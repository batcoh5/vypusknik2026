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

renderChrome();

const STEPS = ['Подтверждение', 'Бюллетень', 'Проверка', 'Отправка', 'Квитанция'];
const stepBox = document.getElementById('step');
const stepper = document.getElementById('stepper');

let election;
let keys;
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

// ---------- шаг 1: подтверждение ----------

function stepAuth() {
  setStep(0);
  render(`
    <h2>Подтверждение участника</h2>
    <p class="muted top-gap-sm">Голосование проходит ${election.endsAt ? `до ${formatDate(election.endsAt)} (время новосибирское)` : 'до объявления итогов оргкомитетом'}.</p>
    ${note('info', 'Один голос на устройство', 'Сейчас бюллетень выдаётся один раз на устройство. Скоро появится подтверждение по номеру телефона с кодом из SMS.', icons.shield)}
    <div class="top-gap-sm">
      <label class="check">
        <input type="checkbox" id="agree">
        <span>Я голосую лично и понимаю, что проголосовать можно только один раз, а изменить голос после отправки нельзя.</span>
      </label>
    </div>
    <div class="actions">
      <button class="btn btn--brand btn--lg" id="next" disabled>Получить бюллетень ${icons.arrow}</button>
    </div>`);
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
  const session = await api(`/api/elections/${election.id}/session`);
  const receipt = store.get(receiptKey(election.id));
  const pending = store.get(pendingKey(election.id));

  if (receipt) return stepReceipt(receipt);

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
    return showMessage(
      'warning',
      'Бюллетень уже выдан',
      'На этом устройстве бюллетень в этом голосовании уже был получен. Проголосовать можно только один раз.',
      `<a class="btn btn--primary" href="/verify">Проверить голос</a><a class="btn btn--glass" href="/ledger">Открыть реестр</a>`,
    );
  }

  stepAuth();
}

main().catch((err) => {
  showMessage('danger', 'Не удалось загрузить голосование', escapeHtml(err.message), '<button class="btn btn--primary" id="reload">Обновить страницу</button>');
  document.getElementById('reload')?.addEventListener('click', () => location.reload());
});

