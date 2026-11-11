'use strict';
// Reading what is in a media file, and writing a new MP4 with the subtitles: burnt into the picture (ffmpeg's `subtitles`
// filter, libass) or added as a subtitle track players can switch on and off (mov_text). Electron-free.
//
// ffmpeg's filter syntax makes paths painful (on Windows "C:\" needs several layers of escaping), so ffmpeg runs inside a
// private work folder that holds the subtitle file and the bundled font under plain names: the filter only ever sees
// "subs.srt" and "fonts". The font is bundled (DejaVu Sans) so the burnt-in text looks the same on every computer, even one
// where ffmpeg finds no system fonts.
let fs;
try { fs = require('original-fs'); } catch { fs = require('fs'); }
const plainFs = require('fs');   // reads inside app.asar (the bundled font), which original-fs cannot
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const S = require('./subs');

class UserError extends Error {}
const cancelled = () => Object.assign(new Error('Cancelled'), { cancelled: true });

const FONT_NAME = 'DejaVu Sans';
function fontFiles() {
  try {
    const dir = path.join(path.dirname(require.resolve('dejavu-fonts-ttf/package.json')), 'ttf');
    return ['DejaVuSans.ttf', 'DejaVuSans-Bold.ttf'].map((f) => path.join(dir, f)).filter((f) => plainFs.existsSync(f));
  } catch { return []; }
}

/** What ffmpeg says about a file: length, and its picture and sound streams. */
function probe(ffmpeg, file) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, ['-hide_banner', '-i', file], { windowsHide: true });
    let text = '';
    child.stderr.on('data', (d) => { if (text.length < 60000) text += d; });
    child.on('error', (e) => reject(new UserError('Could not start ffmpeg: ' + e.message)));
    child.on('close', () => resolve(parseProbe(text)));
  }).then((info) => {
    if (!info.ok) throw new UserError('This file could not be read as video or audio');
    if (!info.hasAudio) throw new UserError('This file has no sound in it, so there is nothing to write subtitles from');
    return info;
  });
}

/** The interesting parts of ffmpeg's description of a file (its stderr after `-i`). */
function parseProbe(text) {
  const d = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(text);
  const info = { ok: !!d, duration: d ? Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3]) : 0, hasVideo: false, hasAudio: false, videoCodec: null, audioCodec: null, width: 0, height: 0, fps: 0, subtitleTracks: 0 };
  for (const line of text.split(/\r?\n/)) {
    const m = /Stream #\d+:\d+(?:\[[^\]]*\])?(?:\([^)]*\))?: (Video|Audio|Subtitle): ([^\s,]+)(.*)$/.exec(line.trim());
    if (!m) continue;
    if (m[1] === 'Video') {
      if (/attached pic/.test(line) || info.hasVideo) continue;     // cover art in a music file is not a video
      info.hasVideo = true; info.videoCodec = m[2];
      const size = /, (\d{2,5})x(\d{2,5})/.exec(m[3]); if (size) { info.width = Number(size[1]); info.height = Number(size[2]); }
      const fps = /, ([\d.]+) (?:fps|tbr)/.exec(m[3]); if (fps) info.fps = Number(fps[1]);
    } else if (m[1] === 'Audio') { if (!info.hasAudio) { info.hasAudio = true; info.audioCodec = m[2]; } }
    else info.subtitleTracks++;
  }
  return info;
}

// codecs an MP4 can carry as they are (anything else is re-encoded)
const MP4_VIDEO = new Set(['h264', 'hevc', 'av1', 'mpeg4', 'vp9']);
const MP4_AUDIO = new Set(['aac', 'mp3', 'ac3', 'eac3', 'alac']);

const SIZES = { small: 15, medium: 19, large: 24 };   // in libass's 288-line script space: about 5%, 6.5% and 8% of the height
/** The ASS style the burnt-in text gets. */
function forceStyle({ size = 'medium', box = false } = {}) {
  const fs_ = SIZES[size] || SIZES.medium;
  const parts = [`FontName=${FONT_NAME}`, `FontSize=${fs_}`, 'PrimaryColour=&H00FFFFFF', 'Bold=0', 'MarginV=16'];
  if (box) parts.push('BorderStyle=3', 'OutlineColour=&H60000000', 'BackColour=&H60000000', 'Outline=2', 'Shadow=0');
  else parts.push('BorderStyle=1', 'OutlineColour=&H00000000', 'BackColour=&H80000000', 'Outline=1.3', 'Shadow=0.6');
  return parts.join(',');
}

/** The ffmpeg arguments for the export (run inside `work`, where subs.srt and fonts/ are). Exported for the tests. */
function exportArgs({ mode, input, output, info, style, language }) {
  const args = ['-hide_banner', '-y', '-nostdin', '-v', 'error', '-progress', 'pipe:1', '-nostats', '-i', input];
  if (mode === 'soft') args.push('-i', 'subs.srt');
  args.push('-map', '0:v:0', '-map', '0:a:0?');
  if (mode === 'soft') args.push('-map', '1:0');
  if (mode === 'burn') {
    args.push('-vf', `subtitles=filename=subs.srt:charenc=UTF-8:fontsdir=fonts:force_style='${forceStyle(style)}'`, '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p');
  } else if (MP4_VIDEO.has(info.videoCodec)) args.push('-c:v', 'copy');
  else args.push('-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p');
  if (MP4_AUDIO.has(info.audioCodec)) args.push('-c:a', 'copy'); else args.push('-c:a', 'aac', '-b:a', '192k');
  if (mode === 'soft') {
    args.push('-c:s', 'mov_text', '-disposition:s:0', 'default');
    const iso = S.ISO3[language];
    if (iso) args.push('-metadata:s:s:0', `language=${iso}`);
  }
  args.push('-dn', '-map_metadata', '0', '-movflags', '+faststart', '-f', 'mp4', output);
  return args;
}

/**
 * Write a new MP4 of `input` with the cues, burnt in (`mode` "burn") or as a subtitle track ("soft"). Writes `output`.part
 * and renames it when done; on cancel or failure the part file is removed and the original is never touched.
 * @returns {Promise<{ path: string, seconds: number }>}
 */
async function exportVideo({ ffmpeg, input, output, cues, mode, info, style, language, signal, onProgress = () => {}, onBeforeReplace = null }) {
  if (mode !== 'burn' && mode !== 'soft') throw new UserError('Unknown export');
  if (!info || !info.hasVideo) throw new UserError('This file has no picture, so the subtitles cannot be put into a video');
  if (!cues.some((c) => S.fileText(c.text))) throw new UserError('There are no subtitles to put in yet');
  if (path.resolve(input) === path.resolve(output)) throw new UserError('The new video cannot replace the original');
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'subtitle-maker-'));
  const part = output + '.part';
  const t0 = Date.now();
  try {
    fs.writeFileSync(path.join(work, 'subs.srt'), S.formatSrt(cues), 'utf8');
    fs.mkdirSync(path.join(work, 'fonts'));
    for (const f of fontFiles()) fs.writeFileSync(path.join(work, 'fonts', path.basename(f)), plainFs.readFileSync(f));
    const args = exportArgs({ mode, input, output: part, info, style, language });
    await new Promise((resolve, reject) => {
      const child = spawn(ffmpeg, args, { cwd: work, windowsHide: true });
      let err = ''; let buf = '';
      const total = Math.max(0.001, info.duration);
      child.stdout.on('data', (d) => {
        buf += d;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
          const m = /^out_time_(?:us|ms)=(\d+)/.exec(line);
          if (m) { const sec = Number(m[1]) / 1e6; const fraction = Math.max(0, Math.min(0.999, sec / total)); const el = (Date.now() - t0) / 1000; onProgress({ fraction, elapsed: el, eta: fraction > 0.03 ? (el / fraction) * (1 - fraction) : null }); }
        }
      });
      child.stderr.on('data', (d) => { if (err.length < 8000) err += d; });
      const onAbort = () => { try { child.kill('SIGKILL'); } catch { /* gone */ } };   // ffmpeg takes ~20 s to wind down on SIGTERM; the part file is thrown away anyway
      if (signal) { if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, { once: true }); }
      child.on('error', (e) => reject(new UserError('Could not start ffmpeg: ' + e.message)));
      child.on('close', (code) => {
        if (signal) signal.removeEventListener('abort', onAbort);
        if (signal && signal.aborted) return reject(cancelled());
        if (code !== 0) {
          const last = err.trim().split(/\r?\n/).filter(Boolean).pop() || `ffmpeg stopped (code ${code})`;
          return reject(new UserError(/No space left/i.test(err) ? 'The disk is full' : 'The video could not be written: ' + last.slice(0, 160)));
        }
        resolve();
      });
    });
    if (!fs.existsSync(part) || fs.statSync(part).size < 1000) throw new UserError('ffmpeg wrote no video');
    if (onBeforeReplace && fs.existsSync(output)) { try { await onBeforeReplace(output); } catch { /* no recycle bin here: the replace was confirmed in the save dialog */ } }
    fs.renameSync(part, output);
    onProgress({ fraction: 1, elapsed: (Date.now() - t0) / 1000, eta: 0 });
    return { path: output, seconds: (Date.now() - t0) / 1000 };
  } catch (e) {
    try { fs.rmSync(part, { force: true }); } catch { /* ignore */ }
    throw e;
  } finally {
    try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

/** "Name (subtitled).mp4" in `dir`, or "Name (subtitled) (2).mp4" and so on when that exists. */
function freeName(dir, base, ext, exists = (p) => fs.existsSync(p)) {
  let p = path.join(dir, base + ext);
  for (let n = 2; exists(p) || exists(p + '.part'); n++) p = path.join(dir, `${base} (${n})${ext}`);
  return p;
}

module.exports = { UserError, cancelled, FONT_NAME, fontFiles, probe, parseProbe, forceStyle, exportArgs, exportVideo, freeName, MP4_VIDEO, MP4_AUDIO };
