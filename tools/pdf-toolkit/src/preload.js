'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('tk', {
  pickFiles: () => ipcRenderer.invoke('files:pick'),
  pickFolder: () => ipcRenderer.invoke('files:pick-folder'),
  pickOutputDir: () => ipcRenderer.invoke('dir:pick'),
  // Dropped File objects -> real paths (File.path was removed in Electron 32+)
  pathForFile: (file) => webUtils.getPathForFile(file),
  expandPaths: (paths) => ipcRenderer.invoke('files:expand', paths),
  inspect: (file) => ipcRenderer.invoke('files:inspect', file),
  run: (mode, paths, opts) => ipcRenderer.invoke('run:start', mode, paths, opts),
  cancel: () => ipcRenderer.invoke('run:cancel'),
  reveal: (file) => ipcRenderer.invoke('reveal', file),
  onProgress: (cb) => ipcRenderer.on('run:progress', (_e, p) => cb(p)),
});
