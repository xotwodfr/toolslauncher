'use strict';
// Pure helpers shared by the main process, the tests and the window (loaded with <script> there): turning the recogniser's
// segments and word times into lyric lines, writing and reading .lrc files, time formats, the language list, and estimates.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Plan = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  const INPUT_EXTS = ['.mp3', '.flac', '.ogg', '.oga', '.opus', '.m4a', '.mp4', '.aac', '.wav', '.wma', '.aif', '.aiff', '.ape', '.wv', '.webm'];
  const MAX_SECONDS = 30 * 60;
  class UserError extends Error {}
  const extOf = (f) => { const m = /\.[^.\\/]+$/.exec(String(f)); return m ? m[0].toLowerCase() : ''; };
  const isAudio = (f) => INPUT_EXTS.includes(extOf(f));
  const baseName = (f) => String(f).replace(/^.*[\\/]/, '');

  // The 99 languages Whisper knows, by the two or three letter code its tokens use.
  const LANGUAGES = {
    en: 'English', zh: 'Chinese', de: 'German', es: 'Spanish', ru: 'Russian', ko: 'Korean', fr: 'French', ja: 'Japanese', pt: 'Portuguese', tr: 'Turkish',
    pl: 'Polish', ca: 'Catalan', nl: 'Dutch', ar: 'Arabic', sv: 'Swedish', it: 'Italian', id: 'Indonesian', hi: 'Hindi', fi: 'Finnish', vi: 'Vietnamese',
    he: 'Hebrew', uk: 'Ukrainian', el: 'Greek', ms: 'Malay', cs: 'Czech', ro: 'Romanian', da: 'Danish', hu: 'Hungarian', ta: 'Tamil', no: 'Norwegian',
    th: 'Thai', ur: 'Urdu', hr: 'Croatian', bg: 'Bulgarian', lt: 'Lithuanian', la: 'Latin', mi: 'Maori', ml: 'Malayalam', cy: 'Welsh', sk: 'Slovak',
    te: 'Telugu', fa: 'Persian', lv: 'Latvian', bn: 'Bengali', sr: 'Serbian', az: 'Azerbaijani', sl: 'Slovenian', kn: 'Kannada', et: 'Estonian', mk: 'Macedonian',
    br: 'Breton', eu: 'Basque', is: 'Icelandic', hy: 'Armenian', ne: 'Nepali', mn: 'Mongolian', bs: 'Bosnian', kk: 'Kazakh', sq: 'Albanian', sw: 'Swahili',
    gl: 'Galician', mr: 'Marathi', pa: 'Punjabi', si: 'Sinhala', km: 'Khmer', sn: 'Shona', yo: 'Yoruba', so: 'Somali', af: 'Afrikaans', oc: 'Occitan',
    ka: 'Georgian', be: 'Belarusian', tg: 'Tajik', sd: 'Sindhi', gu: 'Gujarati', am: 'Amharic', yi: 'Yiddish', lo: 'Lao', uz: 'Uzbek', fo: 'Faroese',
    ht: 'Haitian Creole', ps: 'Pashto', tk: 'Turkmen', nn: 'Nynorsk', mt: 'Maltese', sa: 'Sanskrit', lb: 'Luxembourgish', my: 'Myanmar', bo: 'Tibetan', tl: 'Tagalog',
    mg: 'Malagasy', as: 'Assamese', tt: 'Tatar', haw: 'Hawaiian', ln: 'Lingala', ha: 'Hausa', ba: 'Bashkir', jw: 'Javanese', su: 'Sundanese',
  };
  /** [{ code, name }] with "auto" first, the most-sung languages next, then the rest A to Z. */
  function languageList() {
    const common = ['en', 'es', 'fr', 'de', 'it', 'pt', 'ja', 'ko', 'zh', 'ru', 'tr', 'ar', 'hi', 'nl', 'sv', 'pl'];
    const rest = Object.keys(LANGUAGES).filter((c) => !common.includes(c)).sort((a, b) => LANGUAGES[a].localeCompare(LANGUAGES[b]));
    return [{ code: 'auto', name: 'Detect the language' }, ...common.concat(rest).map((code) => ({ code, name: LANGUAGES[code] }))];
  }

  // ---- time -----------------------------------------------------------------------------------------------------------------
  /** 65.4 -> "1:05.40" (what the line boxes show) */
  function formatTime(sec) {
    const t = Math.max(0, Math.round(Number(sec) * 100));
    const m = Math.floor(t / 6000); const s = Math.floor((t % 6000) / 100); const c = t % 100;
    return `${m}:${String(s).padStart(2, '0')}.${String(c).padStart(2, '0')}`;
  }
  /** "1:05.4", "1:05", "65.4", "0:12,50" -> seconds, or null when it is not a time */
  function parseTime(text) {
    const s = String(text == null ? '' : text).trim().replace(',', '.');
    let m = /^(\d+):(\d{1,2})(?:\.(\d{1,3}))?$/.exec(s);
    if (m) { if (Number(m[2]) > 59) return null; return Number(m[1]) * 60 + Number(m[2]) + (m[3] ? Number('0.' + m[3]) : 0); }
    m = /^(\d+)(?:\.(\d{1,3}))?$/.exec(s);
    if (m) return Number(m[1]) + (m[2] ? Number('0.' + m[2]) : 0);
    return null;
  }
  /** [mm:ss.xx] with the carry done right (59.996 s is 01:00.00, not 00:60.00) */
  function lrcStamp(sec) {
    const t = Math.max(0, Math.round(Number(sec) * 100));
    const m = Math.floor(t / 6000); const s = Math.floor((t % 6000) / 100); const c = t % 100;
    return `[${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(c).padStart(2, '0')}]`;
  }

  // ---- lines ------------------------------------------------------------------------------------------------------------------
  /** Take away what recognisers add to music: note symbols, [Music]-style labels, stray spacing. Returns '' for a line with no words. */
  function cleanText(text) {
    let t = String(text == null ? '' : text)
      .replace(/[♪♫♬♩]+/g, ' ')
      .replace(/[\[(]\s*(?:music|musique|musica|música|musik|applause|singing|instrumental|laughter|silence|inaudible|no speech)\s*[\])]/gi, ' ')
      .replace(/\s+/g, ' ').trim();
    if (!/[\p{L}\p{N}]/u.test(t)) t = '';
    return t;
  }

  const SOFT_BREAK = /[,;:.!?…、。，！？]$/;
  /**
   * Turn recogniser segments into lyric lines { start, end, text }. A long segment is cut into lines where the singer pauses,
   * at punctuation, or when a line would get too long; each line starts when its first word starts.
   * @param {{start:number,end:number,text:string,words?:{text:string,start:number,end:number}[]}[]} segments
   * @param {{maxChars?:number, pause?:number, softChars?:number, spaced?:boolean}} [o]
   */
  function buildLines(segments, { maxChars = 44, pause = 0.9, softChars = 24, spaced = true } = {}) {
    const lines = [];
    const join = (parts) => parts.join(spaced ? ' ' : '');
    const push = (parts, start, end) => {
      const text = cleanText(join(parts));
      if (text) lines.push({ start: Math.round(start * 100) / 100, end: Math.round(Math.max(end, start) * 100) / 100, text });
    };
    const flush = (cur) => { if (cur.length) push(cur.map((x) => x.text), cur[0].start, cur[cur.length - 1].end); };
    for (const seg of segments) {
      const words = (seg.words || []).filter((w) => w && w.text);
      if (!words.length) { push([seg.text], seg.start, seg.end); continue; }
      let cur = [];
      let endsHere = false;
      for (const w of words) {
        endsHere = false;
        if (cur.length) {
          const prev = cur[cur.length - 1];
          const now = join(cur.map((x) => x.text));
          if (w.start - prev.end >= pause) { flush(cur); cur = []; }                                  // the singer paused
          else if (SOFT_BREAK.test(prev.text) && now.length >= softChars) { flush(cur); cur = []; }   // a long enough phrase just ended
          else if (join(cur.map((x) => x.text).concat(w.text)).length > maxChars && !(SOFT_BREAK.test(w.text) && join(cur.map((x) => x.text).concat(w.text)).length <= maxChars + 8)) {   // too long (a word that finishes the phrase may run a few characters over): cut at the last punctuation if there is one
            let cut = -1;
            for (let k = cur.length - 2; k >= 0; k--) if (SOFT_BREAK.test(cur[k].text) && join(cur.slice(0, k + 1).map((x) => x.text)).length >= 12) { cut = k; break; }
            if (cut >= 0) { flush(cur.slice(0, cut + 1)); cur = cur.slice(cut + 1); } else { flush(cur); cur = []; }
          }
        }
        cur.push({ text: w.text, start: w.start, end: w.end });
        if (SOFT_BREAK.test(w.text) && join(cur.map((x) => x.text)).length > maxChars) endsHere = true;
        if (endsHere) { flush(cur); cur = []; }
      }
      flush(cur);
    }
    // lines never start before the previous one, and never overlap it
    for (let i = 1; i < lines.length; i++) if (lines[i].start < lines[i - 1].start) lines[i].start = lines[i - 1].start;
    return lines;
  }

  /** @param {{start:number,text:string}[]} lines */
  function formatLrc(lines) {
    const sorted = lines.filter((l) => l && String(l.text).trim() !== '' && Number.isFinite(l.start)).map((l, i) => ({ ...l, i })).sort((a, b) => a.start - b.start || a.i - b.i);
    return sorted.map((l) => `${lrcStamp(l.start)}${String(l.text).replace(/[\r\n]+/g, ' ').trim()}`).join('\r\n') + (sorted.length ? '\r\n' : '');
  }
  const formatPlain = (lines) => lines.filter((l) => l && String(l.text).trim()).map((l) => String(l.text).replace(/[\r\n]+/g, ' ').trim()).join('\r\n') + '\r\n';

  /** Read an .lrc: every [mm:ss.xx] stamp on a line gives a line with that text; [ar:], [ti:] and such are skipped. */
  function parseLrc(text) {
    const out = [];
    for (const raw of String(text || '').replace(/^﻿/, '').split(/\r?\n/)) {
      const stamps = []; let rest = raw.trim();
      let m;
      while ((m = /^\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/.exec(rest))) {
        stamps.push(Number(m[1]) * 60 + Number(m[2]) + (m[3] ? Number('0.' + m[3]) : 0));
        rest = rest.slice(m[0].length);
      }
      if (stamps.length) for (const t of stamps) out.push({ start: Math.round(t * 100) / 100, text: rest.trim() });
    }
    return out.sort((a, b) => a.start - b.start);
  }

  /** Move every line by `delta` seconds (never before 0). */
  const shiftLines = (lines, delta) => lines.map((l) => ({ ...l, start: Math.max(0, Math.round((l.start + delta) * 100) / 100), ...(l.end != null ? { end: Math.max(0, Math.round((l.end + delta) * 100) / 100) } : {}) }));

  /** Index of the line being sung at `t` (the last one that has started), or -1. */
  function currentLine(lines, t) {
    let idx = -1;
    for (let i = 0; i < lines.length; i++) { if (lines[i].start <= t + 1e-6) idx = i; else break; }
    return idx;
  }

  /** Rough time to make lyrics: measured at about a third of the song's length on a Ryzen 5 5600X, plus loading the model. */
  const estimateSeconds = (duration) => duration * 0.45 + 12;
  const formatDuration = (sec) => { const s = Math.round(sec); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
  const defaultName = (name, ext) => `${baseName(name).replace(/\.[^.]*$/, '') || 'lyrics'}${ext}`;

  return {
    INPUT_EXTS, MAX_SECONDS, UserError, extOf, isAudio, baseName, LANGUAGES, languageList, formatTime, parseTime, lrcStamp, cleanText,
    buildLines, formatLrc, formatPlain, parseLrc, shiftLines, currentLine, estimateSeconds, formatDuration, defaultName,
  };
}));
