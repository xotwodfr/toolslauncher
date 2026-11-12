'use strict';
// LRC (synced lyrics) parsing and writing. Pure functions, no Electron or Node APIs: the main process, the renderer and the
// tests all load this one file (`require` in Node, a <script> tag in the page which exposes `window.LRC`).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.LRC = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  const MAX_CHARS = 1024 * 1024;
  const META_KEYS = { ti: 'title', ar: 'artist', al: 'album', au: 'author', by: 'by', length: 'length', offset: 'offset', re: 'tool', tool: 'tool', ve: 'version', la: 'language' };
  const TIME_TAG = /\[(\d{1,4}):(\d{1,2})(?:[.:](\d{1,3}))?\]/y;
  const META_LINE = /^\[([A-Za-z]{2,6}):(.*)\]\s*$/;
  const WORD_TAG = /<\d{1,4}:\d{1,2}(?:[.:]\d{1,3})?>/g; // enhanced LRC <mm:ss.xx> word times (kept as `words`, see wordsOf)

  /** "12" -> 120 ms, "123" -> 123 ms, "1" -> 100 ms (digits are a decimal fraction of a second). */
  const fractionToMs = (f) => (f ? Number((f + '00').slice(0, 3)) : 0);

  /**
   * Enhanced LRC ("<00:10.00>Hel<00:10.50>lo <00:11.00>world <00:11.60>"): the time before each piece is when it is sung. Pieces
   * with no space between them are syllables of one word. A last tag with nothing after it is when the last word ends.
   * @returns {{t:number,end:number,text:string}[]|null}  null when the line has no word times
   */
  function wordsOf(body) {
    const re = /<(\d{1,4}):(\d{1,2})(?:[.:](\d{1,3}))?>/g;
    const pieces = []; let m; let last = null; let pos = 0; let lead = '';
    while ((m = re.exec(body))) {
      const between = body.slice(pos, m.index);
      if (last) last.text += between; else lead += between;
      const sec = Number(m[2]);
      const t = sec < 60 ? Number(m[1]) * 60000 + sec * 1000 + fractionToMs(m[3]) : null;
      last = t == null ? last : { t, text: '' };
      if (t != null) pieces.push(last);
      pos = re.lastIndex;
    }
    if (!pieces.length) return null;
    pieces[pieces.length - 1].text += body.slice(pos);
    const words = [];
    pieces.forEach((p, i) => {
      const end = i + 1 < pieces.length ? pieces[i + 1].t : p.t;
      const glued = words.length && !/^\s/.test(p.text) && !/\s$/.test(pieces[i - 1].text);
      const text = p.text.replace(/\s+/g, ' ').trim();
      if (!text) { if (words.length && i === pieces.length - 1) words[words.length - 1].end = Math.max(words[words.length - 1].end, p.t); return; }
      if (glued && words.length) { const w = words[words.length - 1]; w.text += text; w.end = Math.max(w.end, end); } else words.push({ t: p.t, end: Math.max(end, p.t), text });
    });
    if (lead.trim() && words.length) words[0].text = lead.trim() + ' ' + words[0].text;
    for (let i = 0; i < words.length; i++) if (words[i].end <= words[i].t) words[i].end = i + 1 < words.length ? words[i + 1].t : words[i].t + 500;
    return words.length ? words : null;
  }

  /**
   * @param {string} text
   * @param {{applyOffset?: boolean}} [opts]  apply the [offset:+ms] tag (default true; positive = lyrics appear earlier)
   * @returns {{ lines: {t: number|null, text: string}[], synced: boolean, meta: object }}
   */
  function parse(text, opts = {}) {
    const applyOffset = opts.applyOffset !== false;
    const src = String(text == null ? '' : text).replace(/^﻿/, '').slice(0, MAX_CHARS);
    const meta = {};
    const timed = [];
    const plain = [];
    for (const raw of src.split(/\r\n|\r|\n/)) {
      const line = raw.trim();
      const m = META_LINE.exec(line);
      if (m && META_KEYS[m[1].toLowerCase()]) { meta[META_KEYS[m[1].toLowerCase()]] = m[2].trim(); continue; }
      const stamps = [];
      let pos = 0;
      for (;;) {
        TIME_TAG.lastIndex = pos;
        const t = TIME_TAG.exec(line);
        if (!t) break;
        const sec = Number(t[2]);
        if (sec < 60) stamps.push(Number(t[1]) * 60000 + sec * 1000 + fractionToMs(t[3]));
        pos = TIME_TAG.lastIndex;
      }
      const rest = line.slice(pos);
      const body = rest.replace(WORD_TAG, '').replace(/\s{2,}/g, ' ').trim();
      const words = stamps.length === 1 ? wordsOf(rest) : null;   // word times only make sense for a line sung once
      if (stamps.length) for (const t of stamps) timed.push(words ? { t, text: body, words } : { t, text: body });
      else if (line) plain.push({ t: null, text: line });
    }
    if (!timed.length) return { lines: plain, synced: false, meta };
    let offset = 0;
    if (applyOffset && meta.offset != null && Number.isFinite(Number(meta.offset))) offset = Number(meta.offset);
    const lines = timed.map((l, i) => ({ l, i })).sort((a, b) => a.l.t - b.l.t || a.i - b.i)
      .map(({ l }) => (l.words
        ? { t: Math.max(0, l.t - offset), text: l.text, words: l.words.map((w) => ({ t: Math.max(0, w.t - offset), end: Math.max(0, w.end - offset), text: w.text })) }
        : { t: Math.max(0, l.t - offset), text: l.text }));
    return { lines, synced: true, meta };
  }

  /** mm:ss.xx (centiseconds, rounded; minutes can exceed 99). */
  function formatTime(ms) {
    const cs = Math.max(0, Math.round(ms / 10));
    const m = Math.floor(cs / 6000);
    const s = Math.floor((cs % 6000) / 100);
    const c = cs % 100;
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(c).padStart(2, '0')}`;
  }

  const oneLine = (s) => String(s == null ? '' : s).replace(/[\r\n\]]+/g, ' ').trim();

  /** Write lines (and optional header info) as LRC text. Lines without a time are written as plain text. */
  function serialize(lines, meta = {}) {
    const out = [];
    for (const k of ['title', 'artist', 'album']) {
      const tag = { title: 'ti', artist: 'ar', album: 'al' }[k];
      if (meta[k]) out.push(`[${tag}:${oneLine(meta[k])}]`);
    }
    if (meta.length) out.push(`[length:${oneLine(meta.length)}]`);
    for (const l of lines) {
      const text = String(l.text == null ? '' : l.text).replace(/[\r\n]+/g, ' ').trim();
      out.push(l.t == null ? text : `[${formatTime(l.t)}]${text}`);
    }
    return out.join('\n') + '\n';
  }

  /** Index of the line being sung at `ms` (last line whose time <= ms), or -1 before the first line. Lines must be sorted. */
  function activeIndex(lines, ms) {
    let lo = 0;
    let hi = lines.length - 1;
    let ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (lines[mid].t != null && lines[mid].t <= ms) { ans = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return ans;
  }

  /** Does this text contain at least one [mm:ss] time tag? (embedded lyrics are sometimes LRC text) */
  const looksSynced = (text) => /\[\d{1,4}:\d{2}(?:[.:]\d{1,3})?\]/.test(String(text || ''));

  /** Shift every timed line by `deltaMs` (never below 0). Returns new lines. */
  const shift = (lines, deltaMs) => lines.map((l) => (l.t == null ? { ...l } : { ...l, t: Math.max(0, l.t + deltaMs) }));

  return { parse, serialize, formatTime, activeIndex, looksSynced, shift, MAX_CHARS };
}));
