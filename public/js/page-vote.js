import {
  api,
  renderChrome,
  escapeHtml,
  formatDate,
  initials,
  store,
  copyText,
  downloadJson,
  receiptKey,
  pendingKey,
  icons,
  note,
  confetti,
  typeText,
  VK_URL,
  shake,
  toast,
  withLoading,
} from './common.js';
import {
  blindToken,
  bytesToHex,
  encryptBallot,
  loadPublicKeys,
  randomBytes,
  unblindSignature,
  verifyTokenSignature,
  computeBlockHash,
  verifyLedgerSignature,
} from './core.js';
import { solveChallenge } from './pow.js';

renderChrome();

const STEPS = ['Телефон', 'Бюллетень', 'Проверка', 'Отправка', 'Квитанция'];
const stepBox = document.getElementById('step');
const stepper = document.getElementById('stepper');

let election;
let keys;
let me;
const choices = {};

document.getElementById('aside-checks').innerHTML = [
  'Бюллетень выдаётся один раз',
  'Слепая подпись — голос нельзя связать с вами',
  'Шифрование до отправки',
  'Запись в открытый реестр',
]
  .map((t, i) => `<li class="ok"><span class="ci" data-d="${300 + i * 120}">${icons.check}</span><span>${t}</span></li>`)
  .join('');
document.querySelectorAll('#aside-checks .ci').forEach((n) => n.style.setProperty('--d', n.dataset.d + 'ms'));

function setStep(n) {
  stepper.innerHTML = STEPS.map(
    (label, i) => `<div class="stepper__item ${i < n ? 'done' : i === n ? 'current' : ''}"><div class="stepper__bar"></div>${label}</div>`,
  ).join('');
}

// Каждый шаг появляется с анимацией.
function render(html) {
  stepBox.innerHTML = `<div class="swap-in">${html}</div>`;
  const top = stepBox.getBoundingClientRect().top;
  if (top < 80) scrollTo({ top: scrollY + top - 120, behavior: 'smooth' });
}

function showMessage(kind, title, text, actions = '') {
  stepper.innerHTML = '';
  render(`${note(kind, title, text)}${actions ? `<div class="actions">${actions}</div>` : ''}`);
}

// ---------- шаг 1: подтверждение номера телефона ----------

// +7 (912) 345-67-89
function formatPhone(value) {
  let d = value.replace(/\D/g, '');
  if (d.startsWith('8')) d = '7' + d.slice(1);
  if (!d.startsWith('7')) d = '7' + d;
  d = d.slice(0, 11);
  const p = d.slice(1);
  let out = '+7';
  if (p.length) out += ' (' + p.slice(0, 3);
  if (p.length >= 3) out += ')';
  if (p.length > 3) out += ' ' + p.slice(3, 6);
  if (p.length > 6) out += '-' + p.slice(6, 8);
  if (p.length > 8) out += '-' + p.slice(8, 10);
  return out;
}
const phoneDigits = (v) => v.replace(/\D/g, '');

function stepLogin(prefill = '') {
  setStep(0);
  const canLogin = me.smsConfigured || me.devLogin;
  render(`
    <h2>Подтвердите номер телефона</h2>
    <p class="muted top-gap-sm">Голосование проходит ${election.endsAt ? `до ${formatDate(election.endsAt)} (время новосибирское)` : 'до объявления итогов оргкомитетом'}.</p>
    ${note('info', 'Один номер — один голос', 'Мы пришлём SMS с кодом. Номер нужен только для того, чтобы никто не проголосовал дважды: он не сохраняется, а бюллетень шифруется и заверяется слепой подписью — связать голос с номером невозможно.', icons.shield)}
    ${
      canLogin
        ? `<form id="phone-form" class="top-gap-sm" novalidate>
            <label class="label" for="phone">Мобильный номер</label>
            <div class="row">
              <input class="input input--phone" id="phone" type="tel" inputmode="tel" autocomplete="tel" placeholder="+7 (9__) ___-__-__" value="${escapeHtml(prefill)}">
              <button class="btn btn--brand btn--lg" type="submit" id="send-code">Получить код ${icons.arrow}</button>
            </div>
            <div id="pow" class="pow hidden"><span class="shimmer" id="pow-text">Проверяем, что вы не робот</span><div class="progress"><div class="progress__fill" id="pow-bar"></div></div></div>
            <div id="phone-error"></div>
          </form>`
        : note('warning', 'Вход ещё не настроен', 'Организаторы пока не подключили отправку SMS. Загляните чуть позже.')
    }`);
  if (!canLogin) return;
  const form = document.getElementById('phone-form');
  const input = document.getElementById('phone');
  const button = document.getElementById('send-code');
  input.addEventListener('input', () => (input.value = formatPhone(input.value)));
  input.addEventListener('focus', () => !input.value && (input.value = '+7 ('));
  input.focus();
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const errBox = document.getElementById('phone-error');
    errBox.innerHTML = '';
    const digits = phoneDigits(input.value);
    if (!/^79\d{9}$/.test(digits)) {
      shake(form);
      errBox.innerHTML = note('danger', 'Проверьте номер', 'Нужен российский мобильный номер: +7 (9XX) XXX-XX-XX.');
      return;
    }
    button.disabled = true;
    input.disabled = true;
    const pow = document.getElementById('pow');
    const bar = document.getElementById('pow-bar');
    pow.classList.remove('hidden');
    try {
      const { challenge, difficulty } = await api('/api/auth/challenge');
      const nonce = await solveChallenge(challenge, difficulty, (p) => (bar.style.width = `${p * 100}%`));
      bar.style.width = '100%';
      document.getElementById('pow-text').textContent = 'Отправляем SMS';
      const res = await api('/api/auth/send', { method: 'POST', body: { phone: digits, challenge, nonce } });
      stepCode(digits, res);
    } catch (err) {
      pow.classList.add('hidden');
      button.disabled = false;
      input.disabled = false;
      shake(form);
      errBox.innerHTML = note('danger', 'Не удалось отправить код', escapeHtml(err.message));
    }
  });
}

function stepCode(digits, sent) {
  setStep(0);
  render(`
    <h2>Введите код из SMS</h2>
    <p class="muted top-gap-sm">Код отправлен на номер <b class="text">${escapeHtml(sent.phone)}</b> · <button class="link" id="change">Изменить номер</button></p>
    ${sent.devCode ? note('warning', 'Тестовый режим', `SMS не отправляется. Ваш код: <b class="text mono">${escapeHtml(sent.devCode)}</b>`) : ''}
    <form id="code-form" class="top-gap-sm" novalidate>
      <label class="label" for="code">Код из 6 цифр</label>
      <div class="row">
        <input class="input input--code" id="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="••••••">
        <button class="btn btn--brand btn--lg" type="submit" id="verify">Подтвердить ${icons.arrow}</button>
      </div>
      <div id="code-error"></div>
      <p class="small muted top-gap-sm" id="resend-box"></p>
    </form>`);
  const form = document.getElementById('code-form');
  const input = document.getElementById('code');
  const button = document.getElementById('verify');
  const resendBox = document.getElementById('resend-box');
  input.focus();
  document.getElementById('change').addEventListener('click', () => stepLogin(formatPhone(digits)));

  let left = sent.resendIn ?? 60;
  const tick = () => {
    if (!document.body.contains(resendBox)) return clearInterval(timer);
    if (left > 0) {
      resendBox.textContent = `Отправить код повторно можно через ${left} с`;
      left--;
    } else {
      clearInterval(timer);
      resendBox.innerHTML = '<button class="link" id="resend" type="button">Отправить код ещё раз</button>';
      document.getElementById('resend').addEventListener('click', () => stepLogin(formatPhone(digits)));
    }
  };
  const timer = setInterval(tick, 1000);
  tick();

  const submit = async () => {
    const code = input.value.replace(/\D/g, '');
    const errBox = document.getElementById('code-error');
    errBox.innerHTML = '';
    if (code.length !== 6) {
      shake(form);
      return;
    }
    button.disabled = true;
    try {
      await withLoading(button, () => api('/api/auth/verify', { method: 'POST', body: { phone: digits, code } }));
      clearInterval(timer);
      toast('Номер подтверждён');
      main();
    } catch (err) {
      button.disabled = false;
      input.select();
      shake(form);
      errBox.innerHTML = note('danger', 'Код не подошёл', escapeHtml(err.message));
    }
  };
  input.addEventListener('input', () => {
    input.value = input.value.replace(/\D/g, '').slice(0, 6);
    if (input.value.length === 6) submit();
  });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    submit();
  });
}

async function logout() {
  await api('/api/auth/logout', { method: 'POST' });
  main();
}

// ---------- шаг 1б: подтверждение ----------

function stepAuth() {
  setStep(0);
  render(`
    <h2>Подтверждение участника</h2>
    <p class="muted top-gap-sm">Номер <b class="text">${escapeHtml(me.user?.phone ?? '')}</b> подтверждён · <button class="link" id="logout">Выйти</button></p>
    <div class="top-gap-sm">
      <label class="check">
        <input type="checkbox" id="agree">
        <span>Я голосую лично и понимаю, что проголосовать можно только один раз, а изменить голос после отправки нельзя.</span>
      </label>
    </div>
    <div class="actions">
      <button class="btn btn--brand btn--lg" id="next" disabled>Получить бюллетень ${icons.arrow}</button>
    </div>`);
  document.getElementById('logout').addEventListener('click', logout);
  const agree = document.getElementById('agree');
  const next = document.getElementById('next');
  agree.addEventListener('change', () => (next.disabled = !agree.checked));
  next.addEventListener('click', stepBallot);
}

// ---------- шаг 2: бюллетень ----------

function stepBallot() {
  setStep(1);
  const questions = election.questions
    .map(
      (q, qi) => `
      <fieldset class="question">
        <legend class="sr-only">${escapeHtml(q.title)}</legend>
        <div class="eyebrow">Номинация ${qi + 1} из ${election.questions.length}</div>
        <div class="question__title">${escapeHtml(q.title)}</div>
        ${q.description ? `<p class="question__desc">${escapeHtml(q.description)}</p>` : ''}
        <div class="options">
          ${q.candidates
            .map(
              (c) => `
            <label class="option">
              <input type="radio" name="${escapeHtml(q.id)}" value="${escapeHtml(c.id)}" ${choices[q.id] === c.id ? 'checked' : ''}>
              <span class="option__radio"></span>
              <span class="avatar avatar--lg">${escapeHtml(initials(c.name))}</span>
              <span><span class="option__name">${escapeHtml(c.name)}</span>${c.description ? `<br><span class="option__desc">${escapeHtml(c.description)}</span>` : ''}</span>
            </label>`,
            )
            .join('')}
        </div>
      </fieldset>`,
    )
    .join('');
  render(`
    <h2>Электронный бюллетень</h2>
    <p class="muted top-gap-sm">Отметьте по одному варианту в каждой номинации.</p>
    <form id="ballot-form" class="top-gap">${questions}
      <div class="actions">
        <button class="btn btn--brand btn--lg" type="submit" id="next" disabled>Далее ${icons.arrow}</button>
        <span class="small muted center-v" id="left"></span>
      </div>
    </form>`);
  const form = document.getElementById('ballot-form');
  const next = document.getElementById('next');
  const left = document.getElementById('left');
  const update = () => {
    for (const q of election.questions) {
      const picked = form.querySelector(`input[name="${CSS.escape(q.id)}"]:checked`);
      if (picked) choices[q.id] = picked.value;
    }
    const remaining = election.questions.filter((q) => !choices[q.id]).length;
    next.disabled = remaining > 0;
    left.textContent = remaining ? `Осталось выбрать: ${remaining}` : 'Все номинации отмечены';
  };
  form.addEventListener('change', (e) => {
    update();
    // Автопрокрутка к следующей номинации.
    const fs = e.target.closest('fieldset');
    const nextFs = fs?.nextElementSibling;
    if (nextFs?.tagName === 'FIELDSET' && !nextFs.querySelector('input:checked')) {
      setTimeout(() => nextFs.scrollIntoView({ behavior: 'smooth', block: 'start' }), 250);
    }
  });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    update();
    if (!next.disabled) stepConfirm();
  });
  update();
}

// ---------- шаг 3: проверка выбора ----------

function stepConfirm() {
  setStep(2);
  const rows = election.questions
    .map((q) => {
      const c = q.candidates.find((x) => x.id === choices[q.id]);
      return `<dt>${escapeHtml(q.title)}</dt><dd><span class="chip"><span class="avatar">${escapeHtml(initials(c.name))}</span>${escapeHtml(c.name)}</span></dd>`;
    })
    .join('');
  render(`
    <h2>Проверьте свой выбор</h2>
    <p class="muted top-gap-sm">После отправки изменить голос будет невозможно.</p>
    <div class="receipt top-gap"><dl class="kv">${rows}</dl></div>
    <div class="actions">
      <button class="btn btn--brand btn--lg" id="send">Отправить голос ${icons.arrow}</button>
      <button class="btn btn--glass btn--lg" id="back">Изменить выбор</button>
    </div>`);
  document.getElementById('back').addEventListener('click', stepBallot);
  document.getElementById('send').addEventListener('click', () => stepSend());
}

// ---------- шаг 4: криптография и отправка ----------

const FLOW = [
  ['token', 'Создаём анонимный токен', 'Случайный токен создаётся на вашем устройстве и «ослепляется»'],
  ['encrypt', 'Шифруем бюллетень', 'ECDH P-256 + AES-256-GCM открытым ключом комиссии'],
  ['sign', 'Получаем слепую подпись', 'Комиссия подтверждает право голоса, не видя токен'],
  ['cast', 'Записываем в реестр', 'Бюллетень анонимно добавляется в цепочку блоков'],
  ['verify', 'Проверяем квитанцию', 'Браузер сверяет хеш блока и подпись реестра'],
];

function renderFlow() {
  setStep(3);
  render(`
    <h2>Отправка голоса</h2>
    <p class="muted top-gap-sm">Все криптографические операции выполняются в вашем браузере.</p>
    <ol class="flow top-gap">
      ${FLOW.map(
        ([id, title, desc]) => `<li id="f-${id}"><span class="flow__icon">${icons.check}</span><div><div class="flow__title">${title}</div><div class="flow__desc">${desc}</div></div></li>`,
      ).join('')}
    </ol>
    <div id="send-error"></div>`);
}

function mark(id, state) {
  const li = document.getElementById('f-' + id);
  if (!li) return;
  li.className = state;
  const title = li.querySelector('.flow__title');
  title.classList.toggle('shimmer', state === 'active');
}

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

async function stepSend(resume = null) {
  renderFlow();
  let current = 'token';
  const run = async (id, fn) => {
    current = id;
    mark(id, 'active');
    const [result] = await Promise.all([fn(), pause(650)]);
    mark(id, 'done');
    return result;
  };

  try {
    let pending = resume;
    if (!pending) {
      const token = bytesToHex(randomBytes(32));
      const blind = await run('token', () => blindToken(token, keys.rsaPub));
      const ballot = await run('encrypt', () => encryptBallot(election.id, { ...choices }, keys.electionKey));
      // Сохраняем до запроса подписи: при обрыве связи голос можно будет дослать.
      pending = { token, blinded: blind.blinded, r: blind.r, ballot };
      store.set(pendingKey(election.id), pending);
    } else {
      mark('token', 'done');
      mark('encrypt', 'done');
    }

    if (!pending.signature) {
      const signature = await run('sign', async () => {
        const res = await api(`/api/elections/${election.id}/sign`, { method: 'POST', body: { blinded: pending.blinded } });
        const sig = unblindSignature(res.blindSignature, pending.r, keys.rsaPub);
        if (!(await verifyTokenSignature(pending.token, sig, keys.rsaPub))) throw new Error('Подпись комиссии не прошла проверку');
        return sig;
      });
      pending = { ...pending, signature };
      store.set(pendingKey(election.id), pending);
    } else {
      mark('sign', 'done');
    }

    const { block } = await run('cast', () =>
      api(`/api/elections/${election.id}/ballot`, {
        method: 'POST',
        body: { token: pending.token, signature: pending.signature, ballot: pending.ballot },
      }),
    );

    await run('verify', async () => {
      const hashOk = (await computeBlockHash(block)) === block.hash;
      const sigOk = await verifyLedgerSignature(block.hash, block.ledgerSignature, keys.ledgerKey);
      if (!hashOk || !sigOk || block.ballot !== pending.ballot || block.token !== pending.token) {
        throw new Error('Квитанция реестра не прошла проверку. Сохраните снимок экрана и сообщите организаторам');
      }
    });

    const receipt = {
      election: election.id,
      electionTitle: election.title,
      receipt: block.hash,
      index: block.index,
      timestamp: block.timestamp,
      prevHash: block.prevHash,
      token: block.token,
      signature: block.signature,
      ballot: block.ballot,
      ledgerSignature: block.ledgerSignature,
    };
    store.set(receiptKey(election.id), receipt);
    store.remove(pendingKey(election.id));
    await pause(300);
    stepReceipt(receipt, true);
  } catch (err) {
    mark(current, 'error');
    const canRetry = store.get(pendingKey(election.id)) && err.status !== 409 && err.status !== 403;
    document.getElementById('send-error').innerHTML = `
      ${note('danger', 'Не удалось отправить голос', escapeHtml(err.message))}
      ${canRetry ? `<div class="actions"><button class="btn btn--primary" id="retry">Повторить отправку</button></div>` : ''}`;
    document.getElementById('retry')?.addEventListener('click', () => stepSend(store.get(pendingKey(election.id))));
  }
}

// ---------- шаг 5: квитанция ----------

function stepReceipt(receipt, fresh = false) {
  setStep(fresh ? 4 : 5);
  render(`
    <div class="center">
      <div class="success-mark">${'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>'}</div>
      <h2>${fresh ? 'Ваш голос принят!' : 'Вы уже проголосовали'}</h2>
      <p class="muted top-gap-sm">Зашифрованный бюллетень записан в реестр, блок № ${receipt.index + 1}. Квитанция сохранена на этом устройстве.</p>
    </div>
    <div class="receipt top-gap">
      <span class="label">Номер квитанции</span>
      <div class="receipt__code" id="receipt-code"></div>
      <dl class="kv top-gap-sm">
        <dt>Время записи</dt><dd>${formatDate(receipt.timestamp)}</dd>
        <dt>Подпись реестра</dt><dd class="mono">${escapeHtml(receipt.ledgerSignature.slice(0, 28))}…</dd>
      </dl>
    </div>
    <div class="actions">
      <a class="btn btn--brand" href="/verify?receipt=${receipt.receipt}">Проверить голос ${icons.arrow}</a>
      <button class="btn btn--glass" id="copy">${icons.copy} Скопировать</button>
      <button class="btn btn--glass" id="download">${icons.download} Скачать</button>
    </div>
    <p class="small muted">Квитанция не содержит вашего выбора в открытом виде. Не показывайте её никому: после объявления итогов по ней можно увидеть расшифрованный бюллетень.</p>`);
  const code = document.getElementById('receipt-code');
  if (fresh) {
    confetti();
    typeText(code, receipt.receipt);
  } else {
    code.textContent = receipt.receipt;
  }
  document.getElementById('copy').addEventListener('click', () => copyText(receipt.receipt));
  document.getElementById('download').addEventListener('click', () =>
    downloadJson(`kvitanciya-${receipt.receipt.slice(0, 12)}.json`, receipt),
  );
}

// ---------- запуск ----------

async function main() {
  const { election: current } = await api('/api/current');
  if (!current || current.status !== 'active') {
    document.getElementById('vote-status').textContent = 'Голосование';
    if (current?.status === 'finished') {
      document.getElementById('vote-title').textContent = current.title;
      return showMessage('info', 'Голосование завершено', 'Приём голосов окончен, итоги уже подведены.', `<a class="btn btn--brand" href="/results">Смотреть итоги ${icons.arrow}</a>`);
    }
    return showMessage(
      'warning',
      'Голосование ещё не началось',
      'Как только оргкомитет откроет голосование, здесь появится бюллетень. Следите за новостями в группе конкурса.',
      `<a class="btn btn--primary" href="${VK_URL}" target="_blank" rel="noopener">${icons.vk} Группа ВКонтакте</a><a class="btn btn--glass" href="/">На главную</a>`,
    );
  }

  election = current;
  document.getElementById('vote-status').textContent = 'Электронный бюллетень';
  document.getElementById('vote-title').textContent = election.title;
  keys = await loadPublicKeys(election.publicKeys);
  me = await api('/api/me');
  const session = await api(`/api/elections/${election.id}/session`);
  const receipt = store.get(receiptKey(election.id));
  const pending = store.get(pendingKey(election.id));

  if (!session.loggedIn) return stepLogin();

  if (pending?.ballot) {
    if (!session.ballotIssued || session.blinded === pending.blinded) {
      stepper.innerHTML = '';
      render(`
        ${note('warning', 'Есть неотправленный бюллетень', 'Прошлая отправка не завершилась. Бюллетень уже зашифрован — его можно дослать.')}
        <div class="actions"><button class="btn btn--brand" id="resume">Завершить отправку ${icons.arrow}</button></div>`);
      document.getElementById('resume').addEventListener('click', () => stepSend(pending));
      return;
    }
    store.remove(pendingKey(election.id));
  }

  if (session.ballotIssued) {
    // Квитанция в браузере показывается, только если голосовал именно этот аккаунт.
    if (receipt) return stepReceipt(receipt);
    return showMessage(
      'warning',
      'Вы уже проголосовали',
      'С этого номера телефона уже проголосовали в этом голосовании. Проголосовать можно только один раз.',
      `<a class="btn btn--primary" href="/verify">Проверить голос</a><a class="btn btn--glass" href="/ledger">Открыть реестр</a>`,
    );
  }

  stepAuth();
}

main().catch((err) => {
  showMessage('danger', 'Не удалось загрузить голосование', escapeHtml(err.message), '<button class="btn btn--primary" id="reload">Обновить страницу</button>');
  document.getElementById('reload')?.addEventListener('click', () => location.reload());
});

