// «Невидимая капча»: подбор числа, при котором SHA-256(challenge:nonce)
// начинается с нужного количества нулевых бит. Человеку — пара секунд,
// ботам массовая отправка SMS обходится дорого.

const enc = new TextEncoder();

function leadingZeroBits(bytes) {
  let bits = 0;
  for (const b of bytes) {
    if (b === 0) {
      bits += 8;
      continue;
    }
    return bits + Math.clz32(b) - 24;
  }
  return bits;
}

export async function solveChallenge(challenge, difficulty, onProgress) {
  const batch = 256;
  const expected = 2 ** difficulty;
  for (let start = 0; ; start += batch) {
    const hashes = await Promise.all(
      Array.from({ length: batch }, (_, i) => crypto.subtle.digest('SHA-256', enc.encode(`${challenge}:${start + i}`))),
    );
    for (let i = 0; i < batch; i++) {
      if (leadingZeroBits(new Uint8Array(hashes[i])) >= difficulty) return String(start + i);
    }
    onProgress?.(Math.min(0.95, 1 - Math.exp(-(start + batch) / expected)));
  }
}
