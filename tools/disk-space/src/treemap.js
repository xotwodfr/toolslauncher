'use strict';
// Squarified treemap layout (Bruls, Huizing and van Wijk, 2000): splits a rectangle into one rectangle per value, each
// with an area proportional to its value, keeping the rectangles as close to squares as it can. Pure maths, no DOM, so the
// tests can check it. Used by the window (loaded as a plain script) and by the tests (require).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Treemap = factory();
})(typeof self !== 'undefined' ? self : this, () => {
  /** the worst aspect ratio of a row of areas laid along a side of length `side` */
  function worst(row, sum, side) {
    if (!row.length) return Infinity;
    let max = -Infinity; let min = Infinity;
    for (const a of row) { if (a > max) max = a; if (a < min) min = a; }
    const s2 = side * side; const sum2 = sum * sum;
    return Math.max((s2 * max) / sum2, sum2 / (s2 * min));
  }

  /**
   * @param {number[]} values  non-negative; any order (zero and invalid values get an empty rectangle)
   * @param {{x:number,y:number,w:number,h:number}} rect
   * @returns {{x:number,y:number,w:number,h:number}[]} one rectangle per value, in the order given
   */
  function squarify(values, rect) {
    const out = values.map(() => ({ x: rect.x, y: rect.y, w: 0, h: 0 }));
    const idx = [];
    let total = 0;
    values.forEach((v, i) => { if (Number.isFinite(v) && v > 0) { idx.push(i); total += v; } });
    if (!idx.length || !(rect.w > 0) || !(rect.h > 0)) return out;
    idx.sort((a, b) => values[b] - values[a]);
    const scale = (rect.w * rect.h) / total;
    const areas = idx.map((i) => values[i] * scale);
    let { x, y, w, h } = rect;
    let i = 0;
    while (i < areas.length) {
      const side = Math.min(w, h);
      const row = [areas[i]]; let sum = areas[i]; let j = i + 1;
      while (j < areas.length) {
        const next = sum + areas[j];
        if (worst([...row, areas[j]], next, side) > worst(row, sum, side)) break;
        row.push(areas[j]); sum = next; j++;
      }
      const last = j >= areas.length;
      if (w >= h) {
        // the row is a column along the left side
        const cw = last ? w : sum / h;
        let cy = y;
        for (let k = 0; k < row.length; k++) {
          const ch = k === row.length - 1 ? y + h - cy : row[k] / cw;
          out[idx[i + k]] = { x, y: cy, w: cw, h: ch };
          cy += ch;
        }
        x += cw; w -= cw;
      } else {
        const rh = last ? h : sum / w;
        let cx = x;
        for (let k = 0; k < row.length; k++) {
          const rw = k === row.length - 1 ? x + w - cx : row[k] / rh;
          out[idx[i + k]] = { x: cx, y, w: rw, h: rh };
          cx += rw;
        }
        y += rh; h -= rh;
      }
      if (w < 0) w = 0; if (h < 0) h = 0;
      i = j;
    }
    return out;
  }
  return { squarify, worst };
});
