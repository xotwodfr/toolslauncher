'use strict';
// Finds files with exactly the same content: group by size, then by a quick fingerprint of the start and end, then by a
// full SHA-256 of the whole file. Only files that survive each step are read in full, so most of a big folder is never
// read at all.
let fs;
try { fs = require('original-fs'); } catch { fs = require('fs'); }
const crypto = require('crypto');
const Cache = require('./cache');

const QUICK = 65536;              // bytes read from the start and from the end for the quick fingerprint
const CONCURRENCY = 4;
const cancelled = () => Object.assign(new Error('Cancelled'), { cancelled: true });

/** Run fn over items, a few at a time. */
async function pool(items, fn, signal) {
  let next = 0;
  const worker = async () => {
    for (;;) {
      if (signal && signal.aborted) throw cancelled();
      const i = next++;
      if (i >= items.length) return;
      await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, worker));
}

async function quickHash(rec) {
  const fh = await fs.promises.open(rec.path, 'r');
  try {
    const h = crypto.createHash('sha1');
    h.update(String(rec.size));
    const head = Buffer.alloc(Math.min(QUICK, rec.size));
    await fh.read(head, 0, head.length, 0);
    h.update(head);
    if (rec.size > QUICK * 2) {
      const tail = Buffer.alloc(QUICK);
      await fh.read(tail, 0, QUICK, rec.size - QUICK);
      h.update(tail);
    }
    return h.digest('hex');
  } finally { await fh.close(); }
}

function fullHash(rec, signal, onBytes) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const s = fs.createReadStream(rec.path, { highWaterMark: 1 << 20 });
    const onAbort = () => s.destroy(cancelled());
    if (signal) { if (signal.aborted) { s.destroy(); return reject(cancelled()); } signal.addEventListener('abort', onAbort, { once: true }); }
    s.on('data', (d) => { h.update(d); if (onBytes) onBytes(d.length); });
    s.on('error', (e) => { if (signal) signal.removeEventListener('abort', onAbort); reject(e); });
    s.on('end', () => { if (signal) signal.removeEventListener('abort', onAbort); resolve(h.digest('hex')); });
  });
}

/**
 * @param files  [{ path, size, mtimeMs, keep }]
 * @param opts   { signal, onProgress({phase, done, total, bytesDone, bytesTotal}), cache: Map (see cache.js) }
 * @returns {{ groups: [{ kind:'exact', hash, size, files: [] }], unreadable: number, hashed: number, fromCache: number }}
 */
async function findExact(files, opts = {}) {
  const { signal, onProgress, cache } = opts;
  const say = (p) => { if (onProgress) onProgress(p); };
  let unreadable = 0;
  let hashed = 0;
  let fromCache = 0;

  // 1. same size
  const bySize = new Map();
  for (const f of files) { if (f.size > 0) { const a = bySize.get(f.size); if (a) a.push(f); else bySize.set(f.size, [f]); } }
  let candidates = [...bySize.values()].filter((g) => g.length > 1).flat();
  say({ phase: 'size', done: files.length, total: files.length, candidates: candidates.length });

  // 2. same start and end
  const quick = new Map();   // file -> fingerprint
  let done = 0;
  await pool(candidates, async (f) => {
    try { quick.set(f, await quickHash(f)); } catch { unreadable++; }
    if (++done % 25 === 0 || done === candidates.length) say({ phase: 'quick', done, total: candidates.length });
  }, signal);
  const byQuick = new Map();
  for (const f of candidates) {
    if (!quick.has(f)) continue;
    const k = quick.get(f);
    const a = byQuick.get(k);
    if (a) a.push(f); else byQuick.set(k, [f]);
  }
  candidates = [...byQuick.values()].filter((g) => g.length > 1).flat();

  // 3. same whole file
  const bytesTotal = candidates.reduce((n, f) => n + f.size, 0);
  let bytesDone = 0;
  done = 0;
  const full = new Map();
  await pool(candidates, async (f) => {
    const k = Cache.key(f);
    const cached = cache && cache.get(k);
    if (cached) { full.set(f, cached); fromCache++; bytesDone += f.size; }
    else {
      try {
        const hash = await fullHash(f, signal, (n) => { bytesDone += n; });
        full.set(f, hash); hashed++;
        if (cache) cache.set(k, hash);
      } catch (e) { if (e.cancelled) throw e; unreadable++; }
    }
    done++;
    say({ phase: 'full', done, total: candidates.length, bytesDone, bytesTotal });
  }, signal);

  const byHash = new Map();
  for (const f of candidates) {
    if (!full.has(f)) continue;
    const h = full.get(f);
    const a = byHash.get(h);
    if (a) a.push(f); else byHash.set(h, [f]);
  }
  const groups = [];
  for (const [hash, list] of byHash) {
    if (list.length < 2) continue;
    list.sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }));
    groups.push({ kind: 'exact', hash, size: list[0].size, files: list });
  }
  groups.sort((a, b) => b.size * (b.files.length - 1) - a.size * (a.files.length - 1) || a.files[0].path.localeCompare(b.files[0].path));
  return { groups, unreadable, hashed, fromCache };
}

module.exports = { findExact, quickHash, fullHash, pool, QUICK };
