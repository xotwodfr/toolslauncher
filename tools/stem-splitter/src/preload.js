'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('ss', {
  engine: () => ipcRenderer.invoke('engine:check'),
  pickSong: () => ipcRenderer.invoke('song:pick'),
  // Dropped File objects -> real paths (File.path was removed in Electron 32+)
  pathForFile: (file) => webUtils.getPathForFile(file),
  openPaths: (paths) => ipcRenderer.invoke('song:open', paths),
  forget: (id) => ipcRenderer.invoke('song:forget', id),
  split: (id) => ipcRenderer.invoke('split:start', id),
  exportMix: (id, mix, format) => ipcRenderer.invoke('export:start', id, mix, format),
  cancel: () => ipcRenderer.invoke('job:cancel'),
  reveal: (file) => ipcRenderer.invoke('reveal', file),
  cacheInfo: () => ipcRenderer.invoke('cache:info'),
  cacheClear: () => ipcRenderer.invoke('cache:clear'),
  onProgress: (cb) => ipcRenderer.on('job:progress', (_e, p) => cb(p)),
  onOpened: (cb) => ipcRenderer.on('song:opened', (_e, r) => cb(r)),
});
