import { api, renderChrome, escapeHtml, formatDate, formatNumber, statusBadge, fetchAllBlocks, plural } from './common.js';
import { loadPublicKeys, verifyBlock, importElectionPrivateKey, tallyBlocks } from './core.js';

renderChrome();

function percent(n, total) {
  return total ? Math.round((n / total) * 1000) / 10 : 0;
}

function renderQuestions(election, tally) {
  const box = document.getElementById('questions');
  box.innerHTML = election.questions
    .map((q) => {
      const counts = tally.counts[q.id];
      const sorted = [...q.candidates].sort((a, b) => counts[b.id] - counts[a.id]);
      const max = counts[sorted[0].id];
      return `<section class="card">
        <h2>${escapeHtml(q.title)}</h2>
        ${sorted
          .map((c) => {
            const n = counts[c.id];
            const p = percent(n, tally.valid);
            return `<div class="result-row ${n === max && n > 0 ? 'leader' : ''}">
              <div class="result-row__head">
                <span><b>${escapeHtml(c.name)}</b> <span class="small muted">${escapeHtml(c.description ?? '')}</span></span>
                <span class="result-row__value"><b>${formatNumber(n)}</b> · ${p}%</span>
              </div>
              <div class="bar"><div class="bar__fill" data-width="${p}"></div></div>
            </div>`;
          })
          .join('')}
      </section>`;
    })
    .join('');
  // Ширина задаётся из JS: CSP запрещает inline-стили в разметке.
  requestAnimationFrame(() => {
    for (const bar of box.querySelectorAll('.bar__fill')) bar.style.width = bar.dataset.width + '%';
  });
}

async function recount(info, official) {
  const btn = document.getElementById('recount');
  const report = document.getElementById('recount-report');
  btn.disabled = true;
  report.innerHTML = '<p class="muted small" id="rp">Загрузка реестра…</p>';
  const progress = (t) => {
    document.getElementById('rp').textContent = t;
  };
  try {
    const keys = await loadPublicKeys(info.publicKeys);
    const blocks = await fetchAllBlocks((n, t) => progress(`Загружено ${n} из ${t} блоков…`));
    let prev = null;
    const bad = [];
    for (const b of blocks) {
      if (!(await verifyBlock(b, prev, keys)).ok) bad.push(b.index + 1);
      prev = b;
    }
    progress('Расшифровка бюллетеней…');
    const priv = await importElectionPrivateKey(info.electionPrivateKey);
    const mine = await tallyBlocks(info.election, blocks, priv);
    const chainMatches = (blocks.at(-1)?.hash ?? official.lastBlockHash) === official.lastBlockHash;
    const same = JSON.stringify(mine.counts) === JSON.stringify(official.counts) && mine.valid === official.valid;
    const ok = same && chainMatches && !bad.length;
    report.innerHTML = `<div class="alert alert--${ok ? 'success' : 'danger'}"><div>
      <b>${ok ? 'Итоги подтверждены' : 'Результат пересчёта расходится с официальным'}</b>
      <p class="small">Блоков проверено: ${formatNumber(blocks.length)}${bad.length ? `, с ошибками: ${bad.slice(0, 10).join(', ')}` : ', ошибок нет'}.
      Действительных бюллетеней: ${formatNumber(mine.valid)}, недействительных: ${formatNumber(mine.spoiled)}.
      ${chainMatches ? 'Последний блок совпадает с зафиксированным при подсчёте.' : 'Последний блок реестра не совпадает с зафиксированным при подсчёте!'}</p>
    </div></div>`;
  } catch (err) {
    report.innerHTML = `<div class="alert alert--danger"><div>${escapeHtml(err.message)}</div></div>`;
  } finally {
    btn.disabled = false;
  }
}

async function main() {
  const info = await api('/api/election');
  const { status, stats, tally } = await api('/api/results');
  const summary = document.getElementById('summary');

  if (!tally) {
    summary.innerHTML = `
      <p>${statusBadge(status)}</p>
      <div class="alert"><div>
        <b>Итоги будут опубликованы после окончания голосования</b>
        <p class="small muted">Бюллетени зашифрованы, и до ${formatDate(info.election.endsAt)} промежуточные результаты не может узнать никто, включая организаторов.</p>
      </div></div>
      <div class="grid grid--2">
        <div class="stat"><div class="stat__value">${formatNumber(stats.ballotsCast)}</div><div class="stat__label">бюллетеней уже в реестре</div></div>
        <div class="stat"><div class="stat__value">${formatNumber(stats.ballotsIssued)}</div><div class="stat__label">бюллетеней выдано</div></div>
      </div>`;
    return;
  }

  summary.innerHTML = `
    <p>${statusBadge(status)} <span class="small muted">Подсчёт завершён ${formatDate(tally.finalizedAt)}</span></p>
    <div class="grid grid--3">
      <div class="stat"><div class="stat__value">${formatNumber(tally.total)}</div><div class="stat__label">${plural(tally.total, 'бюллетень', 'бюллетеня', 'бюллетеней')} в реестре</div></div>
      <div class="stat"><div class="stat__value">${formatNumber(tally.valid)}</div><div class="stat__label">действительных</div></div>
      <div class="stat"><div class="stat__value">${formatNumber(tally.spoiled)}</div><div class="stat__label">недействительных</div></div>
    </div>`;
  renderQuestions(info.election, tally);
  document.getElementById('recount-card').classList.remove('hidden');
  document.getElementById('recount').addEventListener('click', () => recount(info, tally));
}

main().catch((err) => {
  document.getElementById('summary').innerHTML = `<div class="alert alert--danger"><div>${escapeHtml(err.message)}</div></div>`;
});
