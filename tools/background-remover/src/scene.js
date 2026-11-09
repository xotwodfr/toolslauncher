'use strict';
// Draws INVENTED pictures with a clear subject on a busy background, as raw RGB in memory: a potted plant, a round-bellied
// lamp, a striped mug. Used by the tests, the packaged self-test and the README screenshot, so nobody's photograph is needed.
// Every shape is a signed-distance function with a one-pixel soft edge. The function also returns where the subject is, so a
// test can compare the program's cutout with the truth.

const rot = (x, y, a) => ({ x: x * Math.cos(a) + y * Math.sin(a), y: -x * Math.sin(a) + y * Math.cos(a) });
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

// Each shape: dist(x, y) -> signed distance (negative inside), colour(x, y, u) -> [r, g, b] where u is 0..1 across the shape.
const ellipse = (cx, cy, rx, ry, angle = 0) => ({
  dist: (x, y) => { const p = rot(x - cx, y - cy, angle); return (Math.hypot(p.x / rx, p.y / ry) - 1) * Math.min(rx, ry); },
  local: (x, y) => { const p = rot(x - cx, y - cy, angle); return { u: clamp01(0.5 + p.x / (2 * rx)), v: clamp01(0.5 + p.y / (2 * ry)) }; },
});
const polygon = (pts) => ({ // convex polygon, vertices in order
  dist: (x, y) => {
    let d = -Infinity;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i]; const b = pts[(i + 1) % pts.length];
      const ex = b[0] - a[0]; const ey = b[1] - a[1]; const len = Math.hypot(ex, ey);
      d = Math.max(d, ((x - a[0]) * ey - (y - a[1]) * ex) / len); // negative inside for vertices listed clockwise on screen
    }
    return d;
  },
  local: (x, y) => { const xs = pts.map((p) => p[0]); const ys = pts.map((p) => p[1]); const x0 = Math.min(...xs); const y0 = Math.min(...ys); return { u: clamp01((x - x0) / (Math.max(...xs) - x0)), v: clamp01((y - y0) / (Math.max(...ys) - y0)) }; },
});
/** The outline of a shape, `t` thick (the handle of a mug is a ring). */
const ring = (shape, t) => ({ dist: (x, y) => Math.abs(shape.dist(x, y)) - t, local: shape.local });
const roundRect = (x0, y0, x1, y1, r) => ({
  dist: (x, y) => { const cx = (x0 + x1) / 2; const cy = (y0 + y1) / 2; const qx = Math.abs(x - cx) - ((x1 - x0) / 2 - r); const qy = Math.abs(y - cy) - ((y1 - y0) / 2 - r); return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r; },
  local: (x, y) => ({ u: clamp01((x - x0) / (x1 - x0)), v: clamp01((y - y0) / (y1 - y0)) }),
});

/** The three scenes. Each returns { shapes: [...subject shapes back to front], bg: {...} }. Coordinates are 0..1 of the picture. */
function layout(kind, w, h) {
  const S = Math.min(w, h);
  const X = (v) => v * w; const Y = (v) => v * h;
  if (kind === 'lamp') {
    return {
      bg: { a: [226, 208, 176], b: [124, 160, 156], dots: [[255, 244, 214], [96, 132, 140]] },
      shadow: { cx: X(0.5), cy: Y(0.9), rx: S * 0.26, ry: S * 0.045 },
      subject: [
        { shape: ellipse(X(0.5), Y(0.66), S * 0.25, S * 0.23), a: [232, 96, 62], b: [150, 40, 30], shine: true },        // round body
        { shape: roundRect(X(0.5) - S * 0.045, Y(0.3), X(0.5) + S * 0.045, Y(0.45), S * 0.02), a: [58, 58, 66], b: [30, 30, 36] }, // neck
        { shape: polygon([[X(0.5) - S * 0.1, Y(0.1)], [X(0.5) + S * 0.1, Y(0.1)], [X(0.5) + S * 0.2, Y(0.3)], [X(0.5) - S * 0.2, Y(0.3)]]), a: [250, 232, 160], b: [220, 170, 90] }, // shade
        { shape: ellipse(X(0.5), Y(0.915), S * 0.12, S * 0.03), a: [70, 70, 78], b: [40, 40, 46] },                       // foot
      ],
    };
  }
  if (kind === 'mug') {
    return {
      bg: { a: [186, 210, 232], b: [238, 226, 214], dots: [[255, 255, 255], [150, 176, 204]] },
      shadow: { cx: X(0.5), cy: Y(0.83), rx: S * 0.3, ry: S * 0.05 },
      subject: [
        { shape: ring(ellipse(X(0.76), Y(0.54), S * 0.13, S * 0.17, 0.12), S * 0.032), a: [250, 250, 250], b: [200, 200, 205] },  // handle: a ring, so the background shows through its middle
        { shape: roundRect(X(0.5) - S * 0.28, Y(0.28), X(0.5) + S * 0.28, Y(0.8), S * 0.07), a: [64, 120, 200], b: [30, 70, 140], stripes: true },
        { shape: ellipse(X(0.5), Y(0.285), S * 0.28, S * 0.055), a: [250, 248, 244], b: [200, 196, 190] },                 // rim
      ],
    };
  }
  // plant (default)
  const leaf = (angle, len, w2, a, b) => {
    const cx = X(0.5) + Math.sin(angle) * len * 0.5; const cy = Y(0.58) - Math.cos(angle) * len * 0.5;
    return { shape: ellipse(cx, cy, w2, len * 0.5, -angle), a, b, vein: true };
  };
  return {
    bg: { a: [238, 214, 188], b: [170, 196, 180], dots: [[255, 238, 210], [130, 160, 150]] },
    shadow: { cx: X(0.5), cy: Y(0.93), rx: S * 0.24, ry: S * 0.04 },
    subject: [
      leaf(-1.2, S * 0.34, S * 0.05, [84, 176, 96], [34, 110, 60]),
      leaf(1.15, S * 0.36, S * 0.05, [96, 188, 104], [36, 116, 62]),
      leaf(-0.6, S * 0.42, S * 0.06, [66, 160, 86], [26, 98, 54]),
      leaf(0.55, S * 0.44, S * 0.06, [78, 172, 92], [30, 104, 58]),
      leaf(0.0, S * 0.48, S * 0.06, [92, 184, 100], [32, 108, 56]),
      { shape: polygon([[X(0.5) - S * 0.19, Y(0.58)], [X(0.5) + S * 0.19, Y(0.58)], [X(0.5) + S * 0.135, Y(0.92)], [X(0.5) - S * 0.135, Y(0.92)]]), a: [206, 112, 72], b: [150, 70, 42], band: true },
    ],
  };
}

/** Pseudo-random but repeatable. */
const hash = (x, y, s) => { let h = (x * 374761393 + y * 668265263 + s * 2147483647) | 0; h = (h ^ (h >>> 13)) * 1274126177; return ((h ^ (h >>> 16)) >>> 0) / 4294967296; };

/**
 * @param {'plant'|'lamp'|'mug'} kind
 * @returns {{ rgb: Uint8Array, truth: Uint8Array, width: number, height: number }} truth = 255 where the subject is, else 0
 */
function drawScene(kind = 'plant', width = 960, height = 720, seed = 1) {
  const L = layout(kind, width, height);
  const rgb = new Uint8Array(width * height * 3);
  const truth = new Uint8Array(width * height);
  const dots = [];
  for (let i = 0; i < 46; i++) dots.push({ x: hash(i, 1, seed) * width, y: hash(i, 2, seed) * height, r: 12 + hash(i, 3, seed) * 46, c: hash(i, 4, seed) < 0.5 ? 0 : 1, o: 0.12 + hash(i, 5, seed) * 0.28 });
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      // busy background: diagonal gradient, soft bokeh discs, fine grain, a few darker bands
      let c = mix(L.bg.a, L.bg.b, clamp01((x / width) * 0.55 + (y / height) * 0.55));
      for (const d of dots) {
        const e = (Math.hypot(x - d.x, y - d.y) - d.r) / 2.2;
        const cov = (e < -1 ? 1 : e > 1 ? 0 : 0.5 - e * 0.5) * d.o;
        if (cov > 0) c = mix(c, L.bg.dots[d.c], cov);
      }
      const band = 0.5 + 0.5 * Math.sin((x * 0.03 + y * 0.011) + seed);
      c = mix(c, [c[0] * 0.8, c[1] * 0.8, c[2] * 0.82], 0.25 * band);
      const g = (hash(x, y, seed) - 0.5) * 10;
      c = [c[0] + g, c[1] + g, c[2] + g];
      // soft shadow on the ground
      const sh = L.shadow; const sd = Math.hypot((x - sh.cx) / sh.rx, (y - sh.cy) / sh.ry);
      if (sd < 1.5) c = mix(c, [40, 36, 40], 0.42 * clamp01(1.5 - sd) ** 1.5);
      let inSubject = false;
      for (const part of L.subject) {
        const d = part.shape.dist(x, y);
        if (d > 1) continue;
        const cov = d < -1 ? 1 : 0.5 - d * 0.5;
        const { u, v } = part.shape.local(x, y);
        let col = mix(part.a, part.b, clamp01(v * 0.8 + (1 - u) * 0.2));
        if (part.shine) { const sdist = Math.hypot(u - 0.34, v - 0.3); col = mix(col, [255, 245, 235], clamp01(0.55 - sdist * 1.6) * 0.8); }
        if (part.stripes && Math.floor(v * 14) % 2 === 0 && v > 0.12 && v < 0.88) col = mix(col, [236, 244, 255], 0.9);
        if (part.band && v < 0.14) col = mix(col, [236, 150, 108], 0.9);
        if (part.vein && Math.abs(u - 0.5) < 0.012) col = mix(col, [20, 80, 40], 0.5);
        c = mix(c, col, cov);
        if (cov > 0.5) inSubject = true;
      }
      const o = (y * width + x) * 3;
      rgb[o] = Math.max(0, Math.min(255, c[0])); rgb[o + 1] = Math.max(0, Math.min(255, c[1])); rgb[o + 2] = Math.max(0, Math.min(255, c[2]));
      truth[y * width + x] = inSubject ? 255 : 0;
    }
  }
  return { rgb, truth, width, height };
}

module.exports = { drawScene };
