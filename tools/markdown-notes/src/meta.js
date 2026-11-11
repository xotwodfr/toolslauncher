'use strict';
// Front matter, tags, titles and wiki links: the plain-text facts about a note. No Electron, no file system.

/**
 * Split YAML front matter off a note. Only a small, safe subset of YAML is read (it is never executed):
 *   key: value            strings, numbers, true/false
 *   key: [a, b, "c d"]    inline lists
 *   key:                  block lists
 *     - a
 * Returns { data, body, bodyLine } where bodyLine is the 0-based line the body starts on.
 */
function parseFrontMatter(text) {
  const src = String(text || '').replace(/^\p{Cf}+/u, '');
  const m = /^---[ \t]*\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/.exec(src);
  if (!m) return { data: {}, body: src, bodyLine: 0, hasFrontMatter: false };
  const data = {};
  const lines = m[1].split(/\r?\n/);
  let listKey = null;
  for (const line of lines) {
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const item = /^\s+-\s*(.*)$/.exec(line) || (listKey && /^-\s*(.*)$/.exec(line));
    if (item && listKey) { data[listKey].push(scalar(item[1])); continue; }
    const kv = /^([A-Za-z0-9_\-. ]+?)\s*:\s*(.*)$/.exec(line);
    if (!kv) { listKey = null; continue; }
    const key = kv[1].trim().toLowerCase();
    const val = kv[2].trim();
    if (val === '') { data[key] = []; listKey = key; continue; }
    listKey = null;
    if (/^\[.*\]$/.test(val)) data[key] = splitInline(val.slice(1, -1)).map(scalar).filter((v) => v !== '');
    else data[key] = scalar(val);
  }
  const bodyLine = m[0].split('\n').length - 1;
  return { data, body: src.slice(m[0].length), bodyLine, hasFrontMatter: true };
}

function splitInline(s) {
  const out = []; let cur = ''; let q = null;
  for (const ch of s) {
    if (q) { if (ch === q) q = null; else cur += ch; continue; }
    if (ch === '"' || ch === "'") { q = ch; continue; }
    if (ch === ',') { out.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

function scalar(v) {
  let s = String(v).trim();
  if (/^".*"$/.test(s) || /^'.*'$/.test(s)) return s.slice(1, -1);
  s = s.replace(/\s+#.*$/, '');
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  return s;
}

/** Remove fenced code blocks, inline code and HTML comments so tags and links inside them are not counted. */
function stripCode(body) {
  return String(body)
    .replace(/^(\s*)(```|~~~)[^\n]*\n[\s\S]*?(?:\n\1\2[^\n]*|$)/gm, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/`[^`\n]*`/g, '');
}

const TAG_RE = /(^|[\s(,;])#([\p{L}\p{N}_][\p{L}\p{N}_\-/]*)/gu;

/** Normalise a tag for comparison: lowercase, no leading '#', no trailing '/'. */
const normTag = (t) => String(t).trim().replace(/^#+/, '').replace(/\/+$/, '').toLowerCase();

/**
 * All tags of a note: `#tag` in the text (not in code, not a heading, not only digits like #1) and `tags:` / `tag:` in
 * the front matter. Returned normalised, unique, sorted.
 */
function extractTags(text) {
  const { data, body } = parseFrontMatter(text);
  const set = new Set();
  for (const key of ['tags', 'tag', 'keywords']) {
    const v = data[key];
    const list = Array.isArray(v) ? v : (typeof v === 'string' ? v.split(/[,\s]+/) : []);
    for (const t of list) { const n = normTag(t); if (n && /[\p{L}\p{N}_]/u.test(n)) set.add(n); }
  }
  for (const m of stripCode(body).matchAll(TAG_RE)) {
    const t = normTag(m[2]);
    if (t && !/^\d+$/.test(t)) set.add(t);
  }
  return [...set].sort();
}

/** The note's title: front matter `title`, else the first `# heading`, else the file name. */
function noteTitle(text, fileName) {
  const { data, body } = parseFrontMatter(text);
  if (typeof data.title === 'string' && data.title.trim()) return data.title.trim();
  const h = /^#\s+(.+?)\s*#*\s*$/m.exec(stripCode(body));
  if (h) return h[1].trim();
  return String(fileName || '').replace(/\.(md|markdown)$/i, '');
}

/** Words in the body (front matter and markup excluded). Counts CJK characters one by one. */
function wordCount(text) {
  const { body } = parseFrontMatter(text);
  const plain = body.replace(/```[\s\S]*?```/g, (m) => m.replace(/```\S*/g, ' '))
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\[\[([^\]|]*\|)?([^\]]*)\]\]/g, '$2')
    .replace(/[#>*_`~|\-=[\]]+/g, ' ');
  const cjk = (plain.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu) || []).length;
  const words = (plain.replace(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu, ' ').match(/[\p{L}\p{N}][\p{L}\p{N}'\x27.-]*/gu) || []).length;
  return words + cjk;
}

// ---- wiki links --------------------------------------------------------------------------------------------------------
const WIKI_RE = /\[\[([^\[\]\n|#]*)(#[^\[\]\n|]*)?(?:\|([^\[\]\n]*))?\]\]/g;

/** Every [[Target#heading|label]] in the note (outside code). */
function extractWikiLinks(text) {
  const out = [];
  for (const m of stripCode(parseFrontMatter(text).body).matchAll(WIKI_RE)) {
    const target = m[1].trim();
    if (target) out.push({ target, heading: m[2] ? m[2].slice(1).trim() : '', label: (m[3] || '').trim() });
  }
  return out;
}

const posix = (p) => String(p).replace(/\\/g, '/');
const stem = (rel) => posix(rel).split('/').pop().replace(/\.(md|markdown)$/i, '');
const dirOf = (rel) => { const p = posix(rel).split('/'); p.pop(); return p.join('/'); };
const foldKey = (s) => String(s).normalize('NFC').toLowerCase();

/**
 * Resolve a wiki link target to one of the notes (relative paths with '/'), like Obsidian:
 *   - "Folder/Name" matches a note whose path ends with that (case-insensitive);
 *   - "Name" matches by file name; if several notes share it, the one in the linking note's folder wins, then the
 *     nearest folder (fewest steps up), then the shortest path, then alphabetical.
 * Returns the relative path or null when no note matches.
 */
function resolveWikiLink(target, fromRel, allRels) {
  let t = posix(target).trim().replace(/^\/+/, '').replace(/\.(md|markdown)$/i, '');
  if (!t) return null;
  const want = foldKey(t);
  const hasDir = t.includes('/');
  const candidates = [];
  for (const rel of allRels) {
    const noExt = foldKey(posix(rel).replace(/\.(md|markdown)$/i, ''));
    if (hasDir ? (noExt === want || noExt.endsWith('/' + want)) : foldKey(stem(rel)) === want) candidates.push(rel);
  }
  if (!candidates.length) return null;
  if (candidates.length === 1) return candidates[0];
  const from = fromRel ? dirOf(fromRel).split('/').filter(Boolean) : [];
  const score = (rel) => {
    const d = dirOf(rel).split('/').filter(Boolean);
    let common = 0; while (common < d.length && common < from.length && d[common] === from[common]) common++;
    return (from.length - common) * 100 + (d.length - common);
  };
  candidates.sort((a, b) => score(a) - score(b) || a.length - b.length || a.localeCompare(b));
  return candidates[0];
}

/** Where a new note for an unresolved [[Target]] goes: next to the linking note (or the given sub-path of the root). */
function newNotePathFor(target, fromRel) {
  const t = posix(target).trim().replace(/^\/+/, '').replace(/\.(md|markdown)$/i, '');
  const parts = t.split('/').map(safeName).filter(Boolean);
  if (!parts.length) return null;
  const file = parts.pop() + '.md';
  const dir = parts.length ? parts.join('/') : (fromRel ? dirOf(fromRel) : '');
  return dir ? dir + '/' + file : file;
}

// ---- names --------------------------------------------------------------------------------------------------------------
const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;
/** Make a string safe as one file or folder name on Windows and Linux (no separators, no reserved names). */
function safeName(name) {
  let s = String(name || '').normalize('NFC').replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, ' ').replace(/\s+/g, ' ').trim();
  s = s.replace(/[. ]+$/, '').replace(/^\.+/, '');
  if (s.length > 120) s = s.slice(0, 120).trim();
  if (!s || RESERVED.test(s)) return '';
  return s;
}
/** Problems with a name the user typed, in plain words, or '' when it is fine. */
function nameProblem(name) {
  const s = String(name || '');
  if (!s.trim()) return 'The name is empty.';
  if (/[<>:"/\\|?*\u0000-\u001f]/.test(s)) return 'A name cannot contain any of these: < > : " / \\ | ? *';
  if (/[. ]$/.test(s) || /^\./.test(s)) return 'A name cannot start with a dot or end with a dot or a space.';
  if (RESERVED.test(s.trim())) return `"${s.trim()}" is a name Windows reserves. Pick another one.`;
  if (s.length > 120) return 'That name is too long (120 characters at most).';
  return '';
}

/** "name.ext", "name (2).ext", "name (3).ext"... the first one `exists` says is free. */
function uniqueName(name, exists) {
  const dot = name.lastIndexOf('.');
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  if (!exists(name)) return name;
  for (let i = 2; i < 100000; i++) { const n = `${base} (${i})${ext}`; if (!exists(n)) return n; }
  throw new Error('Could not find a free file name');
}

const IMAGE_TYPES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp', avif: 'image/avif' };
/** Sniff an image's type from its first bytes (null if it is not a picture we show). SVG is not accepted from bytes. */
function sniffImage(buf) {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf || []);
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg';
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'gif';
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'webp';
  if (b.length >= 2 && b[0] === 0x42 && b[1] === 0x4d) return 'bmp';
  if (b.length >= 12 && b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70 && /avi[fs]/.test(String.fromCharCode(b[8], b[9], b[10], b[11]))) return 'avif';
  return null;
}

/**
 * File name for a pasted or dropped picture: the dropped file's own (made safe) name with the real extension, or
 * "Pasted image 2026-11-10 14-03-22.png" for a clipboard picture. Made unique by `exists`.
 */
function attachmentName({ originalName, ext, now = new Date(), exists = () => false }) {
  const e = String(ext || 'png').toLowerCase().replace(/^\./, '').replace('jpeg', 'jpg');
  let base = originalName ? safeName(String(originalName).replace(/\.[^.]*$/, '')) : '';
  if (!base) {
    const p = (n) => String(n).padStart(2, '0');
    base = `Pasted image ${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())} ${p(now.getHours())}-${p(now.getMinutes())}-${p(now.getSeconds())}`;
  }
  return uniqueName(`${base}.${e}`, exists);
}

/** A relative Markdown link to an attachment: each path part URL-encoded so spaces and unicode work everywhere. */
function attachmentLink(relFromNote, alt) {
  const href = posix(relFromNote).split('/').map((s) => encodeURIComponent(s)).join('/');
  const a = String(alt || '').replace(/[\[\]\n]/g, ' ').trim();
  return `![${a}](${href})`;
}

/** Toggle the task checkbox on a 0-based line ("- [ ] x" <-> "- [x] x"). Returns the new text, or null if no task there. */
function toggleTask(text, line) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  if (!(line >= 0 && line < lines.length)) return null;
  const m = /^(\s*(?:[-*+]|\d+[.)])\s+\[)([ xX])(\].*)$/.exec(lines[line]);
  if (!m) return null;
  lines[line] = m[1] + (m[2] === ' ' ? 'x' : ' ') + m[3];
  return lines.join(eol);
}

module.exports = {
  parseFrontMatter, extractTags, normTag, noteTitle, wordCount, stripCode,
  extractWikiLinks, resolveWikiLink, newNotePathFor, stem, dirOf, posix,
  safeName, nameProblem, uniqueName, sniffImage, attachmentName, attachmentLink, IMAGE_TYPES, toggleTask,
};
