'use strict';
// Photo Batch Editor core tests. Every step runs on images generated here, and the results are checked by reading the
// pixels back with sharp: sizes, crop ratios, where the watermark landed, grey really being grey, border colours, the
// camera's orientation, metadata stripped or kept, names from the pattern, and never writing over a file.
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sharp = require('../src/sharp-loader');
const exifReader = require('exif-reader');
const R = require('../src/recipe');
const P = require('../src/pipeline');
const B = require('../src/batch');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'photo-test-'));
const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const near = (a, b, tol, msg) => assert(Math.abs(a - b) <= tol, `${msg || ''} expected ${b} +/- ${tol}, got ${a}`);
const step = (type, o = {}) => ({ ...R.freshStep(type), ...o });
const hash = (f) => crypto.createHash('md5').update(fs.readFileSync(f)).digest('hex');

/** A test photo: a colour gradient with a few shapes, w x h, optionally with EXIF. */
async function photo(name, w, h, { orientation, exif, format = 'jpeg', fill } = {}) {
  const f = path.join(tmp, name);
  let p;
  if (fill) p = sharp({ create: { width: w, height: h, channels: 3, background: fill } });
  else {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><defs><linearGradient id="g"><stop offset="0" stop-color="#d04030"/><stop offset="1" stop-color="#3060d0"/></linearGradient></defs><rect width="100%" height="100%" fill="url(#g)"/><circle cx="${w * 0.3}" cy="${h * 0.4}" r="${Math.min(w, h) * 0.15}" fill="#f0e060"/></svg>`;
    p = sharp(Buffer.from(svg));
  }
  if (format === 'jpeg') p = p.jpeg({ quality: 92 }); else if (format === 'png') p = p.png(); else p = p.webp();
  if (exif) p = p.withExif(exif);
  if (orientation) p = p.withMetadata({ orientation });
  await p.toFile(f);
  return f;
}
async function pixels(file) { const r = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true }); return { ...r.info, data: r.data, at: (x, y) => { const i = (y * r.info.width + x) * 4; return [r.data[i], r.data[i + 1], r.data[i + 2], r.data[i + 3]]; } }; }
async function edit(input, recipe, output = {}, name) {
  const out = path.join(tmp, name || `out-${Math.random().toString(36).slice(2)}.${R.EXT[P.outputFormat(R.cleanOutput(output), (await P.inspect(input)).format)]}`);
  await P.processFile(input, recipe, { metadata: 'strip', ...output }, { outPath: out });
  return out;
}

// ---- resize and crop ----------------------------------------------------------------------------------------------------
test('resize: long edge, never upscale, percent, exact (cover / fill / inside)', async () => {
  const f = await photo('r.jpg', 400, 300);
  const dims = async (s) => { const m = await sharp(await edit(f, [step('resize', s)])).metadata(); return [m.width, m.height]; };
  assert.deepStrictEqual(await dims({ mode: 'long', long: 200 }), [200, 150]);
  assert.deepStrictEqual(await dims({ mode: 'long', long: 1000, noUpscale: true }), [400, 300]);
  assert.deepStrictEqual(await dims({ mode: 'long', long: 1000, noUpscale: false }), [1000, 750]);
  assert.deepStrictEqual(await dims({ mode: 'percent', percent: 25 }), [100, 75]);
  assert.deepStrictEqual(await dims({ mode: 'exact', width: 120, height: 120, fit: 'cover' }), [120, 120]);
  assert.deepStrictEqual(await dims({ mode: 'exact', width: 100, height: 300, fit: 'fill' }), [100, 300]);
  assert.deepStrictEqual(await dims({ mode: 'exact', width: 200, height: 200, fit: 'inside' }), [200, 150]);
  assert.deepStrictEqual(await dims({ mode: 'exact', width: 800, height: 800, fit: 'cover', noUpscale: true }), [300, 300]);
});

test('crop: 1:1, 16:9, 4:5, custom and "match the photo\'s orientation" give the exact ratio, as big as fits', async () => {
  const f = await photo('c.jpg', 400, 300);
  const p = await photo('cp.jpg', 300, 400);
  const dims = async (src, s) => { const m = await sharp(await edit(src, [step('crop', s)])).metadata(); return [m.width, m.height]; };
  assert.deepStrictEqual(await dims(f, { aspect: '1:1' }), [300, 300]);
  assert.deepStrictEqual(await dims(f, { aspect: '16:9' }), [400, 225]);
  assert.deepStrictEqual(await dims(f, { aspect: '4:5' }), [240, 300]);
  assert.deepStrictEqual(await dims(f, { aspect: 'custom', customW: 2, customH: 1 }), [400, 200]);
  assert.deepStrictEqual(await dims(p, { aspect: '3:2' }), [300, 200]);
  assert.deepStrictEqual(await dims(p, { aspect: '3:2', matchOrientation: true }), [267, 400]);
});

test('crop: the smart anchor keeps the interesting part (a detailed patch on the right of a plain photo)', async () => {
  const w = 600; const h = 300;
  let cells = '';
  for (let y = 0; y < 10; y++) for (let x = 0; x < 10; x++) cells += `<rect x="${465 + x * 13}" y="${80 + y * 14}" width="14" height="14" fill="${(x + y) % 2 ? '#ff2020' : '#20ff40'}"/>`;
  const f = path.join(tmp, 'busy.png');
  await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="100%" height="100%" fill="#808080"/>${cells}</svg>`)).png().toFile(f);
  const centre = await pixels(await edit(f, [step('crop', { aspect: '1:1', anchor: 'centre' })]));
  const smart = await pixels(await edit(f, [step('crop', { aspect: '1:1', anchor: 'attention' })]));
  const colourful = (px) => { let n = 0; for (let i = 0; i < px.data.length; i += 4) if (Math.max(px.data[i], px.data[i + 1], px.data[i + 2]) - Math.min(px.data[i], px.data[i + 1], px.data[i + 2]) > 100) n++; return n; };
  assert.strictEqual(colourful(centre), 0, 'centre crop misses the patch');
  assert(colourful(smart) > 10000, 'smart crop keeps the patch: ' + colourful(smart));
});

// ---- orientation, rotation ---------------------------------------------------------------------------------------------
test('orientation: a photo stored sideways with EXIF orientation 6 comes out upright (and its orientation tag reset)', async () => {
  // stored 40x20: left half red, right half blue. Orientation 6 = show it turned 90 degrees clockwise: red on top.
  const f = path.join(tmp, 'o6.jpg');
  await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><rect width="20" height="20" fill="#ff0000"/><rect x="20" width="20" height="20" fill="#0000ff"/></svg>')).jpeg({ quality: 95 }).withMetadata({ orientation: 6 }).toFile(f);
  const info = await P.inspect(f);
  assert.deepStrictEqual([info.width, info.height, info.orientation], [20, 40, 6]);
  const out = await edit(f, [], { metadata: 'keep' });
  const px = await pixels(out);
  assert.deepStrictEqual([px.width, px.height], [20, 40]);
  const top = px.at(10, 5); const bottom = px.at(10, 35);
  assert(top[0] > 200 && top[2] < 60, 'red on top ' + top);
  assert(bottom[2] > 200 && bottom[0] < 60, 'blue at the bottom ' + bottom);
  assert.strictEqual((await sharp(out).metadata()).orientation || 1, 1, 'orientation tag reset');
  // and with auto-orient off, it stays as stored
  const raw = await pixels(await edit(f, [], { autoOrient: false }));
  assert.deepStrictEqual([raw.width, raw.height], [40, 20]);
});

test('rotate 90, flip horizontally, and a free angle grows the canvas with the background colour', async () => {
  const f = path.join(tmp, 'lr.png');
  await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><rect width="20" height="20" fill="#ff0000"/><rect x="20" width="20" height="20" fill="#0000ff"/></svg>')).png().toFile(f);
  const r = await pixels(await edit(f, [step('rotate', { angle: 90 })]));
  assert.deepStrictEqual([r.width, r.height], [20, 40]);
  assert(r.at(10, 5)[0] > 200, 'red on top after turning clockwise');
  const fl = await pixels(await edit(f, [step('rotate', { flipH: true })]));
  assert(fl.at(5, 10)[2] > 200 && fl.at(35, 10)[0] > 200, 'mirrored');
  const free = await pixels(await edit(f, [step('rotate', { angle: 30, background: '#00ff00' })]));
  const want = R.rotatedBox(40, 20, 30);
  near(free.width, want.width, 1); near(free.height, want.height, 1);
  const c = free.at(0, 0); assert(c[1] > 200 && c[0] < 60, 'corner is the background ' + c);
});

// ---- colour -------------------------------------------------------------------------------------------------------------------
test('grayscale has R = G = B everywhere; sepia is warm (R > G > B)', async () => {
  const f = await photo('col.png', 120, 80, { format: 'png' });
  const g = await pixels(await edit(f, [step('tone', { mode: 'grayscale' })]));
  for (let i = 0; i < g.data.length; i += 4) assert(g.data[i] === g.data[i + 1] && g.data[i + 1] === g.data[i + 2], 'pixel ' + (i / 4) + ': ' + [g.data[i], g.data[i + 1], g.data[i + 2]]);
  const s = await pixels(await edit(f, [step('tone', { mode: 'sepia' })]));
  const p = s.at(100, 70); assert(p[0] > p[1] && p[1] > p[2], 'sepia ' + p);
});

test('auto levels stretches a flat photo; brightness, saturation and warmth move the right way', async () => {
  const flat = path.join(tmp, 'flat.png');
  await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="50"><defs><linearGradient id="g"><stop offset="0" stop-color="#646464"/><stop offset="1" stop-color="#969696"/></linearGradient></defs><rect width="100%" height="100%" fill="url(#g)"/></svg>')).png().toFile(flat);
  const st = async (f) => (await sharp(f).stats()).channels;
  const lv = await st(await edit(flat, [step('levels', { strength: 'normal' })]));
  assert(lv[0].min < 20 && lv[0].max > 235, `levels: ${lv[0].min}..${lv[0].max}`);
  const f = await photo('adj.png', 100, 60, { format: 'png' });
  const base = await st(f);
  const bright = await st(await edit(f, [step('adjust', { brightness: 40 })]));
  assert(bright[1].mean > base[1].mean + 10, 'brighter');
  const grey = await pixels(await edit(f, [step('adjust', { saturation: -100 })]));
  const q = grey.at(80, 30); assert(Math.max(...q.slice(0, 3)) - Math.min(...q.slice(0, 3)) <= 3, 'no colour left ' + q);
  const warm = await st(await edit(f, [step('adjust', { warmth: 80 })]));
  assert(warm[0].mean > base[0].mean + 5 && warm[2].mean < base[2].mean - 5, 'warmer: more red, less blue');
  const contrast = await st(await edit(f, [step('adjust', { contrast: 60 })]));
  assert(contrast[1].stdev > base[1].stdev * 1.3, 'more contrast');
  const sharp_ = await st(await edit(f, [step('sharpen', { amount: 'strong' })]));
  assert(sharp_[0].mean > 0, 'sharpen runs');
});

// ---- border, watermarks, corners ---------------------------------------------------------------------------------------------
test('border: the right width on every side (as % of the short side) in the chosen colour', async () => {
  const f = await photo('b.png', 300, 200, { format: 'png' });
  const px = await pixels(await edit(f, [step('border', { size: 5, colour: '#12ab34' })]));
  assert.deepStrictEqual([px.width, px.height], [320, 220]);
  for (const [x, y] of [[2, 2], [317, 110], [160, 217], [9, 100]]) assert.deepStrictEqual(px.at(x, y).slice(0, 3), [0x12, 0xab, 0x34], `at ${x},${y}`);
  assert.notDeepStrictEqual(px.at(12, 100).slice(0, 3), [0x12, 0xab, 0x34], 'the photo starts after 10 px');
});

test('text watermark: bright pixels appear in the chosen corner only, at the chosen opacity', async () => {
  const f = await photo('t.png', 400, 300, { format: 'png', fill: '#000000' });
  const quadrant = (px, qx, qy) => { let n = 0; let top = 0; for (let y = qy * 150; y < qy * 150 + 150; y++) for (let x = qx * 200; x < qx * 200 + 200; x++) { const v = px.at(x, y)[0]; if (v > 60) n++; top = Math.max(top, v); } return { n, top }; };
  const px = await pixels(await edit(f, [step('text', { text: 'Sample ✓ Ünïcode', size: 6, colour: '#ffffff', opacity: 100, position: 'bottom-right', shadow: false })]));
  assert(quadrant(px, 1, 1).n > 200, 'text in the bottom right: ' + quadrant(px, 1, 1).n);
  for (const [qx, qy] of [[0, 0], [1, 0]]) assert.strictEqual(quadrant(px, qx, qy).n, 0, `nothing in quadrant ${qx},${qy}`);
  const half = await pixels(await edit(f, [step('text', { text: 'Sample', size: 6, colour: '#ffffff', opacity: 50, position: 'top-left', shadow: false })]));
  const q = quadrant(half, 0, 0);
  assert(q.n > 100 && q.top >= 115 && q.top <= 140, 'half-transparent white over black is mid grey: ' + q.top);
  assert.strictEqual(quadrant(half, 1, 1).n, 0);
});

test('logo watermark: the PNG logo lands in the chosen corner, scaled, with its opacity', async () => {
  const logo = path.join(tmp, 'logo.png');
  await sharp({ create: { width: 50, height: 25, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 1 } } }).png().toFile(logo);
  const f = await photo('lw.png', 400, 300, { format: 'png', fill: '#0000ff' });
  const px = await pixels(await edit(f, [step('logo', { file: logo, scale: 25, opacity: 100, position: 'top-left', margin: 5 })]));
  // 25% of 400 = 100 px wide, 50 high, 5% of 300 = 15 px from the edges
  assert.deepStrictEqual(px.at(16, 16).slice(0, 3), [255, 0, 0]);
  assert.deepStrictEqual(px.at(114, 64).slice(0, 3), [255, 0, 0]);
  assert.deepStrictEqual(px.at(117, 40).slice(0, 3), [0, 0, 255], 'logo ends at 115');
  assert.deepStrictEqual(px.at(390, 290).slice(0, 3), [0, 0, 255], 'nothing elsewhere');
  const half = await pixels(await edit(f, [step('logo', { file: logo, scale: 25, opacity: 50, position: 'bottom-right', margin: 0 })]));
  const c = half.at(390, 290); near(c[0], 128, 3); near(c[2], 127, 3);
  await assert.rejects(edit(f, [step('logo', { file: path.join(tmp, 'gone.png') })]), /logo file is missing/);
});

test('rounded corners: transparent corners in PNG, the background colour in JPEG', async () => {
  const f = await photo('rc.png', 200, 100, { format: 'png', fill: '#ff0000' });
  const png = await pixels(await edit(f, [step('corners', { radius: 20 })], { format: 'png' }));
  assert.strictEqual(png.at(0, 0)[3], 0, 'corner transparent');
  assert.strictEqual(png.at(100, 50)[3], 255, 'middle solid');
  assert.strictEqual(png.at(100, 0)[3], 255, 'edge between corners solid');
  const jpg = await pixels(await edit(f, [step('corners', { radius: 20, background: '#00ff00' })], { format: 'jpeg' }));
  const c = jpg.at(1, 1); assert(c[1] > 220 && c[0] < 40, 'green corner ' + c);
});

test('the steps run in the order of the recipe (border then resize differs from resize then border), and the size is predicted', async () => {
  const f = await photo('ord.jpg', 400, 300);
  const a = [step('border', { size: 10 }), step('resize', { mode: 'long', long: 200 })];
  const b = [step('resize', { mode: 'long', long: 200 }), step('border', { size: 10 })];
  const ma = await sharp(await edit(f, a)).metadata(); const mb = await sharp(await edit(f, b)).metadata();
  assert.deepStrictEqual([ma.width, ma.height], [200, 157]);
  assert.deepStrictEqual([mb.width, mb.height], [230, 180]);
  assert.deepStrictEqual(R.predictSize(400, 300, R.cleanRecipe(a)), { width: 200, height: 157 });
  assert.deepStrictEqual(R.predictSize(400, 300, R.cleanRecipe(b)), { width: 230, height: 180 });
  const off = [step('border', { size: 10, on: false })];
  const mo = await sharp(await edit(f, off)).metadata();
  assert.deepStrictEqual([mo.width, mo.height], [400, 300], 'a step switched off does nothing');
});

// ---- output ------------------------------------------------------------------------------------------------------------------
test('output formats: keep, JPEG, PNG, WebP and AVIF are written as asked; quality changes the size', async () => {
  const f = await photo('fmt.png', 300, 200, { format: 'png' });
  for (const [fmt, want] of [['keep', 'png'], ['jpeg', 'jpeg'], ['png', 'png'], ['webp', 'webp'], ['avif', 'heif']]) {
    const out = await edit(f, [], { format: fmt });
    assert.strictEqual((await sharp(out).metadata()).format, want, fmt);
  }
  const lo = fs.statSync(await edit(f, [], { format: 'jpeg', quality: 30 })).size;
  const hi = fs.statSync(await edit(f, [], { format: 'jpeg', quality: 95 })).size;
  assert(lo < hi, `quality 30 (${lo}) smaller than 95 (${hi})`);
});

test('metadata: stripped, copyright + date only, or kept (camera, GPS) - and the orientation is never left stale', async () => {
  const exif = { IFD0: { Copyright: '(c) Invented Studio', Artist: 'Sam Example', Make: 'InventedCam', Model: 'X1' }, IFD2: { DateTimeOriginal: '2024:05:06 07:08:09' }, IFD3: { GPSLatitudeRef: 'N', GPSLongitudeRef: 'E' } };
  const f = await photo('meta.jpg', 120, 80, { exif });
  const read = async (out) => { const m = await sharp(out).metadata(); return m.exif ? exifReader(m.exif) : null; };
  assert.strictEqual(await read(await edit(f, [], { metadata: 'strip' })), null, 'strip removes the EXIF');
  const c = await read(await edit(f, [], { metadata: 'copyright' }));
  assert.strictEqual(c.Image.Copyright, '(c) Invented Studio'); assert.strictEqual(c.Image.Artist, 'Sam Example');
  assert.strictEqual(c.Photo.DateTimeOriginal.toISOString(), '2024-05-06T07:08:09.000Z');
  assert(!c.Image.Make && !c.GPSInfo, 'no camera, no location');
  const k = await read(await edit(f, [step('resize', { mode: 'long', long: 60 })], { metadata: 'keep' }));
  assert.strictEqual(k.Image.Make, 'InventedCam'); assert(k.GPSInfo && k.GPSInfo.GPSLatitudeRef === 'N', 'location kept');
  const info = await P.inspect(f);
  assert.strictEqual(info.date.getFullYear(), 2024); assert.strictEqual(info.date.getHours(), 7, 'camera time read as local time');
});

test('rename pattern: {name}, {n:3}, {date}, {time}, {w}x{h}; unsafe characters replaced', () => {
  const d = new Date(2024, 4, 6, 7, 8, 9);
  assert.strictEqual(R.expandPattern('{name}-{n:3}-{date}_{w}x{h}', { name: 'IMG_0001', n: 7, date: d, width: 2048, height: 1365 }), 'IMG_0001-007-2024-05-06_2048x1365');
  assert.strictEqual(R.expandPattern('{date} {time} {n}', { name: 'x', n: 12, date: d }), '2024-05-06 07-08-09 12');
  assert.strictEqual(R.expandPattern('trip/{name}:*?', { name: 'Été à Paris' }), 'trip_Été à Paris___');
  assert.strictEqual(R.expandPattern('{date}', { name: 'x' }), 'undated');
  assert.strictEqual(R.expandPattern('   ', { name: 'fallback' }), 'fallback');
  assert.strictEqual(R.expandPattern('con', { name: 'x' }), '_con');
  assert.strictEqual(R.expandPattern('{unknown}-{name}', { name: 'a' }), '{unknown}-a');
});

test('names never collide: existing files, files being written, other jobs of the batch and the originals are skipped', () => {
  const d = path.join(tmp, 'names'); fs.mkdirSync(d);
  fs.writeFileSync(path.join(d, 'a.jpg'), 'x');
  fs.writeFileSync(path.join(d, 'a (2).jpg.part'), 'x');
  const taken = new Set();
  assert.strictEqual(path.basename(B.freePath(d, 'a', 'jpg', taken)), 'a (3).jpg');
  assert.strictEqual(path.basename(B.freePath(d, 'a', 'jpg', taken)), 'a (4).jpg', 'a name another job took');
  const protect = new Set([path.resolve(path.join(d, 'b.png'))]);
  assert.strictEqual(path.basename(B.freePath(d, 'b', 'png', new Set(), protect)), 'b (2).png', 'never the original');
});

test('batch: many photos in parallel, unicode names, a broken file reported in plain words, originals untouched', async () => {
  const d = path.join(tmp, 'batch'); fs.mkdirSync(d);
  const files = [];
  for (const [n, w, h] of [['Été 1.jpg', 400, 300], ['北京 2.jpg', 300, 400], ['three.png', 500, 500], ['four.webp', 640, 360]]) {
    const f = await photo(n, w, h, { format: n.endsWith('png') ? 'png' : n.endsWith('webp') ? 'webp' : 'jpeg' });
    const to = path.join(d, n); fs.renameSync(f, to); files.push(to);
  }
  const broken = path.join(d, 'broken.jpg'); fs.writeFileSync(broken, Buffer.alloc(3000, 7)); files.splice(2, 0, broken);
  const before = files.map(hash);
  const events = [];
  const r = await B.runBatch(files, [step('resize', { mode: 'long', long: 200 }), step('text', { text: 'Test' })], { folder: d, pattern: '{name}', format: 'keep', metadata: 'strip' }, { jobs: 3, onItem: (e) => events.push(e) });
  assert.deepStrictEqual([r.done, r.failed, r.cancelled], [4, 1, 0]);
  assert.deepStrictEqual(files.map(hash), before, 'originals unchanged');
  const names = fs.readdirSync(d).sort();
  for (const n of ['Été 1 (2).jpg', '北京 2 (2).jpg', 'three (2).png', 'four (2).webp']) assert(names.includes(n), n + ' in ' + names);
  const bad = events.find((e) => e.status === 'error');
  assert.strictEqual(bad.file, broken); assert(/damaged|not a photo/.test(bad.error), bad.error);
  const out = events.find((e) => e.status === 'done' && /北京/.test(e.out));
  assert.deepStrictEqual([out.width, out.height], [150, 200]);
  assert.strictEqual(fs.readdirSync(d).filter((n) => n.endsWith('.part')).length, 0);
  // the default output folder is "edited" next to the photos, and {n:3} numbers in list order
  const r2 = await B.runBatch(files.filter((f) => f !== broken), [], { pattern: 'trip-{n:3}', format: 'jpeg' }, { jobs: 2 });
  assert.strictEqual(r2.done, 4);
  assert.deepStrictEqual(fs.readdirSync(path.join(d, 'edited')).sort(), ['trip-001.jpg', 'trip-002.jpg', 'trip-003.jpg', 'trip-004.jpg']);
});

test('batch: Cancel stops the queue and leaves no half-written file', async () => {
  const d = path.join(tmp, 'cancel'); fs.mkdirSync(d);
  const files = [];
  for (let i = 0; i < 12; i++) { const f = await photo(`p${i}.jpg`, 1600, 1200); const to = path.join(d, `p${i}.jpg`); fs.renameSync(f, to); files.push(to); }
  const ac = new AbortController();
  let started = 0;
  const p = B.runBatch(files, [step('resize', { mode: 'percent', percent: 150, noUpscale: false }), step('sharpen'), step('levels')], { folder: path.join(d, 'out'), format: 'png' }, { jobs: 2, signal: ac.signal, onItem: (e) => { if (e.status === 'working' && ++started === 2) ac.abort(); } });
  const r = await p;
  assert(r.cancelled >= 10, JSON.stringify(r));
  assert.strictEqual(r.done + r.cancelled + r.failed, 12);
  const left = fs.existsSync(path.join(d, 'out')) ? fs.readdirSync(path.join(d, 'out')) : [];
  assert.strictEqual(left.filter((n) => n.endsWith('.part')).length, 0);
  assert.strictEqual(left.length, r.done);
});

test('preview: before/after at reduced size; pixel sizes in the recipe scale with it; the full output size is reported', async () => {
  const f = await photo('pv.jpg', 3000, 2000);
  const pv = await P.preview(f, [step('resize', { mode: 'long', long: 1500 }), step('border', { size: 2 })], { format: 'jpeg' }, { box: 600 });
  assert(/^data:image\/jpeg;base64,/.test(pv.before) && /^data:image\/jpeg;base64,/.test(pv.after));
  assert.deepStrictEqual([pv.width, pv.height], [1540, 1040], 'full size');
  assert.deepStrictEqual([pv.previewWidth, pv.previewHeight], [308, 208], 'preview is the full result at a fifth');
  const png = await P.preview(f, [step('corners', { radius: 10 })], { format: 'png' }, { box: 300 });
  assert(/^data:image\/png/.test(png.after), 'transparent corners shown as PNG');
});

test('settings from the window are validated: unknown steps dropped, numbers clamped, bad colours replaced', () => {
  const r = R.cleanRecipe([{ type: 'evil' }, null, { type: 'resize', long: -5, mode: 'weird' }, { type: 'border', size: 999, colour: 'red' }, { type: 'text', text: 'x'.repeat(500), position: 'nowhere' }]);
  assert.strictEqual(r.length, 3);
  assert.strictEqual(r[0].long, 1); assert.strictEqual(r[0].mode, 'long');
  assert.strictEqual(r[1].size, 50); assert.strictEqual(r[1].colour, '#ffffff');
  assert.strictEqual(r[2].text.length, 200); assert.strictEqual(r[2].position, 'bottom-right');
  const o = R.cleanOutput({ format: 'bmp', quality: 500, metadata: 'all', pattern: '', jobs: 99 });
  assert.deepStrictEqual([o.format, o.quality, o.metadata, o.pattern, o.jobs], ['keep', 100, 'copyright', '{name}-edited', 16]);
  assert.strictEqual(R.cleanRecipe('nope').length, 0);
});

test('the colours of the window are readable (WCAG AA contrast)', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'styles.css'), 'utf8');
  const tokens = {};
  for (const m of css.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-fA-F]{6})/g)) tokens[m[1]] = m[2];
  const lum = (hex) => { const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  const pairs = [['text', 'bg', 4.5], ['muted', 'bg', 4.5], ['muted', 'panel', 4.5], ['accent', 'bg', 4.5], ['err', 'bg', 4.5], ['ok', 'bg', 4.5], ['warn', 'bg', 4.5]];
  const bad = pairs.filter(([a, b, min]) => !tokens[a] || !tokens[b] || ratio(tokens[a], tokens[b]) < min).map(([a, b, min]) => `${a} on ${b} < ${min}`);
  assert.deepStrictEqual(bad, []);
});

(async () => {
  let failed = 0;
  for (const [name, fn] of tests) {
    const t0 = Date.now();
    try { await fn(); console.log(`ok   ${name} (${Date.now() - t0} ms)`); }
    catch (e) { failed++; console.log(`FAIL ${name}\n     ${String((e && e.stack) || e).split('\n').slice(0, 6).join('\n     ')}`); }
  }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  console.log(failed ? `\n${failed} of ${tests.length} failed` : `\nall ${tests.length} passed`);
  process.exit(failed ? 1 : 0);
})();
