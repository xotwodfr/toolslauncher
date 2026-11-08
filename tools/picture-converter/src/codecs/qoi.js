'use strict';
// QOI ("Quite OK Image"): https://qoiformat.org/qoi-specification.pdf  - RGBA only, lossless.
const OP_INDEX = 0x00, OP_DIFF = 0x40, OP_LUMA = 0x80, OP_RUN = 0xc0, OP_RGB = 0xfe, OP_RGBA = 0xff, MASK_2 = 0xc0;
const MAGIC = 0x716f6966; // "qoif"
const hash = (r, g, b, a) => (r * 3 + g * 5 + b * 7 + a * 11) % 64;
const s8 = (x) => (x << 24) >> 24; // wrap to signed 8-bit like the reference C code

/** @param {Buffer|Uint8Array} rgba  width*height*4 bytes */
function encode(rgba, width, height) {
  const total = width * height;
  const out = Buffer.alloc(14 + total * 5 + 8);
  let p = 0;
  out.writeUInt32BE(MAGIC, p); p += 4;
  out.writeUInt32BE(width, p); p += 4;
  out.writeUInt32BE(height, p); p += 4;
  out[p++] = 4; out[p++] = 0; // channels = RGBA, colourspace = sRGB with linear alpha

  const index = new Uint8Array(64 * 4);
  let pr = 0, pg = 0, pb = 0, pa = 255, run = 0;
  for (let i = 0; i < total; i++) {
    const o = i * 4;
    const r = rgba[o], g = rgba[o + 1], b = rgba[o + 2], a = rgba[o + 3];
    if (r === pr && g === pg && b === pb && a === pa) {
      run++;
      if (run === 62 || i === total - 1) { out[p++] = OP_RUN | (run - 1); run = 0; }
    } else {
      if (run > 0) { out[p++] = OP_RUN | (run - 1); run = 0; }
      const h4 = hash(r, g, b, a) * 4;
      if (index[h4] === r && index[h4 + 1] === g && index[h4 + 2] === b && index[h4 + 3] === a) {
        out[p++] = OP_INDEX | (h4 / 4);
      } else {
        index[h4] = r; index[h4 + 1] = g; index[h4 + 2] = b; index[h4 + 3] = a;
        if (a === pa) {
          const vr = s8(r - pr), vg = s8(g - pg), vb = s8(b - pb);
          const vgr = vr - vg, vgb = vb - vg;
          if (vr > -3 && vr < 2 && vg > -3 && vg < 2 && vb > -3 && vb < 2) {
            out[p++] = OP_DIFF | ((vr + 2) << 4) | ((vg + 2) << 2) | (vb + 2);
          } else if (vgr > -9 && vgr < 8 && vg > -33 && vg < 32 && vgb > -9 && vgb < 8) {
            out[p++] = OP_LUMA | (vg + 32);
            out[p++] = ((vgr + 8) << 4) | (vgb + 8);
          } else {
            out[p++] = OP_RGB; out[p++] = r; out[p++] = g; out[p++] = b;
          }
        } else {
          out[p++] = OP_RGBA; out[p++] = r; out[p++] = g; out[p++] = b; out[p++] = a;
        }
      }
    }
    pr = r; pg = g; pb = b; pa = a;
  }
  for (let i = 0; i < 7; i++) out[p++] = 0;
  out[p++] = 1;
  return out.subarray(0, p);
}

/** @returns {{width:number,height:number,data:Buffer}} RGBA */
function decode(buf, maxPixels = 100e6) {
  if (buf.length < 14 + 8 || buf.readUInt32BE(0) !== MAGIC) throw new Error('Not a QOI file');
  const width = buf.readUInt32BE(4), height = buf.readUInt32BE(8);
  if (!width || !height || width * height > maxPixels) throw new Error('QOI image has invalid or too large dimensions');
  const total = width * height;
  const data = Buffer.alloc(total * 4);
  const index = new Uint8Array(64 * 4);
  let p = 14, r = 0, g = 0, b = 0, a = 255, run = 0;
  const end = buf.length - 8;
  for (let i = 0; i < total; i++) {
    if (run > 0) run--;
    else {
      if (p >= end) throw new Error('QOI data is truncated');
      const b1 = buf[p++];
      if (b1 === OP_RGB) { r = buf[p++]; g = buf[p++]; b = buf[p++]; }
      else if (b1 === OP_RGBA) { r = buf[p++]; g = buf[p++]; b = buf[p++]; a = buf[p++]; }
      else {
        switch (b1 & MASK_2) {
          case OP_INDEX: { const h4 = (b1 & 0x3f) * 4; r = index[h4]; g = index[h4 + 1]; b = index[h4 + 2]; a = index[h4 + 3]; break; }
          case OP_DIFF: r = (r + ((b1 >> 4) & 3) - 2) & 255; g = (g + ((b1 >> 2) & 3) - 2) & 255; b = (b + (b1 & 3) - 2) & 255; break;
          case OP_LUMA: {
            const b2 = buf[p++], vg = (b1 & 0x3f) - 32;
            r = (r + vg - 8 + ((b2 >> 4) & 0x0f)) & 255; g = (g + vg) & 255; b = (b + vg - 8 + (b2 & 0x0f)) & 255; break;
          }
          default: run = b1 & 0x3f; // OP_RUN
        }
      }
      const h4 = hash(r, g, b, a) * 4;
      index[h4] = r; index[h4 + 1] = g; index[h4 + 2] = b; index[h4 + 3] = a;
    }
    const o = i * 4;
    data[o] = r; data[o + 1] = g; data[o + 2] = b; data[o + 3] = a;
  }
  return { width, height, data };
}

module.exports = { encode, decode };
