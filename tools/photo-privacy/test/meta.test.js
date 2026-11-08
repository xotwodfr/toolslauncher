'use strict';
// Photo Privacy Cleaner core tests. Independent checks:
//   - exifr (a separate EXIF reader) must agree with our scanner on well-formed data,
//   - sharp/libvips must decode the cleaned picture to exactly the same pixels as the original,
//   - and a fuzz run feeds damaged files to make sure the parser fails politely instead of crashing.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const sharp = require('sharp');
const exifr = require('exifr');
const M = require('../src/meta');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ppc-'));
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

// ---- fixtures -------------------------------------------------------------------------------------------------------
/** TIFF/EXIF builder, written independently of the scanner so the two can check each other. */
function buildTiff({ little = false, ifd0 = [], exif = [], gps = [], thumb = null }) {
  const w16 = (b, v, o) => (little ? b.writeUInt16LE(v, o) : b.writeUInt16BE(v, o));
  const w32 = (b, v, o) => (little ? b.writeUInt32LE(v, o) : b.writeUInt32BE(v, o));
  const encode = (type, v) => {
    if (type === 2) return Buffer.from(String(v) + '\0', 'utf8');
    if (type === 3) { const b = Buffer.alloc(2 * v.length); v.forEach((x, i) => w16(b, x, 2 * i)); return b; }
    if (type === 4) { const b = Buffer.alloc(4 * v.length); v.forEach((x, i) => w32(b, x, 4 * i)); return b; }
    if (type === 5) { const b = Buffer.alloc(8 * v.length); v.forEach(([n, d], i) => { w32(b, n, 8 * i); w32(b, d, 8 * i + 4); }); return b; }
    return Buffer.from(v); // 1 BYTE / 7 UNDEFINED
  };
  const countOf = (type, v) => (type === 2 ? Buffer.byteLength(String(v) + '\0') : type === 5 ? v.length : type === 3 || type === 4 ? v.length : Buffer.from(v).length);
  const sizeOf = (entries) => 2 + 12 * entries.length + 4 + entries.reduce((s, e) => { const n = encode(e.type, e.v).length; return s + (n > 4 ? n + (n & 1) : 0); }, 0);
  const block = (entries, at, next) => {
    entries = [...entries].sort((a, b) => a.tag - b.tag);
    const table = Buffer.alloc(2 + 12 * entries.length + 4);
    w16(table, entries.length, 0);
    const data = [];
    let dataLen = 0;
    entries.forEach((e, i) => {
      const o = 2 + 12 * i, bytes = encode(e.type, e.v);
      w16(table, e.tag, o); w16(table, e.type, o + 2); w32(table, countOf(e.type, e.v), o + 4);
      if (bytes.length <= 4) bytes.copy(table, o + 8);
      else { w32(table, at + table.length + dataLen, o + 8); const padded = Buffer.alloc(bytes.length + (bytes.length & 1)); bytes.copy(padded); data.push(padded); dataLen += padded.length; }
    });
    w32(table, next, 2 + 12 * entries.length);
    return Buffer.concat([table, ...data]);
  };
  const gpsE = gps, exE = exif, hasThumb = !!thumb;
  const i0 = [...ifd0]; if (exE.length) i0.push({ tag: 0x8769, type: 4, v: [0] }); if (gpsE.length) i0.push({ tag: 0x8825, type: 4, v: [0] });
  const i1 = hasThumb ? [{ tag: 0x0201, type: 4, v: [0] }, { tag: 0x0202, type: 4, v: [thumb.length] }] : [];
  const at0 = 8, atEx = at0 + sizeOf(i0), atGps = atEx + (exE.length ? sizeOf(exE) : 0), at1 = atGps + (gpsE.length ? sizeOf(gpsE) : 0), atTh = at1 + (hasThumb ? sizeOf(i1) : 0);
  for (const e of i0) { if (e.tag === 0x8769) e.v = [atEx]; if (e.tag === 0x8825) e.v = [atGps]; }
  if (hasThumb) i1[0].v = [atTh];
  const head = Buffer.alloc(8); head.write(little ? 'II' : 'MM', 0); w16(head, 42, 2); w32(head, 8, 4);
  return Buffer.concat([head, block(i0, at0, hasThumb ? at1 : 0), exE.length ? block(exE, atEx, 0) : Buffer.alloc(0), gpsE.length ? block(gpsE, atGps, 0) : Buffer.alloc(0), hasThumb ? block(i1, at1, 0) : Buffer.alloc(0), hasThumb ? thumb : Buffer.alloc(0)]);
}
const rat = (n, d = 1) => [n, d];
const RICH = (little) => buildTiff({
  little,
  ifd0: [
    { tag: 0x010f, type: 2, v: 'ACME Cameras' }, { tag: 0x0110, type: 2, v: 'Shot 9000' }, { tag: 0x0112, type: 3, v: [6] },
    { tag: 0x0131, type: 2, v: 'EditPro 4.2' }, { tag: 0x0132, type: 2, v: '2024:05:01 10:20:30' }, { tag: 0x013b, type: 2, v: 'Jane Doe' },
    { tag: 0x8298, type: 2, v: '(c) Jane Doe' }, { tag: 0x010e, type: 2, v: 'Our house at 12 Elm Street' },
    { tag: 0x9c9d, type: 1, v: Buffer.from('Jane X\0', 'utf16le') },
  ],
  exif: [
    { tag: 0x9003, type: 2, v: '2024:05:01 10:20:30' }, { tag: 0xa430, type: 2, v: 'Jane Doe' }, { tag: 0xa431, type: 2, v: 'SN-123456789' },
    { tag: 0xa434, type: 2, v: 'ACME 50mm f/1.8' }, { tag: 0xa435, type: 2, v: 'LN-555' },
    { tag: 0x9286, type: 7, v: Buffer.concat([Buffer.from('ASCII\0\0\0'), Buffer.from('call me on 555-0100')]) },
    { tag: 0x927c, type: 7, v: Buffer.alloc(40, 7) },
  ],
  gps: [
    { tag: 0x0001, type: 2, v: 'N' }, { tag: 0x0002, type: 5, v: [rat(59), rat(19), rat(3500, 100)] },
    { tag: 0x0003, type: 2, v: 'E' }, { tag: 0x0004, type: 5, v: [rat(18), rat(4), rat(8)] },
    { tag: 0x0005, type: 1, v: [0] }, { tag: 0x0006, type: 5, v: [rat(25)] },
  ],
  thumb: Buffer.from('FAKE-THUMBNAIL-BYTES-0123456789'),
});
const LAT = 59 + 19 / 60 + 35 / 3600, LON = 18 + 4 / 60 + 8 / 3600;

const seg = (marker, payload) => { const h = Buffer.alloc(4); h[0] = 0xff; h[1] = marker; h.writeUInt16BE(payload.length + 2, 2); return Buffer.concat([h, payload]); };
const app1Exif = (tiff) => seg(0xe1, Buffer.concat([Buffer.from('Exif\0\0'), tiff]));
const app1Xmp = (xml) => seg(0xe1, Buffer.concat([Buffer.from('http://ns.adobe.com/xap/1.0/\0'), Buffer.from(xml)]));
/** Insert segments right after the JFIF header (or SOI). */
function withSegments(jpeg, segs) {
  let at = 2;
  if (jpeg[2] === 0xff && jpeg[3] === 0xe0) at = 4 + jpeg.readUInt16BE(4);
  return Buffer.concat([jpeg.subarray(0, at), ...segs, jpeg.subarray(at)]);
}
const gradient = (w = 64, h = 48) => {
  const raw = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const o = (y * w + x) * 3; raw[o] = x * 4; raw[o + 1] = y * 5; raw[o + 2] = (x * y) & 255; }
  return sharp(raw, { raw: { width: w, height: h, channels: 3 } });
};
const pixels = async (buf) => (await sharp(buf).raw().toBuffer({ resolveWithObject: true }));
const samePixels = async (a, b) => { const [x, y] = [await pixels(a), await pixels(b)]; return x.info.width === y.info.width && x.info.height === y.info.height && x.data.equals(y.data); };
const crcT = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (b) => { let c = 0xffffffff; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const pngChunk = (type, data) => { const t = Buffer.from(type, 'latin1'), l = Buffer.alloc(4), c = Buffer.alloc(4); l.writeUInt32BE(data.length); c.writeUInt32BE(crc32(Buffer.concat([t, data]))); return Buffer.concat([l, t, data, c]); };
/** Insert chunks just before IEND. */
const pngWith = (png, chunks) => Buffer.concat([png.subarray(0, png.length - 12), ...chunks, png.subarray(png.length - 12)]);
/** The entropy-coded picture data of a (single-scan) JPEG: from the last Start-of-Scan segment to the end marker. Compared as bytes, because a decoder may colour-manage pixels using the embedded profile. */
const scanData = (jpg) => { const i = jpg.lastIndexOf(Buffer.from([0xff, 0xda])); return jpg.subarray(i + 2 + jpg.readUInt16BE(i + 2), jpg.length - 2); };
/** Payload of the first RIFF chunk with this id, found with a plain loop (independent of the code under test). */
const riffChunk = (w, id) => { for (let p = 12; p + 8 <= w.length;) { const n = w.readUInt32LE(p + 4); if (w.toString('latin1', p, p + 4) === id) return w.subarray(p + 8, p + 8 + n); p += 8 + n + (n & 1); } return null; };
const keys = (r) => [...new Set(r.findings.map((f) => f.key))].sort();
const find = (r, key) => r.findings.find((f) => f.key === key);

let richJpeg, richPng, richWebp, plainJpeg;
async function fixtures() {
  plainJpeg = await gradient().jpeg({ quality: 90 }).toBuffer();
  richJpeg = withSegments(plainJpeg, [
    app1Exif(RICH(false)),
    app1Xmp('<x:xmpmeta><rdf:Description exif:GPSLatitude="59,19.58N" exif:GPSLongitude="18,4.13E" xmp:CreatorTool="EditPro"/></x:xmpmeta>'),
    seg(0xed, Buffer.from('Photoshop 3.0\0' + '8BIM....caption text')),
    seg(0xfe, Buffer.from('shot on my phone')),
    seg(0xe2, Buffer.concat([Buffer.from('MPF\0'), Buffer.alloc(30, 1)])),
    seg(0xe4, Buffer.from('vendor-private-data')),
  ]);
  richJpeg = Buffer.concat([richJpeg, Buffer.from('TRAILING-VIDEO-OR-PREVIEW-BYTES')]);
  const basePng = await gradient().png().toBuffer();
  richPng = pngWith(basePng, [
    pngChunk('tEXt', Buffer.from('parameters\0a secret prompt: portrait of my neighbour, seed 42')),
    pngChunk('tEXt', Buffer.from('Software\0ImageMaker 3')),
    pngChunk('tIME', Buffer.from([0x07, 0xe8, 5, 1, 10, 20, 30])),
    pngChunk('eXIf', RICH(false)),
    pngChunk('iTXt', Buffer.concat([Buffer.from('XML:com.adobe.xmp\0\0\0\0\0'), Buffer.from('<x:xmpmeta exif:GPSLatitude="59,19N" exif:GPSLongitude="18,4E"/>')])),
    pngChunk('prVT', Buffer.from('private vendor chunk')),
  ]);
  richPng = Buffer.concat([richPng, Buffer.from('TRAILING')]);
  richWebp = await gradient().webp({ lossless: true }).withExif({ IFD0: { Make: 'ACME', Model: 'WebCam', Copyright: '(c) Jane' } }).withIccProfile('p3').toBuffer();
}

// ---- reading metadata -----------------------------------------------------------------------------------------------
test('scan: finds every kind of leak in a rich JPEG, with correct values', async () => {
  const r = M.scanBuffer(richJpeg);
  assert.strictEqual(r.format, 'jpeg');
  assert.deepStrictEqual(keys(r), ['camera', 'comment', 'datetime', 'description', 'gps', 'iptc', 'makernote', 'other', 'owner', 'serial', 'software', 'thumbnail', 'trailing', 'xmp'].sort());
  assert.strictEqual(r.risk, 'high');
  assert.strictEqual(r.clean, false);
  const gps = r.findings.find((f) => f.key === 'gps' && /GPS\)/.test(f.label));
  assert(/59\.32639° N, 18\.06889° E, altitude 25 m/.test(gps.detail), gps.detail);
  assert(/ACME Cameras Shot 9000, ACME ACME 50mm|ACME Cameras Shot 9000/.test(find(r, 'camera').detail));
  assert(/Camera body serial SN-123456789; Lens serial LN-555/.test(find(r, 'serial').detail), find(r, 'serial').detail);
  assert(/Jane Doe/.test(find(r, 'owner').detail) && /Jane X/.test(find(r, 'owner').detail), find(r, 'owner').detail);
  assert(/12 Elm Street/.test(find(r, 'description').detail) && /555-0100/.test(find(r, 'description').detail));
  assert(/31 bytes/.test(find(r, 'thumbnail').detail), find(r, 'thumbnail').detail);
  assert(/31 bytes follow/.test(find(r, 'trailing').detail) || /bytes follow/.test(r.findings.find((f) => /Hidden data/.test(f.label)).detail));
  assert(r.findings.some((f) => f.key === 'gps' && /XMP/.test(f.label)), 'GPS inside XMP is reported too');
  assert.strictEqual(r.orientation, 6);
});
test('scan agrees with exifr (an independent EXIF reader), little- and big-endian', async () => {
  for (const little of [false, true]) {
    const jpg = withSegments(plainJpeg, [app1Exif(RICH(little))]);
    const mine = M.scanBuffer(jpg);
    const theirs = await exifr.parse(jpg, { tiff: true, exif: true, gps: true, ifd1: false, mergeOutput: true, translateValues: false, reviveValues: false, makerNote: false, userComment: false });
    assert(Math.abs(theirs.latitude - LAT) < 1e-6 && Math.abs(theirs.longitude - LON) < 1e-6, 'exifr coordinates: ' + theirs.latitude + ',' + theirs.longitude);
    const g = find(mine, 'gps').detail;
    assert(g.startsWith(`${LAT.toFixed(5)}° N, ${LON.toFixed(5)}° E`), g);
    assert.strictEqual(theirs.Make, 'ACME Cameras'); assert(find(mine, 'camera').detail.startsWith('ACME Cameras Shot 9000'));
    assert.strictEqual(theirs.Artist, 'Jane Doe'); assert(find(mine, 'owner').detail.includes('Artist: Jane Doe'));
    assert.strictEqual(theirs.Orientation, 6); assert.strictEqual(mine.orientation, 6);
    assert.strictEqual(theirs.SerialNumber, 'SN-123456789'); assert.strictEqual(theirs.OwnerName, 'Jane Doe'); assert(find(mine, 'serial').detail.includes('SN-123456789'));
    assert.strictEqual(String(theirs.DateTimeOriginal).slice(0, 19).replace(/\D/g, ''), '20240501102030'.slice(0, String(theirs.DateTimeOriginal).slice(0, 19).replace(/\D/g, '').length));
    assert(find(mine, 'datetime').detail === '2024:05:01 10:20:30');
  }
});
test('scan reads real-world EXIF written by libvips (a different writer)', async () => {
  const jpg = await gradient().jpeg().withExif({ IFD0: { Make: 'Canon', Model: 'EOS Test', Copyright: 'Me' }, IFD3: { GPSLatitudeRef: 'S', GPSLatitude: '33/1 51/1 2160/100', GPSLongitudeRef: 'W', GPSLongitude: '151/1 12/1 3600/100' } }).toBuffer();
  const r = M.scanBuffer(jpg);
  assert(find(r, 'camera').detail.startsWith('Canon EOS Test'), JSON.stringify(r.findings));
  const theirs = await exifr.parse(jpg, { gps: true });
  const g = find(r, 'gps').detail;
  assert(g.includes(`${Math.abs(theirs.latitude).toFixed(5)}° S`) && g.includes(`${Math.abs(theirs.longitude).toFixed(5)}° W`), g + ' vs ' + theirs.latitude + ',' + theirs.longitude);
});
test('scan: PNG text (incl. AI prompts), eXIf, XMP, tIME, vendor chunks and trailing data', async () => {
  const r = M.scanBuffer(richPng);
  assert.strictEqual(r.format, 'png');
  assert.deepStrictEqual(keys(r), ['camera', 'datetime', 'description', 'gps', 'makernote', 'other', 'owner', 'serial', 'software', 'text', 'thumbnail', 'time', 'trailing', 'xmp'].sort());
  const t = find(r, 'text');
  assert(/AI prompt/.test(t.label) && /a secret prompt/.test(t.detail), t.label + ' / ' + t.detail);
  assert(find(r, 'time').detail === '2024-05-01');
  assert(/prVT/.test(find(r, 'other').detail));
});
test('scan: WebP with EXIF and colour profile', async () => {
  const r = M.scanBuffer(richWebp);
  assert.strictEqual(r.format, 'webp');
  assert(find(r, 'camera').detail.startsWith('ACME WebCam'), JSON.stringify(r.findings));
  assert(find(r, 'owner').detail.includes('(c) Jane'));
});
test('scan: a picture with nothing hidden is reported clean', async () => {
  for (const b of [plainJpeg, await gradient().png().toBuffer(), await gradient().webp().toBuffer()]) {
    const r = M.scanBuffer(b);
    assert.strictEqual(r.clean, true, JSON.stringify(r.findings));
    assert.strictEqual(r.risk === 'high', false);
  }
});

// ---- cleaning -------------------------------------------------------------------------------------------------------
test('clean JPEG: nothing left, pixels identical, orientation and colour profile kept by default', async () => {
  const r = M.cleanBuffer(richJpeg);
  assert(r.data.length < richJpeg.length - 200);
  assert(await samePixels(richJpeg, r.data), 'decoded pixels must be identical');
  const left = await exifr.parse(r.data, { tiff: true, exif: true, gps: true, xmp: true, iptc: true, icc: false, mergeOutput: true, translateValues: false });
  assert.deepStrictEqual(Object.keys(left || {}), ['Orientation'], 'only the rotation flag may remain: ' + JSON.stringify(left));
  assert.strictEqual(left.Orientation, 6);
  assert.strictEqual(M.scanBuffer(r.data).clean, true);
  for (const needle of ['Jane', 'ACME', 'SN-123', 'Elm Street', 'TRAILING', 'EditPro', 'vendor-private', 'shot on my phone', 'Photoshop', 'MPF']) assert(!r.data.includes(needle), needle + ' still in the file');
  assert(r.data[r.data.length - 2] === 0xff && r.data[r.data.length - 1] === 0xd9, 'ends with the end-of-image marker');
});
test('clean JPEG: options keepOrientation / keepColor', async () => {
  const icc = await gradient().jpeg().withIccProfile('p3').withExif({ IFD0: { Make: 'X' } }).toBuffer();
  assert((await sharp(icc).metadata()).icc, 'fixture should carry a colour profile');
  const keep = M.cleanBuffer(icc);
  assert((await sharp(keep.data).metadata()).icc, 'profile kept by default');
  assert.deepStrictEqual(keep.kept, ['colour profile']);
  const drop = M.cleanBuffer(icc, { keepColor: false });
  assert(!(await sharp(drop.data).metadata()).icc, 'profile removed on request');
  assert(await samePixels(icc, keep.data), 'with the profile kept, decoded pixels are identical');
  assert(scanData(drop.data).equals(scanData(icc)), 'with the profile dropped, the coded picture data is still byte-identical');
  const rotated = withSegments(plainJpeg, [app1Exif(RICH(true))]);
  assert.strictEqual(M.scanBuffer(M.cleanBuffer(rotated).data).orientation, 6);
  assert.strictEqual(M.scanBuffer(M.cleanBuffer(rotated, { keepOrientation: false }).data).orientation, 1);
  assert(!M.cleanBuffer(rotated, { keepOrientation: false }).data.includes('Exif'), 'no EXIF block at all when rotation is not kept');
});
test('clean JPEG: a JFIF-header thumbnail and JFXX thumbnails are removed', async () => {
  const thumb = Buffer.alloc(12, 9); // 2x2 RGB
  const jf = seg(0xe0, Buffer.concat([Buffer.from('JFIF\0'), Buffer.from([1, 1, 0, 0, 1, 0, 1]), Buffer.from([2, 2]), thumb])); // JFIF 1.1, density 1x1, 2x2 thumbnail
  const body = plainJpeg.subarray(2); // sharp writes no JFIF header of its own
  const withThumb = Buffer.concat([Buffer.from([0xff, 0xd8]), jf, seg(0xe0, Buffer.from('JFXX\0\x10JFXXDATA')), body]);
  const r0 = M.scanBuffer(withThumb);
  assert(r0.findings.filter((f) => f.key === 'thumbnail').length === 2, JSON.stringify(r0.findings));
  const out = M.cleanBuffer(withThumb);
  assert(await samePixels(withThumb, out.data));
  assert.strictEqual(M.scanBuffer(out.data).clean, true);
  assert(!out.data.includes('JFXX'));
});
test('clean PNG: text, eXIf, XMP, tIME, vendor and trailing data gone; pixels identical; colour profile kept', async () => {
  const icc = await gradient().png().withIccProfile('p3').toBuffer();
  const src = pngWith(icc, [pngChunk('tEXt', Buffer.from('Author\0Jane')), pngChunk('eXIf', RICH(true)), pngChunk('prVT', Buffer.from('x'))]);
  const r = M.cleanBuffer(src);
  assert(await samePixels(src, r.data));
  assert((await sharp(r.data).metadata()).icc, 'iCCP kept');
  assert.strictEqual(M.scanBuffer(r.data).clean, true);
  assert(!r.data.includes('Jane') && !r.data.includes('prVT') && !r.data.includes('eXIf'));
  const rich = M.cleanBuffer(richPng);
  assert(await samePixels(richPng, rich.data));
  for (const needle of ['secret prompt', 'neighbour', 'ImageMaker', 'ACME', 'TRAILING', 'XML:com.adobe.xmp', 'tIME']) assert(!rich.data.includes(needle), needle + ' still present');
  assert(!(await sharp(M.cleanBuffer(src, { keepColor: false }).data).metadata()).icc, 'iCCP removed on request');
});
test('clean WebP: EXIF removed, flags fixed, pixels identical, profile follows the option', async () => {
  const r = M.cleanBuffer(richWebp);
  const meta = await sharp(r.data).metadata();
  assert(!meta.exif, 'no EXIF');
  assert(meta.icc, 'profile kept');
  assert(await samePixels(richWebp, r.data));
  assert.strictEqual(r.data.readUInt32LE(4) + 8, r.data.length, 'RIFF size is consistent');
  assert.strictEqual(r.data.toString('latin1', 12, 16), 'VP8X');
  assert.strictEqual(r.data[20] & 0x0c, 0, 'EXIF and XMP flags cleared');
  const noIcc = M.cleanBuffer(richWebp, { keepColor: false });
  assert(!(await sharp(noIcc.data).metadata()).icc);
  assert.strictEqual(noIcc.data[20] & 0x2c, 0, 'ICC flag cleared too');
  assert(riffChunk(noIcc.data, 'VP8L').equals(riffChunk(richWebp, 'VP8L')), 'coded picture data identical');
  const lossy = await gradient().webp({ quality: 70 }).withExif({ IFD0: { Make: 'ACME' } }).toBuffer();
  assert(await samePixels(lossy, M.cleanBuffer(lossy).data), 'lossy WebP bitstream is untouched');
});
test('cleaning is idempotent and leaves an already-clean file byte-for-byte alone', async () => {
  const once = M.cleanBuffer(richJpeg).data, twice = M.cleanBuffer(once).data;
  assert(once.equals(twice));
  assert(M.cleanBuffer(plainJpeg).data.equals(plainJpeg), 'a clean JPEG should come out identical');
  const png = await gradient().png().toBuffer();
  assert(M.cleanBuffer(png).data.equals(png));
});

// ---- files ----------------------------------------------------------------------------------------------------------
test('cleanFile: writes "-clean", never overwrites, leaves the original alone, uses the real format for the extension', async () => {
  const src = path.join(tmp, 'holiday.jpg'); fs.writeFileSync(src, richJpeg);
  const before = fs.readFileSync(src);
  const a = await M.cleanFile(src), b = await M.cleanFile(src);
  assert(/holiday-clean\.jpg$/.test(a.output) && /holiday-clean \(1\)\.jpg$/.test(b.output), a.output + ' ' + b.output);
  assert(fs.readFileSync(src).equals(before), 'original untouched');
  assert(a.outBytes < a.inBytes && a.removed.length > 5);
  const lie = path.join(tmp, 'actually-png.jpg'); fs.writeFileSync(lie, richPng);
  assert(/actually-png-clean\.png$/.test((await M.cleanFile(lie, { outDir: path.join(tmp, 'out') })).output));
  assert.deepStrictEqual(fs.readdirSync(tmp).filter((f) => f.endsWith('.part')), []);
});
test('files that are not pictures, damaged or missing are explained politely', async () => {
  const txt = path.join(tmp, 'a.jpg'); fs.writeFileSync(txt, 'hello world, not a picture');
  await assert.rejects(M.scanFile(txt), /a\.jpg: Not a JPEG, PNG or WebP/);
  await assert.rejects(M.cleanFile(txt), /Not a JPEG, PNG or WebP/);
  await assert.rejects(M.scanFile(path.join(tmp, 'nope.jpg')), /Cannot read nope\.jpg/);
  await assert.rejects(M.scanFile('relative.jpg'), /absolute/);
  const cut = path.join(tmp, 'cut.jpg'); fs.writeFileSync(cut, plainJpeg.subarray(0, plainJpeg.length - 40));
  await assert.rejects(M.scanFile(cut), /cut off/);
  const bad = path.join(tmp, 'bad.png'); fs.writeFileSync(bad, richPng.subarray(0, 60));
  await assert.rejects(M.scanFile(bad), /cut off|damaged/);
});

// ---- robustness -----------------------------------------------------------------------------------------------------
test('fuzz: damaged files either scan/clean or fail politely, never crash or hang', async () => {
  let seed = 12345;
  const rnd = (n) => { seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff; return (seed >>> 8) % n; };
  const samples = [richJpeg, richPng, richWebp, withSegments(plainJpeg, [app1Exif(RICH(true))])];
  let ok = 0, polite = 0;
  const t0 = Date.now();
  for (const base of samples) {
    for (let i = 0; i < 400; i++) {
      let b = Buffer.from(base);
      const kind = rnd(4);
      if (kind === 0) b = b.subarray(0, rnd(b.length));
      else if (kind === 1) for (let k = 0, n = 1 + rnd(8); k < n; k++) b[rnd(b.length)] = rnd(256);
      else if (kind === 2) { const at = rnd(b.length), len = rnd(200); b = Buffer.concat([b.subarray(0, at), b.subarray(Math.min(b.length, at + len))]); }
      else { const at = rnd(Math.min(b.length, 400)); for (let k = 0; k < 6; k++) b[at + k] = 0xff; }
      try {
        const r = M.scanBuffer(b);
        if (r.findings) M.cleanBuffer(b);
        ok++;
      } catch (e) {
        if (e instanceof M.UserError || /^Safety check failed/.test(e.message)) polite++;
        else throw new Error(`crash on mutation (kind ${kind}, ${b.length} bytes): ${e.stack}`);
      }
    }
  }
  assert(Date.now() - t0 < 20000, 'fuzzing took too long');
  console.log(`     ${ok} still readable, ${polite} refused politely`);
});
test('hostile EXIF: huge counts, loops and out-of-range offsets are ignored', async () => {
  const evil = Buffer.alloc(80);
  evil.write('MM', 0); evil.writeUInt16BE(42, 2); evil.writeUInt32BE(8, 4);
  evil.writeUInt16BE(3, 8);
  evil.writeUInt16BE(0x010f, 10); evil.writeUInt16BE(2, 12); evil.writeUInt32BE(0x7fffffff, 14); evil.writeUInt32BE(40, 18); // absurd count
  evil.writeUInt16BE(0x8769, 22); evil.writeUInt16BE(4, 24); evil.writeUInt32BE(1, 26); evil.writeUInt32BE(8, 30);            // Exif pointer back to IFD0 (a loop)
  evil.writeUInt16BE(0x8825, 34); evil.writeUInt16BE(4, 36); evil.writeUInt32BE(1, 38); evil.writeUInt32BE(0xfffffff0, 42);    // GPS pointer far outside
  evil.writeUInt32BE(8, 46);                                                                                                    // next IFD points to itself
  const r = M.scanBuffer(withSegments(plainJpeg, [app1Exif(evil)]));
  assert.strictEqual(r.findings.some((f) => f.level === 'high'), false);
  assert(await samePixels(plainJpeg, M.cleanBuffer(withSegments(plainJpeg, [app1Exif(evil)])).data));
});

(async () => {
  await fixtures();
  let failed = 0, passed = 0;
  for (const [name, fn] of tests) {
    try { await fn(); passed++; console.log('ok   ' + name); } catch (e) { failed++; console.log('FAIL ' + name + '\n     ' + String((e && e.stack) || e).split('\n').slice(0, 5).join('\n     ')); }
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${passed}/${tests.length} passed`);
  process.exit(failed ? 1 : 0);
})();
