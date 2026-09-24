import {
  api,
  renderChrome,
  escapeHtml,
  formatDate,
  initials,
  store,
  copyText,
  downloadJson,
  RECEIPT_KEY,
  PENDING_KEY,
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

const STEPS = ['Подтверждение', 'Бюллетень', 'Проверка выбора', 'Отправка', 'Квитанция'];
const stepBox = document.getElementById('step');
const stepper = document.getElementById('stepper');

let info;
let keys;
const choices = {};

function setStep(n) {
  stepper.innerHTML = STEPS.map(
    (label, i) =>
      `<div class="stepper__item ${i < n ? 'done' : i === n ? 'current' : ''}"><div class="stepper__bar"></div>${label}</div>`,
  ).join('');
}

function render(html) {
  stepBox.innerHTML = html;
  stepBox.scrollIntoView({ block: 'nearest' });
}

function showMessage(kind, title, text, actions = '') {
  stepper.innerHTML = '';
  render(`
    <div class="alert alert--${kind}">
      <div><h3>${title}</h3><p class="muted">${text}</p></div>
    </div>
    ${actions ? `<div class="actions">${actions}</div>` : ''}`);
}

// ---------- шаг 1: подтверждение личности ----------

function stepAuth() {
  setStep(0);
  render(`
    <h2>${escapeHtml(info.election.title)}</h2>
    <p class="muted">${escapeHtml(info.election.subtitle)}. Голосование проходит до ${formatDate(info.election.endsAt)}.</p>
    <div class="alert">
      <div>
        <b>Подтверждение участника</b>
        <p class="small muted">Сейчас бюллетень выдаётся один раз на устройство. В ближайшее время появится подтверждение по номеру телефона с кодом из SMS.</p>
      </div>
    </div>
    <div class="stack">
      <label class="checkbox">
        <input type="checkbox" id="agree-personal">
        <span>Я голосую лично и понимаю, что проголосовать можно только один раз, а изменить голос после отправки нельзя.</span>
      </label>
    </div>
    <div class="actions">
      <button class="btn btn--primary" id="next" disabled>Получить бюллетень</button>
    </div>`);
  const agree = document.getElementById('agree-personal');
  const next = document.getElementById('next');
  agree.addEventListener('change', () => {
    next.disabled = !agree.checked;
  });
  next.addEventListener('click', stepBallot);
}

// ---------- шаг 2: бюллетень ----------

function stepBallot() {
  setStep(1);
  const questions = info.election.questions
    .map(
      (q) => `
      <fieldset class="question">
        <legend class="hidden">${escapeHtml(q.title)}</legend>
        <h3>${escapeHtml(q.title)}</h3>
        <p class="muted small">${escapeHtml(q.description ?? '')}</p>
        <div class="options">
          ${q.candidates
            .map(
              (c) => `
            <label class="option">
              <input type="radio" name="${escapeHtml(q.id)}" value="${escapeHtml(c.id)}" ${choices[q.id] === c.id ? 'checked' : ''}>
              <span class="option__radio"></span>
              <span class="option__avatar">${escapeHtml(initials(c.name))}</span>
              <span><span class="option__name">${escapeHtml(c.name)}</span><br><span class="option__desc">${escapeHtml(c.description ?? '')}</span></span>
            </label>`,
            )
            .join('')}
        </div>
      </fieldset>`,
    )
    .join('');
  render(`
    <h2>Электронный бюллетень</h2>
    <p class="muted">Отметьте по одному варианту в каждой номинации.</p>
    <form id="ballot-form">${questions}
      <div class="actions">
        <button class="btn btn--primary" type="submit" id="next" disabled>Далее</button>
      </div>
    </form>`);
  const form = document.getElementById('ballot-form');
  const next = document.getElementById('next');
  const update = () => {
    for (const q of info.election.questions) {
      const picked = form.querySelector(`input[name="${CSS.escape(q.id)}"]:checked`);
      if (picked) choices[q.id] = picked.value;
    }
    next.disabled = !info.election.questions.every((q) => choices[q.id]);
  };
  form.addEventListener('change', update);
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
  const rows = info.election.questions
    .map((q) => {
      const c = q.candidates.find((x) => x.id === choices[q.id]);
      return `<dt>${escapeHtml(q.title)}</dt><dd><b>${escapeHtml(c.name)}</b><br><span class="small muted">${escapeHtml(c.description ?? '')}</span></dd>`;
    })
    .join('');
  render(`
    <h2>Проверьте свой выбор</h2>
    <p class="muted">После отправки изменить голос будет невозможно.</p>
    <div class="receipt"><dl class="kv">${rows}</dl></div>
    <div class="actions">
      <button class="btn btn--primary" id="send">Отправить голос</button>
      <button class="btn btn--secondary" id="back">Изменить выбор</button>
    </div>`);
  document.getElementById('back').addEventListener('click', stepBallot);
  document.getElementById('send').addEventListener('click', () => stepSend());
}

// ---------- шаг 4: криптография и отправка ----------

const PROGRESS = [
  ['token', 'Создание анонимного токена', 'Случайный токен создаётся на вашем устройстве и «ослепляется»'],
  ['encrypt', 'Шифрование бюллетеня', 'Выбор шифруется открытым ключом комиссии (ECDH P-256 + AES-256-GCM)'],
  ['sign', 'Слепая подпись комиссии', 'Комиссия подтверждает право голоса, не видя токен'],
  ['cast', 'Анонимная запись в реестр', 'Бюллетень с подписью добавляется в цепочку блоков'],
  ['verify', 'Проверка квитанции', 'Браузер проверяет хеш блока и подпись реестра'],
];

function renderProgress() {
  setStep(3);
  render(`
    <h2>Отправка голоса</h2>
    <p class="muted">Все криптографические операции выполняются в вашем браузере.</p>
    <ol class="progress-list">
      ${PROGRESS.map(([id, title, desc]) => `<li id="p-${id}"><span class="pi"></span><div><div>${title}</div><div class="pd">${desc}</div></div></li>`).join('')}
    </ol>
    <div id="send-error"></div>`);
}

function mark(id, state) {
  const li = document.getElementById('p-' + id);
  if (li) li.className = state;
}

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

async function stepSend(resume = null) {
  renderProgress();
  let current = 'token';
  const run = async (id, fn) => {
    current = id;
    mark(id, 'active');
    const [result] = await Promise.all([fn(), pause(350)]);
    mark(id, 'done');
    return result;
  };

  try {
    let pending = resume;
    if (!pending) {
      const token = bytesToHex(randomBytes(32));
      const blind = await run('token', () => blindToken(token, keys.rsaPub));
      const ballot = await run('encrypt', () => encryptBallot(info.election.id, { ...choices }, keys.electionKey));
      // Сохраняем до запроса подписи: при обрыве связи голос можно будет досылать.
      pending = { token, blinded: blind.blinded, r: blind.r, ballot };
      store.set(PENDING_KEY, pending);
    } else {
      mark('token', 'done');
      mark('encrypt', 'done');
    }

    if (!pending.signature) {
      const signature = await run('sign', async () => {
        const res = await api('/api/sign', { method: 'POST', body: { blinded: pending.blinded } });
        const sig = unblindSignature(res.blindSignature, pending.r, keys.rsaPub);
        if (!(await verifyTokenSignature(pending.token, sig, keys.rsaPub))) {
          throw new Error('Подпись комиссии не прошла проверку');
        }
        return sig;
      });
      pending = { ...pending, signature };
      store.set(PENDING_KEY, pending);
    } else {
      mark('sign', 'done');
    }

    const { block } = await run('cast', () =>
      api('/api/ballot', {
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
      election: info.election.id,
      receipt: block.hash,
      index: block.index,
      timestamp: block.timestamp,
      prevHash: block.prevHash,
      token: block.token,
      signature: block.signature,
      ballot: block.ballot,
      ledgerSignature: block.ledgerSignature,
    };
    store.set(RECEIPT_KEY, receipt);
    store.remove(PENDING_KEY);
    stepReceipt(receipt, true);
  } catch (err) {
    mark(current, 'error');
    document.getElementById('send-error').innerHTML = `
      <div class="alert alert--danger"><div><b>Не удалось отправить голос</b><p class="small">${escapeHtml(err.message)}</p></div></div>
      ${store.get(PENDING_KEY) && err.status !== 409 ? '<div class="actions"><button class="btn btn--primary" id="retry">Повторить отправку</button></div>' : ''}`;
    document.getElementById('retry')?.addEventListener('click', () => stepSend(store.get(PENDING_KEY)));
  }
}

// ---------- шаг 5: квитанция ----------

function stepReceipt(receipt, fresh = false) {
  setStep(fresh ? 4 : 5);
  render(`
    <div class="alert alert--success">
      <div>
        <h3>${fresh ? 'Ваш голос принят' : 'Вы уже проголосовали'}</h3>
        <p class="small">Зашифрованный бюллетень записан в реестр в блоке № ${receipt.index + 1}. Квитанция сохранена на этом устройстве.</p>
      </div>
    </div>
    <div class="receipt stack">
      <div>
        <div class="field__label">Номер квитанции (хеш блока)</div>
        <div class="receipt__code">${escapeHtml(receipt.receipt)}</div>
      </div>
      <dl class="kv">
        <dt>Блок</dt><dd>№ ${receipt.index + 1}</dd>
        <dt>Время записи</dt><dd>${formatDate(receipt.timestamp)}</dd>
        <dt>Подпись реестра</dt><dd class="mono small">${escapeHtml(receipt.ledgerSignature.slice(0, 32))}…</dd>
      </dl>
    </div>
    <div class="actions">
      <a class="btn btn--primary" href="/verify?receipt=${receipt.receipt}">Проверить голос</a>
      <button class="btn btn--secondary" id="copy">Скопировать номер</button>
      <button class="btn btn--secondary" id="download">Скачать квитанцию</button>
    </div>
    <p class="small muted">Квитанция не содержит вашего выбора в открытом виде. После завершения голосования по ней можно будет увидеть расшифрованный бюллетень и убедиться, что он учтён.</p>`);
  document.getElementById('copy').addEventListener('click', () => copyText(receipt.receipt));
  document.getElementById('download').addEventListener('click', () =>
    downloadJson(`kvitanciya-${receipt.receipt.slice(0, 12)}.json`, receipt),
  );
}

// ---------- запуск ----------

async function main() {
  info = await api('/api/election');
  keys = await loadPublicKeys(info.publicKeys);
  const session = await api('/api/session');
  const receipt = store.get(RECEIPT_KEY);
  const pending = store.get(PENDING_KEY);

  if (receipt && receipt.election === info.election.id) return stepReceipt(receipt);

  if (session.status === 'upcoming') {
    return showMessage('warning', 'Голосование ещё не началось', `Оно откроется ${formatDate(info.election.startsAt)}.`, '<a class="btn btn--primary" href="/">На главную</a>');
  }
  if (session.status === 'ended') {
    return showMessage('warning', 'Голосование завершено', 'Приём бюллетеней окончен.', '<a class="btn btn--primary" href="/results">Смотреть итоги</a>');
  }

  if (pending?.ballot) {
    if (!session.ballotIssued || session.blinded === pending.blinded) {
      stepper.innerHTML = '';
      render(`
        <div class="alert alert--warning"><div>
          <h3>Есть неотправленный бюллетень</h3>
          <p class="small">Прошлая отправка голоса не завершилась. Бюллетень уже зашифрован — его можно дослать.</p>
        </div></div>
        <div class="actions"><button class="btn btn--primary" id="resume">Завершить отправку</button></div>`);
      document.getElementById('resume').addEventListener('click', () => stepSend(pending));
      return;
    }
    store.remove(PENDING_KEY);
  }

  if (session.ballotIssued) {
    return showMessage(
      'warning',
      'Бюллетень уже выдан',
      'На этом устройстве бюллетень уже был получен. Проголосовать можно только один раз. Если вы голосовали, проверьте голос по сохранённой квитанции.',
      '<a class="btn btn--primary" href="/verify">Проверить голос</a> <a class="btn btn--secondary" href="/ledger">Открыть реестр</a>',
    );
  }

  stepAuth();
}

main().catch((err) => {
  showMessage('danger', 'Ошибка загрузки', escapeHtml(err.message), '<button class="btn btn--primary" id="reload">Обновить страницу</button>');
  document.getElementById('reload')?.addEventListener('click', () => location.reload());
});
