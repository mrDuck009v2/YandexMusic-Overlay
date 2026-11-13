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
  startUrl: 'https://music.yandex.ru/collection', // что открывать в скрытом окне при запуске (на «полной» странице подгружается весь плеер)
  playlists: [],                           // добавленные в оверлей плейлисты/альбомы/исполнители: [{ title, url, cover }]
  discord: { enabled: true, clientId: '', button: true }, // статус «Слушает…» в профиле Discord; clientId — необязательный свой Application ID (по умолчанию берётся встроенный)
};

const { DiscordPresence, buildActivity } = require('./discord-rpc');

// Встроенный Application ID Discord. Его нужно завести ОДИН раз (разработчику, не пользователю):
// https://discord.com/developers/applications → New Application → назови «Яндекс Музыка»
// (это название увидят друзья в «Слушает …») → скопируй Application ID и вставь сюда.
// После этого у всех, кто запускает приложение, статус работает сам, без настройки.
const DEFAULT_DISCORD_CLIENT_ID = '1570780746979737640';
const discordClientId = () => cfg.discord.clientId || DEFAULT_DISCORD_CLIENT_ID;

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

function sanitizeDiscord(d) {
  d = d && typeof d === 'object' ? d : {};
  const id = String(d.clientId || '').trim();
  return { enabled: !!d.enabled, clientId: /^\d{17,20}$/.test(id) ? id : '', button: d.button !== false };
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
    playlists: cfg.playlists,
    discord: { ...cfg.discord, builtinId: !!DEFAULT_DISCORD_CLIENT_ID },
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
  cfg.playlists = sanitizePins(user.playlists);
  cfg.discord = sanitizeDiscord({ ...DEFAULTS.discord, ...(user.discord || {}) });
  // раньше статус был выключен по умолчанию и требовал ручной настройки: если свой ID не вводили — включаем автоматически (один раз)
  if (!user.discordAuto) {
    if (!cfg.discord.clientId) cfg.discord.enabled = true;
    cfg.discordAuto = true;
  }
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
  ymWin.loadURL(startUrl()).catch((err) => log('Яндекс: loadURL ошибка', err.message));

  ymWin.webContents.on('did-finish-load', () => {
    log('Яндекс: страница загружена', ymWin.webContents.getURL());
    ymRetryCount = 0;
    clearTimeout(ymRetryTimer);
    ymRetryTimer = null;
  });
  ymWin.webContents.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
    log('Яндекс: ОШИБКА загрузки', code, desc, url);
    if (!isMainFrame || code === -3) return; // -3 — загрузку прервали сами (например, перешли на другую страницу)
    // при старте системы интернета может ещё не быть — пробуем снова с растущей паузой, пока не получится
    ymRetryCount++;
    const delay = Math.min(30000, 2000 * 2 ** Math.min(ymRetryCount, 5));
    clearTimeout(ymRetryTimer);
    ymRetryTimer = setTimeout(() => reloadYandex('нет связи, попытка ' + ymRetryCount), delay);
  });

  ymWin.on('close', (e) => {
    if (!quitting) {
      e.preventDefault();
      ymWin.hide();
    }
  });

  if (firstRun) ymWin.show();
}

let ymRetryTimer = null;
let ymRetryCount = 0;
let notReadyTicks = 0;
let ymAutoReloads = 0;

function startUrl() {
  const u = String(cfg.startUrl || '');
  return /^https:\/\/music\.yandex\.(ru|com|by|kz|uz)\//.test(u) ? u : DEFAULTS.startUrl;
}

// «Перезапуск Яндекс Музыки» — заново загружаем сайт в скрытом окне (вход в аккаунт сохраняется)
function reloadYandex(why) {
  if (!ymWin || ymWin.isDestroyed()) return;
  clearTimeout(ymRetryTimer);
  ymRetryTimer = null;
  notReadyTicks = 0;
  log('Яндекс: перезапуск —', why);
  ymWin.loadURL(startUrl()).catch((err) => log('Яндекс: loadURL ошибка', err.message));
}
ipcMain.on('reload-ym', () => reloadYandex('кнопка'));

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
    // если плеер так и не появился (сайт загрузился криво) — перезагружаем сайт, но не больше трёх раз подряд
    if (st.ready) { notReadyTicks = 0; ymAutoReloads = 0; } else notReadyTicks++;
    if (notReadyTicks > 80 && ymAutoReloads < 3 && !ymWin.isVisible() && /music\.yandex\./.test(ymWin.webContents.getURL())) {
      ymAutoReloads++;
      reloadYandex('плеер не появился за 40 секунд (' + ymAutoReloads + ')');
    }
    ensureIcons(st.icons);
    playerPlaying = !!st.playing;
    trackLyrics(st);
    discordSync(st);
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

// ───────────────────── Поиск, плейлисты, запуск по ссылке ─────────────────────
// Всё, что нужно «прочитать» с сайта (результаты поиска, список плейлистов, название по ссылке), читаем во втором,
// скрытом и беззвучном окне: так музыка в основном окне не прерывается. А играть начинаем в основном окне:
// открываем страницу трека/альбома/плейлиста и нажимаем на ней «слушать».
const SITE_HOST = /^music\.yandex\.(ru|com|by|kz|uz)$/;

// ссылка на страницу сайта → «чистая» (без ?utm и #), иначе пустая строка
function cleanSiteUrl(u) {
  try {
    const x = new URL(String(u || '').trim());
    if (x.protocol !== 'https:' || !SITE_HOST.test(x.hostname)) return '';
    return x.origin + x.pathname.replace(/\/+$/, '');
  } catch { return ''; }
}

function entityTypeOf(u) {
  try {
    const p = new URL(u).pathname.split('/').filter(Boolean);
    if (p[0] === 'album' && p[2] === 'track') return 'track';
    if (p[0] === 'album') return 'album';
    if (p[0] === 'artist') return 'artist';
    if (p.includes('playlists')) return 'playlist';
    if (p[0] === 'rotor') return 'wave';
  } catch { /* не ссылка */ }
  return 'other';
}

function sanitizePins(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const x of list) {
    const url = cleanSiteUrl(x && x.url);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push({
      type: entityTypeOf(url),
      title: String((x && x.title) || url).slice(0, 120),
      url,
      cover: typeof (x && x.cover) === 'string' && /^https:\/\//.test(x.cover) ? x.cover.slice(0, 300) : '',
    });
    if (out.length >= 100) break;
  }
  return out;
}

// второе окно: тот же аккаунт (partition), но звук выключен и показывать его не нужно
let sbWin = null;
let sbTimer = null;
let sbChain = Promise.resolve();
function withScraper(fn) {
  const p = sbChain.then(fn, fn);
  sbChain = p.catch(() => {});
  return p;
}
function getScraper() {
  if (sbWin && !sbWin.isDestroyed()) return sbWin;
  sbWin = new BrowserWindow({
    width: 1200,
    height: 900,
    show: false,
    webPreferences: {
      partition: 'persist:ym',
      backgroundThrottling: false,
      autoplayPolicy: 'document-user-activation-required',
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  const ua = sbWin.webContents.getUserAgent().split(' ').filter((t) => !/^(Electron|ym-overlay|YMOverlay)\//i.test(t)).join(' ');
  sbWin.webContents.setUserAgent(ua);
  sbWin.webContents.setAudioMuted(true);
  sbWin.on('closed', () => { sbWin = null; });
  return sbWin;
}
function scheduleScraperClose() {
  clearTimeout(sbTimer);
  sbTimer = setTimeout(() => { if (sbWin && !sbWin.isDestroyed()) sbWin.destroy(); sbWin = null; }, 90000);
}
// открыть страницу во втором окне и выполнить на ней скрипт (он вернёт JSON-строку)
function scrapeWith(url, js) {
  return withScraper(async () => {
    const win = getScraper();
    try {
      try { await win.loadURL(url); } catch (e) { if (!/ERR_ABORTED/.test(String(e && e.message))) throw e; }
      return JSON.parse(await win.webContents.executeJavaScript(js, true));
    } finally {
      scheduleScraperClose();
    }
  });
}
const netErr = (err) => (/ERR_INTERNET|ERR_NAME_NOT|ERR_NETWORK|ERR_CONNECTION|ERR_TIMED/.test(String(err && err.message)) ? 'нет интернета' : String((err && err.message) || err));

// Скрипт для страницы: собирает со страницы треки, альбомы, плейлисты и исполнителей. Опирается не на названия CSS-классов,
// а на адреса ссылок (/album/…/track/…, /album/…, /artist/…, /playlists/…), поэтому переживает смену вёрстки.
const ENT_LIB = `
    const SKIP = '[class*="PlayerBar"],[class*="PlayQueue"],[class*="FullscreenPlayer"],[class*="SyncLyrics"]';
    const NL = String.fromCharCode(10);
    const isNum = (s) => s !== undefined && s !== '' && !isNaN(Number(s));
    const cache = new Map();
    const classify = (href) => {
      if (cache.has(href)) return cache.get(href);
      let res = null;
      try {
        const u = new URL(href, location.href);
        if (u.hostname.indexOf('music.yandex.') === 0) {
          const p = u.pathname.split('/').filter(Boolean);
          const o = u.origin;
          if (p[0] === 'album' && isNum(p[1]) && p[2] === 'track' && isNum(p[3]) && p.length === 4) res = { type: 'track', key: 'track:' + p[3], url: o + '/album/' + p[1] + '/track/' + p[3] };
          else if (p[0] === 'album' && isNum(p[1]) && p.length === 2) res = { type: 'album', key: 'album:' + p[1], url: o + '/album/' + p[1] };
          else if (p[0] === 'artist' && isNum(p[1]) && p.length === 2) res = { type: 'artist', key: 'artist:' + p[1], url: o + '/artist/' + p[1] };
          else if (p[0] === 'playlists' && p.length === 2) res = { type: 'playlist', key: 'playlist:' + p[1], url: o + '/playlists/' + p[1] };
          else if (p[0] === 'users' && p[2] === 'playlists' && p.length === 4) res = { type: 'playlist', key: 'playlist:' + p[1] + '/' + p[3], url: o + '/users/' + p[1] + '/playlists/' + p[3] };
        }
      } catch (e) { /* не ссылка */ }
      cache.set(href, res);
      return res;
    };
    const firstLine = (el) => ((el.innerText || el.textContent || '').split(NL).map((s) => s.trim()).filter(Boolean)[0] || '');
    const build = (lim) => {
      const groups = new Map();
      for (const a of document.querySelectorAll('a[href]')) {
        if (a.closest(SKIP)) continue;
        const info = classify(a.getAttribute('href'));
        if (!info) continue;
        if (!groups.has(info.key)) groups.set(info.key, { info, anchors: [] });
        groups.get(info.key).anchors.push(a);
      }
      const claimed = [];
      const inClaimed = (el) => claimed.some((c) => c.contains(el));
      const out = { track: [], album: [], playlist: [], artist: [] };
      const limit = lim || { track: 40, album: 20, playlist: 24, artist: 20 };
      // сначала треки, потом альбомы, плейлисты, исполнители: ссылка на исполнителя внутри строки трека — это не «исполнитель» в выдаче
      for (const type of ['track', 'album', 'playlist', 'artist']) {
        for (const g of groups.values()) {
          if (g.info.type !== type || out[type].length >= limit[type]) continue;
          const anchors = g.anchors.filter((a) => !inClaimed(a));
          if (!anchors.length) continue;
          let el = anchors[0];
          for (let i = 0; i < 7 && el.parentElement; i++) {
            const par = el.parentElement;
            let other = false;
            const links = par.querySelectorAll('a[href]');
            for (const a of links) {
              const c = classify(a.getAttribute('href'));
              if (c && c.type === type && c.key !== g.info.key) { other = true; break; }
            }
            if (other || links.length > 14 || par.querySelectorAll('img').length > 3) break;
            el = par;
          }
          let title = '';
          for (const a of anchors) { title = firstLine(a) || a.getAttribute('aria-label') || a.getAttribute('title') || ''; if (title) break; }
          const img = el.querySelector('img');
          if (!title && img) title = (img.alt || '').trim();
          if (!title) continue;
          let subtitle = '';
          if (type === 'track' || type === 'album') {
            const names = [];
            for (const a of el.querySelectorAll('a[href]')) {
              const c = classify(a.getAttribute('href'));
              if (c && c.type === 'artist') { const t = firstLine(a); if (t && names.indexOf(t) < 0) names.push(t); }
            }
            subtitle = names.join(', ');
          }
          claimed.push(el);
          out[type].push({ type, title, subtitle, url: g.info.url, cover: img ? String(img.currentSrc || img.src || '') : '' });
        }
      }
      return out;
    };
    const count = (o) => o.track.length + o.album.length + o.playlist.length + o.artist.length;
`;

const ENTITIES_JS = (maxMs, scrolls) => `(async () => {
  try {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    if (location.hostname.indexOf('passport') >= 0) return JSON.stringify({ error: 'нужно войти в аккаунт: открой Яндекс Музыку из трея и войди' });
    ${ENT_LIB}
    const scrollAll = () => {
      const els = [document.scrollingElement].concat(Array.from(document.querySelectorAll('div,main,section'))
        .filter((e) => e.scrollHeight > e.clientHeight + 80 && /(auto|scroll)/.test(getComputedStyle(e).overflowY)).slice(0, 8));
      els.forEach((e) => { if (e) e.scrollTop = e.scrollHeight; });
    };
    const t0 = Date.now();
    let last = -1, stable = 0, done = 0, out = build();
    while (Date.now() - t0 < ${Number(maxMs)}) {
      await sleep(400);
      out = build();
      const n = count(out);
      if (n > 0 && n === last) stable++; else stable = 0;
      last = n;
      if (stable >= 2) {
        if (done < ${Number(scrolls)}) { done++; scrollAll(); stable = 0; await sleep(500); continue; }
        break;
      }
    }
    out = build();
    return JSON.stringify({ items: out, url: location.href, title: document.title });
  } catch (e) { return JSON.stringify({ error: String(e) }); }
})()`;

// Все треки страницы (плейлист, альбом, исполнитель). Список на сайте подгружается по мере прокрутки,
// поэтому листаем страницу вниз и собираем треки по ходу.
const TRACKS_JS = (maxMs) => `(async () => {
  try {
    ${ENT_LIB}
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const seen = new Map();
    const merge = () => {
      const o = build({ track: 5000, album: 0, playlist: 0, artist: 0 });
      let added = 0;
      for (const it of o.track) if (!seen.has(it.url)) { seen.set(it.url, it); added++; }
      return added;
    };
    const scrollable = (e) => e.scrollHeight > e.clientHeight + 80 && /(auto|scroll)/.test(getComputedStyle(e).overflowY);
    const pick = () => {
      let best = null, bestH = 0;
      const cands = [document.scrollingElement].concat(Array.from(document.querySelectorAll('div,main,section')).filter(scrollable)).filter(Boolean);
      for (const e of cands) {
        const h = e.scrollHeight - e.clientHeight;
        if (h > bestH && e.querySelector('a[href*="/track/"]')) { best = e; bestH = h; }
      }
      return best;
    };
    const t0 = Date.now();
    while (Date.now() - t0 < 9000 && !seen.size) { await sleep(400); merge(); }
    let idle = 0;
    while (Date.now() - t0 < ${Number(maxMs)} && idle < 4) {
      const sc = pick();
      if (!sc) break;
      const before = sc.scrollTop;
      sc.scrollTop = before + Math.max(300, sc.clientHeight * 0.8);
      await sleep(450);
      const added = merge();
      const atEnd = sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 4 || sc.scrollTop === before;
      if (added === 0) idle++; else idle = 0;
      if (atEnd && added === 0) break;
    }
    const h1 = document.querySelector('h1');
    return JSON.stringify({ items: Array.from(seen.values()).slice(0, 500), title: h1 ? (h1.innerText || '').split(NL)[0].trim() : '', url: location.href });
  } catch (e) { return JSON.stringify({ error: String(e) }); }
})()`;

// Нажать «играть» у конкретного трека в списке на открытой странице (так очередью становится сам плейлист)
const PLAY_IN_LIST_JS = (trackId) => `(async () => {
  try {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const BAD = '[class*="PlayerBar"],[class*="PlayQueue"],[class*="FullscreenPlayer"]';
    const id = ${JSON.stringify(String(trackId))};
    const DIG = '0123456789';
    const hasTrack = (h) => { h = h || ''; const i = h.indexOf('/track/' + id); return i >= 0 && DIG.indexOf(h.charAt(i + 7 + id.length) || 'x') < 0; };
    const link = () => Array.from(document.querySelectorAll('a[href]')).find((a) => hasTrack(a.getAttribute('href')) && !a.closest(BAD));
    const usesPlay = (b) => Array.from(b.querySelectorAll('use')).some((u) => {
      const h = u.getAttribute('href') || u.getAttribute('xlink:href') || '';
      const k = h.indexOf('#') >= 0 ? h.slice(h.indexOf('#') + 1) : '';
      return k === 'play' || k.indexOf('play_') === 0;
    });
    const scrollable = (e) => e.scrollHeight > e.clientHeight + 80 && /(auto|scroll)/.test(getComputedStyle(e).overflowY);
    const scroller = () => {
      let best = null, bestH = 0;
      const cands = [document.scrollingElement].concat(Array.from(document.querySelectorAll('div,main,section')).filter(scrollable)).filter(Boolean);
      for (const e of cands) { const h = e.scrollHeight - e.clientHeight; if (h > bestH && e.querySelector('a[href*="/track/"]')) { best = e; bestH = h; } }
      return best;
    };
    let a = link();
    const t0 = Date.now();
    while (!a && Date.now() - t0 < 4000) { await sleep(300); a = link(); }
    if (!a) { // трек может быть ниже в списке — листаем сверху вниз
      const sc = scroller();
      if (sc) {
        sc.scrollTop = 0;
        for (let i = 0; i < 60 && !a; i++) {
          await sleep(350);
          a = link();
          if (a) break;
          const before = sc.scrollTop;
          sc.scrollTop = before + Math.max(300, sc.clientHeight * 0.8);
          if (sc.scrollTop === before) break;
        }
      }
    }
    if (!a) return JSON.stringify({ notfound: true });
    let row = a;
    for (let i = 0; i < 7 && row.parentElement; i++) {
      const par = row.parentElement;
      const others = Array.from(par.querySelectorAll('a[href*="/track/"]')).filter((x) => !hasTrack(x.getAttribute('href')));
      if (others.length || par.querySelectorAll('a[href]').length > 14 || par.querySelectorAll('img').length > 3) break;
      row = par;
    }
    row.scrollIntoView({ block: 'center' });
    await sleep(300);
    const pb = row.querySelector('[class*="PlayButtonWithCover_playButton"]')
      || Array.from(row.querySelectorAll('button,[role="button"]')).find(usesPlay)
      || row.querySelector('button');
    if (!pb) return JSON.stringify({ notfound: true });
    pb.click();
    return JSON.stringify({ ok: true });
  } catch (e) { return JSON.stringify({ error: String(e) }); }
})()`;

// Название и обложка страницы (для добавления плейлиста по ссылке)
const META_JS = `(async () => {
  try {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    if (location.hostname.indexOf('passport') >= 0) return JSON.stringify({ error: 'нужно войти в аккаунт: открой Яндекс Музыку из трея и войди' });
    const meta = (n) => { const m = document.querySelector('meta[property="' + n + '"]') || document.querySelector('meta[name="' + n + '"]'); return m ? (m.getAttribute('content') || '') : ''; };
    const t0 = Date.now();
    while (Date.now() - t0 < 8000 && !document.querySelector('h1') && !meta('og:title')) await sleep(300);
    const h1 = document.querySelector('h1');
    const NL = String.fromCharCode(10);
    return JSON.stringify({ h1: h1 ? (h1.innerText || '').split(NL)[0].trim() : '', ogTitle: meta('og:title'), docTitle: document.title, cover: meta('og:image'), url: location.href });
  } catch (e) { return JSON.stringify({ error: String(e) }); }
})()`;

// Список ссылок страницы — для отладки, если ничего не нашлось
const LINKS_JS = `(() => JSON.stringify({
  url: location.href,
  title: document.title,
  links: Array.from(new Set(Array.from(document.querySelectorAll('a[href]')).map((a) => a.getAttribute('href')))).slice(0, 80),
  imgs: document.querySelectorAll('img').length,
}))()`;

// Нажать на странице «слушать» (кнопка у заголовка трека/альбома/плейлиста/исполнителя)
const PLAY_PAGE_JS = `(async () => {
  try {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const BAD = '[class*="PlayerBar"],[class*="PlayQueue"],[class*="FullscreenPlayer"],[class*="CommonTrack_root"],[class*="Navbar"]';
    const usesPlay = (b) => Array.from(b.querySelectorAll('use')).some((u) => {
      const h = u.getAttribute('href') || u.getAttribute('xlink:href') || '';
      const id = h.indexOf('#') >= 0 ? h.slice(h.indexOf('#') + 1) : '';
      return id === 'play' || id.indexOf('play_') === 0;
    });
    const label = (b) => ((b.getAttribute('aria-label') || '') + ' ' + (b.title || '') + ' ' + (b.textContent || '').slice(0, 40)).toLowerCase();
    const textPlay = (b) => /слушать|воспроизв|играть|запустить|включить/.test(label(b));
    const find = () => {
      const all = Array.from(document.querySelectorAll('button,[role="button"]')).filter((b) => !b.closest(BAD) && b.offsetParent !== null && !b.disabled);
      return all.find(usesPlay) || all.find(textPlay) || null;
    };
    let btn = null;
    const t0 = Date.now();
    while (!btn && Date.now() - t0 < 12000) { btn = find(); if (!btn) await sleep(300); }
    if (!btn) {
      const row = document.querySelector('[class*="CommonTrack_root"]');
      const pb = row && (row.querySelector('[class*="PlayButtonWithCover_playButton"]') || row.querySelector('button'));
      if (pb) { pb.click(); return JSON.stringify({ ok: true, via: 'первый трек в списке' }); }
      return JSON.stringify({ error: 'не нашёл на странице кнопку воспроизведения' });
    }
    btn.click();
    return JSON.stringify({ ok: true, via: (btn.getAttribute('aria-label') || btn.textContent || 'кнопка').trim().slice(0, 40) });
  } catch (e) { return JSON.stringify({ error: String(e) }); }
})()`;

async function runSearch(query) {
  const q = String(query || '').trim().slice(0, 200);
  if (!q) return { items: { track: [], album: [], playlist: [], artist: [] } };
  try {
    const r = await scrapeWith(YM_URL + 'search?text=' + encodeURIComponent(q), ENTITIES_JS(9000, 0));
    if (r.error) { log('Поиск:', r.error); return { error: r.error }; }
    const n = r.items;
    log('Поиск:', q, '→ треков', n.track.length, ', альбомов', n.album.length, ', исполнителей', n.artist.length, ', плейлистов', n.playlist.length);
    return { items: n };
  } catch (err) {
    log('Поиск ошибка:', err.message);
    return { error: netErr(err) };
  }
}

let myPlCache = { at: 0, items: [] };
async function runMyPlaylists(force) {
  if (!force && myPlCache.items.length && Date.now() - myPlCache.at < 5 * 60 * 1000) return { items: myPlCache.items };
  try {
    for (const pth of ['collection', 'collection/playlists']) {
      const r = await scrapeWith(YM_URL + pth, ENTITIES_JS(12000, 3));
      if (r.error) { log('Плейлисты:', r.error); return { error: r.error }; }
      log('Плейлисты:', pth, '→', r.items.playlist.length, 'шт.');
      if (r.items.playlist.length) {
        myPlCache = { at: Date.now(), items: r.items.playlist };
        return { items: r.items.playlist };
      }
    }
    return { items: [] };
  } catch (err) {
    log('Плейлисты ошибка:', err.message);
    return { error: netErr(err) };
  }
}

function cleanTitle(t) {
  return String(t || '').replace(/\s+/g, ' ')
    .replace(/^(Плейлист|Альбом|Исполнитель)\s*[«"](.+?)[»"].*$/i, '$2')
    .replace(/\s*[—–-]\s*(слушать|listen).*$/i, '')
    .replace(/\s*(на|в|on)\s+Яндекс\s*Музык\S*\s*$/i, '')
    .trim().slice(0, 120);
}
function fixCover(c) {
  let u = String(c || '').replace('%%', '400x400');
  if (u.startsWith('//')) u = 'https:' + u;
  return /^https:\/\//.test(u) ? u : '';
}

async function pinAdd(item) {
  const url = cleanSiteUrl(item && item.url);
  if (!url) return { error: 'это не ссылка на Яндекс Музыку (нужна вида music.yandex.ru/…)' };
  const existing = cfg.playlists.find((p) => p.url === url);
  if (existing) return { ok: true, existed: true, item: existing };
  let title = String((item && item.title) || '').trim();
  let cover = fixCover(item && item.cover);
  if (!title) {
    try {
      const m = await scrapeWith(url, META_JS);
      if (m.error) return { error: m.error };
      title = cleanTitle(m.h1 || m.ogTitle || m.docTitle);
      cover = cover || fixCover(m.cover);
    } catch (err) {
      return { error: 'не удалось открыть ссылку: ' + netErr(err) };
    }
  }
  if (!title) title = url.replace(/^https:\/\/[^/]+/, '');
  cfg.playlists = sanitizePins([...cfg.playlists, { url, title, cover }]);
  saveConfig();
  sendConfig();
  log('Плейлисты: добавлено', title, url);
  return { ok: true, item: cfg.playlists.find((p) => p.url === url) };
}

async function playUrl(url) {
  const u = cleanSiteUrl(url);
  if (!u) return { error: 'это не ссылка на Яндекс Музыку' };
  if (!ymWin || ymWin.isDestroyed()) return { error: 'окно Яндекс Музыки недоступно' };
  return withSite(async () => {
    const wc = ymWin.webContents;
    try {
      try { await wc.loadURL(u); } catch (e) { if (!/ERR_ABORTED/.test(String(e && e.message))) throw e; }
      const r = JSON.parse(await wc.executeJavaScript(PLAY_PAGE_JS, true));
      if (r.error) { log('Воспроизведение:', u, '—', r.error); return { error: r.error }; }
      log('Воспроизведение:', u, '— нажато:', r.via);
      return { ok: true };
    } catch (err) {
      log('Воспроизведение ошибка:', err.message);
      return { error: netErr(err) };
    }
  });
}

const tracksCache = new Map(); // url -> { at, data }
async function runTracks(url, force) {
  const u = cleanSiteUrl(url);
  if (!u) return { error: 'это не ссылка на Яндекс Музыку' };
  const c = tracksCache.get(u);
  if (!force && c && Date.now() - c.at < 5 * 60 * 1000) return c.data;
  try {
    const r = await scrapeWith(u, TRACKS_JS(25000));
    if (r.error) { log('Список треков:', r.error); return { error: r.error }; }
    const data = { items: r.items, title: cleanTitle(r.title) };
    log('Список треков:', u, '→', r.items.length, 'шт.');
    if (r.items.length) tracksCache.set(u, { at: Date.now(), data });
    return data;
  } catch (err) {
    log('Список треков ошибка:', err.message);
    return { error: netErr(err) };
  }
}

// Включить конкретный трек из плейлиста/альбома. Если не вышло «внутри списка» — открываем страницу самого трека.
async function playTrackInList(listUrl, trackUrl) {
  const lu = cleanSiteUrl(listUrl), tu = cleanSiteUrl(trackUrl);
  const m = /\/track\/(\d+)/.exec(tu || '');
  if (!lu || !m) return playUrl(trackUrl);
  if (!ymWin || ymWin.isDestroyed()) return { error: 'окно Яндекс Музыки недоступно' };
  const r = await withSite(async () => {
    const wc = ymWin.webContents;
    try {
      let cur = '';
      try { const x = new URL(wc.getURL()); cur = x.origin + x.pathname.replace(/\/+$/, ''); } catch { /* нет страницы */ }
      if (cur !== lu) {
        try { await wc.loadURL(lu); } catch (e) { if (!/ERR_ABORTED/.test(String(e && e.message))) throw e; }
      }
      return JSON.parse(await wc.executeJavaScript(PLAY_IN_LIST_JS(m[1]), true));
    } catch (err) {
      log('Трек из списка ошибка:', err.message);
      return { error: netErr(err) };
    }
  });
  if (r && r.ok) { log('Трек из списка: играет', tu, 'в', lu); return { ok: true }; }
  log('Трек из списка: не нашёл строку трека (', r && (r.error || 'notfound'), '), открываю страницу трека');
  return playUrl(tu);
}

// Отладка: что находится на странице поиска и коллекции
async function diagnoseSearch() {
  const r = await runSearch('Imagine Dragons');
  let brief = r;
  if (r.items) {
    brief = {};
    for (const [k, v] of Object.entries(r.items)) brief[k] = v.length + ': ' + v.slice(0, 3).map((x) => x.title + ' — ' + x.subtitle + ' | ' + x.url).join(' ; ');
  }
  log('ДИАГНОСТИКА ПОИСКА:', JSON.stringify(brief).slice(0, 3000));
  try {
    const l = await scrapeWith(YM_URL + 'search?text=' + encodeURIComponent('Imagine Dragons'), LINKS_JS);
    log('ДИАГНОСТИКА ПОИСКА (ссылки страницы):', JSON.stringify(l).slice(0, 4000));
  } catch (err) { log('ДИАГНОСТИКА ПОИСКА ошибка:', err.message); }
  shell.openPath(logFile);
}
async function diagnosePlaylists() {
  const r = await runMyPlaylists(true);
  log('ДИАГНОСТИКА ПЛЕЙЛИСТОВ:', JSON.stringify(r.error ? r : r.items.slice(0, 8).map((x) => x.title + ' | ' + x.url)).slice(0, 3000));
  try {
    const l = await scrapeWith(YM_URL + 'collection', LINKS_JS);
    log('ДИАГНОСТИКА ПЛЕЙЛИСТОВ (ссылки страницы):', JSON.stringify(l).slice(0, 4000));
  } catch (err) { log('ДИАГНОСТИКА ПЛЕЙЛИСТОВ ошибка:', err.message); }
  shell.openPath(logFile);
}

// ───────────────────── Discord: «Слушает…» в профиле ─────────────────────
const presence = new DiscordPresence();
let discordStatus = { state: 'off', text: '' };
let dcKey = '';
let dcStart = 0;
let dcActive = false;

function setDiscordStatus(st) {
  discordStatus = st;
  log('Discord: состояние', st.state, st.text || '');
  if (overlay && !overlay.isDestroyed()) overlay.webContents.send('discord', st);
}
presence.on('status', setDiscordStatus);
presence.on('error-frame', (d) => log('Discord: ошибка', JSON.stringify(d)));
presence.on('frame', (d) => log('Discord ←', JSON.stringify(d).slice(0, 500)));
// Если Discord отверг статус (чаще всего из-за кнопки или картинки) — пробуем упростить: сначала без кнопки, потом ещё и без обложки
let dcLevel = 0;
let dcLastSt = null;
presence.on('activity-error', (d) => {
  log('Discord: статус отклонён (уровень ' + dcLevel + '):', JSON.stringify(d));
  if (dcLevel < 2 && dcLastSt) {
    dcLevel++;
    dcActive = false;
    dcKey = '';
    discordSync(dcLastSt);
  }
});

function applyDiscord() {
  const d = cfg.discord;
  dcKey = '';
  dcActive = false;
  dcLevel = 0;
  if (d.enabled && discordClientId()) presence.start(discordClientId());
  else {
    presence.stop(true);
    setDiscordStatus({ state: d.enabled ? 'noid' : 'off', text: '' });
  }
}

// вызывается из poll(): обновляет статус только когда что-то реально изменилось (трек, пауза, перемотка)
// Отладка: по очереди показывает 4 варианта статуса (каждый подписан номером), чтобы понять, какой из них Discord отображает
let dcTesting = false;
function discordTest() {
  if (!cfg.discord.enabled || !discordClientId()) { log('Discord-тест: статус выключен или нет Application ID'); return; }
  if (dcTesting) return;
  dcTesting = true;
  const cover = dcLastSt && /^https:\/\//.test(String(dcLastSt.cover || '')) ? dcLastSt.cover : '';
  const now = Date.now();
  const variants = [
    { details: 'Тест 1: просто текст', state: 'без типа и картинок', instance: false },
    { type: 2, details: 'Тест 2: Listening', state: 'без картинок и кнопок', timestamps: { start: now }, instance: false },
    { type: 2, details: 'Тест 3: с обложкой', state: cover ? 'обложка трека' : 'обложки нет (запусти трек)', timestamps: { start: now }, assets: cover ? { large_image: cover } : {}, instance: false },
    { type: 2, details: 'Тест 4: с кнопкой', state: 'кнопка «Найти»', timestamps: { start: now }, buttons: [{ label: 'Найти в Яндекс Музыке', url: 'https://music.yandex.ru/' }], instance: false },
  ];
  let i = 0;
  const step = () => {
    if (i >= variants.length) {
      dcTesting = false; dcActive = false; dcKey = '';
      presence.setActivity(null);
      log('Discord-тест: закончен');
      if (dcLastSt) discordSync(dcLastSt);
      return;
    }
    log('Discord-тест: вариант ' + (i + 1));
    presence.setActivity(variants[i++]);
    setTimeout(step, 15000);
  };
  step();
}

function discordSync(st) {
  if (dcTesting) return;
  const d = cfg.discord;
  if (!d.enabled || !discordClientId()) return;
  dcLastSt = st;
  const a = buildActivity(st, d);
  if (a && dcLevel >= 1) delete a.buttons;
  if (a && dcLevel >= 2) delete a.assets.large_image;
  if (!a) {
    if (dcActive) { dcActive = false; dcKey = ''; presence.setActivity(null); }
    return;
  }
  const key = [a.details, a.state, a.timestamps.end ? a.timestamps.end - a.timestamps.start : 0, a.assets.large_image, d.button].join('|');
  if (!dcActive || key !== dcKey || Math.abs(a.timestamps.start - dcStart) > 2500) {
    dcKey = key;
    dcStart = a.timestamps.start;
    dcActive = true;
    log('Discord →', JSON.stringify(a).slice(0, 500));
    presence.setActivity(a);
  }
}

ipcMain.on('discord-set', (_e, d) => {
  if (!d || typeof d !== 'object') return;
  cfg.discord = sanitizeDiscord({ ...cfg.discord, ...d });
  saveConfig();
  sendConfig();
  buildTrayMenu();
  applyDiscord();
});
ipcMain.on('open-external', (_e, url) => {
  if (url === 'https://discord.com/developers/applications') shell.openExternal(url);
});

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
ipcMain.handle('my-playlists', (_e, force) => runMyPlaylists(!!force));
ipcMain.handle('pin-add', (_e, item) => pinAdd(item));
ipcMain.handle('pin-remove', (_e, url) => {
  cfg.playlists = cfg.playlists.filter((p) => p.url !== String(url || ''));
  saveConfig();
  sendConfig();
  return { ok: true };
});
ipcMain.handle('tracks', (_e, url, force) => runTracks(url, !!force));
ipcMain.handle('play-track', async (_e, listUrl, trackUrl) => {
  const res = await playTrackInList(listUrl, trackUrl);
  poll();
  return res;
});
ipcMain.handle('play-url', async (_e, url) => {
  const res = await playUrl(url);
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
  overlay.setIgnoreMouseEvents(true); // без forward: пока панель закрыта, мышь полностью проходит сквозь оверлей (наведение тоже)
  overlay.loadFile(path.join(__dirname, 'overlay.html'));

  overlay.webContents.on('did-finish-load', () => {
    log('Оверлей: страница загружена');
    overlay.webContents.send('config', configForOverlay());
    const known = {};
    for (const [k, v] of Object.entries(iconCache)) if (v) known[k] = v;
    if (Object.keys(known).length) overlay.webContents.send('icons', known);
    overlay.webContents.send('lyrics', lyricsPayload);
    overlay.webContents.send('discord', discordStatus);
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
    overlay.setIgnoreMouseEvents(true); // без forward: пока панель закрыта, мышь полностью проходит сквозь оверлей (наведение тоже)
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
    { label: 'Перезапустить Яндекс Музыку', click: () => reloadYandex('меню трея') },
    { label: 'Показывать трек в профиле Discord', type: 'checkbox', checked: !!cfg.discord.enabled, click: (i) => {
      cfg.discord = sanitizeDiscord({ ...cfg.discord, enabled: i.checked });
      saveConfig(); sendConfig(); applyDiscord();
    } },
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
    { label: 'Отладка: данные о плейлистах', click: diagnosePlaylists },
    { label: 'Отладка: тестовый статус Discord (4 варианта по 15 сек)', click: discordTest },
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
    applyDiscord();

    const okPanel = globalShortcut.register(cfg.hotkeyPanel, () => setPanel(!panelOpen));
    const okHud = globalShortcut.register(cfg.hotkeyHud, () => setHud(!cfg.hudVisible));
    const okLy = globalShortcut.register(cfg.hotkeyLyrics, () => setLyricsPinned(!(cfg.lyricsVisible && cfg.lyricsPinned)));
    if (!okLy) log('Не удалось занять хоткей', cfg.hotkeyLyrics, '— измени его в config.json');
    if (!okPanel) log('Не удалось занять хоткей', cfg.hotkeyPanel, '— измени его в config.json');
    if (!okHud) log('Не удалось занять хоткей', cfg.hotkeyHud, '— измени его в config.json');

    setInterval(poll, 500);
  });

  app.on('before-quit', () => { quitting = true; presence.stop(true); });
  app.on('will-quit', () => globalShortcut.unregisterAll());
  app.on('window-all-closed', () => { /* живём в трее */ });
}