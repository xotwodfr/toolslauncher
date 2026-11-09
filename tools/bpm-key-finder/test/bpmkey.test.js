'use strict';
// BPM & Key Finder core tests. The detector is checked against invented songs whose tempo and key are known exactly (drums,
// bass, chords and a melody, rendered by src/synth.js), including the hard cases: no drums, no tonal parts, noise, a
// detuned recording, a drifting tempo. Tags are written to real FLAC / MP3 / M4A / Ogg / WAV files made by ffmpeg and the
// audio is compared before and after. Real-song accuracy is NOT claimed here: invented songs are friendlier than recordings.
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const A = require('../src/analyse');
const M = require('../src/music');
const T = require('../src/tags');
const { Pool, ffmpegPath } = require('../src/pool');
const { makeSong, writeWav } = require('../src/synth');

const ff = ffmpegPath();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bpmkey-test-'));
const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const near = (a, b, tol, msg) => assert(Math.abs(a - b) <= tol, `${msg || ''} expected ${b} +/- ${tol}, got ${a}`);
const keyOf = (tonic, mode) => ({ tonic, mode });
const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

function ffmpeg(args) {
  const r = spawnSync(ff, ['-y', '-hide_banner', '-v', 'error', ...args], { encoding: 'utf8', windowsHide: true });
  assert.strictEqual(r.status, 0, 'ffmpeg failed: ' + r.stderr);
}
/** MD5 of a file's decoded audio (tags do not take part), to prove writing tags leaves the sound alone. */
function audioHash(file) {
  const r = spawnSync(ff, ['-hide_banner', '-v', 'error', '-i', file, '-vn', '-f', 's16le', '-'], { maxBuffer: 1 << 28, windowsHide: true });
  assert.strictEqual(r.status, 0, 'decode failed');
  return crypto.createHash('md5').update(r.stdout).digest('hex');
}

// ---- the maths ---------------------------------------------------------------------------------------------------------------
test('fft: a pure tone lands in the right bin and the energy is conserved', () => {
  const n = 1024; const fft = A.makeFft(n);
  const re = new Float64Array(n); const im = new Float64Array(n);
  for (let i = 0; i < n; i++) re[i] = Math.sin((2 * Math.PI * 40 * i) / n);
  const energy = re.reduce((s, v) => s + v * v, 0);
  fft(re, im);
  let top = 0; let at = 0; let spec = 0;
  for (let k = 0; k < n; k++) { const m = Math.hypot(re[k], im[k]); spec += m * m; if (k < n / 2 && m > top) { top = m; at = k; } }
  assert.strictEqual(at, 40);
  near(spec / n, energy, 1e-6, 'Parseval');
});

test('synth: the invented songs have the tempo asked for (kick positions) and stay below clipping', () => {
  const s = makeSong({ bpm: 120, tonic: 0, mode: 'major', seconds: 8, tonal: false });
  let peak = 0; for (const v of s) peak = Math.max(peak, Math.abs(v));
  assert(peak <= 0.86 && peak > 0.5, 'level ' + peak);
  assert.strictEqual(s.length, 8 * 22050);
});

// ---- tempo --------------------------------------------------------------------------------------------------------------------
test('tempo: songs from 84 to 178 BPM come out exact to half a BPM, drum patterns of both kinds', () => {
  const bad = [];
  [84, 90, 97.5, 104, 112, 120, 126, 128, 133, 140, 146, 152, 160, 168, 174, 178].forEach((bpm, i) => {
    const r = A.analysePcm(makeSong({ bpm, tonic: (i * 5) % 12, mode: i % 2 ? 'minor' : 'major', seconds: 22, seed: 100 + i, fourOnFloor: i % 3 === 0 }));
    if (Math.abs(r.bpm - bpm) > 0.5) bad.push(`${bpm}->${r.bpm}`);
  });
  assert.deepStrictEqual(bad, []);
});

test('tempo: a fractional tempo is found to a tenth (93.7 BPM over 40 s)', () => {
  const r = A.analysePcm(makeSong({ bpm: 93.7, tonic: 4, seconds: 40, seed: 9 }));
  near(r.bpm, 93.7, 0.12);
});

test('tempo: very slow songs are listed at double speed (60 -> 120), the documented DJ convention', () => {
  const r = A.analysePcm(makeSong({ bpm: 60, tonic: 2, seconds: 30, seed: 4 }));
  near(r.bpm, 120, 0.5);
});

test('tempo: a song with no drums at all still gets its tempo from the bass and melody', () => {
  const r = A.analysePcm(makeSong({ bpm: 108, tonic: 9, mode: 'minor', seconds: 36, drums: false, seed: 3 }));
  near(r.bpm, 108, 0.5);
});

test('tempo: drums alone give the tempo but no believable key', () => {
  const r = A.analysePcm(makeSong({ bpm: 132, tonic: 0, tonal: false, seconds: 30, seed: 5 }));
  near(r.bpm, 132, 0.5);
  assert(r.keyConfidence < 0.5, 'key confidence on drums only: ' + r.keyConfidence);
});

test('tempo: the confidence tells a steady beat from noise, a held chord and a drifting tempo', () => {
  const rate = 22050; const n = rate * 36;
  const steady = A.analysePcm(makeSong({ bpm: 124, tonic: 7, seconds: 36, seed: 6 }));
  assert(steady.bpmConfidence > 0.9, 'steady ' + steady.bpmConfidence);
  let seed = 7; const noise = new Float32Array(n); for (let i = 0; i < n; i++) { seed = (seed * 1664525 + 1013904223) >>> 0; noise[i] = (seed / 4294967296 - 0.5) * 0.5; }
  assert(A.analysePcm(noise).bpmConfidence < 0.2, 'noise');
  const pad = new Float32Array(n); for (let i = 0; i < n; i++) pad[i] = 0.1 * (Math.sin((2 * Math.PI * 220 * i) / rate) + Math.sin((2 * Math.PI * 277.18 * i) / rate));
  assert(A.analysePcm(pad).bpmConfidence < 0.2, 'held chord');
  const parts = []; for (let k = 0; k < 8; k++) parts.push(makeSong({ bpm: 120 + k * 1.4, tonic: 7, seconds: 5.2, seed: 5 + k }));
  const drift = new Float32Array(parts.reduce((s, p) => s + p.length, 0)); let o = 0; for (const p of parts) { drift.set(p, o); o += p.length; }
  const d = A.analysePcm(drift);
  assert(d.bpmConfidence < steady.bpmConfidence - 0.3, `a drifting tempo is less certain (${d.bpmConfidence} vs ${steady.bpmConfidence})`);
  near(d.bpm, 125, 5, 'a drifting tempo gets roughly its average');
});

// ---- key --------------------------------------------------------------------------------------------------------------------------
test('key: all 24 keys are named correctly', () => {
  const bad = [];
  for (let tonic = 0; tonic < 12; tonic++) {
    for (const mode of ['major', 'minor']) {
      const r = A.analysePcm(makeSong({ bpm: 100 + tonic * 3, tonic, mode, seconds: 18, seed: 50 + tonic * 2 + (mode === 'minor' ? 1 : 0) }));
      const want = NAMES[tonic] + (mode === 'minor' ? 'm' : '');
      if (!r.key || r.key.name !== want) bad.push(`${want}->${r.key ? r.key.name : 'none'}`);
    }
  }
  assert.deepStrictEqual(bad, []);
});

test('key: a recording tuned off A = 440 Hz is still read right, and the tuning is reported', () => {
  for (const [cents, tonic, mode] of [[40, 4, 'minor'], [-35, 9, 'major'], [25, 2, 'major'], [-45, 11, 'minor']]) {
    const r = A.analysePcm(makeSong({ bpm: 110, tonic, mode, cents, seconds: 28, seed: 21 }));
    assert.strictEqual(r.key.name, NAMES[tonic] + (mode === 'minor' ? 'm' : ''), `${cents} cents`);
    near(r.tuningCents, cents, 10, `tuning for ${cents}`);
  }
});

test('key: confidence is high when the key is clear and the runner-up keys are listed', () => {
  const r = A.analysePcm(makeSong({ bpm: 120, tonic: 5, mode: 'major', seconds: 30, seed: 8 }));
  assert(r.keyConfidence > 0.8, 'confidence ' + r.keyConfidence);
  assert.strictEqual(r.keyAlternatives.length, 3);
  assert(r.keyAlternatives.every((k) => k.score < r.keyScore));
});

test('analysis: silence and clips that are too short are refused with a plain message', () => {
  assert.throws(() => A.analysePcm(new Float32Array(22050 * 20)), /silent/);
  assert.throws(() => A.analysePcm(makeSong({ bpm: 120, tonic: 0, seconds: 4 })), /too short/);
});

// ---- files ---------------------------------------------------------------------------------------------------------------------------
test('files: the same song as WAV, FLAC, MP3, Ogg and M4A gives the same answer (decoded by the bundled ffmpeg)', async () => {
  const wav = writeWav(path.join(tmp, 'song.wav'), makeSong({ bpm: 126, tonic: 2, mode: 'minor', seconds: 30, seed: 12 }));
  const got = [];
  for (const ext of ['wav', 'flac', 'mp3', 'ogg', 'm4a']) {
    const file = path.join(tmp, 'song.' + ext);
    if (ext !== 'wav') ffmpeg(['-i', wav, ...(ext === 'mp3' ? ['-b:a', '192k'] : ext === 'm4a' ? ['-c:a', 'aac', '-b:a', '160k'] : ext === 'ogg' ? ['-c:a', 'libvorbis'] : []), file]);
    const r = await A.analyseFile(ff, file, {});
    got.push(`${ext}:${r.bpm.toFixed(1)}:${r.key.name}`);
    near(r.bpm, 126, 0.6, ext);
    assert.strictEqual(r.key.name, 'Dm', ext);
  }
  assert.strictEqual(got.length, 5);
});

test('files: a very long song is read from its middle, and a file that is not audio gives a readable error', async () => {
  const f = path.join(tmp, 'song.wav');
  const r = await A.analyseFile(ff, f, { duration: 500 }); // pretends to be 500 s long: reads 480 s from the middle (10 s in)
  assert.strictEqual(r.analysedFrom, 10);
  const junk = path.join(tmp, 'junk.mp3'); fs.writeFileSync(junk, Buffer.alloc(5000, 7));
  await assert.rejects(A.analyseFile(ff, junk, {}), (e) => e instanceof A.AnalyseError && e.message.length > 3);
});

// ---- the pool ---------------------------------------------------------------------------------------------------------------------------
test('pool: several songs are analysed at once, in order of answers, and cancel stops them all and leaves the pool usable', async () => {
  const pool = new Pool({ size: 3 });
  try {
    const files = [];
    for (let i = 0; i < 6; i++) files.push(writeWav(path.join(tmp, `p${i}.wav`), makeSong({ bpm: 100 + i * 10, tonic: i * 2, seconds: 24, seed: 30 + i })));
    const results = await Promise.all(files.map((f) => pool.run(f)));
    results.forEach((r, i) => near(r.bpm, 100 + i * 10, 0.6, 'song ' + i));
    assert(pool.workers.size <= 3, 'never more workers than asked: ' + pool.workers.size);

    const jobs = files.concat(files).map((f) => pool.run(f).then(() => 'done', (e) => (e.cancelled ? 'cancelled' : 'error:' + e.message)));
    await new Promise((r) => setTimeout(r, 40));
    pool.cancel();
    const outcome = await Promise.all(jobs);
    assert(outcome.every((o) => o === 'cancelled' || o === 'done'), JSON.stringify(outcome));
    assert(outcome.filter((o) => o === 'cancelled').length >= 6, 'most were stopped: ' + outcome.join());
    const again = await pool.run(files[0]);
    near(again.bpm, 100, 0.6, 'the pool works after a cancel');
    await assert.rejects(pool.run(path.join(tmp, 'missing.wav')), (e) => e.analysis === true);
  } finally { pool.close(); }
});

// ---- notation -------------------------------------------------------------------------------------------------------------------------------
test('notation: key names in three styles match the Camelot wheel and Open Key', () => {
  assert.strictEqual(M.keyName(keyOf(0, 'major')), 'C');
  assert.strictEqual(M.keyName(keyOf(9, 'minor')), 'Am');
  assert.strictEqual(M.keyName(keyOf(1, 'major')), 'Db');
  assert.strictEqual(M.keyName(keyOf(3, 'minor')), 'Ebm');
  assert.strictEqual(M.keyName(keyOf(6, 'minor')), 'F#m');
  const cam = (t, m) => M.keyName(keyOf(t, m), 'camelot');
  const open = (t, m) => M.keyName(keyOf(t, m), 'openkey');
  assert.strictEqual(cam(0, 'major'), '8B'); assert.strictEqual(cam(9, 'minor'), '8A');
  assert.strictEqual(cam(7, 'major'), '9B'); assert.strictEqual(cam(4, 'minor'), '9A');
  assert.strictEqual(cam(11, 'major'), '1B'); assert.strictEqual(cam(8, 'minor'), '1A');
  assert.strictEqual(cam(6, 'minor'), '11A'); assert.strictEqual(cam(1, 'major'), '3B');
  assert.strictEqual(open(0, 'major'), '1d'); assert.strictEqual(open(9, 'minor'), '1m');
  assert.strictEqual(open(4, 'minor'), '2m'); assert.strictEqual(open(6, 'minor'), '4m'); assert.strictEqual(open(7, 'major'), '2d');
  // neighbours on the wheel are a fifth apart; relative major/minor share a number
  for (let t = 0; t < 12; t++) {
    assert.strictEqual(parseInt(cam(t, 'major'), 10), parseInt(cam((t + 9) % 12, 'minor'), 10), 'relative minor of ' + t);
    const n = parseInt(cam(t, 'major'), 10);   // one step clockwise on the wheel is a fifth up, and the number goes up by one (12 -> 1)
    assert.strictEqual(parseInt(cam((t + 7) % 12, 'major'), 10), (n % 12) + 1, 'a fifth above ' + t);
  }
});

test('notation: every key survives a trip through each style, and tags written by other programs are understood', () => {
  assert.strictEqual(M.ALL_KEYS.length, 24);
  assert.strictEqual(new Set(M.KEYS_BY_WHEEL.map((k) => M.keyName(k, 'camelot'))).size, 24);
  assert.strictEqual(M.keyName(M.KEYS_BY_WHEEL[0], 'camelot'), '1A');
  for (const style of ['musical', 'camelot', 'openkey']) for (const k of M.ALL_KEYS) assert(M.sameKey(M.parseKey(M.keyName(k, style)), k), `${style} ${M.keyName(k, style)}`);
  const p = (s) => M.parseKey(s);
  assert(M.sameKey(p('A minor'), keyOf(9, 'minor'))); assert(M.sameKey(p('F# Minor'), keyOf(6, 'minor')));
  assert(M.sameKey(p('Db major'), keyOf(1, 'major'))); assert(M.sameKey(p('C#'), keyOf(1, 'major')));
  assert(M.sameKey(p('bbm'), keyOf(10, 'minor'))); assert(M.sameKey(p('08B'), keyOf(0, 'major'))); assert(M.sameKey(p('8a'), keyOf(9, 'minor')));
  assert(M.sameKey(p('E♭'), keyOf(3, 'major'))); assert(M.sameKey(p(' Gmaj '), keyOf(7, 'major'))); assert(M.sameKey(p('Emin'), keyOf(4, 'minor')));
  for (const bad of ['', '  ', 'H', '13A', '0B', 'Am7', 'minor', 'X#m', null, undefined]) assert.strictEqual(p(bad), null, JSON.stringify(bad));
});

test('notation: BPM text, halving and doubling stay in range, confidence words, times', () => {
  assert.strictEqual(M.bpmLabel(128), '128'); assert.strictEqual(M.bpmLabel(127.96), '128'); assert.strictEqual(M.bpmLabel(87.54), '87.5'); assert.strictEqual(M.bpmLabel(null), '');
  assert.strictEqual(M.halve(140), 70); assert.strictEqual(M.double(70), 140); assert.strictEqual(M.halve(30), 20); assert.strictEqual(M.double(300), 400);
  assert.strictEqual(M.bpmForTag(127.6), 128); assert.strictEqual(M.bpmForTag(87.4), 87);
  assert.deepStrictEqual([0.9, 0.5, 0.1, NaN].map(M.tempoSureness), ['clear', 'fair', 'unsure', 'unsure']);
  assert.deepStrictEqual([0.9, 0.5, 0.3].map(M.keySureness), ['clear', 'fair', 'unsure']);
  assert.strictEqual(M.formatTime(65), '1:05'); assert.strictEqual(M.formatTime(3599.6), '60:00'); assert.strictEqual(M.keyLong(keyOf(9, 'minor')), 'A minor'); assert.strictEqual(M.keyLong(keyOf(1, 'major')), 'Db major');
});

test('write plan: fills empty tags, leaves existing ones unless asked, and says why it skipped', () => {
  const row = (o) => ({ tagBpm: 0, tagKey: '', bpm: 127.6, key: keyOf(9, 'minor'), ...o });
  const opt = (o) => ({ bpm: true, key: true, style: 'musical', replace: false, ...o });
  assert.deepStrictEqual(M.planWrite(row({}), opt({})), { skipped: [], bpm: 128, key: 'Am' });
  assert.deepStrictEqual(M.planWrite(row({}), opt({ style: 'camelot' })).key, '8A');
  assert.deepStrictEqual(M.planWrite(row({}), opt({ style: 'openkey' })).key, '1m');
  let p = M.planWrite(row({ tagBpm: 100, tagKey: 'C' }), opt({}));
  assert(p.bpm == null && p.key == null && p.skipped.length === 2 && p.skipped.every((s) => /already has/.test(s)));
  p = M.planWrite(row({ tagBpm: 100, tagKey: 'C' }), opt({ replace: true }));
  assert.strictEqual(p.bpm, 128); assert.strictEqual(p.key, 'Am');
  p = M.planWrite(row({ tagBpm: 128, tagKey: 'Am' }), opt({ replace: true }));
  assert(p.bpm == null && p.key == null && p.skipped.every((s) => /same/.test(s)));
  p = M.planWrite(row({ bpm: null, key: null }), opt({}));
  assert.deepStrictEqual(p.skipped, ['no BPM found', 'no key found']);
  p = M.planWrite(row({}), opt({ key: false })); assert(p.key == null && p.bpm === 128);
  p = M.planWrite(row({}), opt({ bpm: false })); assert(p.bpm == null && p.key === 'Am');
});

test('csv: quotes, commas and line breaks are escaped, and a leading = + - @ cannot become a spreadsheet formula', () => {
  const csv = M.toCsv([{ name: '=SUM(A1).mp3', title: 'Hello, "World"', artist: 'A\nB', durationMs: 185000, bpm: 127.96, bpmConfidence: 0.9, key: keyOf(9, 'minor'), keyConfidence: 0.5, tagBpm: 0, tagKey: '' }]);
  const lines = csv.split('\r\n');
  assert.strictEqual(lines[0], 'File,Title,Artist,Length,BPM,BPM confidence,Key,Camelot,Open Key,Key confidence,BPM in tag,Key in tag');
  assert(csv.includes(`'=SUM(A1).mp3,"Hello, ""World""","A\nB",3:05,128,clear,Am,8A,1m,fair,,`), csv);
  assert(csv.endsWith('\r\n'));
});

// ---- tags --------------------------------------------------------------------------------------------------------------------------------------
test('tags: BPM and key are written to FLAC, MP3, M4A, Ogg and WAV, read back, and the sound is untouched', () => {
  const src = path.join(tmp, 'tagsrc.wav');
  writeWav(src, makeSong({ bpm: 100, tonic: 0, seconds: 9, seed: 2 }));
  for (const ext of ['flac', 'mp3', 'm4a', 'ogg', 'wav']) {
    const file = path.join(tmp, 'tag-' + ext + '.' + ext);
    if (ext === 'wav') fs.copyFileSync(src, file);
    else ffmpeg(['-i', src, '-metadata', 'title=Keep Me', '-metadata', 'artist=Some Artist', ...(ext === 'm4a' ? ['-c:a', 'aac'] : ext === 'ogg' ? ['-c:a', 'libvorbis'] : []), file]);
    const before = audioHash(file);
    const r0 = T.readTags(file);
    assert.strictEqual(r0.tagBpm, 0, ext + ' starts without a BPM'); assert.strictEqual(r0.tagKey, '', ext);
    near(r0.durationMs, 9000, 150, ext + ' length');
    const after = T.writeTags(file, { bpm: 128, key: 'F#m' });
    assert.strictEqual(after.tagBpm, 128, ext); assert.strictEqual(after.tagKey, 'F#m', ext);
    const again = T.readTags(file);
    assert.strictEqual(again.tagBpm, 128, ext + ' read again'); assert.strictEqual(again.tagKey, 'F#m', ext + ' read again');
    if (ext !== 'wav') { assert.strictEqual(again.title, 'Keep Me', ext + ' keeps the title'); assert.strictEqual(again.artist, 'Some Artist', ext + ' keeps the artist'); }
    assert.strictEqual(audioHash(file), before, ext + ': the audio must be identical');
    T.writeTags(file, { key: '8A' });                     // one field at a time leaves the other alone
    assert.strictEqual(T.readTags(file).tagBpm, 128); assert.strictEqual(T.readTags(file).tagKey, '8A');
  }
});

test('tags: bad input and unwritable files are refused and the file is left exactly as it was', () => {
  const file = path.join(tmp, 'safe.flac');
  ffmpeg(['-i', path.join(tmp, 'tagsrc.wav'), file]);
  const bytes = fs.readFileSync(file);
  assert.throws(() => T.writeTags(file, { bpm: 0 }), /whole number/);
  assert.throws(() => T.writeTags(file, { bpm: 12.5 }), /whole number/);
  assert.throws(() => T.writeTags(file, { bpm: 1000 }), /whole number/);
  assert.throws(() => T.writeTags(file, { key: 'Z#' }), /Not a key/);
  assert.throws(() => T.writeTags(path.join(tmp, 'x.aac'), { bpm: 100 }), /cannot hold tags/);
  assert(fs.readFileSync(file).equals(bytes), 'nothing written for refused input');
  fs.chmodSync(file, 0o444);
  try {
    if (process.platform === 'win32' || process.getuid() !== 0) {
      assert.throws(() => T.writeTags(file, { bpm: 120, key: 'C' }), /file left unchanged/);
      assert(fs.readFileSync(file).equals(bytes), 'a failed save leaves the bytes alone');
    }
  } finally { fs.chmodSync(file, 0o644); }
  assert.deepStrictEqual(fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith(`bpmkey-${process.pid}-`)), [], 'no backup files left behind');
  const junk = path.join(tmp, 'broken.mp3'); fs.writeFileSync(junk, Buffer.alloc(300, 1));
  const r = T.readTags(junk);
  assert(r.tagError && r.canWrite === false && r.tagBpm === 0, 'unreadable tags are reported, not thrown');
});

// ---- the look --------------------------------------------------------------------------------------------------------------------------------------
test('look: the accent and text colours are readable on the dark background', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'styles.css'), 'utf8');
  const tokens = {};
  for (const m of css.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-fA-F]{6})/g)) tokens[m[1]] = m[2];
  const lum = (hex) => { const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  const pairs = [['text', 'bg', 4.5], ['muted', 'bg', 4.5], ['muted', 'panel', 4.5], ['accent', 'bg', 4.5], ['err', 'bg', 4.5], ['ok', 'bg', 4.5], ['warn', 'bg', 4.5], ['on-accent', 'accent', 4.5]];
  const bad = pairs.filter(([a, b, min]) => !tokens[a] || !tokens[b] || ratio(tokens[a], tokens[b]) < min).map(([a, b, min]) => `${a} on ${b} < ${min}`);
  assert.deepStrictEqual(bad, []);
});

(async () => {
  let failed = 0;
  for (const [name, fn] of tests) {
    const t0 = Date.now();
    try { await fn(); console.log(`ok   ${name} (${Date.now() - t0} ms)`); }
    catch (e) { failed++; console.log(`FAIL ${name}\n     ${String((e && e.stack) || e).split('\n').slice(0, 6).join('\n     ')}`); }
  }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  console.log(failed ? `\n${failed} of ${tests.length} failed` : `\nall ${tests.length} passed`);
  process.exit(failed ? 1 : 0);
})();
