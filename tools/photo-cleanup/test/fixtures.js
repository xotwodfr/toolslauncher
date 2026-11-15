'use strict';
// Shared test data: a small EXIF (TIFF) block with an orientation, a camera name, a GPS pointer and a thumbnail.
/** Little-endian TIFF: IFD0 { Make, Orientation, ExifIFD (pixel size 4000 x 3000), GPS } -> IFD1 { thumbnail }. */
function makeTiff({ orientation = 6, make = 'TestCam', gps = true, thumb = Buffer.from('THUMBNAILDATA') } = {}) {
  // little-endian TIFF: IFD0 { Make, Orientation, ExifIFD, GPS } -> IFD1 { JPEGInterchangeFormat, Length }
  const parts = []; const b = Buffer.alloc(400); b.write('II', 0, 'latin1'); b.writeUInt16LE(42, 2); b.writeUInt32LE(8, 4);
  let p = 8; const entries = [[0x010f, 2, make.length + 1, 200], [0x0112, 3, 1, orientation], [0x8769, 4, 1, 120]];
  if (gps) entries.push([0x8825, 4, 1, 160]);
  b.writeUInt16LE(entries.length, p); p += 2;
  for (const [tag, type, count, val] of entries) { b.writeUInt16LE(tag, p); b.writeUInt16LE(type, p + 2); b.writeUInt32LE(count, p + 4); if (type === 3) b.writeUInt16LE(val, p + 8); else b.writeUInt32LE(val, p + 8); p += 12; }
  b.writeUInt32LE(260, p);                                   // next IFD -> IFD1
  b.writeUInt16LE(2, 120); [[0xa002, 4, 1, 4000], [0xa003, 4, 1, 3000]].forEach(([tag, type, count, val], i) => { const q = 122 + i * 12; b.writeUInt16LE(tag, q); b.writeUInt16LE(type, q + 2); b.writeUInt32LE(count, q + 4); b.writeUInt32LE(val, q + 8); });
  b.writeUInt16LE(0, 160);
  b.write(make + '\0', 200, 'latin1');
  b.writeUInt16LE(2, 260); [[0x0201, 4, 1, 300], [0x0202, 4, 1, thumb.length]].forEach(([tag, type, count, val], i) => { const q = 262 + i * 12; b.writeUInt16LE(tag, q); b.writeUInt16LE(type, q + 2); b.writeUInt32LE(count, q + 4); b.writeUInt32LE(val, q + 8); });
  b.writeUInt32LE(0, 286);
  thumb.copy(b, 300);
  parts.push(b);
  return Buffer.concat(parts);
}
module.exports = { makeTiff };
