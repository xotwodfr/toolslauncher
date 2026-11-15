'use strict';
// 2x2 solver adapter: the optimal distance-table solver (../solver2.js) behind the common solver interface.
const C = require('../cube');
const S2 = require('../solver2');

function init(onProgress) { S2.init(onProgress); }
function solve(colours) {
  const v = C.validate(2, colours);
  if (!v.ok) throw new Error(v.summary);
  if (v.solved) return { moves: '', stages: [] };
  const text = S2.solve(v.faces).join(' ');
  return { moves: text, stages: [{ title: 'Solve (fewest turns)', moves: text }] };
}
module.exports = { init, solve };
