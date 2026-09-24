// Идентификация избирателя по номеру телефона с кодом из SMS (SMS.RU):
// один номер — один голос в каждом голосовании.
//
// Защита от накрутки SMS (иначе боты могут обнулить баланс):
//  - «невидимая капча»: перед отправкой браузер решает вычислительную задачу;
//  - лимиты: пауза между SMS на номер, число SMS на номер и на IP, общий дневной лимит;
//  - только российские мобильные номера (+7 9xx);
//  - SMS.RU получает IP посетителя и сам блокирует флуд.
// Номер телефона нигде не сохраняется: в сессии и в реестре избирателей — только HMAC.

import crypto from 'node:crypto';

const SESSION = 'vss';
const SESSION_TTL = 7 * 24 * 60 * 60;
const CODE_TTL = 5 * 60 * 1000;
const CODE_ATTEMPTS = 5;
const RESEND_AFTER = 60 * 1000;
const PHONE_DAILY = 5;
const IP_HOURLY = 30;
const CHALLENGE_TTL = 10 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

export class AuthError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

export function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

// +7 (912) 345-67-89, 89123456789, 9123456789 → 79123456789. Только мобильные РФ.
export function normalizePhone(value) {
  let d = String(value ?? '').replace(/\D/g, '');
  if (d.length === 10) d = '7' + d;
  if (d.length === 11 && d[0] === '8') d = '7' + d.slice(1);
  return /^79\d{9}$/.test(d) ? d : null;
}

export function maskPhone(phone) {
  return `+7 ${phone.slice(1, 4)} •••-••-${phone.slice(9, 11)}`;
}

function leadingZeroBits(buf) {
  let bits = 0;
  for (const byte of buf) {
    if (byte === 0) {
      bits += 8;
      continue;
    }
    bits += Math.clz32(byte) - 24;
    break;
  }
  return bits;
}

// Отправка через SMS.RU: https://sms.ru/api/send
export function smsRuSender({ apiId, test = false, fetch: fetchImpl = fetch }) {
  return async (phone, text, ip) => {
    const params = new URLSearchParams({ api_id: apiId, to: phone, msg: text, json: '1' });
    if (ip) params.set('ip', ip);
    if (test) params.set('test', '1');
    const res = await fetchImpl('https://sms.ru/sms/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params,
    });
    const data = await res.json();
    const item = data?.sms?.[phone];
    if (data?.status !== 'OK' || item?.status !== 'OK') {
      throw new Error(item?.status_text ?? data?.status_text ?? `SMS.RU: код ${item?.status_code ?? data?.status_code}`);
    }
  };
}

export function createPhoneIdentity(secret, options = {}) {
  const secure = options.secureCookies ?? false;
  const devLogin = options.devLogin ?? false;
  const difficulty = options.powDifficulty ?? 16;
  const dailyLimit = options.smsDailyLimit ?? 500;
  const resendAfter = options.smsResendAfter ?? RESEND_AFTER;
  const now = () => Date.now();
  const send =
    options.smsSender ??
    (options.smsApiId ? smsRuSender({ apiId: options.smsApiId, test: options.smsTest, fetch: options.fetch }) : null);

  const codes = new Map(); // HMAC номера → { hash, expires, attempts, sentAt, day: [времена отправок] }
  const ipSends = new Map(); // IP → [времена отправок]
  const usedChallenges = new Map();
  let daily = { start: now(), count: 0 };

  setInterval(() => {
    const t = now();
    for (const [k, v] of codes) if (v.sentAt + DAY < t) codes.delete(k);
    for (const [k, v] of ipSends) if (!v.some((x) => x + HOUR > t)) ipSends.delete(k);
    for (const [k, exp] of usedChallenges) if (exp < t) usedChallenges.delete(k);
  }, 10 * 60 * 1000).unref();

  const mac = (s) => secret.hmac(s);
  const hashCode = (phoneKey, code) => mac(`code:${phoneKey}:${code}`);

  const sign = (payload) => {
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    return `${body}.${mac('session:' + body).slice(0, 43)}`;
  };
  const verify = (value) => {
    if (!value) return null;
    const [body, sig] = value.split('.');
    if (!body || !sig) return null;
    const expected = mac('session:' + body).slice(0, 43);
    if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
    try {
      const data = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
      return data.exp > now() / 1000 ? data : null;
    } catch {
      return null;
    }
  };
  const cookie = (value, maxAge) => {
    const attrs = [`${SESSION}=${value}`, 'Path=/', `Max-Age=${maxAge}`, 'HttpOnly', 'SameSite=Lax'];
    if (secure) attrs.push('Secure');
    return attrs.join('; ');
  };
  const session = (req) => verify(parseCookies(req.headers.cookie)[SESSION]);

  function checkChallenge(challenge, nonce) {
    const [ts, rand, sig] = String(challenge ?? '').split('.');
    if (!ts || !rand || !sig || sig !== mac(`pow:${ts}.${rand}`).slice(0, 32)) {
      throw new AuthError(400, 'bad_challenge', 'Проверка не пройдена. Обновите страницу');
    }
    if (Number(ts) + CHALLENGE_TTL < now()) throw new AuthError(400, 'bad_challenge', 'Проверка устарела. Попробуйте ещё раз');
    if (usedChallenges.has(challenge)) throw new AuthError(400, 'bad_challenge', 'Проверка уже использована. Попробуйте ещё раз');
    const hash = crypto.createHash('sha256').update(`${challenge}:${nonce}`).digest();
    if (!/^\d{1,12}$/.test(String(nonce)) || leadingZeroBits(hash) < difficulty) {
      throw new AuthError(400, 'bad_challenge', 'Проверка не пройдена. Попробуйте ещё раз');
    }
    usedChallenges.set(challenge, Number(ts) + CHALLENGE_TTL);
  }

  return {
    name: 'phone',
    configured: Boolean(send),
    devLogin,

    // Ключ для реестра избирателей: HMAC от номера, сам номер не хранится.
    identify(req) {
      return session(req)?.uid ?? null;
    },

    user(req) {
      const s = session(req);
      return s ? { phone: s.masked } : null;
    },

    challenge() {
      const ts = String(now());
      const rand = crypto.randomBytes(12).toString('base64url');
      return { challenge: `${ts}.${rand}.${mac(`pow:${ts}.${rand}`).slice(0, 32)}`, difficulty };
    },

    async sendCode(body, ip) {
      const phone = normalizePhone(body.phone);
      if (!phone) throw new AuthError(400, 'bad_phone', 'Введите российский мобильный номер: +7 9XX XXX-XX-XX');
      if (!send && !devLogin) throw new AuthError(503, 'sms_off', 'Отправка SMS ещё не настроена организаторами');
      checkChallenge(body.challenge, body.nonce);

      const t = now();
      const key = mac('phone:' + phone);
      const entry = codes.get(key);
      if (entry && entry.sentAt + resendAfter > t) {
        const wait = Math.ceil((entry.sentAt + resendAfter - t) / 1000);
        throw new AuthError(429, 'too_soon', `Новый код можно запросить через ${wait} с`, { resendIn: wait });
      }
      const dayList = (entry?.day ?? []).filter((x) => x + DAY > t);
      if (dayList.length >= PHONE_DAILY) throw new AuthError(429, 'phone_limit', 'На этот номер уже отправлено много кодов. Попробуйте завтра');
      const ipList = (ipSends.get(ip) ?? []).filter((x) => x + HOUR > t);
      if (ipList.length >= IP_HOURLY) throw new AuthError(429, 'ip_limit', 'Слишком много запросов кодов из вашей сети. Попробуйте позже');
      if (daily.start + DAY < t) daily = { start: t, count: 0 };
      if (daily.count >= dailyLimit) throw new AuthError(503, 'daily_limit', 'Дневной лимит SMS исчерпан. Попробуйте позже');

      const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
      if (send) {
        try {
          await send(phone, `Код для голосования «Выпускник Краснообска»: ${code}. Никому его не сообщайте.`, ip);
        } catch (err) {
          console.error('SMS:', err.message);
          throw new AuthError(502, 'sms_failed', 'Не удалось отправить SMS. Проверьте номер и попробуйте ещё раз');
        }
      } else {
        console.warn(`[DEV_LOGIN] Код для ${maskPhone(phone)}: ${code}`);
      }
      daily.count++;
      ipSends.set(ip, [...ipList, t]);
      codes.set(key, { hash: hashCode(key, code), expires: t + CODE_TTL, attempts: 0, sentAt: t, day: [...dayList, t] });
      return { sent: true, phone: maskPhone(phone), resendIn: Math.ceil(resendAfter / 1000), ...(send ? {} : { devCode: code }) };
    },

    verifyCode(body) {
      const phone = normalizePhone(body.phone);
      const code = String(body.code ?? '').replace(/\D/g, '');
      if (!phone) throw new AuthError(400, 'bad_phone', 'Некорректный номер телефона');
      const key = mac('phone:' + phone);
      const entry = codes.get(key);
      if (!entry || entry.expires < now() || entry.attempts >= CODE_ATTEMPTS) {
        throw new AuthError(400, 'code_expired', 'Код устарел. Запросите новый');
      }
      entry.attempts++;
      const expected = Buffer.from(entry.hash);
      const given = Buffer.from(hashCode(key, code));
      if (code.length !== 6 || !crypto.timingSafeEqual(expected, given)) {
        const left = CODE_ATTEMPTS - entry.attempts;
        throw new AuthError(400, 'bad_code', left > 0 ? `Неверный код. Осталось попыток: ${left}` : 'Неверный код. Запросите новый');
      }
      entry.expires = 0; // код одноразовый
      const exp = Math.floor(now() / 1000) + SESSION_TTL;
      return { cookie: cookie(sign({ uid: key, masked: maskPhone(phone), exp }), SESSION_TTL), user: { phone: maskPhone(phone) } };
    },

    logoutCookie: () => cookie('', 0),
  };
}
