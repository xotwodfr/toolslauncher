'use strict';
// Pure helpers shared by the main process, the tests and the window (loaded with <script> there): turning the recogniser's
// segments and word times into lyric lines (each keeping the time of every word), writing and reading word-synced .ttml files and
// .lrc files, time formats, the language list, and estimates.
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
    const r2 = (x) => Math.round(x * 100) / 100;
    const push = (parts, start, end, words) => {
      const text = cleanText(join(parts));
      if (!text) return;
      const line = { start: r2(start), end: r2(Math.max(end, start)), text };
      if (words) {
        // keep the words that are still there once music symbols and labels are cleaned away, each with its own time
        const kept = words.map((w) => ({ text: cleanText(w.text), start: r2(w.start), end: r2(Math.max(w.end, w.start)) })).filter((w) => w.text);
        if (kept.length && join(kept.map((w) => w.text)) === text) line.words = kept;
      }
      lines.push(line);
    };
    const flush = (cur) => { if (cur.length) push(cur.map((x) => x.text), cur[0].start, cur[cur.length - 1].end, cur); };
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
    for (let i = 1; i < lines.length; i++) {
      if (lines[i].start < lines[i - 1].start) {
        lines[i].start = lines[i - 1].start;
        if (lines[i].end < lines[i].start) lines[i].end = lines[i].start;
        if (lines[i].words) for (const w of lines[i].words) { w.start = Math.max(w.start, lines[i].start); w.end = Math.max(w.end, w.start); }
      }
    }
    return lines;
  }

  // ---- words ------------------------------------------------------------------------------------------------------------------
  /** The words of a line's text: split at spaces, or one character at a time for languages written without spaces. */
  function splitWords(text, spaced = true) {
    const t = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
    if (!t) return [];
    if (spaced) return t.split(' ');
    return Array.from(t).filter((c) => c !== ' ');
  }
  /** Is this text written without spaces between words (Chinese, Japanese, Thai...)? A guess from the characters used. */
  const looksUnspaced = (text) => /[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff\u0e00-\u0e7f\u0e80-\u0eff\u1000-\u109f\u1780-\u17ff]/.test(String(text)) && !/\s/.test(String(text).trim());

  /** Where line i ends: its own end if it has one, otherwise when the next line starts (and never more than 8 s after it starts). */
  function lineEnd(lines, i, duration) {
    const l = lines[i];
    const next = i + 1 < lines.length ? lines[i + 1].start : Infinity;
    let end = Number.isFinite(l.end) && l.end > l.start ? l.end : Math.min(next, l.start + 8);
    if (l.words && l.words.length) end = Math.max(end, l.words[l.words.length - 1].end);
    end = Math.min(end, next > l.start ? next : end);
    if (Number.isFinite(duration) && duration > l.start) end = Math.min(end, duration);
    if (!(end > l.start)) end = Math.min(l.start + 2, next > l.start ? next : l.start + 2);
    return Math.round(end * 1000) / 1000;
  }

  /**
   * Give every word of a line a time. Words that still match the line's text keep the times they had; when the text was changed
   * so the words no longer match, the line's time is shared out over its words by their length (longer words get longer).
   * @returns {{text:string,start:number,end:number}[]}
   */
  function timeWords(line, end, spaced = true) {
    const texts = splitWords(line.text, spaced);
    if (!texts.length) return [];
    const start = line.start;
    const old = Array.isArray(line.words) ? line.words : [];
    if (old.length === texts.length) {
      return texts.map((text, i) => ({ text, start: old[i].start, end: old[i].end }));
    }
    const from = old.length ? Math.max(start, Math.min(old[0].start, end)) : start;
    const to = Math.max(from + 0.05 * texts.length, end);
    const weight = texts.map((t) => Math.max(1, Array.from(t).length) + 1);
    const total = weight.reduce((a, b) => a + b, 0);
    let t = from;
    return texts.map((text, i) => { const d = ((to - from) * weight[i]) / total; const w = { text, start: t, end: t + d }; t += d; return w; });
  }

  /**
   * Lines ready to write as word-synced lyrics: sorted, empty lines dropped, each with an end and with timed words that never go
   * backwards, never overlap, and stay inside their line.
   */
  function timedLines(lines, { spaced, duration } = {}) {
    const r3 = (x) => Math.round(x * 1000) / 1000;
    const list = lines.filter((l) => l && String(l.text).trim() !== '' && Number.isFinite(l.start))
      .map((l, i) => ({ ...l, text: String(l.text).replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim(), start: Math.max(0, l.start), i }))
      .sort((a, b) => a.start - b.start || a.i - b.i);
    return list.map((l, i) => {
      const sp = spaced == null ? !looksUnspaced(l.text) : spaced;
      const end = lineEnd(list, i, duration);
      const words = timeWords(l, end, sp);
      let prev = l.start;
      const fixed = words.map((w, k) => {
        let s = Math.min(Math.max(Number.isFinite(w.start) ? w.start : prev, prev), end);
        if (k === 0) s = Math.max(s, l.start);
        let e = Math.min(Math.max(Number.isFinite(w.end) ? w.end : s, s), end);
        const nextStart = k + 1 < words.length && Number.isFinite(words[k + 1].start) ? Math.max(words[k + 1].start, s) : end;
        e = Math.min(e, nextStart);
        if (e <= s) e = Math.min(s + 0.05, end);
        prev = e;
        return { text: w.text, start: r3(s), end: r3(Math.max(e, s)) };
      });
      const lineStart = fixed.length ? Math.min(l.start, fixed[0].start) : l.start;
      return { start: r3(lineStart), end: r3(Math.max(end, fixed.length ? fixed[fixed.length - 1].end : end)), text: l.text, words: fixed, spaced: sp };
    });
  }

  /** Index of the word being sung at `t` in a line with timed words, or -1 (before its first word). */
  function currentWord(words, t) {
    let idx = -1;
    if (!Array.isArray(words)) return idx;
    for (let i = 0; i < words.length; i++) { if (words[i].start <= t + 1e-6) idx = i; else break; }
    return idx;
  }

  /** @param {{start:number,text:string}[]} lines */
  function formatLrc(lines) {
    const sorted = lines.filter((l) => l && String(l.text).trim() !== '' && Number.isFinite(l.start)).map((l, i) => ({ ...l, i })).sort((a, b) => a.start - b.start || a.i - b.i);
    return sorted.map((l) => `${lrcStamp(l.start)}${String(l.text).replace(/[\r\n]+/g, ' ').trim()}`).join('\r\n') + (sorted.length ? '\r\n' : '');
  }
  const formatPlain = (lines) => lines.filter((l) => l && String(l.text).trim()).map((l) => String(l.text).replace(/[\r\n]+/g, ' ').trim()).join('\r\n') + '\r\n';

  // ---- TTML (word-synced lyrics) ------------------------------------------------------------------------------------------------
  /** 65.4 -> "00:01:05.400" (a TTML clock time, hours always written, milliseconds) */
  function ttmlTime(sec) {
    const t = Math.max(0, Math.round(Number(sec) * 1000));
    const h = Math.floor(t / 3600000); const m = Math.floor((t % 3600000) / 60000); const s = Math.floor((t % 60000) / 1000); const ms = t % 1000;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
  }
  /** A TTML time expression -> seconds, or null: "00:01:05.400", "1:05.4", "65.4s", "1200ms", "1.5m", "0.5h", "65.4" */
  function parseTtmlTime(text) {
    const s = String(text == null ? '' : text).trim();
    let m = /^(?:(\d+):)?(\d{1,2}):(\d{1,2}(?:\.\d+)?)$/.exec(s);
    if (m) { if (Number(m[2]) > 59 && m[1] != null) return null; if (Number(m[3]) >= 60) return null; return (m[1] ? Number(m[1]) * 3600 : 0) + Number(m[2]) * 60 + Number(m[3]); }
    m = /^(\d+(?:\.\d+)?)(h|m|s|ms)?$/.exec(s);
    if (m) { const v = Number(m[1]); return m[2] === 'h' ? v * 3600 : m[2] === 'm' ? v * 60 : m[2] === 'ms' ? v / 1000 : v; }
    return null;
  }
  const xmlEscape = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const xmlUnescape = (s) => String(s).replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_m, e) => {
    const k = e.toLowerCase();
    if (k[0] === '#') { const n = k[1] === 'x' ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10); try { return String.fromCodePoint(n); } catch { return ''; } }
    return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[k];
  });
  // characters XML 1.0 does not allow at all
  const xmlSafe = (s) => String(s).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g, '');

  /**
   * Write word-synced lyrics as TTML (Timed Text Markup Language), the format Apple Music and other karaoke-style lyric players
   * read: one <p> per line with its start and end, and a <span> with its own start and end for every word.
   * @param {{start:number,end?:number,text:string,words?:{text:string,start:number,end:number}[]}[]} lines
   * @param {{language?:string, title?:string, duration?:number, spaced?:boolean}} [o]
   */
  function formatTtml(lines, { language, title, duration, spaced } = {}) {
    const list = timedLines(lines, { spaced, duration });
    const lang = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(String(language || '')) ? language : '';
    const last = list.length ? list[list.length - 1].end : 0;
    const dur = Number.isFinite(duration) && duration > last ? duration : last;
    const out = ['<?xml version="1.0" encoding="UTF-8"?>'];
    out.push(`<tt xmlns="http://www.w3.org/ns/ttml" xmlns:ttm="http://www.w3.org/ns/ttml#metadata" xmlns:itunes="http://music.apple.com/lyric-ttml-internal" itunes:timing="Word"${lang ? ` xml:lang="${lang}"` : ''}>`);
    out.push('  <head>', '    <metadata>');
    if (title) out.push(`      <ttm:title>${xmlEscape(xmlSafe(title))}</ttm:title>`);
    out.push('      <ttm:agent type="person" xml:id="v1"/>', '    </metadata>', '  </head>');
    out.push(`  <body dur="${ttmlTime(dur)}">`);
    if (list.length) {
      out.push(`    <div begin="${ttmlTime(list[0].start)}" end="${ttmlTime(last)}">`);
      list.forEach((l, i) => {
        const sep = l.spaced ? ' ' : '';
        const spans = l.words.map((w) => `<span begin="${ttmlTime(w.start)}" end="${ttmlTime(w.end)}">${xmlEscape(xmlSafe(w.text))}</span>`).join(sep);
        out.push(`      <p begin="${ttmlTime(l.start)}" end="${ttmlTime(l.end)}" itunes:key="L${i + 1}" ttm:agent="v1">${spans}</p>`);
      });
      out.push('    </div>');
    }
    out.push('  </body>', '</tt>');
    return out.join('\n') + '\n';
  }

  /**
   * Read a TTML lyrics file (ours, Apple Music's, or another program's): every <p> becomes a line, and every <span> that has
   * its own time becomes a timed word. A file timed by line only gives lines without word times. Background vocals
   * (ttm:role="x-bg") are kept, in brackets, as part of the line.
   * @returns {{start:number,end:number,text:string,words?:{text:string,start:number,end:number}[]}[]}
   */
  function parseTtml(text) {
    const src = String(text || '').replace(/^\uFEFF/, '').replace(/<!--[\s\S]*?-->/g, '').replace(/<\?[\s\S]*?\?>/g, '');
    if (!/<tt[\s>]/.test(src)) throw new UserError('This is not a TTML lyrics file');
    // attributes by local name (itunes:key -> key, ttm:role -> role), except xml:lang and such, which keep their prefix
    const attrs = (tag) => { const a = {}; for (const m of tag.matchAll(/([\w:.-]+)\s*=\s*("([^"]*)"|'([^']*)')/g)) a[m[1].startsWith('xml:') ? m[1] : m[1].replace(/^.*:/, '')] = xmlUnescape(m[3] != null ? m[3] : m[4]); return a; };
    const out = [];
    const r3 = (x) => Math.round(x * 1000) / 1000;
    for (const pm of src.matchAll(/<p(\s[^>]*)?>([\s\S]*?)<\/p>/g)) {
      const pa = attrs(pm[1] || '');
      const pStart = parseTtmlTime(pa.begin); let pEnd = parseTtmlTime(pa.end);
      if (pEnd == null && pStart != null && pa.dur) { const d = parseTtmlTime(pa.dur); if (d != null) pEnd = pStart + d; }
      // walk the inside of the <p>: text, <span ...>, </span>, <br/>
      const words = []; let plain = ''; const stack = [];
      let bgOpen = false; let bgFirst = -1;      // inside background vocals: their words are kept, in brackets
      for (const tm of pm[2].matchAll(/<(\/?)([\w:.-]+)([^>]*?)(\/?)>|([^<]+)/g)) {
        if (tm[5] != null) {
          const txt = xmlUnescape(tm[5]);
          plain += txt;
          const top = stack[stack.length - 1];
          if (top && top.timed) top.text += txt;
          continue;
        }
        const name = tm[2].replace(/^.*:/, '');
        if (name === 'br') { plain += ' '; continue; }
        if (name !== 'span' || tm[4]) continue;          // other tags, and an empty <span/>
        if (tm[1]) {
          const sp = stack.pop();
          if (!sp) continue;
          if (sp.timed) {
            const t = sp.text.replace(/\s+/g, ' ').trim();
            if (t) {
              words.push({ text: t, start: r3(sp.start), end: r3(Math.max(sp.end, sp.start)), glued: words.length > 0 && !sp.spaceBefore && !/^\s/.test(sp.text) });
              if (bgOpen && bgFirst < 0) bgFirst = words.length - 1;
            }
          }
          if (sp.bg) {
            plain += ')';
            if (bgFirst >= 0) { words[bgFirst].text = '(' + words[bgFirst].text; words[bgFirst].glued = false; words[words.length - 1].text += ')'; }
            bgOpen = false; bgFirst = -1;
          }
          continue;
        }
        const at = attrs(tm[3] || '');
        const bg = at.role === 'x-bg' && !bgOpen;
        const st = parseTtmlTime(at.begin); let en = parseTtmlTime(at.end);
        if (en == null && st != null && at.dur) { const d = parseTtmlTime(at.dur); if (d != null) en = st + d; }
        // a span that holds other timed spans (background vocals, or a word split in syllables) is not a word itself
        const holds = /^[^]*?<span[^>]*begin=/.test(pm[2].slice(tm.index + tm[0].length).split(/<\/span>/)[0]);
        stack.push({ bg, timed: st != null && !holds, start: st, end: en == null ? st : en, text: '', spaceBefore: plain === '' || /\s$/.test(plain) });
        if (bg) { plain += plain && !/\s$/.test(plain) ? ' (' : '('; bgOpen = true; bgFirst = -1; }
      }
      const lineText = plain.replace(/\(\s+/g, '(').replace(/\s+\)/g, ')').replace(/\s+/g, ' ').trim();
      if (!lineText) continue;
      const start = pStart != null ? pStart : words.length ? words[0].start : null;
      if (start == null) continue;
      const end = Math.max(pEnd != null ? pEnd : start, words.length ? words[words.length - 1].end : start);
      const line = { start: r3(start), end: r3(Math.max(end, start)), text: lineText };
      if (words.length) {
        // syllables written as separate spans with nothing between them ("ba", "by") make one word, unless the language is
        // written without spaces, where every character is its own word
        const merged = [];
        const unspaced = looksUnspaced(lineText);
        for (const w of words) {
          const prev = merged[merged.length - 1];
          if (w.glued && prev && !unspaced) { prev.text += w.text; prev.end = Math.max(prev.end, w.end); } else merged.push({ text: w.text, start: w.start, end: w.end });
        }
        line.words = merged;
      }
      out.push(line);
    }
    return out.map((l, i) => ({ l, i })).sort((a, b) => a.l.start - b.l.start || a.i - b.i).map((x) => x.l);
  }

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

  /** Move every line (and every word in it) by `delta` seconds (never before 0). */
  const mv = (x, delta) => Math.max(0, Math.round((x + delta) * 1000) / 1000);
  const shiftLines = (lines, delta) => lines.map((l) => ({
    ...l, start: mv(l.start, delta),
    ...(l.end != null ? { end: mv(l.end, delta) } : {}),
    ...(Array.isArray(l.words) ? { words: l.words.map((w) => ({ ...w, start: mv(w.start, delta), end: mv(w.end, delta) })) } : {}),
  }));

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
    splitWords, looksUnspaced, lineEnd, timeWords, timedLines, currentWord, ttmlTime, parseTtmlTime, formatTtml, parseTtml, xmlEscape,
  };
}));
