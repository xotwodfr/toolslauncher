'use strict';
// The shared puzzle engine. Every puzzle (cubes, cuboids, Pyraminx, Megaminx) is described the same way, by its geometry:
//   - faces: each with an outward normal and an "up" direction (how the face is held when it is looked at / scanned)
//   - stickers: each on one face, with its centre and its outline (a polygon on the surface, in 3D)
//   - turns: an axis, the fraction of a full turn one step is, and which stickers move (a test on the sticker's centre)
// From that the engine works out, once, the sticker permutation of every turn (by rotating sticker centres in 3D and
// finding where they land), so turn tables can never disagree with the picture. It also projects every face to a flat
// 2D template (used by the fill-in map and the scanner). Loaded with require() in Node and a <script> tag in the window
// (window.PuzzleCore). No dependencies.
//
// Conventions (the same as cube.js, so 2x2/3x3 can be described with it too):
//   - A state is an array with one value per sticker (a colour key, a face letter, null for "not filled in" ...).
//   - A permutation p means: after the turn, sticker i shows what sticker p[i] showed (out[i] = in[p[i]]).
//   - A turn's positive direction is clockwise as seen from outside, looking at the face the axis points out of.
//   - A move is { turn: 'R', amount: k } with k in 1..order-1 (k = order-1 is "anticlockwise once"). Text is per puzzle.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PuzzleCore = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  const EPS = 1e-6;
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
  const norm = (a) => Math.hypot(a[0], a[1], a[2]);
  const unit = (a) => scale(a, 1 / norm(a));
  /** Rotates v by `angle` radians about the unit axis a (right-hand rule: positive = anticlockwise seen from the tip of a). */
  function rotate(v, a, angle) {
    const c = Math.cos(angle); const s = Math.sin(angle); const d = dot(a, v); const x = cross(a, v);
    return [0, 1, 2].map((k) => v[k] * c + x[k] * s + a[k] * d * (1 - c));
  }
  const centroid = (pts) => scale(pts.reduce(add, [0, 0, 0]), 1 / pts.length);

  /**
   * Builds a puzzle from its description.
   * @param {object} spec
   *   id, name                      e.g. 'pyraminx', 'Pyraminx'
   *   colours: { key: { name, hex } }   the colour set, in palette order
   *   faces: [{ id, name, normal, up, colour }]   colour = this face's colour in the standard scheme
   *   stickers: [{ face, centre, poly }]   poly: outline points in 3D (any winding; it is fixed here to anticlockwise seen
   *                                        from outside). Order = state order.
   *   turns: { name: { axis, order, select(centre) -> bool } }   axis is outward through the face of that name; order =
   *                                        steps in a full turn (4 for a square face, 2 for a non-square cuboid face, 3 for
   *                                        Pyraminx, 5 for Megaminx). select picks the stickers that move.
   *   net: [{ face, x, y, rotate }]      where each face's flat template goes on the fill-in map (template coordinates:
   *                                        x right, y DOWN, as on screen; rotate in degrees, clockwise)
   *   format(move) / parse(token)        optional notation; default: "R", "R2", "R'" style (order 4), "R" / "R'" (order 3),
   *                                        "R2" (order 2), "R", "R2", "R2'", "R'" (order 5)
   */
  function definePuzzle(spec) {
    const faces = spec.faces.map((f, i) => ({ ...f, index: i, normal: unit(f.normal), up: unit(f.up) }));
    const faceById = new Map(faces.map((f) => [f.id, f]));
    const stickers = spec.stickers.map((s, i) => {
      const face = faceById.get(s.face);
      if (!face) throw new Error(`sticker ${i}: unknown face ${s.face}`);
      let poly = s.poly.map((p) => p.slice());
      // anticlockwise seen from outside: (p1-p0) x (p2-p0) points outwards
      const n = cross(sub(poly[1], poly[0]), sub(poly[2], poly[0]));
      if (dot(n, face.normal) < 0) poly = poly.reverse();
      return { i, face: s.face, f: face.index, centre: s.centre.slice(), poly, normal: face.normal, ...(s.tag ? { tag: s.tag } : {}) };
    });
    const size = stickers.length;

    // Sticker lookup by (centre, face normal), rounded so floating-point error does not matter.
    const keyOf = (c, nrm) => c.map((v) => Math.round(v * 1e4)).join(',') + '|' + nrm.map((v) => Math.round(v * 1e3)).join(',');
    const index = new Map();
    for (const s of stickers) {
      const k = keyOf(s.centre, s.normal);
      if (index.has(k)) throw new Error(`stickers ${index.get(k)} and ${s.i} are in the same place`);
      index.set(k, s.i);
    }

    // ---- turns ----
    const turns = {};
    const turnNames = Object.keys(spec.turns);
    for (const name of turnNames) {
      const t = spec.turns[name];
      const axis = unit(t.axis);
      const angle = -2 * Math.PI / t.order; // clockwise seen from outside
      const p1 = Array.from({ length: size }, (_, i) => i);
      const moving = [];
      for (const s of stickers) {
        if (!t.select(s.centre, s)) continue;
        moving.push(s.i);
        const k = keyOf(rotate(s.centre, axis, angle), rotate(s.normal, axis, angle));
        const target = index.get(k);
        if (target === undefined) throw new Error(`turn ${name}: sticker ${s.i} has nowhere to go (is the turn's order or selection right?)`);
        p1[target] = s.i;
      }
      // must be a permutation
      const seen = new Uint8Array(size);
      for (const v of p1) { if (seen[v]) throw new Error(`turn ${name} is not a permutation`); seen[v] = 1; }
      const powers = [null, p1];
      for (let k = 2; k < t.order; k++) powers.push(compose(powers[k - 1], p1));
      turns[name] = { name, axis, order: t.order, angle, powers, moving };
    }

    // ---- notation ----
    const defaultFormat = (mv) => {
      const t = turns[mv.turn]; const k = mv.amount;
      if (t.order === 2) return mv.turn + '2';
      if (t.order === 4) return mv.turn + (k === 1 ? '' : k === 2 ? '2' : "'");
      if (t.order === 3) return mv.turn + (k === 1 ? '' : "'");
      if (k === t.order - 1) return mv.turn + "'";
      if (k > t.order / 2) return mv.turn + (t.order - k) + "'";
      return mv.turn + (k === 1 ? '' : k);
    };
    // longest names first so "BL" wins over "B"
    const byLength = turnNames.slice().sort((a, b) => b.length - a.length);
    const defaultParse = (tok) => {
      const s = String(tok).trim().replace(/’/g, "'");
      for (const name of byLength) {
        if (!s.startsWith(name)) continue;
        const rest = s.slice(name.length);
        const m = /^(\d*)('?)$/.exec(rest);
        if (!m) continue;
        const t = turns[name];
        let k = m[1] ? Number(m[1]) : 1;
        if (m[2]) k = -k;
        // a half-turn-only face: "R", "R2", "R'" and "R2'" all mean its one turn
        k = t.order === 2 ? 1 : ((k % t.order) + t.order) % t.order;
        return k ? { turn: name, amount: k } : null;
      }
      throw new Error(`"${tok}" is not a move on the ${spec.name}: use ${turnNames.join(', ')}`);
    };
    const formatMove = spec.format || defaultFormat;
    const parseToken = spec.parse || defaultParse;

    function parseMoves(text) {
      if (Array.isArray(text)) return text.map((m) => (typeof m === 'string' ? parseToken(m) : m)).filter(Boolean);
      return String(text || '').replace(/[()[\],]/g, ' ').trim().split(/\s+/).filter(Boolean).map(parseToken).filter(Boolean);
    }
    const formatMoves = (moves) => moves.map(formatMove).join(' ');
    const inverse = (moves) => moves.slice().reverse().map((m) => ({ turn: m.turn, amount: turns[m.turn].order - m.amount }));
    /** Merges neighbouring turns of the same layer and drops turns that cancel. */
    function simplify(moves) {
      const out = [];
      for (const m of moves) {
        const last = out[out.length - 1];
        if (last && last.turn === m.turn) {
          const k = (last.amount + m.amount) % turns[m.turn].order;
          out.pop();
          if (k) out.push({ turn: m.turn, amount: k });
        } else out.push({ turn: m.turn, amount: m.amount });
      }
      return out;
    }

    function applyMove(state, mv) {
      const t = turns[mv.turn];
      if (!t) throw new Error(`unknown turn ${mv.turn}`);
      const p = t.powers[((mv.amount % t.order) + t.order) % t.order];
      if (!p) return Array.from(state);
      const out = new Array(size);
      for (let i = 0; i < size; i++) out[i] = state[p[i]];
      return out;
    }
    function applyMoves(state, moves) {
      let cur = Array.from(state);
      if (cur.length !== size) throw new Error(`a ${spec.name} has ${size} stickers, not ${cur.length}`);
      for (const mv of (typeof moves === 'string' ? parseMoves(moves) : moves)) cur = applyMove(cur, mv);
      return cur;
    }

    const solvedColours = (scheme) => stickers.map((s) => (scheme || {})[s.face] || faceById.get(s.face).colour);
    const solvedFaces = () => stickers.map((s) => s.face);
    /** Solved = every face one colour (in any orientation of the whole puzzle). */
    function isSolved(state) {
      const seen = new Map();
      for (const s of stickers) {
        const v = state[s.i];
        if (v == null) return false;
        if (!seen.has(s.face)) seen.set(s.face, v); else if (seen.get(s.face) !== v) return false;
      }
      return new Set(seen.values()).size === seen.size;
    }

    function rngFrom(seed) {
      if (seed == null) return Math.random;
      let x = (seed >>> 0) || 1;
      return () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x / 4294967296; };
    }
    /** A random sequence (no two turns of the same layer in a row). `allowed` limits the turns used (default all). */
    function randomMoves(length, seed, allowed) {
      const rnd = rngFrom(seed);
      const names = allowed || spec.scrambleTurns || turnNames;
      const out = [];
      while (out.length < length) {
        const name = names[Math.floor(rnd() * names.length)];
        const last = out[out.length - 1];
        if (last && last.turn === name) continue;
        const order = turns[name].order;
        out.push({ turn: name, amount: 1 + Math.floor(rnd() * (order - 1)) });
      }
      return out;
    }

    // ---- flat face templates (fill-in map and scanner) ----
    // Each face is projected onto its plane, with "up" pointing up the screen. Coordinates: x right, y DOWN.
    const templates = {};
    for (const f of faces) {
      const right = cross(f.up, f.normal); // seen from outside: up x out = right
      const own = stickers.filter((s) => s.face === f.id);
      const origin = centroid(own.map((s) => s.centre));
      const to2 = (p) => { const d = sub(p, origin); return [dot(d, right), -dot(d, f.up)]; };
      const polys = own.map((s) => ({ i: s.i, poly: s.poly.map(to2).map(([x, y]) => [x, y]), centre: to2(s.centre) }));
      // flipping y keeps anticlockwise-from-outside as clockwise on screen; that is fine for drawing
      let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
      for (const p of polys) for (const [x, y] of p.poly) { minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); }
      // the face outline: the convex hull of all its sticker corners
      const outline = hull(polys.flatMap((p) => p.poly));
      templates[f.id] = { face: f.id, stickers: polys, box: { minX, minY, maxX, maxY, w: maxX - minX, h: maxY - minY }, outline };
    }

    /** Fill-in map: every sticker as a 2D polygon, laid out as spec.net says. Returns { cells: [{ i, poly, centre }], box }. */
    function netLayout() {
      const cells = [];
      for (const place of spec.net || []) {
        const t = templates[place.face];
        const a = (place.rotate || 0) * Math.PI / 180; const c = Math.cos(a); const s = Math.sin(a);
        const tf = ([x, y]) => [place.x + x * c - y * s, place.y + x * s + y * c];
        for (const st of t.stickers) cells.push({ i: st.i, face: place.face, poly: st.poly.map(tf), centre: tf(st.centre) });
      }
      let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
      for (const cl of cells) for (const [x, y] of cl.poly) { minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); }
      return { cells, box: { minX, minY, maxX, maxY, w: maxX - minX, h: maxY - minY } };
    }

    return {
      id: spec.id, name: spec.name, spec, faces, faceById, stickers, size, turns, turnNames, index,
      colours: spec.colours, colourKeys: Object.keys(spec.colours),
      formatMove, parseToken, parseMoves, formatMoves, inverse, simplify, applyMove, applyMoves,
      solvedColours, solvedFaces, isSolved, randomMoves, templates, netLayout,
      stickersOf: (faceId) => stickers.filter((s) => s.face === faceId).map((s) => s.i),
    };
  }

  /** p then q as permutations in our convention: out[i] = in[p[q[i]]] for "apply p, then q" -> compose(p, q)[i] = p[q[i]]. */
  function compose(p, q) { const r = new Array(p.length); for (let i = 0; i < p.length; i++) r[i] = p[q[i]]; return r; }

  function hull(points) {
    const pts = points.map((p) => [Math.round(p[0] * 1e6) / 1e6, Math.round(p[1] * 1e6) / 1e6]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const crossZ = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const lower = []; const upper = [];
    for (const p of pts) { while (lower.length >= 2 && crossZ(lower[lower.length - 2], lower[lower.length - 1], p) <= 1e-4) lower.pop(); lower.push(p); }
    for (let i = pts.length - 1; i >= 0; i--) { const p = pts[i]; while (upper.length >= 2 && crossZ(upper[upper.length - 2], upper[upper.length - 1], p) <= 1e-4) upper.pop(); upper.push(p); }
    return lower.slice(0, -1).concat(upper.slice(0, -1));
  }

  return { definePuzzle, compose, rotate, dot, cross, add, sub, scale, norm, unit, centroid, hull };
}));
