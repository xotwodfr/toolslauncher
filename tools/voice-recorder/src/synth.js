'use strict';
// Invented "speech": voiced syllables (a buzzing tone with a few formant-like harmonics, a moving pitch and a syllable
// envelope) grouped into words and phrases, with pauses of known lengths between phrases, plus optional hiss and mains hum.
// Used by the tests, the self-test, the e2e fake microphone and the README screenshot - nobody's real voice.

function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}

/**
 * @param {object} o
 * @param {number} [o.sampleRate=48000]
 * @param {number[]} [o.phrases] length of each phrase in seconds
 * @param {number[]} [o.pauses] pause after each phrase in seconds (silence, apart from the noise)
 * @param {number} [o.lead=0.5] silence before the first phrase
 * @param {number} [o.level=0.3] peak level of the voice
 * @param {number} [o.noise=0] RMS of white hiss added everywhere
 * @param {number} [o.hum=0] amplitude of 50 Hz hum + harmonics
 * @param {number} [o.seed=1]
 * @returns {{samples: Float32Array, sampleRate: number, speech: Array<[number, number]>, pauses: Array<[number, number]>}}
 */
function makeSpeech(o = {}) {
  const sr = o.sampleRate || 48000;
  const phrases = o.phrases || [2.4, 3.0, 2.2];
  const pauses = o.pauses || [0.6, 2.5, 0.8];
  const lead = o.lead == null ? 0.5 : o.lead;
  const level = o.level == null ? 0.3 : o.level;
  const rand = rng(o.seed || 1);
  const total = lead + phrases.reduce((a, b) => a + b, 0) + pauses.slice(0, phrases.length).reduce((a, b) => a + b, 0);
  const n = Math.round(total * sr);
  const out = new Float32Array(n);
  const speech = []; const gaps = [];
  let t = lead;
  if (lead > 0) gaps.push([0, lead]);
  for (let p = 0; p < phrases.length; p++) {
    const end = t + phrases[p];
    let last = t;
    // syllables of 0.12-0.3 s with short (0.03-0.08 s) dips between them; a word gap is a longer dip, never a real pause
    let s = t;
    while (s < end - 0.1) {
      const dur = Math.min(end - s, 0.12 + rand() * 0.18);
      const f0 = 110 + rand() * 80;
      const glide = (rand() - 0.5) * 40;
      const amp = level * (0.55 + rand() * 0.45);
      const a = Math.round(s * sr); const b = Math.min(n, Math.round((s + dur) * sr));
      let phase = 0;
      for (let i = a; i < b; i++) {
        const x = (i - a) / (b - a);
        const env = Math.sin(Math.PI * x) ** 0.7;
        const f = f0 + glide * x;
        phase += (2 * Math.PI * f) / sr;
        // harmonics shaped like a vowel: strong 1-3, a formant bump around 700 Hz and 1.2 kHz
        let v = 0;
        for (let h = 1; h <= 14; h++) {
          const fh = f * h;
          const g = 1 / h + 0.6 * Math.exp(-(((fh - 700) / 180) ** 2)) + 0.35 * Math.exp(-(((fh - 1200) / 220) ** 2));
          v += g * Math.sin(phase * h);
        }
        out[i] += amp * env * v * 0.42;
      }
      last = s + dur;
      s += dur + 0.03 + rand() * 0.05;
    }
    // the real pause runs from the end of the last syllable (a little before the phrase's nominal end) to the next phrase
    speech.push([t, last]);
    t = end;
    const gap = pauses[p] || 0;
    if (gap > 0 || p === phrases.length - 1) gaps.push([last, t + gap]);
    t += gap;
  }
  if (o.noise) {
    // Box-Muller white noise at the asked RMS
    for (let i = 0; i < n; i += 2) {
      const u = Math.max(1e-12, rand()); const v = rand();
      const r = Math.sqrt(-2 * Math.log(u)) * o.noise;
      out[i] += r * Math.cos(2 * Math.PI * v);
      if (i + 1 < n) out[i + 1] += r * Math.sin(2 * Math.PI * v);
    }
  }
  if (o.hum) for (let i = 0; i < n; i++) { const w = (2 * Math.PI * 50 * i) / sr; out[i] += o.hum * (Math.sin(w) + 0.4 * Math.sin(2 * w + 0.3)); }
  for (let i = 0; i < n; i++) out[i] = Math.max(-1, Math.min(1, out[i]));
  return { samples: out, sampleRate: sr, speech, pauses: gaps, duration: n / sr };
}

/** RMS in dBFS of a region of a signal. */
function rmsDb(samples, sr, from = 0, to = samples.length / sr) {
  const a = Math.max(0, Math.floor(from * sr)); const b = Math.min(samples.length, Math.ceil(to * sr));
  let s = 0; for (let i = a; i < b; i++) s += samples[i] * samples[i];
  return 10 * Math.log10(s / Math.max(1, b - a) + 1e-20);
}

module.exports = { makeSpeech, rmsDb, rng };
