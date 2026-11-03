// Хранилище. Два варианта с одинаковым (асинхронным) интерфейсом:
//  - PostgreSQL — если задан DATABASE_URL (Timeweb, любой хостинг без постоянного диска);
//  - SQLite (node:sqlite) — файл DATA_DIR/vote.db, если DATABASE_URL не задан.
//
// Таблицы:
//  - elections:     голосования, их номинации и ключи комиссии;
//  - voter_ballots: реестр избирателей — кому выдана слепая подпись (без бюллетеней);
//  - ledger_blocks: реестр бюллетеней — анонимные зашифрованные голоса (без избирателей);
//  - photos:        фото участников (в SQLite-варианте — файлы в DATA_DIR/photos);
//  - settings:      общий секрет сайта (в SQLite-варианте — файл DATA_DIR/secret.json).

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const PHOTO_NAME_RE = /^[a-f0-9]{24}\.(jpg|png|webp)$/;

export function toElection(r) {
  return (
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
      simulated: Number(r.simulated ?? 0),
    }
  );
}

export function toBlock(r) {
  return (
    r && {
      electionId: r.election_id,
      index: Number(r.idx),
      timestamp: r.timestamp,
      prevHash: r.prev_hash,
      token: r.token,
      signature: r.signature,
      ballot: r.ballot,
      hash: r.hash,
      ledgerSignature: r.ledger_sig,
    }
  );
}

export async function openStorage({ dataDir, databaseUrl, log = console }) {
  if (databaseUrl) {
    const { openPostgres } = await import('./db-pg.js');
    return openPostgres({ databaseUrl, dataDir, log });
  }
  fs.mkdirSync(dataDir, { recursive: true });
  return openSqlite(dataDir);
}

// ---------- SQLite ----------

export async function openSqlite(dataDir) {
  const { DatabaseSync } = await import('node:sqlite');
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

  // Счётчик тестовых голосов (симуляция в режиме DEV_TOOLS) — для баз, созданных раньше.
  try {
    db.exec('ALTER TABLE elections ADD COLUMN simulated INTEGER NOT NULL DEFAULT 0');
  } catch {
    /* колонка уже есть */
  }

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
    addSimulated: db.prepare('UPDATE elections SET simulated = simulated + ? WHERE id = ?'),

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

  const photosDir = path.join(dataDir, 'photos');
  const photoFile = (name) => {
    if (!PHOTO_NAME_RE.test(name)) throw new Error('bad photo name');
    return path.join(photosDir, name);
  };

  return {
    kind: 'sqlite',
    close: async () => db.close(),

    // Общий секрет HMAC хранится в DATA_DIR/secret.json.
    async secret() {
      const file = path.join(dataDir, 'secret.json');
      if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8')).hmac;
      const secret = crypto.randomBytes(32).toString('hex');
      fs.writeFileSync(file, JSON.stringify({ hmac: secret }, null, 2), { mode: 0o600 });
      return secret;
    },

    election: async (id) => toElection(q.election.get(id)),
    elections: async () => q.elections.all().map(toElection),
    activeElection: async () => toElection(q.activeElection.get()),
    lastFinishedElection: async () => toElection(q.lastFinished.get()),
    insertElection: async (e) => {
      q.insertElection.run(e.id, e.title, e.description, JSON.stringify(e.questions), 'draft', e.endsAt, e.createdAt, JSON.stringify(e.keys));
    },
    updateElection: async (id, e) => {
      q.updateElection.run(e.title, e.description, JSON.stringify(e.questions), e.endsAt, id);
    },
    startElection: async (id, at) => {
      q.startElection.run(at, id);
    },
    finishElection: async (id, at, tally) => {
      q.finishElection.run(at, JSON.stringify(tally), id);
    },
    deleteElection: async (id) => {
      q.deleteElection.run(id);
    },
    addSimulated: async (id, n) => {
      q.addSimulated.run(n, id);
    },

    getVoter: async (eid, identity) => q.voter.get(eid, identity),
    countVotersByIp: async (eid, ip) => Number(q.votersByIp.get(eid, ip).n),
    countVoters: async (eid) => Number(q.votersCount.get(eid).n),
    addVoter: async (eid, v) => {
      q.addVoter.run(eid, v.identity, v.ip, v.blinded, v.blindSig, v.issuedAt);
    },

    lastBlock: async (eid) => toBlock(q.lastBlock.get(eid)),
    blockByToken: async (eid, t) => toBlock(q.blockByToken.get(eid, t)),
    blockByHash: async (h) => toBlock(q.blockByHash.get(h)),
    blockByIndex: async (eid, i) => toBlock(q.blockByIndex.get(eid, i)),
    blocks: async (eid, from, limit) => q.blocksRange.all(eid, from, limit).map(toBlock),
    countBlocks: async (eid) => Number(q.blocksCount.get(eid).n),
    addBlock: async (eid, b) => {
      q.addBlock.run(eid, b.index, b.timestamp, b.prevHash, b.token, b.signature, b.ballot, b.hash, b.ledgerSignature);
    },

    // Фото участников — файлы в DATA_DIR/photos.
    async savePhoto(name, data) {
      fs.mkdirSync(photosDir, { recursive: true });
      fs.writeFileSync(photoFile(name), data);
    },
    async photo(name) {
      try {
        return fs.readFileSync(photoFile(name));
      } catch {
        return null;
      }
    },
    async deletePhoto(name) {
      fs.rmSync(photoFile(name), { force: true });
    },

    // Сырые строки для переноса в PostgreSQL.
    dump() {
      return {
        elections: db.prepare('SELECT * FROM elections').all(),
        voters: db.prepare('SELECT * FROM voter_ballots').all(),
        blocks: db.prepare('SELECT * FROM ledger_blocks ORDER BY election_id, idx').all(),
      };
    },
  };
}
