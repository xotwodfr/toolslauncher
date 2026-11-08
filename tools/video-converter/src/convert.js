'use strict';
// Electron-free ffmpeg wrapper (testable with plain Node).
let fs;
try { fs = require('original-fs'); } catch { fs = require('fs'); }
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const INPUT_EXTS = ['.mp4', '.m4v', '.mov', '.mkv', '.webm', '.avi', '.wmv', '.flv', '.mpg', '.mpeg', '.ts', '.m2ts', '.mts', '.3gp', '.ogv', '.gif'];
const FORMATS = {
  mp4:  { ext: '.mp4',  muxer: 'mp4',  label: 'MP4 (H.264 + AAC)', audioKbps: 128 },
  webm: { ext: '.webm', muxer: 'webm', label: 'WebM (VP9 + Opus)', audioKbps: 96 },
  gif:  { ext: '.gif',  muxer: 'gif',  label: 'Animated GIF (no sound)', audioKbps: 0 },
};
// constant-quality values: lower = better and bigger
const QUALITY = { high: { mp4: 19, webm: 30 }, balanced: { mp4: 23, webm: 34 }, small: { mp4: 28, webm: 40 } };
const MAX_HEIGHTS = [0, 2160, 1440, 1080, 720, 480, 360, 240]; // 0 = keep
const FPS_CAPS = [0, 60, 30, 24, 15];                     // 0 = keep
const GIF_WIDTHS = [240, 320, 480, 640, 800];
const GIF_FPS = [8, 10, 12, 15, 20];
const MAX_GIF_SECONDS = 120;
const MIN_VIDEO_KBPS = 50;

class UserError extends Error {}
const fail = (m) => { throw new UserError(m); };

const isSupportedInput = (f) => INPUT_EXTS.includes(path.extname(f).toLowerCase());

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

/** "90", "1:30", "01:02:03.5" -> seconds (number), '' / null -> null. Throws UserError when unreadable. */
function parseTime(text, what) {
  if (text == null) return null;
  const s = String(text).trim();
  if (!s) return null;
  const m = /^(?:(?:(\d+):)?(\d{1,2}):)?(\d+(?:\.\d+)?)$/.exec(s);
  if (!m) fail(`${what} time "${s}" is not valid. Use seconds (90) or minutes:seconds (1:30)`);
  // groups: hours?, minutes?, seconds. With one colon, the first number is minutes.
  const parts = s.split(':').map(Number);
  let sec;
  if (parts.length === 1) sec = parts[0];
  else if (parts.length === 2) sec = parts[0] * 60 + parts[1];
  else sec = parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (!Number.isFinite(sec) || sec < 0) fail(`${what} time "${s}" is not valid`);
  return sec;
}

function pick(list, value, dflt) { const n = Number(value); return list.includes(n) ? n : dflt; }

function normalizeOptions(o = {}) {
  if (!FORMATS[o.format]) fail(`Unsupported output format: ${o.format}`);
  const target = o.targetMb === '' || o.targetMb == null ? null : Number(o.targetMb);
  if (target != null && !(target >= 0.1 && target <= 50000)) fail('Target size must be between 0.1 and 50000 MB');
  const start = parseTime(o.start, 'Start');
  const end = parseTime(o.end, 'End');
  if (start != null && end != null && end <= start) fail('The end time must be later than the start time');
  return {
    format: o.format,
    quality: QUALITY[o.quality] ? o.quality : 'balanced',
    maxHeight: pick(MAX_HEIGHTS, o.maxHeight, 0),
    fps: pick(FPS_CAPS, o.fps, 0),
    targetMb: o.format === 'gif' ? null : target,
    start, end,
    audio: o.audio === 'remove' ? 'remove' : 'keep',
    stripMeta: !!o.stripMeta,
    gifWidth: pick(GIF_WIDTHS, o.gifWidth, 480),
    gifFps: pick(GIF_FPS, o.gifFps, 12),
    outDir: typeof o.outDir === 'string' && o.outDir ? o.outDir : null,
  };
}

/** Seconds of video that will actually be written (after trimming). */
function spanOf(opts, probe) {
  const from = opts.start || 0;
  if (probe.durationSec > 0 && from >= probe.durationSec) fail(`The start time is past the end of the video (${probe.durationSec.toFixed(1)} s long)`);
  const to = opts.end != null ? Math.min(opts.end, probe.durationSec || opts.end) : probe.durationSec;
  return to > 0 ? Math.max(0.1, to - from) : 0;
}

/** Video bitrate (kbit/s) that should land a file near `targetMb`, given the length and audio. */
function bitrateFor(targetMb, seconds, audioKbps) {
  const kbit = targetMb * 8 * 1024 * 0.96 - audioKbps * seconds; // 4% headroom for container overhead
  return Math.floor(kbit / seconds);
}

const NULL_DEVICE = process.platform === 'win32' ? 'NUL' : '/dev/null';

/** Does this conversion need two passes? (A size target does: a single pass cannot hit it reliably, especially VP9.) */
const needsTwoPass = (o) => o.format !== 'gif' && o.targetMb != null;

/**
 * Build the ffmpeg argument list. `probe` is the result of probe().
 * `passInfo` = { pass: 1 | 2, log } for the two-pass size-target mode: pass 1 only analyses (no audio, no output file).
 */
function buildArgs(input, output, rawOpts, probe, passInfo = null) {
  const o = normalizeOptions(rawOpts);
  const fmt = FORMATS[o.format];
  if (probe.videoIndex == null) fail('This file has no video');
  const span = spanOf(o, probe);
  const analysing = !!passInfo && passInfo.pass === 1;
  const args = ['-hide_banner', '-nostdin', '-loglevel', 'error', '-nostats', '-progress', 'pipe:1', '-protocol_whitelist', 'file'];
  if (o.start) args.push('-ss', String(o.start));
  args.push('-i', input);
  if (o.end != null || o.start) args.push('-t', String(span));
  args.push('-map', `0:${probe.videoIndex}`);
  const hasAudio = o.format !== 'gif' && o.audio === 'keep' && probe.hasAudio; // the finished file has sound
  const withAudio = hasAudio && !analysing;                                    // ...but the analysis pass does not need it
  if (withAudio) args.push('-map', '0:a:0');
  args.push('-sn', '-dn');
  args.push(...(o.stripMeta ? ['-map_metadata', '-1', '-map_chapters', '-1'] : ['-map_metadata', '0']));

  const filters = [];
  if (o.format === 'gif') {
    if (span > MAX_GIF_SECONDS) fail(`A GIF this long would be enormous (${Math.round(span)} s). Trim it to ${MAX_GIF_SECONDS} seconds or less`);
    const fpsOut = probe.fps > 0 ? Math.min(o.gifFps, probe.fps) : o.gifFps;
    // one pass: pick the best 256 colours for this clip (palettegen), then use them (paletteuse)
    args.push('-an', '-loop', '0', '-vf',
      `fps=${fpsOut},scale='min(${o.gifWidth},iw)':-2:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle`);
  } else {
    if (o.maxHeight && probe.height > o.maxHeight) filters.push(`scale=-2:${o.maxHeight}`);
    if (o.fps && probe.fps > o.fps + 0.5) filters.push(`fps=${o.fps}`);
    if (filters.length) args.push('-vf', filters.join(','));
    let rate;
    if (o.targetMb != null) {
      rate = bitrateFor(o.targetMb, span || 1, hasAudio ? fmt.audioKbps : 0);
      if (span && rate < MIN_VIDEO_KBPS) {
        const needMb = Math.ceil(((MIN_VIDEO_KBPS + (hasAudio ? fmt.audioKbps : 0)) * span) / 8 / 1024 / 0.96 * 10) / 10;
        fail(`${o.targetMb} MB is too small for ${Math.round(span)} seconds of video. Try at least ${needMb} MB, or trim the video`);
      }
    }
    const passFlags = rate && passInfo ? ['-pass', String(passInfo.pass), '-passlogfile', passInfo.log] : [];
    if (o.format === 'mp4') {
      args.push('-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'medium');
      if (rate) args.push('-b:v', `${rate}k`, ...passFlags);
      else args.push('-crf', String(QUALITY[o.quality].mp4));
      if (!analysing) args.push('-movflags', '+faststart');
      if (withAudio) args.push('-c:a', 'aac', '-b:a', `${fmt.audioKbps}k`);
    } else {
      args.push('-c:v', 'libvpx-vp9', '-pix_fmt', 'yuv420p', '-row-mt', '1', '-deadline', 'good', '-cpu-used', '4');
      if (rate) args.push('-b:v', `${rate}k`, ...passFlags);
      else args.push('-crf', String(QUALITY[o.quality].webm), '-b:v', '0');
      if (withAudio) args.push('-c:a', 'libopus', '-b:a', `${fmt.audioKbps}k`);
    }
    if (!withAudio) args.push('-an');
  }
  if (analysing) args.push('-f', 'null', '-y', NULL_DEVICE);
  else args.push('-f', fmt.muxer, '-y', output); // '-y' is safe: output is always our own fresh ".part" file
  return args;
}

/** Turn ffmpeg's `-i` report into the facts we need. Throws a readable Error if it isn't a video. */
function parseProbeOutput(err) {
  const dur = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(err);
  if (!dur) {
    const reason = /No such file|Invalid data|does not contain any stream|Permission denied|moov atom not found/i.exec(err);
    throw new UserError(reason ? `Cannot read this file (${reason[0].toLowerCase()})` : 'Not a readable video file');
  }
  // first real video stream (not cover art)
  let video = null;
  const re = /Stream #0:(\d+)[^\n]*?: Video: ([^\n]*)/g;
  for (let m; (m = re.exec(err));) { if (!/attached pic/.test(m[2])) { video = m; break; } }
  const audio = /Stream #0:\d+[^\n]*?: Audio:/.test(err);
  if (!video) throw new UserError(audio ? 'This file has sound but no video (use Audio Converter for audio files)' : 'This file has no video');
  const line = video[2];
  const size = /(?:^|[\s,\[(])(\d{2,5})x(\d{2,5})(?=[\s,\[(]|$)/.exec(line);
  const fps = /([\d.]+) fps/.exec(line) || /([\d.]+) tbr/.exec(line);
  return {
    durationSec: Number(dur[1]) * 3600 + Number(dur[2]) * 60 + Number(dur[3]),
    videoIndex: Number(video[1]),
    codec: line.split(/[,(\s]/)[0],
    width: size ? Number(size[1]) : 0, height: size ? Number(size[2]) : 0,
    fps: fps ? Number(fps[1]) : 0,
    pixFmt: (/,\s*(yuv\w+|rgb\w*|gbr\w+|pal8|gray\w*|nv12)[\w(),/ .-]*/.exec(line) || [])[1] || '',
    hasAudio: audio,
    raw: err,
  };
}

/** Run `ffmpeg -i file` and parse what we need from its stderr. */
function probe(input) {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpegPath(), ['-hide_banner', '-nostdin', '-protocol_whitelist', 'file', '-i', input], { windowsHide: true });
    let err = '';
    p.stderr.setEncoding('utf8'); // (not `err += buffer`: a multi-byte character split across chunks must not break)
    p.stderr.on('data', (d) => { err += d; if (err.length > 300000) err = err.slice(-300000); });
    p.on('error', (e) => reject(new UserError(e.code === 'ENOENT' ? 'ffmpeg was not found' : e.message)));
    p.on('close', () => { try { resolve(parseProbeOutput(err)); } catch (e) { reject(e); } });
  });
}

function uniquePath(dir, base, ext) {
  const safe = base.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 120) || 'video';
  let c = path.join(dir, safe + ext);
  for (let i = 1; fs.existsSync(c); i++) c = path.join(dir, `${safe} (${i})${ext}`);
  return c;
}

/** Run one ffmpeg process; reports progress as 0..1 of `span` seconds; honours the abort signal. */
function runFfmpeg(args, span, hooks, onFraction) {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpegPath(), args, { windowsHide: true });
    let err = '', buf = '', speed = 0;
    p.stdout.setEncoding('utf8'); p.stderr.setEncoding('utf8');
    const onAbort = () => { p.kill(); };
    if (hooks.signal) { if (hooks.signal.aborted) p.kill(); else hooks.signal.addEventListener('abort', onAbort, { once: true }); }
    p.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        const sp = /^speed=\s*([\d.]+)x/.exec(line);
        if (sp) speed = Number(sp[1]);
        const m = /^out_time_(?:us|ms)=(\d+)/.exec(line); // both report microseconds
        if (m && span > 0) onFraction(Math.min(0.99, Number(m[1]) / 1e6 / span), speed);
      }
    });
    p.stderr.on('data', (d) => { err += d; if (err.length > 20000) err = err.slice(-20000); });
    p.on('error', (e) => reject(new Error(e.code === 'ENOENT' ? 'ffmpeg was not found' : e.message)));
    p.on('close', (code) => {
      if (hooks.signal) hooks.signal.removeEventListener('abort', onAbort);
      if (hooks.signal && hooks.signal.aborted) return reject(Object.assign(new Error('Cancelled'), { cancelled: true }));
      if (code === 0) return resolve();
      const lines = err.trim().split(/\r?\n/).filter(Boolean);
      reject(new Error(lines.length ? lines[lines.length - 1].slice(0, 200) : `ffmpeg exited with code ${code}`));
    });
  });
}

/**
 * Convert one file. Writes to a temp ".part" file next to the target, then renames, so a cancelled or failed
 * conversion never leaves a broken file behind and nothing is ever overwritten.
 * With a size target it runs two passes (analyse, then encode), which is what makes the result land on the target.
 * @param {{onProgress?:(frac:number, speed:number)=>void, signal?:AbortSignal}} hooks
 */
async function convertOne(input, rawOpts, hooks = {}) {
  const opts = normalizeOptions(rawOpts);
  if (!path.isAbsolute(input)) fail('Input path must be absolute');
  if (!isSupportedInput(input)) fail('Unsupported file type');
  const info = await probe(input);
  const span = spanOf(opts, info);
  const twoPass = needsTwoPass(opts);
  const passLog = path.join(os.tmpdir(), `vidconv-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
  // Validate everything (bad trim, size target too small...) before creating any folder or file.
  const finalArgs = (output) => buildArgs(input, output, opts, info, twoPass ? { pass: 2, log: passLog } : null);
  finalArgs(path.join(os.tmpdir(), 'unused'));
  const outDir = opts.outDir || path.dirname(input);
  await fs.promises.mkdir(outDir, { recursive: true });
  const final = uniquePath(outDir, path.basename(input, path.extname(input)), FORMATS[opts.format].ext);
  const part = `${final}.${process.pid}.part`;

  const t0 = Date.now();
  const report = (offset, scale) => (f, speed) => { if (hooks.onProgress) hooks.onProgress(offset + f * scale, speed); };
  try {
    if (twoPass) {
      await runFfmpeg(buildArgs(input, part, opts, info, { pass: 1, log: passLog }), span, hooks, report(0, 0.5));
      await runFfmpeg(finalArgs(part), span, hooks, report(0.5, 0.5));
    } else {
      await runFfmpeg(finalArgs(part), span, hooks, report(0, 1));
    }
    const out = fs.statSync(part);
    if (out.size === 0) throw new Error('ffmpeg produced an empty file');
    fs.renameSync(part, final);
    if (hooks.onProgress) hooks.onProgress(1, 0);
    return { input, output: final, inBytes: fs.statSync(input).size, outBytes: out.size, seconds: (Date.now() - t0) / 1000, durationSec: span };
  } catch (e) {
    fs.rmSync(part, { force: true });
    throw e;
  } finally {
    if (twoPass) { // ffmpeg's pass-log files: "<log>-0.log" and (x264) "<log>-0.log.mbtree"
      const base = path.basename(passLog);
      for (const n of fs.readdirSync(os.tmpdir())) if (n.startsWith(base)) fs.rmSync(path.join(os.tmpdir(), n), { force: true });
    }
  }
}
/** Encoders we depend on; the UI uses this to explain a broken ffmpeg instead of failing every file. */
function checkEncoders() {
  return new Promise((resolve) => {
    const p = spawn(ffmpegPath(), ['-hide_banner', '-encoders'], { windowsHide: true });
    let out = '';
    p.stdout.setEncoding('utf8');
    p.stdout.on('data', (d) => { out += d; });
    p.on('error', () => resolve({ ok: false, missing: ['ffmpeg'] }));
    p.on('close', () => {
      const missing = ['libx264', 'libvpx-vp9', 'libopus', 'aac', 'gif'].filter((e) => !new RegExp(`\\s${e}\\s`).test(out));
      resolve({ ok: missing.length === 0, missing });
    });
  });
}

module.exports = {
  convertOne, probe, parseProbeOutput, parseTime, buildArgs, normalizeOptions, bitrateFor, spanOf, uniquePath, ffmpegPath,
  checkEncoders, isSupportedInput, needsTwoPass, MIN_VIDEO_KBPS, INPUT_EXTS, FORMATS, QUALITY, MAX_HEIGHTS, FPS_CAPS, GIF_WIDTHS, GIF_FPS, UserError,
};
