// Криптографическое ядро голосования.
// Модуль общий для браузера и сервера (Node.js >= 22): вся проверяемая
// математика живёт в одном месте, чтобы любой наблюдатель мог повторить
// проверки в браузере теми же функциями, что использует сервер.

const subtle = globalThis.crypto.subtle;
const enc = new TextEncoder();
const dec = new TextDecoder();

export const GENESIS_HASH = '0'.repeat(64);
export const BALLOT_PLAINTEXT_SIZE = 512;
const HKDF_INFO = enc.encode('vypusknik2026/ballot/v1');

// ---------- кодирование ----------

export function bytesToHex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function hexToBytes(hex) {
  if (typeof hex !== 'string' || hex.length % 2 !== 0 || /[^0-9a-f]/i.test(hex)) {
    throw new Error('Некорректная hex-строка');
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

export function bytesToB64u(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64uToBytes(str) {
  if (typeof str !== 'string' || /[^A-Za-z0-9_-]/.test(str)) {
    throw new Error('Некорректная base64url-строка');
  }
  const b64 = str.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((str.length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToBigInt(bytes) {
  return bytes.length ? BigInt('0x' + bytesToHex(bytes)) : 0n;
}

export function bigIntToBytes(n, length) {
  let hex = n.toString(16);
  if (hex.length % 2) hex = '0' + hex;
  const raw = hexToBytes(hex);
  if (raw.length > length) throw new Error('Число не помещается в буфер');
  const out = new Uint8Array(length);
  out.set(raw, length - raw.length);
  return out;
}

export function randomBytes(n) {
  return globalThis.crypto.getRandomValues(new Uint8Array(n));
}

export async function sha256(data) {
  const bytes = typeof data === 'string' ? enc.encode(data) : data;
  return new Uint8Array(await subtle.digest('SHA-256', bytes));
}

export async function sha256Hex(data) {
  return bytesToHex(await sha256(data));
}

// ---------- арифметика по модулю ----------

export function modPow(base, exp, mod) {
  let result = 1n;
  base %= mod;
  while (exp > 0n) {
    if (exp & 1n) result = (result * base) % mod;
    base = (base * base) % mod;
    exp >>= 1n;
  }
  return result;
}

export function modInverse(a, m) {
  let [oldR, r] = [((a % m) + m) % m, m];
  let [oldS, s] = [1n, 0n];
  while (r !== 0n) {
    const q = oldR / r;
    [oldR, r] = [r, oldR - q * r];
    [oldS, s] = [s, oldS - q * s];
  }
  if (oldR !== 1n) throw new Error('Обратного элемента не существует');
  return ((oldS % m) + m) % m;
}

// ---------- слепая подпись RSA-FDH (схема Чаума) ----------
// Комиссия подписывает токен избирателя, не видя его. Поэтому в реестре
// нельзя связать бюллетень с тем, кому выдавалась подпись.

export function rsaPublicFromJwk(jwk) {
  const n = bytesToBigInt(b64uToBytes(jwk.n));
  const e = bytesToBigInt(b64uToBytes(jwk.e));
  return { n, e, bytes: b64uToBytes(jwk.n).length };
}

// Full Domain Hash: растягиваем SHA-256 до длины модуля.
export async function fullDomainHash(token, pub) {
  const parts = [];
  const blocks = Math.ceil(pub.bytes / 32);
  for (let i = 0; i < blocks; i++) {
    parts.push(await sha256(`vypusknik2026/fdh/${i}/${token}`));
  }
  const buf = new Uint8Array(blocks * 32);
  parts.forEach((p, i) => buf.set(p, i * 32));
  return bytesToBigInt(buf.slice(0, pub.bytes)) % pub.n;
}

export async function blindToken(token, pub) {
  const m = await fullDomainHash(token, pub);
  let r;
  do {
    r = bytesToBigInt(randomBytes(pub.bytes)) % pub.n;
  } while (r < 2n);
  const blinded = (m * modPow(r, pub.e, pub.n)) % pub.n;
  return { blinded: bytesToHex(bigIntToBytes(blinded, pub.bytes)), r: r.toString(16) };
}

export function unblindSignature(blindSigHex, rHex, pub) {
  const s = bytesToBigInt(hexToBytes(blindSigHex));
  const r = BigInt('0x' + rHex);
  const sig = (s * modInverse(r, pub.n)) % pub.n;
  return bytesToHex(bigIntToBytes(sig, pub.bytes));
}

export async function verifyTokenSignature(token, sigHex, pub) {
  if (!/^[0-9a-f]{64}$/.test(token) || !/^[0-9a-f]+$/.test(sigHex)) return false;
  const s = bytesToBigInt(hexToBytes(sigHex));
  if (s <= 0n || s >= pub.n) return false;
  const m = await fullDomainHash(token, pub);
  return modPow(s, pub.e, pub.n) === m;
}

// ---------- шифрование бюллетеня (ECIES: ECDH P-256 + HKDF + AES-256-GCM) ----------

async function deriveBallotKey(privateKey, publicKey, ephemeralRaw, usage) {
  const bits = await subtle.deriveBits({ name: 'ECDH', public: publicKey }, privateKey, 256);
  const hkdfKey = await subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey']);
  return subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: ephemeralRaw, info: HKDF_INFO },
    hkdfKey,
    { name: 'AES-GCM', length: 256 },
    false,
    [usage],
  );
}

export async function importElectionPublicKey(jwk) {
  return subtle.importKey('jwk', jwk, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
}

export async function importElectionPrivateKey(jwk) {
  return subtle.importKey('jwk', jwk, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
}

// Открытый текст дополняется до фиксированной длины, чтобы размер
// шифртекста не выдавал выбор.
export function encodeBallotPlaintext(electionId, choices) {
  const body = JSON.stringify({ v: 1, election: electionId, choices, salt: bytesToHex(randomBytes(16)) });
  const bytes = enc.encode(body);
  if (bytes.length > BALLOT_PLAINTEXT_SIZE) throw new Error('Бюллетень слишком большой');
  const out = new Uint8Array(BALLOT_PLAINTEXT_SIZE).fill(0x20);
  out.set(bytes);
  return out;
}

// Формат: base64url( epk(65 байт, несжатая точка) || iv(12) || шифртекст+тег )
export async function encryptBallot(electionId, choices, electionPublicKey) {
  const eph = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const epkRaw = new Uint8Array(await subtle.exportKey('raw', eph.publicKey));
  const key = await deriveBallotKey(eph.privateKey, electionPublicKey, epkRaw, 'encrypt');
  const iv = randomBytes(12);
  const ct = new Uint8Array(
    await subtle.encrypt({ name: 'AES-GCM', iv }, key, encodeBallotPlaintext(electionId, choices)),
  );
  const out = new Uint8Array(epkRaw.length + iv.length + ct.length);
  out.set(epkRaw, 0);
  out.set(iv, epkRaw.length);
  out.set(ct, epkRaw.length + iv.length);
  return bytesToB64u(out);
}

export async function decryptBallot(ballotB64u, electionPrivateKey) {
  const raw = b64uToBytes(ballotB64u);
  if (raw.length < 65 + 12 + 16) throw new Error('Шифртекст слишком короткий');
  const epkRaw = raw.slice(0, 65);
  const iv = raw.slice(65, 77);
  const ct = raw.slice(77);
  const epk = await subtle.importKey('raw', epkRaw, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const key = await deriveBallotKey(electionPrivateKey, epk, epkRaw, 'decrypt');
  const plain = await subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
  return JSON.parse(dec.decode(plain).trimEnd());
}

// Проверяет расшифрованный бюллетень по конфигурации голосования.
// Возвращает нормализованный выбор или null, если бюллетень недействителен.
export function validateChoices(election, parsed) {
  if (!parsed || parsed.v !== 1 || parsed.election !== election.id) return null;
  const choices = parsed.choices;
  if (!choices || typeof choices !== 'object') return null;
  const result = {};
  for (const q of election.questions) {
    const c = choices[q.id];
    if (!q.candidates.some((cand) => cand.id === c)) return null;
    result[q.id] = c;
  }
  if (Object.keys(choices).length !== election.questions.length) return null;
  return result;
}

// ---------- реестр (цепочка блоков) ----------

export async function computeBlockHash(block) {
  const ballotHash = await sha256Hex(block.ballot);
  return sha256Hex(
    [block.index, block.timestamp, block.prevHash, block.token, block.signature, ballotHash].join('|'),
  );
}

export async function importLedgerPublicKey(jwk) {
  return subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
}

export async function verifyLedgerSignature(hash, sigB64u, ledgerKey) {
  try {
    return await subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      ledgerKey,
      b64uToBytes(sigB64u),
      enc.encode(hash),
    );
  } catch {
    return false;
  }
}

// Полная проверка одного блока. prev — предыдущий блок (или null для первого).
export async function verifyBlock(block, prev, keys) {
  const checks = {};
  checks.hash = (await computeBlockHash(block)) === block.hash;
  checks.link = prev ? prev.hash === block.prevHash && prev.index + 1 === block.index
    : block.index === 0 && block.prevHash === GENESIS_HASH;
  checks.ledgerSignature = await verifyLedgerSignature(block.hash, block.ledgerSignature, keys.ledgerKey);
  checks.blindSignature = await verifyTokenSignature(block.token, block.signature, keys.rsaPub);
  checks.ok = checks.hash && checks.link && checks.ledgerSignature && checks.blindSignature;
  return checks;
}

export async function loadPublicKeys(publicKeys) {
  return {
    rsaPub: rsaPublicFromJwk(publicKeys.blindSign),
    ledgerKey: await importLedgerPublicKey(publicKeys.ledger),
    electionKey: await importElectionPublicKey(publicKeys.election),
  };
}

// Подсчёт голосов по расшифрованным бюллетеням.
export async function tallyBlocks(election, blocks, electionPrivateKey) {
  const counts = {};
  for (const q of election.questions) {
    counts[q.id] = Object.fromEntries(q.candidates.map((c) => [c.id, 0]));
  }
  const seen = new Set();
  let valid = 0;
  let spoiled = 0;
  for (const block of blocks) {
    if (seen.has(block.token)) {
      spoiled++;
      continue;
    }
    seen.add(block.token);
    let choices = null;
    try {
      choices = validateChoices(election, await decryptBallot(block.ballot, electionPrivateKey));
    } catch {
      choices = null;
    }
    if (!choices) {
      spoiled++;
      continue;
    }
    valid++;
    for (const [q, c] of Object.entries(choices)) counts[q][c]++;
  }
  return { total: blocks.length, valid, spoiled, counts };
}
