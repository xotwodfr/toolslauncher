'use strict';
// Repeated songs. Two kinds of "the same song" are found:
//   identical audio  - the decoded sound is bit for bit the same (same recording, maybe different tags or file name);
//   same song        - same artist and title and (nearly) the same length, e.g. an MP3 and a FLAC of the same track.
// It does NOT listen to the music (no acoustic fingerprint), so two different recordings of a song with different tags
// are not matched, and a mislabelled file can be. Review decides; nothing is deleted from here.
let fs;
try { fs = require('original-fs'); } catch { fs = require('fs'); }
const path = require('path');
const { spawn } = require('child_process');
const T = require('node-taglib-sharp');
const Cache = require('./cache');
const { pool } = require('./exact');

const DURATION_SLACK_MS = 3000;      // "same song" tracks may differ in length by this much (encoder padding, silence)
const IDENTICAL_SLACK_MS = 150;      // files this close in length are candidates for the (slower) identical-audio check
const LOSSLESS_EXT = new Set(['.flac', '.wav', '.aif', '.aiff', '.ape', '.wv']);

const cancelled = () => Object.assign(new Error('Cancelled'), { cancelled: true });

function ffmpegPath() {
  try {
    const p = require('ffmpeg-static');
    if (p) {
      const real = p.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
      if (fs.existsSync(real)) return real;
    }
  } catch { /* fall through */ }
  return 'ffmpeg';
}

/** Lower case, no accents, no punctuation: "Beyoncé – Halo!" and "beyonce halo" are the same text. */
function normalizeText(s) {
  return String(s || '').normalize('NFD').replace(/\p{M}+/gu, '').toLowerCase().replace(/&/g, ' and ').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

const list = (a) => (Array.isArray(a) ? a.filter(Boolean).join(', ') : '');
const num = (n) => (Number.isFinite(Number(n)) ? Number(n) : 0);

/** Tags and sound properties of one file (taglib: reads only the headers, fast). */
function readTags(rec) {
  const out = { title: '', artist: '', album: '', durationMs: 0, bitrate: 0, sampleRate: 0, codec: '', bad: false };
  let f;
  try { f = T.File.createFromPath(rec.path); } catch { out.bad = true; return out; }
  try {
    const t = f.tag; const p = f.properties;
    out.title = t.title || '';
    out.artist = list(t.performers) || list(t.albumArtists);
    out.album = t.album || '';
    if (p) { out.durationMs = Math.round(num(p.durationMilliseconds)); out.bitrate = num(p.audioBitrate); out.sampleRate = num(p.audioSampleRate); out.codec = String(p.description || ''); }
  } finally { f.dispose(); }
  return out;
}

/** MD5 of the decoded audio, whatever the tags and container: `ffmpeg -map 0:a:0 -f md5 -`. */
function audioHash(file, signal) {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpegPath(), ['-hide_banner', '-nostdin', '-v', 'error', '-protocol_whitelist', 'file', '-i', file, '-map', '0:a:0', '-f', 'md5', '-'], { windowsHide: true });
    let out = ''; let err = '';
    const onAbort = () => p.kill('SIGKILL');
    if (signal) { if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, { once: true }); }
    p.stdout.setEncoding('utf8'); p.stderr.setEncoding('utf8');
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; if (err.length > 4000) err = err.slice(-4000); });
    p.on('error', (e) => reject(new Error(e.code === 'ENOENT' ? 'ffmpeg was not found' : e.message)));
    p.on('close', (code) => {
      if (signal) signal.removeEventListener('abort', onAbort);
      if (signal && signal.aborted) return reject(cancelled());
      const m = /MD5=([0-9a-f]{32})/.exec(out);
      if (code === 0 && m) resolve(m[1]); else reject(new Error(err.trim().split(/\r?\n/).pop() || `ffmpeg exited with code ${code}`));
    });
  });
}

/** Higher is better: lossless first (by sample rate), then lossy by bit rate. */
function qualityOf(rec, tags) {
  const ext = path.extname(rec.path).toLowerCase();
  const lossless = LOSSLESS_EXT.has(ext) || /alac|lossless|flac|pcm/i.test(tags.codec);
  return lossless ? 10000 + Math.round((tags.sampleRate || 44100) / 100) : Math.max(1, tags.bitrate || Math.round((rec.size * 8) / Math.max(1, tags.durationMs)));
}

class Union {
  constructor(n) { this.p = Array.from({ length: n }, (_, i) => i); }
  find(i) { while (this.p[i] !== i) { this.p[i] = this.p[this.p[i]]; i = this.p[i]; } return i; }
  join(a, b) { const x = this.find(a); const y = this.find(b); if (x !== y) this.p[Math.max(x, y)] = Math.min(x, y); }
}

/**
 * Pure grouping step (tested without any audio): `entries` = [{ rec, tags, md5? }].
 * @returns groups [{ kind: 'identical' | 'same-song', files: [{...rec, tags, quality}] }]
 */
function groupSongs(entries) {
  const n = entries.length;
  const uf = new Union(n);
  // same artist + title and about the same length
  const byKey = new Map();
  entries.forEach((e, i) => {
    const title = normalizeText(e.tags.title);
    const artist = normalizeText(e.tags.artist);
    if (!title || !artist || !e.tags.durationMs) return;
    const k = `${artist}\u0000${title}`;
    const a = byKey.get(k);
    if (a) a.push(i); else byKey.set(k, [i]);
  });
  for (const idx of byKey.values()) {
    if (idx.length < 2) continue;
    idx.sort((a, b) => entries[a].tags.durationMs - entries[b].tags.durationMs);
    let start = idx[0];
    for (const i of idx) {
      if (entries[i].tags.durationMs - entries[start].tags.durationMs <= DURATION_SLACK_MS) uf.join(start, i);
      else start = i;
    }
  }
  // identical decoded audio
  const byMd5 = new Map();
  entries.forEach((e, i) => { if (e.md5) { const a = byMd5.get(e.md5); if (a) a.push(i); else byMd5.set(e.md5, [i]); } });
  for (const idx of byMd5.values()) for (let k = 1; k < idx.length; k++) uf.join(idx[0], idx[k]);

  const comps = new Map();
  for (let i = 0; i < n; i++) { const r = uf.find(i); const a = comps.get(r); if (a) a.push(i); else comps.set(r, [i]); }
  const groups = [];
  for (const idx of comps.values()) {
    if (idx.length < 2) continue;
    const md5s = new Set(idx.map((i) => entries[i].md5 || ''));
    const identical = md5s.size === 1 && !md5s.has('');
    const files = idx.map((i) => ({ ...entries[i].rec, tags: entries[i].tags, quality: qualityOf(entries[i].rec, entries[i].tags) }));
    files.sort((a, b) => b.quality - a.quality || a.path.localeCompare(b.path, undefined, { numeric: true }));
    groups.push({ kind: identical ? 'identical' : 'same-song', size: files[0].size, files });
  }
  groups.sort((a, b) => b.files.reduce((s, f) => s + f.size, 0) - a.files.reduce((s, f) => s + f.size, 0));
  return groups;
}

/**
 * @param files  [{ path, size, mtimeMs, keep }]
 * @param opts   { signal, onProgress({phase, done, total}), cache: Map }
 */
async function findSongs(files, opts = {}) {
  const { signal, onProgress, cache } = opts;
  const say = (p) => { if (onProgress) onProgress(p); };
  const entries = [];
  let unreadable = 0;
  let done = 0;
  say({ phase: 'tags', done: 0, total: files.length });
  for (const rec of files) {
    if (signal && signal.aborted) throw cancelled();
    const k = Cache.key(rec);
    let hit = cache && cache.get(k);
    if (!hit) {
      const tags = readTags(rec);
      hit = { tags };
      if (cache && !tags.bad) cache.set(k, hit);
    }
    if (hit.tags.bad) unreadable++; else entries.push({ rec, tags: hit.tags, md5: hit.md5 || '', key: k });
    if (++done % 100 === 0) { say({ phase: 'tags', done, total: files.length }); await new Promise((r) => setImmediate(r)); }
  }
  say({ phase: 'tags', done: files.length, total: files.length });

  // only files with a neighbour of nearly the same length can be identical audio
  const order = entries.map((e, i) => i).sort((a, b) => entries[a].tags.durationMs - entries[b].tags.durationMs);
  const cand = new Set();
  for (let a = 0; a + 1 < order.length; a++) {
    const x = entries[order[a]]; const y = entries[order[a + 1]];
    if (y.tags.durationMs - x.tags.durationMs <= IDENTICAL_SLACK_MS && x.tags.durationMs > 0) { cand.add(order[a]); cand.add(order[a + 1]); }
  }
  const todo = [...cand].filter((i) => !entries[i].md5);
  done = 0;
  await pool(todo, async (i) => {
    const e = entries[i];
    try {
      e.md5 = await audioHash(e.rec.path, signal);
      if (cache) cache.set(e.key, { tags: e.tags, md5: e.md5 });
    } catch (err) { if (err.cancelled) throw err; /* unreadable audio: it just cannot be matched as identical */ }
    say({ phase: 'audio', done: ++done, total: todo.length });
  }, signal);
  return { groups: groupSongs(entries), unreadable };
}

module.exports = { findSongs, groupSongs, readTags, audioHash, normalizeText, qualityOf, ffmpegPath, DURATION_SLACK_MS };
