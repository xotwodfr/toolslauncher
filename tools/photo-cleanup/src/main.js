'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, Menu, clipboard, nativeImage, powerSaveBlocker } = require('electron');
const fs = require('original-fs');
const path = require('path');
const C = require('./core');
const M = require('./meta');
const E = require('./engine');

const E2E = process.argv.includes('--e2e');
const SELFTEST = process.argv.find((a) => a.startsWith('--self-test='));
if (E2E || SELFTEST) app.setPath('userData', path.join(app.getPath('temp'), `photo-cleanup-test-${process.pid}`));

// LaMa holds ~1 GB while loaded and takes ~9 s to load, so it stays loaded while the photo is being worked on and is let
// go after a quiet spell.
const IDLE_RELEASE_MS = Number(process.env.PC_IDLE_MS) || 5 * 60 * 1000;

let win = null;
let nextId = 1;
const images = new Map();           // id -> { path, name, format, meta }  photos the user opened (the window names them by id)
const produced = new Set();         // files we wrote - the only ones "Show in folder" may reveal

const send = (channel, payload) => { if (win && !win.isDestroyed()) win.webContents.send(channel, payload); };
const cleanError = (e) => String((e && e.message) || e);

function createWindow() {
  win = new BrowserWindow({
    width: 1320, height: 860, minWidth: 1020, minHeight: 660,
    backgroundColor: '#0b0b0d', title: 'Photo Cleanup', autoHideMenuBar: true, show: !SELFTEST,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false },
  });
  Menu.setApplicationMenu(null);
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'), (E2E || SELFTEST) ? { hash: 'e2e' } : undefined);
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.on('closed', () => { win = null; });
}

// ---- opening photos ----------------------------------------------------------------------------------------------------
async function openImage(p) {
  try {
    if (typeof p !== 'string') throw new C.UserError('Nothing to open');
    const st = await fs.promises.stat(p);
    if (!st.isFile()) throw new C.UserError('This is not a file');
    if (st.size > C.MAX_FILE_BYTES) throw new C.UserError(`This file is ${C.formatBytes(st.size)}, more than the ${C.formatBytes(C.MAX_FILE_BYTES)} limit`);
    const fd = await fs.promises.open(p, 'r');
    const head = Buffer.alloc(16);
    try { await fd.read(head, 0, 16, 0); } finally { await fd.close(); }
    const format = C.sniff(head);
    if (format === 'heic' || /\.(heic|heif)$/i.test(p)) throw new C.UserError('HEIC photos cannot be opened here. Export the photo as JPEG first (most phones and photo apps can do this).');
    if (!['jpeg', 'png', 'webp', 'avif', 'bmp', 'gif'].includes(format)) throw new C.UserError('This is not a photo Photo Cleanup can open (JPEG, PNG, WebP, AVIF, BMP or GIF)');
    const bytes = await fs.promises.readFile(p);
    const meta = M.readMeta(bytes);
    const ex = M.exifSummary(meta.exif);
    const id = nextId++;
    images.set(id, { path: p, name: path.basename(p), format, meta });
    return {
      ok: true, id, name: path.basename(p), size: st.size, format, bytes,
      details: { exif: !!meta.exif, xmp: !!meta.xmp, icc: !!meta.icc, camera: ex.camera, date: ex.date, gps: ex.gps, orientation: ex.orientation },
    };
  } catch (e) { return { ok: false, name: path.basename(String(p || '')), error: cleanError(e) }; }
}
const OPEN_FILTERS = [{ name: 'Photos', extensions: C.OPEN_EXTS.map((e) => e.slice(1)) }];
ipcMain.handle('image:pick', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Open a photo', properties: ['openFile'], filters: OPEN_FILTERS });
  return r.canceled || !r.filePaths.length ? null : openImage(r.filePaths[0]);
});
ipcMain.handle('image:open', (_e, p) => openImage(p));

// ---- the models ------------------------------------------------------------------------------------------------------------
const runners = { lama: { r: null, starting: null, timer: null, busy: 0 }, sam: { r: null, starting: null, timer: null, busy: 0 } };
function getRunner(kind) {
  const s = runners[kind];
  clearTimeout(s.timer);
  if (s.r) return Promise.resolve(s.r);
  if (!s.starting) s.starting = E.createRunner(kind).then((r) => { s.r = r; s.starting = null; armIdle(kind); return r; }, (e) => { s.starting = null; throw e; });
  return s.starting;
}
function armIdle(kind) {
  const s = runners[kind];
  clearTimeout(s.timer);
  s.timer = setTimeout(() => { if (!s.busy) dropRunner(kind); }, IDLE_RELEASE_MS);
  if (s.timer.unref) s.timer.unref();
}
async function dropRunner(kind) {
  const s = runners[kind]; const r = s.r; s.r = null; s.starting = null; clearTimeout(s.timer);
  if (r) { try { await r.release(); } catch { /* ignore */ } }
}
async function withRunner(kind, fn) {
  const s = runners[kind];
  s.busy++;
  try { return await fn(await getRunner(kind)); } finally { s.busy--; armIdle(kind); }
}

ipcMain.handle('engine:check', () => {
  const problems = [];
  const missing = E.missingModels();
  if (missing.length) problems.push(`Model file(s) missing: ${missing.join(', ')} (run "npm run setup" in the tool folder).`);
  try { require('onnxruntime-node'); } catch (e) { problems.push('The model runtime could not start: ' + cleanError(e).slice(0, 160)); }
  return { ok: problems.length === 0, problems };
});
// start both models in the background as soon as a photo is open, so the first tap and the first removal do not wait
ipcMain.handle('engine:warm', () => { for (const k of ['sam', 'lama']) getRunner(k).catch(() => {}); return true; });
ipcMain.handle('engine:state', () => ({ lama: !!runners.lama.r, sam: !!runners.sam.r }));

ipcMain.handle('sam:encode', async (_e, req) => {
  try {
    if (!req || !(req.rgb instanceof Uint8Array) || req.rgb.length !== req.w * req.h * 3 || Math.max(req.w, req.h) > C.SAM) throw new C.UserError('The photo was not prepared correctly');
    const res = await withRunner('sam', (r) => r.call({ type: 'encode', key: req.key, rgb: req.rgb, w: req.w, h: req.h }));
    return { ok: true, key: res.key, seconds: res.seconds };
  } catch (e) { return { ok: false, error: cleanError(e) }; }
});
ipcMain.handle('sam:decode', async (_e, req) => {
  try {
    if (!req || !Array.isArray(req.points) || !req.points.length || req.points.length > 64 || req.points.length !== req.labels.length) throw new C.UserError('Nothing to select');
    const res = await withRunner('sam', (r) => r.call({ type: 'decode', key: req.key, points: req.points, labels: req.labels, maskInput: req.maskInput || null }));
    return { ok: true, logits: res.logits, w: res.w, h: res.h, lowRes: res.lowRes, score: res.score, seconds: res.seconds };
  } catch (e) {
    if (/stale-embedding/.test(cleanError(e))) return { ok: false, stale: true };
    return { ok: false, error: cleanError(e) };
  }
});

let fillCancel = false;
ipcMain.handle('fill:run', async (_e, req) => {
  fillCancel = false;
  const blocker = powerSaveBlocker.start('prevent-app-suspension');
  try {
    const okSize = req && req.w > 0 && req.h > 0 && req.w * req.h <= C.MAX_PIXELS;
    if (!okSize || !(req.rgba instanceof Uint8ClampedArray || req.rgba instanceof Uint8Array) || req.rgba.length !== req.w * req.h * 4 || !(req.unknown instanceof Uint8Array) || req.unknown.length !== req.w * req.h) throw new C.UserError('The area was not prepared correctly');
    if (!runners.lama.r) send('fill:phase', { phase: 'loading' });
    const res = await withRunner('lama', async (r) => {
      if (fillCancel) throw E.cancelled();
      send('fill:phase', { phase: 'filling' });
      return r.call({ type: 'fill', rgba: req.rgba, w: req.w, h: req.h, unknown: req.unknown, feather: Math.max(0, Math.min(64, Number(req.feather) || 0)), pads: req.pads || null, skip: req.skip || null, gaps: req.gaps || null, kind: req.kind === 'extend' ? 'extend' : 'remove' });
    });
    if (fillCancel) return { ok: false, cancelled: true };
    return { ok: true, rgba: res.rgba, seconds: res.seconds };
  } catch (e) {
    if (e && e.cancelled) return { ok: false, cancelled: true };
    return { ok: false, error: cleanError(e) };
  } finally { powerSaveBlocker.stop(blocker); }
});
ipcMain.handle('fill:cancel', () => { fillCancel = true; if (runners.lama.r) runners.lama.r.cancelPending(); });

// ---- saving and copying ---------------------------------------------------------------------------------------------------------
ipcMain.handle('image:save', async (_e, req) => {
  try {
    const src = images.get(req && req.id);
    const fmt = req && C.FORMATS[req.format];
    if (!src || !fmt) throw new C.UserError('Nothing to save');
    const w = req.w | 0; const h = req.h | 0;
    if (!(w > 0 && h > 0 && w * h <= C.MAX_PIXELS)) throw new C.UserError('Nothing to save');
    const meta = M.metaForSave(src.meta, !!req.keepDetails, w, h);
    let bytes;
    if (req.format === 'png') {
      if (!req.rgba || req.rgba.length !== w * h * 4) throw new C.UserError('The picture was not prepared correctly');
      bytes = await M.encodePng(req.rgba, w, h, meta);
    } else {
      const enc = Buffer.from(req.bytes || []);
      if (C.sniff(enc) !== req.format) throw new C.UserError('The picture could not be encoded as ' + fmt.label);
      bytes = req.format === 'jpeg' ? M.jpegWithMeta(enc, meta) : M.webpWithMeta(enc, meta, w, h);
    }
    const pick = await dialog.showSaveDialog(win, {
      title: 'Save the cleaned-up photo', defaultPath: path.join(path.dirname(src.path), C.defaultName(src.name, req.format)),
      filters: [{ name: fmt.label, extensions: [fmt.ext.slice(1)] }],
    });
    if (pick.canceled || !pick.filePath) return { ok: false, dialogCancelled: true };
    let out = pick.filePath;
    const ext = C.extOf(out);
    if (ext !== fmt.ext && !(fmt.ext === '.jpg' && ext === '.jpeg')) out += fmt.ext;
    if (path.resolve(out).toLowerCase() === path.resolve(src.path).toLowerCase()) throw new C.UserError('That would overwrite the original photo. Choose another name.');
    const part = out + '.part';
    await fs.promises.writeFile(part, bytes);
    await fs.promises.rename(part, out);
    produced.add(out);
    return { ok: true, path: out, bytes: bytes.length, details: !!(meta.exif || meta.xmp) };
  } catch (e) { return { ok: false, error: cleanError(e) }; }
});
ipcMain.handle('clipboard:copy', (_e, req) => {
  try {
    const w = req.w | 0; const h = req.h | 0;
    if (!(w > 0 && h > 0) || !req.rgba || req.rgba.length !== w * h * 4) throw new C.UserError('Nothing to copy');
    const bgra = Buffer.alloc(w * h * 4); const s = req.rgba;
    for (let i = 0; i < bgra.length; i += 4) { bgra[i] = s[i + 2]; bgra[i + 1] = s[i + 1]; bgra[i + 2] = s[i]; bgra[i + 3] = s[i + 3]; }
    clipboard.writeImage(nativeImage.createFromBitmap(bgra, { width: w, height: h }));
    return { ok: true };
  } catch (e) { return { ok: false, error: cleanError(e) }; }
});
ipcMain.handle('reveal', (_e, file) => { if (produced.has(file)) shell.showItemInFolder(file); });

// ---- start up -------------------------------------------------------------------------------------------------------------------
const pathsFromArgs = (argv) => argv.slice(app.isPackaged ? 1 : 2).filter((a) => a && !a.startsWith('-') && path.isAbsolute(a) && C.isOpenable(a));
async function openAndSend(paths) { send('image:opened', await openImage(paths[0])); }
async function releaseAll() { await Promise.all(Object.keys(runners).map((k) => dropRunner(k))); }

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
    await releaseAll();
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
        const ctx = { app, getWin: () => win, outFile: arg('--e2e-out'), shotsDir: arg('--shots'), outDir: arg('--readme-shots'), copyDir: arg('--copy-shots'), dialog, clipboard, produced, runners, releaseAll };
        try { (ctx.outDir ? require('../test/readme-shots') : require('../test/e2e')).run(ctx); }
        catch (e) { console.error(e); app.exit(1); }
      });
      return;
    }
    const startup = pathsFromArgs(process.argv);
    if (startup.length) win.webContents.once('did-finish-load', () => openAndSend(startup));
  });
  app.on('window-all-closed', () => { releaseAll().finally(() => app.quit()); });
}
