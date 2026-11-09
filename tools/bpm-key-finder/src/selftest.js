'use strict';
// `--self-test=<result.json>`: proves a PACKAGED build works. Checks the bundled ffmpeg, analyses invented songs of known tempo
// and key on a worker thread (so it proves the worker starts from the packaged app), writes and reads tags in several formats,
// then opens the real window, adds a song in it and checks the answer is shown. Used by CI and by hand on the unpacked build.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const M = require('./music');
const T = require('./tags');
const { Pool, ffmpegPath } = require('./pool');
const { makeSong, writeWav } = require('./synth');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function run({ getWin } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bpmkey-selftest-'));
  const ff = ffmpegPath();
  const results = [];
  const step = async (name, fn) => { try { results.push({ name, ok: true, detail: await fn() }); } catch (e) { results.push({ name, ok: false, error: String((e && e.message) || e) }); } };
  const near = (a, b, tol, what) => { if (!(Math.abs(a - b) <= tol)) throw new Error(`${what}: expected ${b} +/- ${tol}, got ${a}`); };
  const convert = (src, dst, extra = []) => { const r = spawnSync(ff, ['-y', '-hide_banner', '-v', 'error', '-i', src, ...extra, dst], { encoding: 'utf8', windowsHide: true }); if (r.status !== 0) throw new Error('ffmpeg: ' + r.stderr); };
  const pool = new Pool({ size: 2 });
  try {
    await step('bundled ffmpeg runs and can read and write the formats', async () => {
      const r = spawnSync(ff, ['-hide_banner', '-version'], { encoding: 'utf8', windowsHide: true });
      if (r.status !== 0) throw new Error('ffmpeg did not start');
      return /ffmpeg version [^\s]+/.exec(r.stdout)[0];
    });

    const song = writeWav(path.join(dir, 'Self Test.wav'), makeSong({ bpm: 132, tonic: 7, mode: 'minor', seconds: 24, seed: 77 }));
    await step('a worker thread analyses a song: tempo and key are right', async () => {
      const r = await pool.run(song);
      near(r.bpm, 132, 0.6, 'BPM');
      if (!r.key || r.key.name !== 'Gm') throw new Error('key: expected Gm, got ' + (r.key && r.key.name));
      return `${r.bpm.toFixed(1)} BPM, ${r.key.name}`;
    });

    await step('tags are written and read back in FLAC, MP3 and WAV, and the other tags survive', async () => {
      const out = [];
      for (const ext of ['flac', 'mp3', 'wav']) {
        const f = path.join(dir, 'tag.' + ext);
        if (ext === 'wav') fs.copyFileSync(song, f); else convert(song, f, ['-metadata', 'title=Kept']);
        const after = T.writeTags(f, { bpm: 132, key: 'Gm' });
        if (after.tagBpm !== 132 || after.tagKey !== 'Gm') throw new Error(ext + ': read back ' + JSON.stringify(after));
        if (ext !== 'wav' && T.readTags(f).title !== 'Kept') throw new Error(ext + ': lost the title');
        out.push(ext);
      }
      return out.join(', ');
    });

    await step('the key names convert between musical, Camelot and Open Key', async () => {
      const k = { tonic: 7, mode: 'minor' };
      if (M.keyName(k) !== 'Gm' || M.keyName(k, 'camelot') !== '6A' || M.keyName(k, 'openkey') !== '11m') throw new Error('names: ' + [M.keyName(k), M.keyName(k, 'camelot'), M.keyName(k, 'openkey')]);
      return 'Gm = 6A = 11m';
    });

    const win = getWin && getWin();
    if (win) {
      const js = (c) => win.webContents.executeJavaScript(c, true);
      const errors = [];
      win.webContents.on('console-message', (_e, level, msg) => { if (level >= 2) errors.push(msg); });
      const waitFor = async (expr, ms = 30000) => { const end = Date.now() + ms; for (;;) { if (await js(expr)) return; if (Date.now() > end) throw new Error('timed out: ' + expr); await sleep(80); } };
      await step('the window adds a song, analyses it and shows the tempo and key', async () => {
        await waitFor('!!window.__app');
        const res = await js(`window.bk.addPaths([${JSON.stringify(song)}])`);
        if (!res.rows || res.rows.length !== 1) throw new Error('could not add: ' + JSON.stringify(res));
        await js(`void window.__app.addRows(${JSON.stringify(res)})`);
        await waitFor('window.__app.S.rows.length === 1 && window.__app.S.rows[0].status === "done"');
        const shown = await js('({ bpm: document.querySelector("input.bpm").value, key: document.querySelector("select.key").selectedOptions[0].textContent, chips: document.querySelectorAll(".sure").length })');
        near(parseFloat(shown.bpm), 132, 0.6, 'BPM shown');
        if (!/^Gm/.test(shown.key)) throw new Error('key shown: ' + shown.key);
        if (shown.chips !== 2) throw new Error('confidence chips: ' + shown.chips);
        if (errors.length) throw new Error('console errors: ' + errors.join(' | '));
        return `${shown.bpm} BPM, ${shown.key}`;
      });
    }
  } finally {
    pool.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return results;
}

module.exports = { run };
