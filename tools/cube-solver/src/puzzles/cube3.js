'use strict';
// The 3x3 Rubik's cube as a puzzle module (see puzzle-core.js). The model itself lives in ../cube.js (same sticker order,
// turns and validation as always); this file only presents it the way every puzzle module looks.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('../puzzle-core'), require('../cube'));
  else { const def = factory(root.PuzzleCore, root.CubeModel); (root.Puzzles = root.Puzzles || {})[def.id] = def; }
}(typeof self !== 'undefined' ? self : this, function (PuzzleCore, CubeModel) {
  return CubeModel.makePuzzleDef(3, PuzzleCore);
}));
