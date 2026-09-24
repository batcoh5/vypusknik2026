// Ключи комиссии. Создаются при первом запуске и хранятся в DATA_DIR/keys.json.
//  - blindSign: RSA-2048, слепая подпись анонимных токенов избирателей;
//  - election:  ECDH P-256, шифрование бюллетеней (закрытая часть публикуется
//               только после окончания голосования);
//  - ledger:    ECDSA P-256, подпись блоков реестра (квитанции избирателей);
//  - hmac:      секрет для хеширования идентификаторов избирателей.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

function generate() {
  const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, publicExponent: 65537 });
  const election = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const ledger = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return {
    createdAt: new Date().toISOString(),
    blindSign: rsa.privateKey.export({ format: 'jwk' }),
    election: election.privateKey.export({ format: 'jwk' }),
    ledger: ledger.privateKey.export({ format: 'jwk' }),
    hmac: crypto.randomBytes(32).toString('hex'),
  };
}

function publicJwk(jwk) {
  if (jwk.kty === 'RSA') return { kty: 'RSA', n: jwk.n, e: jwk.e };
  return { kty: 'EC', crv: jwk.crv, x: jwk.x, y: jwk.y };
}

export function loadKeys(dataDir) {
  const file = path.join(dataDir, 'keys.json');
  let raw;
  if (fs.existsSync(file)) {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } else {
    raw = generate();
    fs.writeFileSync(file, JSON.stringify(raw, null, 2), { mode: 0o600 });
  }

  const rsaPrivate = crypto.createPrivateKey({ key: raw.blindSign, format: 'jwk' });
  const ledgerPrivate = crypto.createPrivateKey({ key: raw.ledger, format: 'jwk' });
  const modulusBytes = Buffer.from(raw.blindSign.n, 'base64url').length;

  return {
    public: {
      blindSign: publicJwk(raw.blindSign),
      election: publicJwk(raw.election),
      ledger: publicJwk(raw.ledger),
    },
    electionPrivateJwk: { ...raw.election, key_ops: ['deriveBits'], ext: true },

    // Подпись «вслепую»: s' = m'^d mod n (сырая операция RSA без паддинга).
    blindSign(blindedHex) {
      const input = Buffer.from(blindedHex, 'hex');
      if (input.length !== modulusBytes) throw new Error('Неверная длина ослеплённого сообщения');
      const n = BigInt('0x' + Buffer.from(raw.blindSign.n, 'base64url').toString('hex'));
      const m = BigInt('0x' + blindedHex);
      if (m <= 1n || m >= n) throw new Error('Ослеплённое сообщение вне диапазона');
      const out = crypto.privateDecrypt({ key: rsaPrivate, padding: crypto.constants.RSA_NO_PADDING }, input);
      return out.toString('hex');
    },

    signBlock(hash) {
      return crypto
        .sign('sha256', Buffer.from(hash), { key: ledgerPrivate, dsaEncoding: 'ieee-p1363' })
        .toString('base64url');
    },

    hmac(value) {
      return crypto.createHmac('sha256', raw.hmac).update(value).digest('hex');
    },
  };
}
