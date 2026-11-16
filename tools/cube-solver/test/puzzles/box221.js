'use strict';
// A THROWAWAY TEST PUZZLE for the end-to-end test (never offered in normal use): a 2x2x1 cuboid that only turns its sides
// half a turn. Its side faces are 2x1 rectangles, so it proves the window's rectangle paths (map, cubie 3D view of a
// non-cube, a four-corner outline on a non-square face) on a puzzle small enough to solve by a complete search.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('../../src/puzzle-core'));
  else { const def = factory(root.PuzzleCore); (root.Puzzles = root.Puzzles || {})[def.id] = def; }
}(typeof self !== 'undefined' ? self : this, function (PC) {
  const F = [
    { id: 'U', name: 'Top', normal: [0, 1, 0], up: [0, 0, -1], colour: 'w' }, { id: 'D', name: 'Bottom', normal: [0, -1, 0], up: [0, 0, 1], colour: 'y' },
    { id: 'F', name: 'Front', normal: [0, 0, 1], up: [0, 1, 0], colour: 'g' }, { id: 'B', name: 'Back', normal: [0, 0, -1], up: [0, 1, 0], colour: 'b' },
    { id: 'R', name: 'Right', normal: [1, 0, 0], up: [0, 1, 0], colour: 'r' }, { id: 'L', name: 'Left', normal: [-1, 0, 0], up: [0, 1, 0], colour: 'o' },
  ];
  const half = [1, 0.5, 1]; // half the size along x, y, z
  const stickers = [];
  for (const f of F) {
    const k = f.normal.findIndex((v) => v !== 0);
    const t = [0, 1, 2].filter((j) => j !== k);
    const cells = t.map((j) => (half[j] === 1 ? [-0.5, 0.5] : [0]));
    for (const a of cells[0]) for (const b of cells[1]) {
      const c = [0, 0, 0]; c[k] = f.normal[k] * half[k]; c[t[0]] = a; c[t[1]] = b;
      const corner = (da, db) => { const p = c.slice(); p[t[0]] += da; p[t[1]] += db; return p; };
      stickers.push({ face: f.id, centre: c, poly: [corner(-0.5, -0.5), corner(0.5, -0.5), corner(0.5, 0.5), corner(-0.5, 0.5)] });
    }
  }
  const turns = {
    R: { axis: [1, 0, 0], order: 2, select: (c) => c[0] > 0.01 }, L: { axis: [-1, 0, 0], order: 2, select: (c) => c[0] < -0.01 },
    F: { axis: [0, 0, 1], order: 2, select: (c) => c[2] > 0.01 }, B: { axis: [0, 0, -1], order: 2, select: (c) => c[2] < -0.01 },
  };
  const COLOURS = { w: ['white', '#f4f4f2'], y: ['yellow', '#ffd500'], g: ['green', '#009b48'], b: ['blue', '#0046ad'], r: ['red', '#c41e3a'], o: ['orange', '#ff5800'] };
  const puzzle = PC.definePuzzle({
    id: 'box221', name: 'Test 2x2x1',
    colours: Object.fromEntries(Object.entries(COLOURS).map(([k, [name, hex]]) => [k, { name, hex }])),
    faces: F, stickers, turns,
    net: [{ face: 'U', x: 2.4, y: 0 }, { face: 'L', x: 0, y: 2 }, { face: 'F', x: 2.4, y: 2 }, { face: 'R', x: 4.8, y: 2 }, { face: 'B', x: 7.2, y: 2 }, { face: 'D', x: 2.4, y: 4 }],
  });
  const reach = new Map();
  const start = puzzle.solvedColours();
  reach.set(start.join(','), null);
  let frontier = [start];
  while (frontier.length) {
    const next = [];
    for (const st of frontier) for (const t of puzzle.turnNames) {
      const n = puzzle.applyMove(st, { turn: t, amount: 1 });
      const k = n.join(',');
      if (!reach.has(k)) { reach.set(k, { from: st.join(','), move: { turn: t, amount: 1 } }); next.push(n); }
    }
    frontier = next;
  }
  function validate(colours) {
    const empty = colours.map((c, i) => (c ? -1 : i)).filter((i) => i >= 0);
    if (empty.length) return { ok: false, errors: [{ text: `${empty.length} stickers are not filled in yet.`, stickers: empty }] };
    if (!reach.has(colours.join(','))) {
      // the stickers that differ from the nearest reachable state
      let off = null;
      for (const k of reach.keys()) { const st = k.split(','); const d = colours.map((c, i) => i).filter((i) => st[i] !== colours[i]); if (!off || d.length < off.length) off = d; }
      return { ok: false, errors: [{ text: 'This 2x2x1 cannot be reached by turning: some stickers are wrong.', stickers: off }] };
    }
    return { ok: true, solved: puzzle.isSolved(colours) };
  }
  return {
    id: 'box221', name: 'Test 2x2x1', short: '2x2x1', puzzle, validate, scrambleLength: 8, reach, optimal: true,
    scan: { experimental: false, faces: ['F', 'R', 'B', 'L', 'U', 'D'].map((f) => ({ face: f, say: `Show the ${F.find((x) => x.id === f).name.toLowerCase()} face.` })) },
    holdHelp: 'A test puzzle: white on top, green in front; only the sides turn, half a turn at a time.',
    notationHelp: 'R, L, F and B turn that side half a turn.',
  };
}));
