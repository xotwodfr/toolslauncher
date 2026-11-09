'use strict';
// `--self-test=<result.json>`: proves a PACKAGED build works. Checks the bundled ffmpeg and the model runtime, separates a
// generated 9-second "band" with the REAL Demucs model, rebuilds it from the stems, saves two combinations in every
// format and reads them back, then opens the real window, splits a song in it and checks the six lanes are drawn.
// Used by CI and by hand on the unpacked build.
const fs = require('fs');
const os = require('os');
const path = require('path');
const P = require('./plan');
const S = require('./stems');
const K = require('./testkit');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function band(i, rate) {
  const t = i / rate;
  const beat = t % 0.5;
  const kick = Math.sin(2 * Math.PI * (50 + 90 * Math.exp(-beat * 30)) * t) * Math.exp(-beat * 9) * 0.55;
  const chord = (Math.sin(2 * Math.PI * 220 * t) + Math.sin(2 * Math.PI * 277.2 * t) + Math.sin(2 * Math.PI * 329.6 * t)) * 0.07;
  const lead = Math.sin(2 * Math.PI * (440 + 110 * Math.floor((t * 2) % 4)) * t) * 0.14 * Math.exp(-(t % 0.5) * 3);
  return kick + chord + lead;
}

async function run({ getWin, cacheRoot } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stemsplit-selftest-'));
  const out = path.join(dir, 'out');
  fs.mkdirSync(out, { recursive: true });
  const ff = S.ffmpegPath();
  const results = [];
  const step = async (name, fn) => { try { results.push({ name, ok: true, detail: await fn() }); } catch (e) { results.push({ name, ok: false, error: String((e && e.message) || e) }); } };
  const near = (a, b, tol, what) => { if (!(Math.abs(a - b) <= tol)) throw new Error(`${what}: expected ${b} +/- ${tol}, got ${a}`); };
  const dec = (f, rate = 16000) => { const d = K.decode(ff, f, rate); if (d.errors) throw new Error('decode errors: ' + d.errors); return d; };
  try {
    await step('bundled ffmpeg has the encoders and filters', async () => {
      const r = await S.checkEncoders();
      if (!r.ok) throw new Error('missing: ' + r.missing.join(', '));
      return 'ok';
    });
    await step('the model file is bundled', async () => {
      const f = S.modelPath();
      if (!fs.existsSync(f)) throw new Error('missing: ' + f);
      const mb = fs.statSync(f).size / 1048576;
      if (mb < 100) throw new Error('model file too small: ' + mb.toFixed(1) + ' MB');
      return mb.toFixed(0) + ' MB';
    });

    const song = K.makeWav(path.join(dir, 'band.wav'), { rate: 44100, channels: 2, parts: [{ sec: 9, gen: band }] });
    let stems = null;
    await step('the real model separates a song into six stems that add back up to it', async () => {
      const runner = await S.createRunner();
      try {
        stems = await S.ensureStems({ source: song, root: path.join(dir, 'cache'), getRunner: async () => runner });
      } finally { await runner.release(); }
      if (stems.fromCache) throw new Error('unexpectedly cached');
      near(stems.meta.duration, 9, 0.01, 'length');
      const sum = new Float64Array(stems.meta.frames);
      for (const id of P.STEM_IDS) {
        const b = fs.readFileSync(path.join(stems.dir, id + '.wav'));
        for (let i = 0; i < stems.meta.frames; i++) sum[i] += b.readInt16LE(44 + i * 4) / 32767;
      }
      const o = fs.readFileSync(song);
      let num = 0; let den = 0;
      for (let i = 0; i < stems.meta.frames; i++) { const x = o.readInt16LE(44 + i * 4) / 32767; const d = sum[i] - x; num += d * d; den += x * x; }
      const ratio = Math.sqrt(num / den);
      if (!(ratio < 0.3)) throw new Error('stems do not add up to the song: ' + ratio.toFixed(3));
      return `${stems.meta.seconds.toFixed(1)} s, error ${(ratio * 100).toFixed(1)}%`;
    });

    for (const format of Object.keys(P.FORMATS)) {
      await step(`save a mix as ${P.FORMATS[format].label}`, async () => {
        if (!stems) throw new Error('no stems to mix');
        const r = await S.exportMix({
          dir: stems.dir, meta: stems.meta, mix: [{ id: 'vocals', gain: 1 }, { id: 'drums', gain: 1 }], format,
          output: path.join(out, 'mix' + P.FORMATS[format].ext), sourcePath: song,
        });
        const d = dec(r.output);
        near(K.seconds(d), 9, format === 'mp3' ? 0.15 : 0.04, 'length');
        return `${r.bytes} bytes`;
      });
    }

    const win = getWin && getWin();
    if (win && cacheRoot) {
      const js = (c) => win.webContents.executeJavaScript(c, true);
      const errors = [];
      win.webContents.on('console-message', (_e, level, msg) => { if (level >= 2) errors.push(msg); });
      const waitFor = async (expr, ms = 10000) => { const end = Date.now() + ms; for (;;) { if (await js(expr)) return; if (Date.now() > end) throw new Error('timed out: ' + expr); await sleep(60); } };
      await step('the window opens a song, splits it and draws the six lanes', async () => {
        await waitFor('!!window.__app');
        const r = await js(`window.ss.openPaths([${JSON.stringify(song)}])`);
        if (!r.ok) throw new Error('could not open: ' + r.error);
        await js(`void window.__app.handleOpened(${JSON.stringify(r)})`);
        await waitFor('window.__app.S.view === "ready"', 150000);
        await sleep(400);
        const probe = await js(`(()=>{const lanes=[]; for (const id of window.__app.P.STEM_IDS){ const c=document.querySelector('.lane[data-stem="'+id+'"] canvas'); const d=c.getContext('2d').getImageData(0,0,c.width,c.height).data; let hit=0; for(let i=3;i<d.length;i+=4) if(d[i]>0) hit++; lanes.push({id, w:c.width, h:c.height, cw:c.clientWidth, hit}); } return {view: window.__app.S.view, visible: document.visibilityState, win: [innerWidth, innerHeight], lanes};})()`);
        const drawn = probe.lanes.filter((l) => l.hit > l.w / 2).length;
        if (drawn !== 6) throw new Error(`only ${drawn} of 6 lanes are drawn: ${JSON.stringify(probe)}`);
        await js(`(()=>{window.__app.P.selectOnly(window.__app.S.mix, ['bass','guitar']); window.__app.applyMix();})()`);
        const label = await js('document.getElementById("summary").textContent');
        if (!/bass \+ guitar/.test(label)) throw new Error('summary: ' + label);
        if (errors.length) throw new Error('console errors: ' + errors.join(' | '));
        return 'six lanes';
      });
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return results;
}

module.exports = { run };
