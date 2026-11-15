'use strict';
const { app, BrowserWindow, ipcMain, dialog, Menu, session, clipboard } = require('electron');
const fs = require('original-fs');
const path = require('path');
const C = require('./cube');
const { Engine } = require('./engine');

const E2E = process.argv.includes('--e2e');
const SELFTEST = process.argv.find((a) => a.startsWith('--self-test='));
const argValue = (name) => (process.argv.find((a) => a.startsWith(name + '=')) || '').slice(name.length + 1);
if (E2E || SELFTEST) {
  app.setPath('userData', path.join(app.getPath('temp'), `cube-solver-test-${process.pid}`));
  // tests only: a fake webcam that plays an invented video of cube faces (never in normal use)
  const fake = argValue('--fake-video');
  if (fake) {
    app.commandLine.appendSwitch('use-fake-device-for-media-stream');
    app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
    app.commandLine.appendSwitch('use-file-for-fake-video-capture', fake);
  }
}

const PHOTO_EXTS = ['jpg', 'jpeg', 'png', 'webp', 'bmp', 'gif', 'avif'];
const PHOTO_LIMIT = 60 * 1024 * 1024;
const TEXT_LIMIT = 1024 * 1024;

let win = null;
let engine = null;
let lastStatus = null;

const send = (channel, payload) => { if (win && !win.isDestroyed()) win.webContents.send(channel, payload); };
const cleanError = (e) => String((e && e.message) || e);

function startEngine() {
  if (engine) return engine;
  engine = new Engine({ onStatus: (s) => { lastStatus = s; send('solver:status', s); } });
  return engine;
}

function createWindow() {
  win = new BrowserWindow({
    width: 1240, height: 840, minWidth: 1040, minHeight: 680,
    backgroundColor: '#0b0b0d', title: "Rubik's Cube Solver", autoHideMenuBar: true, show: !SELFTEST,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false },
  });
  Menu.setApplicationMenu(null);
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'), (E2E || SELFTEST) ? { hash: 'e2e' } : undefined);
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.on('closed', () => { win = null; });
}

// The camera: only our own window, only video (never the microphone or the screen). Nothing is recorded or saved: the
// window reads colours from the live picture and drops the frames.
function setUpPermissions() {
  const ours = (wc) => !!(win && !win.isDestroyed() && wc === win.webContents);
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb, details) => {
    const types = (details && details.mediaTypes) || [];
    cb(permission === 'media' && ours(wc) && types.length > 0 && types.every((t) => t === 'video'));
  });
  session.defaultSession.setPermissionCheckHandler((wc, permission, _origin, details) => {
    if (permission !== 'media' || !ours(wc)) return false;
    return !details || !details.mediaType || details.mediaType === 'video';
  });
}

// ---- solving ------------------------------------------------------------------------------------------------------------
ipcMain.handle('solver:status', () => lastStatus || (engine && engine.status) || null);
ipcMain.handle('solver:solve', async (_e, size, faces) => {
  if (size !== 2 && size !== 3) throw new Error('Only 2x2 and 3x3 cubes can be solved');
  const want = size === 3 ? 54 : 24;
  if (typeof faces !== 'string' || faces.length !== want || !/^[URFDLB]+$/.test(faces)) throw new Error('That cube description is not valid');
  // check it again here: the worker must only ever see a real, solvable cube
  const v = C.validate(size, faces.split('').map((f) => C.STANDARD_SCHEME[f]));
  if (!v.ok) throw new Error(v.summary);
  if (size === 3 && v.faces.join('') !== faces) throw new Error('That cube description is not valid');
  if (v.solved) return { moves: [], ms: 0 };
  const eng = startEngine();
  await eng.whenReady(size);
  return eng.solve(size, faces.split(''));
});

// ---- small conveniences ----------------------------------------------------------------------------------------------------
ipcMain.handle('clipboard:write', (_e, text) => {
  if (typeof text !== 'string' || text.length > TEXT_LIMIT) throw new Error('Nothing to copy');
  clipboard.writeText(text);
  return true;
});

ipcMain.handle('solution:save', async (_e, text) => {
  if (typeof text !== 'string' || !text || text.length > TEXT_LIMIT) throw new Error('Nothing to save');
  const pick = await dialog.showSaveDialog(win, { title: 'Save the solution', defaultPath: 'cube-solution.txt', filters: [{ name: 'Text', extensions: ['txt'] }] });
  if (pick.canceled || !pick.filePath) return { ok: false, cancelled: true };
  let out = pick.filePath;
  if (!/\.txt$/i.test(out)) out = freeName(out + '.txt'); // the dialog only asked about the name without .txt
  const part = out + '.part';
  fs.writeFileSync(part, text.replace(/\n/g, process.platform === 'win32' ? '\r\n' : '\n'), 'utf8');
  fs.renameSync(part, out);
  return { ok: true, path: out };
});
function freeName(p) {
  if (!fs.existsSync(p)) return p;
  const ext = path.extname(p); const base = p.slice(0, p.length - ext.length);
  for (let i = 2; ; i++) { const c = `${base} (${i})${ext}`; if (!fs.existsSync(c)) return c; }
}

// Photos are read here (the window is sandboxed) and handed over as bytes; they are only read, never changed.
ipcMain.handle('photos:pick', async (_e, multi) => {
  const r = await dialog.showOpenDialog(win, {
    title: multi ? 'Choose photos of the six faces' : 'Choose a photo of this face',
    properties: multi ? ['openFile', 'multiSelections'] : ['openFile'],
    filters: [{ name: 'Pictures', extensions: PHOTO_EXTS }],
  });
  if (r.canceled) return [];
  const out = [];
  for (const file of r.filePaths.slice(0, 6)) {
    const ext = path.extname(file).slice(1).toLowerCase();
    if (!PHOTO_EXTS.includes(ext)) { out.push({ name: path.basename(file), error: 'Not a picture this tool can read' }); continue; }
    try {
      const st = fs.statSync(file);
      if (st.size > PHOTO_LIMIT) { out.push({ name: path.basename(file), error: 'That picture is too big (over 60 MB)' }); continue; }
      out.push({ name: path.basename(file), bytes: new Uint8Array(fs.readFileSync(file)) });
    } catch (e) { out.push({ name: path.basename(file), error: cleanError(e) }); }
  }
  return out;
});

// ---- start up ------------------------------------------------------------------------------------------------------------------
function cleanUp() { try { if (engine) engine.close(); } catch { /* ignore */ } }

const gotLock = SELFTEST || E2E ? true : app.requestSingleInstanceLock();
if (SELFTEST) {
  app.whenReady().then(async () => {
    setUpPermissions();
    startEngine();
    createWindow();
    const outFile = SELFTEST.slice('--self-test='.length);
    let code = 1;
    try {
      const results = await require('./selftest').run({ getWin: () => win, engine });
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
    startEngine();
    createWindow();
    if (E2E) {
      win.webContents.once('did-finish-load', () => {
        const ctx = { app, getWin: () => win, outFile: argValue('--e2e-out'), shotsDir: argValue('--shots'), outDir: argValue('--readme-shots'), fakeVideo: argValue('--fake-video'), fakeSeed: Number(argValue('--fake-seed')) || 0, dialog };
        if (ctx.outDir) require('../test/readme-shots').run(ctx); else require('../test/e2e').run(ctx);
      });
    }
  });
  app.on('window-all-closed', () => { cleanUp(); app.quit(); });
}
