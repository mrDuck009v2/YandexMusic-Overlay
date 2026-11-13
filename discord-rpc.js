// Минимальный клиент Discord Rich Presence (RPC по локальному каналу discord-ipc-N).
// Без внешних зависимостей: Discord слушает именованный канал, обмен — кадрами [opcode][длина][JSON].
const net = require('net');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');

const OP = { HANDSHAKE: 0, FRAME: 1, CLOSE: 2, PING: 3, PONG: 4 };
const MIN_GAP_MS = 4000; // Discord пропускает не больше ~5 обновлений за 20 секунд

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
    this.state = 'off';
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
    if (!silent) this._status('off');
  }

  // activity — объект Rich Presence или null (убрать статус)
  setActivity(activity) {
    this.desired = activity || null;
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
    if (key === this.sentKey) return;
    const wait = this.lastSent + MIN_GAP_MS - Date.now();
    if (wait > 0) {
      clearTimeout(this.sendTimer);
      this.sendTimer = setTimeout(() => this._flush(), wait);
      return;
    }
    this.lastSent = Date.now();
    this.sentKey = key;
    const args = { pid: process.pid };
    if (this.desired) args.activity = this.desired;
    try {
      this.sock.write(encode(OP.FRAME, { cmd: 'SET_ACTIVITY', args, nonce: crypto.randomUUID() }));
    } catch { /* сокет закрылся — переподключимся */ }
  }
}

const clip = (s, n = 128) => {
  s = String(s || '').replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
};
const pad = (s) => (s.length < 2 ? s + '\u2800' : s); // Discord не принимает строки короче 2 символов

// Состояние плеера → «активность» Discord в стиле Spotify («Слушает …» с полосой времени и обложкой)
function buildActivity(st, opts = {}, now = Date.now()) {
  if (!st || !st.ready || st.empty || !st.playing || !st.title) return null;
  const title = pad(clip(st.title + (st.version ? ' (' + st.version + ')' : '')));
  const artist = pad(clip(st.artist || 'Неизвестный исполнитель'));
  const pos = Math.max(0, Number(st.position) || 0);
  const dur = Math.max(0, Number(st.duration) || 0);
  const start = Math.round(now - pos * 1000);
  const a = {
    type: 2, // Listening
    details: title,
    state: artist,
    timestamps: dur > 0 ? { start, end: Math.round(start + dur * 1000) } : { start },
    assets: {},
    instance: false,
  };
  let cover = String(st.cover || '');
  if (cover.startsWith('//')) cover = 'https:' + cover;
  if (/^https:\/\//.test(cover)) a.assets.large_image = cover;
  if (st.album) a.assets.large_text = pad(clip(st.album));
  if (opts.button) {
    const url = 'https://music.yandex.ru/search?text=' + encodeURIComponent(clip(st.artist + ' ' + st.title, 120));
    a.buttons = [{ label: 'Найти в Яндекс Музыке', url }];
  }
  return a;
}

module.exports = { DiscordPresence, buildActivity, encode, pipePath };
