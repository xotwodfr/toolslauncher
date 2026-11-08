'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron');
const fs = require('fs');
const path = require('path');
const P = require('./pdf');

let win = null;
let running = false;
let abort = null;
const produced = new Set(); // outputs we made - the only files "Show in folder" may reveal

function createWindow() {
  win = new BrowserWindow({
    width: 980, height: 700, minWidth: 760, minHeight: 560,
    backgroundColor: '#0f1117', title: 'PDF Toolkit', autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  Menu.setApplicationMenu(null);
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
}

/** Keep PDFs and JPEG/PNG images; walk folders (depth <= 3, <= 2000 files). */
async function expandPaths(inputs) {
  const out = [];
  const seen = new Set();
  async function visit(p, depth) {
    if (out.length >= 2000 || typeof p !== 'string') return;
    let st;
    try { st = await fs.promises.stat(p); } catch { return; }
    if (st.isDirectory()) {
      if (depth >= 3) return;
      let names = [];
      try { names = await fs.promises.readdir(p); } catch { return; }
      names.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
      for (const name of names) await visit(path.join(p, name), depth + 1);
    } else if (st.isFile() && (P.isPdf(p) || P.isImage(p)) && !seen.has(p)) {
      seen.add(p);
      out.push({ path: p, name: path.basename(p), bytes: st.size, kind: P.isPdf(p) ? 'pdf' : 'image' });
    }
  }
  for (const p of inputs) await visit(p, 0);
  return out;
}

const cleanError = (e) => String((e && e.message) || e);

ipcMain.handle('files:pick', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Add PDFs or images', properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'PDF and images', extensions: ['pdf', 'jpg', 'jpeg', 'png'] }],
  });
  return r.canceled ? [] : expandPaths(r.filePaths);
});
ipcMain.handle('files:pick-folder', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Add a folder', properties: ['openDirectory'] });
  return r.canceled ? [] : expandPaths(r.filePaths);
});
ipcMain.handle('files:expand', (_e, paths) => expandPaths(Array.isArray(paths) ? paths : []));
ipcMain.handle('files:inspect', async (_e, file) => {
  try { return { ok: true, ...(await P.inspect(String(file))) }; } catch (e) { return { ok: false, error: cleanError(e) }; }
});
ipcMain.handle('dir:pick', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Choose output folder', properties: ['openDirectory', 'createDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});

const send = (channel, payload) => { if (win && !win.isDestroyed()) win.webContents.send(channel, payload); };

/**
 * mode "merge" / "images": all files go into one result (a step event per file).
 * mode "split" / "pages": the operation runs on each file in turn (a status event per file).
 */
ipcMain.handle('run:start', async (_e, mode, files, opts) => {
  if (running) throw new Error('Something is already running');
  if (!Array.isArray(files) || !files.length || !files.every((f) => typeof f === 'string')) throw new Error('No files selected');
  opts = opts && typeof opts === 'object' ? opts : {};
  running = true;
  abort = new AbortController();
  const summary = { outputs: [], failed: 0, cancelled: false };
  try {
    if (mode === 'merge' || mode === 'images') {
      try {
        const hooks = { signal: abort.signal, onStep: (i) => send('run:progress', { index: i, status: 'working' }) };
        const r = mode === 'merge' ? await P.merge(files, opts, hooks) : await P.imagesToPdf(files, opts, hooks);
        r.outputs.forEach((o) => produced.add(o));
        summary.outputs.push(...r.outputs);
        files.forEach((_f, i) => send('run:progress', { index: i, status: 'done' }));
      } catch (e) {
        if (e.cancelled) { summary.cancelled = true; files.forEach((_f, i) => send('run:progress', { index: i, status: 'skipped' })); }
        else throw e; // the whole job failed: the renderer shows the message
      }
    } else if (mode === 'split' || mode === 'pages') {
      for (let i = 0; i < files.length; i++) {
        if (abort.signal.aborted) { summary.cancelled = true; send('run:progress', { index: i, status: 'skipped' }); continue; }
        send('run:progress', { index: i, status: 'working' });
        try {
          const r = mode === 'split' ? await P.split(files[i], opts, { signal: abort.signal }) : await P.editPages(files[i], opts);
          r.outputs.forEach((o) => produced.add(o));
          summary.outputs.push(...r.outputs);
          send('run:progress', { index: i, status: 'done', outputs: r.outputs.length });
        } catch (e) {
          if (e.cancelled) { summary.cancelled = true; send('run:progress', { index: i, status: 'skipped' }); }
          else { summary.failed++; send('run:progress', { index: i, status: 'error', error: cleanError(e) }); }
        }
      }
    } else throw new Error(`Unknown mode: ${mode}`);
  } finally {
    running = false; abort = null;
  }
  return summary;
});
ipcMain.handle('run:cancel', () => { if (abort) abort.abort(); });
ipcMain.handle('reveal', (_e, file) => { if (produced.has(file)) shell.showItemInFolder(file); });

// `--self-test=<result.json>`: run every operation on generated files and write a report, then exit. Proves that a
// PACKAGED build works. No window, no single-instance lock.
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
