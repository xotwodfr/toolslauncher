'use strict';
// Background Remover core tests. The preparation and clean-up of pictures (plan.js) is checked exactly; the model is run for
// real on an INVENTED picture (src/scene.js: a potted plant on a busy background) whose true outline is known, and the cutout
// is compared with that outline. Real-photo quality is not claimed here.
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const P = require('../src/plan');
const C = require('../src/cutout');
const { drawScene } = require('../src/scene');

const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const near = (a, b, tol, msg) => assert(Math.abs(a - b) <= tol, `${msg || ''} expected ${b} +/- ${tol}, got ${a}`);

/** Squeeze an RGB picture to SIZE x SIZE RGBA with bilinear sampling (what the window does with a canvas). */
function toModelPicture(rgb, w, h) {
  const S = P.SIZE;
  const out = new Uint8ClampedArray(S * S * 4);
  for (let y = 0; y < S; y++) {
    const fy = ((y + 0.5) * h) / S - 0.5; const y0 = Math.max(0, Math.floor(fy)); const y1 = Math.min(h - 1, y0 + 1); const ty = Math.max(0, fy - y0);
    for (let x = 0; x < S; x++) {
      const fx = ((x + 0.5) * w) / S - 0.5; const x0 = Math.max(0, Math.floor(fx)); const x1 = Math.min(w - 1, x0 + 1); const tx = Math.max(0, fx - x0);
      for (let c = 0; c < 3; c++) {
        const a = rgb[(y0 * w + x0) * 3 + c] * (1 - tx) + rgb[(y0 * w + x1) * 3 + c] * tx;
        const b = rgb[(y1 * w + x0) * 3 + c] * (1 - tx) + rgb[(y1 * w + x1) * 3 + c] * tx;
        out[(y * S + x) * 4 + c] = a * (1 - ty) + b * ty;
      }
      out[(y * S + x) * 4 + 3] = 255;
    }
  }
  return out;
}
const truthAtModelSize = (truth, w, h) => {
  const S = P.SIZE; const t = new Uint8Array(S * S);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) t[y * S + x] = truth[Math.min(h - 1, Math.floor(((y + 0.5) * h) / S)) * w + Math.min(w - 1, Math.floor(((x + 0.5) * w) / S))];
  return t;
};
function iou(mask, truth) {
  let inter = 0; let union = 0;
  for (let i = 0; i < mask.length; i++) { const m = mask[i] >= 0.5; const t = truth[i] >= 128; if (m && t) inter++; if (m || t) union++; }
  return inter / union;
}

// ---- plan.js -----------------------------------------------------------------------------------------------------------------
test('plan: the model input is channels-first, scaled to 0..1 and shifted by 0.5, exactly', () => {
  const n = P.SIZE * P.SIZE;
  const rgba = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) { rgba[i * 4] = 255; rgba[i * 4 + 1] = 0; rgba[i * 4 + 2] = 51; rgba[i * 4 + 3] = 7; }
  const t = P.toTensor(rgba);
  assert.strictEqual(t.length, 3 * n);
  near(t[0], 0.5, 1e-6, 'red plane'); near(t[n + 5], -0.5, 1e-6, 'green plane'); near(t[2 * n + n - 1], 51 / 255 - 0.5, 1e-6, 'blue plane');
  assert.throws(() => P.toTensor(new Uint8ClampedArray(100)), /size/);
});

test('plan: the model answer is stretched to 0..1, and an answer with no difference is reported as flat', () => {
  const r = P.normaliseMask(Float32Array.from([-3, 0, 1, 5]));
  assert.deepStrictEqual(Array.from(r.mask), [0, 3 / 8, 0.5, 1]); assert.strictEqual(r.flat, false);
  const flat = P.normaliseMask(new Float32Array(10).fill(0.3));
  assert.strictEqual(flat.flat, true); assert(flat.mask.every((v) => v === 0));
});

test('plan: the edge control leaves 0 alone, never moves solid or empty pixels, and loosens or tightens the soft ones', () => {
  assert.strictEqual(P.edgeGamma(0), 1);
  assert(P.edgeGamma(50) < 1 && P.edgeGamma(-50) > 1, 'looser = smaller power');
  near(P.edgeGamma(50), 0.5, 1e-12); near(P.edgeGamma(-100), 4, 1e-12);
  for (const v of [-100, -40, 0, 40, 100]) { const g = P.edgeGamma(v); assert.strictEqual(0 ** g, 0); assert.strictEqual(1 ** g, 1); }
  assert(0.5 ** P.edgeGamma(50) > 0.5 && 0.5 ** P.edgeGamma(-50) < 0.5);
  for (let v = -100; v < 100; v += 10) assert(0.4 ** P.edgeGamma(v) < 0.4 ** P.edgeGamma(v + 10), 'monotonic');
});

test('plan: sizes, fitting, cover crops, blur radius and brush limits', () => {
  assert.deepStrictEqual(P.workSize(1000, 500), { w: 1000, h: 500, k: 1 });
  const big = P.workSize(6000, 4000); assert.strictEqual(big.w, 3000); assert.strictEqual(big.h, 2000); assert.strictEqual(big.k, 0.5);
  const f = P.fitView(800, 400, 1000, 800, 20);
  near(f.s, 960 / 800, 1e-9); near(f.ox, 20, 1e-6); near(f.oy, (800 - 400 * f.s) / 2, 1e-6);
  const c = P.coverRect(400, 200, 100, 100); assert.deepStrictEqual(c, { sx: 100, sy: 0, sw: 200, sh: 200 });
  const c2 = P.coverRect(200, 400, 100, 50); assert.deepStrictEqual(c2, { sx: 0, sy: 150, sw: 200, sh: 100 });
  near(P.blurPixels(50, 2000), 60, 1e-9); assert.strictEqual(P.blurPixels(0, 2000), 0);
  assert.strictEqual(P.clampBrush(1), 2); assert.strictEqual(P.clampBrush(999), 200); assert.strictEqual(P.clampBrush(36.4), 36);
  assert.strictEqual(P.formatBytes(2048), '2 KB'); assert.strictEqual(P.formatBytes(3 * 1048576), '3.0 MB');
});

test('plan: file types are told by their bytes, names are made from the picture name', () => {
  assert.strictEqual(P.sniff(Buffer.from('89504e470d0a1a0a0000000d', 'hex')), 'png');
  assert.strictEqual(P.sniff(Buffer.concat([Buffer.from('ffd8ffe000104a464946', 'hex'), Buffer.alloc(4)])), 'jpeg');
  assert.strictEqual(P.sniff(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 ')])), 'webp');
  assert.strictEqual(P.sniff(Buffer.from('GIF89a......')), null); assert.strictEqual(P.sniff(Buffer.alloc(5)), null); assert.strictEqual(P.sniff(null), null);
  assert.strictEqual(P.defaultName('holiday photo.JPG', 'png'), 'holiday photo-cutout.png');
  assert.strictEqual(P.defaultName('C:\\pics\\cat.jpeg', 'jpeg'), 'cat-cutout.jpg');
  assert.strictEqual(P.defaultName('noext', 'webp'), 'noext-cutout.webp');
  assert(P.isImage('A.PNG') && P.isImage('b.webp') && P.isImage('c.avif') && !P.isImage('d.txt') && !P.isImage('e'));
  assert.strictEqual(P.FORMATS.png.alpha && P.FORMATS.webp.alpha && !P.FORMATS.jpeg.alpha, true);
});

// ---- the invented pictures ----------------------------------------------------------------------------------------------------
test('scene: the invented pictures are repeatable, differ by seed, and the subject fills a sensible part of the frame', () => {
  const a = drawScene('plant', 320, 240, 1); const b = drawScene('plant', 320, 240, 1); const c = drawScene('plant', 320, 240, 2);
  assert(Buffer.from(a.rgb).equals(Buffer.from(b.rgb)), 'same seed, same picture');
  assert(!Buffer.from(a.rgb).equals(Buffer.from(c.rgb)), 'another seed, another background');
  assert(Buffer.from(a.truth).equals(Buffer.from(c.truth)), 'the subject is where it was');
  for (const kind of ['plant', 'lamp', 'mug']) {
    const s = drawScene(kind, 240, 180, 3);
    const share = s.truth.reduce((n, v) => n + (v ? 1 : 0), 0) / s.truth.length;
    assert(share > 0.12 && share < 0.5, `${kind} covers ${(share * 100).toFixed(0)}% of the picture`);
    assert.strictEqual(s.rgb.length, 240 * 180 * 3);
  }
});

// ---- the model ----------------------------------------------------------------------------------------------------------------------
test('model: the file on disk is the pinned one (size and SHA-256), so a damaged or swapped model is caught', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'fetch-model.js'), 'utf8');
  const sha = /sha256: '([0-9a-f]{64})'/.exec(src)[1]; const bytes = Number(/bytes: (\d+)/.exec(src)[1]);
  const file = C.modelPath();
  assert(fs.existsSync(file), 'model missing - run npm run setup');
  assert.strictEqual(fs.statSync(file).size, bytes);
  assert.strictEqual(crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'), sha);
});

test('model: the plant is cut out of its busy background (outline matches the truth), the window stays responsive meanwhile, and the answer is repeatable', async () => {
  const scene = drawScene('plant', 960, 720, 1);
  const tensor = P.toTensor(toModelPicture(scene.rgb, scene.width, scene.height));
  const runner = await C.createRunner();
  try {
    let last = Date.now(); let maxGap = 0;
    const timer = setInterval(() => { const now = Date.now(); maxGap = Math.max(maxGap, now - last); last = now; }, 20);
    const t0 = Date.now();
    const r1 = await runner.run(tensor);
    const ms = Date.now() - t0;
    clearInterval(timer);
    // onnxruntime's run() blocks whatever thread calls it; a run on the main thread would leave a gap as long as the run itself
    assert(ms > 1000 && maxGap < 700, `the event loop was never blocked for long (longest gap ${maxGap} ms during a ${ms} ms run): the model runs off the main thread`);
    assert.strictEqual(r1.flat, false);
    assert.strictEqual(r1.mask.length, P.SIZE * P.SIZE);
    let lo = 1; let hi = 0; for (let i = 0; i < r1.mask.length; i++) { lo = Math.min(lo, r1.mask[i]); hi = Math.max(hi, r1.mask[i]); }
    assert(lo === 0 && hi === 1, 'normalised to 0..1');
    const q = iou(r1.mask, truthAtModelSize(scene.truth, scene.width, scene.height));
    assert(q > 0.93, 'overlap with the true outline (IoU) ' + q.toFixed(3));
    const r2 = await runner.run(tensor);
    let diff = 0; for (let i = 0; i < r1.mask.length; i += 7) diff = Math.max(diff, Math.abs(r1.mask[i] - r2.mask[i]));
    assert(diff < 1e-4, 'the same picture gives the same cutout (' + diff + ')');
    console.log(`     IoU ${q.toFixed(3)}, ${ms} ms`);
  } finally { await runner.release(); }
});

test('model: a plain grey picture has no subject and does not break anything', async () => {
  const grey = new Uint8ClampedArray(P.SIZE * P.SIZE * 4).fill(128);
  const runner = await C.createRunner();
  try {
    const r = await runner.run(P.toTensor(grey));
    assert.strictEqual(r.mask.length, P.SIZE * P.SIZE);
    for (let i = 0; i < r.mask.length; i += 101) assert(r.mask[i] >= 0 && r.mask[i] <= 1);
  } finally { await runner.release(); }
});

test('model: cancelling or releasing in the middle of a picture is safe (the process survives, the caller hears "cancelled" at once, the model is reusable)', async () => {
  const scene = drawScene('plant', 480, 360, 5);
  const tensor = P.toTensor(toModelPicture(scene.rgb, scene.width, scene.height));
  const runner = await C.createRunner();
  const first = runner.run(tensor).then(() => 'finished', (e) => (e.cancelled ? 'cancelled' : 'error: ' + e.message));
  await new Promise((r) => setTimeout(r, 400));
  const t0 = Date.now();
  runner.cancelPending();
  assert.strictEqual(await first, 'cancelled');
  assert(Date.now() - t0 < 300, 'the caller is told at once, not after the run');
  const again = await runner.run(tensor);                   // the same thread, after it finishes the abandoned picture
  assert.strictEqual(again.mask.length, P.SIZE * P.SIZE);
  const second = runner.run(tensor).then(() => 'finished', (e) => (e.cancelled ? 'cancelled' : 'error: ' + e.message));
  await new Promise((r) => setTimeout(r, 400));
  await runner.release();                                    // mid-run: waits for the picture to finish, then frees the model
  assert.strictEqual(await second, 'cancelled');
  await assert.rejects(runner.run(tensor), (e) => e.cancelled === true);
  const fresh = await C.createRunner();                      // a new runner after all that
  assert.strictEqual((await fresh.run(tensor)).mask.length, P.SIZE * P.SIZE);
  await fresh.release();
});

test('model: wrong input, a released runner and a missing model file give clear errors', async () => {
  await assert.rejects(C.createRunner(path.join(__dirname, 'no-such-model.onnx')), (e) => e instanceof P.UserError && /npm run setup/.test(e.message));
  const runner = await C.createRunner();
  await assert.rejects(runner.run(new Float32Array(10)), /not prepared/);
  await runner.release();
  await assert.rejects(runner.run(P.toTensor(new Uint8ClampedArray(P.SIZE * P.SIZE * 4))), (e) => e.cancelled === true);
});

// ---- the look --------------------------------------------------------------------------------------------------------------------------
test('look: the accent and text colours are readable on the dark background', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'styles.css'), 'utf8');
  const tokens = {};
  for (const m of css.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-fA-F]{6})/g)) tokens[m[1]] = m[2];
  const lum = (hex) => { const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  const pairs = [['text', 'bg', 4.5], ['muted', 'bg', 4.5], ['muted', 'panel', 4.5], ['accent', 'bg', 4.5], ['err', 'bg', 4.5], ['ok', 'bg', 4.5], ['on-accent', 'accent', 4.5]];
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
  console.log(failed ? `\n${failed} of ${tests.length} failed` : `\nall ${tests.length} passed`);
  process.exit(failed ? 1 : 0);
})();
