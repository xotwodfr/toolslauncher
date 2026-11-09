'use strict';
// `--self-test=<result.json>`: proves a PACKAGED build works. Makes test sounds, edits them with the bundled ffmpeg
// (cut, join, fade, normalize, every output format), reads the results back, then opens the real window, loads a file
// into it and saves from it. Used by CI and by hand on the unpacked build.
const fs = require('fs');
const os = require('os');
const path = require('path');
const P = require('./plan');
const E = require('./edit');
const K = require('./testkit');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function run({ getWin } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audioedit-selftest-'));
  const out = path.join(dir, 'out');
  const ff = E.ffmpegPath();
  const results = [];
  const step = async (name, fn) => { try { results.push({ name, ok: true, detail: await fn() }); } catch (e) { results.push({ name, ok: false, error: String((e && e.message) || e) }); } };
  const near = (a, b, tol, what) => { if (!(Math.abs(a - b) <= tol)) throw new Error(`${what}: expected ${b} +/- ${tol}, got ${a}`); };
  const dec = (f) => { const d = K.decode(ff, f); if (d.errors) throw new Error('decode errors: ' + d.errors); return d; };
  const item = async (file, cuts = []) => { const p = await E.probe(file); return { path: file, duration: p.duration, rate: p.rate, channels: p.channels, coverStream: p.coverStream, cuts }; };
  try {
    await step('bundled ffmpeg has the encoders', async () => {
      const r = await E.checkEncoders();
      if (!r.ok) throw new Error('missing encoders: ' + r.missing.join(', '));
      return 'ok';
    });
    const ten = K.makeWav(path.join(dir, 'ten.wav'), { rate: 44100, channels: 2, parts: K.steps(10) });
    const quiet = K.makeWav(path.join(dir, 'quiet.wav'), { rate: 44100, channels: 1, parts: [{ sec: 6, freq: 440, amp: 0.02 }] });
    await step('reads a file and draws its waveform', async () => {
      const p = await E.probe(ten);
      near(p.duration, 10, 0.02, 'length');
      const w = await E.peaks(ten);
      near(w.data.length / 2 / w.perSec, 10, 0.05, 'waveform length');
      return `${p.rate} Hz, ${p.channels} channels, ${w.data.length / 2} points`;
    });
    await step('cut out the middle, then join with a crossfade', async () => {
      const r = await E.render([await item(ten, [[3, 6]]), await item(quiet)], { format: 'wav', outDir: out, join: 'cross', joinSeconds: 1 });
      const d = dec(r.output);
      near(K.seconds(d), 7 + 6 - 1, 0.06, 'length');
      near(K.freqOf(d, 2.2, 2.8), 400, 15, 'pitch before the cut');
      near(K.freqOf(d, 3.2, 3.8), 800, 15, 'pitch after the cut');
      return `${r.parts} pieces, ${K.seconds(d).toFixed(2)} s`;
    });
    await step('fades and peak normalize', async () => {
      const r = await E.render([await item(quiet)], { format: 'wav', outDir: out, fadeIn: 1, fadeOut: 1, normalize: 'peak' });
      const d = dec(r.output);
      near(K.peakDb(d, 2, 4), -1, 0.4, 'peak');
      if (!(K.peakDb(d, 5.99, 6) < K.peakDb(d, 2, 4) - 35)) throw new Error('no fade out');
      if (!(K.rmsDb(d, 0, 0.05) < K.rmsDb(d, 2, 4) - 20)) throw new Error('no fade in');
      return `peak ${K.peakDb(d, 2, 4).toFixed(2)} dB`;
    });
    await step('loudness normalize reaches the target', async () => {
      const r = await E.render([await item(quiet)], { format: 'flac', outDir: out, normalize: 'loudness', loudness: -16 });
      const l = K.loudness(ff, r.output);
      near(l, -16, 1, 'loudness');
      return `${l} LUFS`;
    });
    for (const format of Object.keys(P.FORMATS)) {
      await step(`save as ${P.FORMATS[format].label}`, async () => {
        const r = await E.render([await item(ten, P.keepOnly({ duration: 10 }, 1, 4))], { format, outDir: out });
        const d = dec(r.output);
        near(K.seconds(d), 3, format === 'wav' || format === 'flac' ? 0.04 : 0.15, 'length');
        near(K.freqOf(d, 1.1, 1.9), 400, 20, 'pitch');
        return `${r.bytes} bytes`;
      });
    }

    const win = getWin && getWin();
    if (win) {
      const js = (c) => win.webContents.executeJavaScript(c, true);
      const errors = [];
      win.webContents.on('console-message', (_e, level, msg) => { if (level >= 2) errors.push(msg); });
      const waitFor = async (expr, ms = 10000) => { const end = Date.now() + ms; for (;;) { if (await js(expr)) return; if (Date.now() > end) throw new Error('timed out: ' + expr); await sleep(50); } };
      await step('the window opens, loads a file, draws it and saves from it', async () => {
        await waitFor('!!window.__app');
        await js(`window.ae.openPaths([${JSON.stringify(ten)}]).then(l => window.__app.addOpened(l))`);
        await waitFor('window.__app.S.items.length === 1 && window.__app.S.items[0].peaksState === "ready"');
        await sleep(300);
        const drawn = await js(`(()=>{const c=window.__app.wave.base; const row=c.getContext('2d').getImageData(0,Math.round(c.height*0.6),c.width,1).data; let n=0; for(let i=0;i<row.length;i+=4){ if(row[i+2]>200 && row[i]<150) n++; } return n / c.width;})()`);
        if (drawn < 0.5) throw new Error('the waveform is not drawn');
        await waitFor('window.__app.A.readyState >= 2');
        await js(`(()=>{const o=document.getElementById('outDir'); o.dataset.path=${JSON.stringify(path.join(dir, 'ui'))}; o.value='x'; document.getElementById('format').value='mp3'; document.getElementById('format').dispatchEvent(new Event('change')); window.__app.S.items[0].cuts=[[2,4]]; document.getElementById('fadeIn').dispatchEvent(new Event('input'));})()`);
        await js('document.getElementById("export").click()');
        await waitFor('document.getElementById("result").className.includes("ok")', 20000);
        const files = fs.readdirSync(path.join(dir, 'ui'));
        if (files.length !== 1 || !files[0].endsWith('.mp3')) throw new Error('unexpected output: ' + files);
        near(K.seconds(dec(path.join(dir, 'ui', files[0]))), 8, 0.15, 'saved length');
        if (errors.length) throw new Error('console errors: ' + errors.join(' | '));
        return files[0];
      });
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return results;
}

module.exports = { run };
