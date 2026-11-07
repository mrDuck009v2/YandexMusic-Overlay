const { contextBridge, ipcRenderer } = require('electron');

const on = (channel) => (cb) => ipcRenderer.on(channel, (_e, data) => cb(data));

contextBridge.exposeInMainWorld('ym', {
  onState: on('state'),
  onConfig: on('config'),
  onPanel: on('panel'),
  onHud: on('hud'),
  onIcons: on('icons'),
  onLyrics: on('lyrics'),
  cmd: (name, arg) => ipcRenderer.invoke('cmd', name, arg),
  queue: () => ipcRenderer.invoke('queue'),
  search: (q) => ipcRenderer.invoke('search', q),
  playSearch: (q, i, title, artist) => ipcRenderer.invoke('search-play', q, i, title, artist),
  closePanel: () => ipcRenderer.send('close-panel'),
  setHudPos: (pos) => ipcRenderer.send('hud-pos', pos),
  lyricsUi: (ui) => ipcRenderer.send('lyrics-ui', ui),
  setAppearance: (a) => ipcRenderer.send('appearance', a),
  openYandex: () => ipcRenderer.send('open-yandex'),
});
