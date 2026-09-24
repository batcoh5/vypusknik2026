// Идентификация избирателя.
//
// Сейчас используется «защита по устройству»: подписанная httpOnly-cookie
// с постоянным идентификатором (+ необязательный лимит бюллетеней на IP).
// Позже сюда добавится провайдер «phone»: после подтверждения SMS-кода
// идентификатором станет номер телефона. Остальной код менять не придётся —
// в реестр избирателей попадает только HMAC от идентификатора.

import crypto from 'node:crypto';

const COOKIE = 'vid';
const YEAR = 365 * 24 * 60 * 60;

export function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function createDeviceIdentity(secret, { secureCookies }) {
  const sign = (id) => secret.hmac('cookie:' + id).slice(0, 32);

  function read(req) {
    const value = parseCookies(req.headers.cookie)[COOKIE];
    if (!value) return null;
    const [id, mac] = value.split('.');
    if (!id || !mac || !/^[0-9a-f]{32}$/.test(id)) return null;
    const expected = sign(id);
    if (mac.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) {
      return null;
    }
    return id;
  }

  return {
    name: 'device',

    // Возвращает идентификатор устройства, при необходимости выдаёт новую cookie.
    ensure(req, res) {
      let id = read(req);
      if (!id) {
        id = crypto.randomBytes(16).toString('hex');
        const attrs = [`${COOKIE}=${id}.${sign(id)}`, 'Path=/', `Max-Age=${YEAR}`, 'HttpOnly', 'SameSite=Strict'];
        if (secureCookies) attrs.push('Secure');
        res.setHeader('Set-Cookie', attrs.join('; '));
      }
      return id;
    },

    // Ключ для реестра избирателей (подпись выдаётся один раз на ключ в каждом голосовании).
    identify(req) {
      const id = read(req);
      return id ? secret.hmac('device:' + id) : null;
    },
  };
}
