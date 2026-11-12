'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('fe', {
  pathForFile: (file) => webUtils.getPathForFile(file),
  pickFiles: (mode) => ipcRenderer.invoke('files:pick', mode),
  pickFolder: (mode) => ipcRenderer.invoke('files:pick-folder', mode),
  addPaths: (paths, mode) => ipcRenderer.invoke('files:add', paths, mode),
  forget: (ids) => ipcRenderer.invoke('files:forget', ids),
  pickDir: () => ipcRenderer.invoke('dir:pick'),
  strength: (pw) => ipcRenderer.invoke('strength', pw),
  copy: (text) => ipcRenderer.invoke('clipboard', text),
  reveal: (file) => ipcRenderer.invoke('reveal', file),
  encrypt: (o) => ipcRenderer.invoke('enc:start', o),
  decrypt: (o) => ipcRenderer.invoke('dec:start', o),
  hash: (o) => ipcRenderer.invoke('hash:start', o),
  detect: (text) => ipcRenderer.invoke('hash:detect', text),
  cancel: () => ipcRenderer.invoke('run:cancel'),
  verifySums: (file) => ipcRenderer.invoke('sums:verify', file),
  saveSums: (o) => ipcRenderer.invoke('sums:save', o),
  onProgress: (cb) => ipcRenderer.on('run:progress', (_e, p) => cb(p)),
  onPhase: (cb) => ipcRenderer.on('run:phase', (_e, p) => cb(p)),
  onItem: (cb) => ipcRenderer.on('run:item', (_e, p) => cb(p)),
  onSumsStart: (cb) => ipcRenderer.on('sums:start', (_e, p) => cb(p)),
  onSumsRow: (cb) => ipcRenderer.on('sums:row', (_e, p) => cb(p)),
  onOpened: (cb) => ipcRenderer.on('files:opened', (_e, p) => cb(p)),
});
