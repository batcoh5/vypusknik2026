import {
  api,
  renderChrome,
  setFooterStatus,
  escapeHtml,
  formatDate,
  formatNumber,
  shortHash,
  fetchAllBlocks,
  statusBadge,
  countUp,
  icons,
  note,
  withLoading,
  VK_URL,
} from './common.js';
import { loadPublicKeys, sha256Hex } from './core.js';
import { verifyChainAnimated } from './chain-ui.js';

renderChrome();

const PAGE = 50;
const params = new URLSearchParams(location.search);
const highlight = params.get('highlight');
const root = document.getElementById('ledger-root');
let election;
let keys;

function empty(title, text) {
  root.innerHTML = `
    <div class="card card--pad empty swap-in">
      <div class="empty__icon">${icons.blocks}</div>
      <h3>${title}</h3>
      <p>${text}</p>
      <div class="actions"><a class="btn btn--primary" href="${VK_URL}" target="_blank" rel="noopener">${icons.vk} Группа ВКонтакте</a></div>
    </div>`;
}

async function loadPage(from) {
  const { total, blocks } = await api(`/api/elections/${election.id}/ledger?from=${from}&limit=${PAGE}`);
  const rows = document.getElementById('rows');
  if (!blocks.length) {
    rows.innerHTML = `<tr><td colspan="6" class="muted">В реестре пока нет бюллетеней — станьте первым!</td></tr>`;
  } else {
    rows.innerHTML = blocks
      .map(
        (b, i) => `<tr class="${b.hash === highlight ? 'hl' : ''}" data-i="${i}">
          <td>${b.index + 1}</td>
          <td>${escapeHtml(formatDate(b.timestamp))}</td>
          <td class="mono">${shortHash(b.hash)}</td>
          <td class="mono subtle">${shortHash(b.prevHash)}</td>
          <td class="mono subtle">${shortHash(b.token)}</td>
          <td><a class="link" href="/verify?receipt=${b.hash}">Проверить</a></td>
        </tr>`,
      )
      .join('');
    rows.querySelectorAll('tr').forEach((tr) => (tr.style.animationDelay = Math.min(Number(tr.dataset.i) * 25, 600) + 'ms'));
  }

  const pager = document.getElementById('pager');
  pager.innerHTML = '';
  const pages = Math.ceil(total / PAGE);
  if (pages > 1) {
    const cur = Math.floor(from / PAGE);
    pager.innerHTML = `
      <button class="btn btn--glass btn--sm" id="prev" ${cur === 0 ? 'disabled' : ''}>Назад</button>
      <button class="btn btn--glass btn--sm" id="next" ${cur >= pages - 1 ? 'disabled' : ''}>Вперёд</button>
      <span class="small muted center-v">Страница ${cur + 1} из ${pages}</span>`;
    document.getElementById('prev').onclick = () => loadPage(from - PAGE);
    document.getElementById('next').onclick = () => loadPage(from + PAGE);
  }
  document.querySelector('tr.hl')?.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

async function verifyAll(btn) {
  const report = document.getElementById('verify-report');
  const state = document.getElementById('chain-state');
  const chain = document.getElementById('chain');
  report.innerHTML = '';
  state.innerHTML = '<span class="shimmer">Проверяем…</span>';
  await withLoading(btn, async () => {
    try {
      const blocks = await fetchAllBlocks(election.id);
      if (!blocks.length) {
        state.textContent = '—';
        report.innerHTML = note('info', 'Реестр пуст', 'Проверять пока нечего.');
        return;
      }
      const problems = await verifyChainAnimated(blocks, keys, chain, (n, t) => {
        state.innerHTML = `<span class="shimmer">${formatNumber(n)} из ${formatNumber(t)}</span>`;
      });
      if (problems.length) {
        state.innerHTML = '<span class="badge badge--danger">нарушена</span>';
        report.innerHTML = note('danger', `Найдены проблемы (${problems.length})`, problems.slice(0, 20).map(escapeHtml).join('<br>'));
      } else {
        state.innerHTML = '<span class="badge badge--live"><span class="dot"></span>подтверждена</span>';
        report.innerHTML = note(
          'success',
          'Цепочка целостна',
          `Проверено блоков: ${formatNumber(blocks.length)}. Все хеши, связи, подписи реестра и подписи комиссии верны, повторов нет.`,
        );
      }
    } catch (err) {
      state.innerHTML = '<span class="badge badge--danger">ошибка</span>';
      report.innerHTML = note('danger', 'Ошибка проверки', escapeHtml(err.message));
    }
  });
}

async function main() {
  const id = params.get('election');
  const res = id ? await api(`/api/elections/${id}`).catch(() => ({ election: null })) : await api('/api/current');
  const current = id ? await api('/api/current').catch(() => ({})) : res;
  setFooterStatus(current.election?.status ?? 'none');
  election = res.election;
  if (!election) {
    document.getElementById('ledger-election').innerHTML = statusBadge('none');
    return empty('Реестр появится, когда начнётся голосование', 'Пока голосование не открыто, в реестре нет записей. Следите за новостями конкурса.');
  }
  document.getElementById('ledger-election').innerHTML = `${statusBadge(election.status)}<span>${escapeHtml(election.title)}</span>`;
  keys = await loadPublicKeys(election.publicKeys);
  const { total } = await api(`/api/elections/${election.id}/ledger?limit=1`);
  const last = total ? (await api(`/api/elections/${election.id}/ledger?from=${total - 1}&limit=1`)).blocks[0] : null;

  root.innerHTML = `
    <div class="stats swap-in">
      <div class="stat"><div class="stat__value" id="total">0</div><div class="stat__label">блоков в реестре</div></div>
      <div class="stat"><div class="stat__value stat__value--sm mono">${last ? shortHash(last.hash) : '—'}</div><div class="stat__label">хеш последнего блока</div></div>
      <div class="stat"><div class="stat__value stat__value--sm" id="chain-state">не проверялась</div><div class="stat__label">целостность цепочки</div></div>
    </div>
    <div class="card card--pad swap-in">
      <div class="election-card__head">
        <div><h3>Проверка целостности</h3><p class="small muted top-gap-xs">Браузер скачает весь реестр и проверит каждый блок: хеш, связь с предыдущим, подпись реестра и подпись комиссии.</p></div>
        <button class="btn btn--brand" id="verify-all">${icons.shield} Проверить цепочку</button>
      </div>
      <div class="chain" id="chain"></div>
      <div id="verify-report"></div>
    </div>
    <div class="card card--pad swap-in">
      <h3>Блоки</h3>
      <div class="table-wrap top-gap-sm">
        <table class="table">
          <thead><tr><th>№</th><th>Время</th><th>Хеш блока</th><th>Предыдущий</th><th>Токен</th><th></th></tr></thead>
          <tbody id="rows"></tbody>
        </table>
      </div>
      <div class="actions" id="pager"></div>
    </div>
    <div class="card card--pad swap-in">
      <h3>Открытые ключи комиссии</h3>
      <p class="small muted top-gap-xs">Отпечатки ключей (SHA-256) этого голосования.</p>
      <dl class="kv top-gap-sm" id="keys"></dl>
    </div>`;
  countUp(document.getElementById('total'), total);
  document.getElementById('verify-all').addEventListener('click', (e) => verifyAll(e.currentTarget));

  let start = 0;
  if (highlight) {
    const found = await api(`/api/receipts/${highlight}`).catch(() => null);
    if (found) start = Math.floor(found.block.index / PAGE) * PAGE;
  }
  await loadPage(start);

  const names = { blindSign: 'Слепая подпись (RSA-2048)', election: 'Шифрование (ECDH P-256)', ledger: 'Подпись реестра (ECDSA P-256)' };
  const rows = [];
  for (const [k, label] of Object.entries(names)) {
    rows.push(`<dt>${label}</dt><dd class="mono">${await sha256Hex(JSON.stringify(election.publicKeys[k]))}</dd>`);
  }
  rows.push(
    `<dt>Ключ расшифровки</dt><dd>${election.electionPrivateKey ? '<span class="badge badge--live">опубликован</span>' : '<span class="badge">будет опубликован после завершения</span>'}</dd>`,
  );
  document.getElementById('keys').innerHTML = rows.join('');
}

main().catch((err) => {
  root.innerHTML = note('danger', 'Не удалось загрузить реестр', escapeHtml(err.message));
});
