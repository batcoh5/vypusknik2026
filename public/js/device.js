// Отпечаток устройства для защиты от повторного голосования.
//
// Собираются характеристики самого устройства, которые одинаковы в любом
// браузере, в режиме инкогнито и через VPN: система, экран, число ядер,
// сенсорный ввод, часовой пояс и установленные шрифты.
// На сервер уходит только хеш — сами характеристики не передаются.
//  - fingerprint: хеш характеристик устройства;
//  - local: случайная метка, сохранённая в localStorage и IndexedDB
//    (переживает очистку cookie).

import { sha256Hex, bytesToHex, randomBytes } from './core.js';

// Только шрифты, которые ставятся вместе с системой: пользовательские шрифты
// некоторые браузеры скрывают в приватном режиме, и отпечаток бы менялся.
const FONTS = [
  'Arial', 'Arial Black', 'Bahnschrift', 'Calibri', 'Cambria', 'Candara', 'Comic Sans MS', 'Consolas', 'Constantia',
  'Corbel', 'Courier New', 'Ebrima', 'Franklin Gothic Medium', 'Gabriola', 'Gadugi', 'Georgia', 'Impact', 'Ink Free',
  'Javanese Text', 'Leelawadee UI', 'Lucida Console', 'Lucida Sans Unicode', 'Malgun Gothic', 'Microsoft Himalaya',
  'Segoe Fluent Icons', 'Segoe UI Variable', 'Sitka Text', 'Sylfaen', 'Tahoma', 'Trebuchet MS', 'Verdana',
  'Helvetica Neue', 'Avenir Next', 'Menlo', 'SF Pro', 'Futura', 'Gill Sans', 'Optima', 'Didot', 'Apple Chancery',
  'Noto Sans', 'Roboto', 'DejaVu Sans', 'Liberation Sans', 'Ubuntu', 'Cantarell',
];

function osName() {
  const ua = navigator.userAgent;
  if (/iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return 'ios';
  if (/Android/.test(ua)) return 'android';
  if (/Windows/.test(ua)) return 'windows';
  if (/Mac OS X|Macintosh/.test(ua)) return 'mac';
  if (/CrOS/.test(ua)) return 'chromeos';
  if (/Linux/.test(ua)) return 'linux';
  return 'other';
}

// Шрифт считается установленным, если текст им отличается по ширине от запасного.
function installedFonts() {
  const ctx = document.createElement('canvas').getContext('2d');
  if (!ctx) return '';
  const sample = 'mmmmmmmmmmlli WwЖжЩщ 1234567890';
  const bases = ['monospace', 'serif', 'sans-serif'];
  const baseWidth = bases.map((b) => {
    ctx.font = `72px ${b}`;
    return ctx.measureText(sample).width;
  });
  return FONTS.map((f) =>
    bases.some((b, i) => {
      ctx.font = `72px "${f}", ${b}`;
      return Math.abs(ctx.measureText(sample).width - baseWidth[i]) > 0.5;
    })
      ? '1'
      : '0',
  ).join('');
}

// Семейство видеокарты в едином виде: разные браузеры описывают одну и ту же
// видеокарту по-разному, поэтому оставляем только модель.
function gpuFamily() {
  try {
    const gl = document.createElement('canvas').getContext('webgl');
    if (!gl) return 'none';
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const raw = String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)).toLowerCase();
    if (/apple/.test(raw)) return 'apple';
    const m = raw
      .replace(/\((r|tm)\)/g, '')
      .match(/(rtx\s*\d{3,4}\s*\w*|gtx\s*\d{3,4}\s*\w*|mx\s*\d{3}|quadro\s*\w+|radeon\s*(rx|pro|r\d)?\s*\w*\s*\d{3,4}\w*|radeon\s*(graphics|vega\s*\d*)|(uhd|hd|iris\s*xe|iris)\s*graphics\s*\d*|arc\s*a\d{3}|adreno\s*\d{3}|mali-?\w+|powervr\s*\w*|xclipse\s*\d+)/);
    return m ? m[0].replace(/\s+/g, ' ').trim() : 'other';
  } catch {
    return 'error';
  }
}

// ---------- постоянная метка устройства ----------

const LS_KEY = 'vyp26:device';

function idbGet() {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open('vyp26', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('kv');
      req.onerror = () => resolve(null);
      req.onsuccess = () => {
        const tx = req.result.transaction('kv', 'readonly').objectStore('kv').get('device');
        tx.onsuccess = () => resolve(tx.result ?? null);
        tx.onerror = () => resolve(null);
      };
    } catch {
      resolve(null);
    }
  });
}

function idbSet(value) {
  try {
    const req = indexedDB.open('vyp26', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('kv');
    req.onsuccess = () => req.result.transaction('kv', 'readwrite').objectStore('kv').put(value, 'device');
  } catch {
    /* хранилище недоступно */
  }
}

async function localMark() {
  let id = null;
  try {
    id = localStorage.getItem(LS_KEY);
  } catch {
    /* ignore */
  }
  if (!/^[0-9a-f]{32}$/.test(id ?? '')) id = await idbGet();
  if (!/^[0-9a-f]{32}$/.test(id ?? '')) id = bytesToHex(randomBytes(16));
  try {
    localStorage.setItem(LS_KEY, id);
  } catch {
    /* ignore */
  }
  idbSet(id);
  return id;
}

let cached;
export function deviceInfo() {
  cached ??= (async () => {
    const [w, h] = [screen.width, screen.height].sort((a, b) => b - a);
    const traits = {
      os: osName(),
      screen: `${w}x${h}x${screen.colorDepth}`,
      cores: navigator.hardwareConcurrency ?? 0,
      touch: navigator.maxTouchPoints ?? 0,
      tz: Intl.DateTimeFormat().resolvedOptions().timeZone ?? '',
      fonts: installedFonts(),
      gpu: gpuFamily(),
    };
    return {
      local: await localMark(),
      fingerprint: await sha256Hex('device:' + JSON.stringify(traits)),
    };
  })();
  return cached;
}
