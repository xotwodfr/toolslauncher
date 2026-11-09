'use strict';
// Makes the README screenshot: `node ../../node_modules/electron/cli.js . --e2e --readme-shots=<folder>`.
// The music is INVENTED (a generated drum pattern, bass line, chords and a lead), so the screenshot shows realistic stems
// split by the real model without anyone's real recording.
const fs = require('fs');
const os = require('os');
const path = require('path');
const K = require('../src/testkit');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ROOTS = [55, 55, 65.4, 73.4]; // bass notes of a four-bar loop (A, A, C, D)

function song(i, rate) {
  const t = i / rate;
  const bar = Math.floor(t / 2) % 4;
  const beat = t % 0.5;
  const kick = Math.sin(2 * Math.PI * (48 + 100 * Math.exp(-beat * 32)) * t) * Math.exp(-beat * 8) * 0.6;
  const eighth = t % 0.25;
  const hat = (((i * 7919) % 1000) / 1000 - 0.5) * Math.exp(-eighth * 55) * 0.3;
  const snare = (t % 1 >= 0.5 ? (((i * 104729) % 997) / 997 - 0.5) * Math.exp(-(t % 0.5) * 18) * 0.45 : 0);
  const f = ROOTS[bar];
  const bass = (Math.sin(2 * Math.PI * f * t) + 0.35 * Math.sin(4 * Math.PI * f * t)) * 0.3 * (0.55 + 0.45 * Math.exp(-(t % 0.25) * 5));
  const chordRoot = f * 4;
  const chord = (Math.sin(2 * Math.PI * chordRoot * t) + Math.sin(2 * Math.PI * chordRoot * 1.26 * t) + Math.sin(2 * Math.PI * chordRoot * 1.5 * t)) * 0.06;
  const note = [1, 1.25, 1.5, 2, 1.5, 1.25][Math.floor(t / 0.25) % 6];
  const lead = Math.sin(2 * Math.PI * chordRoot * 2 * note * t + 2 * Math.sin(2 * Math.PI * 5 * t)) * 0.1 * Math.exp(-(t % 0.25) * 6);
  const level = t < 4 ? 0.3 + t * 0.15 : t < 30 ? 0.95 : 0.95 * Math.max(0, (34 - t) / 4);
  return (kick + hat + snare + bass + chord + lead) * level * 0.7;
}

exports.run = async ({ app, getWin, openPaths, outDir }) => {
  const win = getWin();
  const wc = win.webContents;
  const js = (c) => wc.executeJavaScript(c, true);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stemsplit-shots-'));
  fs.mkdirSync(outDir, { recursive: true });
  const waitFor = async (expr, ms = 10000) => { const end = Date.now() + ms; for (;;) { if (await js(expr)) return; if (Date.now() > end) throw new Error('timed out: ' + expr); await sleep(80); } };
  let code = 0;
  try {
    const file = K.makeWav(path.join(dir, 'Demo Track.wav'), { rate: 44100, channels: 2, parts: [{ sec: 34, gen: song }] });
    win.setContentSize(1180, 780);
    await waitFor('!!window.__app');
    const r = await openPaths([file]);
    await js(`void window.__app.handleOpened(${JSON.stringify(r)})`);
    await waitFor('window.__app.S.view === "ready"', 180000);
    await js(`(()=>{
      const a = window.__app;
      a.P.selectOnly(a.S.mix, ['drums', 'bass']); a.applyMix();
      a.seekTo(0.42);
      const f = document.getElementById('format'); f.value = 'flac'; f.dispatchEvent(new Event('change'));
    })()`);
    await sleep(700);
    fs.writeFileSync(path.join(outDir, 'stem-splitter.png'), (await wc.capturePage()).toPNG());
    console.log('wrote stem-splitter.png');
  } catch (e) {
    console.error('readme-shots failed:', e);
    code = 1;
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  app.exit(code);
};
