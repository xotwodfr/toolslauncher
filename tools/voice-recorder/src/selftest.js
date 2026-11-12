'use strict';
// `--self-test=<result.json>`: proves a PACKAGED build works. Checks the bundled ffmpeg, writes and recovers a take,
// cleans invented speech (pauses, loudness, noise) and exports every format, then opens the hidden window and records
// a couple of seconds from Chromium's fake microphone through the real capture path. Used by CI and by hand.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const W = require('./wav');
const A = require('./analyse');
const C = require('./clean');
const T = require('./takes');
const { makeSpeech, rmsDb } = require('./synth');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function run({ getWin, folder } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-selftest-'));
  const ff = C.ffmpegPath();
  const results = [];
  const step = async (name, fn) => { try { results.push({ name, ok: true, detail: await fn() }); } catch (e) { results.push({ name, ok: false, error: String((e && e.message) || e) }); } };
  const near = (a, b, tol, what) => { if (!(Math.abs(a - b) <= tol)) throw new Error(`${what}: expected ${b} +/- ${tol}, got ${a}`); };
  try {
    await step('bundled ffmpeg runs', async () => {
      const r = spawnSync(ff, ['-hide_banner', '-version'], { encoding: 'utf8', windowsHide: true });
      if (r.status !== 0) throw new Error('ffmpeg did not start');
      return /ffmpeg version [^\s]+/.exec(r.stdout)[0];
    });

    await step('a take is written while recording, and an unfinished one is recovered', async () => {
      const s = new T.Session(dir, { sampleRate: 48000, date: new Date(2026, 0, 1, 12, 0, 0), syncEvery: 0 });
      s.append(W.floatToInt16(makeSpeech({ phrases: [1], pauses: [0.2], seed: 2 }).samples));
      fs.closeSync(s.writer.fd); // as if the app stopped here
      const got = T.recover([], [dir]);
      if (got.length !== 1 || got[0].error) throw new Error(JSON.stringify(got));
      return `${got[0].name}, ${got[0].seconds.toFixed(2)} s`;
    });

    const sp = makeSpeech({ phrases: [2.4, 3, 2.2], pauses: [0.5, 3, 0.6], noise: 0.004, seed: 8 });
    const file = W.writeFloatWav(path.join(dir, 'speech.wav'), sp.samples, sp.sampleRate);
    const an = A.analyse(file);
    await step('cleaning: long pause shortened, noise lowered, loudness on target', async () => {
      const out = path.join(dir, 'clean.wav');
      const r = await C.render(file, an, { denoise: { on: true }, pauses: { on: true, longer: 1, keep: 0.5 }, loudness: { on: true, target: -16 }, highpass: { on: true } }, { output: out });
      near(r.duration, sp.duration - 2.5 - ((sp.pauses[2][1] - sp.pauses[2][0]) - 3), 0.15, 'length');
      const m = await C.loudnessOf(out);
      near(m.i, -16, 0.5, 'loudness');
      const plain = path.join(dir, 'den.wav');
      await C.render(file, an, { denoise: { on: true } }, { output: plain });
      const parts = []; W.readMono(plain, (b) => parts.push(Float32Array.from(b)));
      const x = new Float32Array(parts.reduce((s, p) => s + p.length, 0)); let o = 0; for (const p of parts) { x.set(p, o); o += p.length; }
      const [a, b] = sp.pauses[2];
      const drop = rmsDb(sp.samples, 48000, a + 0.3, b - 0.3) - rmsDb(x, 48000, a + 0.3, b - 0.3);
      if (drop < 6) throw new Error('noise only lowered by ' + drop.toFixed(1) + ' dB');
      return `${r.duration.toFixed(2)} s, ${m.i} LUFS, noise -${drop.toFixed(1)} dB`;
    });

    await step('every export format encodes', async () => {
      const done = [];
      for (const f of Object.keys(C.FORMATS)) {
        const out = path.join(dir, 'x.' + C.FORMATS[f].ext);
        await C.render(file, an, {}, { output: out, format: f, title: 'Self test' });
        const r = spawnSync(ff, ['-hide_banner', '-i', out, '-f', 'null', '-'], { encoding: 'utf8', windowsHide: true });
        if (r.status !== 0) throw new Error(f + ': ' + r.stderr.slice(-200));
        done.push(f);
      }
      return done.join(', ');
    });

    const win = getWin && getWin();
    if (win) {
      const js = (c) => win.webContents.executeJavaScript(c, true);
      const errors = [];
      win.webContents.on('console-message', (_e, level, msg) => { if (level >= 2) errors.push(msg); });
      const waitFor = async (expr, ms = 15000) => { const end = Date.now() + ms; for (;;) { if (await js(expr)) return; if (Date.now() > end) throw new Error('timed out: ' + expr); await sleep(80); } };
      await step('the window opens the (fake) microphone and records a take through the real capture path', async () => {
        await waitFor('window.__app && window.__app.ready');
        await waitFor('window.__app.S.mic.ok');
        await js('document.getElementById("rec").click()');
        await waitFor('!!window.__app.S.rec');
        await sleep(2000);
        await js('document.getElementById("stop").click()');
        await waitFor('!window.__app.S.rec && window.__app.S.takes.length >= 1');
        const t = await js('window.__app.S.takes[0]');
        if (!(t.duration > 1.2 && t.duration < 4)) throw new Error('take length ' + t.duration);
        const f = path.join(folder(), t.name);
        if (!fs.existsSync(f)) throw new Error('no file');
        if (errors.length) throw new Error('console errors: ' + errors.join(' | '));
        return `${t.duration.toFixed(2)} s at ${t.sampleRate} Hz`;
      });
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return results;
}

module.exports = { run };
