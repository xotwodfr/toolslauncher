'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const call = (ch) => (...args) => ipcRenderer.invoke(ch, ...args);
contextBridge.exposeInMainWorld('books', {
  library: call('library:list'),
  removeFromLibrary: call('library:remove'),
  pick: call('files:pick'),
  // Dropped File objects -> real paths (File.path was removed in Electron 32+)
  pathForFile: (file) => webUtils.getPathForFile(file),
  open: call('reader:open'),
  close: call('reader:close'),
  chapter: call('reader:chapter'),
  search: call('reader:search'),
  savePosition: call('reader:position'),
  openLink: call('link:open'),
  convert: call('convert:run'),
  cancelConvert: call('convert:cancel'),
  pickDir: call('dir:pick'),
  reveal: call('reveal'),
  openDetails: call('meta:open'),
  pickCover: call('meta:pick-cover'),
  saveDetails: call('meta:save'),
  onConvertProgress: (cb) => ipcRenderer.on('convert:progress', (_e, p) => cb(p)),
  onOpenFile: (cb) => ipcRenderer.on('open:file', (_e, p) => cb(p)),
});
