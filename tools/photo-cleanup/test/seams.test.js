'use strict';
// Seam and haze test (plain Node, real models): `npm test` runs it after the unit tests.
// An invented park photo (sky gradient, tree line, pond, textured grass and a dog with a soft outline, see src/scene.js) goes
// through the same code as the window: remove the dog (core.runRemoval), then extend all four edges (core.runExtension), with
// LaMa in its worker thread. Then test/seams.js measures, against the picture's own natural statistics:
//   - removal: the step across the dog's outline in the result vs across a contour 40 px further out, and the fill's texture
//   - extension: the step across the photo's border vs across the same border 32 px inside the photo, steps between tiles,
//     and haze: contrast, saturation and brightness of the outer half of each new strip vs the photo band next to it.
// v0.1.0 failed this (dog silhouette still visible, ghosted / washed-out strips); see the limits below.
// SEAMS_OUT=<dir> also writes the pictures as PNG.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const C = require('../src/core');
const E = require('../src/engine');
const M = require('../src/meta');
const { parkScene } = require('../src/scene');
const Z = require('./seams');

const LIMITS = {
  // measured with v0.1.0's pixel code on this scene: removal 1.10 / 0.68, seam 1.90, tiles 7.6, haze 0.52 / 0.95 / -0.7
  // (per side: left 0.71, right 0.54, bottom 0.45 contrast; top 14 levels darker)
  removalRatio: 1.0,           // dog outline step / natural step
  removalTexture: [0.75, 1.5], // fill detail / photo detail
  seamRatio: 1.0,              // photo border step / natural step
  passSeam: 8,                 // P90 step between neighbouring tiles, levels
  contrast: 0.6,               // haze: outer strip contrast / photo band (median over all sides)
  sideContrast: 0.55,          // ... and on every side with texture
  saturation: 0.85,            // haze: saturation ratio
  lift: 10,                    // haze: brightness difference, levels (median), and 12 on any side
};

(async () => {
  if (E.missingModels().length) { console.log(' FAIL  seams: models missing, run "npm run setup"'); process.exit(1); }
  const W = 960; const H = 640; const scene = parkScene(W, H, 5);
  const margins = { l: 176, r: 176, t: 64, b: 96 };
  const runner = await E.createRunner('lama');
  const results = []; let failed = 0;
  const check = (name, ok, detail) => { results.push({ name, ok, detail }); if (!ok) failed++; console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}  [${detail}]`); };
  try {
    const fill = async (req) => (await runner.call({ type: 'fill', ...req })).rgba;
    // removal
    const rgba = new Uint8ClampedArray(scene.rgba); const grow = C.defaultGrow(W, H);
    let t0 = Date.now();
    const rem = await C.runRemoval(rgba, W, H, scene.mask, grow, fill);
    const tRemove = (Date.now() - t0) / 1000;
    assert.ok(rem.patches.length > 0);
    const unknown = C.dilate(scene.mask, W, H, grow);
    const r = Z.removalScore(rgba, W, H, scene.mask, unknown);
    check('removal: the dog\'s outline is not visible', r.ratio <= LIMITS.removalRatio, `outline step P90 ${r.p90.toFixed(1)} vs natural ${r.controlP90.toFixed(1)}, ratio ${r.ratio.toFixed(2)} <= ${LIMITS.removalRatio}`);
    check('removal: the fill has the texture of the grass around it', r.texture >= LIMITS.removalTexture[0] && r.texture <= LIMITS.removalTexture[1], `detail ratio ${r.texture.toFixed(2)}`);
    // extension
    t0 = Date.now();
    const ext = await Z.trackedExtension(rgba, W, H, margins, fill);
    const tExtend = (Date.now() - t0) / 1000;
    const { w: FW, h: FH, plan } = ext;
    const s = Z.extensionSeam(ext.rgba, FW, FH, plan.ox, plan.oy, W, H);
    check('extension: no seam at the photo\'s border', s.ratio <= LIMITS.seamRatio, `border step P90 ${s.p90.toFixed(1)} vs natural ${s.controlP90.toFixed(1)}, ratio ${s.ratio.toFixed(2)} <= ${LIMITS.seamRatio}`);
    const ps = Z.passSeams(ext.rgba, FW, FH, ext.labels);
    check('extension: no seams between tiles', ps.p90 <= LIMITS.passSeam, `P90 ${ps.p90.toFixed(1)} over ${ps.n} places`);
    const hz = Z.haze(ext.rgba, FW, FH, plan.ox, plan.oy, W, H);
    const sides = Object.entries(hz.sides).map(([k, v]) => `${k} ${v.contrast ? v.contrast.toFixed(2) : '-'}/${v.saturation.toFixed(2)}/${v.lift.toFixed(1)}`).join(', ');
    const sidesOk = Object.values(hz.sides).every((v) => (!v.contrast || v.contrast >= LIMITS.sideContrast) && Math.abs(v.lift) <= 12);
    check('extension: not washed out (contrast, saturation, brightness like the photo)', hz.contrast >= LIMITS.contrast && hz.saturation >= LIMITS.saturation && Math.abs(hz.lift) <= LIMITS.lift && sidesOk,
      `contrast ${hz.contrast.toFixed(2)} >= ${LIMITS.contrast}, saturation ${hz.saturation.toFixed(2)} >= ${LIMITS.saturation}, lift ${hz.lift.toFixed(1)}; per side c/s/lift: ${sides}`);
    console.log(`        removal ${tRemove.toFixed(1)} s, extension to ${FW} x ${FH} in ${plan.count} parts ${tExtend.toFixed(1)} s`);
    if (process.env.SEAMS_OUT) {
      fs.mkdirSync(process.env.SEAMS_OUT, { recursive: true });
      fs.writeFileSync(path.join(process.env.SEAMS_OUT, 'seams-removed.png'), await M.encodePng(rgba, W, H));
      fs.writeFileSync(path.join(process.env.SEAMS_OUT, 'seams-extended.png'), await M.encodePng(ext.rgba, FW, FH));
    }
  } catch (e) { failed++; console.log(' FAIL  seams\n        ' + ((e && e.stack) || e)); } finally { await runner.release(); }
  console.log(`\nseams: ${results.filter((x) => x.ok).length} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
