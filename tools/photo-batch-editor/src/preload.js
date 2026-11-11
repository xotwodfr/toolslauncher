'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('pb', {
  pickFiles: () => ipcRenderer.invoke('files:pick'),
  pickFolder: () => ipcRenderer.invoke('files:pick-folder'),
  // dropped File objects -> real paths (File.path was removed in Electron 32+)
  pathForFile: (file) => webUtils.getPathForFile(file),
  addPaths: (paths) => ipcRenderer.invoke('files:add', paths),
  remove: (ids) => ipcRenderer.invoke('files:remove', ids),
  clear: () => ipcRenderer.invoke('files:clear'),
  thumb: (id) => ipcRenderer.invoke('files:thumb', id),
  pickLogo: () => ipcRenderer.invoke('logo:pick'),
  preview: (id, recipe, output, box) => ipcRenderer.invoke('preview', id, recipe, output, box),
  pickOut: () => ipcRenderer.invoke('out:pick'),
  start: (ids, recipe, output) => ipcRenderer.invoke('run:start', ids, recipe, output),
  cancel: () => ipcRenderer.invoke('run:cancel'),
  reveal: (file) => ipcRenderer.invoke('reveal', file),
  presets: () => ipcRenderer.invoke('presets:list'),
  savePreset: (name, data) => ipcRenderer.invoke('presets:save', name, data),
  deletePreset: (name) => ipcRenderer.invoke('presets:delete', name),
  onItem: (cb) => ipcRenderer.on('run:item', (_e, r) => cb(r)),
  onOpened: (cb) => ipcRenderer.on('files:opened', (_e, r) => cb(r)),
  // the main process asks the window to draw the watermark text (see main.js)
  onTextDraw: (cb) => ipcRenderer.on('text:draw', (_e, r) => cb(r)),
  textTile: (id, url, err) => ipcRenderer.send('text:tile', id, url, err),
});
