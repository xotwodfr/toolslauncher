'use strict';
// INVENTED photos for the tests, the self-test and the README screenshot (so nobody's real photo is needed or shown).
// Plain JavaScript, returns RGBA pixels and where the objects are.

function rng(seed) { let s = (seed >>> 0) || 1; return () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }
const clamp8 = (v) => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));

/**
 * A simple test photo: a soft sky-blue gradient (with a little grain) behind an obvious red ball and a dark post.
 * The background colour at any point is known exactly (bg(x, y)), so a removal can be checked against it.
 */
function testPhoto(W, H, seed = 1) {
  const rand = rng(seed);
  const rgba = new Uint8ClampedArray(W * H * 4);
  const noise = new Float32Array(W * H);
  for (let i = 0; i < noise.length; i++) noise[i] = (rand() - 0.5) * 4;
  const bg = (x, y) => { const t = y / (H - 1); const u = x / (W - 1); return [120 + 60 * t + 8 * u, 165 + 40 * t, 220 + 15 * t - 6 * u]; };
  const disc = { cx: Math.round(W * 0.6), cy: Math.round(H * 0.45), r: Math.round(Math.min(W, H) * 0.12) };
  const post = { x: Math.round(W * 0.18), y: Math.round(H * 0.55), w: Math.round(W * 0.05), h: Math.round(H * 0.25) };
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x; const o = i * 4;
    let [r, g, b] = bg(x, y);
    r += noise[i]; g += noise[i]; b += noise[i];
    const dx = x + 0.5 - disc.cx; const dy = y + 0.5 - disc.cy; const d = Math.hypot(dx, dy);
    if (d <= disc.r) {
      const shade = 0.75 + 0.25 * Math.max(0, -(dx + dy) / (disc.r * 1.5));
      const edge = Math.min(1, disc.r - d);                       // 1 px of anti-aliasing
      r = r * (1 - edge) + 225 * shade * edge; g = g * (1 - edge) + 45 * shade * edge; b = b * (1 - edge) + 40 * shade * edge;
    }
    if (x >= post.x && x < post.x + post.w && y >= post.y && y < post.y + post.h) { r = 52; g = 44; b = 40; }
    rgba[o] = clamp8(r); rgba[o + 1] = clamp8(g); rgba[o + 2] = clamp8(b); rgba[o + 3] = 255;
  }
  return { rgba, W, H, disc, post, bg };
}

/** A beach for the README screenshot: sky, sea, sand, a beach hut on the right and a striped bin in the foreground. */
function beachScene(W, H, seed = 3) {
  const rand = rng(seed);
  const rgba = new Uint8ClampedArray(W * H * 4);
  const horizon = Math.round(H * 0.46); const shore = Math.round(H * 0.62);
  const bin = { cx: Math.round(W * 0.36), top: Math.round(H * 0.6), w: Math.round(W * 0.07), h: Math.round(H * 0.2) };
  const waveRow = new Float32Array(W); for (let x = 0; x < W; x++) waveRow[x] = Math.sin(x / (W * 0.03)) * H * 0.006 + Math.sin(x / (W * 0.011) + 1) * H * 0.003;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const o = (y * W + x) * 4; const n = (rand() - 0.5);
    let r; let g; let b;
    if (y < horizon) {
      const t = y / horizon;
      r = 96 + 110 * t; g = 150 + 75 * t; b = 222 + 18 * t;
      const sun = Math.hypot(x - W * 0.78, y - H * 0.16); if (sun < H * 0.05) { r = 255; g = 246; b = 214; } else if (sun < H * 0.12) { const k = 1 - (sun - H * 0.05) / (H * 0.07); r += 60 * k; g += 40 * k; b += 5 * k; }
      r += n * 3; g += n * 3; b += n * 3;
    } else if (y < shore + waveRow[x]) {
      const t = (y - horizon) / (shore - horizon);
      const ripple = Math.sin(x / 9 + y * 0.9) * Math.sin(y * 0.37) * 10;
      r = 30 + 40 * t + ripple * 0.4; g = 105 + 55 * t + ripple; b = 150 + 30 * t + ripple;
      if (y > shore + waveRow[x] - 4) { r = 235; g = 240; b = 238; }
    } else {
      const t = (y - shore) / (H - shore);
      r = 222 - 20 * t + n * 26; g = 196 - 22 * t + n * 24; b = 150 - 25 * t + n * 20;
    }
    // beach hut
    const hx0 = W * 0.82; const hx1 = W * 0.93; const hy0 = H * 0.5; const hy1 = H * 0.66;
    if (x >= hx0 && x < hx1 && y >= hy0 && y < hy1) { const stripe = Math.floor((x - hx0) / (W * 0.011)) % 2; r = stripe ? 245 : 70; g = stripe ? 240 : 130; b = stripe ? 232 : 190; }
    if (y >= hy0 - (W * 0.055 - Math.abs(x - (hx0 + hx1) / 2)) * 0.8 && y < hy0 && x >= hx0 - 4 && x < hx1 + 4) { r = 170; g = 60; b = 50; }
    // striped bin with a shadow
    const bx = x - bin.cx; const by = y - bin.top;
    if (by > bin.h - 6 && by < bin.h + 10 && Math.abs(bx + 18) < bin.w * 0.8) { r *= 0.8; g *= 0.8; b *= 0.82; }
    if (by >= 0 && by < bin.h && Math.abs(bx) < bin.w / 2 - by * 0.04) {
      const band = Math.floor(by / (bin.h / 5)) % 2; const light = 0.8 + 0.3 * (0.5 - Math.abs(bx) / bin.w);
      r = (band ? 30 : 210) * light; g = (band ? 120 : 50) * light; b = (band ? 70 : 45) * light;
    }
    rgba[o] = clamp8(r); rgba[o + 1] = clamp8(g); rgba[o + 2] = clamp8(b); rgba[o + 3] = 255;
  }
  return { rgba, W, H, bin, tap: { x: bin.cx, y: bin.top + Math.round(bin.h * 0.45) } };
}

/** Smooth value noise (several octaves, separate x / y scales) for natural-looking textures. Returns f(x, y) -> about -1..1. */
function valueNoise(seed, sx, sy, octaves = 4) {
  const rand = rng(seed); const N = 256; const g = new Float32Array(N * N); for (let i = 0; i < g.length; i++) g[i] = rand() * 2 - 1;
  const at = (x, y) => g[(y & (N - 1)) * N + (x & (N - 1))];
  const smooth = (t) => t * t * (3 - 2 * t);
  const one = (x, y) => { const x0 = Math.floor(x); const y0 = Math.floor(y); const tx = smooth(x - x0); const ty = smooth(y - y0);
    const a = at(x0, y0) + (at(x0 + 1, y0) - at(x0, y0)) * tx; const b = at(x0, y0 + 1) + (at(x0 + 1, y0 + 1) - at(x0, y0 + 1)) * tx; return a + (b - a) * ty; };
  return (x, y) => { let v = 0; let amp = 1; let f = 1; let tot = 0; for (let o = 0; o < octaves; o++) { v += one((x * f) / sx + o * 17.3, (y * f) / sy + o * 9.1) * amp; tot += amp; amp *= 0.5; f *= 2; } return v / tot; };
}

/**
 * A park, like a real phone photo: a sky gradient (darker at the top left), a dark tree line, a pond with ripples on the
 * left and textured grass with blades that get coarser towards the bottom, plus a large white-and-brown "dog" (with a soft
 * outline) lying on the grass. For the seam and texture tests (and nobody's real photo is needed).
 * Returns { rgba, W, H, dog: { cx, cy, rx, ry }, mask (Uint8Array, the dog), horizon }.
 */
function parkScene(W, H, seed = 5) {
  const rgba = new Uint8ClampedArray(W * H * 4); const mask = new Uint8Array(W * H);
  const rand = rng(seed);
  const tree = valueNoise(seed + 1, W * 0.06, H * 0.05, 5); const edge = valueNoise(seed + 2, W * 0.05, 1, 4);
  const grassLo = valueNoise(seed + 3, W * 0.08, H * 0.05, 3); const blades = valueNoise(seed + 4, 2.2, 9, 3); const bladesBig = valueNoise(seed + 5, 4.5, 18, 3);
  const pondEdge = valueNoise(seed + 6, 1, H * 0.06, 3); const ripple = valueNoise(seed + 7, W * 0.05, 1.6, 3);
  const horizon = Math.round(H * 0.36); const treeBottom = Math.round(H * 0.47);
  const dog = { cx: Math.round(W * 0.48), cy: Math.round(H * 0.72), rx: Math.round(W * 0.2), ry: Math.round(H * 0.15) };
  const fringe = Math.max(2, Math.round(Math.max(W, H) / 240));
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const o = (y * W + x) * 4; const u = x / W; const v = y / H; const n = rand() - 0.5;
    let r; let g; let b;
    const treeTop = horizon - (0.5 + 0.5 * edge(x, 0)) * H * 0.14;
    if (y < treeTop) {                                          // sky
      const t = y / horizon;
      r = 60 + 110 * t + 25 * u; g = 120 + 80 * t + 15 * u; b = 205 + 35 * t; r += n * 2; g += n * 2; b += n * 2;
    } else if (y < treeBottom) {                                // trees
      const k = 0.5 + 0.5 * tree(x, y);
      r = 25 + 60 * k; g = 50 + 90 * k; b = 20 + 35 * k; r += n * 18; g += n * 22; b += n * 10;
    } else {
      const depth = (y - treeBottom) / (H - treeBottom);        // 0 far .. 1 near
      const pondRight = W * (0.42 - 0.35 * depth) + pondEdge(0, y) * W * 0.03;
      if (x < pondRight && depth < 0.32) {                      // pond
        const rp = ripple(x, y);
        r = 70 + 25 * rp + 30 * (1 - depth); g = 105 + 30 * rp + 25 * (1 - depth); b = 120 + 35 * rp + 20 * (1 - depth);
        r += n * 6; g += n * 6; b += n * 6;
      } else {                                                  // grass
        const scale = 0.35 + 1.4 * depth;
        const bl = depth > 0.45 ? bladesBig(x / scale, y / scale) : blades(x / scale, y / scale);
        const lo = grassLo(x, y);
        const shade = 0.75 + 0.18 * lo + 0.22 * bl;
        r = (70 + 30 * depth) * shade + n * 14; g = (135 + 25 * depth) * shade + n * 16; b = (45 + 10 * depth) * shade + n * 10;
      }
    }
    // the dog: a white body with brown patches. Its outline is soft, as in a real photo (fur, a little blur): a light fringe
    // of `fringe` pixels lies outside the mask, which (like Segment Anything's) only covers the body itself.
    const dx = (x - dog.cx) / dog.rx; const dy = (y - dog.cy) / dog.ry; const d = dx * dx + dy * dy;
    const out = (d - 1) / (2 * Math.hypot(dx / dog.rx, dy / dog.ry) + 1e-9);   // pixels outside the outline (about)
    if (d >= 1 && out < fringe) { const k = 0.6 * (1 - out / fringe); r += (225 - r) * k; g += (220 - g) * k; b += (208 - b) * k; }
    if (d < 1) {
      mask[y * W + x] = 1;
      const patch = tree(x * 1.7, y * 1.7) > 0.1;
      if (patch) { r = 120 + n * 20; g = 70 + n * 14; b = 40 + n * 10; } else { r = 232 + n * 10; g = 226 + n * 10; b = 215 + n * 10; }
    }
    rgba[o] = clamp8(r); rgba[o + 1] = clamp8(g); rgba[o + 2] = clamp8(b); rgba[o + 3] = 255;
  }
  return { rgba, W, H, dog, mask, horizon };
}

module.exports = { testPhoto, beachScene, parkScene, valueNoise, rng };
