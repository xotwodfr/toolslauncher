'use strict';
// Optimal 2x2 solver (fewest turns, face-turn metric). The bottom-back-left corner is held still, so only U, R and F turns
// are needed and every position is one of 7! x 3^6 = 3,674,160 states. A breadth-first search from the solved state stores
// the distance of every state (one byte each); solving is then a walk down that table, one turn at a time, which is
// optimal by construction. God's number for the 2x2 in this metric is 11.
const C = require('./cube');

const N_PERM = 5040; // 7!
const N_ORI = 729;   // 3^6
const N_STATES = N_PERM * N_ORI;
const MOVES = ['U', 'U2', "U'", 'R', 'R2', "R'", 'F', 'F2', "F'"];
const MOVABLE = [0, 1, 2, 3, 4, 5, 7]; // corner positions; 6 (DBL) never moves

// the corner effect of each turn, read from the sticker model so the two can never disagree
function moveCubies() {
  return MOVES.map((m) => C.toCubies(2, C.applyMoves(2, C.solvedFaces(2), [m])));
}
const FACT = [1, 1, 2, 6, 24, 120, 720, 5040];
function rankPerm(p) { // p: 7 values 0..6
  let r = 0;
  for (let i = 0; i < 7; i++) { let s = 0; for (let j = i + 1; j < 7; j++) if (p[j] < p[i]) s++; r += s * FACT[6 - i]; }
  return r;
}
function unrankPerm(r) {
  const pool = [0, 1, 2, 3, 4, 5, 6]; const p = [];
  for (let i = 0; i < 7; i++) { const f = FACT[6 - i]; const k = Math.floor(r / f); r %= f; p.push(pool.splice(k, 1)[0]); }
  return p;
}
// position k in 0..6 <-> corner position MOVABLE[k]
const toSlot = (pos) => (pos === 7 ? 6 : pos);
const fromSlot = (k) => (k === 6 ? 7 : k);

/** Pieces -> table index, or -1 when the bottom-back-left corner is not in place. */
function indexOf({ cp, co }) {
  if (cp[6] !== 6 || co[6] !== 0) return -1;
  const p = MOVABLE.map((pos) => toSlot(cp[pos]));
  let o = 0;
  for (let i = 0; i < 6; i++) o = o * 3 + co[i];
  return rankPerm(p) * N_ORI + o;
}
function cubiesOf(index) {
  const p = unrankPerm(Math.floor(index / N_ORI));
  let o = index % N_ORI;
  const co = new Array(8).fill(0);
  for (let i = 5; i >= 0; i--) { co[i] = o % 3; o = Math.floor(o / 3); }
  co[7] = (3 - (co.slice(0, 6).reduce((s, x) => s + x, 0) % 3)) % 3;
  const cp = new Array(8);
  MOVABLE.forEach((pos, k) => { cp[pos] = fromSlot(p[k]); });
  cp[6] = 6;
  return { cp, co };
}
// state then move: position i gets what was at move.cp[i]
function multiply(a, m) {
  const cp = new Array(8); const co = new Array(8);
  for (let i = 0; i < 8; i++) { cp[i] = a.cp[m.cp[i]]; co[i] = (a.co[m.cp[i]] + m.co[i]) % 3; }
  return { cp, co };
}

let tables = null;
/** Builds the move tables and the distance table (well under a second). */
function init(onProgress) {
  if (tables) return tables;
  const t0 = Date.now();
  const mc = moveCubies();
  const permMove = new Uint16Array(N_PERM * 9);
  for (let r = 0; r < N_PERM; r++) {
    const p = unrankPerm(r);
    const cp = new Array(8); MOVABLE.forEach((pos, k) => { cp[pos] = fromSlot(p[k]); }); cp[6] = 6;
    for (let m = 0; m < 9; m++) {
      const out = mc[m].cp.map((x) => cp[x]);
      permMove[r * 9 + m] = rankPerm(MOVABLE.map((pos) => toSlot(out[pos])));
    }
  }
  const oriMove = new Uint16Array(N_ORI * 9);
  for (let o = 0; o < N_ORI; o++) {
    const { co } = cubiesOf(o); // permutation part 0 = identity
    for (let m = 0; m < 9; m++) {
      const moved = multiply({ cp: [0, 1, 2, 3, 4, 5, 6, 7], co }, mc[m]).co;
      let v = 0; for (let i = 0; i < 6; i++) v = v * 3 + moved[i];
      oriMove[o * 9 + m] = v;
    }
  }
  if (onProgress) onProgress(0.2);
  const dist = new Uint8Array(N_STATES).fill(255);
  dist[0] = 0;
  const counts = [1];
  let frontier = new Uint32Array([0]);
  for (let d = 0; frontier.length; d++) {
    const next = [];
    for (let k = 0; k < frontier.length; k++) {
      const s = frontier[k];
      const pr = Math.floor(s / N_ORI) * 9; const or = (s % N_ORI) * 9;
      for (let m = 0; m < 9; m++) {
        const t = permMove[pr + m] * N_ORI + oriMove[or + m];
        if (dist[t] === 255) { dist[t] = d + 1; next.push(t); }
      }
    }
    if (next.length) counts.push(next.length);
    frontier = Uint32Array.from(next);
    if (onProgress) onProgress(0.2 + 0.8 * Math.min(1, counts.reduce((s, x) => s + x, 0) / N_STATES));
  }
  tables = { permMove, oriMove, dist, counts, ms: Date.now() - t0 };
  return tables;
}

/** Solves a 2x2 given as face letters (24, URFDLB order). Returns the moves, or throws in plain words. */
function solve(faces) {
  const t = init();
  const cub = C.toCubies(2, faces);
  if (!cub) throw new Error('That is not a real 2x2 position');
  let s = indexOf(cub);
  if (s < 0) throw new Error('The bottom-back-left corner must be in place to solve (fix the colour mapping first)');
  const out = [];
  while (t.dist[s] > 0) {
    const d = t.dist[s];
    const pr = Math.floor(s / N_ORI) * 9; const or = (s % N_ORI) * 9;
    let found = -1;
    for (let m = 0; m < 9; m++) {
      const n = t.permMove[pr + m] * N_ORI + t.oriMove[or + m];
      if (t.dist[n] === d - 1) { found = n; out.push(MOVES[m]); break; }
    }
    if (found < 0) throw new Error('internal: the distance table is inconsistent');
    s = found;
  }
  return out;
}
const distance = (faces) => { const t = init(); const s = indexOf(C.toCubies(2, faces)); return s < 0 ? -1 : t.dist[s]; };

module.exports = { init, solve, distance, indexOf, cubiesOf, N_STATES, MOVES };
