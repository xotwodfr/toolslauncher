'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('cube', {
  status: () => ipcRenderer.invoke('solver:status'),
  onStatus: (cb) => ipcRenderer.on('solver:status', (_e, s) => cb(s)),
  solve: (size, faces) => ipcRenderer.invoke('solver:solve', size, faces),
  copy: (text) => ipcRenderer.invoke('clipboard:write', text),
  saveSolution: (text) => ipcRenderer.invoke('solution:save', text),
  pickPhotos: (multi) => ipcRenderer.invoke('photos:pick', !!multi),
});
