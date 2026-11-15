'use strict';
// Makes the README screenshot: `npm run readme-shots` (= electron . --e2e --readme-shots=../../docs/screenshots).
// Optional --copy-shots=<folder> also writes the extra shots there. The photo is INVENTED (src/scene.js); the outline and the
// removal are done by the real models, so the screenshot shows real results without anyone's photo.
const fs = require('fs');
const os = require('os');
const path = require('path');
const M = require('../src/meta');
const { beachScene } = require('../src/scene');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

exports.run = async ({ app, getWin, outDir, copyDir, dialog, releaseAll }) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'photocleanup-shots-'));
  const win = getWin();
  const wc = win.webContents;
  const js = (c) => wc.executeJavaScript(c, true);
  const waitFor = async (expr, ms = 180000) => { const end = Date.now() + ms; for (;;) { if (await js(expr)) return; if (Date.now() > end) throw new Error('timed out: ' + expr); await sleep(100); } };
  const clickAt = async (x, y) => { for (const type of ['mouseMove', 'mouseDown', 'mouseUp']) { wc.sendInputEvent({ type, x, y, button: 'left', clickCount: 1 }); await sleep(30); } await sleep(150); };
  const log = (m) => console.log('[shots] ' + m);
  const click = async (sel) => { log('click ' + sel); const p = await js(`(()=>{const b=document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return {x:Math.round(b.x+b.width/2), y:Math.round(b.y+b.height/2)};})()`); await clickAt(p.x, p.y); };
  const capture = async (name, dirs) => { await sleep(500); const png = (await wc.capturePage()).toPNG(); for (const d of dirs.filter(Boolean)) { fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, name), png); console.log('wrote', path.join(d, name)); } };
  let code = 1;
  try {
    win.setContentSize(1320, 860);
    const W = 1800; const H = 1200;
    const sc = beachScene(W, H, 3);
    const file = path.join(dir, 'beach.png');
    fs.writeFileSync(file, await M.encodePng(sc.rgba, W, H));
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
    await waitFor('!!window.__app');
    await click('#open2');
    await waitFor('window.__app.S.phase === "ready"');
    log('opened'); await waitFor('window.__app.ensureEmbedding()'); log('embedding ready');
    const p = await js(`window.__app.toWindow(${sc.tap.x}, ${sc.tap.y})`);
    await clickAt(p.x, p.y);
    await waitFor('window.__app.maskCount() > 0', 30000);
    // tap more to add: the top band of the bin
    for (const [x, y] of [[sc.bin.cx, sc.bin.top + Math.round(sc.bin.h * 0.08)]]) {
      const n = await js('window.__app.S.undo.length');
      const q = await js(`window.__app.toWindow(${x}, ${y})`);
      await clickAt(q.x, q.y);
      await waitFor(`window.__app.S.undo.length > ${n} || !document.getElementById('selInfo').textContent`, 30000);
      await sleep(300);
    }
    log('taps done');
    // and the brush for its shadow on the sand
    await click('#tool-brush');
    await js('(() => { const e = document.getElementById("brush"); e.value = 26; e.dispatchEvent(new Event("input")); })()');
    const y = sc.bin.top + sc.bin.h + 2;
    const s0 = await js(`window.__app.toWindow(${sc.bin.cx - sc.bin.w * 0.8 - 22}, ${y})`); const s1 = await js(`window.__app.toWindow(${sc.bin.cx + sc.bin.w * 0.5}, ${y})`);
    wc.sendInputEvent({ type: 'mouseMove', x: s0.x, y: s0.y }); wc.sendInputEvent({ type: 'mouseDown', x: s0.x, y: s0.y, button: 'left', clickCount: 1 });
    for (let i = 1; i <= 20; i++) { wc.sendInputEvent({ type: 'mouseMove', x: Math.round(s0.x + ((s1.x - s0.x) * i) / 20), y: s0.y, button: 'left' }); await sleep(15); }
    wc.sendInputEvent({ type: 'mouseUp', x: s1.x, y: s1.y, button: 'left', clickCount: 1 }); await sleep(300);
    wc.sendInputEvent({ type: 'mouseMove', x: s1.x + 60, y: s1.y - 40 }); await sleep(100);
    await js('document.activeElement && document.activeElement.blur()');
    await capture('photo-cleanup.png', [outDir, copyDir]);
    await click('#tool-tap');
    await click('#remove');
    await waitFor('window.__app.S.phase === "ready" && window.__app.S.lastEdit && window.__app.S.lastEdit.kind === "remove"');
    await click('#compare');
    const a = await js(`window.__app.toWindow(${Math.round(sc.bin.cx + W * 0.04)}, ${Math.round(H * 0.5)})`);
    await clickAt(a.x, a.y);
    await js('document.activeElement && document.activeElement.blur()');
    await capture('photo-cleanup-compare.png', [copyDir]);
    await click('#compare');
    await click('#preset-16-9');
    await capture('photo-cleanup-extend-frame.png', [copyDir]);
    await click('#extend');
    await waitFor('window.__app.S.phase === "ready" && window.__app.S.lastEdit.kind === "extend"', 300000);
    await capture('photo-cleanup-extended.png', [copyDir]);
    code = 0;
  } catch (e) { console.error('screenshot failed:', e); }
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  if (releaseAll) await releaseAll();
  app.exit(code);
};
