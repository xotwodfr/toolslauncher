'use strict';
// Stem Splitter core tests. The separation is checked with a FAKE model whose six stems are fixed fractions of the mix
// (so they add back up to it exactly): that proves the overlap-add, the segment seams, the cache and the mixdown to the
// last sample. One more test runs the REAL Demucs model on a short sound when the model file is present.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const P = require('../src/plan');
const S = require('../src/stems');
const K = require('../src/testkit');

const ff = S.ffmpegPath();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stemsplit-test-'));
const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const near = (a, b, tol, msg) => assert(Math.abs(a - b) <= tol, `${msg || ''} expected ${b} +/- ${tol}, got ${a}`);
const dec = (f, rate = 16000) => { const d = K.decode(ff, f, rate); assert.strictEqual(d.errors, '', 'decode errors: ' + d.errors); return d; };

// model output order: drums, bass, other, vocals, guitar, piano
const FACTORS = { drums: 0.10, bass: 0.20, other: 0.30, vocals: 0.15, guitar: 0.20, piano: 0.05 };
const SMALL = 1000;

/** A stand-in for the neural network: stem = mix * factor. `hook(callNumber)` runs before each answer. */
function fakeRunner(segment = SMALL, factors = FACTORS, hook = null) {
  let calls = 0;
  return {
    segment, calls: () => calls,
    async infer(planar) {
      calls++;
      if (hook) hook(calls);
      const out = new Float32Array(12 * segment);
      P.MODEL_ORDER.forEach((id, s) => { for (let c = 0; c < 2; c++) for (let i = 0; i < segment; i++) out[(s * 2 + c) * segment + i] = planar[c * segment + i] * factors[id]; });
      return out;
    },
    release() {},
  };
}

/** Read a 16-bit stereo WAV written by the tool: header checks, then the samples as [left[], right[]]. */
function readWav(file) {
  const b = fs.readFileSync(file);
  assert.strictEqual(b.toString('latin1', 0, 4), 'RIFF');
  assert.strictEqual(b.toString('latin1', 8, 12), 'WAVE');
  assert.strictEqual(b.readUInt16LE(22), 2, 'channels');
  assert.strictEqual(b.readUInt32LE(24), 44100, 'rate');
  assert.strictEqual(b.readUInt16LE(34), 16, 'bits');
  const dataLen = b.readUInt32LE(40);
  assert.strictEqual(b.readUInt32LE(4), 36 + dataLen, 'RIFF size');
  assert.strictEqual(b.length, 44 + dataLen, 'file size matches the header');
  const n = dataLen / 4;
  const l = new Float64Array(n); const r = new Float64Array(n);
  for (let i = 0; i < n; i++) { l[i] = b.readInt16LE(44 + i * 4) / 32767; r[i] = b.readInt16LE(44 + i * 4 + 2) / 32767; }
  return { l, r, n };
}

/** A raw stereo float32 "song" of known content (two different tones + a sweep so the seams would show). */
function writeRaw(file, frames) {
  const f = new Float32Array(frames * 2);
  for (let i = 0; i < frames; i++) {
    f[2 * i] = 0.5 * Math.sin(i * 0.031) + 0.3 * Math.sin(i * 0.00071 * i * 0.001 + 1);
    f[2 * i + 1] = 0.45 * Math.sin(i * 0.047 + 0.7) - 0.2 * Math.sin(i * 0.0113);
  }
  fs.writeFileSync(file, Buffer.from(f.buffer));
  return f;
}

// ---- the model (plan.js) ---------------------------------------------------------------------------------------------------
test('stems: the six stems, the model order and the presets are consistent', () => {
  assert.deepStrictEqual([...P.MODEL_ORDER].sort(), [...P.STEM_IDS].sort());
  assert.strictEqual(P.STEM_IDS.length, 6);
  for (const p of P.PRESETS) { assert(p.stems.length > 0, p.id); for (const id of p.stems) assert(P.STEM_IDS.includes(id), `${p.id}: ${id}`); }
  assert.strictEqual(new Set(P.PRESETS.map((p) => p.id)).size, P.PRESETS.length, 'preset ids are unique');
  const ids = P.PRESETS.map((p) => P.PRESETS.find((q) => q.id === p.id).stems.slice().sort().join());
  assert.strictEqual(new Set(ids).size, ids.length, 'no two presets are the same combo');
});

test('segments: every sample is covered, non-last segments lie inside the song, and there are no extra ones', () => {
  const N = SMALL;
  for (const T of [1, 2, 749, 750, 999, 1000, 1001, 1749, 1750, 1751, 2500, 7777, 100000, 100001]) {
    const p = P.segmentPlan(T, N, 0.25);
    assert.strictEqual(p.stride, 750);
    assert(p.starts[p.count - 1] + N >= T, `T=${T}: last segment reaches the end`);
    for (let k = 0; k < p.count - 1; k++) assert(p.starts[k] + N <= T, `T=${T}: segment ${k} inside`);
    if (p.count >= 2) assert(p.starts[p.count - 2] + N < T, `T=${T}: no unneeded segment`);
    for (let k = 1; k < p.count; k++) assert.strictEqual(p.starts[k] - p.starts[k - 1], 750);
  }
  assert.throws(() => P.segmentPlan(0), /no sound/);
  assert.strictEqual(P.segmentPlan(P.SEGMENT).count, 1);
  assert.strictEqual(P.segmentPlan(P.SEGMENT + 1).count, 2);
});

test('window: a triangle with peak 1 and no zero weights', () => {
  const w = P.weights(SMALL);
  assert.strictEqual(w.length, SMALL);
  near(Math.max(...w), 1, 1e-6);
  assert(Math.min(...w) > 0);
  near(w[0], w[SMALL - 1], 1e-6);
  assert(w[10] < w[100] && w[100] < w[499]);
});

test('mix: only ticked stems with a volume are heard; nothing ticked is an error', () => {
  const m = P.newMix();
  assert.deepStrictEqual(P.activeStems(m).map((x) => x.id), P.STEM_IDS);
  P.selectOnly(m, ['bass', 'vocals']);
  assert.deepStrictEqual(P.activeStems(m).map((x) => x.id), ['vocals', 'bass']);
  m.bass.gain = 0;
  assert.deepStrictEqual(P.activeStems(m).map((x) => x.id), ['vocals']);
  P.selectOnly(m, []);
  assert.throws(() => P.activeStems(m), (e) => e instanceof P.UserError && /at least one/.test(e.message));
  m.vocals.on = true; m.vocals.gain = 3;
  assert.throws(() => P.activeStems(m), /out of range/);
  m.vocals.gain = NaN;
  assert.throws(() => P.activeStems(m), /out of range/);
});

test('mix: names and preset matching', () => {
  assert.strictEqual(P.describe(['vocals', 'bass']), 'vocals + bass');
  assert.strictEqual(P.describe(['bass', 'vocals']), 'vocals + bass');
  assert.strictEqual(P.describe(P.STEM_IDS), 'everything');
  assert.strictEqual(P.describe(['drums', 'bass', 'guitar', 'piano', 'other']), 'no vocals');
  const m = P.newMix();
  assert.strictEqual(P.matchingPreset(m), 'all');
  P.selectOnly(m, ['drums', 'bass']);
  assert.strictEqual(P.matchingPreset(m), 'rhythm');
  P.selectOnly(m, ['drums', 'guitar']);
  assert.strictEqual(P.matchingPreset(m), null);
  assert.strictEqual(P.defaultName('My: Song?.flac', ['vocals', 'bass'], 'mp3'), 'My_ Song_ (vocals + bass).mp3');
  assert.strictEqual(P.defaultName('', ['drums'], 'nope'), 'Song (drums).wav');
  assert(P.isSupportedInput('C:\\a\\b.FLAC') && !P.isSupportedInput('x.txt') && !P.isSupportedInput('noext'));
  assert.strictEqual(P.formatTime(65), '1:05');
  assert.strictEqual(P.formatTime(3723), '1:02:03');
  assert.throws(() => P.stemFile('../x'), /Unknown stem/);
});

// ---- separating ----------------------------------------------------------------------------------------------------------------
test('separate: the stems equal the fake model\'s answer sample for sample, at every length', async () => {
  for (const T of [1, 300, 999, 1000, 1001, 1750, 1751, 2600, 5321]) {
    const dir = path.join(tmp, 'sep-' + T);
    fs.mkdirSync(dir, { recursive: true });
    const raw = writeRaw(path.join(dir, 'mix.f32'), T);
    const r = await S.separate({ rawFile: path.join(dir, 'mix.f32'), frames: T, runner: fakeRunner(), outDir: dir });
    assert.strictEqual(r.segments, P.segmentPlan(T, SMALL, 0.25).count);
    for (const id of P.STEM_IDS) {
      const w = readWav(path.join(dir, id + '.wav'));
      assert.strictEqual(w.n, T, `${id}: length at T=${T}`);
      let worst = 0;
      for (let i = 0; i < T; i++) {
        worst = Math.max(worst, Math.abs(w.l[i] - raw[2 * i] * FACTORS[id]), Math.abs(w.r[i] - raw[2 * i + 1] * FACTORS[id]));
      }
      assert(worst < 2 / 32767, `${id} at T=${T}: off by ${worst}`);
    }
  }
});

test('separate: segments that disagree are blended smoothly (no click at a seam)', async () => {
  // each call returns the mix scaled by a DIFFERENT amount, so a hard switch would be a step at the seam
  const dir = path.join(tmp, 'seams');
  fs.mkdirSync(dir, { recursive: true });
  const T = 6000;
  const f = new Float32Array(T * 2).fill(0.5);
  fs.writeFileSync(path.join(dir, 'mix.f32'), Buffer.from(f.buffer));
  let n = 0;
  const runner = {
    segment: SMALL, release() {},
    async infer() { n++; const out = new Float32Array(12 * SMALL); out.fill(n % 2 ? 0.2 : 0.4); return out; },
  };
  await S.separate({ rawFile: path.join(dir, 'mix.f32'), frames: T, runner, outDir: dir });
  const w = readWav(path.join(dir, 'drums.wav'));
  let maxStep = 0;
  for (let i = 1; i < T; i++) maxStep = Math.max(maxStep, Math.abs(w.l[i] - w.l[i - 1]));
  assert(maxStep < 0.01, `largest jump between neighbouring samples: ${maxStep}`);
  assert(Math.max(...w.l) > 0.35 && Math.min(...w.l) < 0.25, 'both answers are present in the result');
});

test('separate: cancelling stops after the current segment and ensureStems cleans up', async () => {
  const src = K.makeWav(path.join(tmp, 'cancel.wav'), { rate: 44100, channels: 2, parts: K.steps(3) });
  const root = path.join(tmp, 'cache-cancel');
  const ac = new AbortController();
  const runner = fakeRunner(SMALL, FACTORS, (c) => { if (c === 3) ac.abort(); });
  await assert.rejects(S.ensureStems({ source: src, root, getRunner: async () => runner, signal: ac.signal }), (e) => e.cancelled === true);
  assert(runner.calls() <= 4, 'stopped early: ' + runner.calls());
  assert.deepStrictEqual(fs.readdirSync(root), [], 'nothing half-made is left');
});

test('separate: a file that is not audio gives a readable error', async () => {
  const bad = path.join(tmp, 'notaudio.wav');
  fs.writeFileSync(bad, 'this is not a sound');
  await assert.rejects(S.ensureStems({ source: bad, root: path.join(tmp, 'cache-bad'), getRunner: async () => fakeRunner() }), (e) => e instanceof P.UserError);
});

// ---- the cache -------------------------------------------------------------------------------------------------------------------
test('cache: the second open is instant, a changed file is separated again, a damaged one too', async () => {
  const src = K.makeWav(path.join(tmp, 'song.wav'), { rate: 44100, channels: 2, parts: K.steps(4) });
  const root = path.join(tmp, 'cache-a');
  const r1 = await S.ensureStems({ source: src, root, getRunner: async () => fakeRunner() });
  assert.strictEqual(r1.fromCache, false);
  near(r1.meta.duration, 4, 0.01, 'duration');
  assert(S.isKey(r1.key));
  const r2 = await S.ensureStems({ source: src, root, getRunner: async () => { throw new Error('should not run the model'); } });
  assert.strictEqual(r2.fromCache, true);
  assert.strictEqual(r2.key, r1.key);

  // damaged: a truncated stem is not trusted
  const victim = path.join(r1.dir, 'bass.wav');
  fs.writeFileSync(victim, fs.readFileSync(victim).subarray(0, 1000));
  assert.strictEqual(S.readCache(root, r1.key), null);
  const r3 = await S.ensureStems({ source: src, root, getRunner: async () => fakeRunner() });
  assert.strictEqual(r3.fromCache, false);
  assert.strictEqual(S.readCache(root, r1.key).meta.frames, r1.meta.frames);

  // changed: new content (and time) = new key
  await new Promise((r) => setTimeout(r, 30));
  K.makeWav(src, { rate: 44100, channels: 2, parts: K.steps(5) });
  const r4 = await S.ensureStems({ source: src, root, getRunner: async () => fakeRunner() });
  assert.strictEqual(r4.fromCache, false);
  assert.notStrictEqual(r4.key, r1.key);
  near(r4.meta.duration, 5, 0.01);
});

test('cache: pruning keeps the newest, protects open songs, clearing removes the rest; keys are validated', async () => {
  const root = path.join(tmp, 'cache-b');
  const keys = [];
  for (let i = 0; i < 4; i++) {
    const src = K.makeWav(path.join(tmp, `p${i}.wav`), { rate: 44100, channels: 2, parts: K.steps(1 + i) });
    const r = await S.ensureStems({ source: src, root, getRunner: async () => fakeRunner() });
    const meta = JSON.parse(fs.readFileSync(path.join(r.dir, 'meta.json'), 'utf8'));
    meta.lastUsed = 1000 + i; // song 3 is the newest
    fs.writeFileSync(path.join(r.dir, 'meta.json'), JSON.stringify(meta));
    keys.push(r.key);
  }
  fs.mkdirSync(path.join(root, 'deadbeefdeadbeefdead.part'), { recursive: true });
  assert.strictEqual(S.listCache(root).length, 4);
  assert.strictEqual(S.listCache(root)[0].key, keys[3]);
  const removed = S.pruneCache(root, { keep: 2, protect: [keys[0]] });
  assert.strictEqual(removed, 1, 'song 1 goes; song 0 is protected; songs 2 and 3 are the newest');
  assert.deepStrictEqual(S.listCache(root).map((e) => e.key).sort(), [keys[0], keys[2], keys[3]].sort());
  assert(!fs.existsSync(path.join(root, 'deadbeefdeadbeefdead.part')), 'half-made folders are removed');
  assert.strictEqual(S.clearCache(root, [keys[3]]), 2);
  assert.deepStrictEqual(S.listCache(root).map((e) => e.key), [keys[3]]);
  for (const bad of ['../x', 'ABCDEF', '', null, 'zzzzzzzzzzzzzzzzzzzz']) assert.throws(() => S.dirFor(root, bad), /Bad key/);
});

// ---- mixing and saving -------------------------------------------------------------------------------------------------------
let song; // { dir, meta, src, raw }
async function makeSong() {
  const src = K.makeWav(path.join(tmp, 'mixsong.wav'), { rate: 44100, channels: 2, parts: [{ sec: 2, freq: 440, amp: 0.5 }, { sec: 2, freq: 880, amp: 0.5 }] });
  const r = await S.ensureStems({ source: src, root: path.join(tmp, 'cache-mix'), getRunner: async () => fakeRunner() });
  song = { ...r, src };
}
const mixOf = (...ids) => ids.map((id) => ({ id, gain: 1 }));
const exportTo = async (mix, format, name, extra = {}) => {
  fs.mkdirSync(path.join(tmp, 'exp'), { recursive: true });
  return S.exportMix({ dir: song.dir, meta: song.meta, mix, format, output: path.join(tmp, 'exp', name), sourcePath: song.src, ...extra });
};

test('export: all six stems add back up to the original', async () => {
  await makeSong();
  const r = await exportTo(mixOf(...P.STEM_IDS), 'wav', 'all.wav');
  const a = dec(r.output, 44100);
  const o = dec(song.src, 44100);
  assert(Math.abs(a.samples.length - o.samples.length) <= 2, 'same length');
  let worst = 0;
  for (let i = 0; i < Math.min(a.samples.length, o.samples.length); i++) worst = Math.max(worst, Math.abs(a.samples[i] - o.samples[i]));
  assert(worst <= 6, `largest difference: ${worst} / 32768`);
  assert(!fs.existsSync(r.output + '.part'));
});

test('export: a combination has the level of the chosen stems, and the other stems are really absent', async () => {
  const full = dec((await exportTo(mixOf(...P.STEM_IDS), 'wav', 'lvl-all.wav')).output);
  const base = K.rmsDb(full, 0.2, 1.8);
  const voice = dec((await exportTo(mixOf('vocals'), 'wav', 'lvl-v.wav')).output);
  near(K.rmsDb(voice, 0.2, 1.8) - base, 20 * Math.log10(FACTORS.vocals), 0.25, 'vocals only');
  const vb = dec((await exportTo(mixOf('vocals', 'bass'), 'wav', 'lvl-vb.wav')).output);
  near(K.rmsDb(vb, 0.2, 1.8) - base, 20 * Math.log10(FACTORS.vocals + FACTORS.bass), 0.25, 'vocals + bass');
  const noVoice = dec((await exportTo(mixOf('drums', 'bass', 'guitar', 'piano', 'other'), 'wav', 'lvl-nv.wav')).output);
  near(K.rmsDb(noVoice, 0.2, 1.8) - base, 20 * Math.log10(1 - FACTORS.vocals), 0.25, 'no vocals');
  near(K.freqOf(vb, 0.2, 1.8), 440, 8, 'pitch kept');
  near(K.freqOf(vb, 2.2, 3.8), 880, 12, 'pitch kept (second half)');
});

test('export: each stem\'s volume is applied', async () => {
  const one = dec((await exportTo([{ id: 'vocals', gain: 1 }], 'wav', 'g1.wav')).output);
  const half = dec((await exportTo([{ id: 'vocals', gain: 0.5 }], 'wav', 'g05.wav')).output);
  const loud = dec((await exportTo([{ id: 'vocals', gain: 2 }], 'wav', 'g2.wav')).output);
  near(K.rmsDb(half, 0.2, 1.8) - K.rmsDb(one, 0.2, 1.8), -6.02, 0.15, 'half');
  near(K.rmsDb(loud, 0.2, 1.8) - K.rmsDb(one, 0.2, 1.8), 6.02, 0.15, 'double');
  // a mix of two stems with different volumes
  const mixed = dec((await exportTo([{ id: 'vocals', gain: 1 }, { id: 'bass', gain: 0.5 }], 'wav', 'gmix.wav')).output);
  near(K.rmsDb(mixed, 0.2, 1.8) - K.rmsDb(one, 0.2, 1.8), 20 * Math.log10((FACTORS.vocals + FACTORS.bass * 0.5) / FACTORS.vocals), 0.2, 'two volumes');
});

test('export: adding stems can never clip (a limiter holds the peaks)', async () => {
  const src = K.makeWav(path.join(tmp, 'hot.wav'), { rate: 44100, channels: 2, parts: [{ sec: 2, freq: 300, amp: 0.9 }] });
  const loudFactors = { drums: 1, bass: 1, other: 0, vocals: 0, guitar: 0, piano: 0 };
  const r = await S.ensureStems({ source: src, root: path.join(tmp, 'cache-hot'), getRunner: async () => fakeRunner(SMALL, loudFactors) });
  const out = await S.exportMix({ dir: r.dir, meta: r.meta, mix: mixOf('drums', 'bass'), format: 'wav', output: path.join(tmp, 'exp', 'hot.wav') });
  const d = dec(out.output);
  assert(K.peakDb(d) <= -0.1, 'peak ' + K.peakDb(d));
  assert(K.rmsDb(d, 0.3, 1.7) > -8, 'the sound is still loud: ' + K.rmsDb(d, 0.3, 1.7));
  near(K.freqOf(d, 0.3, 1.7), 300, 6, 'pitch');
});

test('export: every format is written, with the right length', async () => {
  for (const format of Object.keys(P.FORMATS)) {
    const r = await exportTo(mixOf('vocals', 'drums'), format, 'fmt' + P.FORMATS[format].ext);
    assert(r.bytes > 1000);
    const d = dec(r.output);
    near(K.seconds(d), 4, format === 'mp3' ? 0.12 : 0.04, format);
    near(K.freqOf(d, 0.3, 1.7), 440, 8, format);
  }
});

test('export: refuses to replace the original, nothing selected, or an unknown format; a failure leaves no .part', async () => {
  await assert.rejects(S.exportMix({ dir: song.dir, meta: song.meta, mix: mixOf('vocals'), format: 'wav', output: song.src, sourcePath: song.src }), /replace the original/);
  await assert.rejects(exportTo([], 'wav', 'none.wav'), /at least one/);
  await assert.rejects(exportTo(mixOf('vocals'), 'ogg', 'x.ogg'), /Unknown format/);
  await assert.rejects(S.exportMix({ dir: path.join(tmp, 'no-such-dir'), meta: song.meta, mix: mixOf('vocals'), format: 'wav', output: path.join(tmp, 'exp', 'fail.wav') }));
  assert(!fs.existsSync(path.join(tmp, 'exp', 'fail.wav.part')) && !fs.existsSync(path.join(tmp, 'exp', 'fail.wav')));
});

test('export: cancelling leaves no file; tags are copied from the original', async () => {
  const ac = new AbortController(); ac.abort();
  await assert.rejects(exportTo(mixOf('vocals'), 'wav', 'cancel.wav', { signal: ac.signal }), (e) => e.cancelled === true);
  assert(!fs.existsSync(path.join(tmp, 'exp', 'cancel.wav')) && !fs.existsSync(path.join(tmp, 'exp', 'cancel.wav.part')));
  // a tagged original: title survives into the export
  const tagged = path.join(tmp, 'tagged.flac');
  const { spawnSync } = require('child_process');
  const r0 = spawnSync(ff, ['-v', 'error', '-y', '-i', song.src, '-metadata', 'title=Test Title', '-metadata', 'artist=Test Artist', tagged], { windowsHide: true });
  assert.strictEqual(r0.status, 0);
  const t = await S.ensureStems({ source: tagged, root: path.join(tmp, 'cache-tag'), getRunner: async () => fakeRunner() });
  const out = await S.exportMix({ dir: t.dir, meta: t.meta, mix: mixOf('bass'), format: 'flac', output: path.join(tmp, 'exp', 'tag.flac'), sourcePath: tagged });
  const probe = spawnSync(ff, ['-hide_banner', '-i', out.output], { encoding: 'utf8', windowsHide: true });
  assert(/title\s*:\s*Test Title/i.test(probe.stderr) && /artist\s*:\s*Test Artist/i.test(probe.stderr), probe.stderr.slice(-400));
});

// ---- the real model ---------------------------------------------------------------------------------------------------------------
test('model settings: the CPU memory arena stays off (it holds ~4.7 GB for the whole split; off it peaks ~2.5 GB)', () => {
  assert.strictEqual(S.SESSION_OPTIONS.enableCpuMemArena, false);
  assert.strictEqual(S.SESSION_OPTIONS.enableMemPattern, false);
  assert.deepStrictEqual(S.SESSION_OPTIONS.executionProviders, ['cpu'], 'the GPU path (DirectML) fails on this model with out-of-memory');
  assert.throws(() => { S.SESSION_OPTIONS.enableCpuMemArena = true; }, TypeError, 'the settings are frozen');
});

test('real model: loads, answers the right shape, and the stems add back to the mix (skipped when the model is not downloaded)', async () => {
  if (!fs.existsSync(S.modelPath())) { console.log('     (model file not found - skipped; run "npm run setup")'); return; }
  const N = P.SEGMENT;
  // a "band": a low pulse (bass/drums-like), a steady chord and some noise
  const sec = 9;
  const T = sec * 44100;
  const src = path.join(tmp, 'band.wav');
  let seed = 7;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff - 0.5; };
  K.makeWav(src, {
    rate: 44100, channels: 2,
    parts: [{ sec, gen: (i, rate) => {
      const t = i / rate;
      const kick = Math.sin(2 * Math.PI * 55 * t) * Math.exp(-((t * 2) % 1) * 8) * 0.5;
      const chord = (Math.sin(2 * Math.PI * 220 * t) + Math.sin(2 * Math.PI * 277.2 * t) + Math.sin(2 * Math.PI * 329.6 * t)) * 0.09;
      return kick + chord + rnd() * 0.05;
    } }],
  });
  const runner = await S.createRunner();
  // onnxruntime's run() blocks the thread that calls it (the event loop ticked ONCE in a whole 3 s inference), which in the
  // app would freeze the window and the Cancel button. The model runs in a worker thread; this keeps it that way.
  let last = Date.now(); let maxGap = 0;
  const ticker = setInterval(() => { const n = Date.now(); maxGap = Math.max(maxGap, n - last); last = n; }, 20);
  try {
    const r = await S.ensureStems({ source: src, root: path.join(tmp, 'cache-real'), getRunner: async () => runner });
    clearInterval(ticker);
    assert(maxGap < 700, `the main thread was blocked for ${maxGap} ms while the model ran`);
    assert.strictEqual(r.meta.frames, T);
    assert.strictEqual(P.segmentPlan(T).count, 2, 'two overlapping segments were needed');
    const sum = new Float64Array(T);
    const energy = {};
    for (const id of P.STEM_IDS) {
      const w = readWav(path.join(r.dir, id + '.wav'));
      assert.strictEqual(w.n, T);
      let e = 0;
      for (let i = 0; i < T; i++) { sum[i] += w.l[i]; e += w.l[i] * w.l[i]; }
      energy[id] = Math.sqrt(e / T);
    }
    const o = readWav(path.join(tmp, 'band.wav'));
    let num = 0; let den = 0;
    for (let i = 0; i < T; i++) { const d = sum[i] - o.l[i]; num += d * d; den += o.l[i] * o.l[i]; }
    const ratio = Math.sqrt(num / den);
    assert(ratio < 0.3, 'stems sum to within 30% of the mix, got ' + ratio.toFixed(3));
    assert(energy.drums + energy.bass + energy.other + energy.vocals + energy.guitar + energy.piano > 0.02, 'the stems carry sound');
    console.log(`     real model: ${r.meta.seconds.toFixed(1)} s for ${sec} s of audio; sum-vs-mix error ${(ratio * 100).toFixed(1)}%; longest main-thread stall ${maxGap} ms`);
  } finally { clearInterval(ticker); await runner.release(); }
});

// ---- the look ---------------------------------------------------------------------------------------------------------------------
test('look: the stem lane colours and text are readable on the dark background', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'styles.css'), 'utf8');
  const tokens = {};
  for (const m of css.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-fA-F]{6})/g)) tokens[m[1]] = m[2];
  const lum = (hex) => { const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  const pairs = [['text', 'bg', 4.5], ['muted', 'bg', 4.5], ['muted', 'panel', 4.5], ['accent', 'bg', 4.5], ['err', 'bg', 4.5], ['ok', 'bg', 4.5]];
  const bad = pairs.filter(([a, b, min]) => !tokens[a] || !tokens[b] || ratio(tokens[a], tokens[b]) < min).map(([a, b, min]) => `${a} on ${b} < ${min}`);
  assert.deepStrictEqual(bad, []);
  for (const s of P.STEMS) assert(ratio(s.color, tokens['wave-bg']) >= 3, `${s.id} lane colour on the lane background`);
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
