'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('vr', {
  init: () => ipcRenderer.invoke('app:init'),
  engine: () => ipcRenderer.invoke('engine:check'),
  chooseFolder: () => ipcRenderer.invoke('folder:choose'),
  openFolder: () => ipcRenderer.invoke('folder:open'),
  list: () => ipcRenderer.invoke('takes:list'),
  analyse: (name) => ipcRenderer.invoke('takes:analyse', name),
  rename: (name, title) => ipcRenderer.invoke('takes:rename', name, title),
  remove: (name) => ipcRenderer.invoke('takes:delete', name),
  reveal: (name) => ipcRenderer.invoke('takes:reveal', name),
  recStart: (o) => ipcRenderer.invoke('rec:start', o),
  // samples go one way, without waiting for an answer, in the order they were captured
  recChunk: (buf) => ipcRenderer.send('rec:chunk', buf),
  recPause: () => ipcRenderer.invoke('rec:pause'),
  recResume: () => ipcRenderer.invoke('rec:resume'),
  recMark: (t) => ipcRenderer.invoke('rec:mark', t),
  recStop: () => ipcRenderer.invoke('rec:stop'),
  recDiscard: () => ipcRenderer.invoke('rec:discard'),
  preview: (name, opts, range) => ipcRenderer.invoke('clean:preview', name, opts, range),
  exportTake: (name, opts, o) => ipcRenderer.invoke('clean:export', name, opts, o),
  cancelExport: () => ipcRenderer.invoke('export:cancel'),
  revealExport: (p) => ipcRenderer.invoke('export:reveal', p),
  onExportProgress: (cb) => ipcRenderer.on('export:progress', (_e, p) => cb(p)),
  onRecError: (cb) => ipcRenderer.on('rec:error', (_e, m) => cb(m)),
});
