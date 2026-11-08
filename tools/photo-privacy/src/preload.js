'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('pp', {
  pickFiles: () => ipcRenderer.invoke('files:pick'),
  pickFolder: () => ipcRenderer.invoke('files:pick-folder'),
  pickOutputDir: () => ipcRenderer.invoke('dir:pick'),
  // Dropped File objects -> real paths (File.path was removed in Electron 32+)
  pathForFile: (file) => webUtils.getPathForFile(file),
  expandPaths: (paths) => ipcRenderer.invoke('files:expand', paths),
  scan: (file) => ipcRenderer.invoke('files:scan', file),
  clean: (paths, opts) => ipcRenderer.invoke('clean:start', paths, opts),
  cancel: () => ipcRenderer.invoke('clean:cancel'),
  reveal: (file) => ipcRenderer.invoke('reveal', file),
  onProgress: (cb) => ipcRenderer.on('clean:progress', (_e, p) => cb(p)),
});
