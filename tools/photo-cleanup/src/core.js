'use strict';
// Photo Cleanup's pixel and geometry core. Pure JavaScript with no dependencies, so the very same code runs in the window
// (loaded with a <script> tag, as window.Core), in the model worker thread and in the plain-Node unit tests.
//
//   masks       brush strokes, distance transform, grow (dilate), feather, connected parts, bounding boxes
//   resampling  one separable tent filter that both shrinks (area-like) and enlarges (bilinear)
//   filling     prepare a window of the photo for the 512 x 512 LaMa model and blend its answer back in, so that every
//               pixel outside the filled area (plus a narrow feather) stays bit-identical
//   selection   Segment Anything input size and turning its low-resolution answer into a full-resolution mask
//   extending   new canvas size for an aspect preset or dragged edges, and the outward tile plan used to fill it
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Core = factory();
}(typeof self !== 'undefined' ? self : this, () => {
  const MODEL = 512;                 // LaMa's fixed input size
  const SAM = 1024;                  // Segment Anything's input size (longest side)
  const MAX_PIXELS = 60e6;           // largest photo we open or make by extending
  const MAX_SIDE = 20000;
  const MAX_FILE_BYTES = 250 * 1024 * 1024;

  class UserError extends Error {}

  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

  // ---- rectangles -----------------------------------------------------------------------------------------------------------
  // A rect is { x, y, w, h } in pixels, integers, w/h > 0. A box is { x0, y0, x1, y1 } with x1/y1 exclusive.
  const boxToRect = (b) => ({ x: b.x0, y: b.y0, w: b.x1 - b.x0, h: b.y1 - b.y0 });
  const rectToBox = (r) => ({ x0: r.x, y0: r.y, x1: r.x + r.w, y1: r.y + r.h });
  function unionBox(a, b) { if (!a) return b ? { ...b } : null; if (!b) return { ...a }; return { x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) }; }
  function clipBox(b, w, h) {
    const r = { x0: clamp(b.x0, 0, w), y0: clamp(b.y0, 0, h), x1: clamp(b.x1, 0, w), y1: clamp(b.y1, 0, h) };
    return r.x1 > r.x0 && r.y1 > r.y0 ? r : null;
  }
  const growBox = (b, m) => ({ x0: b.x0 - m, y0: b.y0 - m, x1: b.x1 + m, y1: b.y1 + m });
  const boxesTouch = (a, b) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;

  /** Copy a rect out of an interleaved image (ch channels per pixel). */
  function getRect(src, w, ch, r) {
    const T = src.constructor;
    const out = new T(r.w * r.h * ch);
    for (let y = 0; y < r.h; y++) out.set(src.subarray(((r.y + y) * w + r.x) * ch, ((r.y + y) * w + r.x + r.w) * ch), y * r.w * ch);
    return out;
  }
  /** Paste a rect into an interleaved image. */
  function putRect(dst, w, ch, r, data) {
    for (let y = 0; y < r.h; y++) dst.set(data.subarray(y * r.w * ch, (y + 1) * r.w * ch), ((r.y + y) * w + r.x) * ch);
  }

  // ---- masks ----------------------------------------------------------------------------------------------------------------
  /** Bounding box of the nonzero pixels (optionally only inside box `within`), or null. */
  function maskBox(mask, w, h, within) {
    const b = within || { x0: 0, y0: 0, x1: w, y1: h };
    let x0 = Infinity; let y0 = Infinity; let x1 = -1; let y1 = -1;
    for (let y = b.y0; y < b.y1; y++) {
      const row = y * w;
      let first = -1; let last = -1;
      for (let x = b.x0; x < b.x1; x++) if (mask[row + x]) { if (first < 0) first = x; last = x; }
      if (first >= 0) { if (first < x0) x0 = first; if (last > x1) x1 = last; if (y < y0) y0 = y; y1 = y; }
    }
    return x1 < 0 ? null : { x0, y0, x1: x1 + 1, y1: y1 + 1 };
  }
  const maskCount = (mask) => { let n = 0; for (let i = 0; i < mask.length; i++) if (mask[i]) n++; return n; };

  /** Bounding box of the pixels where two same-sized arrays differ (ch values per pixel), or null. */
  function diffBox(a, b, w, h, ch = 1) {
    let x0 = Infinity; let y0 = Infinity; let x1 = -1; let y1 = -1;
    for (let y = 0; y < h; y++) {
      const row = y * w * ch;
      let first = -1; let last = -1;
      for (let i = 0; i < w * ch; i++) if (a[row + i] !== b[row + i]) { const x = (i / ch) | 0; if (first < 0) first = x; last = x; }
      if (first >= 0) { if (first < x0) x0 = first; if (last > x1) x1 = last; if (y < y0) y0 = y; y1 = y; }
    }
    return x1 < 0 ? null : { x0, y0, x1: x1 + 1, y1: y1 + 1 };
  }

  /**
   * Paint a round-capped line (a "capsule") of radius r from (ax, ay) to (bx, by) into the mask with `value` (0 or 1).
   * Coordinates are in pixels, pixel centres at +0.5. Returns the changed area as a box (or null).
   */
  function paintLine(mask, w, h, ax, ay, bx, by, r, value) {
    const box = clipBox({ x0: Math.floor(Math.min(ax, bx) - r), y0: Math.floor(Math.min(ay, by) - r), x1: Math.ceil(Math.max(ax, bx) + r) + 1, y1: Math.ceil(Math.max(ay, by) + r) + 1 }, w, h);
    if (!box) return null;
    const dx = bx - ax; const dy = by - ay; const len2 = dx * dx + dy * dy; const r2 = r * r;
    const v = value ? 1 : 0;
    for (let y = box.y0; y < box.y1; y++) {
      const py = y + 0.5;
      for (let x = box.x0; x < box.x1; x++) {
        const px = x + 0.5;
        let t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const ex = ax + t * dx - px; const ey = ay + t * dy - py;
        if (ex * ex + ey * ey <= r2) mask[y * w + x] = v;
      }
    }
    return box;
  }

  // Exact Euclidean distance transform (Felzenszwalb & Huttenlocher). Squared distance from every pixel to the nearest
  // nonzero pixel of `mask`; 0 on the mask itself. Pixels further than `cap` (if given) may report anything >= cap^2.
  const INF = 1e20;
  function edt1d(f, n, d, v, z) {
    let k = 0; v[0] = 0; z[0] = -INF; z[1] = INF;
    for (let q = 1; q < n; q++) {
      let s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      while (s <= z[k]) { k--; s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]); }
      k++; v[k] = q; z[k] = s; z[k + 1] = INF;
    }
    k = 0;
    for (let q = 0; q < n; q++) { while (z[k + 1] < q) k++; const t = q - v[k]; d[q] = t * t + f[v[k]]; }
  }
  function distanceSq(mask, w, h) {
    const out = new Float32Array(w * h);
    const n = Math.max(w, h);
    const f = new Float64Array(n); const d = new Float64Array(n); const v = new Int32Array(n); const z = new Float64Array(n + 1);
    for (let x = 0; x < w; x++) {
      for (let y = 0; y < h; y++) f[y] = mask[y * w + x] ? 0 : INF;
      edt1d(f, h, d, v, z);
      for (let y = 0; y < h; y++) out[y * w + x] = d[y];
    }
    for (let y = 0; y < h; y++) {
      const row = y * w;
      for (let x = 0; x < w; x++) f[x] = out[row + x];
      edt1d(f, w, d, v, z);
      for (let x = 0; x < w; x++) out[row + x] = d[x];
    }
    return out;
  }

  /** Grow the mask by r pixels (round). Returns a new Uint8Array. */
  function dilate(mask, w, h, r) {
    const out = new Uint8Array(w * h);
    if (!(r > 0)) { for (let i = 0; i < out.length; i++) out[i] = mask[i] ? 1 : 0; return out; }
    const d = distanceSq(mask, w, h); const r2 = r * r;
    for (let i = 0; i < out.length; i++) out[i] = d[i] <= r2 ? 1 : 0;
    return out;
  }

  /**
   * Blend weights for a fill: 1 on the unknown pixels, falling off linearly over `feather` pixels outside them, 0 beyond.
   * Pixels where `protect` is set (optional) get 0 unless unknown. Returns Float32Array.
   */
  function featherWeights(unknown, w, h, feather, protect) {
    const a = new Float32Array(w * h);
    if (!(feather > 0)) { for (let i = 0; i < a.length; i++) a[i] = unknown[i] ? 1 : 0; return a; }
    const d = distanceSq(unknown, w, h); const f1 = feather + 1;
    for (let i = 0; i < a.length; i++) {
      if (unknown[i]) { a[i] = 1; continue; }
      if (protect && protect[i]) continue;
      const dist = Math.sqrt(d[i]);
      if (dist < f1) a[i] = 1 - dist / f1;
    }
    return a;
  }

  /** Connected parts (8-neighbour) of the mask: [{ x0, y0, x1, y1, n }]. */
  function components(mask, w, h) {
    const seen = new Uint8Array(w * h);
    const queue = new Int32Array(w * h);
    const out = [];
    for (let s = 0; s < mask.length; s++) {
      if (!mask[s] || seen[s]) continue;
      let head = 0; let tail = 0; queue[tail++] = s; seen[s] = 1;
      let x0 = w; let y0 = h; let x1 = -1; let y1 = -1; let n = 0;
      while (head < tail) {
        const p = queue[head++]; const x = p % w; const y = (p - x) / w; n++;
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy; if (yy < 0 || yy >= h) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx; if (xx < 0 || xx >= w) continue;
            const q = yy * w + xx;
            if (mask[q] && !seen[q]) { seen[q] = 1; queue[tail++] = q; }
          }
        }
      }
      out.push({ x0, y0, x1: x1 + 1, y1: y1 + 1, n });
    }
    return out;
  }

  /** Square-ish window (with surrounding context) that a removal of the pixels in `box` is computed on. */
  function removalWindow(box, W, H) {
    const bw = box.x1 - box.x0; const bh = box.y1 - box.y0;
    const side = Math.max(Math.round(Math.max(bw, bh) * 2 + 64), MODEL);
    const ww = Math.min(side, W); const wh = Math.min(side, H);
    const cx = (box.x0 + box.x1) / 2; const cy = (box.y0 + box.y1) / 2;
    const x = clamp(Math.round(cx - ww / 2), 0, W - ww); const y = clamp(Math.round(cy - wh / 2), 0, H - wh);
    return { x, y, w: ww, h: wh };
  }
  /** Feather width (full-resolution pixels) for a fill window: about 2 model pixels, at least 2. */
  const featherFor = (win) => Math.max(2, Math.round((Math.max(win.w, win.h) / MODEL) * 2));

  /**
   * Group the parts of a (grown) removal mask into jobs: parts whose windows overlap are filled together, far-apart parts each
   * get their own window (so a small speck in a corner does not force the whole photo through the model at low resolution).
   * Returns [{ box, win }] in image coordinates.
   */
  function removalJobs(parts, W, H) {
    let groups = parts.map((p) => ({ x0: p.x0, y0: p.y0, x1: p.x1, y1: p.y1 }));
    for (let changed = true; changed;) {
      changed = false;
      outer: for (let i = 0; i < groups.length; i++) for (let j = i + 1; j < groups.length; j++) {
        const a = rectToBox(removalWindow(groups[i], W, H)); const b = rectToBox(removalWindow(groups[j], W, H));
        if (boxesTouch(a, groups[j]) || boxesTouch(b, groups[i]) || (boxesTouch(a, b) && boxesTouch(growBox(groups[i], 48), growBox(groups[j], 48)))) {
          groups[i] = unionBox(groups[i], groups[j]); groups.splice(j, 1); changed = true; break outer;
        }
      }
    }
    groups = groups.sort((a, b) => (a.y0 - b.y0) || (a.x0 - b.x0));
    return groups.map((box) => ({ box, win: removalWindow(box, W, H) }));
  }

  // ---- resampling -----------------------------------------------------------------------------------------------------------
  function weights(srcN, dstN) {
    const scale = srcN / dstN; const support = Math.max(1, scale);
    const idx = []; const wts = [];
    for (let i = 0; i < dstN; i++) {
      const c = (i + 0.5) * scale - 0.5;
      const lo = Math.max(0, Math.floor(c - support) + 1); const hi = Math.min(srcN - 1, Math.ceil(c + support) - 1);
      const ii = []; const ww = []; let sum = 0;
      for (let s = lo; s <= hi; s++) { const wv = 1 - Math.abs(s - c) / support; if (wv > 0) { ii.push(s); ww.push(wv); sum += wv; } }
      if (!ii.length) { ii.push(clamp(Math.round(c), 0, srcN - 1)); ww.push(1); sum = 1; }
      idx.push(Int32Array.from(ii)); wts.push(Float32Array.from(ww.map((x) => x / sum)));
    }
    return { idx, wts };
  }
  /**
   * Resize an interleaved image (`ch` channels, any typed array) to dw x dh. Tent filter: bilinear when enlarging, an area
   * average when shrinking. Returns Float32Array (dw*dh*ch). `take` channels from the start of each pixel (default all).
   */
  function resample(src, sw, sh, ch, dw, dh, take = ch) {
    const H = weights(sw, dw); const V = weights(sh, dh);
    const tmp = new Float32Array(dw * sh * take);
    for (let y = 0; y < sh; y++) {
      const row = y * sw;
      for (let x = 0; x < dw; x++) {
        const ii = H.idx[x]; const ww = H.wts[x]; const o = (y * dw + x) * take;
        for (let c = 0; c < take; c++) { let acc = 0; for (let k = 0; k < ii.length; k++) acc += src[(row + ii[k]) * ch + c] * ww[k]; tmp[o + c] = acc; }
      }
    }
    const out = new Float32Array(dw * dh * take);
    for (let y = 0; y < dh; y++) {
      const ii = V.idx[y]; const ww = V.wts[y];
      for (let x = 0; x < dw; x++) {
        const o = (y * dw + x) * take;
        for (let c = 0; c < take; c++) { let acc = 0; for (let k = 0; k < ii.length; k++) acc += tmp[(ii[k] * dw + x) * take + c] * ww[k]; out[o + c] = acc; }
      }
    }
    return out;
  }

  // ---- filling with LaMa ----------------------------------------------------------------------------------------------------
  /**
   * Turn a window of the photo (RGBA, ww x wh) and its unknown pixels into LaMa's inputs. The window is scaled uniformly so its
   * longest side is 512; a shorter side is padded with a mirror image of the window, marked as known.
   * Unknown pixels (any low-resolution pixel that an unknown pixel touches) are zeroed, as the model expects.
   */
  function prepareFill(rgba, ww, wh, unknown) {
    const s = MODEL / Math.max(ww, wh);
    const cw = clamp(Math.round(ww * s), 1, MODEL); const chh = clamp(Math.round(wh * s), 1, MODEL);
    const small = resample(rgba, ww, wh, 4, cw, chh, 3);
    const um = resample(unknown, ww, wh, 1, cw, chh, 1);
    const N = MODEL * MODEL;
    const image = new Float32Array(3 * N); const mask = new Float32Array(N);
    const mirror = (i, n) => { if (n === 1) return 0; const p = 2 * n - 2; i %= p; if (i < 0) i += p; return i < n ? i : p - i; };
    for (let y = 0; y < MODEL; y++) {
      const sy = mirror(y, chh);
      for (let x = 0; x < MODEL; x++) {
        const sx = mirror(x, cw); const si = sy * cw + sx; const o = y * MODEL + x;
        const inside = x < cw && y < chh;
        const unk = um[si] > 1e-4;
        if (inside && unk) { mask[o] = 1; continue; }        // image stays 0 there
        if (!inside && unk) {                                // mirrored padding must not show the unknown content either:
          image[o] = small[si * 3] / 255; image[N + o] = small[si * 3 + 1] / 255; image[2 * N + o] = small[si * 3 + 2] / 255;
          mask[o] = 1; continue;                             // let the model fill it (it is thrown away)
        }
        image[o] = small[si * 3] / 255; image[N + o] = small[si * 3 + 1] / 255; image[2 * N + o] = small[si * 3 + 2] / 255;
      }
    }
    return { image, mask, cw, ch: chh, ww, wh };
  }

  /**
   * Blend LaMa's answer (Float32Array 3x512x512, values 0..255) back into the window. Only the unknown pixels and a feather
   * of `feather` pixels around them change; every other pixel of the window is returned bit-identical. Unknown pixels get
   * alpha 255. opts: { protect: known pixels the feather must not touch, grain: restore fine texture (see grainDetail), seed }.
   * Returns a new Uint8ClampedArray (RGBA).
   */
  function finishFill(output, prep, rgba, unknown, feather, opts = {}) {
    const { cw, ch, ww, wh } = prep; const N = MODEL * MODEL;
    const a = featherWeights(unknown, ww, wh, feather, opts.protect || null);
    const box = maskBox(a, ww, wh);                        // nonzero weights
    const out = new Uint8ClampedArray(rgba);
    if (!box) return out;
    // the model's answer for just the content area, enlarged to the window size
    const small = new Float32Array(cw * ch * 3);
    for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
      const o = y * MODEL + x; const t = (y * cw + x) * 3;
      small[t] = output[o]; small[t + 1] = output[N + o]; small[t + 2] = output[2 * N + o];
    }
    const big = resample(small, cw, ch, 3, ww, wh, 3);
    const detail = opts.grain ? grainDetail(rgba, ww, wh, unknown, cw, ch, opts.seed || 1, big) : null;
    for (let y = box.y0; y < box.y1; y++) for (let x = box.x0; x < box.x1; x++) {
      const i = y * ww + x; const k = a[i];
      if (k <= 0) continue;
      const p = i * 4; const q = i * 3;
      if (k >= 1) {
        if (detail) { out[p] = big[q] + detail[q]; out[p + 1] = big[q + 1] + detail[q + 1]; out[p + 2] = big[q + 2] + detail[q + 2]; }
        else { out[p] = big[q]; out[p + 1] = big[q + 1]; out[p + 2] = big[q + 2]; }
        out[p + 3] = 255;
      } else { out[p] = rgba[p] + (big[q] - rgba[p]) * k; out[p + 1] = rgba[p + 1] + (big[q + 1] - rgba[p + 1]) * k; out[p + 2] = rgba[p + 2] + (big[q + 2] - rgba[p + 2]) * k; }
    }
    return out;
  }

  /**
   * Grain: fine texture for the filled area. The model works at 512 x 512, so a large window comes back without the photo's
   * fine texture (grass blades, sand, film grain, sensor noise), and even at full scale LaMa's fill is smoother than the
   * photo. The "detail band" (picture minus a shrunk-and-enlarged copy of itself, shrunk by twice the model's scale and at
   * least 3x, as LaMa's answer is softer than its own 512 px grid) is measured on the fill and on the real pixels that may
   * be copied; only what the fill lacks is added (matching the local noise statistics). It is copied in overlapping blocks
   * (sized to the scale) from nearby real pixels of about the same colour, leaving out blocks on an edge (horizon, tree
   * line: their detail shows as dark scribbles elsewhere) and unusually busy ones, and the blocks are blended with sin^2
   * weights with the variance kept constant, so there are no block edges. Returns Float32Array (ww*wh*3), zero except on
   * unknown pixels, or null.
   */
  function grainDetail(rgba, ww, wh, unknown, cw, ch, seed, fill) {
    const f = Math.max(3, (2 * ww) / cw);
    const B = clamp(Math.round((f * 6) / 4) * 4, 12, 48); const stride = Math.max(4, B / 4);
    const sw = Math.max(2, Math.round(ww / f)); const sh = Math.max(2, Math.round(wh / f));
    const back = resample(resample(rgba, ww, wh, 4, sw, sh, 3), sw, sh, 3, ww, wh, 3);
    const fillBack = resample(resample(fill, ww, wh, 3, sw, sh, 3), sw, sh, 3, ww, wh, 3);
    const d = distanceSq(unknown, ww, wh);
    // how much detail the fill already has in the band
    let ef = 0; let nf = 0;
    for (let i = 0; i < ww * wh; i++) if (unknown[i]) { const q = i * 3; for (let c = 0; c < 3; c++) { const v = fill[q + c] - fillBack[q + c]; ef += v * v; } nf++; }
    if (!nf) return null;
    const W1 = ww + 1; const bad = new Int32Array(W1 * (wh + 1)); const en = new Float64Array(W1 * (wh + 1));
    for (let y = 0; y < wh; y++) {
      let rb = 0; let re = 0;
      for (let x = 0; x < ww; x++) {
        const i = y * ww + x;
        if (d[i] <= 16) rb++;
        else { const p = i * 4; const q = i * 3; for (let c = 0; c < 3; c++) { const v = rgba[p + c] - back[q + c]; re += v * v; } }
        bad[(y + 1) * W1 + x + 1] = bad[y * W1 + x + 1] + rb; en[(y + 1) * W1 + x + 1] = en[y * W1 + x + 1] + re;
      }
    }
    const sum = (A, x, y) => A[(y + B) * W1 + x + B] - A[y * W1 + x + B] - A[(y + B) * W1 + x] + A[y * W1 + x];
    const meanOf = (src, x, y) => { const m = [0, 0, 0]; let n = 0; for (let yy = y; yy < y + B; yy += 4) for (let xx = x; xx < x + B; xx += 4) { const q = (yy * ww + xx) * 3; m[0] += src[q]; m[1] += src[q + 1]; m[2] += src[q + 2]; n++; } return [m[0] / n, m[1] / n, m[2] / n]; };
    let cands = [];
    // how much the smooth picture changes across a block (an edge: horizon, tree line, the border of an object)
    const lumaAt = (x, y) => { const q = (y * ww + x) * 3; return back[q] + back[q + 1] + back[q + 2]; };
    const slope = (x, y) => { const q = B >> 2; const v = [lumaAt(x + q, y + q), lumaAt(x + 3 * q, y + q), lumaAt(x + q, y + 3 * q), lumaAt(x + 3 * q, y + 3 * q)]; return Math.max(...v) - Math.min(...v); };
    for (let y = 0; y + B <= wh; y += stride) for (let x = 0; x + B <= ww; x += stride) if (!sum(bad, x, y)) cands.push({ x, y, e: sum(en, x, y), m: meanOf(back, x, y), r: slope(x, y) });
    if (cands.length < 4) return null;
    // blocks on an edge carry the edge's own detail (dark scribbles when copied into foliage or sky): leave them out
    const rs = cands.map((c) => c.r).sort((a, b) => a - b); const rMax = Math.max(15, rs[Math.floor(rs.length / 2)] * 2.5);
    const eSorted = cands.map((c) => c.e).sort((a, b) => a - b); const eMax = eSorted[Math.floor(eSorted.length * 0.9)];
    cands = cands.filter((c) => c.r <= rMax && c.e <= eMax);
    if (cands.length < 4) return null;
    // only the detail the fill lacks is added: measured against the blocks that may be copied
    let eKept = 0; for (const c of cands) eKept += c.e; eKept /= cands.length * B * B;
    const gain = Math.sqrt(Math.max(0, 1 - (ef / nf) / Math.max(1e-6, eKept)));
    if (gain < 0.05) return null;
    const CELL = 64; const gw = Math.ceil(ww / CELL); const gh = Math.ceil(wh / CELL); const maxRing = Math.max(gw, gh);
    const grid = Array.from({ length: gw * gh }, () => []);
    for (const c of cands) grid[Math.min(gh - 1, Math.floor((c.y + B / 2) / CELL)) * gw + Math.min(gw - 1, Math.floor((c.x + B / 2) / CELL))].push(c);
    let s = (seed >>> 0) || 1; const rand = () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
    const acc = new Float32Array(ww * wh * 3); const accW = new Float32Array(ww * wh);
    const wt = new Float32Array(B); for (let i = 0; i < B; i++) wt[i] = Math.sin((Math.PI * (i + 0.5)) / B) ** 2;
    const ub = maskBox(unknown, ww, wh); if (!ub) return null;
    const h2 = B / 2;
    for (let by = ub.y0 - h2; by < ub.y1; by += h2) for (let bx = ub.x0 - h2; bx < ub.x1; bx += h2) {
      // does this block touch the hole?
      let touches = false;
      for (let y = Math.max(0, by); y < Math.min(wh, by + B) && !touches; y += 2) for (let x = Math.max(0, bx); x < Math.min(ww, bx + B); x += 2) if (unknown[y * ww + x]) { touches = true; break; }
      if (!touches) continue;
      const cx = bx + h2; const cy = by + h2;
      const tm = meanOf(fill, clamp(bx, 0, ww - B), clamp(by, 0, wh - B));
      const tcx = clamp(Math.floor(cx / CELL), 0, gw - 1); const tcy = clamp(Math.floor(cy / CELL), 0, gh - 1);
      let near = []; let firstSeen = -1;
      for (let ring = 0; ring <= maxRing && near.length < 16 && (firstSeen < 0 || ring <= firstSeen + 2); ring++) {
        for (let gy = tcy - ring; gy <= tcy + ring; gy++) for (let gx = tcx - ring; gx <= tcx + ring; gx++) {
          if (Math.max(Math.abs(gx - tcx), Math.abs(gy - tcy)) !== ring || gx < 0 || gy < 0 || gx >= gw || gy >= gh) continue;
          const cell = grid[gy * gw + gx];
          if (cell.length && firstSeen < 0) firstSeen = ring;
          for (const c of cell) {
            if (Math.abs(c.m[0] - tm[0]) + Math.abs(c.m[1] - tm[1]) + Math.abs(c.m[2] - tm[2]) > 36) continue;
            near.push({ c, dd: (c.x + h2 - cx) ** 2 + (c.y + h2 - cy) ** 2 });
          }
        }
      }
      if (!near.length) continue;
      near = near.sort((p, q) => p.dd - q.dd).slice(0, 16);
      const med = near.map((n) => n.c.e).sort((p, q) => p - q)[Math.floor(near.length / 2)];
      const pool = near.filter((n) => n.c.e <= med * 2.5);
      const src = (pool.length ? pool : near)[Math.floor(rand() * (pool.length || near.length))].c;
      for (let y = 0; y < B; y++) {
        const ty = by + y; if (ty < 0 || ty >= wh) continue;
        for (let x = 0; x < B; x++) {
          const tx = bx + x; if (tx < 0 || tx >= ww) continue;
          const i = ty * ww + tx; if (!unknown[i]) continue;
          const j = (src.y + y) * ww + src.x + x; const p = j * 4; const q = j * 3; const o = i * 3;
          // per pixel: only where the source's smooth colour matches the fill's (no texture across a horizon or an edge)
          if (Math.abs(back[q] - fill[o]) + Math.abs(back[q + 1] - fill[o + 1]) + Math.abs(back[q + 2] - fill[o + 2]) > 30) continue;
          const w = wt[y] * wt[x];
          acc[o] += (rgba[p] - back[q]) * w; acc[o + 1] += (rgba[p + 1] - back[q + 1]) * w; acc[o + 2] += (rgba[p + 2] - back[q + 2]) * w;
          accW[i] += w * w;
        }
      }
    }
    for (let i = 0; i < ww * wh; i++) {
      if (!accW[i]) continue;
      const k = gain / Math.sqrt(accW[i]); const o = i * 3;
      acc[o] *= k; acc[o + 1] *= k; acc[o + 2] *= k;
    }
    return acc;
  }

  /**
   * Gradient-domain correction of the model's answer, in its 512 x 512 space (this replaces a simple tone match: the model
   * passes known pixels through unchanged, so comparing it with them measures nothing). LaMa's fill of a large hole often
   * comes out a shade darker or greyer than the picture around it, which shows as a seam or a patch. Here:
   *  1. along the hole's border, the local offset between the real pixels just outside (a band of `band` px) and the fill
   *     just inside is measured (box averages of radius `R`, so texture noise cancels);
   *  2. that offset is spread over the whole hole as a membrane (Laplace equation: smooth, no corners or box shapes, exactly
   *     the measured offset at the border), solved coarse-to-fine;
   *  3. it is added to the fill. The fill keeps its own gradients and texture; only its overall level is bent to meet the
   *     photo, as in Poisson image editing. Known pixels are not touched.
   * Modifies and returns `output` (3 x 512 x 512, values 0..255).
   */
  function harmonize(prep, output, R = 6, band = 4) {
    const N = MODEL; const NN = N * N; const U = prep.mask; const img = prep.image;
    const known = new Uint8Array(NN); for (let i = 0; i < NN; i++) known[i] = U[i] ? 0 : 1;
    const dU = distanceSq(U, N, N); const dK = distanceSq(known, N, N);
    // integral images: known band (photo) and unknown band (fill), 3 channels + count each
    const W1 = N + 1; const IK = new Float64Array(W1 * W1 * 4); const IU = new Float64Array(W1 * W1 * 4);
    const b2 = band * band;
    for (let y = 0; y < N; y++) {
      const rk = [0, 0, 0, 0]; const ru = [0, 0, 0, 0];
      for (let x = 0; x < N; x++) {
        const i = y * N + x;
        if (known[i] && dU[i] <= b2) { rk[0] += img[i] * 255; rk[1] += img[NN + i] * 255; rk[2] += img[2 * NN + i] * 255; rk[3]++; }
        if (!known[i] && dK[i] <= b2) { ru[0] += output[i]; ru[1] += output[NN + i]; ru[2] += output[2 * NN + i]; ru[3]++; }
        const o = ((y + 1) * W1 + x + 1) * 4; const u = (y * W1 + x + 1) * 4;
        for (let c = 0; c < 4; c++) { IK[o + c] = IK[u + c] + rk[c]; IU[o + c] = IU[u + c] + ru[c]; }
      }
    }
    const boxSum = (I, x0, y0, x1, y1, c) => I[(y1 * W1 + x1) * 4 + c] - I[(y0 * W1 + x1) * 4 + c] - I[(y1 * W1 + x0) * 4 + c] + I[(y0 * W1 + x0) * 4 + c];
    // fixed values on the hole's border pixels (unknown, next to a known one)
    const fixed = new Uint8Array(NN); const val = [new Float32Array(NN), new Float32Array(NN), new Float32Array(NN)];
    let any = false;
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      const i = y * N + x; if (known[i] || dK[i] > 1) continue;
      let r = R; let nk = 0; let nu = 0; let x0; let y0; let x1; let y1;
      for (; r <= R * 4; r *= 2) {
        x0 = Math.max(0, x - r); y0 = Math.max(0, y - r); x1 = Math.min(N, x + r + 1); y1 = Math.min(N, y + r + 1);
        nk = boxSum(IK, x0, y0, x1, y1, 3); nu = boxSum(IU, x0, y0, x1, y1, 3);
        if (nk >= 6 && nu >= 6) break;
      }
      if (nk < 1 || nu < 1) continue;
      fixed[i] = 1; any = true;
      for (let c = 0; c < 3; c++) val[c][i] = boxSum(IK, x0, y0, x1, y1, c) / nk - boxSum(IU, x0, y0, x1, y1, c) / nu;
    }
    if (!any) return output;
    // solve Laplace(c) = 0 on the unknown pixels with the border values fixed: coarse-to-fine Gauss-Seidel
    const solve = (fx, vals, U0, n, iters) => {
      for (let it = 0; it < iters; it++) for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
        const i = y * n + x; if (!U0[i] || fx[i]) continue;
        let s0 = 0; let s1 = 0; let s2 = 0; let k = 0;
        const nb = (j) => { if (U0[j]) { s0 += vals[0][j]; s1 += vals[1][j]; s2 += vals[2][j]; k++; } };
        if (x > 0) nb(i - 1); if (x < n - 1) nb(i + 1); if (y > 0) nb(i - n); if (y < n - 1) nb(i + n);
        if (k) { vals[0][i] = s0 / k; vals[1][i] = s1 / k; vals[2][i] = s2 / k; }
      }
    };
    // pyramid: shrink the unknown area, fixed pixels and their values
    const levels = [{ n: N, U: U, fx: fixed, v: val }];
    while (levels[levels.length - 1].n > 32) {
      const p = levels[levels.length - 1]; const n = p.n / 2;
      const U2 = new Uint8Array(n * n); const f2 = new Uint8Array(n * n); const v2 = [new Float32Array(n * n), new Float32Array(n * n), new Float32Array(n * n)];
      for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
        let cu = 0; let cf = 0; const acc = [0, 0, 0];
        for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
          const j = (2 * y + dy) * p.n + 2 * x + dx;
          if (p.U[j]) cu++;
          if (p.fx[j]) { cf++; acc[0] += p.v[0][j]; acc[1] += p.v[1][j]; acc[2] += p.v[2][j]; }
        }
        const i = y * n + x; U2[i] = cu ? 1 : 0;
        if (cf) { f2[i] = 1; for (let c = 0; c < 3; c++) v2[c][i] = acc[c] / cf; }
      }
      levels.push({ n, U: U2, fx: f2, v: v2 });
    }
    for (let l = levels.length - 1; l >= 0; l--) {
      const L = levels[l];
      if (l < levels.length - 1) {                                   // start from the coarser solution
        const C2 = levels[l + 1];
        for (let y = 0; y < L.n; y++) for (let x = 0; x < L.n; x++) {
          const i = y * L.n + x; if (!L.U[i] || L.fx[i]) continue;
          const j = (y >> 1) * C2.n + (x >> 1);
          for (let c = 0; c < 3; c++) L.v[c][i] = C2.v[c][j];
        }
      }
      solve(L.fx, L.v, L.U, L.n, l === levels.length - 1 ? 200 : 40);
    }
    for (let i = 0; i < NN; i++) if (U[i]) for (let c = 0; c < 3; c++) output[c * NN + i] += clamp(val[c][i], -80, 80);
    return output;
  }

  /**
   * Outpainting help. LaMa washes out an unknown area that touches the edge of its input: towards the border its fill turns
   * grey, low in contrast and saturation (measured on a park photo: half the photo's contrast and saturation in the outer
   * half of the strip), which is the "hazy strip" look. So an extension window is padded on its open side with real picture,
   * reflected about the inner edge of the new strip, with an unknown gap in between:
   *     [ reflection (known) | gap (unknown, thrown away) | new strip (unknown) | photo ]
   * The hole no longer touches the border, and because of the gap the model does not simply mirror the picture into the strip
   * (lines that run into the edge would come back as a "V") or cross-fade the photo with its reflection (a ghost image), as a
   * plain mirror does. pads / skip / gaps: { l, t, r, b } in pixels: padding, depth of the new strip on that side, gap.
   * The padding is limited to the known pixels the window has beyond the strip. Returns { rgba, unknown, w, h, l, t }.
   */
  function mirrorPad(rgba, w, h, unknown, pads, skip = {}, gaps = {}) {
    const S = { l: skip.l || 0, r: skip.r || 0, t: skip.t || 0, b: skip.b || 0 };
    const G = { l: gaps.l || 0, r: gaps.r || 0, t: gaps.t || 0, b: gaps.b || 0 };
    const P = { l: Math.max(0, Math.min(pads.l || 0, w - S.l)), r: Math.max(0, Math.min(pads.r || 0, w - S.r)), t: Math.max(0, Math.min(pads.t || 0, h - S.t)), b: Math.max(0, Math.min(pads.b || 0, h - S.b)) };
    for (const k of ['l', 'r', 't', 'b']) if (!P[k]) G[k] = 0;
    const l = P.l + G.l; const r = P.r + G.r; const t = P.t + G.t; const b = P.b + G.b;
    const W2 = w + l + r; const H2 = h + t + b;
    const out = new Uint8ClampedArray(W2 * H2 * 4); const unk = new Uint8Array(W2 * H2);
    // source index for padded index i on an axis of n pixels; -1 = in a gap (unknown)
    const map = (i, n, lo, hi) => {
      if (i < 0) { const k = -i - lo.g; return k <= 0 ? -1 : Math.min(n - 1, lo.s + k - 1); }
      if (i >= n) { const k = i - n + 1 - hi.g; return k <= 0 ? -1 : Math.max(0, n - 1 - hi.s - (k - 1)); }
      return i;
    };
    const xs = new Int32Array(W2); for (let x = 0; x < W2; x++) xs[x] = map(x - l, w, { s: S.l, g: G.l }, { s: S.r, g: G.r });
    for (let y = 0; y < H2; y++) {
      const sy = map(y - t, h, { s: S.t, g: G.t }, { s: S.b, g: G.b });
      for (let x = 0; x < W2; x++) {
        const di = y * W2 + x; const sx = xs[x];
        out[di * 4 + 3] = 255;
        if (sy < 0 || sx < 0) { unk[di] = 1; continue; }
        const si = sy * w + sx;
        out[di * 4] = rgba[si * 4]; out[di * 4 + 1] = rgba[si * 4 + 1]; out[di * 4 + 2] = rgba[si * 4 + 2];
        unk[di] = unknown[si] ? 1 : 0;
      }
    }
    return { rgba: out, unknown: unk, w: W2, h: H2, l, t };
  }
  /** The window back out of a padded result. */
  function unpad(rgba, W2, l, t, w, h) { return getRect(rgba, W2, 4, { x: l, y: t, w, h }); }

  // ---- selection (Segment Anything) -----------------------------------------------------------------------------------------
  /** Size the photo is shrunk to for the image encoder: longest side 1024. */
  function samSize(W, H) { const s = SAM / Math.max(W, H); return { w: Math.max(1, Math.round(W * s)), h: Math.max(1, Math.round(H * s)), s }; }

  /**
   * Enlarge the decoder's mask logits (mw x mh, values > 0 mean "inside") to a W x H 0/1 mask with bilinear interpolation of
   * the logits, so the outline is smooth rather than blocky. Optionally only for box `within` (other pixels stay 0).
   */
  function logitsToMask(logits, mw, mh, W, H, within) {
    const out = new Uint8Array(W * H);
    const b = within || { x0: 0, y0: 0, x1: W, y1: H };
    const sx = mw / W; const sy = mh / H;
    for (let y = b.y0; y < b.y1; y++) {
      const fy = clamp((y + 0.5) * sy - 0.5, 0, mh - 1); const y0 = Math.floor(fy); const y1 = Math.min(mh - 1, y0 + 1); const ty = fy - y0;
      const r0 = y0 * mw; const r1 = y1 * mw;
      for (let x = b.x0; x < b.x1; x++) {
        const fx = clamp((x + 0.5) * sx - 0.5, 0, mw - 1); const x0 = Math.floor(fx); const x1 = Math.min(mw - 1, x0 + 1); const tx = fx - x0;
        const top = logits[r0 + x0] + (logits[r0 + x1] - logits[r0 + x0]) * tx;
        const bot = logits[r1 + x0] + (logits[r1 + x1] - logits[r1 + x0]) * tx;
        if (top + (bot - top) * ty > 0) out[y * W + x] = 1;
      }
    }
    return out;
  }

  /**
   * Which of the decoder's 4 masks to use. With more than one tap: the single-answer mask 0 (SAM's own advice). With a single
   * positive tap, SAM offers three nested answers (part / object / object plus surroundings). For removing things the whole
   * object is what people mean, so among the answers scored within 0.08 of the best, the largest one wins, unless it covers
   * more than a quarter of the photo (then it is usually the background).
   * scores: 4 predicted IoUs; areas: 4 pixel counts; total: pixels in the mask.
   */
  function pickSamMask(scores, labels, areas, total) {
    if (!(labels.length === 1 && labels[0] === 1)) return 0;
    let best = 1; for (let i = 2; i < 4; i++) if (scores[i] > scores[best]) best = i;
    if (!areas) return best;
    let pick = best;
    for (let i = 1; i < 4; i++) {
      if (scores[i] < scores[best] - 0.08 || areas[i] > total * 0.25 || areas[i] === 0) continue;
      if (areas[i] > areas[pick]) pick = i;
    }
    return pick;
  }

  // ---- extending ------------------------------------------------------------------------------------------------------------
  const PRESETS = Object.freeze({ free: null, '1:1': 1, '4:5': 4 / 5, '3:2': 3 / 2, '16:9': 16 / 9, '9:16': 9 / 16 });

  /** Keep margins non-negative integers and the result within the size limits (3x each side, MAX_PIXELS, MAX_SIDE). */
  function clampMargins(W, H, m) {
    const r = { l: Math.max(0, Math.round(m.l || 0)), t: Math.max(0, Math.round(m.t || 0)), r: Math.max(0, Math.round(m.r || 0)), b: Math.max(0, Math.round(m.b || 0)) };
    const maxW = Math.min(W * 3, MAX_SIDE); const maxH = Math.min(H * 3, MAX_SIDE);
    const fit = (a, b, room) => { const tot = a + b; if (tot <= room) return [a, b]; const k = room / tot; const na = Math.min(a, Math.round(a * k)); return [na, Math.max(0, Math.min(b, room - na))]; };
    [r.l, r.r] = fit(r.l, r.r, Math.max(0, maxW - W));
    [r.t, r.b] = fit(r.t, r.b, Math.max(0, maxH - H));
    for (let i = 0; i < 40 && (W + r.l + r.r) * (H + r.t + r.b) > MAX_PIXELS; i++) { r.l = Math.floor(r.l * 0.9); r.r = Math.floor(r.r * 0.9); r.t = Math.floor(r.t * 0.9); r.b = Math.floor(r.b * 0.9); }
    return r;
  }

  /**
   * Margins (pixels added on the left, top, right and bottom) for an aspect preset, centred. `amount` 0..1 additionally
   * zooms out: 0 adds only what the aspect needs, 1 makes the new frame twice as large again (on the same aspect).
   * For 'free', amount adds the same share on every side (amount 1 = twice the width and height).
   */
  function presetMargins(W, H, preset, amount = 0) {
    const ratio = PRESETS[preset];
    let NW; let NH;
    if (ratio == null) { NW = W * (1 + amount); NH = H * (1 + amount); }
    else {
      if (W / H < ratio) { NW = H * ratio; NH = H; } else { NW = W; NH = W / ratio; }
      NW *= 1 + amount; NH *= 1 + amount;
    }
    NW = Math.max(W, Math.round(NW)); NH = Math.max(H, Math.round(NH));
    const l = Math.floor((NW - W) / 2); const t = Math.floor((NH - H) / 2);
    return clampMargins(W, H, { l, t, r: NW - W - l, b: NH - H - t });
  }

  /** Tile size (full-resolution pixels) used to extend a W x H photo: half the long side, between 512 and 2048. */
  const extendTile = (W, H) => clamp(Math.round(Math.max(W, H) * 0.5), MODEL, 2048);

  /**
   * The outward plan for extending a W x H photo by margins m. The new canvas is FW x FH with the photo at (m.l, m.t).
   * The known area grows one strip at a time (left, right, top, bottom, repeated); a strip is at most ~45% of a tile deep
   * and at most 80% of the known area's own size, so every tile keeps plenty of real picture as context. Each strip is
   * covered by overlapping tiles, filled one after another (each later tile sees the earlier ones' result as known).
   * Every tile window lies inside (known area + its strip), so a window never contains pixels from a later step. Across the
   * strip a window is at most a tile deep; along it, it is as long as the window plus its padding is deep (about square for the
   * model, so e.g. 16:9 from a 12 MP photo is one tall window per side).
   * Returns { FW, FH, ox, oy, tile, feather, steps: [{ side, strip: box, tiles: [{ x, y, w, h, pads, skip, gaps }] }], count }.
   */
  function extendPlan(W, H, margins) {
    const m = clampMargins(W, H, margins);
    const FW = W + m.l + m.r; const FH = H + m.t + m.b;
    const L = extendTile(W, H);
    const K = { x0: m.l, y0: m.t, x1: m.l + W, y1: m.t + H };
    const rem = { l: m.l, r: m.r, t: m.t, b: m.b };
    const steps = [];
    const along = (lo, hi, size) => {                      // tile starts covering [lo, hi) with windows of `size`
      const span = hi - lo;
      if (span <= size) return [lo + Math.floor((span - size) / 2)];
      const n = Math.ceil((span - size) / (size * 0.75)) + 1;
      const out = [];
      for (let i = 0; i < n; i++) out.push(Math.round(lo + ((span - size) * i) / (n - 1)));
      return out;
    };
    let guard = 0;
    while ((rem.l || rem.r || rem.t || rem.b) && guard++ < 1000) {
      for (const side of ['l', 'r', 't', 'b']) {
        if (!rem[side]) continue;
        const horiz = side === 'l' || side === 'r';
        const kSize = horiz ? K.x1 - K.x0 : K.y1 - K.y0;
        const d = Math.max(1, Math.min(rem[side], Math.floor(L * 0.45), Math.floor(kSize * 0.8)));
        let strip; let R;
        if (side === 'l') { strip = { x0: K.x0 - d, y0: K.y0, x1: K.x0, y1: K.y1 }; R = { ...K, x0: K.x0 - d }; }
        if (side === 'r') { strip = { x0: K.x1, y0: K.y0, x1: K.x1 + d, y1: K.y1 }; R = { ...K, x1: K.x1 + d }; }
        if (side === 't') { strip = { x0: K.x0, y0: K.y0 - d, x1: K.x1, y1: K.y0 }; R = { ...K, y0: K.y0 - d }; }
        if (side === 'b') { strip = { x0: K.x0, y0: K.y1, x1: K.x1, y1: K.y1 + d }; R = { ...K, y1: K.y1 + d }; }
        const rw = R.x1 - R.x0; const rh = R.y1 - R.y0;
        const tiles = [];
        // padding on the open side: real picture reflected about the strip's inner edge, behind an unknown gap (see mirrorPad).
        // The window is made about square including the padding, so the model input needs no further (upside-down) padding.
        const across = Math.min(L, horiz ? rw : rh);
        const pad = Math.max(0, Math.min(Math.round(d * 1.2), across - d)); const gap = pad ? Math.round(d * 0.5) : 0;
        const alongSize = Math.min(horiz ? rh : rw, Math.max(L, across + pad + gap));
        const ww = horiz ? across : alongSize; const wh = horiz ? alongSize : across;
        const z = { l: 0, t: 0, r: 0, b: 0 };
        const pads = { ...z, [side]: pad }; const skip = { ...z, [side]: d }; const gaps = { ...z, [side]: gap };
        if (horiz) {
          const x = side === 'l' ? R.x0 : R.x1 - ww;
          for (const y of along(R.y0, R.y1, wh)) tiles.push({ x, y: clamp(y, R.y0, R.y1 - wh), w: ww, h: wh, pads, skip, gaps });
        } else {
          const y = side === 't' ? R.y0 : R.y1 - wh;
          for (const x of along(R.x0, R.x1, ww)) tiles.push({ x: clamp(x, R.x0, R.x1 - ww), y, w: ww, h: wh, pads, skip, gaps });
        }
        steps.push({ side, strip, tiles });
        Object.assign(K, R);
        rem[side] -= d;
      }
    }
    return { FW, FH, ox: m.l, oy: m.t, margins: m, tile: L, feather: Math.max(3, Math.round(L / 256)), steps, count: steps.reduce((n, s) => n + s.tiles.length, 0) };
  }

  /**
   * One fill: the whole pixel pipeline around the model, shared by the model worker, the self-test and the tests.
   * req: { rgba, w, h, unknown, feather, pads?, skip?, gaps?, seed? }; model(image, mask) -> Promise<Float32Array 3x512x512,
   * values 0..255>. Returns a new Uint8ClampedArray (RGBA, w x h): pixels away from the unknown ones are bit-identical.
   */
  async function fillWindow(req, model) {
    let rgba = req.rgba; let unknown = req.unknown; let w = req.w; let h = req.h; let padded = null;
    const p = req.pads;
    if (p && (p.l || p.t || p.r || p.b)) {
      padded = mirrorPad(rgba, w, h, unknown, p, req.skip || {}, req.gaps || {});
      rgba = padded.rgba; unknown = padded.unknown; w = padded.w; h = padded.h;
    }
    const prep = prepareFill(rgba, w, h, unknown);
    const answer = harmonize(prep, Float32Array.from(await model(prep.image, prep.mask)));
    let done = finishFill(answer, prep, rgba, unknown, req.feather, { grain: true, seed: req.seed || (req.w * 31 + req.h) });
    if (padded) done = unpad(done, w, padded.l, padded.t, req.w, req.h);
    return done;
  }

  // ---- running a removal or an extension -----------------------------------------------------------------------------------
  // The window, the self-test and the tests all run edits through these two functions, with `fill` doing the model call:
  //   fill({ kind: 'remove' | 'extend', rgba, w, h, unknown, feather, pads }) -> Promise<Uint8ClampedArray | null (cancelled)>
  // hooks: { onStep(index, count, rect), onUpdate(box) } - both may be async (the window redraws there).

  /**
   * Remove the selected pixels of a W x H RGBA picture, in place. The selection is grown by `grow` pixels, split into far-apart
   * groups, and each group is filled in its own window. Returns { patches: [{ rect, before, after }], cancelled }; on cancel the
   * picture is put back as it was.
   */
  async function runRemoval(rgba, W, H, mask, grow, fill, hooks = {}) {
    const box = maskBox(mask, W, H);
    if (!box) return { patches: [], cancelled: false };
    const region = clipBox(growBox(box, grow + 2), W, H); const rr = boxToRect(region);
    const grown = dilate(getRect(mask, W, 1, rr), rr.w, rr.h, grow);
    const unknown = new Uint8Array(W * H); putRect(unknown, W, 1, rr, grown);
    const parts = components(grown, rr.w, rr.h).map((p) => ({ x0: p.x0 + rr.x, y0: p.y0 + rr.y, x1: p.x1 + rr.x, y1: p.y1 + rr.y }));
    const jobs = removalJobs(parts, W, H);
    const patches = [];
    const undo = () => { for (const p of patches.slice().reverse()) putRect(rgba, W, 4, p.rect, p.before); };
    try {
      for (let i = 0; i < jobs.length; i++) {
        const win = jobs[i].win;
        const unk = getRect(unknown, W, 1, win);
        if (!maskCount(unk)) continue;
        if (hooks.onStep) await hooks.onStep(i, jobs.length, win);
        const before = getRect(rgba, W, 4, win);
        const out = await fill({ kind: 'remove', rgba: before.slice(), w: win.w, h: win.h, unknown: unk, feather: featherFor(win), pads: null });
        if (!out) { undo(); return { patches: [], cancelled: true }; }
        putRect(rgba, W, 4, win, out);
        putRect(unknown, W, 1, win, new Uint8Array(win.w * win.h));
        const d = diffBox(before, out, win.w, win.h, 4);          // keep only the part that really changed
        if (d) {
          const rect = { x: win.x + d.x0, y: win.y + d.y0, w: d.x1 - d.x0, h: d.y1 - d.y0 };
          patches.push({ rect, before: getRect(before, win.w, 4, { x: d.x0, y: d.y0, w: rect.w, h: rect.h }), after: getRect(rgba, W, 4, rect) });
        }
        if (hooks.onUpdate) await hooks.onUpdate(rectToBox(win));
      }
    } catch (e) { undo(); throw e; }
    return { patches, cancelled: false };
  }

  /**
   * Extend a W x H RGBA picture by margins (see extendPlan). Returns { rgba, w, h, plan, cancelled }. The new area starts as
   * the nearest edge colour (only seen while the fill runs). hooks.onStart(rgba, w, h) lets the window show the new canvas.
   */
  async function runExtension(src, W, H, margins, fill, hooks = {}) {
    const plan = extendPlan(W, H, margins);
    const { FW, FH } = plan;
    const rgba = new Uint8ClampedArray(FW * FH * 4); const pending = new Uint8Array(FW * FH).fill(1);
    for (let y = 0; y < FH; y++) {
      const sy = clamp(y - plan.oy, 0, H - 1);
      for (let x = 0; x < FW; x++) {
        const sx = clamp(x - plan.ox, 0, W - 1); const si = (sy * W + sx) * 4; const o = (y * FW + x) * 4;
        rgba[o] = src[si]; rgba[o + 1] = src[si + 1]; rgba[o + 2] = src[si + 2]; rgba[o + 3] = src[si + 3];
      }
    }
    for (let y = 0; y < H; y++) pending.fill(0, (y + plan.oy) * FW + plan.ox, (y + plan.oy) * FW + plan.ox + W);
    if (hooks.onStart) await hooks.onStart(rgba, FW, FH);
    let k = 0;
    for (const step of plan.steps) {
      for (const t of step.tiles) {
        if (hooks.onStep) await hooks.onStep(k, plan.count, t);
        k++;
        const unk = getRect(pending, FW, 1, t);
        if (!maskCount(unk)) continue;
        const out = await fill({ kind: 'extend', rgba: getRect(rgba, FW, 4, t), w: t.w, h: t.h, unknown: unk, feather: plan.feather, pads: t.pads, skip: t.skip, gaps: t.gaps });
        if (!out) return { rgba: null, w: FW, h: FH, plan, cancelled: true };
        putRect(rgba, FW, 4, t, out); putRect(pending, FW, 1, t, new Uint8Array(t.w * t.h));
        if (hooks.onUpdate) await hooks.onUpdate(rectToBox(t));
      }
    }
    return { rgba, w: FW, h: FH, plan, cancelled: false };
  }

  // ---- formats and names ----------------------------------------------------------------------------------------------------
  const OPEN_EXTS = ['.jpg', '.jpeg', '.png', '.webp', '.avif', '.bmp', '.gif'];
  const extOf = (p) => { const m = /\.[^./\\]+$/.exec(String(p)); return m ? m[0].toLowerCase() : ''; };
  const isOpenable = (p) => OPEN_EXTS.includes(extOf(p));
  const FORMATS = Object.freeze({
    jpeg: { label: 'JPEG', ext: '.jpg', mime: 'image/jpeg', quality: true },
    png: { label: 'PNG', ext: '.png', mime: 'image/png', quality: false },
    webp: { label: 'WebP', ext: '.webp', mime: 'image/webp', quality: true },
  });
  /** Which format a file is, from its first bytes. */
  function sniff(b) {
    if (!b || b.length < 12) return null;
    if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
    if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'png';
    if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'webp';
    if (b[0] === 0x42 && b[1] === 0x4d) return 'bmp';
    if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'gif';
    if (b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) {
      const brand = String.fromCharCode(b[8], b[9], b[10], b[11]);
      if (/^(avif|avis)$/.test(brand)) return 'avif';
      if (/^(heic|heix|hevc|hevx|heim|heis|mif1|msf1)$/.test(brand)) return 'heic';
    }
    return null;
  }
  /** The format to save in by default: the original's when we can write it, otherwise PNG. */
  const defaultFormat = (fmt) => (FORMATS[fmt] ? fmt : 'png');
  function defaultName(name, fmt) {
    const base = String(name).replace(/\.[^.]+$/, '') || 'photo';
    return `${base} (cleaned)${FORMATS[fmt].ext}`;
  }
  function formatBytes(n) {
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(0) + ' KB';
    return (n / 1048576).toFixed(n < 10485760 ? 1 : 0) + ' MB';
  }
  /**
   * Default "grow selection" amount for a photo: 1/150 of its long side, 4..40 px. Segment Anything's mask comes from 256 x 256
   * logits, so its outline is only good to about one logit pixel (long side / 256), and the object's soft edge (fur, motion
   * blur, anti-aliasing) lies outside it. Any such rim left in the photo is continued by LaMa as a structure and redraws the
   * object's silhouette (measured on a dog on grass: clearly visible at 3 px on a 1200 px photo, gone at 8 px).
   */
  const defaultGrow = (W, H) => clamp(Math.round(Math.max(W, H) / 150), 4, 40);

  /** Fast 32-bit FNV-1a hash of a byte array (used by tests to compare pictures). */
  function hash(bytes, step = 1) { let h = 0x811c9dc5; for (let i = 0; i < bytes.length; i += step) { h ^= bytes[i]; h = Math.imul(h, 0x01000193); } return (h >>> 0).toString(16); }

  return {
    MODEL, SAM, MAX_PIXELS, MAX_SIDE, MAX_FILE_BYTES, UserError, clamp,
    boxToRect, rectToBox, unionBox, clipBox, growBox, boxesTouch, getRect, putRect,
    maskBox, maskCount, diffBox, paintLine, distanceSq, dilate, featherWeights, components, removalWindow, featherFor, removalJobs,
    resample, prepareFill, finishFill, grainDetail, harmonize, mirrorPad, unpad, fillWindow,
    samSize, logitsToMask, pickSamMask,
    PRESETS, clampMargins, presetMargins, extendTile, extendPlan, runRemoval, runExtension,
    OPEN_EXTS, extOf, isOpenable, FORMATS, sniff, defaultFormat, defaultName, formatBytes, defaultGrow, hash,
  };
}));
