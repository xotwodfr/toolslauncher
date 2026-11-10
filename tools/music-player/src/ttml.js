'use strict';
// TTML (Timed Text Markup Language) lyrics: the word-synced format Apple Music, Lyrics Maker and other karaoke-style tools write.
// One <p> per line with its begin and end, and a <span> with its own begin and end for every word (or syllable). Pure functions,
// no Electron or Node APIs: the main process, the renderer and the tests all load this one file (`require` in Node, a <script>
// tag in the page which exposes `window.TTML`). Times are in milliseconds, like lrc.js.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TTML = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  const MAX_CHARS = 4 * 1024 * 1024;

  /** A TTML time expression -> ms, or null: "00:01:05.400", "1:05.4", "65.4s", "1200ms", "1.5m", "0.5h", "65.4" */
  function parseTime(text) {
    const s = String(text == null ? '' : text).trim();
    let m = /^(?:(\d+):)?(\d{1,2}):(\d{1,2}(?:\.\d+)?)$/.exec(s);
    if (m) {
      if ((m[1] != null && Number(m[2]) > 59) || Number(m[3]) >= 60) return null;
      return Math.round(((m[1] ? Number(m[1]) * 3600 : 0) + Number(m[2]) * 60 + Number(m[3])) * 1000);
    }
    m = /^(\d+(?:\.\d+)?)(h|m|s|ms)?$/.exec(s);
    if (m) { const v = Number(m[1]); return Math.round(m[2] === 'h' ? v * 3600000 : m[2] === 'm' ? v * 60000 : m[2] === 'ms' ? v : v * 1000); }
    return null;
  }

  const unescape = (s) => String(s).replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_m, e) => {
    const k = e.toLowerCase();
    if (k[0] === '#') { const n = k[1] === 'x' ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10); try { return String.fromCodePoint(n); } catch { return ''; } }
    return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[k];
  });
  // attributes by local name (itunes:key -> key, ttm:role -> role), except xml:lang and such, which keep their prefix
  const attrs = (tag) => {
    const a = {};
    for (const m of tag.matchAll(/([\w:.-]+)\s*=\s*("([^"]*)"|'([^']*)')/g)) a[m[1].startsWith('xml:') ? m[1] : m[1].replace(/^.*:/, '')] = unescape(m[3] != null ? m[3] : m[4]);
    return a;
  };
  /** Text written without spaces between words (Chinese, Japanese, Thai...): every character span is its own word there. */
  const unspaced = (text) => /[぀-ヿ㐀-鿿豈-﫿฀-๿຀-໿က-႟ក-៿]/.test(text) && !/\s/.test(text.trim());
  const isTtml = (text) => /<tt[\s>]/.test(String(text || '').slice(0, 8192));

  /**
   * @param {string} text
   * @returns {{ lines: {t:number, end:number, text:string, words?:{t:number,end:number,text:string}[]}[], synced: boolean, wordSynced: boolean, meta: object }}
   *   Every <p> with a time becomes a line; every <span> with its own time a word. Syllables written as spans with nothing
   *   between them make one word. Background vocals (ttm:role="x-bg") are kept, in brackets.
   */
  function parse(text) {
    const src = String(text == null ? '' : text).replace(/^﻿/, '').slice(0, MAX_CHARS).replace(/<!--[\s\S]*?-->/g, '').replace(/<\?[\s\S]*?\?>/g, '');
    const meta = {};
    const rootTag = /<tt(\s[^>]*)?>/.exec(src);
    if (!rootTag) return { lines: [], synced: false, wordSynced: false, meta };
    const ra = attrs(rootTag[1] || '');
    if (ra['xml:lang']) meta.language = ra['xml:lang'];
    const title = /<(?:\w+:)?title[^>]*>([^<]*)<\/(?:\w+:)?title>/.exec(src);
    if (title && title[1].trim()) meta.title = unescape(title[1].trim());
    const lines = [];
    for (const pm of src.matchAll(/<p(\s[^>]*)?>([\s\S]*?)<\/p>/g)) {
      const pa = attrs(pm[1] || '');
      const pStart = parseTime(pa.begin); let pEnd = parseTime(pa.end);
      if (pEnd == null && pStart != null && pa.dur) { const d = parseTime(pa.dur); if (d != null) pEnd = pStart + d; }
      const words = []; let plain = ''; const stack = [];
      let bgOpen = false; let bgFirst = -1;
      const inner = pm[2];
      for (const tm of inner.matchAll(/<(\/?)([\w:.-]+)([^>]*?)(\/?)>|([^<]+)/g)) {
        if (tm[5] != null) {
          const txt = unescape(tm[5]);
          plain += txt;
          const top = stack[stack.length - 1];
          if (top && top.timed) top.text += txt;
          continue;
        }
        const name = tm[2].replace(/^.*:/, '');
        if (name === 'br') { plain += ' '; continue; }
        if (name !== 'span' || tm[4]) continue;
        if (tm[1]) {
          const sp = stack.pop();
          if (!sp) continue;
          if (sp.timed) {
            const t = sp.text.replace(/\s+/g, ' ').trim();
            if (t) {
              words.push({ t: sp.start, end: Math.max(sp.end, sp.start), text: t, glued: words.length > 0 && !sp.spaceBefore && !/^\s/.test(sp.text) });
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
        const a = attrs(tm[3] || '');
        const bg = a.role === 'x-bg' && !bgOpen;
        const st = parseTime(a.begin); let en = parseTime(a.end);
        if (en == null && st != null && a.dur) { const d = parseTime(a.dur); if (d != null) en = st + d; }
        // a span that holds other timed spans (background vocals, or a word split in syllables) is not a word itself
        const holds = /<span[^>]*\sbegin=/.test(inner.slice(tm.index + tm[0].length).split(/<\/span>/)[0]);
        stack.push({ bg, timed: st != null && !holds, start: st, end: en == null ? st : en, text: '', spaceBefore: plain === '' || /\s$/.test(plain) });
        if (bg) { plain += plain && !/\s$/.test(plain) ? ' (' : '('; bgOpen = true; bgFirst = -1; }
      }
      const lineText = plain.replace(/\(\s+/g, '(').replace(/\s+\)/g, ')').replace(/\s+/g, ' ').trim();
      if (!lineText) continue;
      const start = pStart != null ? pStart : words.length ? words[0].t : null;
      if (start == null) continue;
      const end = Math.max(pEnd != null ? pEnd : start, words.length ? words[words.length - 1].end : start);
      const line = { t: start, end, text: lineText };
      if (words.length) {
        const merged = [];
        const cjk = unspaced(lineText);
        for (const w of words) {
          const prev = merged[merged.length - 1];
          if (w.glued && prev && !cjk) { prev.text += w.text; prev.end = Math.max(prev.end, w.end); } else merged.push({ t: w.t, end: w.end, text: w.text, ...(cjk ? { glue: true } : {}) });
        }
        line.words = merged;
      }
      lines.push(line);
    }
    lines.sort((a, b) => a.t - b.t);
    return { lines, synced: lines.length > 0, wordSynced: lines.some((l) => l.words && l.words.length), meta };
  }

  /** Index of the word being sung at `ms` in a line, or -1 before its first word. */
  function activeWord(words, ms) {
    let idx = -1;
    if (!Array.isArray(words)) return idx;
    for (let i = 0; i < words.length; i++) { if (words[i].t <= ms) idx = i; else break; }
    return idx;
  }

  return { parse, parseTime, activeWord, isTtml, MAX_CHARS };
}));
