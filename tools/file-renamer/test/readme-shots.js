'use strict';
// Makes the README screenshot: `node ../../node_modules/electron/cli.js . --e2e --readme-shots=<folder>`.
// The photos are INVENTED (tiny JPEGs made by src/core/testkit.js with made-up EXIF dates); nobody's pictures are used.
const fs = require('fs');
const os = require('os');
const path = require('path');
const K = require('../src/core/testkit');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SHOTS = [
  ['IMG_2041.JPG', '2023:08:19 09:12:04'], ['IMG_2042.JPG', '2023:08:19 09:13:40'], ['IMG_2047.JPG', '2023:08:19 17:55:12'],
  ['IMG_2051.JPG', '2023:08:20 11:02:31'], ['IMG_2052.JPG', '2023:08:20 11:04:09'], ['IMG_2060.JPG', '2023:08:20 20:41:57'],
  ['IMG_2063.JPG', '2023:08:21 08:30:00'], ['IMG_2071.JPG', '2023:08:21 13:16:45'], ['IMG_2072.JPG', '2023:08:21 13:17:02'],
];

exports.run = async ({ app, getWin, outDir }) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'renamer-shots-'));
  const win = getWin();
  const wc = win.webContents;
  const js = (c) => wc.executeJavaScript(c, true);
  const waitFor = async (expr, ms = 20000) => { const end = Date.now() + ms; for (;;) { if (await js(expr)) return; if (Date.now() > end) throw new Error('timed out: ' + expr); await sleep(60); } };
  let code = 1;
  try {
    win.setContentSize(1240, 840);
    const trip = path.join(dir, 'Lisbon trip'); fs.mkdirSync(trip);
    for (const [n, d] of SHOTS) K.jpegWithDate(path.join(trip, n), d);
    fs.writeFileSync(path.join(trip, 'Screenshot 2023-08-22.PNG'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    await waitFor('window.__app && window.__app.S.ready');
    await js(`window.rn.addPaths([${JSON.stringify(trip)}], {})`);
    await js(`(() => {
      const A = window.__app;
      A.addRule('date', { source: 'exif', format: 'YYYY-MM-DD', where: 'replace' });
      A.addRule('insert', { text: ' Lisbon', where: 'beforeExt' });
      A.addRule('number', { where: 'end', separator: ' ', pad: 2, start: 1 });
      A.addRule('extension', { mode: 'lower' });
    })()`);
    await waitFor('window.__app.rows().length === 10 && window.__app.rows()[0].newName.includes("Lisbon")');
    await sleep(300);
    await js('document.activeElement && document.activeElement.blur(); document.getElementById("ruleList").scrollTop = 0');
    await sleep(400);
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'file-renamer.png'), (await wc.capturePage()).toPNG());
    console.log('wrote', path.join(outDir, 'file-renamer.png'));
    code = 0;
  } catch (e) { console.error('screenshot failed:', e); }
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  app.exit(code);
};
