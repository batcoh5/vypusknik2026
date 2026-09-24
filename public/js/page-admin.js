import {
  renderChrome,
  setFooterStatus,
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
} from './common.js';

renderChrome();

const root = document.getElementById('admin-root');
let token = '';
try {
  token = sessionStorage.getItem('vyp26:admin') ?? '';
} catch {
  /* ignore */
}

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
      <p class="small muted top-gap-xs">Ключ администратора задаётся переменной окружения ADMIN_TOKEN при запуске сервера.</p>
      <form class="row top-gap-sm" id="login">
        <input class="input" type="password" id="token" placeholder="Ключ администратора" autocomplete="current-password" aria-label="Ключ администратора">
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

function electionCard(e) {
  const noms = e.questions.length;
  const cands = e.questions.reduce((n, q) => n + q.candidates.length, 0);
  const meta = [
    `${noms} ${plural(noms, 'номинация', 'номинации', 'номинаций')} · ${cands} ${plural(cands, 'вариант', 'варианта', 'вариантов')}`,
    `Создано ${formatDate(e.createdAt)}`,
    e.startedAt && `Запущено ${formatDate(e.startedAt)}`,
    e.endsAt && e.status !== 'finished' && `Окончание ${formatDate(e.endsAt)}`,
    e.finishedAt && `Завершено ${formatDate(e.finishedAt)}`,
    e.status !== 'draft' && `Голосов: <b>${formatNumber(e.stats.ballotsCast)}</b> · выдано бюллетеней: ${formatNumber(e.stats.ballotsIssued)}`,
  ].filter(Boolean);

  const actions = {
    draft: `
      <button class="btn btn--brand btn--sm" data-act="start">${icons.play} Запустить</button>
      <button class="btn btn--glass btn--sm" data-act="edit">${icons.edit} Редактировать</button>
      <button class="btn btn--danger btn--sm" data-act="delete">${icons.trash} Удалить</button>`,
    active: `
      <button class="btn btn--primary btn--sm" data-act="finish">${icons.stop} Завершить и подвести итоги</button>
      <a class="btn btn--glass btn--sm" href="/vote" target="_blank">Открыть на сайте ${icons.external}</a>`,
    finished: `
      <a class="btn btn--glass btn--sm" href="/results" target="_blank">${icons.chart} Итоги</a>
      <button class="btn btn--danger btn--sm" data-act="delete">${icons.trash} Удалить</button>`,
  }[e.status];

  const winners =
    e.tally &&
    e.questions
      .map((q) => {
        const counts = e.tally.counts[q.id];
        const best = [...q.candidates].sort((a, b) => counts[b.id] - counts[a.id])[0];
        return `<li><span class="muted">${escapeHtml(q.title)}:</span> ${escapeHtml(best.name)} — ${formatNumber(counts[best.id])}</li>`;
      })
      .join('');

  return `
    <div class="card card--hover spot" data-id="${e.id}">
      <div class="election-card__head">
        <div>
          <h3>${escapeHtml(e.title)}</h3>
          ${e.description ? `<p class="small muted top-gap-xs">${escapeHtml(e.description)}</p>` : ''}
        </div>
        ${statusBadge(e.status)}
      </div>
      <div class="election-card__meta">${meta.map((m) => `<span>${m}</span>`).join('')}</div>
      ${winners ? `<ul class="small top-gap-sm winners">${winners}</ul>` : ''}
      <div class="actions">${actions}</div>
    </div>`;
}

// Что сейчас видят посетители сайта.
function siteState(elections, active) {
  if (active) return `Сейчас идёт: «${escapeHtml(active.title)}»`;
  const finished = elections.filter((e) => e.status === 'finished').sort((a, b) => b.finishedAt.localeCompare(a.finishedAt))[0];
  if (finished) return `На сайте показаны итоги «${escapeHtml(finished.title)}». Удалите его, чтобы посетители видели «Голосование ещё не началось».`;
  return 'Сейчас на сайте нет голосования — посетители видят «Голосование ещё не началось».';
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
  const active = elections.find((e) => e.status === 'active');
  setFooterStatus(active ? 'active' : elections.some((e) => e.status === 'finished') ? 'finished' : 'none');

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
    <div class="admin-list top-gap">
      ${
        elections.length
          ? elections.map(electionCard).join('')
          : `<div class="card empty"><div class="empty__icon">${icons.hat}</div><h3>Голосований пока нет</h3><p>Создайте первое голосование: добавьте номинации и участников, затем запустите его.</p></div>`
      }
    </div>
    ${note('info', 'Как это работает', 'Создайте голосование → проверьте номинации → запустите. Одновременно может идти только одно голосование. После завершения публикуются итоги и ключ расшифровки. Удалённое голосование исчезает с сайта вместе с реестром — после этого можно создать новое. В каждом голосовании человек голосует только один раз.')}
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
      const dialogs = {
        start: {
          title: 'Запустить голосование?',
          text: `«${e.title}» появится на сайте, и начнётся приём голосов. После запуска номинации изменить нельзя.`,
          ok: 'Запустить',
        },
        finish: {
          title: 'Завершить голосование?',
          text: 'Приём голосов прекратится, бюллетени будут расшифрованы и подсчитаны, итоги и ключ расшифровки — опубликованы. Отменить нельзя.',
          ok: 'Завершить и подвести итоги',
          danger: true,
        },
        delete: {
          title: 'Удалить голосование?',
          text: `«${e.title}» будет удалено вместе с реестром голосов и итогами. Квитанции перестанут проверяться. Отменить нельзя.`,
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

function candidateRow(c = {}, i = 0) {
  return `
    <div class="builder-c">
      <span class="builder-c__num">${i + 1}</span>
      <input class="input" data-f="name" placeholder="Имя участника или вариант" value="${escapeHtml(c.name ?? '')}" maxlength="120">
      <input class="input" data-f="description" placeholder="Подпись (школа, класс) — необязательно" value="${escapeHtml(c.description ?? '')}" maxlength="300">
      <button type="button" class="icon-btn" data-rm="c" aria-label="Удалить вариант">${icons.trash}</button>
    </div>`;
}

function questionBlock(q = {}, qi = 0) {
  const cands = q.candidates?.length ? q.candidates : [{}, {}];
  return `
    <div class="builder-q">
      <div class="builder-q__head">
        <span class="eyebrow" data-qnum>Номинация ${qi + 1}</span>
        <button type="button" class="icon-btn" data-rm="q" aria-label="Удалить номинацию">${icons.trash}</button>
      </div>
      <div class="field"><input class="input" data-f="qtitle" placeholder="Название номинации, например «Выпускник года»" value="${escapeHtml(q.title ?? '')}" maxlength="120"></div>
      <div class="field"><input class="input" data-f="qdesc" placeholder="Пояснение для голосующих — необязательно" value="${escapeHtml(q.description ?? '')}" maxlength="500"></div>
      <span class="label top-gap-sm">Варианты</span>
      <div data-cands>${cands.map(candidateRow).join('')}</div>
      <button type="button" class="btn btn--ghost btn--sm top-gap-xs" data-add="c">${icons.plus} Добавить вариант</button>
    </div>`;
}

function renumber(form) {
  form.querySelectorAll('.builder-q').forEach((q, qi) => {
    q.querySelector('[data-qnum]').textContent = `Номинация ${qi + 1}`;
    q.querySelectorAll('.builder-c__num').forEach((n, ci) => (n.textContent = ci + 1));
  });
}

function collect(form) {
  return {
    title: form.querySelector('#e-title').value,
    description: form.querySelector('#e-desc').value,
    endsAt: form.querySelector('#e-ends').value ? new Date(form.querySelector('#e-ends').value).toISOString() : null,
    questions: [...form.querySelectorAll('.builder-q')].map((q) => ({
      title: q.querySelector('[data-f="qtitle"]').value,
      description: q.querySelector('[data-f="qdesc"]').value,
      candidates: [...q.querySelectorAll('.builder-c')]
        .map((c) => ({
          name: c.querySelector('[data-f="name"]').value,
          description: c.querySelector('[data-f="description"]').value,
        }))
        .filter((c) => c.name.trim() || c.description.trim()),
    })),
  };
}

function showEditor(e = null) {
  const questions = e?.questions?.length ? e.questions : [{}];
  render(`
    <form class="card card--pad" id="editor" novalidate>
      <div class="election-card__head">
        <h2>${e ? 'Редактирование' : 'Новое голосование'}</h2>
        <button type="button" class="btn btn--ghost" id="cancel">Отмена</button>
      </div>
      <div class="field top-gap">
        <label class="label" for="e-title">Название</label>
        <input class="input" id="e-title" placeholder="Например: Народное голосование «Выпускник Краснообска 2026»" value="${escapeHtml(e?.title ?? '')}" maxlength="120">
      </div>
      <div class="field">
        <label class="label" for="e-desc">Описание — необязательно</label>
        <textarea class="textarea" id="e-desc" placeholder="Коротко о голосовании: кто участвует, как выбрать победителя" maxlength="1000">${escapeHtml(e?.description ?? '')}</textarea>
      </div>
      <div class="field">
        <label class="label" for="e-ends">Автоматическое завершение — необязательно</label>
        <input class="input" type="datetime-local" id="e-ends" value="${toLocalInput(e?.endsAt)}">
        <p class="small subtle top-gap-xs">Если не указать, голосование идёт, пока вы не завершите его вручную.</p>
      </div>
      <h3 class="top-gap">Номинации</h3>
      <div class="top-gap-sm" id="questions">${questions.map(questionBlock).join('')}</div>
      <button type="button" class="btn btn--glass top-gap-sm" id="add-q">${icons.plus} Добавить номинацию</button>
      <div id="editor-error"></div>
      <div class="actions">
        <button type="submit" class="btn btn--brand btn--lg">${e ? 'Сохранить изменения' : 'Создать голосование'} ${icons.arrow}</button>
      </div>
    </form>`);

  const form = document.getElementById('editor');
  const list = form.querySelector('#questions');
  form.querySelector('#e-title').focus();
  form.querySelector('#cancel').addEventListener('click', () => showList());
  form.querySelector('#add-q').addEventListener('click', () => {
    list.insertAdjacentHTML('beforeend', questionBlock({}, list.children.length));
    list.lastElementChild.querySelector('input').focus();
  });
  form.addEventListener('click', (ev) => {
    const add = ev.target.closest('[data-add="c"]');
    if (add) {
      const box = add.closest('.builder-q').querySelector('[data-cands]');
      box.insertAdjacentHTML('beforeend', candidateRow({}, box.children.length));
      box.lastElementChild.querySelector('input').focus();
      return;
    }
    const rm = ev.target.closest('[data-rm]');
    if (rm) {
      const node = rm.closest(rm.dataset.rm === 'q' ? '.builder-q' : '.builder-c');
      node.style.transition = 'opacity .2s, transform .2s';
      node.style.opacity = '0';
      node.style.transform = 'translateX(12px)';
      setTimeout(() => {
        node.remove();
        renumber(form);
      }, 200);
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
