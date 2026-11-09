'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('lm', {
  engine: () => ipcRenderer.invoke('engine:check'),
  pickSong: () => ipcRenderer.invoke('song:pick'),
  // Dropped File objects -> real paths (File.path was removed in Electron 32+)
  pathForFile: (file) => webUtils.getPathForFile(file),
  openSong: (p) => ipcRenderer.invoke('song:open', p),
  forget: (id) => ipcRenderer.invoke('song:forget', id),
  make: (id, language) => ipcRenderer.invoke('make:start', { id, language }),
  cancel: () => ipcRenderer.invoke('make:cancel'),
  save: (id, kind, lines) => ipcRenderer.invoke('lyrics:save', { id, kind, lines }),
  reveal: (file) => ipcRenderer.invoke('reveal', file),
  onPhase: (cb) => ipcRenderer.on('make:phase', (_e, p) => cb(p)),
  onProgress: (cb) => ipcRenderer.on('make:progress', (_e, p) => cb(p)),
  onLines: (cb) => ipcRenderer.on('make:lines', (_e, p) => cb(p)),
  onOpened: (cb) => ipcRenderer.on('song:opened', (_e, r) => cb(r)),
});
