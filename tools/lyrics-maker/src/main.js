'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, Menu, protocol, powerSaveBlocker } = require('electron');
const fs = require('original-fs');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');
const P = require('./plan');
const A = require('./audio');
const E = require('./engine');

const E2E = process.argv.includes('--e2e');
const SELFTEST = process.argv.find((a) => a.startsWith('--self-test='));
if (E2E || SELFTEST) app.setPath('userData', path.join(app.getPath('temp'), `lyrics-maker-test-${process.pid}`));

const IDLE_RELEASE_MS = Number(process.env.LM_IDLE_MS) || 120 * 1000; // the model holds about 1.5 GB while loaded; give it back when nobody is using it

// Our own scheme lets the window play the opened song (with Range requests, so seeking works) and nothing else: it asks for
// "lyrics://s/<id>", never for a path.
protocol.registerSchemesAsPrivileged([{ scheme: 'lyrics', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } }]);

let win = null;
let engine = null;
let engineStarting = null;
let idleTimer = null;
let job = null;                       // { abort } - one song at a time
let nextId = 1;
const songs = new Map();              // id -> { path, name, duration }
const produced = new Set();           // files we wrote - the only ones "Show in folder" may reveal

const send = (channel, payload) => { if (win && !win.isDestroyed()) win.webContents.send(channel, payload); };
const cleanError = (e) => String((e && e.message) || e);
const NO_SPACE = new Set(['zh', 'ja', 'th', 'lo', 'my', 'yue', 'km']);

function createWindow() {
  win = new BrowserWindow({
    width: 1240, height: 820, minWidth: 960, minHeight: 620,
    backgroundColor: '#0b0b0d', title: 'Lyrics Maker', autoHideMenuBar: true, show: !SELFTEST,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false },
  });
  Menu.setApplicationMenu(null);
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'), (E2E || SELFTEST) ? { hash: 'e2e' } : undefined);
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.on('closed', () => { win = null; });
}

// ---- opening a song ---------------------------------------------------------------------------------------------------------
async function openSong(p) {
  if (typeof p !== 'string' || !P.isAudio(p)) return { ok: false, name: path.basename(String(p || '')), error: 'This is not an audio file Lyrics Maker can read' };
  try {
    const st = await fs.promises.stat(p);
    if (!st.isFile()) throw new P.UserError('This is not a file');
    const duration = await A.probe(A.ffmpegPath(), p);
    if (duration > P.MAX_SECONDS) throw new P.UserError(`This song is ${P.formatDuration(duration)} long. Lyrics Maker handles songs up to ${P.formatDuration(P.MAX_SECONDS)}.`);
    const id = nextId++;
    songs.set(id, { path: p, name: path.basename(p), duration });
    const lrc = p.replace(/\.[^.\\/]+$/, '') + '.lrc';
    return { ok: true, id, name: path.basename(p), duration, url: `lyrics://s/${id}`, estimate: P.estimateSeconds(duration), existingLrc: fs.existsSync(lrc) };
  } catch (e) { return { ok: false, name: path.basename(p), error: cleanError(e) }; }
}
const registered = (id) => { const s = songs.get(Number(id)); if (!s) throw new P.UserError('That song is not open any more'); return s; };

ipcMain.handle('engine:check', () => {
  const problems = [];
  const missing = E.missingFiles();
  if (missing.length) problems.push('The speech model files are missing (run "npm run setup" in the tool folder).');
  try { require('onnxruntime-node'); } catch (e) { problems.push('The model runtime could not start: ' + cleanError(e).slice(0, 160)); }
  const warnings = [];
  const gb = os.totalmem() / 1073741824;
  if (gb < 6) warnings.push(`This computer has about ${gb.toFixed(1)} GB of memory. Making lyrics needs about 1.5 GB, so close other programs first; it may be slow.`);
  return { ok: problems.length === 0, problems, warnings };
});

ipcMain.handle('song:pick', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Open a song', properties: ['openFile'], filters: [{ name: 'Audio', extensions: P.INPUT_EXTS.map((e) => e.slice(1)) }] });
  return r.canceled ? null : openSong(r.filePaths[0]);
});
ipcMain.handle('song:open', (_e, p) => openSong(p));
ipcMain.handle('song:forget', (_e, id) => { songs.delete(Number(id)); });

// ---- the model ------------------------------------------------------------------------------------------------------------------
const armIdle = () => {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => { if (!job) dropEngine(); }, IDLE_RELEASE_MS);
  if (idleTimer.unref) idleTimer.unref();
};
async function dropEngine() {
  const e = engine; engine = null; engineStarting = null;
  if (e) { try { await e.release(); } catch { /* ignore */ } }
}
async function getEngine() {
  if (engine) return engine;
  if (!engineStarting) engineStarting = E.createEngine().then((e) => { engine = e; return e; }, (err) => { engineStarting = null; throw err; });
  return engineStarting;
}

ipcMain.handle('make:start', async (_e, req) => {
  if (job) return { ok: false, error: 'Lyrics are already being made' };
  const ac = new AbortController();
  job = { abort: () => ac.abort() };
  clearTimeout(idleTimer);
  const blocker = powerSaveBlocker.start('prevent-app-suspension');
  try {
    const s = registered(req && req.id);
    const language = (req && req.language) || 'auto';
    if (language !== 'auto' && !P.LANGUAGES[language]) throw new P.UserError('Unknown language');
    send('make:phase', { phase: engine ? 'reading' : 'loading' });
    const eng = await getEngine();
    if (ac.signal.aborted) return { ok: false, cancelled: true };
    let last = 0;
    const t0 = Date.now();
    const r = await E.makeLyrics(eng, s.path, {
      language, signal: ac.signal,
      onPhase: (phase) => send('make:phase', { phase }),
      onSegments: (segments) => send('make:lines', { lines: P.buildLines(segments, { spaced: language === 'auto' || !NO_SPACE.has(language) }) }),
      onProgress: (p) => {
        const now = Date.now();
        if (now - last < 150 && p.fraction < 1) return;
        last = now;
        send('make:progress', { fraction: p.fraction, elapsed: p.elapsed, eta: p.fraction > 0.12 ? (p.elapsed / p.fraction) * (1 - p.fraction) : null });
      },
    });
    const lines = P.buildLines(r.segments, { spaced: !NO_SPACE.has(r.language) });
    return { ok: true, language: r.language, languageName: P.LANGUAGES[r.language] || r.language, lines, seconds: (Date.now() - t0) / 1000 };
  } catch (e) {
    if (e && e.cancelled) return { ok: false, cancelled: true };
    return { ok: false, error: cleanError(e) };
  } finally { powerSaveBlocker.stop(blocker); job = null; armIdle(); }
});
ipcMain.handle('make:cancel', () => { if (job) job.abort(); });

// ---- saving -----------------------------------------------------------------------------------------------------------------------
ipcMain.handle('lyrics:save', async (_e, req) => {
  try {
    const s = registered(req && req.id);
    const kind = req && req.kind;
    if (kind !== 'lrc' && kind !== 'txt') throw new P.UserError('Unknown file type');
    const lines = (Array.isArray(req.lines) ? req.lines : []).filter((l) => l && typeof l.text === 'string' && Number.isFinite(l.start)).map((l) => ({ start: Math.max(0, l.start), text: l.text.slice(0, 500) }));
    if (!lines.some((l) => l.text.trim())) throw new P.UserError('There are no lyrics to save yet');
    if (lines.length > 5000) throw new P.UserError('Too many lines');
    const content = kind === 'lrc' ? P.formatLrc(lines) : P.formatPlain(lines);
    const ext = kind === 'lrc' ? '.lrc' : '.txt';
    const pick = await dialog.showSaveDialog(win, {
      title: kind === 'lrc' ? 'Save the timed lyrics' : 'Save the lyrics as text',
      defaultPath: path.join(path.dirname(s.path), P.defaultName(s.name, ext)),
      filters: [{ name: kind === 'lrc' ? 'Timed lyrics' : 'Text', extensions: [ext.slice(1)] }],
    });
    if (pick.canceled || !pick.filePath) return { ok: false, dialogCancelled: true };
    let out = pick.filePath;
    if (P.extOf(out) !== ext) out += ext;
    // the extension is always .lrc or .txt, so a save can never land on a song, whatever name was typed
    let backup = null;
    if (fs.existsSync(out)) { backup = out + '.bak'; fs.copyFileSync(out, backup); }   // the file being replaced is kept as .bak
    const part = out + '.part';
    await fs.promises.writeFile(part, '﻿' + content, 'utf8');
    await fs.promises.rename(part, out);
    produced.add(out);
    return { ok: true, path: out, lines: lines.filter((l) => l.text.trim()).length, backup };
  } catch (e) { return { ok: false, error: cleanError(e) }; }
});
ipcMain.handle('reveal', (_e, file) => { if (produced.has(file)) shell.showItemInFolder(file); });

// ---- lyrics:// ----------------------------------------------------------------------------------------------------------------------
const CORS = { 'Access-Control-Allow-Origin': '*' };
const MIME = { '.mp3': 'audio/mpeg', '.flac': 'audio/flac', '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.opus': 'audio/ogg', '.m4a': 'audio/mp4', '.mp4': 'audio/mp4', '.aac': 'audio/aac', '.wav': 'audio/wav', '.webm': 'audio/webm', '.aif': 'audio/aiff', '.aiff': 'audio/aiff' };

function fileResponse(abs, req) {
  let st;
  try { st = fs.statSync(abs); } catch { return new Response('Not found', { status: 404, headers: CORS }); }
  const size = st.size;
  const type = MIME[P.extOf(abs)] || 'application/octet-stream';
  let start = 0; let end = size - 1; let status = 200;
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
  protocol.handle('lyrics', (req) => {
    try {
      const u = new URL(req.url);
      const m = /^\/(\d+)$/.exec(u.pathname);
      const s = m && songs.get(Number(m[1]));
      if (u.hostname !== 's' || !s) return new Response('Not found', { status: 404, headers: CORS });
      return fileResponse(s.path, req);
    } catch { return new Response('Bad request', { status: 400, headers: CORS }); }
  });
}

// ---- start up ----------------------------------------------------------------------------------------------------------------------------
const pathsFromArgs = (argv) => argv.slice(app.isPackaged ? 1 : 2).filter((a) => a && !a.startsWith('-') && path.isAbsolute(a) && P.isAudio(a));
async function openAndSend(paths) { send('song:opened', await openSong(paths[0])); }
function cleanUp() { if (job) job.abort(); clearTimeout(idleTimer); const e = engine; engine = null; if (e) e.release().catch(() => {}); }

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
    await dropEngine();
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
        const arg = (name) => (process.argv.find((a) => a.startsWith(name + '=')) || '').slice(name.length + 1);
        const ctx = { app, getWin: () => win, outFile: arg('--e2e-out'), shotsDir: arg('--shots'), outDir: arg('--readme-shots'), dialog, shell, produced, engineLoaded: () => !!engine };
        if (ctx.outDir) require('../test/readme-shots').run(ctx); else require('../test/e2e').run(ctx);
      });
      return;
    }
    const startup = pathsFromArgs(process.argv);
    if (startup.length) win.webContents.once('did-finish-load', () => openAndSend(startup));
  });
  app.on('window-all-closed', () => { cleanUp(); app.quit(); });
}
