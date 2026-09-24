import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { openDb } from './db.js';
import { loadKeys } from './keys.js';
import { createDeviceIdentity } from './identity.js';
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
const MAX_BODY = 16 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

const SECURITY_HEADERS = {
  'Content-Security-Policy': [
    "default-src 'self'",
    "style-src 'self' https://fonts.googleapis.com",
    'font-src https://fonts.gstatic.com',
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

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// Простая очередь: блоки добавляются строго по одному, иначе два
// одновременных бюллетеня получили бы один и тот же номер блока.
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

export function loadElection(configPath) {
  const election = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  if (!election.id || !Array.isArray(election.questions) || !election.questions.length) {
    throw new Error('Некорректный файл конфигурации голосования');
  }
  return election;
}

export async function createApp(options = {}) {
  const dataDir = options.dataDir ?? path.join(ROOT, 'data');
  fs.mkdirSync(dataDir, { recursive: true });

  const election = loadElection(options.configPath ?? path.join(ROOT, 'config', 'election.json'));
  const keys = loadKeys(dataDir);
  const db = openDb(dataDir);
  const rsaPub = rsaPublicFromJwk(keys.public.blindSign);
  const identity = createDeviceIdentity(keys, { secureCookies: options.secureCookies ?? false });
  const maxPerIp = options.maxVotesPerIp ?? 0;
  const trustProxy = options.trustProxy ?? false;
  const adminToken = options.adminToken;
  const now = options.now ?? (() => new Date());
  const withLedgerLock = createMutex();
  const apiLimiter = createRateLimiter({ windowMs: 60_000, max: options.rateLimit ?? 120 });

  // ---------- состояние голосования ----------

  function status() {
    if (db.getState('closed')) return 'ended';
    const t = now().getTime();
    if (t < Date.parse(election.startsAt)) return 'upcoming';
    if (t > Date.parse(election.endsAt)) return 'ended';
    return 'active';
  }

  // После окончания голосования комиссия публикует закрытый ключ
  // шифрования и итоги — любой может пересчитать голоса сам.
  let finalizing = null;
  async function finalize() {
    const existing = db.getState('tally');
    if (existing) return existing;
    finalizing ??= withLedgerLock(async () => {
      const blocks = db.blocks(0, Number.MAX_SAFE_INTEGER);
      const privateKey = await importElectionPrivateKey(keys.electionPrivateJwk);
      const tally = await tallyBlocks(election, blocks, privateKey);
      const result = {
        ...tally,
        lastBlockHash: blocks.length ? blocks[blocks.length - 1].hash : GENESIS_HASH,
        finalizedAt: now().toISOString(),
      };
      db.transaction(() => {
        db.setState('closed', true);
        db.setState('tally', result);
      });
      return result;
    }).finally(() => {
      finalizing = null;
    });
    return finalizing;
  }

  async function currentTally() {
    if (status() !== 'ended') return null;
    return finalize();
  }

  function clientIp(req) {
    if (trustProxy) {
      const fwd = req.headers['x-forwarded-for'];
      if (fwd) return fwd.split(',')[0].trim();
    }
    return req.socket.remoteAddress ?? 'unknown';
  }

  function publicElection() {
    return {
      id: election.id,
      title: election.title,
      subtitle: election.subtitle,
      location: election.location,
      organizer: election.organizer,
      startsAt: election.startsAt,
      endsAt: election.endsAt,
      questions: election.questions,
    };
  }

  // ---------- обработчики API ----------

  const routes = {
    'GET /api/election': async () => {
      const tally = await currentTally();
      return {
        election: publicElection(),
        status: status(),
        serverTime: now().toISOString(),
        publicKeys: keys.public,
        electionPrivateKey: tally ? keys.electionPrivateJwk : null,
        stats: { ballotsIssued: db.countVoters(), ballotsCast: db.countBlocks() },
        identityProvider: identity.name,
      };
    },

    'GET /api/session': async (req, res) => {
      identity.ensure(req, res);
      const voter = db.getVoter(identity.identify(req) ?? '');
      return {
        status: status(),
        identityProvider: identity.name,
        ballotIssued: Boolean(voter),
        blinded: voter?.blinded ?? null,
      };
    },

    // Шаг 1: избиратель получает слепую подпись на свой анонимный токен.
    'POST /api/sign': async (req, res, body) => {
      if (status() !== 'active') throw new HttpError(403, 'not_active', 'Голосование сейчас не проводится');
      const id = identity.identify(req);
      if (!id) throw new HttpError(401, 'no_session', 'Сессия не найдена. Обновите страницу');
      const blinded = String(body.blinded ?? '').toLowerCase();
      if (!/^[0-9a-f]+$/.test(blinded) || blinded.length !== rsaPub.bytes * 2) {
        throw new HttpError(400, 'bad_request', 'Некорректный запрос');
      }

      const ip = keys.hmac('ip:' + clientIp(req));
      return db.transaction(() => {
        const voter = db.getVoter(id);
        if (voter) {
          // Повтор того же запроса (например, оборвалась связь) — отдаём ту же подпись.
          if (voter.blinded === blinded) return { blindSignature: voter.blind_sig };
          throw new HttpError(409, 'already_issued', 'Бюллетень уже был выдан на этом устройстве');
        }
        if (maxPerIp > 0 && db.countVotersByIp(ip) >= maxPerIp) {
          throw new HttpError(429, 'ip_limit', 'Превышено число бюллетеней для вашей сети');
        }
        let blindSignature;
        try {
          blindSignature = keys.blindSign(blinded);
        } catch {
          throw new HttpError(400, 'bad_request', 'Некорректный запрос');
        }
        db.addVoter({ identity: id, ip, blinded, blindSig: blindSignature, issuedAt: now().toISOString() });
        return { blindSignature };
      });
    },

    // Шаг 2: анонимная отправка зашифрованного бюллетеня в реестр.
    'POST /api/ballot': async (req, res, body) => {
      if (status() !== 'active') throw new HttpError(403, 'not_active', 'Голосование сейчас не проводится');
      const token = String(body.token ?? '');
      const signature = String(body.signature ?? '').toLowerCase();
      const ballot = String(body.ballot ?? '');
      if (!/^[0-9a-f]{64}$/.test(token) || !/^[A-Za-z0-9_-]{100,2000}$/.test(ballot)) {
        throw new HttpError(400, 'bad_request', 'Некорректный бюллетень');
      }
      if (!(await verifyTokenSignature(token, signature, rsaPub))) {
        throw new HttpError(403, 'bad_signature', 'Подпись комиссии на бюллетене недействительна');
      }

      return withLedgerLock(async () => {
        const existing = db.blockByToken(token);
        if (existing) {
          // Повторная отправка того же бюллетеня возвращает ту же квитанцию.
          if (existing.ballot === ballot) return { block: existing, duplicate: true };
          throw new HttpError(409, 'token_used', 'По этому бюллетеню уже проголосовали');
        }
        if (status() !== 'active') throw new HttpError(403, 'not_active', 'Голосование завершено');
        const last = db.lastBlock();
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
        block.ledgerSignature = keys.signBlock(block.hash);
        db.addBlock(block);
        return { block };
      });
    },

    'GET /api/ledger': async (req, res, body, url) => {
      const from = Math.max(0, parseInt(url.searchParams.get('from') ?? '0', 10) || 0);
      const limit = Math.min(500, Math.max(1, parseInt(url.searchParams.get('limit') ?? '50', 10) || 50));
      return { total: db.countBlocks(), blocks: db.blocks(from, limit) };
    },

    'GET /api/results': async () => {
      const tally = await currentTally();
      return {
        status: status(),
        stats: { ballotsIssued: db.countVoters(), ballotsCast: db.countBlocks() },
        tally,
      };
    },

    'GET /api/admin/status': async (req) => {
      requireAdmin(req);
      return {
        status: status(),
        stats: { ballotsIssued: db.countVoters(), ballotsCast: db.countBlocks() },
        maxVotesPerIp: maxPerIp,
        tally: db.getState('tally'),
      };
    },

    // Досрочное завершение: публикация ключа и подсчёт.
    'POST /api/admin/close': async (req) => {
      requireAdmin(req);
      const tally = await finalize();
      return { status: status(), tally };
    },
  };

  function requireAdmin(req) {
    const header = req.headers.authorization ?? '';
    const given = Buffer.from(header.replace(/^Bearer\s+/i, ''));
    const expected = Buffer.from(adminToken ?? '');
    if (!adminToken || given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
      throw new HttpError(401, 'unauthorized', 'Неверный ключ администратора');
    }
  }

  // Отдельный маршрут: квитанция по хешу блока.
  async function ledgerBlock(hash) {
    if (!/^[0-9a-f]{64}$/.test(hash)) throw new HttpError(400, 'bad_request', 'Некорректный номер квитанции');
    const block = db.blockByHash(hash);
    if (!block) throw new HttpError(404, 'not_found', 'Бюллетень с таким номером не найден в реестре');
    const prev = block.index > 0 ? db.blockByIndex(block.index - 1) : null;
    const next = db.blockByIndex(block.index + 1);
    return { block, prev, nextHash: next?.hash ?? null, total: db.countBlocks() };
  }

  // ---------- HTTP ----------

  function send(res, status, payload, headers = {}) {
    const body = JSON.stringify(payload);
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...SECURITY_HEADERS,
      ...headers,
    });
    res.end(body);
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
    let rel = decodeURIComponent(url.pathname);
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
      if (url.pathname.startsWith('/api/')) {
        if (!apiLimiter(clientIp(req))) throw new HttpError(429, 'rate_limited', 'Слишком много запросов. Попробуйте через минуту');
        if (req.method === 'POST') {
          // Защита от CSRF: API принимает только JSON.
          if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) {
            throw new HttpError(415, 'bad_content_type', 'Ожидается application/json');
          }
        }
        const blockMatch = url.pathname.match(/^\/api\/ledger\/([0-9a-fA-F]+)$/);
        if (req.method === 'GET' && blockMatch) return send(res, 200, await ledgerBlock(blockMatch[1].toLowerCase()));
        const handler = routes[`${req.method} ${url.pathname}`];
        if (!handler) throw new HttpError(404, 'not_found', 'Метод не найден');
        const body = req.method === 'POST' ? await readBody(req) : {};
        return send(res, 200, await handler(req, res, body, url));
      }
      if ((req.method === 'GET' || req.method === 'HEAD') && serveStatic(req, res, url)) return;
      const notFound = path.join(PUBLIC_DIR, '404.html');
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8', ...SECURITY_HEADERS });
      res.end(fs.existsSync(notFound) ? fs.readFileSync(notFound) : 'Not found');
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
  return { server, db, keys, election };
}
