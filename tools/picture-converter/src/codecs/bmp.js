'use strict';
// Windows BMP. Encoder: 24-bit (BITMAPINFOHEADER) or 32-bit with alpha (BITMAPV4HEADER, BI_BITFIELDS).
// Decoder: 1/4/8-bit palette, 16/24/32-bit uncompressed or bitfields; bottom-up and top-down; also ICO's DIB payloads.

/** @param {Buffer} rgba width*height*4 @param {{alpha?:boolean}} opts */
function encode(rgba, width, height, { alpha = false } = {}) {
  const bpp = alpha ? 32 : 24;
  const stride = alpha ? width * 4 : Math.ceil((width * 3) / 4) * 4;
  const dibSize = alpha ? 108 : 40;
  const dataSize = stride * height;
  const offset = 14 + dibSize;
  const out = Buffer.alloc(offset + dataSize);
  out.write('BM', 0, 'latin1');
  out.writeUInt32LE(out.length, 2);
  out.writeUInt32LE(offset, 10);
  let p = 14;
  out.writeUInt32LE(dibSize, p); out.writeInt32LE(width, p + 4); out.writeInt32LE(height, p + 8); // positive height = bottom-up
  out.writeUInt16LE(1, p + 12); out.writeUInt16LE(bpp, p + 14);
  out.writeUInt32LE(alpha ? 3 : 0, p + 16);              // BI_BITFIELDS for 32-bit, BI_RGB otherwise
  out.writeUInt32LE(dataSize, p + 20);
  out.writeInt32LE(2835, p + 24); out.writeInt32LE(2835, p + 28); // 72 dpi
  if (alpha) {
    out.writeUInt32LE(0x00ff0000, p + 40); out.writeUInt32LE(0x0000ff00, p + 44);
    out.writeUInt32LE(0x000000ff, p + 48); out.writeUInt32LE(0xff000000, p + 52);
    out.writeUInt32LE(0x57696e20, p + 56);               // "Win " colour space
  }
  for (let y = 0; y < height; y++) {
    let o = offset + (height - 1 - y) * stride;
    for (let x = 0; x < width; x++) {
      const s = (y * width + x) * 4;
      out[o++] = rgba[s + 2]; out[o++] = rgba[s + 1]; out[o++] = rgba[s];
      if (alpha) out[o++] = rgba[s + 3];
    }
  }
  return out;
}

const countBits = (m) => { let n = 0; while (m) { n += m & 1; m >>>= 1; } return n; };
const shiftOf = (m) => { let s = 0; while (m && !(m & 1)) { m >>>= 1; s++; } return s; };
const scale = (v, bits) => (bits === 0 ? 0 : bits === 8 ? v : Math.round((v * 255) / ((1 << bits) - 1)));

/**
 * @param {Buffer} buf  a BMP file, or (isDib) a bare DIB as stored inside an ICO
 * @returns {{width:number,height:number,data:Buffer}} RGBA
 */
function decode(buf, { isDib = false, maxPixels = 100e6 } = {}) {
  let base = 0;
  if (!isDib) {
    if (buf.length < 26 || buf.toString('latin1', 0, 2) !== 'BM') throw new Error('Not a BMP file');
    base = 14;
  }
  const dibSize = buf.readUInt32LE(base);
  let width, height, bpp, comp = 0, colors = 0, topDown = false, headerEnd = base + dibSize;
  if (dibSize === 12) { // OS/2 BITMAPCOREHEADER
    width = buf.readUInt16LE(base + 4); height = buf.readUInt16LE(base + 6); bpp = buf.readUInt16LE(base + 10);
  } else if (dibSize >= 40) {
    width = buf.readInt32LE(base + 4); height = buf.readInt32LE(base + 8); bpp = buf.readUInt16LE(base + 14);
    comp = buf.readUInt32LE(base + 16); colors = buf.readUInt32LE(base + 32);
    if (height < 0) { topDown = true; height = -height; }
  } else throw new Error('Unsupported BMP header');
  const maskHeight = isDib ? height / 2 : height; // an ICO DIB stores XOR image + AND mask as double height
  const imgH = isDib ? Math.floor(maskHeight) : height;
  if (width <= 0 || imgH <= 0 || width * imgH > maxPixels) throw new Error('BMP has invalid or too large dimensions');
  if (comp !== 0 && comp !== 3 && comp !== 6) throw new Error('Compressed BMP files (RLE/JPEG/PNG) are not supported');

  let masks = null;
  if (comp === 3 || comp === 6) {
    if (dibSize >= 52) { masks = [buf.readUInt32LE(base + 40), buf.readUInt32LE(base + 44), buf.readUInt32LE(base + 48), dibSize >= 56 ? buf.readUInt32LE(base + 52) : 0]; }
    else { masks = [buf.readUInt32LE(headerEnd), buf.readUInt32LE(headerEnd + 4), buf.readUInt32LE(headerEnd + 8), 0]; headerEnd += 12; }
  } else if (bpp === 16) masks = [0x7c00, 0x03e0, 0x001f, 0];
  else if (bpp === 32) masks = [0x00ff0000, 0x0000ff00, 0x000000ff, 0xff000000];

  let palette = null;
  if (bpp <= 8) {
    const n = colors || 1 << bpp, entry = dibSize === 12 ? 3 : 4;
    palette = [];
    for (let i = 0; i < n; i++) { const q = headerEnd + i * entry; palette.push([buf[q + 2], buf[q + 1], buf[q]]); }
    headerEnd += n * entry;
  }
  const pixelStart = isDib ? headerEnd : buf.readUInt32LE(10);
  const stride = Math.ceil((width * bpp) / 32) * 4;
  if (pixelStart + stride * imgH > buf.length) throw new Error('BMP data is truncated');

  const data = Buffer.alloc(width * imgH * 4);
  let anyAlpha = false;
  for (let y = 0; y < imgH; y++) {
    const srcRow = pixelStart + (topDown ? y : imgH - 1 - y) * stride;
    for (let x = 0; x < width; x++) {
      const d = (y * width + x) * 4;
      let r, g, b, a = 255;
      if (bpp <= 8) {
        const bitPos = x * bpp, byte = buf[srcRow + (bitPos >> 3)];
        const idx = (byte >> (8 - bpp - (bitPos & 7))) & ((1 << bpp) - 1);
        [r, g, b] = palette[idx] || [0, 0, 0];
      } else if (bpp === 24) {
        const q = srcRow + x * 3; b = buf[q]; g = buf[q + 1]; r = buf[q + 2];
      } else {
        const v = bpp === 16 ? buf.readUInt16LE(srcRow + x * 2) : buf.readUInt32LE(srcRow + x * 4);
        const ch = masks.map((m) => (m ? (v & m) >>> shiftOf(m) : 0));
        r = scale(ch[0], countBits(masks[0])); g = scale(ch[1], countBits(masks[1])); b = scale(ch[2], countBits(masks[2]));
        if (masks[3]) { a = scale(ch[3], countBits(masks[3])); if (a) anyAlpha = true; }
      }
      data[d] = r; data[d + 1] = g; data[d + 2] = b; data[d + 3] = a;
    }
  }
  if (bpp === 32 && !anyAlpha && !(comp === 3 && masks[3])) for (let i = 3; i < data.length; i += 4) data[i] = 255; // unused alpha byte
  if (isDib && bpp < 32) { // ICO: 1-bit AND mask follows the colour data (1 = transparent)
    const maskStart = pixelStart + stride * imgH, maskStride = Math.ceil(width / 32) * 4;
    if (maskStart + maskStride * imgH <= buf.length) {
      for (let y = 0; y < imgH; y++) for (let x = 0; x < width; x++) {
        const bit = (buf[maskStart + (imgH - 1 - y) * maskStride + (x >> 3)] >> (7 - (x & 7))) & 1;
        if (bit) data[(y * width + x) * 4 + 3] = 0;
      }
    }
  }
  return { width, height: imgH, data };
}

module.exports = { encode, decode };
