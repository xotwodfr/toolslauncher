'use strict';
// 3x3 solver: Kociemba's two-phase algorithm from cubejs (MIT, vendored in ./vendor/cubejs without its stray "npm"
// dependency). The tables take a second or two to build, so this runs in a worker thread (solver-worker.js), one table at a
// time so the window can show progress. Solutions are at most 22 turns and checked by the caller against our own model.
const C = require('./cube');
const Cube = require('./vendor/cubejs/cube');
require('./vendor/cubejs/solve');

// the same order cubejs uses internally (mergeURtoDF needs URtoUL and UBtoDF first)
const STEPS = [
  ['move', 'twist'], ['move', 'flip'], ['move', 'FRtoBR'], ['move', 'URFtoDLF'], ['move', 'URtoDF'], ['move', 'URtoUL'],
  ['move', 'UBtoDF'], ['move', 'mergeURtoDF'],
  ['prune', 'sliceTwist'], ['prune', 'sliceFlip'], ['prune', 'sliceURFtoDLFParity'], ['prune', 'sliceURtoDFParity'],
];
let ready = false;
/** Builds the tables, calling onProgress(fraction) after each one. */
function init(onProgress) {
  if (ready) return;
  STEPS.forEach(([kind, name], i) => {
    if (kind === 'move') Cube.computeMoveTables(name); else Cube.computePruningTables(name);
    if (onProgress) onProgress((i + 1) / STEPS.length);
  });
  ready = true;
}
/**
 * faces: 54 face letters (URFDLB order) of a valid, unsolved cube. Returns the moves as an array. The first answer (at most
 * 22 turns) usually comes in well under a second; then, for up to `polishMs`, the search goes on for shorter answers (phase 2
 * kept to 10 turns, as in Kociemba's own program), and the shortest one found is returned.
 */
function solve(faces, { polishMs = 1000 } = {}) {
  init();
  const str = Array.isArray(faces) ? faces.join('') : String(faces);
  if (!/^[URFDLB]{54}$/.test(str)) throw new Error('A 3x3 cube needs 54 stickers');
  if (C.isSolved(3, str.split(''))) return [];
  const cube = Cube.fromString(str);
  const first = cube.solve(22);
  if (first == null) throw new Error('No solution was found');
  let best = C.simplify(C.parseMoves(first));
  if (polishMs > 0 && best.length > 1) {
    try {
      const text = cube.solve(best.length - 1, Date.now() + polishMs, 10, true);
      if (text != null) { const m = C.simplify(C.parseMoves(text)); if (m.length < best.length) best = m; }
    } catch { /* out of time without a shorter one: keep the first */ }
  }
  return best;
}
module.exports = { init, solve, isReady: () => ready };
