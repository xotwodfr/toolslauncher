'use strict';
// Makes the README screenshot: `node test/run-e2e.js --readme-shots=../../docs/screenshots`.
// The photos are INVENTED landscapes (src/samples.js) with invented names, edited by the real pipeline.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { makePhoto } = require('../src/samples');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PHOTOS = [['lakeside morning', 1, 3000, 2000], ['harbour sunset', 0, 3000, 2000], ['ridge walk', 5, 2400, 3000], ['blue hour', 2, 3000, 2000], ['dunes', 3, 3000, 2000], ['meadow', 4, 2000, 2000], ['old pier', 1, 3000, 1700], ['valley view', 5, 3000, 2000]];

exports.run = async ({ app, exit, getWin, outDir, dialog }) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'photobatch-shots-'));
  const win = getWin();
  const wc = win.webContents;
  const js = (c) => wc.executeJavaScript(c, true);
  const waitFor = async (expr, ms = 60000) => { const end = Date.now() + ms; for (;;) { if (await js(expr)) return; if (Date.now() > end) throw new Error('timed out: ' + expr); await sleep(80); } };
  let code = 1;
  try {
    win.setContentSize(1240, 840);
    const src = path.join(dir, 'Trip to the coast');
    fs.mkdirSync(src);
    for (const [n, i, w, h] of PHOTOS) await makePhoto(path.join(src, `${n}.jpg`), w, h, { index: i });
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [src] });
    await waitFor('window.__app && window.__app.ready');
    await js(`(() => {
      const a = window.__app; const R = window.Recipe;
      const st = (t, o) => ({ ...R.freshStep(t), ...o, _id: Math.floor(Math.random() * 1e9) });
      a.S.recipe = [st('resize', { mode: 'long', long: 2048 }), st('crop', { aspect: '4:5', anchor: 'attention', matchOrientation: true }), st('adjust', { contrast: 12, saturation: 15, warmth: 10 }), st('sharpen', { amount: 'light' }), st('border', { size: 2.5, colour: '#ffffff' }), st('text', { text: '© Aster Vale Photography', size: 3.2, position: 'bottom-right' })];
      a.S.output = { ...a.S.output, format: 'webp', quality: 82, metadata: 'copyright', pattern: '{name}-{w}x{h}', folder: '' };
      a.paintSteps(); a.paintOutput();
    })()`);
    await js('document.getElementById("addFolder2").click()');
    await waitFor('window.__app.S.rows.length === 8');
    await waitFor('document.querySelectorAll("#list img[src^=\'data:\']").length === 8');
    await js('document.getElementById("start").click()');
    await waitFor('!window.__app.S.running && /saved/.test(document.getElementById("runText").textContent)', 120000);
    // show a photo in the middle of the list, with its preview up to date
    const id = await js('window.__app.S.rows[1].id');
    await js(`window.__app.select(${id})`);
    await waitFor(`window.__app.previewsShown() > 0 && document.getElementById("pvBusy").hidden`);
    await sleep(800);
    await waitFor('document.getElementById("pvBusy").hidden');
    // the folder lives in a temporary directory here: show where it would be on a real computer
    await js('(() => { const t = document.getElementById("runText"); t.textContent = t.textContent.replace(/→ .*$/, "→ Trip to the coast/edited"); })()');
    await js('document.activeElement && document.activeElement.blur()');
    await sleep(500);
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'photo-batch-editor.png'), (await wc.capturePage()).toPNG());
    console.log('wrote', path.join(outDir, 'photo-batch-editor.png'));
    code = 0;
  } catch (e) { console.error('screenshot failed:', e); }
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  exit(code);
};
