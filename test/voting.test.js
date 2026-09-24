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
  decryptBallot,
  loadPublicKeys,
  randomBytes,
  tallyBlocks,
  unblindSignature,
  verifyBlock,
  verifyTokenSignature,
} from '../public/js/core.js';

let app;
let base;
let dataDir;
const ADMIN = 'test-admin-token';

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vyp-'));
  app = await createApp({ dataDir, adminToken: ADMIN, now: () => new Date('2026-10-01T12:00:00Z') });
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

async function vote(api, choices) {
  const { data: info } = await api('GET', '/api/election');
  const keys = await loadPublicKeys(info.publicKeys);
  await api('GET', '/api/session');
  const token = bytesToHex(randomBytes(32));
  const { blinded, r } = await blindToken(token, keys.rsaPub);
  const signed = await api('POST', '/api/sign', { blinded });
  if (signed.status !== 200) return { signed };
  const signature = unblindSignature(signed.data.blindSignature, r, keys.rsaPub);
  const ballot = await encryptBallot(info.election.id, choices, keys.electionKey);
  const cast = await api('POST', '/api/ballot', { token, signature, ballot });
  return { signed, cast, token, signature, ballot, keys };
}

test('полный цикл: выдача, голос, квитанция, повторное голосование запрещено', async () => {
  const api = client();
  const r = await vote(api, { 'graduate-of-the-year': 'c2', 'best-class': 'k1' });
  assert.equal(r.cast.status, 200);
  assert.ok(await verifyTokenSignature(r.token, r.signature, r.keys.rsaPub));

  const block = r.cast.data.block;
  const checks = await verifyBlock(block, null, r.keys);
  assert.equal(checks.ok, true, JSON.stringify(checks));

  const found = await api('GET', `/api/ledger/${block.hash}`);
  assert.equal(found.status, 200);
  assert.equal(found.data.block.ballot, r.ballot);

  // Второй бюллетень с того же устройства не выдаётся.
  const again = await vote(api, { 'graduate-of-the-year': 'c1', 'best-class': 'k1' });
  assert.equal(again.signed.status, 409);

  // Повторная отправка того же бюллетеня идемпотентна.
  const dup = await api('POST', '/api/ballot', { token: r.token, signature: r.signature, ballot: r.ballot });
  assert.equal(dup.status, 200);
  assert.equal(dup.data.block.hash, block.hash);

  // Тот же токен с другим бюллетенем отклоняется.
  const ballot2 = await encryptBallot('vypusknik-2026', { 'graduate-of-the-year': 'c1', 'best-class': 'k1' }, r.keys.electionKey);
  const reuse = await api('POST', '/api/ballot', { token: r.token, signature: r.signature, ballot: ballot2 });
  assert.equal(reuse.status, 409);
});

test('бюллетень без подписи комиссии отклоняется', async () => {
  const api = client();
  const { data: info } = await api('GET', '/api/election');
  const keys = await loadPublicKeys(info.publicKeys);
  const ballot = await encryptBallot(info.election.id, { 'graduate-of-the-year': 'c1', 'best-class': 'k1' }, keys.electionKey);
  const res = await api('POST', '/api/ballot', {
    token: bytesToHex(randomBytes(32)),
    signature: bytesToHex(randomBytes(256)),
    ballot,
  });
  assert.equal(res.status, 403);
});

test('повтор запроса подписи с тем же сообщением возвращает ту же подпись', async () => {
  const api = client();
  const { data: info } = await api('GET', '/api/election');
  const keys = await loadPublicKeys(info.publicKeys);
  await api('GET', '/api/session');
  const { blinded } = await blindToken(bytesToHex(randomBytes(32)), keys.rsaPub);
  const a = await api('POST', '/api/sign', { blinded });
  const b = await api('POST', '/api/sign', { blinded });
  assert.equal(a.status, 200);
  assert.equal(b.data.blindSignature, a.data.blindSignature);
  const session = await api('GET', '/api/session');
  assert.equal(session.data.ballotIssued, true);
});

test('итоги недоступны до завершения, затем публикуются вместе с ключом', async () => {
  const voters = [
    { 'graduate-of-the-year': 'c3', 'best-class': 'k2' },
    { 'graduate-of-the-year': 'c3', 'best-class': 'k1' },
  ];
  for (const choices of voters) assert.equal((await vote(client(), choices)).cast.status, 200);

  const api = client();
  assert.equal((await api('GET', '/api/results')).data.tally, null);
  assert.equal((await api('POST', '/api/admin/close', {}, { authorization: 'Bearer wrong' })).status, 401);

  const closed = await api('POST', '/api/admin/close', {}, { authorization: `Bearer ${ADMIN}` });
  assert.equal(closed.status, 200);
  const { tally } = closed.data;
  assert.equal(tally.valid, 3);
  assert.equal(tally.counts['graduate-of-the-year'].c3, 2);
  assert.equal(tally.counts['graduate-of-the-year'].c2, 1);
  assert.equal(tally.counts['best-class'].k1, 2);

  // Независимый пересчёт по опубликованному ключу даёт тот же результат.
  const { data: info } = await api('GET', '/api/election');
  assert.ok(info.electionPrivateKey);
  const priv = await importElectionPrivateKey(info.electionPrivateKey);
  const { data: ledger } = await api('GET', '/api/ledger?from=0&limit=500');
  const recount = await tallyBlocks(info.election, ledger.blocks, priv);
  assert.deepEqual(recount.counts, tally.counts);

  // Цепочка целостна.
  const keys = await loadPublicKeys(info.publicKeys);
  let prev = null;
  for (const b of ledger.blocks) {
    assert.equal((await verifyBlock(b, prev, keys)).ok, true);
    prev = b;
  }
  const first = await decryptBallot(ledger.blocks[0].ballot, priv);
  assert.equal(first.choices['graduate-of-the-year'], 'c2');

  // После завершения новые бюллетени не принимаются.
  const late = await vote(client(), { 'graduate-of-the-year': 'c1', 'best-class': 'k1' });
  assert.equal(late.signed.status, 403);
});

test('подмена блока обнаруживается', async () => {
  const api = client();
  const { data: info } = await api('GET', '/api/election');
  const keys = await loadPublicKeys(info.publicKeys);
  const { data: ledger } = await api('GET', '/api/ledger');
  const tampered = { ...ledger.blocks[0], ballot: ledger.blocks[1].ballot };
  assert.equal((await verifyBlock(tampered, null, keys)).ok, false);
});
