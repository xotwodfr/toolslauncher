'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('vc', {
  encoders: () => ipcRenderer.invoke('info:encoders'),
  pickFiles: () => ipcRenderer.invoke('files:pick'),
  pickFolder: () => ipcRenderer.invoke('files:pick-folder'),
  pickOutputDir: () => ipcRenderer.invoke('dir:pick'),
  // Dropped File objects -> real paths (File.path was removed in Electron 32+)
  pathForFile: (file) => webUtils.getPathForFile(file),
  expandPaths: (paths) => ipcRenderer.invoke('files:expand', paths),
  probe: (file) => ipcRenderer.invoke('files:probe', file),
  start: (paths, opts) => ipcRenderer.invoke('convert:start', paths, opts),
  cancel: () => ipcRenderer.invoke('convert:cancel'),
  reveal: (file) => ipcRenderer.invoke('reveal', file),
  onProgress: (cb) => ipcRenderer.on('convert:progress', (_e, p) => cb(p)),
});
