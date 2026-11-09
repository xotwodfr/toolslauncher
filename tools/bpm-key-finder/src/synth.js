'use strict';
// Makes songs whose tempo and key are known exactly, so the detector can be checked against the truth: a drum kit
// (kick, snare, hats), a bass line on the chord roots, a chord pad and a melody wandering over the scale. All invented.
// Used by the unit tests, the packaged self-test, the window test and the README screenshot.
const fs = require('fs');
const path = require('path');

const MAJOR = [0, 2, 4, 5, 7, 9, 11];
const MINOR = [0, 2, 3, 5, 7, 8, 11];   // harmonic minor (the raised 7th is what tells minor from its relative major)
// chords as semitone offsets from the tonic + quality: I vi IV V  /  i iv V i
const PROGRESSION = {
  major: [[0, [0, 4, 7]], [9, [0, 3, 7]], [5, [0, 4, 7]], [7, [0, 4, 7]]],
  minor: [[0, [0, 3, 7]], [5, [0, 3, 7]], [7, [0, 4, 7]], [0, [0, 3, 7]]],
};

function rng(seed) { let s = seed >>> 0 || 1; return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }
const hz = (midi, cents = 0) => 440 * 2 ** ((midi - 69 + cents / 100) / 12);

/**
 * @param {object} o
 * @param {number} o.bpm        exact tempo
 * @param {number} o.tonic      0 = C ... 11 = B
 * @param {'major'|'minor'} o.mode
 * @param {number} [o.seconds=40]
 * @param {number} [o.rate=22050]
 * @param {number} [o.seed=1]
 * @param {number} [o.cents=0]  detune the whole recording (an old tape, a different reference pitch)
 * @param {boolean} [o.drums=true]
 * @param {boolean} [o.fourOnFloor=false]  kick on every beat (dance music) instead of beats 1 and 3
 * @param {boolean} [o.tonal=true] chords, bass and melody
 * @returns {Float32Array}
 */
function makeSong({ bpm, tonic, mode = 'major', seconds = 40, rate = 22050, seed = 1, cents = 0, drums = true, fourOnFloor = false, tonal = true }) {
  const n = Math.round(seconds * rate);
  const out = new Float32Array(n);
  const rand = rng(seed);
  const beat = 60 / bpm;
  const scale = mode === 'minor' ? MINOR : MAJOR;
  const prog = PROGRESSION[mode];

  const tone = (midi, t0, dur, amp, harmonics = 6, attack = 0.01, decay = 0) => {
    const f0 = hz(midi, cents);
    const i0 = Math.max(0, Math.round(t0 * rate));
    const i1 = Math.min(n, Math.round((t0 + dur) * rate));
    for (let h = 1; h <= harmonics; h++) {
      const f = f0 * h;
      if (f > rate / 2.2) break;
      const a = amp / h;
      const w = (2 * Math.PI * f) / rate;
      for (let i = i0; i < i1; i++) {
        const t = (i - i0) / rate;
        const env = Math.min(1, t / attack) * Math.min(1, (dur - t) / 0.02) * Math.exp(-decay * t);
        out[i] += a * env * Math.sin(w * (i - i0));
      }
    }
  };
  const noise = (t0, dur, amp, decay, hp = false) => {
    const i0 = Math.round(t0 * rate);
    const i1 = Math.min(n, i0 + Math.round(dur * rate));
    let last = 0;
    for (let i = i0; i < i1; i++) {
      const x = rand() * 2 - 1;
      const v = hp ? x - last : x;  // a first difference makes it bright (hi-hat)
      last = x;
      out[i] += amp * v * Math.exp(-((i - i0) / rate) * decay);
    }
  };
  const kick = (t0) => {
    const i0 = Math.round(t0 * rate);
    const i1 = Math.min(n, i0 + Math.round(0.28 * rate));
    let phase = 0;
    for (let i = i0; i < i1; i++) {
      const t = (i - i0) / rate;
      phase += (2 * Math.PI * (45 + 110 * Math.exp(-t * 40))) / rate;
      out[i] += 0.6 * Math.sin(phase) * Math.exp(-t * 11);
    }
  };

  const bars = Math.ceil(seconds / (4 * beat));
  for (let bar = 0; bar < bars; bar++) {
    const barT = bar * 4 * beat;
    const [rootOff, triad] = prog[bar % prog.length];
    if (tonal) {
      const root = 48 + tonic + rootOff; // C3 region
      for (const iv of triad) tone(root + 12 + iv, barT, 4 * beat, 0.05, 6, 0.04, 0.2);
      for (let b = 0; b < 4; b++) {
        tone(root - 12, barT + b * beat, beat * 0.85, 0.2, 4, 0.005, 3);
        tone(root - 12 + (b % 2 ? 7 : 0), barT + (b + 0.5) * beat, beat * 0.4, 0.12, 4, 0.005, 5);
      }
      let degree = Math.floor(rand() * 7);
      for (let e = 0; e < 8; e++) {
        degree = Math.max(0, Math.min(13, degree + Math.floor(rand() * 5) - 2));
        const midi = 72 + tonic + scale[degree % 7] + 12 * Math.floor(degree / 7) - 12;
        if (rand() < 0.8) tone(midi, barT + e * 0.5 * beat, beat * 0.45, 0.07, 5, 0.01, 4);
      }
    }
    if (drums) {
      for (let b = 0; b < 4; b++) {
        if (fourOnFloor || b % 2 === 0) kick(barT + b * beat);
        if (b % 2 === 1) noise(barT + b * beat, 0.16, 0.35, 25);
        noise(barT + b * beat, 0.04, 0.12, 120, true);
        noise(barT + (b + 0.5) * beat, 0.04, 0.09, 120, true);
      }
    }
  }
  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(out[i]));
  if (peak > 0) for (let i = 0; i < n; i++) out[i] *= 0.85 / peak;
  return out;
}

/** Write mono samples as a 16-bit WAV (so ffmpeg and the window can read the invented song like any other file). */
function writeWav(file, samples, rate = 22050) {
  const data = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767), i * 2);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVEfmt ', 8); h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(data.length, 40);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.concat([h, data]));
  return file;
}

module.exports = { makeSong, writeWav };
