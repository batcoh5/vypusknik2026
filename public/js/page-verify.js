import { api, renderChrome, escapeHtml, formatDate, store, shortHash, RECEIPT_KEY, statusBadge } from './common.js';
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

const form = document.getElementById('verify-form');
const input = document.getElementById('receipt-input');
const result = document.getElementById('result');
const savedBtn = document.getElementById('use-saved');

const infoPromise = api('/api/election');
let localReceipt = null;

function check(ok, title, detail) {
  const cls = ok === null ? 'na' : ok ? 'ok' : 'fail';
  const icon = ok === null ? '–' : ok ? '✓' : '✕';
  return `<li class="${cls}"><span class="ci">${icon}</span><div><div>${title}</div><div class="small muted">${detail}</div></div></li>`;
}

async function verify(hash, receipt = null) {
  hash = hash.trim().toLowerCase();
  input.value = hash;
  if (!/^[0-9a-f]{64}$/.test(hash)) {
    result.innerHTML = `<div class="card"><div class="alert alert--danger"><div>Номер квитанции должен состоять из 64 символов 0–9 и a–f.</div></div></div>`;
    return;
  }
  history.replaceState(null, '', `?receipt=${hash}`);
  result.innerHTML = `<div class="card"><div class="spinner"></div></div>`;

  const info = await infoPromise;
  const keys = await loadPublicKeys(info.publicKeys);
  let data;
  try {
    data = await api(`/api/ledger/${hash}`);
  } catch (err) {
    result.innerHTML = `<div class="card"><div class="alert alert--danger"><div><h3>Бюллетень не найден</h3><p class="small">${escapeHtml(err.message)}. Проверьте правильность номера квитанции.</p></div></div></div>`;
    return;
  }
  const { block, prev, nextHash, total } = data;
  const mine = receipt ?? (localReceipt?.receipt === hash ? localReceipt : null);

  const hashOk = (await computeBlockHash(block)) === block.hash;
  const linkOk = prev ? prev.hash === block.prevHash : block.prevHash === GENESIS_HASH && block.index === 0;
  const ledgerOk = await verifyLedgerSignature(block.hash, block.ledgerSignature, keys.ledgerKey);
  const blindOk = await verifyTokenSignature(block.token, block.signature, keys.rsaPub);
  const localOk = mine ? mine.ballot === block.ballot && mine.token === block.token : null;
  const receiptSigOk = mine?.ledgerSignature ? await verifyLedgerSignature(hash, mine.ledgerSignature, keys.ledgerKey) : null;

  let decrypted = null;
  let decryptNote = 'Расшифровка станет доступна после окончания голосования, когда комиссия опубликует ключ.';
  if (info.electionPrivateKey) {
    try {
      const priv = await importElectionPrivateKey(info.electionPrivateKey);
      decrypted = validateChoices(info.election, await decryptBallot(block.ballot, priv));
      decryptNote = decrypted ? 'Бюллетень расшифрован опубликованным ключом комиссии и учтён в итогах.' : 'Бюллетень расшифрован, но признан недействительным.';
    } catch {
      decryptNote = 'Не удалось расшифровать бюллетень — он признан недействительным.';
    }
  }

  const allOk = hashOk && linkOk && ledgerOk && blindOk && localOk !== false && receiptSigOk !== false;

  const choiceRows = decrypted
    ? info.election.questions
        .map((q) => {
          const c = q.candidates.find((x) => x.id === decrypted[q.id]);
          return `<dt>${escapeHtml(q.title)}</dt><dd><b>${escapeHtml(c?.name ?? '—')}</b></dd>`;
        })
        .join('')
    : '';

  result.innerHTML = `
    <div class="card">
      <div class="alert alert--${allOk ? 'success' : 'danger'}">
        <div>
          <h3>${allOk ? 'Ваш голос записан в реестр и не изменён' : 'Обнаружено несоответствие'}</h3>
          <p class="small">${allOk ? 'Все криптографические проверки пройдены.' : 'Одна или несколько проверок не пройдены. Сохраните квитанцию и сообщите организаторам.'}</p>
        </div>
      </div>
      <div class="grid grid--2">
        <div>
          <h3>Проверки</h3>
          <ul class="checks">
            ${check(true, 'Бюллетень найден в реестре', `Блок № ${block.index + 1} из ${total}`)}
            ${check(hashOk, 'Хеш блока совпадает', 'SHA-256 от содержимого блока пересчитан в браузере')}
            ${check(linkOk, 'Блок встроен в цепочку', prev ? `Ссылается на блок № ${prev.index + 1}` : 'Первый блок реестра')}
            ${check(ledgerOk, 'Подпись реестра действительна', 'ECDSA P-256, открытый ключ реестра')}
            ${check(blindOk, 'Слепая подпись комиссии действительна', 'Бюллетень выдан законному участнику (RSA-FDH)')}
            ${check(localOk, 'Бюллетень совпадает с отправленным', mine ? 'Сравнение с квитанцией на вашем устройстве' : 'Нет квитанции с этого устройства — сравнение невозможно')}
            ${check(receiptSigOk, 'Квитанция подписана реестром', mine ? 'Реестр не сможет отказаться от этой записи' : 'Загрузите файл квитанции для этой проверки')}
            ${check(decrypted ? true : info.electionPrivateKey ? false : null, 'Учтён при подсчёте', decryptNote)}
          </ul>
        </div>
        <div>
          <h3>Данные блока</h3>
          <dl class="kv small">
            <dt>Статус</dt><dd>${statusBadge(info.status)}</dd>
            <dt>Время записи</dt><dd>${formatDate(block.timestamp)}</dd>
            <dt>Хеш блока</dt><dd class="mono">${block.hash}</dd>
            <dt>Предыдущий</dt><dd class="mono">${block.prevHash}</dd>
            <dt>Следующий</dt><dd class="mono">${nextHash ? shortHash(nextHash) : 'последний блок'}</dd>
            <dt>Токен</dt><dd class="mono">${block.token}</dd>
            <dt>Шифртекст</dt><dd class="mono">${block.ballot.slice(0, 96)}…</dd>
          </dl>
          ${decrypted ? `<div class="receipt stack"><b>Расшифрованный бюллетень</b><dl class="kv">${choiceRows}</dl></div>` : ''}
          <div class="actions"><a class="btn btn--secondary" href="/ledger?highlight=${block.hash}#b${block.index}">Показать в реестре</a></div>
        </div>
      </div>
    </div>`;
}

form.addEventListener('submit', (e) => {
  e.preventDefault();
  verify(input.value).catch(showError);
});

document.getElementById('receipt-file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const receipt = JSON.parse(await file.text());
    if (typeof receipt.receipt !== 'string') throw new Error();
    await verify(receipt.receipt, receipt);
  } catch {
    showError(new Error('Файл не похож на квитанцию голосования'));
  }
});

function showError(err) {
  result.innerHTML = `<div class="card"><div class="alert alert--danger"><div>${escapeHtml(err.message)}</div></div></div>`;
}

localReceipt = store.get(RECEIPT_KEY);
if (localReceipt?.receipt) {
  savedBtn.classList.remove('hidden');
  savedBtn.addEventListener('click', () => verify(localReceipt.receipt, localReceipt).catch(showError));
}

const fromUrl = new URLSearchParams(location.search).get('receipt');
if (fromUrl) verify(fromUrl).catch(showError);
