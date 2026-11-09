'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('ocr', {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (s) => ipcRenderer.invoke('settings:set', s),
  pickFiles: () => ipcRenderer.invoke('files:pick'),
  // Dropped File objects -> real paths (File.path was removed in Electron 32+); '' when the file has no path (dragged from a web page)
  pathForFile: (file) => { try { return webUtils.getPathForFile(file); } catch { return ''; } },
  openPaths: (paths) => ipcRenderer.invoke('files:open', paths),
  forget: (id) => ipcRenderer.invoke('files:forget', id),
  clipboardImage: () => ipcRenderer.invoke('clipboard:image'),
  copyText: (text) => ipcRenderer.invoke('clipboard:write', text),
  run: (bytes, opts) => ipcRenderer.invoke('ocr:run', bytes, opts),
  cancel: () => ipcRenderer.invoke('ocr:cancel'),
  saveText: (name, text, dir) => ipcRenderer.invoke('save:text', name, text, dir),
  saveAll: (items) => ipcRenderer.invoke('save:all', items),
  reveal: (file) => ipcRenderer.invoke('reveal', file),
  onProgress: (cb) => ipcRenderer.on('ocr:progress', (_e, p) => cb(p)),
  onOpened: (cb) => ipcRenderer.on('files:opened', (_e, list) => cb(list)),
});
