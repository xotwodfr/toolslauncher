'use strict';
// The measuring: the whole file is decoded by ffmpeg into raw samples and streamed through one pass that works out
// everything at once, so even a long hi-res file never has to fit in memory:
//   - the averaged spectrum (own FFT, Hann window) for the cutoff / fake-lossless verdict, and a spectrogram picture
//   - sample and true peak, integrated loudness and loudness range (loudness.js), the DR value, clipping, DC offset,
//     mono-in-stereo, silence at the start and end, and the bits really used (from the integer samples).
// Electron-free; runs in a worker thread (worker.js), one file per worker.
const { spawn } = require('child_process');
const { LoudnessMeter } = require('./loudness');
const P = require('./probe');
const V = require('./verdict');

const cancelled = () => Object.assign(new Error('Cancelled'), { cancelled: true });

// ---- FFT ----------------------------------------------------------------------------------------------------------------------
/** In-place radix-2 complex FFT of size n (a power of two). */
function makeFft(n) {
  const levels = Math.log2(n);
  if (!Number.isInteger(levels)) throw new Error('FFT size must be a power of two');
  const rev = new Uint32Array(n);
  for (let i = 0; i < n; i++) { let r = 0; for (let b = 0, x = i; b < levels; b++, x >>= 1) r = (r << 1) | (x & 1); rev[i] = r; }
  const cos = new Float64Array(n / 2); const sin = new Float64Array(n / 2);
  for (let i = 0; i < n / 2; i++) { cos[i] = Math.cos((2 * Math.PI * i) / n); sin[i] = Math.sin((2 * Math.PI * i) / n); }
  return function fft(re, im) {
    for (let i = 0; i < n; i++) { const j = rev[i]; if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1; const step = n / size;
      for (let i = 0; i < n; i += size) {
        for (let j = i, k = 0; j < i + half; j++, k += step) {
          const l = j + half;
          const tre = re[l] * cos[k] + im[l] * sin[k];
          const tim = -re[l] * sin[k] + im[l] * cos[k];
          re[l] = re[j] - tre; im[l] = im[j] - tim;
          re[j] += tre; im[j] += tim;
        }
      }
    }
  };
}

/** FFT size for a sample rate: about 10 Hz per bin. */
const fftSizeFor = (fs) => (fs <= 50000 ? 4096 : fs <= 100000 ? 8192 : 16384);

const SPEC_COLS = 720;
const SPEC_ROWS = 256;
const SILENCE = 0.001;             // -60 dBFS: quieter than this counts as silence at the start and end

class Analyser {
  /**
   * @param {{ sampleRate: number, channels: number, bits: number|null, float: boolean, duration: number }} o
   *   bits: the declared bit depth of integer samples (samples arrive as 32-bit integers), null for float samples
   */
  constructor({ sampleRate, channels, bits, float, duration }) {
    this.fs = sampleRate; this.C = Math.max(1, channels); this.bits = bits; this.isFloat = !!float || !bits;
    this.N = fftSizeFor(sampleRate);
    this.fft = makeFft(this.N);
    this.win = new Float64Array(this.N);
    let wsum = 0;
    for (let i = 0; i < this.N; i++) { this.win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / this.N); wsum += this.win[i]; }
    this.norm = 4 / (wsum * wsum);                 // a full-scale sine reads 0 dB in its bin
    this.bins = this.N / 2 + 1;
    this.re = new Float64Array(this.N); this.im = new Float64Array(this.N);
    this.frame = Array.from({ length: this.C }, () => new Float64Array(this.N));
    this.fpos = 0;
    this.spectrum = new Float64Array(this.bins);  // summed power per bin (mean over channels) over the frames with sound
    this.frames = 0; this.soundFrames = 0;
    // the picture has one column per FFT frame for short files, up to SPEC_COLS (an unknown length is taken as an hour)
    this.expectedFrames = Math.max(1, Math.ceil(((duration > 0 ? duration : 3600) * sampleRate) / this.N));
    this.cols = Math.min(SPEC_COLS, this.expectedFrames);
    this.spec = new Float32Array(this.cols * SPEC_ROWS); this.specN = new Uint16Array(this.cols);
    this.rowOf = new Uint16Array(this.bins);
    for (let k = 0; k < this.bins; k++) this.rowOf[k] = Math.min(SPEC_ROWS - 1, Math.floor((k / (this.bins - 1)) * SPEC_ROWS));
    // sfb21: is the band above 16 kHz switched off and on from frame to frame (what LAME does at lower bitrates)?
    const hz = (f) => Math.round((f / sampleRate) * this.N);
    this.bandA = [hz(12000), hz(15500)]; this.bandB = [hz(16300), hz(19300)];
    this.sfb = { counted: 0, dead: 0, present: 0 };
    // per channel
    const C = this.C;
    this.sum = new Float64Array(C); this.sumSq = new Float64Array(C); this.peak = new Float64Array(C);
    this.run = new Uint32Array(C); this.clipRuns = 0; this.clipSamples = 0; this.fullScale = 0; this.overs = 0;
    this.clipLevel = this.isFloat ? 0.99999 : 1 - Math.pow(2, -(bits - 1)) - 1e-9;
    this.orBits = 0;
    this.diffSq = 0; this.sumLR = 0; this.identical = C === 2;
    this.n = 0; this.firstLoud = -1; this.lastLoud = -1;
    this.drBlock = Math.round(sampleRate * 3); this.drPos = 0;
    this.drSq = new Float64Array(C); this.drPk = new Float64Array(C); this.drBlocks = Array.from({ length: C }, () => []);
    this.meter = new LoudnessMeter(sampleRate, C);
    this.carry = null;
  }

  /** Feed raw bytes from ffmpeg (s32le or f32le, interleaved). Handles pieces that end in the middle of a sample. */
  push(buf) {
    if (this.carry) { buf = Buffer.concat([this.carry, buf]); this.carry = null; }
    const frameBytes = 4 * this.C;
    const usable = buf.length - (buf.length % frameBytes);
    if (usable < buf.length) this.carry = Buffer.from(buf.subarray(usable));
    const frames = usable / frameBytes;
    if (!frames) return;
    const x = new Float32Array(frames * this.C);
    if (this.isFloat) for (let i = 0; i < x.length; i++) x[i] = buf.readFloatLE(i * 4);
    else {
      let or = this.orBits;
      for (let i = 0; i < x.length; i++) { const v = buf.readInt32LE(i * 4); or |= v; x[i] = v / 2147483648; }
      this.orBits = or;
    }
    this.meter.push(x, frames);
    this._stats(x, frames);
  }

  _stats(x, frames) {
    const C = this.C; const lvl = this.clipLevel;
    for (let i = 0; i < frames; i++) {
      let loud = false;
      for (let c = 0; c < C; c++) {
        const v = x[i * C + c];
        const a = v < 0 ? -v : v;
        this.sum[c] += v; this.sumSq[c] += v * v;
        if (a > this.peak[c]) this.peak[c] = a;
        if (a > SILENCE) loud = true;
        if (a >= lvl) { this.fullScale++; this.run[c]++; if (a > 1.00001) this.overs++; }
        else if (this.run[c]) { if (this.run[c] >= 3) { this.clipRuns++; this.clipSamples += this.run[c]; } this.run[c] = 0; }
        this.drSq[c] += v * v; if (a > this.drPk[c]) this.drPk[c] = a;
        this.frame[c][this.fpos] = v;
      }
      if (C === 2) { const l = x[i * 2]; const r = x[i * 2 + 1]; const d = l - r; this.diffSq += d * d; this.sumLR += (l + r) * (l + r); if (d !== 0) this.identical = false; }
      if (loud) { if (this.firstLoud < 0) this.firstLoud = this.n; this.lastLoud = this.n; }
      this.n++;
      if (++this.drPos === this.drBlock) this._drFlush();
      if (++this.fpos === this.N) { this._frame(); this.fpos = 0; }
    }
  }

  _drFlush() {
    for (let c = 0; c < this.C; c++) { this.drBlocks[c].push({ rms: Math.sqrt((2 * this.drSq[c]) / this.drPos), peak: this.drPk[c] }); this.drSq[c] = 0; this.drPk[c] = 0; }
    this.drPos = 0;
  }

  _frame() {
    const N = this.N; const re = this.re; const im = this.im; const w = this.win; const B = this.bins;
    const power = new Float64Array(B);
    let energy = 0;
    for (let c = 0; c < this.C; c += 2) {
      // two channels in one complex FFT (left in the real part, right in the imaginary part), split afterwards
      const a = this.frame[c]; const b = c + 1 < this.C ? this.frame[c + 1] : null;
      for (let i = 0; i < N; i++) { re[i] = a[i] * w[i]; im[i] = b ? b[i] * w[i] : 0; energy += a[i] * a[i] + (b ? b[i] * b[i] : 0); }
      this.fft(re, im);
      for (let k = 0; k < B; k++) {
        const j = (N - k) % N;
        const ar = (re[k] + re[j]) / 2; const ai = (im[k] - im[j]) / 2;      // FFT of the first channel
        power[k] += ar * ar + ai * ai;
        if (b) { const br = (im[k] + im[j]) / 2; const bi = (re[j] - re[k]) / 2; power[k] += br * br + bi * bi; }   // and of the second
      }
    }
    const scale = this.norm / this.C;
    for (let k = 0; k < B; k++) power[k] *= scale;
    const col = Math.min(this.cols - 1, Math.floor((this.frames * this.cols) / this.expectedFrames));
    for (let k = 0; k < B; k++) this.spec[col * SPEC_ROWS + this.rowOf[k]] += power[k] / Math.max(1, Math.ceil(B / SPEC_ROWS));
    this.specN[col]++;
    this.frames++;
    if (energy / (N * this.C) < 1e-12) return;    // digital silence: says nothing about the frequencies
    this.soundFrames++;
    for (let k = 0; k < B; k++) this.spectrum[k] += power[k];
    if (this.bandB[1] < B - 1) {
      let ea = 0; let eb = 0;
      for (let k = this.bandA[0]; k < this.bandA[1]; k++) ea += power[k];
      for (let k = this.bandB[0]; k < this.bandB[1]; k++) eb += power[k];
      ea /= this.bandA[1] - this.bandA[0]; eb /= this.bandB[1] - this.bandB[0];
      if (ea > 1e-10) {          // only frames with clear sound just under 16 kHz can tell
        this.sfb.counted++;
        const r = eb / ea;
        if (r < 1e-4) this.sfb.dead++; else if (r > 0.003) this.sfb.present++;
      }
    }
  }

  /** Everything measured, once the whole file has gone through. */
  finish() {
    if (this.drPos > this.drBlock / 2) this._drFlush();
    for (let c = 0; c < this.C; c++) if (this.run[c] >= 3) { this.clipRuns++; this.clipSamples += this.run[c]; }
    const n = Math.max(1, this.n); const C = this.C;
    const db = (v) => (v > 0 ? 20 * Math.log10(v) : -Infinity);
    const loud = this.meter.result();
    // DR (the "TT DR" way): per channel, the 20% loudest 3 s blocks against the second-highest block peak
    const drs = [];
    for (let c = 0; c < C; c++) {
      const blocks = this.drBlocks[c];
      if (blocks.length < 1) continue;
      const rms = blocks.map((b) => b.rms).sort((a, b) => b - a);
      const top = rms.slice(0, Math.max(1, Math.round(rms.length * 0.2)));
      const r = Math.sqrt(top.reduce((s, v) => s + v * v, 0) / top.length);
      const peaks = blocks.map((b) => b.peak).sort((a, b) => b - a);
      const pk = peaks.length > 1 ? peaks[1] : peaks[0];
      if (r > 0 && pk > 0) drs.push(20 * Math.log10(pk / r));
    }
    // bits really used: the low bits that are zero in every sample were never used
    let effectiveBits = null;
    if (!this.isFloat && this.orBits !== 0) { let tz = 0; let v = this.orBits; while (tz < 32 && (v & 1) === 0) { v >>>= 1; tz++; } effectiveBits = 32 - tz; }
    const spectrumDb = new Float32Array(this.bins);
    for (let k = 0; k < this.bins; k++) spectrumDb[k] = this.soundFrames ? 10 * Math.log10(this.spectrum[k] / this.soundFrames + 1e-30) : -300;
    // the spectrogram as 0..255 = -150..0 dB
    let used = this.cols; while (used > 1 && !this.specN[used - 1]) used--;
    const img = new Uint8Array(used * SPEC_ROWS);
    for (let c = 0; c < used; c++) {
      if (!this.specN[c] && c > 0) { img.copyWithin(c * SPEC_ROWS, (c - 1) * SPEC_ROWS, c * SPEC_ROWS); continue; }   // never a black gap
      const cnt = this.specN[c];
      for (let r = 0; r < SPEC_ROWS; r++) {
        const p = cnt ? this.spec[c * SPEC_ROWS + r] / cnt : 0;
        const d = p > 0 ? 10 * Math.log10(p) : -200;
        img[c * SPEC_ROWS + r] = Math.max(0, Math.min(255, Math.round(((d + 150) / 150) * 255)));
      }
    }
    return {
      samples: this.n, seconds: this.n / this.fs, sampleRate: this.fs, channels: C,
      samplePeak: loud.samplePeak, samplePeakDb: loud.samplePeakDb, truePeakDb: loud.truePeakDb,
      integrated: loud.integrated, lra: loud.lra,
      dr: drs.length ? Math.round(drs.reduce((a, b) => a + b, 0) / drs.length) : null,
      rmsDb: db(Math.sqrt(this.sumSq.reduce((a, b) => a + b, 0) / (n * C))),
      dcOffset: Array.from(this.sum, (s) => s / n),
      clipping: { runs: this.clipRuns, samples: this.clipSamples, fullScale: this.fullScale, overs: this.overs },
      mono: C === 2 ? { identical: this.identical && this.n > 0, sideDb: this.sumLR > 0 ? 10 * Math.log10(this.diffSq / this.sumLR + 1e-30) : -Infinity } : null,
      silence: { start: this.firstLoud < 0 ? this.n / this.fs : this.firstLoud / this.fs, end: this.lastLoud < 0 ? this.n / this.fs : (this.n - 1 - this.lastLoud) / this.fs, all: this.firstLoud < 0 },
      effectiveBits,
      spectrum: { db: spectrumDb, binHz: this.fs / this.N, frames: this.soundFrames },
      sfb21: { ...this.sfb },
      spectrogram: { cols: used, rows: SPEC_ROWS, data: img, minDb: -150, maxDb: 0, nyquist: this.fs / 2 },
    };
  }
}

/**
 * Probe, decode and measure one file. Never writes anything.
 * @returns {Promise<object>} { info (what the file says), m (what was measured), verdict }
 */
async function analyseFile(ffmpeg, file, { signal } = {}) {
  const info = await P.probe(ffmpeg, file);
  const intSamples = info.lossless && !info.float && info.bitsDeclared && info.bitsDeclared <= 32;
  const a = new Analyser({ sampleRate: info.sampleRate, channels: info.channels || 2, bits: intSamples ? info.bitsDeclared : null, float: !intSamples, duration: info.duration });
  const fmt = intSamples ? 's32le' : 'f32le';
  await new Promise((resolve, reject) => {
    const args = ['-hide_banner', '-nostdin', '-v', 'error', '-i', file, '-map', '0:a:0', '-vn', '-sn', '-dn', '-f', fmt, '-acodec', intSamples ? 'pcm_s32le' : 'pcm_f32le', '-'];
    if (info.channels) args.splice(args.indexOf('-f'), 0, '-ac', String(info.channels));
    const child = spawn(ffmpeg, args, { windowsHide: true });
    let err = ''; let failed = null;
    child.stdout.on('data', (d) => { if (failed) return; try { a.push(d); } catch (e) { failed = e; child.kill('SIGKILL'); } });
    child.stderr.on('data', (d) => { if (err.length < 4000) err += d; });
    const onAbort = () => child.kill('SIGKILL');
    if (signal) { if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, { once: true }); }
    child.on('error', (e) => reject(new P.UserError('Could not start ffmpeg: ' + e.message)));
    child.on('close', (code) => {
      if (signal) signal.removeEventListener('abort', onAbort);
      if (signal && signal.aborted) return reject(cancelled());
      if (failed) return reject(failed);
      if (code !== 0 && a.n === 0) return reject(new P.UserError('The sound in this file could not be decoded' + (err.trim() ? ` (${err.trim().split('\n').pop().slice(0, 100)})` : '')));
      if (code !== 0) a.damaged = err.trim().split('\n').pop().slice(0, 140) || 'decoding stopped early';
      resolve();
    });
  });
  const m = a.finish();
  if (a.damaged) m.damaged = a.damaged;
  const verdict = V.verdict(info, m);
  return { info, m, verdict };
}

module.exports = { makeFft, fftSizeFor, Analyser, analyseFile, SPEC_COLS, SPEC_ROWS, cancelled };
