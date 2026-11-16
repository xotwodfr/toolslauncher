'use strict';
// The 5x5 ("Professor's Cube") as a puzzle module (see puzzle-core.js and bigcube-kit.js, which holds the geometry, the
// notation and the validation shared with the 4x4). 150 stickers: U, R, F, D, L, B, 25 each, row by row as cube.js reads a
// 3x3. Turns: R, Rw (two layers), r (only the second layer) for every face, and the middle layers M, E, S, with ' and 2.
//
// The middle sticker of every face is fixed (it only moves with M, E, S, which turn the whole picture with it), so those
// six say which colour belongs on which face, as on a 3x3. What makes a filled-in 5x5 unsolvable: wrong colour counts (in
// total, and among the four diagonal and the four straight centre stickers of every face, which can never trade places),
// two middle stickers of one colour, impossible corners or edge pieces, the same piece twice, and the 3x3 rules for the
// corners and the middle edge pieces (which move exactly like a 3x3's corners and edges): no twisted corner, no single
// flipped middle edge, no two swapped pieces. The edge wings (the edge pieces next to the corners) can be in any
// arrangement, so an edge whose wings are "flipped" is a normal position, fixed by the solution.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./bigcube-kit'));
  else {
    if (!root.BigCubeKit) throw new Error('cube5.js needs bigcube-kit.js to be loaded first');
    const def = factory(root.BigCubeKit); (root.Puzzles = root.Puzzles || {})[def.id] = def;
  }
}(typeof self !== 'undefined' ? self : this, function (Kit) {
  return Kit.makeDef(5);
}));
