'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, Menu, protocol } = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const C = require('./convert');
const E = require('./epub');
const X = require('./xhtml');

const E2E = process.argv.includes('--e2e');
const SELFTEST = process.argv.find((a) => a.startsWith('--self-test='));
if (E2E || SELFTEST) app.setPath('userData', path.join(app.getPath('temp'), `ebook-studio-test-${process.pid}`));

// book://<key>/images/<name> and book://<key>/cover serve the pictures of an open book; book://covers/<id> the library's
// cover thumbnails. Nothing else, and never anything from the network.
protocol.registerSchemesAsPrivileged([{ scheme: 'book', privileges: { standard: true, secure: true, supportFetchAPI: false, corsEnabled: false, stream: true } }]);

const MAX_INPUT = 400 * 1024 * 1024;
const INPUT_EXTS = ['epub', 'txt', 'md', 'markdown', 'html', 'htm', 'xhtml'];
const FORMATS = { epub: 'EPUB', pdf: 'PDF', html: 'HTML', md: 'Markdown', txt: 'Text' };
const PAGE_SIZES = ['A4', 'A5', 'Letter', 'Legal'];

let win = null;
const openBooks = new Map();  // key -> { book, path, id, texts }
const produced = new Set();   // files we wrote: the only ones "Show in folder" reveals
let converting = null;        // { cancelled }
let pendingCover = null;      // { data, mediaType } chosen in the details editor

const send = (ch, payload) => { if (win && !win.isDestroyed()) win.webContents.send(ch, payload); };
const cleanError = (e) => {
  const code = e && e.code;
  if (code === 'ENOENT') return 'That file is not there any more.';
  if (code === 'EACCES' || code === 'EPERM') return 'Windows or Linux did not allow that (the file may be open in another program, or read-only).';
  if (code === 'ENOSPC') return 'The disk is full.';
  return String((e && e.message) || e);
};

// ---- small stores in userData ------------------------------------------------------------------------------------------------------
const dataFile = (name) => path.join(app.getPath('userData'), name);
function readJson(name, fallback) { try { return JSON.parse(fs.readFileSync(dataFile(name), 'utf8')); } catch { return fallback; } }
function writeAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const part = file + '.part';
  fs.writeFileSync(part, data);
  try { fs.renameSync(part, file); } catch (e) { try { fs.unlinkSync(part); } catch { /* ignore */ } throw e; }
}
const writeJson = (name, v) => { try { writeAtomic(dataFile(name), JSON.stringify(v, null, 1)); } catch { /* not important */ } };
let library = null;
const lib = () => library || (library = readJson('library.json', { books: [] }));
const saveLib = () => writeJson('library.json', lib());
const idOf = (p) => crypto.createHash('sha1').update(path.resolve(p)).digest('hex').slice(0, 20);

/** "name.ext", or "name (2).ext"... in `dir`: never an existing file. */
function freeName(dir, base, ext) {
  let n = `${base}.${ext}`; let k = 2;
  while (fs.existsSync(path.join(dir, n))) n = `${base} (${k++}).${ext}`;
  return path.join(dir, n);
}
function freeDir(dir, base) { let n = base; let k = 2; while (fs.existsSync(path.join(dir, n))) n = `${base} (${k++})`; return path.join(dir, n); }

// ---- loading books ------------------------------------------------------------------------------------------------------------------
function readInput(file) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) throw new Error('Bad file');
  const kind = C.kindOf(file);
  if (!kind) throw new Error('Only EPUB, text (.txt), Markdown (.md) and HTML files can be opened.');
  const st = fs.statSync(file);
  if (!st.isFile()) throw new Error('That is not a file.');
  if (st.size > MAX_INPUT) throw new Error('That file is too big (more than 400 MB).');
  if (st.size === 0) throw new Error('That file is empty.');
  const buf = fs.readFileSync(file);
  // pictures next to a Markdown or HTML file: only from its own folder (and folders inside it)
  const baseDir = path.dirname(file);
  const readLocal = (src) => {
    let rel; try { rel = decodeURIComponent(String(src).split(/[?#]/)[0]); } catch { rel = String(src); }
    const p = path.resolve(baseDir, rel);
    if (!p.startsWith(baseDir + path.sep)) return null;
    try { const s = fs.statSync(p); if (!s.isFile() || s.size > 50 * 1024 * 1024) return null; return new Uint8Array(fs.readFileSync(p)); } catch { return null; }
  };
  const book = C.load(kind, new Uint8Array(buf), path.basename(file), readLocal);
  return { book, kind };
}

function libraryEntry(file, book, kind) {
  const id = idOf(file);
  const L = lib();
  let entry = L.books.find((b) => b.id === id);
  if (!entry) { entry = { id, path: file, added: Date.now(), position: null, progress: 0 }; L.books.unshift(entry); }
  Object.assign(entry, { path: file, kind, title: book.meta.title || path.basename(file), authors: book.meta.authors || [], chapters: book.chapters.length, lastOpened: Date.now() });
  // a small copy of the cover for the library
  if (book.cover && !entry.cover) {
    try {
      const ext = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp' }[book.cover.mediaType] || 'img';
      writeAtomic(dataFile(`covers/${id}.${ext}`), Buffer.from(book.cover.data));
      entry.cover = `${id}.${ext}`;
    } catch { /* no cover then */ }
  }
  L.books.sort((a, b) => (b.lastOpened || 0) - (a.lastOpened || 0));
  saveLib();
  return entry;
}
const publicEntry = (b) => ({ id: b.id, path: b.path, title: b.title, authors: b.authors, kind: b.kind, progress: b.progress || 0, cover: b.cover ? `book://covers/${encodeURIComponent(b.cover)}` : null, exists: fs.existsSync(b.path), lastOpened: b.lastOpened });

// ---- window ---------------------------------------------------------------------------------------------------------------------------
function createWindow() {
  win = new BrowserWindow({
    width: 1240, height: 820, minWidth: 860, minHeight: 560,
    backgroundColor: '#0b0b0d', title: 'Ebook Converter & Reader', autoHideMenuBar: true, show: !SELFTEST,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  Menu.setApplicationMenu(null);
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'), (E2E || SELFTEST) ? { hash: 'e2e' } : undefined);
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  // the reading frame is a srcdoc page: it may never navigate anywhere
  win.webContents.on('will-frame-navigate', (e) => { if (!e.isMainFrame && e.url !== 'about:srcdoc') e.preventDefault(); });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.on('closed', () => { win = null; });
}

const handle = (ch, fn) => ipcMain.handle(ch, async (e, ...args) => {
  if (!win || e.sender !== win.webContents) throw new Error('Not allowed');
  try { return await fn(...args); } catch (err) { return { error: cleanError(err) }; }
});
const OPEN_FILTER = [{ name: 'Books', extensions: INPUT_EXTS }];

// ---- library -----------------------------------------------------------------------------------------------------------------------
handle('library:list', () => lib().books.map(publicEntry));
handle('library:remove', (id) => {
  const L = lib();
  const b = L.books.find((x) => x.id === id);
  if (!b) return { ok: true };
  L.books = L.books.filter((x) => x.id !== id);
  if (b.cover) { try { fs.unlinkSync(dataFile('covers/' + path.basename(b.cover))); } catch { /* ignore */ } }
  saveLib();
  return { ok: true };
});
handle('files:pick', async (purpose) => {
  const epubOnly = purpose === 'details';
  const r = await dialog.showOpenDialog(win, {
    title: epubOnly ? 'Choose an EPUB' : purpose === 'convert' ? 'Add books to convert' : 'Open a book',
    properties: purpose === 'convert' ? ['openFile', 'multiSelections'] : ['openFile'],
    filters: epubOnly ? [{ name: 'EPUB', extensions: ['epub'] }] : OPEN_FILTER,
  });
  return r.canceled ? [] : r.filePaths;
});

// ---- reader -------------------------------------------------------------------------------------------------------------------------
handle('reader:open', async (file) => {
  const { book, kind } = readInput(file);
  const entry = libraryEntry(file, book, kind);
  for (const [k, v] of openBooks) if (v.id === entry.id) openBooks.delete(k);
  const key = crypto.randomBytes(12).toString('hex');
  openBooks.set(key, { book, path: file, id: entry.id, texts: null });
  const flatToc = book.toc && book.toc.length ? book.toc : book.chapters.map((c, i) => ({ label: c.title, chapter: i, frag: '', children: [] }));
  return {
    key, id: entry.id, meta: book.meta, chapters: book.chapters.map((c) => ({ title: c.title, size: c.body.length })), toc: flatToc,
    position: entry.position, cover: book.cover ? `book://${key}/cover` : null, warnings: book.warnings || [],
  };
});
handle('reader:close', (key) => { openBooks.delete(key); });

/** One chapter as a page for the sandboxed reading frame. */
handle('reader:chapter', (key, index) => {
  const ob = openBooks.get(key);
  if (!ob) throw new Error('That book is not open any more.');
  const ch = ob.book.chapters[index];
  if (!ch) throw new Error('No such chapter.');
  const body = X.toXhtml(X.parseHtml(`<div>${ch.body}</div>`).children[0].children, {
    mapSrc: (src) => { const m = /^\.\.\/images\/(.+)$/.exec(src); return m ? `book://${key}/images/${m[1]}` : null; },
    mapHref: (href) => href, // already safe: other chapters or web links; the window decides what a click does
  });
  const lang = X.escAttr(ob.book.meta.language || 'en');
  return { html: `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><link rel="stylesheet" href="reader.css"></head><body><article class="chapter">${body}</article></body></html>`, title: ch.title };
});

handle('reader:search', (key, query) => {
  const ob = openBooks.get(key);
  if (!ob) throw new Error('That book is not open any more.');
  const q = String(query || '').trim().toLowerCase();
  if (q.length < 2) return { results: [] };
  if (!ob.texts) ob.texts = ob.book.chapters.map((c) => C.chapterText(c).replace(/\s+/g, ' '));
  const results = [];
  ob.texts.forEach((t, chapter) => {
    const low = t.toLowerCase();
    let i = -1; let nth = 0;
    while ((i = low.indexOf(q, i + 1)) !== -1 && results.length < 500) {
      const s = Math.max(0, i - 50);
      results.push({ chapter, nth, title: ob.book.chapters[chapter].title, before: (s > 0 ? '…' : '') + t.slice(s, i), match: t.slice(i, i + q.length), after: t.slice(i + q.length, i + q.length + 70) + '…' });
      nth++;
    }
  });
  return { results, capped: results.length >= 500 };
});

handle('reader:position', (id, pos) => {
  const b = lib().books.find((x) => x.id === id);
  if (!b || !pos || typeof pos !== 'object') return;
  const chapter = Number(pos.chapter); const frac = Number(pos.frac); const progress = Number(pos.progress);
  if (!Number.isInteger(chapter) || chapter < 0 || !(frac >= 0 && frac <= 1)) return;
  b.position = { chapter, frac };
  if (progress >= 0 && progress <= 1) b.progress = progress;
  saveLib();
});
handle('link:open', async (url) => { if (typeof url === 'string' && /^https?:\/\//i.test(url) && url.length < 4000) await shell.openExternal(url); });

// ---- converter ----------------------------------------------------------------------------------------------------------------------
async function htmlToPdf(html, pageSize) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ebook-studio-pdf-'));
  const file = path.join(tmp, 'book.html');
  fs.writeFileSync(file, html);
  const w = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, javascript: false } });
  w.webContents.on('will-navigate', (e) => e.preventDefault());
  w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  try {
    await w.loadFile(file);
    return await w.webContents.printToPDF({ pageSize: PAGE_SIZES.includes(pageSize) ? pageSize : 'A4', printBackground: true, margins: { top: 0.7, bottom: 0.7, left: 0.7, right: 0.7 } });
  } finally {
    w.destroy();
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

/** Convert one file. Returns the paths written. The original is only read. */
async function convertOne(file, format, opts = {}) {
  const { book } = readInput(file);
  const outDir = opts.outDir || path.dirname(file);
  const base = path.basename(file).replace(/\.[^.]+$/, '');
  const outputs = [];
  if (format === 'epub') { const out = freeName(outDir, base, 'epub'); writeAtomic(out, C.toEpub(book)); outputs.push(out); }
  else if (format === 'txt') { const out = freeName(outDir, base, 'txt'); writeAtomic(out, C.toText(book)); outputs.push(out); }
  else if (format === 'html') { const out = freeName(outDir, base, 'html'); writeAtomic(out, C.toHtml(book)); outputs.push(out); }
  else if (format === 'md') {
    const out = freeName(outDir, base, 'md');
    const imgDirPath = book.images.length ? freeDir(outDir, path.basename(out).replace(/\.md$/, '') + ' images') : null;
    const { text, images } = C.toMarkdown(book, imgDirPath ? path.basename(imgDirPath) : 'images');
    if (images.length) { fs.mkdirSync(imgDirPath); for (const img of images) writeAtomic(path.join(imgDirPath, img.name), Buffer.from(img.data)); outputs.push(imgDirPath); }
    writeAtomic(out, text); outputs.unshift(out);
  } else if (format === 'pdf') {
    const pdf = await htmlToPdf(C.toHtml(book), opts.pageSize);
    const out = freeName(outDir, base, 'pdf'); writeAtomic(out, pdf); outputs.push(out);
  } else throw new Error('Unknown format');
  return { outputs, title: book.meta.title, chapters: book.chapters.length };
}

handle('convert:run', async (files, format, opts) => {
  if (converting) throw new Error('A conversion is already running.');
  if (!Array.isArray(files) || !files.length || files.length > 500 || !files.every((f) => typeof f === 'string' && path.isAbsolute(f))) throw new Error('No files chosen.');
  if (!FORMATS[format]) throw new Error('Unknown format');
  opts = opts && typeof opts === 'object' ? opts : {};
  const o = { pageSize: PAGE_SIZES.includes(opts.pageSize) ? opts.pageSize : 'A4', outDir: null };
  if (opts.outDir) { if (typeof opts.outDir !== 'string' || !path.isAbsolute(opts.outDir) || !fs.statSync(opts.outDir).isDirectory()) throw new Error('That output folder is not there.'); o.outDir = opts.outDir; }
  converting = { cancelled: false };
  const summary = { done: 0, failed: 0, cancelled: 0, outputs: [] };
  try {
    for (let i = 0; i < files.length; i++) {
      if (converting.cancelled) { summary.cancelled++; send('convert:progress', { index: i, status: 'cancelled' }); continue; }
      send('convert:progress', { index: i, status: 'working' });
      await new Promise((r) => setImmediate(r));
      try {
        const r = await convertOne(files[i], format, o);
        r.outputs.forEach((p) => produced.add(p));
        summary.done++; summary.outputs.push(...r.outputs);
        send('convert:progress', { index: i, status: 'done', outputs: r.outputs, chapters: r.chapters });
      } catch (e) { summary.failed++; send('convert:progress', { index: i, status: 'error', error: cleanError(e) }); }
    }
  } finally { converting = null; }
  return summary;
});
handle('convert:cancel', () => { if (converting) converting.cancelled = true; });
handle('dir:pick', async () => { const r = await dialog.showOpenDialog(win, { title: 'Choose where to save', properties: ['openDirectory', 'createDirectory'] }); return r.canceled ? null : r.filePaths[0]; });
handle('reveal', (p) => { if (typeof p === 'string' && produced.has(p)) shell.showItemInFolder(p); });

// ---- details (metadata) editor -------------------------------------------------------------------------------------------------------
handle('meta:open', (file) => {
  if (typeof file !== 'string' || !/\.epub$/i.test(file)) throw new Error('Only EPUB books have details to edit here.');
  const st = fs.statSync(file);
  if (st.size > MAX_INPUT) throw new Error('That file is too big.');
  const ep = E.readEpub(new Uint8Array(fs.readFileSync(file)));
  pendingCover = null;
  const coverData = ep.cover ? ep.files[ep.cover.path] : null;
  const mt = coverData && C.sniff(coverData);
  return { path: file, version: ep.version, meta: ep.meta, cover: mt ? `data:${mt};base64,${Buffer.from(coverData).toString('base64')}` : null, chapters: ep.spine.length };
});
handle('meta:pick-cover', async (droppedPath) => {
  let file = droppedPath;
  if (!file) {
    const r = await dialog.showOpenDialog(win, { title: 'Choose a cover picture', properties: ['openFile'], filters: [{ name: 'Pictures', extensions: ['jpg', 'jpeg', 'png', 'gif', 'webp'] }] });
    if (r.canceled) return { cancelled: true };
    file = r.filePaths[0];
  }
  if (typeof file !== 'string' || !path.isAbsolute(file)) throw new Error('Bad file');
  if (fs.statSync(file).size > 30 * 1024 * 1024) throw new Error('That picture is bigger than 30 MB.');
  const data = new Uint8Array(fs.readFileSync(file));
  const mediaType = C.sniff(data);
  if (!mediaType) throw new Error('The cover must be a JPEG, PNG, GIF or WebP picture.');
  pendingCover = { data, mediaType };
  return { preview: `data:${mediaType};base64,${Buffer.from(data).toString('base64')}`, name: path.basename(file) };
});
handle('meta:save', async (file, changes) => {
  if (typeof file !== 'string' || !/\.epub$/i.test(file) || !changes || typeof changes !== 'object') throw new Error('Bad request');
  const str = (v, max) => (v === undefined ? undefined : String(v).slice(0, max));
  const c = { title: str(changes.title, 1000), authors: str(changes.authors, 2000), language: str(changes.language, 40), publisher: str(changes.publisher, 1000), description: str(changes.description, 20000) };
  if (c.title !== undefined && !c.title.trim()) throw new Error('A book needs a title.');
  if (c.language !== undefined && c.language.trim() && !/^[a-z]{2,3}(-[A-Za-z0-9]{1,8})*$/i.test(c.language.trim())) throw new Error('The language should be a code such as "en", "fr" or "pt-BR".');
  if (changes.cover && pendingCover) c.cover = pendingCover;
  const base = path.basename(file).replace(/\.epub$/i, '');
  const pick = await dialog.showSaveDialog(win, { title: 'Save the book with the new details', defaultPath: freeName(path.dirname(file), `${base} (edited)`, 'epub'), filters: [{ name: 'EPUB', extensions: ['epub'] }] });
  if (pick.canceled || !pick.filePath) return { cancelled: true };
  let out = pick.filePath;
  if (!/\.epub$/i.test(out)) out += '.epub';
  if (path.resolve(out) === path.resolve(file)) throw new Error('Pick a new name: the original book is never overwritten.');
  const bytes = E.editMetadata(new Uint8Array(fs.readFileSync(file)), c);
  E.readEpub(bytes); // proves the new file opens
  writeAtomic(out, Buffer.from(bytes));
  produced.add(out);
  return { ok: true, path: out };
});

// ---- the book:// protocol -------------------------------------------------------------------------------------------------------------
function serveBook(request) {
  try {
    const u = new URL(request.url);
    const parts = u.pathname.split('/').filter(Boolean).map((s) => decodeURIComponent(s));
    if (u.hostname === 'covers') {
      const name = parts[0] || '';
      if (!/^[0-9a-f]{20}\.(jpg|png|gif|webp)$/.test(name)) return new Response('Not found', { status: 404 });
      const data = fs.readFileSync(dataFile('covers/' + name));
      return new Response(data, { headers: { 'content-type': C.sniff(data) || 'application/octet-stream', 'x-content-type-options': 'nosniff' } });
    }
    const ob = openBooks.get(u.hostname);
    if (!ob) return new Response('Not found', { status: 404 });
    let img = null;
    if (parts.length === 1 && parts[0] === 'cover') img = ob.book.cover;
    else if (parts.length === 2 && parts[0] === 'images') img = ob.book.images.find((i) => i.name === parts[1]);
    if (!img) return new Response('Not found', { status: 404 });
    return new Response(Buffer.from(img.data), { headers: { 'content-type': img.mediaType, 'x-content-type-options': 'nosniff', 'cache-control': 'no-cache' } });
  } catch { return new Response('Not found', { status: 404 }); }
}

// ---- start up ------------------------------------------------------------------------------------------------------------------------------
module.exports = { convertOne, htmlToPdf, openBooks };
const pathsFromArgs = (argv) => argv.slice(app.isPackaged ? 1 : 2).filter((a) => a && !a.startsWith('-') && path.isAbsolute(a) && C.kindOf(a));

const gotLock = SELFTEST || E2E ? true : app.requestSingleInstanceLock();
if (SELFTEST) {
  app.whenReady().then(async () => {
    protocol.handle('book', serveBook);
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
    app.exit(code);
  });
} else if (!gotLock) app.quit();
else {
  app.on('second-instance', (_e, argv) => {
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
    const p = pathsFromArgs(argv)[0];
    if (p) send('open:file', p);
  });
  app.whenReady().then(() => {
    protocol.handle('book', serveBook);
    createWindow();
    if (E2E) {
      win.webContents.once('did-finish-load', () => {
        const arg = (name) => (process.argv.find((a) => a.startsWith(name + '=')) || '').slice(name.length + 1);
        const ctx = { app, getWin: () => win, outFile: arg('--e2e-out'), shotsDir: arg('--shots'), outDir: arg('--readme-shots'), dialog, main: module.exports };
        if (ctx.outDir) require('../test/readme-shots').run(ctx); else require('../test/e2e').run(ctx);
      });
      return;
    }
    const startup = pathsFromArgs(process.argv)[0];
    if (startup) win.webContents.once('did-finish-load', () => send('open:file', startup));
  });
  app.on('window-all-closed', () => app.quit());
}
