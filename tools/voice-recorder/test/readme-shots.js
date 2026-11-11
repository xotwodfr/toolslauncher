'use strict';
// Makes the README screenshot: `node test/run-e2e.js --readme-shots=../../docs/screenshots`.
// The takes are INVENTED speech (src/synth.js) with invented titles; the live meter is fed by Chromium's fake microphone.
const fs = require('fs');
const path = require('path');
const W = require('../src/wav');
const { makeSpeech } = require('../src/synth');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// file name (date - title), phrases, pauses, markers (s)
const TAKES = [
  ['2026-11-08 09.12.40 - Garden notes', [3, 2.5, 3], [0.6, 0.8, 0.5], []],
  ['2026-11-09 18.30.05 - Interview questions', [2.2, 2.8, 2.4, 2], [1, 0.7, 1.2, 0.5], [3.4]],
  ['2026-11-10 07.55.12', [2, 2], [0.5, 0.5], []],
  ['2026-11-10 20.41.27 - Episode 14 intro', [2.6, 3.2, 2.4, 2.8, 2.2], [0.5, 3.2, 0.6, 2.4, 0.6], [5.6, 12.9]],
];

exports.run = async ({ app, getWin, outDir, folder, dialog }) => {
  const win = getWin();
  const wc = win.webContents;
  const js = (c) => wc.executeJavaScript(c, true);
  const waitFor = async (expr, ms = 30000) => { const end = Date.now() + ms; for (;;) { if (await js(expr)) return; if (Date.now() > end) throw new Error('timed out: ' + expr); await sleep(80); } };
  let code = 1;
  try {
    win.setContentSize(1240, 840);
    const dir = folder();
    TAKES.forEach(([base, phrases, pauses, markers], i) => {
      const s = makeSpeech({ phrases, pauses, lead: 0.6, noise: 0.005, hum: 0.003, seed: 300 + i, level: 0.32 });
      const pcm = W.floatToInt16(s.samples);
      const part = path.join(dir, base + '.wav.part');
      const w = new W.WavWriter(part, { sampleRate: 48000 });
      w.append(pcm);
      w.finish(path.join(dir, base + '.wav'), markers.map((t) => ({ t })));
    });
    await waitFor('window.__app && window.__app.ready && window.__app.S.mic.ok');
    await js('window.vr.list().then((r) => { window.__app.S.takes = r.takes; })');
    await js('window.__app.openTake("2026-11-10 20.41.27 - Episode 14 intro.wav")');
    await waitFor('!!window.__app.S.info');
    // a session in progress: trimmed, noise learned from the long pause, pauses shortened, loudness to -16
    await js(`(() => {
      const a = window.__app; const o = a.optsFor(a.S.current);
      o.trim = { start: 0.3, end: a.S.info.duration - 0.2 };
      o.denoise = { on: true, strength: 'medium', sample: { start: 6.0, end: 8.4 } };
      o.pauses = { on: true, longer: 1.5, keep: 0.6 };
      o.highpass = { on: true, freq: 80 }; o.loudness = { on: true, target: -16 };
    })()`);
    await js('window.__app.paintOpts(); window.__app.paintTakes(); 1');
    await js('window.__app.S.sel = { start: 2.2, end: 16.5 }; 1');
    await js('window.__app.makePreview(false)');
    await waitFor('!!window.__app.S.preview');
    await js('window.__app.S.sel = null; window.__app.paintSel(); window.__app.drawWave(); 1');
    // the test profile's folder lives in a temporary directory: show the usual default instead
    await js('document.getElementById("folderName").textContent = "\\u200E~/Music/Voice Recordings\\u200E"; 1');
    await js('(() => { const s = document.getElementById("format"); s.value = "mp3"; })()');
    dialog.showSaveDialog = async (_w, o) => ({ canceled: false, filePath: o.defaultPath });
    await js('document.getElementById("export").click()');
    await waitFor('/^Saved/.test(document.getElementById("resultText").textContent)', 60000);
    await waitFor('Math.max(...window.__app.S.levels) > 0.1');
    await js('document.activeElement && document.activeElement.blur()');
    await sleep(700);
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'voice-recorder.png'), (await wc.capturePage()).toPNG());
    console.log('wrote', path.join(outDir, 'voice-recorder.png'));
    code = 0;
  } catch (e) { console.error('screenshot failed:', e); }
  app.exit(code);
};
