'use strict';
// Optimal 3x3x2 (Domino) solver: fewest turns, where U, U', U2, D, D', D2, R2, L2, F2 and B2 each count 1.
//
// A position is the order of the 8 corners (8! = 40,320) and of the 8 edges (8!): 1,625,702,400 positions, too many for
// one table, so this is an IDA* search (depth-first with a growing limit) guided by lower bounds read from tables:
//   - corners + where 3 of the top edges are:     40,320 x 336 = 13.5 million entries (one byte each)
//   - corners + where 3 of the bottom edges are:  the same size
//   - the edges alone:                            40,320 entries
// Each table holds the exact number of turns needed to solve that part, found by a breadth-first search from solved, so the
// largest of the three never overestimates and the first solution found within the limit is a shortest one. The whole
// puzzle can be held 4 ways that each count as solved (turned about the vertical axis), so all 4 are searched together at
// each limit. Building the tables takes about 2 s and 30 MB; a solve takes milliseconds (rarely more than 0.1 s).
const def = require('../puzzles/cuboid332');
const { kindTables, permOf, rankPerm, unrankPerm } = require('./cuboid-common');

const { slots, moves, read } = def.kit;
const puzzle = def.puzzle;
const NM = moves.length;
const CORNERS = slots.filter((s) => s.kind === 'corner').map((s) => s.index);
const EDGES = slots.filter((s) => s.kind === 'edge').map((s) => s.index);
const TOP_EDGES = EDGES.map((s, k) => [s, k]).filter(([s]) => slots[s].faces.includes('U')).map(([, k]) => k);
const BOTTOM_EDGES = EDGES.map((s, k) => [s, k]).filter(([s]) => slots[s].faces.includes('D')).map(([, k]) => k);
const AXIS = { U: 0, D: 0, R: 1, L: 1, F: 2, B: 2 };
const TURN_NAMES = puzzle.turnNames;
const moveTurn = moves.map((m) => TURN_NAMES.indexOf(m.turn));
const turnAxis = TURN_NAMES.map((t) => AXIS[t]);

/** A table: corners x the places of `pieces` (some edges), as exact distances. */
function partialTable(ck, ek, pieces) {
  const K = pieces.length;
  const code = new Map(); const tuples = [];
  const walk = (pre) => {
    if (pre.length === K) { code.set(pre.join(','), tuples.length); tuples.push(pre.slice()); return; }
    for (let p = 0; p < 8; p++) if (!pre.includes(p)) { pre.push(p); walk(pre); pre.pop(); }
  };
  walk([]);
  const NP = tuples.length;
  // a piece at place k goes to the place j with placePerm[j] = k
  const inv = ek.placePerm.map((q) => { const r = new Array(8); q.forEach((v, j) => { r[v] = j; }); return r; });
  const pmove = new Uint16Array(NP * NM);
  for (let i = 0; i < NP; i++) for (let m = 0; m < NM; m++) pmove[i * NM + m] = code.get(tuples[i].map((k) => inv[m][k]).join(','));
  const ofEdges = new Uint16Array(ek.count); // edge rank -> code of the places of `pieces`
  for (let r = 0; r < ek.count; r++) { const p = unrankPerm(r, 8); ofEdges[r] = code.get(pieces.map((pc) => p.indexOf(pc)).join(',')); }
  const SZ = ck.count * NP;
  const dist = new Uint8Array(SZ).fill(255);
  dist[ofEdges[0]] = 0;
  let filled = 1;
  const ct = ck.table;
  for (let d = 0; filled < SZ; d++) {
    let n = 0;
    if (filled < SZ / 2) { // forwards: from every position at distance d
      for (let s = 0; s < SZ; s++) {
        if (dist[s] !== d) continue;
        const c = Math.floor(s / NP) * NM; const e = (s % NP) * NM;
        for (let m = 0; m < NM; m++) { const t = ct[c + m] * NP + pmove[e + m]; if (dist[t] === 255) { dist[t] = d + 1; n++; } }
      }
    } else { // backwards: every position not reached yet that is one turn from distance d
      for (let s = 0; s < SZ; s++) {
        if (dist[s] !== 255) continue;
        const c = Math.floor(s / NP) * NM; const e = (s % NP) * NM;
        for (let m = 0; m < NM; m++) { if (dist[ct[c + m] * NP + pmove[e + m]] === d) { dist[s] = d + 1; n++; break; } }
      }
    }
    if (!n) break;
    filled += n;
  }
  return { NP, dist, ofEdges };
}

let T = null;
/** Builds the move and distance tables (about 2 s, about 30 MB). */
function init(onProgress) {
  if (T) return T;
  const t0 = Date.now();
  const ck = kindTables(CORNERS, moves);
  const ek = kindTables(EDGES, moves);
  if (onProgress) onProgress(0.1);
  const top = partialTable(ck, ek, TOP_EDGES.slice(0, 3));
  if (onProgress) onProgress(0.55);
  const bottom = partialTable(ck, ek, BOTTOM_EDGES.slice(0, 3));
  if (onProgress) onProgress(0.98);
  const edgeDist = new Uint8Array(ek.count).fill(255);
  edgeDist[0] = 0;
  for (let frontier = [0], d = 0; frontier.length; d++) {
    const next = [];
    for (const s of frontier) for (let m = 0; m < NM; m++) { const t = ek.table[s * NM + m]; if (edgeDist[t] === 255) { edgeDist[t] = d + 1; next.push(t); } }
    frontier = next;
  }
  if (onProgress) onProgress(1);
  T = { ck, ek, top, bottom, edgeDist, ms: Date.now() - t0 };
  return T;
}

function search(t, starts, maxDepth) {
  const ct = t.ck.table; const et = t.ek.table;
  const tp = t.top; const bt = t.bottom; const ed = t.edgeDist;
  const h = (c, e) => {
    const a = tp.dist[c * tp.NP + tp.ofEdges[e]]; const b = bt.dist[c * bt.NP + bt.ofEdges[e]]; const x = ed[e];
    return a > b ? (a > x ? a : x) : (b > x ? b : x);
  };
  const path = [];
  let nodes = 0;
  const dfs = (c, e, g, bound, last) => {
    nodes++;
    if (c === 0 && e === 0) return true;
    if (g + h(c, e) > bound) return false;
    for (let m = 0; m < NM; m++) {
      const tn = moveTurn[m];
      // never the same face twice in a row; two turns on the same axis (U and D, R2 and L2, F2 and B2) in one order only
      if (last >= 0 && (tn === last || (turnAxis[tn] === turnAxis[last] && tn < last))) continue;
      path.push(m);
      if (dfs(ct[c * NM + m], et[e * NM + m], g + 1, bound, tn)) return true;
      path.pop();
    }
    return false;
  };
  for (let bound = Math.min(...starts.map(([c, e]) => h(c, e))); bound <= maxDepth; bound++) {
    for (const [c, e] of starts) {
      path.length = 0;
      if (dfs(c, e, 0, bound, -1)) return { path: path.slice(), nodes };
    }
  }
  return null;
}

/** The ways of holding it that make the colours a real position, as [corner rank, edge rank]. */
function startsOf(t, colours) {
  return read(colours).valid.map((w) => [rankPerm(permOf(CORNERS, t.ck.pos, w.at)), rankPerm(permOf(EDGES, t.ek.pos, w.at))]);
}

/** Solves a filled-in 3x3x2 (colour keys, any way of holding it). Returns { moves, stages }, or throws in plain words. */
function solve(colours) {
  const t = init();
  const starts = startsOf(t, colours);
  if (!starts.length) throw new Error('This is not a position a 3x3x2 can get into by turning (check the colours first).');
  const r = search(t, starts, 40);
  if (!r) throw new Error('internal: no solution found');
  const out = r.path.map((m) => moves[m]);
  if (!puzzle.isSolved(puzzle.applyMoves(colours, out))) throw new Error('internal: the solution does not solve it');
  const text = puzzle.formatMoves(out);
  return { moves: text, stages: [{ title: out.length ? 'Solve' : 'Already solved', moves: text }], nodes: r.nodes };
}

/** Fewest turns for a valid colour array (-1 if it is not a real position). */
function distance(colours) {
  const t = init();
  const starts = startsOf(t, colours);
  if (!starts.length) return -1;
  return search(t, starts, 40).path.length;
}

module.exports = { init, solve, distance };
