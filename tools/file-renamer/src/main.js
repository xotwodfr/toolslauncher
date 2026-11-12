'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron');
const fs = require('original-fs');
const path = require('path');
const B = require('./core/batch');
const G = require('./core/engine');
const S = require('./core/store');
const R = require('./core/rules');

const E2E = process.argv.includes('--e2e');
const SELFTEST = process.argv.find((a) => a.startsWith('--self-test='));
if (E2E || SELFTEST) app.setPath('userData', path.join(app.getPath('temp'), `file-renamer-test-${process.pid}`));

let win = null;
const list = new B.FileList();
let history = null;
let presets = null;
let busy = false;
let previewSeq = 0;
const produced = new Set(); // files this app renamed: the only ones "Show in folder" reveals

const send = (channel, payload) => { if (win && !win.isDestroyed()) win.webContents.send(channel, payload); };
const cleanError = (e) => String((e && e.message) || e);
const stores = () => {
  if (!history) history = new S.History(path.join(app.getPath('userData'), 'history'));
  if (!presets) presets = new S.Presets(path.join(app.getPath('userData'), 'presets.json'));
  return { history, presets };
};

function createWindow() {
  win = new BrowserWindow({
    width: 1280, height: 820, minWidth: 980, minHeight: 600,
    backgroundColor: '#0b0b0d', title: 'Batch File Renamer', autoHideMenuBar: true, show: !SELFTEST,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false },
  });
  Menu.setApplicationMenu(null);
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'), (E2E || SELFTEST) ? { hash: 'e2e' } : undefined);
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.on('closed', () => { win = null; });
}

// ---- the list ---------------------------------------------------------------------------------------------------------------
const addOpts = (o) => ({ recursive: !!(o && o.recursive), folders: o && o.folders === 'self' ? 'self' : 'contents' });
const rowOf = (i) => ({ id: i.id, name: i.name, dir: i.dir, isDir: i.isDir, size: i.size, mtimeMs: i.mtimeMs });
async function addPaths(paths, opts) {
  if (busy) throw new Error('Please wait until the renaming is finished');
  const clean = (Array.isArray(paths) ? paths : []).filter((p) => typeof p === 'string' && p.length < 32768 && path.isAbsolute(p)).slice(0, 10000);
  const r = await list.add(clean, addOpts(opts));
  return { added: r.added.length, skipped: r.skipped, capped: r.capped, total: list.items.length };
}
ipcMain.handle('files:pick', async (_e, opts) => {
  const r = await dialog.showOpenDialog(win, { title: 'Add files to rename', properties: ['openFile', 'multiSelections'] });
  return r.canceled ? { added: 0, total: list.items.length } : addPaths(r.filePaths, opts);
});
ipcMain.handle('files:pick-folder', async (_e, opts) => {
  const r = await dialog.showOpenDialog(win, { title: opts && opts.folders === 'self' ? 'Add folders to rename' : 'Add the files in a folder', properties: ['openDirectory', 'multiSelections'] });
  return r.canceled ? { added: 0, total: list.items.length } : addPaths(r.filePaths, opts);
});
ipcMain.handle('files:add', (_e, paths, opts) => addPaths(paths, opts));
ipcMain.handle('files:remove', (_e, ids) => { if (!busy && Array.isArray(ids)) list.remove(ids.filter((n) => Number.isInteger(n))); return list.items.length; });
ipcMain.handle('files:clear', () => { if (!busy) list.clear(); });

// ---- preview ------------------------------------------------------------------------------------------------------------------
const viewOpts = (o) => ({ sort: ['name', 'added', 'modified', 'size'].includes(o && o.sort) ? o.sort : 'name', reverse: !!(o && o.reverse), autoSuffix: !!(o && o.autoSuffix), strict: process.platform === 'win32' || !(o && o.windowsSafe === false) });
async function computePreview(rules, o) {
  const opts = viewOpts(o);
  const ordered = list.sorted(opts.sort, opts.reverse);
  const p = await B.preview(ordered, rules, { strict: opts.strict, autoSuffix: opts.autoSuffix });
  return { ordered, ...p };
}
ipcMain.handle('preview', async (_e, rules, o) => {
  const seq = ++previewSeq;
  const p = await computePreview(rules, o);
  if (seq !== previewSeq) return { stale: true };
  const byId = new Map(p.ordered.map((i) => [i.id, i]));
  return {
    summary: p.summary,
    rows: p.rows.map((r) => ({ ...rowOf(byId.get(r.id)), newName: r.newName, status: r.status, errors: r.errors, warnings: r.warnings, caseOnly: r.caseOnly, swap: r.swap })),
  };
});

// ---- renaming -------------------------------------------------------------------------------------------------------------------
ipcMain.handle('rename:run', async (_e, rules, o) => {
  if (busy) throw new Error('A rename is already running');
  busy = true;
  try {
    // the names are worked out again here, from the files as they are now: the window only says which rules
    const p = await computePreview(rules, o);
    if (p.summary.errors) return { ok: false, problems: p.summary.errors };
    const todo = p.rows.filter((r) => r.status === 'ok');
    if (!todo.length) return { ok: false, nothing: true };
    const journal = G.planBatch(todo.map((r) => ({ from: r.from, to: r.to })), { label: `${todo.length} file${todo.length === 1 ? '' : 's'}` });
    const { history: h } = stores();
    await G.runBatch(journal, { save: (j) => h.save(j), onProgress: (pr) => send('rename:progress', pr) });
    list.moved(todo.map((r) => ({ id: r.id, to: r.to })));
    for (const r of todo) produced.add(r.to);
    return { ok: true, done: todo.length, batch: journal.id, first: todo[0].to };
  } catch (e) {
    return { ok: false, error: cleanError(e) };
  } finally { busy = false; }
});

// ---- history and undo ---------------------------------------------------------------------------------------------------------
ipcMain.handle('history:list', () => stores().history.list().map(S.describe));
ipcMain.handle('history:undo', async (_e, id, partial) => {
  if (busy) throw new Error('Please wait until the renaming is finished');
  if (typeof id !== 'string') throw new Error('No batch');
  busy = true;
  try {
    const { history: h } = stores();
    const j = h.get(id);
    const r = await G.undoBatch(j, { partial: !!partial, save: (x) => h.save(x) });
    // files in the list follow their names back
    const back = new Map(j.groups.flat().filter((op) => op.undone).map((op) => [op.to, op.from]));
    list.moved(list.items.filter((i) => back.has(i.path)).map((i) => ({ id: i.id, to: back.get(i.path) })));
    for (const to of back.values()) produced.add(to);
    return { ok: true, ...r };
  } catch (e) {
    return { ok: false, error: cleanError(e), problems: e.problems || null, okCount: e.okCount || 0 };
  } finally { busy = false; }
});
ipcMain.handle('history:interrupted', () => stores().history.interrupted().map(S.describe));
ipcMain.handle('history:recover', async (_e, id) => {
  if (busy || typeof id !== 'string') throw new Error('Busy');
  const { history: h } = stores();
  const j = h.get(id);
  if (j.state !== 'running') return { ok: true, restored: 0, lost: [] };
  const r = await G.recoverInterrupted(j, { save: (x) => h.save(x) });
  list.refresh();
  return { ok: true, ...r };
});

// ---- presets ----------------------------------------------------------------------------------------------------------------------
ipcMain.handle('presets:list', () => stores().presets.all());
ipcMain.handle('presets:save', (_e, name, rules) => stores().presets.save(name, rules));
ipcMain.handle('presets:remove', (_e, name) => stores().presets.remove(String(name)));
ipcMain.handle('rules:defaults', () => R.DEFAULTS);
ipcMain.handle('shell:show', (_e, p) => { if (typeof p === 'string' && produced.has(p)) shell.showItemInFolder(p); });

// ---- start up ------------------------------------------------------------------------------------------------------------------
const pathsFromArgs = (argv) => argv.slice(app.isPackaged ? 1 : 2).filter((a) => a && !a.startsWith('-') && path.isAbsolute(a));
async function openAndSend(paths) { try { const r = await addPaths(paths, {}); send('files:opened', r); } catch { /* ignore */ } }

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
        const ctx = { app, getWin: () => win, outFile: arg('--e2e-out'), shotsDir: arg('--shots'), outDir: arg('--readme-shots'), dialog, userData: app.getPath('userData') };
        if (ctx.outDir) require('../test/readme-shots').run(ctx); else require('../test/e2e').run(ctx);
      });
      return;
    }
    const startup = pathsFromArgs(process.argv);
    if (startup.length) win.webContents.once('did-finish-load', () => openAndSend(startup));
  });
  app.on('window-all-closed', () => app.quit());
}
