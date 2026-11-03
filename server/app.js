import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { openStorage } from './db.js';
import { hmacWithSecret, generateElectionKeys, electionCrypto } from './keys.js';
import { createVkIdentity } from './identity.js';
import { resultsXlsx } from './xlsx.js';
import {
  GENESIS_HASH,
  computeBlockHash,
  bigIntToBytes,
  bytesToHex,
  encryptBallot,
  fullDomainHash,
  importElectionPublicKey,
  randomBytes,
  importElectionPrivateKey,
  rsaPublicFromJwk,
  tallyBlocks,
  verifyTokenSignature,
} from '../public/js/core.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const MAX_BODY = 64 * 1024;
const MAX_PHOTO_BODY = 4 * 1024 * 1024;
const PHOTO_RE = /^\/photos\/[a-f0-9]{24}\.(jpg|png|webp)$/;

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

const SENT = Symbol('sent');

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
  // Название на сайте не показывается; нужно только для Excel и старых данных.
  const title = text(body.title, 'Название голосования', { max: 120 }) || 'Зрительское голосование';
  const description = text(body.description, 'Описание', { max: 1000 });
  let endsAt = null;
  if (body.endsAt) {
    const t = Date.parse(body.endsAt);
    if (Number.isNaN(t)) throw new HttpError(400, 'invalid', 'Некорректная дата окончания');
    endsAt = new Date(t).toISOString();
  }
  const candidates = Array.isArray(body.candidates) ? body.candidates : [];
  if (candidates.length < 2 || candidates.length > 40) {
    throw new HttpError(400, 'invalid', 'Добавьте от 2 до 40 участников');
  }
  return {
    title,
    description,
    endsAt,
    // Одна номинация на голосование; внутри хранится как список из одного вопроса.
    questions: [
      {
        id: 'q1',
        title,
        description: '',
        candidates: candidates.map((c, ci) => {
          const photo = String(c?.photo ?? '');
          if (photo && !PHOTO_RE.test(photo)) throw new HttpError(400, 'invalid', `Некорректное фото участника ${ci + 1}`);
          return {
            id: `c${ci + 1}`,
            name: text(c?.name, `Имя участника ${ci + 1}`, { min: 1, max: 120 }),
            description: text(c?.description, `Подпись участника ${ci + 1}`, { max: 300 }),
            photo: photo || null,
          };
        }),
      },
    ],
  };
}

export async function createApp(options = {}) {
  const dataDir = options.dataDir ?? path.join(ROOT, 'data');
  const db = await openStorage({ dataDir, databaseUrl: options.databaseUrl, log: options.log ?? console });
  const secret = hmacWithSecret(await db.secret());
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
  // Выдача бюллетеней — тоже по одному: проверка «уже выдан?» и запись идут без гонок.
  const withVoterLock = createMutex();
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
      const election = await db.election(id);
      if (!election) throw new HttpError(404, 'not_found', 'Голосование не найдено');
      if (election.status === 'finished') return election;
      if (election.status !== 'active') throw new HttpError(409, 'not_active', 'Голосование ещё не запущено');
      const blocks = await db.blocks(id, 0, Number.MAX_SAFE_INTEGER);
      const privateKey = await importElectionPrivateKey(cryptoFor(election).electionPrivateJwk);
      const tally = await tallyBlocks(election, blocks, privateKey);
      tally.lastBlockHash = blocks.length ? blocks[blocks.length - 1].hash : GENESIS_HASH;
      await db.finishElection(id, now().toISOString(), tally);
      return db.election(id);
    });
  }

  // Голосование с датой окончания завершается автоматически.
  async function autoFinish() {
    const active = await db.activeElection();
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
    };
  }

  async function adminElection(e) {
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
      stats: { ballotsIssued: await db.countVoters(e.id), ballotsCast: await db.countBlocks(e.id), simulated: e.simulated ?? 0 },
    };
  }

  // Публично видны только запущенные и завершённые голосования.
  async function publicElectionById(id) {
    const e = await db.election(id);
    if (!e || e.status === 'draft') throw new HttpError(404, 'not_found', 'Голосование не найдено');
    return e;
  }

  async function activeElectionById(id) {
    const e = await publicElectionById(id);
    if (e.status !== 'active') throw new HttpError(403, 'not_active', 'Приём голосов в этом голосовании завершён');
    return e;
  }

  // За прокси (Railway, nginx) реальный адрес приходит в заголовке. X-Real-IP
  // выставляет сам прокси; в X-Forwarded-For надёжен только последний адрес —
  // первые клиент может подставить сам.
  function clientIp(req) {
    if (trustProxy) {
      const real = req.headers['x-real-ip'];
      if (real) return String(real).trim();
      const fwd = req.headers['x-forwarded-for'];
      if (fwd) return fwd.split(',').at(-1).trim();
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

  // Для зрителя: идущее голосование или последнее завершённое (без итогов).
  route('GET', '/api/current', async () => {
    const e = (await db.activeElection()) ?? (await db.lastFinishedElection());
    return { election: e ? publicElection(e) : null, serverTime: now().toISOString() };
  });

  // Кто вошёл: имя из ВКонтакте хранится только в cookie самого пользователя.
  route('GET', '/api/me', async ({ req }) => ({
    user: identity.user(req),
    vkConfigured: identity.configured,
    devLogin: identity.devLogin,
  }));

  route('GET', '/api/elections/:id', async ({ params }) => ({
    election: publicElection(await publicElectionById(params.id)),
    serverTime: now().toISOString(),
  }));

  route('GET', '/api/elections/:id/session', async ({ req, params }) => {
    const e = await publicElectionById(params.id);
    const id = identity.identify(req);
    const voter = id ? await db.getVoter(e.id, id) : null;
    return { status: e.status, loggedIn: Boolean(id), ballotIssued: Boolean(voter), blinded: voter?.blinded ?? null };
  });

  // Шаг 1: избиратель получает слепую подпись на свой анонимный токен.
  route('POST', '/api/elections/:id/sign', async ({ req, body, params }) => {
    const e = await activeElectionById(params.id);
    const c = cryptoFor(e);
    const id = identity.identify(req);
    if (!id) throw new HttpError(401, 'no_session', 'Войдите через ВКонтакте, чтобы проголосовать');
    const blinded = String(body.blinded ?? '').toLowerCase();
    if (!/^[0-9a-f]+$/.test(blinded) || blinded.length !== c.rsaPub.bytes * 2) {
      throw new HttpError(400, 'bad_request', 'Некорректный запрос');
    }
    const ip = secret.hmac('ip:' + clientIp(req));
    return withVoterLock(async () => {
      const voter = await db.getVoter(e.id, id);
      if (voter) {
        // Повтор того же запроса (например, оборвалась связь) — отдаём ту же подпись.
        if (voter.blinded === blinded) return { blindSignature: voter.blind_sig };
        throw new HttpError(409, 'already_issued', 'С этого аккаунта ВКонтакте уже проголосовали в этом голосовании');
      }
      if (maxPerIp > 0 && (await db.countVotersByIp(e.id, ip)) >= maxPerIp) {
        throw new HttpError(429, 'ip_limit', 'Превышено число бюллетеней для вашей сети');
      }
      let blindSignature;
      try {
        blindSignature = c.blindSign(blinded);
      } catch {
        throw new HttpError(400, 'bad_request', 'Некорректный запрос');
      }
      await db.addVoter(e.id, { identity: id, ip, blinded, blindSig: blindSignature, issuedAt: now().toISOString() });
      return { blindSignature };
    });
  });

  // Шаг 2: анонимная отправка зашифрованного бюллетеня в реестр.
  route('POST', '/api/elections/:id/ballot', async ({ body, params }) => {
    const e = await activeElectionById(params.id);
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
      const existing = await db.blockByToken(e.id, token);
      if (existing) {
        // Повторная отправка того же бюллетеня возвращает ту же квитанцию.
        if (existing.ballot === ballot) return { block: existing, duplicate: true };
        throw new HttpError(409, 'token_used', 'По этому бюллетеню уже проголосовали');
      }
      if ((await db.election(e.id))?.status !== 'active') throw new HttpError(403, 'not_active', 'Голосование завершено');
      const block = await appendBlock(e, c, token, signature, ballot);
      return { block: { electionId: e.id, ...block } };
    });
  });

  // Запись бюллетеня в конец цепочки. Вызывается только внутри withLedgerLock.
  async function appendBlock(e, c, token, signature, ballot) {
    const last = await db.lastBlock(e.id);
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
    await db.addBlock(e.id, block);
    return block;
  }

  // ---------- админ-панель ----------

  route('GET', '/api/admin/elections', async ({ req }) => {
    requireAdmin(req);
    return {
      elections: await Promise.all((await db.elections()).map(adminElection)),
      maxVotesPerIp: maxPerIp,
      storageWarning: options.storageWarning ?? false,
      devTools: options.devTools ?? false,
      vkConfigured: identity.configured,
      devLogin: identity.devLogin,
    };
  });

  route('POST', '/api/admin/elections', async ({ req, body }) => {
    requireAdmin(req);
    const input = normalizeElectionInput(body);
    const id = 'e' + crypto.randomBytes(6).toString('hex');
    await db.insertElection({ id, ...input, createdAt: now().toISOString(), keys: generateElectionKeys() });
    return { election: await adminElection(await db.election(id)) };
  });

  route('PUT', '/api/admin/elections/:id', async ({ req, body, params }) => {
    requireAdmin(req);
    const e = await db.election(params.id);
    if (!e) throw new HttpError(404, 'not_found', 'Голосование не найдено');
    if (e.status !== 'draft') throw new HttpError(409, 'locked', 'Изменять можно только голосование, которое ещё не запущено');
    await db.updateElection(e.id, normalizeElectionInput(body));
    return { election: await adminElection(await db.election(e.id)) };
  });

  route('POST', '/api/admin/elections/:id/start', async ({ req, params }) => {
    requireAdmin(req);
    return withLedgerLock(async () => {
      const e = await db.election(params.id);
      if (!e) throw new HttpError(404, 'not_found', 'Голосование не найдено');
      if (e.status !== 'draft') throw new HttpError(409, 'bad_state', 'Голосование уже запускалось');
      const active = await db.activeElection();
      if (active) throw new HttpError(409, 'busy', `Сначала завершите текущее голосование «${active.title}»`);
      if (e.endsAt && Date.parse(e.endsAt) <= now().getTime()) {
        throw new HttpError(409, 'bad_state', 'Дата окончания уже прошла — измените её');
      }
      await db.startElection(e.id, now().toISOString());
      return { election: await adminElection(await db.election(e.id)) };
    });
  });

  route('POST', '/api/admin/elections/:id/finish', async ({ req, params }) => {
    requireAdmin(req);
    return { election: await adminElection(await finish(params.id)) };
  });

  // Фото участника: картинка уже уменьшена в браузере, сервер только проверяет и сохраняет.
  route('POST', '/api/admin/photos', async ({ req, body }) => {
    requireAdmin(req);
    const m = String(body.data ?? '').match(/^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/);
    if (!m) throw new HttpError(400, 'invalid', 'Загрузите картинку JPG, PNG или WebP');
    const buf = Buffer.from(m[2], 'base64');
    const magic = {
      jpeg: buf[0] === 0xff && buf[1] === 0xd8,
      png: buf.subarray(0, 4).toString('hex') === '89504e47',
      webp: buf.subarray(0, 4).toString() === 'RIFF' && buf.subarray(8, 12).toString() === 'WEBP',
    };
    if (!magic[m[1]] || buf.length > 3 * 1024 * 1024) throw new HttpError(400, 'invalid', 'Файл не похож на картинку или больше 3 МБ');
    const ext = { jpeg: 'jpg', png: 'png', webp: 'webp' }[m[1]];
    const name = `${crypto.randomBytes(12).toString('hex')}.${ext}`;
    await db.savePhoto(name, buf);
    return { url: `/photos/${name}` };
  });

  // ВРЕМЕННО, для проверки: симуляция голосов (только при DEV_TOOLS=1).
  // Голоса проходят тот же путь, что и настоящие: подпись, шифрование, запись в цепочку.
  route('POST', '/api/admin/elections/:id/simulate', async ({ req, body, params }) => {
    requireAdmin(req);
    if (!options.devTools) throw new HttpError(403, 'disabled', 'Симуляция выключена (включается переменной DEV_TOOLS=1)');
    const e = await activeElectionById(params.id);
    const q = e.questions[0];
    let choices = [];
    if (body.mode === 'manual') {
      for (const cand of q.candidates) {
        const n = Number(body.counts?.[cand.id] ?? 0);
        if (!Number.isInteger(n) || n < 0 || n > 5000) throw new HttpError(400, 'invalid', 'Число голосов — целое от 0 до 5000');
        choices.push(...Array(n).fill(cand.id));
      }
    } else {
      const count = Number(body.count);
      if (!Number.isInteger(count) || count < 1 || count > 5000) throw new HttpError(400, 'invalid', 'Число голосов — целое от 1 до 5000');
      // Случайные «симпатии» зрителей, чтобы итоги не были ровными.
      const weights = q.candidates.map(() => 0.2 + Math.random());
      const sum = weights.reduce((a, b) => a + b, 0);
      for (let i = 0; i < count; i++) {
        let r = Math.random() * sum;
        const k = weights.findIndex((w) => (r -= w) <= 0);
        choices.push(q.candidates[k === -1 ? weights.length - 1 : k].id);
      }
    }
    if (!choices.length) throw new HttpError(400, 'invalid', 'Укажите хотя бы один голос');
    if (choices.length > 5000) throw new HttpError(400, 'invalid', 'За один раз — не больше 5000 голосов');
    choices = choices.sort(() => Math.random() - 0.5);

    const c = cryptoFor(e);
    const electionKey = await importElectionPublicKey(c.public.election);
    return withLedgerLock(async () => {
      if ((await db.election(e.id))?.status !== 'active') throw new HttpError(403, 'not_active', 'Голосование завершено');
      for (const cid of choices) {
        const token = bytesToHex(randomBytes(32));
        const fdh = bytesToHex(bigIntToBytes(await fullDomainHash(token, c.rsaPub), c.rsaPub.bytes));
        const ballot = await encryptBallot(e.id, { [q.id]: cid }, electionKey);
        await appendBlock(e, c, token, c.blindSign(fdh), ballot);
      }
      await db.addSimulated(e.id, choices.length);
      return { added: choices.length, election: await adminElection(await db.election(e.id)) };
    });
  });

  // Итоги в Excel: баллы = голоса / всего × 160 (формулой).
  route('GET', '/api/admin/elections/:id/results.xlsx', async ({ req, res, params }) => {
    requireAdmin(req);
    const e = await db.election(params.id);
    if (!e) throw new HttpError(404, 'not_found', 'Голосование не найдено');
    if (!e.tally) throw new HttpError(409, 'not_finished', 'Итоги появятся после завершения голосования');
    const q = e.questions[0];
    const file = resultsXlsx({
      title: 'Зрительское голосование «Выпускник Краснообска 2026»',
      finishedAt: new Date(e.finishedAt).toLocaleString('ru-RU', { timeZone: 'Asia/Novosibirsk' }),
      candidates: q.candidates.map((c) => ({ name: c.name, description: c.description, votes: e.tally.counts[q.id][c.id] ?? 0 })),
    });
    res.writeHead(200, {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="results.xlsx"; filename*=UTF-8''${encodeURIComponent('Итоги зрительского голосования.xlsx')}`,
      'Cache-Control': 'no-store',
      ...SECURITY_HEADERS,
    });
    res.end(file);
    return SENT;
  });

  route('DELETE', '/api/admin/elections/:id', async ({ req, params }) => {
    requireAdmin(req);
    return withLedgerLock(async () => {
      const e = await db.election(params.id);
      if (!e) throw new HttpError(404, 'not_found', 'Голосование не найдено');
      if (e.status === 'active') throw new HttpError(409, 'bad_state', 'Сначала завершите голосование');
      await db.deleteElection(e.id);
      cryptoCache.delete(e.id);
      // Вместе с голосованием удаляются и фото его участников.
      for (const c of e.questions.flatMap((q) => q.candidates)) {
        if (c.photo && PHOTO_RE.test(c.photo)) await db.deletePhoto(path.basename(c.photo));
      }
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

  function readBody(req, limit = MAX_BODY) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on('data', (c) => {
        size += c.length;
        if (size > limit) {
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

  // Фото участников лежат в базе (или в DATA_DIR/photos для SQLite).
  async function servePhoto(req, res, url) {
    if (!PHOTO_RE.test(url.pathname)) return false;
    const name = path.basename(url.pathname);
    const data = await db.photo(name);
    if (!data) return false;
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(name)] ?? 'application/octet-stream',
      'Content-Length': data.length,
      'Cache-Control': 'public, max-age=86400, immutable',
      ...SECURITY_HEADERS,
    });
    res.end(req.method === 'HEAD' ? undefined : data);
    return true;
  }

  // Старые страницы (голосование, проверка, реестр, итоги) — теперь всё на главной.
  const LEGACY = new Set(['/vote', '/verify', '/ledger', '/results', '/vote.html', '/verify.html', '/ledger.html', '/results.html']);

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
    // Браузер каждый раз сверяется с сервером (ETag), поэтому после деплоя сразу получает новые стили и скрипты.
    const etag = `"${stat.size.toString(36)}-${Math.floor(stat.mtimeMs).toString(36)}"`;
    const cache = { 'Cache-Control': 'no-cache', ETag: etag };
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, { ...cache, ...SECURITY_HEADERS });
      res.end();
      return true;
    }
    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': stat.size,
      ...cache,
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
        const body = hasBody ? await readBody(req, url.pathname === '/api/admin/photos' ? MAX_PHOTO_BODY : MAX_BODY) : {};
        const result = await match.r.handler({ req, res, body, url, params: match.params });
        if (result !== SENT) send(res, 200, result);
        return;
      }
      if (req.method === 'GET' || req.method === 'HEAD') {
        if (LEGACY.has(url.pathname)) {
          res.writeHead(301, { Location: '/' + url.search, ...SECURITY_HEADERS });
          return res.end();
        }
        if ((await servePhoto(req, res, url)) || serveStatic(req, res, url)) return;
      }
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
  server.on('close', () => {
    db.close().catch(() => {});
  });
  return { server, db };
}
