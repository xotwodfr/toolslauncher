'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const T = require('../src/tags');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'at-test-'));
let n = 0, skipped = [];
const ok = (m) => { n++; console.log('  ok  ' + m); };

// ---- fixtures -----------------------------------------------------------------------------
function makeWav(file) {
  const data = Buffer.alloc(8000, 128);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVEfmt ', 8); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22); h.writeUInt32LE(8000, 24); h.writeUInt32LE(8000, 28); h.writeUInt16LE(1, 32); h.writeUInt16LE(8, 34);
  h.write('data', 36); h.writeUInt32LE(data.length, 40);
  fs.writeFileSync(file, Buffer.concat([h, data]));
}
function makeMp3(file) { // 40 silent MPEG-1 Layer III frames (128 kbps, 44.1 kHz, 417 bytes each)
  const frame = Buffer.alloc(417); frame.writeUInt32BE(0xfffb9000, 0);
  fs.writeFileSync(file, Buffer.concat(Array(40).fill(frame)));
}
const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
function ffmpegMake(file, codecArgs) { // real encoders, only when ffmpeg is installed
  const r = spawnSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', ...codecArgs, file]);
  assert.strictEqual(r.status, 0, 'ffmpeg failed: ' + String(r.stderr).slice(-200));
}
function makePng(file) {
  const zlib = require('zlib');
  const crcT = Array.from({ length: 256 }, (_, i) => { let c = i; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const ch = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(4, 0); ihdr.writeUInt32BE(4, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.concat(Array(4).fill(Buffer.concat([Buffer.from([0]), Buffer.alloc(12, 200)])));
  fs.writeFileSync(file, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), ch('IHDR', ihdr), ch('IDAT', zlib.deflateSync(raw)), ch('IEND', Buffer.alloc(0))]));
}

const formats = {
  wav: (f) => makeWav(f),
  mp3: (f) => makeMp3(f),
};
if (hasFfmpeg) {
  formats.flac = (f) => ffmpegMake(f, ['-c:a', 'flac']);
  formats.ogg = (f) => ffmpegMake(f, ['-c:a', 'libvorbis']);
  formats.opus = (f) => ffmpegMake(f, ['-c:a', 'libopus']);
  formats.m4a = (f) => ffmpegMake(f, ['-c:a', 'aac']);
} else skipped.push('flac/ogg/opus/m4a (ffmpeg not installed)');

(async () => {
  const patch = {
    title: 'Héllo ♪ 你好', artist: 'Artist A; Artist B', album: 'The Album', albumArtist: 'Various', genre: 'Rock; Indie',
    composer: 'Comp', comment: 'a comment', year: '2024', track: 3, trackCount: 12, disc: 1, discCount: 2,
  };

  for (const [fmt, make] of Object.entries(formats)) {
    const f = path.join(tmp, `song.${fmt}`);
    make(f);
    const before = T.readTags(f);
    assert(before.durationMs > 0, `${fmt}: duration`);
    T.writeTags(f, patch);
    const t = T.readTags(f).tags;
    assert.strictEqual(t.title, patch.title, `${fmt} title`);
    assert.strictEqual(t.artist, 'Artist A; Artist B', `${fmt} artist`);
    assert.strictEqual(t.album, 'The Album', `${fmt} album`);
    assert.strictEqual(t.year, 2024, `${fmt} year`);
    assert.strictEqual(t.track, 3, `${fmt} track`);
    assert.strictEqual(t.disc, 1, `${fmt} disc`);
    assert.strictEqual(t.genre, 'Rock; Indie', `${fmt} genre`);
    ok(`${fmt}: read + write all fields (unicode, multi-value)`);
  }

  // partial patch leaves other fields alone; empty string clears
  const mp3 = path.join(tmp, 'song.mp3');
  T.writeTags(mp3, { title: 'Only Title Changed' });
  let t = T.readTags(mp3).tags;
  assert.strictEqual(t.title, 'Only Title Changed');
  assert.strictEqual(t.album, 'The Album');
  assert.strictEqual(t.track, 3);
  T.writeTags(mp3, { album: '', track: '' });
  t = T.readTags(mp3).tags;
  assert.strictEqual(t.album, '');
  assert.strictEqual(t.track, 0);
  assert.strictEqual(t.title, 'Only Title Changed');
  ok('partial patches + clearing fields');

  // cover art: set, read back, remove
  const png = path.join(tmp, 'cover.png');
  makePng(png);
  for (const fmt of Object.keys(formats)) {
    const f = path.join(tmp, `song.${fmt}`);
    T.writeTags(f, { cover: { action: 'set' } }, png);
    assert.strictEqual(T.readTags(f).hasCover, true, `${fmt} hasCover`);
    const c = T.readCover(f);
    assert(c && c.mime === 'image/png' && c.dataUrl.startsWith('data:image/png;base64,'), `${fmt} cover data`);
    T.writeTags(f, { cover: { action: 'remove' } });
    assert.strictEqual(T.readTags(f).hasCover, false, `${fmt} cover removed`);
    assert.strictEqual(T.readCover(f), null);
  }
  ok('cover set / read / remove on every format');

  // an unsupported cover file is refused BEFORE the audio file is touched
  const snap = fs.readFileSync(mp3);
  assert.throws(() => T.writeTags(mp3, { cover: { action: 'set' } }, path.join(tmp, 'x.txt')), /Cover must be/);
  assert.deepStrictEqual(fs.readFileSync(mp3), snap);
  assert.throws(() => T.writeTags(path.join(tmp, 'x.txt'), { title: 'x' }), /Unsupported/);
  ok('bad inputs rejected, audio untouched');

  // renaming
  assert.strictEqual(T.fillPattern('{track} - {title}', { track: 3, title: 'Intro' }), '03 - Intro');
  assert.strictEqual(T.fillPattern('{artist} - {title}', { artist: '', title: 'Solo' }), 'Solo');
  assert.strictEqual(T.sanitizeFileName('AC/DC: Back <in> Black?'), 'AC_DC_ Back _in_ Black_');
  assert.strictEqual(T.sanitizeFileName('CON'), 'CON_');
  assert.strictEqual(T.sanitizeFileName('trailing. . '), 'trailing');
  const r = path.join(tmp, 'rename-me.wav'); formats.wav(r);
  T.writeTags(r, { title: 'Intro', track: 1, artist: 'Band' });
  const moved = T.renameFromTags(r, '{track} - {artist} - {title}');
  assert.strictEqual(path.basename(moved), '01 - Band - Intro.wav');
  assert(fs.existsSync(moved) && !fs.existsSync(r));
  // collision: another file already has the target name -> numbered, never overwritten
  const r2 = path.join(tmp, 'other.wav'); formats.wav(r2);
  T.writeTags(r2, { title: 'Intro', track: 1, artist: 'Band' });
  const moved2 = T.renameFromTags(r2, '{track} - {artist} - {title}');
  assert.strictEqual(path.basename(moved2), '01 - Band - Intro (1).wav');
  assert(fs.existsSync(moved));
  // empty pattern result keeps the file name
  const r3 = path.join(tmp, 'keep.wav'); formats.wav(r3);
  assert.strictEqual(T.renameFromTags(r3, '{title}'), r3);
  ok('rename from tags: pattern, sanitising, collisions, empty result');

  // splitting
  assert.deepStrictEqual(T.splitList(' a ;b;; c '), ['a', 'b', 'c']);
  ok('splitList');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${n} checks passed${skipped.length ? ` (skipped: ${skipped.join(', ')})` : ''}`);
})().catch((e) => { console.error('FAIL:', e); process.exit(1); });
