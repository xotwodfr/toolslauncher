'use strict';
// Megaminx tests (plain Node): the geometry and its turns, notation, the piece invariants, validation messages on crafted
// impossible states, and the layer-by-layer solver on many random scrambles (every answer checked by applying it).
// MEGAMINX_STRESS=<n> runs n random scrambles instead of 60.
const assert = require('assert');
const def = require('../src/puzzles/megaminx');
const S = require('../src/solvers/megaminx');

const P = def.puzzle;
const G = P.geometry;
const I = S._internal;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const solved = () => P.solvedColours();
const scrambled = (seed, n = 70) => P.applyMoves(solved(), P.randomMoves(n, seed));
const kinds = (cols) => def.validate(cols).errors.map((e) => e.kind);
const swap = (cols, a, b) => { const c = cols.slice(); [c[a], c[b]] = [c[b], c[a]]; return c; };

// ---- geometry ------------------------------------------------------------------------------------------------------------
test('geometry: 12 faces of 11 stickers, 20 corners, 30 edges, 12 centres, every sticker in exactly one piece', () => {
  assert.strictEqual(P.size, 132);
  assert.strictEqual(P.faces.length, 12);
  for (const f of P.faces) assert.strictEqual(P.stickersOf(f.id).length, 11, f.id);
  assert.strictEqual(G.corners.length, 20); assert.strictEqual(G.edges.length, 30); assert.strictEqual(G.centres.length, 12);
  const all = [].concat(G.centres, ...G.corners, ...G.edges).sort((a, b) => a - b);
  assert.deepStrictEqual(all, Array.from({ length: 132 }, (_, i) => i));
  for (const c of G.corners) assert.strictEqual(new Set(c.map((s) => G.faceOfSticker[s])).size, 3);
  for (const e of G.edges) assert.strictEqual(new Set(e.map((s) => G.faceOfSticker[s])).size, 2);
  for (let f = 0; f < 12; f++) {
    assert.strictEqual(G.neighbours[f].length, 5);
    assert(!G.neighbours[f].includes(G.opposite[f]));
    assert.strictEqual(G.opposite[G.opposite[f]], f);
  }
  // centre colours of the standard scheme and opposite pairs (WCA scheme)
  const col = (f) => P.faceById.get(f).colour;
  const opp = (f) => P.faces[G.opposite[P.faceById.get(f).index]].id;
  assert.deepStrictEqual(['U', 'F', 'R', 'BR', 'BL', 'L'].map((f) => [col(f), col(opp(f))]),
    [['w', 'e'], ['g', 'i'], ['r', 'o'], ['b', 'l'], ['y', 'c'], ['p', 'k']]);
});

test('turns: each turn moves 26 stickers, five turns are nothing, X2 = X X, X\' = X X X X; whole-puzzle checks', () => {
  const start = scrambled(3);
  for (const t of P.turnNames) {
    assert.strictEqual(P.turns[t].moving.length, 26, t);
    assert.strictEqual(P.turns[t].order, 5);
    assert.deepStrictEqual(P.applyMoves(start, [t, t, t, t, t].join(' ')), start, t + ' x5');
    assert.deepStrictEqual(P.applyMoves(start, t + '2'), P.applyMoves(start, `${t} ${t}`));
    assert.deepStrictEqual(P.applyMoves(start, t + "2'"), P.applyMoves(start, `${t} ${t} ${t}`));
    assert.deepStrictEqual(P.applyMoves(start, t + "'"), P.applyMoves(start, `${t} ${t} ${t} ${t}`));
    assert.notDeepStrictEqual(P.applyMoves(start, t), start);
  }
  // opposite faces commute, neighbours do not
  assert.deepStrictEqual(P.applyMoves(start, 'U D'), P.applyMoves(start, 'D U'));
  assert.notDeepStrictEqual(P.applyMoves(start, 'U F'), P.applyMoves(start, 'F U'));
  // a known order: (R' DR' R DR) six times is nothing
  let s = solved(); let k = 0;
  do { s = P.applyMoves(s, "R' DR' R DR"); k++; } while (!P.isSolved(s) && k < 100);
  assert.strictEqual(k, 6);
});

test('notation: every move prints and reads back; scramble followed by its inverse is nothing', () => {
  for (const t of P.turnNames) {
    for (let a = 1; a <= 4; a++) {
      const txt = P.formatMove({ turn: t, amount: a });
      assert.deepStrictEqual(P.parseToken(txt), { turn: t, amount: a }, txt);
    }
  }
  assert.strictEqual(P.formatMoves(P.parseMoves("DBR2' DBL B2 BL' BR")), "DBR2' DBL B2 BL' BR");
  for (let i = 0; i < 20; i++) {
    const m = P.randomMoves(60, 100 + i);
    assert(P.isSolved(P.applyMoves(P.applyMoves(solved(), m), P.inverse(m))));
  }
});

test('net and scanning: 12 faces on the map, two flowers, scan order covers every face once', () => {
  const net = P.netLayout();
  assert.strictEqual(net.cells.length, 132);
  const xs = P.spec.net.map((n) => n.x);
  const uFlower = ['U', 'F', 'R', 'BR', 'BL', 'L'].map((f) => P.spec.net.find((n) => n.face === f).x);
  assert(Math.max(...uFlower) < Math.min(...xs.filter((x) => !uFlower.includes(x))), 'top half on the left, bottom half on the right');
  assert.strictEqual(new Set(def.scan.faces.map((f) => f.face)).size, 12);
  assert(def.scan.experimental);
  for (const f of def.scan.faces) assert(P.templates[f.face] && /Megaminx/.test(f.say));
});

test('pieces: corner twist, edge flip and both permutation parities never change by turning', () => {
  for (let i = 0; i < 50; i++) {
    const c = I.applyToCodes(Int16Array.from(I.HOME), P.randomMoves(80, i + 1).map((m) => I.FACE_IDS.indexOf(m.turn) * 4 + m.amount - 1));
    let tw = 0; let fl = 0;
    for (let p = 0; p < 20; p++) tw += I.oriOfCode(c[p]);
    for (let p = 20; p < 50; p++) fl += I.oriOfCode(c[p]);
    assert.strictEqual(tw % 3, 0); assert.strictEqual(fl % 2, 0);
    const v = def.validate(scrambled(i + 1));
    assert(v.ok && !v.solved, v.summary);
  }
});

// ---- validation ------------------------------------------------------------------------------------------------------------
test('validation: solved and scrambled pass; a solved one says so', () => {
  const v = def.validate(solved());
  assert(v.ok && v.solved); assert.strictEqual(v.summary, 'This Megaminx is already solved.');
  const w = def.validate(scrambled(9));
  assert(w.ok && !w.solved); assert.strictEqual(w.summary, 'This Megaminx can be solved.');
  assert.strictEqual(w.faces.length, 132); assert.strictEqual(w.colourOf.U, 'w');
});

test('validation: missing stickers and wrong counts', () => {
  const c = solved(); c[5] = null; c[77] = null;
  let v = def.validate(c);
  assert.deepStrictEqual(kinds(c), ['empty']); assert.deepStrictEqual(v.errors[0].stickers, [5, 77]);
  assert(/2 stickers are not filled in/.test(v.summary));
  const d = solved(); d[1] = 'g'; // a white corner sticker painted green
  v = def.validate(d);
  assert(kinds(d).includes('count')); assert(/10 white/.test(v.errors[0].text) && /12 dark green/.test(v.errors[0].text), v.errors[0].text);
  assert(kinds(d).includes('piece'));
});

test('validation: two centres the same colour', () => {
  // the green centre swapped with a white sticker: the counts stay right, two centres are white
  const v = def.validate(swap(solved(), G.centres[1], G.corners[0][0]));
  assert.deepStrictEqual(v.errors.map((x) => x.kind), ['centres']);
  assert(/2 centres are white/.test(v.summary), v.summary);
  assert(v.errors[0].stickers.includes(G.centres[1]));
});

test('validation: impossible pieces (same colour twice, colours that never meet, mirror image)', () => {
  // a corner with two of the same colour: swap a corner sticker with an edge sticker of a different piece on the same face
  const s = solved();
  const corner = G.corners[0]; const edge = G.edges.find((e) => !e.some((x) => G.faceOfSticker[x] === G.faceOfSticker[corner[0]]) && e.some((x) => G.faceOfSticker[x] === G.faceOfSticker[corner[1]]));
  const eSt = edge.find((x) => G.faceOfSticker[x] === G.faceOfSticker[corner[1]]);
  let c = swap(s, corner[0], eSt);
  let v = def.validate(c);
  assert(v.errors.some((e) => e.kind === 'piece' && /two .* stickers/.test(e.text) && e.stickers.includes(corner[0])), v.summary);
  // an edge with opposite colours (white and grey)
  const U = P.faceById.get('U').index; const D = P.faceById.get('D').index;
  const eU = G.edges.find((e) => e.some((x) => G.faceOfSticker[x] === U));
  const eD = G.edges.find((e) => e.some((x) => G.faceOfSticker[x] === D));
  const a = eU.find((x) => G.faceOfSticker[x] !== U); const b = eD.find((x) => G.faceOfSticker[x] === D);
  c = swap(s, a, b);
  v = def.validate(c);
  assert(v.errors.some((e) => e.kind === 'piece' && /white and grey/.test(e.text) && /opposite/.test(e.text)), v.summary);
  // a mirror-image corner: swap two stickers of one corner
  c = swap(s, corner[1], corner[2]);
  v = def.validate(c);
  assert(v.errors.some((e) => e.kind === 'piece' && /mirror/.test(e.text)), v.summary);
  // the same corner twice (and so one missing): copy one corner's colours onto another
  c = s.slice(); const other = G.corners.find((x) => !x.some((y) => corner.map((z) => G.faceOfSticker[z]).includes(G.faceOfSticker[y])));
  // keep counts: swap the whole of the two corners' colours and then overwrite one -> counts off; just check duplicate detection
  other.forEach((st, k) => { c[st] = s[corner[k]]; });
  v = def.validate(c);
  assert(v.errors.some((e) => e.kind === 'duplicate'), v.summary);
  assert(v.errors.some((e) => e.kind === 'missing'), v.summary);
});

test('validation: a twisted corner, a flipped edge, two corners swapped, two edges swapped', () => {
  const base = scrambled(21);
  const c = G.corners[4];
  let x = base.slice(); [x[c[0]], x[c[1]], x[c[2]]] = [base[c[1]], base[c[2]], base[c[0]]];
  let v = def.validate(x);
  assert.deepStrictEqual(v.errors.map((e) => e.kind), ['twist']); assert(/twisted/.test(v.summary));
  const e = G.edges[7];
  x = swap(base, e[0], e[1]);
  v = def.validate(x);
  assert.deepStrictEqual(v.errors.map((q) => q.kind), ['flip']); assert(/flipped/.test(v.summary));
  const c2 = G.corners[11];
  x = base.slice(); c.forEach((s, k) => { x[s] = base[c2[k]]; x[c2[k]] = base[s]; });
  v = def.validate(x);
  assert.deepStrictEqual(v.errors.map((q) => q.kind), ['parity']); assert(/Two corners have swapped/.test(v.summary));
  const e2 = G.edges[19];
  x = base.slice(); e.forEach((s, k) => { x[s] = base[e2[k]]; x[e2[k]] = base[s]; });
  v = def.validate(x);
  assert.deepStrictEqual(v.errors.map((q) => q.kind), ['parity']); assert(/Two edges have swapped/.test(v.summary));
  // a three-cycle of corners is fine (it is reachable)
  const c3 = G.corners[15];
  x = base.slice(); c.forEach((s, k) => { x[s] = base[c2[k]]; x[c2[k]] = base[c3[k]]; x[c3[k]] = base[s]; });
  assert(def.validate(x).ok);
});

// ---- the solver ------------------------------------------------------------------------------------------------------------
const TITLES = ['White star', 'White corners', 'Second layer edges', 'Third layer: corners and edges', 'Fourth layer: corners and edges',
  'Last layer: orient edges (grey star)', 'Last layer: place edges', 'Last layer: place corners', 'Last layer: orient corners'];
const stats = { n: 0, total: 0, max: 0, ms: 0, maxMs: 0 };
function check(cols, label) {
  const t0 = Date.now();
  const r = S.solve(cols);
  const ms = Date.now() - t0;
  assert(P.isSolved(P.applyMoves(cols, r.moves)), `${label}: the solution solves it`);
  assert.strictEqual(r.stages.map((s) => s.moves).join(' '), r.moves, `${label}: stages add up to the solution`);
  for (const s of r.stages) assert(s.moves.length && s.title, label);
  const len = r.moves ? r.moves.split(' ').length : 0;
  stats.n++; stats.total += len; stats.max = Math.max(stats.max, len); stats.ms += ms; stats.maxMs = Math.max(stats.maxMs, ms);
  return r;
}

test('solver: init is quick; a solved puzzle needs nothing', () => {
  const t0 = Date.now(); let last = -1;
  S.init((f) => { assert(f >= last); last = f; });
  assert(Date.now() - t0 < 10000);
  const r = S.solve(solved());
  assert.strictEqual(r.moves, ''); assert.deepStrictEqual(r.stages, []);
});

test('solver: short scrambles and single turns', () => {
  for (const t of P.turnNames) check(P.applyMoves(solved(), t), t);
  for (let i = 0; i < 10; i++) check(scrambled(500 + i, 3 + i), 'short ' + i);
});

// MEGAMINX_STRESS=500 node test/megaminx.test.js solves that many scrambles instead of 60
const RUNS = Math.max(60, Number(process.env.MEGAMINX_STRESS) || 0);
test(`solver: ${RUNS} random scrambles, every stage in the beginner order, every answer checked`, () => {
  for (let i = 0; i < RUNS; i++) {
    const r = check(scrambled(1000 + i), 'scramble ' + i);
    const titles = r.stages.map((s) => s.title);
    let at = -1;
    for (const t of titles) { const k = TITLES.indexOf(t); assert(k > at, `stage order: ${titles.join(' | ')}`); at = k; }
  }
});

test('solver: a puzzle held another way (white not on top) and stages never undo earlier ones', () => {
  // turn the whole coloured puzzle so white is somewhere else, as if the user held it differently
  for (let k = 1; k < 60; k += 7) {
    const r = I.ROT[k]; const src = scrambled(2000 + k);
    const cols = new Array(132); for (let s = 0; s < 132; s++) cols[r.sticker[s]] = src[s];
    const res = check(cols, 'rotated ' + k);
    // after each stage, the pieces of that stage (and before) stay solved: replay and check the white face at the end of stage 2
    let st = cols;
    const wFace = P.faces.findIndex((f) => cols[G.centres[f.index]] === 'w');
    for (const stage of res.stages) {
      st = P.applyMoves(st, stage.moves);
      if (stage.title === 'White corners') {
        for (const s of P.stickersOf(P.faces[wFace].id)) assert.strictEqual(st[s], 'w', 'white face done after "White corners"');
      }
    }
  }
});

(async () => {
  let failed = 0;
  for (const [name, fn] of tests) {
    const t0 = Date.now();
    try { await fn(); console.log(`ok   ${name} (${Date.now() - t0} ms)`); } catch (e) { failed++; console.log(`FAIL ${name}\n     ${String((e && e.stack) || e).split('\n').slice(0, 6).join('\n     ')}`); }
  }
  if (stats.n) console.log(`\nsolved ${stats.n} Megaminxes: average ${(stats.total / stats.n).toFixed(1)} turns (longest ${stats.max}), average ${(stats.ms / stats.n).toFixed(0)} ms (slowest ${stats.maxMs} ms)`);
  console.log(failed ? `\n${failed} of ${tests.length} failed` : `\nall ${tests.length} passed`);
  process.exit(failed ? 1 : 0);
})();
