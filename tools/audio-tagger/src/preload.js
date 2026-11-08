'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('at', {
  pickFiles: () => ipcRenderer.invoke('files:pick'),
  pickFolder: () => ipcRenderer.invoke('files:pick-folder'),
  // A FileList can't cross the context bridge: the renderer resolves one File at a time, then loads by path.
  pathForFile: (file) => webUtils.getPathForFile(file),
  loadPaths: (paths) => ipcRenderer.invoke('files:load', paths),
  readTags: (paths) => ipcRenderer.invoke('tags:read', paths),
  readCover: (file) => ipcRenderer.invoke('cover:read', file),
  pickCover: () => ipcRenderer.invoke('cover:pick'),
  save: (req) => ipcRenderer.invoke('tags:save', req),
  reveal: (file) => ipcRenderer.invoke('reveal', file),
  onSaveProgress: (cb) => ipcRenderer.on('save:progress', (_e, p) => cb(p)),
});
