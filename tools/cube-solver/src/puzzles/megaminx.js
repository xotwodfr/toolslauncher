'use strict';
// The Megaminx: a dodecahedron with 12 pentagon faces of 11 stickers each (132 stickers). Every face turns a fifth of a turn
// (72 degrees). The pieces: 12 centres (fixed, one per face), 30 edges (2 stickers) and 20 corners (3 stickers).
//
// Held with the white face on top (U) and the dark green face looking at you (F). Going round the top, clockwise seen from
// above: F (dark green), L (purple), BL (yellow), BR (dark blue), R (red). Every face's opposite face sits on the bottom half:
// D (grey) under U, B (lime green) opposite F, DBR (pink) opposite L, DR (cream) opposite BL, DL (light blue) opposite BR and
// DBL (orange) opposite R. This is the WCA colour scheme (as the official scrambler, TNoodle, draws it).
// The bottom half, clockwise seen from below starting at the front: DR (cream, under F and R), DL (light blue, under F and L),
// DBL (orange, under L and BL), B (lime, under BL and BR), DBR (pink, under BR and R) - and D (grey) at the bottom.
//
// Notation (the usual one for the Megaminx, WCA face names): U, F, R, L, BL, BR on the top half, D, DR, DL, DBR, DBL, B on
// the bottom half. A letter alone turns that face a fifth of a turn clockwise (seen looking straight at that face from
// outside); ' (R') anticlockwise; 2 (R2) two fifths clockwise and 2' (R2') two fifths anticlockwise.
//
// Geometry: face planes at distance 1 from the centre. Each face is cut by the turning planes of its 5 neighbours: a cut
// line runs parallel to each edge, 53% of the way from the edge to the centre of the face, which leaves a centre pentagon
// a bit under half the size of the face (like a real Megaminx), 5 edge stickers (trapezoids) and 5 corner stickers (kites).
//
// Sticker order: faces U, F, R, BR, BL, L, D, DR, DBR, B, DBL, DL; each face 11 stickers: the centre first, then the other
// 10 clockwise (as you look at the face, held as its "up" says) starting with the one at the top. The top of a face:
//   U: the back corner (between BR and BL) at the top;    F, R, BR, BL, L: the edge they share with U at the top;
//   DR, DBR, B, DBL, DL: the corner they share with two top-half faces at the top (DR: the F-R corner, ...);
//   D: the front corner (between DR and DL) at the top.
// So on F, R, BR, BL and L stickers 1, 3, 5, 7, 9 are edges and 2, 4, 6, 8, 10 corners; on U and the six bottom-half faces it is
// the other way round (1, 3, 5, 7, 9 corners). puzzle.geometry has the pieces as sticker lists.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('../puzzle-core'));
  else { const def = factory(root.PuzzleCore); (root.Puzzles = root.Puzzles || {})[def.id] = def; }
}(typeof self !== 'undefined' ? self : this, function (PC) {
  const { dot, cross, add, sub, scale, unit, norm } = PC;
  const FACE_IDS = ['U', 'F', 'R', 'BR', 'BL', 'L', 'D', 'DR', 'DBR', 'B', 'DBL', 'DL'];
  const STANDARD = { U: 'w', F: 'g', R: 'r', BR: 'b', BL: 'y', L: 'p', D: 'e', DR: 'c', DBR: 'k', B: 'i', DBL: 'o', DL: 'l' };
  const colours = {
    w: { name: 'white', hex: '#ffffff' },
    g: { name: 'dark green', hex: '#0b7a32' },
    r: { name: 'red', hex: '#d8191f' },
    b: { name: 'dark blue', hex: '#1c3fc2' },
    y: { name: 'yellow', hex: '#ffd400' },
    p: { name: 'purple', hex: '#7b2cbf' },
    e: { name: 'grey', hex: '#8c8c8c' },
    c: { name: 'cream', hex: '#f3e2ad' },
    k: { name: 'pink', hex: '#ff8ccb' },
    i: { name: 'lime green', hex: '#90e83a' },
    o: { name: 'orange', hex: '#ff7b16' },
    l: { name: 'light blue', hex: '#5ccbf5' },
  };
  const COLOURS = Object.keys(colours);
  const FACE_NAME = {
    U: 'Up', F: 'Front', R: 'Right', BR: 'Back right', BL: 'Back left', L: 'Left',
    D: 'Down', DR: 'Down right', DBR: 'Down back right', B: 'Back', DBL: 'Down back left', DL: 'Down left',
  };

  // ---- the dodecahedron ----
  const C5 = 1 / Math.sqrt(5); const S5 = 2 / Math.sqrt(5);
  const ring = (deg, y) => { const a = deg * Math.PI / 180; return [S5 * Math.sin(a), y, S5 * Math.cos(a)]; };
  // x right, y up, z towards you. Azimuth 0 = front, 90 = right.
  const NORMAL = {
    U: [0, 1, 0], F: ring(0, C5), R: ring(72, C5), BR: ring(144, C5), BL: ring(216, C5), L: ring(288, C5),
    D: [0, -1, 0], DR: ring(36, -C5), DBR: ring(108, -C5), B: ring(180, -C5), DBL: ring(252, -C5), DL: ring(324, -C5),
  };
  const N = FACE_IDS.map((f) => unit(NORMAL[f]));
  const adjacent = (i, j) => i !== j && Math.abs(dot(N[i], N[j]) - C5) < 1e-6;
  const NEIGH = N.map((_, i) => N.map((__, j) => j).filter((j) => adjacent(i, j)));
  // solve 3 plane equations n.p = 1
  function meet(i, j, k) {
    const a = N[i]; const b = N[j]; const c = N[k];
    const det = dot(a, cross(b, c));
    return scale(add(add(cross(b, c), cross(c, a)), cross(a, b)), 1 / det);
  }
  // face frames: "up" as the module comment says
  const UPDIR = (f) => {
    if (f === 'U') return [0, 0, -1];
    if (f === 'D') return [0, 0, 1];
    return [0, 1, 0];
  };
  const frame = N.map((n, i) => {
    const u0 = UPDIR(FACE_IDS[i]);
    const up = unit(sub(u0, scale(n, dot(u0, n))));
    const right = cross(up, n);
    return { n, up, right };
  });
  // neighbours of each face in clockwise order seen from outside, and the vertices between them
  const angleOn = (i, p) => { const { up, right } = frame[i]; return Math.atan2(dot(p, right), dot(p, up)); }; // 0 = up, clockwise positive
  const NB = NEIGH.map((list, i) => list.slice().sort((a, b) => {
    const norm2 = (x) => ((x % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    return norm2(angleOn(i, N[a]) + 1e-9) - norm2(angleOn(i, N[b]) + 1e-9);
  }));

  const CUT = 0.53; // depth of the cut lines, as a fraction of the face's inradius
  const faces = FACE_IDS.map((f, i) => ({ id: f, name: FACE_NAME[f], normal: N[i], up: frame[i].up, colour: STANDARD[f] }));
  const stickers = [];
  const vkey = (p) => p.map((v) => Math.round(v * 1e5)).join(',');
  const cornerAt = new Map(); // vertex key -> [sticker...]
  const edgeAt = new Map();   // 'i-j' -> [sticker...]
  const centres = [];
  const cutOffset = []; // per face: the turning plane is n.p > cutOffset
  for (let i = 0; i < 12; i++) {
    const nb = NB[i]; // clockwise
    // edge k: between this face and nb[k]; vertex k: between nb[k-1] and nb[k]
    const V = nb.map((_, k) => meet(i, nb[(k + 4) % 5], nb[k]));
    const ctr = scale(N[i], 1);
    const inr = norm(sub(scale(add(V[0], V[1]), 0.5), ctr));
    const t = CUT * inr;
    // the cut line of neighbour k: the edge line V[k]V[k+1] moved t towards the centre
    const inward = nb.map((_, k) => unit(sub(ctr, scale(add(V[k], V[(k + 1) % 5]), 0.5))));
    const line = nb.map((_, k) => ({ p: add(V[k], scale(inward[k], t)), d: unit(sub(V[(k + 1) % 5], V[k])) }));
    const inter = (A, B) => { // two lines in the face plane
      const w = sub(B.p, A.p); const c = cross(A.d, B.d);
      const s = dot(cross(w, B.d), c) / dot(c, c);
      return add(A.p, scale(A.d, s));
    };
    const edgeLine = (k) => ({ p: V[k], d: unit(sub(V[(k + 1) % 5], V[k])) });
    // centre pentagon
    const cpoly = nb.map((_, k) => inter(line[(k + 4) % 5], line[k]));
    const pieces = [];
    for (let k = 0; k < 5; k++) {
      const prev = (k + 4) % 5; const next = (k + 1) % 5;
      // corner at V[k] (edges prev and k meet there)
      pieces.push({ kind: 'corner', k, poly: [V[k], inter(edgeLine(k), line[prev]), inter(line[prev], line[k]), inter(edgeLine(prev), line[k])] });
      // edge k
      pieces.push({ kind: 'edge', k, poly: [inter(edgeLine(k), line[prev]), inter(edgeLine(k), line[next]), inter(line[next], line[k]), inter(line[k], line[prev])] });
    }
    // order: centre, then clockwise from the top
    const avg = (pts) => scale(pts.reduce(add, [0, 0, 0]), 1 / pts.length);
    const ang = (p) => { let a = angleOn(i, sub(avg(p.poly), ctr)); if (a < -1e-6) a += 2 * Math.PI; return a; };
    pieces.sort((a, b) => ang(a) - ang(b));
    centres.push(stickers.length);
    stickers.push({ face: FACE_IDS[i], centre: avg(cpoly), poly: cpoly });
    for (const pc of pieces) {
      const s = stickers.length;
      stickers.push({ face: FACE_IDS[i], centre: avg(pc.poly), poly: pc.poly });
      if (pc.kind === 'corner') {
        const key = vkey(V[pc.k]);
        if (!cornerAt.has(key)) cornerAt.set(key, { v: V[pc.k], list: [] });
        cornerAt.get(key).list.push(s);
      } else {
        const j = nb[pc.k];
        const key = Math.min(i, j) + '-' + Math.max(i, j);
        if (!edgeAt.has(key)) edgeAt.set(key, []);
        edgeAt.get(key).push(s);
      }
    }
    // the plane through this face's cut lines on its neighbours: n_i . p = offset. A point on neighbour nb[0] at depth t
    // from the shared edge: compute on that face below, once all faces are known (same t everywhere by symmetry).
    cutOffset.push({ V, t });
  }
  // offset of the turning plane: it passes through the cut line on each neighbour (a point at depth t from the shared edge)
  const OFFSET = (() => {
    const j = NB[0][0]; const { V, t } = cutOffset[0];
    const mid = scale(add(V[0], V[1]), 0.5);
    return dot(N[0], add(mid, scale(unit(sub(N[j], mid)), t)));
  })();
  const turns = {};
  for (let i = 0; i < 12; i++) {
    const n = N[i];
    turns[FACE_IDS[i]] = { axis: n, order: 5, select: (c) => dot(c, n) > OFFSET + 1e-9 };
  }

  // ---- pieces ----
  // corners: three stickers clockwise seen from outside round the vertex, starting with the one on the earliest face (in
  // sticker order); edges: the sticker on the earlier face first.
  const cornerList = [];
  for (const { v, list } of cornerAt.values()) {
    const a = unit(v); const e1 = unit(cross(a, Math.abs(a[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0])); const e2 = cross(a, e1);
    // clockwise seen from outside (looking along -a): angle measured with e1, e2 then reversed
    const ag = (s) => Math.atan2(dot(stickers[s].centre, e2), dot(stickers[s].centre, e1));
    let sorted = list.slice().sort((x, y) => ag(y) - ag(x));
    // check: clockwise seen from outside means (c1-c0)x(c2-c0) points inwards
    const c = sorted.map((s) => stickers[s].centre);
    if (dot(cross(sub(c[1], c[0]), sub(c[2], c[0])), a) > 0) sorted = sorted.reverse();
    const m = sorted.indexOf(Math.min(...sorted));
    cornerList.push(sorted.slice(m).concat(sorted.slice(0, m)));
  }
  cornerList.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  const edgeList = [...edgeAt.values()].map((l) => l.slice().sort((a, b) => a - b)).sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  const fOf = (s) => FACE_IDS.indexOf(stickers[s].face);

  const order5 = {
    format: (mv) => { const k = mv.amount; return mv.turn + (k === 1 ? '' : k === 2 ? '2' : k === 3 ? "2'" : "'"); },
  };

  // ---- the net: two flowers (U with its 5 neighbours, D with its 5), joined at the F - DR edge, side by side ----
  const base = { id: 'megaminx', name: 'Megaminx', colours, faces, stickers, turns, format: order5.format };
  const pre = PC.definePuzzle(base);
  function toTemplate(fi, p) {
    const f = pre.faces[fi]; const right = cross(f.up, f.normal);
    const own = pre.stickers.filter((s) => s.f === fi);
    const origin = PC.centroid(own.map((s) => s.centre));
    const d = sub(p, origin); return [dot(d, right), -dot(d, f.up)];
  }
  const sharedEdge = (i, j) => { const k = NB[i].indexOf(j); const { V } = cutOffset[i]; return [V[k], V[(k + 1) % 5]]; };
  const place = {}; // face index -> { x, y, a }
  const tf = (pl, [x, y]) => [pl.x + x * Math.cos(pl.a) - y * Math.sin(pl.a), pl.y + x * Math.sin(pl.a) + y * Math.cos(pl.a)];
  function unfold(from, to) {
    const [A, B] = sharedEdge(from, to);
    const a = tf(place[from], toTemplate(from, A)); const b = tf(place[from], toTemplate(from, B));
    const a2 = toTemplate(to, A); const b2 = toTemplate(to, B);
    const ang = Math.atan2(b[1] - a[1], b[0] - a[0]) - Math.atan2(b2[1] - a2[1], b2[0] - a2[0]);
    const r = [a2[0] * Math.cos(ang) - a2[1] * Math.sin(ang), a2[0] * Math.sin(ang) + a2[1] * Math.cos(ang)];
    place[to] = { x: a[0] - r[0], y: a[1] - r[1], a: ang };
  }
  const FI = (f) => FACE_IDS.indexOf(f);
  function makeNet(petal, lower) {
    for (const k of Object.keys(place)) delete place[k];
    place[FI('U')] = { x: 0, y: 0, a: 0 };
    for (const j of NB[FI('U')]) unfold(FI('U'), j);
    unfold(petal, lower);
    unfold(lower, FI('D'));
    for (const j of NB[FI('D')]) if (j !== lower) unfold(FI('D'), j);
    // turn the whole map so the two flowers sit side by side (U's flower on the left)
    const du = place[FI('U')]; const dd = place[FI('D')];
    const g = -Math.atan2(dd.y - du.y, dd.x - du.x);
    return FACE_IDS.map((f, i) => {
      const pl = place[i];
      const x = pl.x * Math.cos(g) - pl.y * Math.sin(g); const y = pl.x * Math.sin(g) + pl.y * Math.cos(g);
      let deg = (pl.a + g) * 180 / Math.PI; deg = ((deg % 360) + 540) % 360 - 180;
      return { face: f, x: Math.round(x * 1e6) / 1e6, y: Math.round(y * 1e6) / 1e6, rotate: Math.round(deg * 1e6) / 1e6 };
    });
  }
  // the two flowers are joined at a top-half face and a bottom-half face; pick the join that keeps U nearly upright
  let net = null;
  for (const petal of NB[FI('U')]) {
    for (const lower of NB[petal]) {
      if (lower === FI('U') || NB[FI('U')].includes(lower)) continue;
      const cand = makeNet(petal, lower);
      const score = Math.abs(cand[0].rotate) * 1000 + Math.abs(cand[FI('D')].rotate);
      if (!net || score < net.score) net = { score, cand, petal, lower };
    }
  }
  // then straighten it so the white face stands upright (the bottom flower is then a few degrees off level)
  net = (() => {
    const g = -net.cand[0].rotate * Math.PI / 180;
    return net.cand.map((pl) => {
      const x = pl.x * Math.cos(g) - pl.y * Math.sin(g); const y = pl.x * Math.sin(g) + pl.y * Math.cos(g);
      let deg = pl.rotate + g * 180 / Math.PI; deg = ((deg % 360) + 540) % 360 - 180;
      return { face: pl.face, x: Math.round(x * 1e6) / 1e6, y: Math.round(y * 1e6) / 1e6, rotate: Math.round(deg * 1e6) / 1e6 };
    });
  })();
  const puzzle = PC.definePuzzle({ ...base, net, scrambleTurns: FACE_IDS });
  puzzle.geometry = {
    faceIds: FACE_IDS,
    centres,                                  // sticker index of each face's centre (face order)
    corners: cornerList,                      // 20 x [3 sticker indices], clockwise round the corner seen from outside
    edges: edgeList,                          // 30 x [2 sticker indices]
    neighbours: NB.map((l) => l.slice()),     // per face: its 5 neighbours (face indices), clockwise seen from outside
    opposite: N.map((n) => N.findIndex((m) => dot(m, n) < -0.999)),
    faceOfSticker: stickers.map((s, i) => fOf(i)),
  };

  // ---- validation ----
  const G = puzzle.geometry;
  const word = (c) => (colours[c] ? colours[c].name : String(c));
  const list = (xs) => (xs.length <= 1 ? xs.join('') : xs.slice(0, -1).join(', ') + ' and ' + xs[xs.length - 1]);
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  // where a piece is, in words: by the colours of the centres around it
  const isLike = (fi, cols) => cols[G.centres[fi]];
  function parity(perm) {
    const seen = new Array(perm.length).fill(false); let p = 0;
    for (let i = 0; i < perm.length; i++) {
      if (seen[i]) continue;
      let j = i; let len = 0;
      while (!seen[j]) { seen[j] = true; j = perm[j]; len++; }
      p += len - 1;
    }
    return p % 2;
  }
  /**
   * Checks a Megaminx that was filled in or scanned (colours: one colour key or null per sticker). Returns
   *   { ok, solved, faces, colourOf, errors: [{ kind, text, stickers }], summary }
   * faces = the face id each sticker's colour belongs to (by the centres), colourOf = face id -> colour key.
   */
  function validate(cols) {
    const errors = [];
    const res = { ok: false, solved: false, faces: null, colourOf: null, errors };
    const finish = () => {
      if (res.ok) res.summary = res.solved ? 'This Megaminx is already solved.' : 'This Megaminx can be solved.';
      else res.summary = errors.length === 1 ? errors[0].text : `${errors.length} problems: ${errors[0].text}`;
      return res;
    };
    if (!cols || cols.length !== puzzle.size) {
      errors.push({ kind: 'empty', text: `A Megaminx has ${puzzle.size} stickers.`, stickers: [] });
      return finish();
    }
    const empty = [];
    cols.forEach((c, i) => { if (!COLOURS.includes(c)) empty.push(i); });
    if (empty.length) {
      errors.push({ kind: 'empty', text: `${plural(empty.length, 'sticker is', 'stickers are')} not filled in yet.`, stickers: empty });
      return finish();
    }
    const count = Object.fromEntries(COLOURS.map((c) => [c, 0]));
    for (const c of cols) count[c]++;
    const off = COLOURS.filter((c) => count[c] !== 11);
    if (off.length) {
      const w = off.map((c) => `${count[c]} ${word(c)}`);
      errors.push({ kind: 'count', text: `Every colour must appear exactly 11 times (one whole face), but there ${count[off[0]] === 1 ? 'is' : 'are'} ${list(w)}.`, stickers: [] });
    }
    // centres
    const cc = G.centres.map((s) => cols[s]);
    const dup = COLOURS.filter((c) => cc.filter((x) => x === c).length > 1);
    if (dup.length) {
      const missing = COLOURS.filter((c) => !cc.includes(c));
      errors.push({
        kind: 'centres',
        text: `${list(dup.map((c) => `${cc.filter((x) => x === c).length} centres are ${word(c)}`))}: every face of a Megaminx has its own centre colour${missing.length ? ` (no centre is ${list(missing.map(word))})` : ''}. The centre is the pentagon in the middle of each face.`,
        stickers: G.centres.filter((s) => dup.includes(cols[s])),
      });
      return finish();
    }
    const faceOf = {}; cc.forEach((c, fi) => { faceOf[c] = fi; });
    const colourOf = {}; FACE_IDS.forEach((f, fi) => { colourOf[f] = cc[fi]; });
    res.colourOf = colourOf;
    const fidx = cols.map((c) => faceOf[c]);
    const homeCorner = G.corners.map((st) => st.map((s) => G.faceOfSticker[s]));
    const homeEdge = G.edges.map((st) => st.map((s) => G.faceOfSticker[s]));
    const cornerWhere = (j) => `corner between ${list(homeCorner[j].map((f) => word(cc[f])))}`;
    const edgeWhere = (j) => `edge between ${list(homeEdge[j].map((f) => word(cc[f])))}`;
    let trouble = false;
    const cAt = []; const eAt = [];
    for (let j = 0; j < 20; j++) {
      const fs = G.corners[j].map((s) => fidx[s]);
      const cs = G.corners[j].map((s) => cols[s]);
      let found = -1; let ori = 0;
      for (let p = 0; p < 20 && found < 0; p++) {
        for (let o = 0; o < 3; o++) {
          if (fs.every((f, k) => f === homeCorner[p][(k + o) % 3])) { found = p; ori = o; break; }
        }
      }
      cAt.push({ piece: found, ori });
      if (found >= 0) continue;
      trouble = true;
      const st = G.corners[j].slice();
      let text;
      const twice = cs.find((c, k) => cs.indexOf(c) !== k);
      if (twice) text = `The ${cornerWhere(j)} has two ${word(twice)} stickers (${list(cs.map(word))}). No corner piece has that.`;
      else {
        const apart = [];
        for (let a = 0; a < 3; a++) for (let b = a + 1; b < 3; b++) if (!adjacent(fs[a], fs[b])) apart.push([a, b]);
        if (apart.length) {
          const [a, b] = apart[0];
          const opp = G.opposite[fs[a]] === fs[b];
          text = `The ${cornerWhere(j)} has ${word(cs[a])} and ${word(cs[b])} together (${list(cs.map(word))}), but those faces ${opp ? 'are opposite each other' : 'do not touch'}: no corner piece has both.`;
        } else text = `The ${cornerWhere(j)} (${list(cs.map(word))}) has its colours the wrong way round, like a mirror image: two of its stickers are probably swapped.`;
      }
      errors.push({ kind: 'piece', text, stickers: st });
    }
    for (let j = 0; j < 30; j++) {
      const fs = G.edges[j].map((s) => fidx[s]);
      const cs = G.edges[j].map((s) => cols[s]);
      let found = -1; let ori = 0;
      for (let p = 0; p < 30 && found < 0; p++) {
        if (fs[0] === homeEdge[p][0] && fs[1] === homeEdge[p][1]) { found = p; ori = 0; }
        else if (fs[0] === homeEdge[p][1] && fs[1] === homeEdge[p][0]) { found = p; ori = 1; }
      }
      eAt.push({ piece: found, ori });
      if (found >= 0) continue;
      trouble = true;
      const text = cs[0] === cs[1]
        ? `The ${edgeWhere(j)} has two ${word(cs[0])} stickers. No edge piece has that.`
        : `The ${edgeWhere(j)} has ${word(cs[0])} and ${word(cs[1])}, but those faces ${G.opposite[fs[0]] === fs[1] ? 'are opposite each other' : 'do not touch'}: no edge piece has both.`;
      errors.push({ kind: 'piece', text, stickers: G.edges[j].slice() });
    }
    const dupCheck = (items, stk, where, kind, total) => {
      const at = new Map();
      items.forEach((x, i) => { if (x.piece >= 0) { if (!at.has(x.piece)) at.set(x.piece, []); at.get(x.piece).push(i); } });
      let any = false;
      for (const [p, places] of at) {
        if (places.length < 2) continue;
        any = true; trouble = true;
        errors.push({ kind: 'duplicate', text: `The ${list(stk(p).map((s) => word(cc[G.faceOfSticker[s]])))} ${kind} is there ${places.length === 2 ? 'twice' : places.length + ' times'}: at the ${list(places.map(where))}.`, stickers: places.flatMap((i) => (kind === 'corner' ? G.corners : G.edges)[i]) });
      }
      if (any) {
        const missing = []; for (let p = 0; p < total; p++) if (!at.has(p)) missing.push(p);
        if (missing.length) errors.push({ kind: 'missing', text: `So ${missing.length === 1 ? `this ${kind} is` : `these ${kind}s are`} missing: ${list(missing.map((p) => 'the ' + list(stk(p).map((s) => word(cc[G.faceOfSticker[s]]))) + ' ' + kind))}.`, stickers: [] });
      }
    };
    dupCheck(cAt, (p) => G.corners[p], cornerWhere, 'corner', 20);
    dupCheck(eAt, (p) => G.edges[p], edgeWhere, 'edge', 30);
    if (errors.length || trouble) return finish();

    const twist = cAt.reduce((s, x) => s + x.ori, 0) % 3;
    const allCorners = G.corners.flat(); const allEdges = G.edges.flat();
    if (twist) {
      errors.push({
        kind: 'twist',
        text: "One corner is twisted in place (it has been turned on its own, or two of its stickers were filled in the wrong way round). A real Megaminx can't get like this by turning. "
          + `Check each corner's colours; turning one corner ${twist === 1 ? 'clockwise' : 'anticlockwise'} would fix it.`,
        stickers: allCorners,
      });
    }
    if (eAt.reduce((s, x) => s + x.ori, 0) % 2) {
      errors.push({ kind: 'flip', text: "One edge is flipped (its two colours are the wrong way round). A real Megaminx can't get like this by turning: check the colours of the edges.", stickers: allEdges });
    }
    if (parity(cAt.map((x) => x.piece))) {
      errors.push({ kind: 'parity', text: "Two corners have swapped places. A real Megaminx can't get like this by turning (its corners can only be cycled three at a time): check where each corner is.", stickers: allCorners });
    }
    if (parity(eAt.map((x) => x.piece))) {
      errors.push({ kind: 'parity', text: "Two edges have swapped places. A real Megaminx can't get like this by turning (its edges can only be cycled three at a time): check where each edge is.", stickers: allEdges });
    }
    if (errors.length) return finish();
    res.ok = true;
    res.faces = fidx.map((fi) => FACE_IDS[fi]);
    res.solved = puzzle.isSolved(cols);
    return finish();
  }

  // ---- scanning: how to hold it for each face ----
  function topOf(fi) { // the neighbour(s) at the top of face fi as its template shows it
    const nb = NB[fi];
    // NB is sorted clockwise from the top: the first one is at the top if its angle is ~0, else the top is a corner
    const a0 = Math.abs(angleOn(fi, N[nb[0]]));
    return a0 < 1e-3 ? [nb[0]] : [nb[4], nb[0]];
  }
  const sayFor = (f) => {
    const fi = FI(f); const top = topOf(fi);
    const c = (x) => colours[STANDARD[FACE_IDS[x]]].name;
    return `Turn the Megaminx so the ${colours[STANDARD[f]].name} face looks straight at the camera, `
      + (top.length === 1 ? `with the ${c(top[0])} face on top.` : `with the corner between the ${c(top[0])} and ${c(top[1])} faces pointing up.`);
  };
  const scanOrder = ['U', 'F', 'R', 'BR', 'BL', 'L', 'DR', 'DBR', 'B', 'DBL', 'DL', 'D'];

  return {
    id: 'megaminx',
    name: 'Megaminx',
    short: 'Megaminx',
    puzzle,
    validate,
    scrambleLength: 70,
    scan: { experimental: true, faces: scanOrder.map((f) => ({ face: f, say: sayFor(f) })) },
    holdHelp: 'Hold the Megaminx with the white face on top and the dark green face looking at you. Round the top, going clockwise from the front: dark green, purple (left), yellow (back left), dark blue (back right), red (right). Underneath: grey at the bottom, with cream under green and red, light blue under green and purple, orange, lime green and pink round the back. The map shows the puzzle unfolded as two flowers: the top half (white in the middle) and the bottom half (grey in the middle). If your Megaminx has other colours, fill in what you see: the centres tell which face is which.',
    notationHelp: "Hold it with the white face on top and green in front. U is the top face, F the front, R and L the right and left faces next to it, BR and BL the back-right and back-left faces of the top half. D is the bottom face; DR and DL are the bottom-half faces under the front's right and left corners, DBR and DBL the ones further back, and B the back face (opposite F). A letter alone turns that face a fifth of a turn (72 degrees) clockwise, as you see it looking straight at that face; R' turns it a fifth anticlockwise, R2 two fifths clockwise and R2' two fifths anticlockwise.",
    COLOURS,
    STANDARD,
  };
}));
