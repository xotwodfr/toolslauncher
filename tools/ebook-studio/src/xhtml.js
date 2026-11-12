'use strict';
// HTML and XML helpers: parse (lenient), and write back SAFE, well-formed XHTML from an allow list. The same writer makes
// the chapters of the EPUBs we create and the pages the reader shows, so both are free of scripts, event handlers,
// forms, frames and remote resources. Also HTML -> plain text and HTML -> Markdown.
const { parseDocument, DomUtils } = require('htmlparser2');

const parseHtml = (s) => parseDocument(String(s || ''), { lowerCaseTags: true, lowerCaseAttributeNames: true, recognizeSelfClosing: true, decodeEntities: true });
const parseXml = (s) => parseDocument(String(s || ''), { xmlMode: true, decodeEntities: true });

const escText = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escAttr = (s) => escText(s).replace(/"/g, '&quot;');
// characters that are not allowed in XML 1.0 at all
const xmlSafe = (s) => String(s).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '').replace(/[\p{Cs}\p{Noncharacter_Code_Point}]/gu, '');

const BLOCK_TAGS = ['p', 'div', 'section', 'article', 'aside', 'header', 'footer', 'nav', 'main', 'blockquote', 'pre', 'ul', 'ol', 'li', 'dl', 'dt', 'dd',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption', 'colgroup', 'col', 'figure', 'figcaption', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'address'];
const INLINE_TAGS = ['a', 'span', 'em', 'strong', 'b', 'i', 'u', 's', 'del', 'ins', 'sub', 'sup', 'small', 'mark', 'cite', 'abbr', 'q', 'code', 'kbd', 'samp', 'var',
  'br', 'img', 'ruby', 'rt', 'rp', 'bdi', 'bdo', 'time', 'dfn', 'wbr'];
const ALLOWED = new Set([...BLOCK_TAGS, ...INLINE_TAGS]);
const RENAME = { center: 'div', big: 'span', font: 'span', tt: 'code', strike: 's', acronym: 'abbr', listing: 'pre', body: 'div' };
const DROP = new Set(['script', 'style', 'iframe', 'object', 'embed', 'applet', 'form', 'input', 'button', 'select', 'textarea', 'option', 'audio', 'video', 'source', 'track',
  'canvas', 'noscript', 'template', 'frame', 'frameset', 'noframes', 'link', 'meta', 'base', 'title', 'head', 'param', 'map', 'area', 'dialog', 'portal']);
const VOID = new Set(['br', 'hr', 'img', 'col', 'wbr']);
const ATTRS = new Set(['id', 'class', 'lang', 'dir', 'title', 'colspan', 'rowspan', 'start', 'reversed', 'type', 'datetime', 'cite', 'scope', 'abbr']);

/** A link target we keep as written: web and mail links only. */
const isWeb = (h) => /^(https?|mailto):/i.test(String(h).replace(/[\x00-\x20]/g, ''));
const isDangerous = (h) => { const s = String(h).replace(/[\x00-\x20\x7f-\x9f]/g, ''); return /^[a-z][a-z0-9+.-]*:/i.test(s) && !isWeb(s); };

/**
 * Write DOM nodes as safe XHTML.
 *   opts.mapSrc(src) -> new src for a picture, or null to drop the picture (alt text kept)
 *   opts.mapHref(href) -> new href, or null to drop the link (its text kept); web links go through it too
 *   opts.idPrefix: prefix for every id (so several chapters can share one page)
 */
function toXhtml(nodes, opts = {}) {
  const out = [];
  const mapSrc = opts.mapSrc || (() => null);
  const mapHref = opts.mapHref || ((h) => (isWeb(h) ? h : null));
  const pre = opts.idPrefix || '';
  const walk = (list) => {
    for (const n of list || []) {
      if (n.type === 'text') { out.push(escText(xmlSafe(n.data))); continue; }
      if (n.type === 'cdata') { walk(n.children); continue; }
      if (n.type !== 'tag' && n.type !== 'script' && n.type !== 'style') continue;
      let name = String(n.name).toLowerCase().replace(/^[a-z]+:/, (p) => (p === 'svg:' ? '' : p));
      if (DROP.has(name) || n.type === 'script' || n.type === 'style') continue;
      if (name === 'svg') {
        // cover pages often wrap the picture in <svg><image xlink:href="..."/></svg>: keep the picture only
        const img = DomUtils.findOne((e) => /(^|:)image$/.test(e.name), n.children || [], true);
        const src = img && (img.attribs['xlink:href'] || img.attribs.href);
        const mapped = src ? mapSrc(src) : null;
        if (mapped) out.push(`<img src="${escAttr(mapped)}" alt="" class="svg-image"/>`);
        continue;
      }
      if (name === 'math' || name.includes(':')) { walk(n.children); continue; } // MathML and unknown namespaces: keep the text
      name = RENAME[name] || name;
      if (!ALLOWED.has(name)) { walk(n.children); continue; }
      const a = n.attribs || {};
      let s = '<' + name;
      if (name === 'img') {
        const src = a.src ? mapSrc(a.src) : null;
        if (!src) { if (a.alt) out.push(`<span class="missing-image">${escText(xmlSafe(a.alt))}</span>`); continue; }
        s += ` src="${escAttr(src)}" alt="${escAttr(xmlSafe(a.alt || ''))}"`;
        for (const k of ['width', 'height']) if (/^\d{1,5}$/.test(a[k] || '')) s += ` ${k}="${a[k]}"`;
      }
      let dropLink = false;
      if (name === 'a' && a.href != null) {
        const h = isDangerous(a.href) ? null : mapHref(a.href);
        if (h) s += ` href="${escAttr(h)}"`; else dropLink = true;
        if (h && isWeb(h)) s += ' class="external"';
      }
      for (const [k0, v] of Object.entries(a)) {
        const k = k0 === 'xml:lang' ? 'lang' : k0.toLowerCase();
        if (!ATTRS.has(k)) continue;
        if (name === 'a' && k === 'class' && !dropLink && isWeb(a.href || '')) continue;
        if ((k === 'colspan' || k === 'rowspan' || k === 'start') && !/^\d{1,4}$/.test(v)) continue;
        if (k === 'type' && name !== 'ol') continue;
        if (k === 'id' || k === 'class') { const clean = String(v).replace(/[^\w\-:. ]/g, ''); if (!clean.trim()) continue; s += ` ${k}="${escAttr(k === 'id' ? pre + clean.replace(/\s+/g, '') : clean)}"`; continue; }
        s += ` ${k}="${escAttr(xmlSafe(v))}"`;
      }
      if (VOID.has(name)) { out.push(s + '/>'); continue; }
      out.push(s + '>');
      walk(n.children);
      out.push(`</${name}>`);
    }
  };
  walk(Array.isArray(nodes) ? nodes : [nodes]);
  return out.join('');
}

/** The <body> element of a parsed page (or the whole document when there is none). */
function bodyOf(doc) { return DomUtils.findOne((e) => e.name === 'body', doc.children, true) || doc; }
function titleOf(doc) { const t = DomUtils.findOne((e) => e.name === 'title', doc.children, true); return t ? DomUtils.textContent(t).replace(/\s+/g, ' ').trim() : ''; }
function firstHeading(nodes) {
  const h = DomUtils.findOne((e) => /^h[1-6]$/.test(e.name), Array.isArray(nodes) ? nodes : [nodes], true);
  return h ? DomUtils.textContent(h).replace(/\s+/g, ' ').trim() : '';
}

// ---- text and Markdown out -------------------------------------------------------------------------------------------------
const BLOCKISH = new Set([...BLOCK_TAGS, 'body', 'center', 'br']);

/** HTML nodes -> readable plain text: paragraphs separated by blank lines, list items with "- ", headings on their own. */
function toText(nodes) {
  const parts = [];
  let line = '';
  const flush = (gap) => { const t = line.replace(/[ \t]+/g, ' ').trim(); if (t) parts.push(t); line = ''; if (gap && parts.length && parts[parts.length - 1] !== '') parts.push(''); };
  const walk = (list, ctx) => {
    for (const n of list || []) {
      if (n.type === 'text') { line += ctx.pre ? n.data : n.data.replace(/\s+/g, ' '); continue; }
      if (n.type !== 'tag') continue;
      const name = n.name.toLowerCase();
      if (DROP.has(name)) continue;
      if (name === 'br') { if (ctx.pre) line += '\n'; else flush(false); continue; }
      if (name === 'img') { if (n.attribs.alt) line += `[${n.attribs.alt}]`; continue; }
      if (name === 'hr') { flush(true); parts.push('* * *', ''); continue; }
      if (name === 'li') { flush(false); line = (ctx.ol ? `${++ctx.ol.n}. ` : '- '); walk(n.children, ctx); flush(false); continue; }
      if (name === 'ol' || name === 'ul') { flush(true); walk(n.children, { ...ctx, ol: name === 'ol' ? { n: 0 } : null }); flush(true); continue; }
      if (name === 'pre') { flush(true); const t = DomUtils.textContent(n).replace(/\n$/, ''); parts.push(...t.split('\n'), ''); continue; }
      if (name === 'td' || name === 'th') { walk(n.children, ctx); line += '\t'; continue; }
      if (BLOCKISH.has(name)) { flush(true); walk(n.children, ctx); flush(true); continue; }
      walk(n.children, ctx);
    }
  };
  walk(Array.isArray(nodes) ? nodes : [nodes], { pre: false, ol: null });
  flush(false);
  while (parts.length && parts[parts.length - 1] === '') parts.pop();
  return parts.join('\n').replace(/\n{3,}/g, '\n\n');
}

const mdEsc = (s) => s.replace(/([\\`*_[\]<>])/g, '\\$1').replace(/^(\s*)([#>+-]|\d+\.)(\s)/, '$1\\$2$3');

/** HTML nodes -> Markdown. opts.mapSrc(src) -> path to write for a picture (or null to keep only its alt text). */
function toMarkdown(nodes, opts = {}) {
  const mapSrc = opts.mapSrc || (() => null);
  const mapHref = opts.mapHref || ((h) => (isWeb(h) ? h : null));
  const blocks = [];
  const inline = (list) => {
    let s = '';
    for (const n of list || []) {
      if (n.type === 'text') { s += mdEsc(n.data.replace(/\s+/g, ' ')); continue; }
      if (n.type !== 'tag') continue;
      const name = n.name.toLowerCase();
      if (DROP.has(name)) continue;
      const inner = () => inline(n.children);
      if (name === 'br') s += '  \n';
      else if (name === 'em' || name === 'i' || name === 'cite' || name === 'dfn') { const t = inner().trim(); if (t) s += `*${t}*`; }
      else if (name === 'strong' || name === 'b') { const t = inner().trim(); if (t) s += `**${t}**`; }
      else if (name === 's' || name === 'del' || name === 'strike') { const t = inner().trim(); if (t) s += `~~${t}~~`; }
      else if (name === 'code' || name === 'kbd' || name === 'samp' || name === 'tt') s += '`' + DomUtils.textContent(n).replace(/`/g, "'") + '`';
      else if (name === 'img') { const p = n.attribs.src ? mapSrc(n.attribs.src) : null; const alt = (n.attribs.alt || '').replace(/[[\]]/g, ''); s += p ? `![${alt}](${p.split('/').map(encodeURIComponent).join('/')})` : (alt ? `[${alt}]` : ''); }
      else if (name === 'a') { const h = n.attribs.href && !isDangerous(n.attribs.href) ? mapHref(n.attribs.href) : null; const t = inner(); s += h ? `[${t}](${h.replace(/[()\s]/g, encodeURIComponent)})` : t; }
      else if (name === 'sup') s += '^' + inner();
      else s += inner();
    }
    return s;
  };
  const walk = (list, depth, ordered) => {
    let pending = [];
    const flushInline = () => { const t = inline(pending).replace(/[ \t]+\n/g, '  \n').trim(); if (t) blocks.push(t); pending = []; };
    let n0 = 0;
    for (const n of list || []) {
      if (n.type === 'text' || (n.type === 'tag' && !BLOCKISH.has(n.name.toLowerCase()) && n.name.toLowerCase() !== 'br')) { pending.push(n); continue; }
      if (n.type === 'tag' && n.name.toLowerCase() === 'br') { pending.push(n); continue; }
      if (n.type !== 'tag') continue;
      flushInline();
      const name = n.name.toLowerCase();
      if (DROP.has(name)) continue;
      if (/^h[1-6]$/.test(name)) { const t = inline(n.children).replace(/\s+/g, ' ').trim(); if (t) blocks.push('#'.repeat(Number(name[1])) + ' ' + t); }
      else if (name === 'hr') blocks.push('* * *');
      else if (name === 'pre') { const t = DomUtils.textContent(n).replace(/\n$/, ''); const fence = /```/.test(t) ? '~~~~' : '```'; blocks.push(fence + '\n' + t + '\n' + fence); }
      else if (name === 'blockquote') { const sub = toMarkdown(n.children, opts); if (sub) blocks.push(sub.split('\n').map((l) => (l ? '> ' + l : '>')).join('\n')); }
      else if (name === 'ul' || name === 'ol') {
        const items = (n.children || []).filter((c) => c.type === 'tag' && c.name === 'li');
        const lines = items.map((li, i) => {
          const sub = toMarkdown(li.children, opts).split('\n');
          const marker = name === 'ol' ? `${i + 1}.` : '-';
          return sub.map((l, j) => (j === 0 ? `${marker} ${l}` : l ? '   ' + l : '')).join('\n');
        });
        if (lines.length) blocks.push(lines.join('\n'));
      } else if (name === 'table') {
        const rows = DomUtils.findAll((e) => e.name === 'tr', n.children).map((tr) => (tr.children || []).filter((c) => c.type === 'tag' && (c.name === 'td' || c.name === 'th')).map((c) => inline(c.children).replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim()));
        if (rows.length) {
          const w = Math.max(...rows.map((r) => r.length));
          const pad = (r) => [...r, ...Array(w - r.length).fill('')];
          blocks.push([`| ${pad(rows[0]).join(' | ')} |`, `|${' --- |'.repeat(w)}`, ...rows.slice(1).map((r) => `| ${pad(r).join(' | ')} |`)].join('\n'));
        }
      } else walk(n.children, depth, ordered);
      n0++;
    }
    flushInline();
    void n0;
  };
  walk(Array.isArray(nodes) ? nodes : [nodes], 0, false);
  return blocks.join('\n\n');
}

module.exports = { parseHtml, parseXml, toXhtml, toText, toMarkdown, bodyOf, titleOf, firstHeading, escText, escAttr, xmlSafe, isWeb, isDangerous, DomUtils };
