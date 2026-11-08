'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron');
const fs = require('fs');
const path = require('path');
const { convertOne, isSupportedInput, INPUT_EXTS } = require('./convert');

let win = null;
let cancelled = false;
let running = false;
const producedFiles = new Set(); // only these may be revealed in the file manager

function createWindow() {
  win = new BrowserWindow({
    width: 920, height: 660, minWidth: 720, minHeight: 520,
    backgroundColor: '#0f1117', title: 'Picture Converter', autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  Menu.setApplicationMenu(null);
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
}

/** Expand dropped/selected paths: keep supported files, walk folders (depth <= 3, <= 5000 files). */
async function expandPaths(inputs) {
  const out = [];
  const seen = new Set();
  async function visit(p, depth) {
    if (out.length >= 5000 || typeof p !== 'string') return;
    let st;
    try { st = await fs.promises.stat(p); } catch { return; }
    if (st.isDirectory()) {
      if (depth >= 3) return;
      for (const name of await fs.promises.readdir(p)) await visit(path.join(p, name), depth + 1);
    } else if (st.isFile() && isSupportedInput(p) && !seen.has(p)) {
      seen.add(p);
      out.push({ path: p, name: path.basename(p), bytes: st.size });
    }
  }
  for (const p of inputs) await visit(p, 0);
  return out;
}

ipcMain.handle('files:pick', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Add images', properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Images', extensions: INPUT_EXTS.map((e) => e.slice(1)) }],
  });
  return r.canceled ? [] : expandPaths(r.filePaths);
});
ipcMain.handle('files:pick-folder', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Add a folder of images', properties: ['openDirectory'] });
  return r.canceled ? [] : expandPaths(r.filePaths);
});
ipcMain.handle('files:expand', (_e, paths) => expandPaths(Array.isArray(paths) ? paths : []));
ipcMain.handle('dir:pick', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Choose output folder', properties: ['openDirectory', 'createDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle('convert:start', async (_e, files, opts) => {
  if (running) throw new Error('A conversion is already running');
  if (!Array.isArray(files) || files.length === 0) throw new Error('No files to convert');
  running = true;
  cancelled = false;
  let done = 0, failed = 0, inBytes = 0, outBytes = 0;
  try {
    for (let i = 0; i < files.length; i++) {
      if (cancelled) { win.webContents.send('convert:progress', { index: i, status: 'skipped' }); continue; }
      win.webContents.send('convert:progress', { index: i, status: 'working' });
      try {
        const r = await convertOne(files[i], opts);
        producedFiles.add(r.output);
        done++; inBytes += r.inBytes; outBytes += r.outBytes;
        win.webContents.send('convert:progress', { index: i, status: 'done', output: r.output, width: r.width, height: r.height, inBytes: r.inBytes, outBytes: r.outBytes });
      } catch (err) {
        failed++;
        win.webContents.send('convert:progress', { index: i, status: 'error', error: String(err.message || err) });
      }
    }
  } finally {
    running = false;
  }
  return { done, failed, cancelled, inBytes, outBytes };
});
ipcMain.handle('convert:cancel', () => { cancelled = true; });
ipcMain.handle('reveal', (_e, file) => {
  if (producedFiles.has(file)) shell.showItemInFolder(file);
});

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();
else {
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
  app.whenReady().then(createWindow);
  app.on('window-all-closed', () => app.quit());
}
