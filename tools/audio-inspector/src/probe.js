'use strict';
// What a file says about itself: ffmpeg's description of it (`ffmpeg -i`), read into plain facts. Electron-free.
let fs;
try { fs = require('original-fs'); } catch { fs = require('fs'); }
const { spawn } = require('child_process');

const AUDIO_EXTS = ['.flac', '.wav', '.wave', '.aif', '.aiff', '.aifc', '.m4a', '.alac', '.caf', '.ape', '.wv', '.tta', '.mp3', '.aac', '.ogg', '.oga', '.opus', '.wma', '.mka', '.dsf', '.dff', '.w64', '.mp2', '.ac3', '.mp4', '.webm', '.au', '.snd'];
const LOSSLESS_CODECS = new Set(['flac', 'alac', 'ape', 'wavpack', 'tta', 'truehd', 'mlp', 'mp4als', 'tak', 'shorten', 'wmalossless', 'ralf']);
const isLosslessCodec = (c) => !!c && (LOSSLESS_CODECS.has(c) || /^pcm_/.test(c) || /^dsd_/.test(c));
const extOf = (f) => { const m = /\.[^.\\/]+$/.exec(String(f)); return m ? m[0].toLowerCase() : ''; };
const isAudio = (f) => AUDIO_EXTS.includes(extOf(f));

/** Friendly codec names. */
const CODEC_NAMES = {
  flac: 'FLAC', alac: 'ALAC (Apple Lossless)', ape: "Monkey's Audio", wavpack: 'WavPack', tta: 'TTA', mp3: 'MP3', mp3float: 'MP3', aac: 'AAC', vorbis: 'Vorbis', opus: 'Opus',
  wmav2: 'WMA', wmav1: 'WMA', wmapro: 'WMA Pro', wmalossless: 'WMA Lossless', ac3: 'AC-3', eac3: 'E-AC-3', mp2: 'MP2', truehd: 'TrueHD', mlp: 'MLP', mp4als: 'MPEG-4 ALS', tak: 'TAK',
};
function codecName(c) {
  if (!c) return 'Unknown';
  if (CODEC_NAMES[c]) return CODEC_NAMES[c];
  let m = /^pcm_([su])(\d+)(le|be)?(planar)?$/.exec(c); if (m) return `PCM ${m[2]}-bit${m[1] === 'u' ? ' unsigned' : ''}`;
  m = /^pcm_f(\d+)(le|be)?$/.exec(c); if (m) return `PCM ${m[1]}-bit float`;
  if (/^dsd_/.test(c)) return 'DSD';
  return c.toUpperCase();
}

/** Read ffmpeg's description of a file (stderr of `ffmpeg -i`). */
function parseProbe(text) {
  const out = { ok: false, container: null, duration: 0, containerBitrate: 0, codec: null, profile: null, sampleRate: 0, channels: 0, layout: null, sampleFormat: null, bitsDeclared: null, float: false, streamBitrate: 0, hasCover: false };
  const inp = /Input #0, ([^,]+(?:,[^,]+)*?), from/.exec(text);
  if (inp) out.container = inp[1].split(',')[0].trim();
  const d = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(text);
  if (d) out.duration = Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3]);
  const br = /Duration:[^\n]*bitrate:\s*(\d+)\s*kb\/s/.exec(text);
  if (br) out.containerBitrate = Number(br[1]);
  for (const line of text.split(/\r?\n/)) {
    const m = /Stream #\d+:\d+(?:\[[^\]]*\])?(?:\([^)]*\))?: (Audio|Video): (.*)$/.exec(line.trim());
    if (!m) continue;
    if (m[1] === 'Video') { out.hasCover = true; continue; }
    if (out.codec) continue;                               // the first sound stream is the one looked at
    const parts = m[2].split(/,\s*(?![^()]*\))/);           // commas outside brackets
    const head = /^(\w+)(?:\s*\(([^)]*)\))?/.exec(parts[0]);
    out.codec = head ? head[1] : parts[0];
    if (head && head[2] && !/^\[|0x|float$/.test(head[2])) out.profile = head[2].replace(/\s*\/.*$/, '');
    for (const p of parts.slice(1)) {
      const t = p.trim();
      let mm;
      if ((mm = /^(\d+) Hz$/.exec(t))) out.sampleRate = Number(mm[1]);
      else if ((mm = /^(\d+) kb\/s/.exec(t))) out.streamBitrate = Number(mm[1]);
      else if ((mm = /^(u8|s16|s32|s64|flt|dbl)(p?)(?:\s*\((\d+) bit\))?$/.exec(t))) {
        out.sampleFormat = mm[1] + mm[2];
        out.float = mm[1] === 'flt' || mm[1] === 'dbl';
        out.bitsDeclared = mm[3] ? Number(mm[3]) : ({ u8: 8, s16: 16, s32: 32, s64: 64, flt: 32, dbl: 64 })[mm[1]];
      } else if (/^(mono|stereo|quad|[0-9.]+(\(.*\))?|[0-9]+ channels|downmix|hexagonal|octagonal)/.test(t) && !out.layout) {
        out.layout = t;
        out.channels = t === 'mono' ? 1 : t === 'stereo' ? 2 : t === 'quad' ? 4 : /^(\d+) channels/.test(t) ? Number(/^(\d+)/.exec(t)[1]) : /^(\d+)\.(\d+)/.test(t) ? Number(/^(\d+)\.(\d+)/.exec(t)[1]) + Number(/^(\d+)\.(\d+)/.exec(t)[2]) : 0;
      }
    }
  }
  out.ok = !!out.codec && out.sampleRate > 0;
  out.lossless = isLosslessCodec(out.codec);
  // a lossy decoder hands out floating point samples: that says nothing about the file, so no bit depth for those
  if (!out.lossless) { out.bitsDeclared = null; out.float = false; }
  out.codecName = codecName(out.codec);
  return out;
}

class UserError extends Error {}

function probe(ffmpeg, file) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, ['-hide_banner', '-i', file], { windowsHide: true });
    let text = '';
    child.stderr.on('data', (d) => { if (text.length < 60000) text += d; });
    child.on('error', (e) => reject(new UserError('Could not start ffmpeg: ' + e.message)));
    child.on('close', () => {
      const info = parseProbe(text);
      if (!info.ok) return reject(new UserError(/Audio:/.test(text) ? 'The sound in this file could not be read' : 'This file has no sound that could be read'));
      try { info.fileSize = fs.statSync(file).size; } catch { info.fileSize = 0; }
      info.actualBitrate = info.duration > 0 ? Math.round((info.fileSize * 8) / info.duration / 1000) : 0;
      resolve(info);
    });
  });
}

module.exports = { AUDIO_EXTS, LOSSLESS_CODECS, isLosslessCodec, extOf, isAudio, codecName, parseProbe, probe, UserError };
