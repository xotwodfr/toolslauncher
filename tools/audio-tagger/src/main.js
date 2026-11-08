'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron');
const fs = require('original-fs');
const path = require('path');
const T = require('./tags');

let win = null;
let saving = false;
let pickedCover = null; // the only image path the renderer may ask us to embed (chosen via our own dialog)

function createWindow() {
  win = new BrowserWindow({
    width: 1180, height: 720, minWidth: 900, minHeight: 560,
    backgroundColor: '#0f1117', title: 'Audio Tagger', autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  Menu.setApplicationMenu(null);
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
}

async function expandPaths(inputs) {
  const out = [];
  const seen = new Set();
  async function visit(p, depth) {
    if (out.length >= 5000 || typeof p !== 'string') return;
    let st;
    try { st = await fs.promises.stat(p); } catch { return; }
    if (st.isDirectory()) {
      if (depth >= 6) return;
      let names = [];
      try { names = await fs.promises.readdir(p); } catch { return; }
      names.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
      for (const name of names) await visit(path.join(p, name), depth + 1);
    } else if (st.isFile() && T.isAudio(p) && !seen.has(p)) {
      seen.add(p);
      out.push(p);
    }
  }
  for (const p of inputs) await visit(p, 0);
  return out;
}

const readMany = (paths) => paths.map((p) => {
  try { return T.readTags(p); } catch (e) { return { path: p, name: path.basename(p), error: String(e.message || e) }; }
});

ipcMain.handle('files:pick', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Add audio files', properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Audio', extensions: T.AUDIO_EXTS.map((e) => e.slice(1)) }],
  });
  return r.canceled ? [] : readMany(await expandPaths(r.filePaths));
});
ipcMain.handle('files:pick-folder', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Add a folder of audio files', properties: ['openDirectory'] });
  return r.canceled ? [] : readMany(await expandPaths(r.filePaths));
});
ipcMain.handle('files:load', async (_e, paths) => readMany(await expandPaths(Array.isArray(paths) ? paths : [])));
ipcMain.handle('tags:read', (_e, paths) => readMany((Array.isArray(paths) ? paths : []).filter((p) => typeof p === 'string')));
ipcMain.handle('cover:read', (_e, file) => { try { return T.readCover(file); } catch { return null; } });

ipcMain.handle('cover:pick', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Choose cover image', properties: ['openFile'],
    filters: [{ name: 'Images', extensions: T.IMAGE_EXTS.map((e) => e.slice(1)) }],
  });
  if (r.canceled) return null;
  const file = r.filePaths[0];
  const size = fs.statSync(file).size;
  if (size > 20 * 1024 * 1024) throw new Error('Cover image is larger than 20 MB');
  pickedCover = file;
  const ext = path.extname(file).slice(1).toLowerCase().replace('jpg', 'jpeg');
  return { name: path.basename(file), dataUrl: `data:image/${ext};base64,${fs.readFileSync(file).toString('base64')}` };
});

ipcMain.handle('tags:save', async (_e, req) => {
  if (saving) throw new Error('A save is already running');
  const paths = Array.isArray(req && req.paths) ? req.paths.filter((p) => typeof p === 'string') : [];
  if (!paths.length) throw new Error('Nothing selected');
  const patch = {};
  for (const k of T.FIELD_NAMES) if (req.patch && k in req.patch) patch[k] = req.patch[k];
  if (req.patch && req.patch.cover && ['set', 'remove'].includes(req.patch.cover.action)) patch.cover = { action: req.patch.cover.action };
  const rename = req.rename && req.rename.enabled ? String(req.rename.pattern || '') : '';
  saving = true;
  const results = [];
  try {
    for (let i = 0; i < paths.length; i++) {
      const file = paths[i];
      const filePatch = { ...patch };
      if (req.autoNumber) { filePatch.track = i + 1; filePatch.trackCount = paths.length; }
      win.webContents.send('save:progress', { path: file, status: 'working' });
      try {
        T.writeTags(file, filePatch, patch.cover && patch.cover.action === 'set' ? pickedCover : null);
        const finalPath = rename ? T.renameFromTags(file, rename) : file;
        results.push({ path: file, newPath: finalPath, ok: true });
        win.webContents.send('save:progress', { path: file, status: 'done', newPath: finalPath });
      } catch (err) {
        results.push({ path: file, ok: false, error: String(err.message || err) });
        win.webContents.send('save:progress', { path: file, status: 'error', error: String(err.message || err) });
      }
    }
  } finally {
    saving = false;
  }
  return results;
});

ipcMain.handle('reveal', (_e, file) => { if (typeof file === 'string' && T.isAudio(file) && fs.existsSync(file)) shell.showItemInFolder(file); });

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();
else {
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
  app.whenReady().then(createWindow);
  app.on('window-all-closed', () => app.quit());
}
