'use strict';
// Makes the README screenshot: `node ../../node_modules/electron/cli.js . --e2e --readme-shots=<folder>`.
// The songs are INVENTED (rendered by src/synth.js) with invented titles and artists, analysed by the real engine, so the
// screenshot shows real results without anyone's recording.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { makeSong, writeWav } = require('../src/synth');
const { ffmpegPath } = require('../src/pool');
const T = require('../src/tags');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// title, artist, bpm, tonic, mode, existing BPM tag
const SONGS = [
  ['Paper Lanterns', 'Aster Vale', 118, 0, 'major', 0],
  ['Slow Orbit', 'Nova Harbor', 92, 9, 'minor', 0],
  ['Glass Avenue', 'The Quiet Lines', 126, 2, 'minor', 0],
  ['Morning Static', 'Aster Vale', 104, 7, 'major', 100],
  ['Halfway to Gold', 'Marlow & Pine', 140, 4, 'minor', 0],
  ['Tidewater', 'Nova Harbor', 86, 5, 'major', 0],
  ['Neon Fields', 'Kite Season', 128, 11, 'minor', 0],
  ['Lantern Road', 'The Quiet Lines', 112, 10, 'major', 0],
];

exports.run = async ({ app, getWin, outDir, dialog }) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bpmkey-shots-'));
  const win = getWin();
  const wc = win.webContents;
  const ff = ffmpegPath();
  const js = (c) => wc.executeJavaScript(c, true);
  const waitFor = async (expr, ms = 90000) => { const end = Date.now() + ms; for (;;) { if (await js(expr)) return; if (Date.now() > end) throw new Error('timed out: ' + expr); await sleep(80); } };
  const center = (sel) => js(`(()=>{const e=document.querySelector(${JSON.stringify(sel)}); const b=e.getBoundingClientRect(); return {x:Math.round(b.x+b.width/2), y:Math.round(b.y+b.height/2)};})()`);
  const click = async (sel) => { const { x, y } = await center(sel); wc.sendInputEvent({ type: 'mouseMove', x, y }); wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 }); wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 }); await sleep(120); };
  let code = 1;
  try {
    win.setContentSize(1240, 840);
    const files = [];
    const lib = path.join(dir, 'Library');
    fs.mkdirSync(lib, { recursive: true });
    SONGS.forEach(([title, artist, bpm, tonic, mode, tag], i) => {
      const wav = writeWav(path.join(dir, `w${i}.wav`), makeSong({ bpm, tonic, mode, seconds: 24, seed: 500 + i, fourOnFloor: i % 3 === 2 }));
      const out = path.join(lib, `${artist} - ${title}.flac`);
      const r = spawnSync(ff, ['-y', '-hide_banner', '-v', 'error', '-i', wav, '-metadata', `title=${title}`, '-metadata', `artist=${artist}`, out], { encoding: 'utf8', windowsHide: true });
      if (r.status !== 0) throw new Error(r.stderr);
      if (tag) T.writeTags(out, { bpm: tag });
      files.push(out);
    });
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: files });
    await waitFor('!!window.__app');
    await click('#addFiles2');
    await waitFor('window.__app.S.rows.length === 8 && window.__app.S.rows.every((r) => r.status === "done")');
    // write the first five with Camelot names, leaving the song that already had a BPM alone, as a real session would
    await js('(() => { const s = document.getElementById("style"); s.value = "camelot"; s.dispatchEvent(new Event("change")); })()');
    await js('(() => { for (const r of window.__app.S.rows) { r.selected = false; r.ui.chk.checked = false; r.tr.classList.remove("sel"); } for (const r of window.__app.S.rows.slice(0, 5)) { r.selected = true; r.ui.chk.checked = true; r.tr.classList.add("sel"); } })()');
    await click('#write');
    await waitFor('/Wrote/.test(document.getElementById("result").textContent)', 30000);
    await js('document.activeElement && document.activeElement.blur()');
    await js('window.scrollTo(0, 0)');
    await sleep(500);
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'bpm-key-finder.png'), (await wc.capturePage()).toPNG());
    console.log('wrote', path.join(outDir, 'bpm-key-finder.png'));
    code = 0;
  } catch (e) { console.error('screenshot failed:', e); }
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  app.exit(code);
};
