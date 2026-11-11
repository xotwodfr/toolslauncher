'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('ai', {
  engine: () => ipcRenderer.invoke('engine:check'),
  // Dropped File objects -> real paths (File.path was removed in Electron 32+)
  pathForFile: (file) => webUtils.getPathForFile(file),
  pickFiles: () => ipcRenderer.invoke('files:pick'),
  pickFolder: () => ipcRenderer.invoke('files:pick-folder'),
  addPaths: (paths) => ipcRenderer.invoke('files:add', paths),
  remove: (ids) => ipcRenderer.invoke('files:remove', ids),
  clear: () => ipcRenderer.invoke('files:clear'),
  inspect: (ids) => ipcRenderer.invoke('inspect:start', ids),
  cancel: () => ipcRenderer.invoke('inspect:cancel'),
  detail: (id) => ipcRenderer.invoke('file:detail', id),
  saveReport: (kind, ids) => ipcRenderer.invoke('report:save', { kind, ids }),
  reveal: (file) => ipcRenderer.invoke('reveal', file),
  onRow: (cb) => ipcRenderer.on('inspect:row', (_e, r) => cb(r)),
  onOpened: (cb) => ipcRenderer.on('files:opened', (_e, r) => cb(r)),
});
