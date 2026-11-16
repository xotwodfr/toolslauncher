'use strict';
// Megaminx solver: a HUMAN layer-by-layer method, stage by stage, the way a beginner solves it (white face first, then layer
// after layer down to the last face). Stages (colours of the standard scheme; the real colours come from the centres):
//   White star                       the 5 edges round the white centre
//   White corners                    the 5 corners round the white centre
//   Second layer edges               the 5 edges between the faces round white (the "F2L" edges of the top half)
//   Third layer: corners and edges   the 5 corners and 10 edges of the next layer down
//   Fourth layer: corners and edges  the 5 corners and 5 edges of the layer above the last face
//   Last layer: orient edges (star)  the last face's edges get its colour on top (F R U R' U' F', as on a 3x3)
//   Last layer: place edges          Sune (R U R' U R U2' R') cycles three top edges
//   Last layer: place corners        the Megaminx Niklas (R U2' L' U2 R' U2' L U2) cycles three top corners
//   Last layer: orient corners       R' DR' R DR twice (or its inverse twice) per twisted corner, as on a 3x3; the layers
//                                    below come back by themselves once every corner is right
//
// How a piece is placed: the puzzle is turned in the computer so white is on top (any solution found is turned back into the
// user's face names at the end). For every piece the solver uses only the few faces a person would: the faces round the slot
// plus a "free" face whose turns cannot disturb anything already solved. A small search (IDA*, with distance tables for
// pairs of pieces) finds the shortest way to put the piece in place without leaving anything solved disturbed. Before that,
// the piece is brought next to its slot with turns of free faces only (a lookup on the piece alone), or first taken out of
// a wrong slot. The last layer uses fixed algorithms (checked when the module loads) chosen by a small breadth-first search
// over "turn the last face, then do an algorithm". Every answer is checked by applying it to the puzzle.
const def = require('../puzzles/megaminx');
const PC = require('../puzzle-core');

const P = def.puzzle;
const G = P.geometry;
const NF = 12;
const FACE_IDS = G.faceIds;
const U = FACE_IDS.indexOf('U');
const D = FACE_IDS.indexOf('D');
const NB = G.neighbours;
const OPP = G.opposite;
const NM = NF * 4; // moves: face * 4 + (amount - 1)
const moveFace = (m) => (m >> 2);
const moveAmount = (m) => (m & 3) + 1;
const invMove = (m) => (m & ~3) | (3 - (m & 3));

// ---- pieces ----------------------------------------------------------------------------------------------------------
// A piece's state is one "code": corners 0..59 (position * 3 + orientation), edges 60..119 (60 + position * 2 + orientation),
// where orientation = which of the position's stickers (in the order puzzle.geometry lists them) shows the piece's first
// sticker. Piece ids: corners 0..19, edges 20..49; piece p is at home with code home[p].
const NCODE = 120;
const NPIECE = 50;
const isCornerPiece = (p) => p < 20;
const pieceStickers = (p) => (p < 20 ? G.corners[p] : G.edges[p - 20]);
const codeOf = (p, pos, ori) => (p < 20 ? pos * 3 + ori : 60 + pos * 2 + ori);
const posOfCode = (c) => (c < 60 ? Math.floor(c / 3) : 20 + ((c - 60) >> 1)); // as a piece id: the piece that lives there
const oriOfCode = (c) => (c < 60 ? c % 3 : (c - 60) & 1);
const HOME = Array.from({ length: NPIECE }, (_, p) => codeOf(p, p < 20 ? p : p - 20, 0));
const homeFaces = Array.from({ length: NPIECE }, (_, p) => pieceStickers(p).map((s) => G.faceOfSticker[s]));

// where each sticker is: piece position + index
const locOf = new Array(P.size).fill(null);
G.corners.forEach((st, j) => st.forEach((s, k) => { locOf[s] = { p: j, k }; }));
G.edges.forEach((st, j) => st.forEach((s, k) => { locOf[s] = { p: 20 + j, k }; }));

// move tables on codes, from the sticker model
const TRANS = new Int16Array(NM * NCODE);
for (let f = 0; f < NF; f++) {
  for (let a = 1; a <= 4; a++) {
    const m = f * 4 + a - 1;
    const perm = P.turns[FACE_IDS[f]].powers[a];
    const goes = new Int32Array(P.size); // sticker at i goes to goes[i]
    for (let i = 0; i < P.size; i++) goes[perm[i]] = i;
    for (let c = 0; c < NCODE; c++) {
      const pos = posOfCode(c); const o = oriOfCode(c);
      const s = pieceStickers(pos)[o];
      const to = locOf[goes[s]];
      TRANS[m * NCODE + c] = codeOf(pos, to.p < 20 ? to.p : to.p - 20, to.k);
    }
  }
}
// which faces move a position
const facesOfPos = Array.from({ length: NPIECE }, (_, p) => homeFaces[p].slice());
const layerHas = (f, pos) => facesOfPos[pos].includes(f);

/** colours -> piece codes (by the centres). Throws on a state that is not a real Megaminx. */
function codesFromFaces(fidx) {
  const codes = new Int16Array(NPIECE).fill(-1);
  for (let pos = 0; pos < NPIECE; pos++) {
    const st = pieceStickers(pos); const fs = st.map((s) => fidx[s]); const n = st.length;
    let found = false;
    for (let p = (n === 3 ? 0 : 20); p < (n === 3 ? 20 : 50) && !found; p++) {
      const h = homeFaces[p];
      for (let o = 0; o < n; o++) {
        // piece sticker q sits at location (o + q) % n
        let ok = true;
        for (let q = 0; q < n; q++) if (fs[(o + q) % n] !== h[q]) { ok = false; break; }
        if (ok) { codes[p] = codeOf(p, pos < 20 ? pos : pos - 20, o); found = true; break; }
      }
    }
    if (!found) throw new Error('not a real Megaminx piece at ' + pos);
  }
  if (codes.some((c) => c < 0)) throw new Error('a piece is missing');
  return codes;
}
function applyToCodes(codes, moves) {
  const out = Int16Array.from(codes);
  for (const m of moves) for (let p = 0; p < NPIECE; p++) out[p] = TRANS[m * NCODE + out[p]];
  return out;
}

// ---- the 60 rotations of the whole puzzle --------------------------------------------------------------------------
const ROT = (() => {
  const mat = (axis, ang) => [[1, 0, 0], [0, 1, 0], [0, 0, 1]].map((e) => PC.rotate(e, axis, ang)); // columns
  const apply = (M, v) => [0, 1, 2].map((r) => M[0][r] * v[0] + M[1][r] * v[1] + M[2][r] * v[2]);
  const mul = (A, B) => [0, 1, 2].map((c) => apply(A, B[c])); // A after B
  const nrm = P.faces.map((f) => f.normal);
  const faceKey = (M) => nrm.map((n) => { const v = apply(M, n); return nrm.findIndex((x) => PC.dot(x, v) > 0.999); });
  const gens = [mat(nrm[U], 2 * Math.PI / 5), mat(nrm[FACE_IDS.indexOf('F')], 2 * Math.PI / 5)];
  const seen = new Map(); const list = [];
  const queue = [[[1, 0, 0], [0, 1, 0], [0, 0, 1]]];
  while (queue.length) {
    const M = queue.shift(); const k = faceKey(M).join(',');
    if (seen.has(k)) continue;
    seen.set(k, list.length); list.push(M);
    for (const g of gens) queue.push(mul(g, M));
  }
  const key = (c, n) => c.map((v) => Math.round(v * 1e4)).join(',') + '|' + n.map((v) => Math.round(v * 1e3)).join(',');
  const at = new Map(P.stickers.map((s) => [key(s.centre, s.normal), s.i]));
  return list.map((M) => {
    const face = faceKey(M);
    const sticker = P.stickers.map((s) => at.get(key(apply(M, s.centre), apply(M, s.normal))));
    if (sticker.some((x) => x === undefined)) throw new Error('rotation does not map stickers');
    return { face, sticker }; // face f goes to face[f]; sticker s goes to sticker[s]
  });
})();
if (ROT.length !== 60) throw new Error('expected 60 rotations, got ' + ROT.length);
/** the rotation taking face a to face b and face c to face d (a, c adjacent) */
const rotationFor = (a, b, c, d) => ROT.find((r) => r.face[a] === b && r.face[c] === d);

// ---- search tables ---------------------------------------------------------------------------------------------------
const pairCache = new Map();
/** distance table for two pieces together under a move set: index (localA * 60 + localB). */
function pairTable(a, b, moves, mkey) {
  const key = a + ',' + b + '|' + mkey;
  let t = pairCache.get(key);
  if (t) return t;
  const baseA = isCornerPiece(a) ? 0 : 60; const baseB = isCornerPiece(b) ? 0 : 60;
  t = new Uint8Array(3600).fill(255);
  const start = (HOME[a] - baseA) * 60 + (HOME[b] - baseB);
  t[start] = 0;
  let frontier = [start]; let d = 0;
  while (frontier.length) {
    const next = [];
    d++;
    for (const s of frontier) {
      const ca = Math.floor(s / 60) + baseA; const cb = (s % 60) + baseB;
      for (const m of moves) {
        const na = TRANS[m * NCODE + ca] - baseA; const nb = TRANS[m * NCODE + cb] - baseB;
        const ns = na * 60 + nb;
        if (t[ns] === 255) { t[ns] = d; next.push(ns); }
      }
    }
    frontier = next;
  }
  pairCache.set(key, t);
  return t;
}
const singleCache = new Map();
/** distance table for one piece alone under a move set: index = local code (0..59). */
function singleTable(a, moves, mkey) {
  const key = a + '|' + mkey;
  let t = singleCache.get(key);
  if (t) return t;
  const base = isCornerPiece(a) ? 0 : 60;
  t = new Uint8Array(60).fill(255);
  t[HOME[a] - base] = 0;
  let frontier = [HOME[a] - base]; let d = 0;
  while (frontier.length) {
    const next = []; d++;
    for (const s of frontier) for (const m of moves) { const ns = TRANS[m * NCODE + s + base] - base; if (t[ns] === 255) { t[ns] = d; next.push(ns); } }
    frontier = next;
  }
  singleCache.set(key, t);
  return t;
}
const movesOfFaces = (faces) => faces.flatMap((f) => [f * 4, f * 4 + 1, f * 4 + 2, f * 4 + 3]);
const facesKey = (faces) => faces.slice().sort((x, y) => x - y).join('.');

let nodes = 0;
const DEBUG = !!process.env.MEGAMINX_DEBUG;
/**
 * IDA*: put piece `target` home without leaving any of `keep` (pieces now at home) disturbed, with turns of `faces` only.
 * codes: current piece codes. Returns a move list or null (nothing within maxDepth).
 */
function placeSearch(codes, target, keep, faces, maxDepth) {
  const moves = movesOfFaces(faces); const mkey = facesKey(faces);
  // only kept pieces these faces can move matter
  const watch = keep.filter((p) => faces.some((f) => layerHas(f, posOfCode(HOME[p]))));
  const tracked = [target].concat(watch);
  const n = tracked.length;
  const base = tracked.map((p) => (isCornerPiece(p) ? 0 : 60));
  const tables = watch.map((p) => pairTable(target, p, moves, mkey));
  const single = singleTable(target, moves, mkey);
  const goal = tracked.map((p) => HOME[p]);
  const cur = new Int16Array(n);
  for (let i = 0; i < n; i++) cur[i] = codes[tracked[i]];
  const h = () => {
    const ta = cur[0] - base[0];
    let v = single[ta];
    for (let i = 1; i < n; i++) { const x = tables[i - 1][ta * 60 + cur[i] - base[i]]; if (x > v) v = x; }
    return v;
  };
  const path = [];
  const saves = Array.from({ length: maxDepth + 2 }, () => new Int16Array(n));
  function dfs(g, bound, last) {
    const hv = h();
    if (hv === 0) { for (let i = 0; i < n; i++) if (cur[i] !== goal[i]) return false; return true; }
    if (g + hv > bound) return false;
    const save = saves[g]; save.set(cur);
    for (const m of moves) {
      const f = m >> 2;
      if (last >= 0 && (f === last || (OPP[f] === last && f < last))) continue;
      nodes++;
      const row = m * NCODE;
      for (let i = 0; i < n; i++) cur[i] = TRANS[row + save[i]];
      path.push(m);
      if (dfs(g + 1, bound, f)) return true;
      path.pop();
    }
    cur.set(save);
    return false;
  }
  for (let bound = h(); bound <= maxDepth; bound++) {
    if (dfs(0, bound, -1)) return path.slice();
  }
  return null;
}

/** IDA*: move `target` into one of the positions `inside` (piece ids of positions) without disturbing `keep`. */
function extractSearch(codes, target, keep, faces, inside, maxDepth) {
  const moves = movesOfFaces(faces); const mkey = facesKey(faces);
  const watch = keep.filter((p) => faces.some((f) => layerHas(f, posOfCode(HOME[p]))));
  const n = watch.length;
  const base = watch.map((p) => (isCornerPiece(p) ? 0 : 60));
  const singles = watch.map((p) => singleTable(p, moves, mkey));
  const cur = new Int16Array(n + 1);
  for (let i = 0; i < n; i++) cur[i] = codes[watch[i]];
  cur[n] = codes[target];
  const okCode = new Uint8Array(NCODE);
  for (let c = 0; c < NCODE; c++) if (inside.includes(posOfCode(c))) okCode[c] = 1;
  const path = [];
  const saves = Array.from({ length: maxDepth + 2 }, () => new Int16Array(n + 1));
  const h = () => {
    let v = okCode[cur[n]] ? 0 : 1;
    for (let i = 0; i < n; i++) { const x = singles[i][cur[i] - base[i]]; if (x > v) v = x; }
    return v;
  };
  function dfs(g, bound, last) {
    const hv = h();
    if (hv === 0) return true;
    if (g + hv > bound) return false;
    const save = saves[g]; save.set(cur);
    for (const m of moves) {
      const f = m >> 2;
      if (f === last || (last >= 0 && OPP[f] === last && f < last)) continue;
      nodes++;
      const row = m * NCODE;
      for (let i = 0; i <= n; i++) cur[i] = TRANS[row + save[i]];
      path.push(m);
      if (dfs(g + 1, bound, f)) return true;
      path.pop();
    }
    cur.set(save);
    return false;
  }
  for (let bound = h(); bound <= maxDepth; bound++) if (dfs(0, bound, -1)) return path.slice();
  return null;
}

/** breadth-first search on one piece with the given faces: shortest ways to reach positions in `inside`. */
function freeRoutes(code, faces, inside, extra) {
  const moves = movesOfFaces(faces);
  const insideSet = new Set(inside);
  const prev = new Map([[code, null]]);
  let frontier = [code]; const found = [];
  let depth = 0; let foundDepth = -1;
  const pathTo = (c) => { const out = []; let x = c; while (prev.get(x)) { const [pc, m] = prev.get(x); out.push(m); x = pc; } return out.reverse(); };
  while (frontier.length) {
    for (const c of frontier) if (insideSet.has(posOfCode(c))) found.push({ code: c, depth });
    if (found.length && foundDepth < 0) foundDepth = depth;
    if (foundDepth >= 0 && depth >= foundDepth + extra) break;
    const next = [];
    for (const c of frontier) {
      for (const m of moves) {
        const nc = TRANS[m * NCODE + c];
        if (!prev.has(nc)) { prev.set(nc, [c, m]); next.push(nc); }
      }
    }
    frontier = next; depth++;
  }
  return found.map((x) => ({ code: x.code, moves: pathTo(x.code) }));
}

// ---- the layers (in the solving frame: white on top = U, the last face = D) --------------------------------------------
const PET = NB[U].slice(); // petals, clockwise round U
const LOW = PET.map((p, i) => NB[p].find((q) => q !== U && NB[PET[(i + 1) % 5]].includes(q))); // lower face under petals i, i+1
const findCorner = (fs) => { for (let p = 0; p < 20; p++) if (fs.every((f) => homeFaces[p].includes(f))) return p; return -1; };
const findEdge = (a, b) => { for (let p = 20; p < 50; p++) if (homeFaces[p].includes(a) && homeFaces[p].includes(b)) return p; return -1; };
const L1E = PET.map((p) => findEdge(U, p));
const L1C = PET.map((p, i) => findCorner([U, p, PET[(i + 1) % 5]]));
const L2E = PET.map((p, i) => findEdge(p, PET[(i + 1) % 5]));
const L3C = PET.map((p, i) => findCorner([p, PET[(i + 1) % 5], LOW[i]]));
const L3E = PET.flatMap((p, i) => [findEdge(p, LOW[i]), findEdge(PET[(i + 1) % 5], LOW[i])]);
const L4C = LOW.map((q, i) => findCorner([q, LOW[(i + 1) % 5], PET[(i + 1) % 5]]));
const L4E = LOW.map((q, i) => findEdge(q, LOW[(i + 1) % 5]));
const LLE = LOW.map((q) => findEdge(D, q));
const LLC = LOW.map((q, i) => findCorner([D, q, LOW[(i + 1) % 5]]));
for (const x of [L1E, L1C, L2E, L3C, L3E, L4C, L4E, LLE, LLC]) if (x.some((p) => p < 0)) throw new Error('layer pieces not found');
if (new Set([].concat(L1E, L1C, L2E, L3C, L3E, L4C, L4E, LLE, LLC)).size !== 50) throw new Error('layers do not cover the pieces');


// ---- placing one piece -----------------------------------------------------------------------------------------------
const ALL_FACES = Array.from({ length: NF }, (_, f) => f);
const ALL_POS = Array.from({ length: NPIECE }, (_, p) => p);
const freeFacesFor = (keep) => ALL_FACES.filter((f) => !keep.some((p) => layerHas(f, posOfCode(HOME[p]))));
const uniq = (xs) => [...new Set(xs)];

/**
 * Moves that put `target` home, leaving every piece of `keep` (all at home now) at home, using the faces `I` round its slot.
 * First, if needed, the piece is taken out of a slot it is stuck in, then brought next to the slot with free turns only.
 */
function placePiece(codes, target, keep, I, maxDepth, within = Infinity) {
  if (codes[target] === HOME[target]) return [];
  const free = freeFacesFor(keep);
  const inI = (pos) => I.some((f) => layerHas(f, pos));
  const inFree = (pos) => free.some((f) => layerHas(f, pos));
  const cands = [];
  let pos = posOfCode(codes[target]);
  if (inI(pos)) cands.push({ pre: [], codes });
  else {
    let pre = []; let c0 = codes;
    if (!inFree(pos)) {
      const inside = ALL_POS.filter((q) => inFree(q) || inI(q));
      const near = free.filter((f) => facesOfPos[pos].some((g) => g === f || NB[g].includes(f)));
      let ex = extractSearch(codes, target, keep, uniq(facesOfPos[pos].concat(near)), inside, 8);
      if (!ex) ex = extractSearch(codes, target, keep, uniq(facesOfPos[pos].concat(free)), inside, 8);
      if (!ex) return null;
      pre = ex; c0 = applyToCodes(codes, ex); pos = posOfCode(c0[target]);
    }
    if (inI(pos)) cands.push({ pre, codes: c0 });
    else {
      const routes = freeRoutes(c0[target], free, ALL_POS.filter(inI), 1).slice(0, 8);
      for (const r of routes) cands.push({ pre: pre.concat(r.moves), codes: applyToCodes(c0, r.moves) });
    }
  }
  let best = null;
  for (const c of cands) {
    const limit = Math.min(maxDepth, (best ? best.length : within + 1) - c.pre.length - 1);
    if (limit < 0) continue;
    const m = placeSearch(c.codes, target, keep, I, limit);
    if (m && (!best || c.pre.length + m.length < best.length)) best = c.pre.concat(m);
  }
  return best;
}

/** Solves the pieces `targets` one at a time (cheapest first), keeping `keep` and every finished target in place. */
function solvePieces(state, targets, keepIn, faceSet, maxDepth) {
  const moves = [];
  const keep = keepIn.slice();
  let todo = targets.slice();
  while (todo.length) {
    let best = null;
    // already-solved pieces first; otherwise the cheapest of the next few (trying all of them is slow for little gain)
    const done = todo.find((t) => state.codes[t] === HOME[t]);
    for (const t of (done !== undefined ? [done] : todo.slice(0, solvePieces.window))) {
      if (state.codes[t] === HOME[t]) { best = { t, m: [] }; break; }
      const within = best ? best.m.length - 1 : Infinity;
      const t0 = DEBUG ? Date.now() : 0;
      let m = placePiece(state.codes, t, keep, faceSet(t), maxDepth, within);
      if (DEBUG) console.log('place', t, 'keep', keep.length, m && m.length, Date.now() - t0, 'ms');
      if (!m && !best) m = placePiece(state.codes, t, keep, uniq(faceSet(t).concat(freeFacesFor(keep))), maxDepth);
      if (DEBUG) console.log('  fallback', m && m.length, Date.now() - t0, 'ms');
      if (m && (!best || m.length < best.m.length)) best = { t, m };
    }
    if (!best) { // last resort: any face, deeper
      for (const t of todo) {
        const faces = uniq(faceSet(t).concat(facesOfPos[posOfCode(state.codes[t])], freeFacesFor(keep)));
        const m = placePiece(state.codes, t, keep, faces, maxDepth + 2);
        if (m) { best = { t, m }; break; }
      }
    }
    if (!best) throw new Error('could not place a piece');
    state.codes = applyToCodes(state.codes, best.m);
    moves.push(...best.m);
    keep.push(best.t);
    todo = todo.filter((x) => x !== best.t);
  }
  return moves;
}

solvePieces.window = Infinity;

// ---- the last layer: algorithms, in the usual notation with the last layer on top ------------------------------------
const ALG = {
  eo: "F R U R' U' F'",                      // flips two top edges
  sune: "R U R' U R U2' R'",                 // cycles three top edges (corners move too)
  niklas: "R U2' L' U2 R' U2' L U2",         // cycles three top corners, edges stay
  niklas2: "L U' R' U L' U' R U",
  sledge: "R' DR' R DR",                     // twice: twists the top front-right corner (and the layers below, for now)
};
const parseRel = (text, r) => P.parseMoves(text).map((m) => r.face[FACE_IDS.indexOf(m.turn)] * 4 + m.amount - 1);
const invMoves = (ms) => ms.slice().reverse().map(invMove);
const FRONTS = NB[D].map((f) => rotationFor(U, D, FACE_IDS.indexOf('F'), f)); // the 5 ways to hold it, last face on top
const F2L = ALL_POS.filter((p) => !LLE.includes(p) && !LLC.includes(p));
function macrosFor(names) {
  const out = [];
  for (let k = 1; k <= 4; k++) out.push({ moves: [D * 4 + k - 1] });
  for (const r of FRONTS) {
    for (const n of names) {
      const m = parseRel(ALG[n], r);
      out.push({ moves: m }, { moves: invMoves(m) });
    }
  }
  // check: every algorithm keeps the first layers
  const solved = Int16Array.from(HOME);
  for (const x of out) {
    const c = applyToCodes(solved, x.moves);
    if (F2L.some((p) => c[p] !== HOME[p])) throw new Error('a last-layer algorithm disturbs the first layers');
  }
  return out;
}
let MAC = null;
const llPieces = LLE.concat(LLC);
const dOn = (p, code) => { // is the piece's last-layer sticker on the last face?
  const n = isCornerPiece(p) ? 3 : 2; const q = homeFaces[p].indexOf(D);
  const pos = posOfCode(code); const o = oriOfCode(code);
  return G.faceOfSticker[pieceStickers(pos)[(o + q) % n]] === D;
};
/** breadth-first search over "algorithm or last-face turn" until goal(codes) */
function macroSearch(codes, macros, goal, maxDepth) {
  if (goal(codes)) return [];
  const key = (c) => llPieces.map((p) => c[p]).join(',');
  const seen = new Set([key(codes)]);
  let frontier = [{ codes, path: [] }];
  for (let d = 1; d <= maxDepth; d++) {
    const next = [];
    for (const node of frontier) {
      for (let i = 0; i < macros.length; i++) {
        if (i < 4 && node.path.length && node.path[node.path.length - 1] < 4) continue; // no two last-face turns in a row
        const c = applyToCodes(node.codes, macros[i].moves);
        const k = key(c);
        if (seen.has(k)) continue;
        seen.add(k);
        const path = node.path.concat(i);
        if (goal(c)) return path.flatMap((j) => macros[j].moves);
        next.push({ codes: c, path });
      }
    }
    frontier = next;
  }
  return null;
}
function orientCorners(state) {
  // the beginner way: hold a twisted corner at the front right, do R' DR' R DR twice (or four times) until it is right,
  // turn the top to bring the next corner there; the layers below come back by themselves at the end.
  const r = FRONTS[0];
  const sl = parseRel(ALG.sledge, r);
  const solved = Int16Array.from(HOME);
  const c2 = applyToCodes(solved, sl.concat(sl));
  const slot = LLC.find((p) => c2[p] !== HOME[p]); // the corner position the algorithm twists
  const out = [];
  let turned = 0;
  for (let k = 0; k < 5; k++) {
    if (LLC.every((p) => dOn(p, state.codes[p]))) break;
    if (k > 0) { out.push(D * 4); state.codes = applyToCodes(state.codes, [D * 4]); turned++; }
    // the piece now at the slot position
    const at = LLC.find((p) => posOfCode(state.codes[p]) === posOfCode(HOME[slot]));
    if (dOn(at, state.codes[at])) continue;
    // twice one way or (the same as four times) twice the other way, whichever orients it
    const two = sl.concat(sl);
    const after = applyToCodes(state.codes, two);
    const use = dOn(at, after[at]) ? two : invMoves(two);
    out.push(...use); state.codes = applyToCodes(state.codes, use);
  }
  if (turned % 5) { const back = D * 4 + (5 - (turned % 5)) - 1; out.push(back); state.codes = applyToCodes(state.codes, [back]); }
  return out;
}

const simplifyMoves = (ms) => {
  const out = [];
  for (const m of ms) {
    const last = out[out.length - 1];
    if (last !== undefined && moveFace(last) === moveFace(m)) {
      const k = (moveAmount(last) + moveAmount(m)) % 5;
      out.pop();
      if (k) out.push(moveFace(m) * 4 + k - 1);
    } else out.push(m);
  }
  return out;
};

function init(onProgress) {
  const report = typeof onProgress === 'function' ? onProgress : () => {};
  report(0);
  if (!MAC) {
    MAC = { eo: macrosFor(['eo']), ep: macrosFor(['sune']), cp: macrosFor(['niklas', 'niklas2']) };
  }
  report(1);
}

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
/** Solves a validated Megaminx (colours as the puzzle module's validate accepts). */
function solveColours(colours) {
  init();
  const v = def.validate(colours);
  if (!v.ok) throw new Error(v.summary);
  const fidx = v.faces.map((f) => FACE_IDS.indexOf(f));
  // which face is white (else the first face): turn the puzzle in the computer so it is on top
  const W = FACE_IDS.findIndex((f) => v.colourOf[f] === 'w') >= 0 ? FACE_IDS.findIndex((f) => v.colourOf[f] === 'w') : U;
  const name = (fi) => P.colours[v.colourOf[FACE_IDS[fi]]].name;
  const wName = name(W); const lName = name(OPP[W]);
  let best = null;
  for (const r of ROT.filter((x) => x.face[W] === U)) {
    const canon = new Array(P.size);
    for (let s = 0; s < P.size; s++) canon[r.sticker[s]] = r.face[fidx[s]];
    const stages = solveCanon(codesFromFaces(canon), wName, lName);
    const back = new Array(NF); for (let f = 0; f < NF; f++) back[r.face[f]] = f;
    const mapped = stages.map((st) => ({ title: st.title, moves: st.moves.map((m) => ({ turn: FACE_IDS[back[moveFace(m)]], amount: moveAmount(m) })) }));
    const total = mapped.reduce((a, st) => a + st.moves.length, 0);
    if (!best || total < best.total) best = { total, stages: mapped };
    if (!solveColours.tryAll) break;
  }
  const stages = best.stages.filter((st) => st.moves.length).map((st) => ({ title: st.title, moves: P.formatMoves(st.moves) }));
  const moves = stages.map((st) => st.moves).join(' ');
  if (!P.isSolved(P.applyMoves(colours, moves))) throw new Error('internal error: the solution does not solve the puzzle');
  return { moves, stages };
}
solveColours.tryAll = false;

const timing = {};
function solveCanon(codes, wName, lName) {
  const state = { codes: Int16Array.from(codes) };
  const stages = [];
  const keep = [];
  let tt = Date.now();
  const add = (title, ms) => { stages.push({ title, moves: simplifyMoves(ms) }); const now = Date.now(); timing[title.split(':').pop().trim()] = (timing[title.split(':').pop().trim()] || 0) + now - tt; tt = now; };
  const idx = (arr, p) => arr.indexOf(p);
  // 1. star
  add(`${cap(wName)} star`, solvePieces(state, L1E, keep, () => ALL_FACES, 8)); keep.push(...L1E);
  // 2. corners
  add(`${cap(wName)} corners`, solvePieces(state, L1C, keep, (p) => { const i = idx(L1C, p); return [PET[i], PET[(i + 1) % 5], LOW[i]]; }, 10)); keep.push(...L1C);
  // 3. second layer edges
  add('Second layer edges', solvePieces(state, L2E, keep, (p) => { const i = idx(L2E, p); return [PET[i], PET[(i + 1) % 5], LOW[i]]; }, 12)); keep.push(...L2E);
  // 4. third layer
  const l3faces = (p) => {
    const i = L3C.includes(p) ? idx(L3C, p) : Math.floor(idx(L3E, p) / 2);
    return [D, LOW[(i + 4) % 5], LOW[i], LOW[(i + 1) % 5]];
  };
  add('Third layer: corners and edges', solvePieces(state, L3C.concat(L3E), keep, l3faces, 12)); keep.push(...L3C, ...L3E);
  // 5. fourth layer
  const l4faces = (p) => { const i = L4C.includes(p) ? idx(L4C, p) : idx(L4E, p); return [D, LOW[i], LOW[(i + 1) % 5]]; };
  add('Fourth layer: corners and edges', solvePieces(state, L4C.concat(L4E), keep, l4faces, 14)); keep.push(...L4C, ...L4E);
  // 6. last layer
  const run = (ms) => { state.codes = applyToCodes(state.codes, ms); return ms; };
  const eoGoal = (c) => LLE.every((p) => dOn(p, c[p]));
  const eo = macroSearch(state.codes, MAC.eo, eoGoal, 5);
  if (!eo) throw new Error('last layer edges: no algorithm found');
  add(`Last layer: orient edges (${lName} star)`, run(eo));
  const epGoal = (c) => LLE.every((p) => c[p] === HOME[p]);
  const ep = macroSearch(state.codes, MAC.ep, epGoal, 5);
  if (!ep) throw new Error('last layer edges: could not place them');
  add('Last layer: place edges', run(ep));
  const cpGoal = (c) => epGoal(c) && LLC.every((p) => posOfCode(c[p]) === posOfCode(HOME[p]));
  const cp = macroSearch(state.codes, MAC.cp, cpGoal, 4);
  if (!cp) throw new Error('last layer corners: could not place them');
  add('Last layer: place corners', run(cp));
  add('Last layer: orient corners', orientCorners(state));
  if (state.codes.some((c, p) => c !== HOME[p])) throw new Error('internal error: the puzzle is not solved at the end');
  return stages;
}

/** The solver interface: { moves, stages: [{ title, moves }] } in the puzzle's notation. */
function solve(colours) { return solveColours(colours); }

module.exports = {
  init,
  solve,
  // internals for the tests and development
  _internal: {
    P, G, TRANS, HOME, NPIECE, NCODE, ROT, rotationFor, codesFromFaces, applyToCodes, placeSearch, extractSearch, freeRoutes,
    posOfCode, oriOfCode, codeOf, homeFaces, facesOfPos, layerHas, pairTable, movesOfFaces,
    PET, LOW, L1E, L1C, L2E, L3C, L3E, L4C, L4E, LLE, LLC, U, D, FACE_IDS, NB, OPP, invMove, moveFace, moveAmount,
    nodes: () => nodes, timing, solvePieces,
  },
};
