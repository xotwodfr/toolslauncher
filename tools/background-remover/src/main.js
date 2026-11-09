'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, Menu, powerSaveBlocker } = require('electron');
const fs = require('original-fs');
const path = require('path');
const P = require('./plan');
const C = require('./cutout');

const E2E = process.argv.includes('--e2e');
const SELFTEST = process.argv.find((a) => a.startsWith('--self-test='));
if (E2E || SELFTEST) app.setPath('userData', path.join(app.getPath('temp'), `background-remover-test-${process.pid}`));

const IDLE_RELEASE_MS = Number(process.env.BR_IDLE_MS) || 90 * 1000; // the model holds about 850 MB while loaded; give it back when nobody is using it

let win = null;
let runner = null;
let runnerStarting = null;
let idleTimer = null;
let busy = false;                   // one cutout at a time
let cancelRequested = false;
let nextId = 1;
const images = new Map();           // id -> { path, name }   pictures the user opened (the window only ever names them by id)
const produced = new Set();         // files we wrote - the only ones "Show in folder" may reveal

const send = (channel, payload) => { if (win && !win.isDestroyed()) win.webContents.send(channel, payload); };
const cleanError = (e) => String((e && e.message) || e);

function createWindow() {
  win = new BrowserWindow({
    width: 1280, height: 820, minWidth: 980, minHeight: 640,
    backgroundColor: '#0b0b0d', title: 'Background Remover', autoHideMenuBar: true, show: !SELFTEST,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false },
  });
  Menu.setApplicationMenu(null);
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'), (E2E || SELFTEST) ? { hash: 'e2e' } : undefined);
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.on('closed', () => { win = null; });
}

// ---- reading pictures --------------------------------------------------------------------------------------------------
async function readPicture(p) {
  if (typeof p !== 'string' || !P.isImage(p)) throw new P.UserError('This is not a picture type Background Remover can open (PNG, JPEG, WebP, BMP, GIF or AVIF)');
  const st = await fs.promises.stat(p);
  if (!st.isFile()) throw new P.UserError('This is not a file');
  if (st.size > P.MAX_FILE_BYTES) throw new P.UserError(`This file is ${P.formatBytes(st.size)}, more than the ${P.formatBytes(P.MAX_FILE_BYTES)} limit`);
  return { bytes: await fs.promises.readFile(p), size: st.size };
}

async function openImage(p) {
  try {
    const { bytes, size } = await readPicture(p);
    const id = nextId++;
    images.set(id, { path: p, name: path.basename(p) });
    return { ok: true, id, name: path.basename(p), size, bytes };
  } catch (e) { return { ok: false, name: path.basename(String(p || '')), error: cleanError(e) }; }
}

ipcMain.handle('image:pick', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Open a picture', properties: ['openFile'], filters: [{ name: 'Pictures', extensions: P.IMAGE_EXTS.map((e) => e.slice(1)) }] });
  return r.canceled ? null : openImage(r.filePaths[0]);
});
ipcMain.handle('image:open', (_e, p) => openImage(p));
ipcMain.handle('background:pick', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Choose a background picture', properties: ['openFile'], filters: [{ name: 'Pictures', extensions: P.IMAGE_EXTS.map((e) => e.slice(1)) }] });
  if (r.canceled) return null;
  try { const { bytes } = await readPicture(r.filePaths[0]); return { ok: true, name: path.basename(r.filePaths[0]), bytes }; } catch (e) { return { ok: false, error: cleanError(e) }; }
});

// ---- the model ------------------------------------------------------------------------------------------------------------
ipcMain.handle('engine:check', () => {
  const problems = [];
  if (!fs.existsSync(C.modelPath())) problems.push('The background-removal model file is missing (run "npm run setup" in the tool folder).');
  try { require('onnxruntime-node'); } catch (e) { problems.push('The model runtime could not start: ' + cleanError(e).slice(0, 160)); }
  return { ok: problems.length === 0, problems };
});

const armIdle = () => {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => { if (!busy) dropRunner(); }, IDLE_RELEASE_MS);
  if (idleTimer.unref) idleTimer.unref();
};
async function dropRunner() {
  const r = runner; runner = null; runnerStarting = null;
  if (r) { try { await r.release(); } catch { /* ignore */ } }
}
async function getRunner() {
  if (runner) return runner;
  if (!runnerStarting) runnerStarting = C.createRunner().then((r) => { runner = r; return r; }, (e) => { runnerStarting = null; throw e; });
  return runnerStarting;
}

ipcMain.handle('cutout:run', async (_e, buffer) => {
  if (busy) return { ok: false, error: 'A cutout is already running' };
  busy = true;
  cancelRequested = false;
  clearTimeout(idleTimer);
  const blocker = powerSaveBlocker.start('prevent-app-suspension');
  try {
    if (!(buffer instanceof ArrayBuffer) && !ArrayBuffer.isView(buffer)) throw new P.UserError('The picture was not prepared correctly');
    const bytes = buffer instanceof ArrayBuffer ? new Uint8Array(buffer) : new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    if (bytes.byteLength !== 3 * P.SIZE * P.SIZE * 4) throw new P.UserError('The picture was not prepared correctly');
    const tensor = new Float32Array(bytes.slice().buffer);   // a private, aligned copy
    send('cutout:phase', { phase: runner ? 'finding' : 'loading' });
    const r = await getRunner();
    if (cancelRequested) return { ok: false, cancelled: true };   // cancelled while the model was still starting
    send('cutout:phase', { phase: 'finding' });
    const t0 = Date.now();
    const out = await r.run(tensor);
    return { ok: true, mask: out.mask, flat: out.flat, seconds: (Date.now() - t0) / 1000 };
  } catch (e) {
    if (e && e.cancelled) return { ok: false, cancelled: true };
    await dropRunner();
    return { ok: false, error: cleanError(e) };
  } finally { powerSaveBlocker.stop(blocker); busy = false; armIdle(); }
});
ipcMain.handle('cutout:cancel', () => { cancelRequested = true; if (runner) runner.cancelPending(); });

// ---- saving -----------------------------------------------------------------------------------------------------------------
ipcMain.handle('image:save', async (_e, req) => {
  try {
    const src = images.get(req && req.id);
    const fmt = req && P.FORMATS[req.format];
    if (!src || !fmt) throw new P.UserError('Nothing to save');
    const bytes = Buffer.from(req.bytes);
    if (P.sniff(bytes) !== req.format) throw new P.UserError('The picture could not be encoded as ' + fmt.label.split(' ')[0]);
    if (bytes.length > 400 * 1024 * 1024) throw new P.UserError('The result is too large to save');
    const pick = await dialog.showSaveDialog(win, {
      title: 'Save the cutout', defaultPath: path.join(path.dirname(src.path), P.defaultName(src.name, req.format)),
      filters: [{ name: fmt.label.split(' ')[0], extensions: [fmt.ext.slice(1)] }],
    });
    if (pick.canceled || !pick.filePath) return { ok: false, dialogCancelled: true };
    let out = pick.filePath;
    if (P.extOf(out) !== fmt.ext && !(fmt.ext === '.jpg' && P.extOf(out) === '.jpeg')) out += fmt.ext;
    if (path.resolve(out).toLowerCase() === path.resolve(src.path).toLowerCase()) throw new P.UserError('That would overwrite the original picture. Choose another name.');
    const part = out + '.part';
    await fs.promises.writeFile(part, bytes);
    await fs.promises.rename(part, out);
    produced.add(out);
    return { ok: true, path: out, bytes: bytes.length };
  } catch (e) { return { ok: false, error: cleanError(e) }; }
});
ipcMain.handle('reveal', (_e, file) => { if (produced.has(file)) shell.showItemInFolder(file); });

// ---- start up ---------------------------------------------------------------------------------------------------------------------
const pathsFromArgs = (argv) => argv.slice(app.isPackaged ? 1 : 2).filter((a) => a && !a.startsWith('-') && path.isAbsolute(a) && P.isImage(a));
async function openAndSend(paths) { const r = await openImage(paths[0]); send('image:opened', r); }
function cleanUp() { clearTimeout(idleTimer); const r = runner; runner = null; if (r) r.release().catch(() => {}); }

const gotLock = SELFTEST || E2E ? true : app.requestSingleInstanceLock();
if (SELFTEST) {
  app.whenReady().then(async () => {
    createWindow();
    const outFile = SELFTEST.slice('--self-test='.length);
    let code = 1;
    try {
      const results = await require('./selftest').run({ getWin: () => win, dialog });
      fs.writeFileSync(outFile, JSON.stringify({ ok: results.every((r) => r.ok), results }, null, 2));
      code = results.every((r) => r.ok) ? 0 : 1;
    } catch (e) {
      fs.writeFileSync(outFile, JSON.stringify({ ok: false, error: String((e && e.stack) || e) }, null, 2));
    }
    await dropRunner();
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
    createWindow();
    if (E2E) {
      win.webContents.once('did-finish-load', () => {
        const arg = (name) => (process.argv.find((a) => a.startsWith(name + '=')) || '').slice(name.length + 1);
        const ctx = { app, getWin: () => win, outFile: arg('--e2e-out'), shotsDir: arg('--shots'), outDir: arg('--readme-shots'), dialog, shell, produced, modelLoaded: () => !!runner };
        if (ctx.outDir) require('../test/readme-shots').run(ctx); else require('../test/e2e').run(ctx);
      });
      return;
    }
    const startup = pathsFromArgs(process.argv);
    if (startup.length) win.webContents.once('did-finish-load', () => openAndSend(startup));
  });
  app.on('window-all-closed', () => { cleanUp(); app.quit(); });
}
