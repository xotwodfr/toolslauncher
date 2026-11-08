'use strict';
// Windows icon (.ico). Encoder: multi-size container of PNG images (supported since Windows Vista).
// Decoder: returns the largest image - either a PNG buffer or decoded DIB pixels.
const bmp = require('./bmp');

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** @param {{size:number, png:Buffer}[]} entries  square PNGs, 1..256 px */
function encode(entries) {
  if (!entries.length) throw new Error('An icon needs at least one size');
  const sorted = [...entries].sort((a, b) => a.size - b.size);
  const dir = Buffer.alloc(6 + 16 * sorted.length);
  dir.writeUInt16LE(0, 0); dir.writeUInt16LE(1, 2); dir.writeUInt16LE(sorted.length, 4);
  let offset = dir.length;
  sorted.forEach((e, i) => {
    if (e.size < 1 || e.size > 256) throw new Error('Icon sizes must be between 1 and 256 pixels');
    const o = 6 + i * 16;
    dir[o] = e.size === 256 ? 0 : e.size; dir[o + 1] = e.size === 256 ? 0 : e.size; // 0 means 256
    dir.writeUInt16LE(1, o + 4); dir.writeUInt16LE(32, o + 6);                       // planes, bits per pixel
    dir.writeUInt32LE(e.png.length, o + 8); dir.writeUInt32LE(offset, o + 12);
    offset += e.png.length;
  });
  return Buffer.concat([dir, ...sorted.map((e) => e.png)]);
}

/** @returns {{png:Buffer}|{width:number,height:number,data:Buffer}} */
function decode(buf, maxPixels = 100e6) {
  if (buf.length < 22 || buf.readUInt16LE(0) !== 0 || ![1, 2].includes(buf.readUInt16LE(2))) throw new Error('Not an ICO/CUR file');
  const count = buf.readUInt16LE(4);
  if (!count || 6 + count * 16 > buf.length) throw new Error('ICO directory is invalid');
  let best = null;
  for (let i = 0; i < count; i++) {
    const o = 6 + i * 16;
    const w = buf[o] || 256, h = buf[o + 1] || 256, size = buf.readUInt32LE(o + 8), off = buf.readUInt32LE(o + 12);
    if (off + size > buf.length || size < 8) continue;
    if (!best || w * h > best.w * best.h) best = { w, h, size, off };
  }
  if (!best) throw new Error('ICO contains no readable image');
  const img = buf.subarray(best.off, best.off + best.size);
  if (img.subarray(0, 8).equals(PNG_SIG)) return { png: Buffer.from(img) };
  return bmp.decode(img, { isDib: true, maxPixels });
}

module.exports = { encode, decode };
