'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('pc', {
  engine: () => ipcRenderer.invoke('engine:check'),
  warm: () => ipcRenderer.invoke('engine:warm'),
  engineState: () => ipcRenderer.invoke('engine:state'),
  pickImage: () => ipcRenderer.invoke('image:pick'),
  // Dropped File objects -> real paths (File.path was removed in Electron 32+)
  pathForFile: (file) => webUtils.getPathForFile(file),
  openImage: (p) => ipcRenderer.invoke('image:open', p),
  samEncode: (req) => ipcRenderer.invoke('sam:encode', req),
  samDecode: (req) => ipcRenderer.invoke('sam:decode', req),
  fill: (req) => ipcRenderer.invoke('fill:run', req),
  cancelFill: () => ipcRenderer.invoke('fill:cancel'),
  save: (req) => ipcRenderer.invoke('image:save', req),
  copy: (req) => ipcRenderer.invoke('clipboard:copy', req),
  reveal: (file) => ipcRenderer.invoke('reveal', file),
  onPhase: (cb) => ipcRenderer.on('fill:phase', (_e, p) => cb(p)),
  onOpened: (cb) => ipcRenderer.on('image:opened', (_e, r) => cb(r)),
});
