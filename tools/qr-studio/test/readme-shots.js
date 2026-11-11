'use strict';
// Makes the README screenshot: `node ../../node_modules/electron/cli.js . --e2e --readme-shots=<folder>`.
// INVENTED content: a guest Wi-Fi code for a made-up café, with a made-up logo drawn here.
const fs = require('fs');
const os = require('os');
const path = require('path');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

exports.run = async ({ app, getWin, outDir, dialog, nativeImage }) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qrstudio-shots-'));
  const win = getWin();
  const wc = win.webContents;
  const js = (c) => wc.executeJavaScript(c, true);
  const waitFor = async (expr, ms = 20000) => { const end = Date.now() + ms; for (;;) { if (await js(expr)) return; if (Date.now() > end) throw new Error('timed out: ' + expr); await sleep(80); } };
  let code = 1;
  try {
    win.setContentSize(1240, 840);
    // a made-up logo: a cup on a mint tile
    const N = 128; const bmp = Buffer.alloc(N * N * 4);
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      const i = (y * N + x) * 4;
      const cup = x > 30 && x < 86 && y > 40 && y < 96 && !(x > 38 && x < 78 && y > 40 && y < 50);
      const handle = (x - 92) ** 2 + (y - 62) ** 2 < 15 ** 2 && (x - 92) ** 2 + (y - 62) ** 2 > 8 ** 2 && x > 84;
      const steam = (x === 48 || x === 49 || x === 66 || x === 67) && y > 18 && y < 34;
      const dark = cup || handle || steam;
      const [r, g, b] = dark ? [20, 33, 61] : [184, 242, 230];
      bmp[i] = b; bmp[i + 1] = g; bmp[i + 2] = r; bmp[i + 3] = 255;
    }
    const logo = path.join(dir, 'cafe-logo.png');
    fs.writeFileSync(logo, nativeImage.createFromBitmap(bmp, { width: N, height: N }).toPNG());
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [logo] });
    await waitFor('!!window.__app');
    await js(`(() => { const a = window.__app; a.setTab('make'); a.S.look.kind = 'wifi'; a.S.look.style = 'rounded'; a.S.look.fg = '#14213d';
      a.S.fields.wifi = { ssid: 'Harbor Café Guest', password: 'blue-kettle-2026', security: 'WPA' };
      for (const b of document.querySelectorAll('[data-style]')) b.setAttribute('aria-checked', String(b.dataset.style === 'rounded'));
      document.getElementById('fg').value = '#14213d';
      for (const b of document.querySelectorAll('#kinds .mode')) b.setAttribute('aria-checked', String(b.dataset.kind === 'wifi'));
      a.renderFields(); })()`);
    await js('document.getElementById("logoPick").click()');
    await waitFor('!document.getElementById("logoPrev").hidden');
    await waitFor('/Checked: it scans/.test(document.getElementById("qrCheck").textContent)');
    await js('document.querySelector("details.inside").open = true');
    await js('document.activeElement && document.activeElement.blur()');
    await sleep(500);
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'qr-studio.png'), (await wc.capturePage()).toPNG());
    console.log('wrote', path.join(outDir, 'qr-studio.png'));
    code = 0;
  } catch (e) { console.error('screenshot failed:', e); }
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  app.exit(code);
};
