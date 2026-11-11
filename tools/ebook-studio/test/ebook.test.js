'use strict';
// Ebook Converter & Reader core tests: reading EPUB 2 (NCX) and EPUB 3 (nav), writing EPUBs and checking their structure
// with an independent strict XML parser, text chapter splitting and decoding, details round trips, the sanitiser, and
// the conversions between formats. All books are invented (src/samples.js).
const assert = require('assert');
const { unzipSync, zipSync, strFromU8, strToU8 } = require('fflate');
const { XMLValidator, XMLParser } = require('fast-xml-parser');
const E = require('../src/epub');
const C = require('../src/convert');
const T = require('../src/text');
const X = require('../src/xhtml');
const S = require('../src/samples');

const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const xml = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@', removeNSPrefix: false, isArray: (n) => ['item', 'itemref', 'navPoint', 'li', 'dc:creator', 'meta', 'rootfile'].includes(n) });

/** Everything a valid EPUB needs, checked on the raw bytes. Returns the parsed package. */
function validateEpub(bytes, { epub3 = true } = {}) {
  const entries = E.zipEntries(bytes);
  assert.strictEqual(entries[0].name, 'mimetype', 'mimetype is the first entry');
  assert.strictEqual(entries[0].method, 0, 'mimetype is stored, not compressed');
  assert.strictEqual(entries[0].extraLength, 0, 'no extra field on mimetype');
  assert.strictEqual(Buffer.from(bytes).toString('latin1', 30, 38), 'mimetype');
  assert.strictEqual(Buffer.from(bytes).toString('latin1', 38, 58), 'application/epub+zip');
  const files = unzipSync(bytes);
  for (const [name, data] of Object.entries(files)) {
    if (/\.(xhtml|opf|ncx|xml)$/.test(name)) {
      const v = XMLValidator.validate(strFromU8(data));
      assert.strictEqual(v, true, `${name} is not well-formed: ${JSON.stringify(v)}`);
    }
  }
  const container = xml.parse(strFromU8(files['META-INF/container.xml']));
  const opfPath = container.container.rootfiles.rootfile[0]['@full-path'];
  const pkg = xml.parse(strFromU8(files[opfPath])).package;
  const dir = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : '';
  const items = pkg.manifest.item;
  const ids = new Set();
  for (const it of items) {
    assert.ok(!ids.has(it['@id']), 'duplicate manifest id ' + it['@id']); ids.add(it['@id']);
    const p = dir + decodeURIComponent(it['@href']);
    assert.ok(files[p], `manifest item ${it['@id']} (${p}) exists in the zip`);
  }
  for (const ref of pkg.spine.itemref) assert.ok(ids.has(ref['@idref']), 'spine idref valid: ' + ref['@idref']);
  if (pkg.spine['@toc']) assert.ok(ids.has(pkg.spine['@toc']), 'spine toc refers to the NCX');
  if (epub3) {
    assert.strictEqual(pkg['@version'], '3.0');
    assert.strictEqual(items.filter((i) => /(^|\s)nav(\s|$)/.test(i['@properties'] || '')).length, 1, 'exactly one nav document');
    const mod = pkg.metadata.meta.find((m) => m['@property'] === 'dcterms:modified');
    assert.match(mod['#text'], /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/, 'dcterms:modified');
  }
  const uidId = pkg['@unique-identifier'];
  const ident = [].concat(pkg.metadata['dc:identifier']).find((i) => i['@id'] === uidId);
  assert.ok(ident, 'unique identifier present');
  return { pkg, files, opfPath };
}

// ---- reading ----------------------------------------------------------------------------------------------------------------
test('EPUB 2: details, reading order, NCX contents with fragments, cover from <meta name="cover">, encoded file names', () => {
  const ep = E.readEpub(S.makeEpub2({ chapters: 3 }));
  assert.strictEqual(ep.version, '2.0');
  assert.strictEqual(ep.opfPath, 'OPS/package.opf');
  assert.deepStrictEqual(ep.meta.authors, ['Mara Invented'], 'the illustrator is not an author');
  assert.strictEqual(ep.meta.title, 'The Lighthouse Keeper’s Almanac');
  assert.strictEqual(ep.meta.language, 'en-GB');
  assert.strictEqual(ep.meta.identifier, 'urn:uuid:0b6b1c1e-3d1f-4c39-9a9e-2a3b4c5d6e7f');
  assert.deepStrictEqual(ep.spine.map((s) => [s.path, s.linear]), [['OPS/text/cover.xhtml', false], ['OPS/text/ch1.xhtml', true], ['OPS/text/ch2.xhtml', true], ['OPS/text/ch3.xhtml', true]]);
  assert.deepStrictEqual(ep.toc.map((t) => [t.label, t.path, t.frag]), [['Cover', 'OPS/text/cover.xhtml', ''], ['Chapter 1: Winter Light', 'OPS/text/ch1.xhtml', 'c1'], ['Chapter 2: The Fog Bell', 'OPS/text/ch2.xhtml', 'c2'], ['Chapter 3: Spring Tides', 'OPS/text/ch3.xhtml', 'c3']]);
  assert.strictEqual(ep.cover.path, 'OPS/images/cover.png');
  assert.ok(ep.manifest.get('map').exists, 'percent-encoded unicode file name resolved');
  assert.deepStrictEqual(ep.warnings, []);
});

test('EPUB 3: nested nav contents (preferred over the NCX), cover-image property, creators refined as authors', () => {
  const bytes = E.writeEpub({ meta: { title: 'Nested', authors: ['Ann One', 'Bo Two'], language: 'fr' }, chapters: [{ title: 'Part One', body: '<p>a</p>' }, { title: 'One A', body: '<p>b</p>', level: 2 }, { title: 'One B', body: '<p>c</p>', level: 2 }, { title: 'Part Two', body: '<p>d</p>' }], cover: { data: S.coverPng(10, 15), mediaType: 'image/png' } });
  // make the NCX disagree, to prove the nav document wins in EPUB 3
  const files = unzipSync(bytes);
  files['OEBPS/toc.ncx'] = strToU8(strFromU8(files['OEBPS/toc.ncx']).replace('Part One', 'NCX label'));
  const ep = E.readEpub(zipSync({ mimetype: [strToU8('application/epub+zip'), { level: 0 }], ...Object.fromEntries(Object.entries(files).filter(([k]) => k !== 'mimetype')) }));
  assert.strictEqual(ep.version, '3.0');
  assert.deepStrictEqual(ep.meta.authors, ['Ann One', 'Bo Two']);
  assert.strictEqual(ep.meta.language, 'fr');
  assert.strictEqual(ep.toc[0].label, 'Part One');
  assert.deepStrictEqual(ep.toc[0].children.map((c) => c.label), ['One A', 'One B']);
  assert.strictEqual(ep.toc[1].label, 'Part Two');
  assert.strictEqual(ep.cover.path, 'OEBPS/images/cover.png');
});

test('damaged books: not a zip, no package file, missing chapters; a missing container is tolerated', () => {
  assert.throws(() => E.readEpub(new Uint8Array([1, 2, 3, 4])), /not a valid zip/);
  assert.throws(() => E.readEpub(zipSync({ mimetype: strToU8('application/epub+zip'), 'a.txt': strToU8('x') })), /no package file/);
  const files = unzipSync(S.makeEpub2({ chapters: 2 }));
  delete files['META-INF/container.xml'];
  delete files['OPS/text/ch2.xhtml'];
  const ep = E.readEpub(zipSync(files));
  assert.strictEqual(ep.spine.length, 2);
  assert.ok(ep.warnings.some((w) => /container/.test(w)) && ep.warnings.some((w) => /missing/.test(w)), ep.warnings.join(' | '));
});

test('hrefs: relative, encoded, fragments, never above the root of the zip', () => {
  assert.deepStrictEqual(E.resolveHref('OPS/text', '../images/a%20b.png#x'), { path: 'OPS/images/a b.png', frag: 'x' });
  assert.deepStrictEqual(E.resolveHref('', 'ch1.xhtml'), { path: 'ch1.xhtml', frag: '' });
  assert.strictEqual(E.resolveHref('OPS', '../../etc/passwd'), null);
  assert.strictEqual(E.resolveHref('OPS', 'https://example.org/x'), null);
  assert.strictEqual(E.relativeHref('OPS/package.opf', 'OPS/images/c d.png'), 'images/c%20d.png');
  assert.strictEqual(E.relativeHref('OPS/text/a.xhtml', 'OPS/images/c.png'), '../images/c.png');
});

// ---- writing ----------------------------------------------------------------------------------------------------------------
test('a written EPUB is valid: mimetype first and stored, manifest complete, spine ids valid, all XML well-formed', () => {
  const bytes = E.writeEpub({
    meta: { title: 'Tést & <Things> "quoted"', authors: ['Zoë Ünïcode'], language: 'de', publisher: 'P & Q', description: 'A <b>bold</b> claim', subjects: ['Sea'] },
    chapters: [{ title: 'Eins & zwei', body: '<h1>Eins</h1><p>Text<br/>more <img src="../images/a b.png" alt=""/></p>' }, { title: 'Drei', body: '<p>3</p>' }],
    images: [{ name: 'a b.png', data: S.makePng(4, 4), mediaType: 'image/png' }],
    cover: { data: S.coverPng(20, 30), mediaType: 'image/png' },
  });
  const { pkg, files } = validateEpub(bytes);
  assert.strictEqual(pkg.metadata['dc:title']['#text'], 'Tést & <Things> "quoted"');
  assert.ok(pkg.manifest.item.some((i) => i['@properties'] === 'cover-image'));
  const ncx = xml.parse(strFromU8(files['OEBPS/toc.ncx']));
  assert.strictEqual(ncx.ncx.head.meta.find((m) => m['@name'] === 'dtb:uid')['@content'], [].concat(pkg.metadata['dc:identifier'])[0]['#text'], 'NCX uid matches the identifier');
  assert.deepStrictEqual(ncx.ncx.navMap.navPoint.map((n) => n['@playOrder']), ['1', '2']);
  const back = E.readEpub(bytes);
  assert.deepStrictEqual(back.toc.map((t) => t.label), ['Eins & zwei', 'Drei']);
  assert.strictEqual(back.spine.length, 3, 'cover page + two chapters');
});

test('a book with no chapters or odd details still makes a valid EPUB', () => {
  validateEpub(E.writeEpub({ meta: { title: '', language: 'not a language!' }, chapters: [] }));
});

// ---- text --------------------------------------------------------------------------------------------------------------------
test('text chapters: "CHAPTER I" + title line, a contents list is not taken for chapters, start text kept', () => {
  const ch = T.splitChapters(S.sampleText(), { fallbackTitle: 'The Small Harbour' });
  assert.deepStrictEqual(ch.map((c) => c.title), ['The Small Harbour', 'CHAPTER I: The Arrival', 'CHAPTER II: Market Day', 'CHAPTER III: The Storm']);
  assert.match(ch[0].text, /^Title: The Small Harbour/);
  assert.match(ch[3].text, /THE END$/);
});

test('text chapters: many heading styles; sentences that mention chapters are not headings', () => {
  const t = 'Prologue\n\nOnce.\n\nChapter 1\n\nA.\n\nChapter Two: The Road\n\nB. He read chapter 3 of the book.\nChapter 3 was long, she said.\n\nPART III\n\nC.\n\nKapitel 4\n\nD.\n\nchapter twenty-one\n\nE.\n\nEpilogue\n\nF.';
  assert.deepStrictEqual(T.splitChapters(t).map((c) => c.title), ['Prologue', 'Chapter 1', 'Chapter Two: The Road', 'PART III', 'Kapitel 4', 'chapter twenty-one', 'Epilogue']);
  assert.ok(!T.isHeading('Chapter 3 was long, she said, and then she went on talking for quite a while about it all.'));
  assert.ok(T.isHeading('CHAPTER XIV. The Storm'));
  assert.ok(!T.isHeading('The chapter ends'));
});

test('text without chapters: short stays one chapter, long is cut into parts at paragraph breaks', () => {
  assert.deepStrictEqual(T.splitChapters('Just a note.\n\nTwo lines.').map((c) => c.title), ['Start']);
  const long = Array.from({ length: 400 }, (_v, i) => `Paragraph ${i} ` + 'word '.repeat(60)).join('\n\n');
  const parts = T.splitChapters(long, { partSize: 30000 });
  assert.ok(parts.length >= 3 && parts.every((p, i) => p.title === `Part ${i + 1}`), parts.map((p) => p.title).join());
  assert.strictEqual(parts.map((p) => p.text).join('\n\n'), long.trim(), 'nothing lost or changed');
});

test('text paragraphs: hard-wrapped prose is joined, verse keeps its lines, escaping, scene breaks', () => {
  const html = T.textToXhtml('A long line of prose that was wrapped at around sixty characters\nby an old editor, and it goes on to the next line like this\none.\n\nShort line\nanother <line> & more\n\n* * *\n\nEnd.');
  assert.strictEqual(html, '<p>A long line of prose that was wrapped at around sixty characters by an old editor, and it goes on to the next line like this one.</p>\n<p>Short line<br/>another &lt;line&gt; &amp; more</p>\n<hr/>\n<p>End.</p>');
  assert.strictEqual(XMLValidator.validate(`<div>${html}</div>`), true);
});

test('text decoding: UTF-8 (with and without BOM), UTF-16 LE and BE, Windows-1252', () => {
  assert.strictEqual(T.decodeText(Buffer.from('Café ☕')), 'Café ☕');
  assert.strictEqual(T.decodeText(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('Ünï')])), 'Ünï');
  assert.strictEqual(T.decodeText(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('Ünï', 'utf16le')])), 'Ünï');
  const be = Buffer.from('Ab', 'utf16le').swap16();
  assert.strictEqual(T.decodeText(Buffer.concat([Buffer.from([0xfe, 0xff]), be])), 'Ab');
  assert.strictEqual(T.decodeText(Buffer.from([0x43, 0x61, 0x66, 0xe9, 0x20, 0x93, 0x71, 0x94])), 'Café “q”');
});

// ---- details ------------------------------------------------------------------------------------------------------------------
test('details round trip (EPUB 3): change everything, read it back; the input bytes are not touched', () => {
  const original = E.writeEpub({ meta: { title: 'Old', authors: ['Old Author'], language: 'en', publisher: 'Old Pub', description: 'Old desc' }, chapters: [{ title: 'One', body: '<p>x</p>' }], cover: { data: S.coverPng(10, 15), mediaType: 'image/png' } });
  const copy = Buffer.from(original);
  const edited = E.editMetadata(original, { title: 'New & Better', authors: 'Ann Writer; Ben Helper', language: 'sv', publisher: '', description: 'Fresh words & more', cover: { data: S.coverPng(30, 45), mediaType: 'image/png' } });
  assert.ok(Buffer.from(original).equals(copy), 'input unchanged');
  validateEpub(edited);
  const ep = E.readEpub(edited);
  assert.deepStrictEqual({ title: ep.meta.title, authors: ep.meta.authors, language: ep.meta.language, publisher: ep.meta.publisher, description: ep.meta.description },
    { title: 'New & Better', authors: ['Ann Writer', 'Ben Helper'], language: 'sv', publisher: '', description: 'Fresh words & more' });
  assert.strictEqual(ep.cover.path, 'OEBPS/images/cover-new.png');
  assert.strictEqual(ep.manifest.size, E.readEpub(original).manifest.size + 1);
  assert.strictEqual([...ep.manifest.values()].filter((i) => i.properties.includes('cover-image')).length, 1, 'one cover-image');
  assert.match(strFromU8(ep.files['OEBPS/text/cover.xhtml']), /cover-new\.png/, 'the cover page shows the new cover');
  assert.strictEqual(strFromU8(ep.files['OEBPS/text/chapter-001.xhtml']), strFromU8(E.readEpub(original).files['OEBPS/text/chapter-001.xhtml']), 'chapters untouched');
  // a second round on the result
  const again = E.readEpub(E.editMetadata(edited, { title: 'Third' }));
  assert.strictEqual(again.meta.title, 'Third');
  assert.deepStrictEqual(again.meta.authors, ['Ann Writer', 'Ben Helper']);
});

test('details round trip (EPUB 2): opf:role authors, <meta name="cover">, svg cover page updated, other creators kept', () => {
  const src = S.makeEpub2({ chapters: 2 });
  const edited = E.editMetadata(src, { authors: ['New Person'], cover: { data: S.coverPng(8, 12), mediaType: 'image/png' } });
  const { pkg, files, opfPath } = validateEpub(edited, { epub3: false });
  const opf = strFromU8(files[opfPath]);
  assert.match(opf, /<dc:creator opf:role="aut">New Person<\/dc:creator>/);
  assert.match(opf, /opf:role="ill"/, 'the illustrator stays');
  assert.ok(!/properties=/.test(opf), 'no EPUB 3 attributes in an EPUB 2 package');
  assert.strictEqual(pkg.metadata.meta.filter((m) => m['@name'] === 'cover').length, 1);
  const ep = E.readEpub(edited);
  assert.deepStrictEqual(ep.meta.authors, ['New Person']);
  assert.strictEqual(ep.cover.path, 'OPS/images/cover-new.png');
  assert.match(strFromU8(ep.files['OPS/text/cover.xhtml']), /xlink:href="\.\.\/images\/cover-new\.png"/);
  assert.throws(() => E.editMetadata(src, { cover: { data: new Uint8Array([1, 2]), mediaType: 'image/tiff' } }), /JPEG, PNG/);
});

// ---- sanitiser ------------------------------------------------------------------------------------------------------------------
test('sanitiser strips scripts, handlers, forms, frames, styles and dangerous links; output is well-formed XHTML', () => {
  const bad = '<script>alert(1)</script><p onclick="x" style="color:red">Hi<img src="a.png" onerror="alert(2)"/><a href="javascript:alert(3)">j</a><a href=" JAVA&#09;SCRIPT:x">k</a><a href="data:text/html,x">d</a></p><iframe src="x"></iframe><object data="x"></object><embed src="x"><form action="y"><input name="q"><button>go</button></form><style>*{}</style><svg onload="alert(4)"><circle/></svg><math><mi>x</mi></math><noscript><p>ns</p></noscript><base href="http://evil/"><meta http-equiv="refresh" content="0"><link rel="stylesheet" href="http://evil/x.css"><video src="v.mp4"></video><p>end<br>open';
  const out = X.toXhtml(X.parseHtml(bad).children, { mapSrc: (s) => '../images/' + s });
  assert.ok(!/<script|<iframe|<object|<embed|<form|<input|<button|<style|<svg|<noscript|<base|<meta|<link|<video/i.test(out), out);
  assert.ok(!/\son\w+=/i.test(out) && !/style=/.test(out), out);
  assert.ok(!/href="\s*(javascript|data)/i.test(out), out);
  assert.match(out, /<img src="\.\.\/images\/a\.png" alt=""\/>/);
  assert.match(out, /x/, 'MathML text kept');
  assert.strictEqual(XMLValidator.validate(`<div>${out}</div>`), true, 'well-formed');
  // web links survive and are marked external; ids get a prefix when asked
  assert.strictEqual(X.toXhtml(X.parseHtml('<a href="https://example.org/a?b=1&c=2" id="x y">w</a>').children, { idPrefix: 'c1-' }), '<a href="https://example.org/a?b=1&amp;c=2" class="external" id="c1-xy">w</a>');
  // an svg-wrapped cover keeps only its picture
  assert.strictEqual(X.toXhtml(X.parseHtml('<svg><image xlink:href="c.jpg"/></svg>').children, { mapSrc: (s) => 'X/' + s }), '<img src="X/c.jpg" alt="" class="svg-image"/>');
  // characters XML does not allow are removed
  assert.strictEqual(X.toXhtml(X.parseHtml('<p>a\u0001b\u000bc</p>'.replace('\\u0001', String.fromCharCode(1)).replace('\\u000b', String.fromCharCode(11))).children), '<p>abc</p>');
});

// ---- conversions -------------------------------------------------------------------------------------------------------------------
test('EPUB -> book: the cover page is dropped (a new one is made), pictures and chapter links are kept, contents mapped', () => {
  const book = C.fromEpub(S.makeEpub2({ chapters: 3 }));
  assert.deepStrictEqual(book.chapters.map((c) => c.title), ['Chapter 1: Winter Light', 'Chapter 2: The Fog Bell', 'Chapter 3: Spring Tides']);
  assert.deepStrictEqual(book.images.map((i) => i.name), ['map-é-1.png']);
  assert.match(book.chapters[0].body, /<img src="\.\.\/images\/map-é-1\.png" alt="Map of the point"\/>/);
  assert.match(book.chapters[0].body, /<a href="chapter-002\.xhtml#note">the next note<\/a>/);
  assert.ok(!/script|onerror|onclick|<form|<iframe/i.test(book.chapters.map((c) => c.body).join('')), 'nothing active');
  assert.deepStrictEqual(book.toc.map((t) => [t.chapter, t.frag]), [[0, 'c1'], [1, 'c2'], [2, 'c3']]);
  assert.ok(book.cover && book.cover.mediaType === 'image/png');
});

test('EPUB -> EPUB, TXT, Markdown, HTML: content, pictures, links and details carried over', () => {
  const book = C.fromEpub(S.makeEpub2({ chapters: 3 }));
  const epub = C.toEpub(book);
  validateEpub(epub);
  const again = C.fromEpub(epub);
  assert.deepStrictEqual(again.chapters.map((c) => c.title), book.chapters.map((c) => c.title));
  assert.strictEqual(again.meta.title, book.meta.title);
  assert.strictEqual(again.images.length, 1);
  assert.match(again.chapters[0].body, /href="chapter-002\.xhtml#note"/, 'links survive a round trip');
  const txt = C.toText(book);
  assert.match(txt, /^The Lighthouse Keeper’s Almanac\nby Mara Invented\n/);
  assert.strictEqual((txt.match(/Chapter 2: The Fog Bell/g) || []).length, 1, 'chapter title written once');
  assert.match(txt, /\[Map of the point\]/);
  const { text: md, images } = C.toMarkdown(book, 'Almanac images');
  assert.match(md, /^---\ntitle: "The Lighthouse Keeper’s Almanac"\nauthor: "Mara Invented"\n/);
  assert.match(md, /\n# Chapter 1: Winter Light\n/);
  assert.match(md, /!\[Map of the point\]\(Almanac%20images\/map-%C3%A9-1\.png\)/);
  assert.match(md, /\[tide tables\]\(https:\/\/example\.org\/tides\)/);
  assert.strictEqual(images.length, 1);
  const html = C.toHtml(book);
  assert.match(html, /<img src="data:image\/png;base64,/);
  assert.match(html, /<a href="#c2-note">the next note<\/a>/, 'chapter links become in-page links');
  assert.match(html, /id="c2-note"/);
  assert.ok(!/<script/i.test(html));
});

test('Markdown -> EPUB: front matter details, chapters at # headings, local pictures only from its folder', () => {
  const md = '---\ntitle: Sea Notes\nauthor: Ann One & Bo Two\nlanguage: sv\n---\n\nIntro text.\n\n# First\n\nHello *there* ![pic](pics/p.png) ![out](../secret.png)\n\n# Second\n\n- a\n- b\n\n<script>bad()</script>\n';
  const asked = [];
  const book = C.fromMarkdown(Buffer.from(md), 'sea.md', (src) => { asked.push(src); return src === 'pics/p.png' ? S.makePng(3, 3) : null; });
  assert.deepStrictEqual(book.meta, { title: 'Sea Notes', authors: ['Ann One', 'Bo Two'], language: 'sv' });
  assert.deepStrictEqual(book.chapters.map((c) => c.title), ['Sea Notes', 'First', 'Second']);
  assert.deepStrictEqual(asked, ['pics/p.png', '../secret.png']);
  assert.match(book.chapters[1].body, /<img src="\.\.\/images\/p\.png" alt="pic"\/>/);
  assert.match(book.chapters[1].body, /<span class="missing-image">out<\/span>/);
  assert.ok(!/script/.test(book.chapters[2].body));
  validateEpub(C.toEpub(book));
});

test('HTML -> book: title, chapters at headings inside a wrapper, inline data pictures, SVG pictures refused', () => {
  const png = Buffer.from(S.makePng(2, 2)).toString('base64');
  const page = `<html lang="pt"><head><title>Page Book</title><meta name="author" content="Rita Made"></head><body><main><h2>One</h2><p>a <img src="data:image/png;base64,${png}" alt="dot"></p><h2>Two</h2><p>b <img src="data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=" alt="svg"></p></main></body></html>`;
  const book = C.fromHtml(Buffer.from(page), 'page.html', () => null);
  assert.deepStrictEqual(book.meta, { title: 'Page Book', authors: ['Rita Made'], language: 'pt' });
  assert.deepStrictEqual(book.chapters.map((c) => c.title), ['One', 'Two']);
  assert.strictEqual(book.images.length, 1);
  assert.match(book.chapters[1].body, /missing-image">svg</);
});

test('TXT -> EPUB end to end: details from "Title:" / "Author:" lines, valid book, chapters in the contents', () => {
  const book = C.fromText(Buffer.from(S.sampleText()), 'harbour.txt');
  assert.deepStrictEqual(book.meta, { title: 'The Small Harbour', authors: ['Ada Invented'], language: 'en' });
  const bytes = C.toEpub(book);
  validateEpub(bytes);
  assert.deepStrictEqual(E.readEpub(bytes).toc.map((t) => t.label), ['The Small Harbour', 'CHAPTER I: The Arrival', 'CHAPTER II: Market Day', 'CHAPTER III: The Storm']);
});

test('a large text book (5 MB, 200 chapters) converts in reasonable time', () => {
  const big = Array.from({ length: 200 }, (_v, i) => `\nChapter ${i + 1}\n\n` + Array.from({ length: 40 }, () => 'The wind kept on blowing over the dunes and the grass bent low. '.repeat(10)).join('\n\n')).join('\n');
  const t0 = Date.now();
  const book = C.fromText(Buffer.from(big), 'big.txt');
  const bytes = C.toEpub(book);
  const ms = Date.now() - t0;
  assert.strictEqual(book.chapters.length, 200);
  assert.ok(E.readEpub(bytes).spine.length === 200 && ms < 20000, `${ms} ms`);
});

test('the window pages have a strict Content-Security-Policy and the reading frame runs no scripts', () => {
  const fs = require('fs'); const path = require('path');
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'index.html'), 'utf8');
  const csp = /Content-Security-Policy" content="([^"]+)"/.exec(html)[1];
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /script-src 'self';/);
  assert.ok(!/unsafe|https?:/.test(csp), csp);
  assert.match(html, /<iframe id="frame"[^>]*sandbox="allow-same-origin"/);
  assert.ok(!/allow-scripts/.test(html));
});

(async () => {
  let failed = 0;
  for (const [name, fn] of tests) {
    const t0 = Date.now();
    try { await fn(); console.log(`ok   ${name} (${Date.now() - t0} ms)`); }
    catch (e) { failed++; console.log(`FAIL ${name}\n     ${String((e && e.stack) || e).split('\n').slice(0, 6).join('\n     ')}`); }
  }
  console.log(failed ? `\n${failed} of ${tests.length} failed` : `\nall ${tests.length} passed`);
  process.exit(failed ? 1 : 0);
})();
