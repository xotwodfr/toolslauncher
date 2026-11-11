'use strict';
// Makes the README screenshot: `node ../../node_modules/electron/cli.js . --e2e --readme-shots=<folder>`.
// The video is INVENTED: a drawn evening sky with made-up lines read by a speech voice (espeak-ng or a Windows voice),
// listened to by the real model, so the screenshot shows real results without anyone's recording.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const SP = require('../src/speech');
const A = require('../src/audio');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const LINES = [
  'Welcome back. Today we are walking up to the old lighthouse on the hill.',
  'The path is steep in places, so take your time and bring some water.',
  'From the top you can see the whole bay, and on a clear day, the islands.',
  'Next week we will try the coastal trail at sunrise. See you there.',
];

exports.run = async ({ app, getWin, outDir, dialog }) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'subtitle-shots-'));
  const win = getWin();
  const wc = win.webContents;
  const js = (c) => wc.executeJavaScript(c, true);
  const waitFor = async (expr, ms = 180000) => { const end = Date.now() + ms; for (;;) { if (await js(expr)) return; if (Date.now() > end) throw new Error('timed out: ' + expr); await sleep(100); } };
  const center = (sel) => js(`(()=>{const e=document.querySelector(${JSON.stringify(sel)}); const b=e.getBoundingClientRect(); return {x:Math.round(b.x+b.width/2), y:Math.round(b.y+b.height/2)};})()`);
  const click = async (sel) => { const { x, y } = await center(sel); wc.sendInputEvent({ type: 'mouseMove', x, y }); wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 }); wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 }); await sleep(150); };
  let code = 1;
  try {
    if (!SP.available()) throw new Error('the screenshot needs a speech voice (espeak-ng or Windows)');
    win.setContentSize(1240, 840);
    const at = [1.0, 7.5, 13.5, 20.5];
    const wav = path.join(dir, 'voice.wav');
    await SP.makeClip(LINES.map((text, i) => ({ text, at: at[i], voice: i % 2 ? 'Microsoft Zira Desktop' : 'Microsoft David Desktop' })), 27, wav, dir);
    const file = path.join(dir, 'Lighthouse walk (demo).mp4');
    const sky = 'gradients=s=1280x720:c0=0x1b2a4a:c1=0xf08a5d:x0=0:y0=0:x1=0:y1=720:d=27:r=25';
    const scene = '[0:v]drawbox=x=0:y=540:w=1280:h=180:color=0x101820:t=fill,drawbox=x=880:y=330:w=34:h=210:color=0xe8e2d0:t=fill,drawbox=x=872:y=312:w=50:h=24:color=0xffd166:t=fill,drawbox=x=0:y=500:w=700:h=40:color=0x1c2833:t=fill,format=yuv420p[v]';
    const r = spawnSync(A.ffmpegPath(), ['-y', '-hide_banner', '-v', 'error', '-f', 'lavfi', '-i', sky, '-i', wav, '-filter_complex', scene, '-map', '[v]', '-map', '1:a', '-c:v', 'libx264', '-preset', 'fast', '-c:a', 'aac', '-shortest', file], { encoding: 'utf8', windowsHide: true });
    if (r.status !== 0) throw new Error(r.stderr);
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
    await waitFor('!!window.__app', 20000);
    await click('#open2');
    await waitFor('window.__app.S.media !== null', 15000);
    await waitFor('document.getElementById("player").readyState >= 2', 15000);
    await click('#make');
    await waitFor('window.__app.S.working', 5000);
    await waitFor('!window.__app.S.working');
    await js('document.getElementById("player").currentTime = 15.2; void 0');
    await sleep(600);
    await click('#cues .cue:nth-child(3) .n');
    await js('document.activeElement && document.activeElement.blur()');
    await sleep(500);
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'subtitle-maker.png'), (await wc.capturePage()).toPNG());
    console.log('wrote', path.join(outDir, 'subtitle-maker.png'));
    code = 0;
  } catch (e) { console.error('screenshot failed:', e); }
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  app.exit(code);
};
