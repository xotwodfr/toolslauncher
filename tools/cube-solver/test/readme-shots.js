'use strict';
// Makes the README screenshots: `node ../../node_modules/electron/cli.js . --e2e --readme-shots=<folder>`.
// cube-solver.png (the 3x3, as before) and one picture per puzzle type (cube-solver-<id>.png). Every scramble is INVENTED
// (typed into the Turns box or made with Random), solved by the real solver and shown part way through the solution.
const fs = require('fs');
const path = require('path');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SCRAMBLE = "F R' U2 L B' D2 R F' U L2 B2 D' R2 F U'";

exports.run = async ({ app, getWin, outDir }) => {
  const win = getWin();
  const wc = win.webContents;
  const js = (c) => wc.executeJavaScript(c, true);
  wc.on('console-message', (_e, level, msg) => { if (level >= 2 && !/WebGL|GL Driver|swiftshader|GPU stall/i.test(msg)) console.log('window:', msg); });
  const waitFor = async (expr, ms = 60000) => { const end = Date.now() + ms; for (;;) { if (await js(expr)) return; if (Date.now() > end) throw new Error('timed out: ' + expr); await sleep(80); } };
  const center = (sel) => js(`(()=>{const e=document.querySelector(${JSON.stringify(sel)}); e.scrollIntoView({block:'nearest'}); const b=e.getBoundingClientRect(); return {x:Math.round(b.x+b.width/2), y:Math.round(b.y+b.height/2)};})()`);
  const click = async (sel) => { const { x, y } = await center(sel); wc.sendInputEvent({ type: 'mouseMove', x, y }); wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 }); wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 }); await sleep(120); };
  const pick = async (id) => { await click('#picker'); await click(`[data-puzzle="${id}"]`); await waitFor(`window.__app.S.id === ${JSON.stringify(id)}`); };
  const snap = async (name) => {
    await js('document.activeElement && document.activeElement.blur(); document.getElementById("toast").hidden = true');
    await sleep(250);
    await js('document.getElementById("toast").hidden = true');
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, name), (await wc.capturePage()).toPNG());
    console.log('wrote', path.join(outDir, name));
  };
  /** Solve what is shown, jump some way in and catch the next turn half way. */
  const solveAndCatch = async (at) => {
    await click('#solve');
    await waitFor('window.__app.player().total > 0', 90000);
    const total = await js('window.__app.player().total');
    const k = Math.max(0, Math.min(total - 2, at(total)));
    if (k > 0) { await click(`#chips .mchip[data-k="${k - 1}"]`); await waitFor('!window.__app.player().animating'); }
    await js('document.getElementById("speed").value = "0.5"');
    await click('#pFwd');
    await sleep(700);
  };
  let code = 1;
  try {
    win.setContentSize(1240, 840);
    await waitFor('!!(window.__app && window.__app.ready)');
    await pick('cube3');
    await waitFor('/Solver ready/.test(document.getElementById("engine").textContent)');
    await js(`document.getElementById("turnsText").value = ${JSON.stringify(SCRAMBLE)}`);
    await click('#applyTurns');
    await solveAndCatch(() => 7);
    await snap('cube-solver.png');
    for (const id of await js('window.__app.ids')) {
      if (id === 'cube3') continue;
      await pick(id);
      await waitFor('/Solver ready/.test(document.getElementById("engine").textContent)', 120000);
      await click('#random');
      await solveAndCatch((n) => Math.round(n * 0.4));
      await snap(`cube-solver-${id}.png`);
    }
    code = 0;
  } catch (e) { console.error('screenshot failed:', e); }
  app.exit(code);
};
