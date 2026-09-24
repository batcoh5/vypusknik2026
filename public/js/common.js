// Общие элементы страниц: шапка, подвал, запросы к API, локальное хранилище.

const NAV = [
  ['/', 'Главная'],
  ['/vote', 'Голосовать'],
  ['/verify', 'Проверить голос'],
  ['/ledger', 'Реестр голосов'],
  ['/results', 'Итоги'],
];

const LOGO_SVG = `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true">
  <path d="M12 4 2 9l10 5 10-5-10-5Z" fill="#fff"/>
  <path d="M6 11.2V15c0 1.7 2.7 3 6 3s6-1.3 6-3v-3.8l-6 3-6-3Z" fill="#fff" opacity=".8"/>
  <path d="M21 9v5" stroke="#fff" stroke-width="1.6" stroke-linecap="round"/>
</svg>`;

export function el(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

export function renderChrome() {
  const path = location.pathname.replace(/\.html$/, '').replace(/\/index$/, '/') || '/';
  const header = el(`
    <header class="header">
      <div class="container header__inner">
        <a class="logo" href="/">
          <span class="logo__mark">${LOGO_SVG}</span>
          <span>
            <span class="logo__title">Выпускник 2026</span><br>
            <span class="logo__sub">Голосование · Краснообск</span>
          </span>
        </a>
        <button class="nav-toggle" aria-label="Меню" aria-expanded="false">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 7h16M4 12h16M4 17h16"/></svg>
        </button>
        <nav class="nav">
          ${NAV.map(([href, label]) => `<a href="${href}"${href === path ? ' class="active" aria-current="page"' : ''}>${label}</a>`).join('')}
        </nav>
      </div>
    </header>`);
  const toggle = header.querySelector('.nav-toggle');
  const nav = header.querySelector('.nav');
  toggle.addEventListener('click', () => {
    const open = nav.classList.toggle('open');
    toggle.setAttribute('aria-expanded', String(open));
  });
  document.body.prepend(header);

  document.body.append(
    el(`
    <footer class="footer">
      <div class="container footer__inner">
        <div>
          <div><b class="footer__title">Выпускник 2026</b></div>
          <div>Народное голосование · р.п. Краснообск</div>
        </div>
        <div>
          <div><a href="/verify">Проверить свой голос</a></div>
          <div><a href="/ledger">Открытый реестр бюллетеней</a></div>
          <div><a href="/#how">Как защищён голос</a></div>
        </div>
        <div>© ${new Date().getFullYear()} Оргкомитет проекта «Выпускник 2026»</div>
      </div>
    </footer>`),
  );
}

export async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: body ? { 'Content-Type': 'application/json' } : {},
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

export const STATUS_LABEL = {
  upcoming: ['Скоро начнётся', 'badge--warning'],
  active: ['Голосование идёт', 'badge--success'],
  ended: ['Голосование завершено', 'badge--muted'],
};

export function statusBadge(status) {
  const [label, cls] = STATUS_LABEL[status] ?? ['—', 'badge--muted'];
  return `<span class="badge ${cls}">${label}</span>`;
}

const dateFmt = new Intl.DateTimeFormat('ru-RU', {
  day: 'numeric',
  month: 'long',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  timeZone: 'Asia/Novosibirsk',
});

export function formatDate(iso) {
  return dateFmt.format(new Date(iso)) + ' (Нск)';
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

export function shortHash(hash) {
  return hash ? `${hash.slice(0, 10)}…${hash.slice(-6)}` : '';
}

export function toast(text) {
  const node = el(`<div class="toast" role="status">${escapeHtml(text)}</div>`);
  document.body.append(node);
  setTimeout(() => node.remove(), 2500);
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Скопировано');
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

export function initials(name) {
  return name
    .replace(/[«»"№·]/g, ' ')
    .split(/\s+/)
    .filter((w) => /^[A-Za-zА-Яа-яЁё0-9]/.test(w))
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join('');
}

// Загружает все блоки реестра постранично.
export async function fetchAllBlocks(onProgress) {
  const blocks = [];
  let total = Infinity;
  while (blocks.length < total) {
    const page = await api(`/api/ledger?from=${blocks.length}&limit=500`);
    total = page.total;
    if (!page.blocks.length) break;
    blocks.push(...page.blocks);
    onProgress?.(blocks.length, total);
  }
  return blocks;
}

export const RECEIPT_KEY = 'receipt';
export const PENDING_KEY = 'pending';
