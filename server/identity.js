// Идентификация избирателя через VK ID: один аккаунт ВКонтакте — один голос
// в каждом голосовании.
//
// Вход — OAuth 2.1 с PKCE (https://id.vk.ru/about/business/go/docs):
//   /auth/vk/start    → перенаправление на id.vk.ru/authorize;
//   /auth/vk/callback → сервер меняет код на токен, узнаёт user_id и выдаёт
//                       подписанную cookie сессии; страница без скриптов.
// В реестр избирателей попадает только HMAC от идентификатора ВКонтакте,
// поэтому по базе нельзя узнать, какие аккаунты голосовали.

import crypto from 'node:crypto';

const SESSION = 'vks';
const PKCE = 'vkp';
const SESSION_TTL = 7 * 24 * 60 * 60;
const PKCE_TTL = 10 * 60;

export function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

const b64u = (buf) => Buffer.from(buf).toString('base64url');

// Разрешаем возвращаться только на свои страницы.
export function safeReturn(value) {
  const s = String(value ?? '');
  return /^\/(?![/\\])[\w\-./?=&%]*$/.test(s) ? s : '/';
}

export function createVkIdentity(secret, options = {}) {
  const clientId = options.vkClientId ?? '';
  const host = options.vkHost ?? 'https://id.vk.ru';
  // Адрес сайта: задан явно (publicUrl) или берётся из запроса — с какого домена зашли,
  // туда VK ID и вернёт. Каждый такой адрес должен быть в «доверенных Redirect URL» приложения VK ID.
  const fixedOrigin = (options.publicUrl ?? '').replace(/\/+$/, '');
  const originOf = (req) => fixedOrigin || options.origin?.(req) || `http://${req.headers.host ?? 'localhost'}`;
  // Secure-cookie — всегда, когда сайт открыт по HTTPS (можно принудительно через secureCookies).
  const isSecure = (req) => options.secureCookies ?? originOf(req).startsWith('https://');
  const devLogin = options.devLogin ?? false;
  const fetchImpl = options.fetch ?? fetch;

  const sign = (payload) => {
    const body = b64u(JSON.stringify(payload));
    return `${body}.${secret.hmac('session:' + body).slice(0, 43)}`;
  };
  const verify = (value) => {
    if (!value) return null;
    const [body, mac] = value.split('.');
    if (!body || !mac) return null;
    const expected = secret.hmac('session:' + body).slice(0, 43);
    if (mac.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return null;
    try {
      const data = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
      return data.exp > Date.now() / 1000 ? data : null;
    } catch {
      return null;
    }
  };
  const cookie = (req, name, value, maxAge, sameSite = 'Lax') => {
    const attrs = [`${name}=${value}`, 'Path=/', `Max-Age=${maxAge}`, 'HttpOnly', `SameSite=${sameSite}`];
    if (isSecure(req)) attrs.push('Secure');
    return attrs.join('; ');
  };

  function session(req) {
    return verify(parseCookies(req.headers.cookie)[SESSION]);
  }

  function startSession(req, user) {
    const exp = Math.floor(Date.now() / 1000) + SESSION_TTL;
    return cookie(req, SESSION, sign({ uid: String(user.id), name: user.name ?? '', exp }), SESSION_TTL);
  }

  function redirect(res, location, cookies = []) {
    res.writeHead(302, { Location: location, 'Set-Cookie': cookies, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
    res.end();
  }

  return {
    name: 'vk',
    configured: Boolean(clientId),
    devLogin,

    // Ключ для реестра избирателей: подпись выдаётся один раз на аккаунт в каждом голосовании.
    identify(req) {
      const s = session(req);
      return s ? secret.hmac('vk:' + s.uid) : null;
    },

    user(req) {
      const s = session(req);
      return s ? { name: s.name } : null;
    },

    // Начало входа: генерируем state и code_verifier, запоминаем их в короткой cookie.
    start(req, res, url) {
      if (!clientId) return redirect(res, '/?auth=not_configured');
      const redirectUri = `${originOf(req)}/auth/vk/callback`;
      const state = b64u(crypto.randomBytes(32));
      const verifier = b64u(crypto.randomBytes(48));
      const challenge = b64u(crypto.createHash('sha256').update(verifier).digest());
      const back = safeReturn(url.searchParams.get('return'));
      const pkce = sign({ state, verifier, back, redirectUri, exp: Math.floor(Date.now() / 1000) + PKCE_TTL });
      const params = new URLSearchParams({
        response_type: 'code',
        client_id: clientId,
        redirect_uri: redirectUri,
        state,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        scope: 'vkid.personal_info',
        scheme: 'dark',
      });
      redirect(res, `${host}/authorize?${params}`, [cookie(req, PKCE, pkce, PKCE_TTL)]);
    },

    // Возврат из VK ID: меняем код на токен и узнаём пользователя.
    async callback(req, res, url) {
      const clear = cookie(req, PKCE, '', 0);
      const pkce = verify(parseCookies(req.headers.cookie)[PKCE]);
      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');
      const deviceId = url.searchParams.get('device_id');
      if (!pkce || !code || !state || !deviceId || state !== pkce.state) {
        return redirect(res, '/?auth=failed', [clear]);
      }
      try {
        const post = async (path, params) => {
          const r = await fetchImpl(`${host}${path}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams(params),
          });
          const data = await r.json();
          if (!r.ok || data.error) throw new Error(data.error_description ?? data.error ?? `HTTP ${r.status}`);
          return data;
        };
        const tokens = await post('/oauth2/auth', {
          grant_type: 'authorization_code',
          code_verifier: pkce.verifier,
          // Тот же адрес, что и при начале входа (запомнен в подписанной cookie).
          redirect_uri: pkce.redirectUri,
          code,
          client_id: clientId,
          device_id: deviceId,
          state,
        });
        const info = await post('/oauth2/user_info', { client_id: clientId, access_token: tokens.access_token });
        const uid = info.user?.user_id ?? tokens.user_id;
        if (!uid) throw new Error('VK ID не вернул идентификатор пользователя');
        const name = [info.user?.first_name, info.user?.last_name].filter(Boolean).join(' ');
        redirect(res, pkce.back, [clear, startSession(req, { id: uid, name })]);
      } catch (err) {
        console.error('VK ID:', err.message);
        redirect(res, '/?auth=failed', [clear]);
      }
    },

    // Тестовый вход без ВКонтакте (только при DEV_LOGIN=1 — для проверки на своём компьютере).
    dev(req, res, url) {
      const uid = String(url.searchParams.get('uid') ?? '').replace(/\D/g, '') || String(crypto.randomInt(1e9));
      redirect(res, safeReturn(url.searchParams.get('return')), [startSession(req, { id: 'dev' + uid, name: `Тестовый пользователь ${uid}` })]);
    },

    logout(req, res) {
      redirect(res, '/', [cookie(req, SESSION, '', 0)]);
    },
  };
}
