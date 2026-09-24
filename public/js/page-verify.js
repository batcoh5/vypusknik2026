import {
  api,
  renderChrome,
  setFooterStatus,
  escapeHtml,
  formatDate,
  store,
  shortHash,
  statusBadge,
  icons,
  note,
  shake,
  withLoading,
  initials,
} from './common.js';
import {
  loadPublicKeys,
  computeBlockHash,
  verifyLedgerSignature,
  verifyTokenSignature,
  GENESIS_HASH,
  importElectionPrivateKey,
  decryptBallot,
  validateChoices,
} from './core.js';

renderChrome();
api('/api/current')
  .then((r) => setFooterStatus(r.election?.status ?? 'none'))
  .catch(() => setFooterStatus('none'));

const form = document.getElementById('verify-form');
const input = document.getElementById('receipt-input');
const button = document.getElementById('verify-btn');
const result = document.getElementById('result');
document.getElementById('upload-icon').outerHTML = icons.upload;

// Все квитанции, сохранённые на этом устройстве.
function savedReceipts() {
  const out = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k?.startsWith('vyp26:receipt:')) {
        const r = store.get(k.slice('vyp26:'.length));
        if (r?.receipt) out.push(r);
      }
    }
  } catch {
    /* хранилище недоступно */
  }
  return out;
}

const skeletonResult = `
  <div class="card card--pad">
    <div class="sk sk--title"></div>
    <div class="grid grid--2 top-gap">
      <div>${'<div class="sk sk--block"></div>'.repeat(3)}</div>
      <div><div class="sk sk--line"></div><div class="sk sk--line"></div><div class="sk sk--line sk--short"></div></div>
    </div>
  </div>`;

function check(ok, title, detail, i) {
  const cls = ok === null ? 'na' : ok ? 'ok' : 'fail';
  const icon = ok === null ? icons.minus : ok ? icons.check : icons.x;
  return `<li class="${cls}"><span class="ci" data-d="${i * 110}">${icon}</span><div><div>${title}</div><div class="sub">${detail}</div></div></li>`;
}

async function verify(hash, receipt = null) {
  hash = hash.trim().toLowerCase();
  input.value = hash;
  if (!/^[0-9a-f]{64}$/.test(hash)) {
    shake(form);
    result.innerHTML = `<div class="swap-in">${note('danger', 'Некорректный номер', 'Номер квитанции состоит из 64 символов: цифры 0–9 и буквы a–f.')}</div>`;
    return;
  }
  history.replaceState(null, '', `?receipt=${hash}`);
  result.innerHTML = skeletonResult;

  let data;
  try {
    data = await api(`/api/receipts/${hash}`);
  } catch (err) {
    result.innerHTML = `<div class="swap-in">${note('danger', 'Бюллетень не найден', `${escapeHtml(err.message)}. Проверьте номер квитанции. Если голосование было удалено организаторами, его реестр больше недоступен.`)}</div>`;
    return;
  }
  const { block, prev, nextHash, total, election } = data;
  const keys = await loadPublicKeys(election.publicKeys);
  const mine = receipt ?? savedReceipts().find((r) => r.receipt === hash) ?? null;

  const hashOk = (await computeBlockHash(block)) === block.hash;
  const linkOk = prev ? prev.hash === block.prevHash : block.prevHash === GENESIS_HASH && block.index === 0;
  const ledgerOk = await verifyLedgerSignature(block.hash, block.ledgerSignature, keys.ledgerKey);
  const blindOk = await verifyTokenSignature(block.token, block.signature, keys.rsaPub);
  const localOk = mine ? mine.ballot === block.ballot && mine.token === block.token : null;
  const receiptSigOk = mine?.ledgerSignature ? await verifyLedgerSignature(hash, mine.ledgerSignature, keys.ledgerKey) : null;

  let decrypted = null;
  let decryptNote = 'Расшифровка станет доступна после завершения голосования, когда комиссия опубликует ключ.';
  if (election.electionPrivateKey) {
    try {
      const priv = await importElectionPrivateKey(election.electionPrivateKey);
      decrypted = validateChoices(election, await decryptBallot(block.ballot, priv));
      decryptNote = decrypted ? 'Расшифрован опубликованным ключом комиссии и учтён в итогах' : 'Бюллетень признан недействительным';
    } catch {
      decryptNote = 'Не удалось расшифровать — бюллетень недействителен';
    }
  }

  const allOk = hashOk && linkOk && ledgerOk && blindOk && localOk !== false && receiptSigOk !== false;
  const checks = [
    [true, 'Бюллетень найден в реестре', `Блок № ${block.index + 1} из ${total}`],
    [hashOk, 'Хеш блока совпадает', 'SHA-256 пересчитан в браузере'],
    [linkOk, 'Блок встроен в цепочку', prev ? `Ссылается на блок № ${prev.index + 1}` : 'Первый блок реестра'],
    [ledgerOk, 'Подпись реестра действительна', 'ECDSA P-256, открытый ключ реестра'],
    [blindOk, 'Подпись комиссии действительна', 'Бюллетень выдан законному участнику (слепая подпись RSA)'],
    [localOk, 'Совпадает с отправленным', mine ? 'Сравнение с квитанцией на вашем устройстве' : 'Нет квитанции с этого устройства — загрузите файл'],
    [receiptSigOk, 'Квитанция подписана реестром', mine ? 'Реестр не сможет отказаться от этой записи' : 'Нужен файл квитанции'],
    [decrypted ? true : election.electionPrivateKey ? false : null, 'Учтён при подсчёте', decryptNote],
  ];

  const choiceRows = decrypted
    ? election.questions
        .map((q) => {
          const c = q.candidates.find((x) => x.id === decrypted[q.id]);
          return `<dt>${escapeHtml(q.title)}</dt><dd><span class="chip"><span class="avatar">${escapeHtml(initials(c?.name ?? '?'))}</span>${escapeHtml(c?.name ?? '—')}</span></dd>`;
        })
        .join('')
    : '';

  result.innerHTML = `
    <div class="card card--pad swap-in">
      ${note(
        allOk ? 'success' : 'danger',
        allOk ? 'Голос записан в реестр и не изменён' : 'Обнаружено несоответствие',
        allOk ? `«${escapeHtml(election.title)}» · все криптографические проверки пройдены.` : 'Одна или несколько проверок не пройдены. Сохраните квитанцию и сообщите организаторам.',
      )}
      <div class="grid grid--2 top-gap">
        <div>
          <h3>Проверки</h3>
          <ul class="checks top-gap-sm">${checks.map(([ok, t, d], i) => check(ok, t, d, i)).join('')}</ul>
        </div>
        <div>
          <h3>Данные блока</h3>
          <dl class="kv top-gap-sm">
            <dt>Голосование</dt><dd>${statusBadge(election.status)}</dd>
            <dt>Время записи</dt><dd>${formatDate(block.timestamp)}</dd>
            <dt>Хеш блока</dt><dd class="mono">${block.hash}</dd>
            <dt>Предыдущий</dt><dd class="mono">${shortHash(block.prevHash)}</dd>
            <dt>Следующий</dt><dd class="mono">${nextHash ? shortHash(nextHash) : 'последний блок'}</dd>
            <dt>Шифртекст</dt><dd class="mono">${block.ballot.slice(0, 64)}…</dd>
          </dl>
          ${decrypted ? `<div class="receipt top-gap-sm"><span class="label">Расшифрованный бюллетень</span><dl class="kv">${choiceRows}</dl></div>` : ''}
          <div class="actions"><a class="btn btn--glass" href="/ledger?election=${election.id}&highlight=${block.hash}">Показать в реестре ${icons.arrow}</a></div>
        </div>
      </div>
    </div>`;
  result.querySelectorAll('.ci').forEach((n) => n.style.setProperty('--d', n.dataset.d + 'ms'));
}

const run = (hash, receipt) =>
  withLoading(button, () => verify(hash, receipt)).catch((err) => {
    result.innerHTML = note('danger', 'Ошибка проверки', escapeHtml(err.message));
  });

form.addEventListener('submit', (e) => {
  e.preventDefault();
  run(input.value);
});

document.getElementById('receipt-file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const receipt = JSON.parse(await file.text());
    if (typeof receipt.receipt !== 'string') throw new Error();
    run(receipt.receipt, receipt);
  } catch {
    shake(form);
    result.innerHTML = note('danger', 'Это не файл квитанции', 'Загрузите JSON-файл, скачанный после голосования.');
  }
});

const saved = savedReceipts();
if (saved.length) {
  const box = document.getElementById('saved');
  box.outerHTML = saved
    .map((r) => `<button class="btn btn--ghost btn--sm" data-hash="${r.receipt}">${icons.receipt} ${escapeHtml(r.electionTitle ?? 'Моя квитанция')}</button>`)
    .join('');
  document.querySelectorAll('[data-hash]').forEach((b) =>
    b.addEventListener('click', () => {
      const r = saved.find((x) => x.receipt === b.dataset.hash);
      run(r.receipt, r);
    }),
  );
}

const fromUrl = new URLSearchParams(location.search).get('receipt');
if (fromUrl) run(fromUrl);
