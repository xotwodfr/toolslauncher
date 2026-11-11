'use strict';
// Pure subtitle helpers shared by the main process, the tests and the window (loaded with <script> there): turning the
// recogniser's word times into subtitle cues that follow the usual subtitling rules, wrapping text into lines, reading speed,
// writing and reading .srt and .vtt files, time formats, editing (split, merge, shift) and the language list.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Subs = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  const VIDEO_EXTS = ['.mp4', '.m4v', '.mov', '.mkv', '.webm', '.avi', '.wmv', '.mpg', '.mpeg', '.ts', '.mts', '.m2ts', '.3gp', '.flv', '.ogv'];
  const AUDIO_EXTS = ['.mp3', '.flac', '.ogg', '.oga', '.opus', '.m4a', '.aac', '.wav', '.wma', '.aif', '.aiff', '.ape', '.wv'];
  const INPUT_EXTS = VIDEO_EXTS.concat(AUDIO_EXTS);
  const SUB_EXTS = ['.srt', '.vtt'];
  class UserError extends Error {}
  const extOf = (f) => { const m = /\.[^.\\/]+$/.exec(String(f)); return m ? m[0].toLowerCase() : ''; };
  const isMedia = (f) => INPUT_EXTS.includes(extOf(f));
  const isVideoName = (f) => VIDEO_EXTS.includes(extOf(f));
  const isSubtitle = (f) => SUB_EXTS.includes(extOf(f));
  const baseName = (f) => String(f).replace(/^.*[\\/]/, '');
  const stem = (f) => baseName(f).replace(/\.[^.]*$/, '');

  // The usual rules for subtitles (close to what broadcasters and streaming services ask for).
  const RULES = Object.freeze({
    maxLineChars: 42,       // characters per line (16 for languages written without spaces)
    maxLines: 2,
    minDuration: 1.0,       // seconds on screen, at least
    maxDuration: 7.0,       // and at most
    gap: 0.084,             // between two cues (two frames at 24 fps), so the eye sees a change
    maxCps: 20,             // reading speed, characters per second: faster than this is hard to follow
    targetCps: 17,          // when there is room, a cue stays up long enough for this speed
    pause: 0.6,             // a pause this long in the speech starts a new cue
    linger: 0.3,            // a cue may stay up this much after the last word, when nothing follows at once
  });
  const NO_SPACE = new Set(['zh', 'ja', 'th', 'lo', 'my', 'yue', 'km']);
  const rulesFor = (lang, over) => ({ ...RULES, ...(NO_SPACE.has(lang) ? { maxLineChars: 16, maxCps: 11, targetCps: 9 } : {}), ...(over || {}) });

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
  /** ISO 639-2 codes for the subtitle track's language tag in an MP4 (what players show in their subtitle menu). */
  const ISO3 = {
    en: 'eng', zh: 'chi', de: 'ger', es: 'spa', ru: 'rus', ko: 'kor', fr: 'fre', ja: 'jpn', pt: 'por', tr: 'tur', pl: 'pol', ca: 'cat', nl: 'dut', ar: 'ara',
    sv: 'swe', it: 'ita', id: 'ind', hi: 'hin', fi: 'fin', vi: 'vie', he: 'heb', uk: 'ukr', el: 'gre', ms: 'may', cs: 'cze', ro: 'rum', da: 'dan', hu: 'hun',
    ta: 'tam', no: 'nor', th: 'tha', ur: 'urd', hr: 'hrv', bg: 'bul', lt: 'lit', fa: 'per', sk: 'slo', sl: 'slv', sr: 'srp', et: 'est', lv: 'lav', bn: 'ben',
  };
  function languageList() {
    const common = ['en', 'es', 'fr', 'de', 'it', 'pt', 'ja', 'ko', 'zh', 'ru', 'tr', 'ar', 'hi', 'nl', 'sv', 'pl'];
    const rest = Object.keys(LANGUAGES).filter((c) => !common.includes(c)).sort((a, b) => LANGUAGES[a].localeCompare(LANGUAGES[b]));
    return [{ code: 'auto', name: 'Detect the language' }, ...common.concat(rest).map((code) => ({ code, name: LANGUAGES[code] }))];
  }

  // ---- time -----------------------------------------------------------------------------------------------------------------
  const ms = (sec) => Math.max(0, Math.round(Number(sec) * 1000));
  const r3 = (x) => Math.round(x * 1000) / 1000;
  function clockParts(sec) {
    const t = ms(sec);
    return { h: Math.floor(t / 3600000), m: Math.floor((t % 3600000) / 60000), s: Math.floor((t % 60000) / 1000), f: t % 1000 };
  }
  const p2 = (n) => String(n).padStart(2, '0');
  const p3 = (n) => String(n).padStart(3, '0');
  /** 3661.5 -> "01:01:01,500" (the carry is done on whole milliseconds, so 59.9996 s is 00:01:00,000) */
  function srtTime(sec) { const c = clockParts(sec); return `${p2(c.h)}:${p2(c.m)}:${p2(c.s)},${p3(c.f)}`; }
  /** 61.5 -> "00:01:01.500" */
  function vttTime(sec) { const c = clockParts(sec); return `${p2(c.h)}:${p2(c.m)}:${p2(c.s)}.${p3(c.f)}`; }
  /** What the cue boxes show: "1:05.400", "1:01:05.400" past an hour. */
  function formatTime(sec) { const c = clockParts(sec); return (c.h ? `${c.h}:${p2(c.m)}` : `${c.m}`) + `:${p2(c.s)}.${p3(c.f)}`; }
  /** "1:05.4", "01:01:05,400", "65.4", "1:05" -> seconds, or null when it is not a time */
  function parseTime(text) {
    const s = String(text == null ? '' : text).trim().replace(',', '.');
    const m = /^(?:(\d+):)?(?:(\d+):)?(\d+)(?:\.(\d{1,3}))?$/.exec(s);
    if (!m) return null;
    let h = 0; let mi = 0;
    if (m[1] != null && m[2] != null) { h = Number(m[1]); mi = Number(m[2]); } else if (m[1] != null) mi = Number(m[1]);
    const sec = Number(m[3]);
    if ((m[1] != null) && sec > 59) return null;
    if (m[1] != null && m[2] != null && mi > 59) return null;
    return h * 3600 + mi * 60 + sec + (m[4] ? Number('0.' + m[4]) : 0);
  }
  const formatDuration = (sec) => { const s = Math.round(sec); const h = Math.floor(s / 3600); const m = Math.floor((s % 3600) / 60); return (h ? `${h}:${p2(m)}` : `${m}`) + `:${p2(s % 60)}`; };

  // ---- text -----------------------------------------------------------------------------------------------------------------
  /** Take away what recognisers add: note symbols, [Music]-style labels, stray spacing. Returns '' when no words are left. */
  function cleanText(text) {
    let t = String(text == null ? '' : text)
      .replace(/[♪♫♬♩]+/g, ' ')
      .replace(/[\[(]\s*(?:music|musique|musica|música|musik|applause|silence|inaudible|no speech|blank_audio)\s*[\])]/gi, ' ')
      .replace(/\s+/g, ' ').trim();
    if (!/[\p{L}\p{N}]/u.test(t)) t = '';
    return t;
  }
  /** Length as a reader counts it: characters (not UTF-16 units), without formatting tags and line breaks. */
  /** A "word" that is only a music note or a [Music]-style label (punctuation on its own is kept: CJK words are single characters). */
  const isNoise = (text) => !String(text == null ? '' : text).replace(/[♪♫♬♩]+/g, '').replace(/[\[(]\s*(?:music|musique|musica|música|musik|applause|silence|inaudible|no speech|blank_audio)\s*[\])]/gi, '').trim();
  const visibleLength = (text) => [...String(text || '').replace(/<\/?[a-z][^>]*>/gi, '').replace(/\r?\n/g, '')].length;

  const BREAK_AFTER = /[,;:.!?…、。，！？]$/;
  /**
   * Wrap the text of one cue into lines of at most `maxChars` (two lines unless the text is too long for two). The break is
   * put where the two lines come out most even, preferring a break after punctuation and a top line no longer than the bottom.
   * @returns {string[]}
   */
  function wrapText(text, maxChars = RULES.maxLineChars, spaced = true) {
    const flat = String(text || '').replace(/\s*\r?\n\s*/g, spaced ? ' ' : '').replace(/[ \t]+/g, ' ').trim();
    if (!flat) return [];
    const len = (s) => [...s].length;
    if (len(flat) <= maxChars) return [flat];
    const units = spaced ? flat.split(' ') : [...flat];
    const sep = spaced ? ' ' : '';
    const total = len(flat);
    if (total <= maxChars * 2 + (spaced ? 1 : 0) || units.length < 3) {
      let best = null;
      for (let k = 1; k < units.length; k++) {
        const a = units.slice(0, k).join(sep); const b = units.slice(k).join(sep);
        const la = len(a); const lb = len(b);
        let cost = Math.max(la, lb) * 10 + Math.abs(la - lb);
        if (Math.max(la, lb) > maxChars) cost += 10000;
        if (BREAK_AFTER.test(a)) cost -= 60;
        if (la > lb) cost += 3;                       // a pyramid (short top line) reads more easily
        if (/^(?:a|an|the|of|to|and|or|but|in|on|at|for|my|your|de|la|le|el|der|die|das)$/i.test(units[k - 1])) cost += 25; // do not leave a little word hanging
        if (!best || cost < best.cost) best = { cost, a, b };
      }
      if (best && Math.max(len(best.a), len(best.b)) <= maxChars) return [best.a, best.b];
    }
    // too long for two lines: fill greedily (the warnings will say it is too long)
    const lines = []; let cur = '';
    for (const u of units) {
      const next = cur ? cur + sep + u : u;
      if (cur && len(next) > maxChars) { lines.push(cur); cur = u; } else cur = next;
    }
    if (cur) lines.push(cur);
    return lines;
  }

  /** Reading speed of a cue in characters per second (spaces count, line breaks and tags do not). */
  function cps(cue) {
    const d = cue.end - cue.start;
    const n = visibleLength(cue.text);
    if (!(d > 0)) return n ? Infinity : 0;
    return n / d;
  }

  /**
   * What is wrong with each cue by the rules: [{ code, message }]. `next` is the following cue, for overlaps and gaps.
   */
  function cueProblems(cue, next, rules = RULES) {
    const out = [];
    const d = cue.end - cue.start;
    const lines = String(cue.text || '').split(/\r?\n/);
    if (!String(cue.text || '').trim()) out.push({ code: 'empty', message: 'No text' });
    if (!(d > 0)) out.push({ code: 'order', message: 'Ends before it starts' });
    else {
      const speed = cps(cue);
      if (speed > rules.maxCps) out.push({ code: 'fast', message: `Too fast to read: ${speed.toFixed(0)} characters per second (aim for ${rules.maxCps} or fewer)` });
      if (d < rules.minDuration - 1e-6) out.push({ code: 'short', message: `On screen for only ${d.toFixed(2)} s (at least ${rules.minDuration} s)` });
      if (d > rules.maxDuration + 1e-6) out.push({ code: 'long', message: `On screen for ${d.toFixed(1)} s (at most ${rules.maxDuration} s)` });
    }
    if (lines.length > rules.maxLines) out.push({ code: 'lines', message: `${lines.length} lines (at most ${rules.maxLines})` });
    const longest = Math.max(0, ...lines.map((l) => visibleLength(l)));
    if (longest > rules.maxLineChars) out.push({ code: 'width', message: `A line of ${longest} characters (at most ${rules.maxLineChars})` });
    if (next && next.start < cue.end - 1e-6) out.push({ code: 'overlap', message: 'Overlaps the next subtitle' });
    return out;
  }

  // ---- building cues from what was heard ---------------------------------------------------------------------------------------
  /**
   * Turn recogniser segments (with word times) into subtitle cues { start, end, text } that follow the rules: at most two
   * lines of `maxLineChars`, cut at pauses, sentence ends and commas, between `minDuration` and `maxDuration` long, a small gap
   * between cues, and long enough on screen to be read when there is room.
   * @param {{start:number,end:number,text:string,words?:{text:string,start:number,end:number}[]}[]} segments
   * @param {{language?:string, rules?:object}} [o]
   */
  function buildCues(segments, { language = 'en', rules: over } = {}) {
    const R = rulesFor(language, over);
    const spaced = !NO_SPACE.has(language);
    const sep = spaced ? ' ' : '';
    const maxChars = R.maxLineChars * R.maxLines;
    const groups = [];
    // every word, in order, tagged with the segment it came from (Whisper's segments are usually sentences)
    const words = [];
    segments.forEach((seg, si) => {
      const ws = (seg.words || []).filter((w) => w && !isNoise(w.text) && Number.isFinite(w.start) && Number.isFinite(w.end));
      if (ws.length) for (const w of ws) words.push({ text: String(w.text).trim(), start: w.start, end: Math.max(w.end, w.start), seg: si });
      else {
        // no word times: share the segment's time out over its words by their length
        const text = cleanText(seg.text);
        if (!text) return;
        const parts = spaced ? text.split(' ') : [...text];
        const total = parts.reduce((n, p) => n + p.length + 1, 0);
        let t = seg.start; const span = Math.max(0.1, seg.end - seg.start);
        for (const p of parts) { const d = (span * (p.length + 1)) / total; words.push({ text: p, start: t, end: t + d, seg: si }); t += d; }
      }
    });
    const joined = (list) => list.map((w) => w.text).join(sep);
    const fits = (list) => { const t = joined(list); return [...t].length <= maxChars && wrapText(t, R.maxLineChars, spaced).length <= R.maxLines; };
    let cur = [];
    const flush = (list) => { if (list.length) groups.push(list); };
    for (const w of words) {
      if (cur.length) {
        const prev = cur[cur.length - 1];
        const len = [...joined(cur)].length;
        const candidate = cur.concat(w);
        if (w.start - prev.end >= R.pause) { flush(cur); cur = []; }                                           // a pause
        else if (/[.!?…。！？]$/.test(prev.text) && len >= 12) { flush(cur); cur = []; }                        // a sentence ended
        else if (w.seg !== prev.seg && len >= 24) { flush(cur); cur = []; }                                    // the recogniser started a new segment
        else if (!fits(candidate) || w.end - cur[0].start > R.maxDuration) {
          // too long: cut after the last comma (or other punctuation) when that leaves a decent first part, else here
          let cut = -1;
          for (let k = cur.length - 2; k >= 0; k--) if (BREAK_AFTER.test(cur[k].text) && [...joined(cur.slice(0, k + 1))].length >= 15) { cut = k; break; }
          if (cut >= 0 && fits(cur.slice(cut + 1).concat(w)) && w.end - cur[cut + 1].start <= R.maxDuration) { flush(cur.slice(0, cut + 1)); cur = cur.slice(cut + 1); }
          else { flush(cur); cur = []; }
        }
      }
      cur.push(w);
    }
    flush(cur);

    const cues = groups.map((g) => ({ start: g[0].start, end: g[g.length - 1].end, text: wrapText(joined(g), R.maxLineChars, spaced).join('\n') }))
      .filter((c) => cleanText(c.text));
    return timeCues(cues, R);
  }

  /**
   * Fix the timing of cues by the rules, in order: no cue before the one before it, long enough to read (up to `targetCps`,
   * at least `minDuration`), never longer than `maxDuration`, never into the next one (a `gap` stays free).
   */
  function timeCues(cues, R = RULES) {
    const out = cues.map((c) => ({ ...c })).sort((a, b) => a.start - b.start);
    for (let i = 0; i < out.length; i++) {
      const c = out[i];
      const next = out[i + 1];
      const limit = next ? next.start - R.gap : Infinity;
      const n = visibleLength(c.text);
      let want = Math.max(c.end + (next && next.start - c.end < R.linger + R.gap ? 0 : R.linger), c.start + R.minDuration, c.start + n / R.targetCps);
      want = Math.min(want, c.start + R.maxDuration);
      c.end = Math.max(c.end, Math.min(want, limit));
      if (c.end > limit) c.end = Math.max(c.start + 0.05, limit);      // the words themselves ran into the next cue
      if (c.end > c.start + R.maxDuration) c.end = c.start + R.maxDuration;
      c.start = r3(c.start); c.end = r3(Math.max(c.end, c.start));
    }
    return out;
  }

  // ---- editing ---------------------------------------------------------------------------------------------------------------
  /** Move every cue by `delta` seconds. Cues pushed before 0 start at 0 (and keep at least a moment of time). */
  const shiftCues = (cues, delta) => cues.map((c) => {
    const start = r3(Math.max(0, c.start + delta));
    const end = r3(Math.max(start + Math.min(0.1, Math.max(0, c.end - c.start)), c.end + delta));
    return { ...c, start, end };
  });

  /**
   * Split one cue in two. The text is cut at the word nearest its middle (or at the line break when it has two lines), and
   * the time at `at` when given (the playhead, if it is inside the cue), else in proportion to the text.
   * @returns {[object, object] | null} null when the cue has nothing to split
   */
  function splitCue(cue, at = null, spaced = true) {
    const text = String(cue.text || '').trim();
    let a; let b;
    const lines = text.split(/\r?\n/);
    if (lines.length >= 2) { const k = Math.ceil(lines.length / 2); a = lines.slice(0, k).join(' '); b = lines.slice(k).join(' '); }
    else {
      const units = spaced ? text.split(/\s+/) : [...text];
      if (units.length < 2) return null;
      const sep = spaced ? ' ' : '';
      let bestK = 1; let bestCost = Infinity;
      const total = [...text].length;
      for (let k = 1; k < units.length; k++) {
        const la = [...units.slice(0, k).join(sep)].length;
        let cost = Math.abs(la - (total - la));
        if (BREAK_AFTER.test(units[k - 1])) cost -= 6;
        if (cost < bestCost) { bestCost = cost; bestK = k; }
      }
      a = units.slice(0, bestK).join(sep); b = units.slice(bestK).join(sep);
    }
    if (!a.trim() || !b.trim()) return null;
    const d = cue.end - cue.start;
    let mid = at != null && at > cue.start + 0.05 && at < cue.end - 0.05 ? at : cue.start + d * ([...a].length / ([...a].length + [...b].length));
    mid = r3(mid);
    const gap = Math.min(RULES.gap, Math.max(0, (cue.end - mid) / 4));
    return [{ ...cue, end: mid, text: wrapText(a, RULES.maxLineChars, spaced).join('\n') }, { ...cue, start: r3(Math.min(cue.end, mid + gap)), text: wrapText(b, RULES.maxLineChars, spaced).join('\n') }];
  }

  /** Join a cue with the one after it: from the first's start to the second's end, the texts re-wrapped together. */
  function mergeCues(a, b, spaced = true) {
    const text = [a.text, b.text].map((t) => String(t || '').replace(/\s*\r?\n\s*/g, spaced ? ' ' : '').trim()).filter(Boolean).join(spaced ? ' ' : '');
    return { ...a, start: Math.min(a.start, b.start), end: Math.max(a.end, b.end), text: wrapText(text, RULES.maxLineChars, spaced).join('\n') };
  }

  /** Index of the cue on screen at `t`, or -1. */
  function cueAt(cues, t) {
    for (let i = 0; i < cues.length; i++) if (cues[i].start <= t + 1e-6 && t < cues[i].end - 1e-6) return i;
    return -1;
  }

  // ---- files -----------------------------------------------------------------------------------------------------------------
  /** A cue's text as it may stand in a file: no empty lines inside it (they end a cue), no stray carriage returns. */
  const fileText = (t) => String(t == null ? '' : t).replace(/\r\n?/g, '\n').split('\n').map((l) => l.replace(/\s+$/g, '')).filter((l) => l.trim() !== '').join('\n');
  const usable = (cues) => cues.filter((c) => c && Number.isFinite(c.start) && Number.isFinite(c.end) && fileText(c.text) !== '').map((c, i) => ({ ...c, i }))
    .sort((a, b) => a.start - b.start || a.i - b.i);

  /** SubRip: numbered blocks, "00:00:01,000 --> 00:00:02,500", CRLF line ends (what Windows players expect). */
  function formatSrt(cues) {
    return usable(cues).map((c, i) => `${i + 1}\r\n${srtTime(c.start)} --> ${srtTime(Math.max(c.end, c.start))}\r\n${fileText(c.text).replace(/\n/g, '\r\n')}\r\n`).join('\r\n');
  }

  const KEEP_TAGS = /^<\/?(?:i|b|u)>$/i;
  /** Escape text for WebVTT: & and < become entities unless they start an entity or an <i>/<b>/<u> tag; "-->" cannot appear. */
  function vttEscape(text) {
    return text.replace(/-->/g, '→').replace(/&(?!(?:amp|lt|gt|nbsp|lrm|rlm);)/g, '&amp;')
      .replace(/<[^>]*>?/g, (m) => (KEEP_TAGS.test(m) ? m : m.replace(/</g, '&lt;').replace(/>/g, '&gt;')));   // a bare > is allowed
  }
  function formatVtt(cues) {
    const body = usable(cues).map((c) => `${vttTime(c.start)} --> ${vttTime(Math.max(c.end, c.start))}\n${vttEscape(fileText(c.text))}\n`).join('\n');
    return 'WEBVTT\n\n' + body;
  }

  const TIME_RE = /^\s*((?:\d+:)?\d{1,2}:\d{1,2}(?:[.,]\d{1,3})?)\s*-->\s*((?:\d+:)?\d{1,2}:\d{1,2}(?:[.,]\d{1,3})?)(.*)$/;
  function stampSeconds(s) {
    const m = /^(?:(\d+):)?(\d{1,2}):(\d{1,2})(?:[.,](\d{1,3}))?$/.exec(s.trim());
    if (!m) return null;
    return Number(m[1] || 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) + (m[4] ? Number(m[4].padEnd(3, '0')) / 1000 : 0);
  }
  const blocksOf = (text) => String(text || '').replace(/^﻿/, '').replace(/\r\n?/g, '\n').split(/\n[ \t]*\n+/).map((b) => b.replace(/^\n+/, '')).filter((b) => b.trim());

  /** Read SubRip. Tolerant: numbers may be missing, "." instead of ",", extra blank lines, a BOM, CRLF or LF. */
  function parseSrt(text) {
    const out = [];
    for (const block of blocksOf(text)) {
      const lines = block.split('\n');
      let k = lines.findIndex((l) => TIME_RE.test(l));
      if (k < 0 || k > 1) continue;
      const m = TIME_RE.exec(lines[k]);
      const start = stampSeconds(m[1]); const end = stampSeconds(m[2]);
      if (start == null || end == null) continue;
      const body = lines.slice(k + 1).map((l) => l.replace(/\s+$/, '')).join('\n').replace(/\{\\[^}]*\}/g, '').trim();
      out.push({ start: r3(start), end: r3(end), text: body });
    }
    return out;
  }

  const unescapeVtt = (t) => t.replace(/<(?!\/?(?:i|b|u)>)[^>]*>/gi, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/&lrm;/g, '‎').replace(/&rlm;/g, '‏').replace(/&amp;/g, '&');
  /** Read WebVTT: the header, NOTE/STYLE/REGION blocks and cue settings are skipped, voice and class tags dropped (i/b/u kept). */
  function parseVtt(text) {
    const blocks = blocksOf(text);
    if (!blocks.length || !/^WEBVTT(?:[ \t].*)?$/.test(blocks[0].split('\n')[0].trim())) throw new UserError('This is not a WebVTT file (it must start with WEBVTT)');
    const out = [];
    blocks[0] = blocks[0].split('\n').slice(1).join('\n');   // the header line (a cue may follow it with no blank line in between in sloppy files)
    for (const block of blocks) {
      if (/^(?:NOTE|STYLE|REGION)(?:\s|$)/.test(block)) continue;
      const lines = block.split('\n');
      const k = lines.findIndex((l) => TIME_RE.test(l));
      if (k < 0 || k > 1) continue;
      const m = TIME_RE.exec(lines[k]);
      const start = stampSeconds(m[1]); const end = stampSeconds(m[2]);
      if (start == null || end == null) continue;
      out.push({ start: r3(start), end: r3(end), text: unescapeVtt(lines.slice(k + 1).join('\n')).trim() });
    }
    return out;
  }

  /** Read either kind, by its first line (the extension is not trusted). */
  function parseSubtitles(text) {
    const t = String(text || '').replace(/^﻿/, '');
    if (/^WEBVTT/.test(t.trimStart())) return { format: 'vtt', cues: parseVtt(t) };
    const cues = parseSrt(t);
    if (!cues.length && t.trim()) throw new UserError('No subtitles were found in this file');
    return { format: 'srt', cues };
  }

  /** Rough time to listen to a file: measured at about a third of its length on a 6-core desktop, plus starting the model. */
  const estimateSeconds = (duration) => duration * 0.45 + 12;
  const defaultName = (name, ext) => `${stem(name) || 'subtitles'}${ext}`;

  return {
    VIDEO_EXTS, AUDIO_EXTS, INPUT_EXTS, SUB_EXTS, UserError, extOf, isMedia, isVideoName, isSubtitle, baseName, stem,
    RULES, NO_SPACE, rulesFor, LANGUAGES, ISO3, languageList,
    srtTime, vttTime, formatTime, parseTime, formatDuration,
    cleanText, visibleLength, wrapText, cps, cueProblems, buildCues, timeCues,
    shiftCues, splitCue, mergeCues, cueAt,
    fileText, formatSrt, formatVtt, vttEscape, parseSrt, parseVtt, parseSubtitles, estimateSeconds, defaultName,
  };
}));
