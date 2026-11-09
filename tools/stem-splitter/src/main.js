'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, Menu, protocol, powerSaveBlocker } = require('electron');
const fs = require('original-fs');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');
const P = require('./plan');
const S = require('./stems');

const E2E = process.argv.includes('--e2e');
const SELFTEST = process.argv.find((a) => a.startsWith('--self-test='));
if (E2E || SELFTEST) app.setPath('userData', path.join(app.getPath('temp'), `stem-splitter-test-${process.pid}`));

// Our own scheme gives the window the separated stems (with Range requests) and nothing else: it asks for
// "stems://s/<key>/<stem>.wav", never for a path.
protocol.registerSchemesAsPrivileged([{ scheme: 'stems', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } }]);

let win = null;
let nextId = 1;
const songs = new Map();    // id -> { path, name, duration, key }   the songs the user opened
const produced = new Set(); // files we made - the only ones "Show in folder" may reveal
let job = null;             // { abort } - one split or export at a time
let current = null;         // { id, key, dir, meta } - the song whose stems the window is showing
const cacheRoot = () => path.join(app.getPath('userData'), 'stems');

const send = (channel, payload) => { if (win && !win.isDestroyed()) win.webContents.send(channel, payload); };
const cleanError = (e) => String((e && e.message) || e);

function createWindow() {
  win = new BrowserWindow({
    width: 1180, height: 820, minWidth: 880, minHeight: 640,
    backgroundColor: '#0b0b0d', title: 'Stem Splitter', autoHideMenuBar: true, show: !SELFTEST,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false },
  });
  Menu.setApplicationMenu(null);
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'), (E2E || SELFTEST) ? { hash: 'e2e' } : undefined);
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.on('closed', () => { win = null; });
}

// ---- opening a song --------------------------------------------------------------------------------------------------
async function openSong(p) {
  if (typeof p !== 'string' || !P.isSupportedInput(p)) return { ok: false, path: p, name: path.basename(String(p || '')), error: 'This is not an audio file Stem Splitter can read' };
  try {
    const st = await fs.promises.stat(p);
    if (!st.isFile()) throw new P.UserError('This is not a file');
    const info = await S.probe(p);
    const key = S.cacheKey(p);
    const id = nextId++;
    songs.set(id, { path: p, name: path.basename(p), duration: info.duration, key });
    const cached = !!S.readCache(cacheRoot(), key);
    return {
      ok: true, id, name: path.basename(p), path: p, duration: info.duration, cached, key,
      estimate: P.estimateSeconds(info.duration), previewOk: info.duration <= P.MAX_PREVIEW_SECONDS,
    };
  } catch (e) { return { ok: false, path: p, name: path.basename(p), error: cleanError(e) }; }
}

/** A drop or a command line can name several things; this tool works on one song at a time, so the first usable one wins. */
async function openPaths(paths) {
  const list = (Array.isArray(paths) ? paths : []).filter((p) => typeof p === 'string');
  if (!list.length) return { ok: false, error: 'Nothing to open' };
  const first = list.find((p) => P.isSupportedInput(p)) || list[0];
  const r = await openSong(first);
  if (r.ok && list.length > 1) r.note = 'Only one song can be split at a time, so the first one was opened.';
  return r;
}

const registered = (id) => {
  const s = songs.get(Number(id));
  if (!s) throw new P.UserError('That song is not open any more');
  return s;
};

ipcMain.handle('engine:check', async () => {
  const problems = [];
  if (!fs.existsSync(S.modelPath())) problems.push('The separation model file is missing (run "npm run setup" in the tool folder).');
  try { require('onnxruntime-node'); } catch (e) { problems.push('The model runtime could not start: ' + cleanError(e).slice(0, 160)); }
  try {
    const enc = await S.checkEncoders();
    if (!enc.ok) problems.push('ffmpeg lacks: ' + enc.missing.join(', '));
  } catch (e) { problems.push(cleanError(e)); }
  // not a blocker, just honest: loading the model briefly needs about 4.5 GB, then about 2.5 GB while it separates
  const warnings = [];
  const gb = os.totalmem() / 1073741824;
  if (gb < 7.5) warnings.push(`This computer has about ${gb.toFixed(1)} GB of memory. Splitting needs up to about 4.5 GB for a few seconds and then about 2.5 GB, so close other programs first; it may be slow or fail.`);
  return { ok: problems.length === 0, problems, warnings };
});

ipcMain.handle('song:pick', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Open a song', properties: ['openFile'],
    filters: [{ name: 'Audio', extensions: P.INPUT_EXTS.map((e) => e.slice(1)) }],
  });
  return r.canceled ? null : openSong(r.filePaths[0]);
});
ipcMain.handle('song:open', (_e, paths) => openPaths(paths));
ipcMain.handle('song:forget', (_e, id) => { songs.delete(Number(id)); if (current && current.id === Number(id)) current = null; });

// ---- splitting ---------------------------------------------------------------------------------------------------------
const stemUrls = (key) => Object.fromEntries(P.STEM_IDS.map((id) => [id, `stems://s/${key}/${P.stemFile(id)}`]));

async function withJob(fn) {
  if (job) throw new P.UserError('Something is already running');
  const ac = new AbortController();
  job = { abort: () => ac.abort() };
  const blocker = powerSaveBlocker.start('prevent-app-suspension'); // do not let the computer sleep in the middle of a long split
  try { return await fn(ac.signal); } finally { powerSaveBlocker.stop(blocker); job = null; }
}

ipcMain.handle('split:start', async (_e, id) => {
  try {
    const s = registered(id);
    return await withJob(async (signal) => {
      let runner = null;
      let last = 0;
      try {
        const r = await S.ensureStems({
          source: s.path, root: cacheRoot(), signal,
          getRunner: async () => { runner = await S.createRunner(); return runner; },
          onProgress: (p) => { const now = Date.now(); if (now - last > 120 || p.fraction >= 1) { last = now; send('job:progress', { kind: 'split', ...p }); } },
        });
        current = { id: Number(id), key: r.key, dir: r.dir, meta: r.meta };
        S.pruneCache(cacheRoot(), { keep: 4, protect: [r.key] });
        return { ok: true, key: r.key, fromCache: r.fromCache, duration: r.meta.duration, seconds: r.meta.seconds, stems: stemUrls(r.key) };
      } finally { if (runner) { try { await runner.release(); } catch { /* ignore */ } } }
    });
  } catch (e) { return e.cancelled ? { ok: false, cancelled: true } : { ok: false, error: cleanError(e) }; }
});

ipcMain.handle('job:cancel', () => { if (job) job.abort(); });

// ---- saving ------------------------------------------------------------------------------------------------------------
ipcMain.handle('export:start', async (_e, id, mix, format) => {
  try {
    const s = registered(id);
    const fmt = P.FORMATS[format];
    if (!fmt) throw new P.UserError('Unknown format');
    const active = P.activeStems(mix);                           // throws a readable error when nothing is ticked
    const hit = S.readCache(cacheRoot(), s.key);
    if (!hit) throw new P.UserError('Split this song first');
    const ids = active.map((a) => a.id);
    const pick = await dialog.showSaveDialog(win, {
      title: 'Save the mix', defaultPath: path.join(path.dirname(s.path), P.defaultName(s.name, ids, format)),
      filters: [{ name: fmt.label, extensions: [fmt.ext.slice(1)] }],
    });
    if (pick.canceled || !pick.filePath) return { ok: false, dialogCancelled: true };
    let output = pick.filePath;
    if (P.extOf(output) !== fmt.ext) output += fmt.ext;
    return await withJob(async (signal) => {
      let last = 0;
      const r = await S.exportMix({
        dir: hit.dir, meta: hit.meta, mix: active, format, output, sourcePath: s.path, signal,
        onProgress: (f) => { if (f - last >= 0.01 || f === 1) { last = f; send('job:progress', { kind: 'export', fraction: f }); } },
      });
      produced.add(r.output);
      return { ok: true, output: r.output, bytes: r.bytes, seconds: r.seconds, elapsed: r.elapsed, what: P.describe(ids) };
    });
  } catch (e) { return e.cancelled ? { ok: false, cancelled: true } : { ok: false, error: cleanError(e) }; }
});

ipcMain.handle('reveal', (_e, file) => { if (produced.has(file)) shell.showItemInFolder(file); });

ipcMain.handle('cache:info', () => {
  const list = S.listCache(cacheRoot());
  return { count: list.length, bytes: list.reduce((n, e) => n + e.bytes, 0) };
});
ipcMain.handle('cache:clear', () => {
  const removed = S.clearCache(cacheRoot(), current ? [current.key] : []);
  const list = S.listCache(cacheRoot());
  return { removed, count: list.length, bytes: list.reduce((n, e) => n + e.bytes, 0) };
});

// ---- stems:// ------------------------------------------------------------------------------------------------------------
const CORS = { 'Access-Control-Allow-Origin': '*' };
const FILE_RE = new RegExp(`^(${P.STEM_IDS.join('|')})\\.wav$`);

function fileResponse(abs, req) {
  let st;
  try { st = fs.statSync(abs); } catch { return new Response('Not found', { status: 404, headers: CORS }); }
  const size = st.size;
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
  if (size === 0) return new Response(null, { status: 200, headers: { ...CORS, 'Content-Type': 'audio/wav', 'Content-Length': '0' } });
  const stream = fs.createReadStream(abs, { start, end });
  if (req.signal) req.signal.addEventListener('abort', () => stream.destroy(), { once: true });
  const headers = { ...CORS, 'Content-Type': 'audio/wav', 'Accept-Ranges': 'bytes', 'Content-Length': String(end - start + 1), 'Cache-Control': 'no-store' };
  if (status === 206) headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
  return new Response(Readable.toWeb(stream), { status, headers });
}

function registerProtocol() {
  protocol.handle('stems', (req) => {
    try {
      const u = new URL(req.url);
      const [key, file] = u.pathname.replace(/^\//, '').split('/');
      if (u.hostname !== 's' || !S.isKey(key) || !FILE_RE.test(file || '')) return new Response('Not found', { status: 404, headers: CORS });
      return fileResponse(path.join(S.dirFor(cacheRoot(), key), file), req);
    } catch { return new Response('Bad request', { status: 400, headers: CORS }); }
  });
}

// ---- start up ------------------------------------------------------------------------------------------------------------------
const pathsFromArgs = (argv) => argv.slice(app.isPackaged ? 1 : 2).filter((a) => a && !a.startsWith('-') && path.isAbsolute(a));

async function openAndSend(paths) {
  const r = await openPaths(paths);
  if (r.ok || r.error) send('song:opened', r);
}

function cleanUp() {
  if (job) job.abort();
  try { S.pruneCache(cacheRoot(), { keep: 4, protect: current ? [current.key] : [] }); } catch { /* ignore */ }
}

const gotLock = SELFTEST || E2E ? true : app.requestSingleInstanceLock();
if (SELFTEST) {
  app.whenReady().then(async () => {
    registerProtocol();
    createWindow();
    const outFile = SELFTEST.slice('--self-test='.length);
    let code = 1;
    try {
      const results = await require('./selftest').run({ getWin: () => win, cacheRoot });
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
    try { S.pruneCache(cacheRoot(), { keep: 4 }); } catch { /* ignore */ }
    if (E2E) {
      win.webContents.once('did-finish-load', () => {
        const outFile = (process.argv.find((a) => a.startsWith('--e2e-out=')) || '').slice(10);
        const shotsDir = (process.argv.find((a) => a.startsWith('--shots=')) || '').slice(8);
        const readme = (process.argv.find((a) => a.startsWith('--readme-shots=')) || '').slice(15);
        const ctx = { app, getWin: () => win, openPaths, outFile, shotsDir, cacheRoot, outDir: readme, dialog, produced };
        if (readme) require('../test/readme-shots').run(ctx); else require('../test/e2e').run(ctx);
      });
      return;
    }
    const startup = pathsFromArgs(process.argv);
    if (startup.length) win.webContents.once('did-finish-load', () => openAndSend(startup));
  });
  app.on('window-all-closed', () => { cleanUp(); app.quit(); });
}
