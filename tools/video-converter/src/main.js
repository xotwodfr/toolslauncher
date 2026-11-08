'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron');
const fs = require('original-fs');
const path = require('path');
const C = require('./convert');

let win = null;
let running = false;
let abort = null;
const produced = new Set(); // outputs we made - the only files "Show in folder" may reveal

function createWindow() {
  win = new BrowserWindow({
    width: 1000, height: 720, minWidth: 780, minHeight: 580,
    backgroundColor: '#0f1117', title: 'Video Converter', autoHideMenuBar: true,
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
    if (out.length >= 2000 || typeof p !== 'string') return;
    let st;
    try { st = await fs.promises.stat(p); } catch { return; }
    if (st.isDirectory()) {
      if (depth >= 4) return;
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
const cleanError = (e) => String((e && e.message) || e);

ipcMain.handle('info:encoders', () => C.checkEncoders());
ipcMain.handle('files:pick', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Add videos', properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Videos', extensions: C.INPUT_EXTS.map((e) => e.slice(1)) }],
  });
  return r.canceled ? [] : expandPaths(r.filePaths);
});
ipcMain.handle('files:pick-folder', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Add a folder of videos', properties: ['openDirectory'] });
  return r.canceled ? [] : expandPaths(r.filePaths);
});
ipcMain.handle('files:expand', (_e, paths) => expandPaths(Array.isArray(paths) ? paths : []));
ipcMain.handle('files:probe', async (_e, file) => {
  try {
    const p = await C.probe(String(file));
    return { ok: true, durationSec: p.durationSec, width: p.width, height: p.height, fps: p.fps, codec: p.codec, hasAudio: p.hasAudio };
  } catch (e) { return { ok: false, error: cleanError(e) }; }
});
ipcMain.handle('dir:pick', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Choose output folder', properties: ['openDirectory', 'createDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle('convert:start', async (_e, files, opts) => {
  if (running) throw new Error('A conversion is already running');
  if (!Array.isArray(files) || !files.length || !files.every((f) => typeof f === 'string')) throw new Error('No files to convert');
  C.normalizeOptions(opts); // throws on bad input before anything starts
  running = true;
  abort = new AbortController();
  const send = (p) => { if (win && !win.isDestroyed()) win.webContents.send('convert:progress', p); };
  const summary = { done: 0, failed: 0, cancelled: false, inBytes: 0, outBytes: 0, outputs: [] };
  try {
    // One at a time: ffmpeg already uses every core for a single video.
    for (let index = 0; index < files.length; index++) {
      if (abort.signal.aborted) { send({ index, status: 'skipped' }); continue; }
      send({ index, status: 'working', fraction: 0 });
      let last = 0;
      try {
        const r = await C.convertOne(files[index], opts, {
          signal: abort.signal,
          onProgress: (f, speed) => { if (f - last >= 0.005 || f === 1) { last = f; send({ index, status: 'working', fraction: f, speed }); } },
        });
        produced.add(r.output);
        summary.done++; summary.inBytes += r.inBytes; summary.outBytes += r.outBytes; summary.outputs.push(r.output);
        send({ index, status: 'done', output: r.output, inBytes: r.inBytes, outBytes: r.outBytes, seconds: r.seconds });
      } catch (err) {
        if (err.cancelled) send({ index, status: 'skipped' });
        else { summary.failed++; send({ index, status: 'error', error: cleanError(err) }); }
      }
    }
  } finally {
    summary.cancelled = abort.signal.aborted;
    running = false; abort = null;
  }
  return summary;
});
ipcMain.handle('convert:cancel', () => { if (abort) abort.abort(); });
ipcMain.handle('reveal', (_e, file) => { if (produced.has(file)) shell.showItemInFolder(file); });

// `--self-test=<result.json>`: make a short test clip with the bundled ffmpeg, convert it to every format, write a
// report, then exit. Proves a PACKAGED build works (ffmpeg found, encoders present).
const selfTestArg = process.argv.find((a) => a.startsWith('--self-test='));
const gotLock = selfTestArg ? true : app.requestSingleInstanceLock();
if (selfTestArg) {
  app.whenReady().then(async () => {
    const out = selfTestArg.slice('--self-test='.length);
    let code = 1;
    try {
      const results = await require('./selftest').run();
      fs.writeFileSync(out, JSON.stringify({ ok: results.every((r) => r.ok), results }, null, 2));
      code = results.every((r) => r.ok) ? 0 : 1;
    } catch (e) {
      fs.writeFileSync(out, JSON.stringify({ ok: false, error: String((e && e.stack) || e) }, null, 2));
    }
    app.exit(code);
  });
} else if (!gotLock) app.quit();
else {
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
  app.whenReady().then(createWindow);
  app.on('window-all-closed', () => { if (abort) abort.abort(); app.quit(); });
}
