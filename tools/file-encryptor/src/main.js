'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, Menu, clipboard } = require('electron');
const fs = require('fs');
const path = require('path');
const L = require('./locked');
const J = require('./jobs');
const H = require('./hashing');
const Strength = require('./strength');
const { HashPool } = require('./hashpool');

const E2E = process.argv.includes('--e2e');
const SELFTEST = process.argv.find((a) => a.startsWith('--self-test='));
if (E2E || SELFTEST) app.setPath('userData', path.join(app.getPath('temp'), `file-encryptor-test-${process.pid}`));

const MAX_ITEMS = 20000;
let win = null;
let nextId = 1;
const items = new Map();       // id -> planned item (the renderer names files only by id)
const produced = new Set();    // outputs we made: the only paths "Show in folder" reveals
let running = null;            // { kind, abort }
let pool = null;
const internals = { trash: (p) => shell.trashItem(p) };

const send = (channel, payload) => { if (win && !win.isDestroyed()) win.webContents.send(channel, payload); };
const cleanError = (e) => {
  if (e && e.code === 'ENOSPC') return 'The disk is full.';
  if (e && (e.code === 'EACCES' || e.code === 'EPERM')) return 'Permission denied: the file or folder cannot be read or written here.';
  if (e && e.code === 'ENOENT') return 'The file is not there any more.';
  return String((e && e.message) || e);
};
const need = (ok, msg = 'Invalid request') => { if (!ok) throw new Error(msg); };
const getPool = () => pool || (pool = new HashPool());

function createWindow() {
  win = new BrowserWindow({
    width: 1240, height: 800, minWidth: 900, minHeight: 600,
    backgroundColor: '#0b0b0d', title: 'File Encryptor & Hasher', autoHideMenuBar: true, show: !SELFTEST,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false, backgroundThrottling: false },
  });
  Menu.setApplicationMenu(null);
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'), (E2E || SELFTEST) ? { hash: 'e2e' } : undefined);
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.on('closed', () => { win = null; });
}

// ---- adding files ----------------------------------------------------------------------------------------------------------
/**
 * mode 'encrypt': files and folders as they are; 'decrypt': .locked files (folders are searched for them);
 * 'hash': files, with folders expanded into their files (relative names kept for checksum files).
 */
async function addPaths(paths, mode) {
  const list = (Array.isArray(paths) ? paths : []).filter((p) => typeof p === 'string' && path.isAbsolute(p));
  const rows = []; const problems = [];
  const row = (it, extra = {}) => { const id = nextId++; items.set(id, { ...it, ...extra }); rows.push({ id, name: it.name, kind: it.kind, bytes: it.bytes, files: it.files, folders: it.folders, dir: path.dirname(it.path), rel: extra.rel || it.name, skipped: it.skipped ? it.skipped.length : 0 }); };
  for (const p of list) {
    if (items.size >= MAX_ITEMS) { problems.push('The list is full.'); break; }
    let st;
    try { st = await fs.promises.stat(p); } catch { problems.push(`${path.basename(p)}: not found`); continue; }
    try {
      if (mode === 'encrypt') { row(await J.plan(p)); continue; }
      if (st.isDirectory()) {
        const files = await H.listFiles(p);
        for (const f of files.slice(0, MAX_ITEMS - items.size)) {
          if (mode === 'decrypt' && !f.abs.toLowerCase().endsWith(J.EXT)) continue;
          const it = await J.plan(f.abs);
          if (mode === 'decrypt' && it.kind !== 'locked') continue;
          row(it, { rel: path.basename(p) + '/' + f.rel, root: path.dirname(p) });
        }
        continue;
      }
      const it = await J.plan(p);
      if (mode === 'decrypt' && it.kind !== 'locked') { problems.push(`${it.name} is not a .locked file made by this app`); continue; }
      row(it, { rel: it.name, root: path.dirname(p) });
    } catch (e) { problems.push(`${path.basename(p)}: ${cleanError(e)}`); }
  }
  return { rows, problems };
}

ipcMain.handle('files:pick', async (_e, mode) => {
  need(['encrypt', 'decrypt', 'hash'].includes(mode));
  const r = await dialog.showOpenDialog(win, {
    title: mode === 'decrypt' ? 'Choose .locked files' : 'Choose files', properties: ['openFile', 'multiSelections'],
    filters: mode === 'decrypt' ? [{ name: 'Encrypted files', extensions: ['locked'] }] : undefined,
  });
  return r.canceled ? { rows: [], problems: [] } : addPaths(r.filePaths, mode);
});
ipcMain.handle('files:pick-folder', async (_e, mode) => {
  need(['encrypt', 'decrypt', 'hash'].includes(mode));
  const r = await dialog.showOpenDialog(win, { title: 'Choose a folder', properties: ['openDirectory', 'multiSelections'] });
  return r.canceled ? { rows: [], problems: [] } : addPaths(r.filePaths, mode);
});
ipcMain.handle('files:add', (_e, paths, mode) => { need(['encrypt', 'decrypt', 'hash'].includes(mode)); return addPaths(paths, mode); });
ipcMain.handle('files:forget', (_e, ids) => { for (const id of Array.isArray(ids) ? ids : []) items.delete(id); });
ipcMain.handle('dir:pick', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Choose where to save', properties: ['openDirectory', 'createDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle('strength', (_e, pw) => { need(typeof pw === 'string' && pw.length <= 1024); return Strength.check(pw); });
ipcMain.handle('clipboard', (_e, text) => { need(typeof text === 'string' && text.length < 100000); clipboard.writeText(text); });
ipcMain.handle('reveal', (_e, file) => { if (produced.has(file)) shell.showItemInFolder(file); });

// ---- running jobs ----------------------------------------------------------------------------------------------------------
function progressReporter(total) {
  let done = 0; let last = 0;
  return {
    add(n) { done += n; const now = Date.now(); if (now - last > 100) { last = now; send('run:progress', { done, total }); } },
    finish() { send('run:progress', { done: total, total }); },
  };
}
function begin(kind) {
  need(!running, 'Something is already running.');
  running = { kind, abort: new AbortController() };
  return running.abort.signal;
}
const checkPassword = (pw) => need(typeof pw === 'string' && pw.length >= 1 && pw.length <= 1024, 'Type the password.');
const checkDir = async (d) => {
  if (d == null) return null;
  need(typeof d === 'string' && path.isAbsolute(d));
  const st = await fs.promises.stat(d).catch(() => null);
  need(st && st.isDirectory(), 'The chosen folder is not there any more.');
  return d;
};

ipcMain.handle('enc:start', async (_e, o) => {
  need(o && typeof o === 'object' && Array.isArray(o.ids));
  checkPassword(o.password);
  need(o.password.length >= 8, 'Use a password of at least 8 characters.');
  const outDir = await checkDir(o.outDir);
  const list = o.ids.filter((id) => items.has(id)).map((id) => [id, items.get(id)]);
  need(list.length, 'Add files or folders first.');
  const signal = begin('encrypt');
  const summary = { done: 0, failed: 0, cancelled: false, trashed: 0, outputs: [] };
  try {
    send('run:phase', { text: 'Preparing the key…' });
    const master = await L.newMaster(o.password);
    const prog = progressReporter(list.reduce((s, [, it]) => s + it.bytes, 0) * (o.deleteOriginals ? 2 : 1));
    try {
      for (const [id, it] of list) {
        if (signal.aborted) { summary.cancelled = true; send('run:item', { id, status: 'skipped' }); continue; }
        send('run:item', { id, status: 'working' });
        send('run:phase', { text: `Encrypting ${it.name}…` });
        try {
          const fresh = it.kind === 'folder' ? await J.plan(it.path) : it; // the folder may have changed since it was added
          const r = await J.encryptItem(fresh, { master, outDir, signal, onBytes: (n) => prog.add(n), deleteOriginal: !!o.deleteOriginals, trash: internals.trash });
          if (o.deleteOriginals) prog.add(fresh.bytes);
          produced.add(r.output); summary.outputs.push(r.output); summary.done++;
          if (r.trashed) summary.trashed++;
          send('run:item', { id, status: 'done', output: r.output, outName: path.basename(r.output), verified: r.verified, trashed: r.trashed, note: r.note || (r.skipped.length ? `${r.skipped.length} link(s) or special file(s) were skipped` : '') });
        } catch (e) {
          if (e.cancelled) { summary.cancelled = true; send('run:item', { id, status: 'skipped' }); } else { summary.failed++; send('run:item', { id, status: 'error', error: cleanError(e) }); }
        }
      }
      prog.finish();
    } finally { master.key.fill(0); }
  } finally { running = null; }
  return summary;
});

ipcMain.handle('dec:start', async (_e, o) => {
  need(o && typeof o === 'object' && Array.isArray(o.ids));
  checkPassword(o.password);
  const outDir = await checkDir(o.outDir);
  const list = o.ids.filter((id) => items.has(id)).map((id) => [id, items.get(id)]);
  need(list.length, 'Add .locked files first.');
  const signal = begin('decrypt');
  const summary = { done: 0, failed: 0, cancelled: false, wrongPassword: 0, outputs: [] };
  const getMaster = L.masterCache(o.password);
  const prog = progressReporter(list.reduce((s, [, it]) => s + it.bytes, 0));
  try {
    for (const [id, it] of list) {
      if (signal.aborted) { summary.cancelled = true; send('run:item', { id, status: 'skipped' }); continue; }
      send('run:item', { id, status: 'working' });
      send('run:phase', { text: `Decrypting ${it.name}…` });
      try {
        const r = await J.decryptItem(it.path, { getMaster, outDir, signal, onBytes: (n) => prog.add(n) });
        produced.add(r.output); summary.outputs.push(r.output); summary.done++;
        send('run:item', { id, status: 'done', output: r.output, outName: path.basename(r.output), kind: r.kind, renamed: r.renamed, files: r.files });
      } catch (e) {
        if (e.cancelled) { summary.cancelled = true; send('run:item', { id, status: 'skipped' }); continue; }
        summary.failed++; if (e.code === 'wrong-password') summary.wrongPassword++;
        send('run:item', { id, status: 'error', error: cleanError(e), code: e.code });
      }
    }
    prog.finish();
  } finally { await getMaster.wipe(); running = null; }
  return summary;
});

ipcMain.handle('hash:start', async (_e, o) => {
  need(o && typeof o === 'object' && Array.isArray(o.ids) && Array.isArray(o.algs));
  const algs = H.ORDER.filter((a) => o.algs.includes(a));
  need(algs.length, 'Choose at least one kind of checksum.');
  const list = o.ids.filter((id) => items.has(id)).map((id) => [id, items.get(id)]);
  const signal = begin('hash');
  const prog = progressReporter(list.reduce((s, [, it]) => s + it.bytes, 0));
  const summary = { done: 0, failed: 0, cancelled: false };
  const p = getPool();
  const stop = () => p.cancel();
  signal.addEventListener('abort', stop);
  try {
    await Promise.all(list.map(async ([id, it]) => {
      try {
        send('run:item', { id, status: 'working' });
        const digests = await p.hash(it.path, algs, (n) => prog.add(n));
        it.digests = { ...(it.digests || {}), ...digests };
        summary.done++;
        send('run:item', { id, status: 'done', digests: it.digests });
      } catch (e) {
        if (e.cancelled) { summary.cancelled = true; send('run:item', { id, status: 'skipped' }); } else { summary.failed++; send('run:item', { id, status: 'error', error: cleanError(e) }); }
      }
    }));
    prog.finish();
  } finally { signal.removeEventListener('abort', stop); running = null; }
  return summary;
});
ipcMain.handle('hash:detect', (_e, text) => { need(typeof text === 'string' && text.length < 1000); return H.detect(text); });

ipcMain.handle('run:cancel', () => { if (running) running.abort.abort(); });

// ---- checksum files --------------------------------------------------------------------------------------------------------
ipcMain.handle('sums:verify', async (_e, given) => {
  let file = given;
  if (file == null) {
    const r = await dialog.showOpenDialog(win, { title: 'Choose a checksum file', properties: ['openFile'], filters: [{ name: 'Checksum files', extensions: ['sha256', 'sha512', 'sha1', 'md5', 'b2', 'txt', 'sums', '*'] }] });
    if (r.canceled || !r.filePaths[0]) return null;
    file = r.filePaths[0];
  }
  need(typeof file === 'string' && path.isAbsolute(file));
  const st = await fs.promises.stat(file).catch(() => null);
  if (!st || !st.isFile()) return { ok: false, error: 'The checksum file was not found.' };
  if (st.size > 20 * 1024 * 1024) return { ok: false, error: 'That file is too large to be a checksum list.' };
  const parsed = H.parseChecksums(await fs.promises.readFile(file, 'utf8'), file);
  if (!parsed.lines.length) return { ok: false, error: 'No checksums were found in that file. It should look like "<hash>  <file name>" (sha256sum) or "SHA256 (file name) = <hash>" (BSD).' };
  const base = path.dirname(file);
  const lines = parsed.lines.map((l, i) => {
    let name = l.name;
    if (name == null) name = path.basename(file).replace(/\.(sha256|sha512|sha1|md5|b2|sha256sum|sha512sum|md5sum|sha1sum)$/i, ''); // "x.iso.sha256" checks "x.iso"
    return { n: i, name, abs: path.resolve(base, name.replace(/^\*/, '')), hex: l.hex, algs: l.alg ? [l.alg] : l.algs };
  });
  const signal = begin('verify');
  const p = getPool();
  const stop = () => p.cancel();
  signal.addEventListener('abort', stop);
  const counts = { ok: 0, bad: 0, missing: 0, failed: 0 };
  let total = 0;
  for (const l of lines) { const s = await fs.promises.stat(l.abs).catch(() => null); l.bytes = s && s.isFile() ? s.size : -1; if (l.bytes > 0) total += l.bytes; }
  const prog = progressReporter(total);
  send('sums:start', { file, name: path.basename(file), lines: lines.map((l) => ({ n: l.n, name: l.name, expected: l.hex, alg: l.algs.map((a) => H.ALGS[a].label).join(' or ') })), unreadable: parsed.bad.length });
  try {
    await Promise.all(lines.map(async (l) => {
      if (l.bytes < 0) { counts.missing++; send('sums:row', { n: l.n, status: 'missing' }); return; }
      try {
        const d = await p.hash(l.abs, l.algs, (k) => prog.add(k));
        const hit = l.algs.find((a) => d[a] === l.hex);
        if (hit) { counts.ok++; send('sums:row', { n: l.n, status: 'ok', alg: H.ALGS[hit].label }); } else { counts.bad++; send('sums:row', { n: l.n, status: 'bad', actual: d[l.algs[0]] }); }
      } catch (e) {
        if (e.cancelled) { send('sums:row', { n: l.n, status: 'skipped' }); return; }
        counts.failed++; send('sums:row', { n: l.n, status: 'error', error: cleanError(e) });
      }
    }));
    prog.finish();
  } finally { signal.removeEventListener('abort', stop); running = null; }
  return { ok: true, name: path.basename(file), ...counts, total: lines.length, unreadable: parsed.bad.length, cancelled: signal.aborted };
});

ipcMain.handle('sums:save', async (_e, o) => {
  need(o && typeof o === 'object' && Array.isArray(o.ids) && H.ALGS[o.alg] && ['gnu', 'bsd'].includes(o.format));
  const list = o.ids.map((id) => items.get(id)).filter((it) => it && it.digests && it.digests[o.alg]);
  need(list.length, 'Compute the checksums first.');
  const roots = [...new Set(list.map((it) => it.root || path.dirname(it.path)))];
  const defDir = roots.length === 1 ? (list.length > 1 && list.every((it) => it.rel.includes('/')) ? path.join(roots[0], list[0].rel.split('/')[0]) : roots[0]) : path.dirname(list[0].path);
  const defName = list.length === 1 ? `${list[0].name}.${H.ALGS[o.alg].ext}` : H.ALGS[o.alg].sums;
  const r = await dialog.showSaveDialog(win, { title: 'Save checksum file', defaultPath: path.join(defDir, defName), properties: ['showOverwriteConfirmation'] });
  if (r.canceled || !r.filePath) return { ok: false, cancelled: true };
  const dir = path.dirname(r.filePath);
  const lines = list.map((it) => {
    const rel = path.relative(dir, it.path);
    return { name: (!rel.startsWith('..') && !path.isAbsolute(rel) ? rel : it.path).split(path.sep).join('/'), hex: it.digests[o.alg] };
  }).filter((l) => path.resolve(dir, l.name) !== path.resolve(r.filePath));
  const part = r.filePath + '.part';
  await fs.promises.writeFile(part, H.formatChecksums(lines, o.alg, o.format), { flag: 'w' });
  await fs.promises.rename(part, r.filePath);
  produced.add(r.filePath);
  return { ok: true, file: r.filePath, name: path.basename(r.filePath), count: lines.length };
});

// ---- start up ------------------------------------------------------------------------------------------------------------------
function cleanUp() { try { if (running) running.abort.abort(); if (pool) pool.close(); } catch { /* ignore */ } }
const pathsFromArgs = (argv) => argv.slice(app.isPackaged ? 1 : 2).filter((a) => a && !a.startsWith('-') && path.isAbsolute(a));

const gotLock = SELFTEST || E2E ? true : app.requestSingleInstanceLock();
if (SELFTEST) {
  app.whenReady().then(async () => {
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
    cleanUp();
    app.exit(code);
  });
} else if (!gotLock) app.quit();
else {
  app.on('second-instance', (_e, argv) => {
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
    const paths = pathsFromArgs(argv);
    if (paths.length) send('files:opened', paths);
  });
  app.whenReady().then(() => {
    createWindow();
    if (E2E) {
      win.webContents.once('did-finish-load', () => {
        const arg = (name) => (process.argv.find((a) => a.startsWith(name + '=')) || '').slice(name.length + 1);
        const ctx = { app, getWin: () => win, outFile: arg('--e2e-out'), shotsDir: arg('--shots'), outDir: arg('--readme-shots'), dialog, internals, shell };
        if (ctx.outDir) require('../test/readme-shots').run(ctx); else require('../test/e2e').run(ctx);
      });
      return;
    }
    const startup = pathsFromArgs(process.argv);
    if (startup.length) win.webContents.once('did-finish-load', () => send('files:opened', startup));
  });
  app.on('window-all-closed', () => { cleanUp(); app.quit(); });
}
