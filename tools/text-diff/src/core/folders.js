'use strict';
// Comparing two folders, and copying files from one side to the other.
//  compareFolders(left, right, opts) -> { entries, counts }
//    each entry: { rel, name, depth, type: 'file'|'dir', left, right, status, note }
//    status: 'same' | 'different' | 'left' (only on the left) | 'right' (only on the right) | 'error'
//    quick mode: same size and modified time (within 2 s, for FAT drives) = same; content mode: same size and SHA-256.
//  planCopy(result, rels, dir) / runCopy(plan, { trash }) copy the chosen files left->right or right->left. A file that is
//    replaced goes to the Recycle Bin first (the caller passes shell.trashItem); nothing is ever deleted for good.
let fs;
try { fs = require('original-fs'); } catch { fs = require('fs'); }
const path = require('path');
const { sha256File } = require('./files');

const DEFAULT_IGNORE = ['.git', 'node_modules', '.DS_Store', 'Thumbs.db', 'desktop.ini'];
const MAX_ENTRIES = 300000;
const MTIME_SLACK = 2000;

// ---- ignore patterns ------------------------------------------------------------------------------------------------------
function globToRegExp(glob, ci) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') { re += '.*'; i++; if (glob[i + 1] === '/') i++; }
      else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp('^' + re + '$', ci ? 'i' : '');
}

/** Patterns like `node_modules`, `*.log`, `build/` (folders only), `docs/*.tmp` (from the top of the folder). */
function makeIgnore(patterns, ci = process.platform === 'win32') {
  const rules = [];
  for (let p of patterns || []) {
    p = String(p).trim().replace(/\\/g, '/');
    if (!p || p.startsWith('#')) continue;
    const dirOnly = p.endsWith('/');
    if (dirOnly) p = p.replace(/\/+$/, '');
    if (p.startsWith('/')) p = p.slice(1);
    const anchored = p.includes('/');
    rules.push({ re: globToRegExp(p, ci), dirOnly, anchored });
  }
  return (rel, isDir) => rules.some((r) => (!r.dirOnly || isDir) && r.re.test(r.anchored ? rel : rel.slice(rel.lastIndexOf('/') + 1)));
}

// ---- walking --------------------------------------------------------------------------------------------------------------
async function listDir(dir) {
  try { return await fs.promises.readdir(dir, { withFileTypes: true }); } catch (e) { return { error: e }; }
}

function cancelled() { const e = new Error('Cancelled'); e.cancelled = true; return e; }

async function compareFolders(leftRoot, rightRoot, opts = {}) {
  const mode = opts.mode === 'content' ? 'content' : 'quick';
  const ci = opts.caseInsensitive != null ? !!opts.caseInsensitive : process.platform === 'win32';
  const ignored = makeIgnore(opts.ignore == null ? DEFAULT_IGNORE : opts.ignore, ci);
  const signal = opts.signal;
  const progress = opts.onProgress || (() => {});
  const entries = [];
  const hashJobs = [];
  let seen = 0;

  const statOf = async (p) => { try { const s = await fs.promises.lstat(p); return s; } catch { return null; } };

  async function walk(rel, lRel, rRel, depth, haveL, haveR, self) {
    if (signal && signal.aborted) throw cancelled();
    const lDir = haveL ? path.join(leftRoot, lRel) : null;
    const rDir = haveR ? path.join(rightRoot, rRel) : null;
    const [lList, rList] = await Promise.all([haveL ? listDir(lDir) : [], haveR ? listDir(rDir) : []]);
    const byKey = new Map();
    const add = (list, side) => {
      if (!Array.isArray(list)) return;
      for (const d of list) {
        const key = ci ? d.name.toLowerCase() : d.name;
        let e = byKey.get(key);
        if (!e) { e = { name: d.name }; byKey.set(key, e); }
        e[side] = d;
      }
    };
    add(lList, 'l'); add(rList, 'r');
    const names = [...byKey.values()].sort((a, b) => {
      const da = isDirent(a.l || a.r); const db = isDirent(b.l || b.r);
      if (da !== db) return da ? -1 : 1;
      return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
    });
    const childStatuses = [];
    if (!Array.isArray(lList) || !Array.isArray(rList)) { childStatuses.push('error'); if (self) { self.listError = true; self.note = 'Could not be read'; } }
    for (const n of names) {
      if (entries.length >= MAX_ENTRIES) { const e = new Error(`More than ${MAX_ENTRIES.toLocaleString('en')} files and folders: choose smaller folders or add ignore patterns.`); throw e; }
      const childRel = rel ? rel + '/' + n.name : n.name;
      const lrel = (lRel ? lRel + '/' : '') + (n.l ? n.l.name : n.name);
      const rrel = (rRel ? rRel + '/' : '') + (n.r ? n.r.name : n.name);
      const lIsDir = n.l ? n.l.isDirectory() : null; const rIsDir = n.r ? n.r.isDirectory() : null;
      const isDir = !!(lIsDir || rIsDir);
      if (ignored(childRel, isDir)) continue;
      const skipLink = (n.l && n.l.isSymbolicLink()) || (n.r && n.r.isSymbolicLink());
      const entry = { rel: childRel, lrel, rrel, name: n.name, depth, type: isDir ? 'dir' : 'file', left: null, right: null, status: 'same', note: '' };
      entries.push(entry);
      seen++;
      if (seen % 500 === 0) progress({ seen });
      if (skipLink) { entry.type = 'file'; entry.status = 'error'; entry.note = 'Link or shortcut: not followed'; childStatuses.push('error'); continue; }
      if (n.l && n.r && lIsDir !== rIsDir) {
        entry.status = 'error'; entry.note = lIsDir ? 'A folder on the left, a file on the right' : 'A file on the left, a folder on the right';
        childStatuses.push('error'); continue;
      }
      if (isDir) {
        if (n.l) entry.left = { name: n.l.name };
        if (n.r) entry.right = { name: n.r.name };
        const st = await walk(childRel, lrel, rrel, depth + 1, !!n.l, !!n.r, entry);
        entry.status = !n.r ? 'left' : !n.l ? 'right' : st;
        childStatuses.push(entry.status);
        continue;
      }
      const [ls, rs] = await Promise.all([n.l ? statOf(path.join(leftRoot, lrel)) : null, n.r ? statOf(path.join(rightRoot, rrel)) : null]);
      if (ls) entry.left = { name: n.l.name, size: ls.size, mtimeMs: ls.mtimeMs };
      if (rs) entry.right = { name: n.r.name, size: rs.size, mtimeMs: rs.mtimeMs };
      if ((n.l && !ls) || (n.r && !rs)) { entry.status = 'error'; entry.note = 'Could not be read'; }
      else if (!ls) entry.status = 'right';
      else if (!rs) entry.status = 'left';
      else if (ls.size !== rs.size) entry.status = 'different';
      else if (mode === 'quick') {
        if (Math.abs(ls.mtimeMs - rs.mtimeMs) <= MTIME_SLACK) entry.status = 'same';
        else { entry.status = 'different'; entry.note = 'Same size, different date'; }
      } else if (ls.size === 0) entry.status = 'same';
      else { entry.status = 'pending'; hashJobs.push(entry); }
      childStatuses.push(entry.status);
    }
    if (childStatuses.some((s) => s === 'pending')) return 'pending';
    return childStatuses.every((s) => s === 'same') ? 'same' : 'different';
  }

  const top = await walk('', '', '', 0, true, true, null);

  if (hashJobs.length) {
    let next = 0; let done = 0;
    const worker = async () => {
      while (next < hashJobs.length) {
        if (signal && signal.aborted) throw cancelled();
        const e = hashJobs[next++];
        try {
          const [a, b] = await Promise.all([sha256File(path.join(leftRoot, e.lrel), signal), sha256File(path.join(rightRoot, e.rrel), signal)]);
          e.status = a === b ? 'same' : 'different';
        } catch (err) {
          if (err && err.cancelled) throw err;
          e.status = 'error'; e.note = 'Could not be read';
        }
        done++;
        if (done % 20 === 0) progress({ seen, hashed: done, toHash: hashJobs.length });
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, hashJobs.length) }, worker));
    resolveFolderStatuses(entries);
  } else if (top === 'pending') resolveFolderStatuses(entries);

  const counts = { same: 0, different: 0, left: 0, right: 0, error: 0 };
  for (const e of entries) if (e.type === 'file') counts[e.status] = (counts[e.status] || 0) + 1;
  return { left: leftRoot, right: rightRoot, mode, entries, counts };
}

function isDirent(d) { return !!(d && d.isDirectory()); }

/** After hashing, a folder on both sides is the same only when everything inside it is. */
function resolveFolderStatuses(entries) {
  const allSame = new Map(); // folder rel -> false once a child is not the same
  for (let i = entries.length - 1; i >= 0; i--) { // depth-first order backwards: children are settled before their folder
    const e = entries[i];
    if (e.type === 'dir' && e.left && e.right) e.status = e.listError || allSame.get(e.rel) === false ? 'different' : 'same';
    const parent = e.rel.includes('/') ? e.rel.slice(0, e.rel.lastIndexOf('/')) : '';
    if (e.status !== 'same') allSame.set(parent, false);
  }
}

// ---- copying ----------------------------------------------------------------------------------------------------------------
function inside(root, rel) {
  const full = path.resolve(root, rel);
  const r = path.resolve(root);
  return full.startsWith(r.endsWith(path.sep) ? r : r + path.sep) ? full : null;
}

/**
 * What copying the chosen entries would do. `dir` is 'ltr' (left to right) or 'rtl'. Chosen folders take everything
 * inside them that is not the same on both sides. Files that are the same are skipped.
 */
function planCopy(result, rels, dir) {
  const fromKey = dir === 'rtl' ? 'right' : 'left';
  const toKey = dir === 'rtl' ? 'left' : 'right';
  const fromRoot = result[fromKey]; const toRoot = result[toKey];
  const chosen = new Set(rels);
  const items = []; const dirs = []; const seen = new Set();
  const under = (rel) => { for (let p = rel; p.includes('/');) { p = p.slice(0, p.lastIndexOf('/')); if (chosen.has(p)) return true; } return false; };
  for (const e of result.entries) {
    if (!chosen.has(e.rel) && !under(e.rel)) continue;
    if (!e[fromKey] || e.status === 'same' || e.status === 'error') continue;
    const from = inside(fromRoot, e[fromKey === 'left' ? 'lrel' : 'rrel'] || e.rel); const to = inside(toRoot, e[toKey === 'left' ? 'lrel' : 'rrel'] || e.rel);
    if (!from || !to || seen.has(e.rel)) continue;
    seen.add(e.rel);
    if (e.type === 'dir') { if (!e[toKey]) dirs.push({ rel: e.rel, to }); continue; }
    items.push({ rel: e.rel, from, to, replaces: !!e[toKey], size: e[fromKey].size || 0, expect: e[fromKey] });
  }
  return { dir, fromRoot, toRoot, items, dirs, replacing: items.filter((i) => i.replaces).length, bytes: items.reduce((n, i) => n + i.size, 0) };
}

/**
 * Copy the planned files. Each file goes to "<target>.part" first; the file it replaces is moved to the Recycle Bin
 * (`trash(path)`), then the copy is renamed into place and given the original's modified time.
 */
async function runCopy(plan, { trash, onProgress, signal } = {}) {
  if (typeof trash !== 'function') throw new Error('No Recycle Bin available');
  const done = []; const failed = [];
  for (const d of plan.dirs) { try { await fs.promises.mkdir(d.to, { recursive: true }); } catch (e) { failed.push({ rel: d.rel, error: e.message }); } }
  let i = 0;
  for (const it of plan.items) {
    if (signal && signal.aborted) break;
    const part = it.to + '.part';
    try {
      const st = await fs.promises.stat(it.from);
      if (it.expect && it.expect.size != null && (st.size !== it.expect.size || Math.abs(st.mtimeMs - it.expect.mtimeMs) > 1)) {
        throw new Error('changed since the comparison; compare again first');
      }
      await fs.promises.mkdir(path.dirname(it.to), { recursive: true });
      await fs.promises.copyFile(it.from, part);
      await fs.promises.utimes(part, st.atime, st.mtime);
      if (fs.existsSync(it.to)) await trash(it.to);
      await fs.promises.rename(part, it.to);
      done.push(it.rel);
    } catch (e) {
      try { await fs.promises.rm(part, { force: true }); } catch { /* ignore */ }
      failed.push({ rel: it.rel, error: String((e && e.message) || e) });
    }
    i++;
    if (onProgress) onProgress({ done: i, total: plan.items.length });
  }
  return { done, failed };
}

module.exports = { compareFolders, planCopy, runCopy, makeIgnore, globToRegExp, DEFAULT_IGNORE, inside };
