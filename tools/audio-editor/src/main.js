'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, Menu, protocol } = require('electron');
const fs = require('original-fs');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');
const P = require('./plan');
const E = require('./edit');

const E2E = process.argv.includes('--e2e');
const SELFTEST = process.argv.find((a) => a.startsWith('--self-test='));
if (E2E || SELFTEST) app.setPath('userData', path.join(app.getPath('temp'), `audio-editor-test-${process.pid}`));

// Our own scheme plays the files the user opened (with Range requests, so seeking works), and nothing else: the window
// asks for "aed://f/<number>", never for a path.
protocol.registerSchemesAsPrivileged([{ scheme: 'aed', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } }]);

let win = null;
let nextId = 1;
const files = new Map();      // id -> { path, name, info }   the files the user opened
const previews = new Map();   // id -> temp wav (a playable copy of a file Chromium can't play, or a rendered preview of the edit)
const peaksJobs = new Map();  // id -> AbortController
const produced = new Set();   // outputs we made - the only files "Show in folder" may reveal
let job = null;               // { abort } - one export or preview at a time
let previewDir = null;

const send = (channel, payload) => { if (win && !win.isDestroyed()) win.webContents.send(channel, payload); };
const cleanError = (e) => String((e && e.message) || e);

function createWindow() {
  win = new BrowserWindow({
    width: 1240, height: 800, minWidth: 980, minHeight: 640,
    backgroundColor: '#0f1117', title: 'Audio Editor', autoHideMenuBar: true, show: !SELFTEST,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false },
  });
  Menu.setApplicationMenu(null);
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'), (E2E || SELFTEST) ? { hash: 'e2e' } : undefined);
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.on('closed', () => { win = null; });
}

// ---- opening files ---------------------------------------------------------------------------------------------------
const MIME = { '.mp3': 'audio/mpeg', '.flac': 'audio/flac', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.opus': 'audio/ogg', '.m4a': 'audio/mp4', '.m4b': 'audio/mp4', '.aac': 'audio/aac' };

/** Files and folders (a folder gives the audio files in it, two levels deep) -> supported audio file paths. */
async function expandPaths(inputs) {
  const out = [];
  const seen = new Set();
  async function visit(p, depth) {
    if (out.length >= 500 || typeof p !== 'string') return;
    let st;
    try { st = await fs.promises.stat(p); } catch { return; }
    if (st.isDirectory()) {
      if (depth >= 2) return;
      let names = [];
      try { names = await fs.promises.readdir(p); } catch { return; }
      names.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
      for (const name of names) await visit(path.join(p, name), depth + 1);
    } else if (st.isFile() && P.isSupportedInput(p) && !seen.has(p)) { seen.add(p); out.push(p); }
  }
  for (const p of inputs) await visit(p, 0);
  return out;
}

async function openFile(p) {
  try {
    const info = await E.probe(p);
    const id = nextId++;
    files.set(id, { path: p, name: path.basename(p), info });
    return { ok: true, id, path: p, name: path.basename(p), ...info };
  } catch (e) { return { ok: false, path: p, name: path.basename(p), error: cleanError(e) }; }
}

async function openPaths(paths) {
  const list = await expandPaths(Array.isArray(paths) ? paths : []);
  const out = [];
  for (const p of list) out.push(await openFile(p));
  return out;
}

const registered = (id) => {
  const f = files.get(Number(id));
  if (!f) throw new Error('That file is not open any more');
  return f;
};

ipcMain.handle('info:encoders', () => E.checkEncoders());
ipcMain.handle('files:pick', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Add audio files', properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Audio', extensions: P.INPUT_EXTS.map((e) => e.slice(1)) }],
  });
  return r.canceled ? [] : openPaths(r.filePaths);
});
ipcMain.handle('files:open', (_e, paths) => openPaths(paths));
ipcMain.handle('files:forget', (_e, id) => {
  const ac = peaksJobs.get(Number(id));
  if (ac) ac.abort();
  files.delete(Number(id));
  const pv = previews.get(Number(id));
  if (pv) { fs.rmSync(pv, { force: true }); previews.delete(Number(id)); }
});
ipcMain.handle('file:peaks', async (_e, id) => {
  const f = registered(id);
  const ac = new AbortController();
  peaksJobs.set(Number(id), ac);
  try {
    const r = await E.peaks(f.path, { signal: ac.signal });
    return { data: r.data, perSec: r.perSec };
  } catch (e) {
    if (e.cancelled) return null;
    throw e;
  } finally { peaksJobs.delete(Number(id)); }
});

function tempDir() {
  if (!previewDir) previewDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audioedit-preview-'));
  return previewDir;
}

/** A playable copy for files the player can't open directly (WMA, APE...): decoded to a plain WAV. */
ipcMain.handle('file:playable', async (_e, id) => {
  const f = registered(id);
  const out = path.join(tempDir(), `play-${Number(id)}.wav`);
  if (!fs.existsSync(out)) await E.run(['-hide_banner', '-nostdin', '-loglevel', 'error', '-protocol_whitelist', 'file', '-i', f.path, '-vn', '-map', '0:a:0', '-f', 'wav', '-y', out]);
  previews.set(Number(id), out);
  return `aed://p/${Number(id)}`;
});

// ---- export and preview ------------------------------------------------------------------------------------------------
/** The window sends file ids and cuts; the facts about each file (path, length...) come from what we read ourselves. */
function itemsFromWindow(list) {
  if (!Array.isArray(list) || !list.length) throw new Error('Add a file first');
  return list.map((x) => {
    const f = registered(x && x.id);
    return { path: f.path, duration: f.info.duration, rate: f.info.rate, channels: f.info.channels, coverStream: f.info.coverStream, cuts: Array.isArray(x.cuts) ? x.cuts : [] };
  });
}

async function runJob(kind, list, opts, output) {
  if (job) throw new Error('Something is already being made');
  const items = itemsFromWindow(list);
  P.normalizeOptions(opts, items[0].path); // throws on bad input before anything starts
  const ac = new AbortController();
  job = { abort: () => ac.abort() };
  let last = 0;
  try {
    const r = await E.render(items, opts, {
      signal: ac.signal, output,
      onProgress: (f) => { if (f - last >= 0.004 || f === 1) { last = f; send('job:progress', { kind, fraction: f }); } },
    });
    return r;
  } finally { job = null; }
}

ipcMain.handle('export:start', async (_e, list, opts) => {
  try {
    const r = await runJob('export', list, opts);
    produced.add(r.output);
    return { ok: true, output: r.output, bytes: r.bytes, seconds: r.seconds, notes: r.notes, elapsed: r.elapsed };
  } catch (e) { return e.cancelled ? { ok: false, cancelled: true } : { ok: false, error: cleanError(e) }; }
});

ipcMain.handle('preview:start', async (_e, list, opts) => {
  try {
    const out = path.join(tempDir(), `result-${Date.now()}.wav`);
    for (const [k, v] of previews) if (String(k).startsWith('r')) { fs.rmSync(v, { force: true }); previews.delete(k); }
    const r = await runJob('preview', list, { ...opts, format: 'wav', name: '', outDir: null }, out);
    previews.set('r1', r.output);
    return { ok: true, url: `aed://p/r1?v=${Date.now()}`, seconds: r.seconds, notes: r.notes };
  } catch (e) { return e.cancelled ? { ok: false, cancelled: true } : { ok: false, error: cleanError(e) }; }
});

ipcMain.handle('job:cancel', () => { if (job) job.abort(); });
ipcMain.handle('dir:pick', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Choose output folder', properties: ['openDirectory', 'createDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle('reveal', (_e, file) => { if (produced.has(file)) shell.showItemInFolder(file); });

// ---- aed:// ---------------------------------------------------------------------------------------------------------------
const CORS = { 'Access-Control-Allow-Origin': '*' };
function fileResponse(abs, req) {
  let st;
  try { st = fs.statSync(abs); } catch { return new Response('Not found', { status: 404, headers: CORS }); }
  const size = st.size;
  const type = MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream';
  let start = 0;
  let end = size - 1;
  let status = 200;
  const range = req.headers.get('range');
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (!m || (m[1] === '' && m[2] === '')) return new Response('Bad range', { status: 416, headers: { ...CORS, 'Content-Range': `bytes */${size}` } });
    if (m[1] === '') start = Math.max(0, size - Number(m[2]));
    else { start = Number(m[1]); if (m[2] !== '') end = Math.min(end, Number(m[2])); }
    if (start >= size || start > end) return new Response('Bad range', { status: 416, headers: { ...CORS, 'Content-Range': `bytes */${size}` } });
    status = 206;
  }
  if (size === 0) return new Response(null, { status: 200, headers: { ...CORS, 'Content-Type': type, 'Content-Length': '0' } });
  const stream = fs.createReadStream(abs, { start, end });
  if (req.signal) req.signal.addEventListener('abort', () => stream.destroy(), { once: true });
  const headers = { ...CORS, 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Length': String(end - start + 1), 'Cache-Control': 'no-store' };
  if (status === 206) headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
  return new Response(Readable.toWeb(stream), { status, headers });
}

function registerProtocol() {
  protocol.handle('aed', (req) => {
    try {
      const u = new URL(req.url);
      const id = decodeURIComponent(u.pathname.replace(/^\//, ''));
      if (u.hostname === 'f') return fileResponse(registered(id).path, req);
      if (u.hostname === 'p') {
        const p = previews.get(/^\d+$/.test(id) ? Number(id) : id);
        if (!p) return new Response('Not found', { status: 404, headers: CORS });
        return fileResponse(p, req);
      }
      return new Response('Not found', { status: 404, headers: CORS });
    } catch { return new Response('Bad request', { status: 400, headers: CORS }); }
  });
}

// ---- start up ---------------------------------------------------------------------------------------------------------------
const pathsFromArgs = (argv) => argv.slice(app.isPackaged ? 1 : 2).filter((a) => a && !a.startsWith('-') && path.isAbsolute(a));

async function openAndSend(paths) {
  const opened = await openPaths(paths);
  if (opened.length) send('files:opened', opened);
}

function cleanUp() {
  if (job) job.abort();
  for (const ac of peaksJobs.values()) ac.abort();
  if (previewDir) { try { fs.rmSync(previewDir, { recursive: true, force: true }); } catch { /* ignore */ } }
}

const gotLock = SELFTEST || E2E ? true : app.requestSingleInstanceLock();
if (SELFTEST) {
  app.whenReady().then(async () => {
    registerProtocol();
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
    registerProtocol();
    createWindow();
    if (E2E) {
      win.webContents.once('did-finish-load', () => {
        const outFile = (process.argv.find((a) => a.startsWith('--e2e-out=')) || '').slice(10);
        const shotsDir = (process.argv.find((a) => a.startsWith('--shots=')) || '').slice(8);
        const readme = (process.argv.find((a) => a.startsWith('--readme-shots=')) || '').slice(15);
        const ctx = { app, getWin: () => win, openPaths, outFile, shotsDir, files, previews, outDir: readme };
        if (readme) require('../test/readme-shots').run(ctx); else require('../test/e2e').run(ctx);
      });
      return;
    }
    const startup = pathsFromArgs(process.argv);
    if (startup.length) win.webContents.once('did-finish-load', () => openAndSend(startup));
  });
  app.on('window-all-closed', () => { cleanUp(); app.quit(); });
}
