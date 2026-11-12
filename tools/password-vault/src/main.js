'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, Menu, clipboard, powerMonitor } = require('electron');
const fs = require('fs');
const path = require('path');
const F = require('./vaultfile');
const V = require('./vault');
const G = require('./generator');
const C = require('./csv');
const Strength = require('./strength');
const { Session } = require('./session');

const E2E = process.argv.includes('--e2e');
const SELFTEST = process.argv.find((a) => a.startsWith('--self-test='));
if (E2E || SELFTEST) app.setPath('userData', path.join(app.getPath('temp'), `password-vault-test-${process.pid}`));

const EXT = 'pwvault';
let win = null;
const session = new Session();
let busy = false;              // one slow operation (key derivation, save) at a time
let lastActivity = Date.now();
let clip = null;               // { value, timer, at } what WE put on the clipboard
let pendingImport = null;      // parsed CSV waiting for the user's OK
const produced = new Set();    // files this app wrote: the only ones "Show in folder" may reveal

const send = (channel, payload) => { if (win && !win.isDestroyed()) win.webContents.send(channel, payload); };
const cleanError = (e) => String((e && e.message) || e);
const need = (ok, msg = 'Invalid request') => { if (!ok) throw new Error(msg); };
const isId = (v) => typeof v === 'string' && /^[0-9a-f-]{36}$/.test(v);

// ---- remembered vault (the path only; never anything secret) ------------------------------------------------------------
const configFile = () => path.join(app.getPath('userData'), 'config.json');
function readConfig() { try { const c = JSON.parse(fs.readFileSync(configFile(), 'utf8')); return c && typeof c === 'object' ? c : {}; } catch { return {}; } }
function writeConfig(c) {
  try { fs.mkdirSync(path.dirname(configFile()), { recursive: true }); fs.writeFileSync(configFile() + '.part', JSON.stringify(c)); fs.renameSync(configFile() + '.part', configFile()); } catch { /* a convenience only */ }
}
function remember(file) {
  const c = readConfig();
  c.last = file;
  c.recent = [file, ...(Array.isArray(c.recent) ? c.recent : []).filter((f) => f !== file)].slice(0, 6);
  writeConfig(c);
}

function describe(file) {
  if (!file) return null;
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(8192); const n = fs.readSync(fd, buf, 0, buf.length, 0); fs.closeSync(fd);
    // parse() wants the whole file for the length checks; for the lock screen we only need the header
    const head = buf.subarray(0, n);
    const hlen = head.length >= 14 ? head.readUInt32BE(10) : 0;
    const p = F.parse(Buffer.concat([head.subarray(0, Math.min(n, 14 + hlen)), Buffer.alloc(16)]));
    return { file, name: path.basename(file), folder: path.dirname(file), keyFile: p.keyFile };
  } catch (e) { return { file, name: path.basename(file), folder: path.dirname(file), problem: e.code === 'ENOENT' ? 'The vault file is not there any more. It may have been moved or renamed.' : cleanError(e) }; }
}

function state() {
  if (session.unlocked) return { state: 'unlocked', vault: { file: session.file, name: path.basename(session.file), keyFile: session.meta.keyFile }, settings: session.data.settings, kdf: session.meta.kdf };
  const file = session.file || readConfig().last;
  const v = file ? describe(file) : null;
  return { state: v ? 'locked' : 'start', vault: v };
}

// ---- locking -------------------------------------------------------------------------------------------------------------
function clearClipboard(force) {
  if (!clip) return;
  clearTimeout(clip.timer);
  try { if (force !== false && clipboard.readText() === clip.value) clipboard.clear(); } catch { /* ignore */ }
  clip = null;
  send('clipboard:cleared', {});
}

function lock(reason) {
  if (!session.unlocked) return;
  pendingImport = null;
  clearClipboard();
  session.lock();
  send('vault:locked', { reason, ...state() });
}

setInterval(() => {
  if (!session.unlocked) return;
  const mins = session.data.settings.autoLockMinutes;
  if (mins > 0 && Date.now() - lastActivity > mins * 60000) lock('idle');
}, 5000).unref();

function hookPower() {
  for (const ev of ['lock-screen', 'suspend']) powerMonitor.on(ev, () => lock(ev === 'suspend' ? 'sleep' : 'screen'));
}

async function copy(value, label) {
  need(typeof value === 'string' && value.length, 'There is nothing to copy');
  if (clip) clearTimeout(clip.timer);
  clipboard.writeText(value);
  const seconds = session.unlocked ? session.data.settings.clipboardSeconds : 30;
  clip = { value, timer: setTimeout(() => clearClipboard(), seconds * 1000), at: Date.now() };
  return { label, seconds };
}

// ---- saving ----------------------------------------------------------------------------------------------------------------
async function save() {
  const r = await session.save();
  if (r.conflict) send('vault:conflict', { file: r.conflict, name: path.basename(r.conflict) });
  return r;
}
async function change(fn) {
  need(session.unlocked, 'The vault is locked.');
  const result = fn(session.data);
  await save();
  return result === undefined ? true : result;
}
async function slow(fn) {
  if (busy) throw new Error('Please wait, the vault is still busy.');
  busy = true;
  try { return await fn(); } finally { busy = false; }
}

function createWindow() {
  win = new BrowserWindow({
    width: 1240, height: 800, minWidth: 900, minHeight: 580,
    backgroundColor: '#0b0b0d', title: 'Password Vault', autoHideMenuBar: true, show: !SELFTEST,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false, backgroundThrottling: false },
  });
  Menu.setApplicationMenu(null);
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'), (E2E || SELFTEST) ? { hash: 'e2e' } : undefined);
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.on('minimize', () => { if (session.unlocked && session.data.settings.lockOnMinimize) lock('minimized'); });
  win.on('closed', () => { win = null; });
}

// every request from the window counts as activity for the auto-lock
const handle = (channel, fn) => ipcMain.handle(channel, async (_e, ...args) => { lastActivity = Date.now(); return fn(...args); });

// ---- vault open / create / lock -------------------------------------------------------------------------------------------
handle('state', () => state());
handle('activity', () => true);

handle('vault:pick', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Open a vault', properties: ['openFile'], filters: [{ name: 'Password vault', extensions: [EXT, 'bak'] }, { name: 'All files', extensions: ['*'] }] });
  if (r.canceled || !r.filePaths[0]) return null;
  return choose(r.filePaths[0]);
});
handle('vault:choose', (file) => { need(typeof file === 'string' && path.isAbsolute(file)); return choose(file); });
function choose(file) {
  const v = describe(file);
  if (v.problem) return { ok: false, error: v.problem };
  lock('switch');
  session.close(); session.file = file;
  remember(file);
  return { ok: true, ...state() };
}

handle('keyfile:pick', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Choose the key file', properties: ['openFile'] });
  return r.canceled || !r.filePaths[0] ? null : { file: r.filePaths[0], name: path.basename(r.filePaths[0]) };
});
handle('keyfile:create', async () => {
  const r = await dialog.showSaveDialog(win, { title: 'Save a new key file', defaultPath: 'Vault key.key', properties: ['showOverwriteConfirmation'] });
  if (r.canceled || !r.filePath) return null;
  if (fs.existsSync(r.filePath)) return { ok: false, error: 'A file with that name already exists. A key file is never written over another file.' };
  await F.createKeyFile(r.filePath);
  produced.add(r.filePath);
  return { ok: true, file: r.filePath, name: path.basename(r.filePath) };
});

const keyHash = async (file) => (file ? F.hashKeyFile(String(file)) : null);
const checkPassword = (pw) => need(typeof pw === 'string' && pw.length > 0 && pw.length <= 1024, 'Type the master password.');

handle('vault:create', (opts) => slow(async () => {
  need(opts && typeof opts === 'object');
  checkPassword(opts.password);
  need(opts.password.length >= 8, 'The master password must have at least 8 characters.');
  need(opts.keyFile == null || typeof opts.keyFile === 'string');
  const r = await dialog.showSaveDialog(win, { title: 'Where should the new vault be saved?', defaultPath: path.join(app.getPath('documents'), 'Passwords.' + EXT), filters: [{ name: 'Password vault', extensions: [EXT] }] });
  if (r.canceled || !r.filePath) return { ok: false, cancelled: true };
  let file = r.filePath;
  if (path.extname(file).toLowerCase() !== '.' + EXT) file += '.' + EXT;
  try {
    lock('switch');
    await session.create(file, opts.password, await keyHash(opts.keyFile), undefined);
    produced.add(file);
    remember(file);
    lastActivity = Date.now();
    return { ok: true, ...state() };
  } catch (e) { return { ok: false, error: cleanError(e) }; }
}));

handle('vault:unlock', (opts) => slow(async () => {
  need(opts && typeof opts === 'object');
  checkPassword(opts.password);
  need(opts.keyFile == null || typeof opts.keyFile === 'string');
  const file = session.file || readConfig().last;
  need(file, 'Choose a vault first.');
  try {
    await session.unlock(file, opts.password, await keyHash(opts.keyFile));
    remember(file);
    lastActivity = Date.now();
    return { ok: true, ...state() };
  } catch (e) { return { ok: false, code: e.code, error: cleanError(e) }; }
}));

handle('vault:lock', () => { lock('button'); return state(); });
handle('vault:forget', () => { lock('switch'); session.close(); session.file = null; const c = readConfig(); delete c.last; writeConfig(c); return state(); });

handle('vault:change-master', (opts) => slow(async () => {
  need(session.unlocked && opts && typeof opts === 'object');
  checkPassword(opts.current); checkPassword(opts.next);
  need(opts.next.length >= 8, 'The new master password must have at least 8 characters.');
  try {
    const cur = await keyHash(session.meta.keyFile ? opts.currentKeyFile : null);
    if (session.meta.keyFile && !cur) return { ok: false, error: 'Choose the current key file.' };
    await session.changeMaster(opts.current, cur, opts.next, await keyHash(opts.nextKeyFile), await F.calibrate());
    return { ok: true, ...state() };
  } catch (e) { return { ok: false, error: cleanError(e) }; }
}));

handle('vault:reveal', () => { need(session.file); shell.showItemInFolder(session.file); });

// ---- entries -------------------------------------------------------------------------------------------------------------
handle('entries:list', (q) => {
  need(session.unlocked, 'The vault is locked.');
  q = q && typeof q === 'object' ? q : {};
  const pick = (v, ok, d) => (ok.includes(v) ? v : d);
  return V.listView(session.data, {
    view: pick(q.view, ['all', 'favorites', 'trash', 'folder', 'tag'], 'all'), sort: pick(q.sort, ['title', 'modified', 'created'], 'title'),
    folder: typeof q.folder === 'string' ? q.folder : '', tag: typeof q.tag === 'string' ? q.tag : '', query: typeof q.query === 'string' ? q.query.slice(0, 200) : '',
  });
});
handle('entry:get', (id) => { need(session.unlocked && isId(id)); return V.detailView(session.data, id); });
handle('entry:save', (input) => { need(input && typeof input === 'object' && (input.id == null || isId(input.id))); return change((d) => V.saveEntry(d, input).id); });
handle('entry:favorite', (id, on) => { need(isId(id) && typeof on === 'boolean'); return change((d) => V.setFavorite(d, id, on)); });
handle('entry:trash', (id) => { need(isId(id)); return change((d) => V.trash(d, id)); });
handle('entry:restore', (id) => { need(isId(id)); return change((d) => V.restore(d, id)); });
handle('entry:purge', (id) => { need(isId(id)); return change((d) => V.purge(d, id)); });
handle('trash:empty', () => change((d) => V.emptyTrash(d)));
handle('folder:add', (name) => { need(typeof name === 'string'); return change((d) => V.addFolder(d, name)); });
handle('settings:set', (s) => { need(s && typeof s === 'object'); return change((d) => V.settings(d, s)); });

const WHAT = ['password', 'username', 'url', 'field', 'history', 'totp'];
const secretOf = (id, what, index) => {
  need(session.unlocked && isId(id) && WHAT.includes(what) && Number.isInteger(index || 0) && (index || 0) >= 0);
  return V.secret(session.data, id, what, index || 0);
};
handle('secret:reveal', (id, what, index) => secretOf(id, what, index));
handle('secret:copy', (id, what, index) => copy(secretOf(id, what, index), what));
// not `handle`: the window asks every second while a code is shown, which must not count as activity
ipcMain.handle('totp:now', (_e, id) => { need(session.unlocked && isId(id)); return V.totpNow(session.data, id); });
handle('clipboard:copy-text', (text) => { need(typeof text === 'string' && text.length <= 10000); return copy(text, 'text'); }); // generator results

// ---- generator, strength ---------------------------------------------------------------------------------------------------
handle('gen:password', (o) => G.password(o && typeof o === 'object' ? o : {}));
handle('gen:passphrase', (o) => G.passphrase(o && typeof o === 'object' ? o : {}));
handle('strength', (pw, inputs) => { need(typeof pw === 'string' && pw.length <= 10000); return Strength.check(pw, Array.isArray(inputs) ? inputs.filter((s) => typeof s === 'string').slice(0, 10) : []); });

// ---- import / export -----------------------------------------------------------------------------------------------------
handle('import:pick', async () => {
  need(session.unlocked, 'The vault is locked.');
  const r = await dialog.showOpenDialog(win, { title: 'Import a CSV export', properties: ['openFile'], filters: [{ name: 'CSV', extensions: ['csv'] }] });
  if (r.canceled || !r.filePaths[0]) return null;
  try {
    const st = await fs.promises.stat(r.filePaths[0]);
    if (st.size > 50 * 1024 * 1024) throw new Error('That file is too large for a password export.');
    const parsed = C.importCsv(await fs.promises.readFile(r.filePaths[0], 'utf8'));
    pendingImport = parsed;
    return { ok: true, file: path.basename(r.filePaths[0]), formatName: parsed.formatName, count: parsed.entries.length, skipped: parsed.skipped, sample: parsed.entries.slice(0, 5).map((e) => ({ title: e.title, username: e.username, folder: e.folder })) };
  } catch (e) { return { ok: false, error: cleanError(e) }; }
});
handle('import:commit', () => {
  need(pendingImport, 'Choose a file to import first.');
  const p = pendingImport; pendingImport = null;
  const folder = `Imported from ${p.formatName.split(' ')[0]} ${new Date().toISOString().slice(0, 10)}`;
  return change((d) => ({ ...V.addImported(d, p.entries, folder), folder }));
});
handle('import:cancel', () => { pendingImport = null; });

const notTheVault = (file) => {
  const f = path.resolve(file); const v = path.resolve(session.file);
  need(f !== v && f !== v + '.bak' && f !== v + '.part', 'Choose another file: that is the vault itself.');
};
handle('export:csv', async () => {
  need(session.unlocked, 'The vault is locked.');
  const r = await dialog.showSaveDialog(win, { title: 'Export UNENCRYPTED CSV', defaultPath: 'passwords-UNENCRYPTED.csv', filters: [{ name: 'CSV', extensions: ['csv'] }], properties: ['showOverwriteConfirmation'] });
  if (r.canceled || !r.filePath) return { ok: false, cancelled: true };
  let out = r.filePath; if (!/\.csv$/i.test(out)) out += '.csv';
  notTheVault(out);
  const list = V.exportable(session.data);
  await F.writeAtomic(out, Buffer.from(C.exportCsv(list), 'utf8'), { backup: false });
  produced.add(out);
  return { ok: true, file: out, name: path.basename(out), count: list.length };
});
handle('export:backup', async () => {
  need(session.unlocked, 'The vault is locked.');
  const base = path.basename(session.file, path.extname(session.file));
  const r = await dialog.showSaveDialog(win, { title: 'Save an encrypted backup copy', defaultPath: path.join(path.dirname(session.file), `${base} backup ${new Date().toISOString().slice(0, 10)}.${EXT}`), filters: [{ name: 'Password vault', extensions: [EXT] }] });
  if (r.canceled || !r.filePath) return { ok: false, cancelled: true };
  let out = r.filePath; if (path.extname(out).toLowerCase() !== '.' + EXT) out += '.' + EXT;
  notTheVault(out);
  try { await session.exportBackup(out); } catch (e) { return { ok: false, error: cleanError(e) }; }
  produced.add(out);
  return { ok: true, file: out, name: path.basename(out) };
});
handle('reveal', (file) => { if (produced.has(file)) shell.showItemInFolder(file); });

// ---- start up ------------------------------------------------------------------------------------------------------------------
function cleanUp() { lock('quit'); }

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
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
  app.whenReady().then(() => {
    hookPower();
    createWindow();
    if (E2E) {
      win.webContents.once('did-finish-load', () => {
        const arg = (name) => (process.argv.find((a) => a.startsWith(name + '=')) || '').slice(name.length + 1);
        const internals = { session, lock, clipboard, setIdle: (ms) => { lastActivity = Date.now() - ms; }, powerMonitor, clipState: () => clip };
        const ctx = { app, getWin: () => win, outFile: arg('--e2e-out'), shotsDir: arg('--shots'), outDir: arg('--readme-shots'), dialog, internals };
        if (ctx.outDir) require('../test/readme-shots').run(ctx); else require('../test/e2e').run(ctx);
      });
    }
  });
  app.on('before-quit', cleanUp);
  app.on('window-all-closed', () => { cleanUp(); app.quit(); });
}
