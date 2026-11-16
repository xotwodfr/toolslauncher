'use strict';
// Known puzzles and invented pictures of them, shared by the end-to-end test and its runner.
const path = require('path');
const C = require('../src/cube');
const K = require('../src/colour');
const { renderFace, renderTemplate, printFor, writeY4m } = require('../src/synth');
const Registry = require('../src/puzzles');

const SCAN_ORDER = ['F', 'R', 'B', 'L', 'U', 'D'];
/** The scrambled 3x3 the fake webcam shows (colours, standard scheme, white up / green front). */
const scanCube = (seed) => C.randomState3(seed).map((f) => C.STANDARD_SCHEME[f]);
const faceColours = (colours, n, face) => { const f = C.FACES.indexOf(face); return colours.slice(f * n * n, (f + 1) * n * n); };

/** The end-to-end test's own small test puzzles (a tetrahedron and a 2x2x1), loaded like real modules. */
const TEST_PUZZLES = ['tetra', 'box221'].map((id) => ({ id, puzzlePath: path.join(__dirname, 'puzzles', id + '.js'), solverPath: path.join(__dirname, 'puzzles', 'solvers', id + '.js'), group: 'Test puzzles' }));
const allPuzzles = () => Registry.loadAll({ extra: TEST_PUZZLES });
/** The non-cube puzzle the fake webcam also shows: the Pyraminx when it is there, else the test tetrahedron. */
const camPuzzle = () => { const all = allPuzzles(); return (all.find((p) => p.id === 'pyraminx') || all.find((p) => p.id === 'tetra')).def; };
/** A scrambled state of any puzzle, the same every time for a seed. */
const scrambled = (def, seed) => def.puzzle.applyMoves(def.puzzle.solvedColours(), def.puzzle.randomMoves(def.scrambleLength || 20, seed));
const W = 480; const H = 360; const GRID = 0.62; // the window's default webcam outline: 62% of the picture, centred

/** A video that shows the 3x3's six faces in scan order, then the camera puzzle's faces, each for 2 seconds, looped. */
function scanVideo(file, seed) {
  const colours = scanCube(seed);
  const lights = { F: [1, 1, 1], R: [1.08, 1, 0.86], B: [0.8, 0.8, 0.82], L: [1, 1, 1.04], U: [1.02, 1, 0.95], D: [0.88, 0.9, 0.9] };
  const side = H * GRID;
  const quad = [[(W - side) / 2, (H - side) / 2], [(W + side) / 2, (H - side) / 2], [(W + side) / 2, (H + side) / 2], [(W - side) / 2, (H + side) / 2]];
  const frames = SCAN_ORDER.map((f, k) => ({ image: renderFace(faceColours(colours, 3, f), { width: W, height: H, quad, light: lights[f], noise: 3, glare: 0.25, seed: 50 + k }), repeat: 20 }));
  const def = camPuzzle(); const P = def.puzzle; const st = scrambled(def, seed);
  def.scan.faces.forEach(({ face }, k) => {
    const t = P.templates[face];
    frames.push({ image: renderTemplate(t, st, { width: W, height: H, corners: K.placeOutline(t, W / 2, H / 2, Math.min(W, H) * GRID), print: printFor(P.colours), light: [[1, 1, 1], [1.05, 1, 0.9], [0.85, 0.85, 0.88], [1, 1, 1.04]][k % 4], noise: 3, glare: 0.2, seed: 80 + k }), repeat: 20 });
  });
  return writeY4m(file, frames, 10);
}
module.exports = { SCAN_ORDER, scanCube, faceColours, scanVideo, TEST_PUZZLES, allPuzzles, camPuzzle, scrambled };
