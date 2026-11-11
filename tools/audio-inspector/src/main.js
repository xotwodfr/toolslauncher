'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron');
const fs = require('original-fs');
const path = require('path');
const { spawnSync } = require('child_process');
const P = require('./probe');
const R = require('./report');
const { Pool, ffmpegPath } = require('./pool');

const E2E = process.argv.includes('--e2e');
const SELFTEST = process.argv.find((a) => a.startsWith('--self-test='));
if (E2E || SELFTEST) app.setPath('userData', path.join(app.getPath('temp'), `audio-inspector-test-${process.pid}`));

const MAX_FILES = 5000;
const KEEP_PICTURES = 200;           // spectrogram pictures kept in memory; older ones are measured again when looked at

let win = null;
let pool = null;
let nextId = 1;
const files = new Map();             // id -> { path, name, folder, result?, error? } the window only ever names files by id
const inflight = new Set();
const pictureOrder = [];             // ids whose spectrogram picture is kept, oldest first
const produced = new Set();          // reports we wrote - the only files "Show in folder" may reveal

const send = (channel, payload) => { if (win && !win.isDestroyed()) win.webContents.send(channel, payload); };
const cleanError = (e) => String((e && e.message) || e);
const getPool = () => pool || (pool = new Pool());

function createWindow() {
  win = new BrowserWindow({
    width: 1240, height: 840, minWidth: 980, minHeight: 620,
    backgroundColor: '#0b0b0d', title: 'Audio Inspector', autoHideMenuBar: true, show: !SELFTEST,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false },
  });
  Menu.setApplicationMenu(null);
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'), (E2E || SELFTEST) ? { hash: 'e2e' } : undefined);
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.on('closed', () => { win = null; });
}

// ---- adding files ----------------------------------------------------------------------------------------------------------
async function expandPaths(inputs) {
  const out = [];
  const seen = new Set([...files.values()].map((f) => f.path));
  async function visit(p, depth) {
    if (out.length + files.size >= MAX_FILES || typeof p !== 'string' || !path.isAbsolute(p)) return;
    let st;
    try { st = await fs.promises.stat(p); } catch { return; }
    if (st.isDirectory()) {
      if (depth >= 8) return;
      let names = [];
      try { names = await fs.promises.readdir(p); } catch { return; }
      names.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
      for (const name of names) if (!name.startsWith('.')) await visit(path.join(p, name), depth + 1);
    } else if (st.isFile() && P.isAudio(p) && !seen.has(p)) { seen.add(p); out.push(p); }
  }
  for (const p of inputs) await visit(p, 0);
  return out;
}
async function addPaths(inputs) {
  const list = (Array.isArray(inputs) ? inputs : []).filter((p) => typeof p === 'string');
  const found = await expandPaths(list);
  const rows = found.map((p) => {
    const id = nextId++;
    const row = { id, path: p, name: path.basename(p), folder: path.dirname(p) };
    files.set(id, row);
    return { id, name: row.name, folder: row.folder, ext: P.extOf(p).slice(1) };
  });
  return { rows, capped: files.size >= MAX_FILES, ignored: list.length > 0 && rows.length === 0 };
}

ipcMain.handle('engine:check', () => {
  const r = spawnSync(ffmpegPath(), ['-hide_banner', '-version'], { encoding: 'utf8', windowsHide: true });
  return r.status === 0 ? { ok: true } : { ok: false, problem: 'ffmpeg could not start' + (r.error ? ': ' + r.error.message : '') };
});
ipcMain.handle('files:pick', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Add audio files', properties: ['openFile', 'multiSelections'], filters: [{ name: 'Audio', extensions: P.AUDIO_EXTS.map((e) => e.slice(1)) }, { name: 'All files', extensions: ['*'] }] });
  return r.canceled ? { rows: [] } : addPaths(r.filePaths);
});
ipcMain.handle('files:pick-folder', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Add a folder of audio files', properties: ['openDirectory'] });
  return r.canceled ? { rows: [] } : addPaths(r.filePaths);
});
ipcMain.handle('files:add', (_e, paths) => addPaths(paths));
ipcMain.handle('files:remove', (_e, ids) => { for (const id of Array.isArray(ids) ? ids : []) if (!inflight.has(id)) files.delete(id); });
ipcMain.handle('files:clear', () => { if (pool) pool.cancel(); inflight.clear(); files.clear(); pictureOrder.length = 0; });

// ---- inspecting ----------------------------------------------------------------------------------------------------------------
/** What the list needs (small): the verdict, the facts and a few numbers. The picture stays here until it is asked for. */
function summary(row) {
  const r = row.result;
  return { verdict: r.verdict, facts: R.facts(r), format: `${r.info.codecName}`, rate: r.info.sampleRate, bits: r.info.lossless ? (r.info.float ? `${r.info.bitsDeclared}f` : r.info.bitsDeclared) : null, kbps: r.info.streamBitrate || r.info.containerBitrate || r.info.actualBitrate, lossless: r.info.lossless };
}
function keepPicture(id) {
  const i = pictureOrder.indexOf(id); if (i >= 0) pictureOrder.splice(i, 1);
  pictureOrder.push(id);
  while (pictureOrder.length > KEEP_PICTURES) {
    const old = files.get(pictureOrder.shift());
    if (old && old.result) old.result.m.spectrogram.data = null;
  }
}
async function inspectOne(id) {
  const row = files.get(id);
  if (!row) return { id, status: 'cancelled' };
  inflight.add(id);
  try {
    const result = await getPool().run(row.path);
    row.result = result; row.error = null;
    keepPicture(id);
    return { id, status: 'done', ...summary(row) };
  } catch (e) {
    if (e && e.cancelled) return { id, status: 'cancelled' };
    row.error = cleanError(e); row.result = null;
    return { id, status: 'error', error: row.error };
  } finally { inflight.delete(id); }
}
ipcMain.handle('inspect:start', async (_e, ids) => {
  const list = (Array.isArray(ids) ? ids : []).filter((id) => files.has(id) && !inflight.has(id));
  let done = 0; let failed = 0; let cancelled = 0;
  await Promise.all(list.map(async (id) => {
    send('inspect:row', { id, status: 'working' });
    const r = await inspectOne(id);
    if (r.status === 'done') done++; else if (r.status === 'error') failed++; else cancelled++;
    send('inspect:row', r);
  }));
  return { done, failed, cancelled };
});
ipcMain.handle('inspect:cancel', () => { if (pool) pool.cancel(); });

ipcMain.handle('file:detail', async (_e, id) => {
  const row = files.get(id);
  if (!row) return { ok: false, error: 'That file is not in the list any more' };
  if (!row.result) return { ok: false, error: row.error || 'Not inspected yet' };
  if (!row.result.m.spectrogram.data) {         // the picture was let go to save memory: measure again
    const r = await inspectOne(id);
    if (r.status !== 'done') return { ok: false, error: r.error || 'Stopped' };
  } else keepPicture(id);
  const m = row.result.m;
  return { ok: true, id, name: row.name, folder: row.folder, ...summary(row), spectrum: { db: m.spectrum.db, binHz: m.spectrum.binHz }, spectrogram: m.spectrogram, seconds: m.seconds, sampleRate: m.sampleRate };
});

// ---- reports -----------------------------------------------------------------------------------------------------------------------
ipcMain.handle('report:save', async (_e, req) => {
  try {
    const kind = req && req.kind;
    if (kind !== 'csv' && kind !== 'txt') throw new Error('Unknown report type');
    const ids = (Array.isArray(req.ids) ? req.ids : []).filter((id) => files.has(id));
    const rows = ids.map((id) => files.get(id)).filter((f) => f.result || f.error).map((f) => ({ name: f.name, folder: f.folder, result: f.result, error: f.error }));
    if (!rows.length) throw new Error('Nothing has been inspected yet');
    const pick = await dialog.showSaveDialog(win, {
      title: kind === 'csv' ? 'Save the results as a spreadsheet (CSV)' : 'Save the report as text',
      defaultPath: path.join(app.getPath('documents'), kind === 'csv' ? 'audio-inspector.csv' : 'audio-inspector.txt'),
      filters: [{ name: kind === 'csv' ? 'CSV' : 'Text', extensions: [kind] }],
    });
    if (pick.canceled || !pick.filePath) return { ok: false, dialogCancelled: true };
    let out = pick.filePath;
    if (P.extOf(out) !== '.' + kind) out += '.' + kind;
    // the extension is always .csv or .txt, so a report can never land on a music file, whatever name was typed
    const content = '﻿' + (kind === 'csv' ? R.csv(rows) : R.text(rows));   // the BOM makes Excel read accents correctly
    let backup = null;
    if (fs.existsSync(out)) { backup = out + '.bak'; fs.copyFileSync(out, backup); }
    const part = out + '.part';
    await fs.promises.writeFile(part, content, 'utf8');
    await fs.promises.rename(part, out);
    produced.add(out);
    return { ok: true, path: out, count: rows.length, backup };
  } catch (e) { return { ok: false, error: cleanError(e) }; }
});
ipcMain.handle('reveal', (_e, file) => { if (typeof file === 'string' && produced.has(file)) shell.showItemInFolder(file); });

// ---- start up ------------------------------------------------------------------------------------------------------------------
const pathsFromArgs = (argv) => argv.slice(app.isPackaged ? 1 : 2).filter((a) => a && !a.startsWith('-') && path.isAbsolute(a));
async function openAndSend(paths) { const r = await addPaths(paths); if (r.rows.length) send('files:opened', r); }
function cleanUp() { try { if (pool) pool.close(); } catch { /* ignore */ } }

const gotLock = SELFTEST || E2E ? true : app.requestSingleInstanceLock();
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
} else if (!gotLock) app.quit();
else {
  app.on('second-instance', (_e, argv) => {
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
    const paths = pathsFromArgs(argv);
    if (paths.length) openAndSend(paths);
  });
  app.whenReady().then(() => {
    createWindow();
    if (E2E) {
      win.webContents.once('did-finish-load', () => {
        const arg = (name) => (process.argv.find((a) => a.startsWith(name + '=')) || '').slice(name.length + 1);
        const ctx = { app, getWin: () => win, outFile: arg('--e2e-out'), shotsDir: arg('--shots'), outDir: arg('--readme-shots'), dialog, shell, produced };
        if (ctx.outDir) require('../test/readme-shots').run(ctx); else require('../test/e2e').run(ctx);
      });
      return;
    }
    const startup = pathsFromArgs(process.argv);
    if (startup.length) win.webContents.once('did-finish-load', () => openAndSend(startup));
  });
  app.on('window-all-closed', () => { cleanUp(); app.quit(); });
}
