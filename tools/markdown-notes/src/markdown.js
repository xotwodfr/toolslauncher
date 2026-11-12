'use strict';
// Markdown -> safe HTML. markdown-it (CommonMark + tables + strikethrough + footnotes) with task lists, [[wiki links]],
// heading ids and source line numbers added here, code highlighted with highlight.js, and everything passed through
// the allow-list sanitiser at the end.
const MarkdownIt = require('markdown-it');
const footnote = require('markdown-it-footnote');
const hljs = require('highlight.js');
const Meta = require('./meta');
const { sanitize, esc, escAttr } = require('./sanitize');

/** "Hello, World!" -> "hello-world" (unicode letters kept), used for heading ids and [[Note#Heading]] links. */
function slugify(s) {
  return String(s).normalize('NFC').toLowerCase().trim().replace(/<[^>]*>/g, '')
    .replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'section';
}

function highlight(code, lang) {
  const l = String(lang || '').trim().split(/\s+/)[0].toLowerCase();
  try {
    if (l && hljs.getLanguage(l)) return `<pre><code class="hljs language-${escAttr(l)}">${hljs.highlight(code, { language: l, ignoreIllegals: true }).value}</code></pre>`;
  } catch { /* fall through to plain */ }
  return `<pre><code class="hljs${l ? ' language-' + escAttr(l) : ''}">${esc(code)}</code></pre>`;
}

function wikiPlugin(md) {
  md.inline.ruler.before('link', 'wikilink', (state, silent) => {
    const src = state.src; const pos = state.pos;
    if (src.charCodeAt(pos) !== 0x5b || src.charCodeAt(pos + 1) !== 0x5b) return false;
    const end = src.indexOf(']]', pos + 2);
    if (end === -1) return false;
    const inner = src.slice(pos + 2, end);
    if (!inner.trim() || /[\[\]\n]/.test(inner)) return false;
    if (!silent) {
      const bar = inner.indexOf('|');
      const ref = bar === -1 ? inner : inner.slice(0, bar);
      const hash = ref.indexOf('#');
      const tok = state.push('wikilink', '', 0);
      tok.meta = { target: (hash === -1 ? ref : ref.slice(0, hash)).trim(), heading: hash === -1 ? '' : ref.slice(hash + 1).trim(), label: bar === -1 ? '' : inner.slice(bar + 1).trim() };
    }
    state.pos = end + 2;
    return true;
  });
  md.renderer.rules.wikilink = (tokens, idx, _o, env) => {
    const { target, heading, label } = tokens[idx].meta;
    const exists = !target || !env.resolveWiki || env.resolveWiki(target);
    const text = label || (target ? target + (heading ? ' › ' + heading : '') : heading);
    return `<a href="#" class="wikilink${exists ? '' : ' missing'}" data-wiki="${escAttr(target)}" data-heading="${escAttr(heading)}" title="${escAttr(exists ? target || heading : 'Not written yet: click to create “' + target + '”')}">${esc(text)}</a>`;
  };
}

function hashtagPlugin(md) {
  md.inline.ruler.push('hashtag', (state, silent) => {
    const pos = state.pos;
    if (state.src.charCodeAt(pos) !== 0x23) return false;
    const prev = pos > 0 ? state.src[pos - 1] : ' ';
    if (!/[\s(,;]/.test(prev)) return false;
    const m = /^#([\p{L}\p{N}_][\p{L}\p{N}_\-/]*)/u.exec(state.src.slice(pos, pos + 200));
    if (!m || /^\d+$/.test(m[1])) return false;
    if (!silent) { const tok = state.push('hashtag', '', 0); tok.meta = { tag: m[1].replace(/\/+$/, '') }; }
    state.pos += m[0].length;
    return true;
  });
  md.renderer.rules.hashtag = (tokens, idx) => {
    const tag = tokens[idx].meta.tag;
    return `<a href="#" class="tag" data-tag="${escAttr(tag.toLowerCase())}">#${esc(tag)}</a>`;
  };
}

function taskPlugin(md) {
  md.core.ruler.after('inline', 'tasks', (state) => {
    const t = state.tokens;
    const off = state.env.lineOffset || 0;
    for (let i = 2; i < t.length; i++) {
      if (t[i].type !== 'inline' || t[i - 1].type !== 'paragraph_open' || t[i - 2].type !== 'list_item_open') continue;
      const m = /^\[([ xX])\][ \t]/.exec(t[i].content) || (/^\[([ xX])\]$/.exec(t[i].content));
      if (!m) continue;
      const first = t[i].children[0];
      if (!first || first.type !== 'text' || !/^\[[ xX]\]/.test(first.content)) continue;
      first.content = first.content.replace(/^\[[ xX]\][ \t]?/, '');
      const box = new state.Token('html_inline', '', 0);
      const line = (t[i].map ? t[i].map[0] : t[i - 2].map[0]) + off;
      box.content = `<input type="checkbox" class="task" data-line="${line}"${m[1] === ' ' ? '' : ' checked'}>`;
      box.meta = { task: true, checked: m[1] !== ' ' };
      t[i].children.unshift(box);
      t[i - 2].attrJoin('class', 'task-item');
      t[i - 2].meta = { ...(t[i - 2].meta || {}), task: true, checked: m[1] !== ' ' };
      // the list itself
      for (let j = i - 3; j >= 0; j--) if ((t[j].type === 'bullet_list_open' || t[j].type === 'ordered_list_open') && t[j].level === t[i - 2].level - 1) { if (!/\btasks\b/.test(t[j].attrGet('class') || '')) t[j].attrJoin('class', 'tasks'); break; }
    }
  });
}

function anchorsAndLines(md) {
  md.core.ruler.push('anchors_lines', (state) => {
    const off = state.env.lineOffset || 0;
    const seen = new Map();
    const t = state.tokens;
    for (let i = 0; i < t.length; i++) {
      const tok = t[i];
      if (tok.map && tok.nesting === 1 && /^(paragraph|heading|bullet_list|ordered_list|blockquote|table)_open$/.test(tok.type) && tok.level === 0) tok.attrSet('data-line', String(tok.map[0] + off));
      if (tok.type === 'heading_open') {
        const text = (t[i + 1] && t[i + 1].children || []).filter((c) => c.type === 'text' || c.type === 'code_inline').map((c) => c.content).join('');
        let id = slugify(text); const n = seen.get(id) || 0; seen.set(id, n + 1); if (n) id += '-' + n;
        tok.attrSet('id', id);
      }
    }
  });
}

function makeMd() {
  const md = new MarkdownIt({ html: true, linkify: true, typographer: false, breaks: false, highlight });
  md.use(footnote).use(wikiPlugin).use(hashtagPlugin).use(taskPlugin).use(anchorsAndLines);
  // fences get the source line too (for scroll sync), at top level only
  const fence = md.renderer.rules.fence;
  md.renderer.rules.fence = (tokens, idx, o, env, self) => {
    const html = fence(tokens, idx, o, env, self);
    const tok = tokens[idx];
    return tok.map && tok.level === 0 ? html.replace(/^<pre/, `<pre data-line="${tok.map[0] + (env.lineOffset || 0)}"`) : html;
  };
  return md;
}
const md = makeMd();

/** Front matter shown as a small table above the note (escaped; never interpreted). */
function frontMatterHtml(data) {
  const keys = Object.keys(data);
  if (!keys.length) return '';
  const rows = keys.map((k) => {
    const v = data[k];
    const val = Array.isArray(v) ? v.map((x) => (k === 'tags' || k === 'tag' ? `<span class="tag">#${esc(x)}</span>` : esc(x))).join(' ') : esc(v);
    return `<tr><th>${esc(k)}</th><td>${val}</td></tr>`;
  }).join('');
  return `<table class="frontmatter">${rows}</table>`;
}

/**
 * render(text, opts) -> safe HTML of the note.
 *   opts.resolveWiki(target) -> true when the linked note exists (missing links are drawn differently)
 *   opts.mapImage(src) -> the URL to load a relative image from, or null to block it
 *   opts.frontMatter: false to leave the front matter table out
 */
function render(text, opts = {}) {
  const fm = Meta.parseFrontMatter(text);
  const env = { resolveWiki: opts.resolveWiki, lineOffset: fm.bodyLine };
  const raw = (opts.frontMatter === false ? '' : frontMatterHtml(fm.data)) + md.render(fm.body, env);
  return sanitize(raw, { mapImage: opts.mapImage });
}

/** The markdown-it token stream of the note body (used by the DOCX export). */
function parse(text) {
  const fm = Meta.parseFrontMatter(text);
  return { tokens: md.parse(fm.body, { lineOffset: fm.bodyLine }), data: fm.data };
}

module.exports = { render, parse, slugify, md };
