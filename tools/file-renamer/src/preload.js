'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('rn', {
  // Dropped File objects -> real paths (File.path was removed in Electron 32+)
  pathForFile: (file) => webUtils.getPathForFile(file),
  pickFiles: (opts) => ipcRenderer.invoke('files:pick', opts),
  pickFolder: (opts) => ipcRenderer.invoke('files:pick-folder', opts),
  addPaths: (paths, opts) => ipcRenderer.invoke('files:add', paths, opts),
  remove: (ids) => ipcRenderer.invoke('files:remove', ids),
  clear: () => ipcRenderer.invoke('files:clear'),
  preview: (rules, opts) => ipcRenderer.invoke('preview', rules, opts),
  rename: (rules, opts) => ipcRenderer.invoke('rename:run', rules, opts),
  history: () => ipcRenderer.invoke('history:list'),
  undo: (id, partial) => ipcRenderer.invoke('history:undo', id, partial),
  interrupted: () => ipcRenderer.invoke('history:interrupted'),
  recover: (id) => ipcRenderer.invoke('history:recover', id),
  presets: () => ipcRenderer.invoke('presets:list'),
  savePreset: (name, rules) => ipcRenderer.invoke('presets:save', name, rules),
  removePreset: (name) => ipcRenderer.invoke('presets:remove', name),
  defaults: () => ipcRenderer.invoke('rules:defaults'),
  show: (p) => ipcRenderer.invoke('shell:show', p),
  onProgress: (cb) => ipcRenderer.on('rename:progress', (_e, p) => cb(p)),
  onOpened: (cb) => ipcRenderer.on('files:opened', (_e, r) => cb(r)),
});
