'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, Menu, protocol, session } = require('electron');
const fs = require('original-fs');
const path = require('path');
const { Readable } = require('stream');
const { spawnSync } = require('child_process');
const A = require('./analyse');
const C = require('./clean');
const T = require('./takes');

const E2E = process.argv.includes('--e2e');
const SELFTEST = process.argv.find((a) => a.startsWith('--self-test='));
const argOf = (name) => (process.argv.find((a) => a.startsWith(name + '=')) || '').slice(name.length + 1);
if (E2E || SELFTEST) {
  app.setPath('userData', path.join(app.getPath('temp'), `voice-recorder-test-${process.pid}`));
  // there is no microphone in tests: Chromium's fake capture device stands in (only in these modes)
  app.commandLine.appendSwitch('use-fake-device-for-media-stream');
  app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
  const fake = argOf('--fake-audio');
  if (fake) app.commandLine.appendSwitch('use-file-for-fake-audio-capture', fake);
}
protocol.registerSchemesAsPrivileged([{ scheme: 'vr', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }]);

const CHUNK_MAX = 8 * 1024 * 1024;

let win = null;
let rec = null;                 // the take being recorded (T.Session)
let exportAbort = null;
let previewAbort = null;
const produced = new Set();     // files we exported: the only ones "Show in folder" reveals besides takes
const analyses = new Map();     // path -> { mtimeMs, size, analysis }

const send = (channel, payload) => { if (win && !win.isDestroyed()) win.webContents.send(channel, payload); };
const cleanError = (e) => String((e && e.message) || e);
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
const previewDir = () => { const d = path.join(app.getPath('temp'), `voice-recorder-preview-${process.pid}`); fs.mkdirSync(d, { recursive: true }); return d; };

function loadSettings() { try { return JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) || {}; } catch { return {}; } }
function saveSettings(s) {
  try {
    fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
    const tmp = settingsFile() + '.part';
    fs.writeFileSync(tmp, JSON.stringify(s, null, 2));
    fs.renameSync(tmp, settingsFile());
  } catch { /* settings are a convenience */ }
}
let settings = loadSettings();

function defaultFolder() {
  if (E2E || SELFTEST) return path.join(app.getPath('userData'), 'Voice Recordings');
  for (const where of ['music', 'documents', 'home']) {
    try { const p = app.getPath(where); if (p && fs.existsSync(p)) return path.join(p, 'Voice Recordings'); } catch { /* try the next */ }
  }
  return path.join(app.getPath('userData'), 'Voice Recordings');
}
function folder() {
  const f = typeof settings.folder === 'string' && settings.folder ? settings.folder : defaultFolder();
  fs.mkdirSync(f, { recursive: true });
  return f;
}
function journal(add, remove) {
  const list = new Set(Array.isArray(settings.active) ? settings.active.filter((p) => typeof p === 'string') : []);
  if (add) list.add(add);
  if (remove) list.delete(remove);
  settings.active = [...list];
  saveSettings(settings);
}
function freeBytes(dir) { try { const s = fs.statfsSync(dir); return s.bavail * s.bsize; } catch { return null; } }

function createWindow() {
  win = new BrowserWindow({
    width: 1240, height: 840, minWidth: 980, minHeight: 640,
    backgroundColor: '#0b0b0d', title: 'Voice Recorder & Cleaner', autoHideMenuBar: true, show: !SELFTEST,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false },
  });
  Menu.setApplicationMenu(null);
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'), (E2E || SELFTEST) ? { hash: 'e2e' } : undefined);
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.on('close', () => { finishRecording(); });
  win.on('closed', () => { win = null; });
}

// The microphone: only our own window, only audio (never the camera or the screen).
function setUpPermissions() {
  const ours = (wc) => !!(win && !win.isDestroyed() && wc === win.webContents);
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb, details) => {
    const types = (details && details.mediaTypes) || [];
    cb(permission === 'media' && ours(wc) && types.length > 0 && types.every((t) => t === 'audio'));
  });
  session.defaultSession.setPermissionCheckHandler((wc, permission, _origin, details) => {
    if (permission !== 'media' || !ours(wc)) return false;
    return !details || details.mediaType !== 'video';
  });
}

// ---- serving takes and previews to the window's <audio> (with byte ranges, so seeking works) ---------------------------------
function fileResponse(abs, req) {
  let st;
  try { st = fs.statSync(abs); } catch { return new Response('Not found', { status: 404 }); }
  const size = st.size;
  let start = 0; let end = size - 1; let status = 200;
  const range = req.headers.get('range');
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (!m || (m[1] === '' && m[2] === '')) return new Response('Bad range', { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
    if (m[1] === '') start = Math.max(0, size - Number(m[2]));
    else { start = Number(m[1]); if (m[2] !== '') end = Math.min(end, Number(m[2])); }
    if (start >= size || start > end) return new Response('Bad range', { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
    status = 206;
  }
  if (size === 0) return new Response(null, { status: 200, headers: { 'Content-Type': 'audio/wav', 'Content-Length': '0' } });
  const stream = fs.createReadStream(abs, { start, end });
  if (req.signal) req.signal.addEventListener('abort', () => stream.destroy(), { once: true });
  const headers = { 'Content-Type': 'audio/wav', 'Accept-Ranges': 'bytes', 'Content-Length': String(end - start + 1), 'Cache-Control': 'no-store' };
  if (status === 206) headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
  return new Response(Readable.toWeb(stream), { status, headers });
}
function registerProtocol() {
  protocol.handle('vr', (req) => {
    try {
      const u = new URL(req.url);
      const name = decodeURIComponent(u.pathname.slice(1));
      if (u.hostname === 'take') return fileResponse(T.resolveTake(folder(), name), req);
      if (u.hostname === 'preview' && /^preview-\d+\.wav$/.test(name)) return fileResponse(path.join(previewDir(), name), req);
      return new Response('Not found', { status: 404 });
    } catch { return new Response('Not found', { status: 404 }); }
  });
}

// ---- takes ---------------------------------------------------------------------------------------------------------------------
function analysisOf(file) {
  const st = fs.statSync(file);
  const hit = analyses.get(file);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.analysis;
  const analysis = A.analyse(file);
  if (analyses.size > 20) analyses.delete(analyses.keys().next().value);
  analyses.set(file, { mtimeMs: st.mtimeMs, size: st.size, analysis });
  return analysis;
}
const takeArg = (name) => T.resolveTake(folder(), name);

ipcMain.handle('app:init', () => {
  const dir = folder();
  // takes that were being recorded when the app (or the computer) stopped
  const recovered = T.recover(settings.active || [], [dir]);
  settings.active = [];
  saveSettings(settings);
  return { folder: dir, takes: T.list(dir), recovered, freeBytes: freeBytes(dir), formats: Object.entries(C.FORMATS).map(([id, f]) => ({ id, label: f.label })), targets: C.TARGETS };
});
ipcMain.handle('engine:check', () => {
  const r = spawnSync(C.ffmpegPath(), ['-hide_banner', '-version'], { encoding: 'utf8', windowsHide: true });
  return r.status === 0 ? { ok: true } : { ok: false, problem: 'The sound engine (ffmpeg) could not start' + (r.error ? ': ' + r.error.message : '') + '. Recording works, cleaning and exporting do not.' };
});
ipcMain.handle('folder:choose', async () => {
  if (rec) throw new Error('Stop the recording first');
  const r = await dialog.showOpenDialog(win, { title: 'Where should recordings go?', defaultPath: folder(), properties: ['openDirectory', 'createDirectory'] });
  if (r.canceled || !r.filePaths[0]) return null;
  settings.folder = r.filePaths[0];
  saveSettings(settings);
  const dir = folder();
  const recovered = T.recover([], [dir]);
  return { folder: dir, takes: T.list(dir), recovered, freeBytes: freeBytes(dir) };
});
ipcMain.handle('folder:open', () => shell.openPath(folder()));
ipcMain.handle('takes:list', () => ({ takes: T.list(folder()), freeBytes: freeBytes(folder()) }));
ipcMain.handle('takes:analyse', (_e, name) => {
  const file = takeArg(name);
  const a = analysisOf(file);
  const th = A.silenceThreshold(a.floorDb, a.speechDb);
  return {
    duration: a.duration, sampleRate: a.sampleRate, waveform: A.waveform(a, 1600), floorDb: a.floorDb, speechDb: a.speechDb, peakDb: a.peakDb,
    markers: a.markers, quiet: A.quietestStretch(a.db, a.win, { threshold: th }), pauses: A.findPauses(a.db, a.win, { minPause: 1, threshold: th }).length,
  };
});
ipcMain.handle('takes:rename', (_e, name, title) => {
  if (rec && path.basename(rec.final) === name) throw new Error('This take is still being recorded');
  if (typeof title !== 'string' || title.length > 200) throw new Error('That title is too long');
  return { name: T.rename(folder(), name, title), takes: T.list(folder()) };
});
ipcMain.handle('takes:delete', async (_e, name) => {
  const file = takeArg(name);
  await shell.trashItem(file);
  analyses.delete(file);
  return { takes: T.list(folder()) };
});
ipcMain.handle('takes:reveal', (_e, name) => { shell.showItemInFolder(takeArg(name)); });

// ---- recording -------------------------------------------------------------------------------------------------------------------
ipcMain.handle('rec:start', (_e, o) => {
  if (rec) throw new Error('Already recording');
  const sampleRate = Math.round(Number(o && o.sampleRate));
  if (!(sampleRate >= 8000 && sampleRate <= 192000)) throw new Error('The microphone reports an odd sample rate');
  const dir = folder();
  const free = freeBytes(dir);
  if (free != null && free < 50 * 1024 * 1024) throw new Error('The recordings folder\'s disk is full (less than 50 MB free)');
  rec = new T.Session(dir, { sampleRate });
  journal(rec.partPath);
  return { name: path.basename(rec.final), freeBytes: free, bytesPerSecond: sampleRate * 2 };
});
ipcMain.on('rec:chunk', (_e, buf) => {
  if (!rec) return;
  if (!(buf instanceof ArrayBuffer || ArrayBuffer.isView(buf)) || buf.byteLength > CHUNK_MAX) return;
  try { rec.append(Buffer.from(buf instanceof ArrayBuffer ? buf : buf.buffer, buf.byteOffset || 0, buf.byteLength)); }
  catch (e) { send('rec:error', cleanError(e)); }
});
ipcMain.handle('rec:pause', () => { if (rec) rec.pause(); return { seconds: rec ? rec.seconds : 0 }; });
ipcMain.handle('rec:resume', () => { if (rec) rec.resume(); });
ipcMain.handle('rec:mark', (_e, t) => {
  if (!rec) throw new Error('Not recording');
  const at = Number(t);
  const sec = Number.isFinite(at) && at >= 0 && at <= rec.seconds + 10 ? at : rec.seconds;
  rec.markers.push({ t: sec, label: `Marker ${rec.markers.length + 1}` });
  return { t: sec, n: rec.markers.length };
});
function finishRecording() {
  if (!rec) return null;
  const s = rec; rec = null;
  let out = null;
  try { out = s.stop(); } finally { journal(null, s.partPath); }
  return out;
}
ipcMain.handle('rec:stop', () => {
  const out = finishRecording();
  return { take: out ? T.describe(out) : null, takes: T.list(folder()) };
});
ipcMain.handle('rec:discard', () => {
  if (!rec) return;
  const s = rec; rec = null;
  s.discard(); journal(null, s.partPath);
});

// ---- cleaning: preview and export -------------------------------------------------------------------------------------------
let previewN = 0;
ipcMain.handle('clean:preview', async (_e, name, opts, range) => {
  const file = takeArg(name);
  const a = analysisOf(file);
  const s = Number(range && range.start); const e = Number(range && range.end);
  if (!(Number.isFinite(s) && Number.isFinite(e) && e > s)) throw new Error('Choose what to preview');
  const r = { start: Math.max(0, s), end: Math.min(a.duration, e, s + 60) };
  if (previewAbort) previewAbort.abort();
  const ac = new AbortController(); previewAbort = ac;
  const dir = previewDir();
  for (const n of fs.readdirSync(dir)) { try { fs.rmSync(path.join(dir, n), { force: true }); } catch { /* in use */ } }
  const out = path.join(dir, `preview-${++previewN}.wav`);
  try {
    const res = await C.render(file, a, opts, { output: out, format: 'wav', range: r, signal: ac.signal, tempDir: dir });
    return { url: `vr://preview/${path.basename(out)}`, start: r.start, end: r.end, duration: res.duration, loudness: res.loudness, cuts: res.cuts, noise: res.noise };
  } catch (err) {
    if (err && err.cancelled) return { cancelled: true };
    throw err;
  } finally { if (previewAbort === ac) previewAbort = null; }
});

ipcMain.handle('clean:export', async (_e, name, opts, o) => {
  if (exportAbort) throw new Error('An export is already running');
  const file = takeArg(name);
  const format = o && C.FORMATS[o.format] ? o.format : null;
  if (!format) throw new Error('Choose a format');
  const title = typeof (o && o.title) === 'string' ? o.title.slice(0, 200) : '';
  const parsed = T.parseName(path.basename(file, '.wav'));
  const when = parsed.date || fs.statSync(file).mtime;
  const base = T.takeBase(when, title || parsed.title);
  const outDir = path.join(folder(), 'Exported');
  fs.mkdirSync(outDir, { recursive: true });
  const pick = await dialog.showSaveDialog(win, {
    title: 'Export the recording', defaultPath: C.uniquePath(outDir, base, C.FORMATS[format].ext),
    filters: [{ name: C.FORMATS[format].label, extensions: [C.FORMATS[format].ext] }],
  });
  if (pick.canceled || !pick.filePath) return { cancelled: true };
  let out = pick.filePath;
  if (path.extname(out).toLowerCase() !== '.' + C.FORMATS[format].ext) out += '.' + C.FORMATS[format].ext;
  // never write over a take (nor over the file being exported from)
  if (path.resolve(path.dirname(out)) === path.resolve(folder()) && /\.wav$/i.test(out) && fs.existsSync(out)) out = C.uniquePath(path.dirname(out), path.basename(out, '.wav'), 'wav');
  if (path.resolve(out) === path.resolve(file)) throw new Error('That would replace the recording itself');
  const ac = new AbortController(); exportAbort = ac;
  const a = analysisOf(file);
  const pad = (n) => String(n).padStart(2, '0');
  try {
    const r = await C.render(file, a, opts, {
      output: out, format, title: title || parsed.title || T.stamp(when), date: `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}`,
      signal: ac.signal, tempDir: previewDir(), onProgress: (p) => send('export:progress', { p }),
    });
    produced.add(r.path);
    return { ok: true, path: r.path, name: path.basename(r.path), duration: r.duration, loudness: r.loudness, cuts: r.cuts };
  } catch (err) {
    if (err && err.cancelled) return { cancelled: true };
    throw err;
  } finally { exportAbort = null; }
});
ipcMain.handle('export:cancel', () => { if (exportAbort) exportAbort.abort(); });
ipcMain.handle('export:reveal', (_e, p) => { if (typeof p === 'string' && produced.has(p)) shell.showItemInFolder(p); });

// ---- start up ------------------------------------------------------------------------------------------------------------------------
function cleanUp() {
  try { finishRecording(); } catch { /* ignore */ }
  try { if (exportAbort) exportAbort.abort(); if (previewAbort) previewAbort.abort(); } catch { /* ignore */ }
  try { fs.rmSync(previewDir(), { recursive: true, force: true }); } catch { /* ignore */ }
}

const gotLock = SELFTEST || E2E ? true : app.requestSingleInstanceLock();
if (SELFTEST) {
  app.whenReady().then(async () => {
    setUpPermissions();
    registerProtocol();
    createWindow();
    const outFile = SELFTEST.slice('--self-test='.length);
    let code = 1;
    try {
      const results = await require('./selftest').run({ getWin: () => win, folder });
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
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
  app.whenReady().then(() => {
    setUpPermissions();
    registerProtocol();
    createWindow();
    if (E2E) {
      win.webContents.once('did-finish-load', () => {
        const ctx = { app, getWin: () => win, outFile: argOf('--e2e-out'), shotsDir: argOf('--shots'), outDir: argOf('--readme-shots'), dialog, shell, folder, fakeAudio: argOf('--fake-audio') };
        if (ctx.outDir) require('../test/readme-shots').run(ctx); else require('../test/e2e').run(ctx);
      });
    }
  });
  app.on('before-quit', cleanUp);
  app.on('window-all-closed', () => { cleanUp(); app.quit(); });
}
