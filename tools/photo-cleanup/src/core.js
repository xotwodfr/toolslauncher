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
    const detail = opts.grain && ww / cw > 1.25 ? grainDetail(rgba, ww, wh, unknown, cw, ch, opts.seed || 1, big) : null;
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
   * Grain for a fill computed at reduced resolution. The model works at 512 x 512, so a large window comes back without the
   * fine texture of the photo (sand, grass, film grain, sensor noise) and the filled area looks smooth and blurry. The detail
   * that the shrinking throws away (photo minus its shrunk-and-enlarged copy) is measured on the known pixels, and blocks of
   * it are copied onto the unknown pixels from nearby known places (of the 16 nearest, the calmer two thirds, so edges and
   * objects are not copied).
   * Returns Float32Array (ww*wh*3) that is zero except on unknown pixels, or null when there is nothing suitable to copy.
   */
  function grainDetail(rgba, ww, wh, unknown, cw, ch, seed, fill) {
    const B = 16; const stride = ww * wh > 2.5e6 ? 8 : 4;
    const small = resample(rgba, ww, wh, 4, cw, ch, 3); const back = resample(small, cw, ch, 3, ww, wh, 3);
    // pixels that may serve as a source: known and at least 4 px away from unknown ones
    const d = distanceSq(unknown, ww, wh);
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
    const cands = [];
    const meanOf = (src, x, y) => { const m = [0, 0, 0]; for (let yy = y; yy < y + B; yy += 4) for (let xx = x; xx < x + B; xx += 4) { const q = (yy * ww + xx) * 3; m[0] += src[q]; m[1] += src[q + 1]; m[2] += src[q + 2]; } const n = (B / 4) ** 2; return [m[0] / n, m[1] / n, m[2] / n]; };
    for (let y = 0; y + B <= wh; y += stride) for (let x = 0; x + B <= ww; x += stride) if (!sum(bad, x, y)) cands.push({ x, y, e: sum(en, x, y), m: meanOf(back, x, y) });
    if (cands.length < 4) return null;
    const CELL = 64; const gw = Math.ceil(ww / CELL); const gh = Math.ceil(wh / CELL); const maxRing = Math.max(gw, gh);
    const grid = Array.from({ length: gw * gh }, () => []);
    for (const c of cands) grid[Math.floor((c.y + B / 2) / CELL) * gw + Math.floor((c.x + B / 2) / CELL)].push(c);
    let s = (seed >>> 0) || 1; const rand = () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
    const out = new Float32Array(ww * wh * 3);
    const ub = maskBox(unknown, ww, wh); if (!ub) return null;
    for (let by = ub.y0; by < ub.y1; by += B) for (let bx = ub.x0; bx < ub.x1; bx += B) {
      // of the candidate blocks with about the same colour as the fill here, the nearest 16 (searched ring by ring on a
      // grid of cells), without the busiest third of them (edges, objects), and one of those at random
      const cx = bx + B / 2; const cy = by + B / 2;
      const tm = meanOf(fill, Math.min(bx, ww - B), Math.min(by, wh - B));
      const tcx = Math.floor(cx / CELL); const tcy = Math.floor(cy / CELL);
      let near = []; let firstSeen = -1;
      for (let ring = 0; ring <= maxRing && near.length < 16 && (firstSeen < 0 || ring <= firstSeen + 2); ring++) {
        for (let gy = tcy - ring; gy <= tcy + ring; gy++) for (let gx = tcx - ring; gx <= tcx + ring; gx++) {
          if (Math.max(Math.abs(gx - tcx), Math.abs(gy - tcy)) !== ring || gx < 0 || gy < 0 || gx >= gw || gy >= gh) continue;
          const cell = grid[gy * gw + gx];
          if (cell.length && firstSeen < 0) firstSeen = ring;
          for (const c of cell) {
            if (Math.abs(c.m[0] - tm[0]) + Math.abs(c.m[1] - tm[1]) + Math.abs(c.m[2] - tm[2]) > 30) continue;
            near.push({ c, dd: (c.x + B / 2 - cx) ** 2 + (c.y + B / 2 - cy) ** 2 });
          }
        }
      }
      near = near.sort((p, q) => p.dd - q.dd).slice(0, 16);
      if (!near.length) continue;
      near.sort((p, q) => p.c.e - q.c.e);
      const pool = near.slice(0, Math.max(1, Math.ceil(near.length * 0.66)));
      const src = pool[Math.floor(rand() * pool.length)].c;
      for (let y = 0; y < B && by + y < wh; y++) for (let x = 0; x < B && bx + x < ww; x++) {
        const i = (by + y) * ww + bx + x; if (!unknown[i]) continue;
        const j = (src.y + y) * ww + src.x + x; const p = j * 4; const q = j * 3; const o = i * 3;
        // per pixel: only where the source's smooth colour matches the fill's (no texture across a horizon or an edge)
        if (Math.abs(back[q] - fill[o]) + Math.abs(back[q + 1] - fill[o + 1]) + Math.abs(back[q + 2] - fill[o + 2]) > 24) continue;
        out[o] = rgba[p] - back[q]; out[o + 1] = rgba[p + 1] - back[q + 1]; out[o + 2] = rgba[p + 2] - back[q + 2];
      }
    }
    return out;
  }

  /**
   * Tone match for extensions, in the model's 512 x 512 space: LaMa's new area can come out a shade lighter or darker than
   * the picture it continues, which shows as a faint seam. The average difference between the real picture and the model's
   * own redraw of it, in a band of known pixels next to the new area, is measured locally (box of 2R) and added to the new
   * pixels, fading out over 2R pixels from the seam. Only the model's answer changes; the real pixels are not touched.
   */
  function matchTone(prep, output, R = 16) {
    const N = MODEL; const NN = N * N; const mask = prep.mask; const img = prep.image;
    const known = new Uint8Array(NN); for (let i = 0; i < NN; i++) known[i] = mask[i] ? 0 : 1;
    const dU = distanceSq(mask, N, N); const dK = distanceSq(known, N, N);
    const I = new Float64Array((N + 1) * (N + 1) * 4);         // integral images of the 3 differences and the count
    for (let y = 0; y < N; y++) {
      const r0 = [0, 0, 0, 0];
      for (let x = 0; x < N; x++) {
        const i = y * N + x;
        if (known[i] && dU[i] <= R * R) { r0[0] += img[i] * 255 - output[i]; r0[1] += img[NN + i] * 255 - output[NN + i]; r0[2] += img[2 * NN + i] * 255 - output[2 * NN + i]; r0[3] += 1; }
        const o = ((y + 1) * (N + 1) + x + 1) * 4; const u = (y * (N + 1) + x + 1) * 4;
        for (let c = 0; c < 4; c++) I[o + c] = I[u + c] + r0[c];
      }
    }
    const Rb = 2 * R; const cap = 40;
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      const i = y * N + x; if (known[i]) continue;
      const dist = Math.sqrt(dK[i]); if (dist >= Rb) continue;
      const x0 = Math.max(0, x - Rb); const x1 = Math.min(N, x + Rb + 1); const y0 = Math.max(0, y - Rb); const y1 = Math.min(N, y + Rb + 1);
      const a = (y0 * (N + 1) + x0) * 4; const b = (y0 * (N + 1) + x1) * 4; const c = (y1 * (N + 1) + x0) * 4; const d = (y1 * (N + 1) + x1) * 4;
      const n = I[d + 3] - I[b + 3] - I[c + 3] + I[a + 3]; if (n < 8) continue;
      const k = 1 - dist / Rb;
      for (let ch = 0; ch < 3; ch++) {
        const corr = (I[d + ch] - I[b + ch] - I[c + ch] + I[a + ch]) / n;
        output[ch * NN + i] += clamp(corr, -cap, cap) * k;
      }
    }
    return output;
  }

  /**
   * Outpainting help: LaMa darkens and greys out an unknown area that touches the edge of its input. So before an extension
   * tile is filled, the window is padded on its open side(s) with a mirror image of itself (pixels mirrored from unknown
   * pixels stay unknown). The model then bridges between the real picture and its reflection instead of fading towards a
   * border. Measured on a sky gradient: mean error against the true continuation 2.7 instead of 17 (levels of 255).
   * pads: { l, t, r, b } in pixels, each at most the window size on that axis. Returns { rgba, unknown, w, h }.
   */
  function mirrorPad(rgba, w, h, unknown, pads) {
    const l = Math.min(pads.l || 0, w); const r = Math.min(pads.r || 0, w); const t = Math.min(pads.t || 0, h); const b = Math.min(pads.b || 0, h);
    const W2 = w + l + r; const H2 = h + t + b;
    const out = new Uint8ClampedArray(W2 * H2 * 4); const unk = new Uint8Array(W2 * H2);
    const m = (i, n) => (i < 0 ? -1 - i : i >= n ? 2 * n - 1 - i : i);
    for (let y = 0; y < H2; y++) {
      const sy = m(y - t, h);
      for (let x = 0; x < W2; x++) {
        const sx = m(x - l, w); const si = sy * w + sx; const di = y * W2 + x;
        out[di * 4] = rgba[si * 4]; out[di * 4 + 1] = rgba[si * 4 + 1]; out[di * 4 + 2] = rgba[si * 4 + 2]; out[di * 4 + 3] = 255;
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
   * Every tile window lies inside (known area + its strip), so a window never contains pixels from a later step.
   * Returns { FW, FH, ox, oy, tile, feather, steps: [{ side, strip: box, tiles: [rect] }], count }.
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
        const ww = Math.min(L, rw); const wh = Math.min(L, rh);
        const tiles = [];
        const pad = Math.min(Math.round(d * 1.5), horiz ? ww : wh);      // mirror padding on the open side (see mirrorPad)
        const pads = { l: 0, t: 0, r: 0, b: 0, [side]: pad };
        if (horiz) {
          const x = side === 'l' ? R.x0 : R.x1 - ww;
          for (const y of along(R.y0, R.y1, wh)) tiles.push({ x, y: clamp(y, R.y0, R.y1 - wh), w: ww, h: wh, pads });
        } else {
          const y = side === 't' ? R.y0 : R.y1 - wh;
          for (const x of along(R.x0, R.x1, ww)) tiles.push({ x: clamp(x, R.x0, R.x1 - ww), y, w: ww, h: wh, pads });
        }
        steps.push({ side, strip, tiles });
        Object.assign(K, R);
        rem[side] -= d;
      }
    }
    return { FW, FH, ox: m.l, oy: m.t, margins: m, tile: L, feather: Math.max(3, Math.round(L / 256)), match: 16, steps, count: steps.reduce((n, s) => n + s.tiles.length, 0) };
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
  /** Default "grow selection" amount for a photo: about 0.25% of its long side, 3..24 px. */
  const defaultGrow = (W, H) => clamp(Math.round(Math.max(W, H) / 400), 3, 24);

  /** Fast 32-bit FNV-1a hash of a byte array (used by tests to compare pictures). */
  function hash(bytes, step = 1) { let h = 0x811c9dc5; for (let i = 0; i < bytes.length; i += step) { h ^= bytes[i]; h = Math.imul(h, 0x01000193); } return (h >>> 0).toString(16); }

  return {
    MODEL, SAM, MAX_PIXELS, MAX_SIDE, MAX_FILE_BYTES, UserError, clamp,
    boxToRect, rectToBox, unionBox, clipBox, growBox, boxesTouch, getRect, putRect,
    maskBox, maskCount, diffBox, paintLine, distanceSq, dilate, featherWeights, components, removalWindow, featherFor, removalJobs,
    resample, prepareFill, finishFill, grainDetail, matchTone, mirrorPad, unpad,
    samSize, logitsToMask, pickSamMask,
    PRESETS, clampMargins, presetMargins, extendTile, extendPlan,
    OPEN_EXTS, extOf, isOpenable, FORMATS, sniff, defaultFormat, defaultName, formatBytes, defaultGrow, hash,
  };
}));
