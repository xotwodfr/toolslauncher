'use strict';
// Audio Inspector core tests. All test files are made here from scratch: noise and tones written as WAV, then put through
// ffmpeg the way fake files are made in the wild (to MP3 and back to FLAC, upsampled to 96 kHz, padded to 24-bit). Every
// verdict and number is checked, loudness and true peak against ffmpeg's own ebur128 meter, and every file is hashed before
// and after to prove the inspector never changes anything.
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const A = require('../src/analyse');
const L = require('../src/loudness');
const P = require('../src/probe');
const V = require('../src/verdict');
const R = require('../src/report');
const G = require('../src/signals');
const { Pool, ffmpegPath } = require('../src/pool');

const ff = ffmpegPath();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'inspector-test-'));
const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const near = (a, b, tol, msg) => assert(Math.abs(a - b) <= tol, `${msg || ''} expected ${b} +/- ${tol}, got ${a}`);
const hashes = new Map();
const file = (name) => path.join(tmp, name);
function ffmpeg(args) { const r = spawnSync(ff, ['-y', '-hide_banner', '-v', 'error', ...args], { encoding: 'utf8', windowsHide: true }); assert.strictEqual(r.status, 0, 'ffmpeg failed: ' + r.stderr); }
const md5 = (f) => crypto.createHash('md5').update(fs.readFileSync(f)).digest('hex');
/** Inspect a file, remembering its hash first (checked unchanged at the end). */
async function inspect(f) { if (!hashes.has(f)) hashes.set(f, md5(f)); return A.analyseFile(ff, f); }
function ebur128(f) {
  const r = spawnSync(ff, ['-hide_banner', '-nostats', '-i', f, '-af', 'ebur128=peak=true+sample', '-f', 'null', '-'], { encoding: 'utf8', windowsHide: true });
  const last = (re) => { let m; let v = null; while ((m = re.exec(r.stderr))) v = Number(m[1]); return v; };
  return { I: last(/I:\s+(-?[\d.]+) LUFS/g), LRA: last(/LRA:\s+(-?[\d.]+) LU/g), TP: last(/True peak:\s+Peak:\s+(-?[\d.]+)/g), SP: last(/Sample peak:\s+Peak:\s+(-?[\d.]+)/g) };
}

// the shared test files: 8 seconds of independent white noise per channel at 44.1 kHz
const SEC = 8;
let made = null;
function material() {
  if (made) return made;
  const n = 44100 * SEC;
  const noise = file('noise 44k.wav'); G.writeWav(noise, [G.white(n, 0.18, 11), G.white(n, 0.18, 12)], 44100, 16);
  const mp3 = file('noise 128k.mp3'); ffmpeg(['-i', noise, '-c:a', 'libmp3lame', '-b:a', '128k', mp3]);
  const fake = file('Fake Album – Track 01.flac'); ffmpeg(['-i', mp3, '-sample_fmt', 's16', fake]);
  const fake24 = file('fake 24.wav'); ffmpeg(['-i', mp3, '-c:a', 'pcm_s24le', fake24]);
  const real = file('real full band.flac'); ffmpeg(['-i', noise, real]);
  const pinkf = file('pink.flac'); G.writeWav(file('pink.wav'), [G.pink(n, 0.2, 21), G.pink(n, 0.2, 22)], 44100, 16); ffmpeg(['-i', file('pink.wav'), pinkf]);
  made = { noise, mp3, fake, fake24, real, pink: pinkf };
  return made;
}

// ---- the maths -------------------------------------------------------------------------------------------------------------
test('fft: a tone lands in its bin, energy is conserved, two channels packed in one FFT come apart cleanly', () => {
  const n = 1024; const fft = A.makeFft(n);
  const re = new Float64Array(n); const im = new Float64Array(n);
  for (let i = 0; i < n; i++) re[i] = Math.cos((2 * Math.PI * 37 * i) / n);
  let te = 0; for (let i = 0; i < n; i++) te += re[i] * re[i];
  fft(re, im);
  let fe = 0; let best = 0;
  for (let k = 0; k < n; k++) { const p = re[k] * re[k] + im[k] * im[k]; fe += p; if (k < n / 2 && p > re[best] * re[best] + im[best] * im[best]) best = k; }
  assert.strictEqual(best, 37); near(fe / n, te, 1e-6, 'Parseval');
  assert.throws(() => A.makeFft(1000), /power of two/);
  // the analyser: a full-scale tone reads 0 dB in the averaged spectrum; left and right do not leak into each other
  const a = new A.Analyser({ sampleRate: 48000, channels: 2, bits: null, float: true, duration: 1 });
  const len = 48000; const buf = Buffer.alloc(len * 8);
  const f0 = 48000 / 4096 * 300;                            // exactly on bin 300
  for (let i = 0; i < len; i++) { buf.writeFloatLE(Math.sin((2 * Math.PI * f0 * i) / 48000), i * 8); buf.writeFloatLE(0, i * 8 + 4); }
  a.push(buf.subarray(0, 12345)); a.push(buf.subarray(12345));  // a piece ending inside a sample is joined to the next
  const m = a.finish();
  near(m.spectrum.db[300], -3.01, 0.05, 'a full-scale tone in one of two channels: -3 dB in the channel average');
  assert(m.spectrum.db[600] < -100, 'nothing at twice the frequency');
  assert.strictEqual(m.samples, len);
});

test('loudness: K-weighting is 0 dB at 1 kHz; integrated loudness, LRA and peaks of tones match ffmpeg\'s ebur128 within 0.3', () => {
  for (const fs_ of [44100, 48000, 96000]) {
    const { shelf, hp } = L.kWeighting(fs_);
    const gain = (b, f) => {       // |H(e^jw)| of a biquad
      const w = (2 * Math.PI * f) / fs_;
      const mag = (c) => { let re = 0; let im = 0; for (let k = 0; k < 3; k++) { re += c[k] * Math.cos(k * w); im -= c[k] * Math.sin(k * w); } return Math.hypot(re, im); };
      return mag([b.b0, b.b1, b.b2]) / mag([1, b.a1, b.a2]);
    };
    const g = 20 * Math.log10(gain(shelf, 997) * gain(hp, 997));
    near(g, 0.69, 0.1, `K-weighting at 997 Hz, ${fs_} Hz (the 0.691 offset puts a 1 kHz tone at its level)`);
  }
  const cases = [
    { name: 'sine -20 dBFS 48k', rate: 48000, make: (n) => [G.sine(n, 48000, 1000, 0.1), G.sine(n, 48000, 1000, 0.1)] },
    { name: 'sine 997 Hz -6 dBFS 44.1k, louder on the left', rate: 44100, make: (n) => [G.sine(n, 44100, 997, 0.5), G.sine(n, 44100, 997, 0.25)] },
    { name: 'tone at fs/4 with inter-sample peaks', rate: 44100, make: (n) => [G.sine(n, 44100, 11025, 0.9, Math.PI / 4), G.sine(n, 44100, 11025, 0.9, Math.PI / 4)] },
    { name: 'pink noise with a quiet half (loudness range)', rate: 48000, make: (n) => { const x = G.pink(n, 0.15, 5); for (let i = n / 2; i < n; i++) x[i] *= 0.25; return [x, x.slice()]; } },
  ];
  for (const c of cases) {
    const n = c.rate * 12; const ch = c.make(n);
    const f = G.writeWav(file(`lufs ${c.name}.wav`), ch, c.rate, 'float');
    const ref = ebur128(f);
    const meter = new L.LoudnessMeter(c.rate, 2);
    const x = new Float32Array(n * 2); for (let i = 0; i < n; i++) { x[i * 2] = ch[0][i]; x[i * 2 + 1] = ch[1][i]; }
    meter.push(x, n);
    const r = meter.result();
    near(r.integrated, ref.I, 0.3, `${c.name}: integrated`);
    near(r.samplePeakDb, ref.SP, 0.15, `${c.name}: sample peak`);
    if (!/fs\/4/.test(c.name)) near(r.truePeakDb, ref.TP, 0.3, `${c.name}: true peak`);
    else { near(r.truePeakDb, 20 * Math.log10(0.9), 0.2, 'true peak at fs/4: the real peak between samples (ffmpeg overshoots here)'); assert(r.truePeakDb > r.samplePeakDb + 2.5, 'true peak above the sample peak'); }
    if (/range/.test(c.name)) near(r.lra, ref.LRA, 1.0, `${c.name}: LRA`);
  }
});

test('probe: ffmpeg\'s description is read into plain facts (codec, rate, bits, channels, bitrates, cover art)', () => {
  const t = (s) => P.parseProbe(s);
  const flac = t("Input #0, flac, from 'x.flac':\n  Duration: 00:03:21.45, start: 0.000000, bitrate: 942 kb/s\n  Stream #0:0: Audio: flac, 96000 Hz, stereo, s32 (24 bit)\n  Stream #0:1: Video: mjpeg (Baseline), yuvj420p(pc), 600x600, 90k tbr (attached pic)");
  assert.deepStrictEqual([flac.codec, flac.sampleRate, flac.channels, flac.bitsDeclared, flac.lossless, flac.containerBitrate, flac.hasCover, flac.codecName], ['flac', 96000, 2, 24, true, 942, true, 'FLAC']);
  near(flac.duration, 201.45, 1e-9);
  const mp3 = t("Input #0, mp3, from 'x.mp3':\n  Duration: 00:00:05.04, start: 0.025057, bitrate: 320 kb/s\n  Stream #0:0: Audio: mp3 (mp3float), 44100 Hz, stereo, fltp, 320 kb/s");
  assert.deepStrictEqual([mp3.codec, mp3.profile, mp3.lossless, mp3.bitsDeclared, mp3.streamBitrate], ['mp3', null, false, null, 320]);
  const aac = t("Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'x.m4a':\n  Duration: 00:00:05.00, bitrate: 224 kb/s\n  Stream #0:0[0x1](und): Audio: aac (LC) (mp4a / 0x6134706D), 44100 Hz, 5.1, fltp, 220 kb/s (default)");
  assert.deepStrictEqual([aac.codec, aac.profile, aac.channels, aac.container], ['aac', 'LC', 6, 'mov']);
  const wav = t("Input #0, wav, from 'x.wav':\n  Duration: 00:00:01.00, bitrate: 3072 kb/s\n  Stream #0:0: Audio: pcm_f32le ([3][0][0][0] / 0x0003), 48000 Hz, 2 channels, flt, 3072 kb/s");
  assert.deepStrictEqual([wav.float, wav.bitsDeclared, wav.channels, wav.codecName], [true, 32, 2, 'PCM 32-bit float']);
  assert.strictEqual(t('garbage').ok, false);
  assert(P.isAudio('a.FLAC') && P.isAudio('b.m4a') && !P.isAudio('c.txt'));
});

// ---- the verdicts ---------------------------------------------------------------------------------------------------------------
test('verdict: real full-band noise (WAV and FLAC) is "Real lossless", reaching above 21 kHz, 16 bits used', async () => {
  const m = material();
  for (const f of [m.noise, m.real]) {
    const r = await inspect(f);
    assert.strictEqual(r.verdict.kind, 'real', path.basename(f) + ': ' + JSON.stringify(r.verdict));
    assert.strictEqual(r.verdict.chip, 'Real lossless');
    assert(r.verdict.reachHz >= 21000, 'reaches ' + r.verdict.reachHz);
    assert.strictEqual(r.m.effectiveBits, 16);
    assert(!r.verdict.flags.some((x) => x.code === 'mono'), 'independent channels are not mono');
  }
});

test('verdict: the same noise through MP3 128 kbps and back to FLAC (16-bit) or WAV (24-bit) is "Fake lossless", stopping at ~16-17 kHz', async () => {
  const m = material();
  for (const f of [m.fake, m.fake24]) {
    const r = await inspect(f);
    assert.strictEqual(r.verdict.kind, 'fake', path.basename(f) + ': ' + JSON.stringify(r.verdict));
    assert.strictEqual(r.verdict.chip, 'Fake lossless'); assert.strictEqual(r.verdict.title, 'Fake lossless file');
    assert(r.verdict.cutoffHz >= 15500 && r.verdict.cutoffHz <= 17500, 'cutoff ' + r.verdict.cutoffHz);
    assert(r.verdict.cliffDb >= 40, 'a deep cliff: ' + r.verdict.cliffDb);
    assert(/was probably made from a lossy file \(MP3\/AAC ~128/.test(r.verdict.explain), r.verdict.explain);
    assert(/the sound stops at 1[67]\.\d kHz/.test(r.verdict.explain), r.verdict.explain);
  }
  assert(/^This FLAC/.test((await inspect(m.fake)).verdict.explain)); assert(/^This WAV/.test((await inspect(m.fake24)).verdict.explain));
});

test('verdict: higher-bitrate fakes: 192 kbps is caught; 320 kbps (cutoff ~20 kHz) is caught or honestly "Can\'t tell", never "Real"', async () => {
  const m = material();
  for (const [kb, expect] of [['192k', ['fake']], ['320k', ['fake', 'unsure']]]) {
    const mp3 = file(`n${kb}.mp3`); const out = file(`n${kb}.flac`);
    ffmpeg(['-i', m.noise, '-c:a', 'libmp3lame', '-b:a', kb, mp3]); ffmpeg(['-i', mp3, '-sample_fmt', 's16', out]);
    const r = await inspect(out);
    assert(expect.includes(r.verdict.kind), `${kb}: ${JSON.stringify(r.verdict)}`);
  }
});

test('verdict: lossy files are labelled with codec and bitrate; a 320 kbps MP3 made from a 128 kbps one is called out', async () => {
  const m = material();
  const r = await inspect(m.mp3);
  assert.strictEqual(r.verdict.kind, 'lossy'); assert.strictEqual(r.verdict.chip, 'Lossy (MP3 128 kbps)');
  assert(/stops at 1[67]\.\d kHz, as usual for ~128/.test(r.verdict.explain), r.verdict.explain);
  const up = file('upconverted 320.mp3'); ffmpeg(['-i', m.mp3, '-c:a', 'libmp3lame', '-b:a', '320k', up]);
  const u = await inspect(up);
  assert.strictEqual(u.verdict.chip, 'Lossy (MP3 320 kbps)');
  assert(/re-encoded from a lower bitrate/.test(u.verdict.explain) && u.verdict.flags.some((f) => f.code === 'transcode'), JSON.stringify(u.verdict));
  const ogg = file('noise.ogg'); ffmpeg(['-i', m.noise, '-c:a', 'libvorbis', '-q:a', '3', ogg]);
  const o = await inspect(ogg);
  assert(/^Lossy \(Vorbis/.test(o.verdict.chip), o.verdict.chip);
  assert.strictEqual(o.m.effectiveBits, null, 'no bit depth for a lossy file');
});

test('verdict: pink noise (-3 dB per octave, quiet at the top) is still "Real lossless"', async () => {
  const r = await inspect(material().pink);
  assert.strictEqual(r.verdict.kind, 'real', JSON.stringify(r.verdict));
});

test('verdict: a 96 kHz file made from 44.1 kHz is "Upsampled from 44.1 kHz"; from 48 kHz says so; real 96 kHz noise is "Real high resolution"', async () => {
  const m = material();
  const up = file('upsampled 96k.flac'); ffmpeg(['-i', m.noise, '-af', 'aresample=96000:resampler=soxr:precision=28', '-sample_fmt', 's32', up]);
  const r = await inspect(up);
  assert.strictEqual(r.verdict.kind, 'upsampled', JSON.stringify(r.verdict));
  assert.strictEqual(r.verdict.title, 'Upsampled from 44.1 kHz'); assert(/This 96 kHz file has nothing above 2[12]\.\d kHz/.test(r.verdict.explain), r.verdict.explain);
  // ffmpeg's own (softer) resampler too
  const up2 = file('upsampled swr.wav'); ffmpeg(['-i', m.noise, '-ar', '96000', '-c:a', 'pcm_s24le', up2]);
  assert.strictEqual((await inspect(up2)).verdict.kind, 'upsampled');
  const n48 = 48000 * 6; const src48 = G.writeWav(file('n48.wav'), [G.white(n48, 0.18, 31), G.white(n48, 0.18, 32)], 48000, 24);
  const up48 = file('from48.flac'); ffmpeg(['-i', src48, '-af', 'aresample=96000:resampler=soxr:precision=28', '-sample_fmt', 's32', up48]);
  assert.strictEqual((await inspect(up48)).verdict.title, 'Upsampled from 48 kHz');
  const n96 = 96000 * 6; const real96 = G.writeWav(file('real96.wav'), [G.white(n96, 0.18, 41), G.white(n96, 0.18, 42)], 96000, 24);
  const r96 = await inspect(real96);
  assert.strictEqual(r96.verdict.kind, 'real', JSON.stringify(r96.verdict)); assert.strictEqual(r96.verdict.title, 'Real high resolution');
  assert.strictEqual(r96.m.effectiveBits, 24);
  // an MP3 upsampled to 96 kHz is fake lossless (and the text says it was upsampled too)
  const mp96 = file('mp3 at 96k.flac'); ffmpeg(['-i', m.mp3, '-ar', '96000', '-sample_fmt', 's32', mp96]);
  const f96 = await inspect(mp96);
  assert.strictEqual(f96.verdict.kind, 'fake'); assert(/upsampled to 96 kHz/.test(f96.verdict.explain));
});

test('bits: a 16-bit file padded to 24-bit says "Really 16-bit"; real 24-bit and 32-bit float do not', async () => {
  const m = material();
  const padded = file('padded 24.wav'); ffmpeg(['-i', m.noise, '-c:a', 'pcm_s24le', padded]);
  const padFlac = file('padded 24.flac'); ffmpeg(['-i', m.noise, '-sample_fmt', 's32', '-c:a', 'flac', padFlac]);
  for (const f of [padded, padFlac]) {
    const r = await inspect(f);
    assert.strictEqual(r.info.bitsDeclared, 24, 'stored as 24-bit');
    assert.strictEqual(r.m.effectiveBits, 16); assert(r.verdict.really16);
    assert(r.verdict.flags.some((x) => x.code === 'bits' && /Really 16-bit: stored as 24-bit/.test(x.text)));
    assert.strictEqual(r.verdict.chip, 'Real lossless'); assert.strictEqual(r.verdict.kind, 'real');
  }
  const n = 44100 * 4;
  const r24 = await inspect(G.writeWav(file('true 24.wav'), [G.white(n, 0.2, 51), G.white(n, 0.2, 52)], 44100, 24));
  assert.strictEqual(r24.m.effectiveBits, 24); assert(!r24.verdict.really16);
  const rf = await inspect(G.writeWav(file('float.wav'), [G.white(n, 0.2, 53), G.white(n, 0.2, 54)], 44100, 'float'));
  assert.strictEqual(rf.info.float, true); assert.strictEqual(rf.m.effectiveBits, null); assert(!rf.verdict.really16);
  assert.strictEqual(rf.verdict.kind, 'real');
});

test('honest doubt: a dark (heavily filtered) recording, a very quiet file and a silent file are "Can\'t tell"', async () => {
  const m = material();
  const dark = file('dark recording.flac'); ffmpeg(['-i', m.noise, '-af', 'lowpass=f=2500:p=2,lowpass=f=2500:p=2,lowpass=f=2500:p=2', '-sample_fmt', 's16', dark]);
  const d = await inspect(dark);
  assert.strictEqual(d.verdict.kind, 'unsure', JSON.stringify(d.verdict));
  assert.strictEqual(d.verdict.title, "Can't tell (quiet or band-limited recording)");
  const n = 44100 * 4;
  const quiet = await inspect(G.writeWav(file('quiet.wav'), [G.white(n, 0.0002, 61), G.white(n, 0.0002, 62)], 44100, 16));
  assert.strictEqual(quiet.verdict.kind, 'unsure');
  const silent = await inspect(G.writeWav(file('silent.wav'), [new Float32Array(n), new Float32Array(n)], 44100, 16));
  assert.strictEqual(silent.verdict.kind, 'unsure'); assert(/silent/.test(silent.verdict.explain));
  assert.strictEqual(silent.m.integrated, -Infinity); assert(silent.m.silence.all);
});

// ---- the other measurements ------------------------------------------------------------------------------------------------------
test('clipping: a squared-off sine is counted (places and samples); a clean sine just under full scale has none', async () => {
  const n = 44100 * 3;
  const hot = G.sine(n, 44100, 440, 1.6).map((v) => Math.max(-1, Math.min(1, v)));
  const r = await inspect(G.writeWav(file('clipped.wav'), [hot, hot.slice()], 44100, 16));
  assert(r.m.clipping.runs > 2000, 'two flattened tops per cycle, both channels: ' + r.m.clipping.runs);
  assert(r.m.clipping.samples > r.m.clipping.runs * 10);
  assert(r.verdict.flags.some((f) => f.code === 'clip' && f.kind === 'err'));
  const clean = await inspect(G.writeWav(file('clean.wav'), [G.sine(n, 44100, 440, 0.98), G.sine(n, 44100, 440, 0.98)], 44100, 16));
  assert.strictEqual(clean.m.clipping.runs, 0); assert(!clean.verdict.flags.some((f) => f.code === 'clip'));
  near(clean.m.samplePeakDb, 20 * Math.log10(0.98), 0.05, 'peak');
});

test('DC offset, mono in stereo and silence at the start and end are measured and reported', async () => {
  const n = 44100 * 4;
  const off = (x, d) => x.map((v) => v + d);
  const dc = await inspect(G.writeWav(file('dc.wav'), [off(G.white(n, 0.1, 71), 0.05), off(G.white(n, 0.1, 72), -0.01)], 44100, 16));
  near(dc.m.dcOffset[0], 0.05, 0.002, 'left'); near(dc.m.dcOffset[1], -0.01, 0.002, 'right');
  assert(dc.verdict.flags.some((f) => f.code === 'dc' && /\+5\.0\d%/.test(f.text)), JSON.stringify(dc.verdict.flags));
  const x = G.white(n, 0.2, 73);
  const mono = await inspect(G.writeWav(file('mono in stereo.wav'), [x, x.slice()], 44100, 16));
  assert(mono.m.mono.identical); assert(mono.verdict.flags.some((f) => f.code === 'mono' && /identical/.test(f.text)));
  const y = x.map((v, i) => v + (i % 7 === 0 ? 0.00005 : 0));
  const almost = await inspect(G.writeWav(file('almost mono.wav'), [x, y], 44100, 16));
  assert(!almost.m.mono.identical && almost.verdict.flags.some((f) => /Practically mono/.test(f.text)));
  const pad = new Float32Array(44100 * 9); pad.set(G.white(44100 * 3, 0.2, 74), Math.round(44100 * 2.5));
  const s = await inspect(G.writeWav(file('padded silence.wav'), [pad, pad.slice()], 44100, 16));
  near(s.m.silence.start, 2.5, 0.01, 'start'); near(s.m.silence.end, 3.5, 0.01, 'end');
  assert(s.verdict.flags.filter((f) => f.code === 'silence').length === 2);
});

test('numbers of a real file: peaks, loudness (vs ffmpeg), DR, bitrates, duration and every fact line are filled in', async () => {
  const m = material();
  const r = await inspect(m.real);
  const ref = ebur128(m.real);
  near(r.m.integrated, ref.I, 0.3, 'integrated'); near(r.m.truePeakDb, ref.TP, 0.3, 'true peak'); near(r.m.samplePeakDb, ref.SP, 0.15, 'sample peak');
  near(r.m.seconds, SEC, 0.01); assert.strictEqual(r.info.sampleRate, 44100); assert.strictEqual(r.m.channels, 2);
  // this noise peaks at 3.46x its RMS (10.8 dB); DR counts the RMS of a sine as its peak (+3 dB), so DR 7-8
  assert(r.m.dr >= 7 && r.m.dr <= 8, 'DR ' + r.m.dr);
  assert(r.info.actualBitrate > 600 && r.info.actualBitrate < 1500, 'actual bitrate ' + r.info.actualBitrate);
  const facts = R.facts(r);
  assert.strictEqual(facts.length, 22);
  for (const [k, v] of facts) assert(v && v !== 'undefined' && !/NaN/.test(v), `${k}: ${v}`);
  assert.deepStrictEqual(facts.find(([k]) => k === 'Bit depth'), ['Bit depth', '16-bit']);
  assert(/^-\d+\.\d LUFS$/.test(facts.find(([k]) => k === 'Loudness')[1]));
  assert.strictEqual(r.m.spectrogram.rows, A.SPEC_ROWS); assert(Math.abs(r.m.spectrogram.cols - (SEC * 44100) / 4096) <= 1.5 && r.m.spectrogram.data.length === r.m.spectrogram.cols * r.m.spectrogram.rows);
});

// ---- errors, cancelling, the pool -------------------------------------------------------------------------------------------------
test('errors: a file that is not audio and a damaged file give plain words; cancelling stops at once', async () => {
  const junk = file('junk.flac'); fs.writeFileSync(junk, Buffer.alloc(5000, 3));
  await assert.rejects(A.analyseFile(ff, junk), (e) => e instanceof P.UserError);
  const m = material();
  const cut = file('cut short.flac'); const b = fs.readFileSync(m.real); fs.writeFileSync(cut, b.subarray(0, Math.floor(b.length / 2)));
  const r = await inspect(cut);
  assert(r.m.seconds > 2 && r.m.seconds < SEC, 'the part that is there is measured');
  const ac = new AbortController();
  const p = A.analyseFile(ff, m.real, { signal: ac.signal });
  setTimeout(() => ac.abort(), 30);
  await assert.rejects(p, (e) => e.cancelled === true);
});

test('pool: several files at once in worker threads, results as in the main thread; cancel rejects the rest; the pool is reusable', async () => {
  const m = material();
  const pool = new Pool({ size: 2 });
  const files = [m.fake, m.real, m.mp3, m.pink];
  const t0 = Date.now();
  const res = await Promise.all(files.map((f) => pool.run(f)));
  assert.deepStrictEqual(res.map((r) => r.verdict.kind), ['fake', 'real', 'lossy', 'real']);
  assert(res[0].m.spectrogram.data instanceof Uint8Array && res[0].m.spectrum.db instanceof Float32Array, 'typed arrays come back from the worker');
  const many = Array.from({ length: 6 }, () => pool.run(m.real).then(() => 'done', (e) => (e.cancelled ? 'cancelled' : 'error')));
  setTimeout(() => pool.cancel(), 20);
  const out = await Promise.all(many);
  assert(out.includes('cancelled') && !out.includes('error'), JSON.stringify(out));
  assert.strictEqual((await pool.run(m.fake)).verdict.kind, 'fake', 'works after a cancel');
  await assert.rejects(pool.run(junkFile()), /could not|no sound/i);
  pool.close();
  console.log(`     (4 files in ${Date.now() - t0} ms with 2 workers)`);
});
function junkFile() { const f = file('junk2.wav'); fs.writeFileSync(f, Buffer.from('RIFF....WAVEjunk')); return f; }

// ---- reports -------------------------------------------------------------------------------------------------------------------------
test('report: the CSV has one row per file, quotes what needs quoting, defuses formulas, and the text report reads well', async () => {
  const m = material();
  const rows = [
    { name: 'Fake Album – Track 01.flac', folder: tmp, result: await inspect(m.fake) },
    { name: '=HYPERLINK("x"), "quoted"; ünïcödé.flac', folder: 'C:\\Music', result: await inspect(m.real) },
    { name: 'broken.mp3', folder: 'x', error: 'This file has no sound that could be read' },
  ];
  const csv = R.csv(rows);
  const lines = csv.trim().split('\r\n');
  assert.strictEqual(lines.length, 4);
  assert(lines[0].startsWith('File,Folder,Verdict,Explanation,Format,Sample rate (Hz)'));
  assert(lines[1].startsWith('Fake Album – Track 01.flac,') && lines[1].includes(',Fake lossless,'));
  assert(lines[2].startsWith('"\'=HYPERLINK(""x""), ""quoted""; ünïcödé.flac"'), 'formula defused and quotes doubled: ' + lines[2].slice(0, 60));
  assert(lines[3].includes('Could not inspect'));
  const txt = R.text(rows, new Date('2026-01-02T03:04:00Z'));
  assert(txt.includes('3 files: 1 real lossless, 1 fake lossless, 0 upsampled, 0 can\'t tell, 0 lossy, 1 could not be inspected'), txt.slice(0, 300));
  assert(/Verdict +Fake lossless file/.test(txt) && /Why +This FLAC was probably made from a lossy file/.test(txt));
  assert(txt.includes('Could not inspect: This file has no sound'));
  assert.strictEqual(R.dB(-Infinity), '−∞ dBFS'); assert.strictEqual(R.dB(0.04, 'dBTP'), '+0.0 dBTP'); assert.strictEqual(R.duration(3725), '1:02:05'); assert.strictEqual(R.size(1536), '1.5 KB');
});

test('the inspected files were never changed (every file hashed before and after)', () => {
  assert(hashes.size >= 25, 'many files were checked: ' + hashes.size);
  for (const [f, h] of hashes) assert.strictEqual(md5(f), h, 'changed: ' + f);
});

test('ui: the window code has no remote content and a strict content security policy', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'index.html'), 'utf8');
  assert(/default-src 'none'/.test(html) && /script-src 'self'/.test(html));
  assert(!/https?:\/\//.test(html.replace(/<meta[^>]*Content-Security-Policy[^>]*>/, '')));
  const js = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'app.js'), 'utf8');
  assert(!/https?:\/\/|eval\(|new Function/.test(js));
});

(async () => {
  let failed = 0;
  for (const [name, fn] of tests) {
    if (process.env.ONLY && !new RegExp(process.env.ONLY, 'i').test(name)) continue;
    const t0 = Date.now();
    try { await fn(); console.log(`ok   ${name} (${Date.now() - t0} ms)`); }
    catch (e) { failed++; console.log(`FAIL ${name}\n     ${String((e && e.stack) || e).split('\n').slice(0, 6).join('\n     ')}`); }
  }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  console.log(failed ? `\n${failed} of ${tests.length} failed` : `\nall ${tests.length} passed`);
  process.exit(failed ? 1 : 0);
})();
