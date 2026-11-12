'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, clipboard, Menu } = require('electron');
const fs = require('fs');
const path = require('path');
const { runScan } = require('./runner');
const { listDrives } = require('./drives');
const { protectedReason } = require('./protect');
const T = require('./types');

const E2E = process.argv.includes('--e2e');
const SELFTEST = process.argv.find((a) => a.startsWith('--self-test='));
if (E2E || SELFTEST) app.setPath('userData', path.join(app.getPath('temp'), `disk-space-test-${process.pid}`));

const CSV_LIMIT = 50 * 1024 * 1024;
let win = null;
let job = null;          // the running scan
let scanRoot = null;     // the folder of the last full scan: every action must stay inside it
const testHooks = { delayMs: 0 }; // e2e only: slow the scan down so Cancel can be tested

const send = (channel, payload) => { if (win && !win.isDestroyed()) win.webContents.send(channel, payload); };
const cleanError = (e) => String((e && e.message) || e);
const fmt = (b) => { const u = ['bytes', 'KB', 'MB', 'GB', 'TB']; let i = 0; let v = b; while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; } return (i ? v.toFixed(v < 10 ? 2 : 1) : v) + ' ' + u[i]; };

function createWindow() {
  win = new BrowserWindow({
    width: 1240, height: 840, minWidth: 960, minHeight: 600,
    backgroundColor: '#0b0b0d', title: 'Disk Space Visualizer', autoHideMenuBar: true, show: !SELFTEST,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false },
  });
  Menu.setApplicationMenu(null);
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'), (E2E || SELFTEST) ? { hash: 'e2e' } : undefined);
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.on('closed', () => { win = null; });
}

/** a path from the window that must be an absolute path inside the scanned folder and still exist */
function checkedPath(p, { allowRoot = true } = {}) {
  if (typeof p !== 'string' || !p || p.length > 32767 || p.includes('\0') || !path.isAbsolute(p)) throw new Error('That is not a valid path.');
  if (!scanRoot) throw new Error('Scan a drive or a folder first.');
  const abs = path.resolve(p);
  const rel = path.relative(scanRoot, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('That item is not in the scanned folder.');
  if (!allowRoot && rel === '') throw new Error('This is the folder you scanned. Choose something inside it.');
  try { fs.lstatSync(abs); } catch { throw new Error('It is not there any more (moved or deleted since the scan).'); }
  return abs;
}

// ---- drives and folders ------------------------------------------------------------------------------------------------
ipcMain.handle('drives:list', () => { try { return listDrives(); } catch (e) { return []; } });
ipcMain.handle('folder:pick', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Choose a folder to scan', properties: ['openDirectory'] });
  return r.canceled || !r.filePaths.length ? null : r.filePaths[0];
});
ipcMain.handle('folder:check', (_e, p) => {
  if (typeof p !== 'string' || !path.isAbsolute(p)) return { ok: false, error: 'That is not a folder.' };
  try { const st = fs.statSync(p); return st.isDirectory() ? { ok: true, path: path.resolve(p) } : { ok: false, error: 'Drop a folder, not a file.' }; } catch { return { ok: false, error: 'That folder cannot be opened.' }; }
});

// ---- scanning ----------------------------------------------------------------------------------------------------------
ipcMain.handle('scan:start', async (_e, req) => {
  if (job) throw new Error('A scan is already running.');
  req = req && typeof req === 'object' ? req : {};
  const subtree = req.subtree === true;
  if (typeof req.path !== 'string' || !path.isAbsolute(req.path)) throw new Error('Choose a drive or a folder to scan.');
  const root = subtree ? checkedPath(req.path) : path.resolve(req.path);
  if (!subtree) scanRoot = root;
  const id = Date.now();
  const seen = subtree && Array.isArray(req.seen) ? req.seen.filter((k) => typeof k === 'string' && k.length < 80).slice(0, 1e6) : undefined;
  job = runScan(root, { oneDrive: req.oneDrive !== false, delayMs: E2E ? testHooks.delayMs : 0, seen }, {
    onProgress: (p) => send('scan:progress', { id, subtree, ...p }),
    onSnapshot: subtree ? undefined : (tree) => send('scan:snapshot', { id, tree }),
  });
  try {
    const r = await job.promise;
    return { ok: true, subtree, json: r.json };
  } catch (e) {
    return { ok: false, subtree, error: e.code === 'ENOENT' ? 'That folder does not exist.' : e.code === 'EACCES' || e.code === 'EPERM' ? 'No permission to look inside that folder.' : cleanError(e) };
  } finally { job = null; }
});
ipcMain.handle('scan:cancel', () => { if (job) job.cancel(); });

// ---- actions on one item -----------------------------------------------------------------------------------------------
ipcMain.handle('item:show', (_e, p) => { try { shell.showItemInFolder(checkedPath(p)); return { ok: true }; } catch (e) { return { ok: false, error: cleanError(e) }; } });
ipcMain.handle('item:open', async (_e, p) => {
  try {
    const abs = checkedPath(p);
    const st = fs.statSync(abs);
    if (!st.isDirectory() && T.groupOf(abs) === T.GROUPS.indexOf('apps')) return { ok: false, error: 'Programs and scripts are not started from here, to be safe. Use Show in folder instead.' };
    const err = await shell.openPath(abs);
    return err ? { ok: false, error: 'It could not be opened: ' + err } : { ok: true };
  } catch (e) { return { ok: false, error: cleanError(e) }; }
});
ipcMain.handle('item:copy', (_e, p) => {
  if (typeof p !== 'string' || !p || p.length > 32767) return { ok: false, error: 'Nothing to copy.' };
  clipboard.writeText(p);
  return { ok: true };
});
ipcMain.handle('item:trash', async (_e, p, size, files) => {
  try {
    const abs = checkedPath(p, { allowRoot: false });
    const why = protectedReason(abs);
    if (why) return { ok: false, refused: true, error: why };
    const st = fs.lstatSync(abs);
    const n = Number.isFinite(files) && files > 0 ? Math.floor(files) : 0;
    const what = st.isDirectory() ? `the folder "${path.basename(abs)}"${n ? ` with ${n.toLocaleString('en-US')} file${n === 1 ? '' : 's'}` : ''}` : `"${path.basename(abs)}"`;
    const r = await dialog.showMessageBox(win, {
      type: 'warning', buttons: ['Move to Recycle Bin', 'Cancel'], defaultId: 1, cancelId: 1, noLink: true,
      title: 'Move to Recycle Bin',
      message: `Move ${what} to the Recycle Bin?`,
      detail: `${abs}\n\nThis frees about ${fmt(Number.isFinite(size) && size >= 0 ? size : 0)} once the Recycle Bin is emptied. You can put it back from the Recycle Bin until then.`,
    });
    if (r.response !== 0) return { ok: false, cancelled: true };
    await shell.trashItem(abs);
    return { ok: true };
  } catch (e) { return { ok: false, error: 'It could not be moved to the Recycle Bin: ' + cleanError(e) }; }
});

// ---- CSV ---------------------------------------------------------------------------------------------------------------
let saved = null;
ipcMain.handle('csv:save', async (_e, text, name) => {
  if (typeof text !== 'string' || !text || text.length > CSV_LIMIT) throw new Error('Nothing to save');
  const base = typeof name === 'string' && /^[\w .()-]{1,80}\.csv$/.test(name) ? name : 'disk-space.csv';
  const pick = await dialog.showSaveDialog(win, { title: 'Save as CSV', defaultPath: base, filters: [{ name: 'CSV', extensions: ['csv'] }] });
  if (pick.canceled || !pick.filePath) return { ok: false, cancelled: true };
  let out = pick.filePath;
  if (!/\.csv$/i.test(out)) out += '.csv';
  const part = out + '.part';
  fs.writeFileSync(part, '﻿' + text, 'utf8'); // the BOM makes Excel read accents correctly
  fs.renameSync(part, out);                       // the save dialog already asked before replacing a file
  saved = out;
  return { ok: true, path: out };
});
ipcMain.handle('csv:show', () => { if (saved && fs.existsSync(saved)) shell.showItemInFolder(saved); });

// ---- start up ------------------------------------------------------------------------------------------------------------
function cleanUp() { try { if (job) job.kill(); } catch { /* ignore */ } }

if (SELFTEST) {
  app.whenReady().then(async () => {
    createWindow();
    const outFile = SELFTEST.slice('--self-test='.length);
    let code = 1;
    try {
      const results = await require('./selftest').run({ getWin: () => win });
      fs.writeFileSync(outFile, JSON.stringify({ ok: results.every((r) => r.ok), results }, null, 2));
      code = results.every((r) => r.ok) ? 0 : 1;
    } catch (e) {
      fs.writeFileSync(outFile, JSON.stringify({ ok: false, error: String((e && e.stack) || e) }, null, 2));
    }
    cleanUp();
    app.exit(code);
  });
} else if (!E2E && !app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
  app.whenReady().then(() => {
    createWindow();
    if (E2E) {
      win.webContents.once('did-finish-load', () => {
        const arg = (name) => (process.argv.find((a) => a.startsWith(name + '=')) || '').slice(name.length + 1);
        const ctx = { app, getWin: () => win, outFile: arg('--e2e-out'), shotsDir: arg('--shots'), outDir: arg('--readme-shots'), dialog, shell, clipboard, testHooks };
        if (ctx.outDir) require('../test/readme-shots').run(ctx); else require('../test/e2e').run(ctx);
      });
    }
  });
  app.on('window-all-closed', () => { cleanUp(); app.quit(); });
}
