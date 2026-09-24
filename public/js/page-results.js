import {
  api,
  renderChrome,
  escapeHtml,
  formatDate,
  formatNumber,
  fetchAllBlocks,
  plural,
  countUp,
  icons,
  note,
  initReveal,
  withLoading,
  VK_URL,
} from './common.js';
import { loadPublicKeys, importElectionPrivateKey, tallyBlocks } from './core.js';
import { verifyChainAnimated } from './chain-ui.js';

renderChrome();

const root = document.getElementById('results-root');

function percent(n, total) {
  return total ? Math.round((n / total) * 1000) / 10 : 0;
}

function questionsHtml(election, tally) {
  return election.questions
    .map((q, qi) => {
      const counts = tally.counts[q.id];
      const sorted = [...q.candidates].sort((a, b) => counts[b.id] - counts[a.id]);
      const max = counts[sorted[0].id];
      return `<section class="card card--pad spot" data-reveal data-d="${qi * 80}">
        <div class="eyebrow">Номинация ${qi + 1}</div>
        <h2 class="question__title">${escapeHtml(q.title)}</h2>
        <div class="top-gap-sm">
        ${sorted
          .map((c) => {
            const n = counts[c.id];
            const p = percent(n, tally.valid);
            const lead = n === max && n > 0;
            return `<div class="result-row ${lead ? 'leader' : ''}">
              <div class="result-row__head">
                <span class="result-row__name"><span>${escapeHtml(c.name)}</span>${c.description ? `<span class="small muted">${escapeHtml(c.description)}</span>` : ''}${lead ? `<span class="winner">${icons.crown} Победитель</span>` : ''}</span>
                <span class="result-row__value"><b data-count="${n}">0</b> · ${p}%</span>
              </div>
              <div class="bar"><div class="bar__fill" data-width="${p}"></div></div>
            </div>`;
          })
          .join('')}
        </div>
      </section>`;
    })
    .join('');
}

// Полосы растут и числа считаются, когда карточка появляется на экране.
function animateBars() {
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        e.target.querySelectorAll('.bar__fill').forEach((b) => (b.style.width = b.dataset.width + '%'));
        e.target.querySelectorAll('[data-count]').forEach((n) => countUp(n, Number(n.dataset.count), 1400));
        io.unobserve(e.target);
      }
    },
    { threshold: 0.2 },
  );
  root.querySelectorAll('section.card').forEach((s) => io.observe(s));
}

async function recount(btn, election) {
  const report = document.getElementById('recount-report');
  const chain = document.getElementById('recount-chain');
  report.innerHTML = '';
  await withLoading(btn, async () => {
    try {
      const keys = await loadPublicKeys(election.publicKeys);
      const blocks = await fetchAllBlocks(election.id);
      const problems = await verifyChainAnimated(blocks, keys, chain);
      const priv = await importElectionPrivateKey(election.electionPrivateKey);
      const mine = await tallyBlocks(election, blocks, priv);
      const official = election.tally;
      const chainMatches = (blocks.at(-1)?.hash ?? official.lastBlockHash) === official.lastBlockHash;
      const same = JSON.stringify(mine.counts) === JSON.stringify(official.counts) && mine.valid === official.valid;
      const ok = same && chainMatches && !problems.length;
      report.innerHTML = note(
        ok ? 'success' : 'danger',
        ok ? 'Итоги подтверждены' : 'Пересчёт расходится с официальными итогами',
        `Проверено блоков: ${formatNumber(blocks.length)}${problems.length ? `, с ошибками: ${problems.length}` : ', ошибок нет'}. Действительных бюллетеней: ${formatNumber(mine.valid)}, недействительных: ${formatNumber(mine.spoiled)}. ${chainMatches ? 'Последний блок совпадает с зафиксированным при подсчёте.' : 'Последний блок не совпадает с зафиксированным при подсчёте!'}`,
      );
    } catch (err) {
      report.innerHTML = note('danger', 'Ошибка пересчёта', escapeHtml(err.message));
    }
  });
}

async function main() {
  const { election } = await api('/api/current');
  const statusBox = document.getElementById('results-status');

  if (!election) {
    statusBox.textContent = 'Итоги';
    root.innerHTML = `
      <div class="card card--pad empty swap-in">
        <div class="empty__icon">${icons.chart}</div>
        <h3>Итогов пока нет</h3>
        <p>Голосование ещё не началось. Итоги появятся здесь сразу после его завершения.</p>
        <div class="actions"><a class="btn btn--primary" href="${VK_URL}" target="_blank" rel="noopener">${icons.vk} Группа ВКонтакте</a></div>
      </div>`;
    return;
  }

  statusBox.textContent = election.title;
  const { stats, tally } = election;

  if (!tally) {
    root.innerHTML = `
      <div class="stats swap-in">
        <div class="stat"><div class="stat__value" id="s-cast">0</div><div class="stat__label">голосов в реестре</div></div>
        <div class="stat"><div class="stat__value" id="s-issued">0</div><div class="stat__label">бюллетеней выдано</div></div>
      </div>
      <div class="card card--pad empty swap-in">
        <div class="empty__icon">${icons.lock}</div>
        <h3>Итоги появятся после завершения</h3>
        <p>Бюллетени зашифрованы, поэтому промежуточные результаты не может узнать никто — даже организаторы.${election.endsAt ? ` Голосование продлится до ${formatDate(election.endsAt)}.` : ''}</p>
        <div class="actions"><a class="btn btn--brand" href="/vote">Проголосовать ${icons.arrow}</a></div>
      </div>`;
    countUp(document.getElementById('s-cast'), stats.ballotsCast);
    countUp(document.getElementById('s-issued'), stats.ballotsIssued);
    return;
  }

  document.getElementById('results-title').textContent = 'Итоги голосования';
  root.innerHTML = `
    <div class="stats swap-in">
      <div class="stat"><div class="stat__value" id="s-total">0</div><div class="stat__label">${plural(tally.total, 'бюллетень', 'бюллетеня', 'бюллетеней')} в реестре</div></div>
      <div class="stat"><div class="stat__value" id="s-valid">0</div><div class="stat__label">действительных</div></div>
      <div class="stat"><div class="stat__value" id="s-spoiled">0</div><div class="stat__label">недействительных</div></div>
      <div class="stat"><div class="stat__value stat__value--sm">${formatDate(election.finishedAt)}</div><div class="stat__label">подсчёт завершён</div></div>
    </div>
    ${questionsHtml(election, tally)}
    <section class="card card--pad" data-reveal>
      <div class="election-card__head">
        <div>
          <h3>Независимый пересчёт</h3>
          <p class="small muted top-gap-xs">Браузер скачает весь реестр, проверит цепочку и подписи, расшифрует каждый бюллетень опубликованным ключом комиссии и сравнит итог с официальным.</p>
        </div>
        <button class="btn btn--brand" id="recount">${icons.shield} Пересчитать самостоятельно</button>
      </div>
      <div class="progress" id="recount-chain" hidden><div class="progress__fill"></div></div>
      <div id="recount-report"></div>
    </section>`;
  countUp(document.getElementById('s-total'), tally.total);
  countUp(document.getElementById('s-valid'), tally.valid);
  countUp(document.getElementById('s-spoiled'), tally.spoiled);
  initReveal(root);
  animateBars();
  document.getElementById('recount').addEventListener('click', (e) => recount(e.currentTarget, election));
}

main().catch((err) => {
  root.innerHTML = note('danger', 'Не удалось загрузить итоги', escapeHtml(err.message));
});
