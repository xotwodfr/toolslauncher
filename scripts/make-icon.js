'use strict';
// Generates build/icon.png (512x512): purple rounded square with a white diamond.
// Pure Node (zlib only) so no image tooling is needed. Replace build/icon.png with real art any time.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// usage: node scripts/make-icon.js [outFile] [#rrggbb accent]
const hex = (process.argv[3] || '#7c5cff').replace('#', '');
const [AR, AG, AB] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
const N = 512;
const px = Buffer.alloc(N * N * 4);
const R = 110; // corner radius
const inRound = (x, y) => {
  const cx = Math.min(Math.max(x, R), N - 1 - R);
  const cy = Math.min(Math.max(y, R), N - 1 - R);
  return (x - cx) ** 2 + (y - cy) ** 2 <= R * R;
};
for (let y = 0; y < N; y++) {
  for (let x = 0; x < N; x++) {
    const i = (y * N + x) * 4;
    if (!inRound(x, y)) continue; // transparent
    const t = (x + y) / (2 * N);
    const k = 1 - 0.28 * t; // accent -> slightly darker towards the bottom-right
    let r = AR * k, g = AG * k, b = AB * k;
    const d = Math.abs(x - N / 2) + Math.abs(y - N / 2);
    if (d < 150) { r = g = b = 255; }
    px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = 255;
  }
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(N, 0); ihdr.writeUInt32BE(N, 4); ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
const raw = Buffer.alloc((N * 4 + 1) * N);
for (let y = 0; y < N; y++) {
  raw[y * (N * 4 + 1)] = 0;
  px.copy(raw, y * (N * 4 + 1) + 1, y * N * 4, (y + 1) * N * 4);
}
const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
]);
const out = path.resolve(process.argv[2] || path.join(__dirname, '..', 'build', 'icon.png'));
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, png);
console.log('wrote', out, png.length, 'bytes');
