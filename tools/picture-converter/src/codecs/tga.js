'use strict';
// Truevision TGA. Encoder: 32-bit BGRA, top-left origin, optional RLE. Decoder: colour-mapped, true-colour and
// grey-scale images (types 1, 2, 3 and their RLE variants 9, 10, 11) at 8/15/16/24/32 bits.

function encode(rgba, width, height, { rle = true } = {}) {
  if (width > 65535 || height > 65535) throw new Error('TGA supports at most 65535 pixels per side');
  const head = Buffer.alloc(18);
  head[2] = rle ? 10 : 2;
  head.writeUInt16LE(width, 12); head.writeUInt16LE(height, 14);
  head[16] = 32;
  head[17] = 0x08 | 0x20; // 8 alpha bits, origin at the top-left
  const parts = [head];
  const px = (i) => [rgba[i * 4 + 2], rgba[i * 4 + 1], rgba[i * 4], rgba[i * 4 + 3]]; // BGRA
  if (!rle) {
    const body = Buffer.alloc(width * height * 4);
    for (let i = 0; i < width * height; i++) body.set(px(i), i * 4);
    parts.push(body);
  } else {
    const same = (a, b) => rgba[a * 4] === rgba[b * 4] && rgba[a * 4 + 1] === rgba[b * 4 + 1] && rgba[a * 4 + 2] === rgba[b * 4 + 2] && rgba[a * 4 + 3] === rgba[b * 4 + 3];
    const out = [];
    for (let y = 0; y < height; y++) {            // packets never cross a scan line
      const row = y * width;
      let x = 0;
      while (x < width) {
        let run = 1;
        while (x + run < width && run < 128 && same(row + x, row + x + run)) run++;
        if (run >= 2) { out.push(Buffer.from([0x80 | (run - 1), ...px(row + x)])); x += run; continue; }
        let raw = 1;                               // collect literal pixels until a run of 2+ starts
        while (x + raw < width && raw < 128 && !(x + raw + 1 < width && same(row + x + raw, row + x + raw + 1))) raw++;
        const lit = Buffer.alloc(1 + raw * 4);
        lit[0] = raw - 1;
        for (let k = 0; k < raw; k++) lit.set(px(row + x + k), 1 + k * 4);
        out.push(lit); x += raw;
      }
    }
    parts.push(Buffer.concat(out));
  }
  parts.push(Buffer.from('\0\0\0\0\0\0\0\0TRUEVISION-XFILE.\0', 'latin1')); // TGA 2.0 footer
  return Buffer.concat(parts);
}

function decode(buf, maxPixels = 100e6) {
  if (buf.length < 18) throw new Error('Not a TGA file');
  const idLen = buf[0], cmapType = buf[1], type = buf[2];
  const cmapFirst = buf.readUInt16LE(3), cmapLen = buf.readUInt16LE(5), cmapBits = buf[7];
  const width = buf.readUInt16LE(12), height = buf.readUInt16LE(14), bpp = buf[16], desc = buf[17];
  if (![1, 2, 3, 9, 10, 11].includes(type)) throw new Error('Unsupported TGA type');
  if (!width || !height || width * height > maxPixels) throw new Error('TGA has invalid or too large dimensions');
  if (![8, 15, 16, 24, 32].includes(bpp)) throw new Error('Unsupported TGA pixel depth');
  const isRle = type >= 9, isMapped = type === 1 || type === 9, isGrey = type === 3 || type === 11;
  let p = 18 + idLen;
  let cmap = null;
  if (cmapType === 1 || isMapped) {
    const eb = cmapBits >> 3;
    if (isMapped && (bpp !== 8 || ![2, 3, 4].includes(eb))) throw new Error('Unsupported TGA colour map');
    cmap = [];
    for (let i = 0; i < cmapLen; i++) cmap.push(readPixel(buf, p + i * eb, cmapBits, desc));
    p += cmapLen * (cmapBits >> 3);
  }
  const bytes = Math.ceil(bpp / 8);
  const data = Buffer.alloc(width * height * 4);
  const total = width * height;
  const put = (i, rgba) => { data[i * 4] = rgba[0]; data[i * 4 + 1] = rgba[1]; data[i * 4 + 2] = rgba[2]; data[i * 4 + 3] = rgba[3]; };
  const read = (q) => {
    if (isGrey) return bpp === 8 ? [buf[q], buf[q], buf[q], 255] : [buf[q], buf[q], buf[q], buf[q + 1]];
    if (isMapped) return cmap[buf[q] - cmapFirst] || [0, 0, 0, 255];
    return readPixel(buf, q, bpp, desc);
  };
  let n = 0;
  while (n < total) {
    if (p >= buf.length) throw new Error('TGA data is truncated');
    if (!isRle) { put(n++, read(p)); p += bytes; continue; }
    const hdr = buf[p++], count = (hdr & 0x7f) + 1;
    if (hdr & 0x80) { const v = read(p); p += bytes; for (let k = 0; k < count && n < total; k++) put(n++, v); }
    else for (let k = 0; k < count && n < total; k++) { put(n++, read(p)); p += bytes; }
  }
  if (!(desc & 0x20)) { // bottom-left origin: flip rows
    const row = width * 4, tmp = Buffer.alloc(row);
    for (let y = 0; y < height >> 1; y++) {
      const a = y * row, b = (height - 1 - y) * row;
      data.copy(tmp, 0, a, a + row); data.copy(data, a, b, b + row); tmp.copy(data, b);
    }
  }
  return { width, height, data };
}

function readPixel(buf, q, bits, desc) {
  if (bits === 24) return [buf[q + 2], buf[q + 1], buf[q], 255];
  if (bits === 32) return [buf[q + 2], buf[q + 1], buf[q], (desc & 0x0f) ? buf[q + 3] : 255];
  const v = buf.readUInt16LE(q); // 15/16-bit: A1R5G5B5
  const s = (x) => Math.round((x * 255) / 31);
  return [s((v >> 10) & 31), s((v >> 5) & 31), s(v & 31), bits === 16 && (desc & 0x0f) ? ((v & 0x8000) ? 255 : 0) : 255];
}

module.exports = { encode, decode };
