'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron');
const fs = require('original-fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const C = require('./convert');

let win = null;
let running = false;
let abort = null;
const produced = new Set(); // outputs we made - the only files "Show in folder" may reveal

function createWindow() {
  win = new BrowserWindow({
    width: 960, height: 680, minWidth: 760, minHeight: 540,
    backgroundColor: '#0f1117', title: 'Audio Converter', autoHideMenuBar: true,
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
    } else if (st.isFile() && C.isSupportedInput(p) && !seen.has(p)) {
      seen.add(p);
      out.push({ path: p, name: path.basename(p), bytes: st.size });
    }
  }
  for (const p of inputs) await visit(p, 0);
  return out;
}

ipcMain.handle('info:ffmpeg', () => {
  const r = spawnSync(C.ffmpegPath(), ['-version'], { windowsHide: true });
  if (r.status !== 0) return { ok: false };
  const m = /ffmpeg version (\S+)/.exec(String(r.stdout));
  return { ok: true, version: m ? m[1] : '' };
});
ipcMain.handle('files:pick', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Add audio files', properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Audio / video', extensions: C.INPUT_EXTS.map((e) => e.slice(1)) }],
  });
  return r.canceled ? [] : expandPaths(r.filePaths);
});
ipcMain.handle('files:pick-folder', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Add a folder of audio files', properties: ['openDirectory'] });
  return r.canceled ? [] : expandPaths(r.filePaths);
});
ipcMain.handle('files:expand', (_e, paths) => expandPaths(Array.isArray(paths) ? paths : []));
ipcMain.handle('dir:pick', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Choose output folder', properties: ['openDirectory', 'createDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle('convert:start', async (_e, files, opts) => {
  if (running) throw new Error('A conversion is already running');
  if (!Array.isArray(files) || !files.length) throw new Error('No files to convert');
  C.normalizeOptions(opts); // throws on bad input before anything starts
  running = true;
  abort = new AbortController();
  const send = (p) => { if (win && !win.isDestroyed()) win.webContents.send('convert:progress', p); };
  const summary = { done: 0, failed: 0, cancelled: false, inBytes: 0, outBytes: 0 };
  let next = 0;
  const workers = Math.max(1, Math.min(4, Math.floor(os.cpus().length / 2)));
  async function worker() {
    while (next < files.length) {
      const index = next++;
      if (abort.signal.aborted) { send({ index, status: 'skipped' }); continue; }
      send({ index, status: 'working', fraction: 0 });
      let last = 0;
      try {
        const r = await C.convertOne(files[index], opts, {
          signal: abort.signal,
          onProgress: (f) => { if (f - last >= 0.01 || f === 1) { last = f; send({ index, status: 'working', fraction: f }); } },
        });
        produced.add(r.output);
        summary.done++; summary.inBytes += r.inBytes; summary.outBytes += r.outBytes;
        send({ index, status: 'done', output: r.output, inBytes: r.inBytes, outBytes: r.outBytes });
      } catch (err) {
        if (err.cancelled) send({ index, status: 'skipped' });
        else { summary.failed++; send({ index, status: 'error', error: String(err.message || err) }); }
      }
    }
  }
  try {
    await Promise.all(Array.from({ length: Math.min(workers, files.length) }, worker));
  } finally {
    summary.cancelled = abort.signal.aborted;
    running = false; abort = null;
  }
  return summary;
});
ipcMain.handle('convert:cancel', () => { if (abort) abort.abort(); });
ipcMain.handle('reveal', (_e, file) => { if (produced.has(file)) shell.showItemInFolder(file); });

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();
else {
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
  app.whenReady().then(createWindow);
  app.on('window-all-closed', () => { if (abort) abort.abort(); app.quit(); });
}
