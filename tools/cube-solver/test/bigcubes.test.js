'use strict';
// 4x4 and 5x5 tests (plain Node): geometry and notation, validation with reasons on crafted impossible (and on odd-looking
// but possible) cubes, and the reduction solver on many random scrambles, every answer applied and checked.
//   node test/bigcubes.test.js            (100 scrambles of each; BIGCUBE_N=20 for a quick run)
const assert = require('assert');
const C = require('../src/cube');
const Kit = require('../src/puzzles/bigcube-kit');
const D4 = require('../src/puzzles/cube4');
const D5 = require('../src/puzzles/cube5');
const S4 = require('../src/solvers/cube4');
const S5 = require('../src/solvers/cube5');

const N = Number(process.env.BIGCUBE_N || 100);
const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const DEFS = { 4: D4, 5: D5 };
const SOLVERS = { 4: S4, 5: S5 };
const kinds = (d, colours) => d.validate(colours).errors.map((e) => e.kind);
const swap = (arr, i, j) => { const a = arr.slice(); [a[i], a[j]] = [a[j], a[i]]; return a; };
const ROTATE_X = { 4: "R r l' L'", 5: "R r M' l' L'" }; // the whole cube turned like R
const ROTATE_Y = { 4: "U u d' D'", 5: "U u E' d' D'" };

// ---- geometry and notation ----
test('geometry: sticker counts, pieces, turn orders, X2 = X X, X\' = X X X, Rw = R r', () => {
  for (const n of [4, 5]) {
    const d = DEFS[n]; const P = d.puzzle; const k = d.kit;
    assert.strictEqual(P.size, 6 * n * n);
    assert.strictEqual(k.wings.length, 24);
    assert.strictEqual(k.midges.length, n === 5 ? 12 : 0);
    assert.strictEqual(k.xCentres.length, 24);
    assert.strictEqual(k.tCentres.length, n === 5 ? 24 : 0);
    const start = P.applyMoves(P.solvedColours(), P.randomMoves(50, 3));
    for (const t of P.turnNames) {
      const one = (x) => P.applyMove(x, { turn: t, amount: 1 });
      assert.deepStrictEqual(one(one(one(one(start)))), start, `${n}: ${t} x4`);
      assert.deepStrictEqual(P.applyMoves(start, t + '2'), one(one(start)), `${n}: ${t}2`);
      assert.deepStrictEqual(P.applyMoves(start, t + "'"), one(one(one(start))), `${n}: ${t}'`);
      assert.notDeepStrictEqual(one(start), start, `${n}: ${t} moves something`);
    }
    for (const f of Kit.FACES) assert.deepStrictEqual(P.applyMoves(start, f + 'w'), P.applyMoves(start, `${f} ${f.toLowerCase()}`), `${n}: ${f}w`);
    const seq = P.randomMoves(40, 9);
    assert.deepStrictEqual(P.applyMoves(P.applyMoves(start, seq), P.inverse(seq)), start, 'inverse');
    // whole-cube rotations keep it solved
    assert.ok(P.isSolved(P.applyMoves(P.solvedColours(), ROTATE_X[n] + ' ' + ROTATE_Y[n])));
  }
});

test('the outer turns agree with the 3x3 / 2x2 model (corners, and the 5x5 middle edges and centres)', () => {
  for (const n of [4, 5]) {
    const P = DEFS[n].puzzle;
    for (let i = 0; i < 30; i++) {
      const seq = C.randomMoves(3, 25, i + 1);
      const s = P.applyMoves(P.solvedFaces(), seq.join(' '));
      const two = []; for (let f = 0; f < 6; f++) for (let r = 0; r < 2; r++) for (let c = 0; c < 2; c++) two.push(s[f * n * n + r * (n - 1) * n + c * (n - 1)]);
      assert.strictEqual(two.join(''), C.applyMoves(2, C.solvedFaces(2), seq).join(''));
      if (n === 5) {
        const three = []; const at = (k) => [0, 2, 4][k];
        for (let f = 0; f < 6; f++) for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) three.push(s[f * 25 + at(r) * 5 + at(c)]);
        assert.strictEqual(three.join(''), C.applyMoves(3, C.solvedFaces(3), seq).join(''));
      }
    }
  }
});

test('notation: R, Rw, r, M/E/S (5x5), 2R = r, plain-words errors', () => {
  const P4 = D4.puzzle; const P5 = D5.puzzle;
  assert.deepStrictEqual(P4.parseMoves("R Rw' r2 2R' Uw2"), [{ turn: 'R', amount: 1 }, { turn: 'Rw', amount: 3 }, { turn: 'r', amount: 2 }, { turn: 'r', amount: 3 }, { turn: 'Uw', amount: 2 }]);
  assert.strictEqual(P4.formatMoves(P4.parseMoves("r' Lw2 F")), "r' Lw2 F");
  assert.deepStrictEqual(P5.parseMoves("M E' S2 3R"), [{ turn: 'M', amount: 1 }, { turn: 'E', amount: 3 }, { turn: 'S', amount: 2 }, { turn: 'M', amount: 3 }]);
  assert.throws(() => P4.parseMoves('M'), /is not a move on the 4x4/);
  assert.throws(() => P4.parseMoves('X'), /is not a move/);
  for (const d of [D4, D5]) {
    assert.ok(d.notationHelp.length > 50 && d.holdHelp.length > 50);
    assert.strictEqual(d.scan.faces.length, 6);
    assert.match(d.describeMove({ turn: 'r', amount: 3 }), /second layer from the right a quarter anticlockwise/);
  }
  assert.match(D5.describeMove({ turn: 'M', amount: 1 }), /middle layer/);
});

// ---- validation ----
test('validation: solved, scrambled and held any way round are fine', () => {
  for (const n of [4, 5]) {
    const d = DEFS[n]; const P = d.puzzle;
    assert.ok(d.validate(P.solvedColours()).solved);
    for (let i = 0; i < 20; i++) {
      const s = P.applyMoves(P.solvedColours(), P.randomMoves(60, 100 + i) .concat(P.parseMoves(i % 2 ? ROTATE_X[n] : ROTATE_Y[n])));
      const v = d.validate(s);
      assert.ok(v.ok && !v.solved, v.summary);
    }
  }
});

test('validation: missing stickers and wrong counts', () => {
  for (const n of [4, 5]) {
    const d = DEFS[n]; const s = d.puzzle.solvedColours();
    const e = s.slice(); e[3] = null; e[7] = null;
    const v = d.validate(e);
    assert.deepStrictEqual(v.errors.map((x) => x.kind), ['empty']); assert.deepStrictEqual(v.errors[0].stickers, [3, 7]);
    assert.match(v.summary, /2 stickers are not filled in/);
    const c = s.slice(); c[n + 1] = 'y'; // a white centre sticker painted yellow
    assert.ok(kinds(d, c).includes('count'));
    assert.match(d.validate(c).errors[0].text, new RegExp(`exactly ${n * n} times.*${n * n + 1} yellow.*${n * n - 1} white`));
    assert.strictEqual(d.validate([1, 2]).errors[0].kind, 'empty');
  }
});

test('validation: impossible corners, twisted corner', () => {
  for (const n of [4, 5]) {
    const d = DEFS[n]; const k = d.kit; const s = d.puzzle.applyMoves(d.puzzle.solvedColours(), 'R U F2 L');
    const [a, b, c] = k.cornerFacelets[0];
    const tw = s.slice(); tw[a] = s[b]; tw[b] = s[c]; tw[c] = s[a];
    assert.deepStrictEqual(kinds(d, tw), ['twist']);
    assert.match(d.validate(tw).summary, /twisted/);
    const mirror = swap(s, a, b);
    assert.ok(kinds(d, mirror).includes('piece'));
    // two whites on a corner (and one less elsewhere): an impossible corner
    const rep = s.slice(); const k2 = k.cornerFacelets[3];
    rep[k2[1]] = rep[k2[0]]; rep[k.cornerFacelets[5][0]] = s[k2[1]];
    const v = d.validate(rep);
    assert.ok(v.errors.some((e) => e.kind === 'piece' && e.stickers.includes(k2[0])), v.summary);
  }
});

test('validation 4x4: odd-looking states that ARE solvable are accepted', () => {
  const d = D4; const k = d.kit; const P = d.puzzle; const s = P.solvedColours();
  // a single flipped edge (the two pieces of the top-front edge traded places): OLL parity
  const uf = k.wings.map((w, i) => i).filter((i) => k.wings[i].edge === 1);
  const flip = s.slice();
  const [w1, w2] = uf.map((i) => k.wings[i].stickers);
  [flip[w1[0]], flip[w2[0]]] = [s[w2[1]], s[w1[1]]]; [flip[w1[1]], flip[w2[1]]] = [s[w2[0]], s[w1[0]]];
  assert.ok(d.validate(flip).ok, d.validate(flip).summary);
  assert.deepStrictEqual(flip, P.applyMoves(s, "r2 B2 U2 l U2 r' U2 r U2 F2 r F2 l' B2 r2"));
  // two whole edges swapped (PLL parity), two corners swapped, centre stickers anywhere
  assert.ok(d.validate(P.applyMoves(s, 'r2 U2 r2 Uw2 r2 Uw2')).ok);
  assert.ok(d.validate(P.applyMoves(s, "R U R' U' R' F R2 U' R' U' R U R' F'")).ok); // T-perm: two corners + two edges
  assert.ok(d.validate(P.applyMoves(s, "r U r' U' r' F r2 U' r' U' r U r' F'")).ok);
  assert.ok(d.validate(P.applyMoves(s, 'r')).ok);
});

test('validation 4x4: an edge piece filled in the wrong way round shows up as the same piece twice', () => {
  const d = D4; const k = d.kit; const s = d.puzzle.applyMoves(d.puzzle.solvedColours(), "R u F' d2 B l");
  const w = k.wings[5].stickers;
  const v = d.validate(swap(s, w[0], w[1]));
  assert.ok(v.errors.some((e) => e.kind === 'duplicate' && e.stickers.includes(w[0])), v.summary);
  assert.match(v.errors.find((e) => e.kind === 'duplicate').text, /mirror images/);
  // an edge piece with opposite colours
  const bad = s.slice(); const ww = k.wings[0].stickers; const other = k.wings[7].stickers;
  bad[ww[0]] = 'w'; bad[ww[1]] = 'y'; bad[other[0]] = s[ww[0]]; bad[other[1]] = s[ww[1]];
  assert.ok(kinds(d, bad).includes('piece') || kinds(d, bad).includes('count'));
});

test('validation 5x5: middle centres, centre kinds, a flipped middle edge, two swapped pieces', () => {
  const d = D5; const k = d.kit; const P = d.puzzle; const s = P.applyMoves(P.solvedColours(), "R u F' d2 B l");
  const fc = k.fixedCentres;
  const two = swap(s, fc[0], fc[2]); // the middle stickers then disagree with the corners
  assert.ok(kinds(d, two).includes('piece'));
  const dup = s.slice(); dup[fc[1]] = s[fc[0]];
  assert.deepStrictEqual(kinds(d, dup).filter((x) => x !== 'count'), ['centres']);
  // an x-centre swapped with a t-centre of another colour: counts are fine, the kinds of centre piece are not
  const x = k.xCentres.find((i) => s[i] === 'w'); const t = k.tCentres.find((i) => s[i] === 'g');
  const xt = swap(s, x, t);
  assert.deepStrictEqual(kinds(d, xt), ['centres', 'centres']);
  const flagged = d.validate(xt).errors.flatMap((e) => e.stickers);
  assert.ok(flagged.includes(t) && flagged.includes(x));
  // a flipped middle edge
  const m = k.midges[3];
  assert.deepStrictEqual(kinds(d, swap(s, m[0], m[1])), ['flip']);
  // two middle edges swapped (their wings stay): impossible on a 5x5
  const sw = s.slice(); const ma = k.midges[0]; const mb = k.midges[5];
  [sw[ma[0]], sw[mb[0]]] = [s[mb[0]], s[ma[0]]]; [sw[ma[1]], sw[mb[1]]] = [s[mb[1]], s[ma[1]]];
  assert.deepStrictEqual(kinds(d, sw), ['parity']);
  // two corners swapped
  const sc = s.slice(); const ca = k.cornerFacelets[0]; const cb = k.cornerFacelets[1];
  // URF and UFL: put each one's stickers in the other's place, keeping the U sticker on top
  const cubA = ca.map((i) => s[i]); const cubB = cb.map((i) => s[i]);
  ca.forEach((i, q) => { sc[i] = cubB[q]; }); cb.forEach((i, q) => { sc[i] = cubA[q]; });
  assert.deepStrictEqual(kinds(d, sc), ['parity']);
  // ... but a flipped edge whose middle is right and whose two wings are swapped is a normal position
  const ufw = k.wings.map((w, i) => i).filter((i) => k.wings[i].edge === 1).map((i) => k.wings[i].stickers);
  const sol = P.solvedColours(); const f = sol.slice();
  [f[ufw[0][0]], f[ufw[1][0]]] = [sol[ufw[1][1]], sol[ufw[0][1]]]; [f[ufw[0][1]], f[ufw[1][1]]] = [sol[ufw[1][0]], sol[ufw[0][0]]];
  assert.ok(d.validate(f).ok);
  assert.deepStrictEqual(f, P.applyMoves(sol, "r2 B2 U2 l U2 r' U2 r U2 F2 r F2 l' B2 r2"));
});

// ---- solving ----
const stats = {};
function solveAndCheck(n, colours, label) {
  const d = DEFS[n]; const P = d.puzzle;
  const t0 = Date.now();
  const r = SOLVERS[n].solve(colours);
  const ms = Date.now() - t0;
  const moves = P.parseMoves(r.moves);
  assert.ok(P.isSolved(P.applyMoves(colours, moves)), `${label}: does not solve`);
  assert.strictEqual(r.stages.map((s) => s.moves).join(' '), r.moves, `${label}: stages != moves`);
  let st = colours;
  for (const s of r.stages) {
    assert.ok(s.title && s.moves, label);
    st = P.applyMoves(st, s.moves);
  }
  for (const m of moves) assert.ok(!/w$/.test(m.turn) || n === 4, 'no wide turns on the 5x5');
  return { ms, len: moves.length, stages: r.stages };
}

test('solver: init', () => {
  for (const n of [4, 5]) {
    const t0 = Date.now(); let last = 0;
    SOLVERS[n].init((f) => { assert.ok(f >= last - 1e-9 && f <= 1); last = f; });
    stats['init' + n] = Date.now() - t0;
  }
});

test('solver: special positions (solved, parity cases, held differently)', () => {
  for (const n of [4, 5]) {
    const P = DEFS[n].puzzle;
    assert.deepStrictEqual(SOLVERS[n].solve(P.solvedColours()), { moves: '', stages: [] });
    const flip = P.applyMoves(P.solvedColours(), "r2 B2 U2 l U2 r' U2 r U2 F2 r F2 l' B2 r2");
    const r = solveAndCheck(n, flip, 'flip');
    assert.ok(r.stages.some((s) => (n === 4 ? /Fix the edge parity/ : /Fix the flipped edge/).test(s.title)), r.stages.map((s) => s.title).join());
    for (const extra of [ROTATE_X[n], ROTATE_Y[n] + ' ' + ROTATE_X[n] + ' ' + ROTATE_X[n]]) {
      solveAndCheck(n, P.applyMoves(P.solvedColours(), P.randomMoves(40, 5).concat(P.parseMoves(extra))), 'held');
    }
  }
  const pll = solveAndCheck(4, D4.puzzle.applyMoves(D4.puzzle.solvedColours(), 'r2 U2 r2 Uw2 r2 Uw2'), 'pll');
  assert.ok(pll.stages.some((s) => s.title === 'Fix the swapped edges'));
  // a non-standard colour scheme (green and white swapped everywhere)
  const P = D4.puzzle; const odd = P.applyMoves(P.solvedColours(), P.randomMoves(40, 77)).map((c) => ({ g: 'w', w: 'g' }[c] || c));
  solveAndCheck(4, odd, 'odd scheme');
});

test('validation + solver: swapping any two edge wings (as pieces) or two same-kind centre stickers stays solvable', () => {
  for (const n of [4, 5]) {
    const d = DEFS[n]; const k = d.kit; const P = d.puzzle;
    let seed = 7;
    const rnd = (m) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % m; };
    for (let i = 0; i < 8; i++) {
      const s = P.applyMoves(P.solvedColours(), P.randomMoves(50, 300 + i));
      const a = rnd(24); let b = rnd(23); if (b >= a) b++;
      // move the wing piece at slot a to slot b and back: read each as (colours), and write the piece in the other slot
      // the way that slot shows it (wingPiece tells which piece; its colours at a slot follow from its home slot)
      const faces = d.validate(s).faces; const colourOf = d.validate(s).colourOf;
      const pa = k.wingPiece(a, faces[k.wings[a].stickers[0]], faces[k.wings[a].stickers[1]]);
      const pb = k.wingPiece(b, faces[k.wings[b].stickers[0]], faces[k.wings[b].stickers[1]]);
      const showAt = (piece, slot) => { // the face letters piece shows in slot: try both ways, keep the one that reads back as piece
        const home = Kit.EDGE_FACES[k.wings[piece].edge];
        for (const [x, y] of [[home[0], home[1]], [home[1], home[0]]]) if (k.wingPiece(slot, x, y) === piece) return [x, y];
        throw new Error('no way');
      };
      const t = s.slice();
      showAt(pa, b).forEach((f, q) => { t[k.wings[b].stickers[q]] = colourOf[f]; });
      showAt(pb, a).forEach((f, q) => { t[k.wings[a].stickers[q]] = colourOf[f]; });
      assert.ok(d.validate(t).ok, d.validate(t).summary);
      solveAndCheck(n, t, `wing swap ${n}`);
      const orbit = i % 2 || n === 4 ? k.xCentres : k.tCentres;
      const u = swap(s, orbit[rnd(24)], orbit[rnd(24)]);
      assert.ok(d.validate(u).ok);
      solveAndCheck(n, u, `centre swap ${n}`);
    }
  }
});

for (const n of [4, 5]) {
  test(`solver: ${N} random ${n}x${n} scrambles, every answer applied and checked`, () => {
    const P = DEFS[n].puzzle;
    const lens = []; const times = []; const titles = {};
    for (let i = 0; i < N; i++) {
      let moves = P.randomMoves(DEFS[n].scrambleLength, 1000 + i);
      if (i % 3 === 1) moves = moves.concat(P.parseMoves(ROTATE_X[n])); // sometimes held another way
      const r = solveAndCheck(n, P.applyMoves(P.solvedColours(), moves), `${n}x${n} #${i}`);
      lens.push(r.len); times.push(r.ms);
      for (const s of r.stages) titles[s.title.replace(/^\w+ and \w+ centres$/, 'X and Y centres')] = (titles[s.title.replace(/^\w+ and \w+ centres$/, 'X and Y centres')] || 0) + 1;
    }
    const avg = (a) => (a.reduce((x, y) => x + y, 0) / a.length);
    stats[n] = { avgLen: avg(lens).toFixed(1), maxLen: Math.max(...lens), avgMs: avg(times).toFixed(0), maxMs: Math.max(...times), titles };
  });
}

// ---- run ----
let failed = 0;
const t0 = Date.now();
for (const [name, fn] of tests) {
  try { fn(); console.log('ok   ' + name); } catch (e) { failed++; console.log('FAIL ' + name + '\n     ' + ((e && e.stack) || e)); }
}
for (const n of [4, 5]) {
  if (stats[n]) console.log(`${n}x${n}: init ${stats['init' + n]} ms; ${N} solves: average ${stats[n].avgLen} turns (max ${stats[n].maxLen}), average ${stats[n].avgMs} ms (max ${stats[n].maxMs} ms); stages: ${Object.entries(stats[n].titles).map(([k, v]) => `${k} ${v}`).join(', ')}`);
}
console.log(`${tests.length - failed} of ${tests.length} passed in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
process.exit(failed ? 1 : 0);
