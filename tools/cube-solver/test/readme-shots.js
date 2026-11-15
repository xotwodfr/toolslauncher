'use strict';
// Makes the README screenshot: `node ../../node_modules/electron/cli.js . --e2e --readme-shots=<folder>`.
// The scramble is INVENTED (typed into the Turns box), solved by the real solver and shown part way through the solution.
const fs = require('fs');
const path = require('path');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SCRAMBLE = "F R' U2 L B' D2 R F' U L2 B2 D' R2 F U'";

exports.run = async ({ app, getWin, outDir }) => {
  const win = getWin();
  const wc = win.webContents;
  const js = (c) => wc.executeJavaScript(c, true);
  const waitFor = async (expr, ms = 60000) => { const end = Date.now() + ms; for (;;) { if (await js(expr)) return; if (Date.now() > end) throw new Error('timed out: ' + expr); await sleep(80); } };
  const center = (sel) => js(`(()=>{const e=document.querySelector(${JSON.stringify(sel)}); const b=e.getBoundingClientRect(); return {x:Math.round(b.x+b.width/2), y:Math.round(b.y+b.height/2)};})()`);
  const click = async (sel) => { const { x, y } = await center(sel); wc.sendInputEvent({ type: 'mouseMove', x, y }); wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 }); wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 }); await sleep(120); };
  let code = 1;
  try {
    win.setContentSize(1240, 840);
    await waitFor('!!(window.__app && window.__app.ready)');
    await waitFor('/Solver ready/.test(document.getElementById("engine").textContent)');
    await js(`document.getElementById("turnsText").value = ${JSON.stringify(SCRAMBLE)}`);
    await click('#applyTurns');
    await click('#solve');
    await waitFor('window.__app.player().total > 0');
    await click('#chips .mchip[data-k="6"]');
    await waitFor('!window.__app.player().animating');
    await js('document.getElementById("speed").value = "0.5"');
    await click('#pFwd'); // the eighth turn, caught half way
    await sleep(700);
    await js('document.activeElement && document.activeElement.blur(); document.getElementById("toast").hidden = true');
    await sleep(60);
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'cube-solver.png'), (await wc.capturePage()).toPNG());
    console.log('wrote', path.join(outDir, 'cube-solver.png'));
    code = 0;
  } catch (e) { console.error('screenshot failed:', e); }
  app.exit(code);
};
