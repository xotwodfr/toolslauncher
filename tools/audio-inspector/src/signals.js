'use strict';
// Test material made from scratch (no recordings): white and pink noise, tones, and a WAV writer for 16/24-bit integer and
// 32-bit float samples. Used by the tests, the self-test and the README screenshot. Electron-free.
const fs = require('fs');
const path = require('path');

/** A small seeded random generator (xorshift), so every run makes the same "random" noise. */
function rng(seed = 1) { let s = seed >>> 0 || 1; return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }
/** Gaussian-ish white noise (sum of 4 uniforms), RMS about `level`. */
function white(n, level = 0.2, seed = 1) {
  const r = rng(seed); const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = (r() + r() + r() + r() - 2) * level * 1.7320508;
  return x;
}
/** Pink noise (Paul Kellet's filter on white noise): -3 dB per octave, all the way to the top. */
function pink(n, level = 0.2, seed = 2) {
  const w = white(n, 1, seed); const x = new Float32Array(n);
  let b0 = 0; let b1 = 0; let b2 = 0; let b3 = 0; let b4 = 0; let b5 = 0; let b6 = 0;
  for (let i = 0; i < n; i++) {
    const v = w[i];
    b0 = 0.99886 * b0 + v * 0.0555179; b1 = 0.99332 * b1 + v * 0.0750759; b2 = 0.969 * b2 + v * 0.153852;
    b3 = 0.8665 * b3 + v * 0.3104856; b4 = 0.55 * b4 + v * 0.5329522; b5 = -0.7616 * b5 - v * 0.016898;
    x[i] = b0 + b1 + b2 + b3 + b4 + b5 + b6 + v * 0.5362; b6 = v * 0.115926;
  }
  let sq = 0; for (let i = 0; i < n; i++) sq += x[i] * x[i];
  const k = level / Math.sqrt(sq / Math.max(1, n) || 1);
  for (let i = 0; i < n; i++) x[i] *= k;
  return x;
}
function sine(n, rate, freq, amp = 0.5, phase = 0) { const x = new Float32Array(n); for (let i = 0; i < n; i++) x[i] = amp * Math.sin((2 * Math.PI * freq * i) / rate + phase); return x; }

/**
 * A made-up piece of music (for the screenshot and the self-test): a kick, a bass line, a chord pad rich in harmonics and
 * hi-hats, so its spectrum is full up to the top and changes over time like a real song. Returns [left, right].
 */
function song(seconds, rate = 44100, seed = 7) {
  const n = Math.round(seconds * rate); const L = new Float32Array(n); const Rr = new Float32Array(n);
  const r = rng(seed);
  const chords = [[57, 60, 64], [53, 57, 60], [48, 52, 55], [55, 59, 62]];       // Am F C G (MIDI notes)
  const hz = (m) => 440 * Math.pow(2, (m - 69) / 12);
  const bar = 2.0;
  for (let i = 0; i < n; i++) {
    const t = i / rate; const c = chords[Math.floor(t / bar) % chords.length];
    let pad = 0;
    for (const note of c) { const f = hz(note); for (let k = 1; k <= 14 && f * k < rate / 2.2; k++) pad += Math.sin(2 * Math.PI * f * k * t + k) / (k * 1.2); }
    const bass = Math.sin(2 * Math.PI * hz(c[0] - 24) * t) * 0.9;
    const kt = t % 0.5; const kick = Math.sin(2 * Math.PI * (50 + 90 * Math.exp(-kt * 30)) * kt) * Math.exp(-kt * 9);
    const v = pad * 0.045 + bass * 0.16 + kick * 0.35;
    L[i] = v; Rr[i] = v * 0.92;
  }
  // hi-hats: short bursts of brightened noise on every eighth note, a little to the right
  let prev = 0;
  for (let i = 0; i < n; i++) {
    const t = i / rate; const ht = t % 0.25; const w = r() * 2 - 1; const bright = w - prev; prev = w;
    const h = bright * Math.exp(-ht * 60) * 0.08;
    L[i] += h * 0.8; Rr[i] += h;
  }
  return [L, Rr];
}

/**
 * Write a WAV file. `channels` is an array of Float32Arrays (all the same length).
 * @param {number|'float'} bits 16, 24 or 'float' (32-bit float)
 */
function writeWav(file, channels, rate, bits = 16) {
  const C = channels.length; const n = channels[0].length;
  const isFloat = bits === 'float';
  const bps = isFloat ? 4 : bits / 8;
  const data = Buffer.alloc(n * C * bps);
  let o = 0;
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < C; c++) {
      const v = channels[c][i];
      if (isFloat) { data.writeFloatLE(v, o); o += 4; continue; }
      const max = Math.pow(2, bits - 1);
      const q = Math.max(-max, Math.min(max - 1, Math.round(v * max)));
      if (bits === 16) data.writeInt16LE(q, o); else data.writeIntLE(q, o, 3);
      o += bps;
    }
  }
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVEfmt ', 8); h.writeUInt32LE(16, 16);
  h.writeUInt16LE(isFloat ? 3 : 1, 20); h.writeUInt16LE(C, 22); h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * C * bps, 28);
  h.writeUInt16LE(C * bps, 32); h.writeUInt16LE(bps * 8, 34); h.write('data', 36); h.writeUInt32LE(data.length, 40);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.concat([h, data]));
  return file;
}

/**
 * The ffmpeg filter that upsamples to `rate` for test material: the SoX resampler when this ffmpeg build has it (Linux),
 * else ffmpeg's own resampler at high quality (the Windows build has no libsoxr). Both leave nothing above the old
 * Nyquist frequency, which is what the "upsampled" verdict looks for. AI_TEST_NO_SOXR=1 forces the second one.
 */
let soxr = null;
function upsampleFilter(ffmpeg, rate) {
  if (soxr === null) {
    const { spawnSync } = require('child_process');
    const r = spawnSync(ffmpeg, ['-hide_banner', '-buildconf'], { encoding: 'utf8', windowsHide: true });
    soxr = !process.env.AI_TEST_NO_SOXR && r.status === 0 && /--enable-libsoxr/.test(r.stdout + r.stderr);
  }
  return soxr ? `aresample=${rate}:resampler=soxr:precision=28` : `aresample=${rate}:resampler=swr:filter_size=64:cutoff=0.97`;
}

module.exports = { upsampleFilter, rng, white, pink, sine, song, writeWav };
