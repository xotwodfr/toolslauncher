'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, Menu, protocol } = require('electron');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const Meta = require('./meta');
const R = require('./markdown');
const X = require('./export');
const { NoteIndex } = require('./search');

const E2E = process.argv.includes('--e2e');
const SELFTEST = process.argv.find((a) => a.startsWith('--self-test='));
if (E2E || SELFTEST) app.setPath('userData', path.join(app.getPath('temp'), `markdown-notes-test-${process.pid}`));

// The notes protocol: notefile://root/<path inside the notes folder>. Only pictures, only inside the folder.
protocol.registerSchemesAsPrivileged([{ scheme: 'notefile', privileges: { standard: true, secure: true, supportFetchAPI: false, corsEnabled: false, stream: true } }]);

const MAX_NOTES = 20000;
const MAX_NOTE_BYTES = 20 * 1024 * 1024;   // bigger files are not opened in the editor
const MAX_INDEX_BYTES = 4 * 1024 * 1024;   // bigger notes are indexed by their first 4 MB
const MAX_ATTACHMENT = 50 * 1024 * 1024;
const NOTE_EXT = /\.(md|markdown)$/i;
const SKIP_DIRS = new Set(['node_modules', '.git', '.obsidian', '.trash', 'attachments']);

let win = null;
let root = null;            // absolute path of the notes folder
let realRoot = null;
const index = new NoteIndex();
let current = null;         // { rel, hash } the note open in the window, and the content hash the window is based on
let watcher = null;
let pollTimer = null;
let syncTimer = null;
let syncing = null;
const produced = new Set(); // exports we wrote: the only files "Show in folder" reveals
const trashMode = { fake: null }; // e2e: a folder that stands in for the Recycle Bin

const send = (channel, payload) => { if (win && !win.isDestroyed()) win.webContents.send(channel, payload); };
const cleanError = (e) => {
  const code = e && e.code;
  if (code === 'EACCES' || code === 'EPERM') return 'Windows or Linux did not allow that (the file may be open in another program, or read-only).';
  if (code === 'ENOSPC') return 'The disk is full.';
  if (code === 'ENOENT') return 'That file or folder is not there any more.';
  if (code === 'EEXIST') return 'Something with that name is already there.';
  return String((e && e.message) || e);
};
const sha = (s) => crypto.createHash('sha1').update(s).digest('hex');
const posix = (p) => p.split(path.sep).join('/');

// ---- settings (userData/config.json) -----------------------------------------------------------------------------------
const configFile = () => path.join(app.getPath('userData'), 'config.json');
let config = { lastRoot: null, folders: {} };
function loadConfig() { try { config = { lastRoot: null, folders: {}, ...JSON.parse(fs.readFileSync(configFile(), 'utf8')) }; } catch { /* first run */ } }
function saveConfig() { try { writeAtomic(configFile(), JSON.stringify(config, null, 2)); } catch { /* not important */ } }
const folderConf = () => { const k = root || ''; if (!config.folders[k]) config.folders[k] = { pinned: [], recent: [] }; return config.folders[k]; };

// ---- paths ---------------------------------------------------------------------------------------------------------------
/** A relative path from the window -> an absolute path that is certainly inside the notes folder (or an error). */
function abs(rel, { allowRoot = false } = {}) {
  if (!root) throw new Error('No notes folder is open.');
  if (typeof rel !== 'string' || rel.length > 4000 || rel.includes('\0')) throw new Error('Bad path');
  const clean = rel.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  if (!clean) { if (allowRoot) return root; throw new Error('Bad path'); }
  if (clean.split('/').some((s) => s === '..' || s === '.' || s === '')) throw new Error('Bad path');
  const p = path.resolve(root, ...clean.split('/'));
  if (!p.startsWith(root + path.sep)) throw new Error('That is outside the notes folder.');
  return p;
}
const relOf = (p) => posix(path.relative(root, p));
/** Is a real (symlink-resolved) path inside the notes folder? */
function insideReal(p) { try { const r = fs.realpathSync(p); return r === realRoot || r.startsWith(realRoot + path.sep); } catch { return false; } }

function writeAtomic(file, data) {
  const part = file + '.part';
  fs.writeFileSync(part, data);
  for (let i = 0; ; i++) {
    try { fs.renameSync(part, file); return; } catch (e) {
      if (i >= 5 || !(e.code === 'EPERM' || e.code === 'EBUSY' || e.code === 'EACCES')) { try { fs.unlinkSync(part); } catch { /* ignore */ } throw e; }
      const until = Date.now() + 60 * (i + 1); while (Date.now() < until) { /* Windows: another program has it open for a moment */ }
    }
  }
}
const trash = (p) => {
  if (trashMode.fake) { fs.mkdirSync(trashMode.fake, { recursive: true }); return fs.promises.rename(p, path.join(trashMode.fake, `${Date.now()}-${path.basename(p)}`)); }
  return shell.trashItem(p);
};

// ---- the folder: scan, tree, watch ---------------------------------------------------------------------------------------
/** Walk the notes folder: every note and every folder (hidden folders, .git, node_modules and attachments skipped). */
async function scan() {
  const notes = []; const dirs = [];
  async function walk(dir, depth) {
    if (depth > 24 || notes.length >= MAX_NOTES) return;
    let ents = [];
    try { ents = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (e.name.startsWith('.')) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (SKIP_DIRS.has(e.name.toLowerCase())) continue; dirs.push(relOf(p)); await walk(p, depth + 1); }
      else if (e.isFile() && NOTE_EXT.test(e.name)) { if (notes.length < MAX_NOTES) notes.push(relOf(p)); }
    }
  }
  await walk(root, 0);
  return { notes, dirs };
}

let dirsCache = [];
/** Bring the index up to date with the disk: read new and changed notes, drop vanished ones. */
async function sync() {
  if (!root) return { changed: false };
  if (syncing) return syncing;
  syncing = (async () => {
    const myRoot = root;
    const { notes, dirs } = await scan();
    if (root !== myRoot) return { changed: false };
    let changed = JSON.stringify(dirs) !== JSON.stringify(dirsCache);
    dirsCache = dirs;
    const seen = new Set(notes);
    for (const rel of index.paths()) if (!seen.has(rel)) { index.remove(rel); changed = true; }
    for (const rel of notes) {
      let st; try { st = await fs.promises.stat(abs(rel)); } catch { continue; }
      const d = index.get(rel);
      if (d && d.mtime === st.mtimeMs && d.size === st.size) continue;
      let text = '';
      try {
        if (st.size > MAX_INDEX_BYTES) { const fd = await fs.promises.open(abs(rel), 'r'); const b = Buffer.alloc(MAX_INDEX_BYTES); await fd.read(b, 0, b.length, 0); await fd.close(); text = b.toString('utf8'); }
        else text = await fs.promises.readFile(abs(rel), 'utf8');
      } catch { continue; }
      index.set(rel, text, { mtime: st.mtimeMs, size: st.size });
      changed = true;
    }
    if (current) checkCurrent();
    return { changed, capped: notes.length >= MAX_NOTES };
  })();
  try { return await syncing; } finally { syncing = null; }
}

/** The open note changed on disk? Tell the window (it reloads, or asks when you have unsaved typing). */
function checkCurrent() {
  if (!current) return;
  let text;
  try { text = fs.readFileSync(abs(current.rel), 'utf8'); } catch { send('note:external', { rel: current.rel, gone: true }); return; }
  const h = sha(text);
  if (h !== current.hash) { current.hash = h; send('note:external', { rel: current.rel, text, hash: h }); }
}

function scheduleSync(delay = 250) {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(async () => { const r = await sync().catch(() => ({ changed: false })); if (r.changed) send('folder:changed', folderSummary()); }, delay);
}

function watch() {
  unwatch();
  try {
    watcher = fs.watch(root, { recursive: true }, (_ev, name) => {
      if (name && /\.part$/.test(String(name))) return;
      scheduleSync();
    });
    watcher.on('error', () => { unwatch(); pollTimer = setInterval(() => scheduleSync(0), 4000); });
  } catch { pollTimer = setInterval(() => scheduleSync(0), 4000); }
}
function unwatch() { try { if (watcher) watcher.close(); } catch { /* ignore */ } watcher = null; clearInterval(pollTimer); pollTimer = null; }

function folderSummary() {
  const fc = folderConf();
  const notes = index.paths().sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
  // notes that are not there right now are left out of the lists, but not forgotten (they may be mid-move or on a
  // drive that comes back); deleting a note from the app removes it for good
  const info = (rel) => ({ rel, title: index.get(rel).title });
  return {
    root, name: path.basename(root), notes, dirs: dirsCache.slice(), tags: index.tags(),
    pinned: fc.pinned.filter((r) => index.has(r)).map(info), recent: fc.recent.filter((r) => index.has(r)).map(info), view: config.view || 'split', capped: index.size >= MAX_NOTES,
  };
}

async function openFolder(dir) {
  let st;
  try { st = fs.statSync(dir); } catch { throw new Error('That folder is not there any more.'); }
  if (!st.isDirectory()) throw new Error('That is not a folder.');
  const resolved = path.resolve(dir);
  if (resolved === path.parse(resolved).root || resolved === os.homedir()) throw new Error('Pick a folder for your notes, not the whole drive or your home folder.');
  unwatch();
  root = resolved; realRoot = fs.realpathSync(root);
  current = null;
  for (const rel of index.paths()) index.remove(rel);
  dirsCache = [];
  await sync();
  config.lastRoot = root; saveConfig();
  watch();
  return folderSummary();
}

// ---- window --------------------------------------------------------------------------------------------------------------
function createWindow() {
  win = new BrowserWindow({
    width: 1240, height: 800, minWidth: 820, minHeight: 520,
    backgroundColor: '#0b0b0d', title: 'Markdown Notes', autoHideMenuBar: true, show: !SELFTEST,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: true },
  });
  Menu.setApplicationMenu(null);
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'), (E2E || SELFTEST) ? { hash: 'e2e' } : undefined);
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.on('focus', () => { if (root) scheduleSync(0); });
  win.on('closed', () => { win = null; });
}

// ---- IPC -----------------------------------------------------------------------------------------------------------------
const str = (v, max = 4000) => { if (typeof v !== 'string' || v.length > max) throw new Error('Bad request'); return v; };
const handle = (ch, fn) => ipcMain.handle(ch, async (e, ...args) => {
  if (!win || e.sender !== win.webContents) throw new Error('Not allowed');
  try { return await fn(...args); } catch (err) { return { error: cleanError(err) }; }
});

handle('folder:get', async () => {
  if (root) return folderSummary();
  if (config.lastRoot && fs.existsSync(config.lastRoot)) { try { return await openFolder(config.lastRoot); } catch { /* fall through */ } }
  return null;
});
handle('folder:pick', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Choose your notes folder', properties: ['openDirectory', 'createDirectory'] });
  if (r.canceled || !r.filePaths[0]) return { cancelled: true };
  return openFolder(r.filePaths[0]);
});
handle('folder:refresh', async () => { await sync(); return folderSummary(); });

handle('note:read', async (rel) => {
  const p = abs(str(rel));
  const st = fs.statSync(p);
  if (st.size > MAX_NOTE_BYTES) throw new Error(`This note is ${(st.size / 1048576).toFixed(0)} MB, too big to edit here (the limit is 20 MB).`);
  const text = fs.readFileSync(p, 'utf8');
  current = { rel, hash: sha(text) };
  const fc = folderConf();
  fc.recent = [rel, ...fc.recent.filter((r) => r !== rel)].slice(0, 12);
  saveConfig();
  return { rel, text, hash: current.hash, pinned: fc.pinned.includes(rel), backlinks: index.backlinks(rel), recent: fc.recent.filter((r) => index.has(r) || r === rel).map((r) => ({ rel: r, title: index.has(r) ? index.get(r).title : Meta.stem(r) })) };
});
handle('note:close', () => { current = null; });

/** Save the open note. `base` is the content hash the window started from; if the file changed since, it is a conflict. */
handle('note:save', async (rel, text, base, force) => {
  str(rel); if (typeof text !== 'string' || text.length > MAX_NOTE_BYTES) throw new Error('This note is too big to save.');
  const p = abs(rel);
  let disk = null;
  try { disk = fs.readFileSync(p, 'utf8'); } catch { /* deleted outside: saving puts it back */ }
  if (!force && disk !== null && base && sha(disk) !== base && disk !== text) return { conflict: true, text: disk, hash: sha(disk) };
  fs.mkdirSync(path.dirname(p), { recursive: true });
  writeAtomic(p, text);
  const st = fs.statSync(p);
  const hash = sha(text);
  if (current && current.rel === rel) current.hash = hash;
  const before = index.get(rel);
  const tagsBefore = before ? before.tags.join(',') : null; const titleBefore = before ? before.title : null;
  index.set(rel, text.length > MAX_INDEX_BYTES ? text.slice(0, MAX_INDEX_BYTES) : text, { mtime: st.mtimeMs, size: st.size });
  const after = index.get(rel);
  if (tagsBefore !== after.tags.join(',') || titleBefore !== after.title) send('folder:changed', folderSummary());
  return { ok: true, hash };
});

/** Rendered preview of the text in the editor (not yet saved), with word count and tags. */
handle('note:render', async (rel, text) => {
  str(rel); if (typeof text !== 'string' || text.length > MAX_NOTE_BYTES) throw new Error('Too big to preview');
  const all = index.paths();
  const noteAbs = abs(rel);
  const html = R.render(text, {
    resolveWiki: (t) => !!Meta.resolveWikiLink(t, rel, all),
    mapImage: (src) => imageUrl(noteAbs, src),
  });
  return { html, words: Meta.wordCount(text), tags: Meta.extractTags(text) };
});

/** A relative picture in a note -> notefile:// URL, or null when it is outside the folder or missing. */
function imageUrl(noteAbs, src) {
  let rel;
  try { rel = decodeURIComponent(String(src).split(/[?#]/)[0]); } catch { return null; }
  const p = path.resolve(path.dirname(noteAbs), rel);
  if (!p.startsWith(root + path.sep)) return null;
  try { if (!fs.statSync(p).isFile()) return null; } catch { return null; }
  return 'notefile://root/' + relOf(p).split('/').map(encodeURIComponent).join('/');
}

handle('note:create', async (dirRel, name, body) => {
  const dir = abs(str(dirRel || ''), { allowRoot: true });
  let base = String(name || '').trim().replace(NOTE_EXT, '');
  if (!base) base = 'Untitled';
  const problem = Meta.nameProblem(base);
  if (problem) throw new Error(problem);
  fs.mkdirSync(dir, { recursive: true });
  const file = Meta.uniqueName(base + '.md', (n) => fs.existsSync(path.join(dir, n)));
  const p = path.join(dir, file);
  fs.writeFileSync(p, typeof body === 'string' ? body : `# ${file.replace(NOTE_EXT, '')}\n\n`, { flag: 'wx' });
  await sync();
  send('folder:changed', folderSummary());
  return { rel: relOf(p) };
});
handle('folder:create', async (dirRel, name) => {
  const dir = abs(str(dirRel || ''), { allowRoot: true });
  const problem = Meta.nameProblem(name);
  if (problem) throw new Error(problem);
  const p = path.join(dir, Meta.uniqueName(String(name).trim(), (n) => fs.existsSync(path.join(dir, n))));
  fs.mkdirSync(p);
  await sync();
  send('folder:changed', folderSummary());
  return { rel: relOf(p) };
});

/** After a note or folder moved: keep pinned, recent and the open note pointing at it. */
function moved(oldRel, newRel) {
  const fix = (r) => (r === oldRel ? newRel : r.startsWith(oldRel + '/') ? newRel + r.slice(oldRel.length) : r);
  const fc = folderConf();
  fc.pinned = fc.pinned.map(fix); fc.recent = fc.recent.map(fix); saveConfig();
  index.rename(oldRel, newRel);
  if (current) current.rel = fix(current.rel);
}
async function moveEntry(rel, destAbs) {
  const from = abs(rel);
  if (!fs.existsSync(from)) throw new Error('That note is not there any more.');
  if (destAbs === from || destAbs.startsWith(from + path.sep)) throw new Error('A folder cannot go inside itself.');
  if (fs.existsSync(destAbs) && !(process.platform !== 'linux' && destAbs.toLowerCase() === from.toLowerCase())) throw new Error(`There is already something called “${path.basename(destAbs)}” there.`);
  fs.mkdirSync(path.dirname(destAbs), { recursive: true });
  fs.renameSync(from, destAbs);
  const newRel = relOf(destAbs);
  moved(rel, newRel);
  await sync();
  send('folder:changed', folderSummary());
  return { rel: newRel, current: current && current.rel };
}
handle('entry:rename', async (rel, name) => {
  const from = abs(str(rel));
  const isDir = fs.statSync(from).isDirectory();
  let n = String(name || '').trim();
  if (!isDir) n = n.replace(NOTE_EXT, '');
  const problem = Meta.nameProblem(n);
  if (problem) throw new Error(problem);
  const ext = isDir ? '' : (path.extname(from) || '.md');
  return moveEntry(rel, path.join(path.dirname(from), n + ext));
});
handle('entry:move', async (rel, destDirRel) => {
  const from = abs(str(rel));
  const destDir = abs(str(destDirRel || ''), { allowRoot: true });
  if (!fs.statSync(destDir).isDirectory()) throw new Error('That is not a folder.');
  if (path.dirname(from) === destDir) return { rel, current: current && current.rel };
  return moveEntry(rel, path.join(destDir, path.basename(from)));
});
handle('entry:info', async (rel) => {
  const p = abs(str(rel));
  const st = fs.statSync(p);
  if (!st.isDirectory()) return { dir: false, notes: 1 };
  return { dir: true, notes: index.paths().filter((r) => r.startsWith(rel + '/')).length };
});
handle('entry:trash', async (rel) => {
  const p = abs(str(rel));
  if (!insideReal(p)) throw new Error('That is outside the notes folder.');
  await trash(p);
  const fc = folderConf();
  const gone = (r) => r === rel || r.startsWith(rel + '/');
  fc.pinned = fc.pinned.filter((r) => !gone(r)); fc.recent = fc.recent.filter((r) => !gone(r)); saveConfig();
  if (current && gone(current.rel)) current = null;
  await sync();
  send('folder:changed', folderSummary());
  return { ok: true };
});

handle('search', async (query, tag) => {
  const q = str(query || '', 500); const t = str(tag || '', 200);
  const t0 = Date.now();
  const results = index.search(q, { tag: t, limit: 300 });
  return { results, ms: Date.now() - t0, total: index.size };
});

handle('pin:toggle', async (rel) => {
  str(rel);
  const fc = folderConf();
  const on = !fc.pinned.includes(rel);
  fc.pinned = on ? [...fc.pinned, rel] : fc.pinned.filter((r) => r !== rel);
  saveConfig();
  send('folder:changed', folderSummary());
  return { pinned: on };
});
handle('view:set', async (v) => { if (['edit', 'split', 'preview'].includes(v)) { config.view = v; saveConfig(); } });

/** Follow a [[wiki link]]: open the note, or create it next to the linking note when it does not exist yet. */
handle('wiki:open', async (target, fromRel) => {
  str(target, 500); str(fromRel || '');
  const found = Meta.resolveWikiLink(target, fromRel, index.paths());
  if (found) return { rel: found, created: false };
  const rel = Meta.newNotePathFor(target, fromRel);
  if (!rel) throw new Error('That link has no note name.');
  const p = abs(rel);
  if (!fs.existsSync(p)) {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, `# ${Meta.stem(rel)}\n\n`, { flag: 'wx' });
  }
  await sync();
  send('folder:changed', folderSummary());
  return { rel, created: true };
});
/** A normal link in the preview: another note (relative .md link) opens here; web and mail links open outside. */
handle('link:open', async (href, fromRel) => {
  str(href); str(fromRel || '');
  if (/^(https?:|mailto:)/i.test(href)) { await shell.openExternal(href); return { external: true }; }
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) throw new Error('That kind of link is not opened.');
  let target;
  try { target = decodeURIComponent(href.split('#')[0]); } catch { target = href.split('#')[0]; }
  if (!target) return { anchor: href.split('#')[1] || '' };
  const p = path.resolve(path.dirname(abs(fromRel)), target);
  if (!p.startsWith(root + path.sep)) throw new Error('That link points outside the notes folder.');
  const rel = relOf(p);
  if (NOTE_EXT.test(rel) && index.has(rel)) return { rel, anchor: href.split('#')[1] || '' };
  if (!NOTE_EXT.test(rel) && index.has(rel + '.md')) return { rel: rel + '.md', anchor: href.split('#')[1] || '' };
  throw new Error('That linked note does not exist.');
});

/** A pasted or dropped picture: written to attachments/ next to the note. Returns the Markdown to insert. */
handle('attach:save', async (noteRel, bytes, originalName) => {
  str(noteRel);
  if (!(bytes instanceof Uint8Array) || !bytes.length) throw new Error('No picture there.');
  if (bytes.length > MAX_ATTACHMENT) throw new Error('That picture is bigger than 50 MB.');
  const ext = Meta.sniffImage(bytes);
  if (!ext) throw new Error('Only pictures (PNG, JPEG, GIF, WebP, BMP, AVIF) can be added to a note.');
  const noteAbs = abs(noteRel);
  const dir = path.join(path.dirname(noteAbs), 'attachments');
  fs.mkdirSync(dir, { recursive: true });
  const name = Meta.attachmentName({ originalName: typeof originalName === 'string' ? originalName.slice(0, 200) : '', ext, exists: (n) => fs.existsSync(path.join(dir, n)) });
  const p = path.join(dir, name);
  fs.writeFileSync(p + '.part', Buffer.from(bytes), { flag: 'wx' });
  fs.renameSync(p + '.part', p);
  return { markdown: Meta.attachmentLink('attachments/' + name, name.replace(/\.[^.]+$/, '')), name };
});

// ---- export ------------------------------------------------------------------------------------------------------------
const EXPORTS = { html: ['HTML page', 'html'], pdf: ['PDF', 'pdf'], docx: ['Word document', 'docx'] };
const PAGE_SIZES = ['A4', 'Letter', 'A5', 'Legal'];

async function htmlToPdf(html, pageSize) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'markdown-notes-pdf-'));
  const file = path.join(tmp, 'note.html');
  fs.writeFileSync(file, html);
  const w = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, javascript: false } });
  w.webContents.on('will-navigate', (e) => e.preventDefault());
  w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  try {
    await w.loadFile(file);
    return await w.webContents.printToPDF({ pageSize: PAGE_SIZES.includes(pageSize) ? pageSize : 'A4', printBackground: true, preferCSSPageSize: false, margins: { top: 0.6, bottom: 0.6, left: 0.6, right: 0.6 } });
  } finally {
    w.destroy();
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

async function exportNote(rel, text, format, { pageSize = 'A4' } = {}) {
  const noteAbs = abs(rel);
  const title = Meta.noteTitle(text, path.basename(rel));
  const readImage = X.imageReader(root, noteAbs);
  const all = index.paths();
  const resolveWiki = (t) => !!Meta.resolveWikiLink(t, rel, all);
  if (format === 'html') return Buffer.from(X.noteToHtml(text, { title, readImage, resolveWiki }), 'utf8');
  if (format === 'pdf') return htmlToPdf(X.noteToHtml(text, { title, readImage, resolveWiki }), pageSize);
  if (format === 'docx') return (await X.noteToDocx(text, { title, readImage })).buffer;
  throw new Error('Unknown export');
}

handle('export', async (rel, text, format, opts) => {
  str(rel); if (typeof text !== 'string' || text.length > MAX_NOTE_BYTES) throw new Error('Bad note');
  if (!EXPORTS[format]) throw new Error('Unknown export');
  const [label, ext] = EXPORTS[format];
  const base = Meta.safeName(Meta.noteTitle(text, path.basename(rel))) || Meta.stem(rel);
  const pick = await dialog.showSaveDialog(win, { title: `Export as ${label}`, defaultPath: path.join(app.getPath('documents'), `${base}.${ext}`), filters: [{ name: label, extensions: [ext] }] });
  if (pick.canceled || !pick.filePath) return { cancelled: true };
  let out = pick.filePath;
  if (path.extname(out).toLowerCase() !== '.' + ext) out += '.' + ext;
  if (path.resolve(out) === path.resolve(abs(rel))) throw new Error('That would replace the note itself. Pick another name.');
  const data = await exportNote(rel, text, format, opts && typeof opts === 'object' ? opts : {});
  writeAtomic(out, data);
  produced.add(out);
  return { ok: true, path: out, bytes: data.length };
});
handle('reveal', async (p) => { if (typeof p === 'string' && produced.has(p)) shell.showItemInFolder(p); });

// notefile:// requests -> pictures inside the notes folder, nothing else
function serveNoteFile(request) {
  try {
    const u = new URL(request.url);
    if (!root || u.hostname !== 'root') return new Response('Not found', { status: 404 });
    const rel = decodeURIComponent(u.pathname).replace(/^\/+/, '');
    const p = abs(rel);
    if (!insideReal(p)) return new Response('Not allowed', { status: 403 });
    const st = fs.statSync(p);
    if (!st.isFile() || st.size > MAX_ATTACHMENT) return new Response('Not found', { status: 404 });
    const data = fs.readFileSync(p);
    const ext = Meta.sniffImage(data);
    if (!ext) return new Response('Not a picture', { status: 415 });
    return new Response(data, { status: 200, headers: { 'content-type': Meta.IMAGE_TYPES[ext], 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff' } });
  } catch { return new Response('Not found', { status: 404 }); }
}

// ---- start up --------------------------------------------------------------------------------------------------------------
module.exports = { exportNote, openFolder, htmlToPdf, getIndex: () => index, setTrash: (dir) => { trashMode.fake = dir; } };

const gotLock = SELFTEST || E2E ? true : app.requestSingleInstanceLock();
if (SELFTEST) {
  app.whenReady().then(async () => {
    protocol.handle('notefile', serveNoteFile);
    createWindow();
    const outFile = SELFTEST.slice('--self-test='.length);
    let code = 1;
    try {
      const results = await require('./selftest').run({ getWin: () => win, main: module.exports });
      fs.writeFileSync(outFile, JSON.stringify({ ok: results.every((r) => r.ok), results }, null, 2));
      code = results.every((r) => r.ok) ? 0 : 1;
    } catch (e) {
      fs.writeFileSync(outFile, JSON.stringify({ ok: false, error: String((e && e.stack) || e) }, null, 2));
    }
    unwatch();
    app.exit(code);
  });
} else if (!gotLock) app.quit();
else {
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
  app.whenReady().then(() => {
    loadConfig();
    protocol.handle('notefile', serveNoteFile);
    createWindow();
    if (E2E) {
      win.webContents.once('did-finish-load', () => {
        const arg = (name) => (process.argv.find((a) => a.startsWith(name + '=')) || '').slice(name.length + 1);
        const ctx = { app, getWin: () => win, outFile: arg('--e2e-out'), shotsDir: arg('--shots'), outDir: arg('--readme-shots'), dialog, main: module.exports };
        if (ctx.outDir) require('../test/readme-shots').run(ctx); else require('../test/e2e').run(ctx);
      });
    }
  });
  app.on('window-all-closed', () => { unwatch(); app.quit(); });
}
