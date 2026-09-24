import { renderChrome, escapeHtml, formatNumber, statusBadge } from './common.js';

renderChrome();

const panel = document.getElementById('panel');
let token = '';
try {
  token = sessionStorage.getItem('vyp26:admin') ?? '';
} catch {
  /* ignore */
}

async function adminApi(path, method = 'GET') {
  const res = await fetch(path, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}) },
    body: method === 'POST' ? '{}' : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.message);
  return data;
}

async function show() {
  try {
    const s = await adminApi('/api/admin/status');
    try {
      sessionStorage.setItem('vyp26:admin', token);
    } catch {
      /* ignore */
    }
    document.getElementById('login').classList.add('hidden');
    panel.innerHTML = `
      <p>${statusBadge(s.status)}</p>
      <div class="grid grid--3">
        <div class="stat"><div class="stat__value">${formatNumber(s.stats.ballotsIssued)}</div><div class="stat__label">бюллетеней выдано</div></div>
        <div class="stat"><div class="stat__value">${formatNumber(s.stats.ballotsCast)}</div><div class="stat__label">голосов в реестре</div></div>
        <div class="stat"><div class="stat__value">${s.maxVotesPerIp || '∞'}</div><div class="stat__label">лимит бюллетеней на IP</div></div>
      </div>
      ${
        s.tally
          ? '<div class="alert alert--success"><div>Голосование завершено, ключ расшифровки и итоги опубликованы. <a href="/results">Открыть итоги</a></div></div>'
          : `<div class="alert alert--warning"><div>
              <b>Досрочное завершение</b>
              <p class="small">Приём бюллетеней будет остановлен, ключ расшифровки опубликован, голоса подсчитаны. Действие необратимо.</p>
            </div></div>
            <div class="actions"><button class="btn btn--primary" id="close">Завершить голосование и подвести итоги</button></div>`
      }`;
    document.getElementById('close')?.addEventListener('click', async () => {
      if (!confirm('Завершить голосование? Это действие нельзя отменить.')) return;
      try {
        await adminApi('/api/admin/close', 'POST');
        show();
      } catch (err) {
        panel.insertAdjacentHTML('beforeend', `<div class="alert alert--danger"><div>${escapeHtml(err.message)}</div></div>`);
      }
    });
  } catch (err) {
    panel.innerHTML = token ? `<div class="alert alert--danger"><div>${escapeHtml(err.message)}</div></div>` : '';
  }
}

document.getElementById('login').addEventListener('submit', (e) => {
  e.preventDefault();
  token = document.getElementById('token').value.trim();
  show();
});

if (token) show();
