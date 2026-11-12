'use strict';
// One book model for every format: { meta, chapters: [{ title, level, body }], images: [{ name, data, mediaType }], cover }.
// `body` is safe XHTML (see xhtml.js) in which pictures are "../images/<name>" and links to other chapters are
// "chapter-NNN.xhtml#id": exactly what an EPUB we write needs, and easy to map for the other formats.
const MarkdownIt = require('markdown-it');
const X = require('./xhtml');
const E = require('./epub');
const T = require('./text');

const pad = (n) => String(n).padStart(3, '0');
const IMAGE_TYPES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp' };
function sniff(data) {
  const b = data;
  if (!b || b.length < 4) return null;
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8) return 'image/jpeg';
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'image/gif';
  if (b.length > 12 && b[0] === 0x52 && b[1] === 0x49 && b[8] === 0x57 && b[9] === 0x45) return 'image/webp';
  return null;
}
const extOf = (mt) => ({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' }[mt] || 'bin');

/** Collects the pictures of a book under unique, safe names. */
class Images {
  constructor() { this.list = []; this.byKey = new Map(); this.names = new Set(); }
  add(key, data, nameHint) {
    if (this.byKey.has(key)) return this.byKey.get(key);
    const mediaType = sniff(data); // only real raster pictures (SVG files could carry scripts)
    if (!mediaType) return null;
    let base = String(nameHint || 'image').split('/').pop().replace(/\.[^.]*$/, '').normalize('NFC').replace(/[^\p{L}\p{N}_-]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'image';
    let name = `${base}.${extOf(mediaType)}`; let k = 2;
    while (this.names.has(name.toLowerCase())) name = `${base}-${k++}.${extOf(mediaType)}`;
    this.names.add(name.toLowerCase());
    this.list.push({ name, data, mediaType });
    this.byKey.set(key, name);
    return name;
  }
}

// ---- in ----------------------------------------------------------------------------------------------------------------------
/** EPUB bytes -> book. */
function fromEpub(buf) {
  const ep = E.readEpub(buf);
  const labels = new Map();
  const flat = (list) => { for (const t of list) { if (t.path && !labels.has(t.path)) labels.set(t.path, t.label); flat(t.children); } };
  flat(ep.toc);
  const parsed = [];
  for (const item of ep.spine) {
    if (item.properties.includes('nav')) continue;
    const doc = X.parseHtml(new TextDecoder('utf-8').decode(ep.files[item.path]));
    const body = X.bodyOf(doc);
    const text = X.DomUtils.textContent(body).replace(/\s+/g, '');
    const imgs = X.DomUtils.findAll((e) => e.name === 'img' || /(^|:)image$/.test(e.name), body.children || []);
    // the book's own cover page: we make our own from the cover picture
    if (!text && imgs.length === 1 && ep.cover) {
      const src = imgs[0].attribs.src || imgs[0].attribs['xlink:href'] || imgs[0].attribs.href;
      const r = E.resolveHref(E.dirname(item.path), src);
      if (r && r.path === ep.cover.path) continue;
    }
    parsed.push({ item, doc, body });
  }
  const indexOf = new Map(parsed.map((p, i) => [p.item.path, i]));
  const images = new Images();
  const chapters = parsed.map(({ item, doc, body }, i) => {
    const dir = E.dirname(item.path);
    const html = X.toXhtml(body.children, {
      mapSrc: (src) => { const r = E.resolveHref(dir, src); const data = r && ep.files[r.path]; if (!data) return null; const name = images.add(r.path, data, r.path); return name ? `../images/${name}` : null; },
      mapHref: (href) => {
        if (X.isWeb(href)) return href;
        const r = E.resolveHref(dir, href);
        if (!r) return null;
        const k = indexOf.get(r.path);
        if (k === undefined) return null;
        return `chapter-${pad(k + 1)}.xhtml${r.frag ? '#' + r.frag : ''}`;
      },
    });
    const title = labels.get(item.path) || X.firstHeading(body) || X.titleOf(doc) || `Chapter ${i + 1}`;
    return { title, level: 1, body: html };
  });
  const cover = ep.cover && sniff(ep.files[ep.cover.path]) ? { data: ep.files[ep.cover.path], mediaType: sniff(ep.files[ep.cover.path]) } : null;
  // the book's own table of contents (nested), pointing at our chapters
  const mapToc = (list) => list.map((t) => ({ label: t.label, chapter: t.path != null && indexOf.has(t.path) ? indexOf.get(t.path) : null, frag: t.frag || '', children: mapToc(t.children) }))
    .filter((t) => t.chapter !== null || t.children.length);
  return { meta: { ...ep.meta }, chapters, images: images.list, cover, toc: mapToc(ep.toc), warnings: ep.warnings };
}

const cleanName = (fileName) => String(fileName || 'Untitled').replace(/\.[^.]+$/, '').replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim() || 'Untitled';

/** Plain text -> book. "Title:" / "Author:" lines near the top (as in many free ebooks) fill in the details. */
function fromText(buf, fileName) {
  const text = T.decodeText(buf);
  const head = text.slice(0, 4000);
  const title = (/^\s*Title:\s*(.+)$/im.exec(head) || [])[1];
  const author = (/^\s*(?:Author|By):\s*(.+)$/im.exec(head) || [])[1];
  const lang = (/^\s*Language:\s*(.+)$/im.exec(head) || [])[1];
  const meta = { title: (title || cleanName(fileName)).trim(), authors: author ? [author.trim()] : [], language: langCode(lang) || 'en' };
  const chapters = T.splitChapters(text, { fallbackTitle: meta.title }).map((c) => ({ title: c.title, level: 1, body: `<h1>${X.escText(X.xmlSafe(c.title))}</h1>\n` + T.textToXhtml(c.text) }));
  return { meta, chapters, images: [], cover: null, warnings: [] };
}
function langCode(name) {
  if (!name) return '';
  const n = name.trim().toLowerCase();
  const map = { english: 'en', french: 'fr', german: 'de', spanish: 'es', italian: 'it', portuguese: 'pt', dutch: 'nl', swedish: 'sv', danish: 'da', norwegian: 'no', finnish: 'fi', polish: 'pl', russian: 'ru', latin: 'la', greek: 'el', chinese: 'zh', japanese: 'ja' };
  return map[n] || (/^[a-z]{2,3}(-[a-z0-9]+)?$/i.test(n) ? n : '');
}

/**
 * Split the top level of a page into chapters at its headings: at <h1> when there are two or more, else at <h2>.
 * A single wrapper element (<main>, <article>, <div>) is looked into. Content before the first heading stays as a
 * first chapter only when it has text.
 */
function splitAtHeadings(container, fallbackTitle) {
  let nodes = (container.children || []).filter((n) => n.type === 'tag' || (n.type === 'text' && n.data.trim()));
  while (nodes.length === 1 && nodes[0].type === 'tag' && /^(div|main|article|section|body)$/.test(nodes[0].name)) nodes = nodes[0].children.filter((n) => n.type === 'tag' || (n.type === 'text' && n.data.trim()));
  const count = (tag) => nodes.filter((n) => n.name === tag).length;
  const at = count('h1') >= 2 ? 'h1' : count('h2') >= 2 ? 'h2' : null;
  if (!at) return [{ title: fallbackTitle, nodes }];
  const out = [];
  let cur = { title: fallbackTitle, nodes: [], lead: true };
  for (const n of nodes) {
    if (n.name === at) { if (cur.nodes.length) out.push(cur); cur = { title: X.DomUtils.textContent(n).replace(/\s+/g, ' ').trim() || 'Untitled', nodes: [n] }; continue; }
    cur.nodes.push(n);
  }
  if (cur.nodes.length) out.push(cur);
  // a lead part that is only the book's title heading is dropped
  return out.filter((c) => !(c.lead && !c.nodes.some((n) => n.name !== 'h1' && X.DomUtils.textContent(n).trim())));
}

/** A page (HTML from a file, or rendered Markdown) -> book. readLocal(src) -> bytes of a picture next to the file, or null. */
function fromHtmlString(html, { title, fallbackTitle = 'Untitled', authors = [], language = 'en', readLocal = () => null }) {
  const doc = X.parseHtml(html);
  const body = X.bodyOf(doc);
  const images = new Images();
  const metaTitle = title || X.titleOf(doc) || X.firstHeading(body) || fallbackTitle;
  const parts = splitAtHeadings(body, metaTitle);
  const mapSrc = (src) => {
    const s = String(src).trim();
    const m = /^data:(image\/(?:png|jpe?g|gif|webp));base64,([a-z0-9+/=\s]+)$/i.exec(s);
    let data = null; let key = s;
    if (m) { data = new Uint8Array(Buffer.from(m[2].replace(/\s+/g, ''), 'base64')); key = 'data:' + images.list.length; }
    else if (!/^[a-z][a-z0-9+.-]*:/i.test(s) && !s.startsWith('//')) data = readLocal(s);
    if (!data) return null;
    const name = images.add(key, data, m ? 'image' : decodeURIComponentSafe(s));
    return name ? `../images/${name}` : null;
  };
  const metaAuthor = (X.DomUtils.findOne((e) => e.name === 'meta' && /^(author|dc\.creator)$/i.test(e.attribs.name || ''), doc.children, true) || { attribs: {} }).attribs.content;
  const htmlLang = (X.DomUtils.findOne((e) => e.name === 'html', doc.children, false) || { attribs: {} }).attribs.lang;
  const chapters = parts.map((p, i) => ({ title: p.title || `Chapter ${i + 1}`, level: 1, body: X.toXhtml(p.nodes, { mapSrc }) })).filter((c) => c.body.trim());
  return {
    meta: { title: metaTitle, authors: authors.length ? authors : metaAuthor ? [metaAuthor] : [], language: langCode(htmlLang) || language },
    chapters: chapters.length ? chapters : [{ title: metaTitle, level: 1, body: '<p></p>' }], images: images.list, cover: null, warnings: [],
  };
}
const decodeURIComponentSafe = (s) => { try { return decodeURIComponent(s); } catch { return s; } };

function fromHtml(buf, fileName, readLocal) {
  return fromHtmlString(T.decodeText(buf), { readLocal, fallbackTitle: cleanName(fileName) });
}

const md = new MarkdownIt({ html: true, linkify: true, typographer: true });
function fromMarkdown(buf, fileName, readLocal) {
  let text = T.decodeText(buf);
  const fm = /^---\s*\n([\s\S]*?)\n(?:---|\.\.\.)\s*(?:\n|$)/.exec(text);
  const data = {};
  if (fm) {
    text = text.slice(fm[0].length);
    for (const line of fm[1].split('\n')) { const m = /^([A-Za-z]+)\s*:\s*(.*)$/.exec(line); if (m) data[m[1].toLowerCase()] = m[2].trim().replace(/^["']|["']$/g, ''); }
  }
  const html = md.render(text);
  const author = data.author || data.authors || data.creator;
  return fromHtmlString(html, {
    title: data.title || '', fallbackTitle: cleanName(fileName), readLocal,
    authors: author ? author.split(/\s*[;&]\s*|\s+and\s+/).filter(Boolean) : [], language: langCode(data.lang || data.language) || 'en',
  });
}

/** Any supported file -> book. kind: 'epub' | 'txt' | 'md' | 'html'. */
function load(kind, buf, fileName, readLocal) {
  if (kind === 'epub') return fromEpub(buf);
  if (kind === 'txt') return fromText(buf, fileName);
  if (kind === 'md') return fromMarkdown(buf, fileName, readLocal);
  if (kind === 'html') return fromHtml(buf, fileName, readLocal);
  throw new Error('That kind of file cannot be opened.');
}
const kindOf = (name) => { const m = /\.([a-z0-9]+)$/i.exec(String(name)); const e = m ? m[1].toLowerCase() : ''; return e === 'epub' ? 'epub' : (e === 'txt' || e === 'text') ? 'txt' : (e === 'md' || e === 'markdown') ? 'md' : (e === 'html' || e === 'htm' || e === 'xhtml') ? 'html' : null; };

// ---- out -----------------------------------------------------------------------------------------------------------------------
const bodyNodes = (body) => X.parseHtml(`<div>${body}</div>`).children[0].children;
/** Drop the chapter's first heading when it only repeats the chapter title (the outputs write the title themselves). */
function withoutRepeatedTitle(ch) {
  const nodes = bodyNodes(ch.body);
  const meaningful = (list) => list.find((n) => n.type === 'tag' || (n.type === 'text' && n.data.trim()));
  let first = meaningful(nodes);
  while (first && first.type === 'tag' && /^(section|div|article|header|hgroup)$/.test(first.name)) first = meaningful(first.children || []);
  if (first && /^h[1-6]$/.test(first.name) && X.DomUtils.textContent(first).replace(/\s+/g, ' ').trim() === ch.title.replace(/\s+/g, ' ').trim()) {
    if (nodes.includes(first)) return nodes.filter((n) => n !== first);
    X.DomUtils.removeElement(first);
  }
  return nodes;
}

function toEpub(book) {
  return E.writeEpub({ meta: book.meta, chapters: book.chapters.map((c) => ({ title: c.title, level: c.level, body: c.body })), images: book.images, cover: book.cover });
}

function toText(book) {
  const out = [];
  out.push(book.meta.title || 'Untitled');
  if (book.meta.authors && book.meta.authors.length) out.push('by ' + book.meta.authors.join(', '));
  out.push('');
  for (const ch of book.chapters) {
    const text = X.toText(withoutRepeatedTitle(ch));
    out.push('', '', ch.title, '');
    if (text) out.push(text);
  }
  return out.join('\n').replace(/\n{4,}/g, '\n\n\n').trim() + '\n';
}

/** Markdown with front matter; pictures are written to `imagesDir` (a folder name next to the .md). Returns { text, images }. */
function toMarkdown(book, imagesDir = 'images') {
  const byName = new Map(book.images.map((i) => [i.name, i]));
  const used = new Map();
  const mapSrc = (src) => { const m = /^\.\.\/images\/(.+)$/.exec(src); const img = m && byName.get(decodeURIComponentSafe(m[1])); if (!img) return null; used.set(img.name, img); return `${imagesDir}/${img.name}`; };
  const idx = (href) => /^chapter-(\d+)\.xhtml/.exec(href);
  const mapHref = (href) => { if (X.isWeb(href)) return href; const m = idx(href); return m ? '#' + slug(book.chapters[Number(m[1]) - 1] ? book.chapters[Number(m[1]) - 1].title : '') : null; };
  const yaml = (s) => JSON.stringify(String(s));
  const out = ['---', `title: ${yaml(book.meta.title || 'Untitled')}`];
  if (book.meta.authors && book.meta.authors.length) out.push(`author: ${yaml(book.meta.authors.join('; '))}`);
  if (book.meta.language) out.push(`language: ${yaml(book.meta.language)}`);
  if (book.meta.publisher) out.push(`publisher: ${yaml(book.meta.publisher)}`);
  if (book.meta.description) out.push(`description: ${yaml(book.meta.description)}`);
  out.push('---', '');
  for (const ch of book.chapters) {
    out.push(`# ${ch.title.replace(/\s+/g, ' ')}`, '');
    const body = X.toMarkdown(withoutRepeatedTitle(ch), { mapSrc, mapHref }).replace(/^# /gm, '## ');
    if (body) out.push(body, '');
  }
  return { text: out.join('\n'), images: [...used.values()] };
}
const slug = (s) => String(s).toLowerCase().trim().replace(/[^\p{L}\p{N}\s-]/gu, '').replace(/\s+/g, '-');

const PAGE_CSS = `:root { color-scheme: light; }
body { margin: 0; background: #fff; color: #1b1b1f; font: 18px/1.6 Georgia, "Iowan Old Style", "Noto Serif", "Times New Roman", serif; }
main { max-width: 40em; margin: 0 auto; padding: 3em 1.5em 5em; }
header.book { text-align: center; margin: 2em 0 3em; } header.book h1 { font-size: 2.2em; margin: 0 0 .3em; } header.book .by { font-style: italic; color: #555; }
header.book img.cover { max-width: 60%; max-height: 70vh; display: block; margin: 0 auto 2em; box-shadow: 0 2px 12px rgba(0,0,0,.2); }
nav.toc ol { padding-left: 1.2em; } nav.toc a { color: inherit; }
section.chapter { margin-top: 3em; } h1, h2, h3 { line-height: 1.25; } h2.chapter-title { font-size: 1.6em; margin: 0 0 1em; }
p { margin: 0 0 .8em; text-align: justify; hyphens: auto; }
img { max-width: 100%; height: auto; } pre { white-space: pre-wrap; font-size: .85em; }
blockquote { margin: 1em 2em; font-style: italic; } table { border-collapse: collapse; } td, th { border: 1px solid #aaa; padding: .2em .5em; }
hr { border: 0; text-align: center; margin: 1.5em 0; } hr::after { content: "* * *"; color: #777; }
a { color: #2a55b0; } .missing-image { color: #888; font-style: italic; }
@media print { main { max-width: none; padding: 0; } section.chapter { break-before: page; margin-top: 0; } header.book { break-after: page; } nav.toc { break-after: page; } img, table, pre { break-inside: avoid; } a { color: inherit; text-decoration: none; } }
`;

/** One self-contained HTML page (pictures inlined). When printed (the PDF), each chapter starts on a new page. */
function toHtml(book) {
  const byName = new Map(book.images.map((i) => [i.name, i]));
  const dataUri = (img) => `data:${img.mediaType};base64,${Buffer.from(img.data).toString('base64')}`;
  const chapterSections = book.chapters.map((ch, i) => {
    const n = i + 1;
    const body = X.toXhtml(withoutRepeatedTitle(ch), {
      idPrefix: `c${n}-`,
      mapSrc: (src) => { const m = /^\.\.\/images\/(.+)$/.exec(src); const img = m && byName.get(decodeURIComponentSafe(m[1])); return img ? dataUri(img) : null; },
      mapHref: (href) => { if (X.isWeb(href)) return href; const m = /^chapter-(\d+)\.xhtml(?:#(.*))?$/.exec(href); return m ? (m[2] ? `#c${Number(m[1])}-${m[2]}` : `#ch-${Number(m[1])}`) : null; },
    });
    return `<section class="chapter" id="ch-${n}">\n<h2 class="chapter-title">${X.escText(ch.title)}</h2>\n${body}\n</section>`;
  });
  const m = book.meta;
  const toc = book.chapters.length > 1 ? `<nav class="toc"><h2>Contents</h2><ol>${book.chapters.map((c, i) => `<li><a href="#ch-${i + 1}">${X.escText(c.title)}</a></li>`).join('')}</ol></nav>` : '';
  const cover = book.cover && sniff(book.cover.data) ? `<img class="cover" src="data:${sniff(book.cover.data)};base64,${Buffer.from(book.cover.data).toString('base64')}" alt="Cover">` : '';
  return `<!doctype html>
<html lang="${X.escAttr(m.language || 'en')}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'">
<title>${X.escText(m.title || 'Untitled')}</title>
${m.authors && m.authors.length ? `<meta name="author" content="${X.escAttr(m.authors.join(', '))}">\n` : ''}<style>${PAGE_CSS}</style>
</head>
<body>
<main>
<header class="book">${cover}<h1>${X.escText(m.title || 'Untitled')}</h1>${m.authors && m.authors.length ? `<p class="by">${X.escText(m.authors.join(', '))}</p>` : ''}</header>
${toc}
${chapterSections.join('\n')}
</main>
</body>
</html>
`;
}

/** Plain text of every chapter, for searching inside a book. */
const chapterText = (ch) => X.toText(bodyNodes(ch.body));

module.exports = { load, kindOf, fromEpub, fromText, fromMarkdown, fromHtml, fromHtmlString, toEpub, toText, toMarkdown, toHtml, chapterText, sniff, splitAtHeadings, Images };
