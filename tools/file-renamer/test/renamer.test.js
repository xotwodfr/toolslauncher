'use strict';
// Batch File Renamer core tests: every rule, the full pipeline, the checks (Windows names, duplicates, clashes), and real
// renames in a temporary folder (swaps, chains, case-only changes, folders with their files, a failure half way), undo
// (exact names back, refused when files changed, also from the saved journal after a "restart"), recovery of an
// interrupted batch, photo dates and audio tags from invented files, and presets.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const R = require('../src/core/rules');
const C = require('../src/core/checks');
const G = require('../src/core/engine');
const S = require('../src/core/store');
const B = require('../src/core/batch');
const K = require('../src/core/testkit');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'renamer-test-'));
const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const file = (name, extra) => ({ name, dir: '/x', isDir: false, mtimeMs: Date.UTC(2023, 4, 6, 7, 8, 9), birthtimeMs: Date.UTC(2022, 0, 2, 3, 4, 5), ...(extra || {}) });
const one = (name, rule, extra) => { const r = R.applyRules([file(name, extra)], [R.makeRule(rule.type, rule)])[0]; if (r.errors.length) throw new Error(r.errors[0].message); return r.name; };
const names = (list, rules) => R.applyRules(list.map((n) => (typeof n === 'string' ? file(n) : n)), rules.map((r) => R.makeRule(r.type, r))).map((r) => r.name);
let dirN = 0;
const mkdir = (files) => {
  const d = path.join(tmp, 'd' + (++dirN)); fs.mkdirSync(d, { recursive: true });
  for (const [n, c] of Object.entries(files || {})) { const p = path.join(d, n); fs.mkdirSync(path.dirname(p), { recursive: true }); if (c === null) fs.mkdirSync(p, { recursive: true }); else fs.writeFileSync(p, c); }
  return d;
};
const ls = (d) => fs.readdirSync(d).sort();

// ---- the rules -------------------------------------------------------------------------------------------------------------
test('splitting names: extension, several dots, hidden files, folders', () => {
  assert.deepStrictEqual(R.splitName('photo.final.JPG'), { stem: 'photo.final', ext: '.JPG' });
  assert.deepStrictEqual(R.splitName('.bashrc'), { stem: '.bashrc', ext: '' });
  assert.deepStrictEqual(R.splitName('README'), { stem: 'README', ext: '' });
  assert.deepStrictEqual(R.splitName('trailing.'), { stem: 'trailing.', ext: '' });
  assert.deepStrictEqual(R.splitName('my.folder', true), { stem: 'my.folder', ext: '' });
});

test('find & replace: plain text, every match or the first, case, special characters, extension left alone', () => {
  assert.strictEqual(one('IMG_001_img.jpg', { type: 'replace', find: 'img', replace: 'Photo' }), 'Photo_001_Photo.jpg');
  assert.strictEqual(one('IMG_001_img.jpg', { type: 'replace', find: 'img', replace: 'Photo', matchCase: true }), 'IMG_001_Photo.jpg');
  assert.strictEqual(one('a-a-a.txt', { type: 'replace', find: 'a', replace: 'b', all: false }), 'b-a-a.txt');
  assert.strictEqual(one('price (1).txt', { type: 'replace', find: '(1)', replace: '$1 $&' }), 'price $1 $&.txt', 'no regex meaning in plain mode');
  assert.strictEqual(one('notes.txt', { type: 'replace', find: 'txt', replace: 'md' }), 'notes.txt', 'extension untouched');
  assert.strictEqual(one('notes.txt', { type: 'replace', find: '.txt', replace: '.md', includeExt: true }), 'notes.md');
});

test('find & replace with a regular expression and capture groups; a bad pattern is reported', () => {
  assert.strictEqual(one('2023-05-06 Holiday.jpg', { type: 'replace', regex: true, find: '^(\\d{4})-(\\d{2})-(\\d{2}) (.*)$', replace: '$4 $3.$2.$1' }), 'Holiday 06.05.2023.jpg');
  assert.strictEqual(one('Track 7.mp3', { type: 'replace', regex: true, find: '(\\d+)', replace: '[$1]' }), 'Track [7].mp3');
  assert.strictEqual(one('a1b22c333.txt', { type: 'replace', regex: true, find: '\\d+', replace: '#', all: false }), 'a#b22c333.txt');
  const r = R.applyRules([file('x.txt')], [R.makeRule('replace', { regex: true, find: '(unclosed', replace: '' })])[0];
  assert.strictEqual(r.name, 'x.txt'); assert.match(r.errors[0].message, /not valid/);
});

test('insert text: at the start, the end, before or after the extension, at a position from either end', () => {
  assert.strictEqual(one('song.mp3', { type: 'insert', text: 'Best - ', where: 'start' }), 'Best - song.mp3');
  assert.strictEqual(one('song.mp3', { type: 'insert', text: ' (live)', where: 'beforeExt' }), 'song (live).mp3');
  assert.strictEqual(one('song.mp3', { type: 'insert', text: '.bak', where: 'afterExt' }), 'song.mp3.bak');
  assert.strictEqual(one('abcdef.txt', { type: 'insert', text: '-', where: 'index', index: 2 }), 'ab-cdef.txt');
  assert.strictEqual(one('abcdef.txt', { type: 'insert', text: '-', where: 'index', index: 2, fromEnd: true }), 'abcd-ef.txt');
  assert.strictEqual(one('ab.txt', { type: 'insert', text: '!', where: 'index', index: 99 }), 'ab!.txt');
  assert.strictEqual(one('😀ab.txt', { type: 'insert', text: '-', where: 'index', index: 1 }), '😀-ab.txt', 'emoji count as one character');
});

test('remove characters: a range, first / last N, digits, symbols, a piece of text', () => {
  assert.strictEqual(one('abcdef.txt', { type: 'remove', mode: 'range', from: 2, count: 3 }), 'aef.txt');
  assert.strictEqual(one('abcdef.txt', { type: 'remove', mode: 'range', from: 1, count: 2, fromEnd: true }), 'abcd.txt');
  assert.strictEqual(one('IMG_1234.jpg', { type: 'remove', mode: 'first', count: 4 }), '1234.jpg');
  assert.strictEqual(one('report-final.docx', { type: 'remove', mode: 'last', count: 6 }), 'report.docx');
  assert.strictEqual(one('a1b2c3.txt', { type: 'remove', mode: 'digits' }), 'abc.txt');
  assert.strictEqual(one('héllo, wörld! (copy).txt', { type: 'remove', mode: 'symbols' }), 'héllo wörld copy.txt');
  assert.strictEqual(one('scan copy copy.pdf', { type: 'remove', mode: 'text', text: ' copy' }), 'scan.pdf');
  assert.strictEqual(one('ab.txt', { type: 'remove', mode: 'first', count: 10 }), '.txt', 'can become empty (the check catches it)');
});

test('change case: lower, UPPER, Title, Sentence, camel, kebab, snake; extension optional', () => {
  const n = 'my holiday-PHOTOS_2023.JPG';
  assert.strictEqual(one(n, { type: 'case', mode: 'lower' }), 'my holiday-photos_2023.JPG');
  assert.strictEqual(one(n, { type: 'case', mode: 'lower', ext: true }), 'my holiday-photos_2023.jpg');
  assert.strictEqual(one(n, { type: 'case', mode: 'upper' }), 'MY HOLIDAY-PHOTOS_2023.JPG');
  assert.strictEqual(one('the end of summer.txt', { type: 'case', mode: 'title' }), 'The End Of Summer.txt');
  assert.strictEqual(one('THE END. of summer.txt', { type: 'case', mode: 'sentence' }), 'The end. of summer.txt');
  assert.strictEqual(one(n, { type: 'case', mode: 'camel' }), 'myHolidayPhotos2023.JPG');
  assert.strictEqual(one(n, { type: 'case', mode: 'kebab' }), 'my-holiday-photos-2023.JPG');
  assert.strictEqual(one(n, { type: 'case', mode: 'snake' }), 'my_holiday_photos_2023.JPG');
  assert.strictEqual(one('myFileName.js', { type: 'case', mode: 'snake' }), 'my_file_name.js');
  assert.strictEqual(one('élan vital.txt', { type: 'case', mode: 'title' }), 'Élan Vital.txt');
});

test('numbering: start, step, padding, position, separator, per-folder reset', () => {
  assert.deepStrictEqual(names(['a.jpg', 'b.jpg', 'c.jpg'], [{ type: 'number', start: 1, step: 1, pad: 3, where: 'start', separator: '_' }]), ['001_a.jpg', '002_b.jpg', '003_c.jpg']);
  assert.deepStrictEqual(names(['a.jpg', 'b.jpg'], [{ type: 'number', start: 10, step: 5, pad: 0, where: 'end', separator: ' ' }]), ['a 10.jpg', 'b 15.jpg']);
  assert.deepStrictEqual(names(['a.jpg', 'b.jpg'], [{ type: 'number', start: 1, pad: 2, where: 'replace' }]), ['01.jpg', '02.jpg']);
  assert.deepStrictEqual(names(['abc.jpg'], [{ type: 'number', start: 7, pad: 1, where: 'index', index: 1 }]), ['a7bc.jpg']);
  const list = [file('a.jpg', { dir: '/one' }), file('b.jpg', { dir: '/one' }), file('c.jpg', { dir: '/two' })];
  assert.deepStrictEqual(names(list, [{ type: 'number', perFolder: true, pad: 1, where: 'start', separator: '-' }]), ['1-a.jpg', '2-b.jpg', '1-c.jpg']);
  assert.deepStrictEqual(names(list, [{ type: 'number', perFolder: false, pad: 1, where: 'start', separator: '-' }]), ['1-a.jpg', '2-b.jpg', '3-c.jpg']);
});

test('date: modified, created and photo (EXIF) date with a format pattern; no EXIF is reported', () => {
  const tz = (ms) => new Date(ms); // dates are shown in local time, so build the expectation the same way
  const d = tz(Date.UTC(2023, 4, 6, 7, 8, 9));
  const p = (n) => String(n).padStart(2, '0');
  assert.strictEqual(one('x.jpg', { type: 'date', source: 'modified', format: 'YYYY-MM-DD', where: 'start', separator: ' ' }), `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} x.jpg`);
  assert.strictEqual(one('x.jpg', { type: 'date', source: 'modified', format: 'YYYYMMDD_HHmmss', where: 'replace' }), `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.jpg`);
  const c = tz(Date.UTC(2022, 0, 2, 3, 4, 5));
  assert.strictEqual(one('x.jpg', { type: 'date', source: 'created', format: 'DD MMM YY', where: 'end', separator: ' - ' }), `x - ${p(c.getDate())} Jan 22.jpg`);
  const exif = new Date(2021, 6, 14, 9, 30, 0).getTime();
  assert.strictEqual(one('x.jpg', { type: 'date', source: 'exif', format: '[Photo] YYYY-MM-DD', where: 'replace' }, { exifDate: exif }), 'Photo 2021-07-14.jpg');
  assert.throws(() => one('x.jpg', { type: 'date', source: 'exif' }, { exifDate: null }), /No photo date/);
  assert.strictEqual(R.formatDate(new Date(2024, 1, 3, 4, 5, 6), 'D.M.YYYY H:mm'), '3.2.2024 4:05');
});

test('audio tags: pattern with artist, title, track (padded), album; missing tags are reported', () => {
  const tags = { artist: 'Kite Season', title: 'Night Swim', track: 3, album: 'Tides', year: '2020' };
  assert.strictEqual(one('01 track.mp3', { type: 'tags', pattern: '{track} - {artist} - {title}', where: 'replace' }, { tags }), '03 - Kite Season - Night Swim.mp3');
  assert.strictEqual(one('x.mp3', { type: 'tags', pattern: '{album} ({year})', where: 'start', separator: ' / ' }, { tags }), 'Tides (2020) / x.mp3');
  assert.throws(() => one('x.mp3', { type: 'tags', pattern: '{artist} - {title}' }, { tags: { artist: 'A', title: '' } }), /Missing tag: title/);
  assert.throws(() => one('x.mp3', { type: 'tags', pattern: '{title}' }, { tags: null }), /No audio tags/);
});

test('extension: lower, UPPER, change, remove; folders keep their names', () => {
  assert.strictEqual(one('Photo.JPEG', { type: 'extension', mode: 'lower' }), 'Photo.jpeg');
  assert.strictEqual(one('Photo.jpeg', { type: 'extension', mode: 'upper' }), 'Photo.JPEG');
  assert.strictEqual(one('Photo.jpeg', { type: 'extension', mode: 'change', value: '.jpg' }), 'Photo.jpg');
  assert.strictEqual(one('README', { type: 'extension', mode: 'change', value: 'md' }), 'README.md');
  assert.strictEqual(one('archive.tar.gz', { type: 'extension', mode: 'remove' }), 'archive.tar');
  assert.throws(() => one('a.txt', { type: 'extension', mode: 'change', value: ' ' }), /new extension/);
  assert.strictEqual(R.applyRules([{ ...file('My.Folder'), isDir: true }], [R.makeRule('extension', { mode: 'upper' })])[0].name, 'My.Folder');
});

test('trim and collapse spaces, separators to spaces; transliterate accents', () => {
  assert.strictEqual(one('  too   many  spaces  .txt', { type: 'trim' }), 'too many spaces.txt');
  assert.strictEqual(one('a  b.txt', { type: 'trim', collapse: false }), 'a  b.txt');
  assert.strictEqual(one('my_file.name_here.txt', { type: 'trim', separators: true }), 'my file name here.txt');
  assert.strictEqual(one('Crème brûlée – Æsir Øl Straße Łódź.txt', { type: 'translit' }), 'Creme brulee - AEsir Ol Strasse Lodz.txt');
  assert.strictEqual(R.transliterate('Ångström naïve'), 'Angstrom naive');
  assert.strictEqual(R.transliterate('東京'), '東京', 'scripts without a Latin form are kept');
});

test('the pipeline runs the enabled rules in order; turning one off or moving it changes the result', () => {
  const rules = [
    { type: 'replace', find: '_', replace: ' ' },
    { type: 'case', mode: 'title' },
    { type: 'number', where: 'start', pad: 2, separator: '. ' },
    { type: 'extension', mode: 'lower' },
  ];
  assert.deepStrictEqual(names(['summer_trip.JPG', 'winter_walk.JPG'], rules), ['01. Summer Trip.jpg', '02. Winter Walk.jpg']);
  const off = rules.map((r, i) => (i === 1 ? { ...r, enabled: false } : r));
  assert.deepStrictEqual(names(['summer_trip.JPG'], off), ['01. summer trip.jpg']);
  const moved = [rules[2], rules[1], rules[0], rules[3]];
  assert.deepStrictEqual(names(['summer_trip.JPG'], moved), ['01. Summer Trip.jpg']);
  assert.deepStrictEqual(names(['a.txt'], []), ['a.txt']);
  // presets and the window may send junk: it is cleaned
  const clean = R.sanitizeRules([{ type: 'case', mode: 'upper', evil: 'x' }, { type: 'nope' }, null, { type: 'number', start: '5', pad: 'x' }]);
  assert.deepStrictEqual(clean.map((r) => r.type), ['case', 'number']);
  assert.strictEqual(clean[0].evil, undefined); assert.strictEqual(clean[1].start, 5); assert.strictEqual(clean[1].pad, 2);
});

// ---- checks --------------------------------------------------------------------------------------------------------------------
test('Windows-invalid names: characters, reserved names, trailing dots and spaces, too long', () => {
  const strict = (n) => C.nameProblems(n, { strict: true }).errors;
  assert.deepStrictEqual(strict('fine name.txt'), []);
  assert.match(strict('what?.txt')[0], /"\?"/);
  assert.match(strict('a<b>c:d.txt')[0], /"<" ">" ":"/);
  assert.match(strict('tab\there.txt')[0], /control character/);
  for (const n of ['CON', 'con.txt', 'Prn.log', 'AUX', 'nul.tar.gz', 'COM1', 'lpt9.doc']) assert.match(strict(n).join(), /reserved/, n);
  assert.deepStrictEqual(strict('console.txt'), []);
  assert.match(strict('name.').join(), /ending in a dot/);
  assert.match(strict('name ').join(), /ending in a dot or a space/);
  assert.match(strict('x'.repeat(256)).join(), /too long/);
  assert.match(strict('é'.repeat(200)).join(), /too long/, '255 bytes in UTF-8');
  assert.match(strict('').join(), /empty/);
  assert.match(strict('a/b').join(), /"\/"/);
  // not on Windows: Windows-only problems are warnings
  const loose = C.nameProblems('what?.txt', { strict: false });
  assert.deepStrictEqual(loose.errors, []); assert.match(loose.warnings[0], /Not allowed on Windows/);
});

test('batch checks: duplicates in the batch, clashes with existing files, unchanged rows, swaps, auto suffix', () => {
  const d = mkdir({ 'a.txt': 'a', 'b.txt': 'b', 'c.txt': 'c', 'taken.txt': 't' });
  const P = (n) => path.join(d, n);
  let rows = C.checkBatch([{ id: 1, path: P('a.txt'), newName: 'x.txt' }, { id: 2, path: P('b.txt'), newName: 'x.txt' }, { id: 3, path: P('c.txt'), newName: 'c.txt' }]);
  assert.deepStrictEqual(rows.map((r) => r.status), ['error', 'error', 'same']);
  assert.match(rows[0].errors[0], /same name/);
  rows = C.checkBatch([{ id: 1, path: P('a.txt'), newName: 'taken.txt' }]);
  assert.match(rows[0].errors[0], /already exists/);
  rows = C.checkBatch([{ id: 1, path: P('a.txt'), newName: 'b.txt' }, { id: 2, path: P('b.txt'), newName: 'a.txt' }]);
  assert.deepStrictEqual(rows.map((r) => [r.status, r.swap]), [['ok', true], ['ok', true]], 'a swap is fine');
  rows = C.checkBatch([{ id: 1, path: P('a.txt'), newName: 'b.txt' }, { id: 2, path: P('b.txt'), newName: 'c.txt' }, { id: 3, path: P('c.txt'), newName: 'd.txt' }]);
  assert.deepStrictEqual(rows.map((r) => r.status), ['ok', 'ok', 'ok'], 'a chain is fine');
  rows = C.checkBatch([{ id: 1, path: P('a.txt'), newName: 'x.txt' }, { id: 2, path: P('b.txt'), newName: 'x.txt' }, { id: 3, path: P('c.txt'), newName: 'taken.txt' }], { autoSuffix: true });
  assert.deepStrictEqual(rows.map((r) => [r.status, r.newName]), [['ok', 'x.txt'], ['ok', 'x (2).txt'], ['ok', 'taken (2).txt']]);
  rows = C.checkBatch([{ id: 1, path: P('a.txt'), newName: 'CON.txt' }], { strict: true });
  assert.strictEqual(rows[0].status, 'error');
  rows = C.checkBatch([{ id: 1, path: P('a.txt'), newName: 'q.txt', ruleErrors: ['Rule 1: No photo date'] }]);
  assert.strictEqual(rows[0].status, 'error', 'a rule problem blocks the row');
});

test('case-only renames are recognised on case-insensitive folders (simulated) and are not clashes', () => {
  const d = mkdir({ 'Photo.JPG': 'x', 'Other.txt': 'y' });
  const ci = new Map([[d, true]]);
  const rows = C.checkBatch([{ id: 1, path: path.join(d, 'Photo.JPG'), newName: 'photo.jpg' }, { id: 2, path: path.join(d, 'Other.txt'), newName: 'other.TXT' }], { ciDirs: ci, listDir: () => ['Photo.JPG', 'Other.txt'] });
  assert.deepStrictEqual(rows.map((r) => [r.status, r.caseOnly]), [['ok', true], ['ok', true]]);
  // on a case-insensitive folder, "a.txt" -> "B.TXT" clashes with an existing "b.txt"
  const d2 = mkdir({ 'a.txt': '1', 'b.txt': '2' });
  const r2 = C.checkBatch([{ id: 1, path: path.join(d2, 'a.txt'), newName: 'B.TXT' }], { ciDirs: new Map([[d2, true]]) });
  assert.match(r2[0].errors.join(), /already exists/);
  // and the real folder here is detected correctly
  assert.strictEqual(C.caseInsensitiveDir(d, 'Photo.JPG'), fs.existsSync(path.join(d, 'photo.jpg')));
});

// ---- real renames ------------------------------------------------------------------------------------------------------------
const run = async (d, pairs, opts) => {
  const j = G.planBatch(pairs.map(([a, b]) => ({ from: path.join(d, a), to: path.join(d, b) })));
  await G.runBatch(j, opts);
  return j;
};

test('real renames: a swap (a<->b) and a three-way rotation go through temporary names', async () => {
  const d = mkdir({ 'a.txt': 'A', 'b.txt': 'B', 'x.txt': 'X', 'y.txt': 'Y', 'z.txt': 'Z' });
  await run(d, [['a.txt', 'b.txt'], ['b.txt', 'a.txt'], ['x.txt', 'y.txt'], ['y.txt', 'z.txt'], ['z.txt', 'x.txt']]);
  assert.strictEqual(fs.readFileSync(path.join(d, 'a.txt'), 'utf8'), 'B');
  assert.strictEqual(fs.readFileSync(path.join(d, 'b.txt'), 'utf8'), 'A');
  assert.strictEqual(fs.readFileSync(path.join(d, 'y.txt'), 'utf8'), 'X');
  assert.strictEqual(fs.readFileSync(path.join(d, 'x.txt'), 'utf8'), 'Z');
  assert.deepStrictEqual(ls(d), ['a.txt', 'b.txt', 'x.txt', 'y.txt', 'z.txt'], 'no temporary files left');
});

test('real renames: a case-only change is done in two steps and lands on the new spelling', async () => {
  const d = mkdir({ 'Holiday.JPG': 'img' });
  const j = await run(d, [['Holiday.JPG', 'holiday.jpg']], { ci: true });
  assert.deepStrictEqual(ls(d), ['holiday.jpg']);
  assert.strictEqual(j.groups[0][0].tmp.includes('.renaming-'), true, 'went through a temporary name');
});

test('real renames: a folder and the files inside it in one batch (files first, then the folder)', async () => {
  const d = mkdir({ 'Trip/img1.jpg': '1', 'Trip/img2.jpg': '2' });
  const j = await run(d, [['Trip', 'Holiday 2023'], [path.join('Trip', 'img1.jpg'), path.join('Trip', 'Beach.jpg')], [path.join('Trip', 'img2.jpg'), path.join('Trip', 'Dunes.jpg')]]);
  assert.deepStrictEqual(ls(d), ['Holiday 2023']);
  assert.deepStrictEqual(ls(path.join(d, 'Holiday 2023')), ['Beach.jpg', 'Dunes.jpg']);
  // and undo puts all three back
  const u = await G.undoBatch(j);
  assert.strictEqual(u.undone, 3);
  assert.deepStrictEqual(ls(d), ['Trip']); assert.deepStrictEqual(ls(path.join(d, 'Trip')), ['img1.jpg', 'img2.jpg']);
});

test('real renames: preflight refuses a target taken by a file outside the batch and a missing source', async () => {
  const d = mkdir({ 'a.txt': 'A', 'b.txt': 'B' });
  await assert.rejects(run(d, [['a.txt', 'b.txt']]), /already exists/);
  await assert.rejects(run(d, [['gone.txt', 'c.txt']]), /not there any more/);
  assert.deepStrictEqual(ls(d), ['a.txt', 'b.txt']);
});

test('real renames: a failure half way puts every file back', async () => {
  const d = mkdir({ 'one.txt': '1', 'two.txt': '2', 'three.txt': '3' });
  const j = G.planBatch([['one.txt', 'uno.txt'], ['two.txt', 'dos.txt'], ['three.txt', 'tres.txt']].map(([a, b]) => ({ from: path.join(d, a), to: path.join(d, b) })));
  // a file appears at the second target after the checks (another program, say)
  const saved = [];
  const origRename = fs.promises.rename;
  let calls = 0;
  fs.promises.rename = async (a, b) => { calls++; if (calls === 4) fs.writeFileSync(path.join(d, 'dos.txt'), 'intruder'); return origRename(a, b); };
  try {
    await assert.rejects(G.runBatch(j, { save: (x) => saved.push(x.state) }), /put back/);
  } finally { fs.promises.rename = origRename; }
  assert.deepStrictEqual(ls(d), ['dos.txt', 'one.txt', 'three.txt', 'two.txt']);
  assert.strictEqual(fs.readFileSync(path.join(d, 'dos.txt'), 'utf8'), 'intruder', 'the other file was not touched');
  assert.deepStrictEqual(saved, ['running', 'rolled-back']);
});

// ---- undo ---------------------------------------------------------------------------------------------------------------------
test('undo restores the exact names (unicode, swaps), from the journal saved on disk after a "restart"', async () => {
  const d = mkdir({ 'Ünïcødé 名前.txt': 'u', 'a.txt': 'A', 'b.txt': 'B', 'Song.MP3': 'm' });
  const before = ls(d);
  const hist = new S.History(path.join(tmp, 'history1'));
  const j = G.planBatch([['Ünïcødé 名前.txt', 'plain.txt'], ['a.txt', 'b.txt'], ['b.txt', 'a.txt'], ['Song.MP3', 'song.mp3']].map(([a, b]) => ({ from: path.join(d, a), to: path.join(d, b) })));
  await G.runBatch(j, { save: (x) => hist.save(x) });
  assert.notDeepStrictEqual(ls(d), before);
  // a new History object reads what was saved, as after restarting the app
  const again = new S.History(path.join(tmp, 'history1'));
  const listed = again.list();
  assert.strictEqual(listed.length, 1); assert.strictEqual(listed[0].state, 'done');
  const r = await G.undoBatch(again.get(j.id), { save: (x) => again.save(x) });
  assert.strictEqual(r.undone, 4);
  assert.deepStrictEqual(ls(d), before);
  assert.strictEqual(fs.readFileSync(path.join(d, 'a.txt'), 'utf8'), 'A');
  assert.strictEqual(again.get(j.id).state, 'undone');
  await assert.rejects(G.undoBatch(again.get(j.id)), /cannot be undone/);
  assert.strictEqual(S.describe(again.get(j.id)).count, 4);
});

test('undo checks the files are still where they were left; it can undo just the ones that are', async () => {
  const d = mkdir({ 'one.txt': '1', 'two.txt': '2', 'three.txt': '3' });
  const j = await run(d, [['one.txt', '1.txt'], ['two.txt', '2.txt'], ['three.txt', '3.txt']]);
  fs.renameSync(path.join(d, '1.txt'), path.join(d, 'moved.txt'));    // renamed by someone else
  fs.writeFileSync(path.join(d, '2.txt'), 'changed size');               // replaced with other content
  const checks = G.verifyUndo(j);
  assert.deepStrictEqual(checks.map((c) => !!c.problem), [true, true, false]);
  await assert.rejects(G.undoBatch(j), (e) => e.okCount === 1 && /2 of 3/.test(e.message));
  assert(fs.existsSync(path.join(d, '3.txt')), 'nothing undone after the refusal');
  const r = await G.undoBatch(j, { partial: true });
  assert.strictEqual(r.undone, 1); assert.strictEqual(r.skipped.length, 2);
  assert(fs.existsSync(path.join(d, 'three.txt')));
  assert.strictEqual(j.state, 'partly-undone');
  // the old name taken by a new file: refused for that file
  const d2 = mkdir({ 'a.txt': 'a' });
  const j2 = await run(d2, [['a.txt', 'b.txt']]);
  fs.writeFileSync(path.join(d2, 'a.txt'), 'new file with the old name');
  assert.match(G.verifyUndo(j2)[0].problem, /taken by another file/);
});

test('an interrupted batch (files left at temporary names) is put back', async () => {
  const d = mkdir({ 'a.txt': 'A', 'b.txt': 'B', 'c.txt': 'C' });
  const j = G.planBatch([['a.txt', 'x.txt'], ['b.txt', 'y.txt'], ['c.txt', 'z.txt']].map(([a, b]) => ({ from: path.join(d, a), to: path.join(d, b) })));
  j.state = 'running';
  const [oa, ob] = j.groups[0];
  fs.renameSync(oa.from, oa.tmp); fs.renameSync(oa.tmp, oa.to);   // a finished
  fs.renameSync(ob.from, ob.tmp);                                  // b half way; c not started
  const r = await G.recoverInterrupted(j);
  assert.strictEqual(r.restored, 2); assert.deepStrictEqual(r.lost, []);
  assert.deepStrictEqual(ls(d), ['a.txt', 'b.txt', 'c.txt']);
  assert.strictEqual(j.state, 'rolled-back');
});

// ---- the list and the preview -----------------------------------------------------------------------------------------------
test('the file list: folders add their files (sub-folders optional), or the folder itself; no duplicates', async () => {
  const d = mkdir({ 'a.txt': '1', 'sub/b.txt': '2', 'sub/deeper/c.txt': '3', '.git/HEAD': 'x' });
  const L = new B.FileList();
  let r = await L.add([d]);
  assert.deepStrictEqual(r.added.map((i) => i.name), ['a.txt']);
  r = await L.add([d], { recursive: true });
  assert.deepStrictEqual(r.added.map((i) => i.name).sort(), ['b.txt', 'c.txt']); assert.strictEqual(r.skipped, 1, 'a.txt already listed');
  const L2 = new B.FileList();
  r = await L2.add([path.join(d, 'sub')], { folders: 'self' });
  assert.strictEqual(r.added[0].isDir, true); assert.strictEqual(r.added[0].name, 'sub');
  assert.deepStrictEqual(L.sorted('name').map((i) => i.name), ['a.txt', 'b.txt', 'c.txt']);
  L.remove([L.items[0].id]); assert.strictEqual(L.items.length, 2);
});

test('the preview reads photo dates and audio tags from invented files and finds problems', async () => {
  const d = mkdir({});
  K.jpegWithDate(path.join(d, 'IMG_0001.jpg'), '2021:07:14 09:30:00');
  K.jpegWithDate(path.join(d, 'IMG_0002.jpg'), '2021:07:15 18:05:00');
  fs.writeFileSync(path.join(d, 'no-exif.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  K.mp3WithTags(path.join(d, 'track01.mp3'), { title: 'Night Swim', artist: 'Kite Season', track: '1' });
  K.flacWithTags(path.join(d, 'track02.flac'), { title: 'Lantern Road', artist: 'Kite Season', track: '2' });
  const L = new B.FileList(); await L.add([d]);
  const photos = L.sorted('name').filter((i) => i.name.endsWith('.jpg'));
  let p = await B.preview(photos, [{ type: 'date', source: 'exif', format: 'YYYY-MM-DD HH.mm', where: 'replace' }]);
  assert.deepStrictEqual(p.rows.map((r) => r.newName), ['2021-07-14 09.30.jpg', '2021-07-15 18.05.jpg', 'no-exif.jpg']);
  assert.deepStrictEqual(p.rows.map((r) => r.status), ['ok', 'ok', 'error']);
  assert.match(p.rows[2].errors[0], /Rule 1: No photo date/);
  assert.deepStrictEqual(p.summary, { total: 3, rename: 2, same: 0, errors: 1, warnings: 0 });
  const songs = L.sorted('name').filter((i) => /\.(mp3|flac)$/.test(i.name));
  p = await B.preview(songs, [{ type: 'tags', pattern: '{track} {artist} - {title}', where: 'replace' }]);
  assert.deepStrictEqual(p.rows.map((r) => r.newName), ['01 Kite Season - Night Swim.mp3', '02 Kite Season - Lantern Road.flac']);
});

test('the full pipeline on a real folder: preview, rename, undo', async () => {
  const d = mkdir({ 'IMG_0003.JPG': '3', 'IMG_0001.JPG': '1', 'IMG_0002.JPG': '2', 'notes.txt': 'n' });
  const L = new B.FileList(); await L.add([d]);
  const list = L.sorted('name').filter((i) => i.name.startsWith('IMG'));
  const rules = [{ type: 'remove', mode: 'first', count: 4 }, { type: 'number', where: 'replace', pad: 3, start: 1 }, { type: 'insert', text: 'Beach ', where: 'start' }, { type: 'extension', mode: 'lower' }];
  const p = await B.preview(list, rules);
  assert.deepStrictEqual(p.rows.map((r) => r.newName), ['Beach 001.jpg', 'Beach 002.jpg', 'Beach 003.jpg']);
  const j = G.planBatch(p.rows.filter((r) => r.status === 'ok').map((r) => ({ from: r.from, to: r.to })));
  await G.runBatch(j);
  assert.deepStrictEqual(ls(d), ['Beach 001.jpg', 'Beach 002.jpg', 'Beach 003.jpg', 'notes.txt']);
  assert.strictEqual(fs.readFileSync(path.join(d, 'Beach 001.jpg'), 'utf8'), '1');
  await G.undoBatch(j);
  assert.deepStrictEqual(ls(d), ['IMG_0001.JPG', 'IMG_0002.JPG', 'IMG_0003.JPG', 'notes.txt']);
});

test('presets: save, list, replace by name, remove; junk in the file is cleaned', () => {
  const P = new S.Presets(path.join(tmp, 'presets.json'));
  assert.deepStrictEqual(P.all(), []);
  P.save('Photos by date', [{ type: 'date', source: 'exif', format: 'YYYY-MM-DD' }]);
  P.save('Tidy', [{ type: 'trim' }, { type: 'case', mode: 'lower' }]);
  P.save('Tidy', [{ type: 'trim' }]);
  const all = new S.Presets(path.join(tmp, 'presets.json')).all();
  assert.deepStrictEqual(all.map((p) => [p.name, p.rules.length]), [['Photos by date', 1], ['Tidy', 1]]);
  assert.strictEqual(all[0].rules[0].source, 'exif');
  P.remove('Tidy'); assert.deepStrictEqual(P.all().map((p) => p.name), ['Photos by date']);
  assert.throws(() => P.save('  ', []), /name/);
  fs.writeFileSync(path.join(tmp, 'presets.json'), '{"presets":[{"name":"x","rules":[{"type":"evil"}]}, 5]}');
  assert.deepStrictEqual(P.all(), [{ name: 'x', rules: [] }]);
});

test('the colours used by the window are readable (contrast)', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'styles.css'), 'utf8');
  const tokens = {};
  for (const m of css.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-fA-F]{6})/g)) tokens[m[1]] = m[2];
  const lum = (hex) => { const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  const pairs = [['text', 'bg', 4.5], ['muted', 'bg', 4.5], ['muted', 'panel', 4.5], ['accent', 'bg', 4.5], ['err', 'bg', 4.5], ['ok', 'bg', 4.5], ['warn', 'bg', 4.5]];
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
