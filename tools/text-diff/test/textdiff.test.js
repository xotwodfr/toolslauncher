'use strict';
// Text & File Diff core tests: the line diff on known cases (checked against the `diff` package for minimality), word and
// character highlights, the ignore options, patches that apply back with the `diff` package's applyPatch, the merge,
// encoding detection, safe writing, and folder comparison / copying on a generated tree.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const JsDiff = require('diff');
const T = require('../src/core/textdiff');
const E = require('../src/core/encoding');
const F = require('../src/core/files');
const D = require('../src/core/folders');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'textdiff-test-'));
const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const sp = (s) => T.splitLines(s);
const diff = (a, b, o) => T.diffLines(sp(a), sp(b), o);
const changedLines = (r) => r.blocks.filter((b) => b.type === 'change').reduce((n, b) => n + (b.aEnd - b.aStart) + (b.bEnd - b.bStart), 0);
/** Rebuild both texts from the blocks: proves the blocks cover every line, in order. */
function checkCover(a, b, r) {
  let ai = 0; let bi = 0;
  for (const blk of r.blocks) {
    assert.strictEqual(blk.aStart, ai, 'a continuous'); assert.strictEqual(blk.bStart, bi, 'b continuous');
    if (blk.type === 'equal') assert.strictEqual(blk.aEnd - blk.aStart, blk.bEnd - blk.bStart, 'equal blocks have the same length');
    ai = blk.aEnd; bi = blk.bEnd;
  }
  assert.strictEqual(ai, a.lines.length); assert.strictEqual(bi, b.lines.length);
}
let seed = 12345;
const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };

// ---- lines ---------------------------------------------------------------------------------------------------------------
test('splitLines keeps every kind of line ending and a missing last one', () => {
  const s = sp('a\r\nb\nc\rd');
  assert.deepStrictEqual(s.lines, ['a', 'b', 'c', 'd']);
  assert.deepStrictEqual(s.eols, ['\r\n', '\n', '\r', '']);
  assert.deepStrictEqual(sp('').lines, []);
  assert.deepStrictEqual(sp('\n').lines, ['']);
  assert.deepStrictEqual(sp('x\n').eols, ['\n']);
  assert.strictEqual(T.lineEndingOf(sp('a\r\nb\r\n')), 'CRLF');
  assert.strictEqual(T.lineEndingOf(sp('a\nb')), 'LF');
  assert.strictEqual(T.lineEndingOf(sp('a\rb\r')), 'CR');
  assert.strictEqual(T.lineEndingOf(sp('a\nb\r\n')), 'Mixed');
  assert.strictEqual(T.lineEndingOf(sp('one line')), 'None');
});

// ---- the line diff -----------------------------------------------------------------------------------------------------------
test('known cases: identical, empty sides, one change, add at start and end', () => {
  let r = diff('a\nb\nc\n', 'a\nb\nc\n');
  assert.deepStrictEqual(r.blocks, [{ type: 'equal', aStart: 0, aEnd: 3, bStart: 0, bEnd: 3 }]);
  assert.strictEqual(r.stats.changes, 0);
  r = diff('', 'x\ny\n');
  assert.deepStrictEqual(r.blocks, [{ type: 'change', aStart: 0, aEnd: 0, bStart: 0, bEnd: 2 }]);
  assert.deepStrictEqual(r.stats, { changes: 1, added: 2, removed: 0, modified: 0, same: 0 });
  r = diff('x\ny\n', '');
  assert.deepStrictEqual(r.stats, { changes: 1, added: 0, removed: 2, modified: 0, same: 0 });
  r = diff('a\nb\nc\n', 'a\nB\nc\n');
  assert.deepStrictEqual(r.blocks.map((b) => b.type), ['equal', 'change', 'equal']);
  assert.deepStrictEqual(r.blocks[1], { type: 'change', aStart: 1, aEnd: 2, bStart: 1, bEnd: 2 });
  assert.deepStrictEqual(r.stats, { changes: 1, added: 0, removed: 0, modified: 1, same: 2 });
  r = diff('b\nc\n', 'a\nb\nc\nd\n');
  assert.deepStrictEqual(r.blocks.map((b) => [b.type, b.aStart, b.aEnd, b.bStart, b.bEnd]), [['change', 0, 0, 0, 1], ['equal', 0, 2, 1, 3], ['change', 2, 2, 3, 4]]);
});

test('the classic ABCABBA / CBABAC example has the minimal 5 edits', () => {
  const a = 'A\nB\nC\nA\nB\nB\nA\n'; const b = 'C\nB\nA\nB\nA\nC\n';
  const r = diff(a, b);
  checkCover(sp(a), sp(b), r);
  assert.strictEqual(changedLines(r), 5);
});

test('Myers is minimal: random texts give as few changed lines as the diff package', () => {
  for (let round = 0; round < 60; round++) {
    const n = 5 + Math.floor(rand() * 60);
    const alpha = 2 + Math.floor(rand() * 6);
    const a = Array.from({ length: n }, () => 'l' + Math.floor(rand() * alpha));
    const b = a.filter(() => rand() > 0.2).map((x) => (rand() < 0.15 ? 'l' + Math.floor(rand() * alpha) : x));
    for (let i = 0; i < 5; i++) if (rand() < 0.5) b.splice(Math.floor(rand() * b.length), 0, 'n' + i);
    const ta = a.join('\n') + '\n'; const tb = b.join('\n') + '\n';
    const r = diff(ta, tb);
    checkCover(sp(ta), sp(tb), r);
    const ref = JsDiff.diffArrays(a, b).filter((p) => p.added || p.removed).reduce((s, p) => s + p.count, 0);
    assert.strictEqual(changedLines(r), ref, `round ${round}`);
    // patience is never better than minimal, but must still cover both texts correctly
    const p = diff(ta, tb, { algorithm: 'patience' });
    checkCover(sp(ta), sp(tb), p);
    assert(changedLines(p) >= ref);
  }
});

test('patience keeps unique lines (function headers) lined up where Myers may match braces', () => {
  const a = ['int a() {', '  return 1;', '}', '', 'int b() {', '  return 2;', '}', ''].join('\n');
  const b = ['int a() {', '  return 1;', '}', '', 'int c() {', '  return 3;', '}', '', 'int b() {', '  return 2;', '}', ''].join('\n');
  const r = diff(a, b, { algorithm: 'patience' });
  checkCover(sp(a), sp(b), r);
  const ch = r.blocks.filter((x) => x.type === 'change');
  assert.strictEqual(ch.length, 1);
  assert.strictEqual(ch[0].aEnd - ch[0].aStart, 0, 'nothing removed');
  assert.strictEqual(ch[0].bEnd - ch[0].bStart, 4, 'one block of 4 added lines');
  assert.deepStrictEqual(sp(b).lines.slice(ch[0].bStart, ch[0].bEnd).filter(Boolean)[0], 'int c() {');
});

test('ignore whitespace, case and line endings', () => {
  assert.strictEqual(diff('a  b\n\tc\n', 'a b\nc  \n', { ignoreWhitespace: true }).stats.changes, 0);
  assert.strictEqual(diff('a  b\n', 'a b\n').stats.changes, 1);
  assert.strictEqual(diff('Hello\nWORLD\n', 'hello\nworld\n', { ignoreCase: true }).stats.changes, 0);
  assert.strictEqual(diff('Hello\n', 'hello\n').stats.changes, 1);
  assert.strictEqual(diff('a\r\nb\r\n', 'a\nb\n', { ignoreEol: true }).stats.changes, 0);
  assert.strictEqual(diff('a\r\nb\r\n', 'a\nb\n').stats.modified, 2);
  // a missing final line ending only counts when line endings are compared
  assert.strictEqual(diff('a\nb', 'a\nb\n', { ignoreEol: true }).stats.changes, 0);
  assert.strictEqual(diff('a\nb', 'a\nb\n').stats.changes, 1);
  // all three at once
  assert.strictEqual(diff('Foo  Bar\r\n', 'foo bar\n', { ignoreEol: true, ignoreCase: true, ignoreWhitespace: true }).stats.changes, 0);
});

test('100,000-line files diff quickly and correctly, and very different big files do not hang', () => {
  const lines = Array.from({ length: 100000 }, (_, i) => `line ${i} ${(i * 7919) % 1000}`);
  const b = lines.slice();
  for (let i = 0; i < 300; i++) b[(i * 331) % b.length] = 'changed ' + i;
  b.splice(50000, 0, 'inserted a', 'inserted b');
  b.splice(70000, 5);
  const ta = sp(lines.join('\n')); const tb = sp(b.join('\n'));
  let t0 = Date.now();
  const r = T.diffLines(ta, tb);
  const ms = Date.now() - t0;
  checkCover(ta, tb, r);
  assert(ms < 3000, 'took ' + ms + ' ms');
  assert.strictEqual(r.stats.added - r.stats.removed, 2 - 5);
  // two unrelated 100k-line texts: the work limit kicks in and the answer is still a valid cover
  const c = sp(Array.from({ length: 100000 }, (_, i) => `other ${i % 97} ${i % 13}`).join('\n'));
  t0 = Date.now();
  const r2 = T.diffLines(ta, c, { workLimit: 20e6 });
  assert(Date.now() - t0 < 8000, 'unrelated texts took ' + (Date.now() - t0) + ' ms');
  checkCover(ta, c, r2);
  const rows = T.buildRows(r.blocks);
  assert.strictEqual(rows.hunks.length, r.stats.changes);
});

// ---- rows ---------------------------------------------------------------------------------------------------------------------
test('rows line up both sides: changed lines pair up, extra lines leave a gap on the other side', () => {
  const a = sp('same\nold 1\nold 2\nold 3\nend\n'); const b = sp('same\nnew 1\nend\nmore\n');
  const r = T.diffLines(a, b);
  const rows = T.buildRows(r.blocks);
  assert.deepStrictEqual([...rows.side.left], [0, 1, 2, 3, 4, -1]);
  assert.deepStrictEqual([...rows.side.right], [0, 1, -1, -1, 2, 3]);
  assert.deepStrictEqual([...rows.side.kind], [0, 1, 2, 2, 0, 3]);
  assert.deepStrictEqual(rows.hunks.map((h) => h.sideRow), [1, 5]);
  assert.deepStrictEqual([...rows.unified.kind], [0, 2, 2, 2, 3, 0, 3]);
  assert.deepStrictEqual([...rows.unified.left], [0, 1, 2, 3, 1, 4, -1]);
});

// ---- inline highlights ---------------------------------------------------------------------------------------------------
test('word highlights mark only the changed words; character mode marks single letters', () => {
  const a = 'The quick brown fox jumps'; const b = 'The quick red fox jumped';
  const w = T.inlineDiff(a, b, 'word');
  assert.deepStrictEqual(w.a.map(([f, t]) => a.slice(f, t)), ['brown', 'jumps']);
  assert.deepStrictEqual(w.b.map(([f, t]) => b.slice(f, t)), ['red', 'jumped']);
  const c = T.inlineDiff('colour', 'color', 'char');
  assert.deepStrictEqual(c.a.map(([f, t]) => 'colour'.slice(f, t)), ['u']);
  assert.deepStrictEqual(c.b, []);
  const x = T.inlineDiff('return a + b;', 'return a - b;', 'char');
  assert.deepStrictEqual(x.a, [[9, 10]]); assert.deepStrictEqual(x.b, [[9, 10]]);
  // accents and non-Latin letters are words too
  const u = T.inlineDiff('Grüße aus Köln', 'Grüße aus Zürich', 'word');
  assert.deepStrictEqual(u.b.map(([f, t]) => 'Grüße aus Zürich'.slice(f, t)), ['Zürich']);
  // nothing in common: no highlights, the whole line is the change
  assert.strictEqual(T.inlineDiff('completely different text', 'zzzz yyyy xxxx wwww vvvv', 'word'), null);
});

test('word highlights follow the ignore options', () => {
  const r = T.inlineDiff('let  x = 1', 'let x = 2', 'word', { ignoreWhitespace: true });
  assert.deepStrictEqual(r.a.map(([f, t]) => 'let  x = 1'.slice(f, t)), ['1']);
  const c = T.inlineDiff('Hello World', 'hello world!', 'word', { ignoreCase: true });
  assert.deepStrictEqual(c.b.map(([f, t]) => 'hello world!'.slice(f, t)), ['!']);
  assert.deepStrictEqual(c.a, []);
});

// ---- patches -----------------------------------------------------------------------------------------------------------------
test('the unified patch has the standard form and applies back with the diff package', () => {
  const a = 'one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\n';
  const b = 'one\n2\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\neleven\n';
  const p = T.makePatch(sp(a), sp(b), { aName: 'a/numbers.txt', bName: 'b/numbers.txt' });
  assert(p.startsWith('--- a/numbers.txt\n+++ b/numbers.txt\n@@ -1,5 +1,5 @@\n one\n-two\n+2\n three\n'), p);
  assert(p.includes('@@ -8,3 +8,4 @@\n eight\n nine\n ten\n+eleven\n'), p);
  assert.strictEqual(JsDiff.applyPatch(a, p), b);
});

test('patches apply back for random edits, missing final newlines and CRLF files', () => {
  for (let round = 0; round < 80; round++) {
    const n = Math.floor(rand() * 40);
    const a = Array.from({ length: n }, () => 'w' + Math.floor(rand() * 8));
    const b = a.filter(() => rand() > 0.25).map((x) => (rand() < 0.2 ? x + '!' : x));
    if (rand() < 0.5) b.push('tail');
    const eol = round % 3 === 0 ? '\r\n' : '\n';
    const endA = rand() < 0.5 ? eol : ''; const endB = rand() < 0.5 ? eol : '';
    const ta = a.length ? a.join(eol) + endA : ''; const tb = b.length ? b.join(eol) + endB : '';
    const p = T.makePatch(sp(ta), sp(tb), { algorithm: round % 2 ? 'patience' : 'myers' });
    const back = JsDiff.applyPatch(ta, p);
    assert.strictEqual(back, tb, `round ${round}\n${JSON.stringify(ta)}\n${JSON.stringify(tb)}\n${p}`);
  }
});

test('the patch ignores the ignore options (it is always exact)', () => {
  const a = 'A  b\n'; const b = 'a b\n';
  const p = T.makePatch(sp(a), sp(b));
  assert.strictEqual(JsDiff.applyPatch(a, p), b);
});

// ---- merge -------------------------------------------------------------------------------------------------------------------
test('merging: take left, take right, both, per change', () => {
  const a = sp('head\nleft 1\nmiddle\nleft 2\nend'); const b = sp('head\nright 1\nmiddle\nend\nextra\n');
  const { blocks } = T.diffLines(a, b);
  assert.strictEqual(T.mergeText(a, b, blocks, []), 'head\nleft 1\nmiddle\nleft 2\nend');
  assert.strictEqual(T.mergeText(a, b, blocks, ['right', 'right']), 'head\nright 1\nmiddle\nend\nextra\n');
  assert.strictEqual(T.mergeText(a, b, blocks, ['right', 'left']), 'head\nright 1\nmiddle\nleft 2\nend');
  assert.strictEqual(T.mergeText(a, b, blocks, ['both', 'left']), 'head\nleft 1\nright 1\nmiddle\nleft 2\nend');
  // "both" after a last line without a line ending does not glue lines together
  const c = sp('x'); const d = sp('y\n');
  assert.strictEqual(T.mergeText(c, d, T.diffLines(c, d).blocks, ['both']), 'x\ny\n');
  // taking every right change gives exactly the right text
  const all = blocks.filter((x) => x.type === 'change').map(() => 'right');
  const ra = sp('1\n2\n3\n4\n'); const rb = sp('0\n2\n3\n5\n6\n');
  const rbl = T.diffLines(ra, rb).blocks;
  assert.strictEqual(T.mergeText(ra, rb, rbl, rbl.filter((x) => x.type === 'change').map(() => 'right')), '0\n2\n3\n5\n6\n');
  assert(all.length === 2);
});

// ---- encodings ---------------------------------------------------------------------------------------------------------------
test('encoding detection: UTF-8 with and without BOM, UTF-16 LE/BE with and without BOM, binary', () => {
  const text = 'Héllo wörld – naïve café\nsecond line\n';
  let d = E.detect(Buffer.from(text, 'utf8'));
  assert.strictEqual(d.encoding, 'utf-8'); assert.strictEqual(d.text, text);
  d = E.detect(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text)]));
  assert.strictEqual(d.encoding, 'utf-8-bom'); assert.strictEqual(d.text, text);
  for (const [enc, bom] of [['utf-16le', true], ['utf-16be', true], ['utf-16le', false], ['utf-16be', false]]) {
    const bytes = E.encode(text, enc, bom);
    d = E.detect(bytes);
    assert.strictEqual(d.encoding, enc, enc + ' bom=' + bom); assert.strictEqual(d.text, text); assert.strictEqual(d.bom, bom);
    assert(E.encode(d.text, d.encoding, d.bom).equals(bytes), 'round trip ' + enc);
  }
  // Windows-1252 bytes (é = 0xE9) are not valid UTF-8: treated as binary, not guessed
  assert.strictEqual(E.detect(Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a])).encoding, 'binary');
  // PNG header and random bytes
  assert.strictEqual(E.detect(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13])).encoding, 'binary');
  assert.strictEqual(E.detect(Buffer.from(Array.from({ length: 4000 }, (_, i) => (i * 73) % 256))).encoding, 'binary');
  assert.strictEqual(E.detect(Buffer.alloc(0)).encoding, 'utf-8');
  // emoji (surrogate pairs) in UTF-16
  const emo = 'smile 😀 ok\n';
  assert.strictEqual(E.detect(E.encode(emo, 'utf-16le', true)).text, emo);
  // an odd number of bytes after a UTF-16 BOM is not UTF-16
  assert.strictEqual(E.detect(Buffer.from([0xff, 0xfe, 0x41, 0x00, 0x42])).encoding, 'binary');
});

test('loading files: text is decoded with its line endings, binary files get a hash', async () => {
  const t = path.join(tmp, 'crlf.txt'); fs.writeFileSync(t, E.encode('a\r\nb\r\n', 'utf-16le', true));
  const r = await F.loadForDiff(t);
  assert.strictEqual(r.kind, 'text'); assert.strictEqual(r.encoding, 'utf-16le'); assert.strictEqual(T.lineEndingOf(sp(r.text)), 'CRLF');
  const bin = path.join(tmp, 'pic.bin'); fs.writeFileSync(bin, Buffer.from([0, 1, 2, 3, 255, 0, 7]));
  const b = await F.loadForDiff(bin);
  assert.strictEqual(b.kind, 'binary'); assert.strictEqual(b.text, undefined); assert.match(b.sha256, /^[0-9a-f]{64}$/);
  const bin2 = path.join(tmp, 'pic2.bin'); fs.copyFileSync(bin, bin2);
  assert.strictEqual((await F.loadForDiff(bin2)).sha256, b.sha256);
  await assert.rejects(F.loadForDiff(tmp), (e) => e.code === 'EISDIR');
});

test('saving: free names, atomic writes, overwrite keeps a .bak and refuses a file that changed', async () => {
  const f = path.join(tmp, 'merge.txt'); fs.writeFileSync(f, 'old');
  assert.strictEqual(F.freeName(f), path.join(tmp, 'merge (2).txt'));
  await F.writeAtomic(path.join(tmp, 'new.txt'), 'fresh');
  assert.strictEqual(fs.readFileSync(path.join(tmp, 'new.txt'), 'utf8'), 'fresh');
  assert(!fs.existsSync(path.join(tmp, 'new.txt.part')));
  const st = fs.statSync(f);
  const r = await F.overwriteWithBackup(f, 'new', { size: st.size, mtimeMs: st.mtimeMs });
  assert.strictEqual(fs.readFileSync(f, 'utf8'), 'new');
  assert.strictEqual(fs.readFileSync(r.backup, 'utf8'), 'old');
  assert.strictEqual(r.backup, f + '.bak');
  // a second overwrite does not replace the first backup
  const st2 = fs.statSync(f);
  const r2 = await F.overwriteWithBackup(f, 'newer', { size: st2.size, mtimeMs: st2.mtimeMs });
  assert.strictEqual(r2.backup, path.join(tmp, 'merge.txt (2).bak'));
  assert.strictEqual(fs.readFileSync(f + '.bak', 'utf8'), 'old');
  await assert.rejects(F.overwriteWithBackup(f, 'x', { size: 999, mtimeMs: 1 }), /changed on disk/);
  assert.strictEqual(fs.readFileSync(f, 'utf8'), 'newer');
});

// ---- folders -----------------------------------------------------------------------------------------------------------------
function makeTree() {
  const root = fs.mkdtempSync(path.join(tmp, 'tree-'));
  const L = path.join(root, 'left'); const R = path.join(root, 'right');
  const put = (side, rel, data, mtime) => {
    const p = path.join(side, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, data);
    if (mtime) fs.utimesSync(p, mtime / 1000, mtime / 1000);
  };
  const t0 = Date.UTC(2024, 0, 1);
  put(L, 'same.txt', 'hello', t0); put(R, 'same.txt', 'hello', t0);
  put(L, 'size.txt', 'short', t0); put(R, 'size.txt', 'much longer', t0);
  put(L, 'touched.txt', 'abc', t0); put(R, 'touched.txt', 'abc', t0 + 3600e3);        // same content, other date
  put(L, 'sneaky.txt', 'abc', t0); put(R, 'sneaky.txt', 'xyz', t0);                     // other content, same size and date
  put(L, 'only-left.md', 'L', t0);
  put(R, 'only-right.md', 'R', t0);
  put(L, 'sub/deep/a.txt', 'a', t0); put(R, 'sub/deep/a.txt', 'a', t0);
  put(L, 'sub/b.txt', 'b', t0); put(R, 'sub/b.txt', 'BB', t0);
  put(L, 'alike/x.txt', 'x', t0); put(R, 'alike/x.txt', 'x', t0);
  put(L, 'newdir/n1.txt', 'n1', t0); put(L, 'newdir/n2/n3.txt', 'n3', t0);
  put(L, 'node_modules/pkg/index.js', 'x', t0); put(R, '.git/HEAD', 'ref', t0);
  put(L, 'skip.log', 'log', t0); put(L, 'Ünïcødé 名前.txt', 'u', t0); put(R, 'Ünïcødé 名前.txt', 'u', t0);
  return { root, L, R, t0 };
}

test('folder comparison (quick mode) classifies a generated tree, with folders and ignore patterns', async () => {
  const { L, R } = makeTree();
  const r = await D.compareFolders(L, R, { mode: 'quick', ignore: ['node_modules', '.git', '*.log'], caseInsensitive: false });
  const st = Object.fromEntries(r.entries.map((e) => [e.rel, e.status]));
  assert.strictEqual(st['same.txt'], 'same');
  assert.strictEqual(st['size.txt'], 'different');
  assert.strictEqual(st['touched.txt'], 'different');
  assert.strictEqual(st['sneaky.txt'], 'same', 'quick mode cannot see it (same size and date)');
  assert.strictEqual(st['only-left.md'], 'left');
  assert.strictEqual(st['only-right.md'], 'right');
  assert.strictEqual(st['sub'], 'different'); assert.strictEqual(st['sub/deep'], 'same'); assert.strictEqual(st['sub/b.txt'], 'different');
  assert.strictEqual(st['alike'], 'same');
  assert.strictEqual(st['newdir'], 'left'); assert.strictEqual(st['newdir/n2/n3.txt'], 'left');
  assert.strictEqual(st['Ünïcødé 名前.txt'], 'same');
  assert(!('node_modules' in st) && !('.git' in st) && !('skip.log' in st), 'ignored');
  // folders come before files, at each level
  const top = r.entries.filter((e) => e.depth === 0).map((e) => e.type);
  assert.strictEqual(top.lastIndexOf('dir') < top.indexOf('file'), true);
  assert.strictEqual(r.counts.left, 3); assert.strictEqual(r.counts.right, 1);
});

test('folder comparison (content mode) hashes files: dates do not matter, contents do', async () => {
  const { L, R } = makeTree();
  const r = await D.compareFolders(L, R, { mode: 'content', caseInsensitive: false });
  const st = Object.fromEntries(r.entries.map((e) => [e.rel, e.status]));
  assert.strictEqual(st['touched.txt'], 'same');
  assert.strictEqual(st['sneaky.txt'], 'different');
  assert.strictEqual(st['alike'], 'same'); assert.strictEqual(st['sub'], 'different');
  assert(!('node_modules' in st) && !('.git' in st), 'default ignore list');
  assert.strictEqual(st['skip.log'], 'left');
});

test('ignore patterns: names, globs, folder-only and anchored paths', () => {
  const ig = D.makeIgnore(['node_modules', '*.tmp', 'build/', 'docs/*.bak', '**/cache'], false);
  assert(ig('a/node_modules', true)); assert(ig('x.tmp', false)); assert(ig('deep/er/x.tmp', false));
  assert(ig('build', true)); assert(!ig('build', false));
  assert(ig('docs/a.bak', false)); assert(!ig('other/docs/a.bak', false));
  assert(ig('a/b/cache', true)); assert(!ig('readme.md', false));
  assert(D.makeIgnore(['README.MD'], true)('readme.md', false));
});

test('case-insensitive matching pairs README.md with readme.md (as on Windows)', async () => {
  const root = fs.mkdtempSync(path.join(tmp, 'case-'));
  fs.mkdirSync(path.join(root, 'l')); fs.mkdirSync(path.join(root, 'r'));
  fs.writeFileSync(path.join(root, 'l', 'README.md'), 'x'); fs.writeFileSync(path.join(root, 'r', 'readme.md'), 'x');
  const r = await D.compareFolders(path.join(root, 'l'), path.join(root, 'r'), { mode: 'content', caseInsensitive: true });
  assert.strictEqual(r.entries.length, 1); assert.strictEqual(r.entries[0].status, 'same');
});

test('copying left to right: missing and different files, the replaced file goes to the (fake) Recycle Bin', async () => {
  const { L, R, root } = makeTree();
  const r = await D.compareFolders(L, R, { mode: 'content', caseInsensitive: false });
  const plan = D.planCopy(r, ['size.txt', 'newdir', 'same.txt', 'only-right.md'], 'ltr');
  assert.deepStrictEqual(plan.items.map((i) => i.rel).sort(), ['newdir/n1.txt', 'newdir/n2/n3.txt', 'size.txt']);
  assert.strictEqual(plan.replacing, 1);
  const binned = [];
  const bin = path.join(root, 'bin'); fs.mkdirSync(bin);
  const trash = async (p) => { binned.push(p); fs.renameSync(p, path.join(bin, path.basename(p))); };
  const res = await D.runCopy(plan, { trash });
  assert.deepStrictEqual(res.failed, []);
  assert.strictEqual(fs.readFileSync(path.join(R, 'size.txt'), 'utf8'), 'short');
  assert.strictEqual(fs.readFileSync(path.join(bin, 'size.txt'), 'utf8'), 'much longer', 'the replaced file is in the bin');
  assert.deepStrictEqual(binned, [path.join(R, 'size.txt')]);
  assert.strictEqual(fs.readFileSync(path.join(R, 'newdir/n2/n3.txt'), 'utf8'), 'n3');
  assert(fs.existsSync(path.join(R, 'only-right.md')), 'nothing on the target side is removed');
  assert(!fs.readdirSync(R).some((n) => n.endsWith('.part')));
  const again = await D.compareFolders(L, R, { mode: 'quick', caseInsensitive: false });
  const st = Object.fromEntries(again.entries.map((e) => [e.rel, e.status]));
  assert.strictEqual(st['size.txt'], 'same', 'the copy keeps the modified time');
  assert.strictEqual(st['newdir'], 'same');
  // right to left
  const back = D.planCopy(again, ['only-right.md'], 'rtl');
  await D.runCopy(back, { trash });
  assert.strictEqual(fs.readFileSync(path.join(L, 'only-right.md'), 'utf8'), 'R');
});

test('copying refuses paths outside the folders and files that changed after the comparison', async () => {
  const { L, R } = makeTree();
  const r = await D.compareFolders(L, R, { mode: 'quick', caseInsensitive: false });
  r.entries.push({ rel: '../escape.txt', type: 'file', status: 'left', left: { size: 1 }, right: null });
  const plan = D.planCopy(r, ['../escape.txt'], 'ltr');
  assert.strictEqual(plan.items.length, 0);
  const p2 = D.planCopy(r, ['size.txt'], 'ltr');
  fs.writeFileSync(path.join(L, 'size.txt'), 'changed after the comparison');
  const res = await D.runCopy(p2, { trash: async () => { throw new Error('must not be called'); } });
  assert.strictEqual(res.done.length, 0); assert.match(res.failed[0].error, /changed since/);
  assert.strictEqual(fs.readFileSync(path.join(R, 'size.txt'), 'utf8'), 'much longer');
});

test('the colours used by the window are readable (contrast)', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'styles.css'), 'utf8');
  const tokens = {};
  for (const m of css.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-fA-F]{6})/g)) tokens[m[1]] = m[2];
  const lum = (hex) => { const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  const pairs = [['text', 'bg', 4.5], ['muted', 'bg', 4.5], ['accent', 'bg', 4.5], ['text', 'add-bg', 4.5], ['text', 'del-bg', 4.5], ['text', 'add-hi', 4.5], ['text', 'del-hi', 4.5]];
  const bad = pairs.filter(([a, b, min]) => !tokens[a] || !tokens[b] || ratio(tokens[a], tokens[b]) < min).map(([a, b, min]) => `${a} on ${b} < ${min}`);
  assert.deepStrictEqual(bad, []);
});

(async () => {
  let failed = 0;
  for (const [name, fn] of tests) {
    const t0 = Date.now();
    try { await fn(); console.log(`ok   ${name} (${Date.now() - t0} ms)`); }
    catch (e) { failed++; console.log(`FAIL ${name}\n     ${String((e && e.stack) || e).split('\n').slice(0, 8).join('\n     ')}`); }
  }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  console.log(failed ? `\n${failed} of ${tests.length} failed` : `\nall ${tests.length} passed`);
  process.exit(failed ? 1 : 0);
})();
