'use strict';
// Optimal 3x2x2 solver (fewest turns; R, L quarter turns and R2, L2, U2, D2, F2, B2 each count 1). The 8 corners can be in
// any of 8! orders and the 4 middle edges in any of 4! (nothing can twist or flip with these turns: see the puzzle file), so
// there are 8! x 4! = 967,680 positions. A breadth-first search from the solved position stores every position's distance
// (one byte each, under 1 MB); solving walks down that table one turn at a time, which is optimal by construction. The
// whole puzzle may be held 4 ways that are all "solved" (turned half way round about any axis), so the shortest of the 4 is
// taken.
const def = require('../puzzles/cuboid322');
const { kindTables, permOf, rankPerm } = require('./cuboid-common');

const { slots, moves, read } = def.kit;
const puzzle = def.puzzle;
const NM = moves.length;
const CORNERS = slots.filter((s) => s.kind === 'corner').map((s) => s.index);
const EDGES = slots.filter((s) => s.kind === 'edge').map((s) => s.index);

let T = null;
/** Builds the move tables and the distance table (about 0.1 s). */
function init(onProgress) {
  if (T) return T;
  const t0 = Date.now();
  const ck = kindTables(CORNERS, moves);
  const ek = kindTables(EDGES, moves);
  const NE = ek.count;
  const size = ck.count * NE;
  const dist = new Uint8Array(size).fill(255);
  dist[0] = 0;
  let frontier = new Uint32Array([0]); const counts = [1];
  for (let d = 0; frontier.length; d++) {
    const next = new Uint32Array(Math.min(size, frontier.length * NM)); let nn = 0;
    for (let k = 0; k < frontier.length; k++) {
      const s = frontier[k]; const c = Math.floor(s / NE) * NM; const e = (s % NE) * NM;
      for (let m = 0; m < NM; m++) {
        const t = ck.table[c + m] * NE + ek.table[e + m];
        if (dist[t] === 255) { dist[t] = d + 1; next[nn++] = t; }
      }
    }
    frontier = next.subarray(0, nn);
    if (nn) counts.push(nn);
    if (onProgress) onProgress(Math.min(1, counts.reduce((a, b) => a + b, 0) / size));
  }
  T = { ck, ek, NE, dist, counts, ms: Date.now() - t0 };
  return T;
}

const indexOf = (t, at) => rankPerm(permOf(CORNERS, t.ck.pos, at)) * t.NE + rankPerm(permOf(EDGES, t.ek.pos, at));

/** Distance (fewest turns) of a valid colour array, or -1 if it is not a real position. */
function distance(colours) {
  const t = init();
  const ways = read(colours).valid;
  if (!ways.length) return -1;
  return Math.min(...ways.map((w) => t.dist[indexOf(t, w.at)]));
}

/** Solves a filled-in 3x2x2 (colour keys, any way of holding it). Returns { moves, stages }, or throws in plain words. */
function solve(colours) {
  const t = init();
  const ways = read(colours).valid;
  if (!ways.length) throw new Error('This is not a position a 3x2x2 can get into by turning (check the colours first).');
  let s = -1; let best = 255;
  for (const w of ways) { const i = indexOf(t, w.at); if (t.dist[i] < best) { best = t.dist[i]; s = i; } }
  if (best === 255) throw new Error('internal: this position is not in the table');
  const out = [];
  while (t.dist[s] > 0) {
    const d = t.dist[s]; const c = Math.floor(s / t.NE) * NM; const e = (s % t.NE) * NM;
    let found = -1;
    for (let m = 0; m < NM && found < 0; m++) {
      const n = t.ck.table[c + m] * t.NE + t.ek.table[e + m];
      if (t.dist[n] === d - 1) { found = n; out.push(moves[m]); }
    }
    if (found < 0) throw new Error('internal: the distance table is inconsistent');
    s = found;
  }
  const text = puzzle.formatMoves(out);
  if (!puzzle.isSolved(puzzle.applyMoves(colours, out))) throw new Error('internal: the solution does not solve it');
  return { moves: text, stages: [{ title: out.length ? 'Solve' : 'Already solved', moves: text }] };
}

module.exports = { init, solve, distance };
