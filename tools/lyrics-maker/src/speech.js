'use strict';
// Test material: spoken sentences made with the voices that ship with Windows (System.Speech), placed at known times in a
// silent clip, so the recogniser can be checked against the truth (what was said, and when). Not available on other systems,
// where the tests that need it are skipped. Also a word error rate, to compare what was heard with what was said.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const A = require('./audio');

const available = () => process.platform === 'win32';

/** Speak `text` into a WAV file with a Windows voice. */
function synthesize(text, file, voice = 'Microsoft David Desktop') {
  if (!available()) throw new Error('Speech synthesis is only available on Windows');
  const esc = (s) => String(s).replace(/'/g, "''");
  const script = `Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; try { $s.SelectVoice('${esc(voice)}') } catch {}; $s.SetOutputToWaveFile('${esc(file)}'); $s.Speak('${esc(text)}'); $s.Dispose()`;
  const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0 || !fs.existsSync(file)) throw new Error('Speech synthesis failed: ' + (r.stderr || '').slice(0, 200));
  return file;
}

/** Write 16-bit mono WAV. */
function writeWav(file, samples, rate = 16000) {
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

/**
 * Speak each part at its time into a clip of `seconds` and write it as a 16 kHz mono WAV.
 * @param {{ text: string, at: number, voice?: string }[]} parts
 * @returns {Promise<{ file: string, samples: Float32Array, truth: { start: number, end: number, text: string }[] }>}
 */
async function makeClip(parts, seconds, file, workDir = path.dirname(file)) {
  const ffmpeg = A.ffmpegPath();
  const samples = new Float32Array(Math.round(seconds * 16000));
  const truth = [];
  for (let i = 0; i < parts.length; i++) {
    const tmp = path.join(workDir, `speech-${process.pid}-${i}.wav`);
    synthesize(parts[i].text, tmp, parts[i].voice);
    const pcm = await A.decode16k(ffmpeg, tmp);
    fs.rmSync(tmp, { force: true });
    const at = Math.round(parts[i].at * 16000);
    samples.set(pcm.subarray(0, Math.max(0, samples.length - at)), at);
    truth.push({ start: parts[i].at, end: parts[i].at + pcm.length / 16000, text: parts[i].text });
  }
  writeWav(file, samples);
  return { file, samples, truth };
}

const words = (s) => String(s).toLowerCase().replace(/[^\p{L}\p{N}' ]+/gu, ' ').split(/\s+/).filter(Boolean);
/** Word error rate: how many words must change to turn `heard` into `said`, as a fraction of the words said. */
function wordErrorRate(said, heard) {
  const a = words(said); const b = words(heard);
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...new Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return a.length ? d[a.length][b.length] / a.length : (b.length ? 1 : 0);
}

const SENTENCES = [
  'The river runs down to the sea, and the morning light is warm on the hills.',
  'We walked all night through the empty streets, singing songs we used to know.',
  'Hold on to the little things, they will carry you home.',
  'Every window glowed like a lantern, and the whole town seemed to breathe.',
];

module.exports = { available, synthesize, writeWav, makeClip, wordErrorRate, words, SENTENCES };
