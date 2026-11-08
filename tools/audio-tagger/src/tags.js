'use strict';
// Electron-free tag reading/writing (testable with plain Node). Uses node-taglib-sharp (pure JS).
// Inside Electron, plain `fs` treats *.asar as folders - use original-fs when available.
let fs;
try { fs = require('original-fs'); } catch { fs = require('fs'); }
const os = require('os');
const path = require('path');
const { File, Picture, PictureType, ByteVector } = require('node-taglib-sharp');

const AUDIO_EXTS = ['.mp3', '.flac', '.ogg', '.oga', '.opus', '.m4a', '.mp4', '.wav', '.wma', '.aif', '.aiff', '.ape', '.wv'];
const IMAGE_EXTS = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];
const MAX_COVER_BYTES = 20 * 1024 * 1024;

const isAudio = (f) => AUDIO_EXTS.includes(path.extname(f).toLowerCase());
const isImage = (f) => IMAGE_EXTS.includes(path.extname(f).toLowerCase());

/** Text fields: UI key -> how to get/set on a taglib Tag. `list` fields are "A; B" in the UI. */
const TEXT_FIELDS = {
  title: { key: 'title' },
  artist: { key: 'performers', list: true },
  albumArtist: { key: 'albumArtists', list: true },
  album: { key: 'album' },
  genre: { key: 'genres', list: true },
  composer: { key: 'composers', list: true },
  comment: { key: 'comment' },
};
const NUM_FIELDS = { year: 'year', track: 'track', trackCount: 'trackCount', disc: 'disc', discCount: 'discCount' };
const FIELD_NAMES = [...Object.keys(TEXT_FIELDS), ...Object.keys(NUM_FIELDS)];

const joinList = (arr) => (arr || []).filter(Boolean).join('; ');
const splitList = (s) => String(s).split(/\s*[;\n]\s*/).map((x) => x.trim()).filter(Boolean);
const toNum = (v, max) => {
  if (v === '' || v == null) return 0;
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n > 0 ? Math.min(n, max) : 0;
};

function open(file) {
  if (!isAudio(file)) throw new Error('Unsupported file type');
  return File.createFromPath(file);
}

function summarise(file, f) {
  const t = f.tag;
  const p = f.properties;
  const tags = {};
  for (const [name, def] of Object.entries(TEXT_FIELDS)) tags[name] = def.list ? joinList(t[def.key]) : (t[def.key] || '');
  for (const [name, key] of Object.entries(NUM_FIELDS)) tags[name] = t[key] || 0;
  return {
    path: file,
    name: path.basename(file),
    bytes: fs.statSync(file).size,
    format: path.extname(file).slice(1).toLowerCase(),
    codec: p ? p.description || '' : '',
    durationMs: p ? Math.round(p.durationMilliseconds || 0) : 0,
    bitrate: p ? p.audioBitrate || 0 : 0,
    sampleRate: p ? p.audioSampleRate || 0 : 0,
    channels: p ? p.audioChannels || 0 : 0,
    hasCover: (t.pictures || []).length > 0,
    tags,
  };
}

/** Read tags + audio properties (no cover bytes). Throws on unreadable/corrupt files. */
function readTags(file) {
  const f = open(file);
  try { return summarise(file, f); } finally { f.dispose(); }
}

/** Front cover (or first picture) as { mime, dataUrl } or null. */
function readCover(file) {
  const f = open(file);
  try {
    const pics = f.tag.pictures || [];
    const pic = pics.find((p) => p.type === PictureType.FrontCover) || pics[0];
    if (!pic) return null;
    const bytes = Buffer.from(pic.data.toByteArray());
    const mime = pic.mimeType && /^image\//.test(pic.mimeType) ? pic.mimeType : 'image/jpeg';
    return { mime, dataUrl: `data:${mime};base64,${bytes.toString('base64')}`, bytes: bytes.length };
  } finally { f.dispose(); }
}

/** Apply a patch (only the fields present) to an open taglib file. */
function applyPatch(f, patch, coverPath) {
  const t = f.tag;
  for (const [name, def] of Object.entries(TEXT_FIELDS)) {
    if (!(name in patch)) continue;
    const v = patch[name] == null ? '' : String(patch[name]);
    if (def.list) t[def.key] = splitList(v);
    else t[def.key] = v.trim() === '' ? undefined : v;
  }
  if ('year' in patch) t.year = toNum(patch.year, 9999);
  for (const n of ['track', 'trackCount', 'disc', 'discCount']) if (n in patch) t[n] = toNum(patch[n], 9999);
  if (patch.cover) {
    if (patch.cover.action === 'remove') {
      t.pictures = [];
    } else if (patch.cover.action === 'set') {
      if (!coverPath) throw new Error('No cover image selected');
      const pic = Picture.fromPath(coverPath);
      pic.type = PictureType.FrontCover;
      pic.description = 'Cover';
      t.pictures = [pic];
    }
  }
}

/**
 * Write a patch to one file safely: copy the original first, save, re-read to verify,
 * and restore the original bytes if anything goes wrong.
 */
function writeTags(file, patch, coverPath) {
  if (!isAudio(file)) throw new Error('Unsupported file type');
  if (coverPath) {
    if (!isImage(coverPath)) throw new Error('Cover must be a JPG, PNG, GIF or WebP image');
    if (fs.statSync(coverPath).size > MAX_COVER_BYTES) throw new Error('Cover image is larger than 20 MB');
  }
  const backup = path.join(os.tmpdir(), `audiotagger-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.bak`);
  fs.copyFileSync(file, backup);
  let restored = false;
  try {
    const f = open(file);
    try {
      applyPatch(f, patch, coverPath);
      f.save();
    } finally { f.dispose(); }
    const check = open(file); // must still parse
    check.dispose();
  } catch (err) {
    fs.copyFileSync(backup, file);
    restored = true;
    throw new Error(`${err.message}${restored ? ' (file left unchanged)' : ''}`);
  } finally {
    fs.rmSync(backup, { force: true });
  }
}

// ---- renaming from tags ----------------------------------------------------------------------
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

function sanitizeFileName(s) {
  let out = String(s).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/\s+/g, ' ').trim();
  out = out.replace(/[. ]+$/, '').slice(0, 150).trim();
  if (RESERVED.test(out)) out += '_';
  return out;
}

/** Fill {title} {artist} {album} {albumartist} {track} {disc} {year} from a tags object. */
function fillPattern(pattern, tags) {
  const pad = (n) => (n ? String(n).padStart(2, '0') : '');
  const vals = {
    title: tags.title, artist: tags.artist, album: tags.album, albumartist: tags.albumArtist,
    track: pad(tags.track), disc: tags.disc ? String(tags.disc) : '', year: tags.year ? String(tags.year) : '',
  };
  const filled = String(pattern).replace(/\{(\w+)\}/g, (_m, k) => (vals[k.toLowerCase()] ?? ''));
  // drop separators left dangling by empty values: "01 -  - x" / " - x"
  return sanitizeFileName(filled.replace(/^[\s\-_.]+|[\s\-_.]+$/g, '').replace(/(\s[-_]\s){2,}/g, ' - '));
}

/** Rename `file` to match the pattern (same folder + extension). Never overwrites. Returns new path. */
function renameFromTags(file, pattern) {
  const base = fillPattern(pattern, readTags(file).tags);
  if (!base) return file;
  const dir = path.dirname(file);
  const ext = path.extname(file);
  // Windows file names are case-insensitive: "a.mp3" -> "A.mp3" is a rename of the same file, not a clash.
  const same = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);
  let target = path.join(dir, base + ext);
  for (let i = 1; fs.existsSync(target) && !same(target, file); i++) target = path.join(dir, `${base} (${i})${ext}`);
  if (target !== file) fs.renameSync(file, target);
  return target;
}

module.exports = {
  AUDIO_EXTS, IMAGE_EXTS, FIELD_NAMES, isAudio, isImage,
  readTags, readCover, writeTags, renameFromTags, fillPattern, sanitizeFileName, splitList, joinList,
  ByteVector, // re-exported for tests
};
