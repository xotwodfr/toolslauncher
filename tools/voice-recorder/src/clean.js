'use strict';
// The cleaning chain and the exports, done by ffmpeg. Electron-free.
//   trim -> high-pass (rumble) -> de-click -> noise reduction (profile learned from a quiet stretch) -> de-ess
//   -> shorten long pauses -> loudness (two-pass loudnorm) -> encode
let fs;
try { fs = require('original-fs'); } catch { fs = require('fs'); }
const path = require('path');
const { spawn } = require('child_process');
const A = require('./analyse');

const asarFix = (p) => p.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
function ffmpegPath() {
  try {
    const p = require('ffmpeg-static');
    if (p) { const real = asarFix(p); if (fs.existsSync(real)) return real; }
  } catch { /* fall through */ }
  return 'ffmpeg';
}

const FORMATS = {
  wav: { label: 'WAV', ext: 'wav', args: ['-c:a', 'pcm_s16le', '-rf64', 'auto', '-f', 'wav'] },
  flac: { label: 'FLAC', ext: 'flac', args: ['-c:a', 'flac', '-compression_level', '8', '-f', 'flac'] },
  mp3: { label: 'MP3', ext: 'mp3', args: ['-c:a', 'libmp3lame', '-q:a', '3', '-id3v2_version', '3', '-f', 'mp3'] },
  m4a: { label: 'M4A (AAC)', ext: 'm4a', args: ['-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', '-f', 'ipod'] },
  opus: { label: 'Opus', ext: 'opus', args: ['-c:a', 'libopus', '-b:a', '64k', '-ar', '48000', '-f', 'opus'] },
};
const STRENGTH = { light: 10, medium: 18, strong: 30 };
const TARGETS = [-14, -16, -19, -23];
const TRUE_PEAK = -1.5;

const num = (v, min, max, dflt) => { const n = Number(v); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt; };
const span = (v, max, min = 0.05) => {
  if (!v || typeof v !== 'object') return null;
  const s = num(v.start, 0, max, NaN); const e = num(v.end, 0, max, NaN);
  return Number.isFinite(s) && Number.isFinite(e) && e - s >= min ? { start: s, end: e } : null;
};

/** Validate the cleaning settings coming from the window. Anything odd falls back to a safe default. */
function normalize(o, duration = Infinity) {
  o = o && typeof o === 'object' ? o : {};
  const d = o.denoise || {}; const p = o.pauses || {}; const l = o.loudness || {}; const h = o.highpass || {};
  return {
    trim: span(o.trim, duration, 0),
    highpass: { on: !!h.on, freq: num(h.freq, 40, 200, 80) },
    declick: !!o.declick,
    denoise: { on: !!d.on, strength: STRENGTH[d.strength] ? d.strength : 'medium', sample: span(d.sample, duration) },
    deess: !!o.deess,
    pauses: { on: !!p.on, longer: num(p.longer, 0.3, 30, 1.2), keep: num(p.keep, 0, 10, 0.5) },
    loudness: { on: !!l.on, target: TARGETS.includes(Number(l.target)) ? Number(l.target) : -16 },
  };
}

const anyCleaning = (o) => !!(o.trim || o.highpass.on || o.declick || o.denoise.on || o.deess || o.pauses.on || o.loudness.on);
const f3 = (v) => (Math.round(v * 1000) / 1000).toFixed(3);

/**
 * Work out the ffmpeg inputs and filter graph (everything except loudness) for a stretch of a take.
 * @param {string} file the take
 * @param {object} analysis from analyse()
 * @param {object} opts normalized settings
 * @param {{range?: {start:number,end:number}}} [o] render only this stretch (preview); defaults to the trim or the whole take
 */
function plan(file, analysis, opts, { range } = {}) {
  const dur = analysis.duration;
  const r = range || opts.trim || { start: 0, end: dur };
  const start = Math.max(0, Math.min(dur, r.start)); const end = Math.max(start, Math.min(dur, r.end));
  const inputs = [];
  const filters = [];
  let prefix = 0;
  let noise = null;
  const threshold = A.silenceThreshold(analysis.floorDb, analysis.speechDb);
  if (opts.denoise.on) {
    noise = opts.denoise.sample || A.quietestStretch(analysis.db, analysis.win, { threshold });
    if (noise) {
      prefix = noise.end - noise.start;
      inputs.push(['-ss', f3(noise.start), '-t', f3(prefix), '-i', file]);
    }
  }
  inputs.push(['-ss', f3(start), '-t', f3(end - start), '-i', file]);
  let head = prefix ? '[0:a][1:a]concat=n=2:v=0:a=1' : '[0:a]anull';
  if (opts.highpass.on) { const hp = `highpass=f=${Math.round(opts.highpass.freq)}:poles=2`; filters.push(hp, hp); } // 24 dB per octave
  if (opts.declick) filters.push('adeclick=window=55:overlap=75');
  if (opts.denoise.on) {
    const nr = STRENGTH[opts.denoise.strength];
    const nf = Math.round(Math.min(-20, Math.max(-80, analysis.floorDb)));
    if (prefix) {
      filters.push(`asendcmd=c='0.0 afftdn sample_noise start;${f3(Math.max(0.05, prefix - 0.02))} afftdn sample_noise stop'`);
      filters.push(`afftdn=nr=${nr}:nf=${nf}`);
      filters.push(`atrim=start=${f3(prefix)}`, 'asetpts=PTS-STARTPTS');
    } else filters.push(`afftdn=nr=${nr}:nf=${nf}:tn=1`);
  }
  if (opts.deess) filters.push('deesser=i=0.5:m=0.5:f=0.5');
  let cuts = [];
  if (opts.pauses.on) {
    const pauses = A.findPauses(analysis.db, analysis.win, { minPause: opts.pauses.longer, threshold, from: start, to: end });
    cuts = A.pauseCuts(pauses, opts.pauses).map(([a, b]) => [Math.max(0, a - start), Math.min(end - start, b - start)]).filter(([a, b]) => b - a > 0.01);
    if (cuts.length) {
      filters.push('asetnsamples=n=240:p=0');
      filters.push(`aselect='not(${cuts.map(([a, b]) => `between(t,${f3(a)},${f3(b)})`).join('+')})'`);
      filters.push('asetpts=N/SR/TB');
    }
  }
  const removed = cuts.reduce((s, [a, b]) => s + (b - a), 0);
  return { inputs, head, filters, start, end, noise, cuts, outDuration: Math.max(0, end - start - removed), sampleRate: analysis.sampleRate };
}

const cancelledError = () => Object.assign(new Error('Cancelled'), { cancelled: true });

/** Run ffmpeg; onTime(seconds of output written). Rejects with {cancelled:true} when the signal aborts. */
function runFfmpeg(args, { onTime, signal, ffmpeg = ffmpegPath() } = {}) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) { reject(cancelledError()); return; }
    const child = spawn(ffmpeg, ['-hide_banner', '-nostdin', '-nostats', '-progress', 'pipe:1', ...args], { windowsHide: true });
    let err = ''; let out = '';
    child.stderr.on('data', (d) => { err += d; if (err.length > 2e6) err = err.slice(-1e6); });
    child.stdout.on('data', (d) => {
      out += d;
      let i;
      while ((i = out.indexOf('\n')) >= 0) {
        const line = out.slice(0, i); out = out.slice(i + 1);
        const m = /^out_time_us=(\d+)/.exec(line);
        if (m && onTime) onTime(Number(m[1]) / 1e6);
      }
    });
    const abort = () => { try { child.kill('SIGKILL'); } catch { /* gone */ } };
    if (signal) signal.addEventListener('abort', abort, { once: true });
    child.on('error', (e) => { if (signal) signal.removeEventListener('abort', abort); reject(new Error('ffmpeg could not start: ' + e.message)); });
    child.on('close', (code) => {
      if (signal) signal.removeEventListener('abort', abort);
      if (signal && signal.aborted) reject(cancelledError());
      else if (code === 0) resolve({ stderr: err });
      else reject(new Error('The sound could not be processed: ' + (err.trim().split('\n').filter((l) => !/^\s*$/.test(l)).slice(-3).join(' ') || 'ffmpeg exit ' + code)));
    });
  });
}

function graphArgs(p, extra) {
  const chain = [p.head, ...p.filters, ...extra].join(',');
  return ['-filter_complex', `${chain}[out]`, '-map', '[out]'];
}

/**
 * Render a take (or a stretch of it) with the cleaning applied, to `output` in `format`.
 * Writes `<output>.part` first and renames it when complete. onProgress(0..1).
 * Loudness: the cleaned sound is rendered once to a temporary file, then the gain is found by measuring (gain, then a
 * true-peak limiter, then the EBU R128 meter) until the result is within 0.15 LU of the target, and only then encoded.
 * (loudnorm's own dynamic mode misses short or peaky takes by a whole LU, and the limiter takes some loudness back.)
 * @returns {Promise<{path:string, duration:number, loudness:object|null, cuts:number, noise:object|null}>}
 */
async function render(file, analysis, rawOpts, { output, format = 'wav', range, title, date, signal, onProgress, ffmpeg, tempDir } = {}) {
  const fmt = FORMATS[format];
  if (!fmt) throw new Error('Unknown format: ' + format);
  const opts = normalize(rawOpts, analysis.duration);
  const p = plan(file, analysis, opts, { range });
  if (p.end - p.start < 0.1) throw new Error('There is nothing left to save - the trim leaves no sound');
  const leveled = opts.loudness.on;
  // progress: the cleaning pass is most of the work; each loudness check is a cheap pass over the temporary file
  let base = 0; let share = leveled ? 0.6 : 1;
  const prog = (t) => { if (onProgress) onProgress(Math.min(0.99, base + share * Math.min(1, t / Math.max(0.1, p.outDuration)))); };
  const step = (next) => { base += share; share = next; };
  const part = output + '.part';
  const meta = [];
  if (title) meta.push('-metadata', `title=${String(title).slice(0, 200)}`);
  if (date) meta.push('-metadata', `date=${String(date).slice(0, 40)}`);
  const tail = ['-map_metadata', '-1', ...meta, '-ac', '1', ...fmt.args, part];
  let tmp = null; let loudness = null; let gain = 0;
  try {
    if (!leveled) {
      await runFfmpeg(['-y', '-v', 'error', ...p.inputs.flat(), ...graphArgs(p, []), ...tail], { signal, onTime: prog, ffmpeg });
    } else {
      tmp = path.join(tempDir || require('os').tmpdir(), `vr-level-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.wav`);
      await runFfmpeg(['-y', '-v', 'error', ...p.inputs.flat(), ...graphArgs(p, []), '-ac', '1', '-c:a', 'pcm_f32le', '-rf64', 'auto', '-f', 'wav', tmp], { signal, onTime: prog, ffmpeg });
      step(0.08);
      const target = opts.loudness.target;
      const limit = Math.pow(10, (TRUE_PEAK - 0.5) / 20);
      // gain, then a fast peak limiter (half a dB under the true-peak ceiling): it only shaves the loudest syllables
      const chain = (g) => `volume=${g.toFixed(2)}dB,alimiter=limit=${limit.toFixed(4)}:level=false:attack=1:release=15`;
      const first = await loudnessOf(tmp, { ffmpeg, signal, onTime: prog });
      step(0.08);
      if (Number.isFinite(first.i) && first.i > -70) {
        const start = Math.max(-30, Math.min(30, target - first.i));
        gain = start;
        let prev = null;
        for (let k = 0; ; k++) {
          const m = await loudnessOf(tmp, { ffmpeg, signal, filter: chain(gain), onTime: prog });
          step(0.05);
          loudness = m;
          const miss = target - m.i;
          if (!Number.isFinite(miss) || Math.abs(miss) <= 0.15 || k >= 4) break;
          // the compressor and limiter swallow part of every extra dB: estimate how much from the last two tries
          let slope = 1;
          if (prev && Math.abs(gain - prev.gain) > 0.01) slope = Math.max(0.4, Math.min(1.2, (m.i - prev.i) / (gain - prev.gain)));
          prev = { gain, i: m.i };
          const next = Math.max(start - 12, Math.min(start + 12, gain + miss / slope)); // never squash more than 12 dB
          if (Math.abs(next - gain) < 0.01) break;
          gain = next;
        }
      }
      share = Math.max(0.01, 1 - base);
      const extra = loudness ? ['-af', chain(gain)] : [];
      await runFfmpeg(['-y', '-v', 'error', '-i', tmp, ...extra, ...tail], { signal, onTime: prog, ffmpeg });
    }
    if (signal && signal.aborted) throw cancelledError();
    fs.renameSync(part, output);
  } catch (e) {
    try { fs.rmSync(part, { force: true }); } catch { /* ignore */ }
    throw e;
  } finally {
    if (tmp) try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
  }
  if (onProgress) onProgress(1);
  return { path: output, duration: p.outDuration, loudness, gain: loudness ? gain : 0, cuts: p.cuts.length, noise: p.noise };
}

/** Measure a file's integrated loudness (LUFS) and true peak with ffmpeg's EBU R128 meter. */
async function loudnessOf(file, { ffmpeg, signal, filter, onTime } = {}) {
  const af = (filter ? filter + ',' : '') + 'ebur128=peak=true';
  const { stderr } = await runFfmpeg(['-v', 'info', '-i', file, '-af', af, '-f', 'null', '-'], { ffmpeg, signal, onTime });
  const tail = stderr.slice(stderr.lastIndexOf('Summary:'));
  const i = /I:\s*(-?[\d.]+|-inf) LUFS/.exec(tail); const tp = /Peak:\s*(-?[\d.]+|-inf) dBFS/.exec(tail);
  return { i: i ? Number(i[1]) : -Infinity, tp: tp ? Number(tp[1]) : -Infinity };
}

const BAD_CHARS = /[<>:"/\\|?*\u0000-\u001f]/g;
/** A file-name-safe version of a title (keeps accents and other scripts; Windows-reserved names get an underscore). */
function safeName(s, fallback = 'Recording') {
  let t = String(s == null ? '' : s).replace(BAD_CHARS, ' ').replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '').slice(0, 120);
  if (/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(t)) t = '_' + t;
  return t || fallback;
}

/** "name.ext", or "name (2).ext", "name (3).ext"... - never an existing file (nor one being written). */
function uniquePath(dir, base, ext) {
  for (let i = 1; i < 10000; i++) {
    const p = path.join(dir, `${base}${i > 1 ? ` (${i})` : ''}.${ext}`);
    if (!fs.existsSync(p) && !fs.existsSync(p + '.part')) return p;
  }
  throw new Error('Could not find a free file name');
}

module.exports = { FORMATS, STRENGTH, TARGETS, TRUE_PEAK, ffmpegPath, normalize, anyCleaning, plan, runFfmpeg, render, loudnessOf, safeName, uniquePath };
