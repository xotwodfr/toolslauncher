'use strict';
// `--self-test=<result.json>`: proves a PACKAGED build works. Loads the bundled reader (.wasm from the app's own files, with
// the network switched off for it), draws QR codes and barcodes with the bundled libraries, then opens the real window,
// which draws them to pixels and reads them back on the worker thread (the app's own "it scans" check).
const fs = require('fs');
const R = require('./render');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function run({ getWin, decode } = {}) {
  const results = [];
  const step = async (name, fn) => { try { results.push({ name, ok: true, detail: await fn() }); } catch (e) { results.push({ name, ok: false, error: String((e && e.message) || e) }); } };

  await step('the reader loads its bundled .wasm without the network', async () => {
    const wasm = require.resolve('zxing-wasm/reader/zxing_reader.wasm');
    if (!fs.existsSync(wasm)) throw new Error('missing ' + wasm);
    const saved = globalThis.fetch;
    globalThis.fetch = () => { throw new Error('network used'); };
    try {
      const reader = require('./reader');
      await reader.init();
      const blank = await reader.decode({ width: 64, height: 64, data: new Uint8ClampedArray(64 * 64 * 4).fill(255) });
      if (blank.length) throw new Error('found a code in a blank picture');
    } finally { globalThis.fetch = saved; }
    return 'ok';
  });
  await step('QR codes and every barcode type are drawn', async () => {
    const q = R.qrSvg('WIFI:T:WPA;S:Self Test;P:12345678;;', { style: 'dots' });
    if (!q.svg.startsWith('<svg')) throw new Error('no QR svg');
    for (const [k, v] of [['ean13', '590123412345'], ['ean8', '9638507'], ['upca', '03600029145'], ['code128', 'SELF-TEST'], ['code39', 'SELF'], ['itf', '1234']]) {
      const b = R.barcodeSvg(k, v);
      if (!b.svg.includes('<path')) throw new Error('no ' + k);
    }
    return `QR version ${q.version}, 6 barcode types`;
  });
  await step('the decode worker starts and reads nothing from a blank picture', async () => {
    const r = await decode({ width: 32, height: 32, data: new Uint8ClampedArray(32 * 32 * 4).fill(255) });
    if (!Array.isArray(r) || r.length) throw new Error(JSON.stringify(r));
    return 'ok';
  });
  const win = getWin && getWin();
  if (win) {
    const js = (c) => win.webContents.executeJavaScript(c, true);
    const errors = [];
    win.webContents.on('console-message', (_e, level, msg) => { if (level >= 2) errors.push(msg); });
    const waitFor = async (expr, ms = 30000) => { const end = Date.now() + ms; for (;;) { if (await js(expr)) return; if (Date.now() > end) throw new Error('timed out: ' + expr); await sleep(80); } };
    await step('the window draws a Wi-Fi QR code and a barcode and reads both back from their pixels', async () => {
      await waitFor('!!window.__app');
      await js(`(() => { const a = window.__app; a.S.look.kind = 'wifi'; a.S.fields.wifi = { ssid: 'Self;Test', password: 'pa:ss,word', security: 'WPA' }; a.renderFields(); a.makeQr(); })()`);
      await waitFor('/Checked: it scans/.test(document.getElementById("qrCheck").textContent)');
      await js(`(() => { document.getElementById('sym').value = 'code128'; document.getElementById('barValue').value = 'SELF-TEST 1'; window.__app.makeBar(); })()`);
      await waitFor('/Checked: it scans/.test(document.getElementById("barCheckLine").textContent)');
      if (errors.length) throw new Error('console errors: ' + errors.join(' | '));
      return 'both read back';
    });
  }
  return results;
}

module.exports = { run };
