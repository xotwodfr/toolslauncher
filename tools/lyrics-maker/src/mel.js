'use strict';
// Whisper's audio front end in plain JavaScript: 16 kHz mono audio -> an 80 x 3000 log-mel "picture" of a 30 second window.
// It follows the definition Whisper was trained with (OpenAI's audio.py / Hugging Face's WhisperFeatureExtractor):
//   400-sample periodic Hann window, hop 160, centred frames with reflect padding, power spectrum of the first 3000 frames,
//   80 mel filters on the Slaney scale (librosa's default, area-normalised), log10 with a floor, clamped to 8 below the loudest
//   value, then (x + 4) / 4.
// Any mistake here would not crash anything, it would just make the transcript worse, so the tests check each piece.
const SAMPLE_RATE = 16000;
const N_FFT = 400;
const HOP = 160;
const N_MELS = 80;
const CHUNK_SECONDS = 30;
const N_SAMPLES = SAMPLE_RATE * CHUNK_SECONDS;      // 480000
const N_FRAMES = N_SAMPLES / HOP;                   // 3000
const N_BINS = N_FFT / 2 + 1;                       // 201

// Slaney mel scale: linear below 1 kHz, logarithmic above
const F_SP = 200 / 3;
const MIN_LOG_HZ = 1000;
const MIN_LOG_MEL = MIN_LOG_HZ / F_SP;
const LOG_STEP = Math.log(6.4) / 27;
const hzToMel = (f) => (f >= MIN_LOG_HZ ? MIN_LOG_MEL + Math.log(f / MIN_LOG_HZ) / LOG_STEP : f / F_SP);
const melToHz = (m) => (m >= MIN_LOG_MEL ? MIN_LOG_HZ * Math.exp(LOG_STEP * (m - MIN_LOG_MEL)) : m * F_SP);

const caches = new Map();
/** The filter bank and FFT tables for `nMels` bands (80 for Whisper small, 128 for large-v3). */
function tables(nMels = N_MELS) {
  if (caches.has(nMels)) return caches.get(nMels);
  // triangular filters, area-normalised, as sparse [first bin, weights[]] per mel band
  const edges = new Float64Array(nMels + 2);
  const mMax = hzToMel(SAMPLE_RATE / 2);
  for (let i = 0; i < nMels + 2; i++) edges[i] = melToHz((mMax * i) / (nMels + 1));
  const fft = new Float64Array(N_BINS);
  for (let i = 0; i < N_BINS; i++) fft[i] = (i * SAMPLE_RATE) / N_FFT;
  const bands = [];
  for (let m = 0; m < nMels; m++) {
    const lo = edges[m]; const mid = edges[m + 1]; const hi = edges[m + 2];
    const enorm = 2 / (hi - lo);
    let first = -1; const w = [];
    for (let k = 0; k < N_BINS; k++) {
      const lower = (fft[k] - lo) / (mid - lo);
      const upper = (hi - fft[k]) / (hi - mid);
      const v = Math.max(0, Math.min(lower, upper)) * enorm;
      if (v > 0) { if (first < 0) first = k; w.push(v); }
      else if (first >= 0) break;
    }
    bands.push({ first: Math.max(0, first), w: Float64Array.from(w) });
  }
  const window = new Float64Array(N_FFT);
  for (let n = 0; n < N_FFT; n++) window[n] = 0.5 - 0.5 * Math.cos((2 * Math.PI * n) / N_FFT);
  const cos = new Float64Array(N_BINS * N_FFT);
  const sin = new Float64Array(N_BINS * N_FFT);
  for (let k = 0; k < N_BINS; k++) for (let n = 0; n < N_FFT; n++) { const a = (2 * Math.PI * k * n) / N_FFT; cos[k * N_FFT + n] = Math.cos(a); sin[k * N_FFT + n] = Math.sin(a); }
  const t = { bands, window, cos, sin, edges };
  caches.set(nMels, t);
  return t;
}

/**
 * The log-mel input for the 30 second window of `samples` starting at sample `offset` (shorter windows are padded with silence).
 * @param {Float32Array} samples 16 kHz mono
 * @param {number} [nMels] 80 (Whisper small) or 128 (large-v3)
 * @returns {Float32Array} nMels * 3000, band by band
 */
function logMel(samples, offset = 0, nMels = N_MELS) {
  const { bands, window, cos, sin } = tables(nMels);
  const pad = N_FFT / 2;
  // the 30 second window, silence-padded, then reflect-padded by 200 samples each side (what centre=True does)
  const win = new Float32Array(N_SAMPLES);
  const avail = Math.max(0, Math.min(N_SAMPLES, samples.length - offset));
  if (avail) win.set(samples.subarray(offset, offset + avail));
  const padded = new Float32Array(N_SAMPLES + 2 * pad);
  padded.set(win, pad);
  for (let i = 0; i < pad; i++) { padded[pad - 1 - i] = win[i + 1]; padded[pad + N_SAMPLES + i] = win[N_SAMPLES - 2 - i]; }
  const mel = new Float32Array(nMels * N_FRAMES);
  const power = new Float64Array(N_BINS);
  const frame = new Float64Array(N_FFT);
  let top = -Infinity;
  for (let t = 0; t < N_FRAMES; t++) {
    const at = t * HOP;
    for (let n = 0; n < N_FFT; n++) frame[n] = padded[at + n] * window[n];
    for (let k = 0; k < N_BINS; k++) {
      let re = 0; let im = 0;
      const row = k * N_FFT;
      for (let n = 0; n < N_FFT; n++) { const v = frame[n]; re += v * cos[row + n]; im -= v * sin[row + n]; }
      power[k] = re * re + im * im;
    }
    for (let m = 0; m < nMels; m++) {
      const b = bands[m];
      let s = 0;
      for (let j = 0; j < b.w.length; j++) s += b.w[j] * power[b.first + j];
      const v = Math.log10(Math.max(s, 1e-10));
      mel[m * N_FRAMES + t] = v;
      if (v > top) top = v;
    }
  }
  const floor = top - 8;
  for (let i = 0; i < mel.length; i++) mel[i] = (Math.max(mel[i], floor) + 4) / 4;
  return mel;
}

module.exports = { SAMPLE_RATE, N_FFT, HOP, N_MELS, CHUNK_SECONDS, N_SAMPLES, N_FRAMES, N_BINS, hzToMel, melToHz, tables, logMel };
