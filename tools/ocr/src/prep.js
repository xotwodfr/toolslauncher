'use strict';
// Getting a picture ready to be read: how much to enlarge it, and turning it into clean dark-on-light grey. Works on plain
// RGBA arrays, so the window runs it on canvas pixels and the tests run it with plain Node.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Prep = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  const TARGET_SIDE = 2000;     // small pictures are enlarged until their longer side is about this many pixels
  const MAX_SCALE = 3;
  const MAX_SIDE = 4500;        // huge pictures are shrunk to this: more pixels only make it slower
  const DARK_BACKGROUND = 110;  // average brightness below this (0..255) means light text on a dark background

  /** Factor to draw the picture at before reading it. 1 = unchanged; above 1 = enlarged; below 1 = shrunk. */
  function scaleFor(w, h, enlarge = true) {
    const longest = Math.max(w, h);
    if (longest > MAX_SIDE) return MAX_SIDE / longest;
    if (!enlarge) return 1;
    return Math.min(MAX_SCALE, Math.max(1, TARGET_SIDE / longest));
  }

  /**
   * Make the pixels easier to read, in place: grey, with the contrast stretched, dark text on a light background.
   * @param px     Uint8ClampedArray / Uint8Array of RGBA
   * @returns {{ inverted: boolean, mean: number, lo: number, hi: number }}
   */
  function enhance(px, opts = {}) {
    const n = px.length / 4;
    const grey = new Uint8Array(n);
    const hist = new Uint32Array(256);
    let sum = 0;
    for (let i = 0; i < n; i++) {
      const a = px[i * 4 + 3] / 255;
      // see-through pixels are judged against white
      const g = Math.round((0.299 * px[i * 4] + 0.587 * px[i * 4 + 1] + 0.114 * px[i * 4 + 2]) * a + 255 * (1 - a));
      grey[i] = g; hist[g]++; sum += g;
    }
    const mean = sum / Math.max(1, n);
    // stretch between the 1st and 99th percentile so one stray dark or bright pixel does not decide
    let lo = 0; let hi = 255; let acc = 0;
    for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= n * 0.01) { lo = v; break; } }
    acc = 0;
    for (let v = 255; v >= 0; v--) { acc += hist[v]; if (acc >= n * 0.01) { hi = v; break; } }
    if (hi - lo < 12) { lo = 0; hi = 255; }   // (nearly) one flat colour: nothing to stretch, and it must not turn black
    const span = Math.max(1, hi - lo);
    const inverted = opts.invert === 'auto' || opts.invert === undefined ? mean < DARK_BACKGROUND : !!opts.invert;
    for (let i = 0; i < n; i++) {
      let v = ((grey[i] - lo) * 255) / span;
      v = v < 0 ? 0 : v > 255 ? 255 : v;
      if (inverted) v = 255 - v;
      px[i * 4] = px[i * 4 + 1] = px[i * 4 + 2] = v; px[i * 4 + 3] = 255;
    }
    return { inverted, mean, lo, hi };
  }

  /** A selection drawn on the picture, kept inside it and made whole pixels; null when it is too small to read. */
  function clampRegion(r, w, h) {
    if (!r) return null;
    const x0 = Math.max(0, Math.min(w, Math.round(Math.min(r.x, r.x + r.w))));
    const y0 = Math.max(0, Math.min(h, Math.round(Math.min(r.y, r.y + r.h))));
    const x1 = Math.max(0, Math.min(w, Math.round(Math.max(r.x, r.x + r.w))));
    const y1 = Math.max(0, Math.min(h, Math.round(Math.max(r.y, r.y + r.h))));
    return x1 - x0 >= 8 && y1 - y0 >= 8 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
  }

  return { TARGET_SIDE, MAX_SCALE, MAX_SIDE, DARK_BACKGROUND, scaleFor, enhance, clampRegion };
}));
