'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('cube', {
  status: () => ipcRenderer.invoke('solver:status'),
  onStatus: (cb) => ipcRenderer.on('solver:status', (_e, s) => cb(s)),
  puzzles: () => ipcRenderer.invoke('puzzles:list'),
  want: (id) => ipcRenderer.invoke('solver:want', id),
  solve: (id, colours) => ipcRenderer.invoke('solver:solve', id, colours),
  copy: (text) => ipcRenderer.invoke('clipboard:write', text),
  saveSolution: (text) => ipcRenderer.invoke('solution:save', text),
  pickPhotos: (multi) => ipcRenderer.invoke('photos:pick', !!multi),
});
