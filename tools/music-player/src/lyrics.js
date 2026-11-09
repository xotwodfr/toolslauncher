'use strict';
// Finding, reading and saving lyrics. Electron-free (testable with plain Node).
//  - sidecar file next to the song:   "Song.mp3" -> "Song.lrc" (synced or plain) or "Song.txt" (plain)
//  - embedded in the tags:            ID3 SYLT (synced), ID3 USLT / Vorbis LYRICS / MP4 ©lyr (plain, or LRC text)
// Saving only ever writes the sidecar .lrc: the audio file itself is never touched.
let fs;
try { fs = require('original-fs'); } catch { fs = require('fs'); }
const path = require('path');
const T = require('node-taglib-sharp');
const LRC = require('./lrc');

const MAX_FILE_BYTES = LRC.MAX_CHARS * 3; // UTF-8 can be up to 3 bytes per char in the BMP

/** Decode lyric file bytes: UTF-8/16 with a BOM, else UTF-8, else Windows-1252 (old LRC files). */
function decodeText(buf) {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return new TextDecoder('utf-16le').decode(buf.subarray(2));
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) return new TextDecoder('utf-16be').decode(buf.subarray(2));
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf).replace(/^﻿/, ''); } catch { /* not UTF-8 */ }
  return new TextDecoder('windows-1252').decode(buf);
}

const withExt = (file, ext) => file.slice(0, file.length - path.extname(file).length) + ext;

/** Existing sidecar lyrics file for a song (".lrc" preferred over ".txt"), or null. */
function findSidecar(trackPath) {
  for (const ext of ['.lrc', '.LRC', '.Lrc', '.txt', '.TXT']) {
    const f = withExt(trackPath, ext);
    try { if (fs.statSync(f).isFile()) return f; } catch { /* next */ }
  }
  return null;
}

function readSidecar(file) {
  const st = fs.statSync(file);
  if (st.size > MAX_FILE_BYTES) throw new Error('Lyrics file is too large');
  return decodeText(fs.readFileSync(file));
}

/** Embedded lyrics: { synced: [{t,text}] | null, plain: string }. Never throws for a file that merely has none. */
function readEmbedded(trackPath) {
  let f;
  try { f = T.File.createFromPath(trackPath); } catch { return { synced: null, plain: '' }; }
  try {
    const plain = String(f.tag.lyrics || '').trim();
    let synced = null;
    try {
      const id3 = f.getTag(T.TagTypes.Id3v2, false);
      const frames = id3 ? id3.frames.filter((fr) => String(fr.frameId) === 'SYLT') : [];
      for (const fr of frames) {
        if (fr.format !== T.Id3v2TimestampFormat.AbsoluteMilliseconds || !fr.text || !fr.text.length) continue; // MPEG-frame times need the frame rate: skip
        const lines = fr.text.map((x) => ({ t: Math.max(0, Number(x.time) || 0), text: String(x.text || '').replace(/\r?\n/g, ' ').trim() }));
        if (lines.length) { synced = lines.sort((a, b) => a.t - b.t); break; }
      }
    } catch { /* a damaged SYLT frame must not hide the other lyrics */ }
    return { synced, plain };
  } finally { f.dispose(); }
}

/**
 * Best lyrics for a song, in this order: sidecar .lrc (synced) > embedded SYLT > embedded LRC text > sidecar plain >
 * embedded plain. `source` says where it came from ("sidecar" | "embedded" | "none").
 * @returns {{ source: string, file: string|null, synced: boolean, lines: {t:number|null,text:string}[], meta: object, raw: string }}
 */
function loadLyrics(trackPath) {
  const none = { source: 'none', file: null, synced: false, lines: [], meta: {}, raw: '' };
  const sidecar = findSidecar(trackPath);
  let sidecarParsed = null;
  let sidecarText = '';
  if (sidecar) {
    try { sidecarText = readSidecar(sidecar); sidecarParsed = LRC.parse(sidecarText); } catch { /* unreadable: fall through to embedded */ }
  }
  if (sidecarParsed && sidecarParsed.synced) return { source: 'sidecar', file: sidecar, synced: true, lines: sidecarParsed.lines, meta: sidecarParsed.meta, raw: sidecarText };

  const emb = readEmbedded(trackPath);
  if (emb.synced) return { source: 'embedded', file: null, synced: true, lines: emb.synced, meta: {}, raw: LRC.serialize(emb.synced) };
  if (emb.plain && LRC.looksSynced(emb.plain)) {
    const p = LRC.parse(emb.plain);
    if (p.synced) return { source: 'embedded', file: null, synced: true, lines: p.lines, meta: p.meta, raw: emb.plain };
  }
  if (sidecarParsed && sidecarParsed.lines.length) return { source: 'sidecar', file: sidecar, synced: false, lines: sidecarParsed.lines, meta: sidecarParsed.meta, raw: sidecarText };
  if (emb.plain) {
    const lines = emb.plain.split(/\r\n|\r|\n/).map((s) => s.trim()).filter(Boolean).map((text) => ({ t: null, text }));
    return { source: 'embedded', file: null, synced: false, lines, meta: {}, raw: emb.plain };
  }
  return none;
}

/**
 * Save lyrics next to the song as "<song>.lrc". An existing file is kept as "<song>.lrc.bak" first. The write goes to a
 * temporary file that is then renamed into place, so a crash never leaves half a lyrics file.
 * @returns {{ file: string, backup: string|null }}
 */
function saveSidecar(trackPath, text) {
  const body = String(text == null ? '' : text);
  if (body.length > LRC.MAX_CHARS) throw new Error('Lyrics are too long');
  if (!body.trim()) throw new Error('There is nothing to save');
  const file = withExt(trackPath, '.lrc');
  // On a case-sensitive file system an "X.LRC" might exist; keep using the file that is already there.
  let target = file;
  for (const ext of ['.LRC', '.Lrc']) { const alt = withExt(trackPath, ext); try { if (fs.statSync(alt).isFile()) { target = alt; break; } } catch { /* none */ } }
  let backup = null;
  if (fs.existsSync(target)) { backup = target + '.bak'; fs.copyFileSync(target, backup); }
  const tmp = `${target}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, body.replace(/\r?\n/g, '\n'), 'utf8');
    fs.renameSync(tmp, target);
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
    throw e;
  }
  return { file: target, backup };
}

module.exports = { decodeText, findSidecar, readSidecar, readEmbedded, loadLyrics, saveSidecar };
