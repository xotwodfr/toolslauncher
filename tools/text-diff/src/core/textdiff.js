'use strict';
// The text diff engine. Plain JavaScript with no dependencies, so the same file runs in Node (tests, main process) and in
// the window's Web Worker (importScripts) and page (inline highlights). Nothing here touches files.
//
//  splitLines(text)                 -> { lines: [...], eols: [...] }   each line without its line ending, and the ending
//  diffLines(a, b, opts)            -> { blocks, stats }               a, b are splitLines() results
//      opts: { algorithm: 'myers' | 'patience', ignoreWhitespace, ignoreCase, ignoreEol }
//      blocks: [{ type: 'equal' | 'change', aStart, aEnd, bStart, bEnd }] covering both texts in order
//  buildRows(blocks)                -> rows for the side-by-side and unified views (typed arrays)
//  inlineDiff(a, b, mode, opts)     -> { a: [[from, to], ...], b: [...] } changed character ranges inside a changed line
//  makePatch(a, b, opts)            -> a unified diff (always from the exact texts, so it applies back cleanly)
//  groupHunks(blocks, context)      -> hunks with context lines, for the patch and the HTML report
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TextDiff = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  // ---- lines ---------------------------------------------------------------------------------------------------------------
  function splitLines(text) {
    const lines = []; const eols = [];
    const s = String(text == null ? '' : text);
    const re = /\r\n|\r|\n/g;
    let last = 0; let m;
    while ((m = re.exec(s))) { lines.push(s.slice(last, m.index)); eols.push(m[0]); last = m.index + m[0].length; }
    if (last < s.length) { lines.push(s.slice(last)); eols.push(''); }
    return { lines, eols };
  }

  /** "LF", "CRLF", "CR", "Mixed" or "None" */
  function lineEndingOf(split) {
    let lf = 0; let crlf = 0; let cr = 0;
    for (const e of split.eols) { if (e === '\n') lf++; else if (e === '\r\n') crlf++; else if (e === '\r') cr++; }
    const kinds = (lf > 0) + (crlf > 0) + (cr > 0);
    if (!kinds) return 'None';
    if (kinds > 1) return 'Mixed';
    return lf ? 'LF' : crlf ? 'CRLF' : 'CR';
  }

  function normaliser(opts) {
    const ws = !!(opts && opts.ignoreWhitespace); const ic = !!(opts && opts.ignoreCase);
    return (s) => { if (ws) s = s.replace(/\s+/g, ''); if (ic) s = s.toLowerCase(); return s; };
  }

  /** Turn both line lists into integer ids; equal ids = lines that count as the same under the options. */
  function toIds(a, b, opts) {
    const norm = normaliser(opts);
    const eol = !(opts && opts.ignoreEol);
    const map = new Map();
    const conv = (sp) => {
      const out = new Int32Array(sp.lines.length);
      for (let i = 0; i < sp.lines.length; i++) {
        let k = norm(sp.lines[i]);
        if (eol) k += '\u0000' + sp.eols[i];
        let id = map.get(k);
        if (id === undefined) { id = map.size; map.set(k, id); }
        out[i] = id;
      }
      return out;
    };
    return { A: conv(a), B: conv(b), count: map.size };
  }

  // ---- core algorithms on integer arrays ---------------------------------------------------------------------------------
  // Each algorithm reports matches (equal pairs) by calling keep(aIndex, bIndex, length) in increasing order.

  /**
   * Myers' O(ND) algorithm in linear space (divide at the middle snake). `budget` limits the work: when a piece is too
   * expensive (two long, very different texts), `fallback` handles it instead.
   */
  function myers(A, aLo, aHi, B, bLo, bHi, keep, budget, fallback) {
    // trim the common start and end
    while (aLo < aHi && bLo < bHi && A[aLo] === B[bLo]) { keep(aLo, bLo, 1); aLo++; bLo++; }
    let tail = 0;
    while (aHi > aLo && bHi > bLo && A[aHi - 1] === B[bHi - 1]) { aHi--; bHi--; tail++; }
    if (aLo < aHi && bLo < bHi) {
      const n = aHi - aLo; const m = bHi - bLo;
      const snake = middleSnake(A, aLo, n, B, bLo, m, budget);
      if (!snake) fallback(aLo, aHi, bLo, bHi);
      else {
        // after trimming, both sides differ at both ends, so the edit distance is at least 2 and the middle snake splits
        // the problem into two strictly smaller ones
        const [x, y, u, v] = snake; // absolute coordinates of the snake start (x, y) and end (u, v)
        myers(A, aLo, x, B, bLo, y, keep, budget, fallback);
        if (u > x) keep(x, y, u - x);
        myers(A, u, aHi, B, v, bHi, keep, budget, fallback);
      }
    }
    if (tail) keep(aHi, bHi, tail);
  }

  function middleSnake(A, a0, n, B, b0, m, budget) {
    const max = n + m;
    const delta = n - m;
    const odd = (delta & 1) !== 0;
    const offset = max + 1;
    const vf = new Int32Array(2 * max + 3);
    const vb = new Int32Array(2 * max + 3);
    vf[offset + 1] = 0; vb[offset + 1] = 0;
    const half = Math.ceil(max / 2);
    for (let d = 0; d <= half; d++) {
      budget.work += 2 * d + 1;
      if (budget.work > budget.limit) return null;
      for (let k = -d; k <= d; k += 2) {
        let x = (k === -d || (k !== d && vf[offset + k - 1] < vf[offset + k + 1])) ? vf[offset + k + 1] : vf[offset + k - 1] + 1;
        let y = x - k;
        const sx = x; const sy = y;
        while (x < n && y < m && A[a0 + x] === B[b0 + y]) { x++; y++; }
        vf[offset + k] = x;
        if (odd) {
          const kb = delta - k;
          if (kb >= -(d - 1) && kb <= d - 1 && x + vb[offset + kb] >= n) {
            const s = [a0 + sx, b0 + sy, a0 + x, b0 + y]; s.d = 2 * d - 1; return s;
          }
        }
      }
      for (let k = -d; k <= d; k += 2) {
        let x = (k === -d || (k !== d && vb[offset + k - 1] < vb[offset + k + 1])) ? vb[offset + k + 1] : vb[offset + k - 1] + 1;
        let y = x - k;
        const sx = x; const sy = y;
        while (x < n && y < m && A[a0 + n - x - 1] === B[b0 + m - y - 1]) { x++; y++; }
        vb[offset + k] = x;
        if (!odd) {
          const kf = delta - k;
          if (kf >= -d && kf <= d && vf[offset + kf] + x >= n) {
            const s = [a0 + n - x, b0 + m - y, a0 + n - sx, b0 + m - sy]; s.d = 2 * d; return s;
          }
        }
      }
    }
    return null; // not reached for valid input
  }

  /**
   * Patience diff: lines that occur exactly once on both sides are anchors; the longest run of anchors in the same order
   * (patience sorting) splits the texts, and each gap is diffed again (by patience, then by Myers when it has no anchors).
   */
  function patience(A, aLo, aHi, B, bLo, bHi, keep, budget, fallback) {
    while (aLo < aHi && bLo < bHi && A[aLo] === B[bLo]) { keep(aLo, bLo, 1); aLo++; bLo++; }
    let tail = 0;
    while (aHi > aLo && bHi > bLo && A[aHi - 1] === B[bHi - 1]) { aHi--; bHi--; tail++; }
    if (aLo < aHi && bLo < bHi) {
      const anchors = uniqueAnchors(A, aLo, aHi, B, bLo, bHi);
      if (!anchors.length) myers(A, aLo, aHi, B, bLo, bHi, keep, budget, fallback);
      else {
        let pa = aLo; let pb = bLo;
        for (const [ai, bi] of anchors) {
          patience(A, pa, ai, B, pb, bi, keep, budget, fallback);
          // extend the anchor forwards as long as lines match (the gap after it will trim the rest anyway)
          keep(ai, bi, 1);
          pa = ai + 1; pb = bi + 1;
        }
        patience(A, pa, aHi, B, pb, bHi, keep, budget, fallback);
      }
    }
    if (tail) keep(aHi, bHi, tail);
  }

  function uniqueAnchors(A, aLo, aHi, B, bLo, bHi) {
    const ca = new Map();
    for (let i = aLo; i < aHi; i++) { const e = ca.get(A[i]); if (e) e.n++; else ca.set(A[i], { n: 1, i }); }
    const cb = new Map();
    for (let j = bLo; j < bHi; j++) { const e = cb.get(B[j]); if (e) e.n++; else cb.set(B[j], { n: 1, j }); }
    const pairs = [];
    for (let i = aLo; i < aHi; i++) {
      const ea = ca.get(A[i]);
      if (ea.n !== 1) continue;
      const eb = cb.get(A[i]);
      if (eb && eb.n === 1) pairs.push([i, eb.j]);
    }
    if (!pairs.length) return pairs;
    // longest increasing subsequence on the b index (pairs are already in a order)
    const tails = []; const prev = new Int32Array(pairs.length);
    for (let p = 0; p < pairs.length; p++) {
      const bj = pairs[p][1];
      let lo = 0; let hi = tails.length;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (pairs[tails[mid]][1] < bj) lo = mid + 1; else hi = mid; }
      prev[p] = lo > 0 ? tails[lo - 1] : -1;
      tails[lo] = p;
    }
    const out = [];
    for (let p = tails[tails.length - 1]; p >= 0; p = prev[p]) out.push(pairs[p]);
    return out.reverse();
  }

  // ---- line diff ---------------------------------------------------------------------------------------------------------
  const DEFAULT_LIMIT = 60e6; // units of Myers work before a piece is handed to the cheaper fallback

  function diffLines(a, b, opts) {
    opts = opts || {};
    const { A, B } = toIds(a, b, opts);
    const matches = []; // [aStart, bStart, length] runs, merged
    const keep = (ai, bi, len) => {
      const last = matches[matches.length - 1];
      if (last && last[0] + last[2] === ai && last[1] + last[2] === bi) last[2] += len;
      else matches.push([ai, bi, len]);
    };
    const budget = { work: 0, limit: opts.workLimit || DEFAULT_LIMIT };
    let approximate = false;
    // When Myers would take too long, anchor on unique lines; with no anchors, the piece is shown as replaced.
    const fallback = (aLo, aHi, bLo, bHi) => {
      approximate = true;
      const anchors = uniqueAnchors(A, aLo, aHi, B, bLo, bHi);
      let pa = aLo; let pb = bLo;
      for (const [ai, bi] of anchors) {
        // match the same lines around each anchor cheaply (greedy, no search)
        let s = ai; let t = bi;
        while (s > pa && t > pb && A[s - 1] === B[t - 1]) { s--; t--; }
        let e = ai + 1; let f = bi + 1;
        while (e < aHi && f < bHi && A[e] === B[f]) { e++; f++; }
        if (s >= pa && t >= pb && s < e) { keep(s, t, e - s); pa = e; pb = f; }
      }
    };
    const algo = opts.algorithm === 'patience' ? patience : myers;
    algo(A, 0, A.length, B, 0, B.length, keep, budget, fallback);

    const blocks = [];
    let ai = 0; let bi = 0;
    const pushChange = (aEnd, bEnd) => { if (aEnd > ai || bEnd > bi) blocks.push({ type: 'change', aStart: ai, aEnd, bStart: bi, bEnd }); };
    for (const [ma, mb, len] of matches) {
      pushChange(ma, mb);
      blocks.push({ type: 'equal', aStart: ma, aEnd: ma + len, bStart: mb, bEnd: mb + len });
      ai = ma + len; bi = mb + len;
    }
    pushChange(A.length, B.length);
    // merge equal blocks that touch (can happen across recursion edges)
    const merged = [];
    for (const blk of blocks) {
      const last = merged[merged.length - 1];
      if (last && last.type === blk.type) { last.aEnd = blk.aEnd; last.bEnd = blk.bEnd; } else merged.push(blk);
    }
    return { blocks: merged, stats: statsOf(merged), approximate };
  }

  function statsOf(blocks) {
    const s = { changes: 0, added: 0, removed: 0, modified: 0, same: 0 };
    for (const b of blocks) {
      const na = b.aEnd - b.aStart; const nb = b.bEnd - b.bStart;
      if (b.type === 'equal') { s.same += na; continue; }
      s.changes++;
      const paired = Math.min(na, nb);
      s.modified += paired; s.removed += na - paired; s.added += nb - paired;
    }
    return s;
  }

  // ---- rows for the views ---------------------------------------------------------------------------------------------------
  // kind: 0 same, 1 changed (both sides), 2 removed (left only), 3 added (right only)
  function buildRows(blocks) {
    let side = 0; let uni = 0;
    for (const b of blocks) {
      const na = b.aEnd - b.aStart; const nb = b.bEnd - b.bStart;
      side += b.type === 'equal' ? na : Math.max(na, nb);
      uni += b.type === 'equal' ? na : na + nb;
    }
    const S = { left: new Int32Array(side), right: new Int32Array(side), kind: new Uint8Array(side), hunk: new Int32Array(side) };
    const U = { left: new Int32Array(uni), right: new Int32Array(uni), kind: new Uint8Array(uni), hunk: new Int32Array(uni) };
    const hunks = [];
    let r = 0; let u = 0; let h = -1;
    for (const b of blocks) {
      const na = b.aEnd - b.aStart; const nb = b.bEnd - b.bStart;
      if (b.type === 'equal') {
        for (let i = 0; i < na; i++) {
          S.left[r] = b.aStart + i; S.right[r] = b.bStart + i; S.kind[r] = 0; S.hunk[r] = -1; r++;
          U.left[u] = b.aStart + i; U.right[u] = b.bStart + i; U.kind[u] = 0; U.hunk[u] = -1; u++;
        }
        continue;
      }
      h++;
      hunks.push({ index: h, aStart: b.aStart, aEnd: b.aEnd, bStart: b.bStart, bEnd: b.bEnd, sideRow: r, sideRows: Math.max(na, nb), uniRow: u, uniRows: na + nb });
      const n = Math.max(na, nb);
      for (let i = 0; i < n; i++) {
        const hasA = i < na; const hasB = i < nb;
        S.left[r] = hasA ? b.aStart + i : -1; S.right[r] = hasB ? b.bStart + i : -1;
        S.kind[r] = hasA && hasB ? 1 : hasA ? 2 : 3; S.hunk[r] = h; r++;
      }
      const paired = Math.min(na, nb);
      for (let i = 0; i < na; i++) { U.left[u] = b.aStart + i; U.right[u] = i < paired ? b.bStart + i : -1; U.kind[u] = 2; U.hunk[u] = h; u++; }
      for (let i = 0; i < nb; i++) { U.left[u] = i < paired ? b.aStart + i : -1; U.right[u] = b.bStart + i; U.kind[u] = 3; U.hunk[u] = h; u++; }
    }
    return { side: S, unified: U, hunks };
  }

  // ---- inside a changed line ---------------------------------------------------------------------------------------------------
  const WORD_RE = /[\p{L}\p{N}_]+|\s+|[^\p{L}\p{N}_\s]/gu;
  function tokens(s, mode) {
    if (mode === 'char') return Array.from(s);
    return s.match(WORD_RE) || [];
  }

  /** Simple Myers with a full trace on small token lists; returns the matched token pairs. */
  function lcsPairs(x, y, eq) {
    const n = x.length; const m = y.length; const max = n + m; const off = max + 1;
    const v = new Int32Array(2 * max + 3);
    const trace = [];
    let found = -1;
    for (let d = 0; d <= max; d++) {
      trace.push(v.slice());
      for (let k = -d; k <= d; k += 2) {
        let px = (k === -d || (k !== d && v[off + k - 1] < v[off + k + 1])) ? v[off + k + 1] : v[off + k - 1] + 1;
        let py = px - k;
        while (px < n && py < m && eq(x[px], y[py])) { px++; py++; }
        v[off + k] = px;
        if (px >= n && py >= m) { found = d; break; }
      }
      if (found >= 0) break;
    }
    const pairs = [];
    let px = n; let py = m;
    for (let d = found; d >= 0; d--) {
      const vv = trace[d]; const k = px - py;
      let prevK;
      if (d === 0) prevK = 0;
      else prevK = (k === -d || (k !== d && vv[off + k - 1] < vv[off + k + 1])) ? k + 1 : k - 1;
      const startX = d === 0 ? 0 : vv[off + prevK];
      const startY = startX - prevK;
      const snakeFromX = d === 0 ? 0 : (prevK === k + 1 ? startX : startX + 1);
      const snakeFromY = snakeFromX - k;
      while (px > snakeFromX && py > snakeFromY) { px--; py--; pairs.push([px, py]); }
      px = startX; py = startY;
    }
    return pairs.reverse();
  }

  /**
   * Changed ranges inside a pair of changed lines. mode 'word' or 'char'. Returns null when the lines have too little in
   * common to make highlighting useful (then the whole line is the change) or are too long to compare quickly.
   */
  function inlineDiff(a, b, mode, opts) {
    a = String(a); b = String(b);
    if (a.length > 4000 || b.length > 4000) return null;
    const ta = tokens(a, mode); const tb = tokens(b, mode);
    if (ta.length * tb.length > 4e6) return null;
    const norm = normaliser(opts);
    const ws = !!(opts && opts.ignoreWhitespace);
    const eq = (p, q) => p === q || (norm(p) === norm(q) && (!ws || norm(p) !== '' || (/^\s+$/.test(p) && /^\s+$/.test(q))));
    const pairs = lcsPairs(ta, tb, eq);
    const sameA = new Uint8Array(ta.length); const sameB = new Uint8Array(tb.length);
    for (const [i, j] of pairs) { sameA[i] = 1; sameB[j] = 1; }
    if (ws) { // whitespace never counts as a change when it is ignored
      ta.forEach((t, i) => { if (/^\s+$/.test(t)) sameA[i] = 1; });
      tb.forEach((t, j) => { if (/^\s+$/.test(t)) sameB[j] = 1; });
    }
    const ranges = (toks, same) => {
      const out = []; let pos = 0;
      for (let i = 0; i < toks.length; i++) {
        const len = toks[i].length;
        if (!same[i]) { const last = out[out.length - 1]; if (last && last[1] === pos) last[1] = pos + len; else out.push([pos, pos + len]); }
        pos += len;
      }
      return out;
    };
    const ra = ranges(ta, sameA); const rb = ranges(tb, sameB);
    // with words, join changes separated by a single space so "a b c" -> "x y z" is one highlight, not three
    if (mode !== 'char') { joinSmallGaps(ra, a); joinSmallGaps(rb, b); }
    const kept = (r) => r.reduce((n, [f, t]) => n + t - f, 0);
    const total = a.length + b.length;
    const common = total - kept(ra) - kept(rb);
    if (total > 12 && common / total < 0.3) return null;
    return { a: ra, b: rb };
  }
  function joinSmallGaps(r, s) {
    for (let i = r.length - 2; i >= 0; i--) {
      const gap = s.slice(r[i][1], r[i + 1][0]);
      if (gap.length <= 1 && /^\s?$/.test(gap)) { r[i][1] = r[i + 1][1]; r.splice(i + 1, 1); }
    }
  }

  // ---- unified patch -----------------------------------------------------------------------------------------------------------
  /** Group change blocks into hunks with `context` lines of the unchanged text around them. */
  function groupHunks(blocks, context, aLen, bLen) {
    const ctx = context == null ? 3 : context;
    const out = [];
    let cur = null;
    for (const blk of blocks) {
      if (blk.type !== 'change') continue;
      const aFrom = Math.max(0, blk.aStart - ctx); const bFrom = Math.max(0, blk.bStart - ctx);
      if (cur && blk.aStart - cur.aEndChange <= 2 * ctx) { cur.changes.push(blk); cur.aEndChange = blk.aEnd; cur.bEndChange = blk.bEnd; }
      else {
        if (cur) out.push(cur);
        cur = { aStart: aFrom, bStart: bFrom, changes: [blk], aEndChange: blk.aEnd, bEndChange: blk.bEnd };
      }
    }
    if (cur) out.push(cur);
    for (const h of out) { h.aEnd = Math.min(aLen, h.aEndChange + ctx); h.bEnd = Math.min(bLen, h.bEndChange + ctx); }
    return out;
  }

  /**
   * A unified diff of the exact texts (no ignore options, so it always applies back). Line endings are kept as they are
   * in the files; a last line without a line ending gets the usual "\ No newline at end of file" marker.
   */
  function makePatch(a, b, opts) {
    opts = opts || {};
    const { blocks } = diffLines(a, b, { algorithm: opts.algorithm });
    const hunks = groupHunks(blocks, opts.context, a.lines.length, b.lines.length);
    const aName = opts.aName || 'left'; const bName = opts.bName || 'right';
    let out = '';
    if (opts.header !== false) out += `--- ${aName}${opts.aDate ? '\t' + opts.aDate : ''}\n+++ ${bName}${opts.bDate ? '\t' + opts.bDate : ''}\n`;
    const line = (prefix, sp, i) => {
      const eol = sp.eols[i];
      return prefix + sp.lines[i] + (eol === '' ? '\n\\ No newline at end of file\n' : eol === '\r\n' ? '\r\n' : eol === '\r' ? '\r\n' : '\n');
    };
    for (const h of hunks) {
      const aCount = h.aEnd - h.aStart; const bCount = h.bEnd - h.bStart;
      const range = (start, count) => (count === 0 ? `${start},0` : count === 1 ? `${start + 1}` : `${start + 1},${count}`);
      out += `@@ -${range(h.aStart, aCount)} +${range(h.bStart, bCount)} @@\n`;
      let ai = h.aStart; let bi = h.bStart;
      for (const c of h.changes) {
        while (ai < c.aStart) { out += line(' ', a, ai); ai++; bi++; }
        for (let i = c.aStart; i < c.aEnd; i++) out += line('-', a, i);
        for (let j = c.bStart; j < c.bEnd; j++) out += line('+', b, j);
        ai = c.aEnd; bi = c.bEnd;
      }
      while (ai < h.aEnd) { out += line(' ', a, ai); ai++; bi++; }
    }
    return out;
  }

  // ---- merging -------------------------------------------------------------------------------------------------------------
  /**
   * Build the merged text: unchanged parts come from the left, each change from the side picked for it
   * (choices[i] = 'left' | 'right' | 'both' for the i-th change block; default 'left').
   */
  function mergeText(a, b, blocks, choices) {
    let out = '';
    let h = 0;
    const take = (sp, from, to) => { for (let i = from; i < to; i++) out += sp.lines[i] + sp.eols[i]; };
    for (const blk of blocks) {
      if (blk.type === 'equal') { take(a, blk.aStart, blk.aEnd); continue; }
      const c = (choices && choices[h]) || 'left';
      if (c === 'left' || c === 'both') take(a, blk.aStart, blk.aEnd);
      if (c === 'right' || c === 'both') {
        // a left part without a final line ending followed by more text would glue two lines together
        if (c === 'both' && out && !/[\r\n]$/.test(out) && blk.bEnd > blk.bStart) out += dominantEol(a);
        take(b, blk.bStart, blk.bEnd);
      }
      h++;
    }
    return out;
  }
  function dominantEol(sp) { const e = lineEndingOf(sp); return e === 'CRLF' ? '\r\n' : e === 'CR' ? '\r' : '\n'; }

  return { splitLines, lineEndingOf, diffLines, statsOf, buildRows, inlineDiff, tokens, groupHunks, makePatch, mergeText, uniqueAnchors };
}));
