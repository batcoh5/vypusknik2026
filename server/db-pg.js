// Хранилище на PostgreSQL (включается переменной DATABASE_URL).
// Интерфейс тот же, что у SQLite-варианта в db.js.
// При первом запуске всё из старого SQLite (DATA_DIR/vote.db, secret.json, photos/)
// автоматически переносится в базу.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';

import { PHOTO_NAME_RE, openSqlite, toBlock, toElection } from './db.js';

const SCHEMA_LOCK = 20260011; // номер advisory-блокировки на время создания таблиц и переноса

const SCHEMA = `
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
    tally       TEXT,
    simulated   INTEGER NOT NULL DEFAULT 0
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
  CREATE TABLE IF NOT EXISTS photos (
    name       TEXT PRIMARY KEY,
    data       BYTEA NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`;

// В PostgreSQL 15+ обычный пользователь (не владелец базы) может не иметь права создавать
// таблицы в схеме public. Тогда сайт заводит свою схему — на это хватает права CREATE на базу.
async function chooseSchema(databaseUrl) {
  const c = new pg.Client({ connectionString: databaseUrl, connectionTimeoutMillis: 10_000 });
  await c.connect();
  try {
    const own = await c.query("SELECT 1 FROM pg_namespace WHERE nspname = 'vypusknik'");
    if (own.rowCount) return 'vypusknik';
    const { rows } = await c.query("SELECT has_schema_privilege('public', 'CREATE') AS ok");
    if (rows[0].ok) return 'public';
    await c.query('CREATE SCHEMA IF NOT EXISTS vypusknik');
    return 'vypusknik';
  } finally {
    await c.end();
  }
}

export async function openPostgres({ databaseUrl, dataDir, log = console }) {
  const schema = await chooseSchema(databaseUrl);
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max: 5,
    connectionTimeoutMillis: 10_000,
    options: `-c search_path=${schema}`,
  });
  // Обрыв простаивающего соединения не должен ронять сайт — пул откроет новое.
  pool.on('error', (err) => log.error('PostgreSQL: ошибка соединения:', err.message));

  const one = async (sql, params) => (await pool.query(sql, params)).rows[0];
  const all = async (sql, params) => (await pool.query(sql, params)).rows;
  const run = async (sql, params) => {
    await pool.query(sql, params);
  };

  // Таблицы и перенос — под блокировкой, чтобы старый и новый контейнер при деплое не мешали друг другу.
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [SCHEMA_LOCK]);
    await client.query(SCHEMA);
    if (dataDir) await migrateFromSqlite(client, dataDir, log);
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [SCHEMA_LOCK]).catch(() => {});
    client.release();
  }

  return {
    kind: 'postgres',
    close: () => pool.end(),

    async secret() {
      await run('INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING', [
        'hmac_secret',
        crypto.randomBytes(32).toString('hex'),
      ]);
      return (await one('SELECT value FROM settings WHERE key = $1', ['hmac_secret'])).value;
    },

    election: async (id) => toElection(await one('SELECT * FROM elections WHERE id = $1', [id])),
    elections: async () => (await all('SELECT * FROM elections ORDER BY created_at DESC')).map(toElection),
    activeElection: async () => toElection(await one("SELECT * FROM elections WHERE status = 'active' LIMIT 1")),
    lastFinishedElection: async () =>
      toElection(await one("SELECT * FROM elections WHERE status = 'finished' ORDER BY finished_at DESC LIMIT 1")),
    insertElection: (e) =>
      run(
        'INSERT INTO elections (id, title, description, questions, status, ends_at, created_at, keys) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
        [e.id, e.title, e.description, JSON.stringify(e.questions), 'draft', e.endsAt, e.createdAt, JSON.stringify(e.keys)],
      ),
    updateElection: (id, e) =>
      run('UPDATE elections SET title = $1, description = $2, questions = $3, ends_at = $4 WHERE id = $5', [
        e.title,
        e.description,
        JSON.stringify(e.questions),
        e.endsAt,
        id,
      ]),
    startElection: (id, at) => run("UPDATE elections SET status = 'active', started_at = $1 WHERE id = $2", [at, id]),
    finishElection: (id, at, tally) =>
      run("UPDATE elections SET status = 'finished', finished_at = $1, tally = $2 WHERE id = $3", [at, JSON.stringify(tally), id]),
    deleteElection: (id) => run('DELETE FROM elections WHERE id = $1', [id]),
    addSimulated: (id, n) => run('UPDATE elections SET simulated = simulated + $1 WHERE id = $2', [n, id]),

    getVoter: (eid, identity) => one('SELECT * FROM voter_ballots WHERE election_id = $1 AND identity = $2', [eid, identity]),
    countVotersByIp: async (eid, ip) =>
      Number((await one('SELECT COUNT(*) AS n FROM voter_ballots WHERE election_id = $1 AND ip = $2', [eid, ip])).n),
    countVoters: async (eid) => Number((await one('SELECT COUNT(*) AS n FROM voter_ballots WHERE election_id = $1', [eid])).n),
    addVoter: (eid, v) =>
      run('INSERT INTO voter_ballots (election_id, identity, ip, blinded, blind_sig, issued_at) VALUES ($1, $2, $3, $4, $5, $6)', [
        eid,
        v.identity,
        v.ip,
        v.blinded,
        v.blindSig,
        v.issuedAt,
      ]),

    lastBlock: async (eid) => toBlock(await one('SELECT * FROM ledger_blocks WHERE election_id = $1 ORDER BY idx DESC LIMIT 1', [eid])),
    blockByToken: async (eid, t) => toBlock(await one('SELECT * FROM ledger_blocks WHERE election_id = $1 AND token = $2', [eid, t])),
    blockByHash: async (h) => toBlock(await one('SELECT * FROM ledger_blocks WHERE hash = $1', [h])),
    blockByIndex: async (eid, i) => toBlock(await one('SELECT * FROM ledger_blocks WHERE election_id = $1 AND idx = $2', [eid, i])),
    blocks: async (eid, from, limit) =>
      (await all('SELECT * FROM ledger_blocks WHERE election_id = $1 AND idx >= $2 ORDER BY idx LIMIT $3', [eid, from, limit])).map(toBlock),
    countBlocks: async (eid) => Number((await one('SELECT COUNT(*) AS n FROM ledger_blocks WHERE election_id = $1', [eid])).n),
    addBlock: (eid, b) =>
      run(
        'INSERT INTO ledger_blocks (election_id, idx, timestamp, prev_hash, token, signature, ballot, hash, ledger_sig) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)',
        [eid, b.index, b.timestamp, b.prevHash, b.token, b.signature, b.ballot, b.hash, b.ledgerSignature],
      ),

    savePhoto: (name, data) => run('INSERT INTO photos (name, data) VALUES ($1, $2) ON CONFLICT (name) DO NOTHING', [name, data]),
    photo: async (name) => (await one('SELECT data FROM photos WHERE name = $1', [name]))?.data ?? null,
    deletePhoto: (name) => run('DELETE FROM photos WHERE name = $1', [name]),
  };
}

// Перенос из SQLite: один раз, в одной транзакции. Уже существующие в базе записи не трогаются.
async function migrateFromSqlite(client, dataDir, log) {
  const dbFile = path.join(dataDir, 'vote.db');
  const secretFile = path.join(dataDir, 'secret.json');
  const photosDir = path.join(dataDir, 'photos');
  const has = (f) => {
    try {
      return fs.existsSync(f);
    } catch {
      return false;
    }
  };
  if (!has(dbFile) && !has(secretFile) && !has(photosDir)) return;
  const done = await client.query("SELECT 1 FROM settings WHERE key = 'sqlite_migrated'");
  if (done.rowCount) return;

  log.log(`Перенос данных из SQLite (${dataDir}) в PostgreSQL...`);
  try {
    await client.query('BEGIN');
    const empty = Number((await client.query('SELECT COUNT(*) AS n FROM elections')).rows[0].n) === 0;

    // Секрет определяет, как хранятся избиратели; если база ещё пустая — берём старый.
    if (has(secretFile)) {
      const hmac = JSON.parse(fs.readFileSync(secretFile, 'utf8')).hmac;
      await client.query(
        `INSERT INTO settings (key, value) VALUES ('hmac_secret', $1)
         ON CONFLICT (key) DO ${empty ? 'UPDATE SET value = EXCLUDED.value' : 'NOTHING'}`,
        [hmac],
      );
    }

    const counts = { elections: 0, voters: 0, blocks: 0, photos: 0 };
    if (has(dbFile)) {
      const sqlite = await openSqlite(dataDir);
      const dump = sqlite.dump();
      await sqlite.close();
      for (const r of dump.elections) {
        const res = await client.query(
          `INSERT INTO elections (id, title, description, questions, status, ends_at, created_at, started_at, finished_at, keys, tally, simulated)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) ON CONFLICT (id) DO NOTHING`,
          [r.id, r.title, r.description, r.questions, r.status, r.ends_at, r.created_at, r.started_at, r.finished_at, r.keys, r.tally, Number(r.simulated ?? 0)],
        );
        counts.elections += res.rowCount;
      }
      for (const r of dump.voters) {
        const res = await client.query(
          `INSERT INTO voter_ballots (election_id, identity, ip, blinded, blind_sig, issued_at)
           VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING`,
          [r.election_id, r.identity, r.ip, r.blinded, r.blind_sig, r.issued_at],
        );
        counts.voters += res.rowCount;
      }
      for (const r of dump.blocks) {
        const res = await client.query(
          `INSERT INTO ledger_blocks (election_id, idx, timestamp, prev_hash, token, signature, ballot, hash, ledger_sig)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT DO NOTHING`,
          [r.election_id, Number(r.idx), r.timestamp, r.prev_hash, r.token, r.signature, r.ballot, r.hash, r.ledger_sig],
        );
        counts.blocks += res.rowCount;
      }
    }
    if (has(photosDir)) {
      for (const name of fs.readdirSync(photosDir)) {
        if (!PHOTO_NAME_RE.test(name)) continue;
        const res = await client.query('INSERT INTO photos (name, data) VALUES ($1, $2) ON CONFLICT (name) DO NOTHING', [
          name,
          fs.readFileSync(path.join(photosDir, name)),
        ]);
        counts.photos += res.rowCount;
      }
    }
    await client.query("INSERT INTO settings (key, value) VALUES ('sqlite_migrated', $1) ON CONFLICT (key) DO NOTHING", [
      new Date().toISOString(),
    ]);
    await client.query('COMMIT');
    log.log(
      `Перенесено в PostgreSQL: голосований ${counts.elections}, избирателей ${counts.voters}, бюллетеней ${counts.blocks}, фото ${counts.photos}.`,
    );
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    // Сайт продолжает работать на PostgreSQL; перенос повторится при следующем запуске.
    log.error('Не удалось перенести данные из SQLite (повторю при следующем запуске):', err);
  }
}
