'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, Menu, protocol, clipboard } = require('electron');
const fs = require('original-fs');
const path = require('path');
const { Readable } = require('stream');
const { Engine, PSM, installedLanguages, parseLangs } = require('./ocr');
const { NAMES } = require('./languages');

const E2E = process.argv.includes('--e2e');
const SELFTEST = process.argv.find((a) => a.startsWith('--self-test='));
if (E2E || SELFTEST) app.setPath('userData', path.join(app.getPath('temp'), `image-text-extractor-test-${process.pid}`));

// Our own scheme shows the pictures that were opened, and nothing else: the window asks for "ocr://f/<number>", never a path.
protocol.registerSchemesAsPrivileged([{ scheme: 'ocr', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } }]);

let win = null;
let nextId = 1;
const files = new Map();          // id -> { path, name, size }
const saved = new Set();          // files we wrote - the only ones "Show in folder" may reveal
let job = null;                   // { abort }
let settings = { lang: '', lang2: '', psm: 'auto', enlarge: true, enhance: true, boxes: true };
let lastDir = '';

const send = (channel, payload) => { if (win && !win.isDestroyed()) win.webContents.send(channel, payload); };
const cleanError = (e) => String((e && e.message) || e);

/** Files inside app.asar can't be run as workers: use the copies electron-builder unpacked next to it. */
const unpacked = (p) => p.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
const engine = new Engine({
  workerPath: unpacked(path.join(path.dirname(require.resolve('tesseract.js')), 'worker-script', 'node', 'index.js')),
  corePath: unpacked(path.dirname(require.resolve('tesseract.js-core/package.json'))),
});

function createWindow() {
  win = new BrowserWindow({
    width: 1240, height: 800, minWidth: 980, minHeight: 640,
    backgroundColor: '#0f1117', title: 'Image Text Extractor', autoHideMenuBar: true, show: !SELFTEST,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  Menu.setApplicationMenu(null);
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'), (E2E || SELFTEST) ? { hash: 'e2e' } : undefined);
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.on('closed', () => { win = null; });
}

// ---- settings --------------------------------------------------------------------------------------------------------------
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
function cleanSettings(j = {}) {
  const have = installedLanguages();
  const ok = (c) => (have.includes(c) ? c : '');
  return {
    lang: ok(j.lang), lang2: ok(j.lang2) === ok(j.lang) ? '' : ok(j.lang2),
    psm: Object.prototype.hasOwnProperty.call(PSM, j.psm) ? j.psm : 'auto',
    enlarge: j.enlarge !== false, enhance: j.enhance !== false, boxes: j.boxes !== false,
  };
}
function loadSettings() { try { settings = cleanSettings(JSON.parse(fs.readFileSync(settingsFile(), 'utf8'))); } catch { settings = cleanSettings(); } }
ipcMain.handle('settings:get', () => ({ settings, languages: installedLanguages().map((code) => ({ code, name: NAMES[code] })), locale: app.getLocale() }));
ipcMain.handle('settings:set', (_e, j) => {
  settings = cleanSettings(j);
  try { fs.mkdirSync(path.dirname(settingsFile()), { recursive: true }); fs.writeFileSync(settingsFile(), JSON.stringify(settings)); } catch { /* read-only profile */ }
  return settings;
});

// ---- opening pictures ----------------------------------------------------------------------------------------------------------
const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.bmp': 'image/bmp', '.gif': 'image/gif', '.avif': 'image/avif' };
const EXTS = Object.keys(MIME);
const MAX_FILE = 80 * 1024 * 1024;

async function expandPaths(inputs) {
  const out = [];
  const seen = new Set();
  async function visit(p, depth) {
    if (out.length >= 300 || typeof p !== 'string') return;
    let st;
    try { st = await fs.promises.stat(p); } catch { return; }
    if (st.isDirectory()) {
      if (depth >= 1) return;
      let names = [];
      try { names = await fs.promises.readdir(p); } catch { return; }
      names.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
      for (const n of names) await visit(path.join(p, n), depth + 1);
    } else if (st.isFile() && EXTS.includes(path.extname(p).toLowerCase()) && !seen.has(p)) { seen.add(p); out.push({ p, size: st.size }); }
  }
  for (const p of inputs) await visit(p, 0);
  return out;
}

async function openPaths(paths) {
  const list = await expandPaths(Array.isArray(paths) ? paths : []);
  const out = [];
  for (const { p, size } of list) {
    if (size > MAX_FILE) { out.push({ ok: false, name: path.basename(p), error: 'This picture is too large (over 80 MB)' }); continue; }
    const id = nextId++;
    files.set(id, { path: p, name: path.basename(p), size });
    out.push({ ok: true, id, name: path.basename(p), path: p, size });
  }
  return out;
}

ipcMain.handle('files:pick', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Add pictures', properties: ['openFile', 'multiSelections'], filters: [{ name: 'Pictures', extensions: EXTS.map((e) => e.slice(1)) }] });
  return r.canceled ? [] : openPaths(r.filePaths);
});
ipcMain.handle('files:open', (_e, paths) => openPaths(paths));
ipcMain.handle('files:forget', (_e, id) => { files.delete(Number(id)); });
ipcMain.handle('clipboard:image', () => {
  const img = clipboard.readImage();
  if (!img || img.isEmpty()) return null;
  return img.toPNG();
});
ipcMain.handle('clipboard:write', (_e, text) => { clipboard.writeText(String(text == null ? '' : text).slice(0, 5000000)); });

// ---- reading ---------------------------------------------------------------------------------------------------------------------
const num = (v, lo, hi, d) => { const n = Number(v); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d; };

ipcMain.handle('ocr:run', async (_e, bytes, o = {}) => {
  if (job) throw new Error('Already reading a picture');
  const langs = [o.lang, o.lang2].filter(Boolean).join('+') || 'eng';
  parseLangs(langs);
  if (!installedLanguages().includes(langs.split('+')[0])) throw new Error('That language is not installed');
  const ac = new AbortController();
  job = { abort: () => ac.abort() };
  try {
    const r = await engine.recognize(Buffer.from(bytes), {
      langs, psm: Object.prototype.hasOwnProperty.call(PSM, o.psm) ? o.psm : 'auto',
      scale: num(o.scale, 0.05, 20, 1), ox: num(o.ox, 0, 1e6, 0), oy: num(o.oy, 0, 1e6, 0),
      signal: ac.signal, onProgress: (f) => send('ocr:progress', { fraction: f }),
    });
    return { ok: true, ...r };
  } catch (e) {
    return e.cancelled ? { ok: false, cancelled: true } : { ok: false, error: cleanError(e) };
  } finally { job = null; }
});
ipcMain.handle('ocr:cancel', () => { if (job) job.abort(); });

// ---- saving text -------------------------------------------------------------------------------------------------------------------
const safeName = (n) => String(n || 'text').replace(/\.[A-Za-z0-9]{1,5}$/, '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/[. ]+$/, '').slice(0, 100) || 'text';
function uniquePath(dir, base, ext) {
  let c = path.join(dir, base + ext);
  for (let i = 1; fs.existsSync(c); i++) c = path.join(dir, `${base} (${i})${ext}`);
  return c;
}

ipcMain.handle('save:text', async (_e, name, text, dirHint) => {
  const dir = (typeof dirHint === 'string' && dirHint && fs.existsSync(dirHint) ? dirHint : lastDir) || app.getPath('documents');
  const r = await dialog.showSaveDialog(win, { title: 'Save the text', defaultPath: path.join(dir, `${safeName(name)}.txt`), filters: [{ name: 'Text file', extensions: ['txt'] }] });
  if (r.canceled || !r.filePath) return null;
  const file = /\.txt$/i.test(r.filePath) ? r.filePath : `${r.filePath}.txt`;   // only ever a .txt file, never a picture
  fs.writeFileSync(file, String(text || ''), 'utf8');
  lastDir = path.dirname(file); saved.add(file);
  return { path: file };
});

ipcMain.handle('save:all', async (_e, items) => {
  if (!Array.isArray(items) || !items.length) return null;
  const r = await dialog.showOpenDialog(win, { title: 'Choose a folder for the text files', properties: ['openDirectory', 'createDirectory'], defaultPath: lastDir || app.getPath('documents') });
  if (r.canceled || !r.filePaths[0]) return null;
  const dir = r.filePaths[0];
  lastDir = dir;
  const out = [];
  for (const it of items.slice(0, 500)) {
    const file = uniquePath(dir, safeName(it && it.name), '.txt');   // never overwrites an existing file
    fs.writeFileSync(file, String((it && it.text) || ''), { encoding: 'utf8', flag: 'wx' });
    saved.add(file); out.push(file);
  }
  return { dir, files: out };
});
ipcMain.handle('reveal', (_e, file) => { if (saved.has(file)) shell.showItemInFolder(file); });

// ---- ocr:// ---------------------------------------------------------------------------------------------------------------------------
const CORS = { 'Access-Control-Allow-Origin': '*' };
function registerProtocol() {
  protocol.handle('ocr', (req) => {
    try {
      const u = new URL(req.url);
      const f = files.get(Number(decodeURIComponent(u.pathname.replace(/^\//, ''))));
      if (u.hostname !== 'f' || !f) return new Response('Not found', { status: 404, headers: CORS });
      const type = MIME[path.extname(f.path).toLowerCase()];
      if (!type) return new Response('Not a picture', { status: 415, headers: CORS });
      return new Response(Readable.toWeb(fs.createReadStream(f.path)), { status: 200, headers: { ...CORS, 'Content-Type': type, 'Content-Length': String(f.size), 'Cache-Control': 'no-store' } });
    } catch { return new Response('Bad request', { status: 400, headers: CORS }); }
  });
}

// ---- start up ---------------------------------------------------------------------------------------------------------------------------
const picturesFromArgs = (argv) => argv.slice(app.isPackaged ? 1 : 2).filter((a) => a && !a.startsWith('-') && path.isAbsolute(a));
async function openAndSend(paths) { const opened = await openPaths(paths); if (opened.length) send('files:opened', opened); }

const gotLock = SELFTEST || E2E ? true : app.requestSingleInstanceLock();
if (SELFTEST) {
  app.whenReady().then(async () => {
    loadSettings(); registerProtocol(); createWindow();
    const outFile = SELFTEST.slice('--self-test='.length);
    let code = 1;
    try {
      const results = await require('./selftest').run({ getWin: () => win, engine });
      fs.writeFileSync(outFile, JSON.stringify({ ok: results.every((r) => r.ok), results }, null, 2));
      code = results.every((r) => r.ok) ? 0 : 1;
    } catch (e) { fs.writeFileSync(outFile, JSON.stringify({ ok: false, error: String((e && e.stack) || e) }, null, 2)); }
    await engine.terminate();
    app.exit(code);
  });
} else if (!gotLock) app.quit();
else {
  app.on('second-instance', (_e, argv) => {
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
    const p = picturesFromArgs(argv);
    if (p.length) openAndSend(p);
  });
  app.whenReady().then(() => {
    loadSettings(); registerProtocol(); createWindow();
    if (E2E) {
      win.webContents.once('did-finish-load', () => {
        const outFile = (process.argv.find((a) => a.startsWith('--e2e-out=')) || '').slice(10);
        const shotsDir = (process.argv.find((a) => a.startsWith('--shots=')) || '').slice(8);
        const readme = (process.argv.find((a) => a.startsWith('--readme-shots=')) || '').slice(15);
        const ctx = { app, getWin: () => win, outFile, shotsDir, outDir: readme, engine, openPaths };
        if (readme) require('../test/readme-shots').run(ctx); else require('../test/e2e').run(ctx);
      });
      return;
    }
    const startup = picturesFromArgs(process.argv);
    if (startup.length) win.webContents.once('did-finish-load', () => openAndSend(startup));
  });
  app.on('window-all-closed', async () => { if (job) job.abort(); await engine.terminate(); app.quit(); });
}
