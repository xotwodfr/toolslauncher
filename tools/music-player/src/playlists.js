'use strict';
// M3U / M3U8 playlist import and export, and the saved-playlists store. Electron-free (testable with plain Node).
let fs;
try { fs = require('original-fs'); } catch { fs = require('fs'); }
const path = require('path');
const { decodeText } = require('./lyrics');

const MAX_PLAYLISTS = 500;
const MAX_TRACKS = 50000;

/** Read an M3U/M3U8 file's text into entries [{ file (absolute), title }]. Relative entries resolve against the playlist's folder. */
function parseM3U(text, baseDir) {
  const out = [];
  let title = '';
  for (const raw of String(text).split(/\r\n|\r|\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#')) {
      const m = /^#EXTINF:[^,]*,(.*)$/i.exec(line);
      if (m) title = m[1].trim();
      continue;
    }
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(line) && !/^file:\/\//i.test(line)) { title = ''; continue; } // streams (http://...) are not files
    let file = line;
    if (/^file:\/\//i.test(file)) { try { file = decodeURIComponent(new URL(file).pathname).replace(/^\/([A-Za-z]:)/, '$1'); } catch { title = ''; continue; } }
    file = file.replace(/[\\/]+/g, path.sep);
    out.push({ file: path.isAbsolute(file) ? path.normalize(file) : path.resolve(baseDir, file), title });
    title = '';
    if (out.length >= MAX_TRACKS) break;
  }
  return out;
}

function readM3UFile(file) {
  if (fs.statSync(file).size > 20 * 1024 * 1024) throw new Error('Playlist file is too large');
  return parseM3U(decodeText(fs.readFileSync(file)), path.dirname(file));
}

/** M3U8 text for entries [{ file (absolute), title, seconds }], with paths relative to `playlistDir` when possible. */
function writeM3U(entries, playlistDir) {
  const out = ['#EXTM3U'];
  for (const e of entries) {
    const rel = path.relative(playlistDir, e.file);
    const shown = rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : e.file;
    const title = String(e.title || '').replace(/[\r\n]+/g, ' ').trim();
    out.push(`#EXTINF:${e.seconds > 0 ? Math.round(e.seconds) : -1},${title}`);
    out.push(shown.split(path.sep).join('/'));
  }
  return out.join('\n') + '\n';
}

// ---- saved playlists ----------------------------------------------------------------------------------------------
/** Validate whatever came from disk or the renderer: { lists: [{ id, name, tracks: [rel...] }] }. */
function cleanStore(v) {
  const lists = [];
  const ids = new Set();
  for (const l of (v && Array.isArray(v.lists) ? v.lists : []).slice(0, MAX_PLAYLISTS)) {
    if (!l || typeof l.name !== 'string' || !Array.isArray(l.tracks)) continue;
    let id = typeof l.id === 'string' && /^[\w-]{1,40}$/.test(l.id) ? l.id : '';
    if (!id || ids.has(id)) id = 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    ids.add(id);
    lists.push({ id, name: l.name.trim().slice(0, 120) || 'Playlist', tracks: l.tracks.filter((t) => typeof t === 'string' && t.length < 1024).slice(0, MAX_TRACKS) });
  }
  return { lists };
}

function loadStore(file) {
  try { return cleanStore(JSON.parse(fs.readFileSync(file, 'utf8'))); } catch { return { lists: [] }; }
}
function saveStore(file, store) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cleanStore(store), null, 1));
  fs.renameSync(tmp, file);
}

module.exports = { parseM3U, readM3UFile, writeM3U, cleanStore, loadStore, saveStore };
