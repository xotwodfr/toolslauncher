'use strict';
// Makes the README screenshot: `node ../../node_modules/electron/cli.js . --e2e --readme-shots=<folder>`.
// The picture is INVENTED (src/scene.js), cut out by the real model, so the screenshot shows a real result without anyone's photo.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { nativeImage } = require('electron');
const { drawScene } = require('../src/scene');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

exports.run = async ({ app, getWin, outDir, dialog }) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bgremover-shots-'));
  const win = getWin();
  const wc = win.webContents;
  const js = (c) => wc.executeJavaScript(c, true);
  const waitFor = async (expr, ms = 120000) => { const end = Date.now() + ms; for (;;) { if (await js(expr)) return; if (Date.now() > end) throw new Error('timed out: ' + expr); await sleep(100); } };
  const center = (sel) => js(`(()=>{const e=document.querySelector(${JSON.stringify(sel)}); const b=e.getBoundingClientRect(); return {x:Math.round(b.x+b.width/2), y:Math.round(b.y+b.height/2)};})()`);
  const click = async (sel) => { const { x, y } = await center(sel); wc.sendInputEvent({ type: 'mouseMove', x, y }); wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 }); wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 }); await sleep(150); };
  let code = 1;
  try {
    win.setContentSize(1280, 820);
    const W = 960; const H = 720;
    const sc = drawScene('plant', W, H, 4);
    const bgra = Buffer.alloc(W * H * 4);
    for (let i = 0; i < W * H; i++) { bgra[i * 4] = sc.rgb[i * 3 + 2]; bgra[i * 4 + 1] = sc.rgb[i * 3 + 1]; bgra[i * 4 + 2] = sc.rgb[i * 3]; bgra[i * 4 + 3] = 255; }
    const file = path.join(dir, 'plant on a shelf.png');
    fs.writeFileSync(file, nativeImage.createFromBitmap(bgra, { width: W, height: H }).toPNG());
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
    await waitFor('!!window.__app');
    await click('#open2');
    await waitFor('window.__app.S.phase === "ready"');
    await click('#tool-erase');
    await js('document.activeElement && document.activeElement.blur()');
    await sleep(600);
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'background-remover.png'), (await wc.capturePage()).toPNG());
    console.log('wrote', path.join(outDir, 'background-remover.png'));
    code = 0;
  } catch (e) { console.error('screenshot failed:', e); }
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  app.exit(code);
};
