'use strict';
// End-to-end test: runs inside Electron (`npm run e2e`). Drives the REAL window with real mouse and keyboard input: fills in a
// scrambled cube by clicking, solves it, steps and plays through the solution and reads the colours back off the 3D scene;
// checks the messages for impossible cubes; solves a 2x2; scans a cube with a FAKE WEBCAM playing an invented video of known
// colours; reads a 2x2 from invented photos after dragging the grid onto each face; saves the solution. Then, for EVERY puzzle
// module present (and two small test puzzles of its own, a tetrahedron and a 2x2x1): picks it, scrambles it, solves it,
// steps to the end reading the 3D state back, gets a validation error for a broken state and reads it from invented photos;
// and scans a non-cube puzzle with the fake webcam.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { nativeImage } = require('electron');
const C = require('../src/cube');
const { renderFace } = require('../src/synth');
const K = require('../src/colour');
const { renderTemplate, printFor } = require('../src/synth');
const { SCAN_ORDER, scanCube, faceColours, allPuzzles, camPuzzle, scrambled } = require('./fixtures');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const KEYS = { w: '1', y: '2', g: '3', b: '4', r: '5', o: '6' };

exports.run = async ({ app, getWin, outFile, shotsDir, dialog, fakeVideo, fakeSeed }) => {
  const results = [];
  const errors = [];
  const notes = {};
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cubesolver-e2e-'));
  const win = getWin();
  const wc = win.webContents;
  const js = (code) => wc.executeJavaScript(code, true);
  wc.on('console-message', (_e, level, msg) => { if (level >= 3 && !/WebGL|GL Driver|swiftshader|GPU stall/i.test(msg)) errors.push(msg); });
  const step = async (name, fn) => {
    try { const detail = await fn(); results.push({ name, ok: true, detail: detail === undefined ? '' : detail }); console.log('ok   ' + name); }
    catch (e) { results.push({ name, ok: false, error: String((e && e.message) || e) }); console.log('FAIL ' + name + ': ' + ((e && e.message) || e)); }
  };
  const assert = (c, m) => { if (!c) throw new Error(m); };
  const eq = (a, b, what) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${what}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); };
  const waitFor = async (expr, ms = 8000, what = expr) => {
    const end = Date.now() + ms;
    for (;;) { const v = await js(expr); if (v) return v; if (Date.now() > end) throw new Error('timed out waiting for ' + what); await sleep(50); }
  };
  const shot = async (name) => {
    if (!shotsDir) return;
    fs.mkdirSync(shotsDir, { recursive: true });
    await sleep(300);
    fs.writeFileSync(path.join(shotsDir, name + '.png'), (await wc.capturePage()).toPNG());
  };
  const key = async (keyCode, modifiers = [], char = false) => {
    wc.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
    if (char) wc.sendInputEvent({ type: 'char', keyCode: char === true ? keyCode : char, modifiers });
    wc.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
    await sleep(40);
  };
  const center = (selector) => js(`(()=>{const e=document.querySelector(${JSON.stringify(selector)}); if(!e) return null; e.scrollIntoView({block:'nearest'}); const b=e.getBoundingClientRect(); return {x:Math.round(b.x+b.width/2), y:Math.round(b.y+b.height/2), w:b.width, h:b.height};})()`);
  const mouse = (type, x, y, extra = {}) => wc.sendInputEvent({ type, x, y, button: 'left', clickCount: 1, ...extra });
  const clickAt = async (x, y, wait = 60) => { mouse('mouseMove', x, y); mouse('mouseDown', x, y); mouse('mouseUp', x, y); await sleep(wait); };
  const click = async (selector, wait) => { const r = await center(selector); if (!r) throw new Error('nothing to click: ' + selector); await clickAt(r.x, r.y, wait); };
  const dragPath = async (points) => {
    mouse('mouseMove', points[0].x, points[0].y); mouse('mouseDown', points[0].x, points[0].y);
    for (const p of points.slice(1)) { for (let k = 1; k <= 4; k++) { await sleep(10); } wc.sendInputEvent({ type: 'mouseMove', x: p.x, y: p.y, button: 'left', modifiers: ['leftButtonDown'] }); await sleep(25); }
    const last = points[points.length - 1];
    mouse('mouseUp', last.x, last.y);
    await sleep(80);
  };
  const colours = () => js('window.__app.colours()');
  const text = (id) => js(`document.getElementById(${JSON.stringify(id)}).textContent`);
  const problems = () => js('[...document.querySelectorAll("#problemList li")].map((l) => l.textContent)');
  const sticker = (i) => `#net .sticker[data-i="${i}"]`;
  const clickSticker = async (i, wait = 15) => { const p = await js(`window.__app.cellPoint(${i})`); if (!p) throw new Error('no sticker ' + i); await clickAt(p.x, p.y, wait); };
  const pick = async (id) => {
    await click('#picker');
    await waitFor('!document.getElementById("pickList").hidden', 2000, 'the puzzle list');
    await click(`[data-puzzle="${id}"]`);
    await waitFor(`window.__app.S.id === ${JSON.stringify(id)} && document.getElementById("pickList").hidden`, 3000, 'puzzle ' + id);
  };
  const uniformFaces = (n, st) => C.isSolved(n, st);
  const waitIdle = () => waitFor('!window.__app.player().animating', 10000, 'the turn to finish');
  /** paints the whole net by real input: palette by number key, stickers by clicks */
  async function fillByClicking(target) {
    await click('#clear');
    const g = C.geometry(target.length === 54 ? 3 : 2);
    for (const c of C.COLOURS) {
      await key(KEYS[c], [], true);
      for (let i = 0; i < target.length; i++) if (target[i] === c && !g.centres.includes(i)) await clickSticker(i);
    }
  }
  async function solveAndWait() {
    await click('#solve');
    await waitFor('window.__app.player().total > 0 || /solved|can\'t|could not|not/.test(document.getElementById("verdict").textContent) && !/Solving|Waiting/.test(document.getElementById("verdict").textContent)', 30000, 'a solution');
  }

  try {
    win.setContentSize(1240, 840);
    await step('the window starts with a solved 3x3, the solver gets ready in the background, nothing blocks', async () => {
      await waitFor('!!(window.__app && window.__app.ready)');
      eq(await js('document.querySelectorAll("#net .sticker").length'), 54, 'stickers on the net');
      // the window answers while the solver is still building its tables
      const t0 = Date.now(); await js('1'); assert(Date.now() - t0 < 500, 'window responsive');
      await waitFor('/Solver ready/.test(document.getElementById("engine").textContent)', 30000, 'solver ready');
      const back = await js('window.__app.readBack()');
      assert(back, '3D view readable (WebGL)');
      eq(back, C.solvedColours(3), '3D view shows a solved cube');
      await shot('1-start');
    });

    await step('Solve on a solved cube says it is already solved', async () => {
      await click('#solve');
      await waitFor('/already solved/.test(document.getElementById("verdict").textContent)', 3000, 'already solved');
    });

    await step('drag-painting and the keyboard (number keys, arrows, Enter) paint stickers', async () => {
      await click('#net .sticker[data-i="0"]'); // focus the net with white painted on white (no change)
      await key('5', [], true); // red
      const a = await js('window.__app.cellPoint(0)'); const b = await js('window.__app.cellPoint(1)'); const c = await js('window.__app.cellPoint(2)');
      await dragPath([a, b, c]);
      const after = await colours();
      eq([after[0], after[1], after[2]], ['r', 'r', 'r'], 'top row dragged red');
      eq(await js('window.__app.S.cursor'), 2, 'cursor follows the drag');
      await key('2', [], true); // yellow
      await key('Left'); await key('Left'); await key('Down'); await key('Down'); // cursor 2 -> 1 -> 0 -> 3 -> 6
      await key('Return');
      await key('Right'); await key('Right'); // 7 -> 8
      await key('Space');
      await key('Right'); // nothing to the right of the top face: the cursor stays
      const k = await colours();
      eq([k[6], k[8]], ['y', 'y'], 'keyboard painted stickers 6 and 8');
      eq(await js('window.__app.S.cursor'), 8, 'cursor');
      eq(await js('window.__app.S.paint'), 'y', 'palette by key');
      eq(await js('window.__app.readBack()'), await colours(), 'the live 3D view follows the net');
    });

    // ---- a scramble filled in by clicking ----
    const scramble = C.parseMoves("R U2 F' L D2 B R' U F2 D' L2 B' U R2 F");
    const target = C.applyMoves(3, C.solvedColours(3), scramble);
    let moves = [];
    await step('a scrambled 3x3 is filled in by clicking, and the 3D view shows exactly that', async () => {
      await fillByClicking(target);
      eq(await colours(), target, 'net');
      await sleep(100);
      eq(await js('window.__app.readBack()'), target, '3D view');
      assert(/^$/.test(await text('netInfo')), 'nothing left to fill in');
      await shot('2-filled');
    });

    await step('Solve finds a verified solution of at most 22 turns, shown as move chips', async () => {
      await solveAndWait();
      const p = await js('window.__app.player()');
      moves = p.moves;
      assert(p.total > 0 && p.total <= 22, 'length ' + p.total);
      assert(C.isSolved(3, C.applyMoves(3, target, moves)), 'the moves solve the cube');
      eq(await js('document.querySelectorAll("#chips .mchip").length'), p.total, 'chips');
      assert(new RegExp(`Solved in ${p.total} turns`).test(await text('verdict')), 'verdict: ' + await text('verdict'));
      eq(await js('window.__app.readBack()'), target, 'the player starts at the scrambled cube');
      notes.solution = moves.join(' ');
      return `${p.total} turns: ${moves.join(' ')}`;
    });

    await step('step forward / back animate one turn each; chip and 3D cube stay in sync', async () => {
      await js('document.getElementById("speed").value = "3"; document.getElementById("speed").dispatchEvent(new Event("input"))');
      for (let k = 1; k <= 3; k++) {
        await click('#pFwd'); await sleep(30); await waitIdle();
        eq((await js('window.__app.player()')).pos, k, 'position');
        eq(await js('window.__app.readBack()'), C.applyMoves(3, target, moves.slice(0, k)), '3D cube after ' + k + ' turns');
        eq(await js('document.querySelector("#chips .mchip.now").dataset.k'), String(k - 1), 'highlighted chip');
      }
      await click('#pBack'); await sleep(30); await waitIdle();
      eq((await js('window.__app.player()')).pos, 2, 'back one');
      eq(await js('window.__app.readBack()'), C.applyMoves(3, target, moves.slice(0, 2)), '3D cube after stepping back');
      assert(/Turn 2 of/.test(await text('pCount')), 'counter');
    });

    await step('clicking a chip jumps there; Play runs to the end and the 3D cube ends solved', async () => {
      await click(`#chips .mchip[data-k="${Math.min(5, moves.length - 1)}"]`);
      await waitIdle();
      eq((await js('window.__app.player()')).pos, Math.min(6, moves.length), 'jumped');
      eq(await js('window.__app.readBack()'), C.applyMoves(3, target, moves.slice(0, Math.min(6, moves.length))), '3D after the jump');
      await click('#pPlay');
      await waitFor('window.__app.player().pos === window.__app.player().total && !window.__app.player().playing && !window.__app.player().animating', 40000, 'the end');
      const back = await js('window.__app.readBack()');
      assert(uniformFaces(3, back), 'every face of the 3D cube is one colour');
      eq(back, C.solvedColours(3), 'solved with white on top and green in front');
      assert(/solved/.test(await text('pCount')), 'counter says solved');
      await shot('3-played');
      await click('#pStart'); await waitIdle();
      eq(await js('window.__app.readBack()'), target, 'back at the start');
      await click('#pEnd'); await waitIdle();
      eq(await js('window.__app.readBack()'), C.solvedColours(3), 'go to end');
    });

    await step('Free view: dragging the 3D cube turns the view; From the front puts it back', async () => {
      const v = await center('#view3d');
      await dragPath([{ x: v.x, y: v.y }, { x: v.x + 60, y: v.y + 10 }, { x: v.x + 120, y: v.y + 20 }]);
      eq(await js('document.querySelector("[data-view=free]").getAttribute("aria-checked")'), 'true', 'switched to free');
      await click('[data-view="front"]');
      eq(await js('document.querySelector("[data-view=front]").getAttribute("aria-checked")'), 'true', 'front again');
      eq(await js('window.__app.readBack()'), C.solvedColours(3), 'the view angle never changes the cube');
    });

    await step('Save… writes the solution to a text file (the dialog is answered by the test)', async () => {
      const file = path.join(dir, 'my solution.txt');
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: file });
      await click('#save');
      await waitFor('/Saved to/.test(document.getElementById("toast").textContent)', 5000, 'saved');
      const body = fs.readFileSync(file, 'utf8');
      assert(body.includes(moves.join(' ')), 'moves in the file');
      assert(!fs.existsSync(file + '.part'), 'no part file left');
    });

    // ---- impossible cubes ----
    const solved = C.solvedColours(3);
    const g3 = C.geometry(3);
    async function paintThese(changes) {
      await click('#reset');
      for (const [i, c] of changes) { await key(KEYS[c], [], true); await clickSticker(i); }
      await click('#solve');
      await waitFor('document.getElementById("problems").hidden === false || /solved/.test(document.getElementById("verdict").textContent)', 4000, 'a verdict');
      return problems();
    }
    await step('a twisted corner is explained in plain words', async () => {
      const [a, b, c] = g3.cornerFacelets[0];
      const p = await paintThese([[a, solved[b]], [b, solved[c]], [c, solved[a]]]);
      assert(p.length === 1 && /corner is twisted/.test(p[0]), JSON.stringify(p));
      assert(/can't be solved/.test(await text('verdict')), 'verdict');
    });
    await step('a flipped edge and two swapped pieces are explained', async () => {
      const [a, b] = g3.edgeFacelets[1];
      let p = await paintThese([[a, solved[b]], [b, solved[a]]]);
      assert(p.length === 1 && /edge is flipped/.test(p[0]), JSON.stringify(p));
      const e1 = g3.edgeFacelets[0]; const e2 = g3.edgeFacelets[1];
      p = await paintThese([[e1[0], solved[e2[0]]], [e1[1], solved[e2[1]]], [e2[0], solved[e1[0]]], [e2[1], solved[e1[1]]]]);
      assert(p.length === 1 && /Two pieces are swapped/.test(p[0]), JSON.stringify(p));
    });
    await step('wrong colour counts and a corner with two whites are named, and the corner is marked on the net', async () => {
      const a = g3.cornerFacelets[0][1]; // the top-front-right corner's red sticker painted white
      const p = await paintThese([[a, 'w']]);
      assert(p.some((t) => /10 white and 8 red stickers/.test(t)), 'counts: ' + JSON.stringify(p));
      assert(p.some((t) => /top-front-right corner has two white stickers/.test(t)), 'piece: ' + JSON.stringify(p));
      const marked = await js('[...document.querySelectorAll("#net .sticker.bad")].map((b) => Number(b.dataset.i)).sort((x, y) => x - y)');
      assert(g3.cornerFacelets[0].every((i) => marked.includes(i)), 'the corner is marked: ' + JSON.stringify(marked));
      await shot('4-invalid');
      await key('5', [], true); await clickSticker(a); // editing (red again) clears the marks
      await waitFor('document.querySelectorAll("#net .sticker.bad").length === 0', 2000, 'marks cleared');
    });

    // ---- 2x2 ----
    await step('2x2: a random scramble is solved optimally and plays to a solved cube', async () => {
      await pick('cube2');
      eq(await js('document.querySelectorAll("#net .sticker").length'), 24, '2x2 net');
      await click('#random');
      const start = await colours();
      await solveAndWait();
      const p = await js('window.__app.player()');
      assert(p.total >= 1 && p.total <= 11, '2x2 length ' + p.total);
      const S2 = require('../src/solver2');
      const v = C.validate(2, start);
      eq(p.total, S2.distance(v.faces), 'the fewest turns possible (from the distance table)');
      assert(/fewest possible/.test(await text('verdict')), 'verdict');
      await click('#pEnd'); await waitIdle();
      assert(uniformFaces(2, await js('window.__app.readBack()')), '3D 2x2 solved');
      return `${p.total} turns`;
    });

    await step('2x2: the photos flow reads six invented photos after the grid is dragged onto each face', async () => {
      const cube2 = C.applyMoves(2, C.solvedColours(2), C.parseMoves("R U' F2 R' U2 F R2 U'"));
      const files = [];
      const lights = { F: [1, 1, 1], R: [1.15, 1, 0.72], B: [0.5, 0.5, 0.52], L: [1, 1, 1], U: [0.95, 1, 1.08], D: [1, 1, 1] };
      SCAN_ORDER.forEach((f, k) => {
        const W = 400; const H = 300;
        const quad = [[90 + 6 * k, 50 + 3 * k], [300 - 4 * k, 62], [292 + 2 * k, 262 - k], [96, 250 + 2 * k]]; // each photo at a slight angle
        const img = renderFace(faceColours(cube2, 2, f), { width: W, height: H, quad, light: lights[f], noise: 5, glare: 0.4, seed: 900 + k });
        const bgra = Buffer.alloc(W * H * 4);
        for (let i = 0; i < W * H; i++) { bgra[i * 4] = img.data[i * 4 + 2]; bgra[i * 4 + 1] = img.data[i * 4 + 1]; bgra[i * 4 + 2] = img.data[i * 4]; bgra[i * 4 + 3] = 255; }
        const file = path.join(dir, `face ${k + 1} ${f}.png`);
        fs.writeFileSync(file, nativeImage.createFromBitmap(bgra, { width: W, height: H }).toPNG());
        files.push({ file, quad });
      });
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: files.map((x) => x.file) });
      await click('#t-photos');
      await click('#photosPick');
      await waitFor('window.__app.photos.D && !document.getElementById("photosRead").disabled', 8000, 'six photos loaded');
      // drag every corner of every grid onto the face's real corner, with the mouse
      for (let k = 0; k < 6; k++) {
        const f = SCAN_ORDER[k];
        await js(`document.querySelector('.pslot[data-face="${f}"]').scrollIntoView({block:'nearest'})`);
        for (let c = 0; c < 4; c++) {
          const from = await js(`(() => { const q = window.__app.photos.${f}.corners[${c}]; return window.__app.photoPoint('${f}', q[0], q[1]); })()`);
          const to = await js(`window.__app.photoPoint('${f}', ${files[k].quad[c][0]}, ${files[k].quad[c][1]})`);
          await dragPath([from, { x: Math.round((from.x + to.x) / 2), y: Math.round((from.y + to.y) / 2) }, to]);
        }
        const q = await js(`window.__app.photos.${f}.corners`);
        q.forEach((pt, c) => assert(Math.hypot(pt[0] - files[k].quad[c][0], pt[1] - files[k].quad[c][1]) < 6, `grid corner ${c} of photo ${k + 1} landed at ${pt}`));
      }
      await shot('5-photos');
      await click('#photosRead');
      await waitFor('!document.getElementById("tab-fill").hidden', 4000, 'back on the net');
      eq(await colours(), cube2, 'colours read from the photos');
      await solveAndWait();
      assert((await js('window.__app.player()')).total > 0, 'solved after reading');
    });

    // ---- webcam with the fake camera ----
    await step('3x3 webcam scan: the fake camera shows the six faces; each face is read live, captured with Space, and lands in the net', async () => {
      assert(fakeVideo && fs.existsSync(fakeVideo), 'the fake video exists');
      const cube = scanCube(fakeSeed);
      await pick('cube3');
      await click('#t-camera');
      await click('#camStart');
      await waitFor('!!(window.__app.cam.stream && window.__app.cam.live)', 15000, 'live camera reading');
      notes.camera = await js('(() => { const t = window.__app.cam.stream.getVideoTracks()[0]; const s = t.getSettings(); return t.label + " " + s.width + "x" + s.height; })()');
      for (let k = 0; k < 6; k++) {
        const f = SCAN_ORDER[k];
        const want = faceColours(cube, 3, f);
        assert(new RegExp(C.COLOUR_NAME[C.STANDARD_SCHEME[f]] + '-centred').test(await text('camSay')), 'instruction for ' + f + ': ' + await text('camSay'));
        await waitFor(`JSON.stringify(window.__app.cam.live && window.__app.cam.live.guess) === ${JSON.stringify(JSON.stringify(want))}`, 30000, `the camera to show the ${f} face`);
        if (k === 2) await shot('6-camera');
        await js('document.activeElement && document.activeElement.blur()');
        await key('Space');
        if (k < 5) {
          await waitFor(`!!window.__app.cam.captured.${f}`, 2000, 'captured ' + f);
          eq(await js(`window.__app.cam.captured.${f}.guess`), want, 'captured ' + f);
        }
      }
      await waitFor('!document.getElementById("tab-fill").hidden', 4000, 'back on the net after the sixth face');
      eq(await js('!!window.__app.cam.stream'), false, 'camera stopped');
      eq(await colours(), cube, 'the scanned cube');
      await solveAndWait();
      const p = await js('window.__app.player()');
      assert(p.total > 0 && C.isSolved(3, C.applyMoves(3, cube, p.moves)), 'scanned cube solved');
      return `camera: ${notes.camera}`;
    });

    // ---- every puzzle module present ----
    const savePng = (file, img) => {
      const bgra = Buffer.alloc(img.width * img.height * 4);
      for (let i = 0; i < img.width * img.height; i++) { bgra[i * 4] = img.data[i * 4 + 2]; bgra[i * 4 + 1] = img.data[i * 4 + 1]; bgra[i * 4 + 2] = img.data[i * 4]; bgra[i * 4 + 3] = 255; }
      fs.writeFileSync(file, nativeImage.createFromBitmap(bgra, { width: img.width, height: img.height }).toPNG());
    };
    const inWindow = await js('window.__app.ids');
    const present = allPuzzles().filter((p) => inWindow.includes(p.id));
    notes.puzzles = present.map((p) => p.id).join(' ');
    await step(`every puzzle module present is offered in the picker, grouped (${present.map((p) => p.def.short).join(', ')})`, async () => {
      eq(inWindow, present.map((p) => p.id), 'puzzles in the window');
      const heads = await js('[...document.querySelectorAll("#pickList .pickhead")].map((h) => h.textContent)');
      assert(heads[0] === 'Cubes', 'groups: ' + JSON.stringify(heads));
      if (present.some((p) => p.group === 'Other puzzles')) assert(heads.includes('Other puzzles'), 'groups: ' + JSON.stringify(heads));
      return heads.join(' / ');
    });
    for (const { id, def } of present) {
      const P = def.puzzle;
      const name = def.short;
      let start = null;
      await step(`${name}: picked, Random, Solve, step and jump to the end; the 3D view reads back solved`, async () => {
        await pick(id);
        await click('#reset');
        eq(await js('document.querySelectorAll("#net .sticker").length'), P.size, 'stickers on the map');
        eq(await js('window.__app.readBack()'), P.solvedColours(), '3D view of the solved puzzle');
        await waitFor('/Solver ready/.test(document.getElementById("engine").textContent)', 120000, 'the ' + name + ' solver');
        await click('#random');
        start = await colours();
        assert(!P.isSolved(start), 'scrambled');
        eq(await js('window.__app.readBack()'), start, '3D view of the scramble');
        await click('#solve');
        await waitFor('window.__app.player().total > 0 || /can.t|could not|not shown|stopped|took too long/.test(document.getElementById("verdict").textContent)', 90000, 'a solution');
        const p = await js('window.__app.player()');
        assert(p.total > 0, 'no solution: ' + await text('verdict'));
        const moves = P.parseMoves(p.moves.join(' '));
        assert(P.isSolved(P.applyMoves(start, moves)), 'the moves solve it');
        if (p.stages.length > 1) {
          eq(await js('document.querySelectorAll("#chips .stagehead").length'), p.stages.length, 'stage titles in the move list');
          assert(/^Stage 1 of/.test(await text('pStage')), 'current stage shown: ' + await text('pStage'));
        }
        await js('document.getElementById("speed").value = "3"; document.getElementById("speed").dispatchEvent(new Event("input"))');
        for (let k = 1; k <= Math.min(2, p.total); k++) {
          await click('#pFwd'); await sleep(30); await waitIdle();
          eq(await js('window.__app.readBack()'), P.applyMoves(start, moves.slice(0, k)), `3D view after ${k} turns`);
        }
        await click('#pEnd'); await waitIdle();
        const back = await js('window.__app.readBack()');
        assert(P.isSolved(back), 'the 3D view ends solved');
        await click('#pBack'); await sleep(30); await waitIdle();
        eq(await js('window.__app.readBack()'), P.applyMoves(start, moves.slice(0, p.total - 1)), '3D view one turn back from the end');
        await shot('p-' + id);
        return `${p.total} turns in ${p.stages.length} ${p.stages.length === 1 ? 'stage' : 'stages'}: ${p.stages.map((s) => s.title).join(' / ')}`;
      });
      await step(`${name}: a broken state is refused with a plain-words problem`, async () => {
        await click('#reset');
        const solvedNow = await colours();
        const fx = new Set(def.fixedStickers || []);
        const i = P.stickers.find((s) => !fx.has(s.i)).i;
        const other = P.colourKeys.find((c) => c !== solvedNow[i]);
        const keyOf = await js(`(() => { const b = document.querySelector('.swatch[data-colour="${other}"] kbd'); return b && b.textContent.toLowerCase(); })()`);
        await js('document.activeElement && document.activeElement.blur()');
        await key(keyOf, [], true);
        eq(await js('window.__app.S.paint'), other, 'colour picked with its key');
        await clickSticker(i);
        eq((await colours())[i], other, 'painted');
        await click('#solve');
        await waitFor('document.getElementById("problems").hidden === false', 4000, 'the problems');
        const p = await problems();
        assert(p.length >= 1 && p.every((t) => t.length > 10), JSON.stringify(p));
        assert(/can't be solved/.test(await text('verdict')), 'verdict');
        await click('#reset');
        return p[0];
      });
      await step(`${name}: read from invented photos, one per face, after dragging each outline onto its face`, async () => {
        const state = scrambled(def, 31);
        const order = def.scan.faces.map((f) => f.face);
        const files = [];
        order.forEach((f, k) => {
          const Wd = 400; const Hd = 300; const t = P.templates[f];
          // where the face is in the photo: the outline placed off-centre, then tilted a little (a perspective / affine map)
          const base = K.placeOutline(t, 190 + 6 * (k % 3), 150 - 4 * (k % 2), 200);
          const n = base.length;
          const warp = n === 3 ? K.fitMap([[0, 0], [1, 0], [0, 1]], [[0, 0], [1.04, 0.05], [-0.03, 0.97]]) : K.fitMap([[0, 0], [1, 0], [1, 1], [0, 1]], [[0, 0], [1, 0.03], [0.97, 1.02], [0.02, 0.96]]);
          const corners = base.map(([x, y]) => { const q = K.mapPoint(warp, [(x - 100) / 200, (y - 50) / 200]); return [100 + q[0] * 200, 50 + q[1] * 200]; });
          const light = def.scan.experimental ? [[1, 1, 1], [1.03, 1, 0.95], [0.92, 0.92, 0.94]][k % 3] : [[1, 1, 1], [1.12, 1, 0.76], [0.55, 0.55, 0.57], [0.95, 1, 1.08]][k % 4];
          const img = renderTemplate(t, state, { width: Wd, height: Hd, corners, print: printFor(P.colours), light, noise: 4, glare: 0.3, seed: 300 + k });
          const file = path.join(dir, `${id} face ${k + 1}.png`);
          savePng(file, img);
          files.push({ file, corners });
        });
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: files.map((x) => x.file) });
        await click('#t-photos');
        assert(/Experimental/.test(await text('photosExp')) && (await js('!document.getElementById("photosExp").hidden')) === !!def.scan.experimental, 'experimental badge');
        await click('#photosPick');
        await waitFor('!document.getElementById("photosRead").disabled', 10000, 'all photos loaded');
        for (let k = 0; k < order.length; k++) {
          const f = order[k];
          await js(`document.querySelector('.pslot[data-face="${f}"]').scrollIntoView({block:'nearest'})`);
          for (let c = 0; c < files[k].corners.length; c++) {
            const from = await js(`(() => { const q = window.__app.photos[${JSON.stringify(f)}].corners[${c}]; return window.__app.photoPoint(${JSON.stringify(f)}, q[0], q[1]); })()`);
            const to = await js(`window.__app.photoPoint(${JSON.stringify(f)}, ${files[k].corners[c][0]}, ${files[k].corners[c][1]})`);
            await dragPath([from, { x: Math.round((from.x + to.x) / 2), y: Math.round((from.y + to.y) / 2) }, to]);
          }
          const q = await js(`window.__app.photos[${JSON.stringify(f)}].corners`);
          q.forEach((pt, c) => assert(Math.hypot(pt[0] - files[k].corners[c][0], pt[1] - files[k].corners[c][1]) < 8, `outline corner ${c} of photo ${k + 1} landed at ${pt}`));
        }
        await shot('photos-' + id);
        await click('#photosRead');
        await waitFor('!document.getElementById("tab-fill").hidden', 4000, 'back on the map');
        const got = await colours();
        const wrong = got.map((c, i) => i).filter((i) => got[i] !== state[i]);
        assert(!wrong.length, `${wrong.length} stickers read wrong: ${wrong.slice(0, 8).join(', ')}`);
        return `${order.length} photos, ${P.size} stickers read right`;
      });
    }

    const camDef = camPuzzle();
    await step(`${camDef.short} webcam scan: the outline is a ${K.outlineCorners(camDef.puzzle.templates[camDef.scan.faces[0].face]).length}-cornered shape; each face is read live and captured`, async () => {
      const P = camDef.puzzle;
      const want = scrambled(camDef, fakeSeed);
      await pick(camDef.id);
      await click('#t-camera');
      await click('#camStart');
      await waitFor('!!(window.__app.cam.stream && window.__app.cam.live)', 15000, 'live camera reading');
      const order = camDef.scan.faces;
      for (let k = 0; k < order.length; k++) {
        const f = order[k].face;
        assert((await text('camSay')) === order[k].say, 'instruction for ' + f + ': ' + await text('camSay'));
        const expect = P.templates[f].stickers.map((s) => want[s.i]);
        await waitFor(`!!window.__app.cam.live && window.__app.cam.live.face === ${JSON.stringify(f)} && JSON.stringify(window.__app.cam.live.guess) === ${JSON.stringify(JSON.stringify(expect))}`, 30000, `the camera to show the ${f} face`);
        if (k === 1) await shot('camera-' + camDef.id);
        await js('document.activeElement && document.activeElement.blur()');
        await key('Space');
        if (k < order.length - 1) await waitFor(`!!window.__app.cam.captured[${JSON.stringify(f)}]`, 2000, 'captured ' + f);
      }
      await waitFor('!document.getElementById("tab-fill").hidden', 4000, 'back on the map after the last face');
      eq(await colours(), want, 'the scanned puzzle');
      await solveAndWait();
      const p = await js('window.__app.player()');
      assert(p.total > 0 && P.isSolved(P.applyMoves(want, p.moves.join(' '))), 'scanned puzzle solved');
      return `${order.length} faces`;
    });

    await step('no errors in the window console', async () => { eq(errors, [], 'console errors'); });
  } finally {
    const ok = results.every((r) => r.ok);
    try { fs.writeFileSync(outFile, JSON.stringify({ ok, results, notes }, null, 2)); } catch (e) { console.log('could not write the report', e); }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    app.exit(ok ? 0 : 1);
  }
};
