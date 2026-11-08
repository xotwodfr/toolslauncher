'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sharp = require('sharp');
const { convertOne, normalizeOptions, uniquePath, isSupportedInput } = require('../src/convert');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-test-'));
let n = 0;
const ok = (m) => { n++; console.log('  ok  ' + m); };

(async () => {
  // 400x200 semi-transparent red PNG
  const src = path.join(tmp, 'photo.png');
  await sharp({ create: { width: 400, height: 200, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 0.5 } } }).png().toFile(src);

  // every output format, written next to the source
  for (const [format, ext] of [['jpeg', '.jpg'], ['webp', '.webp'], ['avif', '.avif'], ['png', '.png']]) {
    const r = await convertOne(src, { format, quality: 80 });
    assert.strictEqual(path.extname(r.output), ext);
    const meta = await sharp(r.output).metadata();
    assert.strictEqual(meta.width, 400);
    assert.strictEqual(meta.height, 200);
    assert(r.outBytes > 0);
  }
  ok('png -> jpeg/webp/avif/png');

  // never overwrites: png->png goes to "photo (1).png", source untouched
  assert(fs.existsSync(path.join(tmp, 'photo (1).png')));
  assert.strictEqual((await sharp(src).metadata()).width, 400);
  ok('does not overwrite source');

  // jpeg flattens alpha onto white (not black)
  const jpg = await sharp(path.join(tmp, 'photo.jpg')).raw().toBuffer({ resolveWithObject: true });
  assert(jpg.info.channels === 3 && jpg.data[1] > 100, 'transparent area should be light, got G=' + jpg.data[1]);
  ok('jpeg flattens transparency to white');

  // resize: fit inside, aspect kept, no enlargement
  let r = await convertOne(src, { format: 'webp', resize: { enabled: true, width: 100, height: 100 }, outDir: path.join(tmp, 'out') });
  assert.deepStrictEqual([r.width, r.height], [100, 50]);
  r = await convertOne(src, { format: 'webp', resize: { enabled: true, width: 2000, height: null }, outDir: path.join(tmp, 'out') });
  assert.deepStrictEqual([r.width, r.height], [400, 200]);
  assert(path.dirname(r.output) === path.join(tmp, 'out'));
  ok('resize keeps aspect, no upscaling, custom out dir');

  // EXIF orientation is applied
  const rot = path.join(tmp, 'rot.jpg');
  await sharp({ create: { width: 200, height: 100, channels: 3, background: '#09f' } }).withMetadata({ orientation: 6 }).jpeg().toFile(rot);
  r = await convertOne(rot, { format: 'png' });
  assert.deepStrictEqual([r.width, r.height], [100, 200]);
  ok('EXIF rotation applied');

  // validation of untrusted options / inputs
  assert.throws(() => normalizeOptions({ format: 'exe' }), /Unsupported/);
  assert.strictEqual(normalizeOptions({ format: 'jpeg', quality: 9999 }).quality, 100);
  assert.strictEqual(normalizeOptions({ format: 'jpeg', quality: 'abc' }).quality, 85);
  await assert.rejects(() => convertOne(path.join(tmp, 'x.txt'), { format: 'png' }), /Unsupported file type/);
  await assert.rejects(() => convertOne(path.join(tmp, 'missing.png'), { format: 'png' }));
  assert(isSupportedInput('A.JPG') && !isSupportedInput('a.doc'));
  ok('option + input validation');

  // corrupt image gives an error, not a crash
  const bad = path.join(tmp, 'bad.png');
  fs.writeFileSync(bad, 'not an image');
  await assert.rejects(() => convertOne(bad, { format: 'jpeg' }));
  ok('corrupt image rejected');

  assert.strictEqual(path.basename(uniquePath(tmp, 'fresh', '.png')), 'fresh.png');
  ok('uniquePath');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${n} checks passed`);
})().catch((e) => { console.error('FAIL:', e); process.exit(1); });
