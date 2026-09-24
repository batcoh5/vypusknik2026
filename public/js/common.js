// Общие элементы страниц: шапка, подвал, анимации, запросы к API, хранилище.

export const VK_URL = 'https://vk.com/wkrasnoobskacontest';

// ---------- иконки (Lucide-подобные, stroke) ----------

const svg = (body, extra = '') =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" ${extra}>${body}</svg>`;

export const icons = {
  arrow: svg('<path d="M5 12h14M13 6l6 6-6 6"/>', 'class="arrow"'),
  external: svg('<path d="M7 17 17 7M8 7h9v9"/>'),
  check: svg('<path d="M5 12.5l4.5 4.5L19 7.5"/>'),
  x: svg('<path d="M6 6l12 12M18 6 6 18"/>'),
  minus: svg('<path d="M6 12h12"/>'),
  shield: svg('<path d="M12 3 4 6v6c0 5 3.4 8.4 8 9 4.6-.6 8-4 8-9V6l-8-3Z"/><path d="m9 12 2 2 4-4"/>'),
  eyeOff: svg('<path d="M3 3l18 18M10.6 5.1A10.4 10.4 0 0 1 12 5c6 0 9.5 7 9.5 7a17 17 0 0 1-3.2 4M6.6 6.6A17 17 0 0 0 2.5 12S6 19 12 19a9.7 9.7 0 0 0 5.4-1.6"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/>'),
  lock: svg('<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>'),
  blocks: svg('<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><path d="M10 6.5h4M6.5 10v4M17.5 10v4M14 17.5h-4"/>'),
  receipt: svg('<path d="M5 3h14v18l-3-2-2 2-2-2-2 2-2-2-3 2V3Z"/><path d="M9 8h6M9 12h6"/>'),
  chart: svg('<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>'),
  user: svg('<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>'),
  clock: svg('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'),
  info: svg('<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>'),
  alert: svg('<path d="M12 3 2 20h20L12 3Z"/><path d="M12 10v4M12 17h.01"/>'),
  copy: svg('<rect x="8" y="8" width="13" height="13" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/>'),
  download: svg('<path d="M12 3v12M7 10l5 5 5-5M4 21h16"/>'),
  upload: svg('<path d="M12 21V9M7 14l5-5 5 5M4 3h16"/>'),
  search: svg('<circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/>'),
  plus: svg('<path d="M12 5v14M5 12h14"/>'),
  trash: svg('<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>'),
  edit: svg('<path d="M4 20h4L19 9l-4-4L4 16v4Z"/><path d="m13.5 6.5 4 4"/>'),
  play: svg('<path d="M7 4v16l13-8L7 4Z"/>'),
  stop: svg('<rect x="6" y="6" width="12" height="12" rx="2"/>'),
  crown: svg('<path d="M3 8l4 4 5-7 5 7 4-4-2 11H5L3 8Z"/>'),
  vk: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M13.1 18.5c-6.2 0-9.8-4.3-9.9-11.4h3.1c.1 5.2 2.4 7.4 4.2 7.9V7.1h2.9v4.5c1.8-.2 3.7-2.2 4.3-4.5h2.9c-.5 2.8-2.5 4.8-4 5.6 1.5.7 3.8 2.5 4.7 5.8h-3.2c-.7-2.2-2.4-3.9-4.7-4.1v4.1h-.3Z"/></svg>',
  hat: svg('<path d="M12 4 2 9l10 5 10-5-10-5Z"/><path d="M6 11.5V16c0 1.7 2.7 3 6 3s6-1.3 6-3v-4.5"/>'),
};

// ---------- утилиты DOM ----------

export function el(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

const reduceMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

// ---------- шапка, подвал, фон ----------

function brandHtml() {
  return `<a class="brand brand--footer" href="/" aria-label="Выпускник Краснообска 2026 — на главную">
    <img class="brand__logo" src="/img/wordmark.png" alt="Выпускник Краснообска 2026" width="150" height="46">
  </a>`;
}

export function renderChrome() {
  const footer = el(`
    <footer class="footer">
      <div class="container">
        <div class="footer__grid">
          <div class="footer__about">
            ${brandHtml()}
            <p>Зрительское голосование ежегодного конкурса «Выпускник Краснообска» для выпускников 11-х классов школ рабочего посёлка Краснообск.</p>
          </div>
          <div>
            <h4>Организаторы</h4>
            <ul class="partners">
              <li><span class="partner__logo"><img src="/img/partners/admin.png" alt="" width="84" height="128"></span>Администрация р.п. Краснообск</li>
              <li><span class="partner__logo"><img src="/img/partners/dk.png" alt="" width="126" height="128"></span>МБУ р.п. Краснообска «Дом культуры»</li>
              <li><span class="partner__logo"><img src="/img/partners/molodezh.png" alt="" width="139" height="96"></span>Молодёжный Краснообск</li>
            </ul>
          </div>
        </div>
        <div class="footer__bottom">
          <span>© ${new Date().getFullYear()} «Выпускник Краснообска». Все права защищены.</span>
          <span class="hint">Зрительское голосование
            <button type="button" class="hint__btn" aria-label="Что такое зрительское голосование">${icons.info}</button>
            <span class="hint__tip" role="tooltip">Зрители сами выбирают участника, который понравился им больше всех. Голосовать может каждый — один раз через свой аккаунт ВКонтакте. Голоса зрителей переводятся в баллы (до 160) и учитываются в итогах конкурса.</span>
          </span>
        </div>
      </div>
    </footer>`);
  document.body.append(footer);

  const hint = footer.querySelector('.hint');
  hint.querySelector('.hint__btn').addEventListener('click', (e) => {
    e.stopPropagation();
    hint.classList.toggle('open');
  });
  document.addEventListener('click', () => hint.classList.remove('open'));

  initReveal();
  initSpotlight();
}

// ---------- анимации ----------

let revealObserver;
export function initReveal(root = document) {
  const items = root.querySelectorAll('[data-reveal]:not(.in)');
  // Задержки задаются через data-d: CSP запрещает inline-стили в разметке.
  items.forEach((i) => i.dataset.d && i.style.setProperty('--d', i.dataset.d + 'ms'));
  if (reduceMotion() || !('IntersectionObserver' in window)) {
    items.forEach((i) => i.classList.add('in'));
    return;
  }
  revealObserver ??= new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (e.isIntersecting) {
          e.target.classList.add('in');
          revealObserver.unobserve(e.target);
        }
      }
    },
    { rootMargin: '0px 0px -8% 0px', threshold: 0.08 },
  );
  items.forEach((i) => revealObserver.observe(i));
}

// Подсветка карточки, следующая за курсором.
function initSpotlight() {
  document.addEventListener(
    'pointermove',
    (e) => {
      const card = e.target.closest?.('.spot');
      if (!card) return;
      const r = card.getBoundingClientRect();
      card.style.setProperty('--mx', `${e.clientX - r.left}px`);
      card.style.setProperty('--my', `${e.clientY - r.top}px`);
    },
    { passive: true },
  );
}

// Плавный счётчик чисел.
export function countUp(node, value, duration = 1200) {
  const to = Number(value) || 0;
  if (reduceMotion() || to === 0) {
    node.textContent = formatNumber(to);
    return;
  }
  const start = performance.now();
  const step = (t) => {
    const p = Math.min(1, (t - start) / duration);
    const eased = 1 - Math.pow(1 - p, 4);
    node.textContent = formatNumber(Math.round(to * eased));
    if (p < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

// Полноэкранная загрузка «Отправляем ваш голос…»: держится не меньше minMs.
export async function withOverlay(text, fn, minMs = 2000) {
  const node = el(`<div class="sending" role="status" aria-live="polite"><div class="sending__box"><span class="sending__spin"></span><b>${escapeHtml(text)}</b></div></div>`);
  document.body.append(node);
  try {
    const [result] = await Promise.all([fn(), new Promise((r) => setTimeout(r, minMs))]);
    return result;
  } finally {
    node.classList.add('closing');
    setTimeout(() => node.remove(), 200);
  }
}

// Кнопка в состоянии загрузки: спиннер вместо текста «Загрузка…».
export async function withLoading(button, fn) {
  const html = button.innerHTML;
  button.classList.add('is-loading');
  button.innerHTML = `<span class="spin"></span>${button.dataset.loading ?? ''}`;
  try {
    return await fn();
  } finally {
    button.classList.remove('is-loading');
    button.innerHTML = html;
  }
}

export function shake(node) {
  node.classList.remove('shake');
  void node.offsetWidth;
  node.classList.add('shake');
}

// ---------- скелетоны ----------

export const skeleton = {
  card: () => `<div class="card card--pad stack"><div class="sk sk--title"></div><div>${skeleton.lines(2)}</div></div>`,
  lines: (n = 3) => Array.from({ length: n }, (_, i) => `<div class="sk sk--line${i === n - 1 ? ' sk--short' : ''}"></div>`).join(''),
  blocks: (n = 3) => Array.from({ length: n }, () => '<div class="sk sk--block"></div>').join(''),
};

// ---------- уведомления и диалоги ----------

export function toast(text) {
  const node = el(`<div class="toast" role="status"><span class="dot"></span>${escapeHtml(text)}</div>`);
  document.body.append(node);
  setTimeout(() => {
    node.classList.add('out');
    setTimeout(() => node.remove(), 300);
  }, 2400);
}

export function confirmDialog({ title, text, ok = 'Подтвердить', danger = false }) {
  return new Promise((resolve) => {
    const modal = el(`
      <div class="modal" role="dialog" aria-modal="true">
        <div class="modal__box">
          <h3>${escapeHtml(title)}</h3>
          <p>${escapeHtml(text)}</p>
          <div class="actions">
            <button class="btn ${danger ? 'btn--danger' : 'btn--primary'}" data-ok>${escapeHtml(ok)}</button>
            <button class="btn btn--ghost" data-cancel>Отмена</button>
          </div>
        </div>
      </div>`);
    const close = (value) => {
      modal.classList.add('closing');
      setTimeout(() => modal.remove(), 200);
      removeEventListener('keydown', onKey);
      resolve(value);
    };
    const onKey = (e) => e.key === 'Escape' && close(false);
    modal.addEventListener('click', (e) => {
      if (e.target === modal || e.target.closest('[data-cancel]')) close(false);
      if (e.target.closest('[data-ok]')) close(true);
    });
    addEventListener('keydown', onKey);
    document.body.append(modal);
    modal.querySelector('[data-ok]').focus();
  });
}

export function note(kind, title, text, icon) {
  const ic = icon ?? { success: icons.check, danger: icons.alert, warning: icons.alert }[kind] ?? icons.info;
  return `<div class="note note--${kind}"><span class="note__icon">${ic}</span><div><b>${title}</b>${text ? `<p>${text}</p>` : ''}</div></div>`;
}

// ---------- API ----------

export async function api(path, { method = 'GET', body, headers = {} } = {}) {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* пустой ответ */
  }
  if (!res.ok) {
    const err = new Error(data?.message ?? `Ошибка сервера (${res.status})`);
    err.status = res.status;
    err.code = data?.error;
    throw err;
  }
  return data;
}

// Локальное хранилище может быть недоступно (приватный режим) — не падаем.
export const store = {
  get(key) {
    try {
      return JSON.parse(localStorage.getItem('vyp26:' + key));
    } catch {
      return null;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem('vyp26:' + key, JSON.stringify(value));
    } catch {
      /* ignore */
    }
  },
  remove(key) {
    try {
      localStorage.removeItem('vyp26:' + key);
    } catch {
      /* ignore */
    }
  },
};

export const votedKey = (electionId) => `voted:${electionId}`;
export const pendingKey = (electionId) => `pending:${electionId}`;

// ---------- форматирование ----------

export function statusBadge(status) {
  if (status === 'active') return '<span class="badge badge--live"><span class="dot dot--pulse"></span>Голосование идёт</span>';
  if (status === 'finished') return '<span class="badge badge--done"><span class="dot"></span>Голосование завершено</span>';
  if (status === 'draft') return '<span class="badge badge--draft"><span class="dot"></span>Черновик</span>';
  return '<span class="badge"><span class="dot"></span>Ещё не началось</span>';
}

const dateFmt = new Intl.DateTimeFormat('ru-RU', {
  day: 'numeric',
  month: 'long',
  hour: '2-digit',
  minute: '2-digit',
  timeZone: 'Asia/Novosibirsk',
});

export function formatDate(iso) {
  return iso ? dateFmt.format(new Date(iso)) : '—';
}

export function formatNumber(n) {
  return new Intl.NumberFormat('ru-RU').format(n);
}

export function plural(n, one, few, many) {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

export function initials(name) {
  return (
    String(name)
      .replace(/[«»"№·().,]/g, ' ')
      .split(/\s+/)
      .filter((w) => /^[A-Za-zА-Яа-яЁё0-9]/.test(w))
      .slice(0, 2)
      .map((w) => w[0].toUpperCase())
      .join('') || '•'
  );
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Скопировано в буфер обмена');
  } catch {
    toast('Не удалось скопировать');
  }
}

export function downloadJson(filename, data) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
