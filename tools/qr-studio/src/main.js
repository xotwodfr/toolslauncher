'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, clipboard, nativeImage, desktopCapturer, screen, Menu } = require('electron');
const fs = require('fs');
const path = require('path');
const { Worker } = require('worker_threads');
const R = require('./render');

const E2E = process.argv.includes('--e2e');
const SELFTEST = process.argv.find((a) => a.startsWith('--self-test='));
if (E2E || SELFTEST) app.setPath('userData', path.join(app.getPath('temp'), `qr-studio-test-${process.pid}`));

const MAX_PIXELS = 60e6;            // pictures to read: about 60 megapixels at most
const MAX_FILE = 80 * 1024 * 1024;  // pictures to open / logo files
const MAX_OUT = 200 * 1024 * 1024;  // one saved file
let win = null;
let logo = null;                    // { dataUrl, name } chosen by the user
let batchDir = null;                // the output folder the user chose for a batch: the only place batch files are written
const produced = new Set();         // files and folders this app wrote: the only ones "Show in folder" reveals

const cleanError = (e) => String((e && e.message) || e);

function createWindow() {
  win = new BrowserWindow({
    width: 1240, height: 840, minWidth: 980, minHeight: 640,
    backgroundColor: '#0b0b0d', title: 'QR & Barcode Studio', autoHideMenuBar: true, show: !SELFTEST,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false },
  });
  Menu.setApplicationMenu(null);
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'), (E2E || SELFTEST) ? { hash: 'e2e' } : undefined);
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.on('closed', () => { win = null; });
}

// ---- reading codes on a worker thread ----------------------------------------------------------------------------------
let worker = null; let nextId = 1; const pending = new Map();
function getWorker() {
  if (worker) return worker;
  worker = new Worker(path.join(__dirname, 'decode-worker.js'));
  worker.on('message', (m) => { const p = pending.get(m.id); if (!p) return; pending.delete(m.id); if (m.error) p.reject(new Error(m.error)); else p.resolve(m.results); });
  worker.on('error', (e) => { for (const p of pending.values()) p.reject(e); pending.clear(); worker = null; });
  worker.on('exit', () => { for (const p of pending.values()) p.reject(new Error('The reader stopped unexpectedly')); pending.clear(); worker = null; });
  return worker;
}
function decode(img) {
  return new Promise((resolve, reject) => { const id = nextId++; pending.set(id, { resolve, reject }); getWorker().postMessage({ id, img }); });
}
function checkImage(img) {
  if (!img || typeof img !== 'object') throw new Error('No picture');
  const w = Math.floor(img.width); const h = Math.floor(img.height);
  if (!(w > 0 && h > 0) || w * h > MAX_PIXELS) throw new Error('That picture is too big to read (60 megapixels at most).');
  const d = img.data;
  if (!(d instanceof Uint8Array || d instanceof Uint8ClampedArray) || d.length !== w * h * 4) throw new Error('That picture could not be read.');
  return { width: w, height: h, data: d };
}
/** nativeImage -> RGBA (its bitmap is BGRA on Windows and Linux) */
function rgbaOf(img) {
  const { width, height } = img.getSize();
  const bgra = img.toBitmap();
  const out = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < out.length; i += 4) { out[i] = bgra[i + 2]; out[i + 1] = bgra[i + 1]; out[i + 2] = bgra[i]; out[i + 3] = 255; }
  return { width, height, data: out };
}

// ---- making codes ------------------------------------------------------------------------------------------------------
const str = (v, max = 8000) => (typeof v === 'string' ? v.slice(0, max) : '');
function qrOpts(o) {
  o = o && typeof o === 'object' ? o : {};
  return {
    level: ['L', 'M', 'Q', 'H'].includes(o.level) ? o.level : 'M', size: Number(o.size) || 512, margin: Number.isFinite(Number(o.margin)) ? Number(o.margin) : 4,
    fg: str(o.fg, 7), bg: str(o.bg, 7), transparent: o.transparent === true, style: str(o.style, 10),
    logo: o.logo === true && logo ? logo : null, logoScale: Number(o.logoScale) || 0.15,
  };
}
ipcMain.handle('qr:make', (_e, text, o) => {
  try {
    const t = str(text, 8000);
    if (!t) return { ok: false, error: 'Nothing to put in the code yet.' };
    const q = R.qrSvg(t, qrOpts(o));
    return { ok: true, svg: q.svg, version: q.version, level: q.level, modules: q.modules, warnings: q.warnings };
  } catch (e) { return { ok: false, error: cleanError(e) }; }
});
function barOpts(o) {
  o = o && typeof o === 'object' ? o : {};
  return { showText: o.showText !== false, height: Number(o.height) || 0, fg: str(o.fg, 7), bg: str(o.bg, 7), transparent: o.transparent === true, check: o.check === true };
}
ipcMain.handle('bar:make', (_e, kind, input, o) => {
  try { const b = R.barcodeSvg(str(kind, 20), str(input, 200), barOpts(o)); return { ok: true, ...b }; } catch (e) { return { ok: false, error: cleanError(e) }; }
});

ipcMain.handle('logo:pick', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Choose a logo', properties: ['openFile'], filters: [{ name: 'Pictures', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg'] }] });
  if (r.canceled || !r.filePaths.length) return { ok: false, cancelled: true };
  return setLogo(r.filePaths[0]);
});
function setLogo(file) {
  try {
    const st = fs.statSync(file);
    if (st.size > MAX_FILE) return { ok: false, error: 'That picture is too big for a logo.' };
    const buf = fs.readFileSync(file);
    let img = /\.svg$/i.test(file) ? null : nativeImage.createFromBuffer(buf);
    let dataUrl;
    if (img && !img.isEmpty()) {
      const { width, height } = img.getSize();
      if (Math.max(width, height) > 512) img = img.resize(width >= height ? { width: 512, quality: 'best' } : { height: 512, quality: 'best' });
      dataUrl = img.toDataURL(); // re-encoded as PNG: only plain pixels go into the code
    } else if (/\.svg$/i.test(file)) {
      const text = buf.toString('utf8');
      if (/<script|on\w+\s*=|href\s*=\s*["'](?!#|data:image\/)/i.test(text)) return { ok: false, error: 'That SVG file has scripts or links in it, so it is not used.' };
      dataUrl = 'data:image/svg+xml;base64,' + buf.toString('base64');
    } else return { ok: false, error: 'That file is not a picture this app can use.' };
    logo = { dataUrl, name: path.basename(file) };
    return { ok: true, name: logo.name, preview: dataUrl };
  } catch (e) { return { ok: false, error: 'The logo could not be opened: ' + cleanError(e) }; }
}
ipcMain.handle('logo:clear', () => { logo = null; });

// ---- reading -----------------------------------------------------------------------------------------------------------
ipcMain.handle('read:pixels', async (_e, img) => {
  try { return { ok: true, results: await decode(checkImage(img)) }; } catch (e) { return { ok: false, error: cleanError(e) }; }
});
ipcMain.handle('read:open', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Open a picture with codes', properties: ['openFile'], filters: [{ name: 'Pictures', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'avif', 'svg'] }] });
  if (r.canceled || !r.filePaths.length) return { ok: false, cancelled: true };
  return readFileForWindow(r.filePaths[0]);
});
function readFileForWindow(file) {
  try {
    const st = fs.statSync(file);
    if (!st.isFile()) return { ok: false, error: 'That is not a file.' };
    if (st.size > MAX_FILE) return { ok: false, error: 'That picture is too big (80 MB at most).' };
    return { ok: true, name: path.basename(file), bytes: new Uint8Array(fs.readFileSync(file)) };
  } catch (e) { return { ok: false, error: 'The picture could not be opened: ' + cleanError(e) }; }
}
ipcMain.handle('read:screen', async (_e, hide) => {
  let hidden = false;
  try {
    if (hide !== false && win && win.isVisible()) { win.hide(); hidden = true; await new Promise((r) => setTimeout(r, 450)); }
    const shots = [];
    const displays = screen.getAllDisplays();
    const biggest = displays.reduce((m, d) => ({ width: Math.max(m.width, Math.round(d.size.width * d.scaleFactor)), height: Math.max(m.height, Math.round(d.size.height * d.scaleFactor)) }), { width: 0, height: 0 });
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: biggest });
    if (hidden) { win.show(); hidden = false; }
    for (const s of sources) {
      if (s.thumbnail.isEmpty()) continue;
      const img = rgbaOf(s.thumbnail);
      const results = await decode(img);
      shots.push({ name: s.name, width: img.width, height: img.height, png: new Uint8Array(s.thumbnail.toPNG()), results });
    }
    if (!shots.length) return { ok: false, error: 'The screen could not be captured. On some Linux desktops (Wayland) the system has to allow screen capture first.' };
    return { ok: true, shots };
  } catch (e) {
    return { ok: false, error: 'The screen could not be captured: ' + cleanError(e) };
  } finally { if (hidden && win) win.show(); }
});
ipcMain.handle('link:open', async (_e, url) => {
  const u = str(url, 4000);
  if (!/^(https?:\/\/|mailto:)/i.test(u)) return { ok: false, error: 'Only web and mail links can be opened.' };
  const r = await dialog.showMessageBox(win, { type: 'question', buttons: ['Open in browser', 'Cancel'], defaultId: 1, cancelId: 1, noLink: true, title: 'Open link', message: 'Open this link in your browser?', detail: u + '\n\nOnly open links you trust: a code can point anywhere.' });
  if (r.response !== 0) return { ok: false, cancelled: true };
  await shell.openExternal(u);
  return { ok: true };
});

// ---- saving ------------------------------------------------------------------------------------------------------------
/** "name.ext", or "name (2).ext" ... when it exists: never replaces a file silently */
function uniquePath(dir, base, ext) {
  let p = path.join(dir, base + ext);
  for (let i = 2; fs.existsSync(p) || fs.existsSync(p + '.part'); i++) p = path.join(dir, `${base} (${i})${ext}`);
  return p;
}
function writeAtomic(file, data) {
  const part = file + '.part';
  fs.writeFileSync(part, data);
  fs.renameSync(part, file);
  produced.add(file);
}
const dataOf = (d) => (typeof d === 'string' ? Buffer.from(d, 'utf8') : d instanceof Uint8Array ? Buffer.from(d.buffer, d.byteOffset, d.byteLength) : null);
const safeName = (s) => String(s || '').normalize('NFC').replace(/[\u0000-\u001f<>:"/\\|?*\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/^\.+/, '').replace(/[. ]+$/, '').slice(0, 60) || 'code';
ipcMain.handle('save:file', async (_e, data, kind, name) => {
  const buf = dataOf(data);
  if (!buf || !buf.length || buf.length > MAX_OUT) throw new Error('Nothing to save');
  const ext = kind === 'svg' ? 'svg' : 'png';
  const pick = await dialog.showSaveDialog(win, { title: ext === 'svg' ? 'Save as SVG' : 'Save as PNG', defaultPath: safeName(name) + '.' + ext, filters: [{ name: ext.toUpperCase(), extensions: [ext] }] });
  if (pick.canceled || !pick.filePath) return { ok: false, cancelled: true };
  let out = pick.filePath;
  if (!new RegExp('\\.' + ext + '$', 'i').test(out)) out += '.' + ext;
  writeAtomic(out, buf); // the save dialog has already asked before replacing an existing file
  return { ok: true, path: out };
});
ipcMain.handle('clip:png', (_e, png) => {
  const buf = dataOf(png);
  if (!buf || !buf.length) return { ok: false, error: 'Nothing to copy' };
  const img = nativeImage.createFromBuffer(buf);
  if (img.isEmpty()) return { ok: false, error: 'Could not copy the picture' };
  clipboard.writeImage(img);
  return { ok: true };
});
ipcMain.handle('clip:text', (_e, t) => { const s = str(t, 100000); if (!s) return { ok: false }; clipboard.writeText(s); return { ok: true }; });
ipcMain.handle('clip:image', () => {
  const img = clipboard.readImage();
  if (img.isEmpty()) return { ok: false, error: 'There is no picture on the clipboard. Copy a picture or a screenshot first.' };
  return { ok: true, png: new Uint8Array(img.toPNG()) };
});
ipcMain.handle('file:show', (_e, p) => { if (typeof p === 'string' && produced.has(p) && fs.existsSync(p)) { shell.showItemInFolder(p); return true; } return false; });

// ---- batch -------------------------------------------------------------------------------------------------------------
ipcMain.handle('batch:dir', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Choose the folder for the codes', properties: ['openDirectory', 'createDirectory'] });
  if (r.canceled || !r.filePaths.length) return null;
  batchDir = r.filePaths[0];
  return batchDir;
});
ipcMain.handle('batch:list', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Open a list (CSV or text, one code per line)', properties: ['openFile'], filters: [{ name: 'Lists', extensions: ['csv', 'txt', 'tsv'] }] });
  if (r.canceled || !r.filePaths.length) return { ok: false, cancelled: true };
  try {
    const st = fs.statSync(r.filePaths[0]);
    if (st.size > 20 * 1024 * 1024) return { ok: false, error: 'That list is too big (20 MB at most).' };
    return { ok: true, name: path.basename(r.filePaths[0]), text: fs.readFileSync(r.filePaths[0], 'utf8').replace(/^﻿/, '') };
  } catch (e) { return { ok: false, error: cleanError(e) }; }
});
ipcMain.handle('batch:write', (_e, item) => {
  try {
    if (!batchDir || !fs.existsSync(batchDir)) return { ok: false, error: 'Choose an output folder first.' };
    item = item && typeof item === 'object' ? item : {};
    const ext = item.ext === 'svg' ? '.svg' : '.png';
    const buf = dataOf(item.data);
    if (!buf || !buf.length || buf.length > MAX_OUT) return { ok: false, error: 'Nothing to write' };
    const file = uniquePath(batchDir, safeName(item.name), ext);
    writeAtomic(file, buf);
    return { ok: true, path: file, name: path.basename(file) };
  } catch (e) { return { ok: false, error: cleanError(e) }; }
});
ipcMain.handle('batch:show', () => { if (batchDir && fs.existsSync(batchDir)) { produced.add(batchDir); shell.openPath(batchDir); return true; } return false; });

// ---- start up ----------------------------------------------------------------------------------------------------------
function cleanUp() { try { if (worker) worker.terminate(); } catch { /* ignore */ } }

if (SELFTEST) {
  app.whenReady().then(async () => {
    createWindow();
    const outFile = SELFTEST.slice('--self-test='.length);
    let code = 1;
    try {
      const results = await require('./selftest').run({ getWin: () => win, decode });
      fs.writeFileSync(outFile, JSON.stringify({ ok: results.every((r) => r.ok), results }, null, 2));
      code = results.every((r) => r.ok) ? 0 : 1;
    } catch (e) {
      fs.writeFileSync(outFile, JSON.stringify({ ok: false, error: String((e && e.stack) || e) }, null, 2));
    }
    cleanUp();
    app.exit(code);
  });
} else if (!E2E && !app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
  app.whenReady().then(() => {
    createWindow();
    if (E2E) {
      win.webContents.once('did-finish-load', () => {
        const arg = (name) => (process.argv.find((a) => a.startsWith(name + '=')) || '').slice(name.length + 1);
        const ctx = { app, getWin: () => win, outFile: arg('--e2e-out'), shotsDir: arg('--shots'), outDir: arg('--readme-shots'), dialog, shell, clipboard, nativeImage, setLogo };
        if (ctx.outDir) require('../test/readme-shots').run(ctx); else require('../test/e2e').run(ctx);
      });
    }
  });
  app.on('window-all-closed', () => { cleanUp(); app.quit(); });
}


