'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const call = (ch) => (...args) => ipcRenderer.invoke(ch, ...args);
contextBridge.exposeInMainWorld('notes', {
  getFolder: call('folder:get'),
  pickFolder: call('folder:pick'),
  refresh: call('folder:refresh'),
  read: call('note:read'),
  close: call('note:close'),
  save: call('note:save'),
  render: call('note:render'),
  createNote: call('note:create'),
  createFolder: call('folder:create'),
  rename: call('entry:rename'),
  move: call('entry:move'),
  info: call('entry:info'),
  trash: call('entry:trash'),
  search: call('search'),
  togglePin: call('pin:toggle'),
  setView: call('view:set'),
  openWiki: call('wiki:open'),
  openLink: call('link:open'),
  // bytes: a Uint8Array of the pasted or dropped picture
  saveAttachment: (noteRel, bytes, name) => ipcRenderer.invoke('attach:save', noteRel, bytes, name),
  exportNote: call('export'),
  reveal: call('reveal'),
  onFolderChanged: (cb) => ipcRenderer.on('folder:changed', (_e, s) => cb(s)),
  onExternal: (cb) => ipcRenderer.on('note:external', (_e, s) => cb(s)),
});
