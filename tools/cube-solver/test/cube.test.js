'use strict';
// Cube Solver core tests (plain Node, no window): the sticker/piece model and its turns, validation with reasons on crafted
// impossible cubes, the optimal 2x2 solver (against the known distance distribution and a brute-force search), the 3x3
// two-phase solver on 200 random cubes and the hardest known positions (every answer checked with our own model), colour
// reading from invented face pictures (warm light, a dim face, noise, glare, photos at an angle) and the 2x2 clustering.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const C = require('../src/cube');
const K = require('../src/colour');
const S2 = require('../src/solver2');
const S3 = require('../src/solver3');
const { Engine } = require('../src/engine');
const { renderFace, writeY4m } = require('../src/synth');
const Cube = require('../src/vendor/cubejs/cube');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cubesolver-test-'));
const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const solved3 = () => C.solvedFaces(3);
const solved2 = () => C.solvedFaces(2);
const SUPERFLIP = "U R2 F B R B2 R U2 L B2 R U' D' R2 F R' L B2 U2 F2";
const colourise = (faces, scheme = C.STANDARD_SCHEME) => faces.map((f) => scheme[f]);
const errs = (n, colours) => C.validate(n, colours).errors.map((e) => e.kind);

// ---- the model and its turns -------------------------------------------------------------------------------------------
test('geometry: the corner and edge stickers are the Kociemba ones (as cubejs has them)', () => {
  const g = C.geometry(3);
  assert.deepStrictEqual(g.cornerFacelets, [[8, 9, 20], [6, 18, 38], [0, 36, 47], [2, 45, 11], [29, 26, 15], [27, 44, 24], [33, 53, 42], [35, 17, 51]]);
  assert.deepStrictEqual(g.edgeFacelets, [[5, 10], [7, 19], [3, 37], [1, 46], [32, 16], [28, 25], [30, 43], [34, 52], [23, 12], [21, 41], [50, 39], [48, 14]]);
  assert.deepStrictEqual(g.centres, [4, 13, 22, 31, 40, 49]);
  assert.strictEqual(C.geometry(2).size, 24);
  assert.throws(() => C.geometry(4), /Only 2x2 and 3x3/);
});

test('turns: every turn four times is nothing, X2 = X X, X\' = X X X, on both sizes', () => {
  for (const n of [2, 3]) {
    const start = n === 3 ? C.randomState3(5) : C.randomState2(5);
    for (const f of C.FACES) {
      assert.deepStrictEqual(C.applyMoves(n, start, [f, f, f, f]), start, `${n}: ${f} x4`);
      assert.deepStrictEqual(C.applyMoves(n, start, [f + '2']), C.applyMoves(n, start, [f, f]), `${n}: ${f}2`);
      assert.deepStrictEqual(C.applyMoves(n, start, [f + "'"]), C.applyMoves(n, start, [f, f, f]), `${n}: ${f}'`);
      assert.notDeepStrictEqual(C.applyMoves(n, start, [f]), start, `${n}: ${f} changes something`);
    }
  }
});

test('turns agree with an independent implementation (cubejs) for every turn and 200 random sequences', () => {
  for (const m of C.MOVE_NAMES) assert.strictEqual(C.applyMoves(3, solved3(), [m]).join(''), new Cube().move(m).asString(), m);
  for (let i = 0; i < 200; i++) {
    const seq = C.randomMoves(3, 25, i + 1);
    assert.strictEqual(C.applyMoves(3, solved3(), seq).join(''), new Cube().move(seq.join(' ')).asString());
  }
});

test('known sequences: the sexy move x6 and (R U)x105 are nothing; the superflip flips every edge and nothing else', () => {
  const sexy = C.parseMoves("R U R' U'");
  assert.deepStrictEqual(C.applyMoves(3, solved3(), [].concat(...Array(6).fill(sexy))), solved3());
  assert.notDeepStrictEqual(C.applyMoves(3, solved3(), [].concat(...Array(3).fill(sexy))), solved3());
  assert.deepStrictEqual(C.applyMoves(3, solved3(), [].concat(...Array(105).fill(['R', 'U']))), solved3());
  assert.deepStrictEqual(C.applyMoves(2, solved2(), [].concat(...Array(6).fill(sexy))), solved2());
  const sf = C.applyMoves(3, solved3(), SUPERFLIP);
  const cub = C.toCubies(3, sf);
  assert.deepStrictEqual(cub.cp, [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.deepStrictEqual(cub.co, [0, 0, 0, 0, 0, 0, 0, 0]);
  assert.deepStrictEqual(cub.ep, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  assert.deepStrictEqual(cub.eo, Array(12).fill(1));
  assert.deepStrictEqual(C.applyMoves(3, sf, SUPERFLIP), solved3(), 'the superflip is its own inverse');
  // a sequence followed by its inverse is nothing
  const seq = C.randomMoves(3, 30, 9);
  assert.deepStrictEqual(C.applyMoves(3, C.applyMoves(3, solved3(), seq), C.invertMoves(seq)), solved3());
});

test('notation: parsing, inverses, simplifying, plain-words errors', () => {
  assert.deepStrictEqual(C.parseMoves("R U2 F' (L D') B2'"), ['R', 'U2', "F'", 'L', "D'", 'B2']);
  assert.deepStrictEqual(C.parseMoves('R’ U'), ["R'", 'U']);
  assert.throws(() => C.parseMoves('R X'), /"X" is not a move/);
  assert.throws(() => C.parseMoves('R3'), /is not a move/);
  assert.deepStrictEqual(C.invertMoves(['R', "U'", 'F2']), ['F2', 'U', "R'"]);
  assert.deepStrictEqual(C.simplify(['R', 'R', 'U', "U'", 'F', 'F2', 'L']), ['R2', "F'", 'L']);
  assert.deepStrictEqual(C.parseMoves(''), []);
});

test('pieces: stickers <-> pieces round-trip on random cubes; random states are uniform-looking and solvable', () => {
  let parityOdd = 0;
  for (let i = 0; i < 300; i++) {
    const f = C.randomState3(i + 1);
    const cub = C.toCubies(3, f);
    assert(cub, 'readable');
    assert.deepStrictEqual(C.fromCubies(3, cub), f);
    assert.strictEqual(C.parity(cub.cp), C.parity(cub.ep));
    assert.strictEqual(cub.co.reduce((s, x) => s + x, 0) % 3, 0);
    assert.strictEqual(cub.eo.reduce((s, x) => s + x, 0) % 2, 0);
    parityOdd += C.parity(cub.cp);
    const f2 = C.randomState2(i + 1);
    assert.deepStrictEqual(C.fromCubies(2, C.toCubies(2, f2)), f2);
    assert.strictEqual(C.toCubies(2, f2).cp[6], 6);
  }
  assert(parityOdd > 100 && parityOdd < 200, 'both parities occur: ' + parityOdd);
  const seq = C.randomMoves(3, 400, 3);
  for (let k = 1; k < seq.length; k++) assert.notStrictEqual(seq[k][0], seq[k - 1][0], 'no face twice in a row');
  assert(C.randomMoves(2, 50, 4).every((m) => 'URF'.includes(m[0])), '2x2 scrambles use U, R, F');
});

test('holding the cube: all 24 ways give a real colour scheme; opposite colours are refused', () => {
  let ways = 0;
  for (const top of C.COLOURS) {
    for (const front of C.COLOURS) {
      const s = C.orientationScheme(top, front);
      if (!s) continue;
      ways++;
      assert.strictEqual(s.U, top); assert.strictEqual(s.F, front);
      assert(C.validate(3, C.solvedColours(3, s)).solved, `${top}/${front} solved cube validates`);
    }
  }
  assert.strictEqual(ways, 24);
  assert.strictEqual(C.orientationScheme('w', 'y'), null);
  assert.deepStrictEqual(C.orientationScheme('w', 'g'), C.STANDARD_SCHEME);
  assert.deepStrictEqual(C.orientationScheme('y', 'b'), { U: 'y', R: 'r', F: 'b', D: 'w', L: 'o', B: 'g' });
});

// ---- validation ------------------------------------------------------------------------------------------------------------
test('validation: solved and scrambled cubes pass; a solved one says so', () => {
  const v = C.validate(3, C.solvedColours(3));
  assert(v.ok && v.solved); assert.strictEqual(v.summary, 'This cube is already solved.');
  for (let i = 0; i < 100; i++) {
    const c = colourise(C.randomState3(i + 7));
    const r = C.validate(3, c);
    assert(r.ok && !r.solved, r.summary);
    assert.deepStrictEqual(r.faces, C.randomState3(i + 7));
    const c2 = colourise(C.randomState2(i + 7));
    assert(C.validate(2, c2).ok, C.validate(2, c2).summary);
  }
  assert(C.validate(2, C.solvedColours(2)).solved);
});

test('validation: stickers not filled in, and wrong colour counts in plain words', () => {
  const c = C.solvedColours(3); c[0] = null; c[10] = null;
  let v = C.validate(3, c);
  assert.deepStrictEqual(v.errors.map((e) => e.kind), ['empty']);
  assert.strictEqual(v.errors[0].text, '2 stickers are not filled in yet.');
  assert.deepStrictEqual(v.errors[0].stickers, [0, 10]);
  const d = C.solvedColours(3); d[27] = 'w'; // a yellow sticker on the bottom painted white
  v = C.validate(3, d);
  assert(v.errors.some((e) => e.kind === 'count' && /there are 10 white and 8 yellow stickers/.test(e.text)), JSON.stringify(v.errors));
  const e = C.solvedColours(3); e[27] = 'w'; e[28] = 'w'; e[9] = 'y'; e[18] = 'y';
  v = C.validate(3, e);
  assert.strictEqual(v.errors.find((x) => x.kind === 'count').text, 'Every colour must appear exactly 9 times, but there are 11 white, 8 green and 8 red stickers.');
});

test('validation: two centres of one colour', () => {
  const c = C.solvedColours(3); c[13] = 'g';
  const v = C.validate(3, c);
  assert(v.errors.some((e) => e.kind === 'centres' && /Two centres are green/.test(e.text)), JSON.stringify(v.errors));
  assert.deepStrictEqual(v.errors.find((e) => e.kind === 'centres').stickers, [13, 22]);
});

test('validation: pieces that cannot exist, named by place and marked', () => {
  const g = C.geometry(3);
  // a corner with two whites
  let c = C.solvedColours(3); c[g.cornerFacelets[0][1]] = 'w';
  let v = C.validate(3, c);
  let p = v.errors.find((e) => e.kind === 'piece');
  assert(/top-front-right corner has two white stickers/.test(p.text), p.text);
  assert.deepStrictEqual(p.stickers, g.cornerFacelets[0]);
  // a corner with opposite colours (white and yellow)
  c = C.solvedColours(3); c[g.cornerFacelets[0][1]] = 'y';
  p = C.validate(3, c).errors.find((e) => e.kind === 'piece');
  assert(/white and yellow together .*opposite colours/.test(p.text), p.text);
  // a mirror-image corner: two of its stickers swapped
  c = C.solvedColours(3); [c[9], c[20]] = [c[20], c[9]];
  p = C.validate(3, c).errors.find((e) => e.kind === 'piece');
  assert(/top-front-right corner .*wrong way round, like a mirror image/.test(p.text), p.text);
  // an edge with two greens / with opposite colours
  c = C.solvedColours(3); c[g.edgeFacelets[1][0]] = 'g';
  p = C.validate(3, c).errors.find((e) => e.kind === 'piece');
  assert(/top-front edge has two green stickers/.test(p.text), p.text);
  c = C.solvedColours(3); c[g.edgeFacelets[8][0]] = 'o';
  p = C.validate(3, c).errors.find((e) => e.kind === 'piece');
  assert(/front-right edge has orange and red, but those are opposite colours/.test(p.text), p.text);
});

test('validation: the same piece twice (and so one missing)', () => {
  const g = C.geometry(3);
  const c = C.solvedColours(3);
  // copy the top-front-right corner's colours onto the bottom-front-right corner, in a real orientation
  g.cornerFacelets[4].forEach((k, j) => { c[k] = ['w', 'r', 'g'][j]; }); // D3 F9 R7 -> white, red, green: the URF piece, untwisted
  const v = C.validate(3, c);
  const kinds = v.errors.map((e) => e.kind);
  assert(kinds.includes('duplicate') && kinds.includes('missing'), JSON.stringify(v.errors));
  const dup = v.errors.find((e) => e.kind === 'duplicate');
  assert(/white-red-green corner is there twice: at the top-front-right and the bottom-front-right/.test(dup.text), dup.text);
  assert(/yellow-green-red/.test(v.errors.find((e) => e.kind === 'missing').text));
});

test('validation: a twisted corner, a flipped edge and two swapped pieces, each alone', () => {
  const g = C.geometry(3);
  const base = colourise(C.randomState3(42));
  let c = base.slice(); const [a, b, d] = g.cornerFacelets[3]; [c[a], c[b], c[d]] = [c[b], c[d], c[a]];
  assert.deepStrictEqual(errs(3, c), ['twist']);
  c = base.slice(); const [e1, e2] = g.edgeFacelets[5]; [c[e1], c[e2]] = [c[e2], c[e1]];
  assert.deepStrictEqual(errs(3, c), ['flip']);
  assert(/One edge is flipped/.test(C.validate(3, c).errors[0].text));
  c = base.slice(); const x = g.edgeFacelets[0]; const y = g.edgeFacelets[7];
  [c[x[0]], c[y[0]]] = [c[y[0]], c[x[0]]]; [c[x[1]], c[y[1]]] = [c[y[1]], c[x[1]]];
  assert.deepStrictEqual(errs(3, c), ['parity']);
  assert(/Two pieces are swapped/.test(C.validate(3, c).errors[0].text));
  // two corners swapped is the same kind of problem
  c = base.slice(); const p = g.cornerFacelets[0]; const q = g.cornerFacelets[1];
  for (let k = 0; k < 3; k++) [c[p[k]], c[q[k]]] = [c[q[k]], c[p[k]]];
  assert.deepStrictEqual(errs(3, c), ['parity']);
  // twist + flip together are both reported
  c = base.slice(); [c[a], c[b], c[d]] = [c[b], c[d], c[a]]; [c[e1], c[e2]] = [c[e2], c[e1]];
  assert.deepStrictEqual(errs(3, c), ['twist', 'flip']);
});

test('validation 2x2: any colour scheme the cube really has is understood; twisted corners and broken pieces are not', () => {
  // a cube with white opposite blue (not the usual scheme) is fine as long as it is consistent
  const odd = { U: 'w', D: 'b', F: 'g', B: 'y', R: 'r', L: 'o' };
  const st = C.randomState2(11);
  const v = C.validate(2, st.map((f) => odd[f]));
  assert(v.ok, v.summary);
  assert.strictEqual(S2.distance(v.faces), S2.distance(st));
  // a held-differently cube: the solver keeps the bottom-back-left corner, whatever its colours are
  const turned = C.validate(2, colourise(C.applyMoves(2, C.solvedFaces(2), "R U R'"), C.orientationScheme('g', 'y')));
  assert(turned.ok, turned.summary);
  const g = C.geometry(2);
  let c = colourise(st); const [a, b, d] = g.cornerFacelets[2]; [c[a], c[b], c[d]] = [c[b], c[d], c[a]];
  assert.deepStrictEqual(errs(2, c), ['twist']);
  c = colourise(C.solvedFaces(2)); c[g.cornerFacelets[0][1]] = 'w'; c[g.cornerFacelets[6][0]] = 'r';
  const kinds = errs(2, c);
  assert(kinds.includes('piece'), JSON.stringify(kinds));
  assert(/has two white stickers/.test(C.validate(2, c).errors.find((e) => e.kind === 'piece').text));
  c = colourise(C.solvedFaces(2)); c[3] = null;
  assert.deepStrictEqual(errs(2, c), ['empty']);
});

// ---- 2x2 solver ------------------------------------------------------------------------------------------------------------
test('2x2: the distance table builds fast and matches the known distribution (3,674,160 states, at most 11 turns)', () => {
  const t = S2.init();
  const ms = t.ms; // the time the build took (it may have been built by an earlier test)
  assert.deepStrictEqual(t.counts, [1, 9, 54, 321, 1847, 9992, 50136, 227536, 870072, 1887748, 623800, 2644]);
  assert.strictEqual(t.counts.reduce((s, x) => s + x, 0), S2.N_STATES);
  assert(ms < 3000, 'built in ' + ms + ' ms'); // well under a second on a normal machine; slack for busy CI runners
  console.log(`     (2x2 table: ${ms} ms)`);
});

test('2x2: 500 random cubes are solved with exactly the table distance, instantly, each answer checked', () => {
  const t0 = Date.now(); let longest = 0;
  for (let i = 0; i < 500; i++) {
    const f = C.randomState2(i + 100);
    const m = S2.solve(f);
    assert(C.isSolved(2, C.applyMoves(2, f, m)), 'solved');
    assert.strictEqual(m.length, S2.distance(f));
    assert(m.length <= 11);
    longest = Math.max(longest, m.length);
  }
  assert(Date.now() - t0 < 2000, 'fast');
  assert(longest >= 9, 'random cubes are mostly 9-10 turns away');
});

test('2x2: optimal, checked against a brute-force search that knows nothing about the table', () => {
  const MOVES = S2.MOVES;
  const shortest = (start, limit) => {
    for (let d = 0; d <= limit; d++) {
      const found = (st, depth, last) => {
        if (depth === 0) return C.isSolved(2, st);
        for (const m of MOVES) { if (m[0] === last) continue; if (found(C.applyMoves(2, st, [m]), depth - 1, m[0])) return true; }
        return false;
      };
      if (found(start, d, '')) return d;
    }
    return -1;
  };
  for (let i = 0; i < 25; i++) {
    const len = 1 + (i % 5);
    const f = C.applyMoves(2, solved2(), C.randomMoves(2, len, 500 + i));
    const m = S2.solve(f);
    assert.strictEqual(m.length, shortest(f, len), 'scramble ' + i);
  }
});

// ---- 3x3 solver ----------------------------------------------------------------------------------------------------------------
test('3x3: 200 random cubes are solved in at most 22 turns, every answer checked with our own model', () => {
  const t0 = Date.now(); S3.init(); const initMs = Date.now() - t0;
  const lens = [];
  for (let i = 0; i < 200; i++) {
    const f = C.randomState3(7000 + i);
    const m = S3.solve(f, { polishMs: 0 });
    assert(C.isSolved(3, C.applyMoves(3, f, m)), 'not solved: ' + i);
    assert(m.length <= 22, 'too long: ' + m.length);
    lens.push(m.length);
  }
  console.log(`     (3x3 tables ${initMs} ms; 200 solves in ${Date.now() - t0 - initMs} ms, average ${(lens.reduce((s, x) => s + x, 0) / lens.length).toFixed(1)} turns)`);
});

test('3x3: the hardest known positions (superflip, superflip + four-spot) and easy ones get short answers', () => {
  for (const seq of [SUPERFLIP, "F B U F U' R2 U D' L' F' D2 F2 U' B2 D2 R' D2 L' U2 R2"]) {
    const f = C.applyMoves(3, solved3(), seq);
    const m = S3.solve(f, { polishMs: 200 });
    assert(C.isSolved(3, C.applyMoves(3, f, m)) && m.length <= 22, seq);
  }
  const short = { F: 1, U2: 1, "R U R' U'": 4, "R U F2 L' D B2": 6, "R2 U2 D2": 3 };
  for (const [seq, max] of Object.entries(short)) {
    const m = S3.solve(C.applyMoves(3, solved3(), seq), { polishMs: 300 });
    assert(m.length <= max, `${seq}: ${m.join(' ')}`);
  }
  assert.deepStrictEqual(S3.solve(solved3()), []);
});

test('the solver worker answers both sizes, checks its answers, and reports start-up progress', async () => {
  const progress = [];
  const e = new Engine({ onStatus: (s) => progress.push(s) });
  try {
    await e.whenReady(3);
    assert(progress.some((s) => s.progress3 > 0 && s.progress3 < 1), 'intermediate progress');
    const f3 = C.randomState3(99); const r3 = await e.solve(3, f3);
    assert(C.isSolved(3, C.applyMoves(3, f3, r3.moves)));
    const f2 = C.randomState2(99); const r2 = await e.solve(2, f2);
    assert.strictEqual(r2.moves.length, S2.distance(f2));
  } finally { await e.close(); }
});

// ---- colours ---------------------------------------------------------------------------------------------------------------------
const LIGHTS = [[1, 1, 1], [1.18, 1, 0.68], [0.42, 0.42, 0.45], [0.95, 1, 1.1], [1.05, 1, 0.9], [0.7, 0.72, 0.7]];
function photograph(colours, n, { lights = LIGHTS, noise = 6, glare = 0.5, seed = 1, quads } = {}) {
  const per = n * n;
  return C.FACES.map((_, f) => {
    const img = renderFace(colours.slice(f * per, f * per + per), { light: lights[f % lights.length], noise, glare, seed: seed * 10 + f, quad: quads && quads[f] });
    return K.sampleFace(img, img.quad, n);
  });
}

test('colour maths: Lab of white, black and the primaries; the assignment solver is optimal', () => {
  const w = K.rgbToLab([255, 255, 255]); assert(Math.abs(w[0] - 100) < 0.01 && Math.abs(w[1]) < 0.01 && Math.abs(w[2]) < 0.01);
  assert(Math.abs(K.rgbToLab([0, 0, 0])[0]) < 1e-9);
  const red = K.rgbToLab([255, 0, 0]); assert(Math.abs(red[0] - 53.24) < 0.1 && Math.abs(red[1] - 80.09) < 0.2);
  const rnd = C.rngFrom(5);
  const perms = (a) => (a.length <= 1 ? [a] : a.flatMap((x, i) => perms([...a.slice(0, i), ...a.slice(i + 1)]).map((p) => [x, ...p])));
  for (let t = 0; t < 30; t++) {
    const n = 2 + (t % 5);
    const m = Array.from({ length: n }, () => Array.from({ length: n }, () => Math.round(rnd() * 100)));
    const got = K.hungarian(m).reduce((s, j, i) => s + m[i][j], 0);
    const best = Math.min(...perms([...Array(n).keys()]).map((p) => p.reduce((s, j, i) => s + m[i][j], 0)));
    assert.strictEqual(got, best);
  }
  const groups = K.assignEqual(Array.from({ length: 12 }, () => [rnd(), rnd(), rnd()]), 3, 4);
  assert.deepStrictEqual([0, 1, 2].map((g) => groups.filter((x) => x === g).length), [4, 4, 4]);
});

test('grid: cell centres and sampled areas follow the four corners, and turning the grid four times is nothing', () => {
  const sq = K.squareQuad(150, 100, 90);
  const cells = K.gridCells(sq, 3);
  const near = (a, b, what) => assert(a.every((v, k) => Math.abs(v - b[k]) < 1e-9), `${what}: ${a} vs ${b}`);
  near(cells[0].centre, [120, 70], 'top-left cell');
  near(cells[4].centre, [150, 100], 'middle cell');
  near(cells[8].centre, [180, 130], 'bottom-right cell');
  near(cells[4].corners[0], [142.5, 92.5], 'sampled area of the middle cell');
  const skew = [[10, 10], [110, 20], [100, 120], [0, 100]];
  near(K.quadPoint(skew, 1, 1), [100, 120], 'corner');
  near(K.quadPoint(skew, 0.5, 0.5), [55, 62.5], 'middle');
  let q = skew; for (let k = 0; k < 4; k++) q = K.rotateQuad(q);
  assert.deepStrictEqual(q, skew);
  assert.deepStrictEqual(K.rotateQuad(skew)[0], [0, 100], 'top-left of a turned grid is the old bottom-left');
});

test('sampling: the median of the inside of each cell ignores glare, noise and the black gaps', () => {
  const cols = ['w', 'y', 'g', 'b', 'r', 'o', 'w', 'g', 'r'];
  const img = renderFace(cols, { noise: 14, glare: 0.9, seed: 3 });
  const s = K.sampleFace(img, img.quad, 3);
  const { PRINT } = require('../src/synth');
  s.forEach((x, k) => assert(K.dist(x.lab, K.rgbToLab(PRINT[cols[k]])) < 7, `cell ${k}: ${x.lab.map((v) => v.toFixed(1))}`));
  // a grid that is off the face reads background and says so through a large spread or the black plastic
  const off = K.sampleFace(img, K.squareQuad(30, 30, 40), 3);
  assert(off.length === 9);
});

test('3x3 colours: 15 random cubes in mixed light (warm lamp, a dim side, bluish), noise and glare are read exactly', () => {
  for (let t = 0; t < 15; t++) {
    const cols = colourise(C.randomState3(t + 1));
    const lights = LIGHTS.slice(t % 6).concat(LIGHTS.slice(0, t % 6));
    const res = K.classify3(photograph(cols, 3, { lights, seed: t + 1 }), C.FACES.map((f) => C.STANDARD_SCHEME[f]));
    assert.deepStrictEqual(res.colours, cols, 'cube ' + t);
  }
});

test('3x3 colours: a strongly warm face and a very dim face, together, are still read exactly', () => {
  const cols = colourise(C.randomState3(321));
  const lights = [[1, 1, 1], [1.3, 1.02, 0.55], [0.3, 0.3, 0.32], [1, 1, 1], [1, 1, 1], [1, 1, 1]];
  const res = K.classify3(photograph(cols, 3, { lights, noise: 8, seed: 9 }), C.FACES.map((f) => C.STANDARD_SCHEME[f]));
  assert.deepStrictEqual(res.colours, cols);
  // the fitted light of the warm face is warm, the dim one is dim
  assert(res.gains[1][0] > res.gains[1][2] * 1.6, 'warm face gain ' + res.gains[1].map((v) => v.toFixed(2)));
  assert(res.gains[2].every((v, k) => v < res.gains[0][k] * 0.6), 'dim face gain ' + res.gains[2].map((v) => v.toFixed(2)));
});

test('3x3 colours: centres in any holding (here yellow on top, blue in front) are the references', () => {
  const sc = C.orientationScheme('y', 'b');
  const cols = C.randomState3(55).map((f) => sc[f]);
  const res = K.classify3(photograph(cols, 3, { seed: 4 }), C.FACES.map((f) => sc[f]));
  assert.deepStrictEqual(res.colours, cols);
});

test('2x2 colours: 24 stickers are clustered into 6 groups of exactly 4 and named right, 15 cubes in mixed light', () => {
  for (let t = 0; t < 15; t++) {
    const cols = colourise(C.randomState2(t + 40));
    const lights = LIGHTS.slice(t % 6).concat(LIGHTS.slice(0, t % 6));
    const res = K.classify2(photograph(cols, 2, { lights, seed: t + 40 }));
    for (const c of C.COLOURS) assert.strictEqual(res.colours.filter((x) => x === c).length, 4, 'four of each');
    assert.deepStrictEqual(res.colours, cols, 'cube ' + t);
  }
});

test('2x2 colours: even with a badly misleading face the counts stay exactly 4 each', () => {
  const cols = colourise(C.randomState2(77));
  const res = K.classify2(photograph(cols, 2, { lights: [[1, 1, 1], [1.6, 0.9, 0.3], [0.2, 0.2, 0.25], [1, 1, 1], [1, 1, 1], [1, 1, 1]], noise: 12, seed: 7 }));
  for (const c of C.COLOURS) assert.strictEqual(res.colours.filter((x) => x === c).length, 4);
});

test('photos: faces at an angle are read through a matching four-corner grid; a sideways photo needs the grid turned', () => {
  const cols = colourise(C.randomState3(88));
  const quads = [
    [[60, 40], [250, 60], [240, 210], [70, 200]],
    [[90, 30], [260, 45], [270, 220], [80, 205]],
    [[50, 50], [230, 30], [255, 200], [65, 215]],
    [[70, 35], [245, 35], [270, 215], [45, 215]],
    [[80, 40], [240, 50], [250, 220], [75, 200]],
    [[60, 30], [255, 40], [250, 225], [60, 210]],
  ];
  const res = K.classify3(photograph(cols, 3, { quads, seed: 12 }), C.FACES.map((f) => C.STANDARD_SCHEME[f]));
  assert.deepStrictEqual(res.colours, cols);
  // the F face photographed with the cube turned a quarter clockwise: its top-left sticker is now at the top-right
  const face = cols.slice(18, 27);
  const sq = [[80, 40], [240, 40], [240, 200], [80, 200]];
  const img = renderFace(face, { quad: K.rotateQuad(sq) });
  const straight = K.sampleFace(img, sq, 3).map((s) => K.liveGuess([s])[0]);
  const turned = K.sampleFace(img, K.rotateQuad(sq), 3).map((s) => K.liveGuess([s])[0]);
  assert.deepStrictEqual(turned, face, 'turning the grid with the photo reads it in the right order');
  assert.notDeepStrictEqual(straight, face);
});

test('webcam preview guess: neutral light reads the typical colours; the fake-camera video file is well formed', () => {
  const cols = ['w', 'y', 'g', 'b', 'r', 'o', 'w', 'b', 'o'];
  const img = renderFace(cols, { width: 320, height: 240, noise: 4 });
  assert.deepStrictEqual(K.liveGuess(K.sampleFace(img, img.quad, 3)), cols);
  const file = writeY4m(path.join(tmp, 'face video.y4m'), [{ image: img, repeat: 3 }], 10);
  const buf = fs.readFileSync(file);
  const header = buf.slice(0, buf.indexOf(10)).toString('latin1');
  assert.strictEqual(header, 'YUV4MPEG2 W320 H240 F10:1 Ip A1:1 C420jpeg');
  assert.strictEqual(buf.length, header.length + 1 + 3 * (6 + 320 * 240 * 1.5));
});

(async () => {
  let failed = 0;
  for (const [name, fn] of tests) {
    const t0 = Date.now();
    try { await fn(); console.log(`ok   ${name} (${Date.now() - t0} ms)`); }
    catch (e) { failed++; console.log(`FAIL ${name}\n     ${String((e && e.stack) || e).split('\n').slice(0, 6).join('\n     ')}`); }
  }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  console.log(failed ? `\n${failed} of ${tests.length} failed` : `\nall ${tests.length} passed`);
  process.exit(failed ? 1 : 0);
})();
