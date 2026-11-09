'use strict';
// Scanning a music folder: tags, durations, cover art, ReplayGain. Electron-free (testable with plain Node, and run inside
// a worker thread by the app so a big folder never freezes the window).
let fs;
try { fs = require('original-fs'); } catch { fs = require('fs'); }
const path = require('path');
const T = require('node-taglib-sharp');

/** Formats Chromium (and so this player) can play. */
const AUDIO_EXTS = ['.mp3', '.flac', '.ogg', '.oga', '.opus', '.m4a', '.aac', '.wav'];
/** Audio formats we recognise but cannot play: counted and reported, not listed. */
const UNPLAYABLE_EXTS = ['.wma', '.aif', '.aiff', '.ape', '.wv', '.mka', '.dsf', '.dff', '.mpc', '.tta'];
const IMAGE_EXTS = ['.jpg', '.jpeg', '.png', '.webp', '.gif'];
const COVER_NAMES = ['cover', 'folder', 'front', 'album', 'albumart', 'albumartsmall'];
const MIME = {
  '.mp3': 'audio/mpeg', '.flac': 'audio/flac', '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.opus': 'audio/ogg; codecs=opus',
  '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.wav': 'audio/wav',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif',
};
const CACHE_VERSION = 2;
const MAX_FILES = 200000;
const MAX_DEPTH = 14;
const MAX_COVER_BYTES = 25 * 1024 * 1024;

const extOf = (f) => path.extname(f).toLowerCase();
const isAudio = (f) => AUDIO_EXTS.includes(extOf(f));
const isImage = (f) => IMAGE_EXTS.includes(extOf(f));
const toRel = (root, abs) => path.relative(root, abs).split(path.sep).join('/');

/**
 * Turn a relative path from the renderer / a playlist into an absolute path that is guaranteed to be inside `root`.
 * Throws for "..", absolute paths, other drives and anything that is not an audio or image file.
 */
function resolveInside(root, rel, kinds = 'any') {
  if (typeof rel !== 'string' || !rel || rel.includes('\0')) throw new Error('Bad path');
  const parts = rel.split('/');
  if (parts.some((s) => s === '' || s === '.' || s === '..')) throw new Error('Bad path');
  if (process.platform === 'win32' && /[\\:]/.test(rel)) throw new Error('Bad path'); // drive letters and backslashes
  const abs = path.resolve(root, ...parts);
  const back = path.relative(root, abs);
  if (!back || back.startsWith('..') || path.isAbsolute(back)) throw new Error('Path is outside the music folder');
  const ok = kinds === 'audio' ? isAudio(abs) : kinds === 'image' ? isImage(abs) : (isAudio(abs) || isImage(abs));
  if (!ok) throw new Error('Not a music or image file');
  return abs;
}

const num = (v) => (Number.isFinite(v) && v > 0 ? v : 0);
const gain = (v) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : null); // ReplayGain gain in dB, NaN when missing
const joinList = (arr) => (arr || []).filter(Boolean).join('; ');

/** Read one file's tags into a plain record. Throws only when the file cannot be opened at all. */
function readTrack(root, abs, st, coverFile) {
  const rel = toRel(root, abs);
  const rec = {
    rel, ext: extOf(abs).slice(1), size: st.size, mtime: Math.round(st.mtimeMs),
    title: '', artist: '', albumArtist: '', album: '', genre: '', composer: '', year: 0, track: 0, trackCount: 0, disc: 0, discCount: 0,
    durationMs: 0, bitrate: 0, sampleRate: 0, channels: 0, codec: '',
    cover: coverFile ? 'folder' : '', coverFile: coverFile || '', lyrics: false,
    rg: null, bad: false,
  };
  let f;
  try { f = T.File.createFromPath(abs); } catch (e) { rec.bad = true; return rec; }
  try {
    const t = f.tag;
    const p = f.properties;
    rec.title = t.title || '';
    rec.artist = joinList(t.performers);
    rec.albumArtist = joinList(t.albumArtists);
    rec.album = t.album || '';
    rec.genre = joinList(t.genres);
    rec.composer = joinList(t.composers);
    rec.year = num(t.year); rec.track = num(t.track); rec.trackCount = num(t.trackCount); rec.disc = num(t.disc); rec.discCount = num(t.discCount);
    if (p) {
      rec.durationMs = Math.round(num(p.durationMilliseconds));
      rec.bitrate = num(p.audioBitrate); rec.sampleRate = num(p.audioSampleRate); rec.channels = num(p.audioChannels);
      rec.codec = p.description || '';
    }
    if ((t.pictures || []).length) rec.cover = 'embedded';
    rec.lyrics = !!(t.lyrics && String(t.lyrics).trim());
    const tg = gain(t.replayGainTrackGain);
    const ag = gain(t.replayGainAlbumGain);
    if (tg != null || ag != null) {
      rec.rg = { track: tg, trackPeak: num(t.replayGainTrackPeak) || null, album: ag, albumPeak: num(t.replayGainAlbumPeak) || null };
    }
  } finally { f.dispose(); }
  return rec;
}

const tick = () => new Promise((r) => setImmediate(r));

/**
 * Walk `root` and read every playable file. Unchanged files (same size and modified time) come from `cache`
 * (a Map rel -> record) instead of being read again.
 * @param {string} root
 * @param {{cache?: Map<string, object>, onProgress?: (p:{phase:string,done:number,total:number})=>void, isCancelled?: ()=>boolean}} [opts]
 */
async function scan(root, opts = {}) {
  const cache = opts.cache || new Map();
  const files = []; // { abs, st, coverFile }
  const skipped = {};
  let cancelled = false;
  let walked = 0;

  async function walk(dir, depth) {
    if (cancelled || files.length >= MAX_FILES) return;
    let entries;
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
    entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    // folder artwork: the best-named image in this folder (cover.jpg beats folder.png beats front.webp ...)
    let coverFile = '';
    let coverRank = 99;
    for (const e of entries) {
      if (!e.isFile() || !isImage(e.name)) continue;
      const base = path.basename(e.name, path.extname(e.name)).toLowerCase();
      const rank = COVER_NAMES.indexOf(base);
      if (rank >= 0 && rank < coverRank) { coverRank = rank; coverFile = e.name; }
    }
    for (const e of entries) {
      if (cancelled) return;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (depth < MAX_DEPTH && !e.name.startsWith('.')) await walk(abs, depth + 1);
      } else if (e.isFile()) {
        const ext = extOf(e.name);
        if (AUDIO_EXTS.includes(ext)) {
          let st;
          try { st = await fs.promises.stat(abs); } catch { continue; }
          files.push({ abs, st, coverFile: coverFile ? path.posix.join(toRel(root, dir) || '.', coverFile).replace(/^\.\//, '') : '' });
        } else if (UNPLAYABLE_EXTS.includes(ext)) skipped[ext] = (skipped[ext] || 0) + 1;
      }
      if (++walked % 200 === 0) { if (opts.isCancelled && opts.isCancelled()) cancelled = true; if (opts.onProgress) opts.onProgress({ phase: 'find', done: files.length, total: 0 }); await tick(); }
    }
  }
  await walk(root, 0);

  const tracks = [];
  let reused = 0;
  let errors = 0;
  for (let i = 0; i < files.length && !cancelled; i++) {
    const { abs, st, coverFile } = files[i];
    const rel = toRel(root, abs);
    const hit = cache.get(rel);
    if (hit && hit.size === st.size && hit.mtime === Math.round(st.mtimeMs)) {
      // refresh the folder-cover pointer: the image may have been added or removed since the last scan
      const rec = { ...hit, coverFile: coverFile ? toRel(root, path.join(root, coverFile)) : '' };
      rec.cover = hit.cover === 'embedded' ? 'embedded' : (coverFile ? 'folder' : '');
      tracks.push(rec); reused++;
    } else {
      try { const rec = readTrack(root, abs, st, coverFile); if (rec.bad) errors++; tracks.push(rec); } catch { errors++; }
    }
    if (i % 25 === 0) {
      if (opts.isCancelled && opts.isCancelled()) cancelled = true;
      if (opts.onProgress) opts.onProgress({ phase: 'read', done: i, total: files.length });
      await tick();
    }
  }
  return { root, tracks: cancelled ? [] : tracks, skipped, errors, reused, cancelled };
}

// ---- cache --------------------------------------------------------------------------------------------------------
function loadCache(file, root) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (j && j.version === CACHE_VERSION && j.root === root && Array.isArray(j.tracks)) return new Map(j.tracks.map((t) => [t.rel, t]));
  } catch { /* no cache, or damaged: just rescan */ }
  return new Map();
}
function saveCache(file, root, tracks) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ version: CACHE_VERSION, root, tracks }));
  fs.renameSync(tmp, file);
}

// ---- cover art ----------------------------------------------------------------------------------------------------
/** Cover image bytes for a track: its embedded front cover, else the folder's cover.jpg & co. Returns {mime, data} or null. */
function readCover(root, track) {
  try {
    const abs = resolveInside(root, track.rel, 'audio');
    if (track.cover === 'embedded' || !track.coverFile) {
      let f;
      try { f = T.File.createFromPath(abs); } catch { f = null; }
      if (f) {
        try {
          const pics = f.tag.pictures || [];
          const pic = pics.find((p) => p.type === T.PictureType.FrontCover) || pics[0];
          if (pic && pic.data && pic.data.length && pic.data.length <= MAX_COVER_BYTES) {
            const mime = pic.mimeType && /^image\//.test(pic.mimeType) ? pic.mimeType : 'image/jpeg';
            return { mime, data: Buffer.from(pic.data.toByteArray()) };
          }
        } finally { f.dispose(); }
      }
    }
    if (track.coverFile) {
      const img = resolveInside(root, track.coverFile, 'image');
      if (fs.statSync(img).size <= MAX_COVER_BYTES) return { mime: MIME[extOf(img)] || 'image/jpeg', data: fs.readFileSync(img) };
    }
  } catch { /* no usable cover */ }
  return null;
}

module.exports = {
  AUDIO_EXTS, UNPLAYABLE_EXTS, IMAGE_EXTS, MIME, CACHE_VERSION,
  isAudio, isImage, extOf, toRel, resolveInside, readTrack, scan, loadCache, saveCache, readCover,
};
