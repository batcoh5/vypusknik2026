import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { openDb } from './db.js';
import { loadSecret, generateElectionKeys, electionCrypto } from './keys.js';
import { createVkIdentity } from './identity.js';
import {
  GENESIS_HASH,
  computeBlockHash,
  importElectionPrivateKey,
  rsaPublicFromJwk,
  tallyBlocks,
  verifyTokenSignature,
} from '../public/js/core.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const MAX_BODY = 64 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

const SECURITY_HEADERS = {
  'Content-Security-Policy': [
    "default-src 'self'",
    "style-src 'self'",
    "font-src 'self'",
    "img-src 'self' data:",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'self'",
  ].join('; '),
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};

export class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// Очередь: блоки добавляются строго по одному, иначе два одновременных
// бюллетеня получили бы один и тот же номер блока.
function createMutex() {
  let tail = Promise.resolve();
  return (fn) => {
    const run = tail.then(fn, fn);
    tail = run.catch(() => {});
    return run;
  };
}

function createRateLimiter({ windowMs, max }) {
  const hits = new Map();
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.reset < now) hits.delete(k);
  }, windowMs).unref();
  return (key) => {
    const now = Date.now();
    let entry = hits.get(key);
    if (!entry || entry.reset < now) {
      entry = { count: 0, reset: now + windowMs };
      hits.set(key, entry);
    }
    entry.count++;
    return entry.count <= max;
  };
}

// ---------- проверка данных из админ-панели ----------

function text(value, field, { min = 0, max }) {
  const s = String(value ?? '').trim();
  if (s.length < min) throw new HttpError(400, 'invalid', `Заполните поле «${field}»`);
  if (s.length > max) throw new HttpError(400, 'invalid', `Поле «${field}» длиннее ${max} символов`);
  return s;
}

export function normalizeElectionInput(body) {
  const title = text(body.title, 'Название голосования', { min: 1, max: 120 });
  const description = text(body.description, 'Описание', { max: 1000 });
  let endsAt = null;
  if (body.endsAt) {
    const t = Date.parse(body.endsAt);
    if (Number.isNaN(t)) throw new HttpError(400, 'invalid', 'Некорректная дата окончания');
    endsAt = new Date(t).toISOString();
  }
  const questions = Array.isArray(body.questions) ? body.questions : [];
  if (questions.length < 1 || questions.length > 10) {
    throw new HttpError(400, 'invalid', 'Добавьте от 1 до 10 номинаций');
  }
  return {
    title,
    description,
    endsAt,
    questions: questions.map((q, qi) => {
      const qTitle = text(q?.title, `Номинация ${qi + 1}`, { min: 1, max: 120 });
      const candidates = Array.isArray(q?.candidates) ? q.candidates : [];
      if (candidates.length < 2 || candidates.length > 30) {
        throw new HttpError(400, 'invalid', `В номинации «${qTitle}» должно быть от 2 до 30 вариантов`);
      }
      return {
        id: `q${qi + 1}`,
        title: qTitle,
        description: text(q?.description, `Описание номинации «${qTitle}»`, { max: 500 }),
        candidates: candidates.map((c, ci) => ({
          id: `c${ci + 1}`,
          name: text(c?.name, `Вариант ${ci + 1} в «${qTitle}»`, { min: 1, max: 120 }),
          description: text(c?.description, `Подпись варианта ${ci + 1} в «${qTitle}»`, { max: 300 }),
        })),
      };
    }),
  };
}

export async function createApp(options = {}) {
  const dataDir = options.dataDir ?? path.join(ROOT, 'data');
  fs.mkdirSync(dataDir, { recursive: true });

  const secret = loadSecret(dataDir);
  const db = openDb(dataDir);
  const identity = createVkIdentity(secret, {
    vkClientId: options.vkClientId,
    vkHost: options.vkHost,
    publicUrl: options.publicUrl,
    secureCookies: options.secureCookies ?? false,
    devLogin: options.devLogin ?? false,
    fetch: options.fetch,
  });
  const maxPerIp = options.maxVotesPerIp ?? 0;
  const trustProxy = options.trustProxy ?? false;
  const adminToken = options.adminToken;
  const now = options.now ?? (() => new Date());
  const withLedgerLock = createMutex();
  const apiLimiter = createRateLimiter({ windowMs: 60_000, max: options.rateLimit ?? 240 });
  const adminFailLimiter = createRateLimiter({ windowMs: 10 * 60_000, max: 20 });

  const cryptoCache = new Map();
  function cryptoFor(election) {
    let c = cryptoCache.get(election.id);
    if (!c) {
      c = electionCrypto(election.keys);
      c.rsaPub = rsaPublicFromJwk(c.public.blindSign);
      cryptoCache.set(election.id, c);
    }
    return c;
  }

  // ---------- жизненный цикл голосования ----------

  // Завершение: расшифровка, подсчёт и публикация ключа — любой может пересчитать сам.
  async function finish(id) {
    return withLedgerLock(async () => {
      const election = db.election(id);
      if (!election) throw new HttpError(404, 'not_found', 'Голосование не найдено');
      if (election.status === 'finished') return election;
      if (election.status !== 'active') throw new HttpError(409, 'not_active', 'Голосование ещё не запущено');
      const blocks = db.blocks(id, 0, Number.MAX_SAFE_INTEGER);
      const privateKey = await importElectionPrivateKey(cryptoFor(election).electionPrivateJwk);
      const tally = await tallyBlocks(election, blocks, privateKey);
      tally.lastBlockHash = blocks.length ? blocks[blocks.length - 1].hash : GENESIS_HASH;
      db.finishElection(id, now().toISOString(), tally);
      return db.election(id);
    });
  }

  // Голосование с датой окончания завершается автоматически.
  async function autoFinish() {
    const active = db.activeElection();
    if (active?.endsAt && Date.parse(active.endsAt) <= now().getTime()) await finish(active.id);
  }

  function publicElection(e) {
    const c = cryptoFor(e);
    return {
      id: e.id,
      title: e.title,
      description: e.description,
      questions: e.questions,
      status: e.status,
      endsAt: e.endsAt,
      startedAt: e.startedAt,
      finishedAt: e.finishedAt,
      publicKeys: c.public,
      electionPrivateKey: e.status === 'finished' ? c.electionPrivateJwk : null,
      tally: e.status === 'finished' ? e.tally : null,
      stats: { ballotsIssued: db.countVoters(e.id), ballotsCast: db.countBlocks(e.id) },
    };
  }

  function adminElection(e) {
    return {
      id: e.id,
      title: e.title,
      description: e.description,
      questions: e.questions,
      status: e.status,
      endsAt: e.endsAt,
      createdAt: e.createdAt,
      startedAt: e.startedAt,
      finishedAt: e.finishedAt,
      tally: e.tally,
      stats: { ballotsIssued: db.countVoters(e.id), ballotsCast: db.countBlocks(e.id) },
    };
  }

  // Публично видны только запущенные и завершённые голосования.
  function publicElectionById(id) {
    const e = db.election(id);
    if (!e || e.status === 'draft') throw new HttpError(404, 'not_found', 'Голосование не найдено');
    return e;
  }

  function activeElectionById(id) {
    const e = publicElectionById(id);
    if (e.status !== 'active') throw new HttpError(403, 'not_active', 'Приём голосов в этом голосовании завершён');
    return e;
  }

  function clientIp(req) {
    if (trustProxy) {
      const fwd = req.headers['x-forwarded-for'];
      if (fwd) return fwd.split(',')[0].trim();
    }
    return req.socket.remoteAddress ?? 'unknown';
  }

  function requireAdmin(req) {
    const ip = clientIp(req);
    const header = req.headers.authorization ?? '';
    const given = Buffer.from(header.replace(/^Bearer\s+/i, ''));
    const expected = Buffer.from(adminToken ?? '');
    const ok = adminToken && given.length === expected.length && crypto.timingSafeEqual(given, expected);
    if (!ok) {
      if (!adminFailLimiter(ip)) throw new HttpError(429, 'rate_limited', 'Слишком много попыток входа. Подождите 10 минут');
      throw new HttpError(401, 'unauthorized', 'Неверный ключ администратора');
    }
  }

  // ---------- маршруты ----------

  const routes = [];
  const route = (method, pattern, handler) => {
    const re = new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[A-Za-z0-9_-]+)') + '$');
    routes.push({ method, re, handler });
  };

  route('GET', '/api/current', async () => {
    const e = db.activeElection() ?? db.lastFinishedElection();
    return { election: e ? publicElection(e) : null, serverTime: now().toISOString() };
  });

  // Кто вошёл: имя из ВКонтакте хранится только в cookie самого пользователя.
  route('GET', '/api/me', async ({ req }) => ({
    user: identity.user(req),
    vkConfigured: identity.configured,
    devLogin: identity.devLogin,
  }));

  route('GET', '/api/elections/:id', async ({ params }) => ({
    election: publicElection(publicElectionById(params.id)),
    serverTime: now().toISOString(),
  }));

  route('GET', '/api/elections/:id/session', async ({ req, params }) => {
    const e = publicElectionById(params.id);
    const id = identity.identify(req);
    const voter = id ? db.getVoter(e.id, id) : null;
    return { status: e.status, loggedIn: Boolean(id), ballotIssued: Boolean(voter), blinded: voter?.blinded ?? null };
  });

  // Шаг 1: избиратель получает слепую подпись на свой анонимный токен.
  route('POST', '/api/elections/:id/sign', async ({ req, body, params }) => {
    const e = activeElectionById(params.id);
    const c = cryptoFor(e);
    const id = identity.identify(req);
    if (!id) throw new HttpError(401, 'no_session', 'Войдите через ВКонтакте, чтобы проголосовать');
    const blinded = String(body.blinded ?? '').toLowerCase();
    if (!/^[0-9a-f]+$/.test(blinded) || blinded.length !== c.rsaPub.bytes * 2) {
      throw new HttpError(400, 'bad_request', 'Некорректный запрос');
    }
    const ip = secret.hmac('ip:' + clientIp(req));
    return db.transaction(() => {
      const voter = db.getVoter(e.id, id);
      if (voter) {
        // Повтор того же запроса (например, оборвалась связь) — отдаём ту же подпись.
        if (voter.blinded === blinded) return { blindSignature: voter.blind_sig };
        throw new HttpError(409, 'already_issued', 'С этого аккаунта ВКонтакте уже проголосовали в этом голосовании');
      }
      if (maxPerIp > 0 && db.countVotersByIp(e.id, ip) >= maxPerIp) {
        throw new HttpError(429, 'ip_limit', 'Превышено число бюллетеней для вашей сети');
      }
      let blindSignature;
      try {
        blindSignature = c.blindSign(blinded);
      } catch {
        throw new HttpError(400, 'bad_request', 'Некорректный запрос');
      }
      db.addVoter(e.id, { identity: id, ip, blinded, blindSig: blindSignature, issuedAt: now().toISOString() });
      return { blindSignature };
    });
  });

  // Шаг 2: анонимная отправка зашифрованного бюллетеня в реестр.
  route('POST', '/api/elections/:id/ballot', async ({ body, params }) => {
    const e = activeElectionById(params.id);
    const c = cryptoFor(e);
    const token = String(body.token ?? '');
    const signature = String(body.signature ?? '').toLowerCase();
    const ballot = String(body.ballot ?? '');
    if (!/^[0-9a-f]{64}$/.test(token) || !/^[A-Za-z0-9_-]{100,2000}$/.test(ballot)) {
      throw new HttpError(400, 'bad_request', 'Некорректный бюллетень');
    }
    if (!(await verifyTokenSignature(token, signature, c.rsaPub))) {
      throw new HttpError(403, 'bad_signature', 'Подпись комиссии на бюллетене недействительна');
    }
    return withLedgerLock(async () => {
      const existing = db.blockByToken(e.id, token);
      if (existing) {
        // Повторная отправка того же бюллетеня возвращает ту же квитанцию.
        if (existing.ballot === ballot) return { block: existing, duplicate: true };
        throw new HttpError(409, 'token_used', 'По этому бюллетеню уже проголосовали');
      }
      if (db.election(e.id)?.status !== 'active') throw new HttpError(403, 'not_active', 'Голосование завершено');
      const last = db.lastBlock(e.id);
      const ts = now();
      ts.setUTCSeconds(0, 0); // время округляется до минуты, чтобы затруднить сопоставление
      const block = {
        index: last ? last.index + 1 : 0,
        timestamp: ts.toISOString(),
        prevHash: last ? last.hash : GENESIS_HASH,
        token,
        signature,
        ballot,
      };
      block.hash = await computeBlockHash(block);
      block.ledgerSignature = c.signBlock(block.hash);
      db.addBlock(e.id, block);
      return { block: { electionId: e.id, ...block } };
    });
  });

  route('GET', '/api/elections/:id/ledger', async ({ params, url }) => {
    const e = publicElectionById(params.id);
    const from = Math.max(0, parseInt(url.searchParams.get('from') ?? '0', 10) || 0);
    const limit = Math.min(500, Math.max(1, parseInt(url.searchParams.get('limit') ?? '50', 10) || 50));
    return { total: db.countBlocks(e.id), blocks: db.blocks(e.id, from, limit) };
  });

  // Квитанция по хешу блока (хеши уникальны во всех голосованиях).
  route('GET', '/api/receipts/:hash', async ({ params }) => {
    const hash = params.hash.toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(hash)) throw new HttpError(400, 'bad_request', 'Некорректный номер квитанции');
    const block = db.blockByHash(hash);
    if (!block) throw new HttpError(404, 'not_found', 'Бюллетень с таким номером не найден');
    const e = db.election(block.electionId);
    const prev = block.index > 0 ? db.blockByIndex(e.id, block.index - 1) : null;
    const next = db.blockByIndex(e.id, block.index + 1);
    return { block, prev, nextHash: next?.hash ?? null, total: db.countBlocks(e.id), election: publicElection(e) };
  });

  // ---------- админ-панель ----------

  route('GET', '/api/admin/elections', async ({ req }) => {
    requireAdmin(req);
    return { elections: db.elections().map(adminElection), maxVotesPerIp: maxPerIp };
  });

  route('POST', '/api/admin/elections', async ({ req, body }) => {
    requireAdmin(req);
    const input = normalizeElectionInput(body);
    const id = 'e' + crypto.randomBytes(6).toString('hex');
    db.insertElection({ id, ...input, createdAt: now().toISOString(), keys: generateElectionKeys() });
    return { election: adminElection(db.election(id)) };
  });

  route('PUT', '/api/admin/elections/:id', async ({ req, body, params }) => {
    requireAdmin(req);
    const e = db.election(params.id);
    if (!e) throw new HttpError(404, 'not_found', 'Голосование не найдено');
    if (e.status !== 'draft') throw new HttpError(409, 'locked', 'Изменять можно только голосование, которое ещё не запущено');
    db.updateElection(e.id, normalizeElectionInput(body));
    return { election: adminElection(db.election(e.id)) };
  });

  route('POST', '/api/admin/elections/:id/start', async ({ req, params }) => {
    requireAdmin(req);
    return withLedgerLock(async () => {
      const e = db.election(params.id);
      if (!e) throw new HttpError(404, 'not_found', 'Голосование не найдено');
      if (e.status !== 'draft') throw new HttpError(409, 'bad_state', 'Голосование уже запускалось');
      const active = db.activeElection();
      if (active) throw new HttpError(409, 'busy', `Сначала завершите текущее голосование «${active.title}»`);
      if (e.endsAt && Date.parse(e.endsAt) <= now().getTime()) {
        throw new HttpError(409, 'bad_state', 'Дата окончания уже прошла — измените её');
      }
      db.startElection(e.id, now().toISOString());
      return { election: adminElection(db.election(e.id)) };
    });
  });

  route('POST', '/api/admin/elections/:id/finish', async ({ req, params }) => {
    requireAdmin(req);
    return { election: adminElection(await finish(params.id)) };
  });

  route('DELETE', '/api/admin/elections/:id', async ({ req, params }) => {
    requireAdmin(req);
    return withLedgerLock(async () => {
      const e = db.election(params.id);
      if (!e) throw new HttpError(404, 'not_found', 'Голосование не найдено');
      if (e.status === 'active') throw new HttpError(409, 'bad_state', 'Сначала завершите голосование');
      db.deleteElection(e.id);
      cryptoCache.delete(e.id);
      return { deleted: e.id };
    });
  });

  // ---------- HTTP ----------

  function send(res, status, payload) {
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...SECURITY_HEADERS,
    });
    res.end(JSON.stringify(payload));
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on('data', (c) => {
        size += c.length;
        if (size > MAX_BODY) {
          reject(new HttpError(413, 'too_large', 'Слишком большой запрос'));
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      req.on('end', () => {
        if (!chunks.length) return resolve({});
        try {
          const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          resolve(parsed && typeof parsed === 'object' ? parsed : {});
        } catch {
          reject(new HttpError(400, 'bad_json', 'Некорректный JSON'));
        }
      });
      req.on('error', reject);
    });
  }

  function serveStatic(req, res, url) {
    let rel;
    try {
      rel = decodeURIComponent(url.pathname);
    } catch {
      return false;
    }
    if (rel === '/') rel = '/index.html';
    else if (!path.extname(rel)) rel += '.html';
    const file = path.normalize(path.join(PUBLIC_DIR, rel));
    if (!file.startsWith(PUBLIC_DIR + path.sep)) return false;
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      return false;
    }
    if (!stat.isFile()) return false;
    const type = MIME[path.extname(file)] ?? 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': stat.size,
      'Cache-Control': type.startsWith('text/html') ? 'no-cache' : 'public, max-age=300',
      ...SECURITY_HEADERS,
    });
    if (req.method === 'HEAD') res.end();
    else fs.createReadStream(file).pipe(res);
    return true;
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (url.pathname.startsWith('/auth/') && req.method === 'GET') {
        if (!apiLimiter(clientIp(req))) throw new HttpError(429, 'rate_limited', 'Слишком много запросов. Попробуйте через минуту');
        if (url.pathname === '/auth/vk/start') return identity.start(req, res, url);
        if (url.pathname === '/auth/vk/callback') return await identity.callback(req, res, url);
        if (url.pathname === '/auth/logout') return identity.logout(req, res);
        if (url.pathname === '/auth/dev' && identity.devLogin) return identity.dev(req, res, url);
      }
      if (url.pathname.startsWith('/api/')) {
        if (!apiLimiter(clientIp(req))) {
          throw new HttpError(429, 'rate_limited', 'Слишком много запросов. Попробуйте через минуту');
        }
        const hasBody =
          (req.method === 'POST' || req.method === 'PUT') &&
          (Number(req.headers['content-length'] ?? 0) > 0 || req.headers['transfer-encoding'] !== undefined);
        // Защита от CSRF: запросы с телом принимаются только в JSON.
        if (hasBody && !String(req.headers['content-type'] ?? '').startsWith('application/json')) {
          throw new HttpError(415, 'bad_content_type', 'Ожидается application/json');
        }
        let match = null;
        let allowed = false;
        for (const r of routes) {
          const m = url.pathname.match(r.re);
          if (!m) continue;
          allowed = true;
          if (r.method === req.method) {
            match = { r, params: m.groups ?? {} };
            break;
          }
        }
        if (!match) throw new HttpError(allowed ? 405 : 404, 'not_found', 'Метод не найден');
        await autoFinish();
        const body = hasBody ? await readBody(req) : {};
        return send(res, 200, await match.r.handler({ req, res, body, url, params: match.params }));
      }
      if ((req.method === 'GET' || req.method === 'HEAD') && serveStatic(req, res, url)) return;
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8', ...SECURITY_HEADERS });
      res.end(fs.readFileSync(path.join(PUBLIC_DIR, '404.html')));
    } catch (err) {
      if (err instanceof HttpError) return send(res, err.status, { error: err.code, message: err.message });
      console.error(err);
      return send(res, 500, { error: 'internal', message: 'Внутренняя ошибка сервера' });
    }
  }

  const server = http.createServer((req, res) => {
    handle(req, res);
  });
  server.on('close', () => db.close());
  return { server, db };
}
