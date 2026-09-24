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

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vyp-'));
  app = await createApp({ dataDir, adminToken: ADMIN });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${app.server.address().port}`;
});

after(async () => {
  await new Promise((r) => app.server.close(r));
  fs.rmSync(dataDir, { recursive: true, force: true });
});

// Минимальный «браузер»: хранит cookie между запросами.
function client() {
  let cookie = '';
  return async (method, url, body, headers = {}) => {
    const res = await fetch(base + url, {
      method,
      headers: {
        ...(cookie ? { cookie } : {}),
        ...(body ? { 'content-type': 'application/json' } : {}),
        ...headers,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return { status: res.status, data: await res.json() };
  };
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
  const alice = client();
  const r1 = await vote(alice, id, { q1: 'c2', q2: 'c1' });
  assert.equal(r1.cast.status, 200);
  assert.equal((await verifyBlock(r1.cast.data.block, null, r1.keys)).ok, true);
  assert.equal((await vote(client(), id, { q1: 'c2', q2: 'c2' })).cast.status, 200);
  assert.equal((await vote(client(), id, { q1: 'c3', q2: 'c1' })).cast.status, 200);

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
  assert.equal((await vote(client(), id, { q1: 'c1', q2: 'c1' })).signed.status, 403);

  // Удаление и новое голосование: тот же человек снова может проголосовать один раз.
  assert.equal((await asAdmin('DELETE', `/api/admin/elections/${id}`)).status, 200);
  assert.equal((await client()('GET', '/api/current')).data.election, null);
  assert.equal((await client()('GET', `/api/receipts/${r1.cast.data.block.hash}`)).status, 404);

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
