'use strict';
// The editing model, with no Electron and no ffmpeg in it: files, the parts of each file that are cut out, the output
// options, and what the result will be. The window (renderer) and the ffmpeg code both use it, and the tests run it
// with plain Node.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Plan = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  const MIN_PART = 0.005;        // a cut (or a gap between two cuts) shorter than this is meaningless: 5 ms
  const MIN_KEEP = 0.02;         // a kept piece shorter than this is dropped
  const MICRO_FADE = 0.005;      // 5 ms fade on a cut edge, so a cut never makes a click
  const MAX_SEGMENTS = 400;      // pieces in one export (each is opened as its own input)
  const MAX_FADE = 60;
  const MAX_JOIN = 10;

  class UserError extends Error {}
  const fail = (m) => { throw new UserError(m); };

  // ---- times ---------------------------------------------------------------------------------------------------------
  /** "90", "1:30", "1:30.25", "1:02:03.5" -> seconds. '' / null -> null. Anything else -> NaN. */
  function parseTime(text) {
    if (text == null) return null;
    const s = String(text).trim().replace(',', '.');
    if (!s) return null;
    const m = /^(?:(\d+):)?(?:(\d{1,2}):)?(\d+(?:\.\d+)?)$/.exec(s);
    if (!m) return NaN;
    const parts = s.split(':').map(Number);
    if (parts.some((n) => !Number.isFinite(n))) return NaN;
    if (parts.length > 3) return NaN;
    if (parts.length > 1 && parts.slice(1).some((n) => n >= 60)) return NaN; // "1:75" is not a time
    let sec = 0;
    for (const p of parts) sec = sec * 60 + p;
    return sec;
  }

  /** 83.4 -> "1:23.400" (with ms) or "1:23" (without). Hours only when needed. */
  function formatTime(sec, ms = true) {
    if (!Number.isFinite(sec) || sec < 0) sec = 0;
    const total = ms ? Math.round(sec * 1000) : Math.round(sec);
    const msPart = ms ? total % 1000 : 0;
    const whole = ms ? Math.floor(total / 1000) : total;
    const h = Math.floor(whole / 3600);
    const m = Math.floor((whole % 3600) / 60);
    const s = whole % 60;
    const ss = String(s).padStart(2, '0');
    const tail = ms ? `.${String(msPart).padStart(3, '0')}` : '';
    return h ? `${h}:${String(m).padStart(2, '0')}:${ss}${tail}` : `${m}:${ss}${tail}`;
  }

  const round3 = (n) => Math.round(n * 1000) / 1000;

  // ---- cuts: the parts of a file that are removed -----------------------------------------------------------------------
  /** Sort, clamp to the file, merge overlapping / touching cuts, drop empty ones. */
  function normalizeCuts(cuts, duration) {
    const list = (Array.isArray(cuts) ? cuts : [])
      .map((c) => [Math.max(0, Math.min(duration, Number(c && c[0]))), Math.max(0, Math.min(duration, Number(c && c[1])))])
      .filter((c) => Number.isFinite(c[0]) && Number.isFinite(c[1]) && c[1] - c[0] >= MIN_PART)
      .sort((a, b) => a[0] - b[0]);
    const out = [];
    for (const c of list) {
      const last = out[out.length - 1];
      if (last && c[0] <= last[1] + MIN_PART) last[1] = Math.max(last[1], c[1]);
      else out.push([c[0], c[1]]);
    }
    return out.map((c) => [round3(c[0]), round3(c[1])]);
  }

  /** The pieces that stay: the file minus its cuts. Pieces shorter than MIN_KEEP vanish. */
  function keptRanges(cuts, duration) {
    const out = [];
    let at = 0;
    for (const c of normalizeCuts(cuts, duration)) {
      if (c[0] - at >= MIN_KEEP) out.push([at, c[0]]);
      at = c[1];
    }
    if (duration - at >= MIN_KEEP) out.push([at, duration]);
    return out;
  }

  const keptDuration = (item) => keptRanges(item.cuts, item.duration).reduce((s, r) => s + (r[1] - r[0]), 0);

  /** Cut out [a, b]. Returns the new cuts, or throws UserError if nothing would be left. */
  function cutOut(item, a, b) {
    if (!(b - a >= MIN_PART)) fail('Select a part of the waveform first');
    const cuts = normalizeCuts([...item.cuts, [a, b]], item.duration);
    if (!keptRanges(cuts, item.duration).length) fail('That would remove everything in this file. Remove the file from the list instead');
    return cuts;
  }

  /** Keep only [a, b] (everything before and after is cut out). */
  function keepOnly(item, a, b) {
    if (!(b - a >= MIN_KEEP)) fail('Select at least 0.02 seconds to keep');
    return normalizeCuts([[0, a], [b, item.duration]], item.duration);
  }

  /** Put back the cut that contains time t (or nothing if there is none). */
  function restoreAt(cuts, t) {
    return cuts.filter((c) => !(t >= c[0] - 0.0005 && t <= c[1] + 0.0005));
  }

  /** Map a time in the original file to a time in that file after the cuts (cut parts have no time of their own). */
  function afterCuts(item, t) {
    let removed = 0;
    for (const c of normalizeCuts(item.cuts, item.duration)) {
      if (t >= c[1]) removed += c[1] - c[0];
      else if (t > c[0]) return c[0] - removed;
    }
    return t - removed;
  }

  // ---- output options --------------------------------------------------------------------------------------------------
  const FORMATS = {
    mp3:  { ext: '.mp3',  label: 'MP3',               codec: 'libmp3lame', muxer: 'mp3',  lossy: true,  cover: true,  bitrates: [128, 192, 256, 320], dflt: 192 },
    m4a:  { ext: '.m4a',  label: 'M4A (AAC)',         codec: 'aac',        muxer: 'ipod', lossy: true,  cover: true,  bitrates: [128, 192, 256, 320], dflt: 192 },
    ogg:  { ext: '.ogg',  label: 'Ogg Vorbis',        codec: 'libvorbis',  muxer: 'ogg',  lossy: true,  cover: false, bitrates: [96, 128, 192, 256, 320], dflt: 192 },
    opus: { ext: '.opus', label: 'Opus',              codec: 'libopus',    muxer: 'opus', lossy: true,  cover: false, bitrates: [64, 96, 128, 160, 192], dflt: 128 },
    flac: { ext: '.flac', label: 'FLAC (lossless)',   codec: 'flac',       muxer: 'flac', lossy: false, cover: true },
    wav:  { ext: '.wav',  label: 'WAV (lossless)',    codec: 'pcm_s16le',  muxer: 'wav',  lossy: false, cover: false },
  };
  const NORMALIZE = ['off', 'peak', 'loudness'];
  const LOUD_TARGETS = [-23, -16, -14];
  const PEAK_TARGET = -1; // dBFS
  const JOIN_MODES = ['none', 'gap', 'cross'];
  const INPUT_EXTS = ['.mp3', '.flac', '.wav', '.ogg', '.oga', '.opus', '.m4a', '.m4b', '.aac', '.wma', '.aif', '.aiff', '.ape', '.wv', '.mka'];

  const clampNum = (v, lo, hi, dflt, step) => {
    const n = Number(v);
    if (v === '' || v == null || !Number.isFinite(n)) return dflt;
    const c = Math.max(lo, Math.min(hi, n));
    return step ? Math.round(c / step) * step : c;
  };

  const isSupportedInput = (f) => INPUT_EXTS.includes(String(f).toLowerCase().replace(/^.*(\.[^.\\/]*)$/, '$1'));

  /** The output format "same as the first file" turns into. */
  function sameFormatFor(file) {
    const ext = String(file || '').toLowerCase().replace(/^.*(\.[^.\\/]*)$/, '$1');
    if (ext === '.mp3') return 'mp3';
    if (ext === '.m4a' || ext === '.m4b' || ext === '.aac') return 'm4a';
    if (ext === '.ogg' || ext === '.oga') return 'ogg';
    if (ext === '.opus') return 'opus';
    if (ext === '.flac' || ext === '.ape' || ext === '.wv') return 'flac';
    if (ext === '.wav' || ext === '.aif' || ext === '.aiff') return 'wav';
    return 'mp3';
  }

  /** Validate and clean what the window sends. `firstFile` resolves format "same". */
  function normalizeOptions(o = {}, firstFile = '') {
    const f = o.format === 'same' || o.format == null || o.format === '' ? sameFormatFor(firstFile) : o.format;
    const fmt = FORMATS[f];
    if (!fmt) fail(`Unsupported output format: ${o.format}`);
    const br = Math.round(Number(o.bitrate));
    return {
      format: f,
      bitrate: fmt.lossy ? (fmt.bitrates.includes(br) ? br : fmt.dflt) : null,
      fadeIn: clampNum(o.fadeIn, 0, MAX_FADE, 0, 0.01),
      fadeOut: clampNum(o.fadeOut, 0, MAX_FADE, 0, 0.01),
      gain: clampNum(o.gain, -30, 30, 0, 0.1),
      normalize: NORMALIZE.includes(o.normalize) ? o.normalize : 'off',
      loudness: LOUD_TARGETS.includes(Number(o.loudness)) ? Number(o.loudness) : -16,
      trimSilence: !!o.trimSilence,
      join: JOIN_MODES.includes(o.join) ? o.join : 'none',
      joinSeconds: clampNum(o.joinSeconds, 0, MAX_JOIN, 1, 0.1),
      keepTags: o.keepTags !== false,
      name: typeof o.name === 'string' ? o.name.trim().slice(0, 120) : '',
      outDir: typeof o.outDir === 'string' && o.outDir ? o.outDir : null,
    };
  }

  /** Clean one project item coming from the window. */
  function normalizeItem(it) {
    if (!it || typeof it.path !== 'string' || !it.path) fail('A file is missing its path');
    const duration = Number(it.duration);
    if (!(duration > 0.05) || !Number.isFinite(duration)) fail(`Cannot tell how long "${String(it.path).split(/[\\/]/).pop()}" is`);
    return {
      path: it.path,
      duration,
      rate: Math.round(Number(it.rate)) > 0 ? Math.round(Number(it.rate)) : 44100,
      channels: Number(it.channels) === 1 ? 1 : 2,
      coverStream: Number.isInteger(it.coverStream) ? it.coverStream : null,
      cuts: normalizeCuts(it.cuts, duration),
    };
  }

  // ---- what comes out --------------------------------------------------------------------------------------------------
  /** Length of the result, and why it may be impossible. Never throws: the window shows `error` next to the button. */
  function describe(items, rawOpts) {
    try {
      if (!Array.isArray(items) || !items.length) return { error: 'Add a file first', seconds: 0, parts: 0 };
      const opts = normalizeOptions(rawOpts, items[0] && items[0].path);
      const list = items.map(normalizeItem);
      const lengths = list.map(keptDuration);
      const parts = list.reduce((n, it) => n + keptRanges(it.cuts, it.duration).length, 0);
      if (parts > MAX_SEGMENTS) fail(`Too many separate pieces (${parts}). The limit is ${MAX_SEGMENTS}`);
      if (lengths.some((l) => !(l > 0))) fail('Nothing is left of one of the files');
      const n = list.length;
      let seconds = lengths.reduce((s, l) => s + l, 0);
      const joinSec = n > 1 ? opts.joinSeconds : 0;
      if (n > 1 && opts.join === 'gap') seconds += (n - 1) * joinSec;
      if (n > 1 && opts.join === 'cross') {
        const shortest = Math.min(...lengths);
        if (joinSec > 0 && shortest <= joinSec) fail(`A crossfade of ${joinSec} s needs every file to be longer than that (the shortest is ${shortest.toFixed(1)} s)`);
        seconds -= (n - 1) * joinSec;
      }
      if (opts.fadeIn + opts.fadeOut > seconds + 1e-6) fail(`The fades (${(opts.fadeIn + opts.fadeOut).toFixed(1)} s together) are longer than the result (${seconds.toFixed(1)} s)`);
      return { seconds, parts, opts };
    } catch (e) {
      if (e instanceof UserError) return { error: e.message, seconds: 0, parts: 0 };
      throw e;
    }
  }

  /** Rough size of the finished file in bytes (for "about 4.3 MB" in the window). */
  function estimateBytes(opts, seconds, rate = 44100, channels = 2) {
    const fmt = FORMATS[opts.format];
    if (!fmt) return 0;
    if (fmt.lossy) return Math.round((opts.bitrate * 1000 / 8) * seconds);
    if (opts.format === 'wav') return Math.round(rate * channels * 2 * seconds + 44);
    return Math.round(rate * channels * 2 * seconds * 0.6); // FLAC: about 60% of the PCM size for music
  }

  return {
    MIN_PART, MIN_KEEP, MICRO_FADE, MAX_SEGMENTS, MAX_FADE, MAX_JOIN, PEAK_TARGET, LOUD_TARGETS, NORMALIZE, JOIN_MODES, FORMATS, INPUT_EXTS,
    UserError, parseTime, formatTime, normalizeCuts, keptRanges, keptDuration, cutOut, keepOnly, restoreAt, afterCuts,
    normalizeOptions, normalizeItem, sameFormatFor, isSupportedInput, describe, estimateBytes,
  };
}));
