'use strict';
// Reading what the date and tag rules need: the photo date (EXIF DateTimeOriginal, via exifr) and audio tags (artist,
// title, track, album, year via music-metadata). Read only when a rule asks for them, and remembered per file.
const path = require('path');

const PHOTO_EXTS = new Set(['.jpg', '.jpeg', '.jpe', '.tif', '.tiff', '.heic', '.heif', '.avif', '.png', '.webp', '.dng', '.cr2', '.cr3', '.nef', '.arw', '.orf', '.rw2', '.raf', '.pef', '.srw']);
const AUDIO_EXTS = new Set(['.mp3', '.flac', '.m4a', '.mp4', '.aac', '.ogg', '.oga', '.opus', '.wav', '.aif', '.aiff', '.wma', '.ape', '.wv', '.mpc', '.dsf']);

let exifr = null;
let mm = null;
const cache = new Map();

/** EXIF DateTimeOriginal as milliseconds (the camera's local time read as local time), or null. */
async function exifDate(file) {
  if (!PHOTO_EXTS.has(path.extname(file).toLowerCase())) return null;
  if (!exifr) exifr = require('exifr');
  try {
    const r = await exifr.parse(file, { pick: ['DateTimeOriginal', 'CreateDate'], tiff: true, exif: true, ifd1: false, gps: false, interop: false, xmp: false, icc: false, iptc: false, jfif: false, ihdr: false });
    const d = r && (r.DateTimeOriginal || r.CreateDate);
    if (d instanceof Date && !Number.isNaN(d.getTime())) return d.getTime();
    return null;
  } catch { return null; }
}

/** Audio tags, or null when the file has none we can read. */
async function audioTags(file) {
  if (!AUDIO_EXTS.has(path.extname(file).toLowerCase())) return null;
  // music-metadata is an ES module; import() works from CommonJS in Electron and Node
  if (!mm) mm = await import('music-metadata');
  try {
    const r = await mm.parseFile(file, { duration: false, skipCovers: true });
    const c = r.common || {};
    const t = {
      artist: c.artist || (c.artists && c.artists[0]) || '', title: c.title || '', album: c.album || '', albumartist: c.albumartist || '',
      track: c.track && c.track.no ? c.track.no : '', disc: c.disk && c.disk.no ? c.disk.no : '', year: c.year ? String(c.year) : '',
    };
    return Object.values(t).some((v) => v !== '') ? t : null;
  } catch { return null; }
}

/** Fill in `exifDate` / `tags` on the files that need them (a few at a time). */
async function enrich(files, need, { signal } = {}) {
  const jobs = [];
  for (const f of files) {
    if (f.isDir) continue;
    const key = `${f.path}\u0000${f.mtimeMs}\u0000${f.size}`;
    let c = cache.get(key);
    if (!c) { c = {}; cache.set(key, c); }
    if (need.exif && !('exifDate' in c)) jobs.push(async () => { c.exifDate = await exifDate(f.path); });
    if (need.tags && !('tags' in c)) jobs.push(async () => { c.tags = await audioTags(f.path); });
    f._meta = c;
  }
  let next = 0;
  const worker = async () => { while (next < jobs.length) { if (signal && signal.aborted) return; await jobs[next++](); } };
  await Promise.all(Array.from({ length: Math.min(6, jobs.length) }, worker));
  for (const f of files) { if (f._meta) { f.exifDate = f._meta.exifDate == null ? null : f._meta.exifDate; f.tags = f._meta.tags || null; delete f._meta; } }
  if (cache.size > 50000) cache.clear();
  return files;
}

module.exports = { exifDate, audioTags, enrich, PHOTO_EXTS, AUDIO_EXTS };
