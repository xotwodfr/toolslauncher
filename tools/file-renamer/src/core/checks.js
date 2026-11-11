'use strict';
// Checking a batch before anything is renamed: names Windows cannot store, names that are too long, two files that would
// end up with the same name, names that are already taken on disk, and the special cases (a change of letter case only,
// two files swapping names) that need a careful order of renames.
let fs;
try { fs = require('original-fs'); } catch { fs = require('fs'); }
const path = require('path');

const RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i;
// eslint-disable-next-line no-control-regex
const WIN_BAD = /[<>:"/\\|?*\u0000-\u001f]/;
const MAX_NAME = 255;
const MAX_WIN_PATH = 259;

/**
 * Problems with one file name. `strict` = apply the Windows rules as errors (on Windows, or when asked); otherwise they
 * are warnings (the name works here but not on a Windows drive or a USB stick).
 * @returns {{ errors: string[], warnings: string[] }}
 */
function nameProblems(name, { strict = process.platform === 'win32' } = {}) {
  const errors = []; const warnings = [];
  const win = strict ? errors : warnings;
  if (!name) { errors.push('The new name is empty'); return { errors, warnings }; }
  if (name === '.' || name === '..') { errors.push('"." and ".." cannot be used as names'); return { errors, warnings }; }
  if (name.includes('/') || name.includes('\u0000')) errors.push('Names cannot contain "/"');
  const bad = [...new Set([...name].filter((c) => WIN_BAD.test(c) && c !== '/'))];
  if (bad.length) win.push(`Not allowed on Windows: ${bad.map((c) => (c.charCodeAt(0) < 32 ? 'control character' : `"${c}"`)).join(' ')}`);
  if (RESERVED.test(name)) win.push(`"${name.split('.')[0].toUpperCase()}" is a reserved name on Windows`);
  if (/[. ]$/.test(name)) win.push('Windows does not allow a name ending in a dot or a space');
  if (/^\s/.test(name)) warnings.push('Starts with a space');
  if (Buffer.byteLength(name, 'utf8') > MAX_NAME || name.length > MAX_NAME) errors.push(`The name is too long (more than ${MAX_NAME} characters)`);
  return { errors, warnings };
}

/** Does this folder treat "A" and "a" as the same name? Tested with a real file in it (cached per folder). */
function caseInsensitiveDir(dir, sampleName, cache) {
  if (cache && cache.has(dir)) return cache.get(dir);
  let result = process.platform === 'win32' || process.platform === 'darwin';
  const flipped = sampleName && flipCase(sampleName);
  if (flipped && flipped !== sampleName) {
    try {
      const a = fs.statSync(path.join(dir, sampleName));
      let b = null; try { b = fs.statSync(path.join(dir, flipped)); } catch { b = null; }
      result = !!(b && a.ino === b.ino && a.dev === b.dev);
    } catch { /* keep the platform guess */ }
  }
  if (cache) cache.set(dir, result);
  return result;
}
function flipCase(s) {
  const i = [...s].findIndex((c) => c.toLowerCase() !== c.toUpperCase());
  if (i < 0) return null;
  const c = [...s];
  c[i] = c[i] === c[i].toLowerCase() ? c[i].toUpperCase() : c[i].toLowerCase();
  return c.join('');
}

/**
 * Check a whole batch.
 * @param items  [{ id, path, newName }] (newName is just the name; the folder stays the same)
 * @param opts   { strict, autoSuffix, listDir(dir) -> Set of names (lower-case on case-insensitive folders), ciDirs }
 * @returns rows [{ id, from, to, newName, status: 'same'|'ok'|'error', errors, warnings, caseOnly, swap }]
 */
function checkBatch(items, opts = {}) {
  const ciCache = opts.ciDirs || new Map();
  const listCache = new Map();
  const listDir = (dir) => {
    if (listCache.has(dir)) return listCache.get(dir);
    let names = [];
    try { names = opts.listDir ? opts.listDir(dir) : fs.readdirSync(dir); } catch { names = []; }
    const set = new Map(); // key -> real name
    const ci = caseInsensitiveDir(dir, names[0], ciCache);
    for (const n of names) set.set(ci ? n.toLowerCase() : n, n);
    const v = { ci, names: set };
    listCache.set(dir, v);
    return v;
  };
  const keyOf = (dir, name) => { const d = listDir(dir); return dir + '\u0000' + (d.ci ? name.toLowerCase() : name); };

  const rows = items.map((it) => {
    const dir = path.dirname(it.path); const oldName = path.basename(it.path);
    return { id: it.id, dir, oldName, from: it.path, newName: it.newName, to: path.join(dir, it.newName), status: 'ok', errors: [...(it.ruleErrors || [])], warnings: [], caseOnly: false, swap: false };
  });
  // which names are being given up by the batch (a file that is renamed frees its old name)
  const leaving = new Set();
  for (const r of rows) if (r.newName !== r.oldName) leaving.add(keyOf(r.dir, r.oldName));

  // names in the batch, to find duplicates; auto-suffix gives later duplicates " (2)", " (3)" …
  const taken = new Map();
  for (const r of rows) {
    if (r.newName === r.oldName && !r.errors.length) { r.status = 'same'; }
    const p = nameProblems(r.newName, { strict: opts.strict });
    r.errors.push(...p.errors); r.warnings.push(...p.warnings);
    if (r.status === 'same') { taken.set(keyOf(r.dir, r.newName), r); continue; }
    const d = listDir(r.dir);
    r.caseOnly = d.ci && r.newName.toLowerCase() === r.oldName.toLowerCase();
    const occupied = (name) => {
      const k = keyOf(r.dir, name);
      if (taken.has(k)) return 'batch';
      const onDisk = d.names.has(d.ci ? name.toLowerCase() : name);
      if (onDisk && !leaving.has(k) && !(r.caseOnly && name.toLowerCase() === r.oldName.toLowerCase())) return 'disk';
      return null;
    };
    let clash = occupied(r.newName);
    if (clash && opts.autoSuffix && !r.errors.length) {
      const dot = r.newName.lastIndexOf('.');
      const stem = dot > 0 ? r.newName.slice(0, dot) : r.newName; const ext = dot > 0 ? r.newName.slice(dot) : '';
      for (let n = 2; n < 10000 && clash; n++) {
        const cand = `${stem} (${n})${ext}`;
        if (!occupied(cand)) { r.newName = cand; r.to = path.join(r.dir, cand); r.warnings.push(`Renamed to "${cand}" to avoid a clash`); clash = null; }
      }
      r.caseOnly = d.ci && r.newName.toLowerCase() === r.oldName.toLowerCase();
    }
    if (clash === 'batch') {
      const other = taken.get(keyOf(r.dir, r.newName));
      r.errors.push('Another file in the list gets the same name');
      if (other && other.status !== 'error') { other.errors.push('Another file in the list gets the same name'); }
    } else if (clash === 'disk') r.errors.push('A file with this name already exists in the folder');
    taken.set(keyOf(r.dir, r.newName), r);
    if (process.platform === 'win32' && r.to.length > MAX_WIN_PATH) r.warnings.push(`The full path is longer than ${MAX_WIN_PATH} characters; some programs cannot open it`);
  }
  for (const r of rows) { if (r.errors.length) r.status = 'error'; else if (r.status !== 'same') r.status = 'ok'; }
  // swaps and chains: the new name belongs to another file of the batch right now
  const byOld = new Map(rows.map((r) => [keyOf(r.dir, r.oldName), r]));
  for (const r of rows) {
    if (r.status !== 'ok' || r.caseOnly) continue;
    const owner = byOld.get(keyOf(r.dir, r.newName));
    if (owner && owner !== r) r.swap = true;
  }
  return rows;
}

function summarize(rows) {
  const s = { total: rows.length, rename: 0, same: 0, errors: 0, warnings: 0 };
  for (const r of rows) { if (r.status === 'error') s.errors++; else if (r.status === 'same') s.same++; else s.rename++; if (r.warnings.length) s.warnings++; }
  return s;
}

module.exports = { nameProblems, checkBatch, summarize, caseInsensitiveDir, flipCase, RESERVED, MAX_NAME };
