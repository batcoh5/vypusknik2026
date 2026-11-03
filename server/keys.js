// Ключи.
// Для каждого голосования создаётся свой комплект ключей комиссии:
//  - blindSign: RSA-2048, слепая подпись анонимных токенов избирателей;
//  - election:  ECDH P-256, шифрование бюллетеней (закрытая часть публикуется
//               только после завершения голосования);
//  - ledger:    ECDSA P-256, подпись блоков реестра (квитанции избирателей).
// Общий для сайта секрет HMAC хранится в базе (см. db.js).

import crypto from 'node:crypto';

export function hmacWithSecret(secret) {
  return {
    hmac: (value) => crypto.createHmac('sha256', secret).update(value).digest('hex'),
  };
}

export function generateElectionKeys() {
  const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, publicExponent: 65537 });
  const election = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const ledger = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return {
    blindSign: rsa.privateKey.export({ format: 'jwk' }),
    election: election.privateKey.export({ format: 'jwk' }),
    ledger: ledger.privateKey.export({ format: 'jwk' }),
  };
}

function publicJwk(jwk) {
  if (jwk.kty === 'RSA') return { kty: 'RSA', n: jwk.n, e: jwk.e };
  return { kty: 'EC', crv: jwk.crv, x: jwk.x, y: jwk.y };
}

export function electionCrypto(raw) {
  const rsaPrivate = crypto.createPrivateKey({ key: raw.blindSign, format: 'jwk' });
  const ledgerPrivate = crypto.createPrivateKey({ key: raw.ledger, format: 'jwk' });
  const modulus = Buffer.from(raw.blindSign.n, 'base64url');
  const n = BigInt('0x' + modulus.toString('hex'));

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
      if (input.length !== modulus.length) throw new Error('Неверная длина ослеплённого сообщения');
      const m = BigInt('0x' + blindedHex);
      if (m <= 1n || m >= n) throw new Error('Ослеплённое сообщение вне диапазона');
      return crypto.privateDecrypt({ key: rsaPrivate, padding: crypto.constants.RSA_NO_PADDING }, input).toString('hex');
    },

    signBlock(hash) {
      return crypto
        .sign('sha256', Buffer.from(hash), { key: ledgerPrivate, dsaEncoding: 'ieee-p1363' })
        .toString('base64url');
    },
  };
}
