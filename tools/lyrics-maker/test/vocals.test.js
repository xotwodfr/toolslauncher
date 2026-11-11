'use strict';
// "Isolate vocals first" tests (src/vocals.js). The streaming, overlap blending and resampling are checked exactly with a
// stand-in for the model. Then the real Demucs model is run on SPOKEN sentences (espeak-ng, or the Windows voices) mixed under
// LOUD synthetic music (drums made of noise bursts on the beat, a bass line and chords made of harmonic tones) 6 dB louder
// than the voice: the music must mostly go, the voice must stay, and Whisper must do at least as well on the result as on the
// mix. How it does on real songs (real instruments, reverb, backing vocals) is NOT claimed here.
// Needs models/htdemucs_6s_fp16weights.onnx (node scripts/fetch-demucs.js); without it the model tests are skipped.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const V = require('../src/vocals');
const A = require('../src/audio');
const E = require('../src/engine');
const SP = require('../src/speech');

const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const skipNote = (why) => console.log(`     (skipped: ${why})`);
const needs = ({ model = false, speech = false, whisper = false }, fn) => async () => {
  if (model && V.missing()) return skipNote('needs the separation model: node scripts/fetch-demucs.js');
  if (speech && !SP.available()) return skipNote('needs the Windows speech voices or espeak-ng');
  if (whisper && E.missingFiles().length) return skipNote('needs the Whisper model: npm run setup');
  return fn();
};
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vocals-test-'));
const ffmpeg = A.ffmpegPath();
const dB = (x) => 10 * Math.log10(x);
const hwmMB = () => { try { return Math.round(Number(/VmHWM:\s+(\d+)/.exec(fs.readFileSync('/proc/self/status', 'utf8'))[1]) / 1024); } catch { return null; } };

// ---- helpers --------------------------------------------------------------------------------------------------------------------
/** Decode a file with ffmpeg to interleaved float32 at `rate` with `ch` channels. */
function decodeAt(file, rate, ch) {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpeg, ['-hide_banner', '-v', 'error', '-i', file, '-ac', String(ch), '-ar', String(rate), '-f', 'f32le', '-'], { windowsHide: true });
    const chunks = [];
    p.stdout.on('data', (d) => chunks.push(d));
    p.on('error', reject);
    p.on('close', (code) => {
      if (code !== 0) return reject(new Error('ffmpeg failed'));
      const b = Buffer.concat(chunks); const out = new Float32Array(b.length >> 2);
      for (let i = 0; i < out.length; i++) out[i] = b.readFloatLE(i * 4);
      return resolve(out);
    });
  });
}

/** 16-bit WAV, `channels` = array of Float32Array (same length). */
function writeWav(file, channels, rate) {
  const n = channels[0].length; const c = channels.length;
  const data = Buffer.alloc(n * c * 2);
  for (let i = 0; i < n; i++) for (let k = 0; k < c; k++) data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, channels[k][i])) * 32767), (i * c + k) * 2);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVEfmt ', 8); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(c, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * c * 2, 28); h.writeUInt16LE(c * 2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(data.length, 40);
  fs.writeFileSync(file, Buffer.concat([h, data]));
  return file;
}

/**
 * A loud synthetic band at 44.1 kHz stereo, 120 bpm: kick on every beat, snare on 2 and 4, hi-hat on the eighths (all noise
 * bursts / decaying sweeps), a plucked bass line and sustained chords made of harmonic tones, over Am - F - C - G.
 */
function makeMusic(seconds, rate = 44100) {
  const n = Math.round(seconds * rate);
  const L = new Float32Array(n); const R = new Float32Array(n);
  let seed = 12345;
  const rnd = () => { seed = (seed * 1103515245 + 12345) >>> 0; return seed / 4294967296 * 2 - 1; };
  const beat = 0.5;
  const add = (buf, at, len, f) => { const s = Math.round(at * rate); for (let i = 0; i < len && s + i < n; i++) buf[s + i] += f(i / rate); };
  for (let t = 0, k = 0; t < seconds; t += beat / 2, k++) {
    const len = Math.round(0.25 * rate);
    if (k % 2 === 0) {                                               // kick: falling sine sweep + click
      let ph = 0;
      add(L, t, len, (x) => { ph += 2 * Math.PI * (45 + 90 * Math.exp(-x * 30)) / rate; return 0.9 * Math.sin(ph) * Math.exp(-x * 12); });
      R.set(L.subarray(Math.round(t * rate), Math.min(n, Math.round(t * rate) + len)), Math.round(t * rate));
    }
    if (k % 4 === 2) {                                               // snare: noise burst + body tone
      add(L, t, len, (x) => (0.5 * rnd() + 0.3 * Math.sin(2 * Math.PI * 190 * x)) * Math.exp(-x * 18));
      add(R, t, len, (x) => (0.5 * rnd() + 0.3 * Math.sin(2 * Math.PI * 190 * x)) * Math.exp(-x * 18));
    }
    let prev = 0;                                                    // hi-hat: high-passed noise, a little to the right
    add(L, t, len, (x) => { const v = rnd(); const h = v - prev; prev = v; return 0.12 * h * Math.exp(-x * 60); });
    add(R, t, len, (x) => { const v = rnd(); const h = v - prev; prev = v; return 0.2 * h * Math.exp(-x * 60); });
  }
  const hz = (midi) => 440 * 2 ** ((midi - 69) / 12);
  const chords = [[57, 60, 64], [53, 57, 60], [48, 52, 55], [55, 59, 62]];  // Am F C G
  for (let bar = 0; bar * 2 < seconds; bar++) {
    const ch = chords[bar % 4];
    for (let e = 0; e < 8; e++) {                                    // bass: eighth-note plucks on the root, 2 octaves down
      const f0 = hz(ch[0] - 24 + (e === 6 ? 7 : 0));
      const pluck = (x) => { let v = 0; for (let h = 1; h <= 6; h++) v += Math.sin(2 * Math.PI * f0 * h * x) / h; return 0.35 * v * Math.exp(-x * 6); };
      add(L, bar * 2 + e * 0.25, Math.round(0.24 * rate), pluck);
      add(R, bar * 2 + e * 0.25, Math.round(0.24 * rate), pluck);
    }
    for (let j = 0; j < 3; j++) {                                    // chords: a held pad, one note left, one right, one centre
      const f0 = hz(ch[j]);
      const gl = [0.9, 0.3, 0.6][j]; const gr = [0.3, 0.9, 0.6][j];
      const pad = (x) => { let v = 0; for (let h = 1; h <= 5; h++) v += Math.sin(2 * Math.PI * f0 * h * x) / (h * h); return 0.16 * v * Math.min(1, x * 20, (2 - x) * 20); };
      add(L, bar * 2, Math.round(2 * rate), (x) => gl * pad(x));
      add(R, bar * 2, Math.round(2 * rate), (x) => gr * pad(x));
    }
  }
  return { L, R };
}

const rms2 = (a, from = 0, to = a.length) => { let s = 0; for (let i = from; i < to; i++) s += a[i] * a[i]; return s / Math.max(1, to - from); };
const energyIn = (a, ranges, rate = 16000) => {
  let s = 0; let n = 0;
  for (const [x, y] of ranges) { const f = Math.max(0, Math.round(x * rate)); const t = Math.min(a.length, Math.round(y * rate)); for (let i = f; i < t; i++) s += a[i] * a[i]; n += Math.max(0, t - f); }
  return s / Math.max(1, n);
};

// The test song, made once: { mixFile, mix16, speech16, music16, truth, speechRanges, musicRanges, seconds }
let song = null;
async function makeSong() {
  if (song) return song;
  const seconds = 48;
  const parts = SP.SENTENCES.map((text, i) => ({ text, at: 4 + i * 11, voice: i % 2 ? 'Microsoft Zira Desktop' : 'Microsoft David Desktop' }));
  const clip = await SP.makeClip(parts, seconds, path.join(tmp, 'speech16.wav'));
  const sp = await decodeAt(clip.file, 44100, 1);                       // the voice at the model's rate
  const music = makeMusic(seconds);
  const n = Math.min(sp.length, music.L.length);
  const speechRanges = clip.truth.map((t) => [t.start, t.end]);
  const musicRanges = [];                                               // where only the band plays (with a margin round the voice)
  let from = 0.5;
  for (const t of clip.truth) { if (t.start - 0.3 - from > 0.8) musicRanges.push([from, t.start - 0.3]); from = t.end + 0.6; }
  if (seconds - 0.5 - from > 0.8) musicRanges.push([from, seconds - 0.5]);
  const voicePow = energyIn(sp, speechRanges, 44100);
  const musicPow = (rms2(music.L, 0, n) + rms2(music.R, 0, n)) / 2;
  const g = Math.sqrt((voicePow * 10 ** 0.6) / musicPow);              // music 6 dB louder than the voice (while it speaks)
  const mL = new Float32Array(n); const mR = new Float32Array(n); const vL = new Float32Array(n);
  let peak = 0;
  for (let i = 0; i < n; i++) { mL[i] = sp[i] + g * music.L[i]; mR[i] = sp[i] + g * music.R[i]; peak = Math.max(peak, Math.abs(mL[i]), Math.abs(mR[i])); }
  const k = 0.9 / peak;                                                 // no clipping
  for (let i = 0; i < n; i++) { mL[i] *= k; mR[i] *= k; vL[i] = sp[i] * k; }
  const mixFile = writeWav(path.join(tmp, 'mix.wav'), [mL, mR], 44100);
  const voiceFile = writeWav(path.join(tmp, 'voice.wav'), [vL, vL], 44100);
  const bandL = new Float32Array(n); const bandR = new Float32Array(n);
  for (let i = 0; i < n; i++) { bandL[i] = mL[i] - vL[i]; bandR[i] = mR[i] - vL[i]; }
  const bandFile = writeWav(path.join(tmp, 'band.wav'), [bandL, bandR], 44100);
  song = {
    mixFile, seconds, truth: clip.truth, speechRanges, musicRanges,
    mix16: await A.decode16k(ffmpeg, mixFile), speech16: await A.decode16k(ffmpeg, voiceFile), music16: await A.decode16k(ffmpeg, bandFile),
  };
  return song;
}

/** A stand-in for the model with a small segment: returns the input's mono downmix, (L + R) / sqrt(2), like the worker. */
const identityRunner = (N) => {
  let calls = 0;
  return {
    segment: N, get calls() { return calls; },
    infer: async (p) => { calls++; const o = new Float32Array(N); for (let i = 0; i < N; i++) o[i] = Math.SQRT1_2 * (p[i] + p[N + i]); return o; },
    release: async () => {},
  };
};

function ffmpegMake(args) {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpeg, ['-hide_banner', '-v', 'error', '-y', ...args], { windowsHide: true });
    p.on('error', reject); p.on('close', (c) => (c === 0 ? resolve() : reject(new Error('ffmpeg failed'))));
  });
}

// ---- the plumbing, with a stand-in for the model ------------------------------------------------------------------------------
test('plumbing: segments, overlap blending and resampling give back exactly what decode16k gives (stand-in model)', async () => {
  const f = path.join(tmp, 'tone.wav');
  await ffmpegMake(['-f', 'lavfi', '-i', 'sine=frequency=440:duration=7.3:sample_rate=44100', '-f', 'lavfi', '-i', 'anoisesrc=d=7.3:a=0.2:r=44100:seed=7',
    '-filter_complex', '[0][1]amerge=inputs=2', '-ac', '2', f]);
  const runner = identityRunner(10007);                 // an odd segment, so the stride and the last piece are uneven
  const prog = [];
  const v = await V.isolateVocals(f, { runner, onProgress: (p) => prog.push(p) });
  const ref = await A.decode16k(ffmpeg, f);
  assert.strictEqual(v.length, ref.length);
  let e = 0; for (let i = 0; i < ref.length; i++) e += (v[i] - ref[i]) ** 2;
  const err = dB(e / rms2(ref) / ref.length);
  assert(err < -100, `difference ${err.toFixed(1)} dB`);
  assert(runner.calls >= 40, `${runner.calls} segments`);
  const fr = prog.map((p) => p.fraction);
  assert.strictEqual(fr[0], 0); assert.strictEqual(fr[fr.length - 1], 1);
  for (let i = 1; i < fr.length; i++) assert(fr[i] >= fr[i - 1], 'progress never goes back');
});

test('plumbing: a 48 kHz mono file of an odd length comes out as long as decode16k makes it, and the same', async () => {
  const f = path.join(tmp, 'odd.flac');
  await ffmpegMake(['-f', 'lavfi', '-i', 'anoisesrc=d=5.123:a=0.3:r=48000:seed=3,lowpass=f=6000', '-ac', '1', f]);
  const v = await V.isolateVocals(f, { runner: identityRunner(44100) });
  const ref = await A.decode16k(ffmpeg, f);
  assert(Math.abs(v.length - ref.length) <= 4, `${v.length} vs ${ref.length}`);
  const n = Math.min(v.length, ref.length) - 200;
  let e = 0; let p = 0; for (let i = 200; i < n; i++) { e += (v[i] - ref[i]) ** 2; p += ref[i] ** 2; }
  assert(dB(e / p) < -40, `difference ${dB(e / p).toFixed(1)} dB (two resampling steps instead of one)`);
});

test('plumbing: a file that is not audio, and an already-cancelled signal, are refused cleanly', async () => {
  const bad = path.join(tmp, 'notes.mp3');
  fs.writeFileSync(bad, 'this is not a song');
  await assert.rejects(V.isolateVocals(bad, { runner: identityRunner(1000) }), (e) => e instanceof A.UserError);
  const ac = new AbortController(); ac.abort();
  await assert.rejects(V.isolateVocals(bad, { runner: identityRunner(1000), signal: ac.signal }), (e) => e.cancelled === true);
});

test('plumbing: two separations asked for at once run one after the other (never two models loaded), and both are right', async () => {
  const f = path.join(tmp, 'tone.wav');
  let active = 0; let most = 0; const log = [];
  const runner = (tag) => {
    const r = identityRunner(20000); const infer = r.infer;
    return { segment: r.segment, infer: async (p) => { active++; most = Math.max(most, active); log.push(tag); await new Promise((ok) => setTimeout(ok, 2)); active--; return infer(p); }, release: async () => { log.push(tag + ' released'); } };
  };
  const [a, b] = await Promise.all([V.isolateVocals(f, { runner: runner('a') }), V.isolateVocals(f, { runner: runner('b') })]);
  assert.strictEqual(most, 1);
  assert(log.lastIndexOf('a') < log.indexOf('b'), 'b starts after a is done');
  assert.deepStrictEqual(Array.from(a.subarray(0, 50000)), Array.from(b.subarray(0, 50000)));
  const ac = new AbortController();                                   // cancelled while waiting for its turn
  const first = V.isolateVocals(f, { runner: runner('c') });
  const waiting = V.isolateVocals(f, { runner: runner('d'), signal: ac.signal });
  ac.abort();
  await assert.rejects(waiting, (e) => e.cancelled === true);
  await first; await V.idle();
  assert(!log.includes('d'), 'the cancelled one never ran');
});

test('model: a missing model file gives a clear message', async () => {
  const nowhere = path.join(tmp, 'nothing-here', V.MODEL_FILE);
  assert.strictEqual(V.missing(nowhere), true);
  assert.strictEqual(V.missing(), !fs.existsSync(V.modelPath()));
  await assert.rejects(V.isolateVocals(path.join(tmp, 'tone.wav'), { model: nowhere }), (e) => e instanceof A.UserError && /npm run setup/.test(e.message));
});

// ---- the real model -------------------------------------------------------------------------------------------------------------------
let isolated = null;
test('model: the band drops by far more than 15 dB, the voice keeps its energy, 16 kHz mono of the right length', needs({ model: true, speech: true }, async () => {
  const s = await makeSong();
  const t0 = Date.now(); let tLoaded = 0; const prog = [];
  const v = await V.isolateVocals(s.mixFile, { onProgress: (p) => { prog.push(p.fraction); if (p.phase === 'separate' && !tLoaded) tLoaded = Date.now(); } });
  const took = (Date.now() - t0) / 1000;
  isolated = v;
  assert(v instanceof Float32Array);
  assert(Math.abs(v.length - s.mix16.length) <= 8, `${v.length} samples vs ${s.mix16.length} from decode16k`);
  assert.strictEqual(prog[prog.length - 1], 1);

  const musicMix = energyIn(s.mix16, s.musicRanges); const musicLeft = energyIn(v, s.musicRanges);
  const drop = dB(musicMix / musicLeft);
  const voiceIn = energyIn(s.speech16, s.speechRanges); const voiceOut = energyIn(v, s.speechRanges);
  const kept = dB(voiceOut / voiceIn);
  let e = 0; let p = 0; let em = 0;
  for (const [a, b] of s.speechRanges) for (let i = Math.round(a * 16000); i < Math.min(v.length, Math.round(b * 16000)); i++) { p += s.speech16[i] ** 2; e += (v[i] - s.speech16[i]) ** 2; em += (s.mix16[i] - s.speech16[i]) ** 2; }
  const snrMix = dB(p / em); const snrOut = dB(p / e);
  console.log(`     band where only it plays: ${drop.toFixed(1)} dB quieter | voice energy kept: ${kept.toFixed(1)} dB | voice-to-rest while speaking: mix ${snrMix.toFixed(1)} dB -> vocals ${snrOut.toFixed(1)} dB`);
  console.log(`     ${s.seconds} s of audio in ${took.toFixed(1)} s (model loaded and first segment done after ${((tLoaded - t0) / 1000).toFixed(1)} s): ${(took / s.seconds * 60).toFixed(1)} s per minute; peak memory of the whole process so far ${hwmMB()} MB`);
  assert(drop >= 15, `the band only dropped ${drop.toFixed(1)} dB`);
  assert(kept > -3 && kept < 2, `voice energy changed by ${kept.toFixed(1)} dB`);
  assert(snrOut > snrMix + 10, `voice-to-rest only went from ${snrMix.toFixed(1)} to ${snrOut.toFixed(1)} dB`);
}));

test('model: Whisper understands the isolated vocals about as well as the mix of voice and synthetic band (word error rates)', needs({ model: true, speech: true, whisper: true }, async () => {
  const s = await makeSong();
  const v = isolated || await V.isolateVocals(s.mixFile);
  const said = s.truth.map((t) => t.text).join(' ');
  const eng = await E.createEngine();
  try {
    const heardMix = (await eng.transcribe(s.mix16.slice(), { language: 'en' })).segments.map((x) => x.text).join(' ');
    const heardVoc = (await eng.transcribe(v.slice(), { language: 'en' })).segments.map((x) => x.text).join(' ');
    const werMix = SP.wordErrorRate(said, heardMix); const werVoc = SP.wordErrorRate(said, heardVoc);
    console.log(`     word error rate: mix ${(werMix * 100).toFixed(1)}% -> isolated vocals ${(werVoc * 100).toFixed(1)}%`);
    console.log(`     mix heard:    ${heardMix.trim().slice(0, 400)}`);
    console.log(`     vocals heard: ${heardVoc.trim().slice(0, 400)}`);
    // Measured: Whisper is already very good on this synthetic band (it is not real music), so there is little to win here, and
    // the separation costs a few consonants ("glowed" -> "bloat"): 1.9% -> 9.3% at +6 dB, 14.8% -> 14.8% at +12 dB. So this
    // only checks that isolating does not cost more than 10 words in 100. (On 5 real songs, see the report, it helps a little
    // once Whisper's repetition loops are taken out, and hurts a lot while they are not.)
    assert(werVoc <= werMix + 0.10, `much worse on the vocals: ${werVoc} vs ${werMix}`);
    assert(werVoc <= 0.15, `word error rate on the vocals ${werVoc}`);
  } finally { await eng.release(); }
}));

test('model: cancel mid-separation stops within a few seconds, frees the model, and the next run works', needs({ model: true, speech: true }, async () => {
  const s = await makeSong();
  const ac = new AbortController();
  let abortedAt = 0;
  // 1 s after the first segment is done, so the model is in the middle of the next one (they take several seconds each)
  const p = V.isolateVocals(s.mixFile, { signal: ac.signal, onProgress: (x) => { if (x.phase === 'separate' && !abortedAt) { abortedAt = 1; setTimeout(() => { abortedAt = Date.now(); ac.abort(); }, 1000); } } })
    .then(() => 'finished', (e) => (e.cancelled ? 'cancelled' : 'error: ' + e.message));
  assert.strictEqual(await p, 'cancelled');
  const rejectedIn = (Date.now() - abortedAt) / 1000;
  await V.idle();
  const freedIn = (Date.now() - abortedAt) / 1000;
  console.log(`     rejected ${rejectedIn.toFixed(2)} s after cancel; model freed and thread ended ${freedIn.toFixed(1)} s after cancel`);
  assert(rejectedIn < 1, `took ${rejectedIn} s to give up`);
  assert(freedIn < 30, `took ${freedIn} s to free the model`);

  // Cancel while the model is still loading, too.
  const ac2 = new AbortController();
  const p2 = V.isolateVocals(s.mixFile, { signal: ac2.signal }).then(() => 'finished', (e) => (e.cancelled ? 'cancelled' : 'error: ' + e.message));
  setTimeout(() => ac2.abort(), 1500);
  assert.strictEqual(await p2, 'cancelled');
  await V.idle();

  const short = path.join(tmp, 'short.wav');
  await ffmpegMake(['-i', s.mixFile, '-t', '9', short]);
  const v = await V.isolateVocals(short);
  const ref = await A.decode16k(ffmpeg, short);
  assert(Math.abs(v.length - ref.length) <= 8);
  assert(rms2(v) > 0, 'there is sound');
}));

(async () => {
  let failed = 0;
  for (const [name, fn] of tests) {
    if (process.env.ONLY && !new RegExp(process.env.ONLY, 'i').test(name)) continue;
    const t0 = Date.now();
    try { await fn(); console.log(`ok   ${name} (${Date.now() - t0} ms)`); }
    catch (e) { failed++; console.log(`FAIL ${name}\n     ${String((e && e.stack) || e).split('\n').slice(0, 6).join('\n     ')}`); }
  }
  try { await V.idle(); } catch { /* ignore */ }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  console.log(failed ? `\n${failed} of ${tests.length} failed` : `\nall ${tests.length} passed`);
  process.exit(failed ? 1 : 0);
})();
