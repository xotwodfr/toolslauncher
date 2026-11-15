'use strict';
// Known cubes and invented pictures of them, shared by the end-to-end test and its runner.
const C = require('../src/cube');
const { renderFace, writeY4m } = require('../src/synth');

const SCAN_ORDER = ['F', 'R', 'B', 'L', 'U', 'D'];
/** The scrambled 3x3 the fake webcam shows (colours, standard scheme, white up / green front). */
const scanCube = (seed) => C.randomState3(seed).map((f) => C.STANDARD_SCHEME[f]);
const faceColours = (colours, n, face) => { const f = C.FACES.indexOf(face); return colours.slice(f * n * n, (f + 1) * n * n); };

/** A video that shows the six faces in scan order, each for 2 seconds, with a little light change per face, looped. */
function scanVideo(file, seed) {
  const colours = scanCube(seed);
  const lights = { F: [1, 1, 1], R: [1.08, 1, 0.86], B: [0.8, 0.8, 0.82], L: [1, 1, 1.04], U: [1.02, 1, 0.95], D: [0.88, 0.9, 0.9] };
  const W = 480; const H = 360; const side = H * 0.62;
  const quad = [[(W - side) / 2, (H - side) / 2], [(W + side) / 2, (H - side) / 2], [(W + side) / 2, (H + side) / 2], [(W - side) / 2, (H + side) / 2]];
  const frames = SCAN_ORDER.map((f, k) => ({ image: renderFace(faceColours(colours, 3, f), { width: W, height: H, quad, light: lights[f], noise: 3, glare: 0.25, seed: 50 + k }), repeat: 20 }));
  return writeY4m(file, frames, 10);
}
module.exports = { SCAN_ORDER, scanCube, faceColours, scanVideo };
