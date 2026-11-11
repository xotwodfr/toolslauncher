'use strict';
// Makes the README screenshot: `node ../../node_modules/electron/cli.js . --e2e --readme-shots=<folder>`.
// The "library" is INVENTED: one made-up piece of music (src/signals.js) saved the ways real files come about - a genuine
// FLAC, a FLAC made from an MP3, an "hi-res" file upsampled from CD quality, an MP3, a 24-bit file that is really 16-bit,
// a hot master that clips - under invented artist and title names, inspected by the real engine.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const G = require('../src/signals');
const { ffmpegPath } = require('../src/pool');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

exports.run = async ({ app, getWin, outDir, dialog }) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inspector-shots-'));
  const win = getWin();
  const wc = win.webContents;
  const ff = ffmpegPath();
  const js = (c) => wc.executeJavaScript(c, true);
  const waitFor = async (expr, ms = 90000) => { const end = Date.now() + ms; for (;;) { if (await js(expr)) return; if (Date.now() > end) throw new Error('timed out: ' + expr); await sleep(80); } };
  const center = (sel) => js(`(()=>{const e=document.querySelector(${JSON.stringify(sel)}); const b=e.getBoundingClientRect(); return {x:Math.round(b.x+b.width/2), y:Math.round(b.y+b.height/2)};})()`);
  const click = async (sel) => { const { x, y } = await center(sel); wc.sendInputEvent({ type: 'mouseMove', x, y }); wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 }); wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 }); await sleep(150); };
  const ffm = (args) => { const r = spawnSync(ff, ['-y', '-hide_banner', '-v', 'error', ...args], { encoding: 'utf8', windowsHide: true }); if (r.status !== 0) throw new Error(r.stderr); };
  let code = 1;
  try {
    win.setContentSize(1240, 840);
    const lib = path.join(dir, 'Music');
    fs.mkdirSync(lib, { recursive: true });
    const [l, r] = G.song(24, 44100, 3);
    const master = G.writeWav(path.join(dir, 'master.wav'), [l, r], 44100, 16);
    const hot = G.writeWav(path.join(dir, 'hot.wav'), [l.map((v) => Math.max(-1, Math.min(1, v * 2.6))), r.map((v) => Math.max(-1, Math.min(1, v * 2.6)))], 44100, 16);
    const mp3 = path.join(dir, 'x.mp3'); ffm(['-i', master, '-b:a', '128k', mp3]);
    const out = (name) => path.join(lib, name);
    ffm(['-i', master, out('Aster Vale - Paper Lanterns.flac')]);
    ffm(['-i', mp3, '-sample_fmt', 's16', out('Nova Harbor - Slow Orbit.flac')]);
    ffm(['-i', master, '-af', 'aresample=96000:resampler=soxr:precision=28', '-sample_fmt', 's32', out('The Quiet Lines - Glass Avenue (24-96).flac')]);
    ffm(['-i', master, '-b:a', '320k', out('Kite Season - Neon Fields.mp3')]);
    ffm(['-i', master, '-c:a', 'pcm_s24le', out('Marlow & Pine - Halfway to Gold (24-bit).wav')]);
    ffm(['-i', hot, out('Aster Vale - Morning Static (loud master).flac')]);
    ffm(['-i', mp3, '-c:a', 'alac', out('Nova Harbor - Tidewater.m4a')]);
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [lib] });
    await waitFor('!!window.__app');
    await click('#addFolder2');
    await waitFor('window.__app.S.rows.length === 7 && window.__app.S.rows.every((r) => r.status === "done")');
    await js('window.__app.select(window.__app.S.rows.find((r) => /Slow Orbit/.test(r.name)).id)');
    await waitFor('window.__app.S.detail && /Slow Orbit/.test(window.__app.S.detail.name)', 10000);
    await js('document.activeElement && document.activeElement.blur()');
    await sleep(600);
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'audio-inspector.png'), (await wc.capturePage()).toPNG());
    console.log('wrote', path.join(outDir, 'audio-inspector.png'));
    code = 0;
  } catch (e) { console.error('screenshot failed:', e); }
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  app.exit(code);
};
