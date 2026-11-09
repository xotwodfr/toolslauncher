'use strict';
// Width and height of a picture from its first bytes (PNG, JPEG, GIF, BMP, WebP), without decoding it. Used to show
// "4032 x 3024" next to each look-alike and to ignore pairs whose shapes differ. Returns null when it cannot tell.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ImgSize = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  const u16be = (b, i) => (b[i] << 8) | b[i + 1];
  const u32be = (b, i) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
  const u16le = (b, i) => b[i] | (b[i + 1] << 8);
  const u32le = (b, i) => (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0;
  const ascii = (b, i, n) => String.fromCharCode(...b.subarray(i, i + n));

  function jpeg(b) {
    let i = 2;
    let orientation = 1;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) { i++; continue; }
      const m = b[i + 1];
      if (m === 0xff) { i++; continue; }
      if (m === 0xd8 || (m >= 0xd0 && m <= 0xd7) || m === 0x01) { i += 2; continue; }
      const len = u16be(b, i + 2);
      if (m === 0xe1 && ascii(b, i + 4, 4) === 'Exif') orientation = exifOrientation(b, i + 10, len - 8) || orientation;
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
        let w = u16be(b, i + 7); let h = u16be(b, i + 5);
        if (orientation >= 5 && orientation <= 8) [w, h] = [h, w]; // the picture is shown turned on its side
        return { w, h };
      }
      i += 2 + len;
    }
    return null;
  }

  function exifOrientation(b, start, len) {
    if (len < 12 || start + len > b.length) return 0;
    const le = ascii(b, start, 2) === 'II';
    const r16 = (o) => (le ? u16le(b, start + o) : u16be(b, start + o));
    const r32 = (o) => (le ? u32le(b, start + o) : u32be(b, start + o));
    if (r16(2) !== 42) return 0;
    const ifd = r32(4);
    if (ifd + 2 > len) return 0;
    const n = r16(ifd);
    for (let k = 0; k < n && ifd + 2 + k * 12 + 12 <= len; k++) {
      const e = ifd + 2 + k * 12;
      if (r16(e) === 0x0112) return r16(e + 8);
    }
    return 0;
  }

  function webp(b) {
    if (b.length < 30) return null;
    const kind = ascii(b, 12, 4);
    if (kind === 'VP8 ') return { w: u16le(b, 26) & 0x3fff, h: u16le(b, 28) & 0x3fff };
    if (kind === 'VP8L') { const v = u32le(b, 21); return { w: (v & 0x3fff) + 1, h: ((v >>> 14) & 0x3fff) + 1 }; }
    if (kind === 'VP8X') return { w: (b[24] | (b[25] << 8) | (b[26] << 16)) + 1, h: (b[27] | (b[28] << 8) | (b[29] << 16)) + 1 };
    return null;
  }

  /** @param b Uint8Array of at least the first 64 KB of the file (less is fine for small files) */
  function imageSize(b) {
    if (!b || b.length < 24) return null;
    if (b[0] === 0x89 && ascii(b, 1, 3) === 'PNG') return { w: u32be(b, 16), h: u32be(b, 20) };
    if (b[0] === 0xff && b[1] === 0xd8) return jpeg(b);
    if (ascii(b, 0, 3) === 'GIF') return { w: u16le(b, 6), h: u16le(b, 8) };
    if (b[0] === 0x42 && b[1] === 0x4d) { const w = u32le(b, 18); const h = u32le(b, 22) | 0; return { w, h: Math.abs(h) }; }
    if (ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP') return webp(b);
    return null;
  }

  return { imageSize };
}));
