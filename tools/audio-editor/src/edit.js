'use strict';
// Electron-free ffmpeg side of the editor (testable with plain Node): reading a file's facts, drawing its waveform,
// finding silence, and rendering the edit. Originals are only ever read. The result goes to a fresh ".part" file that is
// renamed when it is complete, so nothing is overwritten and a cancelled export leaves nothing behind.
let fs;
try { fs = require('original-fs'); } catch { fs = require('fs'); }
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const P = require('./plan');

const { UserError } = P;
const fail = (m) => { throw new UserError(m); };

const PEAKS_PER_SEC = 200;       // waveform resolution: one min/max pair per 5 ms
const PEAK_RATE = 16000;         // the waveform is drawn from a 16 kHz mono copy: 80 samples per pair
const LOSSY_RATES = [8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000];
const SILENCE_DB = -50;
const SILENT_LUFS = -69;         // below this there is nothing to normalise (loudnorm reports -70 for silence)
const SILENT_PEAK_DB = -70;
const SILENCE_PAD = 0.05;        // keep this much of the silence, so a trimmed start/end doesn't sound clipped

/** The bundled ffmpeg (unpacked from asar when packaged), else `ffmpeg` on PATH. */
function ffmpegPath() {
  try {
    const p = require('ffmpeg-static');
    if (p) {
      const real = p.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
      if (fs.existsSync(real)) return real;
    }
  } catch { /* fall through */ }
  return 'ffmpeg';
}

const NULL_DEVICE = process.platform === 'win32' ? 'NUL' : '/dev/null';

// ---- running ffmpeg --------------------------------------------------------------------------------------------------
/**
 * Run ffmpeg to completion. Resolves with its stderr (the tail). `hooks.signal` aborts it (SIGKILL: a half-written
 * file is thrown away anyway); `onSeconds(t)` is told how far along the output is.
 */
function run(args, hooks = {}, onSeconds = null) {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpegPath(), args, { windowsHide: true });
    let err = '';
    let buf = '';
    p.stdout.setEncoding('utf8'); p.stderr.setEncoding('utf8');
    const onAbort = () => { p.kill('SIGKILL'); };
    if (hooks.signal) { if (hooks.signal.aborted) onAbort(); else hooks.signal.addEventListener('abort', onAbort, { once: true }); }
    p.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        const m = /^out_time_(?:us|ms)=(\d+)/.exec(line); // both report microseconds
        if (m && onSeconds) onSeconds(Number(m[1]) / 1e6);
      }
    });
    p.stderr.on('data', (d) => { err += d; if (err.length > 120000) err = err.slice(-120000); });
    p.on('error', (e) => reject(new Error(e.code === 'ENOENT' ? 'ffmpeg was not found' : e.message)));
    p.on('close', (code) => {
      if (hooks.signal) hooks.signal.removeEventListener('abort', onAbort);
      if (hooks.signal && hooks.signal.aborted) return reject(Object.assign(new Error('Cancelled'), { cancelled: true }));
      if (code === 0) return resolve(err);
      const lines = err.trim().split(/\r?\n/).filter((l) => l && !/^\[(?:Parsed|silencedetect|out#)/.test(l));
      reject(new Error(lines.length ? lines[lines.length - 1].slice(0, 220) : `ffmpeg exited with code ${code}`));
    });
  });
}

// ---- reading a file --------------------------------------------------------------------------------------------------
/** Turn ffmpeg's `-i` report into the facts we need. Throws a readable UserError if it isn't audio. */
function parseProbe(err) {
  const dur = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(err);
  if (!dur) {
    const reason = /No such file|Invalid data|does not contain any stream|Permission denied|Duration: N\/A/i.exec(err);
    throw new UserError(reason ? `Cannot read this file (${reason[0].toLowerCase()})` : 'Not a readable audio file');
  }
  const audio = /Stream #0:(\d+)[^\n]*?: Audio: ([^\n]*)/.exec(err);
  if (!audio) throw new UserError('This file has no audio');
  const line = audio[2];
  const rate = /(\d+) Hz/.exec(line);
  let channels = 2;
  if (/\bmono\b/.test(line)) channels = 1;
  else if (/\bstereo\b/.test(line)) channels = 2;
  else { const m = /(\d+) channels/.exec(line) || /(\d)\.(\d)/.exec(line); if (m) channels = m[2] !== undefined ? Number(m[1]) + Number(m[2]) : Number(m[1]); }
  let coverStream = null;
  const re = /Stream #0:(\d+)[^\n]*?: Video: [^\n]*attached pic/g;
  const cover = re.exec(err);
  if (cover) coverStream = Number(cover[1]);
  const kbps = /(\d+) kb\/s/.exec(line);
  return {
    duration: Number(dur[1]) * 3600 + Number(dur[2]) * 60 + Number(dur[3]),
    codec: line.split(/[,(\s]/)[0],
    rate: rate ? Number(rate[1]) : 44100,
    channels: channels === 1 ? 1 : 2,
    sourceChannels: channels,
    coverStream,
    kbps: kbps ? Number(kbps[1]) : 0,
  };
}

function probe(input) {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpegPath(), ['-hide_banner', '-nostdin', '-protocol_whitelist', 'file', '-i', input], { windowsHide: true });
    let err = '';
    p.stderr.setEncoding('utf8');
    p.stderr.on('data', (d) => { err += d; if (err.length > 300000) err = err.slice(-300000); });
    p.on('error', (e) => reject(new UserError(e.code === 'ENOENT' ? 'ffmpeg was not found' : e.message)));
    p.on('close', () => { try { resolve(parseProbe(err)); } catch (e) { reject(e); } });
  });
}

/**
 * The waveform: one (min, max) pair per 5 ms, as 16-bit values, from a 16 kHz mono copy of the file.
 * Streams ffmpeg's output so an hour of audio never sits in memory as PCM.
 */
function peaks(input, hooks = {}) {
  return new Promise((resolve, reject) => {
    const args = ['-hide_banner', '-nostdin', '-loglevel', 'error', '-protocol_whitelist', 'file', '-i', input, '-vn', '-map', '0:a:0', '-ac', '1', '-ar', String(PEAK_RATE), '-f', 's16le', '-'];
    const p = spawn(ffmpegPath(), args, { windowsHide: true });
    const per = PEAK_RATE / PEAKS_PER_SEC;
    let out = new Int16Array(4096 * 2);
    let n = 0;                    // finished pairs
    let count = 0, lo = 32767, hi = -32768;
    let carry = null;
    let err = '';
    const push = (a, b) => {
      if (n * 2 + 2 > out.length) { const bigger = new Int16Array(out.length * 2); bigger.set(out); out = bigger; }
      out[n * 2] = a; out[n * 2 + 1] = b; n++;
    };
    const onAbort = () => p.kill('SIGKILL');
    if (hooks.signal) { if (hooks.signal.aborted) onAbort(); else hooks.signal.addEventListener('abort', onAbort, { once: true }); }
    p.stderr.setEncoding('utf8');
    p.stderr.on('data', (d) => { err += d; if (err.length > 5000) err = err.slice(-5000); });
    p.stdout.on('data', (chunk) => {
      let buf = chunk;
      if (carry) { buf = Buffer.concat([carry, chunk]); carry = null; }
      const even = buf.length - (buf.length % 2);
      if (even !== buf.length) carry = buf.subarray(even);
      for (let i = 0; i < even; i += 2) {
        const v = buf.readInt16LE(i);
        if (v < lo) lo = v;
        if (v > hi) hi = v;
        if (++count === per) { push(lo, hi); count = 0; lo = 32767; hi = -32768; }
      }
    });
    p.on('error', (e) => reject(new UserError(e.code === 'ENOENT' ? 'ffmpeg was not found' : e.message)));
    p.on('close', (code) => {
      if (hooks.signal) hooks.signal.removeEventListener('abort', onAbort);
      if (hooks.signal && hooks.signal.aborted) return reject(Object.assign(new Error('Cancelled'), { cancelled: true }));
      if (count > 0) push(lo, hi);
      if (code !== 0 && n === 0) return reject(new Error(err.trim().split(/\r?\n/).pop() || `ffmpeg exited with code ${code}`));
      resolve({ data: out.slice(0, n * 2), perSec: PEAKS_PER_SEC });
    });
  });
}

/** Silent stretches of a file, as [{start, end}] in seconds. A silence that runs to the end of the file ends at `duration`. */
async function silences(input, duration, hooks = {}) {
  const err = await run(['-hide_banner', '-nostdin', '-nostats', '-loglevel', 'info', '-protocol_whitelist', 'file', '-i', input, '-vn', '-map', '0:a:0',
    '-af', `silencedetect=noise=${SILENCE_DB}dB:d=0.1`, '-f', 'null', '-y', NULL_DEVICE], hooks);
  const found = [];
  let open = null;
  for (const line of err.split(/\r?\n/)) {
    const s = /silence_start:\s*(-?[\d.]+)/.exec(line);
    if (s) { open = Math.max(0, Number(s[1])); continue; }
    const e = /silence_end:\s*(-?[\d.]+)/.exec(line);
    if (e && open != null) { found.push({ start: open, end: Math.min(duration, Number(e[1])) }); open = null; }
  }
  if (open != null) found.push({ start: open, end: duration });
  return found;
}

/**
 * Cut the silence off the start of the first piece and the end of the last piece of the result.
 * `list0` / `listN` are silences() of the first / last file. Never removes a whole file.
 */
function trimEdges(items, list0, listN) {
  const out = items.map((it) => ({ ...it, cuts: it.cuts.map((c) => [...c]) }));
  const first = out[0];
  const last = out[out.length - 1];
  const f = P.keptRanges(first.cuts, first.duration)[0];
  if (f) {
    const s = list0.find((x) => f[0] >= x.start - 0.02 && f[0] <= x.end - SILENCE_PAD * 2);
    if (s) { const to = Math.min(f[1] - P.MIN_KEEP, s.end - SILENCE_PAD); if (to - f[0] >= P.MIN_PART) first.cuts.push([f[0], to]); }
  }
  const lr = P.keptRanges(last.cuts, last.duration);
  const l = lr[lr.length - 1];
  if (l) {
    const s = listN.find((x) => l[1] <= x.end + 0.02 && l[1] >= x.start + SILENCE_PAD * 2);
    if (s) { const from = Math.max(l[0] + P.MIN_KEEP, s.start + SILENCE_PAD); if (l[1] - from >= P.MIN_PART) last.cuts.push([from, l[1]]); }
  }
  for (const it of out) it.cuts = P.normalizeCuts(it.cuts, it.duration);
  return out;
}

// ---- the edit as an ffmpeg job ---------------------------------------------------------------------------------------
const num = (n) => String(Math.round(n * 1e6) / 1e6);

function pickRate(items, opts) {
  const top = Math.max(...items.map((i) => i.rate));
  if (opts.format === 'opus') return 48000;
  if (!P.FORMATS[opts.format].lossy) return top;
  return LOSSY_RATES.filter((r) => r <= top).pop() || 8000;
}

/**
 * Everything ffmpeg needs for one run: the inputs (one per kept piece, each opened with its own -ss/-t), and a filter graph
 * that joins the pieces and applies fades, volume and normalisation.
 *  stage 'analyse' stops before normalisation/fades and measures (the first of two passes);
 *  stage 'final' writes the output. `analysis` is what the first pass measured.
 */
function buildJob(items, rawOpts, stage = 'final', analysis = null) {
  const opts = P.normalizeOptions(rawOpts, items[0] && items[0].path);
  const d = P.describe(items, opts);
  if (d.error) fail(d.error);
  const fmt = P.FORMATS[opts.format];
  const rate = pickRate(items, opts);
  const layout = items.every((i) => i.channels === 1) ? 'mono' : 'stereo';
  const inputs = [];
  const filters = [];
  const itemLabels = [];
  items.forEach((item, idx) => {
    const parts = P.keptRanges(item.cuts, item.duration);
    const labels = [];
    parts.forEach(([s, e]) => {
      const k = inputs.length;
      inputs.push({ path: item.path, ss: s, t: e - s });
      const chain = [`aformat=sample_fmts=fltp:sample_rates=${rate}:channel_layouts=${layout}`];
      if (s > 0.0005) chain.push(`afade=t=in:st=0:d=${P.MICRO_FADE}`);
      if (e < item.duration - 0.0005) chain.push(`afade=t=out:st=${num(Math.max(0, e - s - P.MICRO_FADE))}:d=${P.MICRO_FADE}`);
      const label = parts.length === 1 ? `i${idx}` : `p${k}`;
      filters.push(`[${k}:a:0]${chain.join(',')}[${label}]`);
      labels.push(label);
    });
    if (parts.length > 1) filters.push(`${labels.map((l) => `[${l}]`).join('')}concat=n=${parts.length}:v=0:a=1[i${idx}]`);
    itemLabels.push(`i${idx}`);
  });

  // several files: one after the other, with a gap or a crossfade between them
  let current = itemLabels[0];
  if (items.length > 1) {
    const sec = opts.joinSeconds;
    if (opts.join === 'cross' && sec > 0) {
      itemLabels.slice(1).forEach((l, n) => {
        const out = `x${n}`;
        filters.push(`[${current}][${l}]acrossfade=d=${num(sec)}:c1=tri:c2=tri[${out}]`);
        current = out;
      });
    } else {
      const ordered = itemLabels.map((l, n) => {
        if (opts.join === 'gap' && sec > 0 && n < itemLabels.length - 1) { filters.push(`[${l}]apad=pad_dur=${num(sec)}[g${n}]`); return `g${n}`; }
        return l;
      });
      filters.push(`${ordered.map((l) => `[${l}]`).join('')}concat=n=${ordered.length}:v=0:a=1[joined]`);
      current = 'joined';
    }
  }

  // volume
  const post = [];
  const notes = [];
  if (opts.normalize === 'off' && opts.gain !== 0) {
    post.push(`volume=${num(opts.gain)}dB`);
    if (opts.gain > 0) post.push('alimiter=limit=0.97:level=0'); // a boost must not clip
  }
  if (stage === 'analyse') {
    if (opts.normalize === 'loudness') post.push(`loudnorm=I=${opts.loudness}:TP=-1.5:LRA=11:print_format=json`);
    else if (opts.normalize === 'peak') post.push('volumedetect');
  } else if (opts.normalize === 'loudness' && analysis && analysis.loudness) {
    const a = analysis.loudness;
    post.push(`loudnorm=I=${opts.loudness}:TP=-1.5:LRA=11:measured_I=${a.i}:measured_TP=${a.tp}:measured_LRA=${a.lra}:measured_thresh=${a.thresh}:offset=${a.offset}:linear=true`);
    post.push(`aresample=${rate}`); // loudnorm works at 192 kHz
  } else if (opts.normalize === 'peak' && analysis && Number.isFinite(analysis.peakGain)) {
    post.push(`volume=${num(analysis.peakGain)}dB`);
  }
  if (stage === 'final') {
    if (opts.fadeIn > 0) post.push(`afade=t=in:st=0:d=${num(opts.fadeIn)}`);
    if (opts.fadeOut > 0) post.push(`afade=t=out:st=${num(Math.max(0, d.seconds - opts.fadeOut))}:d=${num(opts.fadeOut)}`);
  }
  filters.push(`[${current}]${post.length ? post.join(',') : 'anull'}[out]`);

  return { opts, fmt, rate, layout, inputs, filters, seconds: d.seconds, notes };
}

/** Arguments for one ffmpeg run. `graphFile` holds the filter graph (long edits would not fit on a command line). */
function jobArgs(job, graphFile, output, stage) {
  const args = ['-hide_banner', '-nostdin', '-loglevel', stage === 'analyse' ? 'info' : 'error', '-nostats', '-progress', 'pipe:1', '-protocol_whitelist', 'file'];
  for (const i of job.inputs) {
    if (i.ss > 0) args.push('-ss', num(i.ss));
    args.push('-t', num(i.t), '-i', i.path);
  }
  args.push('-filter_complex_script', graphFile, '-map', '[out]');
  if (stage === 'analyse') return [...args, '-f', 'null', '-y', NULL_DEVICE];
  const { opts, fmt } = job;
  const first = job.firstItem;
  const withCover = opts.keepTags && fmt.cover && first.coverStream != null;
  if (withCover) args.push('-map', `0:${first.coverStream}`);
  args.push('-map_metadata', opts.keepTags ? '0' : '-1', '-map_chapters', '-1');
  if (opts.keepTags && job.joined) args.push('-metadata', 'title=', '-metadata', 'track=', '-metadata', 'disc=');
  args.push('-c:a', fmt.codec);
  if (withCover) args.push('-c:v', 'copy', '-disposition:v:0', 'attached_pic');
  if (fmt.lossy) args.push('-b:a', `${opts.bitrate}k`);
  if (opts.format === 'mp3') args.push('-id3v2_version', '3');
  if (opts.format === 'm4a') args.push('-movflags', '+faststart');
  args.push('-ar', String(job.rate), '-f', fmt.muxer, '-y', output); // '-y' is safe: output is always our own fresh ".part" file
  return args;
}

/** loudnorm prints its measurements as a JSON block; volumedetect prints "max_volume: -3.1 dB". */
function parseAnalysis(err, opts) {
  if (opts.normalize === 'loudness') {
    const blocks = err.match(/\{[^{}]*"input_i"[^{}]*\}/g);
    if (!blocks) return { silent: true };
    const j = JSON.parse(blocks[blocks.length - 1]);
    const v = (k) => Number(j[k]);
    if (![v('input_i'), v('input_tp'), v('input_lra'), v('input_thresh'), v('target_offset')].every(Number.isFinite) || v('input_i') <= SILENT_LUFS) return { silent: true }; // "-inf" or the measuring floor
    return { loudness: { i: v('input_i'), tp: v('input_tp'), lra: v('input_lra'), thresh: v('input_thresh'), offset: v('target_offset') } };
  }
  if (opts.normalize === 'peak') {
    const m = /max_volume:\s*(-?[\d.]+|-inf)\s*dB/.exec(err);
    const max = m ? Number(m[1]) : NaN;
    if (!Number.isFinite(max) || max <= SILENT_PEAK_DB) return { silent: true }; // volumedetect reports -91 dB for digital silence
    return { peakGain: P.PEAK_TARGET - max, peak: max };
  }
  return {};
}

function uniquePath(dir, base, ext) {
  const safe = base.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/[. ]+$/, '').slice(0, 120) || 'audio';
  let c = path.join(dir, safe + ext);
  for (let i = 1; fs.existsSync(c); i++) c = path.join(dir, `${safe} (${i})${ext}`);
  return c;
}

/**
 * Render the edit.
 * @param items    [{path, duration, rate, channels, coverStream, cuts}]  (as the window holds them)
 * @param hooks    { onProgress(fraction), signal, output }  -  `output` writes to exactly that path (used for previews)
 * @returns {{output, bytes, seconds, notes}}
 */
async function render(rawItems, rawOpts, hooks = {}) {
  if (!Array.isArray(rawItems) || !rawItems.length) fail('Add a file first');
  for (const it of rawItems) {
    if (!it || typeof it.path !== 'string' || !path.isAbsolute(it.path)) fail('Input path must be absolute');
    if (!P.isSupportedInput(it.path)) fail('Unsupported file type');
  }
  let items = rawItems.map(P.normalizeItem);
  const opts = P.normalizeOptions(rawOpts, items[0].path);
  const report = (f) => { if (hooks.onProgress) hooks.onProgress(Math.max(0, Math.min(1, f))); };
  const t0 = Date.now();

  if (opts.trimSilence) {
    const l0 = await silences(items[0].path, items[0].duration, hooks);
    const lN = items.length === 1 ? l0 : await silences(items[items.length - 1].path, items[items.length - 1].duration, hooks);
    items = trimEdges(items, l0, lN);
  }
  const probeJob = buildJob(items, opts, 'final'); // validates everything before any file or folder is made
  const notes = [];
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audioedit-'));
  const graphOf = (job, name) => { const f = path.join(tmpDir, name); fs.writeFileSync(f, job.filters.join(';\n')); return f; };
  let part = null;
  try {
    let analysis = null;
    const needsAnalysis = opts.normalize !== 'off';
    if (needsAnalysis) {
      const aj = buildJob(items, opts, 'analyse');
      const err = await run(jobArgs({ ...aj, firstItem: items[0] }, graphOf(aj, 'analyse.txt'), null, 'analyse'), hooks, (t) => report((t / Math.max(0.1, aj.seconds)) * 0.3));
      analysis = parseAnalysis(err, opts);
      if (analysis.silent) notes.push('The audio is silent (or almost), so it was not normalized.');
    }
    const job = buildJob(items, opts, 'final', analysis);
    job.firstItem = items[0];
    job.joined = items.length > 1;
    let final;
    if (hooks.output) final = hooks.output;
    else {
      const dir = opts.outDir || path.dirname(items[0].path);
      fs.mkdirSync(dir, { recursive: true });
      const base = opts.name || `${path.basename(items[0].path, path.extname(items[0].path))} (${items.length > 1 ? 'joined' : 'edited'})`;
      final = uniquePath(dir, base, job.fmt.ext);
    }
    part = `${final}.${process.pid}.part`;
    const from = needsAnalysis ? 0.3 : 0;
    await run(jobArgs(job, graphOf(job, 'final.txt'), part, 'final'), hooks, (t) => report(from + (t / Math.max(0.1, job.seconds)) * (1 - from) * 0.99));
    const st = fs.statSync(part);
    if (st.size === 0) throw new Error('ffmpeg produced an empty file');
    fs.renameSync(part, final);
    part = null;
    report(1);
    return { output: final, bytes: st.size, seconds: job.seconds, elapsed: (Date.now() - t0) / 1000, notes, analysis, format: opts.format, parts: job.inputs.length, expected: probeJob.seconds };
  } finally {
    if (part) fs.rmSync(part, { force: true });
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

/** Encoders we depend on; the window uses this to explain a broken ffmpeg instead of failing every export. */
function checkEncoders() {
  return new Promise((resolve) => {
    const p = spawn(ffmpegPath(), ['-hide_banner', '-encoders'], { windowsHide: true });
    let out = '';
    p.stdout.setEncoding('utf8');
    p.stdout.on('data', (d) => { out += d; });
    p.on('error', () => resolve({ ok: false, missing: ['ffmpeg'] }));
    p.on('close', () => {
      const missing = ['libmp3lame', 'aac', 'libvorbis', 'libopus', 'flac', 'pcm_s16le'].filter((e) => !new RegExp(`\\s${e}\\s`).test(out));
      resolve({ ok: missing.length === 0, missing });
    });
  });
}

module.exports = {
  ffmpegPath, run, probe, parseProbe, peaks, silences, trimEdges, buildJob, jobArgs, parseAnalysis, uniquePath, render, checkEncoders,
  PEAKS_PER_SEC, UserError,
};
