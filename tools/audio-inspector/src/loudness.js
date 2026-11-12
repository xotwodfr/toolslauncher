'use strict';
// Loudness as broadcasters measure it (ITU-R BS.1770-4 / EBU R128), in plain JavaScript, fed block by block:
//   K-weighting (a high shelf and a high pass, worked out for any sample rate the way libebur128 does), 400 ms blocks every
//   100 ms, an absolute gate at -70 LUFS and a relative gate 10 LU under, giving the integrated loudness; 3 s short-term
//   values gated at -70 and -20 LU give the loudness range (LRA, EBU Tech 3342). True peak: the signal is upsampled 4x with a
//   windowed-sinc interpolator and the highest value between samples is found (BS.1770 Annex 2).
// The tests compare every number with ffmpeg's ebur128 filter.

/** Biquad coefficients of the two K-weighting stages for sample rate `fs`. */
function kWeighting(fs) {
  // stage 1: the head's high shelf (+4 dB above ~1.7 kHz)
  let f0 = 1681.974450955533; const G = 3.999843853973347; let Q = 0.7071752369554196;
  let K = Math.tan((Math.PI * f0) / fs);
  const Vh = Math.pow(10, G / 20); const Vb = Math.pow(Vh, 0.4996667741545416);
  let a0 = 1 + K / Q + K * K;
  const shelf = { b0: (Vh + (Vb * K) / Q + K * K) / a0, b1: (2 * (K * K - Vh)) / a0, b2: (Vh - (Vb * K) / Q + K * K) / a0, a1: (2 * (K * K - 1)) / a0, a2: (1 - K / Q + K * K) / a0 };
  // stage 2: a high pass at ~38 Hz
  f0 = 38.13547087602444; Q = 0.5003270373238773;
  K = Math.tan((Math.PI * f0) / fs);
  a0 = 1 + K / Q + K * K;
  const hp = { b0: 1, b1: -2, b2: 1, a1: (2 * (K * K - 1)) / a0, a2: (1 - K / Q + K * K) / a0 };
  return { shelf, hp };
}

/** Weight of each channel in the sum (ffmpeg's default layouts: FL FR FC LFE BL BR ...). */
function channelWeights(n) {
  if (n === 6) return [1, 1, 1, 0, 1.41, 1.41];
  if (n === 5) return [1, 1, 1, 1.41, 1.41];
  return new Array(n).fill(1);
}

/** 4x interpolation filter: 4 phases of TAPS taps, windowed sinc (Kaiser, beta 7), cut at the original Nyquist. */
const TAPS = 24;
function interpolator() {
  const L = 4; const total = TAPS * L; const beta = 7;
  const i0 = (x) => { let s = 1; let t = 1; for (let k = 1; k < 30; k++) { t *= (x / (2 * k)) ** 2; s += t; } return s; };
  const h = new Float64Array(total);
  const mid = (total - 1) / 2;
  for (let n = 0; n < total; n++) {
    const x = (n - mid) / L;
    const sinc = x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
    const r = (n - mid) / (mid + 1);
    h[n] = sinc * (i0(beta * Math.sqrt(Math.max(0, 1 - r * r))) / i0(beta));
  }
  const phases = [];
  for (let p = 0; p < L; p++) { const ph = new Float64Array(TAPS); for (let k = 0; k < TAPS; k++) ph[k] = h[k * L + p]; phases.push(ph); }
  // each phase sums to 1 (no gain at low frequencies)
  for (const ph of phases) { let s = 0; for (const v of ph) s += v; for (let k = 0; k < TAPS; k++) ph[k] /= s; }
  return phases;
}

class LoudnessMeter {
  /** @param {number} fs sample rate  @param {number} channels */
  constructor(fs, channels) {
    this.fs = fs; this.ch = channels;
    const { shelf, hp } = kWeighting(fs);
    this.shelf = shelf; this.hp = hp;
    this.state = Array.from({ length: channels }, () => new Float64Array(8));   // x1 x2 y1 y2 (stage 1) and the same for stage 2
    this.weights = channelWeights(channels);
    this.sub = Math.round(fs / 10);                // 100 ms
    this.subAcc = new Float64Array(channels);
    this.subCount = 0;
    this.subs = [];                                // weighted energy of each 100 ms piece (already summed over channels)
    // true peak
    this.phases = interpolator();
    this.hist = Array.from({ length: channels }, () => new Float64Array(TAPS * 2));   // written twice, so a window never wraps
    this.histPos = 0;
    this.truePeak = 0;
    this.samplePeak = 0;
  }

  /** Feed interleaved samples (Float32Array or Float64Array), `frames` frames. */
  push(x, frames) {
    const C = this.ch; const s1 = this.shelf; const s2 = this.hp;
    const phases = this.phases;
    for (let i = 0; i < frames; i++) {
      for (let c = 0; c < C; c++) {
        const v = x[i * C + c];
        const st = this.state[c];
        // K-weighting, two direct-form-I biquads
        const y1 = s1.b0 * v + s1.b1 * st[0] + s1.b2 * st[1] - s1.a1 * st[2] - s1.a2 * st[3];
        st[1] = st[0]; st[0] = v; st[3] = st[2]; st[2] = y1;
        const y2 = s2.b0 * y1 + s2.b1 * st[4] + s2.b2 * st[5] - s2.a1 * st[6] - s2.a2 * st[7];
        st[5] = st[4]; st[4] = y1; st[7] = st[6]; st[6] = y2;
        this.subAcc[c] += y2 * y2;
        // peaks: the true peak is only worked out where it could beat the highest value so far
        const a = v < 0 ? -v : v;
        if (a > this.samplePeak) this.samplePeak = a;
        const h = this.hist[c];
        const pos = this.histPos;
        h[pos] = v; h[pos + TAPS] = v;
        if (a > this.truePeak) this.truePeak = a;
        // h[pos + 1 .. pos + TAPS] is the last TAPS samples, oldest first. The four phases give the values between the samples
        // 11 and 12 back (the filter's delay); they can only beat the peak so far where those two samples are already high.
        const base = pos + 1;
        const n1 = h[base + TAPS - 12]; const n2 = h[base + TAPS - 13];
        const near = Math.max(n1 < 0 ? -n1 : n1, n2 < 0 ? -n2 : n2);
        if (near > 0 && near * 1.5 >= this.truePeak) {
          for (let p = 0; p < 4; p++) {
            const ph = phases[p]; let acc = 0;
            for (let k = 0; k < TAPS; k++) acc += ph[k] * h[base + TAPS - 1 - k];
            const b = acc < 0 ? -acc : acc;
            if (b > this.truePeak) this.truePeak = b;
          }
        }
      }
      this.histPos = (this.histPos + 1) % TAPS;
      if (++this.subCount === this.sub) {
        let e = 0;
        for (let c = 0; c < C; c++) { e += this.weights[c] * (this.subAcc[c] / this.sub); this.subAcc[c] = 0; }
        this.subs.push(e);
        this.subCount = 0;
      }
    }
  }

  /** Results so far: integrated loudness (LUFS), loudness range (LU), true and sample peak (linear and dBFS). */
  result() {
    const L = (e) => -0.691 + 10 * Math.log10(e);
    const window = (n) => {           // mean energy of every run of n pieces (n = 4: 400 ms blocks, n = 30: 3 s), moving one piece at a time
      const out = [];
      let acc = 0;
      for (let i = 0; i < this.subs.length; i++) { acc += this.subs[i]; if (i >= n) acc -= this.subs[i - n]; if (i >= n - 1) out.push(acc / n); }
      return out;
    };
    const blocks = window(4).filter((e) => e > 0 && L(e) > -70);
    let integrated = -Infinity;
    if (blocks.length) {
      const rel = L(blocks.reduce((a, b) => a + b, 0) / blocks.length) - 10;
      const kept = blocks.filter((e) => L(e) > rel);
      if (kept.length) integrated = L(kept.reduce((a, b) => a + b, 0) / kept.length);
    }
    let lra = 0;
    const st = window(30).filter((e) => e > 0 && L(e) > -70);
    if (st.length) {
      const rel = L(st.reduce((a, b) => a + b, 0) / st.length) - 20;
      const vals = st.map(L).filter((v) => v > rel).sort((a, b) => a - b);
      if (vals.length > 1) {
        const pct = (p) => vals[Math.min(vals.length - 1, Math.max(0, Math.round((p / 100) * (vals.length - 1))))];
        lra = pct(95) - pct(10);
      }
    }
    const db = (v) => (v > 0 ? 20 * Math.log10(v) : -Infinity);
    return { integrated, lra, truePeak: this.truePeak, truePeakDb: db(this.truePeak), samplePeak: this.samplePeak, samplePeakDb: db(this.samplePeak) };
  }
}

module.exports = { kWeighting, channelWeights, interpolator, LoudnessMeter, TAPS };
