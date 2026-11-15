'use strict';
// The 4x4 ("Rubik's Revenge") as a puzzle module (see puzzle-core.js and bigcube-kit.js, which holds the geometry, the
// notation and the validation shared with the 5x5). 96 stickers: U, R, F, D, L, B, 16 each, row by row as cube.js reads a
// 3x3. Turns: R, Rw (two layers), r (only the second layer), for every face, with ' and 2.
//
// What makes a filled-in 4x4 unsolvable: a wrong number of stickers of a colour, an impossible corner (two stickers of one
// colour, opposite colours, a mirror image), an impossible edge piece, the same edge piece twice (the two edge pieces of
// one edge are mirror images, so an edge piece filled in the wrong way round looks like its twin), or a twisted corner.
// Nothing else: on a 4x4 every arrangement of the edge pieces can be reached (an inner slice turn swaps an odd number of
// them), and the centre stickers of one colour are interchangeable, so any arrangement of them can be reached too. The
// "parity" situations everybody knows from the 4x4 (a single flipped edge, two swapped edges after reduction) are normal
// positions, fixed by the solution.
// The 4x4 has no fixed centres: which colour belongs on which face is worked out from the corners, as on the 2x2.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./bigcube-kit'));
  else {
    if (!root.BigCubeKit) throw new Error('cube4.js needs bigcube-kit.js to be loaded first');
    const def = factory(root.BigCubeKit); (root.Puzzles = root.Puzzles || {})[def.id] = def;
  }
}(typeof self !== 'undefined' ? self : this, function (Kit) {
  return Kit.makeDef(4);
}));
