'use strict';
// Netpbm: PPM (P6, colour) and PGM (P5, grey) encoders; decoder for P1-P7 (PBM, PGM, PPM ascii/binary, PAM).

/** Colour image, 8 bits per channel. Alpha is ignored (flatten before calling). */
function encodePpm(rgba, width, height) {
  const head = Buffer.from(`P6\n${width} ${height}\n255\n`, 'latin1');
  const body = Buffer.alloc(width * height * 3);
  for (let i = 0, o = 0; i < width * height; i++) { body[o++] = rgba[i * 4]; body[o++] = rgba[i * 4 + 1]; body[o++] = rgba[i * 4 + 2]; }
  return Buffer.concat([head, body]);
}

/** Grey-scale image using Rec. 709 luma. */
function encodePgm(rgba, width, height) {
  const head = Buffer.from(`P5\n${width} ${height}\n255\n`, 'latin1');
  const body = Buffer.alloc(width * height);
  for (let i = 0; i < width * height; i++) {
    body[i] = Math.round(0.2126 * rgba[i * 4] + 0.7152 * rgba[i * 4 + 1] + 0.0722 * rgba[i * 4 + 2]);
  }
  return Buffer.concat([head, body]);
}

function decode(buf, maxPixels = 100e6) {
  let p = 0;
  const isWs = (c) => c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09;
  const token = () => {
    for (;;) {
      while (p < buf.length && isWs(buf[p])) p++;
      if (buf[p] === 0x23) { while (p < buf.length && buf[p] !== 0x0a) p++; continue; } // '#' comment
      break;
    }
    const s = p;
    while (p < buf.length && !isWs(buf[p])) p++;
    if (s === p) throw new Error('PNM header is truncated');
    return buf.toString('latin1', s, p);
  };
  const magic = token();
  if (!/^P[1-7]$/.test(magic)) throw new Error('Not a PNM file');
  const kind = Number(magic[1]);
  let width, height, maxval = 1, depth = 1;
  if (kind === 7) { // PAM: "KEY value" lines up to ENDHDR
    for (;;) {
      const k = token();
      if (k === 'ENDHDR') break;
      if (k === 'WIDTH') width = Number(token()); else if (k === 'HEIGHT') height = Number(token());
      else if (k === 'DEPTH') depth = Number(token()); else if (k === 'MAXVAL') maxval = Number(token());
      else token(); // TUPLTYPE and any other key: skip its value
    }
  } else {
    width = Number(token()); height = Number(token());
    if (kind !== 1 && kind !== 4) maxval = Number(token());
    depth = kind === 3 || kind === 6 ? 3 : 1;
  }
  if (!(width > 0 && height > 0) || width * height > maxPixels) throw new Error('PNM has invalid or too large dimensions');
  if (!(maxval >= 1 && maxval <= 65535) || ![1, 2, 3, 4].includes(depth)) throw new Error('Unsupported PNM parameters');
  const n = width * height;
  const data = Buffer.alloc(n * 4);
  const ascii = kind === 1 || kind === 2 || kind === 3;
  const wide = maxval > 255;
  if (!ascii) p++; // single whitespace byte after the header
  const sample = () => {
    let v;
    if (ascii) v = Number(token());
    else if (wide) { v = buf.readUInt16BE(p); p += 2; } else v = buf[p++];
    if (p > buf.length + 1) throw new Error('PNM data is truncated');
    return v;
  };
  const to8 = (v) => (maxval === 255 ? v : Math.round((v * 255) / maxval));
  if (kind === 4) { // packed bits, rows padded to a byte, 1 = black
    const rowBytes = Math.ceil(width / 8);
    if (p + rowBytes * height > buf.length) throw new Error('PNM data is truncated');
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const v = ((buf[p + y * rowBytes + (x >> 3)] >> (7 - (x & 7))) & 1) ? 0 : 255;
      const o = (y * width + x) * 4; data[o] = data[o + 1] = data[o + 2] = v; data[o + 3] = 255;
    }
    return { width, height, data };
  }
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    if (kind === 1) { const v = sample() ? 0 : 255; data[o] = data[o + 1] = data[o + 2] = v; data[o + 3] = 255; continue; }
    const s = [];
    for (let c = 0; c < depth; c++) s.push(to8(sample()));
    if (depth === 1) { data[o] = data[o + 1] = data[o + 2] = s[0]; data[o + 3] = 255; }
    else if (depth === 2) { data[o] = data[o + 1] = data[o + 2] = s[0]; data[o + 3] = s[1]; }          // grey + alpha
    else { data[o] = s[0]; data[o + 1] = s[1]; data[o + 2] = s[2]; data[o + 3] = depth === 4 ? s[3] : 255; }
  }
  return { width, height, data };
}

module.exports = { encodePpm, encodePgm, decode };
