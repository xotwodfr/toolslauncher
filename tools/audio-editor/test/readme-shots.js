'use strict';
// Makes the README screenshot: `node ../../node_modules/electron/cli.js . --e2e --readme-shots=<folder>`.
// The sound is INVENTED (a generated arpeggio with sections), so the screenshot shows a realistic waveform without
// anyone's real recording.
const fs = require('fs');
const os = require('os');
const path = require('path');
const K = require('../src/testkit');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const NOTES = [220, 277.2, 329.6, 440, 329.6, 277.2];

/** A song-like sound: a plucked arpeggio, a bass pulse and four sections of different loudness. */
function song(i, rate) {
  const t = i / rate;
  const step = 0.3;
  const k = Math.floor(t / step);
  const local = t - k * step;
  const f = NOTES[k % NOTES.length] * (Math.floor(k / 24) % 2 ? 1.25 : 1);
  const env = Math.exp(-local * 7);
  const pluck = env * (Math.sin(2 * Math.PI * f * t) + 0.45 * Math.sin(4 * Math.PI * f * t) + 0.2 * Math.sin(6 * Math.PI * f * t));
  const beat = t % 0.6;
  const bass = Math.exp(-beat * 9) * Math.sin(2 * Math.PI * 55 * t) * 0.9;
  const level = t < 6 ? 0.16 + t * 0.012 : t < 30 ? 0.62 : t < 36 ? 0.3 : t < 54 ? 0.72 : 0.72 * Math.max(0, (60 - t) / 6);
  return (pluck * 0.42 + bass * 0.5) * level;
}

exports.run = async ({ app, getWin, outDir }) => {
  const win = getWin();
  const wc = win.webContents;
  const js = (c) => wc.executeJavaScript(c, true);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audioeditor-shots-'));
  fs.mkdirSync(outDir, { recursive: true });
  const waitFor = async (expr, ms = 10000) => { const end = Date.now() + ms; for (;;) { if (await js(expr)) return; if (Date.now() > end) throw new Error('timed out: ' + expr); await sleep(50); } };
  let code = 0;
  try {
    const file = K.makeWav(path.join(dir, 'Demo Track.wav'), { rate: 44100, channels: 2, parts: [{ sec: 60, gen: song }] });
    win.setContentSize(1240, 800);
    await waitFor('!!window.__app');
    await js(`window.ae.openPaths([${JSON.stringify(file)}]).then(l => window.__app.addOpened(l))`);
    await waitFor('window.__app.S.items.length === 1 && window.__app.S.items[0].peaksState === "ready"');
    await js(`(()=>{
      const a = window.__app; const it = a.S.items[0];
      it.cuts = [[12.4, 15.9], [41.2, 44.6]];
      a.wave.setCuts(it.cuts);
      a.wave.setSelection(22.0, 27.5); a.wave.on.select([22.0, 27.5]);
      a.seek(19.2);
      document.getElementById('format').value = 'mp3'; document.getElementById('format').dispatchEvent(new Event('change'));
      document.getElementById('fadeIn').value = '1'; document.getElementById('fadeOut').value = '3';
      document.getElementById('normalize').value = 'loudness'; document.getElementById('normalize').dispatchEvent(new Event('change'));
      document.getElementById('fadeIn').dispatchEvent(new Event('input'));
    })()`);
    await sleep(500);
    fs.writeFileSync(path.join(outDir, 'audio-editor.png'), (await wc.capturePage()).toPNG());
    console.log('wrote audio-editor.png');
  } catch (e) {
    console.error('readme-shots failed:', e);
    code = 1;
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  app.exit(code);
};
