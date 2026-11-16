'use strict';
// 4x4 solver: the human "reduction" method (centres, pair the edges, solve it like a 3x3). See bigcube.js.
const { makeSolver } = require('./bigcube');

const S = makeSolver(4);
module.exports = { init: S.init, solve: (colours) => S.solve(colours) };
