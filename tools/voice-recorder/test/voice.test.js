'use strict';
// Voice Recorder core tests: the WAV writer, fix-up and recovery of unfinished takes, markers, the recordings folder, and
// the cleaning chain on invented speech (src/synth.js) with known pauses and noise: pause shortening is checked by
// duration, loudness with ffmpeg's EBU R128 meter, noise reduction by the noise floor in the pauses.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const W = require('../src/wav');
const A = require('../src/analyse');
const C = require('../src/clean');
const T = require('../src/takes');
const { makeSpeech, rmsDb } = require('../src/synth');

const ff = C.ffmpegPath();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-test-'));
const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const near = (a, b, tol, msg) => assert(Math.abs(a - b) <= tol, `${msg || ''} expected ${b} +/- ${tol}, got ${a}`);
const sub = (name) => { const d = path.join(tmp, name); fs.mkdirSync(d, { recursive: true }); return d; };

function readAll(file) {
  const parts = []; W.readMono(file, (b) => parts.push(b));
  const out = new Float32Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
function probe(file) {
  const r = spawnSync(ff, ['-hide_banner', '-i', file, '-f', 'null', '-'], { encoding: 'utf8', windowsHide: true });
  const d = /Duration: (\d+):(\d+):([\d.]+)/.exec(r.stderr);
  const codec = /Audio: ([a-z0-9_]+)/.exec(r.stderr);
  const title = /title\s*:\s*(.*)/.exec(r.stderr);
  return { ok: r.status === 0, duration: d ? +d[1] * 3600 + +d[2] * 60 + +d[3] : NaN, codec: codec && codec[1], title: title && title[1].trim(), err: r.stderr };
}
const sine = (n, f, sr, a = 0.5) => Float32Array.from({ length: n }, (_, i) => a * Math.sin((2 * Math.PI * f * i) / sr));

// ---- WAV --------------------------------------------------------------------------------------------------------------------
test('wav: the header says what the file holds (rate, channels, sizes) and ffmpeg reads it', () => {
  const f = path.join(tmp, 'a.wav');
  W.writeFloatWav(f, sine(24000, 440, 48000), 48000);
  const b = fs.readFileSync(f);
  assert.strictEqual(b.toString('ascii', 0, 4), 'RIFF');
  assert.strictEqual(b.readUInt32LE(4), b.length - 8);
  assert.strictEqual(b.readUInt32LE(24), 48000);
  assert.strictEqual(b.readUInt16LE(22), 1);
  assert.strictEqual(b.readUInt32LE(40), 48000);
  const i = W.inspect(f);
  near(i.duration, 0.5, 1e-9);
  const p = probe(f);
  assert(p.ok, p.err); near(p.duration, 0.5, 0.01);
});

test('wav: the writer keeps honest sizes while recording, and finish() adds the markers and renames the .part', () => {
  const d = sub('writer');
  const part = path.join(d, 'take.wav.part');
  const w = new W.WavWriter(part, { sampleRate: 44100, syncEvery: 0 });
  const chunk = W.floatToInt16(sine(4410, 300, 44100));
  for (let i = 0; i < 25; i++) w.append(chunk);
  w.append(Buffer.from([1, 2, 3])); // a half sample is dropped, a whole one kept
  near(w.seconds, 2.5 + 1 / 44100, 1e-9);
  // mid-recording the file is already valid up to the last sync
  near(W.inspect(part).duration, w.seconds, 1e-9);
  const out = w.finish(path.join(d, 'take.wav'), [{ t: 0.5, label: 'Intro ✓' }, { t: 2, label: '' }]);
  assert(!fs.existsSync(part));
  const i = W.inspect(out);
  near(i.duration, 2.5 + 1 / 44100, 1e-9);
  assert.strictEqual(i.size - 8, fs.readFileSync(out).readUInt32LE(4), 'RIFF size covers the markers');
  assert.deepStrictEqual(i.markers.map((m) => [Math.round(m.t * 1000) / 1000, m.label]), [[0.5, 'Intro ✓'], [2, 'Marker 2']]);
  assert(probe(out).ok);
  assert.throws(() => new W.WavWriter(out, { sampleRate: 44100 }), /EEXIST/, 'never overwrites');
});

test('wav: an unfinished take (sizes still 0, half a sample at the end) is repaired to the audio that is there', () => {
  const d = sub('repair');
  const f = path.join(d, 'crash.wav.part');
  const data = W.floatToInt16(sine(48000 * 3, 200, 48000));
  // what a crash leaves: the header from the start of recording, then audio, then a torn write
  fs.writeFileSync(f, Buffer.concat([W.header({ sampleRate: 48000, dataBytes: 0 }), data, Buffer.from([7])]));
  assert(!probe(f).ok || probe(f).duration < 0.1 || true); // players may refuse or play nothing
  const secs = W.repair(f);
  near(secs, 3, 1e-9);
  const b = fs.readFileSync(f);
  assert.strictEqual(b.length, 44 + data.length, 'torn byte cut off');
  assert.strictEqual(b.readUInt32LE(40), data.length);
  assert.strictEqual(b.readUInt32LE(4), b.length - 8);
  const copy = path.join(d, 'crash-copy.wav'); fs.copyFileSync(f, copy);
  const p = probe(copy); assert(p.ok, p.err); near(p.duration, 3, 0.01);
  // a stale size that is too big is also corrected
  const g = path.join(d, 'big.wav');
  fs.writeFileSync(g, Buffer.concat([W.header({ sampleRate: 48000, dataBytes: 10 * data.length }), data]));
  near(W.repair(g), 3, 1e-9);
});

test('wav: not-a-WAV and empty files are refused in plain words', () => {
  const f = path.join(tmp, 'x.wav'); fs.writeFileSync(f, 'hello there, not audio');
  assert.throws(() => W.inspect(f), /not a WAV/);
  const g = path.join(tmp, 'y.wav'); fs.writeFileSync(g, Buffer.alloc(0));
  assert.throws(() => W.inspect(g), /not a WAV/);
});

// ---- the recordings folder -----------------------------------------------------------------------------------------------
test('takes: a session records, pauses (dropping what comes in), marks, and stops to a dated take', () => {
  const d = sub('session');
  const s = new T.Session(d, { sampleRate: 48000, date: new Date(2026, 10, 10, 21, 4, 33), syncEvery: 0 });
  assert.strictEqual(path.basename(s.partPath), '2026-11-10 21.04.33.wav.part');
  const sec = W.floatToInt16(sine(48000, 220, 48000, 0.3));
  s.append(sec);
  s.mark();
  s.pause(); s.append(sec); s.append(sec); s.resume();
  s.append(sec);
  const out = s.stop();
  assert.strictEqual(path.basename(out), '2026-11-10 21.04.33.wav');
  const info = T.describe(out);
  near(info.duration, 2, 1e-9);
  assert.strictEqual(info.markers.length, 1); near(info.markers[0].t, 1, 1e-9);
  assert.strictEqual(info.title, '');
  // a second take started in the same second gets its own name
  const s2 = new T.Session(d, { sampleRate: 48000, date: new Date(2026, 10, 10, 21, 4, 33) });
  s2.append(sec);
  assert.strictEqual(path.basename(s2.stop()), '2026-11-10 21.04.33 (2).wav');
  // an empty session leaves nothing behind
  const s3 = new T.Session(d, { sampleRate: 48000 });
  assert.strictEqual(s3.stop(), null);
  assert.strictEqual(fs.readdirSync(d).filter((n) => n.endsWith('.part')).length, 0);
});

test('takes: rename keeps the date stamp, handles unicode and clashes, refuses paths outside the folder', () => {
  const d = sub('rename');
  const s = new T.Session(d, { sampleRate: 16000, date: new Date(2026, 0, 2, 3, 4, 5) });
  s.append(W.floatToInt16(sine(16000, 220, 16000)));
  const name = path.basename(s.stop());
  const n1 = T.rename(d, name, 'Épisode 12: «Café» / part?');
  assert.strictEqual(n1, '2026-01-02 03.04.05 - Épisode 12 «Café» part.wav');
  assert.strictEqual(T.parseName(n1.replace(/\.wav$/, '')).title, 'Épisode 12 «Café» part');
  fs.writeFileSync(path.join(d, '2026-01-02 03.04.05 - Taken.wav'), 'x');
  const n2 = T.rename(d, n1, 'Taken');
  assert.strictEqual(n2, '2026-01-02 03.04.05 - Taken (2).wav');
  assert.strictEqual(T.parseName(n2.replace(/\.wav$/, '')).title, 'Taken');
  for (const bad of ['../x.wav', '..', 'a/b.wav', 'nope.wav', 'x.txt', 5]) assert.throws(() => T.resolveTake(d, bad));
  const listed = T.list(d).map((t) => t.name);
  assert(listed.includes(n2));
});

test('takes: on the next start, unfinished takes are fixed and renamed "(recovered)"; empty ones are removed', () => {
  const d = sub('recover');
  const s = new T.Session(d, { sampleRate: 48000, date: new Date(2026, 4, 6, 7, 8, 9), syncEvery: 60000 });
  for (let i = 0; i < 4; i++) s.append(W.floatToInt16(sine(12000, 330, 48000)));
  // simulate the crash: the file is never finished and the sizes were never refreshed
  fs.closeSync(s.writer.fd);
  const other = path.join(sub('elsewhere'), 'old.wav.part');
  fs.writeFileSync(other, W.header({ sampleRate: 48000 }));
  const got = T.recover([other], [d]);
  assert.strictEqual(got.length, 1, JSON.stringify(got));
  assert.strictEqual(got[0].name, '2026-05-06 07.08.09 (recovered).wav');
  near(got[0].seconds, 1, 1e-9);
  assert(!fs.existsSync(other), 'the empty part file is removed');
  const t = T.list(d)[0];
  assert.strictEqual(t.recovered, true);
  near(t.duration, 1, 1e-9);
  assert(probe(path.join(d, t.name)).ok);
});

// ---- analysis ---------------------------------------------------------------------------------------------------------------
const SR = 48000;
const speech = makeSpeech({ phrases: [2.4, 3.0, 2.2, 2.0], pauses: [0.4, 2.5, 4.0, 0.6], lead: 0.5, noise: 0.004, seed: 7 });
const speechFile = W.writeFloatWav(path.join(tmp, 'speech.wav'), speech.samples, SR);

test('analyse: finds the noise floor, the speech level and the pauses where they really are', () => {
  const an = A.analyse(speechFile);
  near(an.duration, speech.duration, 1e-6);
  near(an.floorDb, rmsDb(speech.samples, SR, 7, 8), 2, 'floor');
  assert(an.speechDb > an.floorDb + 20, 'speech well above the noise');
  const th = A.silenceThreshold(an.floorDb, an.speechDb);
  const p = A.findPauses(an.db, an.win, { minPause: 1, threshold: th });
  const want = speech.pauses.filter(([a, b]) => b - a >= 1);
  assert.strictEqual(p.length, want.length, JSON.stringify(p));
  p.forEach(([a, b], i) => { near(a, want[i][0], 0.08, 'pause start'); near(b, want[i][1], 0.08, 'pause end'); });
  const q = A.quietestStretch(an.db, an.win, { threshold: th });
  assert(q && q.end - q.start >= 2.5, JSON.stringify(q));
  assert(want.some(([a, b]) => q.start >= a && q.end <= b), 'quiet stretch inside a pause');
  const wf = A.waveform(an, 300);
  assert.strictEqual(wf.length, 300);
  assert(Math.max(...wf) > 0.2);
});

test('pause cuts: only pauses longer than the limit shrink, to the length asked, half on each side', () => {
  const cuts = A.pauseCuts([[1, 1.5], [3, 6], [10, 11.2]], { longer: 1, keep: 0.4 });
  assert.deepStrictEqual(cuts.map((c) => c.map((v) => Math.round(v * 100) / 100)), [[3.2, 5.8], [10.2, 11]]);
});

// ---- cleaning ---------------------------------------------------------------------------------------------------------------
test('clean: shortening pauses > 1 s to 0.5 s gives exactly the expected length, and the speech is untouched', async () => {
  const an = A.analyse(speechFile);
  const out = path.join(tmp, 'short.wav');
  const r = await C.render(speechFile, an, { pauses: { on: true, longer: 1, keep: 0.5 } }, { output: out });
  const long = speech.pauses.filter(([a, b]) => b - a > 1);
  const expected = speech.duration - long.reduce((s, [a, b]) => s + (b - a - 0.5), 0);
  near(r.duration, expected, 0.1, 'planned');
  near(W.inspect(out).duration, expected, 0.1, 'file');
  assert.strictEqual(r.cuts, 2);
  // the speech energy is all still there (only noise was removed)
  const x = readAll(out);
  const energy = (s) => s.reduce((t, v) => t + v * v, 0);
  near(10 * Math.log10(energy(x) / energy(speech.samples)), 0, 0.3, 'energy ratio dB');
  // the short pause (0.4 s) and the 0.6 s one are still there in full: the first phrase ends at the same place
  const an2 = A.analyse(out);
  const p2 = A.findPauses(an2.db, an2.win, { minPause: 0.3, threshold: A.silenceThreshold(an2.floorDb, an2.speechDb) });
  const [sa, sb] = speech.pauses[1];
  assert(sb - sa < 1, 'the first pause is a short one');
  assert(p2.some(([a, b]) => Math.abs(a - sa) < 0.1 && Math.abs(b - a - (sb - sa)) < 0.1), 'short pause kept: ' + JSON.stringify(p2));
  assert(p2.filter(([a, b]) => b - a > 0.3).every(([a, b]) => b - a <= 1), 'no pause over 1 s left: ' + JSON.stringify(p2));
});

for (const target of [-16, -19]) {
  test(`clean: loudness reaches ${target} LUFS within 0.5 LU (measured with ffmpeg ebur128), true peak kept under -1 dBTP`, async () => {
    const quiet = makeSpeech({ phrases: [3, 3, 3, 3], pauses: [0.5, 0.7, 0.4, 0.5], level: 0.08, noise: 0.001, seed: 11 + target });
    const f = W.writeFloatWav(path.join(tmp, `quiet${target}.wav`), quiet.samples, SR);
    const out = path.join(tmp, `loud${target}.flac`);
    await C.render(f, A.analyse(f), { loudness: { on: true, target } }, { output: out, format: 'flac' });
    const m = await C.loudnessOf(out);
    near(m.i, target, 0.5, 'integrated loudness');
    assert(m.tp <= -1, 'true peak ' + m.tp);
  });
}

test('clean: noise reduction lowers the noise floor by at least 8 dB and keeps the speech level within 1.5 dB', async () => {
  const an = A.analyse(speechFile);
  const out = path.join(tmp, 'denoised.wav');
  const r = await C.render(speechFile, an, { denoise: { on: true, strength: 'medium' } }, { output: out });
  assert(r.noise, 'a quiet stretch was found to learn the noise from');
  const x = readAll(out);
  const [ps, pe] = speech.pauses.find(([a, b]) => b - a > 3);
  const before = rmsDb(speech.samples, SR, ps + 0.3, pe - 0.3); const after = rmsDb(x, SR, ps + 0.3, pe - 0.3);
  assert(before - after >= 8, `noise floor ${before.toFixed(1)} -> ${after.toFixed(1)} dB`);
  const [ss, se] = speech.speech[1];
  near(rmsDb(x, SR, ss, se), rmsDb(speech.samples, SR, ss, se), 1.5, 'speech level');
  // a hand-picked noise sample works too, and so does no sample at all (no pauses in the take)
  const r2 = await C.render(speechFile, an, { denoise: { on: true, strength: 'strong', sample: { start: ps + 0.2, end: ps + 1.5 } } }, { output: path.join(tmp, 'den2.wav') });
  near(r2.noise.start, ps + 0.2, 1e-9);
  const y = readAll(path.join(tmp, 'den2.wav'));
  assert(before - rmsDb(y, SR, ps + 2, pe - 0.3) >= 8, 'hand-picked sample');
  near(W.inspect(path.join(tmp, 'den2.wav')).duration, speech.duration, 0.01, 'length unchanged');
});

test('clean: high-pass removes 50 Hz hum (rumble) but not the voice', async () => {
  const hum = makeSpeech({ phrases: [2, 2], pauses: [1.5, 0.5], hum: 0.05, seed: 3 });
  const f = W.writeFloatWav(path.join(tmp, 'hum.wav'), hum.samples, SR);
  const out = path.join(tmp, 'nohum.wav');
  await C.render(f, A.analyse(f), { highpass: { on: true, freq: 100 } }, { output: out });
  const x = readAll(out);
  const [a, b] = hum.pauses[1];
  assert(rmsDb(hum.samples, SR, a + 0.2, b - 0.2) - rmsDb(x, SR, a + 0.2, b - 0.2) >= 10, 'hum lowered');
});

test('clean: trim keeps only the chosen stretch; all filters together run; the result is mono at the take rate', async () => {
  const an = A.analyse(speechFile);
  const out = path.join(tmp, 'all.wav');
  const r = await C.render(speechFile, an, { trim: { start: 0.4, end: 12 }, highpass: { on: true }, declick: true, deess: true, denoise: { on: true }, pauses: { on: true, longer: 1, keep: 0.5 }, loudness: { on: true, target: -19 } }, { output: out });
  const i = W.inspect(out);
  assert.strictEqual(i.fmt.channels, 1); assert.strictEqual(i.fmt.sampleRate, SR);
  near(i.duration, r.duration, 0.1);
  assert(r.duration < 11.6 - 1.9, 'pauses inside the trim were shortened: ' + r.duration);
  near((await C.loudnessOf(out)).i, -19, 0.5);
});

test('export: WAV, FLAC, MP3, M4A and Opus come out playable with the title, via .part (nothing left behind)', async () => {
  const d = sub('exports');
  const an = A.analyse(speechFile);
  for (const [fmt, codec] of [['wav', 'pcm_s16le'], ['flac', 'flac'], ['mp3', 'mp3'], ['m4a', 'aac'], ['opus', 'opus']]) {
    const out = C.uniquePath(d, '2026-11-10 21.04.33 - Café talk', C.FORMATS[fmt].ext);
    await C.render(speechFile, an, {}, { output: out, format: fmt, title: 'Café talk ✓', date: '2026-11-10' });
    const p = probe(out);
    assert(p.ok, fmt + ': ' + p.err);
    assert.strictEqual(p.codec, codec, fmt);
    near(p.duration, speech.duration, 0.1, fmt + ' duration');
    assert.strictEqual(p.title, 'Café talk ✓', fmt + ' title');
  }
  assert.strictEqual(fs.readdirSync(d).filter((n) => n.endsWith('.part')).length, 0);
  assert.strictEqual(path.basename(C.uniquePath(d, '2026-11-10 21.04.33 - Café talk', 'mp3')), '2026-11-10 21.04.33 - Café talk (2).mp3');
});

test('export: cancelling stops ffmpeg and leaves no file; a trim with nothing left is refused in plain words', async () => {
  const long = makeSpeech({ phrases: Array(30).fill(3), pauses: Array(30).fill(0.5), noise: 0.003, seed: 5 });
  const f = W.writeFloatWav(path.join(tmp, 'long.wav'), long.samples, SR);
  const an = A.analyse(f);
  const ac = new AbortController();
  const out = path.join(tmp, 'cancelled.flac');
  const p = C.render(f, an, { denoise: { on: true }, declick: true, loudness: { on: true } }, { output: out, format: 'flac', signal: ac.signal });
  setTimeout(() => ac.abort(), 150);
  await assert.rejects(p, (e) => e.cancelled === true);
  assert(!fs.existsSync(out) && !fs.existsSync(out + '.part'));
  await assert.rejects(C.render(f, an, { trim: { start: 5, end: 5.05 } }, { output: path.join(tmp, 'none.wav') }), /nothing left|leaves no sound/);
});

test('settings from the window are validated: odd values fall back to safe defaults', () => {
  const o = C.normalize({ trim: { start: -4, end: 'x' }, highpass: { on: 1, freq: 9999 }, denoise: { on: true, strength: 'nuclear', sample: { start: 3, end: 3.01 } }, pauses: { on: true, longer: -1, keep: 99 }, loudness: { on: true, target: -99 } }, 60);
  assert.strictEqual(o.trim, null);
  assert.strictEqual(o.highpass.freq, 200);
  assert.strictEqual(o.denoise.strength, 'medium'); assert.strictEqual(o.denoise.sample, null);
  assert.strictEqual(o.pauses.longer, 0.3); assert.strictEqual(o.pauses.keep, 10);
  assert.strictEqual(o.loudness.target, -16);
  assert.strictEqual(C.anyCleaning(C.normalize({})), false);
  assert.strictEqual(C.safeName(' con '), '_con');
  assert.strictEqual(C.safeName('a:b*c?'), 'a b c');
  assert.strictEqual(C.safeName('...'), 'Recording');
});

test('the colours of the window are readable (WCAG AA contrast)', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'styles.css'), 'utf8');
  const tokens = {};
  for (const m of css.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-fA-F]{6})/g)) tokens[m[1]] = m[2];
  const lum = (hex) => { const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  const pairs = [['text', 'bg', 4.5], ['muted', 'bg', 4.5], ['muted', 'panel', 4.5], ['accent', 'bg', 4.5], ['err', 'bg', 4.5], ['ok', 'bg', 4.5], ['warn', 'bg', 4.5]];
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
