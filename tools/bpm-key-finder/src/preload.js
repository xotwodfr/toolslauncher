'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('bk', {
  engine: () => ipcRenderer.invoke('engine:check'),
  pickFiles: () => ipcRenderer.invoke('files:pick'),
  pickFolder: () => ipcRenderer.invoke('files:pick-folder'),
  // Dropped File objects -> real paths (File.path was removed in Electron 32+)
  pathForFile: (file) => webUtils.getPathForFile(file),
  addPaths: (paths) => ipcRenderer.invoke('files:add', paths),
  remove: (ids) => ipcRenderer.invoke('files:remove', ids),
  clear: () => ipcRenderer.invoke('files:clear'),
  analyse: (ids) => ipcRenderer.invoke('analyse:start', ids),
  cancel: () => ipcRenderer.invoke('analyse:cancel'),
  write: (items) => ipcRenderer.invoke('tags:write', items),
  saveCsv: (text) => ipcRenderer.invoke('csv:save', text),
  onRow: (cb) => ipcRenderer.on('analyse:row', (_e, r) => cb(r)),
  onWriteProgress: (cb) => ipcRenderer.on('write:progress', (_e, p) => cb(p)),
  onOpened: (cb) => ipcRenderer.on('files:opened', (_e, r) => cb(r)),
});
