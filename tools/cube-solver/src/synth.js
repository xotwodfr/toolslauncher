'use strict';
// Invented pictures of cube faces with KNOWN colours, for the tests, the self-test and the fake webcam of the end-to-end test:
// black plastic, rounded stickers with gaps, a background, a light colour/level per face, a glare spot, sensor noise, and an
// optional perspective (the face lying in any four-cornered shape in the picture). Also writes YUV4MPEG2 (.y4m) video,
// the format Chromium's fake camera plays.
const fs = require('fs');

// sticker colours as printed (sRGB), a little off the "typical" values the reader starts from on purpose
const PRINT = { w: [236, 238, 240], y: [246, 220, 30], g: [16, 150, 76], b: [14, 64, 172], r: [196, 22, 48], o: [255, 104, 16] };

function rng(seed) { let s = (seed >>> 0) || 7; return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }
function gauss(rnd) { let u = 0; let v = 0; while (u === 0) u = rnd(); while (v === 0) v = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
const toLin = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
const toSrgb = (v) => { v = Math.max(0, Math.min(1, v)); return 255 * (v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055); };

// homography taking the unit square (0,0)(1,0)(1,1)(0,1) to quad, and its inverse
function squareToQuad(q) {
  const [[x0, y0], [x1, y1], [x2, y2], [x3, y3]] = q;
  const dx1 = x1 - x2; const dx2 = x3 - x2; const dy1 = y1 - y2; const dy2 = y3 - y2;
  const sx = x0 - x1 + x2 - x3; const sy = y0 - y1 + y2 - y3;
  let g = 0; let h = 0;
  if (Math.abs(sx) > 1e-9 || Math.abs(sy) > 1e-9) {
    const den = dx1 * dy2 - dx2 * dy1;
    g = (sx * dy2 - dx2 * sy) / den; h = (dx1 * sy - sx * dy1) / den;
  }
  return [x1 - x0 + g * x1, x3 - x0 + h * x3, x0, y1 - y0 + g * y1, y3 - y0 + h * y3, y0, g, h, 1];
}
function invert3(m) {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h; const B = -(d * i - f * g); const Cc = d * h - e * g;
  const det = a * A + b * B + c * Cc;
  return [A / det, -(b * i - c * h) / det, (b * f - c * e) / det, B / det, (a * i - c * g) / det, -(a * f - c * d) / det, Cc / det, -(a * h - b * g) / det, (a * e - b * d) / det];
}

/**
 * colours: n*n colour keys in reading order. Options: width, height, quad (where the face is; default a centred square),
 * light [r,g,b] multipliers (warm lamp ~ [1.15,1,0.7], dim ~ [0.45,0.45,0.45]), noise (sd in 0..255 units), glare (0..1),
 * background [r,g,b], seed. Returns { width, height, data } (RGBA bytes, like canvas ImageData).
 */
function renderFace(colours, opts = {}) {
  const n = Math.round(Math.sqrt(colours.length));
  const width = opts.width || 320; const height = opts.height || 240;
  const side = Math.min(width, height) * 0.7;
  const quad = opts.quad || [[(width - side) / 2, (height - side) / 2], [(width + side) / 2, (height - side) / 2], [(width + side) / 2, (height + side) / 2], [(width - side) / 2, (height + side) / 2]];
  const light = opts.light || [1, 1, 1];
  const noise = opts.noise == null ? 4 : opts.noise;
  const glare = opts.glare || 0;
  const bg = opts.background || [120, 116, 108];
  const rnd = rng(opts.seed || 1);
  const inv = invert3(squareToQuad(quad));
  const data = new Uint8ClampedArray(width * height * 4);
  const gap = 0.06; const radius = 0.12;
  const glareAt = [0.3 + 0.4 * rnd(), 0.3 + 0.4 * rnd()];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const w = inv[6] * (x + 0.5) + inv[7] * (y + 0.5) + inv[8];
      const u = (inv[0] * (x + 0.5) + inv[1] * (y + 0.5) + inv[2]) / w;
      const v = (inv[3] * (x + 0.5) + inv[4] * (y + 0.5) + inv[5]) / w;
      let lin;
      if (u < -0.02 || v < -0.02 || u > 1.02 || v > 1.02) {
        lin = bg.map((c) => toLin(c) * (0.85 + 0.15 * (y / height)));
      } else {
        const cu = Math.min(n - 1, Math.max(0, Math.floor(u * n))); const cv = Math.min(n - 1, Math.max(0, Math.floor(v * n)));
        const lu = u * n - cu; const lv = v * n - cv; // 0..1 inside the cell
        const du = Math.max(0, Math.abs(lu - 0.5) - (0.5 - gap - radius)); const dv = Math.max(0, Math.abs(lv - 0.5) - (0.5 - gap - radius));
        const onSticker = Math.hypot(du, dv) <= radius && u >= 0 && v >= 0 && u <= 1 && v <= 1;
        const base = onSticker ? PRINT[colours[cv * n + cu]] : [18, 18, 20];
        lin = base.map((c) => toLin(c));
        if (glare && onSticker) {
          const gdist = Math.hypot(u - glareAt[0], v - glareAt[1]);
          const gl = glare * Math.exp(-(gdist * gdist) / 0.004);
          lin = lin.map((c) => c + gl);
        }
      }
      const o = (y * width + x) * 4;
      for (let k = 0; k < 3; k++) data[o + k] = toSrgb(lin[k] * light[k]) + noise * gauss(rnd);
      data[o + 3] = 255;
    }
  }
  return { width, height, data, quad };
}

const K = require('./colour');
const hexRgb = (hex) => { const h = String(hex).replace('#', ''); return [0, 2, 4].map((k) => parseInt(h.slice(k, k + 2), 16)); };
/** Printed colours for a puzzle's colour set: the cube colours as above, the rest from their hex. */
function printFor(colours) {
  const byName = { white: PRINT.w, yellow: PRINT.y, green: PRINT.g, blue: PRINT.b, red: PRINT.r, orange: PRINT.o };
  return Object.fromEntries(Object.entries(colours).map(([k, c]) => [k, byName[String(c.name).toLowerCase()] || hexRgb(c.hex)]));
}
// signed distances of p to the edges of a convex polygon (positive inside, whichever way it winds)
function edgeDistances(poly, p) {
  let a = 0; for (let i = 0; i < poly.length; i++) { const q = poly[i]; const r = poly[(i + 1) % poly.length]; a += q[0] * r[1] - r[0] * q[1]; }
  const sgn = a >= 0 ? 1 : -1;
  return poly.map((q, i) => {
    const r = poly[(i + 1) % poly.length];
    const ex = r[0] - q[0]; const ey = r[1] - q[1]; const len = Math.hypot(ex, ey) || 1;
    return sgn * ((p[1] - q[1]) * -ex + (p[0] - q[0]) * ey) / len * -1;
  });
}

/**
 * Any puzzle face: an invented picture of one face template (puzzle.templates[face]) with known colours. colours: sticker
 * index -> colour key (an array over all the puzzle's stickers, or an object). Options as renderFace, plus corners (where the
 * outline's corners are in the picture, in K.outlineCorners order; default: centred, 70% of the picture) and print (colour
 * key -> sRGB as printed). Returns { width, height, data, corners }.
 */
function renderTemplate(template, colours, opts = {}) {
  const width = opts.width || 320; const height = opts.height || 240;
  const corners = opts.corners || K.placeOutline(template, width / 2, height / 2, Math.min(width, height) * 0.7);
  const print = opts.print || PRINT;
  const light = opts.light || [1, 1, 1];
  const noise = opts.noise == null ? 4 : opts.noise;
  const glare = opts.glare || 0;
  const bg = opts.background || [120, 116, 108];
  const rnd = rng(opts.seed || 1);
  const H = K.templateMap(template, corners);
  const inv = K.invertMap(H);
  const box = template.box; const span = Math.max(box.w, box.h);
  const outline = K.outlineCorners(template);
  const cells = template.stickers.map((s) => {
    let a = 0; for (let i = 0; i < s.poly.length; i++) { const q = s.poly[i]; const r = s.poly[(i + 1) % s.poly.length]; a += q[0] * r[1] - r[0] * q[1]; }
    const size = Math.sqrt(Math.abs(a) / 2);
    const xs = s.poly.map((p) => p[0]); const ys = s.poly.map((p) => p[1]);
    return { poly: s.poly, colour: colours[s.i], gap: 0.06 * size, radius: 0.12 * size * (s.poly.length === 3 ? 0.6 : 1), minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
  });
  const data = new Uint8ClampedArray(width * height * 4);
  const glareAt = [0.3 + 0.4 * rnd(), 0.3 + 0.4 * rnd()];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const t = K.mapPoint(inv, [x + 0.5, y + 0.5]);
      const od = Math.min(...edgeDistances(outline, t));
      let lin;
      if (od < -0.02 * span) {
        lin = bg.map((c) => toLin(c) * (0.85 + 0.15 * (y / height)));
      } else {
        let base = [18, 18, 20]; let onSticker = false;
        for (const c of cells) {
          if (t[0] < c.minX || t[0] > c.maxX || t[1] < c.minY || t[1] > c.maxY) continue;
          const e = edgeDistances(c.poly, t);
          if (Math.min(...e) < 0) continue;
          const inset = c.gap + c.radius;
          const q = Math.hypot(...e.map((v) => Math.max(0, inset - v)));
          if (q <= c.radius) { onSticker = true; base = print[c.colour] || [60, 60, 60]; }
          break;
        }
        lin = base.map((c) => toLin(c));
        if (glare && onSticker) {
          const u = (t[0] - box.minX) / span; const v = (t[1] - box.minY) / span;
          const gdist = Math.hypot(u - glareAt[0], v - glareAt[1]);
          const gl = glare * Math.exp(-(gdist * gdist) / 0.004);
          lin = lin.map((c) => c + gl);
        }
      }
      const o = (y * width + x) * 4;
      for (let k = 0; k < 3; k++) data[o + k] = toSrgb(lin[k] * light[k]) + noise * gauss(rnd);
      data[o + 3] = 255;
    }
  }
  return { width, height, data, corners };
}

/** RGBA image -> one I420 (YUV 4:2:0, BT.601 studio range) frame. */
function toI420(img) {
  const { width: w, height: h, data } = img;
  const Y = Buffer.alloc(w * h); const U = Buffer.alloc((w / 2) * (h / 2)); const V = Buffer.alloc((w / 2) * (h / 2));
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      Y[y * w + x] = Math.round(16 + (65.481 * data[o] + 128.553 * data[o + 1] + 24.966 * data[o + 2]) / 255);
    }
  }
  for (let y = 0; y < h; y += 2) {
    for (let x = 0; x < w; x += 2) {
      let r = 0; let g = 0; let b = 0;
      for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) { const o = ((y + dy) * w + x + dx) * 4; r += data[o]; g += data[o + 1]; b += data[o + 2]; }
      r /= 4; g /= 4; b /= 4;
      const k = (y / 2) * (w / 2) + x / 2;
      U[k] = Math.round(128 + (-37.797 * r - 74.203 * g + 112 * b) / 255);
      V[k] = Math.round(128 + (112 * r - 93.786 * g - 18.214 * b) / 255);
    }
  }
  return Buffer.concat([Y, U, V]);
}
/** Writes a .y4m video: frames is a list of { image, repeat } (repeat = how many frames to hold it). */
function writeY4m(file, frames, fps = 10) {
  const { width, height } = frames[0].image;
  const fd = fs.openSync(file, 'w');
  try {
    fs.writeSync(fd, `YUV4MPEG2 W${width} H${height} F${fps}:1 Ip A1:1 C420jpeg\n`);
    for (const { image, repeat = 1 } of frames) {
      const frame = toI420(image);
      for (let k = 0; k < repeat; k++) { fs.writeSync(fd, 'FRAME\n'); fs.writeSync(fd, frame); }
    }
  } finally { fs.closeSync(fd); }
  return file;
}

module.exports = { PRINT, printFor, renderTemplate, renderFace, writeY4m, toI420, squareToQuad, invert3 };
