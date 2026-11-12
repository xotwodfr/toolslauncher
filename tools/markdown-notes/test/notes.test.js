'use strict';
// Markdown Notes core tests: front matter and tags, wiki links, the search index, file names, the sanitiser, the renderer,
// and the HTML / DOCX exports (the Word file is unzipped and its XML checked with an independent parser).
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { unzipSync, strFromU8 } = require('fflate');
const { XMLValidator } = require('fast-xml-parser');
const M = require('../src/meta');
const R = require('../src/markdown');
const X = require('../src/export');
const { sanitize } = require('../src/sanitize');
const { NoteIndex, fold } = require('../src/search');
const { makePng } = require('../src/testpng');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'markdown-notes-test-'));
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

// ---- front matter and tags ------------------------------------------------------------------------------------------------
test('front matter: scalars, inline lists, block lists, quotes, comments; body and body line', () => {
  const t = '---\ntitle: "My: note"\ndate: 2026-11-10\ncount: 3\ndraft: false\ntags: [work, "big plans", \'x\']\naliases:\n  - one\n  - two\n# a comment\n---\n# Body\ntext';
  const fm = M.parseFrontMatter(t);
  assert.strictEqual(fm.data.title, 'My: note');
  assert.strictEqual(fm.data.date, '2026-11-10');
  assert.strictEqual(fm.data.count, 3);
  assert.strictEqual(fm.data.draft, false);
  assert.deepStrictEqual(fm.data.tags, ['work', 'big plans', 'x']);
  assert.deepStrictEqual(fm.data.aliases, ['one', 'two']);
  assert.strictEqual(fm.body, '# Body\ntext');
  assert.strictEqual(fm.bodyLine, 11);
  assert.strictEqual(M.parseFrontMatter('no front matter\n---\n').hasFrontMatter, false);
  assert.strictEqual(M.parseFrontMatter('﻿---\na: 1\n---\nx'.replace('\\uFEFF', String.fromCharCode(0xfeff))).data.a, 1);
  assert.strictEqual(M.parseFrontMatter('---\r\na: b\r\n---\r\nbody').body, 'body', 'Windows line ends');
});

test('tags: #tags in text and front matter, not in code, headings, URLs or plain numbers; nested tags; unicode', () => {
  const t = '---\ntags: [Work, project/alpha]\n---\n# Heading #notatag?\n\nText #idea, (#Café) and #2026 and #a-b_c/d.\nmail me#nope https://x.org/#anchor\n\n```\n#incode\n```\n`#inline` ## Also heading\n';
  assert.deepStrictEqual(M.extractTags(t), ['a-b_c/d', 'café', 'idea', 'notatag', 'project/alpha', 'work']);
  assert.deepStrictEqual(M.extractTags('---\ntags: one, two\n---\n'), ['one', 'two']);
  assert.deepStrictEqual(M.extractTags('---\ntags:\n  - "#hashed"\n  - plain\n---\n'), ['hashed', 'plain']);
});

test('title (front matter, first heading, file name) and word count', () => {
  assert.strictEqual(M.noteTitle('---\ntitle: From FM\n---\n# H', 'f.md'), 'From FM');
  assert.strictEqual(M.noteTitle('text\n# First heading ##\n# Second', 'f.md'), 'First heading');
  assert.strictEqual(M.noteTitle('```\n# not this\n```\nplain', 'File name.md'), 'File name');
  assert.strictEqual(M.wordCount('---\ntitle: a b c\n---\n# Two words\n\nThree more words, [link text](http://x) ![alt](y.png).'), 7);
  assert.strictEqual(M.wordCount('日本語 text'), 4);
  assert.strictEqual(M.wordCount(''), 0);
});

// ---- wiki links -------------------------------------------------------------------------------------------------------------
test('wiki links: extraction with heading and label, ignoring code', () => {
  const links = M.extractWikiLinks('See [[Note A]], [[Folder/Note B#Part 2|label]], [[#Local]] and `[[not]]`.\n```\n[[nope]]\n```');
  assert.deepStrictEqual(links, [{ target: 'Note A', heading: '', label: '' }, { target: 'Folder/Note B', heading: 'Part 2', label: 'label' }]);
});

test('wiki link resolution: by name, case-insensitive, nearest folder wins, paths, missing', () => {
  const all = ['Inbox.md', 'Projects/Plan.md', 'Archive/Plan.md', 'Projects/Sub/Deep.md', 'Café.md', 'Archive/2025/Plan.md'];
  assert.strictEqual(M.resolveWikiLink('inbox', 'Projects/Plan.md', all), 'Inbox.md');
  assert.strictEqual(M.resolveWikiLink('Plan', 'Projects/Sub/Deep.md', all), 'Projects/Plan.md', 'parent folder is nearer');
  assert.strictEqual(M.resolveWikiLink('Plan', 'Archive/2025/Plan.md', all), 'Archive/2025/Plan.md', 'same folder first');
  assert.strictEqual(M.resolveWikiLink('Plan', 'Inbox.md', all), 'Archive/Plan.md', 'then shortest path, then alphabetical');
  assert.strictEqual(M.resolveWikiLink('Archive/Plan', 'Inbox.md', all), 'Archive/Plan.md');
  assert.strictEqual(M.resolveWikiLink('2025/plan.md', 'Inbox.md', all), 'Archive/2025/Plan.md');
  assert.strictEqual(M.resolveWikiLink('Café'.replace('\\u0301', String.fromCharCode(0x301)), null, all), 'Café.md', 'unicode normal forms');
  assert.strictEqual(M.resolveWikiLink('Nope', 'Inbox.md', all), null);
  assert.strictEqual(M.resolveWikiLink('  ', 'Inbox.md', all), null);
  assert.strictEqual(M.newNotePathFor('New idea', 'Projects/Plan.md'), 'Projects/New idea.md');
  assert.strictEqual(M.newNotePathFor('Ideas/Big: one?', 'Projects/Plan.md'), 'Ideas/Big one.md');
  assert.strictEqual(M.newNotePathFor('Top', null), 'Top.md');
  assert.strictEqual(M.newNotePathFor('../escape', 'a.md'), 'escape.md', 'no climbing out');
});

// ---- search index -------------------------------------------------------------------------------------------------------------
test('search index: add, search (prefix, accents, phrase, tags), update, remove, rename note and folder', () => {
  const ix = new NoteIndex();
  ix.set('Garden.md', '# Garden plan\n\nPlant tomatoes in spring. #outdoors/garden');
  ix.set('Kitchen/Recipes.md', '# Recipes\n\nCrème brûlée and tomato soup. #food');
  ix.set('Kitchen/Shopping.md', '# Shopping\n\nTomatoes, bread.\n\nSee [[Recipes]]');
  assert.strictEqual(ix.size, 3);
  assert.deepStrictEqual(ix.search('tomat').map((r) => r.rel).sort(), ['Garden.md', 'Kitchen/Recipes.md', 'Kitchen/Shopping.md'], 'prefix');
  assert.deepStrictEqual(ix.search('creme brulee').map((r) => r.rel), ['Kitchen/Recipes.md'], 'accents folded');
  assert.deepStrictEqual(ix.search('"tomato soup"').map((r) => r.rel), ['Kitchen/Recipes.md'], 'phrase');
  assert.deepStrictEqual(ix.search('#outdoors').map((r) => r.rel), ['Garden.md'], 'parent tag matches child tag');
  assert.deepStrictEqual(ix.search('tomatoes', { tag: 'food' }).map((r) => r.rel), [], 'tag option filters');
  assert.strictEqual(ix.search('recipes')[0].rel, 'Kitchen/Recipes.md', 'title hits rank first');
  assert.match(ix.search('brulee')[0].snippet, /brûlée/);
  assert.deepStrictEqual(ix.search(''), []);
  assert.deepStrictEqual(ix.tags(), [{ tag: 'food', count: 1 }, { tag: 'outdoors/garden', count: 1 }]);
  assert.deepStrictEqual(ix.backlinks('Kitchen/Recipes.md'), ['Kitchen/Shopping.md']);
  // update: old words gone, new words found
  ix.set('Garden.md', '# Garden plan\n\nPlant potatoes instead.');
  assert.deepStrictEqual(ix.search('tomatoes').map((r) => r.rel).sort(), ['Kitchen/Shopping.md']);
  assert.deepStrictEqual(ix.search('potatoes').map((r) => r.rel), ['Garden.md']);
  assert.ok(!ix.words.has('outdoors'), 'stale words removed from the inverted index');
  // rename a note, then a folder
  ix.rename('Garden.md', 'Outside/Garden.md');
  assert.deepStrictEqual(ix.search('potatoes').map((r) => r.rel), ['Outside/Garden.md']);
  const moves = ix.rename('Kitchen', 'Food');
  assert.strictEqual(moves.length, 2);
  assert.deepStrictEqual(ix.paths().sort(), ['Food/Recipes.md', 'Food/Shopping.md', 'Outside/Garden.md']);
  assert.deepStrictEqual(ix.search('bread').map((r) => r.rel), ['Food/Shopping.md']);
  // remove
  assert.strictEqual(ix.remove('Food/Shopping.md'), true);
  assert.strictEqual(ix.remove('Food/Shopping.md'), false);
  assert.deepStrictEqual(ix.search('bread'), []);
  assert.ok(!ix.words.has('bread'));
  assert.strictEqual(fold('Ærøskøbing CAFÉ'), 'ærøskøbing cafe');
});

test('search index: 3000 notes index and search quickly', () => {
  const ix = new NoteIndex();
  const t0 = Date.now();
  for (let i = 0; i < 3000; i++) ix.set(`n/${i}.md`, `# Note ${i}\n\n${'lorem ipsum dolor sit amet '.repeat(40)} word${i} #t${i % 10}`);
  const built = Date.now() - t0;
  const t1 = Date.now();
  assert.strictEqual(ix.search('word2999').length, 1);
  assert.strictEqual(ix.search('#t3', { limit: 1000 }).length, 300);
  assert.strictEqual(ix.search('lorem dolor', { limit: 5 }).length, 5);
  const searched = Date.now() - t1;
  assert.ok(built < 6000 && searched < 1500, `built in ${built} ms, searched in ${searched} ms`);
});

// ---- names and attachments ------------------------------------------------------------------------------------------------------
test('names: unsafe characters, reserved Windows names, unique names', () => {
  assert.strictEqual(M.safeName('a/b\\c:d*?"<>|'), 'a b c d');
  assert.strictEqual(M.safeName('  trailing dots... '), 'trailing dots');
  assert.strictEqual(M.safeName('CON'), '');
  assert.strictEqual(M.safeName('.hidden'), 'hidden');
  assert.match(M.nameProblem('a:b'), /cannot contain/);
  assert.match(M.nameProblem('nul'), /reserves/);
  assert.match(M.nameProblem('x.'), /end with a dot/);
  assert.strictEqual(M.nameProblem('Grocery list ✓'), '');
  const taken = new Set(['a.md', 'a (2).md']);
  assert.strictEqual(M.uniqueName('a.md', (n) => taken.has(n)), 'a (3).md');
  assert.strictEqual(M.uniqueName('b.md', (n) => taken.has(n)), 'b.md');
});

test('attachments: type sniffed from bytes, names for pasted and dropped pictures, encoded relative links', () => {
  assert.strictEqual(M.sniffImage(makePng(2, 2)), 'png');
  assert.strictEqual(M.sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0])), 'jpg');
  assert.strictEqual(M.sniffImage(Buffer.from('GIF89a......')), 'gif');
  assert.strictEqual(M.sniffImage(Buffer.from('<svg onload="x">')), null, 'SVG (could carry script) is refused');
  assert.strictEqual(M.sniffImage(Buffer.from('hello')), null);
  const now = new Date(2026, 10, 10, 9, 5, 7);
  assert.strictEqual(M.attachmentName({ ext: 'png', now }), 'Pasted image 2026-11-10 09-05-07.png');
  const taken = new Set(['Pasted image 2026-11-10 09-05-07.png']);
  assert.strictEqual(M.attachmentName({ ext: 'png', now, exists: (n) => taken.has(n) }), 'Pasted image 2026-11-10 09-05-07 (2).png');
  assert.strictEqual(M.attachmentName({ originalName: 'Holiday: beach?.JPEG', ext: 'jpeg' }), 'Holiday beach.jpg', 'dropped file keeps its (safe) name, real extension');
  assert.strictEqual(M.attachmentName({ originalName: 'photo.png', ext: 'webp' }), 'photo.webp', 'extension follows the real type');
  assert.strictEqual(M.attachmentLink('attachments/My photo #1.png', 'My photo'), '![My photo](attachments/My%20photo%20%231.png)');
  assert.strictEqual(M.attachmentLink('attachments/日本.png', 'a]b'), '![a b](attachments/%E6%97%A5%E6%9C%AC.png)');
});

test('task toggling keeps the rest of the text and the line ends', () => {
  assert.strictEqual(M.toggleTask('a\n- [ ] one\n- [x] two', 1), 'a\n- [x] one\n- [x] two');
  assert.strictEqual(M.toggleTask('a\r\n  * [X] one', 1), 'a\r\n  * [ ] one');
  assert.strictEqual(M.toggleTask('1. [ ] numbered', 0), '1. [x] numbered');
  assert.strictEqual(M.toggleTask('not a task', 0), null);
  assert.strictEqual(M.toggleTask('x', 5), null);
});

// ---- sanitiser ---------------------------------------------------------------------------------------------------------------------
test('sanitiser blocks scripts, event handlers, javascript: and other dangerous URLs, and remote pictures', () => {
  const cases = [
    '<script>alert(1)</script>', '<img src=x onerror=alert(1)>', '<IMG SRC="jav&#x09;ascript:alert(1)">', '<a href="javascript:alert(1)">x</a>',
    '<a href=" JaVaScRiPt:alert(1)">x</a>', '<a href="java\nscript:alert(1)">x</a>', '<a href="&#106;avascript:alert(1)">x</a>', '<a href="vbscript:x">x</a>',
    '<a href="data:text/html,<script>alert(1)</script>">x</a>', '<svg onload=alert(1)><circle/></svg>', '<iframe src="https://x"></iframe>', '<object data=x></object>',
    '<embed src=x>', '<form action=x><input name=a></form>', '<style>@import "x"</style>', '<link rel=stylesheet href=x>', '<meta http-equiv=refresh content="0;url=x">',
    '<base href="https://evil/">', '<div style="background:url(javascript:alert(1))">s</div>', '<math><mtext><table><mglyph><style><img src=x onerror=alert(1)>',
    '<noscript><p title="</noscript><img src=x onerror=alert(1)>">', '<p onmouseover="alert(1)">hover</p>', '<details open ontoggle=alert(1)>', '<a href="//evil.com/x">p</a>',
    '<img src="https://tracker.example/pixel.gif">', '<img srcset="x 1x" src="data:image/svg+xml;base64,PHN2Zz4=">', '<a href="file:///etc/passwd">f</a>',
  ];
  for (const c of cases) {
    const out = sanitize(c, { mapImage: (s) => 'notefile://root/' + s });
    assert.ok(!/<script|<iframe|<object|<embed|<form|<style|<link|<meta|<base|<svg|<math/i.test(out), `${c} -> ${out}`);
    assert.ok(!/\son[a-z]+\s*=/i.test(out), `event handler survived: ${c} -> ${out}`);
    assert.ok(!/(href|src)="\s*(javascript|vbscript|data:text|file:|https?:|\/\/)/i.test(out), `bad URL survived: ${c} -> ${out}`);
    assert.ok(!/style="/.test(out), `style survived: ${c} -> ${out}`);
  }
  // good things survive
  assert.strictEqual(sanitize('<a href="https://example.org/a?b=1&amp;c=2">ok</a>'), '<a href="https://example.org/a?b=1&amp;c=2" rel="noopener noreferrer">ok</a>');
  assert.strictEqual(sanitize('<details><summary>More</summary><p>x</p></details>'), '<details><summary>More</summary><p>x</p></details>');
  assert.strictEqual(sanitize('<kbd>Ctrl</kbd> <mark>hi</mark> <sub>2</sub>'), '<kbd>Ctrl</kbd> <mark>hi</mark> <sub>2</sub>');
  assert.strictEqual(sanitize('<td style="text-align: center">c</td>'), '<td style="text-align:center">c</td>');
  assert.strictEqual(sanitize('a < b & "c"'), 'a &lt; b &amp; "c"');
  assert.strictEqual(sanitize('<img src="attachments/a.png" alt="A">', { mapImage: (s) => 'notefile://root/' + s }), '<img src="notefile://root/attachments/a.png" alt="A">');
  assert.match(sanitize('<img src="https://x/y.png" alt="remote">'), /class="blocked-img"[^>]*>remote</);
  assert.match(sanitize('<img src="gone.png" alt="g">', { mapImage: () => null }), /Picture not found/);
  assert.strictEqual(sanitize('<input type="text" value="x"><input type="checkbox" checked onclick="x">'), '<input type="checkbox" checked>');
});

// ---- renderer --------------------------------------------------------------------------------------------------------------------
test('renderer: headings with ids, tables, footnotes, highlighted code, task lists with source lines, wiki links, tags, front matter', () => {
  const md = '---\ntags: [demo]\n---\n# Hello World\n\n## Hello World\n\n| a | b |\n|:-:|--:|\n| 1 | 2 |\n\nText[^n] #inline-tag and [[Other]] / [[Missing|shown]].\n\n[^n]: The note.\n\n```js\nconst x = 1;\n```\n\n- [ ] open\n- [x] done\n\n~~gone~~ <kbd>K</kbd>\n';
  const html = R.render(md, { resolveWiki: (t) => t === 'Other' });
  assert.match(html, /<h1 data-line="3" id="hello-world">Hello World<\/h1>/);
  assert.match(html, /<h2 data-line="5" id="hello-world-1">/, 'unique ids');
  assert.match(html, /<th style="text-align:center">a<\/th>/);
  assert.match(html, /<section class="footnotes">/);
  assert.match(html, /<span class="hljs-keyword">const<\/span>/);
  assert.match(html, /<input type="checkbox" class="task" data-line="19">open/);
  assert.match(html, /<input type="checkbox" class="task" data-line="20" checked>done/);
  assert.match(html, /<a href="#" class="wikilink" data-wiki="Other"/);
  assert.match(html, /<a href="#" class="wikilink missing" data-wiki="Missing"[^>]*>shown<\/a>/);
  assert.match(html, /<a href="#" class="tag" data-tag="inline-tag">#inline-tag<\/a>/);
  assert.match(html, /<table class="frontmatter">.*#demo/);
  assert.match(html, /<s>gone<\/s> <kbd>K<\/kbd>/);
  assert.strictEqual(R.slugify('Ça va? Ünïcode — ok!'), 'ça-va-ünïcode-ok');
});

test('renderer: a 2 MB note renders in reasonable time', () => {
  const big = Array.from({ length: 20000 }, (_v, i) => `## Section ${i}\n\nSome *text* with a [link](https://example.org/${i}) and \`code\`.\n`).join('\n');
  const t0 = Date.now();
  const html = R.render(big);
  const ms = Date.now() - t0;
  assert.ok(html.length > big.length && ms < 8000, `${ms} ms`);
});

// ---- exports -----------------------------------------------------------------------------------------------------------------------
const NOTE = '---\ntitle: Trip notes\n---\n# Trip notes\n\nA **bold** start, some *italic*, `code` and a [link](https://example.org).\n\n## Packing list\n\n- passport\n  - copies\n- charger\n\n1. book\n2. go\n\n- [x] tickets\n\n> A quote.\n\n| Day | Place |\n|-----|------:|\n| 1 | Lisbon |\n| 2 | Porto |\n\n```python\nprint("hi")\n```\n\n![map](attachments/map%20one.png)\n\nWith a footnote.[^1]\n\n---\n\n[^1]: Footnote text.\n';

test('HTML export: one self-contained page (picture inlined, no scripts, no app-only links), with a strict CSP', () => {
  const png = makePng(4, 3);
  const asked = [];
  const html = X.noteToHtml(NOTE + '\n[[Elsewhere]] #travel <script>alert(1)</script>\n', { title: 'Trip notes', readImage: (src) => { asked.push(src); return { data: png, ext: 'png' }; } });
  assert.deepStrictEqual(asked, ['attachments/map%20one.png']);
  assert.match(html, /^<!doctype html>/);
  assert.match(html, /<title>Trip notes<\/title>/);
  assert.match(html, /<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'">/);
  assert.match(html, /<img src="data:image\/png;base64,[A-Za-z0-9+/=]+" alt="map">/);
  assert.match(html, /<h2 data-line="\d+" id="packing-list">Packing list<\/h2>/);
  assert.match(html, /<span class="wikilink[^"]*">Elsewhere<\/span>/);
  assert.match(html, /<span class="tag">#travel<\/span>/);
  assert.ok(!/<script/i.test(html) && !/notefile:/.test(html), 'no script, no app protocol');
  assert.match(html, /class="task" disabled/);
  assert.match(html, /\.hljs/, 'code colours included');
  fs.writeFileSync(path.join(tmp, 'trip.html'), html);
});

test('DOCX export: a zip whose document.xml (well-formed) has the headings, runs, lists, table, picture, link and footnote', async () => {
  const png = makePng(40, 20);
  const { buffer, stats } = await X.noteToDocx(NOTE, { title: 'Trip notes', readImage: () => ({ data: png, ext: 'png' }) });
  assert.strictEqual(buffer.slice(0, 2).toString(), 'PK');
  const z = unzipSync(new Uint8Array(buffer));
  for (const part of ['[Content_Types].xml', 'word/document.xml', 'word/numbering.xml', 'word/footnotes.xml', 'word/_rels/document.xml.rels']) assert.ok(z[part], 'has ' + part);
  const xml = strFromU8(z['word/document.xml']);
  for (const [name, data] of Object.entries(z)) if (/\.(xml|rels)$/.test(name)) assert.strictEqual(XMLValidator.validate(strFromU8(data)), true, name + ' is well-formed XML');
  assert.deepStrictEqual(stats.headings, ['Trip notes', 'Packing list']);
  assert.match(xml, /<w:pStyle w:val="Heading1"\/>[\s\S]*?Trip notes/);
  assert.match(xml, /<w:pStyle w:val="Heading2"\/>[\s\S]*?Packing list/);
  assert.match(xml, /<w:b\/>[\s\S]*?bold/);
  assert.match(xml, /<w:i\/>[\s\S]*?italic/);
  assert.match(xml, /Consolas[\s\S]*?code/);
  assert.match(xml, /<w:numPr><w:ilvl w:val="1"\/>/, 'nested list level');
  assert.match(xml, /<w:tbl>[\s\S]*Lisbon[\s\S]*<\/w:tbl>/);
  assert.match(xml, /<w:hyperlink [^>]*r:id=/);
  assert.match(strFromU8(z['word/_rels/document.xml.rels']), /https:\/\/example\.org/);
  assert.match(xml, /☑ /, 'ticked task');
  assert.match(xml, /<w:footnoteReference w:id="1"\/>/);
  assert.match(strFromU8(z['word/footnotes.xml']), /Footnote text/);
  assert.match(xml, /print\(&quot;hi&quot;\)|print\("hi"\)/);
  const media = Object.keys(z).filter((k) => k.startsWith('word/media/'));
  assert.strictEqual(media.length, 1);
  assert.strictEqual(stats.images, 1);
  assert.match(xml, /<wp:extent cx="381000" cy="190500"\/>/, '40x20 px picture at 96 dpi');
  fs.writeFileSync(path.join(tmp, 'trip.docx'), buffer);
});

test('DOCX export: a picture that is missing or of a type Word cannot show becomes its alt text', async () => {
  const { buffer, stats } = await X.noteToDocx('# T\n\n![gone](nope.png) ![webp](x.webp) ![remote](https://x/y.png)', { readImage: (src) => (src === 'x.webp' ? { data: Buffer.from('RIFF0000WEBPVP8 '), ext: 'webp' } : null) });
  const xml = strFromU8(unzipSync(new Uint8Array(buffer))['word/document.xml']);
  assert.match(xml, /\[gone\][\s\S]*\[webp\][\s\S]*\[remote\]/);
  assert.strictEqual(stats.images, 0);
});

test('image sizes from headers: PNG, GIF, JPEG, BMP', () => {
  assert.deepStrictEqual(X.imageSize(makePng(7, 5)), { w: 7, h: 5 });
  const gif = Buffer.from('474946383961' + '0a00' + '0600', 'hex');
  assert.deepStrictEqual(X.imageSize(Buffer.concat([gif, Buffer.alloc(10)])), { w: 10, h: 6 });
  const jpg = Buffer.from('ffd8ffe000104a46494600010100000100010000ffc0001108002000400301110002110103110100', 'hex');
  assert.deepStrictEqual(X.imageSize(jpg), { w: 64, h: 32 });
  const bmp = Buffer.alloc(30); bmp.write('BM'); bmp.writeInt32LE(9, 18); bmp.writeInt32LE(-4, 22);
  assert.deepStrictEqual(X.imageSize(bmp), { w: 9, h: 4 });
  assert.strictEqual(X.imageSize(Buffer.from('nope')), null);
});

test('image reader for exports stays inside the notes folder', () => {
  const root = path.join(tmp, 'root');
  fs.mkdirSync(path.join(root, 'n', 'attachments'), { recursive: true });
  fs.writeFileSync(path.join(root, 'n', 'attachments', 'a b.png'), makePng(2, 2));
  fs.writeFileSync(path.join(tmp, 'outside.png'), makePng(2, 2));
  fs.writeFileSync(path.join(root, 'n', 'fake.png'), 'not a picture');
  const read = X.imageReader(root, path.join(root, 'n', 'note.md'));
  assert.strictEqual(read('attachments/a%20b.png').ext, 'png');
  assert.strictEqual(read('../../outside.png'), null, 'outside the folder');
  assert.strictEqual(read('fake.png'), null, 'not really a picture');
  assert.strictEqual(read('missing.png'), null);
});

test('the renderer page has a strict Content-Security-Policy and the editor bundle is present', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'index.html'), 'utf8');
  const csp = /Content-Security-Policy" content="([^"]+)"/.exec(html)[1];
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /script-src 'self'(;|$)/);
  assert.ok(!/unsafe-inline|unsafe-eval|https?:/.test(csp), csp);
  assert.ok(fs.statSync(path.join(__dirname, '..', 'src', 'renderer', 'vendor', 'editor.js')).size > 100000);
});

(async () => {
  let failed = 0;
  for (const [name, fn] of tests) {
    const t0 = Date.now();
    try { await fn(); console.log(`ok   ${name} (${Date.now() - t0} ms)`); }
    catch (e) { failed++; console.log(`FAIL ${name}\n     ${String((e && e.stack) || e).split('\n').slice(0, 6).join('\n     ')}`); }
  }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  console.log(failed ? `\n${failed} of ${tests.length} failed` : `\nall ${tests.length} passed`);
  process.exit(failed ? 1 : 0);
})();
