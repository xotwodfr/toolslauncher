'use strict';
// The recordings folder: naming takes, listing them, renaming, and recovering takes that were never finished
// (the app or the computer stopped while recording). Electron-free.
let fs;
try { fs = require('original-fs'); } catch { fs = require('fs'); }
const path = require('path');
const W = require('./wav');
const { safeName, uniquePath } = require('./clean');

const pad = (n, w = 2) => String(n).padStart(w, '0');
/** "2026-11-10 21.04.33" - sorts by date, and is a valid file name everywhere (no colons). */
function stamp(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}.${pad(d.getMinutes())}.${pad(d.getSeconds())}`;
}
const STAMP_RE = /^(\d{4})-(\d{2})-(\d{2}) (\d{2})\.(\d{2})\.(\d{2})(?: - (.*))?$/;

/** File name (without .wav) -> { date, title }. Titles follow the date stamp after " - ". */
function parseName(base) {
  const m = STAMP_RE.exec(base);
  if (!m) return { date: null, title: base };
  const date = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  let title = m[7] || '';
  title = title.replace(/ \((\d+)\)$/, ''); // the " (2)" of a name clash is not part of the title
  return { date, title };
}

function takeBase(date, title) {
  const s = stamp(date);
  const t = title ? safeName(title, '') : '';
  return t ? `${s} - ${t}` : s;
}

/** Everything about one take the window needs (never the audio). */
function describe(file) {
  const st = fs.statSync(file);
  const base = path.basename(file, path.extname(file));
  const { date, title } = parseName(base);
  let info = null; let problem = '';
  try { info = W.inspect(file); } catch (e) { problem = String(e.message || e); }
  return {
    name: path.basename(file), base, title, recovered: /\(recovered\)/.test(base),
    date: (date || st.mtime).toISOString(), bytes: st.size,
    duration: info ? info.duration : 0, sampleRate: info ? info.fmt.sampleRate : 0, channels: info ? info.fmt.channels : 0,
    markers: info ? info.markers : [], problem,
  };
}

/** The takes in a folder, newest first. Only WAV files directly in the folder; unfinished `.part` files are not listed. */
function list(dir) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  const out = [];
  for (const n of names) {
    if (!/\.wav$/i.test(n)) continue;
    const f = path.join(dir, n);
    try { if (fs.statSync(f).isFile()) out.push(describe(f)); } catch { /* vanished */ }
  }
  return out.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : a.name.localeCompare(b.name)));
}

/** A take name the window sent us -> its path, only if it really is a WAV directly inside the folder. */
function resolveTake(dir, name) {
  if (typeof name !== 'string' || !name || name.length > 300 || /[\\/]/.test(name) || name === '.' || name === '..' || !/\.wav$/i.test(name)) throw new Error('Unknown recording');
  const p = path.join(dir, name);
  if (path.dirname(p) !== path.resolve(dir)) throw new Error('Unknown recording');
  if (!fs.existsSync(p)) throw new Error('That recording is not in the folder any more');
  return p;
}

/** Give a take a new title (the date stamp stays). Returns the new file name. */
function rename(dir, name, title) {
  const from = resolveTake(dir, name);
  const { date } = parseName(path.basename(from, '.wav'));
  const d = date || fs.statSync(from).mtime;
  const base = takeBase(d, title);
  if (base === path.basename(from, '.wav')) return path.basename(from);
  const to = uniquePath(dir, base, 'wav');
  fs.renameSync(from, to);
  return path.basename(to);
}

/**
 * Finish any `.wav.part` take in these places: fix its header and give it a "(recovered)" name.
 * Part files with no audio in them are removed. Returns what was recovered.
 * @param {string[]} files part files we know were being recorded (from the journal)
 * @param {string[]} dirs folders to look in for others
 */
function recover(files, dirs) {
  const seen = new Set();
  const found = [];
  for (const d of dirs) {
    let names = [];
    try { names = fs.readdirSync(d); } catch { continue; }
    for (const n of names) if (/\.wav\.part$/i.test(n)) found.push(path.join(d, n));
  }
  const out = [];
  for (const f of [...files, ...found]) {
    const key = path.resolve(f);
    if (seen.has(key) || !fs.existsSync(f)) continue;
    seen.add(key);
    try {
      const seconds = W.repair(f);
      if (seconds < 0.05) { fs.rmSync(f, { force: true }); continue; }
      const dir = path.dirname(f);
      const base = path.basename(f).replace(/\.wav\.part$/i, '');
      const to = uniquePath(dir, `${base} (recovered)`, 'wav');
      fs.renameSync(f, to);
      out.push({ path: to, name: path.basename(to), seconds });
    } catch (e) {
      out.push({ path: f, name: path.basename(f), error: String(e.message || e) });
    }
  }
  return out;
}

/**
 * One recording in progress. Samples come in as 16-bit PCM chunks while recording; pause() drops what arrives until
 * resume(). Markers are kept in take seconds. stop() writes the final file.
 */
class Session {
  constructor(dir, { sampleRate, date = new Date(), syncEvery } = {}) {
    this.dir = dir;
    this.date = date;
    this.base = takeBase(date);
    this.final = uniquePath(dir, this.base, 'wav');
    this.writer = new W.WavWriter(this.final + '.part', { sampleRate, syncEvery });
    this.markers = [];
    this.paused = false;
    this.peak = 0;
  }
  get partPath() { return this.writer.path; }
  get seconds() { return this.writer.seconds; }
  append(chunk) { if (!this.paused) this.writer.append(chunk); }
  pause() { this.paused = true; this.writer.sync(); }
  resume() { this.paused = false; }
  mark(label) { const t = this.seconds; this.markers.push({ t, label: label || `Marker ${this.markers.length + 1}` }); return { t, n: this.markers.length }; }
  stop() {
    if (this.writer.dataBytes === 0) { this.writer.discard(); return null; }
    // the final name was free when we started; take a new one if something else appeared since
    const to = fs.existsSync(this.final) ? uniquePath(this.dir, this.base, 'wav') : this.final;
    return this.writer.finish(to, this.markers);
  }
  discard() { this.writer.discard(); }
}

module.exports = { stamp, parseName, takeBase, describe, list, resolveTake, rename, recover, Session };
