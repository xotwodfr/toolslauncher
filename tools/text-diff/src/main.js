'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron');
const fs = require('original-fs');
const path = require('path');
const F = require('./core/files');
const D = require('./core/folders');
const E = require('./core/encoding');

const E2E = process.argv.includes('--e2e');
const SELFTEST = process.argv.find((a) => a.startsWith('--self-test='));
if (E2E || SELFTEST) app.setPath('userData', path.join(app.getPath('temp'), `text-diff-test-${process.pid}`));

const MAX_SAVE = 512 * 1024 * 1024;
const SIDES = ['left', 'right'];

let win = null;
const loaded = { left: null, right: null }; // the files shown on each side: the only files "overwrite" may touch
const produced = new Set();                  // files this app wrote: the only ones "Show in folder" reveals
let folderResult = null;                     // the last folder comparison: copying only works on its entries
let folderAbort = null;
let copying = false;
// Moving to the Recycle Bin. Tests swap this for a function that moves files into a test folder.
const hooks = { trash: (p) => shell.trashItem(p) };

const send = (channel, payload) => { if (win && !win.isDestroyed()) win.webContents.send(channel, payload); };
const isSide = (s) => SIDES.includes(s);
const str = (v, max = 32768) => typeof v === 'string' && v.length > 0 && v.length <= max;

function createWindow() {
  win = new BrowserWindow({
    width: 1280, height: 820, minWidth: 900, minHeight: 560,
    backgroundColor: '#0b0b0d', title: 'Text & File Diff', autoHideMenuBar: true, show: !SELFTEST,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false },
  });
  Menu.setApplicationMenu(null);
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'), (E2E || SELFTEST) ? { hash: 'e2e' } : undefined);
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.on('closed', () => { win = null; });
}

// ---- opening files ------------------------------------------------------------------------------------------------------
async function loadSide(side, file) {
  if (!isSide(side)) throw new Error('Unknown side');
  if (!str(file) || !path.isAbsolute(file)) throw new Error('Not a file path');
  let info;
  try { info = await F.loadForDiff(file); } catch (e) { throw new Error(F.friendly(e, file)); }
  loaded[side] = { path: info.path, size: info.size, mtimeMs: info.mtimeMs, encoding: info.encoding, bom: info.bom };
  return { side, ...info, encodingLabel: E.LABELS[info.encoding] || info.encoding };
}

ipcMain.handle('file:pick', async (_e, side) => {
  if (!isSide(side)) throw new Error('Unknown side');
  const r = await dialog.showOpenDialog(win, { title: side === 'left' ? 'Open the left file' : 'Open the right file', properties: ['openFile'] });
  if (r.canceled || !r.filePaths.length) return null;
  return loadSide(side, r.filePaths[0]);
});
ipcMain.handle('file:load', (_e, side, file) => loadSide(side, file));
ipcMain.handle('file:forget', (_e, side) => { if (isSide(side)) loaded[side] = null; });
ipcMain.handle('file:reload', async (_e, side) => {
  if (!isSide(side) || !loaded[side]) throw new Error('No file on that side');
  return loadSide(side, loaded[side].path);
});

// ---- saving the merged text ------------------------------------------------------------------------------------------------
ipcMain.handle('merge:save', async (_e, args) => {
  const { text, target } = args || {};
  if (typeof text !== 'string' || text.length > MAX_SAVE) throw new Error('Nothing to save');
  if (!['new', 'left', 'right'].includes(target)) throw new Error('Unknown target');
  if (target === 'new') {
    const like = loaded.left || loaded.right;
    const enc = args.encoding && E.ENCODINGS.includes(args.encoding) ? args.encoding : (like && like.encoding !== 'binary' ? like.encoding : 'utf-8');
    const bom = like ? like.bom !== false : true;
    let def = 'merged.txt';
    if (like) { const ext = path.extname(like.path); def = path.join(path.dirname(like.path), path.basename(like.path, ext) + ' (merged)' + ext); }
    const pick = await dialog.showSaveDialog(win, { title: 'Save the merged text', defaultPath: def });
    if (pick.canceled || !pick.filePath) return { ok: false, cancelled: true };
    const out = pick.filePath;
    try {
      // the system dialog already asked about replacing; keep the old file as .bak all the same
      if (fs.existsSync(out)) { const st = fs.statSync(out); await F.overwriteWithBackup(out, E.encode(text, enc, bom), { size: st.size, mtimeMs: st.mtimeMs }); }
      else await F.writeAtomic(out, E.encode(text, enc, bom));
    } catch (e) { throw new Error(F.friendly(e, out)); }
    produced.add(out);
    return { ok: true, path: out, encoding: enc };
  }
  const rec = loaded[target];
  if (!rec) throw new Error(`There is no file on the ${target} to overwrite (pasted text cannot be overwritten). Use "Save as…" instead.`);
  if (rec.encoding === 'binary') throw new Error('That side is not a text file');
  const name = path.basename(rec.path);
  const ok = await dialog.showMessageBox(win, {
    type: 'warning', buttons: [`Overwrite ${name}`, 'Cancel'], defaultId: 1, cancelId: 1, noLink: true,
    title: 'Overwrite the file?', message: `Overwrite "${name}" with the merged text?`,
    detail: `The current file is kept next to it as a backup ("${name}.bak").`,
  });
  if (ok.response !== 0) return { ok: false, cancelled: true };
  let r;
  try { r = await F.overwriteWithBackup(rec.path, E.encode(text, rec.encoding, rec.bom), rec); } catch (e) { throw new Error(F.friendly(e, rec.path)); }
  const st = fs.statSync(rec.path);
  loaded[target] = { ...rec, size: st.size, mtimeMs: st.mtimeMs };
  produced.add(rec.path); produced.add(r.backup);
  return { ok: true, path: rec.path, backup: r.backup };
});

// ---- exports ---------------------------------------------------------------------------------------------------------------
ipcMain.handle('export:save', async (_e, args) => {
  const { kind, text } = args || {};
  if (!['patch', 'html'].includes(kind) || typeof text !== 'string' || !text || text.length > MAX_SAVE) throw new Error('Nothing to export');
  const base = (args.name && typeof args.name === 'string' ? args.name : 'changes').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').slice(0, 120) || 'changes';
  const near = loaded.left ? path.dirname(loaded.left.path) : app.getPath('documents');
  const pick = await dialog.showSaveDialog(win, {
    title: kind === 'patch' ? 'Save the changes as a patch' : 'Save the HTML report',
    defaultPath: path.join(near, base + (kind === 'patch' ? '.patch' : '.html')),
    filters: kind === 'patch' ? [{ name: 'Patch', extensions: ['patch', 'diff'] }] : [{ name: 'Web page', extensions: ['html'] }],
  });
  if (pick.canceled || !pick.filePath) return { ok: false, cancelled: true };
  let out = pick.filePath;
  if (kind === 'html' && !/\.html?$/i.test(out)) out += '.html';
  if (kind === 'patch' && !/\.(patch|diff)$/i.test(out)) out += '.patch';
  try {
    if (fs.existsSync(out)) { const st = fs.statSync(out); await F.overwriteWithBackup(out, Buffer.from(text, 'utf8'), { size: st.size, mtimeMs: st.mtimeMs }); }
    else await F.writeAtomic(out, Buffer.from(text, 'utf8'));
  } catch (e) { throw new Error(F.friendly(e, out)); }
  produced.add(out);
  return { ok: true, path: out };
});
ipcMain.handle('shell:show', (_e, p) => { if (typeof p === 'string' && produced.has(p)) shell.showItemInFolder(p); });

// ---- folders ----------------------------------------------------------------------------------------------------------------
ipcMain.handle('folder:pick', async (_e, side) => {
  const r = await dialog.showOpenDialog(win, { title: side === 'right' ? 'Choose the right folder' : 'Choose the left folder', properties: ['openDirectory'] });
  return r.canceled || !r.filePaths.length ? null : r.filePaths[0];
});
ipcMain.handle('folder:check', async (_e, p) => {
  if (!str(p) || !path.isAbsolute(p)) return { ok: false };
  try { return { ok: (await fs.promises.stat(p)).isDirectory() }; } catch { return { ok: false }; }
});
ipcMain.handle('folder:compare', async (_e, args) => {
  const { left, right, mode, ignore } = args || {};
  if (!str(left) || !str(right) || !path.isAbsolute(left) || !path.isAbsolute(right)) throw new Error('Choose two folders first');
  for (const p of [left, right]) {
    let st; try { st = await fs.promises.stat(p); } catch (e) { throw new Error(F.friendly(e, p)); }
    if (!st.isDirectory()) throw new Error(`"${path.basename(p)}" is not a folder`);
  }
  if (path.resolve(left) === path.resolve(right)) throw new Error('Both sides are the same folder');
  if (folderAbort) folderAbort.abort();
  const ctl = new AbortController(); folderAbort = ctl;
  const patterns = Array.isArray(ignore) ? ignore.filter((s) => typeof s === 'string').slice(0, 200) : D.DEFAULT_IGNORE;
  try {
    const r = await D.compareFolders(path.resolve(left), path.resolve(right), { mode, ignore: patterns, signal: ctl.signal, onProgress: (p) => send('folder:progress', p) });
    folderResult = r;
    return r;
  } catch (e) {
    if (e && e.cancelled) return { cancelled: true };
    throw e;
  } finally { if (folderAbort === ctl) folderAbort = null; }
});
ipcMain.handle('folder:cancel', () => { if (folderAbort) folderAbort.abort(); });
ipcMain.handle('folder:copy', async (_e, args) => {
  const { rels, dir } = args || {};
  if (!folderResult) throw new Error('Compare two folders first');
  if (copying) throw new Error('A copy is already running');
  if (!['ltr', 'rtl'].includes(dir) || !Array.isArray(rels) || !rels.length || rels.length > 500000 || !rels.every((r) => typeof r === 'string')) throw new Error('Nothing selected');
  const plan = D.planCopy(folderResult, rels, dir);
  if (!plan.items.length && !plan.dirs.length) return { ok: false, nothing: true };
  const to = dir === 'ltr' ? 'right' : 'left';
  const n = plan.items.length;
  const ok = await dialog.showMessageBox(win, {
    type: plan.replacing ? 'warning' : 'question', buttons: ['Copy', 'Cancel'], defaultId: 0, cancelId: 1, noLink: true,
    title: 'Copy files?',
    message: `Copy ${n} file${n === 1 ? '' : 's'} to the ${to}?`,
    detail: (plan.replacing ? `${plan.replacing} file${plan.replacing === 1 ? '' : 's'} on the ${to} will be replaced. The old version${plan.replacing === 1 ? ' goes' : 's go'} to the Recycle Bin, so you can get ${plan.replacing === 1 ? 'it' : 'them'} back.\n` : 'No file is replaced.\n') + 'Nothing is deleted.',
  });
  if (ok.response !== 0) return { ok: false, cancelled: true };
  copying = true;
  try {
    const res = await D.runCopy(plan, { trash: (p) => hooks.trash(p), onProgress: (p) => send('folder:copy-progress', p) });
    return { ok: true, ...res };
  } finally { copying = false; }
});
ipcMain.handle('folder:open-pair', async (_e, rel) => {
  if (!folderResult || typeof rel !== 'string') throw new Error('Compare two folders first');
  const e = folderResult.entries.find((x) => x.rel === rel);
  if (!e || e.type !== 'file') throw new Error('Not a file in the comparison');
  const out = {};
  if (e.left) out.left = await loadSide('left', D.inside(folderResult.left, e.lrel));
  if (e.right) out.right = await loadSide('right', D.inside(folderResult.right, e.rrel));
  return out;
});

// ---- start up ------------------------------------------------------------------------------------------------------------------
const pathsFromArgs = (argv) => argv.slice(app.isPackaged ? 1 : 2).filter((a) => a && !a.startsWith('-') && path.isAbsolute(a));
async function openArgs(paths) {
  const files = paths.slice(0, 2);
  const out = {};
  for (let i = 0; i < files.length; i++) {
    try {
      const st = fs.statSync(files[i]);
      if (st.isDirectory()) { out.folders = out.folders || []; out.folders.push(files[i]); continue; }
      out[SIDES[i]] = await loadSide(SIDES[i], files[i]);
    } catch (e) { out.error = String((e && e.message) || e); }
  }
  send('files:opened', out);
}

const gotLock = SELFTEST || E2E ? true : app.requestSingleInstanceLock();
if (SELFTEST) {
  app.whenReady().then(async () => {
    createWindow();
    const outFile = SELFTEST.slice('--self-test='.length);
    let code = 1;
    try {
      const results = await require('./selftest').run({ getWin: () => win, hooks });
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
    const paths = pathsFromArgs(argv);
    if (paths.length) openArgs(paths);
  });
  app.whenReady().then(() => {
    createWindow();
    if (E2E) {
      win.webContents.once('did-finish-load', () => {
        const arg = (name) => (process.argv.find((a) => a.startsWith(name + '=')) || '').slice(name.length + 1);
        const ctx = { app, getWin: () => win, outFile: arg('--e2e-out'), shotsDir: arg('--shots'), outDir: arg('--readme-shots'), dialog, hooks };
        if (ctx.outDir) require('../test/readme-shots').run(ctx); else require('../test/e2e').run(ctx);
      });
      return;
    }
    const startup = pathsFromArgs(process.argv);
    if (startup.length) win.webContents.once('did-finish-load', () => openArgs(startup));
  });
  app.on('window-all-closed', () => app.quit());
}
