'use strict';
// Makes the README screenshot: `node ../../node_modules/electron/cli.js . --e2e --readme-shots=<folder>`.
// The files are INVENTED (random bytes under made-up names) in a temporary folder that is removed afterwards.
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

exports.run = async ({ app, getWin, outDir, dialog }) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fenc-shots-'));
  const win = getWin();
  const wc = win.webContents;
  const js = (c) => wc.executeJavaScript(c, true);
  const waitFor = async (expr, ms = 60000) => { const end = Date.now() + ms; for (;;) { if (await js(expr)) return; if (Date.now() > end) throw new Error('timed out: ' + expr); await sleep(80); } };
  const center = (sel) => js(`(()=>{const e=document.querySelector(${JSON.stringify(sel)}); const b=e.getBoundingClientRect(); return {x:Math.round(b.x+b.width/2), y:Math.round(b.y+b.height/2)};})()`);
  const click = async (sel) => { const { x, y } = await center(sel); wc.sendInputEvent({ type: 'mouseMove', x, y }); wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 }); wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 }); await sleep(150); };
  let code = 1;
  try {
    win.setContentSize(1240, 840);
    const docs = path.join(dir, 'Documents');
    fs.mkdirSync(docs);
    const files = [];
    for (const [name, size] of [['Passport scan.pdf', 1840000], ['Lease agreement 2026.pdf', 612000], ['Tax return 2025.xlsx', 96000], ['Family photos 2019-2024', 0], ['Recovery codes.txt', 900], ['Project Aurora budget.ods', 241000]]) {
      const p = path.join(docs, name);
      if (!size) {
        for (let i = 1; i <= 24; i++) { fs.mkdirSync(path.join(p, String(2018 + Math.ceil(i / 4))), { recursive: true }); fs.writeFileSync(path.join(p, String(2018 + Math.ceil(i / 4)), `IMG_${String(4100 + i)}.jpg`), crypto.randomBytes(180000 + i * 3000)); }
      } else fs.writeFileSync(p, crypto.randomBytes(size));
      files.push(p);
    }
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: files });
    await waitFor('!!window.__app');
    await click('#addFiles2');
    await waitFor('window.__app.S.tabs.encrypt.rows.length === 6');
    await js(`(() => { for (const id of ['pw', 'pw2']) { const e = document.getElementById(id); e.value = 'Invented-Screenshot-Pass-77'; e.dispatchEvent(new Event('input')); } })()`);
    await click('#go');
    await waitFor('window.__app.S.tabs.encrypt.rows.every((r) => r.status === "done") && !window.__app.S.running');
    await js(`(() => { for (const id of ['pw', 'pw2']) { const e = document.getElementById(id); e.value = 'Invented-Screenshot-Pass-77'; e.dispatchEvent(new Event('input')); } })()`);
    await sleep(500);
    await js('document.activeElement && document.activeElement.blur()');
    await sleep(300);
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'file-encryptor.png'), (await wc.capturePage()).toPNG());
    console.log('wrote', path.join(outDir, 'file-encryptor.png'));
    code = 0;
  } catch (e) { console.error('screenshot failed:', e); }
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  app.exit(code);
};
