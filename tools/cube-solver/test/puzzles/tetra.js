'use strict';
// A THROWAWAY TEST PUZZLE for the end-to-end test (never offered in normal use): a tetrahedron, each face cut into four
// triangles, whose four tips can be twisted. It proves the window's triangle paths (fill-in map, 3D body with turning
// tips, scanning with a three-corner outline, a centre sticker on every face that never moves) on a puzzle tiny enough to
// solve by a complete search. Loaded like a real module: require() in Node, a <script> tag in the window.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('../../src/puzzle-core'));
  else { const def = factory(root.PuzzleCore); (root.Puzzles = root.Puzzles || {})[def.id] = def; }
}(typeof self !== 'undefined' ? self : this, function (PC) {
  const V = { A: [1, 1, 1], B: [1, -1, -1], C: [-1, 1, -1], D: [-1, -1, 1] };
  const FACES = { a: ['B', 'C', 'D'], b: ['A', 'D', 'C'], c: ['A', 'B', 'D'], d: ['A', 'C', 'B'] }; // face x lies opposite vertex X
  const COL = { a: 'g', b: 'r', c: 'b', d: 'y' };
  const NAME = { a: 'Green', b: 'Red', c: 'Blue', d: 'Yellow' };
  const mid = (p, q) => p.map((v, k) => (v + q[k]) / 2);
  const stickers = []; const faces = [];
  for (const [f, vs] of Object.entries(FACES)) {
    const opp = V[f.toUpperCase()];
    const [p, q, r] = vs.map((k) => V[k]);
    const centre = PC.centroid([p, q, r]);
    faces.push({ id: f, name: NAME[f], normal: PC.scale(opp, -1), up: PC.sub(p, centre), colour: COL[f] });
    const tri = (pts) => stickers.push({ face: f, centre: PC.centroid(pts), poly: pts });
    tri([p, mid(p, q), mid(p, r)]); tri([q, mid(q, r), mid(q, p)]); tri([r, mid(r, p), mid(r, q)]);
    tri([mid(p, q), mid(q, r), mid(r, p)]);
  }
  const turns = {};
  for (const [k, v] of Object.entries(V)) { const a = PC.unit(v); turns[k] = { axis: v, order: 3, select: (c) => PC.dot(c, a) > 0.6 }; }
  const puzzle = PC.definePuzzle({
    id: 'tetra', name: 'Test tetrahedron',
    colours: { g: { name: 'green', hex: '#009b48' }, r: { name: 'red', hex: '#c41e3a' }, b: { name: 'blue', hex: '#0046ad' }, y: { name: 'yellow', hex: '#ffd500' } },
    faces, stickers, turns,
    net: [{ face: 'a', x: 0, y: 0 }, { face: 'b', x: 3.4, y: 0 }, { face: 'c', x: 6.8, y: 0 }, { face: 'd', x: 10.2, y: 0 }],
  });
  // every reachable state (3^4 = 81), by a complete search, with the turn that leads back towards solved
  const reach = new Map();
  const start = puzzle.solvedColours();
  reach.set(start.join(','), null);
  let frontier = [start];
  while (frontier.length) {
    const next = [];
    for (const st of frontier) for (const t of puzzle.turnNames) for (const amount of [1, 2]) {
      const n = puzzle.applyMove(st, { turn: t, amount });
      const k = n.join(',');
      if (!reach.has(k)) { reach.set(k, { from: st.join(','), move: { turn: t, amount: 3 - amount } }); next.push(n); }
    }
    frontier = next;
  }
  const fixed = stickers.map((s, i) => i).filter((i) => i % 4 === 3);
  function validate(colours) {
    const errors = [];
    const empty = colours.map((c, i) => (c ? -1 : i)).filter((i) => i >= 0);
    if (empty.length) errors.push({ text: `${empty.length} stickers are not filled in yet.`, stickers: empty });
    else if (!reach.has(colours.join(','))) {
      const wrong = colours.map((c, i) => i).filter((i) => !fixed.includes(i));
      const tips = Object.keys(V).filter((k) => { const m = puzzle.turns[k].moving; return ![0, 1, 2].some((a) => reach.has(puzzle.applyMove(start, a ? { turn: k, amount: a } : { turn: k, amount: 3 }).join(',')) && m.every((i) => puzzle.applyMove(start, { turn: k, amount: a || 3 })[i] === colours[i])); });
      errors.push({ text: `The tip${tips.length === 1 ? '' : 's'} at corner ${tips.join(', ')} ${tips.length === 1 ? 'has' : 'have'} colours no real tip has.`, stickers: tips.length ? tips.flatMap((k) => puzzle.turns[k].moving) : wrong });
    }
    return errors.length ? { ok: false, errors, summary: errors[0].text } : { ok: true, solved: puzzle.isSolved(colours) };
  }
  return {
    id: 'tetra', name: 'Test tetrahedron', short: 'Tetra', puzzle, validate, scrambleLength: 6, fixedStickers: fixed, reach,
    optimal: true,
    scan: { experimental: true, faces: ['a', 'b', 'c', 'd'].map((f) => ({ face: f, say: `Show the ${NAME[f].toLowerCase()} face.` })) },
    holdHelp: 'A test puzzle: four faces, each with a centre that never moves and three tips.',
    notationHelp: 'A, B, C and D twist the tip at that corner a third of a turn clockwise; \' means anticlockwise.',
  };
}));
