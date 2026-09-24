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
  return `<a class="brand" href="/" aria-label="Выпускник Краснообска — на главную">
    <img class="brand__logo" src="/img/wordmark.png" alt="Выпускник Краснообска 2026" width="150" height="46">
  </a>`;
}

export function renderChrome() {
  document.body.prepend(
    el(`<div class="glows" aria-hidden="true"><div class="grid-bg"></div><div class="glow glow--a"></div><div class="glow glow--b"></div><div class="glow glow--c"></div></div>`),
  );

  const footer = el(`
    <footer class="footer">
      <div class="container">
        <div class="footer__grid">
          <div class="footer__about">
            ${brandHtml()}
            <p>Зрительское голосование ежегодного конкурса «Выпускник Краснообска» для выпускников 11-х классов школ рабочего посёлка Краснообск.</p>
          </div>
          <div>
            <h4>Конкурс</h4>
            <ul>
              <li><a href="${VK_URL}" target="_blank" rel="noopener">Группа ВКонтакте ${icons.external}</a></li>
            </ul>
          </div>
          <div>
            <h4>Организаторы</h4>
            <ul>
              <li>Администрация р.п. Краснообск</li>
              <li>МБУ р.п. Краснообска «Дом культуры»</li>
              <li>Молодёжный Краснообск</li>
            </ul>
          </div>
        </div>
        <div class="footer__bottom">
          <span>© ${new Date().getFullYear()} «Выпускник Краснообска». Все права защищены.</span>
          <span>Зрительское голосование</span>
        </div>
        <svg class="footer__word" viewBox="0 0 1000 130" aria-hidden="true" preserveAspectRatio="xMidYMax meet">
          <defs><linearGradient id="fw" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".14"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient></defs>
          <text x="500" y="126" text-anchor="middle" textLength="990" lengthAdjust="spacingAndGlyphs" fill="url(#fw)">ВЫПУСКНИК</text>
        </svg>
      </div>
    </footer>`);
  document.body.append(footer);

  // «ВЫПУСКНИК» в подвале выезжает снизу, когда подвал появляется на экране.
  const word = footer.querySelector('.footer__word');
  if (reduceMotion() || !('IntersectionObserver' in window)) word.classList.add('in');
  else {
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        word.classList.add('in');
        io.disconnect();
      }
    });
    io.observe(footer);
  }

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

// Эффект «печатающегося» текста (для хешей и квитанций).
// Конфетти в фирменных цветах.
export function confetti() {
  if (reduceMotion()) return;
  const canvas = el('<canvas class="confetti"></canvas>');
  document.body.append(canvas);
  const ctx = canvas.getContext('2d');
  const dpr = Math.min(2, devicePixelRatio || 1);
  const resize = () => {
    canvas.width = innerWidth * dpr;
    canvas.height = innerHeight * dpr;
  };
  resize();
  const colors = ['#22c7f2', '#3cf0b4', '#2a5bd7', '#ffffff', '#8be9ff'];
  const parts = Array.from({ length: 160 }, () => ({
    x: innerWidth / 2 + (Math.random() - 0.5) * 120,
    y: innerHeight * 0.35,
    vx: (Math.random() - 0.5) * 16,
    vy: -Math.random() * 14 - 4,
    w: 6 + Math.random() * 6,
    h: 3 + Math.random() * 5,
    r: Math.random() * Math.PI,
    vr: (Math.random() - 0.5) * 0.3,
    c: colors[(Math.random() * colors.length) | 0],
  }));
  const start = performance.now();
  const frame = (t) => {
    const age = t - start;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (const p of parts) {
      p.vy += 0.35;
      p.vx *= 0.99;
      p.x += p.vx;
      p.y += p.vy;
      p.r += p.vr;
      ctx.save();
      ctx.globalAlpha = Math.max(0, 1 - age / 3200);
      ctx.translate(p.x * dpr, p.y * dpr);
      ctx.rotate(p.r);
      ctx.fillStyle = p.c;
      ctx.fillRect((-p.w / 2) * dpr, (-p.h / 2) * dpr, p.w * dpr, p.h * dpr);
      ctx.restore();
    }
    if (age < 3200) requestAnimationFrame(frame);
    else canvas.remove();
  };
  requestAnimationFrame(frame);
}

// Звук салюта, синтезируется в браузере (Web Audio): свист ракеты,
// раскатистый взрыв и треск искр. Создаётся по нажатию кнопки —
// иначе браузеры не разрешают воспроизводить звук.
export function fireworksSound() {
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  let ctx;
  try {
    ctx = new AC();
  } catch {
    return null;
  }
  ctx.resume?.();
  const master = ctx.createGain();
  master.gain.value = 0.7;
  const comp = ctx.createDynamicsCompressor();
  master.connect(comp).connect(ctx.destination);

  const noise = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
  const data = noise.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;

  const panner = (pan) => {
    if (!ctx.createStereoPanner) return master;
    const p = ctx.createStereoPanner();
    p.pan.value = Math.max(-0.8, Math.min(0.8, pan));
    p.connect(master);
    return p;
  };
  const noiseSource = (offset = Math.random()) => {
    const src = ctx.createBufferSource();
    src.buffer = noise;
    src.start(ctx.currentTime, offset);
    return src;
  };

  return {
    resume: () => ctx.resume?.(),
    // Свист/шипение взлетающей ракеты.
    launch(pan = 0) {
      const t = ctx.currentTime;
      const src = noiseSource();
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.Q.value = 6;
      bp.frequency.setValueAtTime(500, t);
      bp.frequency.exponentialRampToValueAtTime(3200, t + 1.1);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.18, t + 0.15);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 1.2);
      src.connect(bp).connect(g).connect(panner(pan));
      src.stop(t + 1.3);
    },
    // Взрыв: глухой удар + раскат, у крупных — треск искр.
    boom(pan = 0, big = false, crackle = false) {
      const t = ctx.currentTime;
      const src = noiseSource();
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.setValueAtTime(big ? 1600 : 1100, t);
      lp.frequency.exponentialRampToValueAtTime(120, t + 1.4);
      const g = ctx.createGain();
      g.gain.setValueAtTime(big ? 1.2 : 0.8, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + (big ? 2.2 : 1.5));
      const out = panner(pan);
      src.connect(lp).connect(g).connect(out);
      src.stop(t + 2.3);

      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(110, t);
      osc.frequency.exponentialRampToValueAtTime(38, t + 0.45);
      const og = ctx.createGain();
      og.gain.setValueAtTime(big ? 0.9 : 0.6, t);
      og.gain.exponentialRampToValueAtTime(0.0001, t + 0.5);
      osc.connect(og).connect(out);
      osc.start(t);
      osc.stop(t + 0.55);

      if (crackle) {
        for (let i = 0; i < 28; i++) {
          const ct = t + 0.35 + Math.random() * 1.4;
          const c = noiseSource();
          const hp = ctx.createBiquadFilter();
          hp.type = 'highpass';
          hp.frequency.value = 2500 + Math.random() * 3000;
          const cg = ctx.createGain();
          cg.gain.setValueAtTime(0.0001, ct);
          cg.gain.exponentialRampToValueAtTime(0.08 + Math.random() * 0.12, ct + 0.005);
          cg.gain.exponentialRampToValueAtTime(0.0001, ct + 0.05);
          c.connect(hp).connect(cg).connect(out);
          c.stop(ct + 0.06);
        }
      }
    },
    close: () => setTimeout(() => ctx.close?.(), 3000),
  };
}

// Большой салют на весь экран: ракеты взлетают снизу и взрываются
// разноцветными шарами, кольцами и «ивами» со светящимися хвостами.
export function fireworks(duration = 7000, sound = null) {
  if (reduceMotion()) {
    sound?.close();
    return;
  }
  const canvas = el('<canvas class="fireworks"></canvas>');
  const flash = el('<div class="fireworks-flash"></div>');
  document.body.append(canvas, flash);
  const ctx = canvas.getContext('2d');
  const dpr = Math.min(1.5, devicePixelRatio || 1);
  let W = 0;
  let H = 0;
  const resize = () => {
    W = innerWidth;
    H = innerHeight;
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  };
  resize();
  addEventListener('resize', resize);

  const palettes = [
    ['#22c7f2', '#8be9ff', '#ffffff'],
    ['#3cf0b4', '#b6ffe4', '#ffffff'],
    ['#ffd166', '#ffb703', '#fff3c4'],
    ['#ff5ea8', '#ffb3d9', '#ffffff'],
    ['#a78bfa', '#ddd6fe', '#ffffff'],
    ['#2a5bd7', '#22c7f2', '#3cf0b4'],
    ['#ff6b35', '#ffd166', '#ffffff'],
  ];
  const rand = (a, b) => a + Math.random() * (b - a);
  const pick = (arr) => arr[(Math.random() * arr.length) | 0];
  const rockets = [];
  const sparks = [];
  const MAX_SPARKS = matchMedia('(max-width: 600px)').matches ? 1400 : 2600;

  function launch(x = rand(W * 0.1, W * 0.9)) {
    const targetY = rand(H * 0.12, H * 0.45);
    rockets.push({ x, y: H + 10, vx: rand(-1.2, 1.2), vy: -Math.sqrt(2 * 0.12 * (H - targetY)) * rand(0.95, 1.05), trail: [], palette: pick(palettes) });
    if (Math.random() < 0.7) sound?.launch((x / W) * 2 - 1);
  }

  function explode(r) {
    const type = pick(['sphere', 'sphere', 'ring', 'willow', 'double']);
    const count = type === 'ring' ? 70 : rand(110, 170) | 0;
    const speed = rand(4.5, 7.5);
    const add = (n, spd, colors, opts = {}) => {
      for (let i = 0; i < n && sparks.length < MAX_SPARKS; i++) {
        const a = (i / n) * Math.PI * 2 + rand(-0.05, 0.05);
        const v = type === 'ring' ? spd : spd * Math.cbrt(Math.random());
        sparks.push({
          x: r.x,
          y: r.y,
          px: r.x,
          py: r.y,
          vx: Math.cos(a) * v,
          vy: Math.sin(a) * v,
          life: 1,
          decay: opts.decay ?? rand(0.009, 0.016),
          color: pick(colors),
          size: opts.size ?? rand(1.4, 2.6),
          gravity: opts.gravity ?? 0.06,
          friction: opts.friction ?? 0.965,
          flicker: Math.random() < 0.35,
        });
      }
    };
    if (type === 'willow') add(count, speed * 0.8, ['#ffd166', '#ffe8a3', '#ffb703'], { decay: rand(0.005, 0.008), gravity: 0.045, friction: 0.975, size: 1.6 });
    else add(count, speed, r.palette);
    if (type === 'double') add(60, speed * 0.45, [pick(pick(palettes))]);
    sound?.boom((r.x / W) * 2 - 1, type === 'double' || type === 'willow', type === 'willow' || Math.random() < 0.35);
    // вспышка в точке взрыва
    sparks.push({ x: r.x, y: r.y, px: r.x, py: r.y, vx: 0, vy: 0, life: 1, decay: 0.08, color: '#ffffff', size: 26, gravity: 0, friction: 1, burst: true });
    flash.style.opacity = '0.18';
    setTimeout(() => (flash.style.opacity = '0'), 60);
  }

  // Первый залп — сразу несколько ракет, дальше — очередями.
  for (let i = 0; i < 5; i++) setTimeout(() => launch(W * (0.15 + i * 0.175)), i * 120);
  const start = performance.now();
  let nextLaunch = start + 700;

  let last = start;
  const frame = (t) => {
    const elapsed = t - start;
    // Шаг времени в «кадрах по 60 fps»: на медленном телефоне салют идёт с той же скоростью.
    const dt = Math.min(4, Math.max(0.25, (t - last) / 16.67));
    last = t;
    if (elapsed < duration && t >= nextLaunch) {
      const volley = Math.random() < 0.3 ? 3 : 1;
      for (let i = 0; i < volley; i++) launch();
      nextLaunch = t + rand(220, 520);
    }
    ctx.clearRect(0, 0, W, H);
    ctx.globalCompositeOperation = 'lighter';

    for (let i = rockets.length - 1; i >= 0; i--) {
      const r = rockets[i];
      r.trail.push([r.x, r.y]);
      if (r.trail.length > 10) r.trail.shift();
      r.x += r.vx * dt;
      r.y += r.vy * dt;
      r.vy += 0.12 * dt;
      ctx.beginPath();
      ctx.moveTo(r.trail[0][0], r.trail[0][1]);
      for (const [x, y] of r.trail) ctx.lineTo(x, y);
      ctx.strokeStyle = 'rgba(255, 230, 180, 0.8)';
      ctx.lineWidth = 2.2;
      ctx.stroke();
      if (r.vy >= -0.6) {
        explode(r);
        rockets.splice(i, 1);
      }
    }

    for (let i = sparks.length - 1; i >= 0; i--) {
      const p = sparks[i];
      p.px = p.x;
      p.py = p.y;
      const f = Math.pow(p.friction, dt);
      p.vx *= f;
      p.vy = p.vy * f + p.gravity * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.life -= p.decay * dt;
      if (p.life <= 0) {
        sparks.splice(i, 1);
        continue;
      }
      if (p.burst) {
        const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.size * 4 * p.life + 1);
        g.addColorStop(0, `rgba(255,255,255,${0.9 * p.life})`);
        g.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.fillStyle = g;
        ctx.fillRect(p.x - 120, p.y - 120, 240, 240);
        continue;
      }
      const alpha = p.flicker && Math.random() < 0.3 ? p.life * 0.3 : p.life;
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = p.color;
      ctx.lineWidth = p.size;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(p.px - p.vx * 2, p.py - p.vy * 2);
      ctx.lineTo(p.x, p.y);
      ctx.stroke();
      ctx.globalAlpha = alpha * 0.25;
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size * 3, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
    }

    if (elapsed < duration || rockets.length || sparks.length) requestAnimationFrame(frame);
    else {
      removeEventListener('resize', resize);
      canvas.remove();
      flash.remove();
      sound?.close();
    }
  };
  requestAnimationFrame(frame);
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
