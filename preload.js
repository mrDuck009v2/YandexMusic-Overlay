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
  playUrl: (url) => ipcRenderer.invoke('play-url', url),
  myPlaylists: (force) => ipcRenderer.invoke('my-playlists', !!force),
  pinAdd: (item) => ipcRenderer.invoke('pin-add', item),
  pinRemove: (url) => ipcRenderer.invoke('pin-remove', url),
  reloadYm: () => ipcRenderer.send('reload-ym'),
  tracks: (url, force) => ipcRenderer.invoke('tracks', url, !!force),
  playTrack: (listUrl, trackUrl) => ipcRenderer.invoke('play-track', listUrl, trackUrl),
  onDiscord: on('discord'),
  discordSet: (d) => ipcRenderer.send('discord-set', d),
  openExternal: (url) => ipcRenderer.send('open-external', url),
  closePanel: () => ipcRenderer.send('close-panel'),
  setHudPos: (pos) => ipcRenderer.send('hud-pos', pos),
  lyricsUi: (ui) => ipcRenderer.send('lyrics-ui', ui),
  setAppearance: (a) => ipcRenderer.send('appearance', a),
  openYandex: () => ipcRenderer.send('open-yandex'),
});
