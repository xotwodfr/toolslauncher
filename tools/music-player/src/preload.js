'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const on = (channel, cb) => { const h = (_e, p) => cb(p); ipcRenderer.on(channel, h); return () => ipcRenderer.removeListener(channel, h); };

contextBridge.exposeInMainWorld('mp', {
  // settings
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  // library
  getLibrary: () => ipcRenderer.invoke('library:get'),
  chooseFolder: () => ipcRenderer.invoke('library:choose'),
  openFolder: (dir) => ipcRenderer.invoke('library:open', dir),
  rescan: () => ipcRenderer.invoke('library:rescan'),
  pathForFile: (file) => webUtils.getPathForFile(file), // dropped File -> real path
  onLibrary: (cb) => on('library:event', cb),
  // lyrics
  getLyrics: (rel) => ipcRenderer.invoke('lyrics:get', rel),
  saveLyrics: (rel, text) => ipcRenderer.invoke('lyrics:save', rel, text),
  // playlists
  getPlaylists: () => ipcRenderer.invoke('playlists:get'),
  savePlaylists: (store) => ipcRenderer.invoke('playlists:save', store),
  importPlaylist: () => ipcRenderer.invoke('playlists:import'),
  exportPlaylist: (name, rels) => ipcRenderer.invoke('playlists:export', name, rels),
  // misc
  reveal: (rel) => ipcRenderer.invoke('reveal', rel),
  revealRoot: () => ipcRenderer.invoke('reveal-root'),
  setMini: (on_) => ipcRenderer.invoke('window:mini', !!on_),
  openInTagger: (rel) => ipcRenderer.invoke('tagger:open', rel),
  testHook: (fn) => ipcRenderer.invoke('test:hook', fn), // only answers in --e2e mode
});
