import {
  api,
  renderChrome,
  statusBadge,
  formatDate,
  escapeHtml,
  plural,
  initials,
  initReveal,
  countUp,
  icons,
  VK_URL,
} from './common.js';

renderChrome();

const HOW = [
  [icons.user, 'Один человек — один голос', 'Для голосования нужно подтвердить номер телефона кодом из SMS: один номер — один бюллетень в каждом голосовании.'],
  [icons.eyeOff, 'Тайна голосования', 'Комиссия заверяет бюллетень «слепой подписью», не видя его. Связать голос с человеком невозможно.'],
  [icons.lock, 'Шифрование в браузере', 'Выбор шифруется прямо на вашем устройстве. До конца голосования промежуточных итогов не видит никто.'],
  [icons.blocks, 'Открытый реестр', 'Каждый бюллетень записывается в цепочку блоков. Подменить или удалить голос незаметно нельзя.'],
  [icons.receipt, 'Квитанция', 'После голосования вы получаете номер квитанции и в любой момент можете проверить, что голос учтён.'],
  [icons.chart, 'Пересчёт итогов', 'После завершения публикуется ключ расшифровки — любой может пересчитать голоса сам.'],
];

const FAQ = [
  ['Зачем подтверждать номер телефона?', 'Чтобы каждый голосовал один раз: один номер — один бюллетень в каждом голосовании. Номер не сохраняется, а связать бюллетень с номером невозможно — сайт не узнаёт, за кого вы проголосовали.'],
  ['Можно ли проголосовать повторно или изменить голос?', 'Нет. В каждом голосовании бюллетень выдаётся один раз на номер телефона, а каждая подпись комиссии принимается в реестр только один раз. Отправленный голос изменить нельзя.'],
  ['Что такое квитанция?', 'Это уникальный номер блока с вашим зашифрованным бюллетенем в реестре. Она сохраняется на устройстве, её можно скопировать или скачать. По квитанции видно, что голос записан, не изменён и учтён.'],
  ['Может ли кто-то узнать, за кого я проголосовал?', 'Реестр избирателей и реестр бюллетеней разделены, а бюллетень заверяется слепой подписью. Выбор зашифрован до конца голосования. Не показывайте никому свою квитанцию — после публикации итогов по ней можно увидеть расшифрованный бюллетень.'],
  ['Как убедиться, что итоги честные?', 'После завершения на странице «Итоги» нажмите «Пересчитать самостоятельно»: браузер скачает весь реестр, проверит цепочку и подписи и подсчитает голоса сам.'],
  ['Где следить за новостями конкурса?', 'Все новости, этапы и участники — в официальной группе конкурса «Выпускник Краснообска» во ВКонтакте.'],
];

function renderStatic() {
  document.getElementById('how-grid').innerHTML = HOW.map(
    ([icon, title, text], i) => `
      <div class="card card--hover spot step-card" data-reveal data-d="${i * 70}">
        <div class="icon-box">${icon}</div>
        <h3>${title}</h3>
        <p>${text}</p>
      </div>`,
  ).join('');
  document.getElementById('faq-list').innerHTML = FAQ.map(
    ([q, a], i) => `
      <details class="faq" data-reveal data-d="${i * 60}">
        <summary>${q}<i></i></summary>
        <div class="faq__body"><div><p>${a}</p></div></div>
      </details>`,
  ).join('');
}

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

function renderNoElection() {
  document.getElementById('hero-status').innerHTML = statusBadge('none');
  document.getElementById('hero-lead').classList.remove('lead-sk');
  document.getElementById('hero-lead').innerHTML =
    'Голосование ещё не началось. Как только оргкомитет его откроет, здесь появятся номинации и кнопка «Проголосовать». Следите за новостями в группе конкурса.';
  document.getElementById('hero-actions').innerHTML = `
    <a class="btn btn--primary btn--lg" href="${VK_URL}" target="_blank" rel="noopener">${icons.vk} Группа ВКонтакте</a>
    <a class="btn btn--glass btn--lg" href="#how">Как устроено голосование</a>`;
}

function renderElection(e, serverTime) {
  document.getElementById('hero-status').innerHTML = statusBadge(e.status);
  const lead = document.getElementById('hero-lead');
  lead.classList.remove('lead-sk');
  lead.innerHTML = `<b class="grad-text">${escapeHtml(e.title)}</b>${e.description ? `<br>${escapeHtml(e.description)}` : ''}`;

  const actions = document.getElementById('hero-actions');
  if (e.status === 'active') {
    actions.innerHTML = `
      <a class="btn btn--brand btn--lg" href="/vote">Проголосовать ${icons.arrow}</a>
      <a class="btn btn--glass btn--lg" href="/verify">Проверить голос</a>`;
    if (e.endsAt) countdown(e.endsAt, Date.parse(serverTime) - Date.now());
  } else {
    actions.innerHTML = `
      <a class="btn btn--brand btn--lg" href="/results">Смотреть итоги ${icons.arrow}</a>
      <a class="btn btn--glass btn--lg" href="/verify">Проверить голос</a>`;
  }

  const candidates = e.questions.reduce((n, q) => n + q.candidates.length, 0);
  document.getElementById('stats-wrap').hidden = false;
  countUp(document.getElementById('stat-cast'), e.stats.ballotsCast);
  countUp(document.getElementById('stat-issued'), e.stats.ballotsIssued);
  countUp(document.getElementById('stat-noms'), e.questions.length);
  countUp(document.getElementById('stat-cands'), candidates);

  document.getElementById('nominations-section').hidden = false;
  document.getElementById('nominations').innerHTML = e.questions
    .map(
      (q, i) => `
      <div class="card card--hover spot" data-reveal data-d="${i * 80}">
        <div class="eyebrow">Номинация ${i + 1} · ${q.candidates.length} ${plural(q.candidates.length, 'участник', 'участника', 'участников')}</div>
        <h3>${escapeHtml(q.title)}</h3>
        ${q.description ? `<p>${escapeHtml(q.description)}</p>` : ''}
        <div class="nominee-list">
          ${q.candidates.map((c) => `<span class="chip"><span class="avatar">${escapeHtml(initials(c.name))}</span>${escapeHtml(c.name)}</span>`).join('')}
        </div>
      </div>`,
    )
    .join('');
  if (e.status === 'finished') document.getElementById('nom-title').textContent = 'Номинации голосования';
  initReveal();
}

async function main() {
  renderStatic();
  initReveal();
  const { election, serverTime } = await api('/api/current');
  if (!election) renderNoElection();
  else renderElection(election, serverTime);
}

main().catch(() => renderNoElection());
