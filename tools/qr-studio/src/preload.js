'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('qs', {
  makeQr: (text, opts) => ipcRenderer.invoke('qr:make', text, opts),
  makeBar: (kind, input, opts) => ipcRenderer.invoke('bar:make', kind, input, opts),
  pickLogo: () => ipcRenderer.invoke('logo:pick'),
  clearLogo: () => ipcRenderer.invoke('logo:clear'),
  readPixels: (img) => ipcRenderer.invoke('read:pixels', img),
  openPicture: () => ipcRenderer.invoke('read:open'),
  readScreen: (hide) => ipcRenderer.invoke('read:screen', hide),
  clipboardImage: () => ipcRenderer.invoke('clip:image'),
  openLink: (url) => ipcRenderer.invoke('link:open', url),
  save: (data, kind, name) => ipcRenderer.invoke('save:file', data, kind, name),
  copyPng: (png) => ipcRenderer.invoke('clip:png', png),
  copyText: (t) => ipcRenderer.invoke('clip:text', t),
  showFile: (p) => ipcRenderer.invoke('file:show', p),
  batchDir: () => ipcRenderer.invoke('batch:dir'),
  batchList: () => ipcRenderer.invoke('batch:list'),
  batchWrite: (item) => ipcRenderer.invoke('batch:write', item),
  batchShow: () => ipcRenderer.invoke('batch:show'),
  pathForFile: (file) => webUtils.getPathForFile(file),
});
