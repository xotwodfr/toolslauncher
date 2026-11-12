'use strict';
// EPUB 2 and 3: reading (container.xml -> OPF -> manifest, spine, metadata, NCX or nav table of contents), writing a
// valid EPUB 3 (with an EPUB 2 NCX too, for older readers), and changing the metadata / cover of an existing book into
// a NEW file. Zip handling is fflate (pure JavaScript).
const { unzipSync, zipSync, strToU8, strFromU8 } = require('fflate');
const crypto = require('crypto');
const X = require('./xhtml');
const { DomUtils } = X;

const MAX_ENTRY = 300 * 1024 * 1024;   // one file inside the book
const MAX_TOTAL = 1024 * 1024 * 1024;  // the whole book unpacked

// ---- paths ------------------------------------------------------------------------------------------------------------------
const dirname = (p) => { const i = p.lastIndexOf('/'); return i === -1 ? '' : p.slice(0, i); };
/** Resolve an href (URL-encoded, relative) against a base path inside the zip. Returns { path, frag } or null. */
function resolveHref(baseDir, href) {
  if (href == null) return null;
  const s = String(href).trim();
  if (!s || /^[a-z][a-z0-9+.-]*:/i.test(s) || s.startsWith('//')) return null;
  const hash = s.indexOf('#');
  let rel = hash === -1 ? s : s.slice(0, hash);
  const frag = hash === -1 ? '' : s.slice(hash + 1);
  try { rel = decodeURIComponent(rel); } catch { /* keep as written */ }
  rel = rel.split('?')[0];
  const parts = (rel.startsWith('/') ? [] : baseDir.split('/').filter(Boolean));
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') { if (!parts.length) return null; parts.pop(); } else parts.push(seg);
  }
  return { path: parts.join('/'), frag: (() => { try { return decodeURIComponent(frag); } catch { return frag; } })() };
}
/** A relative href from one file in the zip to another (both full paths). */
function relativeHref(fromFile, toPath) {
  const a = dirname(fromFile).split('/').filter(Boolean); const b = toPath.split('/');
  let i = 0; while (i < a.length && i < b.length - 1 && a[i] === b[i]) i++;
  return [...Array(a.length - i).fill('..'), ...b.slice(i)].map((s) => (s === '..' ? s : encodeURIComponent(s))).join('/');
}

const MEDIA = { xhtml: 'application/xhtml+xml', html: 'application/xhtml+xml', htm: 'application/xhtml+xml', css: 'text/css', ncx: 'application/x-dtbncx+xml',
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', svg: 'image/svg+xml', webp: 'image/webp', ttf: 'font/ttf', otf: 'font/otf',
  woff: 'font/woff', woff2: 'font/woff2', js: 'application/javascript', xml: 'application/xml', smil: 'application/smil+xml', mp3: 'audio/mpeg', mp4: 'video/mp4' };
const mediaOf = (p) => MEDIA[(/\.([a-z0-9]+)$/i.exec(p) || [])[1]?.toLowerCase()] || 'application/octet-stream';

// ---- small DOM helpers (namespace prefixes ignored: dc:title, opf:meta, title all match "title") ----------------------------
const local = (name) => String(name || '').toLowerCase().replace(/^.*:/, '');
const findAll = (root, name) => DomUtils.findAll((e) => local(e.name) === name, Array.isArray(root) ? root : [root]);
const findOne = (root, name) => DomUtils.findOne((e) => local(e.name) === name, Array.isArray(root) ? root : [root], true);
const textOf = (el) => (el ? DomUtils.textContent(el).replace(/\s+/g, ' ').trim() : '');
const attr = (el, name) => { if (!el || !el.attribs) return undefined; for (const [k, v] of Object.entries(el.attribs)) if (local(k) === name) return v; return undefined; };
const kids = (el, name) => (el && el.children ? el.children.filter((c) => c.type === 'tag' && (!name || local(c.name) === name)) : []);

// ---- reading -------------------------------------------------------------------------------------------------------------------
function unzip(buf) {
  let total = 0;
  const files = unzipSync(buf instanceof Uint8Array ? buf : new Uint8Array(buf), {
    filter: (f) => {
      if (f.name.endsWith('/')) return false;
      if (f.originalSize > MAX_ENTRY) throw new Error(`“${f.name}” inside the book is too big to open.`);
      total += f.originalSize;
      if (total > MAX_TOTAL) throw new Error('This book is too big to open (more than 1 GB unpacked).');
      return true;
    },
  });
  return files;
}

/**
 * Open an EPUB. Returns { version, opfPath, meta, manifest: Map(id -> item), spine: [item], toc: [{ label, path, frag, children }],
 * cover: item|null, files: { path: Uint8Array }, warnings }.
 */
function readEpub(buf) {
  let files;
  try { files = unzip(buf); } catch (e) { if (/too big/.test(e.message)) throw e; throw new Error('This is not an EPUB (it is not a valid zip file).'); }
  const warnings = [];
  const mt = files.mimetype ? strFromU8(files.mimetype).trim() : '';
  if (mt !== 'application/epub+zip') warnings.push('The book has no proper "mimetype" entry; reading it anyway.');
  let opfPath = null;
  if (files['META-INF/container.xml']) {
    const c = X.parseXml(strFromU8(files['META-INF/container.xml']));
    const roots = findAll(c, 'rootfile');
    const r = roots.find((e) => /oebps-package/.test(attr(e, 'media-type') || '')) || roots[0];
    if (r) opfPath = (attr(r, 'full-path') || '').replace(/^\/+/, '');
  }
  if (!opfPath || !files[opfPath]) {
    opfPath = Object.keys(files).find((p) => /\.opf$/i.test(p)) || null;
    if (!opfPath) throw new Error('This EPUB has no package file (content.opf), so it cannot be read.');
    warnings.push('META-INF/container.xml is missing or wrong; found the package file by its name.');
  }
  const opfDir = dirname(opfPath);
  const opf = X.parseXml(strFromU8(files[opfPath]));
  const pkg = findOne(opf, 'package');
  const version = (pkg && attr(pkg, 'version')) || '2.0';
  const md = findOne(opf, 'metadata') || opf;
  // refinements (EPUB 3): <meta refines="#id" property="role">aut</meta>
  const refines = {};
  for (const m of findAll(md, 'meta')) { const r = attr(m, 'refines'); if (r) { (refines[r.replace(/^#/, '')] ||= {})[attr(m, 'property')] = textOf(m); } }
  const titles = findAll(md, 'title');
  const mainTitle = titles.find((t) => (refines[attr(t, 'id')] || {})['title-type'] === 'main') || titles[0];
  const creators = findAll(md, 'creator').filter((c) => {
    const role = attr(c, 'role') || (refines[attr(c, 'id')] || {}).role;
    return !role || role === 'aut';
  });
  const uidId = pkg && attr(pkg, 'unique-identifier');
  const ids = findAll(md, 'identifier');
  const meta = {
    title: textOf(mainTitle),
    authors: creators.map(textOf).filter(Boolean),
    language: textOf(findOne(md, 'language')),
    publisher: textOf(findOne(md, 'publisher')),
    description: textOf(findOne(md, 'description')).replace(/<[^>]*>/g, ''),
    identifier: textOf(ids.find((e) => attr(e, 'id') === uidId) || ids[0]),
    date: textOf(findOne(md, 'date')),
    subjects: findAll(md, 'subject').map(textOf).filter(Boolean),
  };
  const manifest = new Map();
  for (const it of findAll(findOne(opf, 'manifest') || opf, 'item')) {
    const id = attr(it, 'id'); const r = resolveHref(opfDir, attr(it, 'href'));
    if (!id || !r) continue;
    manifest.set(id, { id, path: r.path, mediaType: attr(it, 'media-type') || mediaOf(r.path), properties: (attr(it, 'properties') || '').split(/\s+/).filter(Boolean), exists: !!files[r.path] });
  }
  const spineEl = findOne(opf, 'spine');
  const spine = [];
  for (const ref of kids(spineEl, 'itemref')) {
    const item = manifest.get(attr(ref, 'idref'));
    if (!item) { warnings.push(`The reading order names "${attr(ref, 'idref')}", which is not in the book.`); continue; }
    if (!item.exists) { warnings.push(`“${item.path}” is listed but missing from the book.`); continue; }
    if (!/x?html|xml/.test(item.mediaType)) continue;
    spine.push({ ...item, linear: attr(ref, 'linear') !== 'no' });
  }
  if (!spine.length) throw new Error('This EPUB has no readable chapters.');
  // table of contents: EPUB 3 nav first, then the EPUB 2 NCX
  let toc = [];
  const navItem = [...manifest.values()].find((i) => i.properties.includes('nav') && i.exists);
  if (navItem) {
    const doc = X.parseHtml(strFromU8(files[navItem.path]));
    const navs = findAll(doc, 'nav');
    const nav = navs.find((n) => /(^|\s)toc(\s|$)/.test(attr(n, 'type') || '')) || navs[0];
    const walk = (ol) => kids(ol, 'li').map((li) => {
      const a = kids(li, 'a')[0] || kids(li, 'span')[0];
      const r = a ? resolveHref(dirname(navItem.path), attr(a, 'href')) : null;
      const sub = kids(li, 'ol')[0];
      return { label: textOf(a) || 'Untitled', path: r ? r.path : null, frag: r ? r.frag : '', children: sub ? walk(sub) : [] };
    });
    const ol = nav && kids(nav, 'ol')[0];
    if (ol) toc = walk(ol);
  }
  const ncxItem = manifest.get(spineEl && attr(spineEl, 'toc')) || [...manifest.values()].find((i) => /dtbncx/.test(i.mediaType));
  if (!toc.length && ncxItem && files[ncxItem.path]) {
    const doc = X.parseXml(strFromU8(files[ncxItem.path]));
    const walk = (el) => kids(el, 'navpoint').map((np) => {
      const content = kids(np, 'content')[0];
      const r = content ? resolveHref(dirname(ncxItem.path), attr(content, 'src')) : null;
      return { label: textOf(findOne(kids(np, 'navlabel'), 'text')) || 'Untitled', path: r ? r.path : null, frag: r ? r.frag : '', children: walk(np) };
    });
    toc = walk(findOne(doc, 'navmap'));
  }
  // cover picture: EPUB 3 property, EPUB 2 <meta name="cover">, else an image called "cover"
  let cover = [...manifest.values()].find((i) => i.properties.includes('cover-image') && i.exists) || null;
  if (!cover) { const m = findAll(md, 'meta').find((e) => attr(e, 'name') === 'cover'); const it = m && manifest.get(attr(m, 'content')); if (it && it.exists && /^image\//.test(it.mediaType)) cover = it; }
  if (!cover) cover = [...manifest.values()].find((i) => /^image\//.test(i.mediaType) && i.exists && /cover/i.test(i.id + ' ' + i.path)) || null;
  return { version, opfPath, meta, manifest, spine, toc, cover, files, warnings };
}

// ---- writing ---------------------------------------------------------------------------------------------------------------------
const uuid = () => crypto.randomUUID();
const isoNow = () => new Date().toISOString().replace(/\.\d+Z$/, 'Z');
const XHTML_HEAD = '<?xml version="1.0" encoding="utf-8"?>\n<!DOCTYPE html>\n';
const e = X.escText; const ea = X.escAttr;

const BOOK_CSS = `body { font-family: serif; line-height: 1.5; margin: 0 5%; }
h1, h2, h3 { line-height: 1.25; page-break-after: avoid; }
h1 { font-size: 1.6em; margin: 1.5em 0 1em; } h2 { font-size: 1.3em; }
p { margin: 0 0 0.8em; text-align: justify; hyphens: auto; }
img { max-width: 100%; height: auto; }
.cover { text-align: center; margin: 0; padding: 0; } .cover img { max-height: 100vh; }
pre { white-space: pre-wrap; font-size: 0.9em; }
blockquote { margin: 1em 2em; font-style: italic; }
table { border-collapse: collapse; } td, th { border: 1px solid #999; padding: 0.2em 0.5em; }
hr { border: 0; text-align: center; margin: 1.5em 0; } hr::after { content: "* * *"; }
`;

function chapterDoc({ title, body, lang, cssHref, type = 'chapter' }) {
  return `${XHTML_HEAD}<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="${ea(lang)}" xml:lang="${ea(lang)}">
<head>
<meta charset="utf-8"/>
<title>${e(X.xmlSafe(title))}</title>
<link rel="stylesheet" type="text/css" href="${ea(cssHref)}"/>
</head>
<body>
<section epub:type="${type}">
${body}
</section>
</body>
</html>
`;
}

/**
 * Build an EPUB 3 file.
 *   book.meta: { title, authors[], language, publisher, description, identifier, date, subjects[] }
 *   book.chapters: [{ title, body (safe XHTML from toXhtml/textToXhtml), level (1 or 2, for the table of contents) }]
 *       Pictures in a body refer to "../images/<name>" (see `images`).
 *   book.images: [{ name, data, mediaType }]  (written to OEBPS/images/<name>)
 *   book.cover: { data, mediaType } | null
 * Returns a Uint8Array. The "mimetype" entry is first and stored uncompressed, as the standard requires.
 */
function writeEpub(book) {
  const meta = { title: 'Untitled', authors: [], language: 'en', publisher: '', description: '', identifier: '', date: '', subjects: [], ...book.meta };
  const lang = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/i.test(meta.language || '') ? meta.language : 'en';
  const ident = meta.identifier || 'urn:uuid:' + uuid();
  const files = {};
  files.mimetype = [strToU8('application/epub+zip'), { level: 0 }];
  files['META-INF/container.xml'] = strToU8('<?xml version="1.0" encoding="utf-8"?>\n<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">\n  <rootfiles>\n    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>\n  </rootfiles>\n</container>\n');
  const manifest = [];
  const spine = [];
  const tocEntries = [];
  manifest.push('<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>');
  manifest.push('<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>');
  manifest.push('<item id="css" href="styles.css" media-type="text/css"/>');
  files['OEBPS/styles.css'] = strToU8(book.css || BOOK_CSS);
  let coverName = null;
  if (book.cover && book.cover.data) {
    const ext = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp' }[book.cover.mediaType] || 'jpg';
    coverName = `cover.${ext}`;
    files[`OEBPS/images/${coverName}`] = book.cover.data;
    manifest.push(`<item id="cover-image" href="images/${coverName}" media-type="${ea(book.cover.mediaType || 'image/jpeg')}" properties="cover-image"/>`);
    files['OEBPS/text/cover.xhtml'] = strToU8(chapterDoc({ title: meta.title, lang, cssHref: '../styles.css', type: 'cover', body: `<div class="cover"><img src="../images/${coverName}" alt="${ea(X.xmlSafe(meta.title))}"/></div>` }));
    manifest.push('<item id="cover" href="text/cover.xhtml" media-type="application/xhtml+xml"/>');
    spine.push('<itemref idref="cover" linear="yes"/>');
  }
  const used = new Set();
  for (const img of book.images || []) {
    if (used.has(img.name) || img.name === coverName) continue;
    used.add(img.name);
    files[`OEBPS/images/${img.name}`] = img.data;
    manifest.push(`<item id="img-${used.size}" href="images/${encodeURIComponent(img.name)}" media-type="${ea(img.mediaType || mediaOf(img.name))}"/>`);
  }
  const chapters = book.chapters && book.chapters.length ? book.chapters : [{ title: meta.title, body: '<p></p>' }];
  chapters.forEach((ch, i) => {
    const n = String(i + 1).padStart(3, '0');
    const file = `text/chapter-${n}.xhtml`;
    files[`OEBPS/${file}`] = strToU8(chapterDoc({ title: ch.title || `Chapter ${i + 1}`, lang, cssHref: '../styles.css', body: ch.body || '<p></p>' }));
    manifest.push(`<item id="ch${n}" href="${file}" media-type="application/xhtml+xml"/>`);
    spine.push(`<itemref idref="ch${n}"/>`);
    tocEntries.push({ title: ch.title || `Chapter ${i + 1}`, href: file, level: ch.level === 2 ? 2 : 1 });
  });
  // nested table of contents: level-2 entries go under the level-1 entry before them
  const tree = [];
  for (const t of tocEntries) { if (t.level === 2 && tree.length) tree[tree.length - 1].children.push(t); else tree.push({ ...t, children: [] }); }
  const navLis = (list) => list.map((t) => `<li><a href="${ea(t.href)}">${e(X.xmlSafe(t.title))}</a>${t.children && t.children.length ? `\n<ol>\n${navLis(t.children)}\n</ol>` : ''}</li>`).join('\n');
  files['OEBPS/nav.xhtml'] = strToU8(`${XHTML_HEAD}<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="${ea(lang)}" xml:lang="${ea(lang)}">
<head>
<meta charset="utf-8"/>
<title>${e(X.xmlSafe(meta.title))}</title>
<link rel="stylesheet" type="text/css" href="styles.css"/>
</head>
<body>
<nav epub:type="toc" id="toc">
<h1>Contents</h1>
<ol>
${navLis(tree)}
</ol>
</nav>
<nav epub:type="landmarks" id="landmarks" hidden="hidden">
<ol>
${coverName ? '<li><a epub:type="cover" href="text/cover.xhtml">Cover</a></li>\n' : ''}<li><a epub:type="bodymatter" href="${ea(tocEntries[0].href)}">Start of the book</a></li>
</ol>
</nav>
</body>
</html>
`);
  let order = 0;
  const navPoints = (list, depth) => list.map((t) => { order++; const id = `np${order}`; const po = order; return `${'  '.repeat(depth)}<navPoint id="${id}" playOrder="${po}"><navLabel><text>${e(X.xmlSafe(t.title))}</text></navLabel><content src="${ea(t.href)}"/>${t.children && t.children.length ? '\n' + navPoints(t.children, depth + 1) + '\n' + '  '.repeat(depth) : ''}</navPoint>`; }).join('\n');
  const depth = tree.some((t) => t.children.length) ? 2 : 1;
  files['OEBPS/toc.ncx'] = strToU8(`<?xml version="1.0" encoding="utf-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1" xml:lang="${ea(lang)}">
<head>
<meta name="dtb:uid" content="${ea(ident)}"/>
<meta name="dtb:depth" content="${depth}"/>
<meta name="dtb:totalPageCount" content="0"/>
<meta name="dtb:maxPageNumber" content="0"/>
</head>
<docTitle><text>${e(X.xmlSafe(meta.title))}</text></docTitle>
<navMap>
${navPoints(tree, 1)}
</navMap>
</ncx>
`);
  const md = [];
  md.push(`<dc:identifier id="bookid">${e(X.xmlSafe(ident))}</dc:identifier>`);
  md.push(`<dc:title id="title">${e(X.xmlSafe(meta.title || 'Untitled'))}</dc:title>`);
  (meta.authors || []).filter(Boolean).forEach((a, i) => { md.push(`<dc:creator id="creator${i + 1}">${e(X.xmlSafe(a))}</dc:creator>`); md.push(`<meta refines="#creator${i + 1}" property="role" scheme="marc:relators">aut</meta>`); });
  md.push(`<dc:language>${e(lang)}</dc:language>`);
  if (meta.publisher) md.push(`<dc:publisher>${e(X.xmlSafe(meta.publisher))}</dc:publisher>`);
  if (meta.description) md.push(`<dc:description>${e(X.xmlSafe(meta.description))}</dc:description>`);
  if (meta.date) md.push(`<dc:date>${e(X.xmlSafe(meta.date))}</dc:date>`);
  for (const s of meta.subjects || []) md.push(`<dc:subject>${e(X.xmlSafe(s))}</dc:subject>`);
  md.push(`<meta property="dcterms:modified">${isoNow()}</meta>`);
  if (coverName) md.push('<meta name="cover" content="cover-image"/>');
  files['OEBPS/content.opf'] = strToU8(`<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid" xml:lang="${ea(lang)}">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
${md.join('\n')}
</metadata>
<manifest>
${manifest.join('\n')}
</manifest>
<spine toc="ncx">
${spine.join('\n')}
</spine>
${coverName ? '<guide>\n<reference type="cover" title="Cover" href="text/cover.xhtml"/>\n</guide>\n' : ''}</package>
`);
  // everything except the mimetype is compressed
  const out = {};
  for (const [k, v] of Object.entries(files)) out[k] = Array.isArray(v) ? v : [v, { level: 6 }];
  return zipSync(out, { mtime: new Date() });
}

// ---- changing the details of an existing book ------------------------------------------------------------------------------------
/**
 * Change title, authors, language, publisher, description and/or cover of an EPUB; returns the bytes of a NEW EPUB.
 * Everything else in the book is kept as it was. `changes` fields that are undefined are left alone; an empty string
 * removes that detail (except the title and language, which a book must have).
 *   changes.cover: { data, mediaType } to set a new cover picture
 */
function editMetadata(buf, changes) {
  const files = unzip(buf);
  const book = readEpub(buf);
  const opfDir = dirname(book.opfPath);
  const doc = X.parseXml(strFromU8(files[book.opfPath]));
  const pkg = findOne(doc, 'package');
  const md = findOne(doc, 'metadata');
  if (!pkg || !md) throw new Error('The package file of this book is damaged.');
  const v3 = /^3/.test(attr(pkg, 'version') || '');
  const dcPrefix = (() => { const t = findOne(md, 'title') || findOne(md, 'language'); return t && t.name.includes(':') ? t.name.split(':')[0] + ':' : 'dc:'; })();
  if (dcPrefix === 'dc:' && !Object.keys(md.attribs).some((k) => k === 'xmlns:dc') && !Object.keys(pkg.attribs).some((k) => k === 'xmlns:dc')) md.attribs['xmlns:dc'] = 'http://purl.org/dc/elements/1.1/';
  const mk = (name, text, attribs = {}) => {
    const p = X.parseXml(`<x>${`<${name}${Object.entries(attribs).map(([k, v]) => ` ${k}="${ea(v)}"`).join('')}>${e(X.xmlSafe(text))}</${name}>`}</x>`);
    return findOne(p, 'x').children[0];
  };
  const newline = () => { const t = findOne(X.parseXml('<x>\n</x>'), 'x').children[0]; t.parent = null; return t; };
  const append = (node) => { DomUtils.appendChild(md, newline()); DomUtils.appendChild(md, node); };
  const drop = (el) => { const p = el.prev; if (p && p.type === 'text' && !p.data.trim()) DomUtils.removeElement(p); DomUtils.removeElement(el); };
  const removeRefines = (el) => { const id = attr(el, 'id'); if (!id) return; for (const m of findAll(md, 'meta')) if (attr(m, 'refines') === '#' + id) drop(m); };
  const setOne = (name, value, required) => {
    if (value === undefined) return;
    const v = String(value).trim();
    const els = findAll(md, name);
    if (!v && required) return;
    if (!v) { for (const el of els) { removeRefines(el); drop(el); } return; }
    if (els.length) { els[0].children = [{ type: 'text', data: X.xmlSafe(v), parent: els[0] }]; for (const el of els.slice(1)) if (name !== 'title') { removeRefines(el); drop(el); } }
    else append(mk(dcPrefix + name, v));
  };
  setOne('title', changes.title, true);
  setOne('language', changes.language, true);
  setOne('publisher', changes.publisher);
  setOne('description', changes.description);
  if (changes.authors !== undefined) {
    const list = (Array.isArray(changes.authors) ? changes.authors : String(changes.authors).split(/\s*;\s*/)).map((s) => String(s).trim()).filter(Boolean);
    const old = findAll(md, 'creator').filter((c) => { const role = attr(c, 'role') || (() => { const id = attr(c, 'id'); const m = id && findAll(md, 'meta').find((x) => attr(x, 'refines') === '#' + id && attr(x, 'property') === 'role'); return m ? textOf(m) : ''; })(); return !role || role === 'aut'; });
    for (const c of old) { removeRefines(c); drop(c); }
    list.forEach((a, i) => {
      if (v3) { const id = `author-${i + 1}-${crypto.randomBytes(3).toString('hex')}`; append(mk(dcPrefix + 'creator', a, { id })); append(mk('meta', 'aut', { refines: '#' + id, property: 'role', scheme: 'marc:relators' })); }
      else append(mk(dcPrefix + 'creator', a, { 'opf:role': 'aut' }));
    });
  }
  const newFiles = { ...files };
  if (changes.cover && changes.cover.data) {
    const ext = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp' }[changes.cover.mediaType];
    if (!ext) throw new Error('The cover must be a JPEG, PNG, GIF or WebP picture.');
    const manifestEl = findOne(doc, 'manifest');
    const ids = new Set(findAll(manifestEl, 'item').map((i) => attr(i, 'id')));
    let id = 'cover-image'; let k = 2; while (ids.has(id)) id = `cover-image-${k++}`;
    let p = (opfDir ? opfDir + '/' : '') + `images/cover-new.${ext}`; k = 2; while (newFiles[p]) p = (opfDir ? opfDir + '/' : '') + `images/cover-new-${k++}.${ext}`;
    newFiles[p] = changes.cover.data instanceof Uint8Array ? changes.cover.data : new Uint8Array(changes.cover.data);
    if (v3) for (const it of findAll(manifestEl, 'item')) { const props = (attr(it, 'properties') || '').split(/\s+/).filter((x) => x && x !== 'cover-image'); if (props.length) it.attribs.properties = props.join(' '); else delete it.attribs.properties; }
    const href = relativeHref(book.opfPath, p);
    const itemAttrs = { id, href, 'media-type': changes.cover.mediaType };
    if (v3) itemAttrs.properties = 'cover-image';
    const itemNode = findOne(X.parseXml(`<x><item${Object.entries(itemAttrs).map(([a, b]) => ` ${a}="${ea(b)}"`).join('')}/></x>`), 'x').children[0];
    DomUtils.appendChild(manifestEl, newline());
    DomUtils.appendChild(manifestEl, itemNode);
    for (const m of findAll(md, 'meta')) if (attr(m, 'name') === 'cover') drop(m);
    append(mk('meta', '', { name: 'cover', content: id }));
    // a cover page that shows the old picture is pointed at the new one (only that attribute changes in the file)
    if (book.cover) {
      for (const it of book.manifest.values()) {
        if (!/x?html/.test(it.mediaType) || !newFiles[it.path]) continue;
        const src = strFromU8(newFiles[it.path]);
        let changed = false;
        const next = src.replace(/\b(src|xlink:href|href)=(["'])([^"']+)\2/g, (m, a, q, v) => {
          const r = resolveHref(dirname(it.path), v);
          if (!r || r.path !== book.cover.path || a === 'href' && !/<image\b/i.test(src)) return m;
          changed = true; return `${a}=${q}${relativeHref(it.path, p)}${q}`;
        });
        if (changed) newFiles[it.path] = strToU8(next);
      }
    }
  }
  if (v3) {
    const mod = findAll(md, 'meta').find((m) => attr(m, 'property') === 'dcterms:modified');
    if (mod) mod.children = [{ type: 'text', data: isoNow(), parent: mod }]; else append(mk('meta', isoNow(), { property: 'dcterms:modified' }));
  }
  newFiles[book.opfPath] = strToU8(DomUtils.getOuterHTML(doc, { xmlMode: true, decodeEntities: true, encodeEntities: 'utf8' }));
  const out = { mimetype: [strToU8('application/epub+zip'), { level: 0 }] };
  for (const [k2, v] of Object.entries(newFiles)) if (k2 !== 'mimetype') out[k2] = [v, { level: 6 }];
  return zipSync(out, { mtime: new Date() });
}

/** Zip entries in their stored order, with whether each is compressed (for checks: the mimetype must be first and stored). */
function zipEntries(buf) {
  const b = Buffer.from(buf);
  const out = [];
  let i = 0;
  while (i + 30 <= b.length && b.readUInt32LE(i) === 0x04034b50) {
    const method = b.readUInt16LE(i + 8); const csize = b.readUInt32LE(i + 18); const nlen = b.readUInt16LE(i + 26); const xlen = b.readUInt16LE(i + 28);
    const name = b.toString('utf8', i + 30, i + 30 + nlen);
    out.push({ name, method, extraLength: xlen, offset: i });
    i += 30 + nlen + xlen + csize;
    if (b.readUInt16LE(i - csize - nlen - xlen - 30 + 6) & 8) i += 16; // data descriptor
  }
  return out;
}

module.exports = { readEpub, writeEpub, editMetadata, resolveHref, relativeHref, zipEntries, mediaOf, dirname, BOOK_CSS, unzip };
