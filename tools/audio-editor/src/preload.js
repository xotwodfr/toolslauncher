'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('ae', {
  encoders: () => ipcRenderer.invoke('info:encoders'),
  pickFiles: () => ipcRenderer.invoke('files:pick'),
  pickOutputDir: () => ipcRenderer.invoke('dir:pick'),
  // Dropped File objects -> real paths (File.path was removed in Electron 32+)
  pathForFile: (file) => webUtils.getPathForFile(file),
  openPaths: (paths) => ipcRenderer.invoke('files:open', paths),
  forget: (id) => ipcRenderer.invoke('files:forget', id),
  peaks: (id) => ipcRenderer.invoke('file:peaks', id),
  playable: (id) => ipcRenderer.invoke('file:playable', id),
  exportStart: (items, opts) => ipcRenderer.invoke('export:start', items, opts),
  previewStart: (items, opts) => ipcRenderer.invoke('preview:start', items, opts),
  cancel: () => ipcRenderer.invoke('job:cancel'),
  reveal: (file) => ipcRenderer.invoke('reveal', file),
  onProgress: (cb) => ipcRenderer.on('job:progress', (_e, p) => cb(p)),
  onOpened: (cb) => ipcRenderer.on('files:opened', (_e, list) => cb(list)),
});
