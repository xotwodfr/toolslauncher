'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, Menu, protocol } = require('electron');
const fs = require('original-fs');
const path = require('path');
const { Worker } = require('worker_threads');
const { Readable } = require('stream');
const Trash = require('./trash');
const Cache = require('./cache');
const Scan = require('./scan');

const E2E = process.argv.includes('--e2e');
const SELFTEST = process.argv.find((a) => a.startsWith('--self-test='));
if (E2E || SELFTEST) app.setPath('userData', path.join(app.getPath('temp'), `duplicate-finder-test-${process.pid}`));

// Our own scheme shows pictures and plays songs from the scan results, and nothing else: the window asks for
// "dfx://f/<number>", never for a path.
protocol.registerSchemesAsPrivileged([{ scheme: 'dfx', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } }]);

let win = null;
let nextId = 1;
const files = new Map();          // id -> file record, for everything the window may ask to show, reveal or move
let groups = [];                  // the current results: [{ id, kind, size, files: [rec] }]
let photoList = [];               // the pictures of the current photo scan: [rec]
let photoCache = new Map();
let photoKeys = [];
let job = null;                   // { worker, cancel }
let trashMode = { fake: '' };     // tests only: move files to this folder instead of the Recycle Bin
let settings = { roots: [], mode: 'files', options: {} };

const send = (channel, payload) => { if (win && !win.isDestroyed()) win.webContents.send(channel, payload); };
const cleanError = (e) => String((e && e.message) || e);
const cacheFile = (name) => path.join(app.getPath('userData'), 'cache', name);
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');

function createWindow() {
  win = new BrowserWindow({
    width: 1240, height: 800, minWidth: 980, minHeight: 640,
    backgroundColor: '#0f1117', title: 'Duplicate Finder', autoHideMenuBar: true, show: !SELFTEST,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  Menu.setApplicationMenu(null);
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'), (E2E || SELFTEST) ? { hash: 'e2e' } : undefined);
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.on('closed', () => { win = null; });
}

// ---- settings -------------------------------------------------------------------------------------------------------------
function loadSettings() {
  try {
    const j = JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
    settings = cleanSettings(j);
  } catch { /* first run */ }
}
function cleanSettings(j) {
  const roots = (Array.isArray(j && j.roots) ? j.roots : []).filter((r) => r && typeof r.path === 'string' && path.isAbsolute(r.path)).slice(0, 50).map((r) => ({ path: r.path, keep: !!r.keep }));
  return { roots, mode: ['files', 'photos', 'music'].includes(j && j.mode) ? j.mode : 'files', options: Scan.cleanOptions(j && j.options) };
}
ipcMain.handle('settings:get', () => settings);
ipcMain.handle('settings:set', (_e, j) => {
  settings = cleanSettings(j);
  try { fs.mkdirSync(path.dirname(settingsFile()), { recursive: true }); fs.writeFileSync(settingsFile(), JSON.stringify(settings)); } catch { /* read-only profile */ }
  return settings;
});

// ---- registering results ----------------------------------------------------------------------------------------------------
const view = (g) => ({
  id: g.id, kind: g.kind, size: g.size, maxDistance: g.maxDistance || 0,
  files: g.files.map((f) => ({ id: f.id, path: f.path, name: path.basename(f.path), dir: path.dirname(f.path), size: f.size, mtimeMs: f.mtimeMs, keep: f.keep, root: f.root, w: f.w || 0, h: f.h || 0, pixels: f.pixels || 0, quality: f.quality || 0, tags: f.tags || null })),
});

function register(list) {
  for (const g of list) {
    g.id = nextId++;
    for (const f of g.files) { f.id = f.id || nextId++; files.set(f.id, f); }
  }
  return list;
}

function forgetAll() {
  files.clear(); groups = []; photoList = [];
}

// ---- scanning --------------------------------------------------------------------------------------------------------------
async function checkRoots(roots) {
  if (!Array.isArray(roots) || !roots.length) throw new Error('Add at least one folder first');
  if (roots.length > 50) throw new Error('Too many folders');
  const out = [];
  for (const r of roots) {
    if (!r || typeof r.path !== 'string' || !path.isAbsolute(r.path)) throw new Error('A folder path is not valid');
    let st;
    try { st = await fs.promises.stat(r.path); } catch { throw new Error(`The folder "${r.path}" cannot be opened`); }
    if (!st.isDirectory()) throw new Error(`"${r.path}" is not a folder`);
    out.push({ path: r.path, keep: !!r.keep });
  }
  return out;
}

function runWorker(data) {
  if (job) throw new Error('A scan is already running');
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, 'scan-worker.js'), { workerData: data });
    const state = { worker, cancelled: false, cancel: () => { state.cancelled = true; worker.postMessage('cancel'); } };
    job = state;
    let finished = false;
    const end = (fn, v) => { if (finished) return; finished = true; job = null; fn(v); };
    worker.on('message', (m) => {
      if (m.type === 'progress') send('scan:progress', m);
      else if (m.type === 'done') end(resolve, m.result);
      else if (m.type === 'cancelled') end(resolve, null);
      else if (m.type === 'error') end(reject, new Error(m.error));
    });
    worker.on('error', (e) => end(reject, e));
    worker.on('exit', () => end(resolve, null));
  });
}

ipcMain.handle('scan:start', async (_e, mode, rawRoots, options) => {
  if (!['files', 'music'].includes(mode)) throw new Error('Unknown mode');
  const roots = await checkRoots(rawRoots);
  forgetAll();
  const r = await runWorker({ job: 'scan', mode, roots, options, cacheFile: cacheFile(mode === 'music' ? 'music.json' : 'hashes.json') });
  if (!r) return { cancelled: true };
  groups = register(r.groups);
  return { groups: groups.map(view), stats: r.stats };
});

ipcMain.handle('photos:list', async (_e, rawRoots, options) => {
  const roots = await checkRoots(rawRoots);
  forgetAll();
  const r = await runWorker({ job: 'list-photos', roots, options });
  if (!r) return { cancelled: true };
  photoCache = Cache.load(cacheFile('photos.json'), 1);
  photoKeys = r.files.map(Cache.key);
  photoList = r.files;
  const out = [];
  for (const f of photoList) {
    f.id = nextId++; files.set(f.id, f);
    const hit = photoCache.get(Cache.key(f));
    if (hit) { const [hex, w, h, flat] = hit.split('|'); f.hex = hex; f.w = Number(w); f.h = Number(h); f.flat = flat === '1'; }
    out.push({ id: f.id, hex: f.hex || '' , w: f.w || 0, h: f.h || 0, flat: !!f.flat });
  }
  return { files: out, stats: r.stats };
});

ipcMain.handle('photos:store', (_e, batch) => {
  if (!Array.isArray(batch)) return;
  for (const b of batch) {
    const f = files.get(b && b.id);
    if (!f || !/^[0-9a-f]{16}$/.test(String(b.hex))) continue;
    f.hex = b.hex; f.w = Math.max(0, Math.round(Number(b.w)) || 0); f.h = Math.max(0, Math.round(Number(b.h)) || 0); f.flat = !!b.flat;
    photoCache.set(Cache.key(f), `${f.hex}|${f.w}|${f.h}|${f.flat ? 1 : 0}`);
  }
});

ipcMain.handle('photos:group', async (_e, threshold) => {
  const items = photoList.filter((f) => f.hex).map((f) => ({ id: f.id, path: f.path, size: f.size, mtimeMs: f.mtimeMs, keep: f.keep, root: f.root, hex: f.hex, w: f.w, h: f.h, flat: f.flat }));
  Cache.save(cacheFile('photos.json'), 1, photoCache, photoKeys);
  const r = await runWorker({ job: 'group-photos', items, threshold: Scan.cleanOptions({ threshold }).threshold });
  if (!r) return { cancelled: true };
  // the worker returns copies: point them back at the registered records so ids stay valid
  const byId = new Map(photoList.map((f) => [f.id, f]));
  for (const g of r.groups) g.files = g.files.map((f) => Object.assign(byId.get(f.id), { pixels: f.pixels }));
  groups = register(r.groups);
  return { groups: groups.map(view), stats: { pictures: items.length, undecodable: photoList.length - items.length } };
});

ipcMain.handle('scan:cancel', () => { if (job) job.cancel(); });

ipcMain.handle('dir:pick', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Add folders to scan', properties: ['openDirectory', 'multiSelections'] });
  return r.canceled ? [] : r.filePaths;
});
ipcMain.handle('dir:check', async (_e, paths) => {
  const out = [];
  for (const p of Array.isArray(paths) ? paths : []) {
    if (typeof p !== 'string' || !path.isAbsolute(p)) continue;
    try { if ((await fs.promises.stat(p)).isDirectory()) out.push(p); } catch { /* not a folder */ }
  }
  return out;
});
ipcMain.handle('reveal', (_e, id) => { const f = files.get(id); if (f) shell.showItemInFolder(f.path); });

// ---- moving to the Recycle Bin -------------------------------------------------------------------------------------------------
function pruneMoved(movedIds) {
  const gone = new Set(movedIds);
  for (const g of groups) g.files = g.files.filter((f) => !gone.has(f.id));
  groups = groups.filter((g) => g.files.length > 1);
  for (const id of gone) files.delete(id);
}

const trashItem = (p) => {
  if (trashMode.fake) { fs.mkdirSync(trashMode.fake, { recursive: true }); return fs.promises.rename(p, path.join(trashMode.fake, `${Date.now()}-${Math.floor(Math.random() * 1e6)}-${path.basename(p)}`)); }
  return shell.trashItem(p);
};

ipcMain.handle('trash:plan', (_e, ids) => {
  const plan = Trash.planTrash(groups, Array.isArray(ids) ? ids : []);
  return { count: plan.items.length, bytes: plan.bytes, problems: plan.problems.slice(0, 10), problemCount: plan.problems.length, sample: plan.items.slice(0, 6).map((i) => i.path) };
});

ipcMain.handle('trash:run', async (_e, ids) => {
  if (job) throw new Error('Wait for the scan to finish first');
  const plan = Trash.planTrash(groups, Array.isArray(ids) ? ids : []);
  if (!plan.items.length) return { moved: [], skipped: plan.problems.map((p) => ({ path: '', reason: p })) };
  const result = await Trash.executeTrash(plan, { trashItem, onProgress: (p) => send('trash:progress', { done: p.done, total: p.total }) });
  pruneMoved(result.moved.map((m) => m.id));
  return { moved: result.moved.map((m) => ({ id: m.id, size: m.size })), skipped: result.skipped.map((s) => ({ id: s.id, name: path.basename(s.path), reason: s.reason })), bytes: result.moved.reduce((n, m) => n + m.size, 0) };
});

// ---- dfx:// ------------------------------------------------------------------------------------------------------------------------
const MIME = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp', '.avif': 'image/avif', '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg', '.flac': 'audio/flac', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.opus': 'audio/ogg', '.m4a': 'audio/mp4', '.aac': 'audio/aac' };
const CORS = { 'Access-Control-Allow-Origin': '*' };

function fileResponse(abs, req) {
  const type = MIME[path.extname(abs).toLowerCase()];
  if (!type) return new Response('Not a picture or song', { status: 415, headers: CORS });
  let st;
  try { st = fs.statSync(abs); } catch { return new Response('Not found', { status: 404, headers: CORS }); }
  const size = st.size;
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
  protocol.handle('dfx', (req) => {
    try {
      const u = new URL(req.url);
      const f = files.get(Number(decodeURIComponent(u.pathname.replace(/^\//, ''))));
      if (u.hostname !== 'f' || !f) return new Response('Not found', { status: 404, headers: CORS });
      return fileResponse(f.path, req);
    } catch { return new Response('Bad request', { status: 400, headers: CORS }); }
  });
}

// ---- start up ------------------------------------------------------------------------------------------------------------------------
const foldersFromArgs = (argv) => argv.slice(app.isPackaged ? 1 : 2).filter((a) => a && !a.startsWith('-') && path.isAbsolute(a));
async function addFolders(paths) {
  const dirs = [];
  for (const p of paths) { try { if (fs.statSync(p).isDirectory()) dirs.push(p); } catch { /* not a folder */ } }
  if (dirs.length) send('roots:add', dirs);
}

const gotLock = SELFTEST || E2E ? true : app.requestSingleInstanceLock();
if (SELFTEST) {
  app.whenReady().then(async () => {
    loadSettings(); registerProtocol(); createWindow();
    const outFile = SELFTEST.slice('--self-test='.length);
    let code = 1;
    try {
      const results = await require('./selftest').run({ getWin: () => win, setTrashMode: (dir) => { trashMode = { fake: dir }; } });
      fs.writeFileSync(outFile, JSON.stringify({ ok: results.every((r) => r.ok), results }, null, 2));
      code = results.every((r) => r.ok) ? 0 : 1;
    } catch (e) {
      fs.writeFileSync(outFile, JSON.stringify({ ok: false, error: String((e && e.stack) || e) }, null, 2));
    }
    app.exit(code);
  });
} else if (!gotLock) app.quit();
else {
  app.on('second-instance', (_e, argv) => {
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
    addFolders(foldersFromArgs(argv));
  });
  app.whenReady().then(() => {
    loadSettings(); registerProtocol(); createWindow();
    if (E2E) {
      win.webContents.once('did-finish-load', () => {
        const outFile = (process.argv.find((a) => a.startsWith('--e2e-out=')) || '').slice(10);
        const shotsDir = (process.argv.find((a) => a.startsWith('--shots=')) || '').slice(8);
        const readme = (process.argv.find((a) => a.startsWith('--readme-shots=')) || '').slice(15);
        const ctx = { app, getWin: () => win, outFile, shotsDir, outDir: readme, setTrashMode: (dir) => { trashMode = { fake: dir }; }, files: () => files, groups: () => groups };
        if (readme) require('../test/readme-shots').run(ctx); else require('../test/e2e').run(ctx);
      });
      return;
    }
    const startup = foldersFromArgs(process.argv);
    if (startup.length) win.webContents.once('did-finish-load', () => addFolders(startup));
  });
  app.on('window-all-closed', () => { if (job) job.cancel(); app.quit(); });
}
