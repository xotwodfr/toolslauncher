'use strict';
// Optimal Pyraminx solver (fewest turns; U and U' each count as one turn, a tip turn counts as one).
//
// The tips can be twisted on their own and nothing else moves them relative to their centres, so they are solved apart:
// each wrong tip needs exactly one tip turn. The rest (4 centres that twist in place, 6 edges that move and flip) has
// 3^4 x 6!/2 x 2^5 = 933,120 positions. A breadth-first search from the solved state stores the distance of every one
// (one byte each, indexed by edge permutation x edge flips x centre twists, 3.7 MB with the unreachable half included);
// solving is a walk down that table, one turn at a time, which is optimal by construction (the most is 11 turns, plus up
// to 4 tip turns). The solution turns the tips first (the quick part a person usually does first), then the rest; tip turns
// commute with everything, so this order costs nothing.
const P = require('../puzzles/pyraminx');

const pz = P.puzzle;
const BODY = ['U', 'L', 'R', 'B'];
const MOVES = []; for (const t of BODY) MOVES.push({ turn: t, amount: 1 }, { turn: t, amount: 2 });
const NM = MOVES.length;
const N_PERM = 720; const N_EO = 64; const N_CC = 81;
const N_STATES = N_PERM * N_EO * N_CC;

const FACT = [1, 1, 2, 6, 24, 120];
function rankPerm(p) { let r = 0; for (let i = 0; i < 6; i++) { let s = 0; for (let j = i + 1; j < 6; j++) if (p[j] < p[i]) s++; r += s * FACT[5 - i]; } return r; }
function unrankPerm(r) { const pool = [0, 1, 2, 3, 4, 5]; const p = []; for (let i = 0; i < 6; i++) { const f = FACT[5 - i]; const k = Math.floor(r / f); r %= f; p.push(pool.splice(k, 1)[0]); } return p; }
const eoBits = (eo) => eo.reduce((s, x, i) => s | (x << i), 0);
const ccIndex = (cc) => cc.reduce((s, x) => s * 3 + x, 0);
function indexOf(pcs) { return (rankPerm(pcs.ep) * N_EO + eoBits(pcs.eo)) * N_CC + ccIndex(pcs.cc); }
/** Table index -> pieces (tips solved). */
function piecesOf(index) {
  const c = index % N_CC; const q = (index - c) / N_CC; const o = q % N_EO; const r = (q - o) / N_EO;
  return { ep: unrankPerm(r), eo: [0, 1, 2, 3, 4, 5].map((i) => (o >> i) & 1), cc: [Math.floor(c / 27) % 3, Math.floor(c / 9) % 3, Math.floor(c / 3) % 3, c % 3], tt: [Math.floor(c / 27) % 3, Math.floor(c / 9) % 3, Math.floor(c / 3) % 3, c % 3] };
}

// what each turn does to the pieces, read from the sticker model so the two can never disagree
const moveEffect = (mv) => P.readPieces(pz.applyMoves(pz.solvedFaces(), [mv]));

let tables = null;
/** Builds the move tables and the distance table (about a tenth of a second). */
function init(onProgress) {
  if (tables) return tables;
  const t0 = Date.now();
  const fx = MOVES.map(moveEffect);
  const permMove = new Uint16Array(N_PERM * NM); const eoMove = new Uint8Array(N_EO * NM); const ccMove = new Uint8Array(N_CC * NM);
  for (let r = 0; r < N_PERM; r++) {
    const p = unrankPerm(r);
    for (let m = 0; m < NM; m++) permMove[r * NM + m] = rankPerm(fx[m].ep.map((j) => p[j]));
  }
  for (let o = 0; o < N_EO; o++) {
    for (let m = 0; m < NM; m++) {
      const e = fx[m];
      let v = 0; for (let i = 0; i < 6; i++) v |= (((o >> e.ep[i]) & 1) ^ e.eo[i]) << i;
      eoMove[o * NM + m] = v;
    }
  }
  for (let c = 0; c < N_CC; c++) {
    const cc = [Math.floor(c / 27) % 3, Math.floor(c / 9) % 3, Math.floor(c / 3) % 3, c % 3];
    for (let m = 0; m < NM; m++) ccMove[c * NM + m] = ccIndex(cc.map((x, v) => (x + fx[m].cc[v]) % 3));
  }
  const next = (s, m) => {
    const c = s % N_CC; const q = (s - c) / N_CC; const o = q % N_EO; const r = (q - o) / N_EO;
    return (permMove[r * NM + m] * N_EO + eoMove[o * NM + m]) * N_CC + ccMove[c * NM + m];
  };
  const dist = new Uint8Array(N_STATES).fill(255);
  dist[0] = 0;
  const counts = [1];
  let frontier = new Uint32Array([0]); let total = 1;
  for (let d = 0; frontier.length; d++) {
    const out = new Uint32Array(frontier.length * NM); let n = 0;
    for (let k = 0; k < frontier.length; k++) {
      const s = frontier[k];
      for (let m = 0; m < NM; m++) { const t = next(s, m); if (dist[t] === 255) { dist[t] = d + 1; out[n++] = t; } }
    }
    if (n) counts.push(n);
    total += n;
    frontier = out.slice(0, n);
    if (onProgress) onProgress(Math.min(1, total / 933120));
  }
  // what a tip turn does to its tip (+1 or +2 twist per turn)
  const tipStep = BODY.map((t, v) => moveEffect({ turn: t.toLowerCase(), amount: 1 }).tt[v]);
  tables = { dist, counts, next, tipStep, ms: Date.now() - t0 };
  return tables;
}

/** Plans the solution from colours. Returns { tips: [moves], body: [moves] }, or throws in plain words. */
function plan(colours) {
  const t = init();
  const v = P.validate(colours);
  if (!v.ok) throw new Error(v.summary);
  const pcs = P.readPieces(v.faces);
  const tips = [];
  pcs.tt.forEach((x, k) => {
    const rel = ((x - pcs.cc[k]) % 3 + 3) % 3;
    if (!rel) return;
    for (let a = 1; a < 3; a++) if ((rel + t.tipStep[k] * a) % 3 === 0) { tips.push({ turn: BODY[k].toLowerCase(), amount: a }); break; }
  });
  let s = indexOf(pcs);
  if (t.dist[s] === 255) throw new Error('internal: this position is not in the table');
  const body = [];
  while (t.dist[s] > 0) {
    const d = t.dist[s];
    let found = -1;
    for (let m = 0; m < NM; m++) { const n = t.next(s, m); if (t.dist[n] === d - 1) { found = n; body.push(MOVES[m]); break; } }
    if (found < 0) throw new Error('internal: the distance table is inconsistent');
    s = found;
  }
  if (!pz.isSolved(pz.applyMoves(v.faces, tips.concat(body)))) throw new Error('internal: the solution does not solve the puzzle');
  return { tips, body };
}

/** colours: one colour key per sticker (any way round the user held it). */
function solve(colours) {
  const { tips, body } = plan(colours);
  const stages = [];
  if (tips.length) stages.push({ title: 'Turn the tips', moves: pz.formatMoves(tips) });
  if (body.length) stages.push({ title: 'Solve the rest', moves: pz.formatMoves(body) });
  return { moves: pz.formatMoves(tips.concat(body)), stages };
}

/** Fewest turns for a position given as face letters: [body turns, tip turns]. */
function distance(faces) {
  const t = init(); const pcs = P.readPieces(faces);
  return [t.dist[indexOf(pcs)], pcs.tt.filter((x, k) => x !== pcs.cc[k]).length];
}

module.exports = { init, solve, plan, distance, indexOf, piecesOf, MOVES, N_STATES };
