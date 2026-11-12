'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron');
const fs = require('original-fs');
const path = require('path');
const R = require('./recipe');
const P = require('./pipeline');
const B = require('./batch');

const E2E = process.argv.includes('--e2e');
const SELFTEST = process.argv.find((a) => a.startsWith('--self-test='));
if (E2E || SELFTEST) app.setPath('userData', path.join(app.getPath('temp'), `photo-batch-editor-test-${process.pid}`));

const MAX_PHOTOS = 10000;
const PRESETS_MAX = 100;

let win = null;
let nextId = 1;
const photos = new Map();      // id -> { path, info } (the window only ever names photos by id)
const produced = new Set();    // files we wrote: the only ones "Show in folder" reveals
let runAbort = null;

// ---- work in flight, and quitting safely ---------------------------------------------------------------------------------
// On Linux the image work runs on sharp's WebAssembly build (see sharp-loader.js), and a process cannot exit while one of
// its WebAssembly threads is still busy. So every image job is counted, and quitting first stops the batch, refuses new
// work and waits for what is running (a second or two); only if that hangs is the process ended outright.
let inFlight = 0;
let quitting = false;
const idleWaiters = [];
async function track(promise) {
  if (quitting) throw new Error('The app is closing');
  inFlight++;
  try { return await promise; } finally { if (--inFlight === 0) idleWaiters.splice(0).forEach((f) => f()); }
}
const handleBusy = (channel, fn) => ipcMain.handle(channel, (...args) => track(Promise.resolve().then(() => fn(...args))));
async function quitSafely(code = 0) {
  if (quitting) return;
  quitting = true;
  if (runAbort) runAbort.abort();
  if (inFlight) {
    const idle = new Promise((r) => idleWaiters.push(r));
    const late = await Promise.race([idle.then(() => false), new Promise((r) => setTimeout(() => r(true), 20000))]);
    if (late) { process.kill(process.pid, 'SIGKILL'); return; }
  }
  app.exit(code);
}

const send = (channel, payload) => { if (win && !win.isDestroyed()) win.webContents.send(channel, payload); };
const cleanError = (e) => B.plainError(e);
const presetsFile = () => path.join(app.getPath('userData'), 'presets.json');

function createWindow() {
  win = new BrowserWindow({
    width: 1240, height: 840, minWidth: 1020, minHeight: 640,
    backgroundColor: '#0b0b0d', title: 'Photo Batch Editor', autoHideMenuBar: true, show: !SELFTEST,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  Menu.setApplicationMenu(null);
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'), (E2E || SELFTEST) ? { hash: 'e2e' } : undefined);
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.on('closed', () => { win = null; });
}

// ---- photos ------------------------------------------------------------------------------------------------------------------
async function expandPaths(inputs) {
  const out = [];
  const seen = new Set([...photos.values()].map((p) => p.path));
  async function visit(p, depth) {
    if (out.length + photos.size >= MAX_PHOTOS || typeof p !== 'string') return;
    let st;
    try { st = await fs.promises.stat(p); } catch { return; }
    if (st.isDirectory()) {
      if (depth >= 4 || (depth > 0 && path.basename(p) === 'edited')) return; // our own output folder is not input
      let names = [];
      try { names = await fs.promises.readdir(p); } catch { return; }
      names.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
      for (const name of names) await visit(path.join(p, name), depth + 1);
    } else if (st.isFile() && P.isPhoto(p) && !seen.has(p)) {
      seen.add(p);
      out.push({ path: p, bytes: st.size });
    }
  }
  for (const p of inputs) await visit(p, 0);
  return out;
}

async function addPaths(inputs) {
  const list = (Array.isArray(inputs) ? inputs : []).filter((p) => typeof p === 'string');
  const files = await expandPaths(list);
  const rows = new Array(files.length);
  let i = 0;
  const worker = async () => {
    while (i < files.length) {
      const k = i++; const f = files[k];
      const id = nextId++;
      let info = null; let problem = '';
      try { info = await P.inspect(f.path); } catch (e) { problem = cleanError(e); }
      photos.set(id, { path: f.path, info });
      rows[k] = { id, name: path.basename(f.path), folder: path.basename(path.dirname(f.path)), bytes: f.bytes, width: info ? info.width : 0, height: info ? info.height : 0, format: info ? info.format : '', problem };
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));
  return { rows, capped: photos.size >= MAX_PHOTOS, ignored: list.length > 0 && rows.length === 0 };
}
const photoOf = (id) => { const p = photos.get(id); if (!p) throw new Error('That photo is not in the list any more'); return p; };

handleBusy('files:pick', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Add photos', properties: ['openFile', 'multiSelections'], filters: [{ name: 'Photos', extensions: P.INPUT_EXTS.map((e) => e.slice(1)) }] });
  return r.canceled ? { rows: [] } : addPaths(r.filePaths);
});
handleBusy('files:pick-folder', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Add a folder of photos', properties: ['openDirectory'] });
  return r.canceled ? { rows: [] } : addPaths(r.filePaths);
});
handleBusy('files:add', (_e, paths) => addPaths(paths));
ipcMain.handle('files:remove', (_e, ids) => { for (const id of Array.isArray(ids) ? ids : []) photos.delete(id); });
ipcMain.handle('files:clear', () => { photos.clear(); });
handleBusy('files:thumb', async (_e, id) => { try { return await P.thumbnail(photoOf(id).path, 88); } catch { return null; } });

// ---- logo for the watermark --------------------------------------------------------------------------------------------------
handleBusy('logo:pick', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Choose a logo (PNG with transparency works best)', properties: ['openFile'], filters: [{ name: 'Images', extensions: ['png', 'webp', 'jpg', 'jpeg', 'avif', 'tif', 'tiff'] }] });
  if (r.canceled || !r.filePaths[0]) return null;
  const file = r.filePaths[0];
  try { await require('./sharp-loader')(file).metadata(); } catch { throw new Error('That file is not an image this tool can read'); }
  return { file, name: path.basename(file) };
});

// ---- watermark text: drawn by the window's canvas ----------------------------------------------------------------------------
// sharp's own text drawing (Pango + fontconfig) must not run inside Electron on Linux: Chromium carries its own copy of
// those libraries and the two clash (it hangs). So the window draws the words once per batch and sends back a PNG.
let textReq = 1;
const textWaits = new Map();
ipcMain.on('text:tile', (e, id, url, err) => {
  const w = textWaits.get(id);
  if (!w || !win || e.sender !== win.webContents) return;
  textWaits.delete(id);
  if (err || typeof url !== 'string' || !url.startsWith('data:image/png;base64,') || url.length > 30e6) w.rej(new Error(err ? String(err).slice(0, 200) : 'The text could not be drawn'));
  else w.res(url);
});
async function windowText(s) {
  if (!win || win.isDestroyed()) throw new Error('The window is needed to draw the text');
  const id = textReq++;
  const wait = new Promise((res, rej) => {
    textWaits.set(id, { res, rej });
    setTimeout(() => { if (textWaits.delete(id)) rej(new Error('Drawing the watermark text took too long')); }, 20000);
  });
  win.webContents.send('text:draw', { id, text: s.text, colour: s.colour, bold: s.bold, shadow: s.shadow, ref: P.TEXT_REF });
  const url = await wait;
  const r = await require('./sharp-loader')(Buffer.from(url.slice(22), 'base64')).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data: r.data, width: r.info.width, height: r.info.height, ref: P.TEXT_REF };
}

// ---- preview -----------------------------------------------------------------------------------------------------------------
handleBusy('preview', async (_e, id, recipe, output, box) => {
  const p = photoOf(id);
  if (!p.info) throw new Error('This photo cannot be read');
  const size = Math.max(200, Math.min(1600, Math.round(Number(box) || 900)));
  return P.preview(p.path, R.cleanRecipe(recipe), R.cleanOutput(output), { box: size, info: p.info, text: P.textCache(windowText) });
});

// ---- the batch ----------------------------------------------------------------------------------------------------------------
ipcMain.handle('out:pick', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Where should the edited photos go?', properties: ['openDirectory', 'createDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});
handleBusy('run:start', async (_e, ids, recipe, output) => {
  if (runAbort) throw new Error('A batch is already running');
  const list = (Array.isArray(ids) ? ids : []).filter((id) => photos.has(id));
  if (!list.length) throw new Error('No photos to edit');
  const out = R.cleanOutput(output);
  if (out.folder && !path.isAbsolute(out.folder)) throw new Error('Choose the output folder again');
  const ac = new AbortController(); runAbort = ac;
  const files = list.map((id) => photos.get(id).path);
  try {
    const t0 = Date.now();
    const r = await B.runBatch(files, R.cleanRecipe(recipe), out, {
      signal: ac.signal, textDrawer: windowText,
      onItem: (e) => {
        if (e.out) produced.add(e.out);
        send('run:item', { id: list[e.index], status: e.status, out: e.out || '', outName: e.out ? path.basename(e.out) : '', width: e.width, height: e.height, bytes: e.bytes, error: e.error || '' });
      },
    });
    const folders = [...new Set(r.outputs.map((o) => path.dirname(o)))];
    return { done: r.done, failed: r.failed, cancelled: r.cancelled, seconds: (Date.now() - t0) / 1000, firstOutput: r.outputs[0] || '', folders };
  } finally { runAbort = null; }
});
ipcMain.handle('run:cancel', () => { if (runAbort) runAbort.abort(); });
ipcMain.handle('reveal', (_e, file) => { if (typeof file === 'string' && produced.has(file)) shell.showItemInFolder(file); });

// ---- presets --------------------------------------------------------------------------------------------------------------------
function loadPresets() {
  try {
    const j = JSON.parse(fs.readFileSync(presetsFile(), 'utf8'));
    const out = {};
    for (const [name, v] of Object.entries(j && typeof j === 'object' ? j : {})) if (v && typeof v === 'object') out[name.slice(0, 80)] = { recipe: R.cleanRecipe(v.recipe), output: R.cleanOutput(v.output) };
    return out;
  } catch { return {}; }
}
function savePresets(all) {
  fs.mkdirSync(path.dirname(presetsFile()), { recursive: true });
  const tmp = presetsFile() + '.part';
  fs.writeFileSync(tmp, JSON.stringify(all, null, 2));
  fs.renameSync(tmp, presetsFile());
}
ipcMain.handle('presets:list', () => loadPresets());
ipcMain.handle('presets:save', (_e, name, data) => {
  const n = typeof name === 'string' ? name.trim().slice(0, 80) : '';
  if (!n) throw new Error('Give the preset a name');
  const all = loadPresets();
  if (!all[n] && Object.keys(all).length >= PRESETS_MAX) throw new Error('There are too many presets - delete some first');
  all[n] = { recipe: R.cleanRecipe(data && data.recipe), output: R.cleanOutput(data && data.output) };
  savePresets(all);
  return all;
});
ipcMain.handle('presets:delete', (_e, name) => {
  const all = loadPresets();
  delete all[String(name)];
  savePresets(all);
  return all;
});

// ---- start up ---------------------------------------------------------------------------------------------------------------------
const pathsFromArgs = (argv) => argv.slice(app.isPackaged ? 1 : 2).filter((a) => a && !a.startsWith('-') && path.isAbsolute(a));
async function openAndSend(paths) { const r = await addPaths(paths); if (r.rows.length) send('files:opened', r); }

const gotLock = SELFTEST || E2E ? true : app.requestSingleInstanceLock();
if (SELFTEST) {
  app.whenReady().then(async () => {
    createWindow();
    const outFile = SELFTEST.slice('--self-test='.length);
    let code = 1;
    try {
      const results = await require('./selftest').run({ getWin: () => win, textDrawer: windowText });
      fs.writeFileSync(outFile, JSON.stringify({ ok: results.every((r) => r.ok), results }, null, 2));
      code = results.every((r) => r.ok) ? 0 : 1;
    } catch (e) {
      fs.writeFileSync(outFile, JSON.stringify({ ok: false, error: String((e && e.stack) || e) }, null, 2));
    }
    quitSafely(code);
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
        const ctx = { app, exit: quitSafely, getWin: () => win, outFile: arg('--e2e-out'), shotsDir: arg('--shots'), outDir: arg('--readme-shots'), dialog, shell };
        if (ctx.outDir) require('../test/readme-shots').run(ctx); else require('../test/e2e').run(ctx);
      });
      return;
    }
    const startup = pathsFromArgs(process.argv);
    if (startup.length) win.webContents.once('did-finish-load', () => openAndSend(startup));
  });
  app.on('window-all-closed', () => { quitSafely(0); });
}
