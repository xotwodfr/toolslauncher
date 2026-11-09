'use strict';
// Makes the README screenshot: `node ../../node_modules/electron/cli.js . --e2e --readme-shots=<folder>`.
// The pictures are INVENTED (generated landscapes), so the screenshot shows realistic results without anyone's photos.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { png } = require('../src/testkit');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));

/** A generated landscape: a sky gradient, a sun and two hills. `light` brightens it; `scale` makes it smaller. */
function scene(seed, w, h, light = 0) {
  const SKY = [[[255, 140, 70], [90, 60, 150]], [[120, 200, 255], [20, 80, 170]], [[255, 200, 120], [200, 70, 110]], [[150, 220, 190], [30, 100, 120]]][seed % 4];
  const sun = [0.25 + (seed % 3) * 0.25, 0.3 + (seed % 2) * 0.1];
  return (x, y) => {
    const u = x / w; const v = y / h;
    let c = mix(SKY[0], SKY[1], v);
    if ((u - sun[0]) ** 2 + ((v - sun[1]) * (h / w)) ** 2 < 0.012) c = [255, 240, 200];
    const hill1 = 0.62 + 0.08 * Math.sin(u * 6 + seed);
    const hill2 = 0.78 + 0.06 * Math.sin(u * 9 + seed * 2);
    if (v > hill2) c = [20 + seed * 4, 60, 50]; else if (v > hill1) c = [45, 90 + seed * 6, 80];
    return c.map((k) => Math.max(0, Math.min(255, k + light)));
  };
}

exports.run = async ({ app, getWin, outDir, setTrashMode }) => {
  const win = getWin();
  const wc = win.webContents;
  const js = (c) => wc.executeJavaScript(c, true);
  // made at the top of the drive when possible, so the paths in the screenshot don't show a user name
  let dir;
  try { dir = path.join(path.parse(os.tmpdir()).root, 'duplicate-finder-demo'); fs.mkdirSync(dir); } catch { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dupefinder-shots-')); }
  fs.mkdirSync(outDir, { recursive: true });
  const waitFor = async (expr, ms = 20000) => { const end = Date.now() + ms; for (;;) { if (await js(expr)) return; if (Date.now() > end) throw new Error('timed out: ' + expr); await sleep(50); } };
  let code = 0;
  try {
    const put = (rel, data, iso) => { const f = path.join(dir, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, data); fs.utimesSync(f, new Date(iso), new Date(iso)); };
    const W = 320; const H = 220;
    const base = [[`Camera Roll/IMG_2041.png`, 0], [`Camera Roll/IMG_2077.png`, 1], [`Camera Roll/IMG_2113.png`, 2], [`Camera Roll/IMG_2150.png`, 3]];
    base.forEach(([rel, seed], i) => {
      put(rel, png(W, H, scene(seed, W, H)), `2024-0${i + 3}-12`);
      put(`Phone Backup/${path.basename(rel, '.png')} (1).png`, png(W, H, scene(seed, W, H)), `2024-0${i + 3}-20`);                 // an exact copy
      if (i % 2 === 0) put(`Edited/${path.basename(rel, '.png')} small.png`, png(W / 2, H / 2, scene(seed, W / 2, H / 2, 6)), `2024-0${i + 4}-02`); // smaller and a bit brighter
    });
    put('Camera Roll/Selfie.png', png(W, H, (x, y) => [(x * 5) % 255, (y * 3) % 255, 128]), '2024-05-01');
    win.setContentSize(1240, 800);
    setTrashMode(path.join(dir, '_bin'));
    await waitFor('!!window.__app');
    await js(`window.__app.addRoots([${JSON.stringify(path.join(dir, 'Camera Roll'))}, ${JSON.stringify(path.join(dir, 'Phone Backup'))}, ${JSON.stringify(path.join(dir, 'Edited'))}])`);
    await js('document.getElementById("mode-photos").click()');
    await js('document.getElementById("scan").click()');
    await waitFor('window.__app.S.scanned && window.__app.S.busy === null');
    await waitFor('[...document.querySelectorAll("#groups img.thumb")].every(i => i.complete && i.naturalWidth > 0)');
    await js('document.getElementById("rule").value = "best"; document.getElementById("select").click()');
    await sleep(500);
    fs.writeFileSync(path.join(outDir, 'duplicate-finder.png'), (await wc.capturePage()).toPNG());
    console.log('wrote duplicate-finder.png');
  } catch (e) {
    console.error('readme-shots failed:', e);
    code = 1;
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  app.exit(code);
};
