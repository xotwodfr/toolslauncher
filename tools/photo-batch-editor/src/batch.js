'use strict';
// Runs a recipe over many photos, a few at a time: output names from the rename pattern, never over an existing file
// (nor over the original), progress per photo, Cancel. Electron-free.
let fs;
try { fs = require('original-fs'); } catch { fs = require('fs'); }
const os = require('os');
const path = require('path');
const R = require('./recipe');
const P = require('./pipeline');

/**
 * A free path for `base.ext` in `dir`: "base.ext", else "base (2).ext", "base (3).ext"... It is never an existing file,
 * a file being written (.part), a name another job of this batch has taken, or one of the protected (original) paths.
 */
function freePath(dir, base, ext, taken = new Set(), protect = new Set()) {
  const key = (p) => (process.platform === 'win32' || process.platform === 'darwin' ? p.toLowerCase() : p);
  // compare the protected paths the same way (resolved, and without case where the file system ignores it), whatever form the caller gave
  const prot = new Set([...protect].map((x) => key(path.resolve(String(x)))));
  for (let i = 1; i < 100000; i++) {
    const p = path.join(dir, `${base}${i > 1 ? ` (${i})` : ''}.${ext}`);
    if (taken.has(key(p)) || prot.has(key(path.resolve(p))) || fs.existsSync(p) || fs.existsSync(p + '.part')) continue;
    taken.add(key(p));
    return p;
  }
  throw new Error('Could not find a free file name');
}

/**
 * @param {string[]} files
 * @param {object} recipe
 * @param {object} output  (folder '' = an "edited" folder next to each photo)
 * @param {{onItem?:Function, signal?:AbortSignal, jobs?:number, textDrawer?:Function}} o
 * @returns {Promise<{done:number, failed:number, cancelled:number, outputs:string[]}>}
 */
async function runBatch(files, rawRecipe, rawOutput, { onItem, signal, jobs, textDrawer } = {}) {
  const recipe = R.cleanRecipe(rawRecipe);
  const output = R.cleanOutput(rawOutput);
  const size = Math.max(1, Math.min(jobs || output.jobs || Math.max(1, Math.floor((os.cpus().length || 2) / 2)), 8, files.length || 1));
  const taken = new Set();
  const protect = new Set(files.map((f) => {
    const p = path.resolve(f);
    return process.platform === 'win32' || process.platform === 'darwin' ? p.toLowerCase() : p;
  }));
  const logo = P.logoLoader();
  const text = P.textCache(textDrawer);
  const outputs = [];
  let done = 0; let failed = 0; let cancelled = 0; let next = 0;

  async function one(i) {
    const file = files[i];
    if (signal && signal.aborted) { cancelled++; onItem && onItem({ index: i, file, status: 'cancelled' }); return; }
    onItem && onItem({ index: i, file, status: 'working' });
    try {
      const info = await P.inspect(file);
      const fmt = P.outputFormat(output, info.format);
      const dir = output.folder || path.join(path.dirname(file), 'edited');
      fs.mkdirSync(dir, { recursive: true });
      const size_ = R.predictSize(output.autoOrient ? info.width : info.storedWidth, output.autoOrient ? info.height : info.storedHeight, recipe);
      const name = path.basename(file, path.extname(file));
      const date = info.date || fs.statSync(file).mtime;
      const base = R.expandPattern(output.pattern, { name, n: i + 1, date, width: size_.width, height: size_.height });
      const out = freePath(dir, base, R.EXT[fmt], taken, protect);
      const r = await P.processFile(file, recipe, output, { outPath: out, signal, logo, text, info });
      done++; outputs.push(r.path);
      onItem && onItem({ index: i, file, status: 'done', out: r.path, width: r.width, height: r.height, bytes: r.bytes });
    } catch (e) {
      if (e && e.cancelled) { cancelled++; onItem && onItem({ index: i, file, status: 'cancelled' }); }
      else { failed++; onItem && onItem({ index: i, file, status: 'error', error: plainError(e) }); }
    }
  }
  async function worker() { while (next < files.length) { const i = next++; await one(i); } }
  await Promise.all(Array.from({ length: size }, worker));
  return { done, failed, cancelled, outputs };
}

/** sharp/libvips messages in plain words. */
function plainError(e) {
  const m = String((e && e.message) || e);
  if (/unsupported image format|Input file contains unsupported|bad seek|VipsJpeg: Premature|Corrupt|not a known file format/i.test(m)) return 'This file is damaged or is not a photo this tool can read';
  if (/Input image exceeds pixel limit/i.test(m)) return 'This photo is too large to edit (over 268 megapixels)';
  if (/ENOSPC/.test(m)) return 'The disk is full';
  if (/EACCES|EPERM/.test(m)) return 'No permission to write in the output folder';
  if (/ENOENT/.test(m) && !/logo/.test(m)) return 'The file is not there any more';
  return m;
}

module.exports = { freePath, runBatch, plainError };
