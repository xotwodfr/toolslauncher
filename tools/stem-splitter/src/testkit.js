'use strict';
// Test fixtures and measuring tools, shared by the unit tests, the packaged self-test and the window test.
// Test files are made as plain WAVs written by this file (no ffmpeg needed), so the editor is checked against sounds whose
// content is known exactly: tones of a chosen pitch and loudness.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

/**
 * Write a 16-bit WAV. `parts` = [{ sec, freq, amp }] played one after the other; freq 0 = silence.
 * A part may instead have `gen(i, rate)` returning a sample between -1 and 1 (used to make song-like test audio).
 * A fixed sine per part, so the pitch tells which part of the original any piece of output came from.
 */
function makeWav(file, { rate = 44100, channels = 1, parts }) {
  const total = parts.reduce((n, p) => n + Math.round(p.sec * rate), 0);
  const data = Buffer.alloc(total * channels * 2);
  let at = 0;
  for (const p of parts) {
    const n = Math.round(p.sec * rate);
    for (let i = 0; i < n; i++) {
      const v = p.gen ? Math.round(Math.max(-1, Math.min(1, p.gen(i, rate))) * 32767)
        : p.freq ? Math.round(Math.sin((2 * Math.PI * p.freq * i) / rate) * (p.amp == null ? 0.5 : p.amp) * 32767) : 0;
      for (let c = 0; c < channels; c++) data.writeInt16LE(v, (at + i) * channels * 2 + c * 2);
    }
    at += n;
  }
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVEfmt ', 8); h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); h.writeUInt16LE(channels, 22); h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * channels * 2, 28);
  h.writeUInt16LE(channels * 2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(data.length, 40);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.concat([h, data]));
  return file;
}

/** `steps(n, sec)`: n parts of `sec` seconds each, at 200, 300, 400... Hz - the part number is readable from the pitch. */
const steps = (n, sec = 1, amp = 0.5) => Array.from({ length: n }, (_, i) => ({ sec, freq: 200 + i * 100, amp }));

/** Decode any file to 16-bit mono PCM at `rate` with ffmpeg. Returns { samples: Int16Array, rate, errors }. */
function decode(ffmpeg, file, rate = 16000) {
  const r = spawnSync(ffmpeg, ['-hide_banner', '-v', 'error', '-i', file, '-vn', '-ac', '1', '-ar', String(rate), '-f', 's16le', '-'], { maxBuffer: 1 << 29, windowsHide: true });
  const buf = r.stdout || Buffer.alloc(0);
  return { samples: new Int16Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 2)), rate, errors: String(r.stderr || '').trim(), status: r.status };
}

const at = (pcm, t) => Math.max(0, Math.min(pcm.samples.length, Math.round(t * pcm.rate)));
/** Pitch of the sound between t0 and t1 (zero crossings per second). */
function freqOf(pcm, t0, t1) {
  let crossings = 0;
  const a = at(pcm, t0);
  const b = at(pcm, t1);
  for (let i = a + 1; i < b; i++) if (pcm.samples[i - 1] < 0 && pcm.samples[i] >= 0) crossings++;
  return crossings / Math.max(1e-9, (b - a) / pcm.rate);
}
/** Level between t0 and t1 in dBFS (RMS). -Infinity for silence. */
function rmsDb(pcm, t0, t1) {
  const a = at(pcm, t0);
  const b = at(pcm, t1);
  let sum = 0;
  for (let i = a; i < b; i++) sum += (pcm.samples[i] / 32768) ** 2;
  return 10 * Math.log10(sum / Math.max(1, b - a));
}
/** Highest sample between t0 and t1 in dBFS. */
function peakDb(pcm, t0 = 0, t1 = Infinity) {
  let m = 0;
  const b = Math.min(at(pcm, t1), pcm.samples.length);
  for (let i = at(pcm, t0); i < b; i++) m = Math.max(m, Math.abs(pcm.samples[i]));
  return 20 * Math.log10(Math.max(1, m) / 32768);
}
/** Biggest jump between two neighbouring samples (a click shows up as a big jump). */
function maxStep(pcm, t0, t1) {
  let m = 0;
  for (let i = at(pcm, t0) + 1; i < at(pcm, t1); i++) m = Math.max(m, Math.abs(pcm.samples[i] - pcm.samples[i - 1]));
  return m;
}
const seconds = (pcm) => pcm.samples.length / pcm.rate;

/** Integrated loudness (LUFS) of a file, measured by ffmpeg's EBU R128 scanner. */
function loudness(ffmpeg, file) {
  const r = spawnSync(ffmpeg, ['-hide_banner', '-nostats', '-i', file, '-vn', '-af', 'ebur128=peak=true', '-f', 'null', '-'], { encoding: 'utf8', maxBuffer: 1 << 26, windowsHide: true });
  const text = String(r.stderr);
  const i = text.lastIndexOf('Summary:');
  const m = /I:\s*(-?[\d.]+) LUFS/.exec(text.slice(i));
  return m ? Number(m[1]) : NaN;
}

module.exports = { makeWav, steps, decode, freqOf, rmsDb, peakDb, maxStep, seconds, loudness };
