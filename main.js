const {
  app, BrowserWindow, globalShortcut, ipcMain, screen, Tray, Menu, nativeImage, shell, net,
} = require('electron');
const path = require('path');
const fs = require('fs');

// Игнорируем ошибки SSL-сертификатов, чтобы окно могло подключиться к Яндекс Музыке
app.commandLine.appendSwitch('ignore-certificate-errors');

// ───────────────────────── Настройки ─────────────────────────
const DEFAULTS = {
  hotkeyPanel: 'CommandOrControl+Shift+M', // открыть/закрыть панель управления
  hotkeyHud: 'CommandOrControl+Shift+H',   // показать/скрыть мини-плеер
  hudCorner: 'top-right',                  // top-left | top-right | bottom-left | bottom-right
  hudOpacity: 0.7,                         // 0.2 … 1
  hudVisible: true,                        // показывать мини-плеер постоянно
  hudFlashOnTrackChange: true,             // если скрыт — мигнуть на 4 сек при смене трека
  hudPos: null,                            // {x, y} 0…1 — положение, если мини-плеер перетащили мышкой
  hotkeyLyrics: 'CommandOrControl+Shift+L', // закрепить/открепить окно с текстом песни
  hudLyrics: true,                         // показывать текущую строку песни в мини-плеере
  lyricsVisible: true,                     // окно с текстом включено (видно при открытой панели)
  lyricsPinned: false,                     // закреплено: окно текста остаётся поверх окон и без панели
  lyricsPos: null,                         // {x, y, w, h} — положение (0…1) и размер окна текста
  theme: {                                 // внешний вид (всё это меняется во вкладке «Вид» панели)
    accent: '#ffcc00',                     // акцентный цвет
    bg: '#121216',                         // цвет фона плашек и панели
    fg: '#ffffff',                         // цвет текста
    lyricsOpacity: 0.7,                    // прозрачность окна текста, 0.1…1
    panelOpacity: 0.96,                    // прозрачность панели, 0.5…1
    lyricsFontSize: 16,                    // размер текста песни, px
    radius: 14,                            // скругление углов, px
    blur: true,                            // размытие фона за плашками
  },
  lyricsOffset: 0,                         // сдвиг текста в секундах (+ — строки раньше, − — позже)
};

const ICON = path.join(__dirname, 'icon.png');
const YM_URL = 'https://music.yandex.ru/';

let cfg = { ...DEFAULTS };
let cfgFile = '';
let logFile = '';
let firstRun = false;
let ymWin = null;
let overlay = null;
let tray = null;
let panelOpen = false;
let panelOpenedAt = 0;
let quitting = false;

// ───────────────────── Лог для диагностики ─────────────────────
function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.join(' ')}\n`;
  console.log(line.trim());
  try { if (logFile) fs.appendFileSync(logFile, line); } catch { /* не критично */ }
}

// приводим настройки вида к допустимым значениям (в конфиге их могли поправить руками)
function sanitizeTheme(t) {
  const D = DEFAULTS.theme;
  const hex = (v, d) => (typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v.trim()) ? v.trim().toLowerCase() : d);
  const num = (v, a, b, d) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Math.min(b, Math.max(a, Number(v))) : d);
  t = t && typeof t === 'object' ? t : {};
  return {
    accent: hex(t.accent, D.accent),
    bg: hex(t.bg, D.bg),
    fg: hex(t.fg, D.fg),
    lyricsOpacity: num(t.lyricsOpacity, 0.1, 1, D.lyricsOpacity),
    panelOpacity: num(t.panelOpacity, 0.5, 1, D.panelOpacity),
    lyricsFontSize: Math.round(num(t.lyricsFontSize, 12, 32, D.lyricsFontSize)),
    radius: Math.round(num(t.radius, 0, 28, D.radius)),
    blur: t.blur !== false,
  };
}

function saveConfig() {
  try { fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2)); } catch { /* не критично */ }
}

function configForOverlay() {
  return {
    hudCorner: cfg.hudCorner,
    hudOpacity: cfg.hudOpacity,
    hudVisible: cfg.hudVisible,
    hudFlash: cfg.hudFlashOnTrackChange,
    hotkeyPanel: cfg.hotkeyPanel,
    hudPos: cfg.hudPos,
    hudLyrics: cfg.hudLyrics,
    lyricsOffset: cfg.lyricsOffset,
    lyricsVisible: cfg.lyricsVisible,
    lyricsPinned: cfg.lyricsPinned,
    lyricsPos: cfg.lyricsPos,
    theme: cfg.theme,
  };
}

function loadConfig() {
  cfgFile = path.join(app.getPath('userData'), 'config.json');
  logFile = path.join(app.getPath('userData'), 'debug.log');
  try { fs.writeFileSync(logFile, ''); } catch { /* не критично */ }
  firstRun = !fs.existsSync(cfgFile);
  let user = {};
  try { user = JSON.parse(fs.readFileSync(cfgFile, 'utf8')); } catch { /* нет файла — ок */ }
  cfg = { ...DEFAULTS, ...user };
  cfg.theme = sanitizeTheme({ ...DEFAULTS.theme, ...(user.theme || {}) });
  cfg.hudOpacity = Math.min(1, Math.max(0.2, Number(cfg.hudOpacity) || DEFAULTS.hudOpacity));
  try { fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2)); } catch { /* не критично */ }
}

// ───────────────────── Окно с Яндекс Музыкой ─────────────────────
function createYandexWindow() {
  ymWin = new BrowserWindow({
    width: 1200,
    height: 800,
    show: false,
    title: 'Яндекс Музыка',
    icon: ICON,
    webPreferences: {
      partition: 'persist:ym',
      backgroundThrottling: false,
      autoplayPolicy: 'no-user-gesture-required',
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  const ua = ymWin.webContents
    .getUserAgent()
    .split(' ')
    .filter((t) => !/^(Electron|ym-overlay|YMOverlay)\//i.test(t))
    .join(' ');
  ymWin.webContents.setUserAgent(ua);

  ymWin.setMenuBarVisibility(false);
  ymWin.loadURL(YM_URL);

  ymWin.webContents.on('did-finish-load', () => log('Яндекс: страница загружена', ymWin.webContents.getURL()));
  ymWin.webContents.on('did-fail-load', (_e, code, desc, url) => log('Яндекс: ОШИБКА загрузки', code, desc, url));

  ymWin.on('close', (e) => {
    if (!quitting) {
      e.preventDefault();
      ymWin.hide();
    }
  });

  if (firstRun) ymWin.show();
}

function showYandex() {
  if (!ymWin) return;
  setPanel(false);
  ymWin.show();
  ymWin.focus();
}

// ───────────────────── Чтение состояния плеера ─────────────────────
// Общие функции, которые выполняются внутри страницы Яндекс Музыки
const BAR_JS = `
  const lbl = (b) => (b.getAttribute('aria-label') || b.title || '').trim();
  const isPP = (b) => { const l = lbl(b); return l === 'Пауза' || l === 'Воспроизведение'; };
  const findBar = () => {
    const btns = Array.from(document.querySelectorAll('button'));
    const prev = btns.find((b) => lbl(b) === 'Предыдущая песня');
    const next = btns.find((b) => lbl(b) === 'Следующая песня');
    if (!prev || !next) return null;
    let best = null, el = prev.parentElement;
    while (el && el !== document.body) {
      if (Array.from(el.querySelectorAll('button')).filter(isPP).length > 1) break;
      if (el.contains(next)) best = el;
      el = el.parentElement;
    }
    return best;
  };
`;

const STATE_JS = `(() => {
  try {
    ${BAR_JS}
    const ms = navigator.mediaSession;
    if (!ms) return JSON.stringify({ ready: false, why: 'нет navigator.mediaSession' });
    const md = ms.metadata;
    if (!md || !md.title) return JSON.stringify({ ready: true, empty: true });
    const arts = md.artwork || [];
    const cover = arts.length ? String(arts[arts.length - 1].src).replace(/\\d+x\\d+$/, '400x400') : '';
    const bar = findBar();
    const seekEl = document.querySelector('input[type=range][aria-label="Управление таймкодом"]');
    const volEl = document.querySelector('input[type=range][aria-label="Управление громкостью"]');
    const barBtns = bar ? Array.from(bar.querySelectorAll('button')) : [];
    const pressed = (b) => !!b && b.getAttribute('aria-pressed') === 'true';
    let pos = 0, dur = 0;
    if (seekEl) { pos = Number(seekEl.value) || 0; dur = Number(seekEl.max) || 0; }
    // точная позиция (с долями секунды) из аудио-элемента — нужна для синхронного текста
    const au = Array.from(document.querySelectorAll('audio,video')).find((m) => !m.paused && isFinite(m.currentTime) && isFinite(m.duration) && (!dur || Math.abs(m.duration - dur) < 3));
    if (au) { pos = au.currentTime; if (!dur) dur = au.duration; }
    const lk = barBtns.find((b) => { const l = lbl(b); return l === 'Нравится' || /из любимых|убрать|удалить/i.test(l); });
    const sh = barBtns.find((b) => /перемеш|shuffle|случайн/i.test(lbl(b)));
    const rp = barBtns.find((b) => /повтор|repeat/i.test(lbl(b)));
    const info = (b) => {
      if (!b) return null;
      const svg = b.querySelector('svg');
      const use = b.querySelector('use');
      return {
        l: lbl(b),
        p: b.getAttribute('aria-pressed'),
        c: String(b.className).replace(/\\s+/g, ' ').slice(0, 200),
        sc: svg ? String(svg.getAttribute('class') || '') : '',
        u: use ? (use.getAttribute('xlink:href') || use.getAttribute('href') || '') : '',
      };
    };
    const isOn = (b) => {
      if (!b) return false;
      const p = b.getAttribute('aria-pressed');
      if (p === 'true') return true;
      if (p === 'false') return false;
      if (b.getAttribute('aria-checked') === 'true') return true;
      const i = info(b);
      return /(^|[_\\s#-])(active|checked|selected|enabled)([_\\s-]|$)/i.test(i.c + ' ' + i.sc + ' ' + i.u);
    };
    const st = {
      ready: true,
      empty: false,
      playing: ms.playbackState === 'playing',
      title: md.title || '',
      version: '',
      artist: md.artist || '',
      album: md.album || '',
      cover: cover,
      position: pos,
      duration: dur,
      liked: !!lk && (pressed(lk) || lbl(lk) !== 'Нравится'),
      shuffle: isOn(sh),
      repeat: isOn(rp) ? (/one|single|один|трек/i.test(lbl(rp) + ' ' + (info(rp).u || '')) ? 2 : 1) : 0,
      index: -1,
    };
    if (volEl) st.volume = Number(volEl.value);
    st.dbg = JSON.stringify({ sh: info(sh), rp: info(rp) });
    const ic = (b) => { const u = b && b.querySelector('use'); return u ? (u.getAttribute('xlink:href') || u.getAttribute('href') || '') : ''; };
    let volBtn = null;
    if (volEl) {
      let p = volEl.parentElement;
      for (let i = 0; i < 4 && p && !volBtn; i++) {
        const bs = Array.from(p.querySelectorAll('button')).filter((b) => b.querySelector('use'));
        volBtn = bs.find((b) => /громк|звук|mute/i.test(lbl(b))) || null;
        p = p.parentElement;
      }
    }
    st.icons = {
      shuffle: ic(sh),
      prev: ic(barBtns.find((b) => lbl(b) === 'Предыдущая песня')),
      play: ic(barBtns.find(isPP)),
      next: ic(barBtns.find((b) => lbl(b) === 'Следующая песня')),
      repeat: ic(rp),
      like: ic(lk),
      volume: ic(volBtn),
    };
    return JSON.stringify(st);
  } catch (e) {
    return JSON.stringify({ ready: false, error: String(e) });
  }
})()`;


// ───────────────────── Иконки с сайта ─────────────────────
// Берём иконки кнопок прямо из спрайта Яндекс Музыки и отдаём оверлею как SVG
const ICON_JS = (href) => `(async () => {
  try {
    const parts = ${JSON.stringify(String(href))}.split('#');
    const url = parts[0] || '/icons/sprite.svg';
    const id = parts[1];
    const ser = new XMLSerializer();
    const out = (sym) => JSON.stringify({
      vb: sym.getAttribute('viewBox') || '0 0 24 24',
      html: Array.from(sym.childNodes).map((n) => ser.serializeToString(n)).join(''),
    });
    const inline = document.getElementById(id);
    if (inline && inline.tagName.toLowerCase() === 'symbol') return out(inline);
    window.__ymSprites = window.__ymSprites || {};
    if (!window.__ymSprites[url]) window.__ymSprites[url] = fetch(url).then((r) => r.text());
    let txt;
    try { txt = await window.__ymSprites[url]; } catch (e) { delete window.__ymSprites[url]; throw e; }
    const doc = new DOMParser().parseFromString(txt, 'image/svg+xml');
    const sym = Array.from(doc.querySelectorAll('symbol')).find((x) => x.getAttribute('id') === id);
    if (!sym) return JSON.stringify({ error: 'символ не найден в спрайте' });
    return out(sym);
  } catch (e) { return JSON.stringify({ error: String(e) }); }
})()`;

const iconCache = {};
const iconPending = new Set();
async function ensureIcons(map) {
  if (!map || !ymWin || ymWin.isDestroyed()) return;
  for (const href of Object.values(map)) {
    if (!href || href in iconCache || iconPending.has(href)) continue;
    iconPending.add(href);
    try {
      const res = JSON.parse(await ymWin.webContents.executeJavaScript(ICON_JS(href), true));
      if (res.error) {
        log('Иконка не загрузилась:', href, res.error);
        iconCache[href] = null;
      } else {
        iconCache[href] = res;
        log('Иконка загружена:', href, String(res.html).slice(0, 400));
        if (overlay && !overlay.isDestroyed()) overlay.webContents.send('icons', { [href]: res });
      }
    } catch (err) {
      log('Иконка ошибка:', href, err.message);
      iconCache[href] = null;
    } finally {
      iconPending.delete(href);
    }
  }
}

let lastJson = '';
let lastLoggedKey = '';
let lastErr = '';
let lastDbg = '';

// пишем в лог только когда меняется «вид» состояния (не каждые 500 мс)
function logState(json) {
  let key = json;
  try {
    const s = JSON.parse(json);
    key = s.ready ? (s.empty ? 'empty' : 'playing-track') : 'notready:' + (s.why || s.error || '');
  } catch { /* оставим как есть */ }
  if (key !== lastLoggedKey) {
    lastLoggedKey = key;
    log('Состояние плеера:', json.slice(0, 300));
  }
}

async function poll() {
  if (!ymWin || ymWin.isDestroyed() || !overlay || overlay.isDestroyed()) return;
  try {
    const json = await ymWin.webContents.executeJavaScript(STATE_JS, true);
    logState(json);
    lastErr = '';
    const st = JSON.parse(json);
    if (st.dbg) {
      if (st.dbg !== lastDbg) {
        lastDbg = st.dbg;
        log('Кнопки shuffle/повтор:', st.dbg);
      }
      delete st.dbg;
    }
    ensureIcons(st.icons);
    playerPlaying = !!st.playing;
    trackLyrics(st);
    const out = JSON.stringify(st);
    if (out !== lastJson) {
      lastJson = out;
      overlay.webContents.send('state', st);
    }
  } catch (err) {
    if (err.message !== lastErr) {
      lastErr = err.message;
      log('poll ошибка:', err.message);
    }
  }
}


// ───────────────────── Диагностика ─────────────────────
const DIAG_JS = `(() => {
  try {
    ${BAR_JS}
    const out = {};
    out.url = location.href;
    out.title = document.title;
    out.externalAPI = typeof window.externalAPI;
    out.keys = Object.keys(window).filter((k) => /api|player|yandex|music|ym|store|redux|audio/i.test(k)).slice(0, 60);
    const ms = navigator.mediaSession;
    out.mediaSession = ms ? {
      state: ms.playbackState,
      meta: ms.metadata ? {
        title: ms.metadata.title, artist: ms.metadata.artist, album: ms.metadata.album,
        artwork: (ms.metadata.artwork || []).map((a) => a.src + ' ' + a.sizes).slice(0, 3),
      } : null,
    } : 'нет';
    out.media = Array.from(document.querySelectorAll('audio,video')).map((m) => ({
      tag: m.tagName, paused: m.paused, t: m.currentTime, d: m.duration, vol: m.volume, src: String(m.currentSrc).slice(0, 80),
    }));
    const bar = findBar();
    const desc = (b) => ({ l: lbl(b), pressed: b.getAttribute('aria-pressed'), expanded: b.getAttribute('aria-expanded') });
    out.barButtons = bar ? Array.from(bar.querySelectorAll('button')).map(desc) : 'панель плеера не найдена';
    out.ranges = Array.from(document.querySelectorAll('input[type=range]')).map((r) => ({ l: r.getAttribute('aria-label'), max: r.max, v: r.value }));
    out.interesting = Array.from(document.querySelectorAll('[aria-label]'))
      .map((e) => e.getAttribute('aria-label'))
      .filter((l) => /очеред|перемеш|повтор|shuffle|repeat|queue|случайн/i.test(l)).slice(0, 20);
    out.iframes = Array.from(document.querySelectorAll('iframe')).map((f) => f.src).slice(0, 5);
    out.buttons = Array.from(document.querySelectorAll('button[aria-label],button[title]'))
      .map((b) => (b.getAttribute('aria-label') || b.title)).filter(Boolean).slice(0, 40);
    return JSON.stringify(out);
  } catch (e) { return JSON.stringify({ error: String(e) }); }
})()`;

async function diagnose() {
  try {
    const json = await ymWin.webContents.executeJavaScript(DIAG_JS, true);
    log('ДИАГНОСТИКА:', json);
  } catch (err) {
    log('ДИАГНОСТИКА ошибка:', err.message);
  }
  shell.openPath(logFile);
}


// Диагностика очереди: открывает панель очереди на сайте, записывает её вид в лог и закрывает обратно
const DIAG_QUEUE_JS = `(async () => {
  try {
    ${BAR_JS}
    const bar = findBar();
    const btn = bar && Array.from(bar.querySelectorAll('button')).find((b) => lbl(b) === 'Очередь воспроизведения');
    if (!btn) return JSON.stringify({ error: 'нет кнопки очереди' });
    const before = new Set(document.querySelectorAll('*'));
    btn.click();
    await new Promise((r) => setTimeout(r, 1200));
    const added = Array.from(document.querySelectorAll('*')).filter((e) => !before.has(e));
    const roots = added.filter((e) => before.has(e.parentElement)).slice(0, 4).map((e) => ({
      tag: e.tagName, label: e.getAttribute('aria-label'), cls: String(e.className).slice(0, 80), html: e.outerHTML.slice(0, 3500),
    }));
    const byClass = Array.from(document.querySelectorAll('[class*="ueue"],[aria-label*="чередь"]'))
      .filter((e) => e !== btn).slice(0, 3).map((e) => ({
        tag: e.tagName, label: e.getAttribute('aria-label'), cls: String(e.className).slice(0, 80), html: e.outerHTML.slice(0, 3500),
      }));
    const res = { addedCount: added.length, roots: roots, byClass: byClass,
      listitems: document.querySelectorAll('[role=listitem]').length, rows: document.querySelectorAll('[role=row]').length };
    const dlg = document.querySelector('[role="dialog"][aria-modal="true"]');
    const closeBtn = dlg && Array.from(dlg.querySelectorAll('button')).find((b) => lbl(b) === 'Закрыть');
    if (closeBtn) closeBtn.click(); else btn.click();
    return JSON.stringify(res);
  } catch (e) { return JSON.stringify({ error: String(e) }); }
})()`;

async function diagnoseQueue() {
  try {
    const json = await ymWin.webContents.executeJavaScript(DIAG_QUEUE_JS, true);
    log('ДИАГНОСТИКА ОЧЕРЕДИ:', json);
  } catch (err) {
    log('ДИАГНОСТИКА ОЧЕРЕДИ ошибка:', err.message);
  }
  shell.openPath(logFile);
}

// ───────────────────── Очередь ─────────────────────
// Очередь живёт в полноэкранном плеере сайта. Открываем его (окно скрыто, это не видно),
// читаем список, при необходимости нажимаем play у нужной строки и закрываем обратно.
const QUEUE_JS = (playIdx) => `(async () => {
  try {
    ${BAR_JS}
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const findRoot = () => document.querySelector('[class*="PlayQueue_root"]');
    const getRows = (root) => Array.from(root.querySelectorAll('[class*="CommonTrack_root"]'))
      .filter((r) => !(r.parentElement && r.parentElement.closest('[class*="CommonTrack_root"]')));
    let opened = false;
    if (!findRoot()) {
      const bar = findBar();
      const btn = bar && Array.from(bar.querySelectorAll('button')).find((b) => lbl(b) === 'Очередь воспроизведения');
      if (!btn) return JSON.stringify({ error: 'нет кнопки очереди' });
      btn.click();
      opened = true;
      for (let i = 0; i < 25 && !findRoot(); i++) await sleep(150);
    }
    const close = () => {
      if (!opened) return;
      const dlg = document.querySelector('[role="dialog"][aria-modal="true"]');
      const c = dlg && Array.from(dlg.querySelectorAll('button')).find((b) => lbl(b) === 'Закрыть');
      if (c) c.click();
    };
    let root = findRoot();
    if (!root) { close(); return JSON.stringify({ error: 'панель очереди не появилась' }); }
    await sleep(opened ? 500 : 0);

    const playIdx = ${Number.isInteger(playIdx) ? playIdx : -1};
    if (playIdx >= 0) {
      const rows = getRows(root);
      const row = rows[playIdx];
      const pb = row && (row.querySelector('[class*="PlayButtonWithCover_playButton"]') || row.querySelector('button'));
      if (pb) { pb.click(); await sleep(800); }
      root = findRoot() || root;
    }

    const items = getRows(root).map((r, i) => {
      const tEl = r.querySelector('[class*="Meta_titleContainer"]');
      let title = tEl ? ((tEl.innerText || tEl.textContent || '').split('\\n')[0]).trim() : '';
      const img = r.querySelector('img');
      if (!title && img) title = (img.alt || '').replace(/^Трек\\s+/, '');
      const arts = Array.from(r.querySelectorAll('a[href*="/artist/"]')).map((a) => a.textContent.trim()).filter(Boolean);
      const artist = Array.from(new Set(arts)).join(', ');
      const cur = !!r.querySelector('[class*="root_current"]');
      return { i, title, artist, cur };
    });
    close();
    return JSON.stringify({ items });
  } catch (e) { return JSON.stringify({ error: String(e) }); }
})()`;

// Скрытое окно сайта одно, а кликаем мы в нём из разных мест (очередь, поиск, команды) —
// поэтому долгие операции выстраиваем в цепочку, чтобы они не мешали друг другу.
let siteChain = Promise.resolve();
function withSite(fn) {
  const p = siteChain.then(fn, fn);
  siteChain = p.catch(() => {});
  return p;
}

let queueBusy = false;
async function runQueue(playIdx) {
  if (!ymWin || ymWin.isDestroyed()) return [];
  if (queueBusy) return null; // уже читаем — оверлей повторит позже
  queueBusy = true;
  try {
    const json = await withSite(() => ymWin.webContents.executeJavaScript(QUEUE_JS(playIdx), true));
    const res = JSON.parse(json);
    if (res.error) { log('Очередь:', res.error); return []; }
    return res.items;
  } catch (err) {
    log('Очередь ошибка:', err.message);
    return [];
  } finally {
    queueBusy = false;
  }
}

// ───────────────────── Текст песни ─────────────────────
// Тексты берём из открытой базы LRCLIB (lrclib.net): там есть строки с таймкодами (как на сайте),
// а где их нет — обычный текст без подсветки. Запросы идут из этого процесса, не из сайта Яндекса.
const LRCLIB = 'https://lrclib.net/api';
const lyricsCache = new Map(); // key -> payload
let lyricsKey = '';
let lyricsWaitTicks = 0;
let lyricsSeq = 0;
let lyricsPayload = { key: '', status: 'idle' };
let playerPlaying = false;

function sendLyrics(p) {
  lyricsPayload = p;
  if (overlay && !overlay.isDestroyed()) overlay.webContents.send('lyrics', p);
}

// "[01:23.45] строка" → [{ t: 83.45, text }]
function parseLrc(text) {
  const out = [];
  let offset = 0;
  const re = /^\s*\[(\d+):(\d+(?:[.:]\d+)?)\]/;
  for (const raw of String(text || '').split(/\r?\n/)) {
    const stamps = [];
    let rest = raw;
    let m;
    while ((m = re.exec(rest))) {
      stamps.push(Number(m[1]) * 60 + Number(m[2].replace(':', '.')));
      rest = rest.slice(m[0].length);
    }
    if (!stamps.length) {
      const o = /^\s*\[offset:\s*([+-]?\d+)\s*\]/i.exec(raw);
      if (o) offset = Number(o[1]) / 1000;
      continue;
    }
    const txt = rest.replace(/<\d+:\d+(?:[.:]\d+)?>/g, '').trim(); // пословные метки <00:01.20>
    for (const t of stamps) out.push({ t, text: txt });
  }
  out.sort((a, b) => a.t - b.t);
  while (out.length && !out[out.length - 1].text) out.pop();
  return out.map((l) => ({ t: Math.max(0, Math.round((l.t - offset) * 100) / 100), text: l.text }));
}

async function lrclibGet(pathAndQuery) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 8000);
  try {
    const res = await net.fetch(LRCLIB + pathAndQuery, {
      headers: { 'User-Agent': 'YM-Overlay/0.1.0 (local app)' },
      signal: ctl.signal,
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

const normName = (s) => String(s || '').toLowerCase()
  .replace(/\(.*?\)|\[.*?\]/g, ' ')
  .replace(/[^\p{L}\p{N}]+/gu, ' ')
  .trim();

async function fetchLyrics(t) {
  const title = String(t.title || '').trim();
  const artists = String(t.artist || '').split(/,|&|\bfeat\.?\b/i).map((x) => x.trim()).filter(Boolean);
  const first = artists[0] || '';
  const dur = Math.round(t.duration) || 0;
  const qs = (o) => '?' + new URLSearchParams(o).toString();
  const nt = normName(title);

  const toPayload = (x) => {
    if (!x) return null;
    if (x.instrumental) return { status: 'instrumental' };
    const durOk = !dur || !x.duration || Math.abs(x.duration - dur) <= 6;
    const synced = x.syncedLyrics && durOk ? parseLrc(x.syncedLyrics) : [];
    if (synced.length > 1) return { status: 'ok', synced, plain: null, source: 'LRCLIB' };
    let plain = x.plainLyrics || '';
    if (!plain && x.syncedLyrics) plain = parseLrc(x.syncedLyrics).map((l) => l.text).join('\n');
    if (plain.trim()) return { status: 'ok', synced: null, plain: plain.trim(), source: 'LRCLIB' };
    return null;
  };

  const pick = (list) => {
    if (!Array.isArray(list)) return null;
    let best = null, bestScore = -1;
    for (const x of list) {
      if (!x || (!x.instrumental && !x.syncedLyrics && !x.plainLyrics)) continue;
      const xt = normName(x.trackName);
      if (nt && xt && !(xt === nt || xt.includes(nt) || nt.includes(xt))) continue;
      let sc = 0;
      if (x.syncedLyrics) sc += 4;
      if (xt === nt) sc += 3;
      if (first && normName(x.artistName).includes(normName(first))) sc += 3;
      if (dur && x.duration) {
        const d = Math.abs(x.duration - dur);
        sc += d <= 2 ? 4 : d <= 6 ? 2 : -2;
      }
      if (sc > bestScore) { best = x; bestScore = sc; }
    }
    return best;
  };

  // 1) точное совпадение по названию, исполнителю и длительности
  if (first && dur) {
    const exact = await lrclibGet('/get' + qs({ track_name: title, artist_name: first, duration: dur }));
    const p = toPayload(exact);
    if (p) return p;
  }
  // 2) поиск по названию и исполнителю, 3) общий поиск
  const tries = [];
  if (first) tries.push('/search' + qs({ track_name: title, artist_name: first }));
  tries.push('/search' + qs({ q: (first + ' ' + title).trim() }));
  for (const path of tries) {
    const best = pick(await lrclibGet(path));
    const p = toPayload(best);
    if (p) return p;
  }
  return { status: 'none' };
}

// вызывается из poll(): следит за сменой трека и запускает загрузку текста
function trackLyrics(st) {
  if (!st || !st.ready || st.empty || !st.title) {
    if (lyricsKey) { lyricsKey = ''; sendLyrics({ key: '', status: 'idle' }); }
    return;
  }
  const key = st.title + '|' + st.artist;
  if (key === lyricsKey) return;
  // длительность на старте трека бывает ещё 0 — немного подождём, она нужна для точного поиска
  if (!(st.duration > 0) && ++lyricsWaitTicks < 4) return;
  lyricsWaitTicks = 0;
  lyricsKey = key;
  const seq = ++lyricsSeq;
  const cached = lyricsCache.get(key);
  if (cached) { sendLyrics({ key, ...cached }); return; }
  sendLyrics({ key, status: 'loading' });
  fetchLyrics(st).then((p) => {
    if (lyricsCache.size > 100) lyricsCache.delete(lyricsCache.keys().next().value);
    lyricsCache.set(key, p);
    log('Текст песни:', key, '→', p.status, p.synced ? 'синхронный, строк ' + p.synced.length : '');
    if (seq === lyricsSeq) sendLyrics({ key, ...p });
  }).catch((err) => {
    log('Текст песни ошибка:', key, err.message);
    if (seq === lyricsSeq) sendLyrics({ key, status: 'error', error: err.message });
  });
}

// ───────────────────── Поиск ─────────────────────
// Ищем через поиск самого сайта (в скрытом окне, оно же продолжает играть музыку), забираем
// найденные треки со страницы результатов, а «играть» — это клик по кнопке трека на этой странице.
const ROWS_JS = `
  const rowsOf = () => {
    const inQueue = (r) => !!r.closest('[class*="PlayQueue_root"]');
    const rows = Array.from(document.querySelectorAll('[class*="CommonTrack_root"]'))
      .filter((r) => !inQueue(r) && !(r.parentElement && r.parentElement.closest('[class*="CommonTrack_root"]')));
    if (rows.length) return rows;
    // запасной вариант без привязки к названиям классов: строка трека = контейнер вокруг ссылки на трек
    const seen = new Set();
    const out = [];
    for (const a of Array.from(document.querySelectorAll('a[href*="/track/"]'))) {
      if (inQueue(a)) continue;
      let el = a;
      for (let i = 0; i < 7 && el.parentElement; i++) {
        const p = el.parentElement;
        const tracks = new Set(Array.from(p.querySelectorAll('a[href*="/track/"]')).map((x) => x.getAttribute('href')));
        if (tracks.size > 1) break;
        el = p;
        if (el.querySelector('a[href*="/artist/"]') && el.querySelector('img')) break;
      }
      if (!seen.has(el)) { seen.add(el); out.push(el); }
    }
    return out;
  };
  const sigOf = (r) => (r.textContent || '').slice(0, 40);
  const rowInfo = (r, i) => {
    const tEl = r.querySelector('[class*="Meta_titleContainer"]');
    let title = tEl ? ((tEl.innerText || tEl.textContent || '').split('\\n')[0]).trim() : '';
    const img = r.querySelector('img');
    if (!title) { const l = r.querySelector('a[href*="/track/"]'); if (l) title = ((l.innerText || l.textContent || '').split('\\n')[0]).trim(); }
    if (!title && img) title = (img.alt || '').replace(/^Трек\\s+/, '');
    const arts = Array.from(r.querySelectorAll('a[href*="/artist/"]')).map((a) => a.textContent.trim()).filter(Boolean);
    return { i, title, artist: Array.from(new Set(arts)).join(', '), cover: img ? String(img.src || '') : '' };
  };
`;

// вписываем запрос в поле поиска сайта и отправляем. Поле может появляться только на странице поиска —
// тогда сначала кликаем по ссылке/кнопке «Поиск» (переход внутри сайта, музыка не прерывается)
const SEARCH_SUBMIT_JS = (q) => `(async () => {
  try {
    ${ROWS_JS}
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const findInput = () => {
      const all = Array.from(document.querySelectorAll('input')).filter((i) => {
        const t = (i.type || 'text').toLowerCase();
        return t === 'text' || t === 'search';
      });
      const hit = all.filter((i) => /поиск|search|найти|искать/i.test([i.placeholder, i.getAttribute('aria-label'), i.getAttribute('role'), i.name].join(' ')));
      const vis = (list) => list.find((i) => i.offsetParent !== null) || list[0];
      return vis(hit) || (all.length === 1 ? all[0] : null);
    };
    let el = findInput();
    let opened = '';
    if (!el) {
      const searchish = (e) => /поиск|search/i.test([e.getAttribute('aria-label'), e.getAttribute('title'), (e.textContent || '').slice(0, 40)].join(' '));
      const opener = document.querySelector('a[href="/search"]')
        || document.querySelector('a[href^="/search"]')
        || Array.from(document.querySelectorAll('a,button,[role=button],[role=link]')).find((e) => (e.textContent || '').length < 40 && searchish(e));
      if (opener) {
        opened = (opener.tagName + ' ' + (opener.getAttribute('href') || opener.getAttribute('aria-label') || opener.textContent || '')).slice(0, 80);
        opener.click();
        for (let i = 0; i < 15 && !el; i++) { await sleep(200); el = findInput(); }
      }
    }
    if (!el) return JSON.stringify({ error: 'на сайте не найдено поле поиска', opened });
    el.focus();
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(el, ${JSON.stringify(q)});
    el.dispatchEvent(new Event('input', { bubbles: true }));
    const form = el.closest('form');
    if (form && form.requestSubmit) form.requestSubmit();
    ['keydown', 'keypress', 'keyup'].forEach((type) => el.dispatchEvent(new KeyboardEvent(type, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true })));
    return JSON.stringify({ ok: true, opened, sig: rowsOf().slice(0, 5).map(sigOf).join('|') });
  } catch (e) { return JSON.stringify({ error: String(e) }); }
})()`;

// ждём, пока сайт откроет результаты именно этого запроса, и забираем треки
const SEARCH_WAIT_JS = (q, sig, timeoutMs) => `(async () => {
  try {
    ${ROWS_JS}
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const norm = (s) => String(s).toLowerCase().replace(/[^\\p{L}\\p{N}]+/gu, '');
    const want = norm(${JSON.stringify(q)});
    const urlOk = () => { let u = location.href; try { u = decodeURIComponent(u.replace(/\\+/g, ' ')); } catch (e) { /* оставим как есть */ } return norm(u).includes(want); };
    const oldSig = ${JSON.stringify(sig)};
    const t0 = Date.now();
    let last = -1, stable = 0, routed = false;
    while (Date.now() - t0 < ${timeoutMs}) {
      await sleep(300);
      if (!urlOk()) continue;
      routed = true;
      const rows = rowsOf();
      const s = rows.slice(0, 5).map(sigOf).join('|');
      if (rows.length && (s !== oldSig || Date.now() - t0 > 4000)) {
        if (rows.length === last) { if (++stable >= 2) break; } else { stable = 0; last = rows.length; }
      }
    }
    if (!routed) return JSON.stringify({ route: false, url: location.href });
    return JSON.stringify({ route: true, items: rowsOf().slice(0, 30).map(rowInfo), url: location.href });
  } catch (e) { return JSON.stringify({ error: String(e) }); }
})()`;

const SEARCH_PLAY_JS = (idx, title, artist) => `(() => {
  try {
    ${ROWS_JS}
    const T = ${JSON.stringify(String(title))}, A = ${JSON.stringify(String(artist))};
    const same = (r) => { const x = rowInfo(r, 0); return x.title === T && x.artist === A; };
    const rows = rowsOf();
    let row = rows[${Number.isInteger(idx) ? idx : -1}];
    if (!row || !same(row)) row = rows.find(same);
    if (!row) return JSON.stringify({ notfound: true });
    const pb = row.querySelector('[class*="PlayButtonWithCover_playButton"]')
      || Array.from(row.querySelectorAll('button,[role=button]')).find((b) => /воспроизв|слушать|играть|play/i.test((b.getAttribute('aria-label') || '') + ' ' + (b.title || '')))
      || row.querySelector('button')
      || row.querySelector('img');
    if (!pb) return JSON.stringify({ error: 'у трека нет кнопки play' });
    pb.click();
    return JSON.stringify({ ok: true });
  } catch (e) { return JSON.stringify({ error: String(e) }); }
})()`;

let lastSearch = '';
async function runSearch(query) {
  const q = String(query || '').trim().slice(0, 200);
  if (!q) return { items: [] };
  if (!ymWin || ymWin.isDestroyed()) return { error: 'окно Яндекс Музыки недоступно' };
  return withSite(async () => {
    const wc = ymWin.webContents;
    const run = async (code) => JSON.parse(await wc.executeJavaScript(code, true));
    try {
      const sub = await run(SEARCH_SUBMIT_JS(q));
      if (sub.opened) log('Поиск: открыл поиск кликом по', sub.opened);
      let sig0 = sub.sig;
      if (sub.error) log('Поиск:', sub.error, '— пробую открыть страницу поиска напрямую');
      const sig = q === lastSearch ? '\u0000' : sig0;
      let res = sub.error ? { route: false } : await run(SEARCH_WAIT_JS(q, sig, 3500));
      if (res.route === false && !sub.error) {
        // форма не отправилась скриптом — пробуем настоящим нажатием Enter
        wc.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
        wc.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
        res = await run(SEARCH_WAIT_JS(q, sig, 6000));
      }
      if (res.route === false) {
        // последний вариант: открыть страницу поиска напрямую (это перезагружает сайт — текущий трек остановится)
        log('Поиск: открываю страницу поиска напрямую');
        await wc.loadURL(YM_URL + 'search?text=' + encodeURIComponent(q));
        res = await run(SEARCH_WAIT_JS(q, '\u0000', 12000));
      }
      if (res.error) { log('Поиск:', res.error); return { error: res.error }; }
      if (res.route === false) {
        log('Поиск: сайт не открыл результаты, url =', res.url);
        return { error: 'сайт не открыл результаты поиска. Открой Яндекс Музыку из трея и проверь, что ты вошёл в аккаунт' };
      }
      lastSearch = q;
      log('Поиск:', q, '→ найдено', res.items.length, res.items[0] ? '(первый: ' + res.items[0].title + ')' : '');
      return { items: res.items };
    } catch (err) {
      log('Поиск ошибка:', err.message);
      return { error: err.message };
    }
  });
}

async function runSearchPlay(query, idx, title, artist) {
  if (!ymWin || ymWin.isDestroyed()) return { error: 'окно Яндекс Музыки недоступно' };
  const attempt = () => withSite(async () => JSON.parse(await ymWin.webContents.executeJavaScript(SEARCH_PLAY_JS(idx, title, artist), true)));
  try {
    let r = await attempt();
    if (r.notfound) { // сайт успел уйти со страницы результатов — повторяем поиск и пробуем снова
      const s = await runSearch(query);
      if (s.error) return s;
      r = await attempt();
    }
    if (r.notfound) return { error: 'трек не найден в результатах' };
    if (r.error) { log('Поиск (play):', r.error); return r; }
    return { ok: true };
  } catch (err) {
    log('Поиск (play) ошибка:', err.message);
    return { error: err.message };
  }
}

// Отладка поиска: ищет тестовый запрос и пишет в лог, как выглядит страница результатов
async function diagnoseSearch() {
  const r = await runSearch('Imagine Dragons');
  log('ДИАГНОСТИКА ПОИСКА:', JSON.stringify(r).slice(0, 1500));
  try {
    const html = await withSite(() => ymWin.webContents.executeJavaScript(`(() => {
      ${ROWS_JS}
      const r = rowsOf()[0];
      if (r) return r.outerHTML.slice(0, 3000);
      const uniq = (a) => Array.from(new Set(a)).slice(0, 40);
      return 'строк нет; url: ' + location.href
        + '; поля ввода: ' + JSON.stringify(Array.from(document.querySelectorAll('input')).map((i) => ({ t: i.type, p: i.placeholder, a: i.getAttribute('aria-label') })))
        + '; ссылки: ' + JSON.stringify(uniq(Array.from(document.querySelectorAll('a[href]')).map((a) => a.getAttribute('href'))))
        + '; кнопки: ' + JSON.stringify(uniq(Array.from(document.querySelectorAll('button,[role=button]')).map((b) => (b.getAttribute('aria-label') || b.title || b.textContent || '').trim().slice(0, 30)).filter(Boolean)))
        + '; ширина окна: ' + window.innerWidth;
    })()`, true));
    log('ДИАГНОСТИКА ПОИСКА (первая строка):', html);
  } catch (err) {
    log('ДИАГНОСТИКА ПОИСКА ошибка:', err.message);
  }
  shell.openPath(logFile);
}

// ───────────────────── Команды плееру ─────────────────────
const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
const clickBar = (expr) => `(() => { ${BAR_JS}
  const bar = findBar(); if (!bar) return;
  const b = Array.from(bar.querySelectorAll('button')).find((x) => { const l = lbl(x); return ${expr}; });
  if (b) b.click();
})()`;
// выставить значение у ползунка сайта так, чтобы React это заметил
const setRange = (label, v) => `(() => {
  const el = document.querySelector('input[type=range][aria-label="${label}"]');
  if (!el) return;
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  set.call(el, ${v});
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
})()`;
const NOOP = () => 'void 0';
const COMMANDS = {
  toggle: () => clickBar("l === 'Пауза' || l === 'Воспроизведение'"),
  next: () => clickBar("l === 'Следующая песня'"),
  prev: () => clickBar("l === 'Предыдущая песня'"),
  like: () => clickBar("l === 'Нравится' || /из любимых|убрать|удалить/i.test(l)"),
  shuffle: () => clickBar("/перемеш|shuffle|случайн/i.test(l)"),
  repeat: () => clickBar("/повтор|repeat/i.test(l)"),
  seek: (v) => setRange('Управление таймкодом', Math.max(0, num(v))),
  volume: (v) => setRange('Управление громкостью', Math.min(1, Math.max(0, num(v, 1)))),
  play: NOOP,
};

ipcMain.handle('cmd', async (_e, name, arg) => {
  if (name === 'play') {
    await runQueue(Math.floor(num(arg, -1)));
    poll();
    return;
  }
  const build = COMMANDS[name];
  if (!build || !ymWin) return;
  try {
    await ymWin.webContents.executeJavaScript(build(arg), true);
  } catch (err) {
    log('cmd ошибка:', name, err.message);
  }
  poll();
});

ipcMain.handle('queue', () => runQueue(-1));

ipcMain.handle('search', (_e, q) => runSearch(q));
ipcMain.handle('search-play', async (_e, q, idx, title, artist) => {
  const res = await runSearchPlay(String(q || ''), Math.floor(num(idx, -1)), String(title || ''), String(artist || ''));
  poll();
  return res;
});

ipcMain.on('close-panel', () => setPanel(false));
ipcMain.on('hud-pos', (_e, pos) => {
  const x = Number(pos && pos.x), y = Number(pos && pos.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return;
  cfg.hudPos = { x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)) };
  saveConfig();
});
ipcMain.on('lyrics-ui', (_e, ui) => {
  if (!ui || typeof ui !== 'object') return;
  if (typeof ui.visible === 'boolean') cfg.lyricsVisible = ui.visible;
  if (typeof ui.pinned === 'boolean') cfg.lyricsPinned = ui.pinned;
  const p = ui.pos;
  if (p && Number.isFinite(Number(p.x)) && Number.isFinite(Number(p.y))) {
    const c01 = (v) => Math.min(1, Math.max(0, Number(v)));
    const size = (v) => (Number.isFinite(Number(v)) ? Math.min(4000, Math.max(150, Math.round(Number(v)))) : undefined);
    cfg.lyricsPos = { x: c01(p.x), y: c01(p.y), w: size(p.w), h: size(p.h) };
  }
  saveConfig();
  buildTrayMenu();
});
ipcMain.on('appearance', (_e, a) => {
  if (!a || typeof a !== 'object') return;
  if (a.reset) {
    cfg.theme = sanitizeTheme(DEFAULTS.theme);
    cfg.hudOpacity = DEFAULTS.hudOpacity;
    saveConfig();
    sendConfig();
    return;
  }
  if (a.theme && typeof a.theme === 'object') cfg.theme = sanitizeTheme({ ...cfg.theme, ...a.theme });
  if (a.hudOpacity !== undefined && Number.isFinite(Number(a.hudOpacity))) cfg.hudOpacity = Math.min(1, Math.max(0.2, Number(a.hudOpacity)));
  saveConfig();
});
function sendConfig() {
  if (overlay && !overlay.isDestroyed()) overlay.webContents.send('config', configForOverlay());
}
// закрепить окно с текстом поверх всех окон / открепить (тогда оно видно только при открытой панели)
function setLyricsPinned(on) {
  if (on) cfg.lyricsVisible = true;
  cfg.lyricsPinned = on;
  saveConfig();
  sendConfig();
  buildTrayMenu();
}
function resetLyricsPos() {
  cfg.lyricsPos = null;
  saveConfig();
  sendConfig();
}
function resetHudPos() {
  cfg.hudPos = null;
  saveConfig();
  if (overlay && !overlay.isDestroyed()) overlay.webContents.send('config', configForOverlay());
}
ipcMain.on('open-yandex', () => showYandex());

// ───────────────────── Оверлей ─────────────────────
function createOverlay() {
  const display = screen.getPrimaryDisplay();
  overlay = new BrowserWindow({
    ...display.bounds,
    transparent: true,
    frame: false,
    hasShadow: false,
    resizable: false,
    movable: false,
    skipTaskbar: true,
    focusable: false,
    show: false,
    alwaysOnTop: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  overlay.setAlwaysOnTop(true, 'screen-saver');
  overlay.setIgnoreMouseEvents(true, { forward: true });
  overlay.loadFile(path.join(__dirname, 'overlay.html'));

  overlay.webContents.on('did-finish-load', () => {
    log('Оверлей: страница загружена');
    overlay.webContents.send('config', configForOverlay());
    const known = {};
    for (const [k, v] of Object.entries(iconCache)) if (v) known[k] = v;
    if (Object.keys(known).length) overlay.webContents.send('icons', known);
    overlay.webContents.send('lyrics', lyricsPayload);
    overlay.showInactive();
    lastJson = ''; // отправить состояние заново, если оно ушло до загрузки оверлея
    poll();
  });

  // ошибки из самого оверлея (например, не сработал preload) тоже пишем в лог
  overlay.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) log('Оверлей (консоль):', message);
  });
  overlay.webContents.on('preload-error', (_e, p, err) => log('Оверлей: ОШИБКА preload', p, err && err.message));

  overlay.on('blur', () => {
    if (panelOpen && Date.now() - panelOpenedAt > 400) setPanel(false);
  });
}

function setPanel(open) {
  if (!overlay || overlay.isDestroyed() || panelOpen === open) return;
  panelOpen = open;
  if (open) {
    panelOpenedAt = Date.now();
    const d = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    overlay.setBounds(d.bounds);
    overlay.setIgnoreMouseEvents(false);
    overlay.setFocusable(true);
    overlay.focus();
  } else {
    overlay.blur();
    overlay.setFocusable(false);
    overlay.setIgnoreMouseEvents(true, { forward: true });
  }
  overlay.webContents.send('panel', open);
}

function setHud(visible) {
  cfg.hudVisible = visible;
  if (overlay && !overlay.isDestroyed()) overlay.webContents.send('hud', visible);
  buildTrayMenu();
}

// ───────────────────── Трей ─────────────────────
function buildTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: `Панель управления (${cfg.hotkeyPanel})`, click: () => setPanel(!panelOpen) },
    { label: 'Мини-плеер поверх окон', type: 'checkbox', checked: cfg.hudVisible, click: (i) => setHud(i.checked) },
    { label: 'Вернуть мини-плеер в угол (сбросить перетаскивание)', click: resetHudPos },
    { label: `Текст песни закреплён поверх окон (${cfg.hotkeyLyrics})`, type: 'checkbox', checked: !!(cfg.lyricsVisible && cfg.lyricsPinned), click: (i) => setLyricsPinned(i.checked) },
    { label: 'Вернуть окно текста на место', click: resetLyricsPos },
    { label: 'Открыть Яндекс Музыку (вход, поиск)', click: showYandex },
    { type: 'separator' },
    {
      label: 'Запускать вместе с Windows',
      type: 'checkbox',
      checked: app.getLoginItemSettings().openAtLogin,
      click: (i) => app.setLoginItemSettings({ openAtLogin: i.checked }),
    },
    { label: 'Папка с настройками', click: () => shell.showItemInFolder(cfgFile) },
    { type: 'separator' },
    {
      label: 'Отладка: DevTools Яндекса',
      click: () => { if (ymWin) ymWin.webContents.openDevTools({ mode: 'detach' }); },
    },
    { label: 'Отладка: собрать данные о плеере (запусти трек!)', click: diagnose },
    { label: 'Отладка: данные об очереди (запусти трек из плейлиста!)', click: diagnoseQueue },
    { label: 'Отладка: данные о поиске (тестовый запрос)', click: diagnoseSearch },
    { label: 'Отладка: открыть лог', click: () => shell.openPath(logFile) },
    { type: 'separator' },
    { label: 'Выход', click: () => { quitting = true; app.quit(); } },
  ]));
}

function createTray() {
  const img = nativeImage.createFromPath(ICON).resize({ width: 16, height: 16 });
  tray = new Tray(img);
  tray.setToolTip('YM Overlay');
  tray.on('click', () => setPanel(!panelOpen));
  buildTrayMenu();
}

// ───────────────────── Запуск ─────────────────────
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => setPanel(true));

  app.whenReady().then(() => {
    loadConfig();
    log('Запуск. Electron', process.versions.electron);
    createYandexWindow();
    createOverlay();
    createTray();

    const okPanel = globalShortcut.register(cfg.hotkeyPanel, () => setPanel(!panelOpen));
    const okHud = globalShortcut.register(cfg.hotkeyHud, () => setHud(!cfg.hudVisible));
    const okLy = globalShortcut.register(cfg.hotkeyLyrics, () => setLyricsPinned(!(cfg.lyricsVisible && cfg.lyricsPinned)));
    if (!okLy) log('Не удалось занять хоткей', cfg.hotkeyLyrics, '— измени его в config.json');
    if (!okPanel) log('Не удалось занять хоткей', cfg.hotkeyPanel, '— измени его в config.json');
    if (!okHud) log('Не удалось занять хоткей', cfg.hotkeyHud, '— измени его в config.json');

    setInterval(poll, 500);
  });

  app.on('before-quit', () => { quitting = true; });
  app.on('will-quit', () => globalShortcut.unregisterAll());
  app.on('window-all-closed', () => { /* живём в трее */ });
}