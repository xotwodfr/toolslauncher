'use strict';
// Pyraminx tests (plain Node): the geometry and its turns, the fill-in map, validation with reasons on crafted impossible
// puzzles, and the optimal solver (against the known distance distribution, an independent breadth-first search on whole
// sticker states, and many random positions, every answer checked by applying it).
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const PC = require('../src/puzzle-core');
const P = require('../src/puzzles/pyraminx');
const S = require('../src/solvers/pyraminx');

const pz = P.puzzle;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const kinds = (cols) => P.validate(cols).errors.map((e) => e.kind);
const solvedCols = () => pz.solvedColours();
const swap = (a, i, j) => { const b = a.slice(); [b[i], b[j]] = [b[j], b[i]]; return b; };
function rng(seed) { let x = seed >>> 0 || 1; return () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x / 4294967296; }; }
/** A uniformly random real Pyraminx position (face letters). */
function randomState(seed) {
  const rnd = rng(seed);
  const ep = [0, 1, 2, 3, 4, 5];
  for (let i = 5; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [ep[i], ep[j]] = [ep[j], ep[i]]; }
  if (P.parity(ep)) [ep[0], ep[1]] = [ep[1], ep[0]];
  const eo = [0, 0, 0, 0, 0].map(() => (rnd() < 0.5 ? 1 : 0)); eo.push(eo.reduce((s, x) => s + x, 0) % 2);
  const r3 = () => Math.floor(rnd() * 3);
  return P.fromPieces({ ep, eo, cc: [r3(), r3(), r3(), r3()], tt: [r3(), r3(), r3(), r3()] });
}
const colourise = (faces) => faces.map((f) => P.pieces.STANDARD[f]);
// a whole-puzzle rotation as a sticker permutation (out[i] = in[rot[i]]), found from the geometry
function wholeRotation(axis, angle) {
  return pz.stickers.map((s) => {
    const c = PC.rotate(s.centre, PC.unit(axis), -angle); // the sticker that lands on s
    let best = -1; let bd = Infinity;
    for (const t of pz.stickers) { const d = PC.norm(PC.sub(t.centre, c)); if (d < bd) { bd = d; best = t.i; } }
    assert(bd < 1e-6);
    return best;
  });
}
const permute = (state, p) => p.map((j) => state[j]);

// ---- geometry -------------------------------------------------------------------------------------------------------
test('geometry: 36 stickers, 9 per face (6 pointing up, 3 down), tiling each face; pieces use every sticker once', () => {
  assert.strictEqual(pz.size, 36);
  for (const f of ['F', 'L', 'R', 'D']) assert.strictEqual(pz.stickersOf(f).length, 9);
  const area = (poly) => PC.norm(PC.cross(PC.sub(poly[1], poly[0]), PC.sub(poly[2], poly[0]))) / 2;
  const edge = 2 * Math.sqrt(6);
  for (const f of ['F', 'L', 'R', 'D']) {
    const sum = pz.stickersOf(f).reduce((s, i) => s + area(pz.stickers[i].poly), 0);
    assert(Math.abs(sum - (Math.sqrt(3) / 4) * edge * edge) < 1e-9, f);
    const t = pz.templates[f];
    // the outline is the triangle (the shared hull may keep points along its sides; they all lie on it)
    assert(t.outline.length >= 3);
    // standing on its base: one corner at the top centre, two at the bottom
    const top = t.outline.reduce((a, b) => (b[1] < a[1] ? b : a));
    assert(Math.abs(top[0]) < 1e-6);
    assert.strictEqual(t.outline.filter((p) => Math.abs(p[1] - t.box.maxY) < 1e-6).length, 2);
    // reading order: the tip, then 3, then 5 stickers left to right
    const ys = t.stickers.map((s) => s.centre[1]);
    assert(ys[0] < ys[1] && ys[3] < ys[4]);
    for (const [a, b] of [[1, 2], [2, 3], [4, 5], [5, 6], [6, 7], [7, 8]]) assert(t.stickers[a].centre[0] < t.stickers[b].centre[0]);
  }
  const { TIPS, CENTRES, EDGES } = P.pieces;
  const used = [...TIPS.flat(), ...CENTRES.flat(), ...EDGES.flat()].sort((a, b) => a - b);
  assert.deepStrictEqual(used, Array.from({ length: 36 }, (_, i) => i));
  for (const pc of [...TIPS, ...CENTRES, ...EDGES]) assert.strictEqual(new Set(pc.map((i) => pz.stickers[i].face)).size, pc.length);
  // the sticker layout the header comment promises
  for (let f = 0; f < 4; f++) {
    assert(TIPS.flat().includes(f * 9) && TIPS.flat().includes(f * 9 + 4) && TIPS.flat().includes(f * 9 + 8));
    assert(CENTRES.flat().includes(f * 9 + 2) && CENTRES.flat().includes(f * 9 + 5) && CENTRES.flat().includes(f * 9 + 7));
  }
});

test('turns: each is order 3, X\' = X X, U/L/R/B move 12 stickers and u/l/r/b 3, tips commute with everything', () => {
  const start = randomState(7);
  for (const t of pz.turnNames) {
    const one = pz.applyMoves(start, t);
    assert.notDeepStrictEqual(one, start, t);
    assert.deepStrictEqual(pz.applyMoves(start, `${t} ${t} ${t}`), start, t + ' x3');
    assert.deepStrictEqual(pz.applyMoves(start, `${t}'`), pz.applyMoves(start, `${t} ${t}`), t + "'");
    assert.strictEqual(pz.turns[t].moving.length, t === t.toUpperCase() ? 12 : 3);
  }
  for (const a of ['u', 'l', 'r', 'b']) for (const b of pz.turnNames) {
    assert.deepStrictEqual(pz.applyMoves(start, `${a} ${b}`), pz.applyMoves(start, `${b} ${a}`), `${a} ${b}`);
  }
  for (let i = 0; i < 50; i++) {
    const seq = pz.randomMoves(20, i + 1, pz.turnNames);
    assert.deepStrictEqual(pz.applyMoves(pz.applyMoves(start, seq), pz.inverse(seq)), start);
  }
  // a commutator of two corner turns never twists a tip
  const comm = pz.applyMoves(pz.solvedFaces(), "R U R' U'");
  for (const t of P.pieces.TIPS) for (const i of t) assert.strictEqual(comm[i], pz.solvedFaces()[i]);
});

test('turn direction: U is clockwise seen from above (the front face gets the right face\'s colours, like a cube\'s U)', () => {
  const s = pz.applyMoves(pz.solvedFaces(), 'U');
  for (const i of [0, 1, 2, 3]) assert.strictEqual(s[i], 'R');
  for (const i of [4, 5, 6, 7, 8]) assert.strictEqual(s[i], 'F');
  const t = pz.applyMoves(pz.solvedFaces(), 'u');
  assert.strictEqual(t[0], 'R'); assert.strictEqual(t[1], 'F');
});

test('notation: U L R B u l r b with \', "2" read as \'; anything else is refused in plain words', () => {
  assert.strictEqual(pz.formatMoves(pz.parseMoves("U L' r b' B")), "U L' r b' B");
  assert.strictEqual(pz.formatMoves(pz.parseMoves('U2 l2')), "U' l'");
  assert.strictEqual(pz.formatMoves(pz.parseMoves('R’')), "R'");
  assert.throws(() => pz.parseMoves('F'), /not a Pyraminx move/);
  assert.throws(() => pz.parseMoves('Uw'), /not a Pyraminx move/);
});

test('fill-in map: the faces fold up (neighbouring cells across a fold belong to the same piece), and do not overlap', () => {
  const { cells } = pz.netLayout();
  assert.strictEqual(cells.length, 36);
  const pieceOf = new Map();
  [...P.pieces.TIPS, ...P.pieces.CENTRES, ...P.pieces.EDGES].forEach((pc, k) => pc.forEach((i) => pieceOf.set(i, k)));
  const d = (a, b) => Math.hypot(a.centre[0] - b.centre[0], a.centre[1] - b.centre[1]);
  let folds = 0;
  for (const a of cells.filter((c) => c.face === 'F')) {
    const others = cells.filter((c) => c.face !== 'F');
    const nearest = others.reduce((x, y) => (d(a, y) < d(a, x) ? y : x));
    if (d(a, nearest) < 1.5) { folds++; assert.strictEqual(pieceOf.get(a.i), pieceOf.get(nearest.i), `cell ${a.i} next to ${nearest.i}`); }
  }
  assert.strictEqual(folds, 6, 'the 3 tips and 3 edges of the front face lie along a fold');
  for (let i = 0; i < cells.length; i++) for (let j = i + 1; j < cells.length; j++) assert(d(cells[i], cells[j]) > 0.9);
  // L, R and D (template bottom-left/bottom-right corners) end up where they fold to: the bottom face below the front
  const cy = (f) => cells.filter((c) => c.face === f).reduce((s, c) => s + c.centre[1], 0) / 9;
  const cx = (f) => cells.filter((c) => c.face === f).reduce((s, c) => s + c.centre[0], 0) / 9;
  assert(cx('L') < cx('F') && cx('R') > cx('F') && cy('D') > cy('F'));
});

test('definition: the fields the window needs, and it loads as a <script> into window.Puzzles', () => {
  for (const k of ['id', 'name', 'short', 'puzzle', 'validate', 'scrambleLength', 'scan', 'holdHelp', 'notationHelp']) assert(P[k] != null, k);
  assert.strictEqual(P.id, 'pyraminx');
  assert.deepStrictEqual(P.scan.faces.map((f) => f.face).sort(), ['D', 'F', 'L', 'R']);
  assert.strictEqual(P.scan.experimental, true);
  for (const f of P.scan.faces) assert(pz.templates[f.face] && f.say.length > 20);
  const win = { self: null }; win.self = win;
  const ctx = vm.createContext(win);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/puzzle-core.js'), 'utf8'), ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/puzzles/pyraminx.js'), 'utf8'), ctx);
  assert.strictEqual(win.Puzzles.pyraminx.puzzle.size, 36);
  assert.strictEqual(win.Puzzles.pyraminx.validate(solvedCols()).ok, true);
});

// ---- validation -----------------------------------------------------------------------------------------------------
test('validation: solved and scrambled puzzles pass, in any way of holding and any colour stickering', () => {
  const v = P.validate(solvedCols());
  assert(v.ok && v.solved, v.summary);
  assert.strictEqual(v.summary, 'This Pyraminx is already solved.');
  const rotU = wholeRotation([0, 1, 0], 2 * Math.PI / 3);
  const rotX = wholeRotation(P.puzzle.turns.B.axis, 2 * Math.PI / 3);
  for (let i = 0; i < 100; i++) {
    const cols = colourise(randomState(100 + i));
    const r = P.validate(cols);
    assert(r.ok && !r.solved, r.summary);
    const turned = permute(permute(cols, rotU), i % 2 ? rotX : rotU);
    assert(P.validate(turned).ok);
    assert.strictEqual(S.plan(turned).body.length + S.plan(turned).tips.length, S.plan(cols).body.length + S.plan(cols).tips.length);
    // a puzzle stickered in other colours (any colours on any faces) is just as real
    const relabel = { g: 'y', y: 'r', r: 'g', b: 'b' };
    const other = cols.map((c) => (i % 3 ? relabel[c] : { g: 'r', r: 'g', b: 'b', y: 'y' }[c]));
    const o = P.validate(other);
    assert(o.ok, o.summary);
  }
});

test('validation: empty stickers and wrong colour counts', () => {
  const a = solvedCols(); a[3] = null; a[30] = undefined;
  const r = P.validate(a);
  assert.deepStrictEqual(r.errors[0].stickers, [3, 30]);
  assert.match(r.summary, /2 stickers are not filled in yet/);
  const b = solvedCols(); b[1] = 'r';
  const rb = P.validate(b);
  assert(kinds(b).includes('count'));
  assert.match(rb.errors.find((e) => e.kind === 'count').text, /exactly 9 times.*8 green and 10 red/);
  assert(!rb.ok);
  assert.match(P.validate([]).summary, /36 stickers/);
});

test('validation: impossible centres (two of a colour, two the same, mirror image)', () => {
  const C = P.pieces.CENTRES;
  const a = solvedCols(); a[C[0][0]] = a[C[0][1]];
  let r = P.validate(a);
  assert(r.errors.some((e) => e.kind === 'centre' && /top corner.*two (red|green|blue) stickers/.test(e.text) && e.stickers.includes(C[0][0])), r.summary);
  // the top centre made to look like the front-left one (same three colours)
  const b = solvedCols(); C[0].forEach((i, k) => { b[i] = b[C[1][k]]; });
  r = P.validate(b);
  assert(r.errors.some((e) => e.kind === 'centre' && /different set of three colours/.test(e.text)), r.summary);
  const c = swap(solvedCols(), C[2][0], C[2][1]);
  r = P.validate(c);
  assert(r.errors.some((e) => e.kind === 'centre' && /front-right corner go round the wrong way/.test(e.text) && e.stickers.length === 3), r.summary);
});

test('validation: impossible tips (a colour its centre does not have, two of a colour, mirror image)', () => {
  const T = P.pieces.TIPS; const C = P.pieces.CENTRES;
  const lack = (v) => ['g', 'r', 'b', 'y'].find((x) => !C[v].some((i) => solvedCols()[i] === x));
  const a = solvedCols(); a[T[0][1]] = lack(0);
  let r = P.validate(a);
  assert(r.errors.some((e) => e.kind === 'tip' && /top tip has yellow.*same three colours/.test(e.text) && e.stickers.includes(T[0][1])), r.summary);
  const b = solvedCols(); b[T[3][0]] = b[T[3][1]];
  r = P.validate(b);
  assert(r.errors.some((e) => e.kind === 'tip' && /back tip has two/.test(e.text)), r.summary);
  r = P.validate(swap(solvedCols(), T[1][0], T[1][2]));
  assert.deepStrictEqual(kinds(swap(solvedCols(), T[1][0], T[1][2])), ['tip']);
  assert.match(r.summary, /front-left tip go round the wrong way/);
});

test('validation: impossible edges, the same edge twice, one flipped edge, two swapped edges', () => {
  const E = P.pieces.EDGES;
  const a = solvedCols(); a[E[0][0]] = a[E[0][1]];
  assert(P.validate(a).errors.some((e) => e.kind === 'edge' && /front-left edge has two/.test(e.text)));
  // the front-left edge copied onto the front-right place (so front-right's own edge is missing)
  const b = solvedCols(); b[E[1][0]] = b[E[0][0]]; b[E[1][1]] = b[E[0][1]];
  const rb = P.validate(b);
  assert(rb.errors.some((e) => e.kind === 'duplicate' && /green-red edge is there twice: at the front-left edge and front-right edge/.test(e.text) && e.stickers.length === 4), rb.summary);
  assert(rb.errors.some((e) => e.kind === 'missing' && /green-blue/.test(e.text)), rb.summary);
  const st = randomState(3);
  const flipped = swap(colourise(st), E[4][0], E[4][1]);
  assert.deepStrictEqual(kinds(flipped), ['flip']);
  assert.match(P.validate(flipped).summary, /One edge is flipped/);
  assert.strictEqual(P.validate(flipped).errors[0].stickers.length, 12);
  // trade two edges' places without flipping them
  const sw = colourise(st); const t = sw.slice();
  [t[E[2][0]], t[E[2][1]], t[E[5][0]], t[E[5][1]]] = [sw[E[5][0]], sw[E[5][1]], sw[E[2][0]], sw[E[2][1]]];
  const ks = kinds(t);
  assert(ks.length === 1 || ks.length === 2); // swapping can also change the flip count
  assert(ks.includes('parity'), ks.join());
  assert.match(P.validate(t).errors.find((e) => e.kind === 'parity').text, /Two edges have swapped places/);
  // brute force: every single edge flip and every edge swap of every scrambled state is refused
  for (let s = 0; s < 20; s++) {
    const base = colourise(randomState(500 + s));
    for (let i = 0; i < 6; i++) {
      assert(!P.validate(swap(base, E[i][0], E[i][1])).ok);
      for (let j = i + 1; j < 6; j++) for (const fl of [0, 1]) {
        const x = base.slice(); x[E[i][0]] = base[E[j][fl]]; x[E[i][1]] = base[E[j][1 - fl]]; x[E[j][fl]] = base[E[i][0]]; x[E[j][1 - fl]] = base[E[i][1]];
        assert(!P.validate(x).ok);
      }
    }
  }
});

test('validation: a state reachable by turns is always accepted (500 random scrambles)', () => {
  for (let i = 0; i < 500; i++) {
    const cols = pz.applyMoves(solvedCols(), pz.randomMoves(25, i + 1, pz.turnNames));
    assert(P.validate(cols).ok);
  }
});

// ---- solver -----------------------------------------------------------------------------------------------------------
test('solver tables: the known distance distribution (God\'s number 11 without tips), built quickly', () => {
  const t0 = Date.now();
  const t = S.init();
  assert.deepStrictEqual(t.counts, [1, 8, 48, 288, 1728, 9896, 51808, 220111, 480467, 166276, 2457, 32]);
  console.log(`     tables built in ${t.ms} ms (${Date.now() - t0} ms here), ${(t.dist.length / 1e6).toFixed(1)} MB distance table`);
});

test('solver: optimal, against an independent breadth-first search on whole sticker states (depth 5) plus tips', () => {
  const body = ['U', "U'", 'L', "L'", 'R', "R'", 'B', "B'"].map((m) => pz.parseMoves(m)[0]);
  const seen = new Map([[pz.solvedFaces().join(''), 0]]);
  let frontier = [pz.solvedFaces()];
  const counts = [1];
  for (let d = 1; d <= 5; d++) {
    const next = [];
    for (const s of frontier) for (const m of body) { const t = pz.applyMove(s, m); const k = t.join(''); if (!seen.has(k)) { seen.set(k, d); next.push(t); } }
    counts.push(next.length); frontier = next;
  }
  assert.deepStrictEqual(counts, [1, 8, 48, 288, 1728, 9896]);
  let checked = 0;
  for (const [k, d] of seen) {
    if (checked++ % 7) continue;
    const faces = k.split('');
    assert.deepStrictEqual(S.distance(faces), [d, 0]);
    // add some tip turns: each wrong tip costs exactly one
    const tips = ['u', "l'", 'r', "b'"].slice(0, checked % 5);
    const cols = colourise(pz.applyMoves(faces, tips.join(' ')));
    const p = S.plan(cols);
    assert.strictEqual(p.body.length, d); assert.strictEqual(p.tips.length, tips.length);
  }
});

test('solver: 1000 random positions solved and checked; lengths and times', () => {
  const lens = []; let worstMs = 0; const t0 = Date.now();
  for (let i = 0; i < 1000; i++) {
    const cols = colourise(randomState(1000 + i));
    const t = Date.now();
    const r = S.solve(cols);
    worstMs = Math.max(worstMs, Date.now() - t);
    const moves = pz.parseMoves(r.moves);
    assert(pz.isSolved(pz.applyMoves(cols, moves)), r.moves);
    assert.strictEqual(r.stages.map((s) => s.moves).filter(Boolean).join(' '), r.moves);
    assert(moves.length <= 15);
    // tips first, then only corner turns
    const firstBig = moves.findIndex((m) => m.turn === m.turn.toUpperCase());
    assert(moves.slice(firstBig < 0 ? moves.length : firstBig).every((m) => m.turn === m.turn.toUpperCase()));
    lens.push(moves.length);
  }
  const avg = lens.reduce((s, x) => s + x, 0) / lens.length;
  console.log(`     average ${avg.toFixed(2)} turns (most ${Math.max(...lens)}), ${((Date.now() - t0) / 1000).toFixed(3)} ms per solve, worst ${worstMs} ms`);
  assert.deepStrictEqual(S.solve(solvedCols()), { moves: '', stages: [] });
});

test('solver: the 32 hardest positions (11 turns) with all four tips wrong: 15 turns each, quickly', () => {
  const t = S.init();
  let n = 0; let worst = 0;
  for (let s = 0; s < t.dist.length; s++) {
    if (t.dist[s] !== 11) continue;
    n++;
    const pcs = S.piecesOf(s);
    pcs.tt = pcs.tt.map((x, k) => (x + 1 + (k % 2)) % 3);
    const cols = colourise(P.fromPieces(pcs));
    const t0 = Date.now();
    const r = S.solve(cols);
    worst = Math.max(worst, Date.now() - t0);
    assert(pz.isSolved(pz.applyMoves(cols, r.moves)));
    assert.strictEqual(pz.parseMoves(r.moves).length, 15);
    assert.strictEqual(r.stages[0].title, 'Turn the tips');
    assert.strictEqual(pz.parseMoves(r.stages[0].moves).length, 4);
    if (n === 1) console.log(`     e.g. ${r.moves}`);
  }
  assert.strictEqual(n, 32);
  console.log(`     worst solve ${worst} ms`);
  const flipped = colourise(P.fromPieces({ ep: [0, 1, 2, 3, 4, 5], eo: [1, 1, 0, 0, 0, 0], cc: [0, 0, 0, 0], tt: [0, 0, 0, 0] }));
  assert.throws(() => S.solve(swap(flipped, P.pieces.EDGES[0][0], P.pieces.EDGES[0][1])), /flipped/);
});

(async () => {
  let failed = 0;
  for (const [name, fn] of tests) {
    const t0 = Date.now();
    try { await fn(); console.log(`ok   ${name} (${Date.now() - t0} ms)`); }
    catch (e) { failed++; console.log(`FAIL ${name}\n     ${String((e && e.stack) || e).split('\n').slice(0, 6).join('\n     ')}`); }
  }
  console.log(failed ? `\n${failed} of ${tests.length} failed` : `\nall ${tests.length} passed`);
  process.exit(failed ? 1 : 0);
})();
