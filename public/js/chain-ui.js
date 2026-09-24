// Анимированная проверка цепочки блоков: квадратики загораются по мере проверки.

import { verifyBlock } from './core.js';

const MAX_CELLS = 600;

export async function verifyChainAnimated(blocks, keys, chainNode, onProgress) {
  const cells = Math.min(blocks.length, MAX_CELLS);
  const perCell = blocks.length / Math.max(cells, 1);
  chainNode.innerHTML = Array.from({ length: cells }, () => '<span class="chain__b"></span>').join('');
  const nodes = chainNode.children;
  const problems = [];
  const tokens = new Set();
  let prev = null;
  let cellBad = false;
  const frame = () => new Promise((r) => requestAnimationFrame(r));
  // Небольшая задержка, чтобы проверка была видна даже на маленьком реестре.
  const delay = blocks.length < 60 ? 45 : 0;

  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    const c = await verifyBlock(b, prev, keys);
    if (!c.ok) {
      const what = [!c.hash && 'хеш', !c.link && 'связь с предыдущим', !c.ledgerSignature && 'подпись реестра', !c.blindSignature && 'подпись комиссии']
        .filter(Boolean)
        .join(', ');
      problems.push(`Блок № ${b.index + 1}: ${what}`);
      cellBad = true;
    }
    if (tokens.has(b.token)) {
      problems.push(`Блок № ${b.index + 1}: повторное использование токена`);
      cellBad = true;
    }
    tokens.add(b.token);
    prev = b;
    const cell = Math.min(cells - 1, Math.floor(i / perCell));
    const isLastInCell = i === blocks.length - 1 || Math.floor((i + 1) / perCell) !== cell;
    if (isLastInCell && nodes[cell]) {
      nodes[cell].className = 'chain__b ' + (cellBad ? 'bad' : 'ok');
      cellBad = false;
      onProgress?.(i + 1, blocks.length);
      if (delay) await new Promise((r) => setTimeout(r, delay));
      else if (cell % 20 === 0) await frame();
    }
  }
  return problems;
}
