'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('df', {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (s) => ipcRenderer.invoke('settings:set', s),
  pickFolders: () => ipcRenderer.invoke('dir:pick'),
  // Dropped File objects -> real paths (File.path was removed in Electron 32+)
  pathForFile: (file) => webUtils.getPathForFile(file),
  checkFolders: (paths) => ipcRenderer.invoke('dir:check', paths),
  scan: (mode, roots, options) => ipcRenderer.invoke('scan:start', mode, roots, options),
  listPhotos: (roots, options) => ipcRenderer.invoke('photos:list', roots, options),
  storePhotoHashes: (batch) => ipcRenderer.invoke('photos:store', batch),
  groupPhotos: (threshold) => ipcRenderer.invoke('photos:group', threshold),
  cancel: () => ipcRenderer.invoke('scan:cancel'),
  reveal: (id) => ipcRenderer.invoke('reveal', id),
  planTrash: (ids) => ipcRenderer.invoke('trash:plan', ids),
  runTrash: (ids) => ipcRenderer.invoke('trash:run', ids),
  onScanProgress: (cb) => ipcRenderer.on('scan:progress', (_e, p) => cb(p)),
  onTrashProgress: (cb) => ipcRenderer.on('trash:progress', (_e, p) => cb(p)),
  onAddRoots: (cb) => ipcRenderer.on('roots:add', (_e, list) => cb(list)),
});
