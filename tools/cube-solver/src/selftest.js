'use strict';
// `--self-test=<result.json>`: proves a PACKAGED build works, for every puzzle it contains. Starts each puzzle's solver
// worker (so it proves the workers and the solvers load from the packaged app), solves random scrambles of every puzzle and
// checks every answer with the puzzle's own model, reads colours from invented face pictures of every puzzle, then checks
// the real window loaded (three.js, the map, the 3D view, every puzzle in the picker) and solves a cube in it.
const C = require('./cube');
const K = require('./colour');
const { renderFace, renderTemplate, printFor } = require('./synth');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const within = (p, ms, what) => Promise.race([p, sleep(ms).then(() => { throw new Error(what); })]);

async function run({ getWin, engine, puzzles }) {
  const results = [];
  const step = async (name, fn) => { try { results.push({ name, ok: true, detail: await fn() }); } catch (e) { results.push({ name, ok: false, error: String((e && e.message) || e) }); } };

  await step('the 3x3 solver worker starts and builds its tables', async () => {
    await within(engine.whenReady('cube3'), 60000, 'the 3x3 solver did not get ready within a minute');
    return `3x3 tables ${engine.status.puzzles.cube3.ms} ms`;
  });

  await step('3x3: ten random cubes are solved in at most 22 turns, each answer checked', async () => {
    let longest = 0;
    for (let i = 0; i < 10; i++) {
      const cols = C.randomState3(1000 + i).map((f) => C.STANDARD_SCHEME[f]);
      const r = await engine.solve('cube3', cols);
      if (!C.isSolved(3, C.applyMoves(3, cols, r.text))) throw new Error('not solved');
      if (r.moves.length > 22) throw new Error('too long: ' + r.moves.length);
      longest = Math.max(longest, r.moves.length);
    }
    return 'longest ' + longest;
  });

  for (const { id, def } of puzzles) {
    if (id === 'cube3') continue;
    const P = def.puzzle;
    await step(`${def.short}: the solver starts and random scrambles are solved, each answer checked`, async () => {
      const t0 = Date.now();
      await within(engine.whenReady(id), 120000, `the ${def.short} solver did not get ready within two minutes`);
      const ready = Date.now() - t0;
      let longest = 0; let slowest = 0;
      const n = id === 'cube2' ? 20 : 4;
      for (let i = 0; i < n; i++) {
        const st = P.applyMoves(P.solvedColours(), P.randomMoves(def.scrambleLength || 25, 2000 + i));
        if (P.isSolved(st)) continue;
        const r = await engine.solve(id, st);
        if (!P.isSolved(P.applyMoves(st, r.moves))) throw new Error('not solved');
        longest = Math.max(longest, r.moves.length); slowest = Math.max(slowest, r.ms);
      }
      return `ready in ${ready} ms (tables ${engine.status.puzzles[id].ms} ms), longest ${longest} turns, slowest ${slowest} ms`;
    });
  }

  await step('colours are read from invented face pictures (3x3: one face in warm light, one dim)', async () => {
    const faces = C.randomState3(77);
    const cols = faces.map((f) => C.STANDARD_SCHEME[f]);
    const lights = [[1, 1, 1], [1.16, 1, 0.7], [0.45, 0.45, 0.47], [1, 1, 1], [0.9, 0.95, 1.05], [1, 1, 1]];
    const samples = C.FACES.map((_, f) => { const img = renderFace(cols.slice(f * 9, f * 9 + 9), { light: lights[f], noise: 5, seed: f + 1 }); return K.sampleFace(img, img.quad, 3); });
    const got = K.classify3(samples, C.FACES.map((f) => C.STANDARD_SCHEME[f])).colours;
    const wrong = got.filter((c, i) => c !== cols[i]).length;
    if (wrong) throw new Error(wrong + ' stickers read wrong');
    return '54 of 54 right';
  });

  await step('colours are read from invented face pictures of every puzzle (its own face outlines)', async () => {
    const out = [];
    for (const { def } of puzzles) {
      const P = def.puzzle;
      const st = P.applyMoves(P.solvedColours(), P.randomMoves(def.scrambleLength || 25, 5));
      const order = def.scan.faces.map((f) => f.face);
      const faces = order.map((f, k) => {
        const t = P.templates[f];
        const img = renderTemplate(t, st, { width: 320, height: 240, print: printFor(P.colours), light: [[1, 1, 1], [1.05, 1, 0.9], [0.85, 0.85, 0.88]][k % 3], noise: 4, glare: 0.3, seed: 40 + k });
        return K.sampleTemplate(img, t, img.corners);
      });
      const flat = faces.flat();
      const moved = new Uint8Array(P.size);
      for (const t of Object.values(P.turns)) if (t.moving.length < P.size) for (const i of t.moving) moved[i] = 1;
      const solved = P.solvedColours(); const fixed = {};
      flat.forEach((s, k) => { if (!moved[s.i]) fixed[k] = solved[s.i]; });
      const counts = P.colourKeys.map((k) => solved.filter((c) => c === k).length);
      const r = K.classifyCounts(faces, { keys: P.colourKeys, counts, typical: K.typicalFor(P.colours), fixed, white: P.colourKeys.find((k) => String(P.colours[k].name).toLowerCase() === 'white') || null });
      const wrong = flat.filter((s, k) => r.colours[k] !== st[s.i]).length;
      if (wrong) throw new Error(`${def.short}: ${wrong} stickers read wrong`);
      out.push(`${def.short} ${P.size}/${P.size}`);
    }
    return out.join(', ');
  });

  await step('the window loads: map, 3D view, every puzzle in the picker, and a solve inside the window', async () => {
    const wc = getWin().webContents;
    const js = (code) => wc.executeJavaScript(code, true);
    const end = Date.now() + 20000;
    while (!(await js('!!(window.__app && window.__app.ready)'))) { if (Date.now() > end) throw new Error('the window did not start'); await sleep(100); }
    const ids = await js('window.__app.ids');
    if (ids.join() !== puzzles.map((p) => p.id).join()) throw new Error('the window offers ' + ids.join(', '));
    const shown = [];
    for (const { id, def } of puzzles) {
      await js(`document.querySelector('[data-puzzle="${id}"]').click()`);
      await sleep(150);
      const n = await js('document.querySelectorAll("#net .sticker").length');
      if (n !== def.puzzle.size) throw new Error(`${def.short}: the map has ${n} stickers`);
      shown.push(def.short);
    }
    await js('document.querySelector(\'[data-puzzle="cube3"]\').click()');
    await sleep(150);
    const three = await js('!!window.__app.readBack()');
    await js('document.getElementById("turnsText").value = "R U F2 L\' D B2"; document.getElementById("applyTurns").click(); document.getElementById("solve").click();');
    const end2 = Date.now() + 30000;
    while (!(await js('window.__app.player().total > 0'))) { if (Date.now() > end2) throw new Error('no solution shown: ' + (await js('document.getElementById("verdict").textContent'))); await sleep(100); }
    return `${shown.join(', ')} drawn; 3D view ${three ? 'working' : 'not available (no WebGL)'}; solution of ${await js('window.__app.player().total')} turns shown`;
  });
  return results;
}
module.exports = { run };
