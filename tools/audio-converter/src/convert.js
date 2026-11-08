'use strict';
// Electron-free ffmpeg wrapper (testable with plain Node).
let fs;
try { fs = require('original-fs'); } catch { fs = require('fs'); }
const path = require('path');
const { spawn } = require('child_process');

const INPUT_EXTS = ['.mp3', '.flac', '.wav', '.ogg', '.oga', '.opus', '.m4a', '.m4b', '.aac', '.wma', '.aif', '.aiff', '.ape', '.wv', '.mka', '.mp4', '.mkv', '.webm', '.mov'];

// codec / muxer per output format. `lossy` formats take a bitrate; `cover` = can carry attached cover art.
const FORMATS = {
  mp3:  { ext: '.mp3',  codec: 'libmp3lame', muxer: 'mp3',   lossy: true,  cover: true,  bitrates: [96, 128, 192, 256, 320], dflt: 192 },
  m4a:  { ext: '.m4a',  codec: 'aac',        muxer: 'ipod',  lossy: true,  cover: true,  bitrates: [96, 128, 192, 256, 320], dflt: 192 },
  ogg:  { ext: '.ogg',  codec: 'libvorbis',  muxer: 'ogg',   lossy: true,  cover: false, bitrates: [96, 128, 192, 256, 320], dflt: 192 },
  opus: { ext: '.opus', codec: 'libopus',    muxer: 'opus',  lossy: true,  cover: false, bitrates: [64, 96, 128, 160, 192], dflt: 128 },
  flac: { ext: '.flac', codec: 'flac',       muxer: 'flac',  lossy: false, cover: true },
  wav:  { ext: '.wav',  codec: 'pcm_s16le',  muxer: 'wav',   lossy: false, cover: false },
};
const SAMPLE_RATES = [0, 22050, 32000, 44100, 48000, 96000]; // 0 = keep

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

function normalizeOptions(o = {}) {
  const fmt = FORMATS[o.format];
  if (!fmt) throw new Error(`Unsupported output format: ${o.format}`);
  const br = Math.round(Number(o.bitrate));
  const sr = Math.round(Number(o.sampleRate));
  return {
    format: o.format,
    bitrate: fmt.lossy ? (fmt.bitrates.includes(br) ? br : fmt.dflt) : null,
    sampleRate: SAMPLE_RATES.includes(sr) ? sr : 0,
    channels: [1, 2].includes(Number(o.channels)) ? Number(o.channels) : 0,
    keepTags: o.keepTags !== false,
    outDir: typeof o.outDir === 'string' && o.outDir ? o.outDir : null,
  };
}

/** Build the ffmpeg argument list. `probe` supplies the attached-picture stream index, if any. */
function buildArgs(input, output, rawOpts, probe = {}) {
  const o = normalizeOptions(rawOpts);
  const fmt = FORMATS[o.format];
  const args = ['-hide_banner', '-nostdin', '-loglevel', 'error', '-nostats', '-progress', 'pipe:1',
    '-protocol_whitelist', 'file', '-i', input];
  args.push('-map', '0:a:0');
  const withCover = o.keepTags && fmt.cover && probe.coverStream != null;
  if (withCover) args.push('-map', `0:${probe.coverStream}`);
  args.push('-map_metadata', o.keepTags ? '0' : '-1', '-map_chapters', '-1');
  args.push('-c:a', fmt.codec);
  if (withCover) args.push('-c:v', 'copy', '-disposition:v:0', 'attached_pic');
  if (fmt.lossy) args.push('-b:a', `${o.bitrate}k`);
  if (o.format === 'mp3') args.push('-id3v2_version', '3');
  if (o.sampleRate) args.push('-ar', String(o.sampleRate));
  if (o.channels) args.push('-ac', String(o.channels));
  args.push('-f', fmt.muxer, '-y', output); // '-y' is safe: output is always our own fresh ".part" file
  return args;
}

/** Run `ffmpeg -i file` and parse what we need from its stderr. */
function probe(input) {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpegPath(), ['-hide_banner', '-nostdin', '-protocol_whitelist', 'file', '-i', input], { windowsHide: true });
    let err = '';
    // setEncoding (not `err += buffer`): a multi-byte character split across two chunks must not turn into U+FFFD.
    p.stderr.setEncoding('utf8');
    p.stderr.on('data', (d) => { err += d; if (err.length > 200000) err = err.slice(-200000); });
    p.on('error', (e) => reject(new Error(e.code === 'ENOENT' ? 'ffmpeg was not found' : e.message)));
    p.on('close', () => {
      const dur = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(err);
      const audio = /Stream #0:(\d+)[^\n]*Audio:\s*([^,\n(]+)/.exec(err);
      const hz = /Audio:[^\n]*?(\d+) Hz/.exec(err);
      const kbps = /Audio:[^\n]*?(\d+) kb\/s/.exec(err);
      const cover = /Stream #0:(\d+)[^\n]*Video:[^\n]*\(attached pic\)/.exec(err);
      // Tags: file-level block (MP3/FLAC/M4A) and the audio stream's block (Ogg Vorbis / Opus keep them there).
      const meta = {};
      const streamMeta = {};
      let section = null;
      for (const line of err.split(/\r?\n/)) {
        const head = /^\s{2}(Duration:|Stream #0:\d+)/.exec(line);
        if (/^\s{2}Metadata:/.test(line)) section = 'file';
        else if (head && head[1] === 'Duration:') section = null;
        else if (head) section = /Audio:/.test(line) ? 'stream' : null;
        else if (/^\s{4}Metadata:/.test(line) && section === 'stream') section = 'stream';
        const m = /^\s{4,6}(\w+)\s*:\s*(.+)$/.exec(line);
        if (m && section && !/^(Metadata|Duration|Stream)$/i.test(m[1])) (section === 'file' ? meta : streamMeta)[m[1].toLowerCase()] = m[2].trim();
      }
      for (const [k, v] of Object.entries(streamMeta)) if (!(k in meta)) meta[k] = v;
      if (!dur || !audio) {
        const reason = /No such file|Invalid data|does not contain any stream|Permission denied/i.exec(err);
        return reject(new Error(reason ? `Cannot read this file (${reason[0].toLowerCase()})` : 'Not a readable audio file'));
      }
      resolve({
        durationSec: Number(dur[1]) * 3600 + Number(dur[2]) * 60 + Number(dur[3]),
        codec: audio[2].trim(), sampleRate: hz ? Number(hz[1]) : 0, bitrate: kbps ? Number(kbps[1]) : 0,
        coverStream: cover ? Number(cover[1]) : null, tags: meta,
      });
    });
  });
}

function uniquePath(dir, base, ext) {
  let c = path.join(dir, base + ext);
  for (let i = 1; fs.existsSync(c); i++) c = path.join(dir, `${base} (${i})${ext}`);
  return c;
}

/**
 * Convert one file. Writes to a temp ".part" file next to the target, then renames, so a cancelled or
 * failed conversion never leaves a broken file behind and nothing is ever overwritten.
 * @param {{onProgress?:(frac:number)=>void, signal?:AbortSignal}} hooks
 */
async function convertOne(input, rawOpts, hooks = {}) {
  const opts = normalizeOptions(rawOpts);
  if (!path.isAbsolute(input)) throw new Error('Input path must be absolute');
  if (!isSupportedInput(input)) throw new Error('Unsupported file type');
  const info = await probe(input);
  const outDir = opts.outDir || path.dirname(input);
  await fs.promises.mkdir(outDir, { recursive: true });
  const ext = FORMATS[opts.format].ext;
  const final = uniquePath(outDir, path.basename(input, path.extname(input)), ext);
  const part = `${final}.${process.pid}.part`;
  const args = buildArgs(input, part, opts, info);

  const t0 = Date.now();
  try {
    await new Promise((resolve, reject) => {
      const p = spawn(ffmpegPath(), args, { windowsHide: true });
      let err = '', buf = '';
      p.stdout.setEncoding('utf8'); p.stderr.setEncoding('utf8');
      const onAbort = () => { p.kill(); };
      if (hooks.signal) { if (hooks.signal.aborted) { p.kill(); } else hooks.signal.addEventListener('abort', onAbort, { once: true }); }
      p.stdout.on('data', (d) => {
        buf += d;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
          const m = /^out_time_(?:us|ms)=(\d+)/.exec(line); // both report microseconds
          if (m && info.durationSec > 0 && hooks.onProgress) hooks.onProgress(Math.min(0.99, Number(m[1]) / 1e6 / info.durationSec));
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
    const out = fs.statSync(part);
    if (out.size === 0) throw new Error('ffmpeg produced an empty file');
    fs.renameSync(part, final);
    if (hooks.onProgress) hooks.onProgress(1);
    return { input, output: final, inBytes: fs.statSync(input).size, outBytes: out.size, seconds: (Date.now() - t0) / 1000, durationSec: info.durationSec };
  } catch (e) {
    fs.rmSync(part, { force: true });
    throw e;
  }
}

module.exports = { convertOne, probe, buildArgs, normalizeOptions, uniquePath, ffmpegPath, isSupportedInput, INPUT_EXTS, FORMATS, SAMPLE_RATES };
