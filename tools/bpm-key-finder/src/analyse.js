'use strict';
// Tempo and key detection in plain JavaScript (no native code, no models). Electron-free, so Node tests can run it.
//
//   Tempo: spectral flux of a log-mel spectrogram -> onset strength -> autocorrelation read at the multiples of each
//          candidate beat period (a "comb"), weighted by a mild preference for everyday tempos -> refined by sliding a
//          beat grid over the whole song and keeping the speed and phase that line up best.
//   Key:   spectral peaks -> 12 pitch classes (after estimating how far the recording is tuned from A = 440 Hz) ->
//          compared with the Krumhansl-Kessler and Temperley major/minor profiles in all 12 transpositions.
//
// Honest limits: a constant-tempo song comes out right to a fraction of a BPM, but half/double confusions (70 vs 140) can
// happen, songs with a drifting tempo get only an average, and key detection is a statistical guess (the relative
// major/minor and the neighbouring key on the circle of fifths are the usual mistakes).
const { spawn } = require('child_process');

const RATE = 22050;          // analysis sample rate (mono)
const MAX_SECONDS = 480;     // longer songs are analysed from the middle
const MIN_SECONDS = 8;
const BPM_MIN = 40;
const BPM_MAX = 240;

class AnalyseError extends Error {}

// ---- FFT ---------------------------------------------------------------------------------------------------------------
function makeFft(n) {
  const bits = Math.round(Math.log2(n));
  if (1 << bits !== n) throw new Error('FFT size must be a power of two');
  const rev = new Uint32Array(n);
  for (let i = 0; i < n; i++) { let r = 0; for (let b = 0; b < bits; b++) if (i & (1 << b)) r |= 1 << (bits - 1 - b); rev[i] = r; }
  const cos = new Float64Array(n / 2);
  const sin = new Float64Array(n / 2);
  for (let i = 0; i < n / 2; i++) { cos[i] = Math.cos((2 * Math.PI * i) / n); sin[i] = -Math.sin((2 * Math.PI * i) / n); }
  return function fft(re, im) {
    for (let i = 0; i < n; i++) { const j = rev[i]; if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1;
      const step = n / size;
      for (let start = 0; start < n; start += size) {
        for (let k = 0, w = 0; k < half; k++, w += step) {
          const a = start + k;
          const b = a + half;
          const tr = re[b] * cos[w] - im[b] * sin[w];
          const ti = re[b] * sin[w] + im[b] * cos[w];
          re[b] = re[a] - tr; im[b] = im[a] - ti;
          re[a] += tr; im[a] += ti;
        }
      }
    }
  };
}

const hann = (n) => { const w = new Float64Array(n); for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n); return w; };
const clamp01 = (x) => Math.max(0, Math.min(1, x));

// ---- tempo -------------------------------------------------------------------------------------------------------------
const ONSET_N = 1024;
const ONSET_HOP = 256;
const FPS = RATE / ONSET_HOP;

const hzToMel = (f) => 2595 * Math.log10(1 + f / 700);
const melToHz = (m) => 700 * (10 ** (m / 2595) - 1);

/** Triangular mel filters as sparse [bin, weight] lists. */
function melBands(count, fmin, fmax, n, rate) {
  const edges = [];
  for (let i = 0; i < count + 2; i++) edges.push(melToHz(hzToMel(fmin) + ((hzToMel(fmax) - hzToMel(fmin)) * i) / (count + 1)));
  const df = rate / n;
  const bands = [];
  for (let b = 0; b < count; b++) {
    const lo = edges[b]; const mid = edges[b + 1]; const hi = edges[b + 2];
    const bins = [];
    for (let k = Math.ceil(lo / df); k * df < hi && k < n / 2; k++) {
      const f = k * df;
      const w = f <= mid ? (f - lo) / (mid - lo) : (hi - f) / (hi - mid);
      if (w > 0) bins.push([k, w]);
    }
    if (!bins.length) bins.push([Math.min(n / 2 - 1, Math.round(mid / df)), 1]);
    const norm = bins.reduce((s, [, w]) => s + w, 0);
    bands.push(bins.map(([k, w]) => [k, w / norm]));
  }
  return bands;
}

/** Onset strength per frame (86 frames a second): how much new sound arrives, summed over mel bands. */
function onsetEnvelope(x) {
  const frames = Math.floor((x.length - ONSET_N) / ONSET_HOP) + 1;
  if (frames < 64) throw new AnalyseError('This song is too short to analyse');
  const fft = makeFft(ONSET_N);
  const win = hann(ONSET_N);
  const bands = melBands(32, 30, 9000, ONSET_N, RATE);
  const re = new Float64Array(ONSET_N);
  const im = new Float64Array(ONSET_N);
  const mag = new Float64Array(ONSET_N / 2);
  let prev = new Float64Array(bands.length);
  const cur = new Float64Array(bands.length);
  const flux = new Float64Array(frames);
  for (let f = 0; f < frames; f++) {
    const at = f * ONSET_HOP;
    for (let i = 0; i < ONSET_N; i++) { re[i] = x[at + i] * win[i]; im[i] = 0; }
    fft(re, im);
    for (let k = 0; k < ONSET_N / 2; k++) mag[k] = Math.hypot(re[k], im[k]) / (ONSET_N / 4);
    let sum = 0;
    for (let b = 0; b < bands.length; b++) {
      let m = 0;
      for (const [k, w] of bands[b]) m += mag[k] * w;
      cur[b] = Math.log1p(1000 * m);
      if (f > 0) sum += Math.max(0, cur[b] - prev[b]);
    }
    flux[f] = sum / bands.length;
    prev = Float64Array.from(cur);
  }
  // remove the slow trend, keep only the peaks above it
  const env = new Float64Array(frames);
  const half = Math.round(0.2 * FPS);
  let run = 0; let lo = 0; let hi = -1;
  for (let i = 0; i < frames; i++) {
    while (hi < Math.min(frames - 1, i + half)) { hi++; run += flux[hi]; }
    while (lo < i - half) { run -= flux[lo]; lo++; }
    env[i] = Math.max(0, flux[i] - run / (hi - lo + 1));
  }
  return env;
}

const lerpAt = (a, t) => {
  if (t < 0 || t >= a.length - 1) return 0;
  const i = Math.floor(t);
  const f = t - i;
  return a[i] * (1 - f) + a[i + 1] * f;
};

/** Normalised autocorrelation of the onset envelope for lags 0..maxLag. */
function autocorr(env, maxLag) {
  const n = env.length;
  let energy = 0;
  for (let i = 0; i < n; i++) energy += env[i] * env[i];
  const r = new Float64Array(maxLag + 1);
  if (energy === 0) return r;
  for (let lag = 0; lag <= maxLag; lag++) {
    let s = 0;
    for (let i = 0; i + lag < n; i++) s += env[i] * env[i + lag];
    r[lag] = (s / energy) * (n / (n - lag)); // unbiased: longer lags have fewer terms
  }
  return r;
}

// When a tempo and its double fit the music about equally well, prefer the one nearer 128 BPM. Measured on invented songs this
// gets everything from 84 to 178 BPM right; slower songs (72, 78) are listed at double speed, as DJs do.
const PRIOR_CENTER = 128;
const PRIOR_SIGMA = 0.8; // octaves
const prior = (bpm) => Math.exp(-0.5 * (Math.log2(bpm / PRIOR_CENTER) / PRIOR_SIGMA) ** 2);

/** @returns {{bpm:number, confidence:number, strength:number}} */
function estimateTempo(env) {
  const maxLag = Math.ceil((FPS * 60 * 4) / BPM_MIN) + 2;
  const r = autocorr(env, maxLag);
  const comb = (bpm) => {
    const lag = (FPS * 60) / bpm;
    let s = 0;
    for (let k = 1; k <= 4; k++) { const L = lag * k; if (L < maxLag) s += lerpAt(r, L) / k; }
    return s;
  };
  // coarse sweep, log-spaced so every tempo gets the same relative resolution
  let best = { bpm: 0, score: -Infinity, raw: 0 };
  for (let bpm = BPM_MIN; bpm <= BPM_MAX; bpm *= 1.004) {
    const raw = comb(bpm);
    const score = raw * prior(bpm);
    if (score > best.score) best = { bpm, score, raw };
  }
  // refine on the song itself: slide a beat grid across the whole envelope
  const smooth = new Float64Array(env.length);
  for (let i = 0; i < env.length; i++) smooth[i] = (env[Math.max(0, i - 1)] + 2 * env[i] + env[Math.min(env.length - 1, i + 1)]) / 4;
  const align = (bpm) => {
    const period = (FPS * 60) / bpm;
    let top = -1; let phaseAt = 0;
    const steps = Math.max(8, Math.round(period));
    for (let p = 0; p < steps; p++) {
      const phase = (p * period) / steps;
      let s = 0; let count = 0;
      for (let t = phase; t < smooth.length - 1; t += period) { s += lerpAt(smooth, t); count++; }
      s /= Math.max(1, count);
      if (s > top) { top = s; phaseAt = phase; }
    }
    return { score: top, phase: phaseAt };
  };
  let bpm = best.bpm;
  let a = align(bpm);
  for (const [span, step] of [[0.03, 0.001], [0.004, 0.0001]]) { // +-3% in 0.1% steps, then +-0.4% in 0.01% steps
    const centre = bpm;
    for (let m = -span; m <= span + 1e-12; m += step) {
      const b = centre * (1 + m);
      const t = align(b);
      if (t.score > a.score) { a = t; bpm = b; }
    }
  }
  // Fold into 70..190 BPM, where music is counted in practice (a 62 BPM ballad is listed as 124, as DJs do; the user can
  // undo it with / 2). Half and double are often equally good answers, so the app offers the other one in one click.
  let folded = 1;
  while (bpm < 70) { bpm *= 2; folded *= 2; }
  while (bpm >= 190) { bpm /= 2; folded /= 2; }
  if (folded !== 1) a = align(bpm);

  // how well do beats line up compared with the average moment? and how clearly did this tempo win?
  let mean = 0;
  for (let i = 0; i < smooth.length; i++) mean += smooth[i];
  mean /= smooth.length;
  const lift = mean > 0 ? a.score / mean : 0;               // 1 = no better than a random grid
  // 'lift' is how much stronger the onsets are on the beat grid than anywhere else. Measured on invented songs: steady music
  // 10-15, a tempo that drifts 120->130 about 4, noise or a held chord about 1.3. Confidence runs from lift 1.5 (none) to 7.5 (full).
  const confidence = clamp01((lift - 1.5) / 6);
  return { bpm, confidence, lift, phase: a.phase / FPS, folded };
}

// ---- key ---------------------------------------------------------------------------------------------------------------
const KEY_N = 8192;
const KEY_HOP = 4096;
const KK_MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const KK_MINOR = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
const TP_MAJOR = [5.0, 2.0, 3.5, 2.0, 4.5, 4.0, 2.0, 4.5, 2.0, 3.5, 1.5, 4.0];
const TP_MINOR = [5.0, 2.0, 3.5, 4.5, 2.0, 4.0, 2.0, 4.5, 3.5, 2.0, 1.5, 4.0];

function pearson(a, b) {
  let ma = 0; let mb = 0;
  for (let i = 0; i < 12; i++) { ma += a[i]; mb += b[i]; }
  ma /= 12; mb /= 12;
  let num = 0; let da = 0; let db = 0;
  for (let i = 0; i < 12; i++) { const x = a[i] - ma; const y = b[i] - mb; num += x * y; da += x * x; db += y * y; }
  return da > 0 && db > 0 ? num / Math.sqrt(da * db) : 0;
}

/** Peaks of every frame as { semitone (relative to A4, fractional), weight, frame }. */
function spectralPeaks(x) {
  const frames = Math.floor((x.length - KEY_N) / KEY_HOP) + 1;
  if (frames < 4) throw new AnalyseError('This song is too short to analyse');
  const fft = makeFft(KEY_N);
  const win = hann(KEY_N);
  const re = new Float64Array(KEY_N);
  const im = new Float64Array(KEY_N);
  const mag = new Float64Array(KEY_N / 2);
  const df = RATE / KEY_N;
  const kLo = Math.ceil(65 / df);
  const kHi = Math.floor(2100 / df);
  const out = { semi: [], weight: [], frame: [] };
  for (let f = 0; f < frames; f++) {
    const at = f * KEY_HOP;
    for (let i = 0; i < KEY_N; i++) { re[i] = x[at + i] * win[i]; im[i] = 0; }
    fft(re, im);
    let top = 0;
    for (let k = kLo - 1; k <= kHi + 1; k++) { mag[k] = Math.hypot(re[k], im[k]); if (mag[k] > top) top = mag[k]; }
    if (top < 1e-3) continue; // silence
    const floor = top * 0.06;
    for (let k = kLo; k <= kHi; k++) {
      const m = mag[k];
      if (m > floor && m > mag[k - 1] && m >= mag[k + 1]) {
        const a = mag[k - 1]; const c = mag[k + 1];
        const denom = a - 2 * m + c;
        const delta = denom !== 0 ? (0.5 * (a - c)) / denom : 0; // parabolic peak position
        const freq = (k + delta) * df;
        out.semi.push(12 * Math.log2(freq / 440));
        out.weight.push(Math.sqrt(m / top));
        out.frame.push(f);
      }
    }
  }
  out.frames = frames;
  return out;
}

const NOTE_SHARP = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

function estimateKey(x) {
  const p = spectralPeaks(x);
  if (p.semi.length < 50) return { key: null, confidence: 0, tuningCents: 0, alternatives: [] };
  // how far from A = 440 Hz is the recording tuned? (circular mean of the fractional semitone, weighted)
  let c = 0; let s = 0;
  for (let i = 0; i < p.semi.length; i++) { const a = 2 * Math.PI * p.semi[i]; c += p.weight[i] * Math.cos(a); s += p.weight[i] * Math.sin(a); }
  const tuning = Math.atan2(s, c) / (2 * Math.PI); // semitones, -0.5..0.5
  const chroma = new Float64Array(12);
  let frameSum = new Float64Array(12);
  let lastFrame = -1;
  const flush = () => {
    let tot = 0;
    for (let i = 0; i < 12; i++) tot += frameSum[i];
    if (tot > 0) for (let i = 0; i < 12; i++) chroma[i] += frameSum[i] / tot; // every frame counts the same, loud or quiet
    frameSum = new Float64Array(12);
  };
  for (let i = 0; i < p.semi.length; i++) {
    if (p.frame[i] !== lastFrame) { if (lastFrame >= 0) flush(); lastFrame = p.frame[i]; }
    const pc = ((Math.round(p.semi[i] - tuning) % 12) + 12 + 9) % 12; // A is 9 semitones above C
    frameSum[pc] += p.weight[i];
  }
  flush();

  const scored = [];
  for (let tonic = 0; tonic < 12; tonic++) {
    for (const mode of ['major', 'minor']) {
      const kk = mode === 'major' ? KK_MAJOR : KK_MINOR;
      const tp = mode === 'major' ? TP_MAJOR : TP_MINOR;
      const rotKk = new Array(12); const rotTp = new Array(12);
      for (let i = 0; i < 12; i++) { rotKk[(i + tonic) % 12] = kk[i]; rotTp[(i + tonic) % 12] = tp[i]; }
      scored.push({ tonic, mode, score: (pearson(chroma, rotKk) + pearson(chroma, rotTp)) / 2 });
    }
  }
  scored.sort((a, b) => b.score - a.score);
  const [best, second] = scored;
  const margin = best.score - second.score;
  const confidence = clamp01(0.6 * clamp01((best.score - 0.45) / 0.4) + 0.4 * clamp01(margin / 0.12));
  return {
    key: { tonic: best.tonic, mode: best.mode, name: NOTE_SHARP[best.tonic] + (best.mode === 'minor' ? 'm' : '') },
    score: best.score, margin, confidence, tuningCents: Math.round(tuning * 100),
    alternatives: scored.slice(1, 4).map((k) => ({ tonic: k.tonic, mode: k.mode, score: k.score })),
    chroma: Array.from(chroma, (v) => v / Math.max(1e-9, Math.max(...chroma))),
  };
}

// ---- putting it together ------------------------------------------------------------------------------------------------
/** @param {Float32Array|Float64Array} samples mono at RATE */
function analysePcm(samples) {
  if (samples.length < MIN_SECONDS * RATE) throw new AnalyseError('This song is too short to analyse (under ' + MIN_SECONDS + ' seconds)');
  let peak = 0;
  for (let i = 0; i < samples.length; i++) { const v = Math.abs(samples[i]); if (v > peak) peak = v; }
  if (peak < 1e-4) throw new AnalyseError('This song is silent');
  const env = onsetEnvelope(samples);
  const tempo = estimateTempo(env);
  const key = estimateKey(samples);
  return {
    seconds: samples.length / RATE,
    bpm: Math.round(tempo.bpm * 100) / 100, bpmConfidence: tempo.confidence, firstBeat: tempo.phase,
    key: key.key, keyConfidence: key.confidence, keyScore: key.score || 0, keyAlternatives: key.alternatives, tuningCents: key.tuningCents,
  };
}

// ---- decoding -------------------------------------------------------------------------------------------------------------
/** Decode any audio file to mono float samples at RATE with ffmpeg. `start` and `seconds` pick a slice. */
function decode(ffmpeg, file, { start = 0, seconds = MAX_SECONDS, signal } = {}) {
  return new Promise((resolve, reject) => {
    const args = ['-hide_banner', '-v', 'error', ...(start > 0 ? ['-ss', String(start)] : []), '-t', String(seconds), '-i', file, '-vn', '-ac', '1', '-ar', String(RATE), '-f', 'f32le', '-'];
    const child = spawn(ffmpeg, args, { windowsHide: true });
    const chunks = []; let errText = '';
    child.stdout.on('data', (d) => chunks.push(d));
    child.stderr.on('data', (d) => { if (errText.length < 2000) errText += d; });
    const onAbort = () => { child.kill(); reject(Object.assign(new Error('Cancelled'), { cancelled: true })); };
    if (signal) { if (signal.aborted) return onAbort(); signal.addEventListener('abort', onAbort, { once: true }); }
    child.on('error', (e) => reject(new AnalyseError('Could not start ffmpeg: ' + e.message)));
    child.on('close', (code) => {
      if (signal) signal.removeEventListener('abort', onAbort);
      const buf = Buffer.concat(chunks);
      if (code !== 0 || buf.length < 4) {
        const why = errText.trim().split('\n').pop().slice(0, 90);
        return reject(new AnalyseError('This file could not be read as audio' + (why ? ` (${why})` : '')));
      }
      const out = new Float32Array(Math.floor(buf.length / 4));
      for (let i = 0; i < out.length; i++) out[i] = buf.readFloatLE(i * 4);
      resolve(out);
    });
  });
}

/** Decode and analyse one file. `duration` (seconds, if known) lets a very long song be read from its middle. */
async function analyseFile(ffmpeg, file, { duration = 0, signal } = {}) {
  const start = duration > MAX_SECONDS ? Math.floor((duration - MAX_SECONDS) / 2) : 0;
  const samples = await decode(ffmpeg, file, { start, seconds: MAX_SECONDS, signal });
  const r = analysePcm(samples);
  r.analysedFrom = start;
  return r;
}

module.exports = { RATE, MAX_SECONDS, MIN_SECONDS, BPM_MIN, BPM_MAX, AnalyseError, makeFft, onsetEnvelope, estimateTempo, estimateKey, analysePcm, decode, analyseFile, NOTE_SHARP };
