'use strict';
// Core tests for PDF Toolkit. Results are read back with pdf.js (Mozilla's reader), a different implementation from the
// pdf-lib that wrote them, so these tests don't just check the library against itself.
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { pathToFileURL } = require('url');
const { PDFDocument } = require('pdf-lib');
const P = require('../src/pdf');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pdftk-'));
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
let passed = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

/** A PDF whose page i is (100 + 10*i) points wide, so every page can be recognised by its width. */
async function makePdf(name, pageCount, firstWidth = 100) {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pageCount; i++) doc.addPage([firstWidth + 10 * i, 200]);
  const f = path.join(tmp, name);
  fs.writeFileSync(f, await doc.save());
  return f;
}

let pdfjsPromise;
const pdfjs = () => (pdfjsPromise ||= import(pathToFileURL(path.join(__dirname, '..', 'node_modules', 'pdfjs-dist', 'legacy', 'build', 'pdf.mjs')).href));
async function open(file) {
  const lib = await pdfjs();
  return lib.getDocument({ data: new Uint8Array(fs.readFileSync(file)), verbosity: 0 }).promise;
}
/** [{width, height, rotate}] for every page, as pdf.js sees them. */
async function pages(file) {
  const doc = await open(file);
  const out = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const p = await doc.getPage(i);
    const [x0, y0, x1, y1] = p.view;
    out.push({ width: Math.round(x1 - x0), height: Math.round(y1 - y0), rotate: p.rotate });
  }
  return out;
}
const widths = async (file) => (await pages(file)).map((p) => p.width);

// PDF matrices [a b c d e f] act on row vectors. mul(A, B) = "apply A, then B".
const mul = (A, B) => [
  A[0] * B[0] + A[1] * B[2], A[0] * B[1] + A[1] * B[3],
  A[2] * B[0] + A[3] * B[2], A[2] * B[1] + A[3] * B[3],
  A[4] * B[0] + A[5] * B[2] + B[4], A[4] * B[1] + A[5] * B[3] + B[5],
];
/** The combined matrix (all the "cm" steps pdf-lib wrote) in force when the first image on page 1 is painted. */
async function imageMatrix(file) {
  const lib = await pdfjs();
  const doc = await open(file);
  const page = await doc.getPage(1);
  const ops = await page.getOperatorList();
  let ctm = [1, 0, 0, 1, 0, 0];
  for (let i = 0; i < ops.fnArray.length; i++) {
    if (ops.fnArray[i] === lib.OPS.save) ctm = [1, 0, 0, 1, 0, 0];
    if (ops.fnArray[i] === lib.OPS.transform) ctm = mul(Array.from(ops.argsArray[i]), ctm); // a later cm applies first
    if (ops.fnArray[i] === lib.OPS.paintImageXObject) return ctm;
  }
  throw new Error('no image painted on page 1');
}

/** A small valid PNG (8-bit RGB), written by hand so the test needs no image library. */
function makePng(w, h) {
  const crcT = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const t = Buffer.from(type); const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const c = Buffer.alloc(4); c.writeUInt32BE(crc(Buffer.concat([t, data]))); return Buffer.concat([len, t, data, c]); };
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const o = y * (w * 3 + 1) + 1 + x * 3; raw[o] = x * 40; raw[o + 1] = y * 40; raw[o + 2] = 128; }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

// ---- page range syntax ----------------------------------------------------------------------------------------------
test('page ranges: numbers, open ends, end, all, whitespace', () => {
  assert.deepStrictEqual(P.parseSpec('1-3, 5, 8-', 10), [{ from: 1, to: 3 }, { from: 5, to: 5 }, { from: 8, to: 10 }]);
  assert.deepStrictEqual(P.parseSpec('-2', 10), [{ from: 1, to: 2 }]);
  assert.deepStrictEqual(P.parseSpec(' 3 - END ', 10), [{ from: 3, to: 10 }]);
  assert.deepStrictEqual(P.parseSpec('ALL', 4), [{ from: 1, to: 4 }]);
  assert.deepStrictEqual(P.indexesOf(P.parseSpec('3,1,1,2-3', 3)), [2, 0, 0, 1, 2]);
  assert.deepStrictEqual(P.indexesOf(P.parseSpec('4-2', 5, { allowReverse: true })), [3, 2, 1]);
});
test('page ranges: bad input gets a readable message, not a crash', () => {
  const msg = (s, n = 10, o) => { try { P.parseSpec(s, n, o); } catch (e) { assert(e instanceof P.UserError, 'should be a UserError: ' + s); return e.message; } assert.fail('accepted ' + s); };
  assert(/Enter which pages/.test(msg('')));
  assert(/Page 0 does not exist/.test(msg('0')));
  assert(/Page 11 does not exist \(this document has 10 pages\)/.test(msg('2, 11')));
  assert(/"3-1" goes backwards; write it as 1-3/.test(msg('3-1')));
  assert(/not a page number/.test(msg('abc')));
  assert(/not a page number/.test(msg('1-2-3')));
  assert(/not a page number/.test(msg('1.5')));
});

// ---- merge ---------------------------------------------------------------------------------------------------------
test('merge keeps the given order and every page', async () => {
  const a = await makePdf('a.pdf', 3, 100), b = await makePdf('b.pdf', 2, 500);
  const before = [sha(a), sha(b)];
  const r = await P.merge([b, a], {}, {});
  assert.strictEqual(r.pages, 5);
  assert.deepStrictEqual(await widths(r.outputs[0]), [500, 510, 100, 110, 120]);
  assert.deepStrictEqual([sha(a), sha(b)], before, 'inputs must not change');
  assert(/b-merged\.pdf$/.test(r.outputs[0]), r.outputs[0]);
});
test('merge never overwrites: a second run gets a new name', async () => {
  const a = await makePdf('m1.pdf', 1), b = await makePdf('m2.pdf', 1);
  const r1 = await P.merge([a, b]), r2 = await P.merge([a, b]);
  assert.notStrictEqual(r1.outputs[0], r2.outputs[0]);
  assert(fs.existsSync(r1.outputs[0]) && fs.existsSync(r2.outputs[0]));
  assert(/\(1\)\.pdf$/.test(r2.outputs[0]), r2.outputs[0]);
  assert.deepStrictEqual(fs.readdirSync(tmp).filter((f) => f.endsWith('.part')), [], 'no temp files left behind');
});
test('merge needs two files, and a bad file names itself', async () => {
  const a = await makePdf('only.pdf', 1);
  await assert.rejects(P.merge([a]), /at least two/);
  const bad = path.join(tmp, 'bad.pdf'); fs.writeFileSync(bad, 'this is not a pdf');
  await assert.rejects(P.merge([a, bad]), /bad\.pdf is not a valid PDF/);
  const txt = path.join(tmp, 'notes.txt'); fs.writeFileSync(txt, 'x');
  await assert.rejects(P.merge([a, txt]), /notes\.txt is not a PDF file/);
  await assert.rejects(P.merge([a, 'relative.pdf']), /absolute/);
  await assert.rejects(P.merge([a, path.join(tmp, 'missing.pdf')]), /Cannot read missing\.pdf/);
});
test('password-protected PDFs are refused with advice', async () => {
  const doc = await PDFDocument.create(); doc.addPage([100, 100]);
  doc.context.trailerInfo.Encrypt = doc.context.register(doc.context.obj({ Filter: 'Standard', V: 1, R: 2, O: '<00>', U: '<00>', P: -4 }));
  const f = path.join(tmp, 'locked.pdf'); fs.writeFileSync(f, await doc.save());
  const ok = await makePdf('plain.pdf', 1);
  await assert.rejects(P.merge([ok, f]), /locked\.pdf is password-protected/);
});
test('a cancelled merge writes nothing', async () => {
  const a = await makePdf('c1.pdf', 1), b = await makePdf('c2.pdf', 1);
  const dir = path.join(tmp, 'cancel-out');
  const ac = new AbortController(); ac.abort();
  await assert.rejects(P.merge([a, b], { outDir: dir }, { signal: ac.signal }), (e) => e.cancelled === true);
  assert(!fs.existsSync(dir) || fs.readdirSync(dir).length === 0);
});

// ---- split ---------------------------------------------------------------------------------------------------------
test('split: one file per page', async () => {
  const src = await makePdf('s1.pdf', 3);
  const out = path.join(tmp, 'split-each');
  const r = await P.split(src, { mode: 'each', outDir: out });
  assert.strictEqual(r.outputs.length, 3);
  assert.deepStrictEqual(r.outputs.map((f) => path.basename(f)), ['s1-page-1.pdf', 's1-page-2.pdf', 's1-page-3.pdf']);
  assert.deepStrictEqual(await Promise.all(r.outputs.map(async (f) => (await widths(f)).join())), ['100', '110', '120']);
});
test('split: by ranges, each range its own file', async () => {
  const src = await makePdf('s2.pdf', 6);
  const r = await P.split(src, { mode: 'ranges', spec: '1-2, 4, 5-', outDir: path.join(tmp, 'split-ranges') });
  assert.deepStrictEqual(r.outputs.map((f) => path.basename(f)), ['s2-pages-1-2.pdf', 's2-page-4.pdf', 's2-pages-5-6.pdf']);
  assert.deepStrictEqual(await Promise.all(r.outputs.map(async (f) => (await widths(f)).join())), ['100,110', '130', '140,150']);
});
test('split: every N pages (last group may be shorter)', async () => {
  const src = await makePdf('s3.pdf', 5);
  const r = await P.split(src, { mode: 'every', every: 2, outDir: path.join(tmp, 'split-every') });
  assert.deepStrictEqual(await Promise.all(r.outputs.map(async (f) => (await widths(f)).length)), [2, 2, 1]);
  await assert.rejects(P.split(src, { mode: 'every', every: 0 }), /number of pages/);
});
test('split: refuses a split that changes nothing, and bad modes', async () => {
  const src = await makePdf('s4.pdf', 3);
  await assert.rejects(P.split(src, { mode: 'ranges', spec: 'all' }), /nothing to split/);
  await assert.rejects(P.split(src, { mode: 'every', every: 99 }), /nothing to split/);
  await assert.rejects(P.split(src, { mode: 'sideways' }), /Unknown split mode/);
  await assert.rejects(P.split(src, { mode: 'ranges', spec: '9' }), /Page 9 does not exist/);
});

// ---- extract / delete / rotate -------------------------------------------------------------------------------------
test('extract keeps the order written (reorders and repeats)', async () => {
  const src = await makePdf('e1.pdf', 4);
  const r = await P.editPages(src, { action: 'extract', spec: '3,1,1', outDir: path.join(tmp, 'edit') });
  assert.deepStrictEqual(await widths(r.outputs[0]), [120, 100, 100]);
  assert(/e1-extracted\.pdf$/.test(r.outputs[0]));
});
test('delete removes the pages and refuses to remove all', async () => {
  const src = await makePdf('d1.pdf', 5);
  const r = await P.editPages(src, { action: 'delete', spec: '2-3, 5', outDir: path.join(tmp, 'edit') });
  assert.deepStrictEqual(await widths(r.outputs[0]), [100, 130]);
  await assert.rejects(P.editPages(src, { action: 'delete', spec: 'all' }), /every page/);
});
test('rotate turns only the chosen pages and adds to an existing rotation', async () => {
  const src = await makePdf('r1.pdf', 3);
  const once = await P.editPages(src, { action: 'rotate', spec: '2', angle: 90, outDir: path.join(tmp, 'edit') });
  assert.deepStrictEqual((await pages(once.outputs[0])).map((p) => p.rotate), [0, 90, 0]);
  const twice = await P.editPages(once.outputs[0], { action: 'rotate', spec: '1-2', angle: 270, outDir: path.join(tmp, 'edit') });
  assert.deepStrictEqual((await pages(twice.outputs[0])).map((p) => p.rotate), [270, 0, 0]); // 0+270, 90+270=360->0
  await assert.rejects(P.editPages(src, { action: 'rotate', spec: '1', angle: 45 }), /90, 180 or 270/);
  await assert.rejects(P.editPages(src, { action: 'explode', spec: '1' }), /Unknown page action/);
});

// ---- images -> PDF -------------------------------------------------------------------------------------------------
test('images: A4 pages, landscape or portrait to suit, image centred inside the margin', async () => {
  const wide = path.join(tmp, 'wide.png'), tall = path.join(tmp, 'tall.png');
  fs.writeFileSync(wide, makePng(8, 4)); fs.writeFileSync(tall, makePng(4, 8));
  const r = await P.imagesToPdf([wide, tall], { pageSize: 'a4', margin: 20, outDir: path.join(tmp, 'img') });
  assert.strictEqual(r.pages, 2);
  const ps = await pages(r.outputs[0]);
  assert.deepStrictEqual(ps.map((p) => [p.width, p.height]), [[842, 595], [595, 842]]);
  const [a, , , d, e, f] = await imageMatrix(r.outputs[0]); // page 1: [a 0 0 d e f] = scaled image placement
  assert(a > 0 && d > 0);
  assert(Math.abs(e + a / 2 - 842 / 2) < 1 && Math.abs(f + d / 2 - 595 / 2) < 1, 'image should be centred');
  assert(e >= 20 - 0.01 && f >= 20 - 0.01 && e + a <= 842 - 20 + 0.01 && f + d <= 595 - 20 + 0.01, 'image must stay inside the margin');
  assert(Math.abs(a / d - 2) < 0.001, 'aspect ratio kept');
});
test('images: "fit" makes the page the size of the picture; per-image mode writes one PDF each', async () => {
  const a = path.join(tmp, 'p1.png'), b = path.join(tmp, 'p2.png');
  fs.writeFileSync(a, makePng(16, 8)); fs.writeFileSync(b, makePng(8, 8));
  const one = await P.imagesToPdf([a, b], { pageSize: 'fit', outDir: path.join(tmp, 'fit') });
  assert.deepStrictEqual((await pages(one.outputs[0])).map((p) => [p.width, p.height]), [[12, 6], [6, 6]]);
  const each = await P.imagesToPdf([a, b], { pageSize: 'fit', perImage: true, outDir: path.join(tmp, 'fit-each') });
  assert.deepStrictEqual(each.outputs.map((f) => path.basename(f)), ['p1.pdf', 'p2.pdf']);
});
test('images: wrong types and damaged images are explained', async () => {
  const gif = path.join(tmp, 'x.gif'); fs.writeFileSync(gif, 'GIF89a');
  await assert.rejects(P.imagesToPdf([gif]), /not a JPEG or PNG/);
  const broken = path.join(tmp, 'broken.png'); fs.writeFileSync(broken, Buffer.from('definitely not png data at all'));
  await assert.rejects(P.imagesToPdf([broken]), /broken\.png could not be read as a PNG/);
  await assert.rejects(P.imagesToPdf([]), /at least one image/);
});
test('images: a phone photo stored sideways (EXIF orientation) comes out upright', async () => {
  let sharp;
  try { sharp = require(path.join(__dirname, '..', '..', 'picture-converter', 'node_modules', 'sharp')); } catch { console.log('   (skipped: needs sharp from tools/picture-converter to make a JPEG)'); return; }
  const make = (o, name) => sharp({ create: { width: 40, height: 20, channels: 3, background: '#c33' } }).jpeg().withMetadata({ orientation: o }).toBuffer().then((b) => { const f = path.join(tmp, name); fs.writeFileSync(f, b); return f; });
  const plain = await make(1, 'o1.jpg'), six = await make(6, 'o6.jpg'), eight = await make(8, 'o8.jpg'), three = await make(3, 'o3.jpg');
  assert.deepStrictEqual([plain, six, eight, three].map((f) => P.jpegOrientation(fs.readFileSync(f))), [1, 6, 8, 3]);
  const run = async (f) => { const r = await P.imagesToPdf([f], { pageSize: 'fit', outDir: path.join(tmp, 'orient') }); return { page: (await pages(r.outputs[0]))[0], m: await imageMatrix(r.outputs[0]) }; };
  const o1 = await run(plain), o6 = await run(six), o8 = await run(eight), o3 = await run(three);
  assert.deepStrictEqual([o1.page.width, o1.page.height], [30, 15]);
  assert.deepStrictEqual([o6.page.width, o6.page.height], [15, 30], 'orientation 6 swaps width and height');
  const near = (x, y) => Math.abs(x - y) < 1e-6;
  // matrix [a b c d e f]: stored x-axis = (a,b), stored y-axis (towards the top of the stored picture) = (c,d)
  assert(near(o6.m[0], 0) && o6.m[1] < 0 && o6.m[2] > 0 && near(o6.m[3], 0), 'orientation 6 = turned 90 degrees clockwise: ' + o6.m);
  assert(near(o8.m[0], 0) && o8.m[1] > 0 && o8.m[2] < 0 && near(o8.m[3], 0), 'orientation 8 = turned 90 degrees anticlockwise: ' + o8.m);
  assert(o3.m[0] < 0 && o3.m[3] < 0 && near(o3.m[1], 0) && near(o3.m[2], 0), 'orientation 3 = upside down: ' + o3.m);
  for (const o of [o6, o8, o3]) { // whichever way it is turned, the picture must lie exactly on the page
    const [a, b, c, d, e, f] = o.m;
    const xs = [e, e + a, e + c, e + a + c], ys = [f, f + b, f + d, f + b + d];
    assert(Math.min(...xs) > -1e-6 && Math.min(...ys) > -1e-6 && Math.max(...xs) < o.page.width + 1e-6 && Math.max(...ys) < o.page.height + 1e-6, 'picture off the page: ' + o.m);
  }
});

(async () => {
  let failed = 0;
  for (const [name, fn] of tests) {
    try { await fn(); passed++; console.log('ok   ' + name); } catch (e) { failed++; console.log('FAIL ' + name + '\n     ' + String((e && e.stack) || e).split('\n').slice(0, 4).join('\n     ')); }
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${passed}/${tests.length} passed`);
  process.exit(failed ? 1 : 0);
})();
