'use strict';
// Photo details (metadata) and file writing, in the main process. Plain Node (zlib only).
//
// The window decodes the photo with the browser engine, which turns it upright (EXIF orientation) and hands over plain pixels;
// the browser's encoders write no metadata at all. So this module
//   - reads EXIF, XMP and the ICC colour profile out of the original JPEG / PNG / WebP file,
//   - cleans the EXIF for the edited picture: orientation set to "upright" (the pixels already are), the embedded thumbnail
//     removed (it would still show the old picture, including what the user removed) and the stored pixel size updated,
//   - writes them into the new JPEG / WebP (from the window's encoder) or into a PNG it encodes itself (lossless and exact).
// The ICC profile is always kept (the pixels are the file's own colour values, not converted); EXIF and XMP only on request.
const zlib = require('zlib');

// ---- small binary helpers -------------------------------------------------------------------------------------------------
const CRC_TABLE = (() => { const t = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; } return t; })();
function crc32(buf, crc = -1) { for (let i = 0; i < buf.length; i++) crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8); return crc; }
const EXIF_HEADER = Buffer.from('Exif\0\0', 'latin1');
const XMP_HEADER = Buffer.from('http://ns.adobe.com/xap/1.0/\0', 'latin1');
const ICC_HEADER = Buffer.from('ICC_PROFILE\0', 'latin1');
const startsWith = (buf, head, at = 0) => buf.length >= at + head.length && buf.compare(head, 0, head.length, at, at + head.length) === 0;

// ---- reading -------------------------------------------------------------------------------------------------------------
/** @returns {{ exif: Buffer|null, xmp: Buffer|null, icc: Buffer|null }} EXIF as a bare TIFF block, XMP as UTF-8, ICC raw. */
function readMeta(bytes) {
  const b = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = { exif: null, xmp: null, icc: null };
  try {
    if (b[0] === 0xff && b[1] === 0xd8) readJpeg(b, out);
    else if (b.length > 8 && b.readUInt32BE(0) === 0x89504e47) readPng(b, out);
    else if (b.length > 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') readWebp(b, out);
  } catch { /* a damaged block: keep what was found */ }
  return out;
}
function readJpeg(b, out) {
  let p = 2; const icc = [];
  while (p + 4 <= b.length) {
    if (b[p] !== 0xff) break;
    const marker = b[p + 1];
    if (marker === 0xff) { p++; continue; }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) { p += 2; continue; }
    if (marker === 0xda || marker === 0xd9) break;                 // start of scan: no more metadata
    const len = b.readUInt16BE(p + 2);
    const seg = b.subarray(p + 4, p + 2 + len);
    if (marker === 0xe1 && startsWith(seg, EXIF_HEADER) && !out.exif) out.exif = Buffer.from(seg.subarray(6));
    else if (marker === 0xe1 && startsWith(seg, XMP_HEADER) && !out.xmp) out.xmp = Buffer.from(seg.subarray(XMP_HEADER.length));
    else if (marker === 0xe2 && startsWith(seg, ICC_HEADER)) icc.push({ seq: seg[12], data: seg.subarray(14) });
    p += 2 + len;
  }
  if (icc.length) out.icc = Buffer.concat(icc.sort((a, c) => a.seq - c.seq).map((c) => c.data));
}
function readPng(b, out) {
  let p = 8;
  while (p + 12 <= b.length) {
    const len = b.readUInt32BE(p); const type = b.toString('latin1', p + 4, p + 8); const data = b.subarray(p + 8, p + 8 + len);
    if (type === 'eXIf' && !out.exif) out.exif = Buffer.from(startsWith(data, EXIF_HEADER) ? data.subarray(6) : data);
    else if (type === 'iCCP' && !out.icc) { const z = data.indexOf(0); out.icc = zlib.inflateSync(data.subarray(z + 2)); }
    else if (type === 'iTXt' && !out.xmp) {
      const z = data.indexOf(0);
      if (data.toString('latin1', 0, z) === 'XML:com.adobe.xmp') {
        const compressed = data[z + 1]; let q = z + 3;
        q = data.indexOf(0, q) + 1; q = data.indexOf(0, q) + 1;       // language tag, translated keyword
        out.xmp = compressed ? zlib.inflateSync(data.subarray(q)) : Buffer.from(data.subarray(q));
      }
    } else if (type === 'IDAT' || type === 'IEND') { if (type === 'IEND') break; }
    p += 12 + len;
  }
}
function readWebp(b, out) {
  let p = 12;
  while (p + 8 <= b.length) {
    const type = b.toString('latin1', p, p + 4); const len = b.readUInt32LE(p + 4); const data = b.subarray(p + 8, p + 8 + len);
    if (type === 'EXIF' && !out.exif) out.exif = Buffer.from(startsWith(data, EXIF_HEADER) ? data.subarray(6) : data);
    else if (type === 'XMP ' && !out.xmp) out.xmp = Buffer.from(data);
    else if (type === 'ICCP' && !out.icc) out.icc = Buffer.from(data);
    p += 8 + len + (len & 1);
  }
}

// ---- EXIF (TIFF) ---------------------------------------------------------------------------------------------------------
const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8 };
function tiffReader(t) {
  const le = t.toString('latin1', 0, 2) === 'II';
  if (!le && t.toString('latin1', 0, 2) !== 'MM') throw new Error('not TIFF');
  return {
    le,
    u16: (o) => (le ? t.readUInt16LE(o) : t.readUInt16BE(o)),
    u32: (o) => (le ? t.readUInt32LE(o) : t.readUInt32BE(o)),
    w16: (o, v) => (le ? t.writeUInt16LE(v, o) : t.writeUInt16BE(v, o)),
    w32: (o, v) => (le ? t.writeUInt32LE(v, o) : t.writeUInt32BE(v, o)),
  };
}
/** Entries of the IFD at `off`: [{ tag, type, count, at (entry offset), valueAt }], plus the offset of its "next IFD" field. */
function ifd(t, r, off) {
  if (!off || off + 2 > t.length) return { entries: [], nextAt: -1 };
  const n = r.u16(off); const entries = [];
  for (let i = 0; i < n; i++) {
    const at = off + 2 + i * 12; if (at + 12 > t.length) break;
    const type = r.u16(at + 2); const count = r.u32(at + 4); const size = (TYPE_SIZE[type] || 1) * count;
    entries.push({ tag: r.u16(at), type, count, at, valueAt: size <= 4 ? at + 8 : r.u32(at + 8) });
  }
  return { entries, nextAt: off + 2 + n * 12 };
}
const intValue = (r, e) => (e.type === 3 ? r.u16(e.valueAt) : r.u32(e.valueAt));

/** What a TIFF/EXIF block says, for the window: { orientation, camera, date, gps }. */
function exifSummary(tiff) {
  const s = { orientation: 1, camera: '', date: '', gps: false };
  if (!tiff) return s;
  try {
    const t = Buffer.from(tiff); const r = tiffReader(t);
    const str = (e) => t.toString('latin1', e.valueAt, e.valueAt + e.count).replace(/\0+$/, '').trim();
    const ifd0 = ifd(t, r, r.u32(4));
    let make = ''; let model = '';
    for (const e of ifd0.entries) {
      if (e.tag === 0x0112) s.orientation = intValue(r, e);
      if (e.tag === 0x010f && e.type === 2) make = str(e);
      if (e.tag === 0x0110 && e.type === 2) model = str(e);
      if (e.tag === 0x0132 && e.type === 2 && !s.date) s.date = str(e);
      if (e.tag === 0x8825 && intValue(r, e) > 0) s.gps = true;
      if (e.tag === 0x8769) for (const x of ifd(t, r, intValue(r, e)).entries) if (x.tag === 0x9003 && x.type === 2) s.date = str(x);
    }
    s.camera = model.toLowerCase().startsWith(make.toLowerCase()) ? model : [make, model].filter(Boolean).join(' ');
  } catch { /* unreadable: defaults */ }
  return s;
}

/**
 * EXIF for the edited picture: a copy with Orientation = 1, the thumbnail (IFD1) unlinked AND its bytes zeroed (so the old
 * picture cannot be recovered from the file), and the Exif pixel size updated to width x height. Returns null if the block
 * cannot be read.
 */
function cleanExif(tiff, width, height) {
  try {
    const t = Buffer.from(tiff); const r = tiffReader(t);
    const ifd0 = ifd(t, r, r.u32(4));
    for (const e of ifd0.entries) {
      if (e.tag === 0x0112 && e.type === 3) r.w16(e.valueAt, 1);
      if (e.tag === 0x8769) {
        for (const x of ifd(t, r, intValue(r, e)).entries) {
          const v = x.tag === 0xa002 ? width : x.tag === 0xa003 ? height : null;
          if (v == null) continue;
          if (x.type === 4) r.w32(x.valueAt, v); else if (x.type === 3 && v <= 0xffff) r.w16(x.valueAt, v);
        }
      }
    }
    if (ifd0.nextAt > 0 && ifd0.nextAt + 4 <= t.length) {
      const ifd1Off = r.u32(ifd0.nextAt);
      if (ifd1Off) {
        const ifd1 = ifd(t, r, ifd1Off);
        const get = (tag) => ifd1.entries.find((e) => e.tag === tag);
        const wipe = (off, len) => { if (off > 0 && len > 0 && off + len <= t.length) t.fill(0, off, off + len); };
        const jo = get(0x0201); const jl = get(0x0202);
        if (jo && jl) wipe(intValue(r, jo), intValue(r, jl));
        const so = get(0x0111); const sc = get(0x0117);           // an uncompressed thumbnail (strips)
        if (so && sc) for (let i = 0; i < Math.min(so.count, sc.count); i++) {
          const o = so.count === 1 ? intValue(r, so) : (so.type === 3 ? r.u16(so.valueAt + i * 2) : r.u32(so.valueAt + i * 4));
          const l = sc.count === 1 ? intValue(r, sc) : (sc.type === 3 ? r.u16(sc.valueAt + i * 2) : r.u32(sc.valueAt + i * 4));
          wipe(o, l);
        }
        // wipe IFD1's own entries too, then unlink it
        if (ifd1.nextAt > 0) t.fill(0, ifd1Off, Math.min(t.length, ifd1.nextAt + 4));
        r.w32(ifd0.nextAt, 0);
      }
    }
    return t;
  } catch { return null; }
}

// ---- writing: JPEG -------------------------------------------------------------------------------------------------------
function segment(marker, payload) { const h = Buffer.alloc(4); h[0] = 0xff; h[1] = marker; h.writeUInt16BE(payload.length + 2, 2); return Buffer.concat([h, payload]); }
/** Insert metadata segments into a JPEG (after SOI and any JFIF APP0). Existing EXIF/XMP/ICC segments are dropped first. */
function jpegWithMeta(jpeg, meta) {
  const b = Buffer.from(jpeg);
  const parts = [b.subarray(0, 2)]; let p = 2; const kept = [];
  while (p + 4 <= b.length && b[p] === 0xff) {
    const marker = b[p + 1];
    if (marker === 0xda) break;
    const len = b.readUInt16BE(p + 2); const seg = b.subarray(p, p + 2 + len); const body = seg.subarray(4);
    const isMeta = (marker === 0xe1 && (startsWith(body, EXIF_HEADER) || startsWith(body, XMP_HEADER))) || (marker === 0xe2 && startsWith(body, ICC_HEADER));
    if (!isMeta) kept.push({ marker, seg });
    p += 2 + len;
  }
  const add = [];
  if (meta.exif && meta.exif.length + 8 <= 65533) add.push(segment(0xe1, Buffer.concat([EXIF_HEADER, meta.exif])));
  if (meta.xmp && meta.xmp.length + XMP_HEADER.length + 2 <= 65533) add.push(segment(0xe1, Buffer.concat([XMP_HEADER, meta.xmp])));
  if (meta.icc && meta.icc.length) {
    const max = 65519; const n = Math.ceil(meta.icc.length / max);
    if (n <= 255) for (let i = 0; i < n; i++) add.push(segment(0xe2, Buffer.concat([ICC_HEADER, Buffer.from([i + 1, n]), meta.icc.subarray(i * max, (i + 1) * max)])));
  }
  const app0 = kept.filter((k) => k.marker === 0xe0).map((k) => k.seg);
  const rest = kept.filter((k) => k.marker !== 0xe0).map((k) => k.seg);
  parts.push(...app0, ...add, ...rest, b.subarray(p));
  return Buffer.concat(parts);
}

// ---- writing: PNG (our own encoder: exact, lossless) -----------------------------------------------------------------------
function chunk(type, data) {
  const head = Buffer.alloc(8); head.writeUInt32BE(data.length, 0); head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4); crc.writeInt32BE(~crc32(data, crc32(head.subarray(4))) | 0, 0);
  return Buffer.concat([head, data, crc]);
}
/** Filter the rows (adaptive per row: the filter with the smallest sum of absolute values, as libpng does). */
function filterRows(rgba, w, h, bpp) {
  const stride = w * bpp; const out = Buffer.alloc((stride + 1) * h);
  const line = Buffer.alloc(stride); const prev = Buffer.alloc(stride); const cand = [Buffer.alloc(stride), Buffer.alloc(stride), Buffer.alloc(stride), Buffer.alloc(stride), Buffer.alloc(stride)];
  for (let y = 0; y < h; y++) {
    if (bpp === 4) for (let i = 0; i < stride; i++) line[i] = rgba[y * stride + i];
    else for (let x = 0, s = y * w * 4, d = 0; x < w; x++, s += 4) { line[d++] = rgba[s]; line[d++] = rgba[s + 1]; line[d++] = rgba[s + 2]; }
    let best = 0; let bestSum = Infinity;
    for (let f = 0; f < 5; f++) {
      const c = cand[f]; let sum = 0;
      for (let i = 0; i < stride; i++) {
        const a = i >= bpp ? line[i - bpp] : 0; const up = y ? prev[i] : 0; const ul = y && i >= bpp ? prev[i - bpp] : 0;
        let pred = 0;
        if (f === 1) pred = a; else if (f === 2) pred = up; else if (f === 3) pred = (a + up) >> 1;
        else if (f === 4) { const p = a + up - ul; const pa = Math.abs(p - a); const pb = Math.abs(p - up); const pc = Math.abs(p - ul); pred = pa <= pb && pa <= pc ? a : pb <= pc ? up : ul; }
        const v = (line[i] - pred) & 0xff; c[i] = v; sum += v < 128 ? v : 256 - v;
        if (sum >= bestSum) break;
      }
      if (sum < bestSum) { bestSum = sum; best = f; }
    }
    // recompute the winner fully (the loop above may have stopped early for it only if it lost, so cand[best] is complete)
    out[y * (stride + 1)] = best; cand[best].copy(out, y * (stride + 1) + 1);
    line.copy(prev);
  }
  return out;
}
/** Encode RGBA pixels as PNG (RGB when fully opaque), with the given metadata. Async: compression runs off the main thread. */
async function encodePng(rgba, w, h, meta = {}) {
  let opaque = true; for (let i = 3; i < rgba.length; i += 4) if (rgba[i] !== 255) { opaque = false; break; }
  const bpp = opaque ? 3 : 4;
  const raw = filterRows(rgba, w, h, bpp);
  const idat = await new Promise((res, rej) => zlib.deflate(raw, { level: 6, memLevel: 9 }, (e, d) => (e ? rej(e) : res(d))));
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = opaque ? 2 : 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const parts = [Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr)];
  if (meta.icc && meta.icc.length) parts.push(chunk('iCCP', Buffer.concat([Buffer.from('ICC Profile\0\0', 'latin1'), zlib.deflateSync(meta.icc)])));
  if (meta.exif && meta.exif.length) parts.push(chunk('eXIf', meta.exif));
  if (meta.xmp && meta.xmp.length) parts.push(chunk('iTXt', Buffer.concat([Buffer.from('XML:com.adobe.xmp\0\0\0\0\0', 'latin1'), meta.xmp])));
  const MAXC = 8 * 1024 * 1024;
  for (let i = 0; i < idat.length; i += MAXC) parts.push(chunk('IDAT', idat.subarray(i, i + MAXC)));
  parts.push(chunk('IEND', Buffer.alloc(0)));
  return Buffer.concat(parts);
}

// ---- writing: WebP -------------------------------------------------------------------------------------------------------
function riffChunk(type, data) {
  const head = Buffer.alloc(8); head.write(type, 0, 'latin1'); head.writeUInt32LE(data.length, 4);
  return data.length & 1 ? Buffer.concat([head, data, Buffer.alloc(1)]) : Buffer.concat([head, data]);
}
/** Put metadata into a WebP (from the browser's encoder): an extended (VP8X) file with ICCP / EXIF / XMP chunks. */
function webpWithMeta(webp, meta, w, h) {
  const b = Buffer.from(webp);
  if (!(meta.icc || meta.exif || meta.xmp)) return b;
  const chunks = []; let p = 12;
  while (p + 8 <= b.length) {
    const type = b.toString('latin1', p, p + 4); const len = b.readUInt32LE(p + 4);
    chunks.push({ type, data: b.subarray(p + 8, p + 8 + len) });
    p += 8 + len + (len & 1);
  }
  let alpha = chunks.some((c) => c.type === 'ALPH');
  const vp8x = chunks.find((c) => c.type === 'VP8X');
  if (vp8x && vp8x.data[0] & 0x10) alpha = true;
  const vp8l = chunks.find((c) => c.type === 'VP8L');
  if (vp8l && vp8l.data.length >= 5 && (vp8l.data.readUInt32LE(1) >>> 28) & 1) alpha = true;
  const image = chunks.filter((c) => c.type === 'ALPH' || c.type === 'VP8 ' || c.type === 'VP8L');
  const head = Buffer.alloc(10);
  head[0] = (meta.icc ? 0x20 : 0) | (alpha ? 0x10 : 0) | (meta.exif ? 0x08 : 0) | (meta.xmp ? 0x04 : 0);
  head.writeUIntLE(w - 1, 4, 3); head.writeUIntLE(h - 1, 7, 3);
  const body = [Buffer.from('WEBP', 'latin1'), riffChunk('VP8X', head)];
  if (meta.icc) body.push(riffChunk('ICCP', meta.icc));
  for (const c of image) body.push(riffChunk(c.type, c.data));
  if (meta.exif) body.push(riffChunk('EXIF', meta.exif));
  if (meta.xmp) body.push(riffChunk('XMP ', meta.xmp));
  const all = Buffer.concat(body);
  const riff = Buffer.alloc(8); riff.write('RIFF', 0, 'latin1'); riff.writeUInt32LE(all.length, 4);
  return Buffer.concat([riff, all]);
}

/**
 * The metadata to write for an edited picture of width x height: ICC always; EXIF (cleaned) and XMP only when keepDetails.
 */
function metaForSave(orig, keepDetails, width, height) {
  const out = { icc: orig && orig.icc ? orig.icc : null, exif: null, xmp: null };
  if (keepDetails && orig) {
    if (orig.exif) out.exif = cleanExif(orig.exif, width, height);
    if (orig.xmp) out.xmp = Buffer.from(orig.xmp.toString('utf8').replace(/(tiff:Orientation=")\d/g, (_m, a) => a + '1').replace(/(<tiff:Orientation>)\d/g, (_m, a) => a + '1')
      .replace(/<xmp:Thumbnails>[\s\S]*?<\/xmp:Thumbnails>/g, ''), 'utf8');   // an XMP thumbnail would show the old picture
  }
  return out;
}

module.exports = { crc32, readMeta, exifSummary, cleanExif, jpegWithMeta, encodePng, webpWithMeta, metaForSave, filterRows, ifd, tiffReader };
