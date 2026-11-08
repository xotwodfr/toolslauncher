'use strict';
// End-to-end tests of convertOne() for every output format and option, plus the new input formats.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sharp = require('sharp');
const { convertOne, normalizeOptions, INPUT_EXTS } = require('../src/convert');
const { FORMATS, OPTIONS, describe } = require('../src/formats');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-formats-'));
let n = 0;
const ok = (m) => { n++; console.log('  ok  ' + m); };
const SW = 96, SH = 64;

// Source: left part opaque, a semi-transparent stripe on top, right third fully transparent (with garbage colour).
function makeSource(opaque) {
  const d = Buffer.alloc(SW * SH * 4);
  for (let y = 0; y < SH; y++) for (let x = 0; x < SW; x++) {
    const o = (y * SW + x) * 4;
    d[o] = (x * 2) & 255; d[o + 1] = (y * 3) & 255; d[o + 2] = (x + y) & 255;
    d[o + 3] = opaque ? 255 : x >= 64 ? 0 : y < 8 ? 128 : 255;
    if (!opaque && x >= 64) { d[o] = 255; d[o + 1] = 0; d[o + 2] = 255; }
  }
  return d;
}
const rawOf = async (file) => { const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true }); return { data, w: info.width, h: info.height }; };
const mean = (a, b, onlyVisible, ref) => { let s = 0, c = 0; for (let i = 0; i < a.length; i += 4) { if (onlyVisible && ref[i + 3] === 0) continue; for (let k = 0; k < 3; k++) { s += Math.abs(a[i + k] - b[i + k]); c++; } } return s / c; };
const eq = (a, b) => Buffer.compare(a, b) === 0;

(async () => {
  const srcFile = path.join(tmp, 'src.png');
  const opaqueFile = path.join(tmp, 'opaque.png');
  await sharp(makeSource(false), { raw: { width: SW, height: SH, channels: 4 } }).png().toFile(srcFile);
  await sharp(makeSource(true), { raw: { width: SW, height: SH, channels: 4 } }).png().toFile(opaqueFile);
  const src = (await rawOf(srcFile)).data;
  const BG = '#336699', bgRgb = [0x33, 0x66, 0x99];
  const flat = (await sharp(srcFile).flatten({ background: BG }).ensureAlpha().raw().toBuffer());
  const outDir = path.join(tmp, 'out');
  const conv = (fmt, extra = {}, file = srcFile) => convertOne(file, { format: fmt, outDir, background: BG, ...extra });
  // decode any produced file back to RGBA through the app's own input path (our decoders for the non-sharp formats)
  const back = async (file) => {
    const ext = path.extname(file).toLowerCase();
    if (['.jpg', '.png', '.webp', '.gif', '.avif', '.tiff'].includes(ext)) return rawOf(file);
    return rawOf((await convertOne(file, { format: 'png', outDir: path.join(tmp, 'back') })).output);
  };

  // ---- the registry itself ------------------------------------------------------------------------
  const d = describe();
  assert.strictEqual(d.formats.length, 14);
  assert.strictEqual(new Set(d.formats.map((f) => f.ext)).size, 14, 'extensions are unique');
  assert.strictEqual(new Set(d.formats.map((f) => f.label)).size, 14, 'labels are unique');
  for (const f of d.formats) {
    for (const o of f.options) {
      assert(OPTIONS[o.name], `${f.id} references unknown option ${o.name}`);
      for (const [dep, v] of Object.entries(o.when || {})) {
        assert(f.options.some((x) => x.name === dep) && OPTIONS[dep], `${f.id}.${o.name} depends on ${dep}, which that format must also show`);
        const spec = OPTIONS[dep]; assert(spec.type === 'bool' ? typeof v === 'boolean' : (spec.choices || []).includes(v), `${f.id}.${o.name}: "${dep}" can never be ${v}`);
      }
    }
    assert.strictEqual(typeof f.meta, 'boolean');
  }
  for (const [name, o] of Object.entries(OPTIONS)) assert(o.label && o.type && 'default' in o, `option ${name} is fully described`);
  ok('registry: 14 formats, unique names, every option defined');

  // ---- every output format converts to a file that decodes back with the right size -------------------
  const results = {};
  for (const id of Object.keys(FORMATS)) {
    const r = await conv(id, { icoSizes: [16, 32] });
    results[id] = r;
    assert.strictEqual(path.extname(r.output), FORMATS[id].ext, `${id} extension`);
    assert(r.outBytes > 0 && fs.statSync(r.output).size === r.outBytes, `${id} size reported correctly`);
    if (id === 'pdf') { const t = fs.readFileSync(r.output).toString('latin1'); assert(t.startsWith('%PDF-') && t.trimEnd().endsWith('%%EOF')); continue; }
    if (id === 'ico') { const b = fs.readFileSync(r.output); assert.strictEqual(b.readUInt16LE(4), 2); continue; }
    const got = await back(r.output);
    assert.deepStrictEqual([got.w, got.h], [SW, SH], `${id} decodes back at the original size`);
  }
  ok('all 14 outputs are written and decode back at the right size');

  // ---- fidelity: lossless formats are exact, lossy ones are close ------------------------------------
  const visibleExact = (a, b) => { for (let i = 0; i < a.length; i += 4) { if (a[i + 3] !== b[i + 3]) return false; if (a[i + 3] > 0 && (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2])) return false; } return true; };
  for (const id of ['png', 'tiff', 'qoi', 'tga']) assert(visibleExact((await back(results[id].output)).data, src), `${id} keeps pixels and transparency exactly`);
  assert(visibleExact((await back((await conv('bmp', { bmpAlpha: true })).output)).data, src), 'bmp 32-bit keeps pixels and transparency exactly');
  assert(eq((await back(results.bmp.output)).data, flat), 'bmp 24-bit equals the image flattened on the background');
  assert(eq((await back(results.ppm.output)).data, flat), 'ppm equals the image flattened on the background');
  const pgm = (await back(results.pgm.output)).data;
  for (let i = 0; i < SW * SH; i += 41) { const l = Math.round(0.2126 * flat[i * 4] + 0.7152 * flat[i * 4 + 1] + 0.0722 * flat[i * 4 + 2]); assert.strictEqual(pgm[i * 4], l, 'pgm is the luma of the flattened image'); }
  const jpgBack = (await back(results.jpeg.output)).data;
  assert(mean(jpgBack, flat, false) < 6, 'jpeg is close to the flattened image: ' + mean(jpgBack, flat, false).toFixed(2));
  const jpgPx = (x, y) => [...jpgBack.subarray((y * SW + x) * 4, (y * SW + x) * 4 + 3)];
  assert(jpgPx(80, 40).every((v, i) => Math.abs(v - bgRgb[i]) < 8), 'transparent area became the chosen background colour');
  for (const id of ['webp', 'avif', 'jxl']) {
    const g = (await back(results[id].output)).data;
    assert(mean(g, src, true, src) < 14, `${id} lossy visible-pixel error ${mean(g, src, true, src).toFixed(2)}`);
    let aErr = 0; for (let i = 3; i < g.length; i += 4) aErr = Math.max(aErr, Math.abs(g[i] - src[i]));
    assert(aErr <= 3, `${id} keeps transparency (max alpha error ${aErr})`);
  }
  const gifBack = (await back(results.gif.output)).data;
  assert(gifBack[(40 * SW + 80) * 4 + 3] === 0 && gifBack[(40 * SW + 10) * 4 + 3] === 255, 'gif keeps on/off transparency');
  ok('fidelity: png/tiff/qoi/tga/bmp32 exact; bmp24/ppm/pgm flatten correctly; jpeg/webp/avif/jxl close; gif transparency');

  // ---- options -------------------------------------------------------------------------------------
  const uniq = (buf, visibleOnly) => { const s = new Set(); for (let i = 0; i < buf.length; i += 4) if (!visibleOnly || buf[i + 3] > 0) s.add(buf.readUInt32LE(i)); return s.size; };
  const noisy = path.join(tmp, 'noisy.png'); await sharp(makeSource(true), { raw: { width: SW, height: SH, channels: 4 } }).blur(0.6).png().toFile(noisy);
  const full = await conv('png', { palette: false }, noisy), pal = await conv('png', { palette: true, colors: 16 }, noisy);
  assert(pal.outBytes < full.outBytes / 2, `png palette is much smaller (${pal.outBytes} vs ${full.outBytes})`);
  assert(uniq((await rawOf(pal.output)).data) <= 16, 'png palette honours the colour count');
  const gif4 = await conv('gif', { colors: 4 }, noisy); assert(uniq((await rawOf(gif4.output)).data, true) <= 4, 'gif honours the colour count');
  const gif256 = await conv('gif', { colors: 256 }, noisy); assert(gif256.outBytes > gif4.outBytes * 2, 'more colours -> bigger gif');
  assert.strictEqual((await sharp((await conv('jpeg', { progressive: true })).output).metadata()).isProgressive, true);
  assert.strictEqual((await sharp((await conv('jpeg', { progressive: false })).output).metadata()).isProgressive, false);
  const q10 = await conv('jpeg', { quality: 10 }, noisy), q95 = await conv('jpeg', { quality: 95 }, noisy);
  assert(q95.outBytes > q10.outBytes * 2, 'jpeg quality changes the size');
  const wl = await conv('webp', { lossless: true }, opaqueFile);
  assert(eq((await rawOf(wl.output)).data, (await rawOf(opaqueFile)).data), 'webp lossless is exact');
  const al = await conv('avif', { lossless: true }, opaqueFile);
  const alMean = mean((await rawOf(al.output)).data, (await rawOf(opaqueFile)).data, false);
  assert(alMean < 1.5, 'avif lossless is (near) exact: mean error ' + alMean.toFixed(3));
  // read TIFF tag 259 (Compression) straight from the first IFD: 1 = none, 5 = LZW, 7 = JPEG, 8 / 32946 = Deflate
  const tiffTag = (file) => {
    const b = fs.readFileSync(file), le = b.toString('latin1', 0, 2) === 'II';
    const u16 = (o) => (le ? b.readUInt16LE(o) : b.readUInt16BE(o)), u32 = (o) => (le ? b.readUInt32LE(o) : b.readUInt32BE(o));
    const ifd = u32(4); const count = u16(ifd);
    for (let i = 0; i < count; i++) { const e = ifd + 2 + i * 12; if (u16(e) === 259) return u16(e + 8); }
    return null;
  };
  const wantTag = { lzw: [5], deflate: [8, 32946], jpeg: [7], none: [1] };
  for (const c of ['lzw', 'deflate', 'jpeg', 'none']) assert(wantTag[c].includes(tiffTag((await conv('tiff', { tiffCompression: c })).output)), `tiff ${c}: wrong compression tag`);
  const tl = await conv('tiff', { tiffCompression: 'lzw' }, noisy), tn = await conv('tiff', { tiffCompression: 'none' }, noisy);
  assert(tl.outBytes < tn.outBytes, 'tiff LZW is smaller than uncompressed');
  const sizes = await conv('ico', { icoSizes: [256, 16, 48] });
  const icoB = fs.readFileSync(sizes.output);
  assert.deepStrictEqual([0, 1, 2].map((i) => icoB[6 + i * 16] || 256), [16, 48, 256], 'ico entries are the requested sizes, smallest first');
  assert.strictEqual(sizes.width, 256);
  const flatFile = path.join(tmp, 'flat.png'); await sharp({ create: { width: SW, height: SH, channels: 4, background: { r: 10, g: 120, b: 200, alpha: 1 } } }).png().toFile(flatFile);
  const tgaRaw = await conv('tga', { rle: false }, flatFile), tgaRle = await conv('tga', { rle: true }, flatFile);
  assert.strictEqual(tgaRaw.outBytes, 18 + SW * SH * 4 + 26, 'tga without RLE has the exact raw size');
  assert(tgaRle.outBytes < tgaRaw.outBytes / 10, `tga RLE shrinks a flat image a lot (${tgaRle.outBytes} vs ${tgaRaw.outBytes})`);
  assert(eq((await back(tgaRle.output)).data, (await rawOf(flatFile)).data), 'RLE output decodes back exactly');
  // photo-like texture (a smooth synthetic gradient is a bad test: lossless can beat lossy on it)
  const texFile = path.join(tmp, 'texture.png'); { let s = 99; const t = Buffer.alloc(SW * SH * 3); for (let i = 0; i < t.length; i++) t[i] = ((s = (s * 1664525 + 1013904223) >>> 0) >>> 16) & 255; await sharp(t, { raw: { width: SW, height: SH, channels: 3 } }).blur(1.2).png().toFile(texFile); }
  const jxlLoss = await conv('jxl', { lossless: true }, texFile), jxlLossy = await conv('jxl', { quality: 40 }, texFile);
  assert(jxlLossy.outBytes < jxlLoss.outBytes / 2, `jxl lossy is much smaller than lossless (${jxlLossy.outBytes} vs ${jxlLoss.outBytes})`);
  const pdfJ = await conv('pdf', { pdfMode: 'jpeg' }), pdfL = await conv('pdf', { pdfMode: 'lossless' });
  assert(fs.readFileSync(pdfJ.output).includes(Buffer.from('/DCTDecode')) && !fs.readFileSync(pdfJ.output).includes(Buffer.from('/SMask')));
  assert(fs.readFileSync(pdfL.output).includes(Buffer.from('/SMask')), 'lossless pdf of a transparent image carries a soft mask');
  assert(!fs.readFileSync((await conv('pdf', { pdfMode: 'lossless' }, opaqueFile)).output).includes(Buffer.from('/SMask')), 'no soft mask when the image is opaque');
  ok('options: png palette, gif colours, jpeg progressive/quality, webp+avif lossless, tiff compression, ico sizes, tga rle, jxl, pdf modes');

  // ---- resize + metadata still apply to the new formats ------------------------------------------------
  for (const id of ['qoi', 'bmp', 'jxl', 'pdf']) {
    const r = await conv(id, { resize: { enabled: true, width: 48, height: null } });
    assert.deepStrictEqual([r.width, r.height], [48, 32], `${id} resize keeps the aspect ratio`);
  }
  ok('resize works for the new formats');

  // ---- new INPUT formats: convert to X, then use X as the input again ----------------------------------
  for (const id of ['bmp', 'tga', 'qoi', 'ppm', 'pgm', 'ico', 'jxl']) assert(INPUT_EXTS.includes(FORMATS[id].ext), `${id} can also be read`);
  const expectFromBmp = (await back((await conv('bmp', { bmpAlpha: true })).output)).data;
  assert(visibleExact(expectFromBmp, src), 'bmp -> png keeps everything');
  const icoRead = await rawOf((await convertOne(results.ico.output, { format: 'png', outDir: path.join(tmp, 'back') })).output);
  assert.deepStrictEqual([icoRead.w, icoRead.h], [32, 32], 'ico input yields its largest image');
  ok('new input formats (bmp, tga, qoi, ppm, pgm, ico, jxl) are read back correctly');

  // ---- robustness ------------------------------------------------------------------------------------------
  const evil = path.join(tmp, 'huge.ppm'); fs.writeFileSync(evil, 'P6\n100000 100000\n255\n');
  await assert.rejects(() => convertOne(evil, { format: 'png', outDir }), /too large|invalid/i);
  const trunc = path.join(tmp, 'trunc.qoi'); fs.writeFileSync(trunc, fs.readFileSync(results.qoi.output).subarray(0, 60));
  await assert.rejects(() => convertOne(trunc, { format: 'png', outDir }), /truncated/);
  const junk = path.join(tmp, 'junk.tga'); fs.writeFileSync(junk, Buffer.alloc(40, 7));
  await assert.rejects(() => convertOne(junk, { format: 'png', outDir }));
  const junkIco = path.join(tmp, 'junk.ico'); fs.writeFileSync(junkIco, Buffer.alloc(40, 1));
  await assert.rejects(() => convertOne(junkIco, { format: 'png', outDir }));
  assert.deepStrictEqual(normalizeOptions({ format: 'ico', icoSizes: [999, 'x', -1] }).icoSizes, OPTIONS.icoSizes.default, 'bad ico sizes fall back to the defaults');
  assert.deepStrictEqual(normalizeOptions({ format: 'ico', icoSizes: [32, 16, 32] }).icoSizes, [16, 32]);
  assert.strictEqual(normalizeOptions({ format: 'jpeg', background: 'red; background:url(x)' }).background, '#ffffff');
  assert.strictEqual(normalizeOptions({ format: 'png', colors: 7 }).colors, 256);
  assert.strictEqual(normalizeOptions({ format: 'png', colors: 64 }).colors, 256, 'sizes libvips cannot honour are not accepted');
  assert.strictEqual(normalizeOptions({ format: 'png', colors: 16 }).colors, 16);
  assert.strictEqual(normalizeOptions({ format: 'tiff', tiffCompression: 'evil' }).tiffCompression, 'lzw');
  assert.strictEqual(normalizeOptions({ format: 'pdf', pdfMode: {} }).pdfMode, 'jpeg');
  assert.throws(() => normalizeOptions({ format: 'exe' }), /Unsupported/);
  ok('robustness: huge/truncated/garbage inputs rejected, hostile option values fall back to safe defaults');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${n} checks passed`);
})().catch((e) => { console.error('FAIL:', e); process.exit(1); });
