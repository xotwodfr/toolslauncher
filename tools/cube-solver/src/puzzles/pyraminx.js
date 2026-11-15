'use strict';
// The Pyraminx: a tetrahedron with 4 faces of 9 triangular stickers (36 stickers).
//
// Held with one face flat on the table (D, yellow in the standard scheme) and one face looking at you (F, green); the left
// face (L) is then red and the right face (R) blue. Its four corners are U (top), L (front-left), R (front-right) and
// B (back). The pieces: 4 tips (3 stickers each, they only twist), 4 centres (the 3 stickers just below each tip, they only
// twist), 6 edges (2 stickers each, they move and flip).
//
// Notation (WCA): U, L, R, B turn the corner of that name together with the layer under it (two layers) a third of a turn
// clockwise, seen looking at that corner from outside; U' etc. anticlockwise. Lowercase u, l, r, b turn only the tip.
//
// Sticker order: faces F, L, R, D, each read row by row as the face template shows it (the triangle standing on its base,
// apex up): row 1 = the tip (1 sticker), row 2 = 3 stickers (left to right), row 3 = 5 stickers (left to right). The apex of
// F, L and R is the top corner U; the apex of D is the back corner B (D is seen from below with the green face's edge at the
// bottom). So sticker f*9 + 0 is a tip, f*9 + 2 a centre, f*9 + 1, 3 edges, f*9 + 4, 8 tips, f*9 + 5, 7 centres, f*9 + 6 an edge.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('../puzzle-core'));
  else { const def = factory(root.PuzzleCore); (root.Puzzles = root.Puzzles || {})[def.id] = def; }
}(typeof self !== 'undefined' ? self : this, function (PC) {
  const { dot, cross, add, sub, scale, unit, norm } = PC;
  const S6 = Math.sqrt(6); const S2 = Math.sqrt(2);
  // A regular tetrahedron with its centre at the origin, circumradius 3 (edge 2*sqrt(6)), the top corner straight up.
  const VERT = { U: [0, 3, 0], L: [-S6, -1, S2], R: [S6, -1, S2], B: [0, -1, -2 * S2] };
  const VERTS = ['U', 'L', 'R', 'B'];
  const FACE_IDS = ['F', 'L', 'R', 'D'];
  const FACE_VERTS = { F: ['U', 'L', 'R'], L: ['U', 'L', 'B'], R: ['U', 'R', 'B'], D: ['L', 'R', 'B'] };
  const FACE_APEX = { F: 'U', L: 'U', R: 'U', D: 'B' };
  const OPPOSITE_FACE = { U: 'D', L: 'R', R: 'L', B: 'F' }; // the face that does not touch each corner
  const FACE_NAME = { F: 'Front', L: 'Left', R: 'Right', D: 'Bottom' };
  const FACE_WORD = { F: 'front', L: 'left', R: 'right', D: 'bottom' };
  const CORNER_WORD = { U: 'top', L: 'front-left', R: 'front-right', B: 'back' };
  const STANDARD = { F: 'g', L: 'r', R: 'b', D: 'y' };
  const colours = {
    g: { name: 'green', hex: '#009b48' },
    r: { name: 'red', hex: '#c41e3a' },
    b: { name: 'blue', hex: '#0046ad' },
    y: { name: 'yellow', hex: '#ffd500' },
  };
  const COLOURS = Object.keys(colours);

  // ---- geometry ----
  const faceCentroid = (f) => scale(FACE_VERTS[f].map((v) => VERT[v]).reduce(add, [0, 0, 0]), 1 / 3);
  const faces = []; const stickers = [];
  for (const f of FACE_IDS) {
    const normal = unit(scale(VERT[Object.keys(OPPOSITE_FACE).find((v) => OPPOSITE_FACE[v] === f)], -1));
    const c0 = faceCentroid(f);
    const A = VERT[FACE_APEX[f]];
    const up = unit(sub(A, c0));
    const right = cross(up, normal);
    const [p, q] = FACE_VERTS[f].filter((v) => v !== FACE_APEX[f]).map((v) => VERT[v]);
    const [Bv, Cv] = dot(sub(p, c0), right) < dot(sub(q, c0), right) ? [p, q] : [q, p]; // bottom-left, bottom-right
    faces.push({ id: f, name: FACE_NAME[f], normal, up, colour: STANDARD[f] });
    const P = (a, b, c) => scale(add(add(scale(A, a), scale(Bv, b)), scale(Cv, c)), 1 / 3);
    for (let r = 0; r < 3; r++) {
      for (let k = 0; k < 2 * r + 1; k++) {
        const j = k >> 1;
        const poly = k % 2 === 0
          ? [P(3 - r, r - j, j), P(2 - r, r - j + 1, j), P(2 - r, r - j, j + 1)] // pointing up
          : [P(3 - r, r - j, j), P(3 - r, r - j - 1, j + 1), P(2 - r, r - j, j + 1)]; // pointing down
        stickers.push({ face: f, centre: PC.centroid(poly), poly });
      }
    }
  }
  const AX = Object.fromEntries(VERTS.map((v) => [v, unit(VERT[v])]));
  // Along a corner's axis the corner is at 3 and the opposite face at -1: the tip is the part above 5/3, the tip and the
  // layer under it the part above 1/3 (sticker centres sit at 19/9, 11/9, 7/9 or below 0).
  const turns = {};
  for (const v of VERTS) turns[v] = { axis: AX[v], order: 3, select: (c) => dot(c, AX[v]) > 1 / 3 };
  for (const v of VERTS) turns[v.toLowerCase()] = { axis: AX[v], order: 3, select: (c) => dot(c, AX[v]) > 5 / 3 };

  // ---- pieces (sticker indices, from the geometry) ----
  const near = (x, y) => Math.abs(x - y) < 1e-6;
  const proj = (i, v) => dot(stickers[i].centre, AX[v]);
  const faceIdx = (i) => FACE_IDS.indexOf(stickers[i].face);
  // three stickers round a corner, anticlockwise seen from outside, starting on the first face in F, L, R, D order
  function aroundCorner(list, v) {
    const a = AX[v]; const e1 = unit(cross(a, Math.abs(a[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0])); const e2 = cross(a, e1);
    const ang = (i) => Math.atan2(dot(stickers[i].centre, e2), dot(stickers[i].centre, e1));
    const sorted = list.slice().sort((x, y) => ang(x) - ang(y));
    const start = sorted.indexOf(sorted.slice().sort((x, y) => faceIdx(x) - faceIdx(y))[0]);
    return sorted.slice(start).concat(sorted.slice(0, start));
  }
  const all = stickers.map((_, i) => i);
  const TIPS = VERTS.map((v) => aroundCorner(all.filter((i) => near(proj(i, v), 19 / 9)), v));
  const CENTRES = VERTS.map((v) => aroundCorner(all.filter((i) => near(proj(i, v), 11 / 9)), v));
  const EDGE_VERTS = [['U', 'L'], ['U', 'R'], ['L', 'R'], ['U', 'B'], ['L', 'B'], ['R', 'B']];
  let EDGES = EDGE_VERTS.map(([v, w]) => all.filter((i) => near(proj(i, v), 7 / 9) && near(proj(i, w), 7 / 9)).sort((x, y) => faceIdx(x) - faceIdx(y)));
  const EDGE_FACES_OF = (e) => e.map((i) => stickers[i].face);
  const EDGE_PLACE = EDGES.map((e) => {
    const fs = EDGE_FACES_OF(e);
    if (!fs.includes('F') && !fs.includes('D')) return 'back';
    return fs.map((f) => FACE_WORD[f]).join('-');
  });

  const puzzle = PC.definePuzzle({
    id: 'pyraminx', name: 'Pyraminx', colours, faces, stickers, turns,
    scrambleTurns: ['U', 'L', 'R', 'B'],
    net: [], // filled in below, once the templates exist
    parse(tok) {
      const s = String(tok).trim().replace(/’/g, "'");
      const m = /^([ULRBulrb])(2?)('?)$/.exec(s);
      if (!m) throw new Error(`"${tok}" is not a Pyraminx move: use U, L, R or B (a corner and the layer under it) or u, l, r, b (just the tip), optionally followed by '`);
      let k = m[2] ? 2 : 1; if (m[3]) k = 3 - k;
      return { turn: m[1], amount: k };
    },
  });

  // Edge orientation: pick which sticker of each edge place is its "first" one so that every turn flips an even number of
  // edges. Then the number of flipped edges is always even on a real Pyraminx.
  {
    const P1 = VERTS.map((v) => puzzle.turns[v].powers[1]);
    let found = null;
    for (let mask = 0; mask < 64 && !found; mask++) {
      const E = EDGES.map((e, k) => ((mask >> k) & 1 ? [e[1], e[0]] : e));
      const owner = new Map(); E.forEach((e, k) => e.forEach((s, j) => owner.set(s, [k, j])));
      if (P1.every((p) => E.reduce((n, e) => n + owner.get(p[e[0]])[1], 0) % 2 === 0)) found = E;
    }
    if (!found) throw new Error('pyraminx: no edge orientation labelling');
    EDGES = found;
  }

  // ---- fill-in map: the classic unfolding, a big triangle (point down) with the front face in the middle, the left and
  // right faces folded out to its sides and the bottom face folded out below it.
  {
    const to2 = (f, p) => {
      const face = puzzle.faceById.get(f); const right = cross(face.up, face.normal);
      const d = sub(p, faceCentroid(f)); return [dot(d, right), -dot(d, face.up)];
    };
    const n = {}; for (const v of ['U', 'L', 'R']) n[v] = to2('F', VERT[v]);
    const comb = (a, b, c) => [a[0] + b[0] - c[0], a[1] + b[1] - c[1]];
    const GAP = 0.35;
    const netPos = { F: n, L: { U: n.U, L: n.L, B: comb(n.U, n.L, n.R) }, R: { U: n.U, R: n.R, B: comb(n.U, n.R, n.L) }, D: { L: n.L, R: n.R, B: comb(n.L, n.R, n.U) } };
    for (const f of FACE_IDS) {
      const vs = FACE_VERTS[f]; const tgt = netPos[f]; const src = Object.fromEntries(vs.map((v) => [v, to2(f, VERT[v])]));
      const [a, b] = vs;
      const ang = Math.atan2(tgt[b][1] - tgt[a][1], tgt[b][0] - tgt[a][0]) - Math.atan2(src[b][1] - src[a][1], src[b][0] - src[a][0]);
      const c = Math.cos(ang); const s = Math.sin(ang);
      const rot = ([x, y]) => [x * c - y * s, x * s + y * c];
      const ra = rot(src[a]);
      let off = [tgt[a][0] - ra[0], tgt[a][1] - ra[1]];
      for (const v of vs) { const r = rot(src[v]); if (Math.hypot(r[0] + off[0] - tgt[v][0], r[1] + off[1] - tgt[v][1]) > 1e-6) throw new Error('pyraminx: net does not fold'); }
      if (f !== 'F') { const len = Math.hypot(off[0], off[1]); off = [off[0] * (1 + GAP / len), off[1] * (1 + GAP / len)]; }
      puzzle.spec.net.push({ face: f, x: off[0], y: off[1], rotate: Math.round(ang * 180 / Math.PI * 1e6) / 1e6 });
    }
  }

  // ---- pieces <-> stickers ----
  // A state of pieces: ep[i] = which edge is at place i, eo[i] = 1 when it is flipped; cc[v] / tt[v] = how far the centre /
  // tip of corner v is twisted (0, 1, 2). Face letters are the faces the stickers belong to when solved.
  const HOME_CENTRE = CENTRES.map((c) => c.map((i) => stickers[i].face));
  const HOME_TIP = TIPS.map((c) => c.map((i) => stickers[i].face));
  const HOME_EDGE = EDGES.map((e) => e.map((i) => stickers[i].face));
  const shiftOf = (letters, home) => { for (let c = 0; c < 3; c++) if ([0, 1, 2].every((k) => letters[k] === home[(k + c) % 3])) return c; return -1; };
  function readPieces(faceLetters) {
    const ep = []; const eo = [];
    for (const e of EDGES) {
      const [a, b] = e.map((i) => faceLetters[i]);
      let j = HOME_EDGE.findIndex((h) => h[0] === a && h[1] === b);
      if (j >= 0) { ep.push(j); eo.push(0); continue; }
      j = HOME_EDGE.findIndex((h) => h[0] === b && h[1] === a);
      if (j < 0) return null;
      ep.push(j); eo.push(1);
    }
    const cc = CENTRES.map((c, v) => shiftOf(c.map((i) => faceLetters[i]), HOME_CENTRE[v]));
    const tt = TIPS.map((c, v) => shiftOf(c.map((i) => faceLetters[i]), HOME_TIP[v]));
    if (cc.includes(-1) || tt.includes(-1)) return null;
    return { ep, eo, cc, tt };
  }
  function fromPieces({ ep, eo, cc, tt }) {
    const out = puzzle.solvedFaces();
    EDGES.forEach((e, i) => { for (let k = 0; k < 2; k++) out[e[(k + eo[i]) % 2]] = HOME_EDGE[ep[i]][k]; });
    CENTRES.forEach((c, v) => { for (let k = 0; k < 3; k++) out[c[k]] = HOME_CENTRE[v][(k + cc[v]) % 3]; });
    TIPS.forEach((c, v) => { for (let k = 0; k < 3; k++) out[c[k]] = HOME_TIP[v][(k + tt[v]) % 3]; });
    return out;
  }
  function parity(p) {
    let s = 0; const seen = new Array(p.length).fill(false);
    for (let i = 0; i < p.length; i++) { if (seen[i]) continue; let len = 0; for (let j = i; !seen[j]; j = p[j]) { seen[j] = true; len++; } s += len - 1; }
    return s % 2;
  }

  // ---- validation ----
  const word = (c) => (colours[c] ? colours[c].name : 'empty');
  const list = (w) => (w.length <= 1 ? w.join('') : w.slice(0, -1).join(', ') + ' and ' + w[w.length - 1]);
  const plural = (k, one, many) => `${k} ${k === 1 ? one : many}`;
  const centreName = (v) => `centre at the ${CORNER_WORD[VERTS[v]]} corner`;
  const tipName = (v) => `${CORNER_WORD[VERTS[v]]} tip`;
  const edgeWhere = (i) => (EDGE_PLACE[i] === 'back' ? 'back edge (between the left and right faces)' : `${EDGE_PLACE[i]} edge`);
  const allEdgeStickers = EDGES.flat();

  /**
   * Checks a Pyraminx that was filled in or scanned (colours: one colour key or null per sticker). Returns
   *   { ok, solved, faces, colourOf, errors: [{ kind, text, stickers }], summary }
   * faces = face letters to solve (when ok); colourOf = face letter -> colour. Kinds: empty, count, centre, tip, edge,
   * duplicate, missing, flip, parity.
   */
  function validate(cols) {
    const errors = [];
    const res = { ok: false, solved: false, faces: null, colourOf: null, errors };
    const done = () => {
      if (res.ok) res.summary = res.solved ? 'This Pyraminx is already solved.' : 'This Pyraminx can be solved.';
      else res.summary = errors.length === 1 ? errors[0].text : `${errors.length} problems: ${errors[0].text}`;
      return res;
    };
    if (!cols || cols.length !== puzzle.size) {
      errors.push({ kind: 'empty', text: `A Pyraminx has ${puzzle.size} stickers.`, stickers: [] });
      return done();
    }
    const empty = []; cols.forEach((c, i) => { if (!COLOURS.includes(c)) empty.push(i); });
    if (empty.length) {
      errors.push({ kind: 'empty', text: `${plural(empty.length, 'sticker is', 'stickers are')} not filled in yet.`, stickers: empty });
      return done();
    }
    const count = Object.fromEntries(COLOURS.map((c) => [c, 0])); for (const c of cols) count[c]++;
    const off = COLOURS.filter((c) => count[c] !== 9);
    if (off.length) {
      const w = off.map((c) => `${count[c]} ${word(c)}`);
      errors.push({ kind: 'count', text: `Every colour must appear exactly 9 times (one whole face), but there ${count[off[0]] === 1 ? 'is' : 'are'} ${list(w)}.`, stickers: [] });
    }
    // centres: each has three different colours, and the colour it lacks is the colour of the face opposite its corner
    let centreTrouble = false;
    CENTRES.forEach((c, v) => {
      const cs = c.map((i) => cols[i]);
      const twice = cs.find((x, k) => cs.indexOf(x) !== k);
      if (twice) { centreTrouble = true; errors.push({ kind: 'centre', text: `The ${centreName(v)} (the three stickers just below the tip) has two ${word(twice)} stickers. Each centre piece has three different colours.`, stickers: c.slice() }); }
    });
    if (centreTrouble) return done();
    const lacks = CENTRES.map((c) => COLOURS.find((x) => !c.some((i) => cols[i] === x)));
    for (const x of COLOURS) {
      const vs = lacks.map((l, v) => (l === x ? v : -1)).filter((v) => v >= 0);
      if (vs.length > 1) {
        centreTrouble = true;
        const same = COLOURS.filter((y) => y !== x).map(word);
        errors.push({ kind: 'centre', text: `The centres at the ${list(vs.map((v) => CORNER_WORD[VERTS[v]]))} corners ${vs.length === 2 ? 'both' : 'all'} have ${list(same)}. Every centre piece has a different set of three colours (each one lacks a different colour), so one of them is filled in wrong.`, stickers: vs.flatMap((v) => CENTRES[v]) });
      }
    }
    if (centreTrouble) return done();
    const faceOf = {}; lacks.forEach((x, v) => { faceOf[x] = OPPOSITE_FACE[VERTS[v]]; });
    const colourOf = {}; for (const x of COLOURS) colourOf[faceOf[x]] = x;
    res.colourOf = colourOf;
    const letters = cols.map((x) => faceOf[x]);
    CENTRES.forEach((c, v) => {
      if (shiftOf(c.map((i) => letters[i]), HOME_CENTRE[v]) < 0) {
        centreTrouble = true;
        errors.push({ kind: 'centre', text: `The colours of the ${centreName(v)} go round the wrong way, like a mirror image: two of its stickers are probably swapped.`, stickers: c.slice() });
      }
    });
    if (centreTrouble) return done();
    // tips: the same three colours as the centre under them, in the same order round the corner
    TIPS.forEach((t, v) => {
      const ts = t.map((i) => cols[i]); const cs = CENTRES[v].map((i) => cols[i]);
      const twice = ts.find((x, k) => ts.indexOf(x) !== k);
      const strange = ts.filter((x) => !cs.includes(x));
      let text = null;
      if (twice) text = `The ${tipName(v)} has two ${word(twice)} stickers. Each tip has three different colours.`;
      else if (strange.length) text = `The ${tipName(v)} has ${word(strange[0])}, but the centre under it is ${list(cs.map(word))}. A tip always has the same three colours as the centre under it (they are fixed together), so ${word(strange[0])} cannot be on it.`;
      else if (shiftOf(t.map((i) => letters[i]), HOME_TIP[v]) < 0) text = `The colours of the ${tipName(v)} go round the wrong way, like a mirror image: two of its stickers are probably swapped.`;
      if (text) errors.push({ kind: 'tip', text, stickers: t.slice() });
    });
    // edges: two different colours (any two different colours make a real edge), each edge once
    const at = [];
    EDGES.forEach((e, i) => {
      const [a, b] = e.map((k) => cols[k]);
      if (a === b) { errors.push({ kind: 'edge', text: `The ${edgeWhere(i)} has two ${word(a)} stickers. No edge piece has that.`, stickers: e.slice() }); at.push(-1); return; }
      const fa = faceOf[a]; const fb = faceOf[b];
      at.push(HOME_EDGE.findIndex((h) => (h[0] === fa && h[1] === fb) || (h[0] === fb && h[1] === fa)));
    });
    const where = new Map(); at.forEach((j, i) => { if (j >= 0) { if (!where.has(j)) where.set(j, []); where.get(j).push(i); } });
    const pieceName = (j) => HOME_EDGE[j].map((f) => word(colourOf[f])).join('-');
    let dups = false;
    for (const [j, places] of where) {
      if (places.length < 2) continue;
      dups = true;
      errors.push({ kind: 'duplicate', text: `The ${pieceName(j)} edge is there ${places.length === 2 ? 'twice' : places.length + ' times'}: at the ${list(places.map(edgeWhere))}.`, stickers: places.flatMap((i) => EDGES[i]) });
    }
    if (dups) {
      const missing = HOME_EDGE.map((_, j) => j).filter((j) => !where.has(j));
      if (missing.length) errors.push({ kind: 'missing', text: `So ${missing.length === 1 ? 'this edge is' : 'these edges are'} missing: ${list(missing.map(pieceName))}.`, stickers: [] });
    }
    if (errors.length) return done();
    const pcs = readPieces(letters);
    if (pcs.eo.reduce((s, x) => s + x, 0) % 2) {
      errors.push({ kind: 'flip', text: "One edge is flipped (its two colours are the wrong way round). A real Pyraminx can't get like this by turning: check the colours of the edges (the stickers in the middle of each side).", stickers: allEdgeStickers.slice() });
    }
    if (parity(pcs.ep)) {
      errors.push({ kind: 'parity', text: "Two edges have swapped places. A real Pyraminx can't get like this by turning: check the colours of the edges (the stickers in the middle of each side).", stickers: allEdgeStickers.slice() });
    }
    if (errors.length) return done();
    res.ok = true; res.faces = letters; res.solved = puzzle.isSolved(letters);
    return done();
  }

  return {
    id: 'pyraminx', name: 'Pyraminx', short: 'Pyraminx',
    puzzle,
    validate,
    scrambleLength: 14,
    scan: {
      experimental: true,
      faces: [
        { face: 'F', say: 'Hold the Pyraminx with the yellow face flat on the bottom and the green face looking at the camera (one corner points straight up).' },
        { face: 'L', say: 'Keep yellow on the bottom and turn the whole puzzle a third of a turn to the right, so the red face looks at the camera (top corner still up).' },
        { face: 'R', say: 'Keep yellow on the bottom and turn the whole puzzle another third of a turn to the right, so the blue face looks at the camera (top corner still up).' },
        { face: 'D', say: 'Tip the puzzle over so the yellow face looks at the camera, with the green face at the bottom (the back corner points up).' },
      ],
    },
    holdHelp: 'Hold the Pyraminx with one face flat on the bottom (yellow in the usual colours) and one face looking at you (green); red is then on the left and blue on the right, and one corner points straight up. The map is the puzzle unfolded: the front face in the middle, the left and right faces beside it and the bottom face below it.',
    notationHelp: "Hold it with the front face looking at you and one corner up. U, L, R and B name the top, front-left, front-right and back corners. A capital letter turns that corner together with the layer under it a third of a turn clockwise (as if you look straight at the corner from outside); with ' (U') it goes anticlockwise. A small letter (u, l, r, b) turns only the little tip at that corner.",
    // extras for the solver and tests
    pieces: { VERTS, TIPS, CENTRES, EDGES, EDGE_PLACE, CORNER_WORD, OPPOSITE_FACE, STANDARD },
    readPieces, fromPieces, parity,
  };
}));
