'use strict';
// Look-alike pictures. Each picture is reduced to a 64-bit "difference hash" (does each little patch get brighter or
// darker towards the right?), which survives resizing, re-saving, small colour changes and recompression. Two pictures
// whose hashes differ in only a few bits are look-alikes. The hashing happens in the window (the browser can decode WebP,
// AVIF, GIF...), the comparing here, with no Electron in it, so the tests run it with plain Node.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Similar = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  const SIZE = 32;               // the picture is first shrunk to SIZE x SIZE grey values
  const FLAT_STDDEV = 3;         // a picture whose grey values barely vary has no shape to compare (a blank screenshot)

  /** Average a grey SIZE x SIZE picture down to the 9 x 8 grid the hash is read from. */
  function grid9x8(gray, w = SIZE, h = SIZE) {
    const out = new Float64Array(9 * 8);
    for (let cy = 0; cy < 8; cy++) {
      const y0 = (cy * h) / 8; const y1 = ((cy + 1) * h) / 8;
      for (let cx = 0; cx < 9; cx++) {
        const x0 = (cx * w) / 9; const x1 = ((cx + 1) * w) / 9;
        let sum = 0; let weight = 0;
        for (let y = Math.floor(y0); y < Math.ceil(y1); y++) {
          const wy = Math.min(y + 1, y1) - Math.max(y, y0);
          for (let x = Math.floor(x0); x < Math.ceil(x1); x++) {
            const wx = Math.min(x + 1, x1) - Math.max(x, x0);
            sum += gray[y * w + x] * wx * wy; weight += wx * wy;
          }
        }
        out[cy * 9 + cx] = sum / weight;
      }
    }
    return out;
  }

  /**
   * @param gray  grey values 0..255, row by row, w x h (default 32 x 32)
   * @returns {{ hi: number, lo: number, flat: boolean }}   the 64 bits as two unsigned 32-bit numbers
   */
  function dhash(gray, w = SIZE, h = SIZE) {
    const g = grid9x8(gray, w, h);
    let hi = 0; let lo = 0;
    for (let cy = 0; cy < 8; cy++) {
      for (let cx = 0; cx < 8; cx++) {
        const bit = g[cy * 9 + cx] > g[cy * 9 + cx + 1] ? 1 : 0;
        const n = cy * 8 + cx;                // 0..63, first bit first
        if (n < 32) hi = ((hi << 1) | bit) >>> 0; else lo = ((lo << 1) | bit) >>> 0;
      }
    }
    let mean = 0;
    for (let i = 0; i < gray.length; i++) mean += gray[i];
    mean /= gray.length;
    let v = 0;
    for (let i = 0; i < gray.length; i++) v += (gray[i] - mean) ** 2;
    return { hi, lo, flat: Math.sqrt(v / gray.length) < FLAT_STDDEV };
  }

  const popcount = (x) => {
    x -= (x >>> 1) & 0x55555555;
    x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
    x = (x + (x >>> 4)) & 0x0f0f0f0f;
    return Math.imul(x, 0x01010101) >>> 24;
  };
  const distance = (a, b) => popcount((a.hi ^ b.hi) >>> 0) + popcount((a.lo ^ b.lo) >>> 0);

  const toHex = (h) => h.hi.toString(16).padStart(8, '0') + h.lo.toString(16).padStart(8, '0');
  const fromHex = (s) => ({ hi: parseInt(s.slice(0, 8), 16) >>> 0, lo: parseInt(s.slice(8, 16), 16) >>> 0 });

  /** Pictures of clearly different shape are not look-alikes however similar the hash. */
  function sameShape(a, b) {
    if (!(a.w > 0 && a.h > 0 && b.w > 0 && b.h > 0)) return true;
    return Math.abs(Math.log((a.w / a.h) / (b.w / b.h))) < 0.05;
  }

  /**
   * Group look-alikes.
   * @param items      [{ hi, lo, flat, w, h }]   (anything else on the items is passed through)
   * @param threshold  largest number of differing bits (0..64) that still counts as a look-alike
   * @param opts       { onProgress(fraction), signal }
   * @returns [{ members: [index...], maxDistance }]   groups of 2 or more, biggest first
   *
   * Every member of a group is within `threshold` of the group's first (pivot) picture, so a chain of "A looks like B,
   * B looks like C" never drags in a picture that looks nothing like A.
   */
  function group(items, threshold, opts = {}) {
    const n = items.length;
    const hi = new Uint32Array(n); const lo = new Uint32Array(n);
    const ok = new Uint8Array(n);
    for (let i = 0; i < n; i++) { hi[i] = items[i].hi; lo[i] = items[i].lo; ok[i] = items[i].flat ? 0 : 1; }
    const adj = Array.from({ length: n }, () => []);
    for (let i = 0; i < n; i++) {
      if (opts.signal && opts.signal.aborted) throw Object.assign(new Error('Cancelled'), { cancelled: true });
      if (!ok[i]) continue;
      const ah = hi[i]; const al = lo[i];
      for (let j = i + 1; j < n; j++) {
        if (!ok[j]) continue;
        const d = popcount((ah ^ hi[j]) >>> 0) + popcount((al ^ lo[j]) >>> 0);
        if (d <= threshold && sameShape(items[i], items[j])) { adj[i].push(j, d); adj[j].push(i, d); }
      }
      if (opts.onProgress && i % 500 === 0) opts.onProgress(i / n);
    }
    // pivots: the picture with the most look-alikes first
    const order = Array.from({ length: n }, (_, i) => i).filter((i) => adj[i].length).sort((a, b) => adj[b].length - adj[a].length || a - b);
    const taken = new Uint8Array(n);
    const groups = [];
    for (const p of order) {
      if (taken[p]) continue;
      const members = [p];
      let maxDistance = 0;
      for (let k = 0; k < adj[p].length; k += 2) {
        const q = adj[p][k];
        if (!taken[q]) { members.push(q); maxDistance = Math.max(maxDistance, adj[p][k + 1]); }
      }
      if (members.length < 2) continue;
      for (const m of members) taken[m] = 1;
      members.sort((a, b) => a - b);
      groups.push({ members, maxDistance });
    }
    groups.sort((a, b) => b.members.length - a.members.length || a.members[0] - b.members[0]);
    return groups;
  }

  return { SIZE, FLAT_STDDEV, dhash, distance, popcount, toHex, fromHex, sameShape, group, grid9x8 };
}));
