'use strict';
// Reading sticker colours from pictures (webcam frames or photos). Shared by the window (loaded with <script>) and the tests.
//
// 1. sampleFace: a grid (four corner points, so it can follow a photo taken at an angle) is laid over the face; inside each
//    cell only the middle part is sampled (the black plastic and the sticker edges stay out) and the colour is the per-channel
//    MEDIAN of many pixels in CIE Lab, so glare spots, noise and a stray edge do not move it.
// 2. classify: every sticker gets one of the six colours, with exactly n*n of each (a min-cost assignment, Hungarian method).
//    3x3: the six centres are the reference colours. 2x2: no centres, so the 24 stickers are clustered into 6 groups of 4
//    (k-means, then the counts are fixed with the assignment) and the groups are named by the nearest standard colour.
//    Lighting differs between faces (a warm lamp on one, a dim side on another), so each face also gets its own light
//    correction (a gain per red/green/blue channel, fitted to the colours it was assigned), and the assignment is repeated.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CubeColour = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  const COLOURS = ['w', 'y', 'g', 'b', 'r', 'o'];
  // typical sticker colours as a camera sees them in neutral light (sRGB 0..255)
  const TYPICAL = { w: [232, 234, 232], y: [240, 214, 40], g: [20, 160, 80], b: [20, 70, 180], r: [190, 25, 45], o: [250, 110, 20] };

  // ---- colour spaces ------------------------------------------------------------------------------------------------------
  const toLinear = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  const fromLinear = (v) => { v = Math.max(0, Math.min(1, v)); return 255 * (v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055); };
  const LIN = new Float64Array(256); for (let i = 0; i < 256; i++) LIN[i] = toLinear(i);
  function linToLab(r, g, b) {
    const x = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047;
    const y = 0.2126729 * r + 0.7151522 * g + 0.0721750 * b;
    const z = (0.0193339 * r + 0.1191920 * g + 0.9503041 * b) / 1.08883;
    const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
    const fx = f(x); const fy = f(y); const fz = f(z);
    return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
  }
  const rgbToLab = (rgb) => linToLab(LIN[clamp255(rgb[0])], LIN[clamp255(rgb[1])], LIN[clamp255(rgb[2])]);
  const clamp255 = (v) => Math.max(0, Math.min(255, Math.round(v)));
  const TYPICAL_LAB = Object.fromEntries(COLOURS.map((c) => [c, rgbToLab(TYPICAL[c])]));
  // lightness counts for less than colour: one side of a cube is nearly always darker than another
  const W_L = 0.45;
  const dist = (a, b) => Math.sqrt(W_L * W_L * (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2);

  // ---- the grid ---------------------------------------------------------------------------------------------------------------
  /** quad = [topLeft, topRight, bottomRight, bottomLeft] as [x, y]; (u, v) in 0..1 across / down the face. */
  function quadPoint(quad, u, v) {
    const [a, b, c, d] = quad;
    return [
      (1 - u) * (1 - v) * a[0] + u * (1 - v) * b[0] + u * v * c[0] + (1 - u) * v * d[0],
      (1 - u) * (1 - v) * a[1] + u * (1 - v) * b[1] + u * v * c[1] + (1 - u) * v * d[1],
    ];
  }
  /** The centre and the four corners of the sampled middle part of every cell, row by row. */
  function gridCells(quad, n, inner = 0.5) {
    const cells = [];
    const lo = (1 - inner) / 2; const hi = 1 - lo;
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        cells.push({
          r, c,
          centre: quadPoint(quad, (c + 0.5) / n, (r + 0.5) / n),
          corners: [[lo, lo], [hi, lo], [hi, hi], [lo, hi]].map(([u, v]) => quadPoint(quad, (c + u) / n, (r + v) / n)),
        });
      }
    }
    return cells;
  }
  /** Turns the grid a quarter turn clockwise (for a photo taken with the cube on its side). */
  const rotateQuad = (quad) => [quad[3], quad[0], quad[1], quad[2]];
  const squareQuad = (cx, cy, size) => { const h = size / 2; return [[cx - h, cy - h], [cx + h, cy - h], [cx + h, cy + h], [cx - h, cy + h]]; };

  const median = (arr) => { const a = Float64Array.from(arr).sort(); const k = a.length >> 1; return a.length % 2 ? a[k] : (a[k - 1] + a[k]) / 2; };
  /**
   * Samples the colours of one face from an image ({ width, height, data: RGBA bytes }). Returns n*n samples
   * { lab, rgb, spread } in reading order; spread is how uneven the cell was (high = probably not on a sticker).
   */
  function sampleFace(img, quad, n, { inner = 0.5, steps = 9 } = {}) {
    return gridCells(quad, n, inner).map((cell) => {
      const L = []; const A = []; const B = []; const R = []; const G = []; const Bl = [];
      const lo = (1 - inner) / 2;
      for (let i = 0; i < steps; i++) {
        for (let j = 0; j < steps; j++) {
          const u = (cell.c + lo + (inner * (j + 0.5)) / steps) / n;
          const v = (cell.r + lo + (inner * (i + 0.5)) / steps) / n;
          const [x, y] = quadPoint(quad, u, v);
          const px = Math.round(x); const py = Math.round(y);
          if (px < 0 || py < 0 || px >= img.width || py >= img.height) continue;
          const o = (py * img.width + px) * 4;
          const r = img.data[o]; const g = img.data[o + 1]; const b = img.data[o + 2];
          const lab = linToLab(LIN[r], LIN[g], LIN[b]);
          L.push(lab[0]); A.push(lab[1]); B.push(lab[2]); R.push(r); G.push(g); Bl.push(b);
        }
      }
      if (!L.length) return { lab: [0, 0, 0], rgb: [0, 0, 0], spread: 999, outside: true };
      const lab = [median(L), median(A), median(B)];
      const spread = median(L.map((l, k) => dist([l, A[k], B[k]], lab)));
      return { lab, rgb: [median(R), median(G), median(Bl)], spread };
    });
  }

  // ---- assignment (Hungarian method, minimum cost, square matrix) -------------------------------------------------------------
  function hungarian(cost) {
    const n = cost.length;
    const INF = 1e18;
    const u = new Float64Array(n + 1); const v = new Float64Array(n + 1);
    const p = new Int32Array(n + 1); const way = new Int32Array(n + 1);
    for (let i = 1; i <= n; i++) {
      p[0] = i;
      let j0 = 0;
      const minv = new Float64Array(n + 1).fill(INF);
      const used = new Uint8Array(n + 1);
      do {
        used[j0] = 1;
        const i0 = p[j0]; let delta = INF; let j1 = 0;
        for (let j = 1; j <= n; j++) {
          if (used[j]) continue;
          const cur = cost[i0 - 1][j - 1] - u[i0] - v[j];
          if (cur < minv[j]) { minv[j] = cur; way[j] = j0; }
          if (minv[j] < delta) { delta = minv[j]; j1 = j; }
        }
        for (let j = 0; j <= n; j++) {
          if (used[j]) { u[p[j]] += delta; v[j] -= delta; } else minv[j] -= delta;
        }
        j0 = j1;
      } while (p[j0] !== 0);
      do { const j1 = way[j0]; p[j0] = p[j1]; j0 = j1; } while (j0);
    }
    const rowToCol = new Array(n);
    for (let j = 1; j <= n; j++) if (p[j]) rowToCol[p[j] - 1] = j - 1;
    return rowToCol;
  }
  /** Gives each item one of the groups, `per` items per group, minimising the summed cost. cost[item][group]. */
  function assignEqual(cost, groups, per, fixed = {}) {
    const n = cost.length;
    const BIG = 1e9;
    const m = cost.map((row, i) => {
      const out = [];
      for (let g = 0; g < groups; g++) {
        const c = fixed[i] != null ? (fixed[i] === g ? 0 : BIG) : row[g];
        for (let k = 0; k < per; k++) out.push(c);
      }
      return out;
    });
    if (n !== groups * per) throw new Error('assignEqual: counts do not add up');
    return hungarian(m).map((col) => Math.floor(col / per));
  }

  // ---- classification --------------------------------------------------------------------------------------------------------
  const linOf = (s) => s.rgb.map((v) => toLinear(v));
  const labOfLin = (lin) => linToLab(lin[0], lin[1], lin[2]);

  /**
   * The shared engine. faces: 6 arrays (URFDLB) of n*n samples. refs: initial reference Lab per group (6). fixed: sample
   * index -> group (centres). Returns { groups: group per sticker (54 or 24), refsLin, gains }.
   */
  function solveLighting(faces, n, initRefsLin, fixed, rounds = 6) {
    const per = n * n;
    const all = faces.flat();
    const lin = all.map(linOf);
    const gains = faces.map(() => [1, 1, 1]);
    let refsLin = initRefsLin.map((r) => r.slice());
    let groups = null;
    for (let round = 0; round < rounds; round++) {
      const corrected = lin.map((x, i) => { const g = gains[Math.floor(i / per)]; return labOfLin([x[0] / g[0], x[1] / g[1], x[2] / g[2]]); });
      const refLab = refsLin.map(labOfLin);
      const cost = corrected.map((lab) => refLab.map((ref) => dist(lab, ref)));
      const next = assignEqual(cost, 6, per, fixed);
      const same = groups && next.every((g, i) => g === groups[i]);
      groups = next;
      if (same && round > 1) break;
      // fit each face's light: observed = gain * reference, per channel (least squares)
      for (let f = 0; f < 6; f++) {
        for (let ch = 0; ch < 3; ch++) {
          let num = 0; let den = 0;
          for (let k = 0; k < per; k++) { const i = f * per + k; const ref = refsLin[groups[i]][ch]; num += lin[i][ch] * ref; den += ref * ref; }
          gains[f][ch] = den > 1e-9 ? Math.max(0.05, num / den) : 1;
        }
      }
      // the overall level is arbitrary: keep the average gain at 1 per channel
      for (let ch = 0; ch < 3; ch++) {
        const mean = Math.exp(gains.reduce((s, g) => s + Math.log(g[ch]), 0) / 6);
        for (const g of gains) g[ch] /= mean;
      }
      // the references become the average of what they were given, light-corrected
      refsLin = refsLin.map((old, grp) => {
        const sum = [0, 0, 0]; let k = 0;
        groups.forEach((gg, i) => { if (gg !== grp) return; const g = gains[Math.floor(i / per)]; for (let ch = 0; ch < 3; ch++) sum[ch] += lin[i][ch] / g[ch]; k++; });
        return k ? sum.map((s) => s / k) : old;
      });
    }
    return { groups, refsLin, gains };
  }

  /** 3x3: centres are the references. centreColours[f] = colour key of face f's centre. Returns 54 colour keys + confidence. */
  function classify3(faces, centreColours) {
    if (faces.length !== 6 || faces.some((f) => f.length !== 9)) throw new Error('classify3 needs 6 faces of 9 samples');
    if (new Set(centreColours).size !== 6) throw new Error('The six centres must be six different colours');
    const fixed = {};
    for (let f = 0; f < 6; f++) fixed[f * 9 + 4] = f; // group f = colour of face f's centre
    const init = faces.map((face) => linOf(face[4]));
    const { groups, refsLin, gains } = solveLighting(faces, 3, init, fixed);
    return withConfidence(faces, 3, groups.map((g) => centreColours[g]), groups, refsLin, gains);
  }

  /** 2x2: cluster 24 stickers into 6 groups of exactly 4 and name the groups. */
  function classify2(faces) {
    if (faces.length !== 6 || faces.some((f) => f.length !== 4)) throw new Error('classify2 needs 6 faces of 4 samples');
    const all = faces.flat();
    // k-means started from the typical colours, then counts fixed with the assignment, a few rounds
    let centres = COLOURS.map((c) => TYPICAL_LAB[c].slice());
    let groups = null;
    for (let it = 0; it < 12; it++) {
      const cost = all.map((s) => centres.map((c) => dist(s.lab, c)));
      groups = it < 3 ? cost.map((row) => row.indexOf(Math.min(...row))) : assignEqual(cost, 6, 4);
      centres = centres.map((old, g) => {
        const mine = all.filter((_, i) => groups[i] === g);
        return mine.length ? [0, 1, 2].map((k) => mine.reduce((s, x) => s + x.lab[k], 0) / mine.length) : old;
      });
    }
    groups = assignEqual(all.map((s) => centres.map((c) => dist(s.lab, c))), 6, 4);
    // then the light correction per face, starting from those groups
    const initLin = COLOURS.map((_, g) => {
      const mine = all.map(linOf).filter((_, i) => groups[i] === g);
      return [0, 1, 2].map((k) => mine.reduce((s, x) => s + x[k], 0) / mine.length);
    });
    const lit = solveLighting(faces, 2, initLin, {});
    // name the groups: nearest typical colours, one name per group, after a grey-world-free white balance that uses the
    // brightest, least colourful group as white
    const labs = lit.refsLin.map(labOfLin);
    const whiteIdx = labs.map((l, i) => [l[0] - 1.5 * Math.hypot(l[1], l[2]), i]).sort((a, b) => b[0] - a[0])[0][1];
    const wl = lit.refsLin[whiteIdx];
    const tw = TYPICAL.w.map(toLinear);
    const wb = wl.map((v, k) => (v > 1e-6 ? tw[k] / v : 1));
    const balanced = lit.refsLin.map((r) => labOfLin(r.map((v, k) => v * wb[k])));
    const nameCost = balanced.map((lab) => COLOURS.map((c) => dist(lab, TYPICAL_LAB[c])));
    const names = hungarian(nameCost).map((k) => COLOURS[k]);
    return withConfidence(faces, 2, lit.groups.map((g) => names[g]), lit.groups, lit.refsLin, lit.gains);
  }

  // how clear each sticker's answer was: the gap between the best and the second-best reference after light correction
  function withConfidence(faces, n, colours, groups, refsLin, gains) {
    const per = n * n;
    const refLab = refsLin.map(labOfLin);
    const unsure = [];
    faces.flat().forEach((s, i) => {
      const g = gains[Math.floor(i / per)];
      const lab = labOfLin(linOf(s).map((v, k) => v / g[k]));
      const d = refLab.map((r) => dist(lab, r));
      const mine = d[groups[i]];
      const other = Math.min(...d.filter((_, k) => k !== groups[i]));
      if (other - mine < 8 || s.spread > 25) unsure.push(i);
    });
    return { colours, unsure, gains };
  }

  /** Quick guess for the live camera preview: nearest reference (the centres seen so far, else typical colours). */
  function liveGuess(samples, refs = {}) {
    const refLab = COLOURS.map((c) => (refs[c] ? refs[c] : TYPICAL_LAB[c]));
    return samples.map((s) => {
      const d = refLab.map((r) => dist(s.lab, r));
      return COLOURS[d.indexOf(Math.min(...d))];
    });
  }

  // ---- any puzzle: face templates (outline + sticker polygons) instead of a square grid ------------------------------------
  // A face template (puzzle.templates[face]) is flat, in its own units, y DOWN. The user places the outline's corners on the
  // picture (3 for a triangle, 4 for a square or rectangle, 5 for a pentagon); the template is mapped onto the picture with an
  // affine map (3 corners) or a perspective map (4 corners exactly, 5 by least squares), and every sticker is sampled in the
  // middle part of its polygon.
  const area2 = (pts) => { let a = 0; for (let i = 0; i < pts.length; i++) { const p = pts[i]; const q = pts[(i + 1) % pts.length]; a += p[0] * q[1] - q[0] * p[1]; } return a; };
  /** The outline's corners, clockwise on screen, starting at the top-left-most one. */
  function outlineCorners(template) {
    let pts = template.outline.map((p) => [p[0], p[1]]);
    if (area2(pts) < 0) pts = pts.reverse();
    let k = 0;
    pts.forEach((p, i) => { if (p[0] + p[1] < pts[k][0] + pts[k][1] - 1e-9) k = i; });
    return pts.slice(k).concat(pts.slice(0, k));
  }
  /** Where the outline's corners go for a template centred at (cx, cy), its larger side `size` long. */
  function placeOutline(template, cx, cy, size) {
    const b = template.box; const s = size / Math.max(b.w, b.h);
    const mx = (b.minX + b.maxX) / 2; const my = (b.minY + b.maxY) / 2;
    return outlineCorners(template).map(([x, y]) => [cx + (x - mx) * s, cy + (y - my) * s]);
  }
  /** Turns the corner assignment one corner on (a quarter for squares, a third for triangles, a fifth for pentagons). */
  const rotateCorners = (corners) => [corners[corners.length - 1], ...corners.slice(0, -1)];
  function solveLinear(A, b) { // Gaussian elimination with partial pivoting
    const n = b.length; const M = A.map((row, i) => [...row, b[i]]);
    for (let c = 0; c < n; c++) {
      let piv = c; for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
      [M[c], M[piv]] = [M[piv], M[c]];
      if (Math.abs(M[c][c]) < 1e-12) return null;
      for (let r = 0; r < n; r++) { if (r === c) continue; const f = M[r][c] / M[c][c]; if (f) for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k]; }
    }
    return M.map((row, i) => row[n] / row[i]);
  }
  /** A 3x3 matrix (row-major) mapping the points src onto dst: affine for 3 points, perspective for 4 or more. */
  function fitMap(src, dst) {
    if (src.length === 3) {
      const A = []; const b = [];
      src.forEach(([x, y], i) => { A.push([x, y, 1, 0, 0, 0]); b.push(dst[i][0]); A.push([0, 0, 0, x, y, 1]); b.push(dst[i][1]); });
      const h = solveLinear(A, b);
      return h ? [h[0], h[1], h[2], h[3], h[4], h[5], 0, 0, 1] : null;
    }
    const rows = []; const rhs = [];
    src.forEach(([x, y], i) => {
      const [u, v] = dst[i];
      rows.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); rhs.push(u);
      rows.push([0, 0, 0, x, y, 1, -v * x, -v * y]); rhs.push(v);
    });
    let h;
    if (rows.length === 8) h = solveLinear(rows, rhs);
    else { // least squares: (A^T A) h = A^T b
      const AtA = Array.from({ length: 8 }, (_, i) => Array.from({ length: 8 }, (_, j) => rows.reduce((s, r) => s + r[i] * r[j], 0)));
      const Atb = Array.from({ length: 8 }, (_, i) => rows.reduce((s, r, k) => s + r[i] * rhs[k], 0));
      h = solveLinear(AtA, Atb);
    }
    return h ? [...h, 1] : null;
  }
  const mapPoint = (H, [x, y]) => { const w = H[6] * x + H[7] * y + H[8]; return [(H[0] * x + H[1] * y + H[2]) / w, (H[3] * x + H[4] * y + H[5]) / w]; };
  function invertMap(m) {
    const [a, b, c, d, e, f, g, h, i] = m;
    const A = e * i - f * h; const B = -(d * i - f * g); const Cc = d * h - e * g;
    const det = a * A + b * B + c * Cc;
    return [A / det, -(b * i - c * h) / det, (b * f - c * e) / det, B / det, (a * i - c * g) / det, -(a * f - c * d) / det, Cc / det, -(a * h - b * g) / det, (a * e - b * d) / det];
  }
  const polyCentre = (poly) => { const n = poly.length; return [poly.reduce((s, p) => s + p[0], 0) / n, poly.reduce((s, p) => s + p[1], 0) / n]; };
  const shrink = (poly, k) => { const c = polyCentre(poly); return poly.map(([x, y]) => [c[0] + (x - c[0]) * k, c[1] + (y - c[1]) * k]); };
  function insidePoly(q, x, y) {
    let ins = false;
    for (let i = 0, j = q.length - 1; i < q.length; j = i++) {
      const [xi, yi] = q[i]; const [xj, yj] = q[j];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) ins = !ins;
    }
    return ins;
  }
  /** The map from the template onto the picture, for these outline corners (in the order outlineCorners gives). */
  const templateMap = (template, corners) => fitMap(outlineCorners(template), corners);
  /** Every sticker of the template on the picture: { i, centre, poly, inner } (inner = the sampled middle part). */
  function templateCells(template, corners, inner = 0.5) {
    const H = templateMap(template, corners);
    if (!H) return [];
    return template.stickers.map((s) => {
      const c = polyCentre(s.poly);
      return { i: s.i, centre: mapPoint(H, c), poly: s.poly.map((p) => mapPoint(H, p)), inner: shrink(s.poly, inner).map((p) => mapPoint(H, p)) };
    });
  }
  /** Samples every sticker of one face (template order). Same reading as sampleFace: a median in Lab of the middle part. */
  function sampleTemplate(img, template, corners, { inner = 0.5, steps = 9 } = {}) {
    const H = templateMap(template, corners);
    return template.stickers.map((s) => {
      const poly = shrink(s.poly, inner);
      let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
      for (const [x, y] of poly) { minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); }
      const L = []; const A = []; const B = []; const R = []; const G = []; const Bl = [];
      const n = poly.length === 4 ? steps : steps + 3; // a triangle or pentagon fills less of its box
      for (let i = 0; i < n && H; i++) {
        for (let j = 0; j < n; j++) {
          const tx = minX + ((maxX - minX) * (j + 0.5)) / n; const ty = minY + ((maxY - minY) * (i + 0.5)) / n;
          if (poly.length !== 4 && !insidePoly(poly, tx, ty)) continue;
          const [x, y] = mapPoint(H, [tx, ty]);
          const px = Math.round(x); const py = Math.round(y);
          if (!(px >= 0 && py >= 0 && px < img.width && py < img.height)) continue;
          const o = (py * img.width + px) * 4;
          const r = img.data[o]; const g = img.data[o + 1]; const b = img.data[o + 2];
          const lab = linToLab(LIN[r], LIN[g], LIN[b]);
          L.push(lab[0]); A.push(lab[1]); B.push(lab[2]); R.push(r); G.push(g); Bl.push(b);
        }
      }
      if (!L.length) return { i: s.i, lab: [0, 0, 0], rgb: [0, 0, 0], spread: 999, outside: true };
      const lab = [median(L), median(A), median(B)];
      const spread = median(L.map((l, k) => dist([l, A[k], B[k]], lab)));
      return { i: s.i, lab, rgb: [median(R), median(G), median(Bl)], spread };
    });
  }

  // ---- any number of colours, known counts ---------------------------------------------------------------------------------------
  const hexRgb = (hex) => { const h = String(hex).replace('#', ''); return [0, 2, 4].map((k) => parseInt(h.slice(k, k + 2), 16)); };
  const TYPICAL_BY_NAME = { white: TYPICAL.w, yellow: TYPICAL.y, green: TYPICAL.g, blue: TYPICAL.b, red: TYPICAL.r, orange: TYPICAL.o };
  /** What a camera typically sees for each colour of a puzzle (the six cube colours as measured, others from their hex). */
  function typicalFor(colours) {
    return Object.fromEntries(Object.entries(colours).map(([k, c]) => [k, (TYPICAL_BY_NAME[String(c.name).toLowerCase()] || hexRgb(c.hex)).slice()]));
  }
  /** Gives each item a group, counts[g] items per group, minimising the summed cost. */
  function assignCounts(cost, counts, fixed = {}) {
    const n = cost.length; const BIG = 1e9;
    if (counts.reduce((s, x) => s + x, 0) !== n) throw new Error('assignCounts: counts do not add up');
    const colGroup = []; counts.forEach((k, g) => { for (let j = 0; j < k; j++) colGroup.push(g); });
    const m = cost.map((row, i) => colGroup.map((g) => (fixed[i] != null ? (fixed[i] === g ? 0 : BIG) : row[g])));
    return hungarian(m).map((col) => colGroup[col]);
  }
  /** solveLighting for faces of any sizes and any number of groups with known counts. */
  function lightingCounts(faces, counts, initRefsLin, fixed, rounds = 6) {
    const all = faces.flat(); const faceOf = []; faces.forEach((f, k) => f.forEach(() => faceOf.push(k)));
    const lin = all.map(linOf);
    const gains = faces.map(() => [1, 1, 1]);
    let refsLin = initRefsLin.map((r) => r.slice());
    let groups = null;
    for (let round = 0; round < rounds; round++) {
      const corrected = lin.map((x, i) => { const g = gains[faceOf[i]]; return labOfLin([x[0] / g[0], x[1] / g[1], x[2] / g[2]]); });
      const refLab = refsLin.map(labOfLin);
      const next = assignCounts(corrected.map((lab) => refLab.map((ref) => dist(lab, ref))), counts, fixed);
      const same = groups && next.every((g, i) => g === groups[i]);
      groups = next;
      if (same && round > 1) break;
      for (let f = 0; f < faces.length; f++) {
        for (let ch = 0; ch < 3; ch++) {
          let num = 0; let den = 0;
          for (let i = 0; i < all.length; i++) { if (faceOf[i] !== f) continue; const ref = refsLin[groups[i]][ch]; num += lin[i][ch] * ref; den += ref * ref; }
          gains[f][ch] = den > 1e-9 ? Math.max(0.05, num / den) : 1;
        }
      }
      for (let ch = 0; ch < 3; ch++) {
        const mean = Math.exp(gains.reduce((s, g) => s + Math.log(g[ch]), 0) / gains.length);
        for (const g of gains) g[ch] /= mean;
      }
      refsLin = refsLin.map((old, grp) => {
        const sum = [0, 0, 0]; let k = 0;
        groups.forEach((gg, i) => { if (gg !== grp) return; const g = gains[faceOf[i]]; for (let ch = 0; ch < 3; ch++) sum[ch] += lin[i][ch] / g[ch]; k++; });
        return k ? sum.map((s) => s / k) : old;
      });
    }
    return { groups, refsLin, gains, faceOf };
  }
  /**
   * Any puzzle. faces: arrays of samples (one array per scanned face, any sizes). keys: the colour keys; counts: how many
   * stickers of each colour the puzzle has (same order); typical: key -> typical sRGB; fixed: flat sample index -> colour key
   * for stickers whose colour is known (centres that never move); white: the key of white, if the puzzle has it. When every colour has a known sticker those are the
   * references (as for the 3x3); otherwise the samples are clustered into groups of exactly the right sizes and the groups are
   * named by the nearest typical colours (as for the 2x2). Returns { colours (flat, input order), unsure (flat indices), gains }.
   */
  function classifyCounts(faces, { keys, counts, typical, fixed = {}, white = keys.includes('w') ? 'w' : null }) {
    const all = faces.flat();
    if (all.length !== counts.reduce((s, x) => s + x, 0)) throw new Error('The pictures do not have the right number of stickers');
    const typLab = keys.map((k) => rgbToLab(typical[k]));
    const fixedIdx = {}; for (const [i, k] of Object.entries(fixed)) fixedIdx[i] = keys.indexOf(k);
    const known = new Set(Object.values(fixedIdx));
    let lit; let names;
    if (keys.every((_, g) => known.has(g))) {
      const lin = all.map(linOf);
      const init = keys.map((_, g) => {
        const mine = Object.keys(fixedIdx).filter((i) => fixedIdx[i] === g).map((i) => lin[i]);
        return [0, 1, 2].map((ch) => mine.reduce((s, x) => s + x[ch], 0) / mine.length);
      });
      lit = lightingCounts(faces, counts, init, fixedIdx);
      names = keys.slice();
    } else {
      const K = keys.length;
      let centres = typLab.map((c) => c.slice());
      let groups = null;
      for (let it = 0; it < 12; it++) {
        const cost = all.map((s) => centres.map((c) => dist(s.lab, c)));
        groups = it < 3 ? cost.map((row) => row.indexOf(Math.min(...row))) : assignCounts(cost, counts);
        centres = centres.map((old, g) => {
          const mine = all.filter((_, i) => groups[i] === g);
          return mine.length ? [0, 1, 2].map((k) => mine.reduce((s, x) => s + x.lab[k], 0) / mine.length) : old;
        });
      }
      groups = assignCounts(all.map((s) => centres.map((c) => dist(s.lab, c))), counts);
      const lin = all.map(linOf);
      const initLin = keys.map((_, g) => {
        const mine = lin.filter((_, i) => groups[i] === g);
        return mine.length ? [0, 1, 2].map((k) => mine.reduce((s, x) => s + x[k], 0) / mine.length) : typical[keys[g]].map(toLinear);
      });
      lit = lightingCounts(faces, counts, initLin, {});
      // name the groups: white balance on the brightest, least colourful group if the puzzle has white, then the nearest
      // typical colours, one name per group, only among colours with as many stickers as the group
      const labs = lit.refsLin.map(labOfLin);
      const wKey = white == null ? -1 : keys.indexOf(white);
      let wb = [1, 1, 1];
      if (wKey >= 0) {
        const whiteIdx = labs.map((l, i) => [l[0] - 1.5 * Math.hypot(l[1], l[2]), i]).sort((a, b) => b[0] - a[0])[0][1];
        const wl = lit.refsLin[whiteIdx]; const tw = typical[keys[wKey]].map(toLinear);
        wb = wl.map((v, k) => (v > 1e-6 ? tw[k] / v : 1));
      }
      const balanced = lit.refsLin.map((r) => labOfLin(r.map((v, k) => v * wb[k])));
      const nameCost = balanced.map((lab, g) => typLab.map((t, k) => dist(lab, t) + (counts[k] === counts[g] ? 0 : 1e6)));
      names = hungarian(nameCost).map((k) => keys[k]);
      for (let g = 0; g < K; g++) if (!names[g]) names[g] = keys[g];
    }
    const colours = lit.groups.map((g) => names[g]);
    const refLab = lit.refsLin.map(labOfLin);
    const unsure = [];
    all.forEach((s, i) => {
      const g = lit.gains[lit.faceOf[i]];
      const lab = labOfLin(linOf(s).map((v, k) => v / g[k]));
      const d = refLab.map((r) => dist(lab, r));
      const mine = d[lit.groups[i]];
      const other = Math.min(...d.filter((_, k) => k !== lit.groups[i]));
      if (other - mine < 8 || s.spread > 25) unsure.push(i);
    });
    return { colours, unsure, gains: lit.gains };
  }
  /** Quick guess for the live camera preview, any colour set: nearest of refs[key] (Lab) or the typical colour. */
  function liveGuessKeys(samples, keys, typical, refs = {}) {
    const refLab = keys.map((k) => (refs[k] ? refs[k] : rgbToLab(typical[k])));
    return samples.map((s) => { const d = refLab.map((r) => dist(s.lab, r)); return keys[d.indexOf(Math.min(...d))]; });
  }

  return { COLOURS, TYPICAL, TYPICAL_LAB, rgbToLab, linToLab, toLinear, fromLinear, dist, quadPoint, gridCells, rotateQuad, squareQuad, sampleFace, hungarian, assignEqual, classify3, classify2, liveGuess, median,
    outlineCorners, placeOutline, rotateCorners, fitMap, mapPoint, invertMap, templateMap, templateCells, sampleTemplate, insidePoly, polyCentre, shrink,
    hexRgb, typicalFor, assignCounts, classifyCounts, liveGuessKeys };
}));
