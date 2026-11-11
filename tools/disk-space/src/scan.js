'use strict';
// The folder scanner. Electron-free; runs inside a worker thread (src/worker.js) and directly in the tests.
//  - iterative (an explicit stack), so very deep folders cannot overflow anything
//  - size = the space the file takes on the disk where the system says so (blocks x 512 on Linux / macOS), else its length
//  - symbolic links and Windows junctions are counted but never followed (no loops, nothing counted twice)
//  - a file with several hard links is counted once (device + inode)
//  - folders that cannot be read are counted and listed, and the scan goes on
//  - by default it stays on the drive it started on (other drives mounted inside are listed, not entered)
const fsDefault = require('fs');
const path = require('path');
const T = require('./types');

const NG = T.GROUPS.length;
const KEEP_FILES = 64;         // files listed one by one per folder; the smaller rest of a folder is one "N smaller files" block
const TOP_FILES = 200;
const MAX_ERRORS = 500;
const MAX_HARD = 300000;
const PSEUDO = new Set(['/proc', '/sys', '/dev', '/run/user']);

const PARENT = Symbol('parent'); // not part of the JSON
function newDir(name) { return { n: name, s: 0, f: 0, d: 0, g: new Array(NG).fill(0), c: [] }; }

class MinHeap {
  constructor(limit) { this.a = []; this.limit = limit; }
  min() { return this.a.length ? this.a[0].s : -1; }
  push(item) {
    const a = this.a;
    if (a.length >= this.limit) { if (item.s <= a[0].s) return; a[0] = item; this.down(0); return; }
    a.push(item); let i = a.length - 1;
    while (i > 0) { const p = (i - 1) >> 1; if (a[p].s <= a[i].s) break; [a[p], a[i]] = [a[i], a[p]]; i = p; }
  }
  down(i) {
    const a = this.a;
    for (;;) {
      const l = 2 * i + 1; const r = l + 1; let m = i;
      if (l < a.length && a[l].s < a[m].s) m = l;
      if (r < a.length && a[r].s < a[m].s) m = r;
      if (m === i) return; [a[m], a[i]] = [a[i], a[m]]; i = m;
    }
  }
  sorted() { return [...this.a].sort((x, y) => y.s - x.s); }
}

/**
 * @param {string} root  an absolute folder path
 * @param {object} [o]
 * @param {boolean} [o.oneDrive=true]  do not enter other drives mounted inside
 * @param {() => boolean} [o.shouldStop]
 * @param {(p:object) => void} [o.onProgress]   about 5 times a second
 * @param {(snap:string) => void} [o.onSnapshot]  about once a second: the tree so far (JSON, big items only)
 * @param {string[]} [o.seen]   "dev:inode" of hard-linked files already counted elsewhere (when rescanning one folder)
 * @param {number} [o.delayMs]   test hook: wait this long after each folder (makes Cancel testable)
 * @param {object} [o.fs]        test hook: a replacement fs
 * @param {string} [o.platform]
 */
function scan(root, o = {}) {
  const fs = o.fs || fsDefault;
  const platform = o.platform || process.platform;
  const useBlocks = platform !== 'win32';
  const oneDrive = o.oneDrive !== false;
  const t0 = Date.now();
  root = path.resolve(root);
  const rootStat = fs.statSync(root);   // follow a link given as the starting point itself
  if (!rootStat.isDirectory()) throw new Error('That is not a folder.');
  const tree = newDir(root);
  const stats = { files: 0, dirs: 0, bytes: 0, apparent: 0, links: 0, hardlinks: 0, otherDrives: 0, skipped: 0, errors: [] };
  const exts = new Map();
  const top = new MinHeap(TOP_FILES);
  const seenInodes = new Set(Array.isArray(o.seen) ? o.seen : []);
  const hard = []; // [key, path] of each hard-linked file counted here, so a later rescan of one folder does not count it again
  const rootDev = rootStat.dev;
  let stopped = false;
  let current = root;
  let lastProgress = 0; let lastSnap = Date.now();
  let ticks = 0;
  const sleepArr = o.delayMs ? new Int32Array(new SharedArrayBuffer(4)) : null;

  const fail = (p, e) => {
    stats.skipped++;
    if (stats.errors.length < MAX_ERRORS) stats.errors.push({ path: p, code: (e && e.code) || 'ERROR', message: plainError(e) });
  };
  const progress = (force) => {
    const now = Date.now();
    if (o.onProgress && (force || now - lastProgress >= 200)) { lastProgress = now; o.onProgress({ files: stats.files, dirs: stats.dirs, bytes: stats.bytes, skipped: stats.skipped, current, ms: now - t0 }); }
    if (o.onSnapshot && now - lastSnap >= 1000) { lastSnap = now; o.onSnapshot(snapshot(tree, stats.bytes)); }
  };

  // stack of [node, absolute path]; each folder knows its parent through a symbol key, so deep trees cost nothing extra
  const stack = [[tree, root]];
  while (stack.length) {
    if (o.shouldStop && o.shouldStop()) { stopped = true; break; }
    const [node, dir] = stack.pop();
    current = dir;
    stats.dirs++;
    let names;
    try { names = fs.readdirSync(dir); } catch (e) { node.e = e.code || 'ERROR'; fail(dir, e); progress(); continue; }
    const files = [];
    let sum = 0; let count = 0; const gsum = new Array(NG).fill(0);
    const subdirs = [];
    for (const name of names) {
      if ((++ticks & 255) === 0) { if (o.shouldStop && o.shouldStop()) { stopped = true; break; } progress(); }
      const full = path.join(dir, name);
      let st;
      try { st = fs.lstatSync(full); } catch (e) { fail(full, e); continue; }
      if (st.isSymbolicLink()) { stats.links++; continue; }
      if (st.isDirectory()) {
        if ((oneDrive && st.dev !== rootDev) || (platform !== 'win32' && PSEUDO.has(full))) { stats.otherDrives++; const m = newDir(name); m.l = 'drive'; node.c.push(m); continue; }
        const child = newDir(name);
        child[PARENT] = node;
        node.c.push(child);
        subdirs.push(child);
        continue;
      }
      if (!st.isFile()) continue; // sockets, devices, pipes
      if (st.nlink > 1) {
        const key = st.dev + ':' + st.ino;
        if (seenInodes.has(key)) { stats.hardlinks++; continue; }
        seenInodes.add(key);
        if (hard.length < MAX_HARD) hard.push([key, full]);
      }
      const size = useBlocks && typeof st.blocks === 'number' && st.blocks >= 0 ? st.blocks * 512 : st.size;
      const k = T.groupOf(name);
      files.push({ n: name, s: size, k });
      sum += size; count++; gsum[k] += size;
      stats.apparent += st.size;
      const e = T.extOf(name);
      const x = exts.get(e); if (x) { x.s += size; x.n++; } else exts.set(e, { s: size, n: 1, k });
      if (size > top.min() || top.a.length < TOP_FILES) top.push({ p: full, s: size, k });
    }
    // keep the biggest files of this folder by name; the rest are one block
    files.sort((a, b) => b.s - a.s);
    if (files.length > KEEP_FILES) {
      const rest = files.splice(KEEP_FILES);
      node.o = { n: rest.length, s: rest.reduce((t, f) => t + f.s, 0) };
    }
    for (const f of files) node.c.push(f);
    stats.files += count; stats.bytes += sum;
    for (let a = node; a; a = a[PARENT]) { a.s += sum; a.f += count; a.d += subdirs.length; for (let g = 0; g < NG; g++) a.g[g] += gsum[g]; }
    for (let i = subdirs.length - 1; i >= 0; i--) stack.push([subdirs[i], path.join(dir, subdirs[i].n)]);
    if (stopped) break;
    if (sleepArr) Atomics.wait(sleepArr, 0, 0, o.delayMs);
    progress();
  }
  if (stopped) for (const [node] of stack) node.u = 1; // not scanned (cancelled)
  sortTree(tree);
  current = '';
  progress(true);
  return {
    tree, partial: stopped, ms: Date.now() - t0, root,
    stats,
    largest: top.sorted(),
    hard,
    exts: [...exts.entries()].map(([e, v]) => ({ e, s: v.s, n: v.n, k: v.k })).sort((a, b) => b.s - a.s),
  };
}

function sortTree(tree) {
  const stack = [tree];
  while (stack.length) {
    const n = stack.pop();
    n.c.sort((a, b) => b.s - a.s);
    for (const c of n.c) if (c.c) stack.push(c);
  }
}

/** the tree so far, only the parts big enough to see (for the live view while scanning) */
function snapshot(tree, total) {
  const min = Math.max(1, total / 4000);
  const copy = (n, depth) => {
    const out = { n: n.n, s: n.s, f: n.f, d: n.d, g: n.g, c: [] };
    if (n.c) {
      const kids = n.c.filter((c) => c.s >= min).sort((a, b) => b.s - a.s).slice(0, 300);
      for (const c of kids) out.c.push(c.c ? (depth < 5 ? copy(c, depth + 1) : { n: c.n, s: c.s, f: c.f, d: c.d, g: c.g, c: [] }) : { n: c.n, s: c.s, k: c.k });
    }
    return out;
  };
  return JSON.stringify(copy(tree, 0));
}

function plainError(e) {
  const code = e && e.code;
  if (code === 'EACCES' || code === 'EPERM') return 'No permission to look inside';
  if (code === 'ENOENT') return 'It disappeared during the scan';
  if (code === 'EBUSY') return 'In use by the system';
  if (code === 'ELOOP') return 'Too many links';
  if (code === 'ENAMETOOLONG') return 'The path is too long';
  return String((e && e.message) || e || 'Could not be read');
}

module.exports = { scan, snapshot, KEEP_FILES, TOP_FILES, MinHeap };
