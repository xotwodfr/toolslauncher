'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('lm', {
  engine: () => ipcRenderer.invoke('engine:check'),
  pickSong: () => ipcRenderer.invoke('song:pick'),
  // Dropped File objects -> real paths (File.path was removed in Electron 32+)
  pathForFile: (file) => webUtils.getPathForFile(file),
  openSong: (p) => ipcRenderer.invoke('song:open', p),
  forget: (id) => ipcRenderer.invoke('song:forget', id),
  make: (id, language, lyrics, model) => ipcRenderer.invoke('make:start', { id, language, lyrics, model }),
  models: () => ipcRenderer.invoke('models:list'),
  downloadModel: (id) => ipcRenderer.invoke('models:download', id),
  cancelModel: () => ipcRenderer.invoke('models:cancel'),
  removeModel: (id) => ipcRenderer.invoke('models:remove', id),
  onModelProgress: (cb) => ipcRenderer.on('models:progress', (_e, p) => cb(p)),
  cancel: () => ipcRenderer.invoke('make:cancel'),
  save: (id, kind, lines, language) => ipcRenderer.invoke('lyrics:save', { id, kind, lines, language }),
  load: (id) => ipcRenderer.invoke('lyrics:load', { id }),
  reveal: (file) => ipcRenderer.invoke('reveal', file),
  onPhase: (cb) => ipcRenderer.on('make:phase', (_e, p) => cb(p)),
  onProgress: (cb) => ipcRenderer.on('make:progress', (_e, p) => cb(p)),
  onLines: (cb) => ipcRenderer.on('make:lines', (_e, p) => cb(p)),
  onOpened: (cb) => ipcRenderer.on('song:opened', (_e, r) => cb(r)),
});
