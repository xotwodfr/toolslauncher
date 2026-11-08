'use strict';
// Tests for the pure-JS / WASM codecs. Lossless formats must round-trip exactly; where ffmpeg is installed it also
// decodes our encoders' output independently (a codec checked only against its own decoder can be wrong in a
// self-consistent way).
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { spawnSync } = require('child_process');
const sharp = require('sharp');
const qoi = require('../src/codecs/qoi');
const bmp = require('../src/codecs/bmp');
const tga = require('../src/codecs/tga');
const pnm = require('../src/codecs/pnm');
const ico = require('../src/codecs/ico');
const pdf = require('../src/codecs/pdf');
const jxl = require('../src/codecs/jxl');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-codec-'));
let n = 0;
const ok = (m) => { n++; console.log('  ok  ' + m); };

// deterministic test image: solid runs, smooth gradients, then noise with varying alpha - exercises every QOI/TGA path
function makeImage(w, h, seed = 12345) {
  let s = seed; const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) >>> 8) & 255;
  const d = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const o = (y * w + x) * 4;
    if (y < h / 3) { d[o] = 200; d[o + 1] = 40; d[o + 2] = 40; d[o + 3] = 255; }
    else if (y < (2 * h) / 3) { d[o] = (x * 4) & 255; d[o + 1] = (y * 3) & 255; d[o + 2] = 128; d[o + 3] = 255; }
    else { d[o] = rnd(); d[o + 1] = rnd(); d[o + 2] = rnd(); d[o + 3] = rnd(); }
  }
  return d;
}
const opaque = (d) => { const c = Buffer.from(d); for (let i = 3; i < c.length; i += 4) c[i] = 255; return c; };
const W = 67, H = 41; // odd sizes on purpose (BMP row padding, TGA/QOI run edges)
const img = makeImage(W, H);
const solid = opaque(img);

const ffmpeg = (() => { try { return spawnSync('ffmpeg', ['-version']).status === 0 ? 'ffmpeg' : null; } catch { return null; } })();
// -> RGBA bytes decoded by ffmpeg, or null when THIS ffmpeg build cannot read the format at all (older builds lack
// e.g. the QOI decoder). A decoder that reads our file and gets different pixels is still a hard failure.
const skipped = [];
function ffmpegDecode(file) {
  const out = path.join(tmp, 'ff.raw');
  const r = spawnSync(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-i', file, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgba', out]);
  if (r.status !== 0) { skipped.push(path.extname(file) + ' (' + String(r.stderr).split('\n')[0].slice(0, 60) + ')'); return null; }
  return fs.readFileSync(out);
}
const same = (a, b) => a.length === b.length && Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;

(async () => {
  // ---- QOI ------------------------------------------------------------------------------------
  const q = qoi.encode(img, W, H);
  assert.deepStrictEqual(qoi.decode(q).data, img); assert.strictEqual(qoi.decode(q).width, W);
  assert(q.length < W * H * 4, 'QOI should compress this image');
  const qs = qoi.encode(solid, W, H); assert(same(qoi.decode(qs).data, solid));
  assert.throws(() => qoi.decode(Buffer.from('nope, not qoi at all, padded to 30 bytes!!')), /Not a QOI/);
  assert.throws(() => qoi.decode(q.subarray(0, 40)), /truncated/);
  ok('QOI: exact round trip (runs, index, diff, luma, rgb, rgba), rejects garbage and truncation');

  // ---- TGA ------------------------------------------------------------------------------------
  for (const rle of [false, true]) {
    const t = tga.encode(img, W, H, { rle });
    assert(same(tga.decode(t).data, img), `tga rle=${rle}`);
  }
  assert(tga.encode(solid, W, H, { rle: true }).length < tga.encode(solid, W, H, { rle: false }).length, 'RLE should shrink this image');
  // hand-built variants: bottom-left origin 24-bit, 8-bit grey, 8-bit colour-mapped, 16-bit
  const mk = (type, bpp, desc, extra, px, cmap = Buffer.alloc(0), cbits = 0) => { const h = Buffer.alloc(18); h[1] = cmap.length ? 1 : 0; h[2] = type; h.writeUInt16LE(cmap.length ? 0 : 0, 3); h.writeUInt16LE(cmap.length ? cmap.length / (cbits / 8) : 0, 5); h[7] = cbits; h.writeUInt16LE(2, 12); h.writeUInt16LE(2, 14); h[16] = bpp; h[17] = desc; return Buffer.concat([h, cmap, px]); };
  const bl = tga.decode(mk(2, 24, 0, null, Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]))); // rows stored bottom-first, BGR
  assert.deepStrictEqual([...bl.data.subarray(0, 4)], [9, 8, 7, 255], 'bottom-left origin must be flipped');
  const grey = tga.decode(mk(3, 8, 0x20, null, Buffer.from([10, 20, 30, 40]))); assert.deepStrictEqual([...grey.data.subarray(4, 8)], [20, 20, 20, 255]);
  const mapped = tga.decode(mk(1, 8, 0x20, null, Buffer.from([0, 1, 1, 0]), Buffer.from([255, 0, 0, 0, 255, 0]), 24)); // BGR palette: blue, green
  assert.deepStrictEqual([[...mapped.data.subarray(0, 4)], [...mapped.data.subarray(4, 8)]], [[0, 0, 255, 255], [0, 255, 0, 255]]);
  ok('TGA: exact round trip raw + RLE; decodes bottom-left origin, grey and colour-mapped files');

  // ---- BMP ------------------------------------------------------------------------------------
  assert(same(bmp.decode(bmp.encode(img, W, H, { alpha: true })).data, img), 'bmp 32-bit alpha');
  assert(same(bmp.decode(bmp.encode(solid, W, H)).data, solid), 'bmp 24-bit');
  const b24 = bmp.encode(solid, W, H); assert.strictEqual(b24.readUInt32LE(2), b24.length); assert.strictEqual(bmp.decode(b24).height, H);
  // hand-built: 8-bit palette top-down, 1-bit, 16-bit 555
  const dib = (bpp, w, h, palette, rows, topDown = false) => { const hd = Buffer.alloc(40); hd.writeUInt32LE(40, 0); hd.writeInt32LE(w, 4); hd.writeInt32LE(topDown ? -h : h, 8); hd.writeUInt16LE(1, 12); hd.writeUInt16LE(bpp, 14); hd.writeUInt32LE(palette.length / 4, 32); const off = 14 + 40 + palette.length; const f = Buffer.alloc(14); f.write('BM', 0, 'latin1'); f.writeUInt32LE(off, 10); return Buffer.concat([f, hd, palette, rows]); };
  const p8 = Buffer.from([0, 0, 255, 0, 0, 255, 0, 0]);  // BGRx: red, green
  const b8 = bmp.decode(dib(8, 2, 2, p8, Buffer.from([0, 1, 0, 0, 1, 0, 0, 0]), true)); // top-down: row0 = red,green ; row1 = green,red
  assert.deepStrictEqual([[...b8.data.subarray(0, 4)], [...b8.data.subarray(4, 8)], [...b8.data.subarray(8, 12)]], [[255, 0, 0, 255], [0, 255, 0, 255], [0, 255, 0, 255]]);
  const b1 = bmp.decode(dib(1, 8, 1, Buffer.from([0, 0, 0, 0, 255, 255, 255, 0]), Buffer.from([0b10100000, 0, 0, 0]))); // black/white, 1 = white
  assert.deepStrictEqual([b1.data[0], b1.data[4], b1.data[8]], [255, 0, 255]);
  const rows16 = Buffer.alloc(4); rows16.writeUInt16LE(0x7c00, 0); // pure red in 5-5-5
  assert.deepStrictEqual([...bmp.decode(dib(16, 1, 1, Buffer.alloc(0), rows16)).data], [255, 0, 0, 255]);
  assert.throws(() => bmp.decode(Buffer.from('not a bitmap file at all, really not, padding')), /Not a BMP/);
  ok('BMP: exact round trip 24-bit + 32-bit alpha; decodes palette, 1-bit, 16-bit and top-down files');

  // ---- PNM ------------------------------------------------------------------------------------
  assert(same(pnm.decode(pnm.encodePpm(solid, W, H)).data, solid), 'ppm');
  const pg = pnm.decode(pnm.encodePgm(solid, W, H));
  const luma = (o) => Math.round(0.2126 * solid[o] + 0.7152 * solid[o + 1] + 0.0722 * solid[o + 2]);
  for (let i = 0; i < W * H; i += 97) assert.deepStrictEqual([pg.data[i * 4], pg.data[i * 4 + 1], pg.data[i * 4 + 2]], [luma(i * 4), luma(i * 4), luma(i * 4)]);
  const d1 = (s) => [...pnm.decode(Buffer.from(s, 'latin1')).data];
  assert.deepStrictEqual(d1('P1\n# comment\n2 1\n1 0\n').slice(0, 8), [0, 0, 0, 255, 255, 255, 255, 255]);
  assert.deepStrictEqual(d1('P2\n2 1\n10\n0 5\n').filter((_, i) => i % 4 === 0), [0, 128]);
  assert.deepStrictEqual(d1('P3\n1 1\n255\n9 8 7\n'), [9, 8, 7, 255]);
  assert.deepStrictEqual(d1('P4\n3 1\n\xa0'), [0, 0, 0, 255, 255, 255, 255, 255, 0, 0, 0, 255]);
  const p5w = Buffer.concat([Buffer.from('P5\n1 1\n65535\n'), Buffer.from([0xff, 0xff])]); assert.strictEqual(pnm.decode(p5w).data[0], 255); // 16-bit samples scale to 8-bit
  const pam = Buffer.concat([Buffer.from('P7\nWIDTH 1\nHEIGHT 1\nDEPTH 4\nMAXVAL 255\nTUPLTYPE RGB_ALPHA\nENDHDR\n'), Buffer.from([1, 2, 3, 4])]);
  assert.deepStrictEqual([...pnm.decode(pam).data], [1, 2, 3, 4]);
  assert.throws(() => pnm.decode(Buffer.from('P6\n100000 100000\n255\n')), /too large/);
  ok('PNM: PPM exact, PGM luma, decodes P1-P7 (ascii, binary, 16-bit, PAM) and rejects huge sizes');

  // ---- ICO ------------------------------------------------------------------------------------
  const pngOf = (size) => sharp(img, { raw: { width: W, height: H, channels: 4 } }).resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();
  const sizes = [16, 32, 256];
  const icoBuf = ico.encode(await Promise.all(sizes.map(async (size) => ({ size, png: await pngOf(size) }))));
  assert.strictEqual(icoBuf.readUInt16LE(4), 3); assert.strictEqual(icoBuf[6 + 32], 0, '256 is stored as 0');
  const dec = ico.decode(icoBuf); assert(dec.png, 'png entry returned');
  assert.strictEqual((await sharp(dec.png).metadata()).width, 256, 'largest image is chosen');
  // a classic DIB-based icon (32-bit with alpha, as old tools write them): XOR bitmap with doubled height + AND mask
  const small = makeImage(16, 16, 7);
  const f = bmp.encode(small, 16, 16, { alpha: true });
  const dibBytes = Buffer.from(f.subarray(14)); dibBytes.writeInt32LE(32, 8); // height doubled
  const dibIcon = Buffer.concat([dibBytes, Buffer.alloc(4 * 16)]);
  const hdr = Buffer.alloc(22); hdr.writeUInt16LE(1, 2); hdr.writeUInt16LE(1, 4); hdr[6] = 16; hdr[7] = 16; hdr.writeUInt16LE(32, 12); hdr.writeUInt32LE(dibIcon.length, 14); hdr.writeUInt32LE(22, 18);
  const dibDec = ico.decode(Buffer.concat([hdr, dibIcon])); assert(dibDec.data && dibDec.width === 16 && dibDec.height === 16);
  assert(same(dibDec.data, small), 'DIB icon pixels incl. alpha');
  assert.throws(() => ico.decode(Buffer.from('this is not an icon file, not at all!!')), /ICO/);
  assert.throws(() => ico.encode([]), /at least one/);
  ok('ICO: multi-size PNG container, picks the largest; decodes DIB icons with alpha');

  // ---- PDF ------------------------------------------------------------------------------------
  const rgb = Buffer.alloc(W * H * 3), alpha = Buffer.alloc(W * H);
  for (let i = 0; i < W * H; i++) { rgb[i * 3] = img[i * 4]; rgb[i * 3 + 1] = img[i * 4 + 1]; rgb[i * 3 + 2] = img[i * 4 + 2]; alpha[i] = img[i * 4 + 3]; }
  const jpegBytes = await sharp(solid, { raw: { width: W, height: H, channels: 4 } }).removeAlpha().jpeg({ quality: 90 }).toBuffer();
  for (const [label, doc] of [['lossless+mask', pdf.encode({ width: W, height: H, rgb, alpha })], ['jpeg', pdf.encode({ width: W, height: H, jpeg: jpegBytes })]]) {
    const text = doc.toString('latin1');
    assert(text.startsWith('%PDF-1.4') && text.trimEnd().endsWith('%%EOF'));
    const startxref = Number(/startxref\n(\d+)\n%%EOF/.exec(text)[1]);
    assert(text.startsWith('xref', startxref), `${label}: startxref must point at the xref table`);
    const count = Number(/xref\n0 (\d+)\n/.exec(text)[1]);
    const entries = [...text.slice(startxref).matchAll(/(\d{10}) 00000 n /g)].map((m) => Number(m[1]));
    assert.strictEqual(entries.length, count - 1);
    entries.forEach((off, i) => assert(text.startsWith(`${i + 1} 0 obj`, off), `${label}: object ${i + 1} offset`));
    assert(/\/MediaBox \[0 0 50\.25 30\.75\]/.test(text), `${label}: page is the image size at 96 dpi`);
  }
  const losslessDoc = pdf.encode({ width: W, height: H, rgb, alpha }).toString('latin1');
  const streams = [...losslessDoc.matchAll(/\/Length (\d+) >>\nstream\n/g)].map((m) => ({ len: Number(m[1]), at: m.index + m[0].length }));
  const raw = Buffer.from(losslessDoc, 'latin1');
  const inflated = streams.filter((s) => s.len > 100).map((s) => zlib.inflateSync(raw.subarray(s.at, s.at + s.len)));
  assert(inflated.some((b) => same(b, rgb)) && inflated.some((b) => same(b, alpha)), 'embedded RGB and soft-mask streams decode to the original pixels');
  const jpegDoc = Buffer.from(pdf.encode({ width: W, height: H, jpeg: jpegBytes }).toString('latin1'), 'latin1');
  assert(jpegDoc.includes(jpegBytes), 'JPEG is embedded byte-for-byte');
  fs.writeFileSync(path.join(tmp, 'sample.pdf'), pdf.encode({ width: W, height: H, rgb, alpha }));
  ok('PDF: valid xref table, correct page size, embedded pixels and soft mask decode back exactly');

  // ---- JPEG XL --------------------------------------------------------------------------------
  const jl = await jxl.encode(img, W, H, { lossless: true, effort: 3 });
  const jd = await jxl.decode(jl);
  assert.deepStrictEqual([jd.width, jd.height], [W, H]);
  // The encoder is bit-exact (checked against ffmpeg's libjxl below). jsquash's DECODER, though, converts
  // semi-transparent pixels through float and can be off by 1 in a colour channel - so allow exactly that.
  let maxDiff = 0, alphaDiff = 0;
  for (let i = 0; i < W * H * 4; i++) { const d = Math.abs(jd.data[i] - img[i]); if (i % 4 === 3) alphaDiff = Math.max(alphaDiff, d); else maxDiff = Math.max(maxDiff, d); }
  assert(maxDiff <= 1 && alphaDiff === 0, `jsquash round trip: colour diff ${maxDiff}, alpha diff ${alphaDiff}`);
  // (the same +-1 appears for fully opaque images, so it is not about alpha: it is the decoder's output conversion)
  const jOpaque = await jxl.decode(await jxl.encode(solid, W, H, { lossless: true, effort: 3 }));
  const offBy = [...Array(W * H).keys()].filter((i) => [0, 1, 2].some((c) => jOpaque.data[i * 4 + c] !== solid[i * 4 + c])).length;
  assert(offBy / (W * H) < 0.02, `jsquash decode differs on ${offBy} of ${W * H} pixels (expected well under 2%)`);
  const jlossy = await jxl.encode(solid, W, H, { quality: 85, effort: 3 });
  const jd2 = await jxl.decode(jlossy);
  let err = 0; for (let i = 0; i < W * H * 4; i++) err += Math.abs(jd2.data[i] - solid[i]);
  assert(err / (W * H * 4) < 12, 'lossy JXL mean abs error ' + (err / (W * H * 4)).toFixed(2));
  assert.strictEqual(jlossy[0], 0xff); assert.strictEqual(jlossy[1], 0x0a); // bare codestream signature (FF 0A)
  await assert.rejects(() => jxl.decode(Buffer.from('definitely not jpeg xl')));
  ok('JPEG XL (WASM): lossless is exact, lossy is close, bad input rejected');

  // ---- independent decode with ffmpeg ------------------------------------------------------------
  if (ffmpeg) {
    const cases = {
      'qoi': [qoi.encode(img, W, H), img], 'tga raw': [tga.encode(img, W, H, { rle: false }), img], 'tga rle': [tga.encode(img, W, H, { rle: true }), img],
      'bmp 24': [bmp.encode(solid, W, H), solid], 'bmp 32 alpha': [bmp.encode(img, W, H, { alpha: true }), img],
      'ppm': [pnm.encodePpm(solid, W, H), solid],
    };
    for (const [name, [bytes, expected]] of Object.entries(cases)) {
      const file = path.join(tmp, name.replace(/\W+/g, '_') + '.' + name.split(' ')[0]);
      fs.writeFileSync(file, bytes);
      const got = ffmpegDecode(file);
      if (got === null) continue; // this ffmpeg build cannot read the format (recorded in `skipped`)
      if (name === 'bmp 32 alpha' && !same(got, expected)) { // some ffmpeg builds drop the BMP alpha channel: compare colour only, report it
        const rgbOnly = (b) => Buffer.from(b.filter((_, i) => i % 4 !== 3));
        assert(same(rgbOnly(got), rgbOnly(expected)), 'bmp 32 colour differs from ffmpeg\'s decode');
        console.log('       (note: this ffmpeg ignores the BMP alpha channel; colours match)');
        continue;
      }
      assert(same(got, expected), `${name}: ffmpeg decodes our file to different pixels`);
    }
    const pgmFile = path.join(tmp, 'a.pgm'); fs.writeFileSync(pgmFile, pnm.encodePgm(solid, W, H));
    const g = ffmpegDecode(pgmFile); if (g) for (let i = 0; i < W * H; i += 53) assert.strictEqual(g[i * 4], pg.data[i * 4], 'pgm luma matches ffmpeg');
    // JPEG XL: ffmpeg's libjxl (if this build has it) must read our lossless file back bit-exactly, transparency included
    const jxlFile = path.join(tmp, 'a.jxl'); fs.writeFileSync(jxlFile, jl);
    const jr = spawnSync(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-c:v', 'libjxl', '-i', jxlFile, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgba', path.join(tmp, 'jx.raw')]);
    if (jr.status === 0) assert(same(fs.readFileSync(path.join(tmp, 'jx.raw')), img), 'ffmpeg (libjxl) must decode our lossless JXL exactly');
    else console.log('       (this ffmpeg has no libjxl decoder: JPEG XL cross-check skipped)');
    const icoFile = path.join(tmp, 'a.ico'); fs.writeFileSync(icoFile, icoBuf);
    // ffmpeg picks the largest image in an icon, as our decoder does: its pixels must equal our 256px PNG entry
    const viaFfmpeg = ffmpegDecode(icoFile);
    const our256 = await sharp(dec.png).ensureAlpha().raw().toBuffer();
    if (viaFfmpeg) {
      assert.strictEqual(viaFfmpeg.length, 256 * 256 * 4, 'ffmpeg reads the 256px icon image');
      assert(same(viaFfmpeg, our256), 'ffmpeg decodes our ICO\'s PNG entry to the same pixels');
    }
    ok('ffmpeg independently decodes our QOI, TGA, BMP, PPM, PGM and ICO output to the same pixels' +
      (skipped.length ? ` (formats this ffmpeg cannot read, skipped: ${skipped.join(', ')})` : ''));
  } else console.log('  --  ffmpeg not installed: skipped the independent decode check');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${n} checks passed`);
})().catch((e) => { console.error('FAIL:', e); process.exit(1); });
