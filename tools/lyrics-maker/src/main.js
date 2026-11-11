'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, Menu, protocol, powerSaveBlocker } = require('electron');
const fs = require('original-fs');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');
const P = require('./plan');
const A = require('./audio');
const E = require('./engine');
const M = require('./models');

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
let engineModel = null;                // which speech model the loaded engine is
let modelJob = null;                   // { abort } while a model is being downloaded
const modelDirs = () => ({ bundledDir: E.modelDir(), userDir: app.getPath('userData') });
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
    const stem = p.replace(/\.[^.\\/]+$/, '');
    return { ok: true, id, name: path.basename(p), duration, url: `lyrics://s/${id}`, estimate: P.estimateSeconds(duration), existingTtml: fs.existsSync(stem + '.ttml'), existingLrc: fs.existsSync(stem + '.lrc') };
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
  const e = engine; engine = null; engineStarting = null; engineModel = null;
  if (e) { try { await e.release(); } catch { /* ignore */ } }
}
async function getEngine(model = 'standard') {
  if ((engine || engineStarting) && engineModel !== model) await dropEngine();   // another model was asked for: let the old one go first
  engineModel = model;
  if (engine) return engine;
  if (!engineStarting) {
    const starting = E.createEngine({ dir: M.dirFor(model, modelDirs()) }).then((e) => {
      if (engineStarting !== starting) { e.release().catch(() => {}); throw new Error('The speech model was changed while it was starting'); }   // let go in the meantime
      engine = e; return e;
    }, (err) => { if (engineStarting === starting) { engineStarting = null; engineModel = null; } throw err; });
    engineStarting = starting;
  }
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
    const lyrics = typeof (req && req.lyrics) === 'string' ? P.pastedLines(req.lyrics) : [];   // the user's own lyrics, to be timed
    const model = (req && req.model) || 'standard';
    if (!M.MODELS[model]) throw new P.UserError('Unknown model');
    if (!M.installed(model, modelDirs())) throw new P.UserError('The accurate model is not downloaded yet. Download it first (under Model), or choose Standard.');
    send('make:phase', { phase: engine && engineModel === model ? 'reading' : 'loading' });
    const eng = await getEngine(model);
    if (ac.signal.aborted) return { ok: false, cancelled: true };
    let last = 0;
    const t0 = Date.now();
    const r = await E.makeLyrics(eng, s.path, {
      language, signal: ac.signal, lyrics: lyrics.length ? lyrics : null,
      onPhase: (phase) => send('make:phase', { phase }),
      onSegments: (segments) => send('make:lines', { lines: P.buildLines(segments, { spaced: language === 'auto' || !NO_SPACE.has(language) }) }),
      onProgress: (p) => {
        const now = Date.now();
        if (now - last < 150 && p.fraction < 1) return;
        last = now;
        send('make:progress', { fraction: p.fraction, elapsed: p.elapsed, phase: p.phase, eta: p.fraction > 0.12 && p.phase !== 'timing' ? (p.elapsed / p.fraction) * (1 - p.fraction) : null });
      },
    });
    // pasted lyrics: a line with few of its words heard, that the model also finds unlikely where it was put, may be misplaced
    const lines = r.lines ? r.lines.map(({ matched, confidence, ...l }) => ({ ...l, ...(matched < 0.5 && confidence < -3 ? { doubt: true } : {}) }))
      : P.buildLines(r.segments, { spaced: !NO_SPACE.has(r.language) });
    return { ok: true, language: r.language, languageName: P.LANGUAGES[r.language] || r.language, lines, seconds: (Date.now() - t0) / 1000, ...(r.lines ? { fromLyrics: true, matched: r.matched } : {}) };
  } catch (e) {
    if (e && e.cancelled) return { ok: false, cancelled: true };
    return { ok: false, error: cleanError(e) };
  } finally { powerSaveBlocker.stop(blocker); job = null; armIdle(); }
});
ipcMain.handle('make:cancel', () => { if (job) job.abort(); });

// ---- speech models ------------------------------------------------------------------------------------------------------------
ipcMain.handle('models:list', () => M.list(modelDirs()));
ipcMain.handle('models:download', async (_e, id) => {
  if (modelJob) return { ok: false, error: 'A download is already running' };
  if (!M.MODELS[id] || M.MODELS[id].bundled) return { ok: false, error: 'Unknown model' };
  const ac = new AbortController();
  modelJob = { abort: () => ac.abort() };
  const blocker = powerSaveBlocker.start('prevent-app-suspension');
  let last = 0;
  try {
    const { net } = require('electron');
    // in the window tests, the files come from a local test server instead of the internet
    const base = (E2E && process.env.LM_MODEL_BASE) || null;
    await M.download(id, modelDirs(), {
      fetch: (url, init) => net.fetch(url, init), signal: ac.signal,
      ...(base ? { urlFor: (f) => base.replace(/\/$/, '') + '/' + f.name } : {}),
      onProgress: (p) => { const now = Date.now(); if (now - last > 200 || p.done === p.total) { last = now; send('models:progress', { id, ...p }); } },
    });
    return { ok: true };
  } catch (e) {
    if (e && e.cancelled) return { ok: false, cancelled: true };
    return { ok: false, error: cleanError(e) };
  } finally { powerSaveBlocker.stop(blocker); modelJob = null; }
});
ipcMain.handle('models:cancel', () => { if (modelJob) modelJob.abort(); });
ipcMain.handle('models:remove', async (_e, id) => {
  try {
    if (job && engineModel === id) throw new P.UserError('Wait until the lyrics are made');
    if (engineModel === id) await dropEngine();
    await M.remove(id, modelDirs());
    return { ok: true };
  } catch (e) { return { ok: false, error: cleanError(e) }; }
});

// ---- saving -----------------------------------------------------------------------------------------------------------------------
const SAVE_KINDS = {
  ttml: { ext: '.ttml', title: 'Save the word-synced lyrics', filter: 'Word-synced lyrics (TTML)' },
  lrc: { ext: '.lrc', title: 'Save the timed lyrics', filter: 'Timed lyrics' },
  txt: { ext: '.txt', title: 'Save the lyrics as text', filter: 'Text' },
};
const num = (x) => (typeof x === 'number' && Number.isFinite(x) ? Math.max(0, Math.min(x, 24 * 3600)) : null);
/** Lines from the window, checked: text, times, and (for TTML) the timed words. */
function cleanLines(list) {
  return (Array.isArray(list) ? list : []).filter((l) => l && typeof l.text === 'string' && num(l.start) != null).slice(0, 5000).map((l) => {
    const line = { start: num(l.start), text: l.text.slice(0, 500) };
    if (num(l.end) != null) line.end = num(l.end);
    if (Array.isArray(l.words)) {
      const words = l.words.slice(0, 500).filter((w) => w && typeof w.text === 'string' && num(w.start) != null).map((w) => ({ text: w.text.slice(0, 200), start: num(w.start), end: num(w.end) != null ? num(w.end) : num(w.start) }));
      if (words.length) line.words = words;
    }
    return line;
  });
}

ipcMain.handle('lyrics:save', async (_e, req) => {
  try {
    const s = registered(req && req.id);
    const kind = req && req.kind;
    const k = Object.prototype.hasOwnProperty.call(SAVE_KINDS, kind) ? SAVE_KINDS[kind] : null;
    if (!k) throw new P.UserError('Unknown file type');
    if (Array.isArray(req.lines) && req.lines.length > 5000) throw new P.UserError('Too many lines');
    const lines = cleanLines(req.lines);
    if (!lines.some((l) => l.text.trim())) throw new P.UserError('There are no lyrics to save yet');
    const language = typeof req.language === 'string' && P.LANGUAGES[req.language] ? req.language : '';
    const title = s.name.replace(/\.[^.]*$/, '');
    const content = kind === 'ttml' ? P.formatTtml(lines, { language, title, duration: s.duration, spaced: language ? !NO_SPACE.has(language) : undefined })
      : kind === 'lrc' ? P.formatLrc(lines) : P.formatPlain(lines);
    const ext = k.ext;
    const pick = await dialog.showSaveDialog(win, {
      title: k.title,
      defaultPath: path.join(path.dirname(s.path), P.defaultName(s.name, ext)),
      filters: [{ name: k.filter, extensions: [ext.slice(1)] }],
    });
    if (pick.canceled || !pick.filePath) return { ok: false, dialogCancelled: true };
    let out = pick.filePath;
    if (P.extOf(out) !== ext) out += ext;
    // the extension is always .ttml, .lrc or .txt, so a save can never land on a song, whatever name was typed
    let backup = null;
    if (fs.existsSync(out)) { backup = out + '.bak'; fs.copyFileSync(out, backup); }   // the file being replaced is kept as .bak
    const part = out + '.part';
    // TTML is XML, which declares its own encoding: no byte order mark there; .lrc and .txt get one so old players read them as UTF-8
    await fs.promises.writeFile(part, (kind === 'ttml' ? '' : '\uFEFF') + content, 'utf8');
    await fs.promises.rename(part, out);
    produced.add(out);
    return { ok: true, path: out, lines: lines.filter((l) => l.text.trim()).length, backup };
  } catch (e) { return { ok: false, error: cleanError(e) }; }
});

// Load lyrics made earlier (or by another program) to fix them: a .ttml keeps its word times, an .lrc gives lines only.
ipcMain.handle('lyrics:load', async (_e, req) => {
  try {
    const s = registered(req && req.id);
    const stem = s.path.replace(/\.[^.\\/]+$/, '');
    const guess = ['.ttml', '.lrc'].map((x) => stem + x).find((f) => fs.existsSync(f));
    const r = await dialog.showOpenDialog(win, {
      title: 'Load lyrics to edit', defaultPath: guess || path.dirname(s.path), properties: ['openFile'],
      filters: [{ name: 'Lyrics (TTML or LRC)', extensions: ['ttml', 'xml', 'lrc'] }],
    });
    if (r.canceled || !r.filePaths[0]) return { ok: false, dialogCancelled: true };
    const file = r.filePaths[0];
    const st = await fs.promises.stat(file);
    if (st.size > 8 * 1024 * 1024) throw new P.UserError('This file is too big to be lyrics');
    const text = await fs.promises.readFile(file, 'utf8');
    const isTtml = /<tt[\s>]/.test(text.slice(0, 4096));
    const lines = isTtml ? P.parseTtml(text) : P.parseLrc(text);
    if (!lines.length) throw new P.UserError(isTtml ? 'No timed lines were found in this TTML file' : 'No timed lines were found in this file (an .lrc line starts with a time like [01:05.40])');
    const lang = isTtml ? (/<tt[^>]*\sxml:lang\s*=\s*["']([\w-]+)["']/.exec(text) || [])[1] : null;
    return { ok: true, name: path.basename(file), kind: isTtml ? 'ttml' : 'lrc', lines, language: lang && P.LANGUAGES[lang.split('-')[0]] ? lang.split('-')[0] : null };
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
function cleanUp() { if (job) job.abort(); if (modelJob) modelJob.abort(); clearTimeout(idleTimer); const e = engine; engine = null; if (e) e.release().catch(() => {}); }

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
