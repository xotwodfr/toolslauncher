'use strict';
const { app, BrowserWindow, ipcMain, dialog, Menu } = require('electron');
const fs = require('original-fs');
const path = require('path');
const { spawnSync } = require('child_process');
const M = require('./music');
const T = require('./tags');
const { Pool, ffmpegPath } = require('./pool');

const E2E = process.argv.includes('--e2e');
const SELFTEST = process.argv.find((a) => a.startsWith('--self-test='));
if (E2E || SELFTEST) app.setPath('userData', path.join(app.getPath('temp'), `bpm-key-finder-test-${process.pid}`));

const MAX_SONGS = 5000;
const CSV_LIMIT = 20 * 1024 * 1024;

let win = null;
let pool = null;
let nextId = 1;
const songs = new Map();        // id -> { path, durationMs, ... } the renderer only ever names songs by id
const inflight = new Set();     // ids being analysed
let writing = false;

const send = (channel, payload) => { if (win && !win.isDestroyed()) win.webContents.send(channel, payload); };
const cleanError = (e) => String((e && e.message) || e);
const getPool = () => pool || (pool = new Pool());

function createWindow() {
  win = new BrowserWindow({
    width: 1240, height: 780, minWidth: 940, minHeight: 560,
    backgroundColor: '#0b0b0d', title: 'BPM & Key Finder', autoHideMenuBar: true, show: !SELFTEST,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false },
  });
  Menu.setApplicationMenu(null);
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'), (E2E || SELFTEST) ? { hash: 'e2e' } : undefined);
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.on('closed', () => { win = null; });
}

// ---- adding songs -------------------------------------------------------------------------------------------------------
async function expandPaths(inputs) {
  const out = [];
  const seen = new Set([...songs.values()].map((s) => s.path));
  async function visit(p, depth) {
    if (out.length + songs.size >= MAX_SONGS || typeof p !== 'string') return;
    let st;
    try { st = await fs.promises.stat(p); } catch { return; }
    if (st.isDirectory()) {
      if (depth >= 6) return;
      let names = [];
      try { names = await fs.promises.readdir(p); } catch { return; }
      names.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
      for (const name of names) await visit(path.join(p, name), depth + 1);
    } else if (st.isFile() && M.isAudio(p) && !seen.has(p)) {
      seen.add(p);
      out.push(p);
    }
  }
  for (const p of inputs) await visit(p, 0);
  return out;
}

async function addPaths(inputs) {
  const list = (Array.isArray(inputs) ? inputs : []).filter((p) => typeof p === 'string');
  const files = await expandPaths(list);
  const rows = [];
  for (const file of files) {
    const t = T.readTags(file);
    const id = nextId++;
    songs.set(id, { path: file, durationMs: t.durationMs });
    rows.push({
      id, name: path.basename(file), folder: path.basename(path.dirname(file)), ext: M.extOf(file).slice(1),
      title: t.title, artist: t.artist, durationMs: t.durationMs, tagBpm: t.tagBpm, tagKey: t.tagKey, canWrite: t.canWrite, tagError: t.tagError,
    });
  }
  const capped = songs.size >= MAX_SONGS;
  return { rows, capped, ignored: list.length && !rows.length };
}

ipcMain.handle('files:pick', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Add songs', properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Audio', extensions: M.INPUT_EXTS.map((e) => e.slice(1)) }],
  });
  return r.canceled ? { rows: [] } : addPaths(r.filePaths);
});
ipcMain.handle('files:pick-folder', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Add a folder of songs', properties: ['openDirectory'] });
  return r.canceled ? { rows: [] } : addPaths(r.filePaths);
});
ipcMain.handle('files:add', (_e, paths) => addPaths(paths));
ipcMain.handle('files:remove', (_e, ids) => { for (const id of Array.isArray(ids) ? ids : []) { if (!inflight.has(id)) songs.delete(id); } });
ipcMain.handle('files:clear', () => { if (pool) pool.cancel(); inflight.clear(); songs.clear(); });

ipcMain.handle('engine:check', () => {
  const r = spawnSync(ffmpegPath(), ['-hide_banner', '-version'], { encoding: 'utf8', windowsHide: true });
  return r.status === 0 ? { ok: true } : { ok: false, problem: 'ffmpeg could not start' + (r.error ? ': ' + r.error.message : '') };
});

// ---- analysing ---------------------------------------------------------------------------------------------------------
ipcMain.handle('analyse:start', async (_e, ids) => {
  const list = (Array.isArray(ids) ? ids : []).filter((id) => songs.has(id) && !inflight.has(id));
  let done = 0; let failed = 0; let cancelled = 0;
  await Promise.all(list.map(async (id) => {
    inflight.add(id);
    const s = songs.get(id);
    try {
      const result = await getPool().run(s.path, s.durationMs / 1000);
      done++;
      send('analyse:row', { id, status: 'done', result });
    } catch (e) {
      if (e && e.cancelled) { cancelled++; send('analyse:row', { id, status: 'cancelled' }); }
      else { failed++; send('analyse:row', { id, status: 'error', error: cleanError(e) }); }
    } finally { inflight.delete(id); }
  }));
  return { done, failed, cancelled };
});
ipcMain.handle('analyse:cancel', () => { if (pool) pool.cancel(); });

// ---- writing tags ------------------------------------------------------------------------------------------------------
ipcMain.handle('tags:write', async (_e, items) => {
  if (writing) throw new Error('A save is already running');
  const list = Array.isArray(items) ? items : [];
  writing = true;
  const results = [];
  try {
    for (let i = 0; i < list.length; i++) {
      const it = list[i] || {};
      const s = songs.get(it.id);
      if (!s) { results.push({ id: it.id, ok: false, error: 'That song is not in the list any more' }); continue; }
      if (inflight.has(it.id)) { results.push({ id: it.id, ok: false, error: 'Still being analysed' }); continue; }
      try {
        const after = T.writeTags(s.path, { bpm: it.bpm == null ? undefined : it.bpm, key: it.key == null ? undefined : it.key });
        results.push({ id: it.id, ok: true, tagBpm: after.tagBpm, tagKey: after.tagKey });
      } catch (e) { results.push({ id: it.id, ok: false, error: cleanError(e) }); }
      send('write:progress', { done: i + 1, total: list.length });
      await new Promise((r) => setImmediate(r)); // let the window repaint between files
    }
  } finally { writing = false; }
  return results;
});

// ---- CSV ---------------------------------------------------------------------------------------------------------------------
ipcMain.handle('csv:save', async (_e, text) => {
  if (typeof text !== 'string' || !text || text.length > CSV_LIMIT) throw new Error('Nothing to save');
  const pick = await dialog.showSaveDialog(win, { title: 'Save results as CSV', defaultPath: 'bpm-and-keys.csv', filters: [{ name: 'CSV', extensions: ['csv'] }] });
  if (pick.canceled || !pick.filePath) return { ok: false, cancelled: true };
  let out = pick.filePath;
  if (!/\.csv$/i.test(out)) out += '.csv';
  fs.writeFileSync(out, '﻿' + text, 'utf8'); // the BOM makes Excel read accents correctly
  return { ok: true, path: out };
});

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
        const ctx = { app, getWin: () => win, outFile: arg('--e2e-out'), shotsDir: arg('--shots'), outDir: arg('--readme-shots'), dialog };
        if (ctx.outDir) require('../test/readme-shots').run(ctx); else require('../test/e2e').run(ctx);
      });
      return;
    }
    const startup = pathsFromArgs(process.argv);
    if (startup.length) win.webContents.once('did-finish-load', () => openAndSend(startup));
  });
  app.on('window-all-closed', () => { cleanUp(); app.quit(); });
}
