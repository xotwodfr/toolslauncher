'use strict';
// Reading files for the diff, and the careful ways of writing: always to "<name>.part" first and then renamed, never over
// a file that is there without a backup or a free name.
let fs;
try { fs = require('original-fs'); } catch { fs = require('fs'); }
const path = require('path');
const crypto = require('crypto');
const E = require('./encoding');

const MAX_TEXT_BYTES = 64 * 1024 * 1024; // bigger files are compared by hash only

function sha256File(file, signal) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const s = fs.createReadStream(file, { highWaterMark: 1 << 20 });
    const onAbort = () => { s.destroy(); const e = new Error('Cancelled'); e.cancelled = true; reject(e); };
    if (signal) { if (signal.aborted) return onAbort(); signal.addEventListener('abort', onAbort, { once: true }); }
    s.on('data', (d) => h.update(d));
    s.on('error', (e) => { if (signal) signal.removeEventListener('abort', onAbort); reject(e); });
    s.on('end', () => { if (signal) signal.removeEventListener('abort', onAbort); resolve(h.digest('hex')); });
  });
}

/** Plain-words reasons for the usual file errors. */
function friendly(e, file) {
  const name = file ? `"${path.basename(file)}"` : 'The file';
  switch (e && e.code) {
    case 'ENOENT': return `${name} is not there any more.`;
    case 'EACCES': case 'EPERM': return `${name} cannot be opened: permission denied.`;
    case 'EISDIR': return `${name} is a folder, not a file.`;
    case 'EBUSY': return `${name} is in use by another program.`;
    case 'ENOSPC': return 'The disk is full.';
    case 'EROFS': return `${name} is on a read-only drive.`;
    default: return String((e && e.message) || e);
  }
}

/**
 * Read a file for comparing. Text (UTF-8 / UTF-16) comes back decoded; anything else, and very big files, come back with
 * only their hash.
 */
async function loadForDiff(file) {
  const st = await fs.promises.stat(file);
  if (!st.isFile()) throw Object.assign(new Error('not a file'), { code: 'EISDIR' });
  const base = { path: file, name: path.basename(file), size: st.size, mtimeMs: st.mtimeMs };
  if (st.size > MAX_TEXT_BYTES) {
    return { ...base, kind: 'binary', encoding: 'binary', tooLarge: true, sha256: await sha256File(file) };
  }
  const buf = await fs.promises.readFile(file);
  const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
  const d = E.detect(buf);
  if (d.encoding === 'binary') return { ...base, kind: 'binary', encoding: 'binary', sha256 };
  return { ...base, kind: 'text', encoding: d.encoding, bom: d.bom, text: d.text, sha256 };
}

/** "<dir>/<stem> (2)<ext>" … the first name that is not taken. */
function freeName(file) {
  if (!fs.existsSync(file)) return file;
  const dir = path.dirname(file); const ext = path.extname(file); const stem = path.basename(file, ext);
  for (let i = 2; i < 10000; i++) {
    const p = path.join(dir, `${stem} (${i})${ext}`);
    if (!fs.existsSync(p)) return p;
  }
  throw new Error('Could not find a free file name');
}

/** Write bytes to "<file>.part", then rename over the target (which must be free or already backed up). */
async function writeAtomic(file, data) {
  const part = file + '.part';
  try {
    await fs.promises.writeFile(part, data);
    await fs.promises.rename(part, file);
  } catch (e) {
    try { await fs.promises.rm(part, { force: true }); } catch { /* ignore */ }
    throw e;
  }
}

/**
 * Overwrite `file` with `data`, keeping the old file as "<file>.bak" (or "<file> (2).bak" … when that is taken).
 * Refuses when the file changed after it was read (size or modified time differ from `expect`).
 * @returns {{ path, backup }}
 */
async function overwriteWithBackup(file, data, expect) {
  const st = await fs.promises.stat(file);
  if (expect && (st.size !== expect.size || Math.abs(st.mtimeMs - expect.mtimeMs) > 1)) {
    throw new Error(`"${path.basename(file)}" changed on disk after it was opened. Open it again before overwriting it.`);
  }
  const backup = freeName(file + '.bak');
  await fs.promises.copyFile(file, backup, fs.constants.COPYFILE_EXCL);
  await writeAtomic(file, data);
  return { path: file, backup };
}

module.exports = { MAX_TEXT_BYTES, sha256File, loadForDiff, freeName, writeAtomic, overwriteWithBackup, friendly };
