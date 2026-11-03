import {
  renderChrome,
  escapeHtml,
  formatDate,
  formatNumber,
  statusBadge,
  plural,
  icons,
  note,
  toast,
  shake,
  withLoading,
  confirmDialog,
  api as baseApi,
  el,
} from './common.js';

renderChrome();

const root = document.getElementById('admin-root');
let token = '';
try {
  token = sessionStorage.getItem('vyp26:admin') ?? '';
} catch {
  /* ignore */
}

let devTools = false;

const api = (path, opts = {}) => baseApi(path, { ...opts, headers: { Authorization: `Bearer ${token}` } });

function render(html) {
  root.innerHTML = `<div class="swap-in">${html}</div>`;
}

// ---------- вход ----------

function showLogin(error = '') {
  render(`
    <div class="card card--pad">
      <div class="icon-box">${icons.lock}</div>
      <h3>Вход для оргкомитета</h3>
      <p class="small muted top-gap-xs">Здесь оргкомитет создаёт голосования, запускает их и смотрит итоги. Введите пароль администратора.</p>
      <form class="row top-gap-sm" id="login">
        <input class="input" type="password" id="token" placeholder="Пароль" autocomplete="current-password" aria-label="Пароль администратора">
        <button class="btn btn--brand" type="submit">Войти ${icons.arrow}</button>
      </form>
      ${error ? note('danger', 'Не удалось войти', escapeHtml(error)) : ''}
    </div>`);
  const form = document.getElementById('login');
  if (error) shake(form);
  document.getElementById('token').focus();
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    token = document.getElementById('token').value.trim();
    await withLoading(form.querySelector('button'), () => showList());
  });
}

// ---------- список голосований ----------

// Итоги: голоса и баллы (голоса / всего × 160, с округлением) — как в выгрузке Excel.
function resultsTable(e) {
  const q = e.questions[0];
  const counts = e.tally.counts[q.id];
  const total = q.candidates.reduce((n, c) => n + (counts[c.id] ?? 0), 0);
  // Участники в том же порядке и с теми же номерами, что в голосовании (как в протоколе), без сортировки.
  const rows = q.candidates
    .map((c, i) => {
      const num = i + 1;
      const v = counts[c.id] ?? 0;
      const points = total ? Math.round((v / total) * 160) : 0;
      return `<tr><td>${num}</td><td>${escapeHtml(c.name)}</td><td class="num">${formatNumber(v)}</td><td class="num">${points}</td></tr>`;
    })
    .join('');
  return `
    <div class="table-wrap top-gap-sm">
      <table class="table results-table">
        <thead><tr><th>№</th><th>Участник</th><th class="num">Голоса</th><th class="num">Баллы из 160</th></tr></thead>
        <tbody>${rows}</tbody>
        <tfoot><tr><td></td><td>Всего</td><td class="num">${formatNumber(total)}</td><td class="num">${total ? 160 : 0}</td></tr></tfoot>
      </table>
    </div>`;
}

function electionCard(e) {
  const cands = e.questions[0]?.candidates.length ?? 0;
  const meta = [
    `${cands} ${plural(cands, 'участник', 'участника', 'участников')}`,
    `Создано ${formatDate(e.createdAt)}`,
    e.startedAt && `Запущено ${formatDate(e.startedAt)}`,
    e.endsAt && e.status !== 'finished' && `Окончание ${formatDate(e.endsAt)}`,
    e.finishedAt && `Завершено ${formatDate(e.finishedAt)}`,
    e.status !== 'draft' && `Проголосовало: <b>${formatNumber(e.stats.ballotsCast)}</b>${e.stats.simulated ? ` <span class="badge badge--draft">из них тестовых: ${formatNumber(e.stats.simulated)}</span>` : ''}`,
  ].filter(Boolean);

  const actions = {
    draft: `
      <button class="btn btn--brand btn--sm" data-act="start">${icons.play} Запустить</button>
      <button class="btn btn--glass btn--sm" data-act="edit">${icons.edit} Редактировать</button>
      <button class="btn btn--danger btn--sm" data-act="delete">${icons.trash} Удалить</button>`,
    active: `
      <button class="btn btn--primary btn--sm" data-act="finish">${icons.stop} Завершить и подвести итоги</button>
      ${devTools ? `<button class="btn btn--glass btn--sm" data-act="simulate">${icons.chart} Симуляция голосов</button>` : ''}
      <a class="btn btn--glass btn--sm" href="/" target="_blank">Открыть сайт ${icons.external}</a>`,
    finished: `
      <button class="btn btn--brand btn--sm" data-act="excel">${icons.download} Скачать итоги в Excel</button>
      <button class="btn btn--danger btn--sm" data-act="delete">${icons.trash} Удалить</button>`,
  }[e.status];

  return `
    <div class="card card--hover spot" data-id="${e.id}">
      <div class="election-card__head">
        <div>
          <h3>Голосование от ${escapeHtml(formatDate(e.createdAt))}</h3>
          ${e.description ? `<p class="small muted top-gap-xs">${escapeHtml(e.description)}</p>` : ''}
        </div>
        ${statusBadge(e.status)}
      </div>
      <div class="election-card__meta">${meta.map((m) => `<span>${m}</span>`).join('')}</div>
      ${e.tally ? resultsTable(e) : ''}
      <div class="actions">${actions}</div>
    </div>`;
}

// ВРЕМЕННО: окно симуляции голосов — случайно или заданное число каждому участнику.
function simulateDialog(e) {
  const cands = e.questions[0].candidates;
  return new Promise((resolve) => {
    const modal = el(`
      <div class="modal" role="dialog" aria-modal="true">
        <form class="modal__box modal__box--wide" novalidate>
          <h3>Симуляция голосов</h3>
          <p>Тестовые голоса добавятся в это голосование и попадут в итоги и Excel.</p>
          <div class="seg top-gap-sm">
            <label><input type="radio" name="mode" value="random" checked><span>Случайно</span></label>
            <label><input type="radio" name="mode" value="manual"><span>Вручную</span></label>
          </div>
          <div class="sim-random top-gap-sm">
            <label class="label" for="sim-count">Сколько голосов добавить</label>
            <input class="input" id="sim-count" type="number" min="1" max="5000" value="100">
          </div>
          <div class="sim-manual top-gap-sm hidden">
            ${cands
              .map(
                (c) => `<label class="sim-row"><span>${escapeHtml(c.name)}</span><input class="input" type="number" min="0" max="5000" value="0" data-c="${escapeHtml(c.id)}"></label>`,
              )
              .join('')}
          </div>
          <div class="actions">
            <button class="btn btn--brand" type="submit">Добавить голоса</button>
            <button class="btn btn--ghost" type="button" data-cancel>Отмена</button>
          </div>
        </form>
      </div>`);
    const form = modal.querySelector('form');
    const close = (value) => {
      modal.classList.add('closing');
      setTimeout(() => modal.remove(), 200);
      resolve(value);
    };
    form.addEventListener('change', () => {
      const manual = form.mode.value === 'manual';
      form.querySelector('.sim-random').classList.toggle('hidden', manual);
      form.querySelector('.sim-manual').classList.toggle('hidden', !manual);
    });
    modal.addEventListener('click', (ev) => {
      if (ev.target === modal || ev.target.closest('[data-cancel]')) close(null);
    });
    form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      if (form.mode.value === 'manual') {
        const counts = Object.fromEntries([...form.querySelectorAll('[data-c]')].map((i) => [i.dataset.c, Number(i.value) || 0]));
        close({ mode: 'manual', counts });
      } else {
        close({ mode: 'random', count: Number(form.querySelector('#sim-count').value) || 0 });
      }
    });
    document.body.append(modal);
    form.querySelector('#sim-count').focus();
  });
}

// Скачивание .xlsx с итогами (запрос с ключом администратора).
async function downloadExcel(e) {
  const res = await fetch(`/api/admin/elections/${e.id}/results.xlsx`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error((await res.json().catch(() => null))?.message ?? 'Не удалось скачать файл');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(await res.blob());
  a.download = 'Итоги зрительского голосования.xlsx';
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// Что сейчас видят посетители сайта.
function siteState(elections, active) {
  if (active) return 'Сейчас идёт голосование.';
  const finished = elections.filter((e) => e.status === 'finished').sort((a, b) => b.finishedAt.localeCompare(a.finishedAt))[0];
  if (finished) return `На сайте написано, что голосование завершено. Удалите его, чтобы посетители видели «Голосование скоро начнётся».`;
  return 'Сейчас голосования нет — посетители видят «Голосование скоро начнётся».';
}

async function showList() {
  let data;
  try {
    data = await api('/api/admin/elections');
  } catch (err) {
    if (err.status === 401 || err.status === 429) {
      try {
        sessionStorage.removeItem('vyp26:admin');
      } catch {
        /* ignore */
      }
      return showLogin(token ? err.message : '');
    }
    throw err;
  }
  try {
    sessionStorage.setItem('vyp26:admin', token);
  } catch {
    /* ignore */
  }
  const { elections } = data;
  devTools = Boolean(data.devTools);
  const warnings = [
    data.storageWarning &&
      note(
        'danger',
        'Данные пропадут при следующем обновлении сайта',
        'На Railway не подключено постоянное хранилище. Откройте сервис → Settings → Volumes → New Volume (путь /data) и удалите переменную DATA_DIR, если она указывает в другое место. До этого голосования и голоса стираются при каждом деплое.',
      ),
    data.devTools &&
      note('warning', 'Включена симуляция голосов', 'Это временная функция для проверки (DEV_TOOLS=1). Тестовые голоса попадают в итоги — перед настоящим голосованием удалите тестовое голосование и уберите переменную DEV_TOOLS.'),
    !data.vkConfigured &&
      (data.devLogin
        ? note('warning', 'Тестовый режим входа', 'Вход через ВКонтакте не настроен, включён тестовый вход. Уберите DEV_LOGIN перед настоящим голосованием.')
        : note('warning', 'Вход через ВКонтакте не настроен', 'Голосовать пока нельзя: не задан ID приложения VK ID (VK_CLIENT_ID).')),
  ]
    .filter(Boolean)
    .join('');
  const active = elections.find((e) => e.status === 'active');

  render(`
    <div class="election-card__head">
      <div>
        <h2>Голосования</h2>
        <p class="small muted top-gap-xs">${siteState(elections, active)}</p>
      </div>
      <div class="row">
        <button class="btn btn--brand" id="create">${icons.plus} Новое голосование</button>
        <button class="btn btn--ghost" id="logout">Выйти</button>
      </div>
    </div>
    ${warnings}
    <div class="admin-list top-gap">
      ${
        elections.length
          ? elections.map(electionCard).join('')
          : `<div class="card empty"><div class="empty__icon">${icons.hat}</div><h3>Голосований пока нет</h3><p>Создайте первое голосование: добавьте участников с фото, затем запустите его.</p></div>`
      }
    </div>
    ${note('info', 'Как это работает', 'Создайте голосование и добавьте участников → запустите. Одновременно может идти только одно голосование. Итоги видны только здесь, после завершения; их можно скачать в Excel. Удалённое голосование исчезает с сайта вместе со всеми голосами — после этого можно создать новое. Зрители голосуют через ВКонтакте: один аккаунт — один голос.')}
  `);

  document.getElementById('create').addEventListener('click', () => showEditor());
  document.getElementById('logout').addEventListener('click', () => {
    token = '';
    try {
      sessionStorage.removeItem('vyp26:admin');
    } catch {
      /* ignore */
    }
    showLogin();
  });

  root.querySelectorAll('[data-act]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      const id = btn.closest('[data-id]').dataset.id;
      const e = elections.find((x) => x.id === id);
      const act = btn.dataset.act;
      if (act === 'edit') return showEditor(e);
      if (act === 'simulate') {
        const body = await simulateDialog(e);
        if (!body) return;
        try {
          const res = await withLoading(btn, () => api(`/api/admin/elections/${id}/simulate`, { method: 'POST', body }));
          toast(`Добавлено тестовых голосов: ${formatNumber(res.added)}`);
          showList();
        } catch (err) {
          toast(err.message);
        }
        return;
      }
      if (act === 'excel') {
        try {
          await withLoading(btn, () => downloadExcel(e));
        } catch (err) {
          toast(err.message);
        }
        return;
      }
      const dialogs = {
        start: {
          title: 'Запустить голосование?',
          text: `Участники появятся на сайте, и начнётся приём голосов. После запуска список участников изменить нельзя.`,
          ok: 'Запустить',
        },
        finish: {
          title: 'Завершить голосование?',
          text: 'Приём голосов прекратится, голоса будут подсчитаны. Итоги появятся здесь, в админке. Отменить нельзя.',
          ok: 'Завершить и подвести итоги',
          danger: true,
        },
        delete: {
          title: 'Удалить голосование?',
          text: `Голосование будет удалено вместе со всеми голосами, итогами и фото участников. Отменить нельзя.`,
          ok: 'Удалить навсегда',
          danger: true,
        },
      };
      if (!(await confirmDialog(dialogs[act]))) return;
      try {
        await withLoading(btn, async () => {
          if (act === 'delete') await api(`/api/admin/elections/${id}`, { method: 'DELETE' });
          else await api(`/api/admin/elections/${id}/${act}`, { method: 'POST' });
        });
        toast({ start: 'Голосование запущено', finish: 'Итоги подведены', delete: 'Голосование удалено' }[act]);
        showList();
      } catch (err) {
        toast(err.message);
      }
    }),
  );
}

// ---------- конструктор голосования ----------

function toLocalInput(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function photoHtml(c) {
  return c.photo ? `<img src="${escapeHtml(c.photo)}" alt="">` : `<span>${icons.upload}<br>Фото</span>`;
}

function candidateRow(c = {}, i = 0) {
  return `
    <div class="builder-p" data-photo="${escapeHtml(c.photo ?? '')}">
      <label class="builder-p__photo" title="Загрузить фото">
        ${photoHtml(c)}
        <input type="file" accept="image/*" class="sr-only" data-f="file">
      </label>
      <div class="builder-p__fields">
        <span class="builder-c__num">Участник ${i + 1}</span>
        <input class="input" data-f="name" placeholder="Имя и фамилия" value="${escapeHtml(c.name ?? '')}" maxlength="120">
        <input class="input" data-f="description" placeholder="Подпись, например «Школа № 1, 11 «А»» — необязательно" value="${escapeHtml(c.description ?? '')}" maxlength="300">
      </div>
      <button type="button" class="icon-btn" data-rm="c" aria-label="Удалить участника">${icons.trash}</button>
    </div>`;
}

function renumber(form) {
  form.querySelectorAll('.builder-p .builder-c__num').forEach((n, ci) => (n.textContent = `Участник ${ci + 1}`));
}

function collect(form) {
  return {
    description: form.querySelector('#e-desc').value,
    endsAt: form.querySelector('#e-ends').value ? new Date(form.querySelector('#e-ends').value).toISOString() : null,
    candidates: [...form.querySelectorAll('.builder-p')]
      .map((c) => ({
        name: c.querySelector('[data-f="name"]').value,
        description: c.querySelector('[data-f="description"]').value,
        photo: c.dataset.photo || null,
      }))
      .filter((c) => c.name.trim() || c.description.trim() || c.photo),
  };
}

// Фото уменьшается в браузере до 800 px по большей стороне и сохраняется в JPEG.
async function resizePhoto(file) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 800 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', 0.86);
}

function showEditor(e = null) {
  const candidates = e?.questions?.[0]?.candidates?.length ? e.questions[0].candidates : [{}, {}];
  render(`
    <form class="card card--pad" id="editor" novalidate>
      <div class="election-card__head">
        <h2>${e ? 'Редактирование' : 'Новое голосование'}</h2>
        <button type="button" class="btn btn--ghost" id="cancel">Отмена</button>
      </div>
      <div class="field top-gap">
        <label class="label" for="e-desc">Описание — необязательно</label>
        <textarea class="textarea" id="e-desc" placeholder="Пара слов для зрителей, например: «Выберите участника, который понравился вам больше всех»" maxlength="1000">${escapeHtml(e?.description ?? '')}</textarea>
      </div>
      <div class="field">
        <label class="label" for="e-ends">Автоматическое завершение — необязательно</label>
        <input class="input" type="datetime-local" id="e-ends" value="${toLocalInput(e?.endsAt)}">
        <p class="small subtle top-gap-xs">Если не указать, голосование идёт, пока вы не завершите его вручную.</p>
      </div>

      <h3 class="top-gap">Участники</h3>
      <p class="small subtle top-gap-xs">Нажмите на квадрат, чтобы загрузить фото. Лучше вертикальное, как на обложке.</p>
      <div class="top-gap-sm" id="cands">${candidates.map(candidateRow).join('')}</div>
      <button type="button" class="btn btn--glass top-gap-sm" id="add-c">${icons.plus} Добавить участника</button>
      <div id="editor-error"></div>
      <div class="actions">
        <button type="submit" class="btn btn--brand btn--lg">${e ? 'Сохранить изменения' : 'Создать голосование'} ${icons.arrow}</button>
      </div>
    </form>`);

  const form = document.getElementById('editor');
  const list = form.querySelector('#cands');
  form.querySelector('[data-f="name"]').focus();
  form.querySelector('#cancel').addEventListener('click', () => showList());
  form.querySelector('#add-c').addEventListener('click', () => {
    list.insertAdjacentHTML('beforeend', candidateRow({}, list.children.length));
    list.lastElementChild.querySelector('[data-f="name"]').focus();
  });
  form.addEventListener('click', (ev) => {
    const rm = ev.target.closest('[data-rm]');
    if (!rm) return;
    const node = rm.closest('.builder-p');
    node.style.transition = 'opacity .2s, transform .2s';
    node.style.opacity = '0';
    node.style.transform = 'translateX(12px)';
    setTimeout(() => {
      node.remove();
      renumber(form);
    }, 200);
  });
  form.addEventListener('change', async (ev) => {
    if (ev.target.dataset.f !== 'file' || !ev.target.files[0]) return;
    const row = ev.target.closest('.builder-p');
    const box = row.querySelector('.builder-p__photo');
    box.classList.add('is-loading');
    try {
      const data = await resizePhoto(ev.target.files[0]);
      const { url } = await api('/api/admin/photos', { method: 'POST', body: { data } });
      row.dataset.photo = url;
      box.querySelector('img, span')?.remove();
      box.insertAdjacentHTML('afterbegin', `<img src="${escapeHtml(url)}" alt="">`);
    } catch (err) {
      toast(err.message || 'Не удалось загрузить фото');
    } finally {
      box.classList.remove('is-loading');
      ev.target.value = '';
    }
  });
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const btn = form.querySelector('[type="submit"]');
    const errBox = form.querySelector('#editor-error');
    errBox.innerHTML = '';
    try {
      await withLoading(btn, () =>
        e ? api(`/api/admin/elections/${e.id}`, { method: 'PUT', body: collect(form) }) : api('/api/admin/elections', { method: 'POST', body: collect(form) }),
      );
      toast(e ? 'Изменения сохранены' : 'Голосование создано. Запустите его, когда будете готовы');
      showList();
    } catch (err) {
      errBox.innerHTML = note('danger', 'Проверьте форму', escapeHtml(err.message));
      shake(btn);
    }
  });
}

if (token) {
  root.innerHTML = `<div class="stack"><div class="card"><div class="sk sk--title"></div></div><div class="card"><div class="sk sk--block"></div></div></div>`;
  showList().catch((err) => render(note('danger', 'Ошибка', escapeHtml(err.message))));
} else {
  showLogin();
}
