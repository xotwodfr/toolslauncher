'use strict';
// Solver for the throwaway test puzzle ../box221.js: walks its complete table of reachable states back to solved.
const def = require('../box221');

module.exports = {
  init(onProgress) { if (onProgress) onProgress(1); },
  solve(colours) {
    const v = def.validate(colours);
    if (!v.ok) throw new Error(v.errors[0].text);
    const moves = [];
    let k = colours.join(',');
    while (def.reach.get(k)) { const step = def.reach.get(k); moves.push(step.move); k = step.from; }
    const text = def.puzzle.formatMoves(moves);
    return { moves: text, stages: moves.length > 1 ? [{ title: 'First turn', moves: def.puzzle.formatMoves(moves.slice(0, 1)) }, { title: 'The rest', moves: def.puzzle.formatMoves(moves.slice(1)) }] : [{ title: 'Solve', moves: text }] };
  },
};
