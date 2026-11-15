'use strict';
// 3x3 solver adapter: Kociemba's two-phase search (../solver3.js) behind the common solver interface.
const C = require('../cube');
const S3 = require('../solver3');

function init(onProgress) { S3.init(onProgress); }
function solve(colours) {
  const v = C.validate(3, colours);
  if (!v.ok) throw new Error(v.summary);
  if (v.solved) return { moves: '', stages: [] };
  const text = S3.solve(v.faces).join(' ');
  return { moves: text, stages: [{ title: 'Solve', moves: text }] };
}
module.exports = { init, solve };
