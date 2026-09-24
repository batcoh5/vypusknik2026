// Единственная страница для зрителя: выбрать участника → войти через ВКонтакте → проголосовать.

import {
  api,
  renderChrome,
  escapeHtml,
  formatDate,
  initials,
  initReveal,
  icons,
  note,
  store,
  pendingKey,
  votedKey,
  confirmDialog,
  withOverlay,
  toast,
  VK_URL,
} from './common.js';
import { blindToken, bytesToHex, encryptBallot, loadPublicKeys, randomBytes, unblindSignature, verifyTokenSignature } from './core.js';

renderChrome();

const root = document.getElementById('vote-root');
const bar = document.getElementById('vote-bar');
const barChoice = document.getElementById('vote-bar-choice');
const voteButton = document.getElementById('vote-button');
const CHOICE_KEY = 'vyp26:choice';

let election;
let me;
let session;
let selected = null;

const nomination = () => election.questions[0];
const candidateById = (id) => nomination().candidates.find((c) => c.id === id);

function setLead(html) {
  const lead = document.getElementById('hero-lead');
  lead.classList.remove('lead-sk');
  lead.innerHTML = html;
  lead.hidden = !html;
}

function render(html) {
  root.innerHTML = `<div class="swap-in">${html}</div>`;
  initReveal(root);
}

// ---------- таймер до окончания ----------

function countdown(target, offset) {
  const box = document.getElementById('hero-countdown');
  const units = [
    ['d', 'дней', 86400000],
    ['h', 'часов', 3600000],
    ['m', 'минут', 60000],
    ['s', 'секунд', 1000],
  ];
  box.innerHTML = `<div class="countdown">${units
    .map(([k, label]) => `<div class="countdown__cell"><span class="countdown__num" data-u="${k}"></span><span class="countdown__label">${label}</span></div>`)
    .join('')}</div>`;
  const last = {};
  const tick = () => {
    let ms = Math.max(0, Date.parse(target) - (Date.now() + offset));
    for (const [k, , size] of units) {
      const v = Math.floor(ms / size);
      ms -= v * size;
      const text = k === 'd' ? String(v) : String(v).padStart(2, '0');
      if (last[k] !== text) {
        last[k] = text;
        box.querySelector(`[data-u="${k}"]`).innerHTML = `<span>${text}</span>`;
      }
    }
  };
  tick();
  setInterval(tick, 1000);
}

// ---------- состояния страницы ----------

function showMessage(icon, title, text, actions = '') {
  bar.hidden = true;
  render(`
    <div class="card card--pad empty">
      <div class="empty__icon">${icon}</div>
      <h2>${title}</h2>
      <p>${text}</p>
      ${actions ? `<div class="actions">${actions}</div>` : ''}
    </div>`);
}

const vkButton = `<a class="btn btn--primary btn--lg" href="${VK_URL}" target="_blank" rel="noopener">${icons.vk} Группа конкурса ВКонтакте</a>`;

function showThanks(fresh) {
  const voted = store.get(votedKey(election.id));
  const name = voted?.name ? `за <b class="text">${escapeHtml(voted.name)}</b> ` : '';
  bar.hidden = true;
  render(`
    <div class="card card--pad center thanks">
      <div class="success-mark"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg></div>
      <h2>${fresh ? 'Спасибо! Ваш голос учтён' : 'Вы уже проголосовали'}</h2>
      <p class="muted top-gap-sm">${fresh ? `Ваш голос ${name}засчитан.` : `Ваш голос ${name}уже засчитан — проголосовать можно только один раз.`}</p>
      <div class="actions">${vkButton}</div>
    </div>`);
}

function candidateCard(c, i) {
  const photo = c.photo
    ? `<img src="${escapeHtml(c.photo)}" alt="" loading="lazy">`
    : `<span class="candidate__initials">${escapeHtml(initials(c.name))}</span>`;
  return `
    <label class="candidate" data-reveal data-d="${Math.min(i * 60, 480)}">
      <input type="radio" name="candidate" value="${escapeHtml(c.id)}" ${selected === c.id ? 'checked' : ''}>
      <span class="candidate__photo">${photo}<span class="candidate__check">${icons.check}</span></span>
      <span class="candidate__body">
        <span class="candidate__name">${escapeHtml(c.name)}</span>
        ${c.description ? `<span class="candidate__desc">${escapeHtml(c.description)}</span>` : ''}
      </span>
    </label>`;
}

function updateBar() {
  const c = selected && candidateById(selected);
  bar.hidden = !c;
  if (!c) return;
  barChoice.innerHTML = `<span class="muted small">Ваш выбор</span><b>${escapeHtml(c.name)}</b>`;
  voteButton.innerHTML = me.user ? `Проголосовать ${icons.arrow}` : `${icons.vk} Войти и проголосовать`;
}

function showCandidates() {
  const failed = new URLSearchParams(location.search).get('auth') === 'failed';
  const loginLine = me.user
    ? `<p class="small muted">Вы вошли через ВКонтакте${me.user.name ? ` как <b class="text">${escapeHtml(me.user.name)}</b>` : ''} · <a class="link" href="/auth/logout">Выйти</a></p>`
    : `<p class="small muted">Выберите участника. Чтобы проголосовать, нужно войти через ВКонтакте — один аккаунт, один голос.</p>`;
  render(`
    <div class="vote-head">
      <h2>За кого голосуете?</h2>
      ${loginLine}
    </div>
    ${failed ? note('danger', 'Не удалось войти', 'Вход через ВКонтакте не завершился. Попробуйте ещё раз.') : ''}
    ${!me.vkConfigured && !me.devLogin ? note('warning', 'Голосование скоро откроется', 'Вход через ВКонтакте ещё настраивается. Загляните чуть позже.') : ''}
    <form class="candidates" id="candidates">${nomination().candidates.map(candidateCard).join('')}</form>`);
  document.getElementById('candidates').addEventListener('change', (e) => {
    selected = e.target.value;
    updateBar();
  });
  updateBar();
}

// ---------- голосование ----------

function login() {
  try {
    sessionStorage.setItem(CHOICE_KEY, JSON.stringify({ election: election.id, candidate: selected }));
  } catch {
    /* ignore */
  }
  location.href = me.vkConfigured ? '/auth/vk/start?return=/%3Fvote%3D1' : '/auth/dev?return=/%3Fvote%3D1';
}

// Голос отправляется анонимно: сначала подпись, затем зашифрованный выбор.
async function sendVote(pending) {
  const keys = await loadPublicKeys(election.publicKeys);
  if (!pending) {
    const token = bytesToHex(randomBytes(32));
    const blind = await blindToken(token, keys.rsaPub);
    const ballot = await encryptBallot(election.id, { [nomination().id]: selected }, keys.electionKey);
    pending = { token, blinded: blind.blinded, r: blind.r, ballot, candidate: selected };
    store.set(pendingKey(election.id), pending);
  }
  if (!pending.signature) {
    const res = await api(`/api/elections/${election.id}/sign`, { method: 'POST', body: { blinded: pending.blinded } });
    const signature = unblindSignature(res.blindSignature, pending.r, keys.rsaPub);
    if (!(await verifyTokenSignature(pending.token, signature, keys.rsaPub))) throw new Error('Не удалось отправить голос. Попробуйте ещё раз');
    pending = { ...pending, signature };
    store.set(pendingKey(election.id), pending);
  }
  await api(`/api/elections/${election.id}/ballot`, {
    method: 'POST',
    body: { token: pending.token, signature: pending.signature, ballot: pending.ballot },
  });
  store.remove(pendingKey(election.id));
  store.set(votedKey(election.id), { name: candidateById(pending.candidate)?.name ?? '' });
}

async function vote() {
  const c = candidateById(selected);
  if (!c) return;
  if (!me.user) return login();
  const ok = await confirmDialog({
    title: `Голосуете за ${c.name}?`,
    text: 'Проголосовать можно только один раз, изменить выбор потом не получится.',
    ok: 'Да, проголосовать',
  });
  if (!ok) return;
  try {
    await withOverlay('Отправляем ваш голос…', () => sendVote(null));
    showThanks(true);
  } catch (err) {
    if (err.status === 409) return showThanks(false);
    toast(err.message);
  }
}

voteButton.addEventListener('click', vote);

// ---------- запуск ----------

async function main() {
  const [{ election: current, serverTime }, meRes] = await Promise.all([api('/api/current'), api('/api/me')]);
  me = meRes;

  if (!current) {
    setLead('');
    return showMessage(icons.clock, 'Голосование скоро начнётся', 'Как только организаторы откроют голосование, здесь появятся участники.', vkButton);
  }

  election = current;
  setLead(election.description ? escapeHtml(election.description) : '');

  if (election.status === 'finished') {
    return showMessage(icons.check, 'Голосование завершено', 'Спасибо всем, кто голосовал!', vkButton);
  }
  if (election.endsAt) countdown(election.endsAt, Date.parse(serverTime) - Date.now());

  session = await api(`/api/elections/${election.id}/session`);
  const pending = store.get(pendingKey(election.id));

  // Отправка прервалась (закрыли страницу, пропала связь) — тихо досылаем.
  if (session.loggedIn && pending?.ballot && (!session.ballotIssued || session.blinded === pending.blinded)) {
    try {
      selected = pending.candidate;
      await sendVote(pending);
      return showThanks(true);
    } catch {
      store.remove(pendingKey(election.id));
    }
  }
  if (session.ballotIssued) return showThanks(false);

  // Вернулись после входа через ВКонтакте — продолжаем с выбранным участником.
  let saved = null;
  try {
    saved = JSON.parse(sessionStorage.getItem(CHOICE_KEY));
    sessionStorage.removeItem(CHOICE_KEY);
  } catch {
    /* ignore */
  }
  if (saved?.election === election.id && candidateById(saved.candidate)) selected = saved.candidate;
  showCandidates();
  history.replaceState(null, '', '/');
  if (selected && me.user && saved) {
    document.getElementById('vote').scrollIntoView({ behavior: 'smooth' });
    vote();
  }
}

main().catch((err) => {
  showMessage(icons.alert, 'Не удалось загрузить страницу', escapeHtml(err.message), '<button class="btn btn--primary" id="reload">Обновить</button>');
  document.getElementById('reload')?.addEventListener('click', () => location.reload());
});

