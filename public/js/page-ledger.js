import { api, renderChrome, escapeHtml, formatDate, formatNumber, shortHash, fetchAllBlocks } from './common.js';
import { loadPublicKeys, verifyBlock, sha256Hex } from './core.js';

renderChrome();

const PAGE = 50;
const params = new URLSearchParams(location.search);
const highlight = params.get('highlight');
let info;
let keys;

async function loadPage(from) {
  const { total, blocks } = await api(`/api/ledger?from=${from}&limit=${PAGE}`);
  document.getElementById('total').textContent = formatNumber(total);
  const rows = document.getElementById('rows');
  if (!blocks.length) {
    rows.innerHTML = `<tr><td colspan="6" class="muted">В реестре пока нет бюллетеней</td></tr>`;
  } else {
    rows.innerHTML = blocks
      .map(
        (b) => `<tr id="b${b.index}" class="${b.hash === highlight ? 'hl' : ''}">
          <td>${b.index + 1}</td>
          <td>${escapeHtml(formatDate(b.timestamp))}</td>
          <td class="mono">${shortHash(b.hash)}</td>
          <td class="mono">${shortHash(b.prevHash)}</td>
          <td class="mono">${shortHash(b.token)}</td>
          <td><a href="/verify?receipt=${b.hash}">Проверить</a></td>
        </tr>`,
      )
      .join('');
  }

  const pager = document.getElementById('pager');
  pager.innerHTML = '';
  const pages = Math.ceil(total / PAGE);
  if (pages > 1) {
    const cur = Math.floor(from / PAGE);
    const prev = document.createElement('button');
    prev.className = 'btn btn--secondary';
    prev.textContent = '← Назад';
    prev.disabled = cur === 0;
    prev.onclick = () => loadPage(from - PAGE);
    const next = document.createElement('button');
    next.className = 'btn btn--secondary';
    next.textContent = 'Вперёд →';
    next.disabled = cur >= pages - 1;
    next.onclick = () => loadPage(from + PAGE);
    const label = document.createElement('span');
    label.className = 'muted small';
    label.textContent = `Страница ${cur + 1} из ${pages}`;
    pager.append(prev, next, label);
  }
  if (highlight) document.querySelector('tr.hl')?.scrollIntoView({ block: 'center' });
}

async function verifyAll() {
  const btn = document.getElementById('verify-all');
  const report = document.getElementById('verify-report');
  const state = document.getElementById('chain-state');
  btn.disabled = true;
  report.innerHTML = '<p class="muted small" id="vp">Загрузка реестра…</p>';
  try {
    const blocks = await fetchAllBlocks((n, t) => {
      document.getElementById('vp').textContent = `Загружено ${n} из ${t} блоков…`;
    });
    const problems = [];
    const tokens = new Set();
    let prev = null;
    for (const b of blocks) {
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
      if (b.index % 25 === 0) document.getElementById('vp').textContent = `Проверено ${b.index + 1} из ${blocks.length} блоков…`;
    }
    if (problems.length) {
      state.innerHTML = '<span class="badge badge--danger">нарушена</span>';
      report.innerHTML = `<div class="alert alert--danger"><div><b>Найдены проблемы (${problems.length})</b><ul>${problems.slice(0, 20).map((p) => `<li>${escapeHtml(p)}</li>`).join('')}</ul></div></div>`;
    } else {
      state.innerHTML = '<span class="badge badge--success">подтверждена</span>';
      report.innerHTML = `<div class="alert alert--success"><div><b>Цепочка целостна</b><p class="small">Проверено блоков: ${formatNumber(blocks.length)}. Все хеши, связи, подписи реестра и слепые подписи комиссии верны, повторов нет.</p></div></div>`;
    }
  } catch (err) {
    report.innerHTML = `<div class="alert alert--danger"><div>${escapeHtml(err.message)}</div></div>`;
  } finally {
    btn.disabled = false;
  }
}

async function main() {
  info = await api('/api/election');
  keys = await loadPublicKeys(info.publicKeys);
  const { total } = await api('/api/ledger?limit=1');
  const last = total ? (await api(`/api/ledger?from=${total - 1}&limit=1`)).blocks[0] : null;
  document.getElementById('last-hash').textContent = last ? shortHash(last.hash) : '—';

  let start = 0;
  const hlIndex = location.hash.match(/^#b(\d+)$/);
  if (hlIndex) start = Math.floor(Number(hlIndex[1]) / PAGE) * PAGE;
  await loadPage(start);

  const names = { blindSign: 'Слепая подпись (RSA-2048)', election: 'Шифрование бюллетеней (ECDH P-256)', ledger: 'Подпись реестра (ECDSA P-256)' };
  const rows = [];
  for (const [k, label] of Object.entries(names)) {
    rows.push(`<dt>${label}</dt><dd class="mono">${await sha256Hex(JSON.stringify(info.publicKeys[k]))}</dd>`);
  }
  rows.push(
    `<dt>Ключ расшифровки</dt><dd>${info.electionPrivateKey ? '<span class="badge badge--success">опубликован</span>' : '<span class="badge badge--muted">будет опубликован после окончания</span>'}</dd>`,
  );
  document.getElementById('keys').innerHTML = rows.join('');
  document.getElementById('verify-all').addEventListener('click', verifyAll);
}

main().catch((err) => {
  document.getElementById('rows').innerHTML = `<tr><td colspan="6">${escapeHtml(err.message)}</td></tr>`;
});
