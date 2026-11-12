'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, Menu, protocol, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Worker } = require('worker_threads');
const { Readable } = require('stream');
const { spawn } = require('child_process');
const Lib = require('./library');
const Lyrics = require('./lyrics');
const PL = require('./playlists');
const Settings = require('./settings');
const { findInstalledTool } = require('./launcher-link');

const E2E = process.argv.includes('--e2e');
const SELFTEST = process.argv.find((a) => a.startsWith('--self-test='));
if (E2E || SELFTEST) app.setPath('userData', path.join(app.getPath('temp'), `music-player-test-${process.pid}`));

// Our own scheme serves songs (with Range requests, so seeking works) and cover thumbnails, but only from the folder the
// user opened. `corsEnabled` + an Allow-Origin header are needed so Web Audio is allowed to process the stream (EQ).
protocol.registerSchemesAsPrivileged([{ scheme: 'mpm', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } }]);
// Lets the OS media keys / the Windows "now playing" overlay control the player through navigator.mediaSession.
app.commandLine.appendSwitch('enable-features', 'HardwareMediaKeyHandling,MediaSessionService');

let win = null;
let settings = Settings.defaults();
let settingsTimer = null;
let lib = { root: '', tracks: [], byRel: new Map(), scanning: false, skipped: {}, errors: 0 };
let worker = null;
let autoOpened = false;
let startupTarget = null; // a folder or file given on the command line / "Open with"
let normalBounds = null;

const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
function saveSettingsSoon() {
  clearTimeout(settingsTimer);
  settingsTimer = setTimeout(() => { try { Settings.save(settingsFile(), settings); } catch { /* read-only profile: carry on */ } }, 300);
}
function flushSettings() { if (settingsTimer) { clearTimeout(settingsTimer); settingsTimer = null; try { Settings.save(settingsFile(), settings); } catch { /* ignore */ } } }

const rootKey = (root) => crypto.createHash('sha1').update(process.platform === 'win32' ? root.toLowerCase() : root).digest('hex').slice(0, 16);
const cacheFile = (root) => path.join(app.getPath('userData'), 'cache', `${rootKey(root)}.json`);
const playlistsFile = (root) => path.join(app.getPath('userData'), 'playlists', `${rootKey(root)}.json`);
const send = (channel, payload) => { if (win && !win.isDestroyed()) win.webContents.send(channel, payload); };
const cleanError = (e) => String((e && e.message) || e);

function createWindow() {
  win = new BrowserWindow({
    width: 1220, height: 780, minWidth: 900, minHeight: 600,
    backgroundColor: '#0f1117', title: 'Music Player', autoHideMenuBar: true, show: !SELFTEST,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true,
      autoplayPolicy: 'no-user-gesture-required', // so "resume where you left off" and the sleep timer can work without a click
      backgroundThrottling: false,                // keeps gapless hand-over timing exact while the window is minimised
    },
  });
  Menu.setApplicationMenu(null);
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'), (E2E || SELFTEST) ? { hash: 'e2e' } : undefined);
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.on('closed', () => { win = null; });
}

// ---- library --------------------------------------------------------------------------------------------------------
function stopWorker() {
  if (worker) { const w = worker; worker = null; w.postMessage('cancel'); setTimeout(() => w.terminate().catch(() => {}), 500); }
}

function setLibraryTracks(tracks) {
  lib.tracks = tracks;
  lib.byRel = new Map(tracks.map((t) => [t.rel, t]));
}

async function openLibrary(dir, playRel) {
  const root = path.resolve(String(dir || ''));
  let st;
  try { st = await fs.promises.stat(root); } catch { throw new Error('That folder does not exist any more'); }
  if (!st.isDirectory()) throw new Error('That is not a folder');
  stopWorker();
  lib = { root, tracks: [], byRel: new Map(), scanning: true, skipped: {}, errors: 0 };
  const cached = Lib.loadCache(cacheFile(root), root);
  setLibraryTracks([...cached.values()]);
  settings = Settings.clean({ lastRoot: root, recent: [root, ...settings.recent.filter((r) => r !== root)] }, settings);
  saveSettingsSoon();
  send('library:event', { type: 'loaded', root, tracks: lib.tracks, cached: cached.size > 0, playRel: playRel || '', settings });

  const w = new Worker(path.join(__dirname, 'scan-worker.js'), { workerData: { root, cacheFile: cacheFile(root) } });
  worker = w;
  w.on('message', (m) => {
    if (worker !== w) return;
    if (m.type === 'progress') send('library:event', { type: 'progress', phase: m.phase, done: m.done, total: m.total });
    else if (m.type === 'done') {
      worker = null; lib.scanning = false;
      if (m.result.cancelled) return;
      setLibraryTracks(m.result.tracks);
      lib.skipped = m.result.skipped; lib.errors = m.result.errors;
      send('library:event', { type: 'done', root, tracks: m.result.tracks, skipped: m.result.skipped, errors: m.result.errors, reused: m.result.reused });
    } else if (m.type === 'error') { worker = null; lib.scanning = false; send('library:event', { type: 'error', error: m.error }); }
  });
  w.on('error', (e) => { if (worker === w) { worker = null; lib.scanning = false; send('library:event', { type: 'error', error: cleanError(e) }); } });
  return { root };
}

/** A command-line / "Open with" target: a folder opens as the library; an audio file opens its folder and plays it. */
async function openTarget(target) {
  const st = await fs.promises.stat(target);
  if (st.isDirectory()) return openLibrary(target);
  if (st.isFile() && Lib.isAudio(target)) { const dir = path.dirname(target); return openLibrary(dir, Lib.toRel(dir, target)); }
  throw new Error('Drop a folder of music (or a song)');
}

ipcMain.handle('library:get', async () => {
  if (!autoOpened) {
    autoOpened = true;
    const target = startupTarget || settings.lastRoot;
    if (target) { try { await openTarget(target); } catch (e) { if (startupTarget) send('library:event', { type: 'error', error: cleanError(e) }); } }
  }
  return { root: lib.root, tracks: lib.tracks, scanning: lib.scanning, skipped: lib.skipped, errors: lib.errors, settings };
});
ipcMain.handle('library:choose', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Choose your music folder', properties: ['openDirectory'], defaultPath: settings.lastRoot || app.getPath('music') });
  return r.canceled ? null : openLibrary(r.filePaths[0]);
});
ipcMain.handle('library:open', (_e, target) => openTarget(String(target)));
ipcMain.handle('library:rescan', () => { if (!lib.root) throw new Error('No folder is open'); return openLibrary(lib.root); });

// ---- settings ------------------------------------------------------------------------------------------------------
ipcMain.handle('settings:get', () => settings);
ipcMain.handle('settings:set', (_e, patch) => { settings = Settings.clean(patch, settings); saveSettingsSoon(); return settings; });

// ---- songs and covers over mpm:// --------------------------------------------------------------------------------------
const CORS = { 'Access-Control-Allow-Origin': '*' };
const coverCache = new Map(); // "rel|size" -> { mime, data }
const COVER_CACHE_MAX = 400;

function fileResponse(abs, req) {
  let st;
  try { st = fs.statSync(abs); } catch { return new Response('Not found', { status: 404, headers: CORS }); }
  const size = st.size;
  const type = Lib.MIME[Lib.extOf(abs)] || 'application/octet-stream';
  let start = 0;
  let end = size - 1;
  let status = 200;
  const range = req.headers.get('range');
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (!m || (m[1] === '' && m[2] === '')) return new Response('Bad range', { status: 416, headers: { ...CORS, 'Content-Range': `bytes */${size}` } });
    if (m[1] === '') { start = Math.max(0, size - Number(m[2])); }
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

function coverResponse(rel, size) {
  const track = lib.byRel.get(rel);
  if (!track) return new Response('Not found', { status: 404, headers: CORS });
  const key = `${rel}|${size}`;
  let hit = coverCache.get(key);
  if (!hit) {
    const c = Lib.readCover(lib.root, track);
    if (!c) return new Response('No cover', { status: 404, headers: CORS });
    hit = c;
    if (size > 0) {
      try {
        const img = nativeImage.createFromBuffer(c.data);
        if (!img.isEmpty()) {
          const { width, height } = img.getSize();
          const scale = Math.min(1, size / Math.max(width, height));
          const small = scale < 1 ? img.resize({ width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)), quality: 'good' }) : img;
          hit = { mime: 'image/jpeg', data: small.toJPEG(88) };
        }
      } catch { /* keep the original bytes */ }
    }
    if (coverCache.size >= COVER_CACHE_MAX) coverCache.delete(coverCache.keys().next().value);
    coverCache.set(key, hit);
  }
  return new Response(hit.data, { status: 200, headers: { ...CORS, 'Content-Type': hit.mime, 'Cache-Control': 'max-age=3600' } });
}

function registerProtocol() {
  protocol.handle('mpm', (req) => {
    try {
      const u = new URL(req.url);
      const rel = u.pathname.split('/').slice(1).map(decodeURIComponent).join('/');
      if (!lib.root) return new Response('No library', { status: 404, headers: CORS });
      if (u.hostname === 't') return fileResponse(Lib.resolveInside(lib.root, rel, 'audio'), req);
      if (u.hostname === 'c') return coverResponse(rel, Math.min(2000, Math.max(0, Number(u.searchParams.get('s')) || 0)));
      return new Response('Not found', { status: 404, headers: CORS });
    } catch { return new Response('Bad request', { status: 400, headers: CORS }); }
  });
}

// ---- lyrics -------------------------------------------------------------------------------------------------------------
function knownTrack(rel) {
  const t = lib.byRel.get(rel);
  if (!t) throw new Error('Unknown song');
  return Lib.resolveInside(lib.root, rel, 'audio');
}
ipcMain.handle('lyrics:get', (_e, rel) => {
  const abs = knownTrack(rel);
  const l = Lyrics.loadLyrics(abs);
  return { source: l.source, fileName: l.file ? path.basename(l.file) : '', synced: l.synced, wordSynced: !!l.wordSynced, lines: l.lines, meta: l.meta, raw: l.raw, sidecarName: path.basename(abs, path.extname(abs)) + '.lrc' };
});
ipcMain.handle('lyrics:save', (_e, rel, text) => {
  const abs = knownTrack(rel);
  const r = Lyrics.saveSidecar(abs, text);
  return { fileName: path.basename(r.file), backupName: r.backup ? path.basename(r.backup) : '' };
});

// ---- playlists ------------------------------------------------------------------------------------------------------------
ipcMain.handle('playlists:get', () => (lib.root ? PL.loadStore(playlistsFile(lib.root)) : { lists: [] }));
ipcMain.handle('playlists:save', (_e, store) => { if (!lib.root) throw new Error('No folder is open'); const clean = PL.cleanStore(store); PL.saveStore(playlistsFile(lib.root), clean); return clean; });

ipcMain.handle('playlists:import', async () => {
  if (!lib.root) throw new Error('Open a music folder first');
  const r = await dialog.showOpenDialog(win, { title: 'Import a playlist', properties: ['openFile'], filters: [{ name: 'Playlists', extensions: ['m3u8', 'm3u'] }], defaultPath: lib.root });
  if (r.canceled) return null;
  const file = r.filePaths[0];
  const entries = PL.readM3UFile(file);
  const fold = (s) => (process.platform === 'win32' ? s.toLowerCase() : s);
  const byAbs = new Map(lib.tracks.map((t) => [fold(path.resolve(lib.root, ...t.rel.split('/'))), t.rel]));
  const tracks = [];
  let missing = 0;
  for (const e of entries) { const rel = byAbs.get(fold(path.resolve(e.file))); if (rel) tracks.push(rel); else missing++; }
  return { name: path.basename(file, path.extname(file)), tracks, missing };
});

ipcMain.handle('playlists:export', async (_e, name, rels) => {
  if (!lib.root) throw new Error('Open a music folder first');
  const list = (Array.isArray(rels) ? rels : []).map((r) => lib.byRel.get(r)).filter(Boolean);
  if (!list.length) throw new Error('This playlist is empty');
  const safe = String(name || 'Playlist').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').trim().slice(0, 100) || 'Playlist';
  const r = await dialog.showSaveDialog(win, { title: 'Export playlist', defaultPath: path.join(lib.root, `${safe}.m3u8`), filters: [{ name: 'M3U8 playlist', extensions: ['m3u8'] }] });
  if (r.canceled || !r.filePath) return null;
  const entries = list.map((t) => ({ file: path.resolve(lib.root, ...t.rel.split('/')), title: [t.artist, t.title || path.basename(t.rel, path.extname(t.rel))].filter(Boolean).join(' - '), seconds: t.durationMs / 1000 }));
  fs.writeFileSync(r.filePath, PL.writeM3U(entries, path.dirname(r.filePath)), 'utf8');
  return { file: r.filePath, count: entries.length };
});

// ---- misc ------------------------------------------------------------------------------------------------------------------
ipcMain.handle('reveal', (_e, rel) => { shell.showItemInFolder(knownTrack(rel)); });
ipcMain.handle('reveal-root', () => { if (lib.root) shell.openPath(lib.root); });

ipcMain.handle('window:mini', (_e, on) => {
  if (!win) return;
  if (on) {
    if (!normalBounds) normalBounds = win.getBounds();
    const [w, h] = win.getSize(); const [cw, ch] = win.getContentSize();
    win.setMinimumSize(380 + (w - cw), 150 + (h - ch)); // sizes are for the content area; the title bar and borders come on top
    win.setContentSize(460, 156);
    win.setAlwaysOnTop(true);
  } else {
    win.setAlwaysOnTop(false);
    win.setMinimumSize(900, 600);
    if (normalBounds) win.setBounds(normalBounds);
    normalBounds = null;
  }
});

/** Open a song in Audio Tagger (a sibling tool installed by Tools Launcher), if it is installed. */
ipcMain.handle('tagger:open', async (_e, rel) => {
  const abs = knownTrack(rel);
  const found = findInstalledTool(launcherDataDirs(), 'audio-tagger');
  if (!found) return { ok: false, reason: 'Audio Tagger is not installed. Install it from Tools Launcher.' };
  const child = spawn(found.file, [abs], { cwd: found.cwd, detached: true, stdio: 'ignore' });
  await new Promise((resolve, reject) => { child.once('error', reject); child.once('spawn', resolve); });
  child.unref();
  return { ok: true };
});

const launcherDataDirs = () => [path.join(app.getPath('appData'), 'Tools Launcher', 'data'), path.join(app.getPath('appData'), 'ToolsLauncher-dev', 'data')];

// ---- start up --------------------------------------------------------------------------------------------------------------
const argTarget = process.argv.slice(app.isPackaged ? 1 : 2).find((a) => !a.startsWith('-') && fs.existsSync(a));

if (SELFTEST) {
  app.whenReady().then(async () => {
    const out = SELFTEST.slice('--self-test='.length);
    let code = 1;
    try {
      const results = await require('./selftest').run({ app, BrowserWindow, createWindow: () => createWindow(), registerProtocol, getWin: () => win, openLibrary, getLib: () => lib });
      fs.writeFileSync(out, JSON.stringify({ ok: results.every((r) => r.ok), results }, null, 2));
      code = results.every((r) => r.ok) ? 0 : 1;
    } catch (e) {
      fs.writeFileSync(out, JSON.stringify({ ok: false, error: String((e && e.stack) || e) }, null, 2));
    }
    app.exit(code);
  });
} else {
  const gotLock = E2E ? true : app.requestSingleInstanceLock();
  if (!gotLock) app.quit();
  else {
    app.on('second-instance', (_e, argv) => {
      if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
      const t = argv.slice(1).find((a) => !a.startsWith('-') && fs.existsSync(a));
      if (t) openTarget(t).catch((e) => send('library:event', { type: 'error', error: cleanError(e) }));
    });
    app.whenReady().then(() => {
      settings = Settings.load(settingsFile());
      startupTarget = argTarget ? path.resolve(argTarget) : null;
      registerProtocol();
      createWindow();
      const shotsScript = (process.argv.find((a) => a.startsWith('--readme-shots=')) || '').slice(15);
      if (E2E && shotsScript) require('../test/readme-shots').run({ app, getWin: () => win, getLib: () => lib, openLibrary, outDir: shotsScript });
      else if (E2E) require('../test/e2e').run({ app, getWin: () => win, getLib: () => lib, openLibrary, outFile: (process.argv.find((a) => a.startsWith('--e2e-out=')) || '').slice(10), shotsDir: (process.argv.find((a) => a.startsWith('--shots=')) || '').slice(8) });
    });
    app.on('window-all-closed', () => { stopWorker(); flushSettings(); app.quit(); });
    app.on('before-quit', () => { stopWorker(); flushSettings(); });
  }
}
