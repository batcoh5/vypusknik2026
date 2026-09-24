import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

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

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vyp-'));
  app = await createApp({
    dataDir,
    adminToken: ADMIN,
    smsSender: fakeSms,
    powDifficulty: 6,
    smsResendAfter: 0,
  });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${app.server.address().port}`;
});

after(async () => {
  await new Promise((r) => app.server.close(r));
  fs.rmSync(dataDir, { recursive: true, force: true });
});

// Поддельный SMS.RU: запоминает отправленные коды.
const sms = [];
async function fakeSms(phone, text, ip) {
  sms.push({ phone, code: text.match(/\d{6}/)[0], ip });
}
const lastCode = (phone) => sms.filter((m) => m.phone === phone).at(-1)?.code;

// Решение «невидимой капчи» (в тестах сложность маленькая).
async function solve(api) {
  const { data } = await api('GET', '/api/auth/challenge');
  for (let n = 0; ; n++) {
    const h = crypto.createHash('sha256').update(`${data.challenge}:${n}`).digest();
    const zeros = h[0] === 0 ? 8 + Math.clz32(h[1]) - 24 : Math.clz32(h[0]) - 24;
    if (zeros >= data.difficulty) return { challenge: data.challenge, nonce: String(n) };
  }
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

// Вход по номеру телефона: капча → SMS → код.
async function login(api, phone) {
  const sent = await api('POST', '/api/auth/send', { phone, ...(await solve(api)) });
  if (sent.status !== 200) return sent;
  return api('POST', '/api/auth/verify', { phone, code: lastCode(phone.replace(/\D/g, '').replace(/^8/, '7')) });
}

// «Человек» — браузер, подтвердивший свой номер.
async function voter(n = nextUid++) {
  const api = client();
  const phone = `7900${String(n).padStart(7, '0')}`;
  const res = await login(api, phone);
  assert.equal(res.status, 200, JSON.stringify(res.data));
  api.phone = phone;
  return api;
}

const admin = client();
const asAdmin = (method, url, body) => admin(method, url, body, { authorization: `Bearer ${ADMIN}` });

const SAMPLE = {
  title: 'Выпускник года',
  description: 'Тестовое голосование',
  questions: [
    { title: 'Выпускник года', candidates: [{ name: 'Анна' }, { name: 'Борис' }, { name: 'Вера' }] },
    { title: 'Лучший класс', candidates: [{ name: '11 «А»' }, { name: '11 «Б»' }] },
  ],
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
  const bad = await asAdmin('POST', '/api/admin/elections', { title: 'X', questions: [{ title: 'Q', candidates: [{ name: 'один' }] }] });
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
  const r1 = await vote(alice, id, { q1: 'c2', q2: 'c1' });
  assert.equal(r1.cast.status, 200);
  assert.equal((await verifyBlock(r1.cast.data.block, null, r1.keys)).ok, true);
  assert.equal((await vote(await voter(), id, { q1: 'c2', q2: 'c2' })).cast.status, 200);
  assert.equal((await vote(await voter(), id, { q1: 'c3', q2: 'c1' })).cast.status, 200);

  // Второй бюллетень с того же устройства не выдаётся.
  assert.equal((await vote(alice, id, { q1: 'c1', q2: 'c1' })).signed.status, 409);

  // Повторная отправка того же бюллетеня идемпотентна, другого — отклоняется.
  const dup = await alice('POST', `/api/elections/${id}/ballot`, { token: r1.token, signature: r1.signature, ballot: r1.ballot });
  assert.equal(dup.data.block.hash, r1.cast.data.block.hash);
  const other = await encryptBallot(id, { q1: 'c1', q2: 'c1' }, r1.keys.electionKey);
  assert.equal((await alice('POST', `/api/elections/${id}/ballot`, { token: r1.token, signature: r1.signature, ballot: other })).status, 409);

  // Поддельная подпись.
  const forged = await client()('POST', `/api/elections/${id}/ballot`, {
    token: bytesToHex(randomBytes(32)),
    signature: bytesToHex(randomBytes(256)),
    ballot: other,
  });
  assert.equal(forged.status, 403);

  // Квитанция находится.
  const receipt = await client()('GET', `/api/receipts/${r1.cast.data.block.hash}`);
  assert.equal(receipt.data.election.id, id);
  assert.equal(receipt.data.election.tally, null);

  // Итоги скрыты до завершения.
  assert.equal((await client()('GET', `/api/elections/${id}`)).data.election.tally, null);

  const finished = await asAdmin('POST', `/api/admin/elections/${id}/finish`);
  const tally = finished.data.election.tally;
  assert.equal(tally.valid, 3);
  assert.equal(tally.counts.q1.c2, 2);
  assert.equal(tally.counts.q1.c3, 1);
  assert.equal(tally.counts.q2.c1, 2);

  // Независимый пересчёт по опубликованному ключу даёт тот же результат, цепочка целостна.
  const { data: pub } = await client()('GET', `/api/elections/${id}`);
  const priv = await importElectionPrivateKey(pub.election.electionPrivateKey);
  const { data: ledger } = await client()('GET', `/api/elections/${id}/ledger?limit=500`);
  assert.deepEqual((await tallyBlocks(pub.election, ledger.blocks, priv)).counts, tally.counts);
  const keys = await loadPublicKeys(pub.election.publicKeys);
  let prev = null;
  for (const b of ledger.blocks) {
    assert.equal((await verifyBlock(b, prev, keys)).ok, true);
    prev = b;
  }
  const tampered = { ...ledger.blocks[0], ballot: ledger.blocks[1].ballot };
  assert.equal((await verifyBlock(tampered, null, keys)).ok, false);

  // После завершения голоса не принимаются.
  assert.equal((await vote(await voter(), id, { q1: 'c1', q2: 'c1' })).signed.status, 403);

  // Удаление и новое голосование: тот же человек снова может проголосовать один раз.
  assert.equal((await asAdmin('DELETE', `/api/admin/elections/${id}`)).status, 200);
  assert.equal((await client()('GET', '/api/current')).data.election, null);
  assert.equal((await client()('GET', `/api/receipts/${r1.cast.data.block.hash}`)).status, 404);
  assert.equal((await client()('GET', `/api/elections/${id}`)).status, 404);
  // От удалённого голосования на сервере не остаётся ничего: ни бюллетеней, ни выданных подписей, ни меток.
  assert.equal(app.db.election(id), undefined);
  assert.equal(app.db.countBlocks(id), 0);
  assert.equal(app.db.countVoters(id), 0);

  const second = (await asAdmin('POST', '/api/admin/elections', SAMPLE)).data.election.id;
  await asAdmin('POST', `/api/admin/elections/${second}/start`);
  assert.equal((await vote(alice, second, { q1: 'c1', q2: 'c1' })).cast.status, 200);
  assert.equal((await vote(alice, second, { q1: 'c1', q2: 'c1' })).signed.status, 409);

  // Одновременно может идти только одно голосование.
  const third = (await asAdmin('POST', '/api/admin/elections', SAMPLE)).data.election.id;
  assert.equal((await asAdmin('POST', `/api/admin/elections/${third}/start`)).status, 409);
  const list = await asAdmin('GET', '/api/admin/elections');
  assert.equal(list.data.elections.length, 2);
});

test('без подтверждённого номера бюллетень не выдаётся, один номер — один голос', async () => {
  const id = (await asAdmin('POST', '/api/admin/elections', SAMPLE)).data.election.id;
  const active = (await asAdmin('GET', '/api/admin/elections')).data.elections.find((e) => e.status === 'active');
  if (active) await asAdmin('POST', `/api/admin/elections/${active.id}/finish`);
  await asAdmin('POST', `/api/admin/elections/${id}/start`);

  const guest = client();
  assert.equal((await guest('GET', `/api/elections/${id}/session`)).data.loggedIn, false);
  assert.equal((await vote(guest, id, { q1: 'c1', q2: 'c1' })).signed.status, 401);

  // Тот же номер из другого браузера, инкогнито или через VPN — отказ.
  const phone = await voter(4242);
  assert.equal((await vote(phone, id, { q1: 'c1', q2: 'c1' })).cast.status, 200);
  const laptop = await voter(4242);
  assert.equal((await laptop('GET', `/api/elections/${id}/session`)).data.ballotIssued, true);
  assert.equal((await vote(laptop, id, { q1: 'c2', q2: 'c2' })).signed.status, 409);

  // Другие номера голосуют спокойно — даже с одинаковых телефонов.
  assert.equal((await vote(await voter(4343), id, { q1: 'c3', q2: 'c2' })).cast.status, 200);

  await phone('POST', '/api/auth/logout');
  assert.equal((await phone('GET', `/api/elections/${id}/session`)).data.loggedIn, false);
});

test('SMS-вход: капча, лимиты, неверный код, только мобильные номера РФ', async () => {
  const b = client();
  // Без решённой капчи SMS не отправляется.
  const noPow = await b('POST', '/api/auth/send', { phone: '79001112233', challenge: 'x.y.z', nonce: '1' });
  assert.equal(noPow.status, 400);
  // Капча одноразовая.
  const pow = await solve(b);
  assert.equal((await b('POST', '/api/auth/send', { phone: '+7 (900) 111-22-33', ...pow })).status, 200);
  assert.equal((await b('POST', '/api/auth/send', { phone: '79001112244', ...pow })).status, 400);
  // Не больше 5 кодов в день на номер.
  for (let i = 0; i < 4; i++) {
    assert.equal((await b('POST', '/api/auth/send', { phone: '89001112233', ...(await solve(b)) })).status, 200);
  }
  const tooMany = await b('POST', '/api/auth/send', { phone: '79001112233', ...(await solve(b)) });
  assert.equal(tooMany.status, 429);
  // Не мобильный / не российский номер.
  assert.equal((await b('POST', '/api/auth/send', { phone: '74951234567', ...(await solve(b)) })).status, 400);
  assert.equal((await b('POST', '/api/auth/send', { phone: '380501234567', ...(await solve(b)) })).status, 400);
  // Неверный код — отказ, после 5 попыток код сгорает.
  for (let i = 0; i < 5; i++) {
    assert.equal((await b('POST', '/api/auth/verify', { phone: '79001112233', code: '000000' })).status, 400);
  }
  const burned = await b('POST', '/api/auth/verify', { phone: '79001112233', code: lastCode('79001112233') });
  assert.equal(burned.status, 400);
  assert.equal((await b('GET', '/api/me')).data.user, null);
  // SMS.RU получает IP посетителя.
  assert.ok(sms.at(-1).ip);
  // Номер нигде не хранится в открытом виде: в cookie — только маска.
  const c = client();
  await login(c, '79005556677');
  assert.equal((await c('GET', '/api/me')).data.user.phone, '+7 900 •••-••-77');
});
