const {
  app, BrowserWindow, globalShortcut, ipcMain, screen, Tray, Menu, nativeImage, shell,
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

let queueBusy = false;
async function runQueue(playIdx) {
  if (!ymWin || ymWin.isDestroyed()) return [];
  if (queueBusy) return null; // уже читаем — оверлей повторит позже
  queueBusy = true;
  try {
    const json = await ymWin.webContents.executeJavaScript(QUEUE_JS(playIdx), true);
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

ipcMain.on('close-panel', () => setPanel(false));
ipcMain.on('hud-pos', (_e, pos) => {
  const x = Number(pos && pos.x), y = Number(pos && pos.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return;
  cfg.hudPos = { x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)) };
  saveConfig();
});
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
    if (!okPanel) log('Не удалось занять хоткей', cfg.hotkeyPanel, '— измени его в config.json');
    if (!okHud) log('Не удалось занять хоткей', cfg.hotkeyHud, '— измени его в config.json');

    setInterval(poll, 500);
  });

  app.on('before-quit', () => { quitting = true; });
  app.on('will-quit', () => globalShortcut.unregisterAll());
  app.on('window-all-closed', () => { /* живём в трее */ });
}