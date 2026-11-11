'use strict';
// `--self-test=<result.json>`: proves a PACKAGED build works. Checks the bundled ffmpeg, makes a real and a fake lossless file
// from scratch (noise; the fake goes through MP3 and back), inspects them on the worker threads of the packaged app, then
// drives the real window: adds the files, waits for the verdicts and saves a CSV. Used by CI and by hand on the unpacked build.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const G = require('./signals');
const { Pool, ffmpegPath } = require('./pool');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function run({ getWin } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inspector-selftest-'));
  const results = [];
  const step = async (name, fn) => { try { results.push({ name, ok: true, detail: await fn() }); } catch (e) { results.push({ name, ok: false, error: String((e && e.message) || e) }); } };
  const ff = ffmpegPath();
  const ffm = (args) => { const r = spawnSync(ff, ['-y', '-hide_banner', '-v', 'error', ...args], { encoding: 'utf8', windowsHide: true }); if (r.status !== 0) throw new Error('ffmpeg: ' + r.stderr.slice(0, 300)); };
  try {
    await step('bundled ffmpeg runs (with the MP3 encoder the test needs)', async () => {
      const r = spawnSync(ff, ['-hide_banner', '-version'], { encoding: 'utf8', windowsHide: true });
      if (r.status !== 0) throw new Error('ffmpeg did not start');
      return /ffmpeg version [^\s]+/.exec(r.stdout)[0];
    });
    const n = 44100 * 6;
    const wav = G.writeWav(path.join(dir, 'noise.wav'), [G.white(n, 0.18, 1), G.white(n, 0.18, 2)], 44100, 16);
    const real = path.join(dir, 'Real ü.flac'); ffm(['-i', wav, real]);
    const mp3 = path.join(dir, 'x.mp3'); ffm(['-i', wav, '-b:a', '128k', mp3]);
    const fake = path.join(dir, 'Fake ü.flac'); ffm(['-i', mp3, '-sample_fmt', 's16', fake]);

    await step('the worker threads inspect a real and a fake lossless file correctly', async () => {
      const pool = new Pool({ size: 2 });
      try {
        const [a, b] = await Promise.all([pool.run(real), pool.run(fake)]);
        if (a.verdict.kind !== 'real') throw new Error('real file: ' + a.verdict.title);
        if (b.verdict.kind !== 'fake') throw new Error('fake file: ' + b.verdict.title);
        return `${a.verdict.chip}; ${b.verdict.chip} (${b.verdict.explain})`;
      } finally { pool.close(); }
    });

    const win = getWin && getWin();
    if (win) {
      const js = (c) => win.webContents.executeJavaScript(c, true);
      const errors = [];
      win.webContents.on('console-message', (_e, level, msg) => { if (level >= 2) errors.push(msg); });
      const waitFor = async (expr, ms = 60000) => { const end = Date.now() + ms; for (;;) { if (await js(expr)) return; if (Date.now() > end) throw new Error('timed out: ' + expr); await sleep(100); } };
      await step('the window inspects the files, draws the spectrogram and saves a CSV', async () => {
        await waitFor('!!window.__app');
        await js(`window.ai.addPaths(${JSON.stringify([real, fake])}).then((r) => { void window.__app.added(r); })`);
        await waitFor('window.__app.S.rows.length === 2 && window.__app.S.rows.every((r) => r.status === "done")');
        const kinds = await js('window.__app.S.rows.map((r) => r.verdict.kind).join(",")');
        if (kinds !== 'real,fake') throw new Error('verdicts in the window: ' + kinds);
        await js(`window.__app.select(window.__app.S.rows[1].id)`);
        await waitFor('window.__app.S.detail && window.__app.S.detail.verdict.kind === "fake"', 10000);
        const out = path.join(dir, 'report.csv');
        const { dialog } = require('electron');
        dialog.showSaveDialog = async () => ({ canceled: false, filePath: out });
        const r = await js('window.ai.saveReport("csv", window.__app.S.rows.map((x) => x.id))');
        if (!r.ok) throw new Error('save failed: ' + r.error);
        const csv = fs.readFileSync(out, 'utf8');
        if (!/Fake lossless/.test(csv) || !/Real lossless/.test(csv)) throw new Error('CSV does not hold the verdicts');
        if (errors.length) throw new Error('console errors: ' + errors.join(' | '));
        return 'ok';
      });
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return results;
}

module.exports = { run };
