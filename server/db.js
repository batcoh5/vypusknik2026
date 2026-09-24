// Хранилище на встроенном SQLite (node:sqlite).
// Две логически разделённые части, как в ДЭГ:
//  - voters: реестр избирателей — кому выдана слепая подпись (без бюллетеней);
//  - blocks: реестр бюллетеней — анонимные зашифрованные голоса (без избирателей).

import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';

export function openDb(dataDir) {
  const db = new DatabaseSync(path.join(dataDir, 'vote.db'));
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    CREATE TABLE IF NOT EXISTS voters (
      identity   TEXT PRIMARY KEY,
      ip         TEXT NOT NULL,
      blinded    TEXT NOT NULL,
      blind_sig  TEXT NOT NULL,
      issued_at  TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS voters_ip ON voters(ip);
    CREATE TABLE IF NOT EXISTS blocks (
      idx        INTEGER PRIMARY KEY,
      timestamp  TEXT NOT NULL,
      prev_hash  TEXT NOT NULL,
      token      TEXT NOT NULL UNIQUE,
      signature  TEXT NOT NULL,
      ballot     TEXT NOT NULL,
      hash       TEXT NOT NULL UNIQUE,
      ledger_sig TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS state (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  const q = {
    voter: db.prepare('SELECT * FROM voters WHERE identity = ?'),
    votersByIp: db.prepare('SELECT COUNT(*) AS n FROM voters WHERE ip = ?'),
    votersCount: db.prepare('SELECT COUNT(*) AS n FROM voters'),
    addVoter: db.prepare('INSERT INTO voters (identity, ip, blinded, blind_sig, issued_at) VALUES (?, ?, ?, ?, ?)'),
    lastBlock: db.prepare('SELECT * FROM blocks ORDER BY idx DESC LIMIT 1'),
    blockByToken: db.prepare('SELECT * FROM blocks WHERE token = ?'),
    blockByHash: db.prepare('SELECT * FROM blocks WHERE hash = ?'),
    blockByIndex: db.prepare('SELECT * FROM blocks WHERE idx = ?'),
    blocksRange: db.prepare('SELECT * FROM blocks WHERE idx >= ? ORDER BY idx LIMIT ?'),
    blocksCount: db.prepare('SELECT COUNT(*) AS n FROM blocks'),
    addBlock: db.prepare(
      'INSERT INTO blocks (idx, timestamp, prev_hash, token, signature, ballot, hash, ledger_sig) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ),
    getState: db.prepare('SELECT value FROM state WHERE key = ?'),
    setState: db.prepare('INSERT INTO state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'),
  };

  const toBlock = (r) =>
    r && {
      index: r.idx,
      timestamp: r.timestamp,
      prevHash: r.prev_hash,
      token: r.token,
      signature: r.signature,
      ballot: r.ballot,
      hash: r.hash,
      ledgerSignature: r.ledger_sig,
    };

  return {
    close: () => db.close(),
    transaction(fn) {
      db.exec('BEGIN IMMEDIATE');
      try {
        const result = fn();
        db.exec('COMMIT');
        return result;
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    },
    getVoter: (identity) => q.voter.get(identity),
    countVotersByIp: (ip) => q.votersByIp.get(ip).n,
    countVoters: () => q.votersCount.get().n,
    addVoter: (v) => q.addVoter.run(v.identity, v.ip, v.blinded, v.blindSig, v.issuedAt),
    lastBlock: () => toBlock(q.lastBlock.get()),
    blockByToken: (t) => toBlock(q.blockByToken.get(t)),
    blockByHash: (h) => toBlock(q.blockByHash.get(h)),
    blockByIndex: (i) => toBlock(q.blockByIndex.get(i)),
    blocks: (from, limit) => q.blocksRange.all(from, limit).map(toBlock),
    countBlocks: () => q.blocksCount.get().n,
    addBlock: (b) =>
      q.addBlock.run(b.index, b.timestamp, b.prevHash, b.token, b.signature, b.ballot, b.hash, b.ledgerSignature),
    getState(key) {
      const row = q.getState.get(key);
      return row ? JSON.parse(row.value) : null;
    },
    setState: (key, value) => q.setState.run(key, JSON.stringify(value)),
  };
}
