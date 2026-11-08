'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('launcher', {
  getLibrary: (refresh = false) => ipcRenderer.invoke('library:get', { refresh }),
  install: (id) => ipcRenderer.invoke('tool:install', id),
  uninstall: (id) => ipcRenderer.invoke('tool:uninstall', id),
  launch: (id) => ipcRenderer.invoke('tool:launch', id),
  reveal: (id) => ipcRenderer.invoke('tool:reveal', id),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  openDataDir: () => ipcRenderer.invoke('app:open-data-dir'),
  onProgress: (cb) => {
    const handler = (_e, p) => cb(p);
    ipcRenderer.on('tool:progress', handler);
    return () => ipcRenderer.removeListener('tool:progress', handler);
  },
});
