'use strict';
// Reads and writes the few tags this tool cares about (title, artist, BPM, initial key). Electron-free, so Node tests run it.
// Writes are safe the same way Audio Tagger's are: copy the original, save, read it back to check, and put the original
// bytes back if anything is off.
let fs;
try { fs = require('original-fs'); } catch { fs = require('fs'); }
const os = require('os');
const path = require('path');
const { File } = require('node-taglib-sharp');
const M = require('./music');

const first = (list) => ((list || []).filter(Boolean)[0]) || '';

/** Tags + length of one file. Never throws: a file whose tags cannot be read still gets analysed. */
function readTags(file) {
  const base = { title: '', artist: '', tagBpm: 0, tagKey: '', durationMs: 0, canWrite: M.canWriteTags(file), tagError: '' };
  try {
    const f = File.createFromPath(file);
    try {
      const t = f.tag;
      return {
        ...base,
        title: t.title || '', artist: first(t.performers) || first(t.albumArtists),
        tagBpm: Math.round(t.beatsPerMinute || 0), tagKey: String(t.initialKey || '').trim(),
        durationMs: Math.round((f.properties && f.properties.durationMilliseconds) || 0),
      };
    } finally { f.dispose(); }
  } catch (e) {
    return { ...base, canWrite: false, tagError: String((e && e.message) || e).slice(0, 160) };
  }
}

/**
 * Write a BPM and/or a key to one file. `change` = { bpm?: whole number, key?: text }. Returns what the file holds afterwards.
 * Throws with the file left exactly as it was when anything goes wrong.
 */
function writeTags(file, change) {
  if (!M.canWriteTags(file)) throw new Error('This kind of file cannot hold tags');
  const hasBpm = change.bpm != null;
  const hasKey = change.key != null;
  if (!hasBpm && !hasKey) return readTags(file);
  if (hasBpm && !(Number.isInteger(change.bpm) && change.bpm >= 1 && change.bpm <= 999)) throw new Error('BPM must be a whole number from 1 to 999');
  if (hasKey && !M.KEY_TEXT_RE.test(change.key)) throw new Error('Not a key name: ' + String(change.key).slice(0, 20));
  const backup = path.join(os.tmpdir(), `bpmkey-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.bak`);
  fs.copyFileSync(file, backup);
  try {
    const f = File.createFromPath(file);
    try {
      if (hasBpm) f.tag.beatsPerMinute = change.bpm;
      if (hasKey) f.tag.initialKey = change.key;
      f.save();
    } finally { f.dispose(); }
    const after = readTags(file);
    if (after.tagError) throw new Error('The file could not be read back after saving');
    if (hasBpm && after.tagBpm !== change.bpm) throw new Error(`The BPM did not stick (the file says ${after.tagBpm || 'nothing'})`);
    if (hasKey && after.tagKey !== change.key) throw new Error(`The key did not stick (the file says ${after.tagKey || 'nothing'})`);
    return after;
  } catch (err) {
    try { fs.copyFileSync(backup, file); } catch { /* the original is still in the backup file */ }
    throw new Error(`${err.message} (file left unchanged)`);
  } finally {
    fs.rmSync(backup, { force: true });
  }
}

module.exports = { readTags, writeTags };
