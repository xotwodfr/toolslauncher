'use strict';
// `--self-test=<result.json>`: proves a PACKAGED build works. Checks the bundled ffmpeg and the model files, starts the speech
// model on its worker thread from the packaged app and listens to a clip (a spoken sentence where Windows voices exist, otherwise
// a plain tone, which must come back with no words and no error), then opens the real window, opens a song in it, makes lyrics,
// and saves a .lrc through the window. Used by CI and by hand on the unpacked build.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const P = require('./plan');
const A = require('./audio');
const E = require('./engine');
const SP = require('./speech');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MIN_BYTES = { 'encoder_model_int8.onnx': 80e6, 'decoder_model_merged_int8.onnx': 140e6, 'tokenizer.json': 2e6, 'config.json': 1000, 'generation_config.json': 3000 };

async function run({ getWin } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lyrics-selftest-'));
  const results = [];
  const step = async (name, fn) => { try { results.push({ name, ok: true, detail: await fn() }); } catch (e) { results.push({ name, ok: false, error: String((e && e.message) || e) }); } };
  const speech = SP.available();
  let engine = null;
  try {
    await step('bundled ffmpeg runs', async () => {
      const r = spawnSync(A.ffmpegPath(), ['-hide_banner', '-version'], { encoding: 'utf8', windowsHide: true });
      if (r.status !== 0) throw new Error('ffmpeg did not start');
      return /ffmpeg version [^\s]+/.exec(r.stdout)[0];
    });
    await step('the speech model files are bundled', async () => {
      const bad = [];
      for (const f of E.MODEL_FILES) { const p = path.join(E.modelDir(), f); if (!fs.existsSync(p) || fs.statSync(p).size < MIN_BYTES[f]) bad.push(f); }
      if (bad.length) throw new Error('missing or too small: ' + bad.join(', '));
      return (E.MODEL_FILES.reduce((n, f) => n + fs.statSync(path.join(E.modelDir(), f)).size, 0) / 1048576).toFixed(0) + ' MB';
    });

    // a clip to listen to: one spoken sentence (Windows) or a tone
    const clip = path.join(dir, 'Self Test.wav');
    let said = null;
    if (speech) { said = SP.SENTENCES[0]; await SP.makeClip([{ text: said, at: 1 }], 9, clip, dir); }
    else { const x = new Float32Array(16000 * 9); for (let i = 0; i < x.length; i++) x[i] = 0.3 * Math.sin((2 * Math.PI * 440 * i) / 16000); SP.writeWav(clip, x); }

    await step('the speech model starts from the packaged app and listens to the clip', async () => {
      engine = await E.createEngine();
      const samples = await A.decode16k(A.ffmpegPath(), clip);
      const r = await engine.transcribe(samples, { language: speech ? 'auto' : 'en' });
      if (speech) {
        const heard = r.segments.map((s) => s.text).join(' ');
        const wer = SP.wordErrorRate(said, heard);
        if (!(wer <= 0.15)) throw new Error(`heard "${heard}" (word error rate ${wer.toFixed(2)})`);
        if (r.language !== 'en') throw new Error('language: ' + r.language);
        return `"${heard}"`;
      }
      return r.segments.length ? `heard ${r.segments.length} segment(s) in a plain tone` : 'a plain tone gives no words, as it should';
    });

    const win = getWin && getWin();
    if (win) {
      const js = (c) => win.webContents.executeJavaScript(c, true);
      const errors = [];
      win.webContents.on('console-message', (_e, level, msg) => { if (level >= 2) errors.push(msg); });
      const waitFor = async (expr, ms = 180000) => { const end = Date.now() + ms; for (;;) { if (await js(expr)) return; if (Date.now() > end) throw new Error('timed out: ' + expr); await sleep(150); } };
      await step('the window opens the song, makes lyrics, and saves a .lrc file through the window', async () => {
        await waitFor('!!window.__app');
        const opened = await js(`window.lm.openSong(${JSON.stringify(clip)}).then((r) => { if (r.ok) void window.__app.loadSong(r); return r.ok ? 'ok' : r.error; })`);
        if (opened !== 'ok') throw new Error('could not open: ' + opened);
        await waitFor('window.__app.S.song !== null');
        await js('void window.__app.make()');
        await waitFor('window.__app.S.working');
        await waitFor('!window.__app.S.working');
        const n = await js('window.__app.S.lines.length');
        if (speech && n < 1) throw new Error('no lines were made');
        if (speech) {
          const out = path.join(dir, 'saved.lrc');
          const { dialog } = require('electron');
          dialog.showSaveDialog = async () => ({ canceled: false, filePath: out });
          const r = await js('window.lm.save(window.__app.S.song.id, "lrc", window.__app.S.lines.map((l) => ({ start: l.start, text: l.text })))');
          if (!r.ok) throw new Error('save failed: ' + r.error);
          const parsed = P.parseLrc(fs.readFileSync(out, 'utf8'));
          if (parsed.length !== n || Math.abs(parsed[0].start - 1) > 0.6) throw new Error('saved file does not match: ' + JSON.stringify(parsed));
        }
        if (errors.length) throw new Error('console errors: ' + errors.join(' | '));
        return `${n} line(s)`;
      });
    }
  } finally {
    if (engine) { try { await engine.release(); } catch { /* ignore */ } }
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return results;
}

module.exports = { run };
