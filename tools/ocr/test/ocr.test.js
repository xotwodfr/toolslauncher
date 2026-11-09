'use strict';
// Image Text Extractor core tests. Pictures with known text (test/fixtures, made with a normal system font) are read
// by the real Tesseract engine and the result is compared with what was written: the text, the language, the position of
// every word, and what happens when a reading is cancelled.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { Engine, shape, parseLangs, installedLanguages, PSM, UserError } = require('../src/ocr');
const Prep = require('../src/prep');
const Tidy = require('../src/tidy');
const Lang = require('../src/languages');
const PNG = require('./pngtools');

const fx = (n) => path.join(__dirname, 'fixtures', n);
const load = (n) => fs.readFileSync(fx(n));
const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const near = (a, b, tol, msg) => assert(Math.abs(a - b) <= tol, `${msg || ''} expected ${b} +/- ${tol}, got ${a}`);
const engine = new Engine();
/** Prepare a picture the way the window does (enlarge, grey, dark-on-light), then read it. */
async function readPrepared(name, opts = {}) {
  const img = PNG.decode(load(name));
  const scale = Prep.scaleFor(img.w, img.h, opts.enlarge !== false);
  const big = scale === 1 ? img : PNG.resize(img, Math.round(img.w * scale), Math.round(img.h * scale));
  const info = opts.enhance === false ? null : Prep.enhance(big.px, { invert: 'auto' });
  const r = await engine.recognize(PNG.encode(big), { langs: opts.langs || 'eng', psm: opts.psm, scale, signal: opts.signal });
  return { ...r, scale, info };
}

// ---- the small pure parts -----------------------------------------------------------------------------------------------
test('languages: the shipped set, names, and locale mapping', () => {
  assert.deepStrictEqual(installedLanguages().sort(), Lang.CODES.slice().sort(), 'every language file is present');
  assert.strictEqual(Lang.NAMES.swe, 'Swedish');
  assert.strictEqual(Lang.forLocale('sv-SE'), 'swe'); assert.strictEqual(Lang.forLocale('en-US'), 'eng'); assert.strictEqual(Lang.forLocale('nb-NO'), 'nor');
  assert.strictEqual(Lang.forLocale('xx'), 'eng'); assert.strictEqual(Lang.forLocale(undefined), 'eng');
  assert.deepStrictEqual(parseLangs('eng+swe'), ['eng', 'swe']);
  assert.deepStrictEqual(parseLangs('eng+eng'), ['eng']);
  for (const bad of ['xxx', 'eng+', '../eng', 'eng+swe+deu+fra', 'eng+../../x', 'ENG']) assert.throws(() => parseLangs(bad), UserError, bad);
});

test('prep: how much to enlarge, and a selection kept inside the picture', () => {
  assert.strictEqual(Prep.scaleFor(2000, 1000), 1);
  near(Prep.scaleFor(1000, 500), 2, 1e-9); near(Prep.scaleFor(420, 50), 3, 1e-9, 'capped at 3');
  assert.strictEqual(Prep.scaleFor(420, 50, false), 1, 'enlarging can be switched off');
  near(Prep.scaleFor(9000, 3000), 0.5, 1e-9, 'huge pictures are shrunk');
  assert.deepStrictEqual(Prep.clampRegion({ x: 10, y: 20, w: 100, h: 50 }, 500, 500), { x: 10, y: 20, w: 100, h: 50 });
  assert.deepStrictEqual(Prep.clampRegion({ x: 100, y: 100, w: -50, h: -40 }, 500, 500), { x: 50, y: 60, w: 50, h: 40 }, 'dragged up and to the left');
  assert.deepStrictEqual(Prep.clampRegion({ x: -20, y: -20, w: 80, h: 80 }, 500, 500), { x: 0, y: 0, w: 60, h: 60 }, 'clipped to the picture');
  assert.strictEqual(Prep.clampRegion({ x: 5, y: 5, w: 3, h: 40 }, 500, 500), null, 'too small to read');
  assert.strictEqual(Prep.clampRegion(null, 10, 10), null);
});

test('prep: contrast is stretched, dark backgrounds are inverted, see-through pixels count as white', () => {
  const mk = (rgb, n = 100) => { const a = new Uint8ClampedArray(n * 4); for (let i = 0; i < n; i++) { a[i * 4] = rgb[0]; a[i * 4 + 1] = rgb[1]; a[i * 4 + 2] = rgb[2]; a[i * 4 + 3] = 255; } return a; };
  const faint = mk([200, 200, 200]); for (let i = 0; i < 20; i++) { faint[i * 4] = faint[i * 4 + 1] = faint[i * 4 + 2] = 170; }
  const r = Prep.enhance(faint);
  assert.strictEqual(r.inverted, false);
  const vals = new Set(); for (let i = 0; i < 100; i++) vals.add(faint[i * 4]);
  assert(Math.min(...vals) <= 5 && Math.max(...vals) >= 250, 'faint grey text on grey became full black on white: ' + [...vals]);
  const dark = mk([30, 30, 30]); for (let i = 0; i < 20; i++) { dark[i * 4] = dark[i * 4 + 1] = dark[i * 4 + 2] = 240; }
  const d = Prep.enhance(dark);
  assert.strictEqual(d.inverted, true);
  assert(dark[0] < 40 && dark[99 * 4] > 215, 'light text on dark became dark text on light');
  const clear = new Uint8ClampedArray(8); const c = Prep.enhance(clear);   // fully see-through
  assert.strictEqual(c.inverted, false); assert.strictEqual(clear[0], 255);
  const forced = mk([30, 30, 30]); assert.strictEqual(Prep.enhance(forced, { invert: false }).inverted, false);
});

test('tidy: clean-up, joining lines into paragraphs, counting, comparing', () => {
  assert.strictEqual(Tidy.clean('  a  \r\n\r\n\r\n\r\nb \n\n'), '  a\n\nb');
  assert.strictEqual(Tidy.joinLines('The meeting is\non Thursday at\nnoon.\n\nBring the exam-\nple forms.\nThanks!'), 'The meeting is on Thursday at noon.\n\nBring the example forms. Thanks!');
  assert.strictEqual(Tidy.joinLines('well-\nKnown'), 'well- Known', 'a hyphen before a capital is kept');
  assert.strictEqual(Tidy.joinLines(''), '');
  assert.deepStrictEqual(Tidy.stats('one two\nthree'), { words: 3, chars: 13, lines: 2 });
  assert.deepStrictEqual(Tidy.stats(''), { words: 0, chars: 0, lines: 0 });
  assert.strictEqual(Tidy.similarity('Hello  World', 'hello world'), 1);
  near(Tidy.similarity('kitten', 'sitting'), 1 - 3 / 7, 1e-9);
  assert.strictEqual(Tidy.similarity('', ''), 1); assert.strictEqual(Tidy.similarity('abc', ''), 0);
});

test('shape: words and lines in the original picture\'s pixels, whatever the enlargement or crop', () => {
  const data = { text: 'Hi there\n', confidence: 88.4, blocks: [{ paragraphs: [{ lines: [{ text: 'Hi there\n', confidence: 90, bbox: { x0: 20, y0: 40, x1: 220, y1: 80 }, words: [
    { text: 'Hi', confidence: 95.2, bbox: { x0: 20, y0: 40, x1: 60, y1: 80 } }, { text: ' ', confidence: 10, bbox: { x0: 60, y0: 40, x1: 70, y1: 80 } }, { text: 'there', confidence: 70, bbox: { x0: 80, y0: 40, x1: 220, y1: 80 } }] }] }] }] };
  const plain = shape(data);
  assert.strictEqual(plain.words.length, 2, 'blank words dropped'); assert.strictEqual(plain.confidence, 88);
  assert.deepStrictEqual(plain.words[0], { t: 'Hi', c: 95, x: 20, y: 40, w: 40, h: 40 });
  assert.deepStrictEqual(plain.lines[0], { t: 'Hi there', c: 90, x: 20, y: 40, w: 200, h: 40 });
  const mapped = shape(data, { scale: 2, ox: 100, oy: 50 });
  assert.deepStrictEqual(mapped.words[1], { t: 'there', c: 70, x: 140, y: 70, w: 70, h: 20 });
  assert.deepStrictEqual(shape({}).words, []);
});

// ---- reading pictures ----------------------------------------------------------------------------------------------------
test('reads a line of English text', async () => {
  const r = await readPrepared('fox.png');
  assert(Tidy.similarity(r.text, 'The quick brown fox jumps over the lazy dog') >= 0.97, JSON.stringify(r.text));
  assert(r.confidence >= 85, 'confidence ' + r.confidence);
  assert.strictEqual(r.words.length, 9);
  assert.strictEqual(r.words[0].t, 'The');
  const img = PNG.decode(load('fox.png'));
  for (const w of r.words) { assert(w.x >= 0 && w.y >= 0 && w.x + w.w <= img.w + 2 && w.y + w.h <= img.h + 2, JSON.stringify(w)); }
  assert(r.words[1].x > r.words[0].x + r.words[0].w - 2, 'words run left to right');
  return `${r.ms} ms, confidence ${r.confidence}`;
});

test('reads a paragraph and keeps the line breaks', async () => {
  const r = await readPrepared('paragraph.png');
  const want = 'Meeting notes: the budget review moved to Thursday.\nPlease bring the signed forms and a printed copy\nof the schedule. Lunch will be provided.';
  assert(Tidy.similarity(r.text, want) >= 0.96, JSON.stringify(r.text));
  assert.strictEqual(Tidy.clean(r.text).split('\n').length, 3, 'three lines');
  assert.strictEqual(r.lines.length, 3);
  assert(r.lines[1].y > r.lines[0].y && r.lines[2].y > r.lines[1].y, 'lines top to bottom');
  assert.strictEqual(Tidy.joinLines(r.text).includes('\n'), false, 'joined into one paragraph');
});

test('reads numbers, punctuation and currency', async () => {
  const r = await readPrepared('invoice.png');
  assert(r.text.includes('2024-0517'), JSON.stringify(r.text));
  assert(r.text.includes('1,249.50'), JSON.stringify(r.text));
  assert(Tidy.similarity(r.text, 'Invoice 2024-0517 total 1,249.50 SEK due 30 June') >= 0.95);
});

test('reads Swedish and German with their language, accents included', async () => {
  const sv = await readPrepared('swedish.png', { langs: 'swe' });
  assert(Tidy.similarity(sv.text, 'Smörgåsar och äppelpaj är gott på söndagen') >= 0.93, JSON.stringify(sv.text));
  assert(/[åäö]/i.test(sv.text), 'keeps å ä ö');
  const de = await readPrepared('german.png', { langs: 'deu' });
  assert(Tidy.similarity(de.text, 'Die Größe der Straße überrascht uns alle') >= 0.93, JSON.stringify(de.text));
  assert(/[ößü]/.test(de.text), 'keeps ö ß ü');
  const both = await readPrepared('swedish.png', { langs: 'swe+eng' });
  assert(Tidy.similarity(both.text, 'Smörgåsar och äppelpaj är gott på söndagen') >= 0.9, 'two languages together: ' + JSON.stringify(both.text));
});

test('light text on a dark background is detected, inverted and read', async () => {
  const want = 'Light text on a dark background';
  const prepared = await readPrepared('dark.png');
  assert.strictEqual(prepared.info.inverted, true, 'detected as dark');
  assert(Tidy.similarity(prepared.text, want) >= 0.95, JSON.stringify(prepared.text));
  const raw = await engine.recognize(load('dark.png'), { langs: 'eng' });
  process.stdout.write(`       (as is: ${Math.round(Tidy.similarity(raw.text, want) * 100)}% right, prepared: ${Math.round(Tidy.similarity(prepared.text, want) * 100)}%)\n`);
});

test('small text is read after enlarging, and enlarging does not hurt', async () => {
  const want = 'Small text needs enlarging to be read well';
  const big = await readPrepared('small.png');
  assert.strictEqual(big.scale, 3, 'enlarged three times');
  assert(Tidy.similarity(big.text, want) >= 0.9, JSON.stringify(big.text));
  const same = await readPrepared('small.png', { enlarge: false });
  process.stdout.write(`       (not enlarged: ${Math.round(Tidy.similarity(same.text, want) * 100)}% right, enlarged: ${Math.round(Tidy.similarity(big.text, want) * 100)}%)\n`);
  assert(Tidy.similarity(big.text, want) >= Tidy.similarity(same.text, want), 'enlarging does not hurt');
});

test('a blank picture gives no text and no words', async () => {
  const r = await readPrepared('blank.png');
  assert.strictEqual(r.text.trim(), ''); assert.strictEqual(r.words.length, 0);
});

test('word positions come back in the original picture\'s pixels when it was enlarged and when only a part was read', async () => {
  const plain = await engine.recognize(load('fox.png'), { langs: 'eng' });
  const img = PNG.decode(load('fox.png'));
  const twice = PNG.resize(img, img.w * 2, img.h * 2);
  const big = await engine.recognize(PNG.encode(twice), { langs: 'eng', scale: 2 });
  assert.strictEqual(big.words.length, plain.words.length);
  big.words.forEach((w, i) => { near(w.x, plain.words[i].x, 6, `x of "${w.t}"`); near(w.y, plain.words[i].y, 6, `y of "${w.t}"`); });
  // read only the second line of the paragraph: cut out at (0, 62) 1000 x 55
  const para = PNG.decode(load('paragraph.png'));
  const full = await engine.recognize(load('paragraph.png'), { langs: 'eng' });
  const part = PNG.crop(para, 0, full.lines[1].y - 8, para.w, full.lines[1].h + 16);
  const r = await engine.recognize(PNG.encode(part), { langs: 'eng', psm: 'line', ox: 0, oy: full.lines[1].y - 8 });
  assert(Tidy.similarity(r.text, 'Please bring the signed forms and a printed copy') >= 0.95, JSON.stringify(r.text));
  near(r.lines[0].y, full.lines[1].y, 8, 'the line is where it was in the whole picture');
});

test('layout modes: single line and sparse text read a one-line picture', async () => {
  for (const psm of ['line', 'block', 'sparse', 'auto']) {
    const r = await engine.recognize(load('fox.png'), { langs: 'eng', psm });
    assert(Tidy.similarity(r.text, 'The quick brown fox jumps over the lazy dog') >= 0.9, `${psm}: ${JSON.stringify(r.text)}`);
  }
  assert.deepStrictEqual(Object.keys(PSM), ['auto', 'block', 'line', 'sparse']);
});

test('the same language keeps its worker; changing language swaps it', async () => {
  await engine.recognize(load('fox.png'), { langs: 'eng' });
  const w1 = engine.worker;
  await engine.recognize(load('fox.png'), { langs: 'eng' });
  assert.strictEqual(engine.worker, w1, 'reused');
  await engine.recognize(load('swedish.png'), { langs: 'swe' });
  assert.notStrictEqual(engine.worker, w1, 'replaced');
  assert.strictEqual(engine.key, 'swe');
});

test('several readings started together run one after another and all finish', async () => {
  const names = ['fox.png', 'invoice.png', 'paragraph.png', 'fox.png'];
  const rs = await Promise.all(names.map((n) => engine.recognize(load(n), { langs: 'eng' })));
  assert.strictEqual(rs.length, 4);
  assert(rs[1].text.includes('2024-0517') && rs[2].lines.length === 3);
});

test('progress is reported while reading', async () => {
  const seen = [];
  await engine.recognize(load('paragraph.png'), { langs: 'eng', onProgress: (f) => seen.push(f) });
  assert(seen.length >= 1 && seen.every((f) => f >= 0 && f <= 1), JSON.stringify(seen));
});

test('cancel: stops a reading at once and the engine keeps working afterwards', async () => {
  const big = PNG.resize(PNG.decode(load('paragraph.png')), 3000, 600);
  const ac = new AbortController();
  const p = engine.recognize(PNG.encode(big), { langs: 'eng', signal: ac.signal });
  setTimeout(() => ac.abort(), 150);
  const t0 = Date.now();
  await assert.rejects(p, (e) => e.cancelled === true);
  assert(Date.now() - t0 < 3000, 'cancelled quickly: ' + (Date.now() - t0));
  const again = await engine.recognize(load('fox.png'), { langs: 'eng' });
  assert(Tidy.similarity(again.text, 'The quick brown fox jumps over the lazy dog') >= 0.97);
  const pre = new AbortController(); pre.abort();
  await assert.rejects(engine.recognize(load('fox.png'), { langs: 'eng', signal: pre.signal }), (e) => e.cancelled === true);
});

test('bad input is refused with a readable message', async () => {
  await assert.rejects(engine.recognize(Buffer.from('not a picture at all, just some words here and there, more than one hundred bytes of it so that only the type is wrong xx'), { langs: 'eng' }), /not a picture the reader can use/);
  await assert.rejects(engine.recognize('a string', { langs: 'eng' }), UserError);
  await assert.rejects(engine.recognize(load('fox.png'), { langs: 'klingon' }), /Unknown language/);
  await assert.rejects(engine.recognize(load('fox.png'), { langs: '../../etc/passwd' }), /Unknown language/);
});

// ---- the window's colours -------------------------------------------------------------------------------------------------
test('colours: text and controls meet WCAG contrast (AA)', () => {
  const file = path.join(__dirname, '..', 'src', 'renderer', 'styles.css');
  if (!fs.existsSync(file)) return 'skipped: no window yet';
  const css = fs.readFileSync(file, 'utf8');
  const root = /:root\s*\{([^}]*)\}/.exec(css)[1];
  const v = (name) => { const m = new RegExp('--' + name + ':\\s*(#[0-9a-fA-F]{6})').exec(root); assert(m, 'missing --' + name); return m[1]; };
  const lum = (hex) => { const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((x) => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4)); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05); };
  const pairs = [['text', 'bg', 4.5], ['text', 'panel', 4.5], ['text', 'panel-2', 4.5], ['text', 'page', 4.5], ['muted', 'bg', 4.5], ['muted', 'panel', 4.5], ['muted', 'panel-2', 4.5], ['muted', 'page', 4.5],
    ['on-accent', 'accent', 4.5], ['accent', 'bg', 4.5], ['accent', 'panel', 4.5], ['err', 'bg', 4.5], ['err', 'panel', 4.5], ['ok', 'bg', 4.5], ['warn', 'bg', 4.5], ['warn', 'panel', 4.5]];
  const bad = pairs.filter(([a, b, min]) => ratio(v(a), v(b)) < min).map(([a, b, min]) => `${a} on ${b}: ${ratio(v(a), v(b)).toFixed(2)} < ${min}`);
  assert.deepStrictEqual(bad, []);
  return undefined;
});

(async () => {
  let failed = 0;
  for (const [name, fn] of tests) {
    const t0 = Date.now();
    try { const note = await fn(); console.log(`ok   ${name} (${Date.now() - t0} ms)${typeof note === 'string' ? '  [' + note + ']' : ''}`); }
    catch (e) { failed++; console.log(`FAIL ${name}\n     ${String((e && e.stack) || e).split('\n').slice(0, 5).join('\n     ')}`); }
  }
  await engine.terminate();
  console.log(failed ? `\n${failed} of ${tests.length} failed` : `\nall ${tests.length} passed`);
  process.exit(failed ? 1 : 0);
})();
