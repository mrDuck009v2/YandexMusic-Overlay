const { contextBridge, ipcRenderer } = require('electron');

const on = (channel) => (cb) => ipcRenderer.on(channel, (_e, data) => cb(data));

contextBridge.exposeInMainWorld('ym', {
  onState: on('state'),
  onConfig: on('config'),
  onPanel: on('panel'),
  onHud: on('hud'),
  onIcons: on('icons'),
  cmd: (name, arg) => ipcRenderer.invoke('cmd', name, arg),
  queue: () => ipcRenderer.invoke('queue'),
  closePanel: () => ipcRenderer.send('close-panel'),
  setHudPos: (pos) => ipcRenderer.send('hud-pos', pos),
  openYandex: () => ipcRenderer.send('open-yandex'),
});
