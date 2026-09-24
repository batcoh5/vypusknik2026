import { api, renderChrome, statusBadge, formatDate, formatNumber, escapeHtml, el, plural } from './common.js';

renderChrome();

function countdown(target, serverOffset) {
  const box = document.getElementById('hero-countdown');
  const tick = () => {
    const ms = Date.parse(target) - (Date.now() + serverOffset);
    if (ms <= 0) {
      box.replaceChildren();
      return;
    }
    const d = Math.floor(ms / 86400000);
    const h = Math.floor((ms % 86400000) / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    box.innerHTML = `<div class="countdown">
      <div><b>${d}</b><span>дн</span></div>
      <div><b>${String(h).padStart(2, '0')}</b><span>ч</span></div>
      <div><b>${String(m).padStart(2, '0')}</b><span>мин</span></div>
      <div><b>${String(s).padStart(2, '0')}</b><span>сек</span></div>
    </div>`;
  };
  tick();
  setInterval(tick, 1000);
}

async function main() {
  const info = await api('/api/election');
  const { election, status, stats } = info;
  const offset = Date.parse(info.serverTime) - Date.now();

  document.title = `${election.title} — голосование`;
  document.getElementById('hero-title').textContent = election.title;
  document.getElementById('hero-subtitle').textContent = election.subtitle;
  document.getElementById('hero-status').innerHTML = statusBadge(status);
  document.getElementById('stat-cast').textContent = formatNumber(stats.ballotsCast);
  document.getElementById('stat-issued').textContent = formatNumber(stats.ballotsIssued);
  document.getElementById('stat-dates').textContent = `с ${formatDate(election.startsAt)} по ${formatDate(election.endsAt)}`;

  const voteBtn = document.getElementById('hero-vote');
  if (status === 'upcoming') {
    voteBtn.textContent = 'Голосование ещё не началось';
    countdown(election.startsAt, offset);
  } else if (status === 'active') {
    countdown(election.endsAt, offset);
  } else {
    voteBtn.textContent = 'Смотреть итоги';
    voteBtn.href = '/results';
  }

  const list = document.getElementById('nominations');
  list.replaceChildren(
    ...election.questions.map((q) =>
      el(`<div class="receipt">
        <h3>${escapeHtml(q.title)}</h3>
        <p class="muted small">${escapeHtml(q.description ?? '')}</p>
        <div class="small">${q.candidates.length} ${plural(q.candidates.length, 'участник', 'участника', 'участников')}: ${q.candidates.map((c) => escapeHtml(c.name)).join(', ')}</div>
      </div>`),
    ),
  );
}

main().catch((err) => {
  document.getElementById('hero-status').innerHTML = `<span class="badge badge--danger">${escapeHtml(err.message)}</span>`;
});
