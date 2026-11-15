'use strict';
// `--self-test=<result.json>`: proves a PACKAGED build works. Starts the solver worker (so it proves the worker and the
// vendored solver load from the packaged app), solves random 3x3 and 2x2 cubes and checks every answer with our own model,
// reads colours from invented face pictures, then checks the real window loaded (three.js, the net, the 3D view) and solves
// a cube in it.
const C = require('./cube');
const K = require('./colour');
const { renderFace } = require('./synth');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function run({ getWin, engine }) {
  const results = [];
  const step = async (name, fn) => { try { results.push({ name, ok: true, detail: await fn() }); } catch (e) { results.push({ name, ok: false, error: String((e && e.message) || e) }); } };

  await step('the solver worker starts and builds its tables', async () => {
    await Promise.race([engine.whenReady(3), sleep(60000).then(() => { throw new Error('the solver did not get ready within a minute'); })]);
    return `2x2 table ${engine.status.ms2} ms, 3x3 tables ${engine.status.ms3} ms`;
  });

  await step('3x3: ten random cubes are solved in at most 22 turns, each answer checked', async () => {
    let longest = 0;
    for (let i = 0; i < 10; i++) {
      const faces = C.randomState3(1000 + i);
      const r = await engine.solve(3, faces);
      if (!C.isSolved(3, C.applyMoves(3, faces, r.moves))) throw new Error('not solved');
      if (r.moves.length > 22) throw new Error('too long: ' + r.moves.length);
      longest = Math.max(longest, r.moves.length);
    }
    return 'longest ' + longest;
  });

  await step('2x2: random cubes are solved optimally (at most 11 turns)', async () => {
    let longest = 0;
    for (let i = 0; i < 20; i++) {
      const faces = C.randomState2(2000 + i);
      const r = await engine.solve(2, faces);
      if (!C.isSolved(2, C.applyMoves(2, faces, r.moves)) || r.moves.length > 11) throw new Error('bad 2x2 answer');
      longest = Math.max(longest, r.moves.length);
    }
    return 'longest ' + longest;
  });

  await step('colours are read from invented face pictures (one face in warm light, one dim)', async () => {
    const faces = C.randomState3(77);
    const cols = faces.map((f) => C.STANDARD_SCHEME[f]);
    const lights = [[1, 1, 1], [1.16, 1, 0.7], [0.45, 0.45, 0.47], [1, 1, 1], [0.9, 0.95, 1.05], [1, 1, 1]];
    const samples = C.FACES.map((_, f) => { const img = renderFace(cols.slice(f * 9, f * 9 + 9), { light: lights[f], noise: 5, seed: f + 1 }); return K.sampleFace(img, img.quad, 3); });
    const got = K.classify3(samples, C.FACES.map((f) => C.STANDARD_SCHEME[f])).colours;
    const wrong = got.filter((c, i) => c !== cols[i]).length;
    if (wrong) throw new Error(wrong + ' stickers read wrong');
    return '54 of 54 right';
  });

  await step('the window loads: net, 3D view and a solve inside the window', async () => {
    const wc = getWin().webContents;
    const js = (code) => wc.executeJavaScript(code, true);
    const end = Date.now() + 20000;
    while (!(await js('!!(window.__app && window.__app.ready)'))) { if (Date.now() > end) throw new Error('the window did not start'); await sleep(100); }
    const stickers = await js('document.querySelectorAll("#net .sticker").length');
    if (stickers !== 54) throw new Error('net has ' + stickers + ' stickers');
    const three = await js('!!window.__app.readBack()');
    await js('document.getElementById("turnsText").value = "R U F2 L\' D B2"; document.getElementById("applyTurns").click(); document.getElementById("solve").click();');
    const end2 = Date.now() + 30000;
    while (!(await js('window.__app.player().total > 0'))) { if (Date.now() > end2) throw new Error('no solution shown: ' + (await js('document.getElementById("verdict").textContent'))); await sleep(100); }
    return `${stickers} stickers, 3D view ${three ? 'working' : 'not available (no WebGL)'}, solution of ${await js('window.__app.player().total')} turns shown`;
  });
  return results;
}
module.exports = { run };
