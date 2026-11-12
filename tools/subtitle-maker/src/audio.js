'use strict';
// Reading the sound for Whisper: any audio or video file -> 16 kHz mono float samples, with the bundled ffmpeg. Electron-free.
let fs;
try { fs = require('original-fs'); } catch { fs = require('fs'); }
const { spawn } = require('child_process');

const SAMPLE_RATE = 16000;
const MAX_SECONDS = 3 * 60 * 60; // a feature film fits (the sound alone is ~690 MB in memory at that length); longer files are refused

class UserError extends Error {}
const cancelled = () => Object.assign(new Error('Cancelled'), { cancelled: true });
const asarFix = (p) => p.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');

function ffmpegPath() {
  try {
    const p = require('ffmpeg-static');
    if (p) { const real = asarFix(p); if (fs.existsSync(real)) return real; }
  } catch { /* fall through */ }
  return 'ffmpeg';
}

/** Length in seconds, read from the file's header by ffmpeg ("Duration: 00:03:21.45"). */
function probe(ffmpeg, file) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, ['-hide_banner', '-i', file], { windowsHide: true });
    let text = '';
    child.stderr.on('data', (d) => { if (text.length < 20000) text += d; });
    child.on('error', (e) => reject(new UserError('Could not start ffmpeg: ' + e.message)));
    child.on('close', () => {
      const m = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(text);
      if (!m) return reject(new UserError('This file could not be read as audio'));
      if (/Stream #\d+:\d+.*Audio:/.test(text) === false) return reject(new UserError('This file has no audio in it'));
      resolve(Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]));
    });
  });
}

/** @returns {Promise<Float32Array>} the whole file as 16 kHz mono */
function decode16k(ffmpeg, file, { signal } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, ['-hide_banner', '-v', 'error', '-i', file, '-vn', '-ac', '1', '-ar', String(SAMPLE_RATE), '-t', String(MAX_SECONDS), '-f', 'f32le', '-'], { windowsHide: true });
    const chunks = []; let err = '';
    child.stdout.on('data', (d) => chunks.push(d));
    child.stderr.on('data', (d) => { if (err.length < 2000) err += d; });
    const onAbort = () => { child.kill(); reject(cancelled()); };
    if (signal) { if (signal.aborted) return onAbort(); signal.addEventListener('abort', onAbort, { once: true }); }
    child.on('error', (e) => reject(new UserError('Could not start ffmpeg: ' + e.message)));
    child.on('close', (code) => {
      if (signal) signal.removeEventListener('abort', onAbort);
      let total = 0; for (const c of chunks) total += c.length;
      if (code !== 0 || total < 4) return reject(new UserError('This file has no sound that could be read' + (err.trim() ? ` (${err.trim().split('\n').pop().slice(0, 90)})` : '')));
      // one copy only (a long film is hundreds of MB): the bytes go straight into the array's own memory, chunk by chunk
      const out = new Float32Array(Math.floor(total / 4));
      const bytes = new Uint8Array(out.buffer);
      let at = 0;
      for (let i = 0; i < chunks.length; i++) { const c = chunks[i]; const n = Math.min(c.length, bytes.length - at); if (n > 0) bytes.set(c.subarray(0, n), at); at += n; chunks[i] = null; }
      resolve(out);
    });
  });
}

module.exports = { SAMPLE_RATE, MAX_SECONDS, UserError, cancelled, ffmpegPath, probe, decode16k };
