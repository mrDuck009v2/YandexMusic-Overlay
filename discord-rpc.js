// Минимальный клиент Discord Rich Presence (RPC по локальному каналу discord-ipc-N).
// Без внешних зависимостей: Discord слушает именованный канал, обмен — кадрами [opcode][длина][JSON].
const net = require('net');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');

const OP = { HANDSHAKE: 0, FRAME: 1, CLOSE: 2, PING: 3, PONG: 4 };
const MIN_GAP_MS = 1000;  // минимальная пауза между обновлениями
const WINDOW_MS = 20000;  // Discord пропускает не больше ~5 обновлений за 20 секунд
const BURST = 5;
const MAX_URL = 500;      // Discord отвергает весь статус, если URL кнопки длиннее 512 символов

function pipePath(i) {
  if (process.platform === 'win32') return '\\\\?\\pipe\\discord-ipc-' + i;
  const dir = process.env.XDG_RUNTIME_DIR || process.env.TMPDIR || process.env.TMP || process.env.TEMP || '/tmp';
  return path.join(dir, 'discord-ipc-' + i);
}

function encode(op, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  const head = Buffer.alloc(8);
  head.writeInt32LE(op, 0);
  head.writeInt32LE(body.length, 4);
  return Buffer.concat([head, body]);
}

class DiscordPresence extends EventEmitter {
  constructor() {
    super();
    this.clientId = '';
    this.sock = null;
    this.ready = false;
    this.running = false;
    this.buf = Buffer.alloc(0);
    this.retryTimer = null;
    this.sendTimer = null;
    this.desired = null;      // что должно быть в профиле (null — ничего)
    this.sentKey = undefined; // что отправлено в последний раз
    this.lastSent = 0;
    this.sentTimes = [];      // когда уходили последние обновления (для лимита 5 за 20 с)
    this.pendingHard = false; // среди ждущих отправки изменений есть «важное» (смена трека, пауза, перемотка)
    this.state = 'off';
    this.rtt = 0;             // сглаженное время ответа Discord на SET_ACTIVITY, мс (для компенсации задержки строки песни)
    this.inflight = new Map(); // nonce → время отправки
  }

  _status(state, text) {
    this.state = state;
    this.emit('status', { state, text: text || '' });
  }

  start(clientId) {
    if (this.running && this.clientId === clientId) return;
    this.stop(true);
    this.clientId = clientId;
    this.running = true;
    this._status('connecting');
    this._connect(0);
  }

  stop(silent) {
    this.running = false;
    clearTimeout(this.retryTimer);
    clearTimeout(this.sendTimer);
    if (this.sock) {
      try {
        if (this.ready) this.sock.write(encode(OP.FRAME, { cmd: 'SET_ACTIVITY', args: { pid: process.pid }, nonce: crypto.randomUUID() }));
        this.sock.end();
        this.sock.destroy();
      } catch { /* уже закрыт */ }
    }
    this.sock = null;
    this.ready = false;
    this.sentKey = undefined;
    this.desired = null;
    this.pendingHard = false;
    this.inflight.clear();
    if (!silent) this._status('off');
  }

  // activity — объект Rich Presence или null (убрать статус)
  // soft — меняется только строка песни: такие обновления не занимают последний слот лимита, он остаётся под смену трека/паузу
  setActivity(activity, soft) {
    this.desired = activity || null;
    if (!soft) this.pendingHard = true;
    this._flush();
  }

  _retry(state, text, ms) {
    this.ready = false;
    this._status(state, text);
    clearTimeout(this.retryTimer);
    if (this.running) this.retryTimer = setTimeout(() => this._connect(0), ms);
  }

  _connect(i) {
    if (!this.running) return;
    if (i > 9) { this._retry('nodiscord', 'Discord не запущен', 10000); return; }
    const sock = net.createConnection(pipePath(i));
    this.sock = sock;
    this.buf = Buffer.alloc(0);
    let opened = false;
    sock.on('connect', () => {
      opened = true;
      sock.write(encode(OP.HANDSHAKE, { v: 1, client_id: this.clientId }));
    });
    sock.on('data', (d) => this._onData(sock, d));
    sock.on('error', () => {
      if (sock !== this.sock) return;
      if (!opened) this._connect(i + 1); // этот канал занят/не существует — пробуем следующий
    });
    sock.on('close', () => {
      if (sock !== this.sock) return;
      if (opened && this.running) this._retry('nodiscord', 'Связь с Discord потеряна', 5000);
    });
  }

  _onData(sock, d) {
    if (sock !== this.sock) return;
    this.buf = Buffer.concat([this.buf, d]);
    while (this.buf.length >= 8) {
      const op = this.buf.readInt32LE(0);
      const len = this.buf.readInt32LE(4);
      if (this.buf.length < 8 + len) break;
      let data = {};
      try { data = JSON.parse(this.buf.slice(8, 8 + len).toString('utf8')); } catch { /* битый кадр */ }
      this.buf = this.buf.slice(8 + len);
      this._onFrame(op, data);
    }
  }

  _onFrame(op, data) {
    if (op === OP.PING) { this.sock && this.sock.write(encode(OP.PONG, data)); return; }
    if (op === OP.CLOSE) {
      // например, код 4000 — неверный Application ID: переподключаться бессмысленно
      const bad = data && data.code === 4000;
      if (bad) {
        this.running = false;
        this._status('error', 'Discord не принял Application ID — проверь, что скопировал его целиком');
        try { this.sock.destroy(); } catch { /* ок */ }
      }
      return;
    }
    if (op === OP.FRAME) {
      if (data.nonce && this.inflight.has(data.nonce)) {
        const ms = Date.now() - this.inflight.get(data.nonce);
        this.inflight.delete(data.nonce);
        this.rtt = this.rtt ? this.rtt * 0.7 + ms * 0.3 : ms;
      }
      this.emit('frame', data);
      if (data.cmd === 'SET_ACTIVITY' && data.evt === 'ERROR') this.emit('activity-error', data.data);
      if (data.evt === 'READY') {
        this.ready = true;
        this.sentKey = undefined;
        const u = data.data && data.data.user;
        this._status('connected', u ? (u.global_name || u.username || '') : '');
        this._flush();
      } else if (data.evt === 'ERROR') {
        this.emit('error-frame', data.data);
      }
    }
  }

  _flush() {
    if (!this.ready || !this.sock) return;
    const key = JSON.stringify(this.desired);
    if (key === this.sentKey) { this.pendingHard = false; return; }
    const now = Date.now();
    this.sentTimes = this.sentTimes.filter((t) => now - t < WINDOW_MS);
    const limit = this.pendingHard ? BURST : BURST - 1;
    let wait = this.lastSent + (this.minGap || MIN_GAP_MS) - now;
    if (this.sentTimes.length >= limit) wait = Math.max(wait, this.sentTimes[this.sentTimes.length - limit] + WINDOW_MS - now + 50);
    if (wait > 0) {
      clearTimeout(this.sendTimer);
      this.sendTimer = setTimeout(() => this._flush(), wait);
      return;
    }
    this.lastSent = Date.now();
    this.sentTimes.push(this.lastSent);
    this.pendingHard = false;
    this.sentKey = key;
    const args = { pid: process.pid };
    if (this.desired) args.activity = this.desired;
    try {
      const nonce = crypto.randomUUID();
      if (this.inflight.size > 20) this.inflight.clear();
      this.inflight.set(nonce, this.lastSent);
      this.sock.write(encode(OP.FRAME, { cmd: 'SET_ACTIVITY', args, nonce }));
    } catch { /* сокет закрылся — переподключимся */ }
  }
}

const clip = (s, n = 128) => {
  s = String(s || '').replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
};
// encodeURIComponent падает на «одинокой» суррогатной половинке (обрезанный эмодзи) — вычищаем такие
const enc = (s) => {
  try { return encodeURIComponent(s); } catch {
    return encodeURIComponent(s.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, ''));
  }
};
// Ссылка поиска, гарантированно не длиннее MAX_URL (кириллица в процентном кодировании — по 6 символов на букву)
function searchUrl(base, text) {
  const chars = Array.from(clip(text, 120));
  let url = base + enc(chars.join(''));
  while (url.length > MAX_URL && chars.length > 1) {
    chars.pop();
    url = base + enc(chars.join(''));
  }
  return url;
}
const pad = (s) => (s.length < 2 ? s + '\u2800' : s); // Discord не принимает строки короче 2 символов

// Состояние плеера → «активность» Discord в стиле Spotify («Слушает …» с полосой времени и обложкой)
// opts: button, button2 ('genius' | 'youtube'), lyrics + line + next (строка песни), paused (показывать паузу)
function buildActivity(st, opts = {}, now = Date.now()) {
  if (!st || !st.ready || st.empty || !st.title) return null;
  const playing = !!st.playing;
  if (!playing && !opts.paused) return null;
  const fullTitle = st.title + (st.version ? ' (' + st.version + ')' : '');
  const artistRaw = st.artist || 'Неизвестный исполнитель';
  // opts.lyrics — у трека есть синхронный текст: в «details» название и исполнитель, в «state» текущая строка песни
  const withLy = !!opts.lyrics && playing;
  // со строками песни вся первая строка — «название — исполнитель · альбом»; без них альбом остаётся подписью при наведении на обложку
  const title = pad(clip(withLy ? fullTitle + ' — ' + artistRaw + (st.album ? ' · ' + st.album : '') : fullTitle));
  const artist = pad(clip(!playing ? '⏸ На паузе' : withLy ? (opts.line ? '♪ ' + opts.line : '♪') : artistRaw));
  const a = {
    type: 2, // Listening
    details: title,
    state: artist,
    assets: {},
    instance: false,
  };
  if (playing) { // на паузе полосу времени не показываем
    const pos = Math.max(0, Number(st.position) || 0);
    const dur = Math.max(0, Number(st.duration) || 0);
    const start = Math.round(now - pos * 1000);
    a.timestamps = dur > 0 ? { start, end: Math.round(start + dur * 1000) } : { start };
  }
  let cover = String(st.cover || '');
  if (cover.startsWith('//')) cover = 'https:' + cover;
  if (/^https:\/\//.test(cover)) a.assets.large_image = cover;
  if (!withLy && st.album) a.assets.large_text = pad(clip(st.album, 120)); // подпись при наведении на обложку
  const q = artistRaw + ' ' + st.title;
  const buttons = [];
  if (opts.button) buttons.push({ label: 'Найти в Яндекс Музыке', url: searchUrl('https://music.yandex.ru/search?text=', q) });
  if (opts.button2 === 'genius') buttons.push({ label: 'Текст на Genius', url: searchUrl('https://genius.com/search?q=', q) });
  else if (opts.button2 === 'youtube') buttons.push({ label: 'Найти на YouTube', url: searchUrl('https://www.youtube.com/results?search_query=', q) });
  if (buttons.length) a.buttons = buttons;
  return a;
}

module.exports = { DiscordPresence, buildActivity, encode, pipePath };