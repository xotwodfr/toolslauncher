'use strict';
// The model of the tool, with no Electron, no ffmpeg and no neural network in it: which stems exist, the combos
// ("presets"), how a song is cut into overlapping segments for the model, how the stems are mixed back together, and
// the output formats. The window (renderer) and the processing code both use it, and the tests run it with plain Node.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Plan = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  const SAMPLE_RATE = 44100;     // the model's rate; everything is decoded to this
  const SEGMENT = 343980;        // the model takes exactly this many samples (7.8 s) per call
  const OVERLAP = 0.25;          // neighbouring segments share this fraction, blended with a triangle window
  const MAX_GAIN = 2;            // a stem's volume slider goes from 0 to this
  const MAX_PREVIEW_SECONDS = 20 * 60; // the live preview keeps every stem in memory; export has no such limit

  // Display order. `color` only tints that stem's waveform lane.
  const STEMS = [
    { id: 'vocals', label: 'Vocals', color: '#ff7eb6' },
    { id: 'drums', label: 'Drums', color: '#ffb454' },
    { id: 'bass', label: 'Bass', color: '#6ea8ff' },
    { id: 'guitar', label: 'Guitar', color: '#7ee081' },
    { id: 'piano', label: 'Piano', color: '#c39bff' },
    { id: 'other', label: 'Other', color: '#9aa4b2' },
  ];
  const STEM_IDS = STEMS.map((s) => s.id);
  // The order the model writes its output in (NOT the display order).
  const MODEL_ORDER = ['drums', 'bass', 'other', 'vocals', 'guitar', 'piano'];

  const PRESETS = [
    { id: 'instrumental', label: 'No vocals', stems: ['drums', 'bass', 'guitar', 'piano', 'other'] },
    { id: 'vocals', label: 'Vocals only', stems: ['vocals'] },
    { id: 'drums', label: 'Drums only', stems: ['drums'] },
    { id: 'rhythm', label: 'Drums + bass', stems: ['drums', 'bass'] },
    { id: 'voice-bass', label: 'Voice + bass', stems: ['vocals', 'bass'] },
    { id: 'voice-rhythm', label: 'Voice + drums + bass', stems: ['vocals', 'drums', 'bass'] },
    { id: 'bass-guitar', label: 'Bass + guitar', stems: ['bass', 'guitar'] },
    { id: 'all', label: 'Everything', stems: STEM_IDS.slice() },
  ];

  const FORMATS = {
    wav: { label: 'WAV (lossless)', ext: '.wav', ffmpeg: ['-c:a', 'pcm_s16le', '-f', 'wav'] },
    flac: { label: 'FLAC (lossless, smaller)', ext: '.flac', ffmpeg: ['-c:a', 'flac', '-f', 'flac'] },
    mp3: { label: 'MP3 (320 kbps)', ext: '.mp3', ffmpeg: ['-c:a', 'libmp3lame', '-b:a', '320k', '-id3v2_version', '3', '-f', 'mp3'] },
  };

  const INPUT_EXTS = ['.mp3', '.flac', '.wav', '.ogg', '.oga', '.opus', '.m4a', '.m4b', '.aac', '.wma', '.aif', '.aiff', '.ape', '.wv', '.mka', '.webm', '.mp4', '.mkv'];

  /** An error whose message is meant to be shown to the person as it is. */
  class UserError extends Error {}

  const lastDot = (p) => { const i = p.lastIndexOf('.'); return i > Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\')) ? i : -1; };
  const extOf = (p) => { const i = lastDot(String(p)); return i < 0 ? '' : String(p).slice(i).toLowerCase(); };
  const isSupportedInput = (p) => INPUT_EXTS.includes(extOf(p));

  /** 3:05 / 1:02:03 */
  function formatTime(sec) {
    if (!Number.isFinite(sec) || sec < 0) sec = 0;
    const s = Math.floor(sec);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const r = s % 60;
    const pad = (n) => String(n).padStart(2, '0');
    return h ? `${h}:${pad(m)}:${pad(r)}` : `${m}:${pad(r)}`;
  }

  /** How the model sees a song: segment starts (in samples). Every sample is covered; non-last segments lie fully inside. */
  function segmentPlan(totalFrames, segment = SEGMENT, overlap = OVERLAP) {
    if (!(totalFrames > 0)) throw new UserError('This file has no sound');
    const stride = Math.max(1, Math.floor(segment * (1 - overlap)));
    const count = totalFrames <= segment ? 1 : Math.ceil((totalFrames - segment) / stride) + 1;
    const starts = Array.from({ length: count }, (_, k) => k * stride);
    return { stride, count, segment, starts };
  }

  /** Triangle blend window (peak 1) used to join overlapping segments, so a seam never makes a click. */
  function weights(segment = SEGMENT) {
    const w = new Float32Array(segment);
    const half = Math.floor(segment / 2);
    for (let i = 0; i < half; i++) w[i] = i + 1;
    for (let i = half; i < segment; i++) w[i] = segment - i;
    let max = 0;
    for (let i = 0; i < segment; i++) if (w[i] > max) max = w[i];
    for (let i = 0; i < segment; i++) w[i] /= max;
    return w;
  }

  /** Rough time to separate a song on the CPU: about two thirds of its length plus ~8 s to load the model (measured: 34 s of audio took 26 s). */
  const estimateSeconds = (duration) => Math.round(duration * 0.62 + 8);

  // ---- the mix --------------------------------------------------------------------------------------------------------
  /** A fresh mix: every stem on at full volume. */
  const newMix = () => Object.fromEntries(STEM_IDS.map((id) => [id, { on: true, gain: 1 }]));

  /** Turn on exactly these stems (volumes are kept). */
  function selectOnly(mix, ids) {
    const set = new Set(ids);
    for (const id of STEM_IDS) mix[id].on = set.has(id);
    return mix;
  }

  /** The stems that are heard: [{ id, gain }] in display order. Throws a readable error when nothing is. */
  function activeStems(mix) {
    const out = [];
    for (const id of STEM_IDS) {
      const m = mix && mix[id];
      if (!m || !m.on) continue;
      const g = Number(m.gain);
      if (!Number.isFinite(g) || g < 0 || g > MAX_GAIN) throw new UserError('A volume is out of range');
      if (g > 0) out.push({ id, gain: g });
    }
    if (!out.length) throw new UserError('Tick at least one stem to export');
    return out;
  }

  /** "vocals + bass" (or "no vocals", "everything"). */
  function describe(ids) {
    const set = new Set(ids);
    if (set.size === STEM_IDS.length) return 'everything';
    if (set.size === STEM_IDS.length - 1) {
      const missing = STEM_IDS.find((id) => !set.has(id));
      return 'no ' + missing;
    }
    return STEM_IDS.filter((id) => set.has(id)).join(' + ');
  }

  /** Which preset (if any) the current ticks match, ignoring volumes. */
  function matchingPreset(mix) {
    const on = STEM_IDS.filter((id) => mix[id] && mix[id].on).join(',');
    const hit = PRESETS.find((p) => STEM_IDS.filter((id) => p.stems.includes(id)).join(',') === on);
    return hit ? hit.id : null;
  }

  const SAFE = /[<>:"/\\|?*\u0000-\u001f]/g;
  /** "Song (vocals + bass).mp3" - a file name that is valid on every system. */
  function defaultName(songName, ids, format) {
    const base = String(songName || 'Song').replace(/\.[A-Za-z0-9]{1,5}$/, '').replace(SAFE, '_').trim() || 'Song';
    const f = FORMATS[format] || FORMATS.wav;
    return `${base} (${describe(ids)})${f.ext}`;
  }

  /** Every stem's file name inside a song's folder. */
  const stemFile = (id) => { if (!STEM_IDS.includes(id)) throw new UserError('Unknown stem'); return id + '.wav'; };

  return {
    SAMPLE_RATE, SEGMENT, OVERLAP, MAX_GAIN, MAX_PREVIEW_SECONDS, STEMS, STEM_IDS, MODEL_ORDER, PRESETS, FORMATS, INPUT_EXTS,
    UserError, extOf, isSupportedInput, formatTime, segmentPlan, weights, estimateSeconds,
    newMix, selectOnly, activeStems, describe, matchingPreset, defaultName, stemFile,
  };
}));
