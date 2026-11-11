'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('ds', {
  platform: process.platform,
  sep: process.platform === 'win32' ? '\\' : '/',
  drives: () => ipcRenderer.invoke('drives:list'),
  pickFolder: () => ipcRenderer.invoke('folder:pick'),
  checkFolder: (p) => ipcRenderer.invoke('folder:check', p),
  // Dropped File objects -> real paths (File.path was removed in Electron 32+)
  pathForFile: (file) => webUtils.getPathForFile(file),
  scan: (req) => ipcRenderer.invoke('scan:start', req),
  cancel: () => ipcRenderer.invoke('scan:cancel'),
  show: (p) => ipcRenderer.invoke('item:show', p),
  open: (p) => ipcRenderer.invoke('item:open', p),
  copy: (p) => ipcRenderer.invoke('item:copy', p),
  trash: (p, size, files) => ipcRenderer.invoke('item:trash', p, size, files),
  saveCsv: (text, name) => ipcRenderer.invoke('csv:save', text, name),
  showCsv: () => ipcRenderer.invoke('csv:show'),
  onProgress: (cb) => ipcRenderer.on('scan:progress', (_e, p) => cb(p)),
  onSnapshot: (cb) => ipcRenderer.on('scan:snapshot', (_e, s) => cb(s)),
});
