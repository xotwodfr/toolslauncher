'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('br', {
  engine: () => ipcRenderer.invoke('engine:check'),
  pickImage: () => ipcRenderer.invoke('image:pick'),
  // Dropped File objects -> real paths (File.path was removed in Electron 32+)
  pathForFile: (file) => webUtils.getPathForFile(file),
  openImage: (p) => ipcRenderer.invoke('image:open', p),
  pickBackground: () => ipcRenderer.invoke('background:pick'),
  cutout: (tensorBuffer) => ipcRenderer.invoke('cutout:run', tensorBuffer),
  cancel: () => ipcRenderer.invoke('cutout:cancel'),
  save: (req) => ipcRenderer.invoke('image:save', req),
  reveal: (file) => ipcRenderer.invoke('reveal', file),
  onPhase: (cb) => ipcRenderer.on('cutout:phase', (_e, p) => cb(p)),
  onOpened: (cb) => ipcRenderer.on('image:opened', (_e, r) => cb(r)),
});
