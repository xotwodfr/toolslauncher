'use strict';
// Audio Editor core tests. Test sounds are tones of known pitch and loudness (see src/testkit.js), so every export is
// checked by listening to it: how long it is, which part of the original each stretch came from (by pitch), how loud it is
// and whether the cuts click.
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const P = require('../src/plan');
const E = require('../src/edit');
const K = require('../src/testkit');

const ff = E.ffmpegPath();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'audioedit-test-'));
const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const near = (a, b, tol, msg) => assert(Math.abs(a - b) <= tol, `${msg || ''} expected ${b} +/- ${tol}, got ${a}`);
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const out = (name) => path.join(tmp, 'out', name);
const dec = (f) => { const d = K.decode(ff, f); assert.strictEqual(d.errors, '', 'decode errors: ' + d.errors); return d; };
const sh = (args) => { const r = spawnSync(ff, ['-hide_banner', '-y', '-v', 'error', ...args], { encoding: 'utf8', windowsHide: true }); assert.strictEqual(r.status, 0, 'ffmpeg failed: ' + r.stderr.slice(-300)); };

/** A project item for a file, as the window would hold it. */
async function item(file, cuts = []) {
  const p = await E.probe(file);
  return { path: file, duration: p.duration, rate: p.rate, channels: p.channels, coverStream: p.coverStream, cuts };
}
const exp = async (items, opts = {}, hooks = {}) => E.render(items, { format: 'wav', outDir: path.join(tmp, 'out'), ...opts }, hooks);

let ten, tenStereo, quiet, padded, mono22;

async function fixtures() {
  ten = K.makeWav(path.join(tmp, 'ten.wav'), { rate: 44100, channels: 1, parts: K.steps(10) });              // 10 s, second n is 200 + 100n Hz
  tenStereo = K.makeWav(path.join(tmp, 'ten stereo.wav'), { rate: 48000, channels: 2, parts: K.steps(10) });
  quiet = K.makeWav(path.join(tmp, 'quiet.wav'), { rate: 44100, channels: 1, parts: [{ sec: 6, freq: 440, amp: 0.02 }] });
  padded = K.makeWav(path.join(tmp, 'padded.wav'), { rate: 44100, channels: 1, parts: [{ sec: 1.5, freq: 0 }, { sec: 3, freq: 500 }, { sec: 2, freq: 0 }] });
  mono22 = K.makeWav(path.join(tmp, 'mono22.wav'), { rate: 22050, channels: 1, parts: [{ sec: 4, freq: 900 }] });
  fs.mkdirSync(path.join(tmp, 'out'), { recursive: true });
}

// ---- the model -------------------------------------------------------------------------------------------------------
test('times: parse and format', () => {
  assert.strictEqual(P.parseTime('90'), 90);
  assert.strictEqual(P.parseTime('1:30'), 90);
  assert.strictEqual(P.parseTime('1:30.25'), 90.25);
  assert.strictEqual(P.parseTime('1:02:03.5'), 3723.5);
  assert.strictEqual(P.parseTime('1,5'), 1.5);
  assert.strictEqual(P.parseTime(''), null);
  assert(Number.isNaN(P.parseTime('abc')));
  assert(Number.isNaN(P.parseTime('1:75')));
  assert(Number.isNaN(P.parseTime('-3')));
  assert.strictEqual(P.formatTime(83.4), '1:23.400');
  assert.strictEqual(P.formatTime(83.4, false), '1:23');
  assert.strictEqual(P.formatTime(3723.5), '1:02:03.500');
  assert.strictEqual(P.formatTime(-5), '0:00.000');
  assert.strictEqual(P.formatTime(59.9996), '1:00.000');
});

test('cuts: merged, clamped, sorted; kept pieces are the rest', () => {
  assert.deepStrictEqual(P.normalizeCuts([[5, 7], [1, 2], [6, 9], [20, 30], [3, 3]], 10), [[1, 2], [5, 9]]);
  assert.deepStrictEqual(P.normalizeCuts([[-5, 2], [9, 40]], 10), [[0, 2], [9, 10]]);
  assert.deepStrictEqual(P.normalizeCuts([[1, 2], [2.001, 3]], 10), [[1, 3]], 'touching cuts merge');
  assert.deepStrictEqual(P.normalizeCuts([['x', 1], null, [4, NaN]], 10), []);
  assert.deepStrictEqual(P.keptRanges([[1, 2], [5, 9]], 10), [[0, 1], [2, 5], [9, 10]]);
  assert.deepStrictEqual(P.keptRanges([[0, 2], [9, 10]], 10), [[2, 9]]);
  assert.deepStrictEqual(P.keptRanges([], 10), [[0, 10]]);
  assert.deepStrictEqual(P.keptRanges([[0.005, 10]], 10), [], 'a sliver is not kept');
  const it = { duration: 10, cuts: [[1, 2], [5, 9]] };
  near(P.keptDuration(it), 5, 1e-9);
});

test('cuts: cut out, keep only, restore, and the time after cuts', () => {
  const it = { duration: 10, cuts: [] };
  const a = P.cutOut(it, 2, 4);
  assert.deepStrictEqual(a, [[2, 4]]);
  assert.deepStrictEqual(P.cutOut({ ...it, cuts: a }, 3, 6), [[2, 6]]);
  assert.deepStrictEqual(P.keepOnly(it, 3, 5), [[0, 3], [5, 10]]);
  assert.deepStrictEqual(P.keepOnly(it, 0, 10), []);
  assert.throws(() => P.cutOut(it, 0, 10), P.UserError);
  assert.throws(() => P.cutOut(it, 3, 3), /Select a part/);
  assert.throws(() => P.keepOnly(it, 3, 3.001), P.UserError);
  assert.deepStrictEqual(P.restoreAt([[2, 4], [6, 8]], 7), [[2, 4]]);
  assert.deepStrictEqual(P.restoreAt([[2, 4], [6, 8]], 5), [[2, 4], [6, 8]]);
  const c = { duration: 10, cuts: [[2, 4], [6, 8]] };
  near(P.afterCuts(c, 1), 1, 1e-9);
  near(P.afterCuts(c, 3), 2, 1e-9, 'inside a cut: the cut point');
  near(P.afterCuts(c, 5), 3, 1e-9);
  near(P.afterCuts(c, 9), 5, 1e-9);
});

test('options: defaults, clamping, format "same"', () => {
  const o = P.normalizeOptions({}, 'C:\\music\\a.flac');
  assert.strictEqual(o.format, 'flac');
  assert.strictEqual(o.bitrate, null);
  assert.strictEqual(P.normalizeOptions({ format: 'same' }, '/x/a.MP3').format, 'mp3');
  assert.strictEqual(P.normalizeOptions({}, '/x/a.wma').format, 'mp3');
  assert.strictEqual(P.normalizeOptions({}, '/x/a.aiff').format, 'wav');
  assert.strictEqual(P.normalizeOptions({ format: 'mp3', bitrate: 999 }).bitrate, 192);
  assert.strictEqual(P.normalizeOptions({ format: 'mp3', bitrate: 320 }).bitrate, 320);
  assert.strictEqual(P.normalizeOptions({ format: 'wav', fadeIn: 999, fadeOut: -3, gain: 99 }).fadeIn, 60);
  assert.strictEqual(P.normalizeOptions({ format: 'wav', fadeOut: -3 }).fadeOut, 0);
  assert.strictEqual(P.normalizeOptions({ format: 'wav', gain: 99 }).gain, 30);
  assert.strictEqual(P.normalizeOptions({ format: 'wav', gain: 'abc' }).gain, 0);
  assert.strictEqual(P.normalizeOptions({ format: 'wav', normalize: 'evil' }).normalize, 'off');
  assert.strictEqual(P.normalizeOptions({ format: 'wav', loudness: -5 }).loudness, -16);
  assert.strictEqual(P.normalizeOptions({ format: 'wav', join: 'x' }).join, 'none');
  assert.throws(() => P.normalizeOptions({ format: 'exe' }), /Unsupported output format/);
  assert.strictEqual(P.normalizeOptions({ format: 'wav', name: '  My mix  ' }).name, 'My mix');
});

test('describe: length of the result and the reasons it cannot be made', () => {
  const a = { path: '/a.wav', duration: 10, rate: 44100, channels: 2, cuts: [[2, 4]] };
  const b = { path: '/b.wav', duration: 6, rate: 44100, channels: 2, cuts: [] };
  near(P.describe([a], { format: 'wav' }).seconds, 8, 1e-9);
  near(P.describe([a, b], { format: 'wav' }).seconds, 14, 1e-9);
  near(P.describe([a, b], { format: 'wav', join: 'gap', joinSeconds: 2 }).seconds, 16, 1e-9);
  near(P.describe([a, b], { format: 'wav', join: 'cross', joinSeconds: 2 }).seconds, 12, 1e-9);
  assert.match(P.describe([a, b], { format: 'wav', join: 'cross', joinSeconds: 7 }).error, /crossfade/);
  assert.match(P.describe([a], { format: 'wav', fadeIn: 5, fadeOut: 5 }).error, /fades/);
  assert.match(P.describe([], {}).error, /Add a file/);
  const many = { ...a, cuts: Array.from({ length: 450 }, (_, i) => [i * 0.2 + 0.05, i * 0.2 + 0.1]), duration: 100 };
  assert.match(P.describe([many], { format: 'wav' }).error, /Too many/);
  const bad = P.describe([{ path: '/c.wav', duration: 0 }], { format: 'wav' });
  assert(bad.error, 'a file with no length is an error, not a crash');
  const est = P.estimateBytes(P.normalizeOptions({ format: 'mp3', bitrate: 128 }), 100);
  assert.strictEqual(est, 1600000);
});

// ---- ffmpeg side -----------------------------------------------------------------------------------------------------
test('probe: length, rate, channels', async () => {
  const p = await E.probe(ten);
  near(p.duration, 10, 0.01);
  assert.strictEqual(p.rate, 44100);
  assert.strictEqual(p.channels, 1);
  const s = await E.probe(tenStereo);
  assert.strictEqual(s.rate, 48000);
  assert.strictEqual(s.channels, 2);
  await assert.rejects(() => E.probe(path.join(tmp, 'missing.wav')), /Cannot read|No such/i);
  fs.writeFileSync(path.join(tmp, 'notaudio.mp3'), 'this is not audio at all');
  await assert.rejects(() => E.probe(path.join(tmp, 'notaudio.mp3')), P.UserError);
});

test('waveform: one min/max pair per 5 ms, loud where the tone is, flat where it is silent', async () => {
  const w = await E.peaks(padded);
  assert.strictEqual(w.perSec, 200);
  near(w.data.length / 2 / 200, 6.5, 0.05, 'length of the waveform');
  const pair = (t) => [w.data[Math.floor(t * 200) * 2], w.data[Math.floor(t * 200) * 2 + 1]];
  assert.deepStrictEqual(pair(0.7), [0, 0], 'silence at the start');
  const [lo, hi] = pair(3);
  assert(hi > 12000 && hi < 17000 && lo < -12000, `tone peaks about +/-16384, got ${lo}..${hi}`);
  assert.deepStrictEqual(pair(6.2), [0, 0], 'silence at the end');
});

test('waveform: can be cancelled', async () => {
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(() => E.peaks(ten, { signal: ac.signal }), (e) => e.cancelled === true);
});

test('silence: finds the quiet start and end', async () => {
  const s = await E.silences(padded, 6.5);
  assert.strictEqual(s.length, 2);
  near(s[0].start, 0, 0.02); near(s[0].end, 1.5, 0.03);
  near(s[1].start, 4.5, 0.03); near(s[1].end, 6.5, 0.03);
  assert.deepStrictEqual(await E.silences(ten, 10), []);
});

test('trim: keep only a piece', async () => {
  const r = await exp([await item(ten, P.keepOnly({ duration: 10 }, 2, 5))]);
  near(r.seconds, 3, 0.001);
  const d = dec(r.output);
  near(K.seconds(d), 3, 0.03, 'length');
  near(K.freqOf(d, 0.2, 0.8), 400, 12, 'starts at the 2 s part (400 Hz)');
  near(K.freqOf(d, 1.2, 1.8), 500, 12);
  near(K.freqOf(d, 2.2, 2.8), 600, 12, 'ends with the 4 s part (600 Hz)');
});

test('cut: the middle goes away and the rest closes up', async () => {
  const r = await exp([await item(ten, P.cutOut({ duration: 10, cuts: [] }, 3, 6))]);
  const d = dec(r.output);
  near(K.seconds(d), 7, 0.04);
  near(K.freqOf(d, 2.2, 2.8), 400, 12, 'before the cut (the 2 s..3 s part is 400 Hz)');
  near(K.freqOf(d, 3.2, 3.8), 800, 15, 'after the cut: the 6 s part (800 Hz)');
  assert(K.rmsDb(d, 2.997, 3.003) < K.rmsDb(d, 1, 2) - 6, 'the two edges dip to silence for a moment');
});

test('cut: no click where two pieces meet, wherever in the wave the cut falls', async () => {
  const tone = K.makeWav(path.join(tmp, 'tone440.wav'), { rate: 44100, parts: [{ sec: 6, freq: 440, amp: 0.5 }] });
  const natural = (2 * Math.PI * 440) / 16000 * 16384; // the biggest step a clean 440 Hz tone makes at 16 kHz: 2831
  for (const [a, b] of [[2.0013, 3.0007], [2.0041, 3.0020], [1.0, 4.0033]]) {
    const r = await exp([await item(tone, [[a, b]])]);
    const d = dec(r.output);
    const seam = a;
    const worst = K.maxStep(d, seam - 0.02, seam + 0.02);
    assert(worst < natural * 1.1, `cut ${a}-${b}: biggest jump at the seam ${worst}, a clean tone makes ${Math.round(natural)}`);
  }
  // without the 5 ms edge fades the same cuts WOULD click: prove the test can see a click
  const hardFile = path.join(tmp, 'out', 'hard.wav');
  sh(['-i', tone, '-filter_complex', '[0:a]atrim=0:2.0013,asetpts=PTS-STARTPTS[a];[0:a]atrim=3.0007,asetpts=PTS-STARTPTS[b];[a][b]concat=n=2:v=0:a=1', hardFile]);
  const hard = K.decode(ff, hardFile);
  assert(K.maxStep(hard, 1.99, 2.01) > natural * 1.5, 'a hard cut clicks (control): ' + K.maxStep(hard, 1.99, 2.01));
});

test('cut: several cuts in one file', async () => {
  const cuts = P.normalizeCuts([[1, 2], [4, 5], [8, 9]], 10);
  const r = await exp([await item(ten, cuts)]);
  const d = dec(r.output);
  near(K.seconds(d), 7, 0.05);
  const heard = [0.5, 1.5, 2.5, 3.5, 4.5, 5.5, 6.5].map((t) => Math.round(K.freqOf(d, t - 0.25, t + 0.25) / 100) * 100);
  assert.deepStrictEqual(heard, [200, 400, 500, 700, 800, 900, 1100], 'which parts survived, in order: ' + heard);
  assert.strictEqual(r.parts, 4);
});

test('a long list of cuts (the filter graph goes through a file, not the command line)', async () => {
  const cuts = [];
  for (let i = 0; i < 90; i++) cuts.push([i * 0.1 + 0.02, i * 0.1 + 0.05]); // 90 cuts of 30 ms in the first 9 s
  const r = await exp([await item(ten, cuts)]);
  assert(r.parts >= 90);
  near(K.seconds(dec(r.output)), 10 - 90 * 0.03, 0.2);
});

test('join: files one after another, mono and stereo, different sample rates', async () => {
  const r = await exp([await item(ten, P.keepOnly({ duration: 10 }, 0, 2)), await item(mono22), await item(tenStereo, P.keepOnly({ duration: 10 }, 8, 10))]);
  const d = dec(r.output);
  near(K.seconds(d), 8, 0.05);
  near(K.freqOf(d, 0.3, 0.7), 200, 10);
  near(K.freqOf(d, 2.3, 3.7), 900, 15, 'the 22 kHz mono file in the middle');
  near(K.freqOf(d, 6.3, 6.7), 1000, 15, 'the stereo file at the end (8 s part = 1000 Hz)');
  assert.strictEqual(r.parts, 3);
});

test('join: gap of silence between files', async () => {
  const r = await exp([await item(mono22), await item(mono22)], { join: 'gap', joinSeconds: 1.5 });
  const d = dec(r.output);
  near(K.seconds(d), 9.5, 0.05);
  assert(K.rmsDb(d, 4.3, 5.4) < -80, 'silent in the gap');
  near(K.freqOf(d, 6.2, 6.8), 900, 15);
});

test('join: crossfade overlaps the files', async () => {
  const a = K.makeWav(path.join(tmp, 'ca.wav'), { rate: 44100, parts: [{ sec: 5, freq: 300 }] });
  const b = K.makeWav(path.join(tmp, 'cb.wav'), { rate: 44100, parts: [{ sec: 5, freq: 700 }] });
  const r = await exp([await item(a), await item(b)], { join: 'cross', joinSeconds: 2 });
  const d = dec(r.output);
  near(K.seconds(d), 8, 0.05);
  near(K.freqOf(d, 0.5, 1.5), 300, 10);
  near(K.freqOf(d, 6.5, 7.5), 700, 10);
  assert(K.rmsDb(d, 3.9, 4.1) > -14, 'no dip in the middle of the crossfade: ' + K.rmsDb(d, 3.9, 4.1));
});

test('fades: in and out', async () => {
  const r = await exp([await item(ten, P.keepOnly({ duration: 10 }, 2, 8))], { fadeIn: 1, fadeOut: 2 });
  near(r.seconds, 6, 0.001);
  const d = dec(r.output);
  near(K.seconds(d), 6, 0.04);
  assert(K.rmsDb(d, 0, 0.05) < K.rmsDb(d, 2, 3) - 20, 'starts silent');
  assert(K.rmsDb(d, 0.9, 1.0) > K.rmsDb(d, 0, 0.1), 'gets louder through the fade');
  near(K.rmsDb(d, 2, 3), -9, 1.5, 'full level in the middle (0.5 amplitude = about -9 dB RMS)');
  assert(K.peakDb(d, 5.99, 6) < -45, 'ends silent: ' + K.peakDb(d, 5.99, 6));
  assert(K.rmsDb(d, 4.0, 4.2) > K.rmsDb(d, 5.8, 6) + 15, 'gets quieter through the fade');
});

test('volume: gain up and down', async () => {
  const base = await exp([await item(quiet)]);
  const basePeak = K.peakDb(dec(base.output));
  const up = await exp([await item(quiet)], { gain: 12 });
  near(K.peakDb(dec(up.output)), basePeak + 12, 0.4, '+12 dB');
  const down = await exp([await item(quiet)], { gain: -6 });
  near(K.peakDb(dec(down.output)), basePeak - 6, 0.4, '-6 dB');
  const loud = await exp([await item(ten)], { gain: 20 });
  const dl = dec(loud.output);
  assert(K.peakDb(dl) <= -0.2, 'a boost is limited instead of clipping: ' + K.peakDb(dl));
  near(K.seconds(dl), 10, 0.05, 'the limiter does not change the length');
});

test('normalize: peak goes to -1 dB', async () => {
  const r = await exp([await item(quiet)], { normalize: 'peak' });
  near(K.peakDb(dec(r.output)), -1, 0.3);
  const loud = await exp([await item(ten)], { normalize: 'peak' });
  near(K.peakDb(dec(loud.output)), -1, 0.3, 'also brings a louder file down');
});

test('normalize: loudness lands on the target', async () => {
  for (const target of [-16, -23]) {
    const r = await exp([await item(quiet)], { normalize: 'loudness', loudness: target }, {});
    const lufs = K.loudness(ff, r.output);
    near(lufs, target, 1, `loudness target ${target}`);
    assert(K.peakDb(dec(r.output)) <= -1, 'true peak stays below the ceiling');
    near(K.seconds(dec(r.output)), 6, 0.05);
  }
});

test('normalize: silence is left alone and the user is told', async () => {
  const sil = K.makeWav(path.join(tmp, 'sil.wav'), { rate: 44100, parts: [{ sec: 2, freq: 0 }] });
  for (const normalize of ['peak', 'loudness']) {
    const r = await exp([await item(sil)], { normalize });
    assert(r.notes.some((n) => /silent/.test(n)), 'mentions that it is silent');
    near(K.seconds(dec(r.output)), 2, 0.05);
  }
});

test('trim silence at the start and end', async () => {
  const r = await exp([await item(padded)], { trimSilence: true });
  const d = dec(r.output);
  near(K.seconds(d), 3 + 0.1, 0.12, 'the 3 s tone plus a little of the silence kept on both sides');
  near(K.freqOf(d, 0.5, 2.5), 500, 10);
  const keep = await exp([await item(ten)], { trimSilence: true });
  near(K.seconds(dec(keep.output)), 10, 0.05, 'nothing to trim in a file without silence');
  const cutStart = await exp([await item(padded, [[0, 1.5], [1.5, 2.5]])], { trimSilence: true });
  near(K.seconds(dec(cutStart.output)), 2 + 0.05, 0.12, 'cuts that already removed the start do not confuse it');
});

test('every output format plays back whole, with the right length', async () => {
  const src = [await item(ten, P.keepOnly({ duration: 10 }, 1, 4))];
  for (const format of Object.keys(P.FORMATS)) {
    const r = await exp(src, { format });
    assert(r.output.endsWith(P.FORMATS[format].ext), format);
    const d = dec(r.output);
    near(K.seconds(d), 3, format === 'wav' || format === 'flac' ? 0.03 : 0.12, `${format} length`);
    near(K.freqOf(d, 1.1, 1.9), 400, 15, `${format} pitch`);
    const p = await E.probe(r.output);
    assert.strictEqual(p.channels, 1, `${format} stays mono`);
  }
});

test('output rate and channels follow the inputs', async () => {
  const stereo = await exp([await item(tenStereo, P.keepOnly({ duration: 10 }, 0, 2))]);
  const ps = await E.probe(stereo.output);
  assert.strictEqual(ps.rate, 48000); assert.strictEqual(ps.channels, 2);
  const mp3 = await exp([await item(tenStereo, P.keepOnly({ duration: 10 }, 0, 2))], { format: 'mp3' });
  assert.strictEqual((await E.probe(mp3.output)).rate, 48000);
  const opus = await exp([await item(mono22)], { format: 'opus' });
  assert.strictEqual((await E.probe(opus.output)).rate, 48000, 'Opus always runs at 48 kHz');
  const hi = K.makeWav(path.join(tmp, 'hi.wav'), { rate: 96000, parts: [{ sec: 1, freq: 440 }] });
  const mp3hi = await exp([await item(hi)], { format: 'mp3' });
  assert.strictEqual((await E.probe(mp3hi.output)).rate, 48000, 'MP3 cannot go above 48 kHz');
  const flachi = await exp([await item(hi)], { format: 'flac' });
  assert.strictEqual((await E.probe(flachi.output)).rate, 96000, 'lossless keeps the rate');
});

test('tags and cover art are kept; joins drop the title', async () => {
  const wav = K.makeWav(path.join(tmp, 'tagsrc.wav'), { rate: 44100, channels: 2, parts: K.steps(3) });
  const png = path.join(tmp, 'cover.png');
  sh(['-f', 'lavfi', '-i', 'color=c=0xd6409f:s=64x64:d=1', '-frames:v', '1', png]);
  const tagged = path.join(tmp, 'Tagged Song.mp3');
  sh(['-i', wav, '-i', png, '-map', '0:a', '-map', '1:v', '-c:a', 'libmp3lame', '-b:a', '128k', '-c:v', 'mjpeg', '-id3v2_version', '3',
    '-metadata', 'title=Secret Title', '-metadata', 'artist=Some Artist', '-metadata', 'album=Some Album', '-metadata', 'track=4', '-disposition:v', 'attached_pic', tagged]);
  const info = await E.probe(tagged);
  assert.notStrictEqual(info.coverStream, null, 'the cover is found');
  const kept = await exp([await item(tagged, P.keepOnly({ duration: info.duration }, 0.5, 2))], { format: 'mp3' });
  const rep = spawnSync(ff, ['-hide_banner', '-i', kept.output], { encoding: 'utf8', windowsHide: true }).stderr;
  assert(/Secret Title/.test(rep) && /Some Artist/.test(rep) && /Some Album/.test(rep), 'tags carried over');
  assert(/attached pic/.test(rep), 'cover carried over');
  near(K.seconds(dec(kept.output)), 1.5, 0.12, 'the cover does not stretch the audio');
  const bare = await exp([await item(tagged)], { format: 'mp3', keepTags: false });
  const rep2 = spawnSync(ff, ['-hide_banner', '-i', bare.output], { encoding: 'utf8', windowsHide: true }).stderr;
  assert(!/Secret Title|Some Artist/.test(rep2) && !/attached pic/.test(rep2), 'keepTags: false removes tags and cover');
  const joined = await exp([await item(tagged), await item(ten)], { format: 'mp3' });
  const rep3 = spawnSync(ff, ['-hide_banner', '-i', joined.output], { encoding: 'utf8', windowsHide: true }).stderr;
  assert(/Some Artist/.test(rep3) && !/Secret Title/.test(rep3), 'a join keeps artist and album but not the first title');
});

test('originals are never touched; outputs get fresh names', async () => {
  const before = sha(ten);
  const dir = path.join(tmp, 'fresh');
  const a = await E.render([await item(ten)], { format: 'wav', outDir: dir });
  const b = await E.render([await item(ten)], { format: 'wav', outDir: dir });
  assert.notStrictEqual(a.output, b.output);
  assert(/ten \(edited\)\.wav$/.test(a.output) && /ten \(edited\) \(1\)\.wav$/.test(b.output), path.basename(a.output) + ' / ' + path.basename(b.output));
  assert.strictEqual(sha(ten), before, 'the original is unchanged');
  const same = await E.render([await item(ten)], { format: 'wav', outDir: path.dirname(ten), name: 'ten' });
  assert.notStrictEqual(same.output, ten, 'never overwrites the source, even with the same name');
  assert.strictEqual(sha(ten), before);
  const named = await E.render([await item(ten), await item(ten)], { format: 'wav', outDir: dir, name: 'a/b:c*?' });
  assert(/a_b_c__\.wav$/.test(named.output), path.basename(named.output));
  const joinedDefault = await E.render([await item(ten), await item(ten)], { format: 'wav', outDir: dir });
  assert(/ten \(joined\)\.wav$/.test(joinedDefault.output));
  assert(!fs.readdirSync(dir).some((n) => n.endsWith('.part')), 'no leftovers');
});

test('awkward file names', async () => {
  const dir = path.join(tmp, "odd [dir] #1 %20 it's ünï");
  const f = K.makeWav(path.join(dir, "my song's [live] 100% #2 é.wav"), { rate: 44100, parts: K.steps(3) });
  const r = await E.render([await item(f, [[0.5, 1]])], { format: 'flac', outDir: dir });
  near(K.seconds(dec(r.output)), 2.5, 0.05);
  assert(r.output.startsWith(dir));
});

test('cancel: stops at once and leaves nothing behind', async () => {
  const leftoversBefore = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('audioedit-') && !n.startsWith('audioedit-test-'));
  const long = K.makeWav(path.join(tmp, 'long.wav'), { rate: 44100, channels: 2, parts: [{ sec: 600, freq: 330 }] });
  const dir = path.join(tmp, 'cancel');
  const ac = new AbortController();
  const t0 = Date.now();
  const p = E.render([await item(long)], { format: 'flac', outDir: dir, normalize: 'loudness' }, { signal: ac.signal, onProgress: (f) => { if (f > 0.02) ac.abort(); } });
  await assert.rejects(p, (e) => e.cancelled === true);
  assert(Date.now() - t0 < 20000, 'cancelled quickly');
  const left = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
  assert.deepStrictEqual(left, [], 'no output and no .part file: ' + left);
  const after = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('audioedit-') && !n.startsWith('audioedit-test-'));
  assert.deepStrictEqual(after.filter((n) => !leftoversBefore.includes(n)), [], 'temporary graph folders are removed');
});

test('progress rises to 1', async () => {
  const seen = [];
  await exp([await item(ten)], { normalize: 'peak' }, { onProgress: (f) => seen.push(f) });
  assert(seen.length >= 2, 'reports progress');
  assert.strictEqual(seen[seen.length - 1], 1);
  assert(seen.every((f) => f >= 0 && f <= 1));
});

test('errors are readable and make no files', async () => {
  const dir = path.join(tmp, 'errs');
  await assert.rejects(() => E.render([{ path: 'relative.wav', duration: 5, cuts: [] }], { format: 'wav', outDir: dir }), /absolute/);
  await assert.rejects(() => E.render([{ path: path.join(tmp, 'x.exe'), duration: 5, cuts: [] }], { format: 'wav', outDir: dir }), /Unsupported file type/);
  await assert.rejects(() => E.render([], { format: 'wav', outDir: dir }), /Add a file/);
  await assert.rejects(async () => E.render([await item(ten)], { format: 'wav', outDir: dir, fadeIn: 8, fadeOut: 8 }), /fades/);
  await assert.rejects(async () => E.render([await item(ten), await item(mono22)], { format: 'wav', outDir: dir, join: 'cross', joinSeconds: 5 }), /crossfade/);
  await assert.rejects(() => E.render([{ path: path.join(tmp, 'gone.wav'), duration: 5, rate: 44100, channels: 1, cuts: [] }], { format: 'wav', outDir: dir }), /No such file|Error|Could not|Invalid/i);
  assert(!fs.existsSync(dir) || fs.readdirSync(dir).length === 0, 'no files made by failed exports');
});

test('graph: built as expected for a join with cuts, fades and normalize', async () => {
  const items = [P.normalizeItem(await item(ten, [[2, 4]])), P.normalizeItem(await item(mono22))];
  const job = E.buildJob(items, { format: 'mp3', bitrate: 192, join: 'cross', joinSeconds: 1, fadeIn: 0.5, fadeOut: 1, normalize: 'peak' }, 'final', { peakGain: 3.5 });
  assert.strictEqual(job.inputs.length, 3);
  assert.deepStrictEqual(job.inputs.map((i) => [i.ss, i.t]), [[0, 2], [4, 6], [0, 4]]);
  const g = job.filters.join('\n');
  assert(/acrossfade=d=1:c1=tri:c2=tri/.test(g));
  assert(/concat=n=2:v=0:a=1\[i0\]/.test(g));
  assert(/volume=3.5dB/.test(g));
  assert(/afade=t=in:st=0:d=0.5/.test(g) && /afade=t=out:st=\d+(\.\d+)?:d=1/.test(g));
  assert(/afade=t=out:st=1.995:d=0.005/.test(g), 'tiny fade where the first piece is cut off');
  assert(/afade=t=in:st=0:d=0.005/.test(g), 'tiny fade where the second piece starts');
  const args = E.jobArgs({ ...job, firstItem: items[0], joined: true }, 'g.txt', 'out.part', 'final');
  const firstSs = args.indexOf('-ss');
  assert(args.includes('-filter_complex_script') && args.includes('libmp3lame') && args.includes('192k'));
  assert(firstSs > 0 && args.indexOf('-i', firstSs) === firstSs + 4, '-ss -t are given right before their -i');
  assert(args.includes('title='), 'a join clears the title');
});

// ---- the window's colours ----------------------------------------------------------------------------------------------
test('colours: text and controls meet WCAG contrast (AA)', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'styles.css'), 'utf8');
  const root = /:root\s*\{([^}]*)\}/.exec(css)[1];
  const v = (name) => { const m = new RegExp('--' + name + ':\\s*(#[0-9a-fA-F]{6})').exec(root); assert(m, 'missing --' + name); return m[1]; };
  const lum = (hex) => { const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((x) => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4)); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05); };
  const pairs = [
    ['text', 'bg', 4.5], ['text', 'panel', 4.5], ['text', 'panel-2', 4.5],
    ['muted', 'bg', 4.5], ['muted', 'panel', 4.5], ['muted', 'panel-2', 4.5], ['muted', 'wave-bg', 4.5],
    ['on-accent', 'accent', 4.5], ['accent', 'bg', 4.5], ['accent', 'panel', 4.5], ['accent', 'panel-2', 4.5],
    ['err', 'bg', 4.5], ['err', 'panel', 4.5], ['ok', 'bg', 4.5],
    ['wave', 'wave-bg', 3], ['accent', 'wave-bg', 3], ['head', 'wave-bg', 3],
  ];
  const bad = pairs.filter(([a, b, min]) => ratio(v(a), v(b)) < min).map(([a, b, min]) => `${a} on ${b}: ${ratio(v(a), v(b)).toFixed(2)} < ${min}`);
  assert.deepStrictEqual(bad, []);
  assert(ratio('#ffb3b3', '#3a1f24') >= 4.5, 'text on the red Cut button');
});

(async () => {
  let failed = 0;
  try { await fixtures(); } catch (e) { console.error('fixtures failed:', e); process.exit(1); }
  for (const [name, fn] of tests) {
    const t0 = Date.now();
    try { await fn(); console.log(`ok   ${name} (${Date.now() - t0} ms)`); }
    catch (e) { failed++; console.log(`FAIL ${name}\n     ${String((e && e.stack) || e).split('\n').slice(0, 5).join('\n     ')}`); }
  }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  console.log(failed ? `\n${failed} of ${tests.length} failed` : `\nall ${tests.length} passed`);
  process.exit(failed ? 1 : 0);
})();
