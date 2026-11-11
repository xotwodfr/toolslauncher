'use strict';
// Encrypting and decrypting real files and folders: names, .part files, cancel, the verification pass and moving
// originals to the Recycle Bin. Electron-free (the trash function is passed in) so it can be tested in plain Node.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const L = require('./locked');
const A = require('./archive');

const EXT = '.locked';

/** "name.ext" -> "name (2).ext" ... until free. Folders and ".locked" outputs keep their last extension at the end. */
function uniquePath(dir, name) {
  let p = path.join(dir, name);
  if (!fs.existsSync(p)) return p;
  const ext = path.extname(name); const stem = ext && ext !== name ? name.slice(0, -ext.length) : name;
  for (let i = 2; i < 10000; i++) { p = path.join(dir, `${stem} (${i})${ext && ext !== name ? ext : ''}`); if (!fs.existsSync(p)) return p; }
  throw new Error('Could not find a free name for ' + name);
}

const WIN_BAD = /[<>:"/\\|?*\u0000-\u001f]/g;
/** The original name from inside a .locked file, made safe to use as a single file name here. */
function safeName(name) {
  let s = String(name || '').split(/[\\/]/).pop().replace(WIN_BAD, '_').replace(/[. ]+$/, '');
  if (!s || s === '.' || s === '..') s = 'decrypted';
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(s)) s = '_' + s;
  return s.slice(0, 240);
}

/** Looks at what the user added: { path, name, kind: 'file'|'folder'|'locked', bytes, entries? }. */
async function plan(p, signal) {
  const st = await fs.promises.stat(p);
  if (st.isDirectory()) {
    const w = await A.walk(p, signal);
    const bytes = w.entries.reduce((s, e) => s + (e.size || 0), 0);
    return { path: p, name: path.basename(p), kind: 'folder', bytes, files: w.entries.filter((e) => e.type === 'file').length, folders: w.entries.filter((e) => e.type === 'dir').length, entries: w.entries, skipped: w.skipped, mtimeMs: st.mtimeMs };
  }
  if (!st.isFile()) throw new Error('Not a regular file');
  let kind = 'file';
  if (p.toLowerCase().endsWith(EXT)) { try { await L.inspect(p); kind = 'locked'; } catch { /* a file that only looks like one */ } }
  return { path: p, name: path.basename(p), kind, bytes: st.size, mtimeMs: st.mtimeMs, size: st.size };
}

/** A signature of a folder's contents (paths, sizes, times), to notice changes between encrypting and deleting. */
const signature = (entries) => crypto.createHash('sha256').update(JSON.stringify(entries.map((e) => [e.rel, e.type, e.size || 0, e.mtimeMs || 0]))).digest('hex');

/**
 * Encrypts one planned item to "<name>.locked" (in outDir or next to it). With `deleteOriginal`, the result is first
 * decrypted again in full and compared (SHA-256 of everything) and the original is checked to be unchanged; only then
 * is it handed to `trash` (the Recycle Bin). Returns { output, verified, trashed, skipped }.
 */
async function encryptItem(item, { master, outDir, signal, onBytes, deleteOriginal = false, trash }) {
  const dir = outDir || path.dirname(item.path);
  const output = uniquePath(dir, item.name + EXT);
  const part = output + '.part';
  let fh = null;
  try {
    fh = await fs.promises.open(part, 'wx');
    let content; let meta;
    if (item.kind === 'folder') {
      content = A.pack(item.entries, signal);
      meta = { v: 1, kind: 'folder', name: item.name, bytes: item.bytes, files: item.files, folders: item.folders, mtime: Math.floor(item.mtimeMs) };
    } else {
      const st = await fs.promises.stat(item.path);
      content = (async function* read() {
        let got = 0;
        for await (const c of fs.createReadStream(item.path, { highWaterMark: 1 << 20 })) { got += c.length; yield c; }
        const after = await fs.promises.stat(item.path);
        if (got !== st.size || after.size !== st.size || after.mtimeMs !== st.mtimeMs) throw new Error('The file changed while it was being encrypted. Try again when nothing is writing to it.');
      })();
      meta = { v: 1, kind: 'file', name: item.name, bytes: st.size, mtime: Math.floor(st.mtimeMs) };
    }
    const r = await L.encryptStream({ master, meta, content, out: fh, signal, onBytes });
    await fh.sync(); await fh.close(); fh = null;
    if (fs.existsSync(output)) throw new Error('A file named ' + path.basename(output) + ' appeared meanwhile; nothing was replaced.');
    await fs.promises.rename(part, output);
    const res = { output, verified: false, trashed: false, skipped: item.skipped || [] };
    if (deleteOriginal) {
      const getMaster = async (salt) => { if (!salt.equals(master.salt)) throw new Error('salt mismatch'); return master.key; };
      const check = await L.decryptFile(output, { getMaster, onMeta: () => null, signal });
      if (check.plainHash !== r.plainHash) throw new Error('The check after encrypting failed, so the original was NOT deleted.');
      res.verified = true;
      let unchanged;
      if (item.kind === 'folder') unchanged = signature((await A.walk(item.path)).entries) === signature(item.entries);
      else { const st = await fs.promises.stat(item.path); unchanged = st.size === meta.bytes && Math.floor(st.mtimeMs) === meta.mtime; }
      if (!unchanged) { res.note = 'The original changed after it was encrypted, so it was kept.'; return res; }
      await trash(item.path);
      res.trashed = true;
    }
    return res;
  } catch (e) {
    if (fh) await fh.close().catch(() => {});
    await fs.promises.rm(part, { force: true }).catch(() => {});
    throw e;
  }
}

/**
 * Decrypts one .locked file into outDir (or next to it) under its original name ("name (2).ext" if that is taken).
 * Output goes to a .part file (or a hidden temporary folder) and is renamed only after the whole file has been
 * authenticated; on any failure, everything it wrote is removed. Returns { output, kind, name, renamed }.
 */
async function decryptItem(file, { getMaster, outDir, signal, onBytes }) {
  const dir = outDir || path.dirname(file);
  let made = null; // { kind, tmp, sink, fh }
  try {
    const r = await L.decryptFile(file, {
      getMaster, signal, onBytes,
      onMeta: async (meta) => {
        const name = safeName(meta.name);
        if (meta.kind === 'folder') {
          const tmp = path.join(dir, `.${name}.part-${crypto.randomBytes(4).toString('hex')}`);
          await fs.promises.mkdir(tmp);
          made = { kind: 'folder', tmp, name, sink: A.unpacker(tmp) };
          return made.sink;
        }
        if (meta.kind !== 'file') throw new L.LockedError('damaged', 'The file is damaged (unknown kind of content).');
        const tmp = uniquePath(dir, name) + '.part';
        const fh = await fs.promises.open(tmp, 'wx');
        let pos = 0;
        made = { kind: 'file', tmp, name, fh };
        return { write: async (b) => { await fh.write(b, 0, b.length, pos); pos += b.length; }, end: async () => { await fh.sync(); await fh.close(); made.fh = null; } };
      },
    });
    const final = uniquePath(dir, made.name);
    await fs.promises.rename(made.tmp, final);
    if (made.kind === 'file' && r.meta.mtime) await fs.promises.utimes(final, new Date(), new Date(r.meta.mtime)).catch(() => {});
    if (made.kind === 'folder' && r.meta.mtime) await fs.promises.utimes(final, new Date(), new Date(r.meta.mtime)).catch(() => {});
    return { output: final, kind: made.kind, name: made.name, renamed: path.basename(final) !== made.name, bytes: r.contentBytes, files: made.sink ? made.sink.stats().files : 1 };
  } catch (e) {
    if (made) {
      if (made.fh) await made.fh.close().catch(() => {});
      if (made.sink) await made.sink.abort().catch(() => {});
      await fs.promises.rm(made.tmp, { recursive: true, force: true }).catch(() => {});
    }
    throw e;
  }
}

module.exports = { EXT, uniquePath, safeName, plan, encryptItem, decryptItem, signature };
