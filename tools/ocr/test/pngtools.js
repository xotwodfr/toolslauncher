'use strict';
// Test-only picture tools: read and write PNGs, enlarge and crop, so the tests can prepare pictures the way the window does.
const zlib = require('zlib');

/** @returns {{ w, h, px: Uint8ClampedArray }}  RGBA */
function decode(buf) {
  let p = 8; let w = 0; let h = 0; let ct = 0; let depth = 0; const idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p); const type = buf.toString('ascii', p + 4, p + 8); const data = buf.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); depth = data[8]; ct = data[9]; if (data[12]) throw new Error('interlaced'); }
    else if (type === 'IDAT') idat.push(data);
    p += 12 + len;
  }
  if (depth !== 8 || ![0, 2, 6].includes(ct)) throw new Error(`unsupported PNG (depth ${depth}, type ${ct})`);
  const bpp = ct === 0 ? 1 : ct === 2 ? 3 : 4;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * bpp;
  const out = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    for (let x = 0; x < stride; x++) {
      const v = raw[y * (stride + 1) + 1 + x];
      const a = x >= bpp ? out[y * stride + x - bpp] : 0;
      const b = y > 0 ? out[(y - 1) * stride + x] : 0;
      const c = x >= bpp && y > 0 ? out[(y - 1) * stride + x - bpp] : 0;
      let r;
      if (f === 0) r = v; else if (f === 1) r = v + a; else if (f === 2) r = v + b; else if (f === 3) r = v + ((a + b) >> 1);
      else { const pp = a + b - c; const pa = Math.abs(pp - a); const pb = Math.abs(pp - b); const pc = Math.abs(pp - c); r = v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c); }
      out[y * stride + x] = r & 255;
    }
  }
  const px = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    if (ct === 0) { px[i * 4] = px[i * 4 + 1] = px[i * 4 + 2] = out[i]; px[i * 4 + 3] = 255; }
    else { px[i * 4] = out[i * bpp]; px[i * 4 + 1] = out[i * bpp + 1]; px[i * 4 + 2] = out[i * bpp + 2]; px[i * 4 + 3] = ct === 6 ? out[i * bpp + 3] : 255; }
  }
  return { w, h, px };
}

function encode({ w, h, px }) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) Buffer.from(px.buffer, px.byteOffset + y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1);
  const crcT = (() => { const t = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/** Bilinear resize to the given size. */
function resize(img, nw, nh) {
  const out = new Uint8ClampedArray(nw * nh * 4);
  for (let y = 0; y < nh; y++) {
    const fy = Math.max(0, Math.min(img.h - 1, (y + 0.5) * img.h / nh - 0.5)); const y0 = Math.floor(fy); const y1 = Math.min(img.h - 1, y0 + 1); const ty = fy - y0;
    for (let x = 0; x < nw; x++) {
      const fx = Math.max(0, Math.min(img.w - 1, (x + 0.5) * img.w / nw - 0.5)); const x0 = Math.floor(fx); const x1 = Math.min(img.w - 1, x0 + 1); const tx = fx - x0;
      for (let c = 0; c < 4; c++) {
        const a = img.px[(y0 * img.w + x0) * 4 + c] * (1 - tx) + img.px[(y0 * img.w + x1) * 4 + c] * tx;
        const b = img.px[(y1 * img.w + x0) * 4 + c] * (1 - tx) + img.px[(y1 * img.w + x1) * 4 + c] * tx;
        out[(y * nw + x) * 4 + c] = a * (1 - ty) + b * ty;
      }
    }
  }
  return { w: nw, h: nh, px: out };
}

function crop(img, x, y, w, h) {
  const out = new Uint8ClampedArray(w * h * 4);
  for (let r = 0; r < h; r++) out.set(img.px.subarray(((y + r) * img.w + x) * 4, ((y + r) * img.w + x + w) * 4), r * w * 4);
  return { w, h, px: out };
}

module.exports = { decode, encode, resize, crop };
