'use strict';
// Cuboid tests (plain Node): the 3x3x2 (Domino) and 3x2x2 geometry and turns, the pieces, validation messages on broken
// fillings, the claims about which positions can be reached, and the two optimal solvers (every answer applied and
// checked; distances compared with an independent breadth-first search over sticker patterns).
const assert = require('assert');
const PC = require('../src/puzzle-core');
const D332 = require('../src/puzzles/cuboid332');
const D322 = require('../src/puzzles/cuboid322');
const S332 = require('../src/solvers/cuboid332');
const S322 = require('../src/solvers/cuboid322');

const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const ALL = [[D332, S332], [D322, S322]];

const keyOf = (c, n) => c.map((v) => Math.round(v * 1e4)).join(',') + '|' + n.map((v) => Math.round(v * 1e3)).join(',');
/** The sticker permutation of turning the stickers chosen by `pick` by `angle` about `axis` (e.g. the whole puzzle). */
function rotation(P, axis, angle, pick = () => true) {
  const p = Array.from({ length: P.size }, (_, i) => i);
  for (const s of P.stickers) {
    if (!pick(s.centre)) continue;
    const t = P.index.get(keyOf(PC.rotate(s.centre, axis, angle), PC.rotate(s.normal, axis, angle)));
    assert(t !== undefined, 'rotation lands on a sticker');
    p[t] = s.i;
  }
  return p;
}
const permute = (state, p) => p.map((j) => state[j]);
const shuffle = (arr, rnd) => { for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; } return arr; };
const rng = (seed) => { let x = seed >>> 0 || 1; return () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x / 4294967296; }; };
const len = (text) => (text ? text.split(' ').length : 0);

// ---- geometry --------------------------------------------------------------------------------------------------------
test('geometry: sticker counts, face sizes, turn orders, pieces', () => {
  assert.strictEqual(D332.puzzle.size, 42);
  assert.strictEqual(D322.puzzle.size, 32);
  assert.deepStrictEqual(D332.puzzle.turnNames.map((n) => D332.puzzle.turns[n].order), [4, 2, 2, 4, 2, 2]); // U R F D L B
  assert.deepStrictEqual(D322.puzzle.turnNames.map((n) => D322.puzzle.turns[n].order), [2, 4, 2, 2, 4, 2]);
  const kinds = (d) => d.kit.slots.reduce((m, s) => { m[s.kind] = (m[s.kind] || 0) + 1; return m; }, {});
  assert.deepStrictEqual(kinds(D332), { corner: 8, edge: 8, centre: 2 });
  assert.deepStrictEqual(kinds(D322), { corner: 8, edge: 4 });
  for (const [d] of ALL) {
    assert.strictEqual(d.kit.holds.length, 8, 'eight ways to hold a cuboid with the same shape');
    for (const f of d.puzzle.faces) {
      const t = d.puzzle.templates[f.id];
      const [cols, rows] = d.kit.faceSize[f.id];
      assert.strictEqual(Math.round(t.box.w), cols); assert.strictEqual(Math.round(t.box.h), rows);
      assert.strictEqual(t.stickers.length, cols * rows);
      assert.strictEqual(d.kit.expected[f.colour], cols * rows);
    }
    const net = d.puzzle.netLayout();
    assert.strictEqual(net.cells.length, d.puzzle.size);
    // no two cells of the fill-in map overlap
    for (let a = 0; a < net.cells.length; a++) for (let b = a + 1; b < net.cells.length; b++) {
      const [p, q] = [net.cells[a].centre, net.cells[b].centre];
      assert(Math.hypot(p[0] - q[0], p[1] - q[1]) > 0.9, 'cells overlap');
    }
    assert.strictEqual(d.scan.faces.length, 6);
    assert(d.scan.faces.every((f) => f.say && d.puzzle.templates[f.face]));
    for (const k of ['id', 'name', 'short', 'holdHelp', 'notationHelp']) assert(d[k], k);
  }
  assert.strictEqual(D332.id, 'cuboid332'); assert.strictEqual(D332.short, '3x3x2');
  assert.strictEqual(D322.id, 'cuboid322'); assert.strictEqual(D322.short, '3x2x2');
});

test('turns: order times is nothing, sequences and inverses, notation', () => {
  for (const [d] of ALL) {
    const P = d.puzzle;
    const start = P.applyMoves(P.solvedColours(), P.randomMoves(30, 3));
    for (const n of P.turnNames) {
      const t = P.turns[n];
      let s = start;
      for (let k = 0; k < t.order; k++) { s = P.applyMove(s, { turn: n, amount: 1 }); if (k < t.order - 1) assert.notDeepStrictEqual(s, start, n); }
      assert.deepStrictEqual(s, start, `${n} x${t.order}`);
      assert.strictEqual(t.moving.length, d.kit.slots.filter((sl) => P.turns[n].moving.includes(sl.stickers[0])).reduce((a, sl) => a + sl.stickers.length, 0), `${n} moves whole pieces`);
    }
    for (let i = 0; i < 50; i++) {
      const seq = P.randomMoves(40, 100 + i);
      assert.deepStrictEqual(P.applyMoves(P.applyMoves(P.solvedColours(), seq), P.inverse(seq)), P.solvedColours());
      assert.deepStrictEqual(P.parseMoves(P.formatMoves(seq)), seq);
    }
  }
  const A = D332.puzzle; const B = D322.puzzle;
  assert.deepStrictEqual(A.parseMoves("U D' R2 F"), [{ turn: 'U', amount: 1 }, { turn: 'D', amount: 3 }, { turn: 'R', amount: 1 }, { turn: 'F', amount: 1 }]);
  assert.strictEqual(A.formatMoves(A.parseMoves("U2 R F2 D'")), "U2 R2 F2 D'");
  assert.strictEqual(B.formatMoves(B.parseMoves("R L' U F2 R2")), "R L' U2 F2 R2");
  // Domino: the top and bottom together in opposite directions turn the whole puzzle: still solved
  assert(A.isSolved(A.applyMoves(A.solvedColours(), "U D'")));
  assert(!A.isSolved(A.applyMoves(A.solvedColours(), 'U D')));
  // 3x2x2: both halves together turn the whole puzzle over
  assert(B.isSolved(B.applyMoves(B.solvedColours(), 'U2 D2')) && B.isSolved(B.applyMoves(B.solvedColours(), 'F2 B2')));
  assert(!B.isSolved(B.applyMoves(B.solvedColours(), "R L'")));
  // known: a 3x2x2's R U2 R' ... commutator returns after its order; (R U2)^n
  let s = B.solvedColours(); let n = 0;
  do { s = B.applyMoves(s, 'R U2'); n++; } while (!B.isSolved(s) && n < 1000);
  assert(n > 1 && n < 1000, '(R U2) has a finite order: ' + n);
});

// ---- what can be reached -----------------------------------------------------------------------------------------------
test('3x2x2: every arrangement of corners (8!) and middle edges (4!) is reached: 967,680 positions', () => {
  const t = S322.init();
  assert.strictEqual(t.counts.reduce((a, b) => a + b, 0), 40320 * 24);
  assert(t.dist.every((x) => x !== 255));
  console.log(`    3x2x2 table: ${t.ms} ms; positions by distance from one solved state: ${t.counts.join(', ')}`);
});

test('every arrangement of the pieces is solvable (single swaps of two corners or two edges included)', () => {
  const rnd = rng(42);
  for (const [d, S] of ALL) {
    const slots = d.kit.slots;
    const groups = ['corner', 'edge'].map((k) => slots.filter((s) => s.kind === k).map((s) => s.index));
    const home = slots.map((s) => s.index);
    const cases = [];
    for (const g of groups) { const p = home.slice(); [p[g[0]], p[g[1]]] = [p[g[1]], p[g[0]]]; cases.push(p); }
    for (let i = 0; i < 60; i++) {
      const p = home.slice();
      for (const g of groups) { const sh = shuffle(g.slice(), rnd); g.forEach((s, k) => { p[s] = sh[k]; }); }
      cases.push(p);
    }
    for (const p of cases) {
      const colours = d.kit.build(p);
      assert(colours, 'buildable');
      const v = d.validate(colours);
      assert(v.ok, v.summary);
      const r = S.solve(colours);
      assert(d.puzzle.isSolved(d.puzzle.applyMoves(colours, r.moves)), d.id);
    }
  }
});

test('the 3x2x2 middle layer and the Domino middle slices: allowed, solved in two face turns', () => {
  // 3x2x2: a quarter turn of the middle layer (flips all four middle edges at once)
  const B = D322.puzzle;
  const M = rotation(B, [1, 0, 0], -Math.PI / 2, (c) => Math.abs(c[0]) < 0.6);
  const afterM = permute(B.solvedColours(), M);
  assert(!B.isSolved(afterM));
  assert(D322.validate(afterM).ok, D322.validate(afterM).summary);
  assert.strictEqual(len(S322.solve(afterM).moves), 2);
  const scr = B.applyMoves(permute(B.applyMoves(B.solvedColours(), B.randomMoves(20, 8)), M), B.randomMoves(20, 9));
  assert(D322.validate(scr).ok);
  assert(B.isSolved(B.applyMoves(scr, S322.solve(scr).moves)));
  // Domino: half turns of the two middle slices
  const A = D332.puzzle;
  for (const axis of [[1, 0, 0], [0, 0, 1]]) {
    const k = axis[0] ? 0 : 2;
    const sl = rotation(A, axis, Math.PI, (c) => Math.abs(c[k]) < 0.6);
    const st = permute(A.solvedColours(), sl);
    assert(D332.validate(st).ok, D332.validate(st).summary);
    assert.strictEqual(len(S332.solve(st).moves), 2);
    const scr2 = A.applyMoves(permute(A.applyMoves(A.solvedColours(), A.randomMoves(20, 10 + k)), sl), A.randomMoves(20, 11));
    assert(D332.validate(scr2).ok);
    assert(A.isSolved(A.applyMoves(scr2, S332.solve(scr2).moves)));
  }
});

test('holding the puzzle any way round: same answer length, still checks out', () => {
  for (const [d, S] of ALL) {
    const P = d.puzzle;
    const rots = [[[0, 1, 0], Math.PI / 2], [[0, 1, 0], Math.PI], [[1, 0, 0], Math.PI], [[0, 0, 1], Math.PI]];
    for (let i = 0; i < 20; i++) {
      const c = P.applyMoves(P.solvedColours(), P.randomMoves(30, 300 + i));
      const n = len(S.solve(c).moves);
      for (const [ax, ang] of rots) {
        if (d === D322 && ang === Math.PI / 2) continue; // a quarter about the vertical axis changes the 3x2x2's shape
        const p = rotation(P, ax, ang);
        const held = permute(c, p);
        assert(d.validate(held).ok, d.validate(held).summary);
        const r = S.solve(held);
        assert(P.isSolved(P.applyMoves(held, r.moves)));
        assert.strictEqual(len(r.moves), n, 'same length held another way');
      }
    }
  }
});

// ---- validation ----------------------------------------------------------------------------------------------------------
test('validation: solved and scrambled pass; empty, counts, impossible pieces, twists, flips, mirrors, duplicates', () => {
  for (const [d] of ALL) {
    const P = d.puzzle; const K = d.kit;
    const solved = P.solvedColours();
    const v0 = d.validate(solved);
    assert(v0.ok && v0.solved, v0.summary);
    assert.strictEqual(v0.summary, `This ${d.name} is already solved.`);
    for (let i = 0; i < 100; i++) {
      const v = d.validate(P.applyMoves(solved, P.randomMoves(30, 500 + i)));
      assert(v.ok, v.summary);
    }
    const errs = (c) => { const v = d.validate(c); assert(!v.ok); return v.errors; };
    let c = solved.slice(); c[0] = null; c[5] = null;
    let e = errs(c);
    assert.strictEqual(e[0].text, '2 stickers are not filled in yet.'); assert.deepStrictEqual(e[0].stickers, [0, 5]);
    assert(/not filled in/.test(d.validate(new Array(P.size).fill(null)).summary));
    assert(/has \d+ stickers/.test(d.validate([]).summary));

    const corner = K.slots.find((s) => s.kind === 'corner'); const edge = K.slots.find((s) => s.kind === 'edge');
    const [a, b, x] = corner.stickers;
    // a wrong colour: counts + an impossible piece
    c = solved.slice(); c[a] = c[a] === 'w' ? 'y' : 'w';
    e = errs(c);
    assert(e.some((q) => q.kind === 'count' && /There are/.test(q.text) && /one face's worth/.test(q.text)), e[0].text);
    assert(e.some((q) => q.kind === 'piece' && q.stickers.includes(a)), JSON.stringify(e));
    // two stickers of a corner swapped: a mirror image
    c = solved.slice(); [c[a], c[b]] = [c[b], c[a]];
    e = errs(c);
    assert.strictEqual(e.length, 1); assert(/mirror image/.test(e[0].text)); assert.deepStrictEqual(e[0].stickers.sort((p, q) => p - q), corner.stickers.slice().sort((p, q) => p - q));
    // a corner twisted
    c = solved.slice(); [c[a], c[b], c[x]] = [c[b], c[x], c[a]];
    e = errs(c);
    assert.strictEqual(e.length, 1); assert(/twisted in place/.test(e[0].text), e[0].text);
    // an edge flipped
    c = solved.slice(); const [p, q] = edge.stickers; [c[p], c[q]] = [c[q], c[p]];
    e = errs(c);
    assert.strictEqual(e.length, 1); assert(/flipped/.test(e[0].text), e[0].text); assert.deepStrictEqual(e[0].stickers, edge.stickers);
    // an edge with opposite colours
    c = solved.slice(); c[q] = c[p] === 'w' ? 'y' : 'w';
    e = errs(c);
    assert(e.some((r) => /opposite colours/.test(r.text) && r.stickers.includes(q)), JSON.stringify(e));
    // the same corner twice
    const corners = K.slots.filter((s) => s.kind === 'corner');
    const home = K.slots.map((s) => s.index); home[corners[1].index] = corners[0].index;
    e = errs(K.build(home));
    assert(e.some((r) => r.kind === 'duplicate' && /is there twice/.test(r.text)));
    assert(e.some((r) => r.kind === 'missing' && /missing/.test(r.text)));
    // every message is plain text and has a stickers list
    for (const r of e) { assert.strictEqual(typeof r.text, 'string'); assert(Array.isArray(r.stickers)); }
  }
  // Domino: wrong centres
  const A = D332.puzzle; const cen = D332.kit.slots.filter((s) => s.kind === 'centre');
  const c = A.solvedColours(); c[cen[0].stickers[0]] = 'y';
  const e = D332.validate(c).errors;
  assert(e.some((r) => /centre/.test(r.text) && r.stickers.includes(cen[0].stickers[0])), JSON.stringify(e));
  // Domino held upside down (yellow on top) is fine
  const flipped = permute(A.applyMoves(A.solvedColours(), A.randomMoves(25, 2)), rotation(A, [0, 0, 1], Math.PI));
  assert.strictEqual(flipped[cen[0].stickers[0]], 'y');
  assert(D332.validate(flipped).ok);
  // 3x2x2: one or two middle edges flipped on their own cannot be reached; all four (the middle layer) can
  const B = D322.puzzle; const edges = D322.kit.slots.filter((s) => s.kind === 'edge');
  const flip = (st, k) => { const s = st.slice(); const [p, q] = edges[k].stickers; [s[p], s[q]] = [s[q], s[p]]; return s; };
  const base = B.applyMoves(B.solvedColours(), B.randomMoves(20, 4));
  assert(!D322.validate(flip(base, 0)).ok);
  assert(/flipped/.test(D322.validate(flip(flip(base, 0), 1)).summary));
  assert(!D322.validate(flip(flip(flip(base, 0), 1), 2)).ok);
});

// ---- solvers -------------------------------------------------------------------------------------------------------------
/** Breadth-first search over sticker patterns from every solved pattern the turns can reach: distance of each pattern. */
function stickerBfs(d, depth) {
  const P = d.puzzle;
  // the solved patterns the turns can reach (the whole puzzle turned some ways) are all distance 0
  const starts = d.kit.holds.map((h) => P.solvedColours(h.colourOf)).filter((c) => d.validate(c).ok);
  const moves = [];
  for (const n of P.turnNames) for (let k = 1; k < P.turns[n].order; k++) moves.push({ turn: n, amount: k });
  const dist = new Map(starts.map((c) => [c.join(''), 0]));
  let frontier = starts;
  for (let dd = 0; dd < depth; dd++) {
    const next = [];
    for (const s of frontier) {
      for (const m of moves) {
        const t = P.applyMove(s, m); const k = t.join('');
        if (dist.has(k)) continue;
        dist.set(k, dd + 1); next.push(t);
      }
    }
    frontier = next;
  }
  return { dist, starts: starts.length };
}

test('optimal: the solvers agree with a sticker-level breadth-first search (positions up to 6 turns)', () => {
  for (const [d, S] of ALL) {
    const P = d.puzzle;
    const depth = 6;
    const { dist, starts } = stickerBfs(d, depth);
    assert.strictEqual(starts, 8, 'eight solved patterns (every way of holding it)');
    let checked = 0; const byDepth = {};
    for (const [k, v] of dist) {
      byDepth[v] = (byDepth[v] || 0) + 1;
      if ((checked++ % 5) !== 0) continue; // a fifth of them
      const colours = k.split('');
      const r = S.solve(colours);
      assert.strictEqual(len(r.moves), v, `${d.id}: ${r.moves} for a position ${v} turns away`);
      assert(P.isSolved(P.applyMoves(colours, r.moves)));
    }
    console.log(`    ${d.id}: ${dist.size} positions within ${depth} turns, a fifth of them checked (by distance: ${JSON.stringify(byDepth)})`);
  }
});

test('random scrambles: every answer solves it, is never longer than the scramble, and timing', () => {
  for (const [d, S, n] of [[D332, S332, 1000], [D322, S322, 2000]]) {
    const P = d.puzzle;
    const t0 = Date.now(); S.init(); const ti = Date.now() - t0;
    let worst = 0; let total = 0; let longest = 0; let sum = 0;
    for (let i = 0; i < n; i++) {
      const seq = P.randomMoves(i % 10 === 0 ? 8 : 40, 9000 + i);
      const c = P.applyMoves(P.solvedColours(), seq);
      const t = Date.now(); const r = S.solve(c); const ms = Date.now() - t;
      total += ms; worst = Math.max(worst, ms);
      assert(P.isSolved(P.applyMoves(c, r.moves)), `${d.id} ${r.moves}`);
      const L = len(r.moves);
      assert(L <= P.simplify(seq).length);
      assert.strictEqual(r.stages.map((s) => s.moves).filter(Boolean).join(' '), r.moves);
      longest = Math.max(longest, L); sum += L;
    }
    const s0 = S.solve(P.solvedColours());
    assert.strictEqual(s0.moves, '');
    console.log(`    ${d.id}: init ${ti} ms (already built if 0); ${n} solves, average ${(total / n).toFixed(2)} ms, worst ${worst} ms; average ${(sum / n).toFixed(2)} turns, longest ${longest}`);
  }
  assert.throws(() => S332.solve(D332.puzzle.solvedColours().map((c, i) => (i === 0 ? 'g' : c))), /not a position/);
});

// ---- run ----
let failed = 0;
const t0 = Date.now();
for (const [name, fn] of tests) {
  try { fn(); console.log('ok   ' + name); } catch (e) { failed++; console.log('FAIL ' + name + '\n     ' + (e && e.stack ? e.stack.split('\n').slice(0, 4).join('\n     ') : e)); }
}
console.log(`\n${tests.length - failed} of ${tests.length} tests passed (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
process.exit(failed ? 1 : 0);
