// Проверка цепочки блоков с полоской прогресса.

import { verifyBlock } from './core.js';

export async function verifyChainAnimated(blocks, keys, barNode, onProgress) {
  const fill = barNode.querySelector('.progress__fill');
  barNode.hidden = false;
  barNode.classList.remove('done');
  fill.style.width = '0%';
  const problems = [];
  const tokens = new Set();
  let prev = null;
  // На маленьком реестре проверка занимает миллисекунды — растягиваем её, чтобы было видно прогресс.
  const minDuration = 900;
  const start = performance.now();

  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    const c = await verifyBlock(b, prev, keys);
    if (!c.ok) {
      const what = [!c.hash && 'хеш', !c.link && 'связь с предыдущим', !c.ledgerSignature && 'подпись реестра', !c.blindSignature && 'подпись комиссии']
        .filter(Boolean)
        .join(', ');
      problems.push(`Блок № ${b.index + 1}: ${what}`);
    }
    if (tokens.has(b.token)) problems.push(`Блок № ${b.index + 1}: повторное использование токена`);
    tokens.add(b.token);
    prev = b;
    if (i % 10 === 0 || i === blocks.length - 1) {
      fill.style.width = `${((i + 1) / blocks.length) * 100}%`;
      onProgress?.(i + 1, blocks.length);
      await new Promise((r) => requestAnimationFrame(r));
    }
  }

  const left = minDuration - (performance.now() - start);
  if (left > 0) await new Promise((r) => setTimeout(r, left));
  fill.classList.toggle('bad', problems.length > 0);
  barNode.classList.add('done');
  setTimeout(() => (barNode.hidden = true), 700);
  return problems;
}
