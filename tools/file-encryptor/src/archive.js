'use strict';
// A tiny, documented folder archive (like tar, but simpler): the folder tree becomes ONE byte stream that is then
// encrypted as a single .locked file. Records, all integers big-endian:
//   u8 type (1 = folder, 2 = file, 0 = end) | u16 path length | path (UTF-8, "/"-separated, relative) |
//   files only: u64 size | u64 modified time (ms since 1970) | the file's bytes
// Unpacking never writes outside the target folder: absolute paths, "..", empty parts, drive letters and control
// characters are refused, and names Windows cannot store are made safe.
const fs = require('fs');
const path = require('path');

const T_END = 0; const T_DIR = 1; const T_FILE = 2;
const MAX_PATH = 4096;

/** Walks a folder: [{ rel, abs, type, size, mtimeMs }], folders before their contents; links and specials are skipped. */
async function walk(root, signal) {
  const out = []; const skipped = [];
  async function visit(abs, rel) {
    if (signal && signal.aborted) return;
    let names;
    try { names = await fs.promises.readdir(abs, { withFileTypes: true }); } catch (e) { throw new Error(`Could not read the folder “${rel || path.basename(abs)}” (${e.code || e.message}).`); }
    names.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const d of names) {
      const a = path.join(abs, d.name); const r = rel ? rel + '/' + d.name : d.name;
      if (d.isSymbolicLink()) { skipped.push(r + ' (a link)'); continue; }
      if (d.isDirectory()) { out.push({ rel: r, abs: a, type: 'dir' }); await visit(a, r); }
      else if (d.isFile()) { const st = await fs.promises.stat(a); out.push({ rel: r, abs: a, type: 'file', size: st.size, mtimeMs: Math.floor(st.mtimeMs) }); }
      else skipped.push(r + ' (not a regular file)');
    }
  }
  await visit(root, '');
  return { entries: out, skipped };
}

function record(type, rel, size, mtime) {
  const p = Buffer.from(rel, 'utf8');
  if (p.length > MAX_PATH) throw new Error('A path inside the folder is too long: ' + rel.slice(0, 80) + '…');
  const b = Buffer.alloc(3 + p.length + (type === T_FILE ? 16 : 0));
  b.writeUInt8(type, 0); b.writeUInt16BE(p.length, 1); p.copy(b, 3);
  if (type === T_FILE) { b.writeBigUInt64BE(BigInt(size), 3 + p.length); b.writeBigUInt64BE(BigInt(Math.max(0, mtime || 0)), 11 + p.length); }
  return b;
}

/** The archive as an async iterable of Buffers. A file that changes size while it is read is an error. */
async function* pack(entries, signal) {
  for (const e of entries) {
    if (signal && signal.aborted) return;
    if (e.type === 'dir') { yield record(T_DIR, e.rel); continue; }
    yield record(T_FILE, e.rel, e.size, e.mtimeMs);
    let got = 0;
    const stream = fs.createReadStream(e.abs, { highWaterMark: 1 << 20, end: e.size > 0 ? e.size - 1 : undefined, start: 0 });
    if (e.size > 0) {
      for await (const chunk of stream) { got += chunk.length; yield chunk; if (signal && signal.aborted) { stream.destroy(); return; } }
    } else stream.destroy();
    const st = await fs.promises.stat(e.abs).catch(() => null);
    if (got !== e.size || !st || st.size !== e.size || Math.floor(st.mtimeMs) !== e.mtimeMs) throw new Error(`“${e.rel}” changed while it was being encrypted. Try again when nothing is writing to it.`);
  }
  yield Buffer.from([T_END]);
}

const WIN_BAD = /[<>:"|?*\u0000-\u001f]/g;
const WIN_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
/** Validates a path from an archive and returns its safe parts, or throws. */
function safeParts(rel, platform = process.platform) {
  if (typeof rel !== 'string' || !rel || rel.includes('\\') || rel.startsWith('/') || /^[a-zA-Z]:/.test(rel) || /[\u0000-\u001f]/.test(rel)) throw new Error('The archive contains an unsafe path: ' + JSON.stringify(rel).slice(0, 100));
  const parts = rel.split('/');
  if (parts.some((p) => !p || p === '.' || p === '..')) throw new Error('The archive contains an unsafe path: ' + JSON.stringify(rel).slice(0, 100));
  if (platform !== 'win32') return parts;
  return parts.map((p) => { let s = p.replace(WIN_BAD, '_').replace(/[. ]+$/, (m) => '_'.repeat(m.length)); if (WIN_RESERVED.test(s)) s = '_' + s; return s; });
}

/**
 * A sink that unpacks the archive stream into `root` (which must exist and be empty): write(buf) as data arrives, end()
 * when done. Files are created with 'wx' (never replacing anything) and get their modified time back.
 */
function unpacker(root, { platform = process.platform } = {}) {
  const rootAbs = path.resolve(root);
  let buf = Buffer.alloc(0);
  let state = 'head'; let cur = null; let done = false; let files = 0; let dirs = 0;
  const target = (rel) => {
    const abs = path.resolve(rootAbs, ...safeParts(rel, platform));
    if (abs !== rootAbs && !abs.startsWith(rootAbs + path.sep)) throw new Error('The archive contains a path outside its folder.');
    return abs;
  };
  async function finishFile() {
    await cur.fh.close();
    if (cur.mtime) await fs.promises.utimes(cur.abs, new Date(), new Date(cur.mtime)).catch(() => {});
    files++; cur = null; state = 'head';
  }
  async function write(data) {
    buf = buf.length ? Buffer.concat([buf, data]) : data;
    for (;;) {
      if (done) { if (buf.length) throw new Error('The archive has data after its end.'); return; }
      if (state === 'head') {
        if (buf.length < 1) return;
        const type = buf[0];
        if (type === T_END) { done = true; buf = buf.subarray(1); continue; }
        if (type !== T_DIR && type !== T_FILE) throw new Error('The archive is damaged (unknown record).');
        if (buf.length < 3) return;
        const plen = buf.readUInt16BE(1);
        const need = 3 + plen + (type === T_FILE ? 16 : 0);
        if (plen === 0 || plen > MAX_PATH) throw new Error('The archive is damaged (bad path length).');
        if (buf.length < need) return;
        const rel = buf.subarray(3, 3 + plen).toString('utf8');
        const abs = target(rel);
        if (type === T_DIR) {
          await fs.promises.mkdir(abs, { recursive: true }); dirs++;
          buf = buf.subarray(need);
          continue;
        }
        const size = Number(buf.readBigUInt64BE(3 + plen));
        const mtime = Number(buf.readBigUInt64BE(11 + plen));
        await fs.promises.mkdir(path.dirname(abs), { recursive: true });
        let fh;
        try { fh = await fs.promises.open(abs, 'wx'); } catch (e) { if (e.code === 'EEXIST') throw new Error(`The folder contains two files that would get the same name here: “${rel}”.`); throw e; }
        cur = { fh, abs, left: size, mtime, pos: 0 };
        buf = buf.subarray(need);
        state = 'data';
        if (size === 0) await finishFile();
        continue;
      }
      if (state === 'data') {
        if (!buf.length) return;
        const n = Math.min(cur.left, buf.length);
        await cur.fh.write(buf, 0, n, cur.pos);
        cur.pos += n; cur.left -= n;
        buf = buf.subarray(n);
        if (cur.left === 0) await finishFile();
      }
    }
  }
  async function end() {
    if (cur) { await cur.fh.close().catch(() => {}); cur = null; }
    if (!done) throw new Error('The archive is incomplete.');
  }
  async function abort() { if (cur) { await cur.fh.close().catch(() => {}); cur = null; } }
  return { write, end, abort, stats: () => ({ files, dirs }) };
}

module.exports = { walk, pack, unpacker, safeParts, T_END, T_DIR, T_FILE };
