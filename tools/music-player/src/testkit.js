'use strict';
// Builds small real audio files for the unit tests, the end-to-end test and the packaged self-test (--self-test): generated sine WAVs and silent MP3s, tagged with taglib
// (title, artist, album, ReplayGain, lyrics, synced lyrics, cover art).
const fs = require('fs');
const path = require('path');
const T = require('node-taglib-sharp');
const { SynchronizedLyricsFrame, SynchronizedText } = require('node-taglib-sharp/dist/id3v2/frames/synchronizedLyricsFrame');

/** 16-bit mono PCM WAV with a sine wave (amplitude 0..1). */
function makeWav(file, { seconds = 1, freq = 440, freqs = null, amp = 0.5, rate = 8000 } = {}) {
  const n = Math.round(seconds * rate);
  const data = Buffer.alloc(n * 2);
  if (freqs) { // a chord: the frequencies at falling strength, scaled so the sum never clips
    const w = freqs.map((_, k) => 1 / (1 + k * 0.5)); const norm = w.reduce((a, b) => a + b, 0);
    for (let i = 0; i < n; i++) { let v = 0; freqs.forEach((f, k) => { v += Math.sin((2 * Math.PI * f * i) / rate) * w[k]; }); data.writeInt16LE(Math.round((v / norm) * amp * 32767), i * 2); }
  } else {
    for (let i = 0; i < n; i++) data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * freq * i) / rate) * amp * 32767), i * 2);
  }
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVEfmt ', 8); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22); h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(data.length, 40);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.concat([h, data]));
  return file;
}

/** 40 silent MPEG-1 Layer III frames (128 kbps, 44.1 kHz): about 1.04 s. */
function makeMp3(file) {
  const frame = Buffer.alloc(417);
  frame.writeUInt32BE(0xfffb9000, 0);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.concat(Array(40).fill(frame)));
  return file;
}

/** A tiny valid PNG (solid colour), `size` pixels square. */
function makePng(size = 8, rgb = [200, 60, 120]) {
  const zlib = require('zlib');
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (t, d) => { const a = Buffer.from(t); const l = Buffer.alloc(4); const c = Buffer.alloc(4); l.writeUInt32BE(d.length); c.writeUInt32BE(crc(Buffer.concat([a, d]))); return Buffer.concat([l, a, d, c]); };
  const row = Buffer.alloc(size * 3 + 1);
  for (let x = 0; x < size; x++) { row[1 + x * 3] = rgb[0]; row[2 + x * 3] = rgb[1]; row[3 + x * 3] = rgb[2]; }
  const raw = Buffer.concat(Array(size).fill(row));
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/** A square PNG with a diagonal two-colour gradient and a soft circle: stand-in cover art. */
function makeGradientPng(size, c1, c2, circle = [255, 255, 255]) {
  const zlib = require('zlib');
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (t, d) => { const a = Buffer.from(t); const l = Buffer.alloc(4); const c = Buffer.alloc(4); l.writeUInt32BE(d.length); c.writeUInt32BE(crc(Buffer.concat([a, d]))); return Buffer.concat([l, a, d, c]); };
  const raw = Buffer.alloc((size * 3 + 1) * size);
  const cx = size * 0.62; const cy = size * 0.4; const r = size * 0.22;
  for (let y = 0; y < size; y++) {
    const o = y * (size * 3 + 1);
    for (let x = 0; x < size; x++) {
      const t = (x + y) / (2 * size);
      const d = Math.hypot(x - cx, y - cy);
      const k = Math.max(0, Math.min(1, (r - d) / 6)) * 0.35; // soft-edged disc at 35 % strength
      for (let c = 0; c < 3; c++) raw[o + 1 + x * 3 + c] = Math.round((c1[c] + (c2[c] - c1[c]) * t) * (1 - k) + circle[c] * k);
    }
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/**
 * Write tags into an existing file.
 * @param {object} t  title, artist, albumArtist, album, genre, year, track, trackCount, disc, lyrics, rgTrack, rgPeak, rgAlbum,
 *                    sylt: [{time, text}], cover: Buffer
 */
function tag(file, t) {
  const f = T.File.createFromPath(file);
  try {
    const x = f.tag;
    if (t.title != null) x.title = t.title;
    if (t.artist) x.performers = [t.artist];
    if (t.albumArtist) x.albumArtists = [t.albumArtist];
    if (t.album) x.album = t.album;
    if (t.genre) x.genres = [t.genre];
    if (t.year) x.year = t.year;
    if (t.track) x.track = t.track;
    if (t.trackCount) x.trackCount = t.trackCount;
    if (t.disc) x.disc = t.disc;
    if (t.lyrics) x.lyrics = t.lyrics;
    if (t.rgTrack != null) x.replayGainTrackGain = t.rgTrack;
    if (t.rgPeak != null) x.replayGainTrackPeak = t.rgPeak;
    if (t.rgAlbum != null) x.replayGainAlbumGain = t.rgAlbum;
    if (t.cover) { const p = T.Picture.fromData(T.ByteVector.fromByteArray(t.cover)); p.type = T.PictureType.FrontCover; p.mimeType = 'image/png'; x.pictures = [p]; }
    if (t.sylt) {
      const id3 = f.getTag(T.TagTypes.Id3v2, true);
      const fr = SynchronizedLyricsFrame.fromInfo('', 'eng', T.Id3v2SynchronizedTextType.Lyrics);
      fr.format = T.Id3v2TimestampFormat.AbsoluteMilliseconds;
      fr.text = t.sylt.map((s) => new SynchronizedText(s.time, s.text));
      id3.addFrame(fr);
    }
    f.save();
  } finally { f.dispose(); }
  return file;
}

module.exports = { makeWav, makeMp3, makePng, makeGradientPng, tag };
