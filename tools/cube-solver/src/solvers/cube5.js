'use strict';
// 5x5 solver: the human "reduction" method (centres, pair the edges, solve it like a 3x3). See bigcube.js.
const { makeSolver } = require('./bigcube');

const S = makeSolver(5);
module.exports = { init: S.init, solve: (colours) => S.solve(colours) };
