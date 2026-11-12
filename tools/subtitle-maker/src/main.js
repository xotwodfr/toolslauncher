'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, Menu, protocol, powerSaveBlocker } = require('electron');
const fs = require('original-fs');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');
const S = require('./subs');
const A = require('./audio');
const E = require('./engine');
const M = require('./media');

const E2E = process.argv.includes('--e2e');
const SELFTEST = process.argv.find((a) => a.startsWith('--self-test='));
if (E2E || SELFTEST) app.setPath('userData', path.join(app.getPath('temp'), `subtitle-maker-test-${process.pid}`));

const IDLE_RELEASE_MS = Number(process.env.SM_IDLE_MS) || 120 * 1000; // the model holds about 1.5 GB while loaded; give it back when nobody is using it
const MAX_CUES = 20000;
const MAX_SUB_BYTES = 8 * 1024 * 1024;

// Our own scheme lets the window play the opened file (with Range requests, so seeking works) and nothing else: it asks for
// "subs://m/<id>", never for a path.
protocol.registerSchemesAsPrivileged([{ scheme: 'subs', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } }]);

let win = null;
let engine = null;
let engineStarting = null;
let idleTimer = null;
let job = null;                       // { abort } - listening, one file at a time
let exportJob = null;                 // { abort } - writing a video
let nextId = 1;
const media = new Map();              // id -> { path, name, info }
const produced = new Set();           // files we wrote - the only ones "Show in folder" may reveal

const send = (channel, payload) => { if (win && !win.isDestroyed()) win.webContents.send(channel, payload); };
const cleanError = (e) => String((e && e.message) || e);

function createWindow() {
  win = new BrowserWindow({
    width: 1240, height: 840, minWidth: 980, minHeight: 640,
    backgroundColor: '#0b0b0d', title: 'Subtitle Maker', autoHideMenuBar: true, show: !SELFTEST,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false },
  });
  Menu.setApplicationMenu(null);
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'), (E2E || SELFTEST) ? { hash: 'e2e' } : undefined);
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.on('closed', () => { win = null; });
}

// ---- checking what the window sends -----------------------------------------------------------------------------------------
const registered = (id) => { const m = media.get(Number(id)); if (!m) throw new S.UserError('That file is not open any more'); return m; };
/** Cues from the window, checked and cleaned: numbers that are numbers, text that is text, a sane amount. */
function cleanCues(list) {
  if (!Array.isArray(list)) throw new S.UserError('No subtitles');
  if (list.length > MAX_CUES) throw new S.UserError('Too many subtitles');
  const out = [];
  for (const c of list) {
    if (!c || typeof c !== 'object' || typeof c.text !== 'string' || !Number.isFinite(c.start) || !Number.isFinite(c.end)) continue;
    if (c.start < 0 || c.end < 0 || c.start > 360000 || c.end > 360000) continue;
    out.push({ start: c.start, end: Math.max(c.start, c.end), text: c.text.slice(0, 2000) });
  }
  return out;
}

// ---- opening ---------------------------------------------------------------------------------------------------------------------
function siblingSubs(p) {
  const base = p.replace(/\.[^.\\/]+$/, '');
  for (const ext of ['.srt', '.vtt']) { const f = base + ext; try { if (fs.statSync(f).isFile()) return f; } catch { /* none */ } }
  return null;
}
async function openMedia(p) {
  if (typeof p !== 'string' || !path.isAbsolute(p) || !S.isMedia(p)) return { ok: false, name: path.basename(String(p || '')), error: 'This is not a video or audio file Subtitle Maker can read' };
  try {
    const st = await fs.promises.stat(p);
    if (!st.isFile()) throw new S.UserError('This is not a file');
    const info = await M.probe(A.ffmpegPath(), p);
    if (info.duration > A.MAX_SECONDS) throw new S.UserError(`This file is ${S.formatDuration(info.duration)} long. Subtitle Maker handles files up to ${S.formatDuration(A.MAX_SECONDS)}.`);
    const id = nextId++;
    media.set(id, { path: p, name: path.basename(p), info });
    const sib = siblingSubs(p);
    return {
      ok: true, id, name: path.basename(p), duration: info.duration, hasVideo: info.hasVideo, width: info.width, height: info.height,
      url: `subs://m/${id}`, estimate: S.estimateSeconds(info.duration), sibling: sib ? path.basename(sib) : null,
    };
  } catch (e) { return { ok: false, name: path.basename(p), error: cleanError(e) }; }
}

async function readSubtitles(p) {
  if (typeof p !== 'string' || !path.isAbsolute(p) || !S.isSubtitle(p)) return { ok: false, error: 'Only .srt and .vtt subtitle files can be opened' };
  try {
    const st = await fs.promises.stat(p);
    if (!st.isFile()) throw new S.UserError('This is not a file');
    if (st.size > MAX_SUB_BYTES) throw new S.UserError('This subtitle file is too big (over 8 MB)');
    const buf = await fs.promises.readFile(p);
    let text = buf.toString('utf8');
    if (buf[0] === 0xff && buf[1] === 0xfe) text = buf.slice(2).toString('utf16le');
    else if (text.includes('�')) text = buf.toString('latin1');           // an old file in a Windows code page: Latin-1 is the best guess
    const r = S.parseSubtitles(text);
    if (r.cues.length > MAX_CUES) throw new S.UserError('This file has too many subtitles');
    return { ok: true, name: path.basename(p), format: r.format, cues: r.cues };
  } catch (e) { return { ok: false, name: path.basename(p), error: cleanError(e) }; }
}

ipcMain.handle('engine:check', () => {
  const problems = [];
  const missing = E.missingFiles();
  if (missing.length) problems.push('The speech model files are missing (run "npm run setup" in the tool folder). Subtitles can still be opened, edited and burnt in.');
  try { require('onnxruntime-node'); } catch (e) { problems.push('The model runtime could not start: ' + cleanError(e).slice(0, 160)); }
  const warnings = [];
  const gb = os.totalmem() / 1073741824;
  if (gb < 6) warnings.push(`This computer has about ${gb.toFixed(1)} GB of memory. Making subtitles needs about 1.5 GB, so close other programs first; it may be slow.`);
  return { ok: problems.length === 0, problems, warnings };
});

ipcMain.handle('media:pick', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Open a video or audio file', properties: ['openFile'], filters: [{ name: 'Video and audio', extensions: S.INPUT_EXTS.map((e) => e.slice(1)) }, { name: 'All files', extensions: ['*'] }] });
  return r.canceled ? null : openMedia(r.filePaths[0]);
});
ipcMain.handle('media:open', (_e, p) => openMedia(p));
ipcMain.handle('media:forget', (_e, id) => { if (!job && !exportJob) media.delete(Number(id)); });
ipcMain.handle('subs:pick', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Open subtitles', properties: ['openFile'], filters: [{ name: 'Subtitles', extensions: ['srt', 'vtt'] }] });
  return r.canceled ? null : readSubtitles(r.filePaths[0]);
});
ipcMain.handle('subs:open', (_e, p) => readSubtitles(p));
ipcMain.handle('subs:sibling', (_e, id) => { const m = registered(id); const sib = siblingSubs(m.path); return sib ? readSubtitles(sib) : { ok: false, error: 'There is no subtitle file next to it any more' }; });

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
  if (job) return { ok: false, error: 'Subtitles are already being made' };
  const ac = new AbortController();
  job = { abort: () => ac.abort() };
  clearTimeout(idleTimer);
  const blocker = powerSaveBlocker.start('prevent-app-suspension');
  try {
    const m = registered(req && req.id);
    const language = (req && req.language) || 'auto';
    if (language !== 'auto' && !S.LANGUAGES[language]) throw new S.UserError('Unknown language');
    const task = req && req.translate === true ? 'translate' : 'transcribe';
    send('make:phase', { phase: engine ? 'reading' : 'loading' });
    const eng = await getEngine();
    if (ac.signal.aborted) return { ok: false, cancelled: true };
    let last = 0;
    const t0 = Date.now();
    const sofar = [];
    let heard = language === 'auto' ? null : language;   // the language, once the first window has found it
    const lang = (l) => (task === 'translate' ? 'en' : l);
    const r = await E.listen(eng, m.path, {
      language, task, signal: ac.signal,
      onPhase: (phase) => send('make:phase', { phase }),
      onSegments: (segments) => { sofar.push(...segments); send('make:cues', { cues: S.buildCues(sofar, { language: lang(heard || 'en') }) }); },
      onProgress: (p) => {
        if (p.language) heard = p.language;
        const now = Date.now();
        if (now - last < 150 && p.fraction < 1) return;
        last = now;
        send('make:progress', { fraction: p.fraction, elapsed: p.elapsed, eta: p.fraction > 0.12 ? (p.elapsed / p.fraction) * (1 - p.fraction) : null, language: p.language || null });
      },
    });
    const cues = S.buildCues(r.segments, { language: lang(r.language) });
    return { ok: true, language: r.language, languageName: S.LANGUAGES[r.language] || r.language, translated: task === 'translate', cues, seconds: (Date.now() - t0) / 1000 };
  } catch (e) {
    if (e && e.cancelled) return { ok: false, cancelled: true };
    return { ok: false, error: cleanError(e) };
  } finally { powerSaveBlocker.stop(blocker); job = null; armIdle(); }
});
ipcMain.handle('make:cancel', () => { if (job) job.abort(); });

// ---- saving subtitles ------------------------------------------------------------------------------------------------------------
ipcMain.handle('subs:save', async (_e, req) => {
  try {
    const kind = req && req.kind;
    if (kind !== 'srt' && kind !== 'vtt') throw new S.UserError('Unknown file type');
    const cues = cleanCues(req.cues);
    if (!cues.some((c) => S.fileText(c.text))) throw new S.UserError('There are no subtitles to save yet');
    const m = req.id != null ? media.get(Number(req.id)) : null;
    const ext = '.' + kind;
    const baseName = m ? m.name : (typeof req.name === 'string' ? path.basename(req.name) : 'subtitles');
    const dir = m ? path.dirname(m.path) : app.getPath('documents');
    const pick = await dialog.showSaveDialog(win, {
      title: kind === 'srt' ? 'Save subtitles as SubRip (.srt)' : 'Save subtitles as WebVTT (.vtt)',
      defaultPath: path.join(dir, S.defaultName(baseName, ext)),
      filters: [{ name: kind === 'srt' ? 'SubRip subtitles' : 'WebVTT subtitles', extensions: [kind] }],
    });
    if (pick.canceled || !pick.filePath) return { ok: false, dialogCancelled: true };
    let out = pick.filePath;
    if (S.extOf(out) !== ext) out += ext;
    // the extension is always .srt or .vtt, so a save can never land on the video, whatever name was typed
    const content = kind === 'srt' ? '﻿' + S.formatSrt(cues) : S.formatVtt(cues);
    let backup = null;
    if (fs.existsSync(out)) { backup = out + '.bak'; fs.copyFileSync(out, backup); }   // the file being replaced is kept as .bak
    const part = out + '.part';
    await fs.promises.writeFile(part, content, 'utf8');
    await fs.promises.rename(part, out);
    produced.add(out);
    return { ok: true, path: out, count: cues.filter((c) => S.fileText(c.text)).length, backup };
  } catch (e) { return { ok: false, error: cleanError(e) }; }
});

// ---- writing a video ----------------------------------------------------------------------------------------------------------------
ipcMain.handle('video:export', async (_e, req) => {
  if (exportJob) return { ok: false, error: 'A video is already being written' };
  try {
    const m = registered(req && req.id);
    const mode = req && req.mode;
    if (mode !== 'burn' && mode !== 'soft') throw new S.UserError('Unknown export');
    if (!m.info.hasVideo) throw new S.UserError('This file has no picture, so the subtitles cannot be put into a video');
    const cues = cleanCues(req.cues);
    if (!cues.some((c) => S.fileText(c.text))) throw new S.UserError('There are no subtitles to put in yet');
    const style = { size: ['small', 'medium', 'large'].includes(req.style && req.style.size) ? req.style.size : 'medium', box: !!(req.style && req.style.box) };
    const language = typeof req.language === 'string' && S.LANGUAGES[req.language] ? req.language : null;
    const dir = path.dirname(m.path);
    const suggested = M.freeName(dir, `${S.stem(m.name)} (${mode === 'burn' ? 'subtitled' : 'with subtitles'})`, '.mp4');
    const pick = await dialog.showSaveDialog(win, {
      title: mode === 'burn' ? 'Save the video with the subtitles burnt in' : 'Save the video with a subtitle track',
      defaultPath: suggested, filters: [{ name: 'MP4 video', extensions: ['mp4'] }],
    });
    if (pick.canceled || !pick.filePath) return { ok: false, dialogCancelled: true };
    let out = pick.filePath;
    if (S.extOf(out) !== '.mp4') out += '.mp4';
    if (path.resolve(out).toLowerCase() === path.resolve(m.path).toLowerCase()) throw new S.UserError('The new video cannot replace the original. Choose another name.');
    const ac = new AbortController();
    exportJob = { abort: () => ac.abort() };
    const blocker = powerSaveBlocker.start('prevent-app-suspension');
    let last = 0;
    try {
      // a file the user chose to replace (the save dialog asked) goes to the Recycle Bin, only once the new one is complete
      const r = await M.exportVideo({
        ffmpeg: A.ffmpegPath(), input: m.path, output: out, cues, mode, info: m.info, style, language, signal: ac.signal,
        onBeforeReplace: async (p) => { await shell.trashItem(p); },
        onProgress: (p) => { const now = Date.now(); if (now - last < 150 && p.fraction < 1) return; last = now; send('video:progress', p); },
      });
      produced.add(r.path);
      return { ok: true, path: r.path, seconds: r.seconds, mode };
    } finally { powerSaveBlocker.stop(blocker); }
  } catch (e) {
    if (e && e.cancelled) return { ok: false, cancelled: true };
    return { ok: false, error: cleanError(e) };
  } finally { exportJob = null; }
});
ipcMain.handle('video:cancel', () => { if (exportJob) exportJob.abort(); });
ipcMain.handle('reveal', (_e, file) => { if (typeof file === 'string' && produced.has(file)) shell.showItemInFolder(file); });

// ---- subs:// ----------------------------------------------------------------------------------------------------------------------
const CORS = { 'Access-Control-Allow-Origin': '*' };
const MIME = {
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.mkv': 'video/x-matroska', '.webm': 'video/webm', '.ogv': 'video/ogg', '.avi': 'video/x-msvideo',
  '.mp3': 'audio/mpeg', '.flac': 'audio/flac', '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.opus': 'audio/ogg', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.wav': 'audio/wav',
};
function fileResponse(abs, req) {
  let st;
  try { st = fs.statSync(abs); } catch { return new Response('Not found', { status: 404, headers: CORS }); }
  const size = st.size;
  const type = MIME[S.extOf(abs)] || 'application/octet-stream';
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
  protocol.handle('subs', (req) => {
    try {
      const u = new URL(req.url);
      const m = /^\/(\d+)$/.exec(u.pathname);
      const item = m && media.get(Number(m[1]));
      if (u.hostname !== 'm' || !item) return new Response('Not found', { status: 404, headers: CORS });
      return fileResponse(item.path, req);
    } catch { return new Response('Bad request', { status: 400, headers: CORS }); }
  });
}

// ---- start up ----------------------------------------------------------------------------------------------------------------------------
const pathsFromArgs = (argv) => argv.slice(app.isPackaged ? 1 : 2).filter((a) => a && !a.startsWith('-') && path.isAbsolute(a) && (S.isMedia(a) || S.isSubtitle(a)));
async function openAndSend(paths) {
  const mediaPath = paths.find((p) => S.isMedia(p));
  if (mediaPath) send('media:opened', await openMedia(mediaPath));
  const sub = paths.find((p) => S.isSubtitle(p));
  if (sub) send('subs:opened', await readSubtitles(sub));
}
function cleanUp() { if (job) job.abort(); if (exportJob) exportJob.abort(); clearTimeout(idleTimer); const e = engine; engine = null; if (e) e.release().catch(() => {}); }

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
