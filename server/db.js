// Хранилище на встроенном SQLite (node:sqlite).
//  - elections:     голосования, их номинации и ключи комиссии;
//  - voter_ballots: реестр избирателей — кому выдана слепая подпись (без бюллетеней);
//  - ledger_blocks: реестр бюллетеней — анонимные зашифрованные голоса (без избирателей).

import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';

export function openDb(dataDir) {
  const db = new DatabaseSync(path.join(dataDir, 'vote.db'));
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS elections (
      id          TEXT PRIMARY KEY,
      title       TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      questions   TEXT NOT NULL,
      status      TEXT NOT NULL CHECK (status IN ('draft', 'active', 'finished')),
      ends_at     TEXT,
      created_at  TEXT NOT NULL,
      started_at  TEXT,
      finished_at TEXT,
      keys        TEXT NOT NULL,
      tally       TEXT
    );
    CREATE TABLE IF NOT EXISTS voter_ballots (
      election_id TEXT NOT NULL REFERENCES elections(id) ON DELETE CASCADE,
      identity    TEXT NOT NULL,
      ip          TEXT NOT NULL,
      blinded     TEXT NOT NULL,
      blind_sig   TEXT NOT NULL,
      issued_at   TEXT NOT NULL,
      PRIMARY KEY (election_id, identity)
    );
    CREATE INDEX IF NOT EXISTS voter_ballots_ip ON voter_ballots(election_id, ip);
    CREATE TABLE IF NOT EXISTS ledger_blocks (
      election_id TEXT NOT NULL REFERENCES elections(id) ON DELETE CASCADE,
      idx         INTEGER NOT NULL,
      timestamp   TEXT NOT NULL,
      prev_hash   TEXT NOT NULL,
      token       TEXT NOT NULL,
      signature   TEXT NOT NULL,
      ballot      TEXT NOT NULL,
      hash        TEXT NOT NULL UNIQUE,
      ledger_sig  TEXT NOT NULL,
      PRIMARY KEY (election_id, idx),
      UNIQUE (election_id, token)
    );
  `);

  const q = {
    election: db.prepare('SELECT * FROM elections WHERE id = ?'),
    elections: db.prepare('SELECT * FROM elections ORDER BY created_at DESC'),
    activeElection: db.prepare("SELECT * FROM elections WHERE status = 'active' LIMIT 1"),
    lastFinished: db.prepare("SELECT * FROM elections WHERE status = 'finished' ORDER BY finished_at DESC LIMIT 1"),
    insertElection: db.prepare(
      'INSERT INTO elections (id, title, description, questions, status, ends_at, created_at, keys) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ),
    updateElection: db.prepare('UPDATE elections SET title = ?, description = ?, questions = ?, ends_at = ? WHERE id = ?'),
    startElection: db.prepare("UPDATE elections SET status = 'active', started_at = ? WHERE id = ?"),
    finishElection: db.prepare("UPDATE elections SET status = 'finished', finished_at = ?, tally = ? WHERE id = ?"),
    deleteElection: db.prepare('DELETE FROM elections WHERE id = ?'),

    voter: db.prepare('SELECT * FROM voter_ballots WHERE election_id = ? AND identity = ?'),
    votersByIp: db.prepare('SELECT COUNT(*) AS n FROM voter_ballots WHERE election_id = ? AND ip = ?'),
    votersCount: db.prepare('SELECT COUNT(*) AS n FROM voter_ballots WHERE election_id = ?'),
    addVoter: db.prepare(
      'INSERT INTO voter_ballots (election_id, identity, ip, blinded, blind_sig, issued_at) VALUES (?, ?, ?, ?, ?, ?)',
    ),

    lastBlock: db.prepare('SELECT * FROM ledger_blocks WHERE election_id = ? ORDER BY idx DESC LIMIT 1'),
    blockByToken: db.prepare('SELECT * FROM ledger_blocks WHERE election_id = ? AND token = ?'),
    blockByHash: db.prepare('SELECT * FROM ledger_blocks WHERE hash = ?'),
    blockByIndex: db.prepare('SELECT * FROM ledger_blocks WHERE election_id = ? AND idx = ?'),
    blocksRange: db.prepare('SELECT * FROM ledger_blocks WHERE election_id = ? AND idx >= ? ORDER BY idx LIMIT ?'),
    blocksCount: db.prepare('SELECT COUNT(*) AS n FROM ledger_blocks WHERE election_id = ?'),
    addBlock: db.prepare(
      'INSERT INTO ledger_blocks (election_id, idx, timestamp, prev_hash, token, signature, ballot, hash, ledger_sig) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ),
  };

  const toElection = (r) =>
    r && {
      id: r.id,
      title: r.title,
      description: r.description,
      questions: JSON.parse(r.questions),
      status: r.status,
      endsAt: r.ends_at,
      createdAt: r.created_at,
      startedAt: r.started_at,
      finishedAt: r.finished_at,
      keys: JSON.parse(r.keys),
      tally: r.tally ? JSON.parse(r.tally) : null,
    };

  const toBlock = (r) =>
    r && {
      electionId: r.election_id,
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

    election: (id) => toElection(q.election.get(id)),
    elections: () => q.elections.all().map(toElection),
    activeElection: () => toElection(q.activeElection.get()),
    lastFinishedElection: () => toElection(q.lastFinished.get()),
    insertElection: (e) =>
      q.insertElection.run(e.id, e.title, e.description, JSON.stringify(e.questions), 'draft', e.endsAt, e.createdAt, JSON.stringify(e.keys)),
    updateElection: (id, e) => q.updateElection.run(e.title, e.description, JSON.stringify(e.questions), e.endsAt, id),
    startElection: (id, at) => q.startElection.run(at, id),
    finishElection: (id, at, tally) => q.finishElection.run(at, JSON.stringify(tally), id),
    deleteElection: (id) => q.deleteElection.run(id),

    getVoter: (eid, identity) => q.voter.get(eid, identity),
    countVotersByIp: (eid, ip) => q.votersByIp.get(eid, ip).n,
    countVoters: (eid) => q.votersCount.get(eid).n,
    addVoter: (eid, v) => q.addVoter.run(eid, v.identity, v.ip, v.blinded, v.blindSig, v.issuedAt),

    lastBlock: (eid) => toBlock(q.lastBlock.get(eid)),
    blockByToken: (eid, t) => toBlock(q.blockByToken.get(eid, t)),
    blockByHash: (h) => toBlock(q.blockByHash.get(h)),
    blockByIndex: (eid, i) => toBlock(q.blockByIndex.get(eid, i)),
    blocks: (eid, from, limit) => q.blocksRange.all(eid, from, limit).map(toBlock),
    countBlocks: (eid) => q.blocksCount.get(eid).n,
    addBlock: (eid, b) =>
      q.addBlock.run(eid, b.index, b.timestamp, b.prevHash, b.token, b.signature, b.ballot, b.hash, b.ledgerSignature),
  };
}
