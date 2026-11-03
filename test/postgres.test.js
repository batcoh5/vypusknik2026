// PostgreSQL: данные переживают перезапуск сайта, старые данные из SQLite переносятся в базу.
// Запуск: TEST_DATABASE_URL=postgresql://user@host/db npm test
// (для этого файла создаётся отдельная база <db>_persist — тесты идут параллельно).

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createApp } from '../server/app.js';
import { blindToken, bytesToHex, encryptBallot, loadPublicKeys, randomBytes, unblindSignature } from '../public/js/core.js';

const PG_URL = process.env.TEST_DATABASE_URL;
const ADMIN = 'test-admin-token';
const SAMPLE = { title: 'Выпускник года', candidates: [{ name: 'Анна' }, { name: 'Борис' }] };
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const quiet = { log() {}, error() {} };

let dbUrl;
let pg;

async function resetDb() {
  const c = new pg.Client({ connectionString: dbUrl });
  await c.connect();
  await c.query('DROP TABLE IF EXISTS ledger_blocks, voter_ballots, elections, photos, settings');
  await c.query('DROP SCHEMA IF EXISTS vypusknik CASCADE');
  await c.end();
}

before(async () => {
  if (!PG_URL) return;
  pg = (await import('pg')).default;
  const u = new URL(PG_URL);
  const name = u.pathname.slice(1) + '_persist';
  const admin = new pg.Client({ connectionString: PG_URL });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS "${name}"`);
  await admin.query(`CREATE DATABASE "${name}"`);
  await admin.end();
  u.pathname = '/' + name;
  dbUrl = u.toString();
});

async function start(options) {
  const app = await createApp({ adminToken: ADMIN, devLogin: true, devTools: true, log: quiet, ...options });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const stop = () => new Promise((r) => app.server.close(r));
  return { app, base, stop };
}

function browser(base) {
  const jar = {};
  return async (method, url, body, headers = {}) => {
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
    const type = res.headers.get('content-type') ?? '';
    return { status: res.status, data: type.includes('json') ? await res.json() : null };
  };
}

const asAdmin = (base) => {
  const b = browser(base);
  return (method, url, body) => b(method, url, body, { authorization: `Bearer ${ADMIN}` });
};

// Полный путь избирателя: вход (тестовый), слепая подпись, отправка бюллетеня.
async function vote(base, uid, electionId, choice) {
  const api = browser(base);
  await api('GET', `/auth/dev?uid=${uid}`);
  const { data } = await api('GET', `/api/elections/${electionId}`);
  const keys = await loadPublicKeys(data.election.publicKeys);
  const token = bytesToHex(randomBytes(32));
  const { blinded, r } = await blindToken(token, keys.rsaPub);
  const signed = await api('POST', `/api/elections/${electionId}/sign`, { blinded });
  if (signed.status !== 200) return signed.status;
  const signature = unblindSignature(signed.data.blindSignature, r, keys.rsaPub);
  const ballot = await encryptBallot(electionId, { q1: choice }, keys.electionKey);
  return (await api('POST', `/api/elections/${electionId}/ballot`, { token, signature, ballot })).status;
}

async function createWithPhoto(base) {
  const admin = asAdmin(base);
  const photo = (await admin('POST', '/api/admin/photos', { data: 'data:image/png;base64,' + PNG.toString('base64') })).data.url;
  const body = { ...SAMPLE, candidates: [{ name: 'Анна', photo }, { name: 'Борис' }] };
  const id = (await admin('POST', '/api/admin/elections', body)).data.election.id;
  assert.equal((await admin('POST', `/api/admin/elections/${id}/start`)).status, 200);
  return { id, photo };
}

test('PostgreSQL: голосование, голоса, фото и секрет переживают перезапуск сайта', { skip: !PG_URL && 'нет TEST_DATABASE_URL' }, async () => {
  await resetDb();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vyp-'));
  const first = await start({ databaseUrl: dbUrl, dataDir });
  const { id, photo } = await createWithPhoto(first.base);
  assert.equal(await vote(first.base, 1, id, 'c1'), 200);
  assert.equal(await vote(first.base, 2, id, 'c2'), 200);
  assert.equal((await asAdmin(first.base)('POST', `/api/admin/elections/${id}/simulate`, { mode: 'manual', counts: { c1: 3, c2: 0 } })).status, 200);
  await first.stop();
  // Сайт работает на PostgreSQL и ничего не пишет на диск.
  assert.deepEqual(fs.readdirSync(dataDir), []);

  const second = await start({ databaseUrl: dbUrl, dataDir });
  const admin = asAdmin(second.base);
  const e = (await admin('GET', '/api/admin/elections')).data.elections.find((x) => x.id === id);
  assert.equal(e.status, 'active');
  assert.deepEqual(e.stats, { ballotsIssued: 2, ballotsCast: 5, simulated: 3 });
  assert.equal((await fetch(second.base + photo)).status, 200);
  // Секрет тот же: проголосовавший до перезапуска не может проголосовать снова.
  assert.equal(await vote(second.base, 1, id, 'c2'), 409);
  assert.equal(await vote(second.base, 3, id, 'c2'), 200);
  const tally = (await admin('POST', `/api/admin/elections/${id}/finish`)).data.election.tally;
  assert.deepEqual(tally.counts.q1, { c1: 4, c2: 2 });
  await second.stop();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('PostgreSQL: данные из старого SQLite переносятся автоматически и один раз', { skip: !PG_URL && 'нет TEST_DATABASE_URL' }, async () => {
  await resetDb();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vyp-'));

  // Старый сайт на SQLite: завершённое голосование и идущее, с фото и голосами.
  const old = await start({ dataDir });
  const oldAdmin = asAdmin(old.base);
  const done = (await oldAdmin('POST', '/api/admin/elections', SAMPLE)).data.election.id;
  await oldAdmin('POST', `/api/admin/elections/${done}/start`);
  assert.equal(await vote(old.base, 10, done, 'c2'), 200);
  const doneTally = (await oldAdmin('POST', `/api/admin/elections/${done}/finish`)).data.election.tally;
  const { id, photo } = await createWithPhoto(old.base);
  assert.equal(await vote(old.base, 11, id, 'c1'), 200);
  await old.stop();

  const logs = [];
  const log = { log: (m) => logs.push(m), error: (...a) => logs.push(a.join(' ')) };
  const moved = await start({ databaseUrl: dbUrl, dataDir, log });
  assert.ok(logs.some((m) => /голосований 2, избирателей 2, бюллетеней 2, фото 1/.test(m)), logs.join('\n'));
  const admin = asAdmin(moved.base);
  const list = (await admin('GET', '/api/admin/elections')).data.elections;
  assert.deepEqual(list.find((x) => x.id === done).tally, doneTally);
  assert.equal(list.find((x) => x.id === id).status, 'active');
  assert.equal((await fetch(moved.base + photo)).status, 200);
  // Перенесён и секрет: уже голосовавший аккаунт повторно не голосует, новый — голосует.
  assert.equal(await vote(moved.base, 11, id, 'c2'), 409);
  assert.equal(await vote(moved.base, 12, id, 'c2'), 200);
  const tally = (await admin('POST', `/api/admin/elections/${id}/finish`)).data.election.tally;
  assert.deepEqual(tally.counts.q1, { c1: 1, c2: 1 });
  await moved.stop();

  // Повторный запуск ничего не переносит заново.
  logs.length = 0;
  const again = await start({ databaseUrl: dbUrl, dataDir, log });
  assert.ok(!logs.some((m) => /Перенос/.test(m)));
  assert.equal((await asAdmin(again.base)('GET', '/api/admin/elections')).data.elections.length, 2);
  await again.stop();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

