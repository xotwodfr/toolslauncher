'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('sm', {
  engine: () => ipcRenderer.invoke('engine:check'),
  // Dropped File objects -> real paths (File.path was removed in Electron 32+)
  pathForFile: (file) => webUtils.getPathForFile(file),
  pickMedia: () => ipcRenderer.invoke('media:pick'),
  openMedia: (p) => ipcRenderer.invoke('media:open', p),
  forget: (id) => ipcRenderer.invoke('media:forget', id),
  pickSubs: () => ipcRenderer.invoke('subs:pick'),
  openSubs: (p) => ipcRenderer.invoke('subs:open', p),
  siblingSubs: (id) => ipcRenderer.invoke('subs:sibling', id),
  make: (id, language, translate) => ipcRenderer.invoke('make:start', { id, language, translate }),
  cancel: () => ipcRenderer.invoke('make:cancel'),
  save: (id, kind, cues, name) => ipcRenderer.invoke('subs:save', { id, kind, cues, name }),
  exportVideo: (id, mode, cues, style, language) => ipcRenderer.invoke('video:export', { id, mode, cues, style, language }),
  cancelExport: () => ipcRenderer.invoke('video:cancel'),
  reveal: (file) => ipcRenderer.invoke('reveal', file),
  onPhase: (cb) => ipcRenderer.on('make:phase', (_e, p) => cb(p)),
  onProgress: (cb) => ipcRenderer.on('make:progress', (_e, p) => cb(p)),
  onCues: (cb) => ipcRenderer.on('make:cues', (_e, p) => cb(p)),
  onExportProgress: (cb) => ipcRenderer.on('video:progress', (_e, p) => cb(p)),
  onMediaOpened: (cb) => ipcRenderer.on('media:opened', (_e, r) => cb(r)),
  onSubsOpened: (cb) => ipcRenderer.on('subs:opened', (_e, r) => cb(r)),
});
