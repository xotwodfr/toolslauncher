'use strict';
// Helpers shared by the two cuboid solvers (Node only): permutation ranks, move tables on the pieces of one kind, and
// turning a filled-in colour array into piece permutations for every way of holding the puzzle that makes it real.

const FACT = [1];
for (let i = 1; i <= 12; i++) FACT.push(FACT[i - 1] * i);

/** Rank of a permutation of 0..n-1 (Lehmer code). */
function rankPerm(p) {
  const n = p.length; let r = 0;
  for (let i = 0; i < n; i++) { let s = 0; for (let j = i + 1; j < n; j++) if (p[j] < p[i]) s++; r += s * FACT[n - 1 - i]; }
  return r;
}
function unrankPerm(r, n) {
  const pool = Array.from({ length: n }, (_, i) => i); const p = [];
  for (let i = 0; i < n; i++) { const f = FACT[n - 1 - i]; const k = Math.floor(r / f); r %= f; p.push(pool.splice(k, 1)[0]); }
  return p;
}

/**
 * The pieces of one kind (e.g. the corners): `group` = their slot indices. A permutation p of 0..n-1 means: the place
 * group[k] holds the piece whose home is group[p[k]]. Returns, for every move, the permutation of places it causes, and the
 * full move table on ranks (Uint16Array or Uint32Array, n! x moves).
 */
function kindTables(group, moves) {
  const n = group.length;
  const pos = new Map(group.map((s, k) => [s, k]));
  const placePerm = moves.map((m) => group.map((s) => pos.get(m.slotPerm[s])));
  const count = FACT[n];
  const table = count <= 65536 ? new Uint16Array(count * moves.length) : new Uint32Array(count * moves.length);
  const nm = moves.length;
  for (let r = 0; r < count; r++) {
    const p = unrankPerm(r, n);
    for (let m = 0; m < nm; m++) {
      const q = placePerm[m]; const out = new Array(n);
      for (let k = 0; k < n; k++) out[k] = p[q[k]];
      table[r * nm + m] = rankPerm(out);
    }
  }
  return { n, count, placePerm, table, pos };
}

/** The permutation (as above) of one kind of piece in a read position (`at` = piece per slot, piece = its home slot). */
function permOf(group, pos, at) {
  return group.map((s) => pos.get(at[s].piece));
}

module.exports = { FACT, rankPerm, unrankPerm, kindTables, permOf };
