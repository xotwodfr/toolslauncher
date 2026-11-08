'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('ac', {
  ffmpegInfo: () => ipcRenderer.invoke('info:ffmpeg'),
  pickFiles: () => ipcRenderer.invoke('files:pick'),
  pickFolder: () => ipcRenderer.invoke('files:pick-folder'),
  pickOutputDir: () => ipcRenderer.invoke('dir:pick'),
  // A FileList can't cross the context bridge, so resolve one File at a time, then expand by path.
  pathForFile: (file) => webUtils.getPathForFile(file),
  expandPaths: (paths) => ipcRenderer.invoke('files:expand', paths),
  start: (paths, opts) => ipcRenderer.invoke('convert:start', paths, opts),
  cancel: () => ipcRenderer.invoke('convert:cancel'),
  reveal: (file) => ipcRenderer.invoke('reveal', file),
  onProgress: (cb) => ipcRenderer.on('convert:progress', (_e, p) => cb(p)),
});
