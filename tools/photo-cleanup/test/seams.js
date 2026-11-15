'use strict';
// How visible is an edit? Measurements on a finished picture, used by the seam test (test/seams.test.js, real model runs)
// and handy for comparing versions by hand.
//
//   contourSteps   the colour step across a contour (the outline of a removed object, the border between the photo and an
//                  extension): mean of a band just inside minus a band just outside, per 24 x 24 block along the contour,
//                  so texture noise cancels. Compared with the same measurement across a contour of the same shape that lies
//                  in untouched picture (the photo's natural steps), a seam shows as steps well above the natural ones.
//   haze           the outer part of an extension against the photo band next to it, in short segments along the side:
//                  local contrast and saturation ratios and the brightness lift. A washed-out ("hazy") extension has less
//                  contrast and saturation than the photo and is lighter.
//   textureRatio   fine detail (pixel minus its 5 x 5 mean) of filled pixels against real pixels nearby (blur shows < 1).
const C = require('../src/core');

const luma = (rgba, i) => 0.299 * rgba[i * 4] + 0.587 * rgba[i * 4 + 1] + 0.114 * rgba[i * 4 + 2];
const pct = (arr, p) => { if (!arr.length) return 0; const s = Float64Array.from(arr).sort(); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const median = (arr) => pct(arr, 0.5);

/** Per-pixel squared |luma - 5x5 box mean|. */
function detailEnergy(rgba, W, H) {
  const L = new Float32Array(W * H); for (let i = 0; i < W * H; i++) L[i] = luma(rgba, i);
  const I = new Float64Array((W + 1) * (H + 1));
  for (let y = 0; y < H; y++) { let row = 0; for (let x = 0; x < W; x++) { row += L[y * W + x]; I[(y + 1) * (W + 1) + x + 1] = I[y * (W + 1) + x + 1] + row; } }
  const E = new Float32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const x0 = Math.max(0, x - 2); const x1 = Math.min(W, x + 3); const y0 = Math.max(0, y - 2); const y1 = Math.min(H, y + 3);
    const m = (I[y1 * (W + 1) + x1] - I[y0 * (W + 1) + x1] - I[y1 * (W + 1) + x0] + I[y0 * (W + 1) + x0]) / ((x1 - x0) * (y1 - y0));
    const d = L[y * W + x] - m; E[y * W + x] = d * d;
  }
  return E;
}

/** Fine-detail ratio: RMS detail of the `filled` pixels / of the `ring` pixels (both Uint8Array masks). */
function textureRatio(rgba, W, H, filled, ring) {
  const E = detailEnergy(rgba, W, H); let a = 0; let na = 0; let b = 0; let nb = 0;
  for (let i = 0; i < W * H; i++) { if (filled[i]) { a += E[i]; na++; } else if (ring[i]) { b += E[i]; nb++; } }
  return Math.sqrt((a / Math.max(1, na)) / Math.max(1e-6, b / Math.max(1, nb)));
}

/**
 * Steps across the outline of `inside` (Uint8Array mask): for every 24 x 24 block the outline passes through, the largest
 * channel difference between the mean of the inside pixels 2..8 px from the outline and the outside pixels 2..8 px from it
 * (both within the block's 48 x 48 neighbourhood). `within` (optional mask) limits which pixels count (e.g. not the canvas
 * border). Returns an array of steps (levels of 255).
 */
function contourSteps(rgba, W, H, inside, within) {
  const outside = new Uint8Array(W * H); for (let i = 0; i < W * H; i++) outside[i] = inside[i] ? 0 : 1;
  const dOut = C.distanceSq(inside, W, H); const dIn = C.distanceSq(outside, W, H);
  const B = 24; const steps = [];
  for (let by = 0; by < H; by += B) for (let bx = 0; bx < W; bx += B) {
    let hasEdge = false;
    for (let y = by; y < Math.min(H, by + B) && !hasEdge; y++) for (let x = bx; x < Math.min(W, bx + B); x++) { const i = y * W + x; if (inside[i] && dIn[i] <= 1 && (!within || within[i])) { hasEdge = true; break; } }
    if (!hasEdge) continue;
    const a = [0, 0, 0]; const b = [0, 0, 0]; let na = 0; let nb = 0;
    for (let y = Math.max(0, by - 12); y < Math.min(H, by + B + 12); y++) for (let x = Math.max(0, bx - 12); x < Math.min(W, bx + B + 12); x++) {
      const i = y * W + x; if (within && !within[i]) continue;
      if (inside[i] && dIn[i] >= 4 && dIn[i] <= 64) { for (let c = 0; c < 3; c++) a[c] += rgba[i * 4 + c]; na++; }
      else if (!inside[i] && dOut[i] >= 4 && dOut[i] <= 64) { for (let c = 0; c < 3; c++) b[c] += rgba[i * 4 + c]; nb++; }
    }
    if (na < 40 || nb < 40) continue;
    steps.push(Math.max(...[0, 1, 2].map((c) => Math.abs(a[c] / na - b[c] / nb))));
  }
  return steps;
}

/** Rectangle mask (box x0,y0,x1,y1) as Uint8Array. */
function boxMask(W, H, b) { const m = new Uint8Array(W * H); for (let y = Math.max(0, b.y0); y < Math.min(H, b.y1); y++) m.fill(1, y * W + Math.max(0, b.x0), y * W + Math.min(W, b.x1)); return m; }

/**
 * Seam between a photo (W x H at ox, oy) and its extension on a FW x FH canvas: steps across the photo's border against the
 * steps across a border of the same shape 32 px inside the photo (only pixels inside the photo, so both are measured on
 * real picture on one side at least). Returns { p90, controlP90, ratio, worst, n }.
 */
function extensionSeam(rgba, FW, FH, ox, oy, W, H) {
  const photo = { x0: ox, y0: oy, x1: ox + W, y1: oy + H };
  const notBorder = boxMask(FW, FH, { x0: 1, y0: 1, x1: FW - 1, y1: FH - 1 });
  const seam = contourSteps(rgba, FW, FH, boxMask(FW, FH, photo), notBorder);
  const g = 32; const inner = { x0: ox + g, y0: oy + g, x1: ox + W - g, y1: oy + H - g };
  const ctrl = contourSteps(rgba, FW, FH, boxMask(FW, FH, inner), boxMask(FW, FH, photo));
  // only the sides that were extended
  const p90 = pct(seam, 0.9); const controlP90 = pct(ctrl, 0.9);
  return { p90, controlP90, ratio: p90 / Math.max(1, controlP90), worst: pct(seam, 1), n: seam.length };
}

/**
 * Haze of an extension: on every extended side at least 16 px deep, the outer half of the new strip (corners left out) is
 * compared with the band of the photo of the same depth next to it, in segments of 32 px along the side. Per segment: local
 * contrast (luma standard deviation, only where the photo band has texture), saturation (max - min channel) and mean luma. Returns medians over all segments:
 * { contrast: out/in, saturation: out/in, lift: out - in (luma levels), n, sides: { l: {...}, ... } }.
 */
function haze(rgba, FW, FH, ox, oy, W, H) {
  const m = { l: ox, t: oy, r: FW - ox - W, b: FH - oy - H };
  const stat = (x0, y0, x1, y1) => {
    let s = 0; let ss = 0; let sat = 0; let n = 0;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const i = y * FW + x; const o = i * 4; const l = luma(rgba, i); s += l; ss += l * l; sat += Math.max(rgba[o], rgba[o + 1], rgba[o + 2]) - Math.min(rgba[o], rgba[o + 1], rgba[o + 2]); n++; }
    const mean = s / n; return { mean, sd: Math.sqrt(Math.max(0, ss / n - mean * mean)), sat: sat / n };
  };
  const all = { contrast: [], saturation: [], lift: [] }; const sides = {};
  for (const side of ['l', 'r', 't', 'b']) {
    const depth = Math.min(m[side], side === 'l' || side === 'r' ? W : H); if (depth < 16) continue;
    const half = Math.max(8, Math.floor(depth / 2)); const per = { contrast: [], saturation: [], lift: [] };
    const horiz = side === 'l' || side === 'r'; const len = horiz ? H : W;
    for (let a = 0; a + 32 <= len; a += 32) {
      let o; let p;
      if (side === 'l') { o = stat(0, oy + a, half, oy + a + 32); p = stat(ox, oy + a, ox + half, oy + a + 32); }
      if (side === 'r') { o = stat(FW - half, oy + a, FW, oy + a + 32); p = stat(ox + W - half, oy + a, ox + W, oy + a + 32); }
      if (side === 't') { o = stat(ox + a, 0, ox + a + 32, half); p = stat(ox + a, oy, ox + a + 32, oy + half); }
      if (side === 'b') { o = stat(ox + a, FH - half, ox + a + 32, FH); p = stat(ox + a, oy + H - half, ox + a + 32, oy + H); }
      const k = { saturation: o.sat / Math.max(1, p.sat), lift: o.mean - p.mean };
      if (p.sd >= 6) k.contrast = o.sd / p.sd;                  // contrast only where the photo has texture (not clear sky)
      for (const key of Object.keys(k)) { per[key].push(k[key]); all[key].push(k[key]); }
    }
    sides[side] = { contrast: median(per.contrast), saturation: median(per.saturation), lift: median(per.lift), n: per.lift.length };
  }
  return { contrast: median(all.contrast), saturation: median(all.saturation), lift: median(all.lift), n: all.lift.length, sides };
}

/**
 * Visibility of a removal: steps across the outline of the removed object (its own mask, not the grown one) in the result,
 * against the steps across the outline of the object grown by 40 px (untouched picture around it). A silhouette that is
 * still visible (a rim left behind and continued by the fill, a darker or lighter patch, a box) shows as large steps.
 * Also the texture of the fill against the picture around it. Returns { p90, controlP90, ratio, texture }.
 */
function removalScore(rgba, W, H, objectMask, unknown) {
  const steps = contourSteps(rgba, W, H, objectMask);
  const far = C.dilate(objectMask, W, H, 40);
  const ctrl = contourSteps(rgba, W, H, far);
  const dI = C.distanceSq(Uint8Array.from(unknown, (v) => (v ? 0 : 1)), W, H); const dO = C.distanceSq(unknown, W, H);
  const inner = new Uint8Array(W * H); const ring = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) { if (unknown[i] && dI[i] > 64) inner[i] = 1; else if (!unknown[i] && dO[i] > 100 && dO[i] < 1600) ring[i] = 1; }
  const p90 = pct(steps, 0.9); const controlP90 = pct(ctrl, 0.9);
  return { p90, controlP90, ratio: p90 / Math.max(1, controlP90), texture: textureRatio(rgba, W, H, inner, ring) };
}

/**
 * Seams between passes inside the new area (neighbouring extension tiles, removal windows): labels Int32Array(W*H) says which
 * pass last wrote each pixel (0 = original). Steps across every boundary between two passes (both > 0) against the steps
 * across the photo's own control contour. Returns { p90, n }.
 */
function passSeams(rgba, W, H, labels) {
  const steps = [];
  const passes = new Set(labels); passes.delete(0);
  for (const p of passes) {
    const m = new Uint8Array(W * H); for (let i = 0; i < W * H; i++) m[i] = labels[i] === p ? 1 : 0;
    const other = new Uint8Array(W * H); for (let i = 0; i < W * H; i++) other[i] = labels[i] > 0 ? 1 : 0;
    // only where this pass borders another pass
    steps.push(...contourSteps(rgba, W, H, m, other));
  }
  return { p90: pct(steps, 0.9), n: steps.length };
}

/** Run an extension through core.runExtension with a real `fill`, recording which pass wrote which pixel. */
async function trackedExtension(rgba, W, H, margins, fill) {
  let labels = null; let FW = 0; let pass = 0; let cur = null;
  const r = await C.runExtension(rgba, W, H, margins, async (req) => {
    const out = await fill(req); pass++;
    for (let y = 0; y < req.h; y++) for (let x = 0; x < req.w; x++) { const i = (y * req.w + x) * 4; if (req.unknown[y * req.w + x] || out[i] !== req.rgba[i] || out[i + 1] !== req.rgba[i + 1] || out[i + 2] !== req.rgba[i + 2]) labels[(cur.y + y) * FW + cur.x + x] = pass; }
    return out;
  }, { onStart: (_p, w, h) => { FW = w; labels = new Int32Array(w * h); }, onStep: (_k, _n, t) => { cur = t; } });
  return { ...r, labels };
}

module.exports = { luma, pct, median, detailEnergy, textureRatio, contourSteps, boxMask, extensionSeam, haze, removalScore, passSeams, trackedExtension };
