import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createApp } from '../server/app.js';
import {
  blindToken,
  bytesToHex,
  encryptBallot,
  importElectionPrivateKey,
  loadPublicKeys,
  randomBytes,
  tallyBlocks,
  unblindSignature,
  verifyBlock,
} from '../public/js/core.js';

let app;
let base;
let dataDir;
const ADMIN = 'test-admin-token';

// TEST_DATABASE_URL=postgresql://... — прогнать те же тесты на PostgreSQL (база очищается!).
const PG_URL = process.env.TEST_DATABASE_URL;

async function resetPostgres(url) {
  const { default: pg } = await import('pg');
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  await c.query('DROP TABLE IF EXISTS ledger_blocks, voter_ballots, elections, photos, settings');
  await c.query('DROP SCHEMA IF EXISTS vypusknik CASCADE');
  await c.end();
}

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vyp-'));
  if (PG_URL) await resetPostgres(PG_URL);
  app = await createApp({
    dataDir,
    databaseUrl: PG_URL,
    adminToken: ADMIN,
    devLogin: true,
    vkClientId: '51234567',
    publicUrl: 'https://vote.example',
    fetch: fakeVk,
    devTools: true,
  });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${app.server.address().port}`;
});

after(async () => {
  await new Promise((r) => app.server.close(r));
  fs.rmSync(dataDir, { recursive: true, force: true });
});

// Поддельный VK ID: принимает только правильный код и code_verifier.
const vkCalls = [];
async function fakeVk(url, init) {
  const params = Object.fromEntries(new URLSearchParams(String(init.body)));
  vkCalls.push({ url, params });
  const json = (status, data) => ({ ok: status === 200, status, json: async () => data });
  if (url === 'https://id.vk.ru/oauth2/auth') {
    if (params.code !== 'good-code' || !params.code_verifier || params.device_id !== 'dev-1') {
      return json(400, { error: 'invalid_grant' });
    }
    return json(200, { access_token: 'token-1', user_id: 777 });
  }
  if (url === 'https://id.vk.ru/oauth2/user_info' && params.access_token === 'token-1') {
    return json(200, { user: { user_id: '777', first_name: 'Анна', last_name: 'С' } });
  }
  return json(401, { error: 'invalid_token' });
}

let nextUid = 1000;

// Минимальный «браузер»: хранит cookie между запросами, не следует редиректам.
function client() {
  const jar = {};
  const fn = async (method, url, body, headers = {}) => {
    const res = await fetch(base + url, {
      method,
      redirect: 'manual',
      headers: {
        cookie: Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; '),
        ...(body ? { 'content-type': 'application/json' } : {}),
        ...headers,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    for (const c of res.headers.getSetCookie()) {
      const [kv] = c.split(';');
      const i = kv.indexOf('=');
      jar[kv.slice(0, i)] = kv.slice(i + 1);
    }
    const text = await res.text();
    return { status: res.status, location: res.headers.get('location'), data: text ? JSON.parse(text) : null };
  };
  return fn;
}

// «Человек» — браузер, вошедший через (тестовый) аккаунт ВКонтакте.
async function voter(uid = nextUid++) {
  const api = client();
  await api('GET', `/auth/dev?uid=${uid}`);
  api.uid = uid;
  return api;
}

const admin = client();
const asAdmin = (method, url, body) => admin(method, url, body, { authorization: `Bearer ${ADMIN}` });

const SAMPLE = {
  title: 'Выпускник года',
  description: 'Тестовое голосование',
  candidates: [{ name: 'Анна', description: 'Школа № 1' }, { name: 'Борис' }, { name: 'Вера' }],
};

async function vote(api, electionId, choices) {
  const { data } = await api('GET', `/api/elections/${electionId}`);
  const keys = await loadPublicKeys(data.election.publicKeys);
  await api('GET', `/api/elections/${electionId}/session`);
  const token = bytesToHex(randomBytes(32));
  const { blinded, r } = await blindToken(token, keys.rsaPub);
  const signed = await api('POST', `/api/elections/${electionId}/sign`, { blinded });
  if (signed.status !== 200) return { signed };
  const signature = unblindSignature(signed.data.blindSignature, r, keys.rsaPub);
  const ballot = await encryptBallot(electionId, choices, keys.electionKey);
  const cast = await api('POST', `/api/elections/${electionId}/ballot`, { token, signature, ballot });
  return { signed, cast, token, signature, ballot, keys };
}

test('без запущенного голосования на сайте его нет', async () => {
  const { data } = await client()('GET', '/api/current');
  assert.equal(data.election, null);
});

test('админка требует ключ и проверяет данные', async () => {
  const api = client();
  assert.equal((await api('GET', '/api/admin/elections')).status, 401);
  // Название необязательно: без него голосование называется «Зрительское голосование».
  const untitled = await asAdmin('POST', '/api/admin/elections', { candidates: [{ name: 'один' }, { name: 'два' }] });
  assert.equal(untitled.data.election.title, 'Зрительское голосование');
  await asAdmin('DELETE', `/api/admin/elections/${untitled.data.election.id}`);
  const bad = await asAdmin('POST', '/api/admin/elections', { title: 'X', candidates: [{ name: 'один' }] });
  assert.equal(bad.status, 400);
});

test('полный цикл: создать, запустить, проголосовать, завершить, удалить, создать заново', async () => {
  const created = await asAdmin('POST', '/api/admin/elections', SAMPLE);
  assert.equal(created.status, 200);
  const id = created.data.election.id;
  assert.equal(created.data.election.status, 'draft');

  // Черновик не виден публично.
  assert.equal((await client()('GET', '/api/current')).data.election, null);
  assert.equal((await client()('GET', `/api/elections/${id}`)).status, 404);

  // Черновик можно отредактировать.
  const edited = await asAdmin('PUT', `/api/admin/elections/${id}`, { ...SAMPLE, title: 'Выпускник Краснообска 2026' });
  assert.equal(edited.data.election.title, 'Выпускник Краснообска 2026');

  assert.equal((await asAdmin('POST', `/api/admin/elections/${id}/start`)).status, 200);
  assert.equal((await client()('GET', '/api/current')).data.election.id, id);
  assert.equal((await asAdmin('PUT', `/api/admin/elections/${id}`, SAMPLE)).status, 409);
  assert.equal((await asAdmin('DELETE', `/api/admin/elections/${id}`)).status, 409);

  // Голосуем.
  const alice = await voter();
  const r1 = await vote(alice, id, { q1: 'c2' });
  assert.equal(r1.cast.status, 200);
  assert.equal((await verifyBlock(r1.cast.data.block, null, r1.keys)).ok, true);
  assert.equal((await vote(await voter(), id, { q1: 'c2' })).cast.status, 200);
  assert.equal((await vote(await voter(), id, { q1: 'c3' })).cast.status, 200);

  // Второй бюллетень с того же устройства не выдаётся.
  assert.equal((await vote(alice, id, { q1: 'c1' })).signed.status, 409);

  // Повторная отправка того же бюллетеня идемпотентна, другого — отклоняется.
  const dup = await alice('POST', `/api/elections/${id}/ballot`, { token: r1.token, signature: r1.signature, ballot: r1.ballot });
  assert.equal(dup.data.block.hash, r1.cast.data.block.hash);
  const other = await encryptBallot(id, { q1: 'c1' }, r1.keys.electionKey);
  assert.equal((await alice('POST', `/api/elections/${id}/ballot`, { token: r1.token, signature: r1.signature, ballot: other })).status, 409);

  // Поддельная подпись.
  const forged = await client()('POST', `/api/elections/${id}/ballot`, {
    token: bytesToHex(randomBytes(32)),
    signature: bytesToHex(randomBytes(256)),
    ballot: other,
  });
  assert.equal(forged.status, 403);

  // Зрителю не видны ни итоги, ни ключ расшифровки, ни реестр и квитанции.
  const pubActive = (await client()('GET', `/api/elections/${id}`)).data.election;
  assert.equal(pubActive.tally, undefined);
  assert.equal(pubActive.electionPrivateKey, undefined);
  assert.equal((await client()('GET', `/api/elections/${id}/ledger`)).status, 404);
  assert.equal((await client()('GET', `/api/receipts/${r1.cast.data.block.hash}`)).status, 404);
  // Excel до завершения недоступен.
  assert.equal((await asAdmin('GET', `/api/admin/elections/${id}/results.xlsx`)).status, 409);

  const finished = await asAdmin('POST', `/api/admin/elections/${id}/finish`);
  const tally = finished.data.election.tally;
  assert.equal(tally.valid, 3);
  assert.equal(tally.counts.q1.c2, 2);
  assert.equal(tally.counts.q1.c3, 1);

  // Итоги видны только в админке и совпадают с пересчётом по реестру.
  assert.equal((await client()('GET', `/api/elections/${id}`)).data.election.tally, undefined);
  const e = await app.db.election(id);
  const blocks = await app.db.blocks(id, 0, 1000);
  const { electionCrypto } = await import('../server/keys.js');
  const priv = await importElectionPrivateKey(electionCrypto(e.keys).electionPrivateJwk);
  assert.deepEqual((await tallyBlocks(e, blocks, priv)).counts, tally.counts);
  const keys = await loadPublicKeys(electionCrypto(e.keys).public);
  let prev = null;
  for (const b of blocks) {
    assert.equal((await verifyBlock(b, prev, keys)).ok, true);
    prev = b;
  }

  // После завершения голоса не принимаются.
  assert.equal((await vote(await voter(), id, { q1: 'c1' })).signed.status, 403);

  // Удаление и новое голосование: тот же человек снова может проголосовать один раз.
  assert.equal((await asAdmin('DELETE', `/api/admin/elections/${id}`)).status, 200);
  assert.equal((await client()('GET', '/api/current')).data.election, null);
  assert.equal((await client()('GET', `/api/elections/${id}`)).status, 404);
  // От удалённого голосования на сервере не остаётся ничего: ни бюллетеней, ни выданных подписей, ни меток.
  assert.equal(await app.db.election(id), undefined);
  assert.equal(await app.db.countBlocks(id), 0);
  assert.equal(await app.db.countVoters(id), 0);

  const second = (await asAdmin('POST', '/api/admin/elections', SAMPLE)).data.election.id;
  await asAdmin('POST', `/api/admin/elections/${second}/start`);
  assert.equal((await vote(alice, second, { q1: 'c1' })).cast.status, 200);
  assert.equal((await vote(alice, second, { q1: 'c1' })).signed.status, 409);

  // Одновременно может идти только одно голосование.
  const third = (await asAdmin('POST', '/api/admin/elections', SAMPLE)).data.election.id;
  assert.equal((await asAdmin('POST', `/api/admin/elections/${third}/start`)).status, 409);
  const list = await asAdmin('GET', '/api/admin/elections');
  assert.equal(list.data.elections.length, 2);
});

test('без входа через ВКонтакте бюллетень не выдаётся, один аккаунт — один голос', async () => {
  const id = (await asAdmin('POST', '/api/admin/elections', SAMPLE)).data.election.id;
  const active = (await asAdmin('GET', '/api/admin/elections')).data.elections.find((e) => e.status === 'active');
  if (active) await asAdmin('POST', `/api/admin/elections/${active.id}/finish`);
  await asAdmin('POST', `/api/admin/elections/${id}/start`);

  // Не вошёл — голосовать нельзя.
  const guest = client();
  assert.equal((await guest('GET', `/api/elections/${id}/session`)).data.loggedIn, false);
  assert.equal((await vote(guest, id, { q1: 'c1' })).signed.status, 401);

  // Тот же аккаунт ВКонтакте из другого браузера, инкогнито или через VPN — отказ.
  const phone = await voter(4242);
  assert.equal((await vote(phone, id, { q1: 'c1' })).cast.status, 200);
  const laptop = await voter(4242);
  assert.equal((await laptop('GET', `/api/elections/${id}/session`)).data.ballotIssued, true);
  assert.equal((await vote(laptop, id, { q1: 'c2' })).signed.status, 409);

  // Другие аккаунты голосуют спокойно — даже с одинаковых телефонов.
  assert.equal((await vote(await voter(4343), id, { q1: 'c3' })).cast.status, 200);

  // Выход завершает сессию.
  await phone('GET', '/auth/logout');
  assert.equal((await phone('GET', `/api/elections/${id}/session`)).data.loggedIn, false);
});

test('вход через VK ID: PKCE, проверка state, обмен кода на токен', async () => {
  const b = client();
  const start = await b('GET', '/auth/vk/start?return=/');
  assert.equal(start.status, 302);
  const auth = new URL(start.location);
  assert.equal(auth.origin + auth.pathname, 'https://id.vk.ru/authorize');
  assert.equal(auth.searchParams.get('client_id'), '51234567');
  assert.equal(auth.searchParams.get('redirect_uri'), 'https://vote.example/auth/vk/callback');
  assert.equal(auth.searchParams.get('code_challenge_method'), 'S256');
  const state = auth.searchParams.get('state');
  assert.ok(state.length >= 32);

  // Подменённый state отклоняется.
  const bad = await b('GET', `/auth/vk/callback?code=good-code&state=wrong&device_id=dev-1`);
  assert.equal(bad.location, '/?auth=failed');

  const again = new URL((await b('GET', '/auth/vk/start?return=/')).location).searchParams.get('state');
  const ok = await b('GET', `/auth/vk/callback?code=good-code&state=${again}&device_id=dev-1`);
  assert.equal(ok.status, 302);
  assert.equal(ok.location, '/');
  const exchange = vkCalls.find((c) => c.url.endsWith('/oauth2/auth'));
  assert.equal(exchange.params.grant_type, 'authorization_code');
  assert.equal(exchange.params.redirect_uri, 'https://vote.example/auth/vk/callback');

  const me = await b('GET', '/api/me');
  assert.equal(me.data.user.name, 'Анна С');
  assert.equal(me.data.vkConfigured, true);

  // Неверный код — вход не выполняется.
  const c = client();
  const st = new URL((await c('GET', '/auth/vk/start')).location).searchParams.get('state');
  const fail = await c('GET', `/auth/vk/callback?code=bad&state=${st}&device_id=dev-1`);
  assert.equal(fail.location, '/?auth=failed');
  assert.equal((await c('GET', '/api/me')).data.user, null);

  // Возврат только на свои страницы.
  const evil = new URL((await client()('GET', '/auth/vk/start?return=//evil.example')).location);
  assert.ok(evil.searchParams.get('state'));
});

test('фото участников и итоги в Excel', async () => {
  const { execFileSync } = await import('node:child_process');
  // Фото: только картинки, сохраняется и отдаётся с сайта.
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  assert.equal((await asAdmin('POST', '/api/admin/photos', { data: 'data:image/png;base64,' + Buffer.from('not an image').toString('base64') })).status, 400);
  assert.equal((await client()('POST', '/api/admin/photos', { data: 'data:image/png;base64,' + png.toString('base64') })).status, 401);
  const up = await asAdmin('POST', '/api/admin/photos', { data: 'data:image/png;base64,' + png.toString('base64') });
  assert.equal(up.status, 200);
  const photoRes = await fetch(base + up.data.url);
  assert.equal(photoRes.status, 200);
  assert.equal(photoRes.headers.get('content-type'), 'image/png');
  // Чужие пути в фото не принимаются.
  assert.equal((await asAdmin('POST', '/api/admin/elections', { title: 'X', candidates: [{ name: 'А', photo: 'https://evil.example/x.png' }, { name: 'Б' }] })).status, 400);

  const active = (await asAdmin('GET', '/api/admin/elections')).data.elections.find((e) => e.status === 'active');
  if (active) await asAdmin('POST', `/api/admin/elections/${active.id}/finish`);
  const created = await asAdmin('POST', '/api/admin/elections', {
    title: 'Приз зрительских симпатий',
    candidates: [{ name: 'Анна', photo: up.data.url }, { name: 'Борис' }, { name: 'Вера' }],
  });
  assert.equal(created.data.election.questions.length, 1);
  assert.equal(created.data.election.questions[0].candidates[0].photo, up.data.url);
  const id = created.data.election.id;
  await asAdmin('POST', `/api/admin/elections/${id}/start`);
  for (const c of ['c2', 'c2', 'c2', 'c1']) assert.equal((await vote(await voter(), id, { q1: c })).cast.status, 200);
  await asAdmin('POST', `/api/admin/elections/${id}/finish`);

  const res = await fetch(`${base}/api/admin/elections/${id}/results.xlsx`, { headers: { authorization: `Bearer ${ADMIN}` } });
  assert.equal(res.status, 200);
  const file = path.join(dataDir, 'results.xlsx');
  fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  // Распаковываем лист и проверяем формулу «голоса / всего × 160» с округлением.
  const sheet = execFileSync('python3', ['-c', `import zipfile,sys;print(zipfile.ZipFile(sys.argv[1]).read('xl/worksheets/sheet1.xml').decode())`, file]).toString();
  assert.match(sheet, /<f>IF\(\$C\$7=0,0,ROUND\(C5\/\$C\$7\*160,0\)\)<\/f><v>120<\/v>/);
  // Порядок строк — как в голосовании, без сортировки по голосам: первый участник в первой строке, даже если он не победил.
  assert.match(sheet, /<c r="A4"><v>1<\/v><\/c><c r="B4" t="inlineStr"><is><t xml:space="preserve">Анна<\/t>/);
  assert.match(sheet, /<c r="A5"><v>2<\/v><\/c>/);
  assert.match(sheet, /<f>SUM\(C4:C6\)<\/f><v>4<\/v>/);
  assert.match(sheet, /Анна/);

  // Удаление голосования удаляет и фото.
  await asAdmin('DELETE', `/api/admin/elections/${id}`);
  assert.equal((await fetch(base + up.data.url)).status, 404);
});

test('симуляция голосов (DEV_TOOLS): случайно и вручную', async () => {
  const active = (await asAdmin('GET', '/api/admin/elections')).data.elections.find((e) => e.status === 'active');
  if (active) await asAdmin('POST', `/api/admin/elections/${active.id}/finish`);
  const id = (await asAdmin('POST', '/api/admin/elections', SAMPLE)).data.election.id;
  // Только для идущего голосования и только админу.
  assert.equal((await asAdmin('POST', `/api/admin/elections/${id}/simulate`, { mode: 'random', count: 5 })).status, 404);
  await asAdmin('POST', `/api/admin/elections/${id}/start`);
  assert.equal((await client()('POST', `/api/admin/elections/${id}/simulate`, { mode: 'random', count: 5 })).status, 401);
  assert.equal((await asAdmin('POST', `/api/admin/elections/${id}/simulate`, { mode: 'random', count: 0 })).status, 400);

  const manual = await asAdmin('POST', `/api/admin/elections/${id}/simulate`, { mode: 'manual', counts: { c1: 7, c2: 3, c3: 0 } });
  assert.equal(manual.data.added, 10);
  const random = await asAdmin('POST', `/api/admin/elections/${id}/simulate`, { mode: 'random', count: 25 });
  assert.equal(random.data.added, 25);
  assert.equal(random.data.election.stats.simulated, 35);
  // Настоящий голос тоже проходит.
  assert.equal((await vote(await voter(), id, { q1: 'c3' })).cast.status, 200);

  const tally = (await asAdmin('POST', `/api/admin/elections/${id}/finish`)).data.election.tally;
  assert.equal(tally.valid, 36);
  assert.equal(tally.spoiled, 0);
  assert.ok(tally.counts.q1.c1 >= 7 && tally.counts.q1.c2 >= 3 && tally.counts.q1.c3 >= 1);
  assert.equal(tally.counts.q1.c1 + tally.counts.q1.c2 + tally.counts.q1.c3, 36);
});

test('без DEV_TOOLS симуляция выключена', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vyp-'));
  const plain = await createApp({ dataDir: dir, adminToken: ADMIN });
  await new Promise((r) => plain.server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${plain.server.address().port}`;
  const H = { authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json' };
  const id = (await (await fetch(`${url}/api/admin/elections`, { method: 'POST', headers: H, body: JSON.stringify(SAMPLE) })).json()).election.id;
  await fetch(`${url}/api/admin/elections/${id}/start`, { method: 'POST', headers: H });
  const res = await fetch(`${url}/api/admin/elections/${id}/simulate`, { method: 'POST', headers: H, body: JSON.stringify({ mode: 'random', count: 5 }) });
  assert.equal(res.status, 403);
  await new Promise((r) => plain.server.close(r));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('адрес сайта для VK ID берётся из запроса: любой домен, HTTPS → Secure-cookie', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vyp-'));
  const site = await createApp({ dataDir: dir, adminToken: ADMIN, vkClientId: '51234567', trustProxy: true, fetch: fakeVk });
  await new Promise((r) => site.server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${site.server.address().port}`;
  const get = (p, headers = {}) => fetch(url + p, { redirect: 'manual', headers });
  t.after(async () => {
    site.server.closeAllConnections();
    await new Promise((r) => site.server.close(r));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const cookiesOf = (res) => res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');

  // Зашли с основного домена через прокси хостинга (HTTPS).
  const viaProxy = { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'vypusknik2026.ru' };
  const start = await get('/auth/vk/start', viaProxy);
  const auth = new URL(start.headers.get('location'));
  assert.equal(auth.searchParams.get('redirect_uri'), 'https://vypusknik2026.ru/auth/vk/callback');
  assert.ok(start.headers.getSetCookie().every((c) => c.includes('; Secure')));
  // Обмен кода — с тем же адресом, что и при начале входа.
  vkCalls.length = 0;
  const done = await get(`/auth/vk/callback?code=good-code&state=${auth.searchParams.get('state')}&device_id=dev-1`, {
    ...viaProxy,
    cookie: cookiesOf(start),
  });
  assert.equal(done.headers.get('location'), '/');
  assert.equal(vkCalls.find((c) => c.url.endsWith('/oauth2/auth')).params.redirect_uri, 'https://vypusknik2026.ru/auth/vk/callback');
  assert.ok(done.headers.getSetCookie().some((c) => c.startsWith('vks=') && c.includes('; Secure')));

  // Технический домен хостинга — тоже работает, со своим адресом возврата.
  const tw = await get('/auth/vk/start', { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'batcoh5-vypusknik2026-1bbe.twc1.net' });
  assert.equal(new URL(tw.headers.get('location')).searchParams.get('redirect_uri'), 'https://batcoh5-vypusknik2026-1bbe.twc1.net/auth/vk/callback');
  // Прокси не сообщил протокол: настоящий домен считается HTTPS.
  const noProto = await get('/auth/vk/start', { 'x-forwarded-host': 'vypusknik2026.ru' });
  assert.equal(new URL(noProto.headers.get('location')).searchParams.get('redirect_uri'), 'https://vypusknik2026.ru/auth/vk/callback');
  // Локально по HTTP — без Secure, иначе браузер не сохранит cookie.
  const local = await get('/auth/vk/start');
  assert.match(new URL(local.headers.get('location')).searchParams.get('redirect_uri'), /^http:\/\/127\.0\.0\.1:\d+\/auth\/vk\/callback$/);
  assert.ok(local.headers.getSetCookie().every((c) => !c.includes('Secure')));
  // Мусор в заголовке Host не попадает в адрес возврата.
  const junk = await get('/auth/vk/start', { 'x-forwarded-host': 'evil.example/x?y=' });
  assert.match(new URL(junk.headers.get('location')).searchParams.get('redirect_uri'), /^http:\/\/127\.0\.0\.1:\d+\//);
});
