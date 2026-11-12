'use strict';
// Makes the README screenshot: `node ../../node_modules/electron/cli.js . --e2e --readme-shots=<folder>`.
// The "song" is INVENTED: a spoken, made-up set of lines read by a Windows voice (or espeak-ng), listened to by the real model, so the
// screenshot shows real results without anyone's recording or lyrics.
const fs = require('fs');
const os = require('os');
const path = require('path');
const SP = require('../src/speech');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const LINES = [
  'The harbor lights come on one by one, and the boats lean into the dark.',
  'I kept your letter in my coat, folded small against the cold.',
  'Somewhere past the edge of town the radio is playing our song.',
  'So leave a lantern in the window, and I will find my way back home.',
];

exports.run = async ({ app, getWin, outDir, dialog }) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lyrics-shots-'));
  const win = getWin();
  const wc = win.webContents;
  const js = (c) => wc.executeJavaScript(c, true);
  const waitFor = async (expr, ms = 180000) => { const end = Date.now() + ms; for (;;) { if (await js(expr)) return; if (Date.now() > end) throw new Error('timed out: ' + expr); await sleep(100); } };
  const center = (sel) => js(`(()=>{const e=document.querySelector(${JSON.stringify(sel)}); const b=e.getBoundingClientRect(); return {x:Math.round(b.x+b.width/2), y:Math.round(b.y+b.height/2)};})()`);
  const click = async (sel) => { const { x, y } = await center(sel); wc.sendInputEvent({ type: 'mouseMove', x, y }); wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 }); wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 }); await sleep(150); };
  let code = 1;
  try {
    if (!SP.available()) throw new Error('the screenshot needs the Windows speech voices or espeak-ng');
    win.setContentSize(1240, 760);
    const at = [1.5, 8.0, 14.0, 20.5];
    const file = path.join(dir, 'Harbor Lights (demo).wav');
    await SP.makeClip(LINES.map((text, i) => ({ text, at: at[i], voice: i % 2 ? 'Microsoft Zira Desktop' : 'Microsoft David Desktop' })), 29, file, dir);
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
    await waitFor('!!window.__app', 20000);
    await click('#open2');
    await waitFor('window.__app.S.song !== null', 15000);
    await click('#make');
    await waitFor('window.__app.S.working', 5000);
    await waitFor('!window.__app.S.working');
    // play into the third line so a word is lit up, then pause on it
    await js('(() => { const l = window.__app.S.lines.find((x) => /radio/.test(x.text)) || window.__app.S.lines[2]; const w = l.words[Math.min(5, l.words.length - 1)]; const p = document.getElementById("player"); p.currentTime = w.start + 0.05; return p.play(); })()');
    await sleep(250);
    await js('document.getElementById("player").pause(); void 0');
    await sleep(500);
    await js('document.activeElement && document.activeElement.blur()');
    await sleep(500);
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'lyrics-maker.png'), (await wc.capturePage()).toPNG());
    console.log('wrote', path.join(outDir, 'lyrics-maker.png'));
    code = 0;
  } catch (e) { console.error('screenshot failed:', e); }
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  app.exit(code);
};
