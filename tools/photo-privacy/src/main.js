'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron');
const fs = require('fs');
const path = require('path');
const M = require('./meta');

let win = null;
let running = false;
let cancelled = false;
const produced = new Set(); // outputs we made - the only files "Show in folder" may reveal

function createWindow() {
  win = new BrowserWindow({
    width: 1020, height: 720, minWidth: 780, minHeight: 580,
    backgroundColor: '#0f1117', title: 'Photo Privacy Cleaner', autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  Menu.setApplicationMenu(null);
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
}

/** Keep picture files; walk folders (depth <= 4, <= 3000 files). */
async function expandPaths(inputs) {
  const out = [];
  const seen = new Set();
  async function visit(p, depth) {
    if (out.length >= 3000 || typeof p !== 'string') return;
    let st;
    try { st = await fs.promises.stat(p); } catch { return; }
    if (st.isDirectory()) {
      if (depth >= 4) return;
      let names = [];
      try { names = await fs.promises.readdir(p); } catch { return; }
      names.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
      for (const name of names) await visit(path.join(p, name), depth + 1);
    } else if (st.isFile() && M.isSupportedName(p) && !seen.has(p)) {
      seen.add(p);
      out.push({ path: p, name: path.basename(p), bytes: st.size });
    }
  }
  for (const p of inputs) await visit(p, 0);
  return out;
}
const cleanError = (e) => String((e && e.message) || e);

ipcMain.handle('files:pick', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Add photos', properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Photos (JPEG, PNG, WebP)', extensions: ['jpg', 'jpeg', 'jpe', 'png', 'webp'] }],
  });
  return r.canceled ? [] : expandPaths(r.filePaths);
});
ipcMain.handle('files:pick-folder', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Add a folder of photos', properties: ['openDirectory'] });
  return r.canceled ? [] : expandPaths(r.filePaths);
});
ipcMain.handle('files:expand', (_e, paths) => expandPaths(Array.isArray(paths) ? paths : []));
ipcMain.handle('files:scan', async (_e, file) => {
  try { return { ok: true, ...(await M.scanFile(String(file))) }; } catch (e) { return { ok: false, error: cleanError(e) }; }
});
ipcMain.handle('dir:pick', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Choose output folder', properties: ['openDirectory', 'createDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle('clean:start', async (_e, files, opts) => {
  if (running) throw new Error('A cleaning run is already in progress');
  if (!Array.isArray(files) || !files.length || !files.every((f) => typeof f === 'string')) throw new Error('No photos selected');
  opts = opts && typeof opts === 'object' ? opts : {};
  const o = {
    keepColor: opts.keepColor !== false, keepOrientation: opts.keepOrientation !== false,
    outDir: typeof opts.outDir === 'string' && opts.outDir ? opts.outDir : null,
  };
  running = true; cancelled = false;
  const send = (p) => { if (win && !win.isDestroyed()) win.webContents.send('clean:progress', p); };
  const summary = { done: 0, failed: 0, cancelled: false, inBytes: 0, outBytes: 0, outputs: [] };
  try {
    for (let i = 0; i < files.length; i++) {
      if (cancelled) { send({ index: i, status: 'skipped' }); continue; }
      send({ index: i, status: 'working' });
      try {
        const r = await M.cleanFile(files[i], o);
        produced.add(r.output);
        summary.done++; summary.inBytes += r.inBytes; summary.outBytes += r.outBytes; summary.outputs.push(r.output);
        send({ index: i, status: 'done', output: r.output, inBytes: r.inBytes, outBytes: r.outBytes, removed: r.removed.length });
      } catch (e) {
        summary.failed++;
        send({ index: i, status: 'error', error: cleanError(e) });
      }
    }
  } finally {
    summary.cancelled = cancelled; running = false;
  }
  return summary;
});
ipcMain.handle('clean:cancel', () => { cancelled = true; });
ipcMain.handle('reveal', (_e, file) => { if (produced.has(file)) shell.showItemInFolder(file); });

// `--self-test=<result.json>`: clean generated files and write a report, then exit (proves a PACKAGED build works).
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
  app.on('window-all-closed', () => app.quit());
}
