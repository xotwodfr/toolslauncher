'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('td', {
  // Dropped File objects -> real paths (File.path was removed in Electron 32+)
  pathForFile: (file) => webUtils.getPathForFile(file),
  pickFile: (side) => ipcRenderer.invoke('file:pick', side),
  loadFile: (side, p) => ipcRenderer.invoke('file:load', side, p),
  reloadFile: (side) => ipcRenderer.invoke('file:reload', side),
  forgetFile: (side) => ipcRenderer.invoke('file:forget', side),
  saveMerged: (args) => ipcRenderer.invoke('merge:save', args),
  exportSave: (args) => ipcRenderer.invoke('export:save', args),
  show: (p) => ipcRenderer.invoke('shell:show', p),
  pickFolder: (side) => ipcRenderer.invoke('folder:pick', side),
  checkFolder: (p) => ipcRenderer.invoke('folder:check', p),
  compareFolders: (args) => ipcRenderer.invoke('folder:compare', args),
  cancelFolders: () => ipcRenderer.invoke('folder:cancel'),
  copyFiles: (args) => ipcRenderer.invoke('folder:copy', args),
  openPair: (rel) => ipcRenderer.invoke('folder:open-pair', rel),
  onFolderProgress: (cb) => ipcRenderer.on('folder:progress', (_e, p) => cb(p)),
  onCopyProgress: (cb) => ipcRenderer.on('folder:copy-progress', (_e, p) => cb(p)),
  onOpened: (cb) => ipcRenderer.on('files:opened', (_e, r) => cb(r)),
});
