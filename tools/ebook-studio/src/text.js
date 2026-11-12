'use strict';
// Plain text books: decoding (UTF-8, UTF-16, old Windows code page), splitting into chapters on "Chapter N" style lines,
// and paragraphs (hard-wrapped lines joined, short lines such as poetry kept).
const { escText, xmlSafe } = require('./xhtml');

/** Bytes -> string: BOM first, then strict UTF-8, else Windows-1252 (what old .txt files usually are). */
function decodeText(buf) {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) return new TextDecoder('utf-8').decode(b.subarray(3));
  if (b[0] === 0xff && b[1] === 0xfe) return new TextDecoder('utf-16le').decode(b.subarray(2));
  if (b[0] === 0xfe && b[1] === 0xff) return new TextDecoder('utf-16be').decode(b.subarray(2));
  try { return new TextDecoder('utf-8', { fatal: true }).decode(b); } catch { /* not UTF-8 */ }
  try { return new TextDecoder('windows-1252').decode(b); } catch { return new TextDecoder('latin1').decode(b); }
}

const NUMBER_WORDS = 'one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|last';
const NUM = `(?:\\d{1,4}|[ivxlcdm]{1,8}|(?:${NUMBER_WORDS})(?:[\\s-]+(?:${NUMBER_WORDS}))*)`;
const CHAPTER_RE = new RegExp(`^\\s*(?:chapter|chap\\.|chapitre|kapitel|cap[ií]tulo|capitolo|hoofdstuk|kapittel|luku|rozdzia[lł])\\s+${NUM}\\b\\.?(?:\\s*[:.\\-–—]\\s*.*|\\s+\\S.*)?$`, 'i');
const PART_RE = new RegExp(`^\\s*(?:part|book|volume)\\s+${NUM}\\b\\.?(?:\\s*[:.\\-–—]\\s*.*|\\s+\\S.*)?$`, 'i');
const SPECIAL_RE = /^\s*(?:prologue|epilogue|introduction|preface|foreword|afterword|appendix(?:\s+[a-z0-9]+)?|acknowledg(?:e)?ments|interlude)\s*[.:]?\s*$/i;

/** Is this line a chapter heading? (short, on its own, "Chapter 3", "CHAPTER IV. The Storm", "Part Two", "Prologue"...) */
function isHeading(line) {
  const l = line.trim();
  if (!l || l.length > 80) return false;
  return CHAPTER_RE.test(l) || PART_RE.test(l) || SPECIAL_RE.test(l);
}

/**
 * Split a text into chapters: [{ title, text }]. A heading line must stand alone (blank line before it, or the start).
 * The title is the heading line, plus the next short line when that looks like a chapter name ("Chapter 1" / "The Storm").
 * Text before the first heading becomes a first chapter only if it has real content. With no headings at all, a long
 * text is cut into parts of about `partSize` characters at paragraph breaks, so a reader does not get one giant page.
 */
function splitChapters(text, { partSize = 60000, fallbackTitle = 'Start' } = {}) {
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
  const marks = [];
  for (let i = 0; i < lines.length; i++) {
    if (!isHeading(lines[i])) continue;
    if (i > 0 && lines[i - 1].trim() !== '') continue;
    marks.push(i);
  }
  // a table of contents at the start lists the headings line after line: those are not chapter starts
  const real = marks.filter((m, k) => {
    const next = marks[k + 1];
    if (next === undefined) return true;
    // an entry of a contents list: nothing but more heading lines (or blank lines) until the next heading
    return lines.slice(m + 1, next).some((l) => l.trim() && !isHeading(l));
  });
  const chapters = [];
  if (!real.length) {
    const all = lines.join('\n').trim();
    if (all.length <= partSize * 1.5) return [{ title: fallbackTitle, text: all }];
    const paras = all.split(/\n\s*\n/);
    let cur = []; let len = 0;
    for (const p of paras) { cur.push(p); len += p.length; if (len >= partSize) { chapters.push({ title: `Part ${chapters.length + 1}`, text: cur.join('\n\n') }); cur = []; len = 0; } }
    if (cur.length) chapters.push({ title: `Part ${chapters.length + 1}`, text: cur.join('\n\n') });
    return chapters;
  }
  const before = lines.slice(0, real[0]).join('\n').trim();
  if (before.replace(/\s+/g, '').length > 0) chapters.push({ title: fallbackTitle, text: before });
  real.forEach((m, k) => {
    const end = k + 1 < real.length ? real[k + 1] : lines.length;
    let title = lines[m].trim().replace(/\s+/g, ' ');
    let start = m + 1;
    // "CHAPTER I" followed by a short title line ("Down the Rabbit-Hole") and a blank line
    let j = start; while (j < end && lines[j].trim() === '') j++;
    if (j < end && lines[j].trim().length <= 70 && !/[.!?,;]["'”’)]?$/.test(lines[j].trim()) && /^\s*$/.test(lines[j + 1] || '') && !/[:.\-–—]\s*\S/.test(title.replace(/^\S+\s+\S+/, ''))) {
      title += ': ' + lines[j].trim(); start = j + 1;
    }
    chapters.push({ title, text: lines.slice(start, end).join('\n').trim() });
  });
  return chapters;
}

/**
 * Plain text -> XHTML paragraphs. Paragraphs are separated by blank lines. Inside a paragraph, lines that look
 * hard-wrapped (most of them long) are joined with spaces; short lines (poems, addresses) keep their line breaks.
 * A text with no blank lines at all is taken as one paragraph per line.
 */
function textToXhtml(text) {
  const t = String(text).replace(/\r\n?/g, '\n').trim();
  if (!t) return '';
  let paras = t.split(/\n[ \t]*\n+/);
  if (paras.length === 1 && t.split('\n').length > 3) paras = t.split('\n');
  return paras.map((p) => {
    const lines = p.split('\n').map((l) => l.replace(/\s+$/, ''));
    if (lines.length === 1 && /^\s*(\*\s*){3,}$|^\s*(-\s*){3,}$|^\s*#\s*$/.test(lines[0])) return '<hr/>';
    const long = lines.filter((l) => l.trim().length > 55).length;
    const wrapped = lines.length > 1 && long >= Math.ceil((lines.length - 1) * 0.6);
    const body = wrapped ? lines.map((l) => l.trim()).join(' ') : lines.map((l) => l.trim()).join('\n');
    return '<p>' + escText(xmlSafe(body)).replace(/\n/g, '<br/>') + '</p>';
  }).join('\n');
}

module.exports = { decodeText, splitChapters, isHeading, textToXhtml };
