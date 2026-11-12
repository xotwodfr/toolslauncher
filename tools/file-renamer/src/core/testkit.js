'use strict';
// Tiny INVENTED sample files for the tests, the self-test and the screenshots: a JPEG with an EXIF photo date, and MP3 /
// FLAC files with tags. Built byte by byte so no outside tool or real recording is needed.
const fs = require('fs');

/** A minimal JPEG whose EXIF says it was taken at `when` ("YYYY:MM:DD HH:MM:SS"). */
function jpegWithDate(file, when) {
  const tiff = Buffer.alloc(64);
  tiff.write('II', 0, 'latin1'); tiff.writeUInt16LE(42, 2); tiff.writeUInt32LE(8, 4);
  tiff.writeUInt16LE(1, 8);                                       // IFD0: one entry
  tiff.writeUInt16LE(0x8769, 10); tiff.writeUInt16LE(4, 12); tiff.writeUInt32LE(1, 14); tiff.writeUInt32LE(26, 18); // -> Exif IFD
  tiff.writeUInt32LE(0, 22);
  tiff.writeUInt16LE(1, 26);                                      // Exif IFD: one entry
  tiff.writeUInt16LE(0x9003, 28); tiff.writeUInt16LE(2, 30); tiff.writeUInt32LE(20, 32); tiff.writeUInt32LE(44, 36); // DateTimeOriginal
  tiff.writeUInt32LE(0, 40);
  tiff.write(when.padEnd(19).slice(0, 19) + '\u0000', 44, 'latin1');
  const app1 = Buffer.concat([Buffer.from('Exif\u0000\u0000', 'latin1'), tiff]);
  const len = Buffer.alloc(2); len.writeUInt16BE(app1.length + 2);
  fs.writeFileSync(file, Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe1]), len, app1, Buffer.from([0xff, 0xd9])]));
  return file;
}

const syncsafe = (n) => Buffer.from([(n >> 21) & 0x7f, (n >> 14) & 0x7f, (n >> 7) & 0x7f, n & 0x7f]);

/** An MP3 (ID3v2.4 tag + a few silent MPEG frames) with the given tags. */
function mp3WithTags(file, tags = {}) {
  const frames = [];
  const add = (id, text) => {
    if (text == null || text === '') return;
    const body = Buffer.concat([Buffer.from([3]), Buffer.from(String(text), 'utf8')]);
    frames.push(Buffer.concat([Buffer.from(id, 'latin1'), syncsafe(body.length), Buffer.from([0, 0]), body]));
  };
  add('TIT2', tags.title); add('TPE1', tags.artist); add('TALB', tags.album); add('TRCK', tags.track); add('TDRC', tags.year);
  const body = Buffer.concat(frames);
  const head = Buffer.concat([Buffer.from('ID3', 'latin1'), Buffer.from([4, 0, 0]), syncsafe(body.length)]);
  const frame = Buffer.alloc(417); frame[0] = 0xff; frame[1] = 0xfb; frame[2] = 0x90; frame[3] = 0x64;
  fs.writeFileSync(file, Buffer.concat([head, body, ...Array(12).fill(frame)]));
  return file;
}

/** A FLAC header (STREAMINFO + Vorbis comments, no audio frames) with the given tags. */
function flacWithTags(file, tags = {}) {
  const info = Buffer.alloc(34);
  info.writeUInt16BE(4096, 0); info.writeUInt16BE(4096, 2);
  // sample rate 44100 (20 bits), 2 channels (3 bits: 1), 16 bits (5 bits: 15), 0 samples (36 bits)
  const sr = 44100;
  info[10] = (sr >> 12) & 0xff; info[11] = (sr >> 4) & 0xff; info[12] = ((sr & 0xf) << 4) | (1 << 1) | (15 >> 4); info[13] = (15 & 0xf) << 4;
  const comments = Object.entries({ TITLE: tags.title, ARTIST: tags.artist, ALBUM: tags.album, TRACKNUMBER: tags.track, DATE: tags.year }).filter(([, v]) => v != null && v !== '').map(([k, v]) => Buffer.from(`${k}=${v}`, 'utf8'));
  const vendor = Buffer.from('invented', 'utf8');
  const parts = [u32le(vendor.length), vendor, u32le(comments.length)];
  for (const c of comments) parts.push(u32le(c.length), c);
  const vc = Buffer.concat(parts);
  const blockHead = (type, len, last) => Buffer.from([(last ? 0x80 : 0) | type, (len >> 16) & 0xff, (len >> 8) & 0xff, len & 0xff]);
  fs.writeFileSync(file, Buffer.concat([Buffer.from('fLaC', 'latin1'), blockHead(0, 34, false), info, blockHead(4, vc.length, true), vc]));
  return file;
}
function u32le(n) { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; }

module.exports = { jpegWithDate, mp3WithTags, flacWithTags };
