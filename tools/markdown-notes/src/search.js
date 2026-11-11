'use strict';
// The in-memory note index of the main process: one entry per note (title, tags, links, folded text) and an inverted
// word index for fast lookups. Updated note by note as files change (set / remove / rename), never rebuilt as a whole
// unless the folder changes.
const M = require('./meta');

/** Lowercase, no accents ("Café" -> "cafe"), NFKC: the form both the text and the query are compared in. */
const fold = (s) => String(s).normalize('NFKD').replace(/\p{M}/gu, '').normalize('NFC').toLowerCase();
const WORD = /[\p{L}\p{N}_]+/gu;
const words = (s) => fold(s).match(WORD) || [];

class NoteIndex {
  constructor() {
    this.docs = new Map();   // rel -> { rel, title, tags, links, text, folded, mtime, size }
    this.words = new Map();  // word -> Set(rel)
  }

  get size() { return this.docs.size; }
  has(rel) { return this.docs.has(rel); }
  get(rel) { return this.docs.get(rel); }
  paths() { return [...this.docs.keys()]; }

  /** Add or replace one note. */
  set(rel, text, info = {}) {
    if (this.docs.has(rel)) this._unlink(rel);
    const name = rel.split('/').pop();
    const doc = {
      rel, title: M.noteTitle(text, name), tags: M.extractTags(text), links: M.extractWikiLinks(text).map((l) => l.target),
      text: String(text), folded: fold(text) + '\n' + fold(name), mtime: info.mtime || 0, size: info.size || Buffer.byteLength(String(text)),
    };
    doc.wordSet = new Set([...words(text), ...words(name.replace(/\.(md|markdown)$/i, ''))]);
    for (const w of doc.wordSet) { let s = this.words.get(w); if (!s) this.words.set(w, (s = new Set())); s.add(rel); }
    this.docs.set(rel, doc);
    return doc;
  }

  remove(rel) { if (!this.docs.has(rel)) return false; this._unlink(rel); this.docs.delete(rel); return true; }

  /** Move a note (or, when `oldRel` is a folder, every note under it) to a new path. Returns the moves made. */
  rename(oldRel, newRel) {
    const moves = [];
    if (this.docs.has(oldRel)) moves.push([oldRel, newRel]);
    else for (const rel of this.docs.keys()) if (rel.startsWith(oldRel + '/')) moves.push([rel, newRel + rel.slice(oldRel.length)]);
    for (const [a, b] of moves) { const d = this.docs.get(a); this.remove(a); this.set(b, d.text, { mtime: d.mtime, size: d.size }); }
    return moves;
  }

  _unlink(rel) {
    const d = this.docs.get(rel);
    for (const w of d.wordSet) { const s = this.words.get(w); if (s) { s.delete(rel); if (!s.size) this.words.delete(w); } }
  }

  /** Every tag with how many notes have it, most used first. */
  tags() {
    const count = new Map();
    for (const d of this.docs.values()) for (const t of d.tags) count.set(t, (count.get(t) || 0) + 1);
    return [...count].map(([tag, n]) => ({ tag, count: n })).sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
  }

  /** Notes that link to `rel` with a wiki link. */
  backlinks(rel) {
    const all = this.paths();
    const out = [];
    for (const d of this.docs.values()) if (d.rel !== rel && d.links.some((t) => M.resolveWikiLink(t, d.rel, all) === rel)) out.push(d.rel);
    return out.sort();
  }

  /**
   * Search: every word of the query must appear (a word matches as a prefix: "plan" finds "planning"), "quoted text"
   * must appear as written, and `#tag` / the `tag` option filters by tag (a parent tag includes its children:
   * #work matches #work/meetings). Results are ranked: title hits first, then by how often the words appear.
   */
  search(query, { tag = '', limit = 200 } = {}) {
    const q = String(query || '');
    const phrases = []; const terms = []; const tags = tag ? [M.normTag(tag)] : [];
    q.replace(/"([^"]+)"/g, (_m, p) => { phrases.push(fold(p)); return ' '; })
      .split(/\s+/).filter(Boolean).forEach((t) => { if (/^#./.test(t)) tags.push(M.normTag(t)); else terms.push(...words(t)); });
    let pool = null;
    for (const t of terms) {
      const hit = new Set();
      const exact = this.words.get(t);
      if (exact) for (const r of exact) hit.add(r);
      for (const [w, set] of this.words) if (w.length > t.length && w.startsWith(t)) for (const r of set) hit.add(r);
      pool = pool ? new Set([...pool].filter((r) => hit.has(r))) : hit;
      if (!pool.size) return [];
    }
    let list = pool ? [...pool].map((r) => this.docs.get(r)) : [...this.docs.values()];
    if (phrases.length) list = list.filter((d) => phrases.every((p) => d.folded.includes(p)));
    if (tags.length) list = list.filter((d) => tags.every((t) => d.tags.some((x) => x === t || x.startsWith(t + '/'))));
    if (!terms.length && !phrases.length && !tags.length) return [];
    const needles = [...phrases, ...terms];
    const scored = list.map((d) => {
      const ft = fold(d.title);
      let score = 0;
      for (const n of needles) {
        if (ft.includes(n)) score += 50;
        let i = -1; let c = 0; while ((i = d.folded.indexOf(n, i + 1)) !== -1 && c < 50) c++;
        score += c;
      }
      return { d, score };
    });
    scored.sort((a, b) => b.score - a.score || a.d.title.localeCompare(b.d.title));
    return scored.slice(0, limit).map(({ d }) => ({ rel: d.rel, title: d.title, tags: d.tags, snippet: snippet(d.text, needles) }));
  }
}

/** A line of text around the first hit, for the result list. Works on the original text (accents kept). */
function snippet(text, needles) {
  const body = M.parseFrontMatter(text).body.replace(/\s+/g, ' ');
  if (!needles.length) return body.slice(0, 120);
  const folded = fold(body);
  let at = -1; let len = 0;
  for (const n of needles) { const i = folded.indexOf(n); if (i !== -1 && (at === -1 || i < at)) { at = i; len = n.length; } }
  if (at === -1) return body.slice(0, 120);
  // NFKD folding can change lengths for some characters; map back approximately by clamping
  const start = Math.max(0, at - 40);
  const s = body.slice(start, Math.min(body.length, at + len + 80));
  return (start > 0 ? '…' : '') + s.trim() + (at + len + 80 < body.length ? '…' : '');
}

module.exports = { NoteIndex, fold, snippet };
