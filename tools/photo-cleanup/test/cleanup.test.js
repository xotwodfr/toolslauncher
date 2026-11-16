'use strict';
// Unit tests (plain Node): `npm test`. Mask operations, the crop / resize / blend maths (untouched pixels must stay
// bit-identical), extension geometry and the tile plan, metadata reading and writing, and the real models on a tiny input.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const C = require('../src/core');
const M = require('../src/meta');
const E = require('../src/engine');
const { testPhoto, rng } = require('../src/scene');
const { makeTiff } = require('./fixtures');

let passed = 0; let failed = 0;
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// ---- masks --------------------------------------------------------------------------------------------------------------
test('distance transform matches brute force on random masks', () => {
  const rand = rng(5);
  for (let k = 0; k < 6; k++) {
    const w = 23 + k * 3; const h = 17 + k;
    const mask = new Uint8Array(w * h); for (let i = 0; i < mask.length; i++) mask[i] = rand() < 0.03 ? 1 : 0;
    mask[k] = 1;
    const d = C.distanceSq(mask, w, h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let best = Infinity;
      for (let yy = 0; yy < h; yy++) for (let xx = 0; xx < w; xx++) if (mask[yy * w + xx]) best = Math.min(best, (x - xx) ** 2 + (y - yy) ** 2);
      assert.strictEqual(d[y * w + x], best, `(${x},${y})`);
    }
  }
});

test('dilate grows a single pixel into a disc of the right radius', () => {
  const w = 41; const h = 41; const m = new Uint8Array(w * h); m[20 * w + 20] = 1;
  const g = C.dilate(m, w, h, 6);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) assert.strictEqual(g[y * w + x], (x - 20) ** 2 + (y - 20) ** 2 <= 36 ? 1 : 0);
  assert.deepStrictEqual(Array.from(C.dilate(m, w, h, 0)), Array.from(m));
});

test('paintLine paints a capsule, erases with 0 and reports the changed box', () => {
  const w = 60; const h = 40; const m = new Uint8Array(w * h);
  const box = C.paintLine(m, w, h, 10, 20, 50, 20, 5, 1);
  assert.ok(box.x0 <= 5 && box.x1 >= 55 && box.y0 <= 15 && box.y1 >= 25);
  assert.strictEqual(m[20 * w + 30], 1); assert.strictEqual(m[20 * w + 6], 1); assert.strictEqual(m[27 * w + 30], 0); assert.strictEqual(m[20 * w + 57], 0);
  C.paintLine(m, w, h, 30, 20, 30, 20, 3, 0);
  assert.strictEqual(m[20 * w + 30], 0); assert.strictEqual(m[20 * w + 20], 1);
  assert.strictEqual(C.paintLine(m, w, h, -50, -50, -40, -40, 3, 1), null, 'off the picture changes nothing');
});

test('maskBox, diffBox, getRect / putRect round trip', () => {
  const w = 30; const h = 20; const m = new Uint8Array(w * h); m[5 * w + 7] = 1; m[12 * w + 22] = 1;
  assert.deepStrictEqual(C.maskBox(m, w, h), { x0: 7, y0: 5, x1: 23, y1: 13 });
  assert.strictEqual(C.maskBox(new Uint8Array(4), 2, 2), null);
  const a = new Uint8ClampedArray(w * h * 4).fill(9); const b = new Uint8ClampedArray(a); b[(8 * w + 3) * 4 + 2] = 1; b[(9 * w + 11) * 4] = 7;
  assert.deepStrictEqual(C.diffBox(a, b, w, h, 4), { x0: 3, y0: 8, x1: 12, y1: 10 });
  const r = { x: 2, y: 3, w: 11, h: 7 }; const part = C.getRect(b, w, 4, r);
  const c = new Uint8ClampedArray(a); C.putRect(c, w, 4, r, part);
  assert.strictEqual(C.hash(c), C.hash(b));
});

test('components finds separate parts; removalJobs keeps far parts apart and merges near ones', () => {
  const W = 3000; const H = 2000; const m = new Uint8Array(W * H);
  C.paintLine(m, W, H, 200, 200, 220, 210, 10, 1);       // a speck top-left
  C.paintLine(m, W, H, 2500, 1600, 2550, 1650, 20, 1);   // two parts close together bottom-right
  C.paintLine(m, W, H, 2620, 1640, 2640, 1650, 8, 1);
  const parts = C.components(m, W, H);
  assert.strictEqual(parts.length, 3);
  const jobs = C.removalJobs(parts, W, H);
  assert.strictEqual(jobs.length, 2, JSON.stringify(jobs));
  for (const j of jobs) {
    const b = j.box; const r = j.win;
    assert.ok(r.x <= b.x0 && r.y <= b.y0 && r.x + r.w >= b.x1 && r.y + r.h >= b.y1, 'window holds its parts');
    assert.ok(r.x >= 0 && r.y >= 0 && r.x + r.w <= W && r.y + r.h <= H, 'window inside the photo');
    assert.strictEqual(r.w, r.h, 'square when the photo allows');
    assert.ok(r.w >= C.MODEL);
  }
});

test('removalWindow on a small photo is clamped to the photo', () => {
  const r = C.removalWindow({ x0: 10, y0: 10, x1: 60, y1: 40 }, 300, 200);
  assert.deepStrictEqual(r, { x: 0, y: 0, w: 300, h: 200 });
});

// ---- resampling and blending --------------------------------------------------------------------------------------------
test('resample keeps a flat colour flat, shrinks by averaging and enlarges smoothly', () => {
  const src = new Uint8ClampedArray(37 * 23 * 4); for (let i = 0; i < src.length; i += 4) { src[i] = 200; src[i + 1] = 100; src[i + 2] = 50; src[i + 3] = 255; }
  for (const [dw, dh] of [[10, 7], [80, 50], [37, 23]]) {
    const out = C.resample(src, 37, 23, 4, dw, dh, 3);
    for (let i = 0; i < out.length; i += 3) { assert.ok(Math.abs(out[i] - 200) < 1e-3 && Math.abs(out[i + 1] - 100) < 1e-3 && Math.abs(out[i + 2] - 50) < 1e-3); }
  }
  const stripes = new Float32Array(8); for (let i = 0; i < 8; i++) stripes[i] = i % 2 ? 255 : 0;
  const half = C.resample(stripes, 8, 1, 1, 4, 1); for (const v of half) assert.ok(Math.abs(v - 127.5) < 40, 'averaged: ' + v);
  const ramp = Float32Array.from([0, 100]); const up = C.resample(ramp, 2, 1, 1, 8, 1);
  for (let i = 1; i < 8; i++) assert.ok(up[i] >= up[i - 1], 'monotonic');
});

/** A stand-in for the model: answers with a flat colour everywhere (values 0..255, 3 x 512 x 512). */
const flatModel = (r, g, b) => { const N = C.MODEL * C.MODEL; const o = new Float32Array(3 * N); o.fill(r, 0, N); o.fill(g, N, 2 * N); o.fill(b, 2 * N); return o; };

test('prepareFill: inputs are 512 x 512, unknown pixels zeroed and masked, content scaled uniformly with mirrored padding', () => {
  const w = 800; const h = 400; const rgba = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) { rgba[i * 4] = 255; rgba[i * 4 + 1] = 128; rgba[i * 4 + 2] = 0; rgba[i * 4 + 3] = 255; }
  const unk = new Uint8Array(w * h); C.paintLine(unk, w, h, 400, 200, 400, 200, 40, 1);
  const p = C.prepareFill(rgba, w, h, unk);
  assert.strictEqual(p.image.length, 3 * 512 * 512); assert.strictEqual(p.mask.length, 512 * 512);
  assert.strictEqual(p.cw, 512); assert.strictEqual(p.ch, 256);
  const N = 512 * 512; const at = (x, y) => y * 512 + x;
  assert.strictEqual(p.mask[at(256, 128)], 1); assert.strictEqual(p.image[at(256, 128)], 0);
  assert.strictEqual(p.mask[at(10, 10)], 0); assert.ok(Math.abs(p.image[at(10, 10)] - 1) < 1e-6 && Math.abs(p.image[N + at(10, 10)] - 128 / 255) < 1e-6);
  assert.strictEqual(p.mask[at(256, 383)], 1, 'mirror of the hole in the padding is masked too');
  assert.strictEqual(p.mask[at(10, 500)], 0); assert.ok(Math.abs(p.image[at(10, 500)] - 1) < 1e-6, 'padding mirrors the picture');
  // every unknown pixel maps onto a masked model pixel
  const s = 512 / 800;
  for (let y = 0; y < h; y += 3) for (let x = 0; x < w; x += 3) if (unk[y * w + x]) assert.strictEqual(p.mask[at(Math.floor(x * s), Math.floor(y * s))], 1);
});

test('finishFill: unknown pixels take the fill, a narrow feather blends, every other pixel is bit-identical', () => {
  const { rgba, W, H } = testPhoto(700, 500, 2);
  const unk = new Uint8Array(W * H); C.paintLine(unk, W, H, 300, 250, 360, 260, 30, 1);
  const feather = 4;
  const prep = C.prepareFill(rgba, W, H, unk);
  const out = C.finishFill(flatModel(10, 200, 30), prep, rgba, unk, feather);
  const d = C.distanceSq(unk, W, H);
  let blended = 0;
  for (let i = 0; i < W * H; i++) {
    const o = i * 4; const dist = Math.sqrt(d[i]);
    if (unk[i]) assert.ok(Math.abs(out[o] - 10) <= 1 && Math.abs(out[o + 1] - 200) <= 1 && out[o + 3] === 255, 'filled');
    else if (dist >= feather + 1) { for (let c = 0; c < 4; c++) assert.strictEqual(out[o + c], rgba[o + c], 'untouched pixel changed at ' + i); }
    else if (out[o] !== rgba[o] || out[o + 1] !== rgba[o + 1]) blended++;
  }
  assert.ok(blended > 0, 'the feather ring blends');
});

test('grain: a large window gets the photo\'s fine texture back in the filled area, and nothing changes outside it', () => {
  const W = 1400; const H = 1000; const rand = rng(9);
  const rgba = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < W * H; i++) { const n = (rand() - 0.5) * 40; rgba[i * 4] = 180 + n; rgba[i * 4 + 1] = 150 + n; rgba[i * 4 + 2] = 110 + n; rgba[i * 4 + 3] = 255; }
  const unk = new Uint8Array(W * H); C.paintLine(unk, W, H, 700, 500, 700, 500, 150, 1);
  const prep = C.prepareFill(rgba, W, H, unk);
  const sd = (img) => { let s1 = 0; let s2 = 0; let n = 0; for (let y = 450; y < 550; y++) for (let x = 650; x < 750; x++) { const v = img[(y * W + x) * 4]; s1 += v; s2 += v * v; n++; } return Math.sqrt(s2 / n - (s1 / n) ** 2); };
  const smooth = C.finishFill(flatModel(180, 150, 110), prep, rgba, unk, 3);
  const grain = C.finishFill(flatModel(180, 150, 110), prep, rgba, unk, 3, { grain: true, seed: 3 });
  const orig = sd(rgba); const a = sd(smooth); const b = sd(grain);
  assert.ok(a < 1, 'without grain the fill is flat: ' + a);
  assert.ok(b > orig * 0.5 && b < orig * 1.3, `with grain the texture is back: ${b.toFixed(1)} vs the photo's ${orig.toFixed(1)}`);
  const d = C.distanceSq(unk, W, H);
  for (let i = 0; i < W * H; i++) if (d[i] > 16) for (let c = 0; c < 4; c++) assert.strictEqual(grain[i * 4 + c], rgba[i * 4 + c]);
  return `texture ${b.toFixed(1)} vs ${orig.toFixed(1)}`;
});

test('harmonize: a fill that comes out darker than the picture around it is bent to meet it, smoothly, known pixels untouched', () => {
  const W = 400; const H = 400; const rgba = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const o = (y * W + x) * 4; rgba[o] = 100 + x / 8; rgba[o + 1] = 150; rgba[o + 2] = 200; rgba[o + 3] = 255; }
  const unk = new Uint8Array(W * H); C.paintLine(unk, W, H, 200, 200, 200, 200, 90, 1);
  const prep = C.prepareFill(rgba, W, H, unk); const N = C.MODEL * C.MODEL;
  // the "model": the true picture everywhere, but 30 levels darker inside the hole
  const out = new Float32Array(3 * N);
  for (let i = 0; i < N; i++) for (let c = 0; c < 3; c++) out[c * N + i] = prep.image[c * N + i] * 255;
  const s = C.MODEL / W; const truth = (x) => 100 + x / s / 8;
  for (let i = 0; i < N; i++) if (prep.mask[i]) { const x = i % C.MODEL; out[i] = truth(x) - 30; out[N + i] = 120; out[2 * N + i] = 170; }
  const known = Float32Array.from(out);
  C.harmonize(prep, out);
  let worst = 0;
  for (let i = 0; i < N; i++) {
    if (!prep.mask[i]) { assert.strictEqual(out[i], known[i]); continue; }
    const x = i % C.MODEL; worst = Math.max(worst, Math.abs(out[i] - truth(x)), Math.abs(out[N + i] - 150), Math.abs(out[2 * N + i] - 200));
  }
  assert.ok(worst < 3, 'offset removed, worst ' + worst.toFixed(2));
  return `worst ${worst.toFixed(2)}`;
});
test('mirrorPad for extensions: reflection about the strip\'s inner edge, behind an unknown gap', () => {
  const w = 10; const rgba = new Uint8ClampedArray(w * 4); for (let i = 0; i < w; i++) rgba[i * 4] = i * 10;
  const unk = new Uint8Array(w); unk[0] = 1; unk[1] = 1;                    // a new strip of 2 px on the left
  const p = C.mirrorPad(rgba, w, 1, unk, { l: 4 }, { l: 2 }, { l: 2 });
  assert.strictEqual(p.w, 16); assert.strictEqual(p.l, 6);
  assert.deepStrictEqual(Array.from({ length: p.w }, (_, x) => (p.unknown[x] ? 'U' : p.rgba[x * 4] / 10)).join(''), '5432UUUU23456789');
  const q = C.mirrorPad(rgba, w, 1, unk, { l: 20 }, { l: 2 }, { l: 2 });
  assert.strictEqual(q.w, w + 8 + 2, 'padding limited to the known pixels');
});
test('mirrorPad and unpad: padded window is a reflection, unknown follows, unpad gives the window back', () => {
  const w = 6; const h = 4; const rgba = new Uint8ClampedArray(w * h * 4); for (let i = 0; i < w * h; i++) rgba[i * 4] = i;
  const unk = new Uint8Array(w * h); unk[w - 1] = 1;
  const p = C.mirrorPad(rgba, w, h, unk, { r: 3, t: 2 });
  assert.strictEqual(p.w, 9); assert.strictEqual(p.h, 6);
  assert.strictEqual(p.rgba[((2 + 0) * 9 + 6) * 4], rgba[(0 * w + 5) * 4], 'first padded column mirrors the last one');
  assert.strictEqual(p.unknown[2 * 9 + 6], 1); assert.strictEqual(p.unknown[2 * 9 + 8], 0);
  assert.strictEqual(p.rgba[(1 * 9 + 0) * 4], rgba[0], 'top padding mirrors the first row');
  const back = C.unpad(p.rgba, p.w, p.l, p.t, w, h);
  for (let i = 0; i < w * h; i++) assert.strictEqual(back[i * 4], rgba[i * 4]);
});

// ---- selection ------------------------------------------------------------------------------------------------------------
test('samSize, logitsToMask and pickSamMask', () => {
  assert.deepStrictEqual(C.samSize(4000, 3000), { w: 1024, h: 768, s: 1024 / 4000 });
  assert.deepStrictEqual(C.samSize(900, 1600), { w: 576, h: 1024, s: 1024 / 1600 });
  const mw = 8; const mh = 6; const lg = new Float32Array(mw * mh).fill(-5); for (let y = 2; y < 4; y++) for (let x = 3; x < 5; x++) lg[y * mw + x] = 5;
  const m = C.logitsToMask(lg, mw, mh, 80, 60);
  assert.strictEqual(m[30 * 80 + 40], 1); assert.strictEqual(m[5 * 80 + 5], 0);
  assert.strictEqual(C.pickSamMask([0.1, 0.5, 0.9, 0.7], [1]), 2);
  assert.strictEqual(C.pickSamMask([0.1, 0.5, 0.9, 0.7], [1, 0]), 0);
  // the whole object (mask 2) beats a slightly better scored part (mask 1); the background-sized mask 3 never wins
  assert.strictEqual(C.pickSamMask([0.76, 0.98, 0.945, 0.72], [1], [1936, 1824, 8581, 9587], 786432), 2);
  assert.strictEqual(C.pickSamMask([0.7, 0.977, 0.96, 0.95], [1], [1956, 1892, 9061, 292607], 786432), 2);
  assert.strictEqual(C.pickSamMask([0.7, 0.98, 0.7, 0.6], [1], [10, 2000, 9000, 9500], 786432), 1);
});

// ---- extending ------------------------------------------------------------------------------------------------------------
test('presetMargins: exact aspect, centred, never shrinks, amount zooms out', () => {
  const cases = [[4000, 3000], [3000, 4000], [1200, 900], [1000, 1000], [5000, 1000]];
  for (const [W, H] of cases) for (const p of ['1:1', '4:5', '3:2', '16:9', '9:16']) {
    const m = C.presetMargins(W, H, p, 0);
    const FW = W + m.l + m.r; const FH = H + m.t + m.b;
    assert.ok(m.l >= 0 && m.r >= 0 && m.t >= 0 && m.b >= 0);
    assert.ok(Math.abs(FW / FH - C.PRESETS[p]) < 1.5 / Math.min(FW, FH) + 1e-9 || FW === W * 3 || FH === H * 3, `${W}x${H} ${p}: ${FW}x${FH}`);
    assert.ok(Math.abs(m.l - m.r) <= 1 && Math.abs(m.t - m.b) <= 1, 'centred');
    assert.ok((m.l + m.r === 0) || (m.t + m.b === 0), 'only one axis grows at amount 0');
  }
  const a = C.presetMargins(1000, 1000, '1:1', 0.5); assert.deepStrictEqual(a, { l: 250, t: 250, r: 250, b: 250 });
  const f = C.presetMargins(1200, 900, 'free', 0.2); assert.deepStrictEqual(f, { l: 120, t: 90, r: 120, b: 90 });
  const big = C.clampMargins(100, 100, { l: 1000, r: 1000, t: 0, b: 0 }); assert.strictEqual(100 + big.l + big.r, 300, 'at most 3x');
});

function checkPlan(W, H, m) {
  const plan = C.extendPlan(W, H, m);
  const { FW, FH } = plan;
  const filled = new Uint8Array(FW * FH);
  for (let y = 0; y < H; y++) filled.fill(1, (y + plan.oy) * FW + plan.ox, (y + plan.oy) * FW + plan.ox + W);
  for (const st of plan.steps) {
    // the strip is new, next to known pixels; tiles lie inside known + strip and together cover the strip
    for (const t of st.tiles) {
      assert.ok(t.x >= 0 && t.y >= 0 && t.x + t.w <= FW && t.y + t.h <= FH, 'tile inside the canvas');
      const across = st.side === 'l' || st.side === 'r' ? t.w : t.h;
      assert.ok(across <= plan.tile && t.w * t.h <= plan.tile * plan.tile * 4, 'tile size');
      let known = 0; let unknown = 0; let alien = 0;
      for (let y = t.y; y < t.y + t.h; y++) for (let x = t.x; x < t.x + t.w; x++) {
        const inStrip = x >= st.strip.x0 && x < st.strip.x1 && y >= st.strip.y0 && y < st.strip.y1;
        if (filled[y * FW + x]) known++; else if (inStrip) unknown++; else alien++;
      }
      assert.strictEqual(alien, 0, 'a tile never holds pixels of a later step');
      assert.ok(known >= unknown * 0.9, `enough real picture as context (known ${known}, new ${unknown})`);
      for (let y = t.y; y < t.y + t.h; y++) for (let x = t.x; x < t.x + t.w; x++) filled[y * FW + x] = 1;
    }
    for (let y = st.strip.y0; y < st.strip.y1; y++) for (let x = st.strip.x0; x < st.strip.x1; x++) assert.strictEqual(filled[y * FW + x], 1, 'strip covered');
  }
  assert.strictEqual(C.maskCount(filled), FW * FH, 'the whole new canvas gets filled');
  return plan;
}
test('extendPlan: tiles cover every new pixel, keep context and stay in bounds (presets and dragged edges)', () => {
  const p1 = checkPlan(4000, 3000, C.presetMargins(4000, 3000, '16:9', 0));
  assert.strictEqual(p1.FW, 5333); assert.strictEqual(p1.FH, 3000); assert.strictEqual(p1.count, 2, '16:9 from 12 MP: one tall window per side');
  checkPlan(4000, 3000, C.presetMargins(4000, 3000, '9:16', 0));
  checkPlan(1200, 900, C.presetMargins(1200, 900, '1:1', 0.6));
  checkPlan(640, 480, { l: 900, t: 30, r: 0, b: 400 });
  checkPlan(300, 200, { l: 10, t: 10, r: 600, b: 0 });
  const p2 = C.extendPlan(1200, 900, { l: 0, t: 0, r: 2400, b: 0 });
  assert.ok(p2.steps.length > 1, 'a large extension goes outward in several steps');
  for (const s of p2.steps) for (const t of s.tiles) {
    assert.ok(t.pads.r > 0 && !t.pads.l, 'mirror padding on the open side');
    assert.ok(t.gaps.r > 0 && t.skip.r === s.strip.x1 - s.strip.x0, 'an unknown gap between the strip and the reflection');
    assert.ok(Math.abs(t.w + t.pads.r + t.gaps.r - t.h) <= 1 || t.h === p2.FH, 'about square with the padding');
  }
});

// ---- metadata and files ---------------------------------------------------------------------------------------------------
test('EXIF: summary, then cleaning sets orientation 1, updates the size and wipes the thumbnail', () => {
  const t = makeTiff();
  const s = M.exifSummary(t);
  assert.deepStrictEqual([s.orientation, s.camera, s.gps], [6, 'TestCam', true]);
  const c = M.cleanExif(t, 5333, 3000);
  assert.strictEqual(M.exifSummary(c).orientation, 1);
  assert.strictEqual(c.indexOf('THUMBNAILDATA'), -1, 'thumbnail bytes are gone');
  const r = M.tiffReader(c); const ifd0 = M.ifd(c, r, 8);
  assert.strictEqual(r.u32(ifd0.nextAt), 0, 'IFD1 unlinked');
  assert.strictEqual(c.readUInt32LE(122 + 8), 5333); assert.strictEqual(c.readUInt32LE(134 + 8), 3000);
  assert.strictEqual(M.cleanExif(Buffer.from('nonsense'), 1, 1), null);
});

test('JPEG: metadata is inserted after JFIF, read back, and replaces older segments', () => {
  const jfif = Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.from([0xff, 0xe0, 0, 16]), Buffer.from('JFIF\0\x01\x01\0\0\x01\0\x01\0\0', 'latin1'), Buffer.from([0xff, 0xda, 0, 4, 1, 2]), Buffer.from([9, 9, 9, 0xff, 0xd9])]);
  const icc = Buffer.alloc(150000, 7); const exif = makeTiff(); const xmp = Buffer.from('<x:xmpmeta tiff:Orientation="6"/>');
  const out = M.jpegWithMeta(jfif, { exif, icc, xmp });
  assert.strictEqual(out.readUInt16BE(2), 0xffe0, 'JFIF stays first');
  const back = M.readMeta(out);
  assert.ok(back.exif.equals(exif)); assert.ok(back.icc.equals(icc), 'multi-segment ICC'); assert.ok(back.xmp.equals(xmp));
  const again = M.jpegWithMeta(out, { exif: null, icc, xmp: null });
  const b2 = M.readMeta(again); assert.strictEqual(b2.exif, null); assert.strictEqual(b2.xmp, null); assert.ok(b2.icc.equals(icc));
  assert.ok(again.subarray(again.length - 6).equals(Buffer.from([2, 9, 9, 9, 0xff, 0xd9])), 'image data untouched');
});

function decodePng(buf) {
  let p = 8; let w; let h; let type; const idat = []; const types = [];
  while (p < buf.length) { const len = buf.readUInt32BE(p); const t = buf.toString('latin1', p + 4, p + 8); types.push(t); const d = buf.subarray(p + 8, p + 8 + len);
    const crc = buf.readInt32BE(p + 8 + len); assert.strictEqual(crc, ~M.crc32(buf.subarray(p + 4, p + 8 + len)) | 0, 'crc ' + t);
    if (t === 'IHDR') { w = d.readUInt32BE(0); h = d.readUInt32BE(4); type = d[9]; } if (t === 'IDAT') idat.push(d); p += 12 + len; }
  const raw = zlib.inflateSync(Buffer.concat(idat)); const bpp = type === 6 ? 4 : 3; const stride = w * bpp; const out = new Uint8ClampedArray(w * h * 4); const prev = Buffer.alloc(stride); const cur = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) { const f = raw[y * (stride + 1)];
    for (let i = 0; i < stride; i++) { const x = raw[y * (stride + 1) + 1 + i]; const a = i >= bpp ? cur[i - bpp] : 0; const b = prev[i]; const c = i >= bpp ? prev[i - bpp] : 0;
      let pr = 0; if (f === 1) pr = a; else if (f === 2) pr = b; else if (f === 3) pr = (a + b) >> 1; else if (f === 4) { const q = a + b - c; const pa = Math.abs(q - a); const pb = Math.abs(q - b); const pc = Math.abs(q - c); pr = pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      cur[i] = (x + pr) & 0xff; }
    for (let x = 0; x < w; x++) { const o = (y * w + x) * 4; out[o] = cur[x * bpp]; out[o + 1] = cur[x * bpp + 1]; out[o + 2] = cur[x * bpp + 2]; out[o + 3] = bpp === 4 ? cur[x * bpp + 3] : 255; }
    cur.copy(prev); }
  return { w, h, rgba: out, types };
}
test('PNG encoder: exact pixels (RGB and RGBA), all filters decode, metadata chunks readable', async () => {
  const { rgba, W, H } = testPhoto(321, 203, 4);
  const exif = makeTiff(); const icc = Buffer.alloc(3000, 3); const xmp = Buffer.from('<x/>');
  const png = await M.encodePng(rgba, W, H, { exif, icc, xmp });
  const d = decodePng(png);
  assert.strictEqual(d.w, W); assert.strictEqual(C.hash(d.rgba), C.hash(rgba), 'pixels identical');
  assert.deepStrictEqual(d.types.slice(0, 4), ['IHDR', 'iCCP', 'eXIf', 'iTXt']);
  const back = M.readMeta(png); assert.ok(back.exif.equals(exif) && back.icc.equals(icc) && back.xmp.equals(xmp));
  const a = new Uint8ClampedArray(rgba); a[3] = 10; a[(50 * W + 9) * 4 + 3] = 0;
  const d2 = decodePng(await M.encodePng(a, W, H)); assert.strictEqual(C.hash(d2.rgba), C.hash(a), 'RGBA identical');
});

test('WebP: metadata wraps the image in an extended (VP8X) file', () => {
  const vp8 = Buffer.alloc(30, 1);
  const riff = Buffer.concat([Buffer.from('RIFF', 'latin1'), Buffer.from([38, 0, 0, 0]), Buffer.from('WEBPVP8 ', 'latin1'), Buffer.from([30, 0, 0, 0]), vp8]);
  const exif = makeTiff(); const icc = Buffer.alloc(101, 2);
  const out = M.webpWithMeta(riff, { exif, icc, xmp: null }, 640, 480);
  assert.strictEqual(out.toString('latin1', 12, 16), 'VP8X');
  assert.strictEqual(out[20], 0x20 | 0x08);
  assert.strictEqual(out.readUIntLE(24, 3), 639); assert.strictEqual(out.readUIntLE(27, 3), 479);
  assert.strictEqual(out.readUInt32LE(4), out.length - 8);
  const back = M.readMeta(out); assert.ok(back.exif.equals(exif) && back.icc.equals(icc));
  assert.ok(M.webpWithMeta(riff, {}, 1, 1).equals(riff), 'no metadata: unchanged');
});

test('metaForSave keeps ICC always, EXIF / XMP only on request, and cleans them', () => {
  const orig = { exif: makeTiff(), icc: Buffer.from('ICC'), xmp: Buffer.from('<a tiff:Orientation="8"/><xmp:Thumbnails>old</xmp:Thumbnails>') };
  const strip = M.metaForSave(orig, false, 10, 10); assert.deepStrictEqual([strip.exif, strip.xmp, String(strip.icc)], [null, null, 'ICC']);
  const keep = M.metaForSave(orig, true, 10, 10);
  assert.strictEqual(M.exifSummary(keep.exif).orientation, 1); assert.strictEqual(String(keep.xmp), '<a tiff:Orientation="1"/>');
});

test('formats: sniff, default format and names', () => {
  assert.strictEqual(C.sniff(Buffer.from([0xff, 0xd8, 0xff, 0, 0, 0, 0, 0, 0, 0, 0, 0])), 'jpeg');
  assert.strictEqual(C.sniff(Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypheic', 'latin1')])), 'heic');
  assert.strictEqual(C.defaultFormat('avif'), 'png'); assert.strictEqual(C.defaultFormat('webp'), 'webp');
  assert.strictEqual(C.defaultName('IMG_1.JPG', 'jpeg'), 'IMG_1 (cleaned).jpg');
  assert.ok(C.isOpenable('a/b.WebP') && !C.isOpenable('x.heic'));
});

// ---- the real models, tiny runs ----------------------------------------------------------------------------------------------
const haveModels = E.missingModels().length === 0;
test('bundled model files match their pinned size', () => {
  if (!haveModels) throw new Error('models missing: run "npm run setup" (' + E.missingModels().join(', ') + ')');
  for (const k of Object.keys(E.MODELS)) assert.strictEqual(fs.statSync(E.modelPath(k)).size, E.MODELS[k].bytes, k);
});
test('real LaMa run: fills a hole in a gradient with the gradient (512 x 512 in, 3 x 512 x 512 out)', async () => {
  const { rgba, W, H, disc, bg } = testPhoto(512, 512, 7);
  const unk = C.dilate((() => { const m = new Uint8Array(W * H); C.paintLine(m, W, H, disc.cx, disc.cy, disc.cx, disc.cy, disc.r, 1); return m; })(), W, H, 4);
  const r = await E.createRunner('lama');
  try {
    const res = await r.call({ type: 'fill', rgba, w: W, h: H, unknown: unk, feather: 2 });
    assert.strictEqual(res.rgba.length, W * H * 4);
    let worst = 0;
    for (let y = disc.cy - disc.r + 6; y < disc.cy + disc.r - 6; y += 4) for (let x = disc.cx - disc.r + 6; x < disc.cx + disc.r - 6; x += 4) {
      const b = bg(x, y); const o = (y * W + x) * 4; worst = Math.max(worst, Math.abs(res.rgba[o] - b[0]), Math.abs(res.rgba[o + 1] - b[1]), Math.abs(res.rgba[o + 2] - b[2]));
    }
    assert.ok(worst < 16, 'filled area matches the background, worst channel difference ' + worst.toFixed(1));
    const d = C.distanceSq(unk, W, H);
    for (let i = 0; i < W * H; i++) if (d[i] > 9) for (let c = 0; c < 4; c++) assert.strictEqual(res.rgba[i * 4 + c], rgba[i * 4 + c]);
    return `worst ${worst.toFixed(1)}, ${res.seconds.toFixed(1)} s`;
  } finally { await r.release(); }
});
test('real MobileSAM run: one tap outlines the ball (IoU > 0.9); a second, negative tap on the background keeps it', async () => {
  const { rgba, W, H, disc } = testPhoto(800, 600, 8);
  const ss = C.samSize(W, H); const small = C.resample(rgba, W, H, 4, ss.w, ss.h, 3);
  const r = await E.createRunner('sam');
  try {
    await r.call({ type: 'encode', key: 1, rgb: Uint8Array.from(small, (v) => Math.round(v)), w: ss.w, h: ss.h });
    const iou = (mask) => { let i = 0; let u = 0; for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const t = Math.hypot(x + 0.5 - disc.cx, y + 0.5 - disc.cy) <= disc.r; const m = mask[y * W + x]; if (t && m) i++; if (t || m) u++; } return i / u; };
    const a = await r.call({ type: 'decode', key: 1, points: [[disc.cx * ss.s, disc.cy * ss.s]], labels: [1] });
    assert.strictEqual(a.w, ss.w); assert.strictEqual(a.h, ss.h); assert.strictEqual(a.lowRes.length, 65536);
    const q1 = iou(C.logitsToMask(a.logits, a.w, a.h, W, H)); assert.ok(q1 > 0.9, 'IoU ' + q1);
    const b = await r.call({ type: 'decode', key: 1, points: [[disc.cx * ss.s, disc.cy * ss.s], [40 * ss.s, 40 * ss.s]], labels: [1, 0], maskInput: a.lowRes });
    const q2 = iou(C.logitsToMask(b.logits, b.w, b.h, W, H)); assert.ok(q2 > 0.85, 'IoU with a negative tap ' + q2);
    await assert.rejects(r.call({ type: 'decode', key: 2, points: [[1, 1]], labels: [1] }), /stale-embedding/);
    return `IoU ${q1.toFixed(3)} / ${q2.toFixed(3)}`;
  } finally { await r.release(); }
});

(async () => {
  for (const t of tests) {
    const t0 = Date.now();
    try { const d = await t.fn(); passed++; console.log(`  ok   ${t.name}${d ? '  [' + d + ']' : ''} (${Date.now() - t0} ms)`); }
    catch (e) { failed++; console.log(` FAIL  ${t.name}\n        ${(e && e.stack) || e}`); }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();

