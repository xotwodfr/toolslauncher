'use strict';
// `--self-test=<result.json>`: proves a PACKAGED build works. Checks the bundled ffmpeg (and that it can draw subtitles), the
// model files and the font, starts the speech model on its worker thread and listens to a clip (a spoken sentence where a
// speech voice exists - espeak-ng or the Windows voices - otherwise a plain tone, which must give no words and no error),
// burns subtitles into a small video and looks at the picture, then drives the real window: opens a video, makes subtitles
// and saves an .srt. Used by CI and by hand on the unpacked build.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const S = require('./subs');
const A = require('./audio');
const E = require('./engine');
const M = require('./media');
const SP = require('./speech');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MIN_BYTES = { 'encoder_model_int8.onnx': 80e6, 'decoder_model_merged_int8.onnx': 140e6, 'tokenizer.json': 2e6, 'config.json': 1000, 'generation_config.json': 3000 };

async function run({ getWin } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'subtitle-selftest-'));
  const results = [];
  const step = async (name, fn) => { try { results.push({ name, ok: true, detail: await fn() }); } catch (e) { results.push({ name, ok: false, error: String((e && e.message) || e) }); } };
  const speech = SP.available();
  const ff = A.ffmpegPath();
  const run_ = (args) => { const r = spawnSync(ff, ['-y', '-hide_banner', '-v', 'error', ...args], { encoding: 'utf8', windowsHide: true }); if (r.status !== 0) throw new Error('ffmpeg: ' + r.stderr.slice(0, 300)); };
  let engine = null;
  try {
    await step('bundled ffmpeg runs and can draw subtitles (libass)', async () => {
      const r = spawnSync(ff, ['-hide_banner', '-filters'], { encoding: 'utf8', windowsHide: true });
      if (r.status !== 0) throw new Error('ffmpeg did not start');
      if (!/\bsubtitles\b/.test(r.stdout)) throw new Error('this ffmpeg has no subtitles filter');
      return /ffmpeg version [^\s]+/.exec(spawnSync(ff, ['-version'], { encoding: 'utf8' }).stdout)[0];
    });
    await step('the speech model files and the font are bundled', async () => {
      const bad = [];
      for (const f of E.MODEL_FILES) { const p = path.join(E.modelDir(), f); if (!fs.existsSync(p) || fs.statSync(p).size < MIN_BYTES[f]) bad.push(f); }
      if (M.fontFiles().length !== 2) bad.push('DejaVu Sans font');
      if (bad.length) throw new Error('missing or too small: ' + bad.join(', '));
      return (E.MODEL_FILES.reduce((n, f) => n + fs.statSync(path.join(E.modelDir(), f)).size, 0) / 1048576).toFixed(0) + ' MB';
    });

    // a clip: one spoken sentence (or a tone), in a small video
    const wav = path.join(dir, 'speech.wav');
    let said = null;
    if (speech) { said = SP.SENTENCES[0]; await SP.makeClip([{ text: said, at: 1 }], 8, wav, dir); }
    else { const x = new Float32Array(16000 * 8); for (let i = 0; i < x.length; i++) x[i] = 0.3 * Math.sin((2 * Math.PI * 440 * i) / 16000); SP.writeWav(wav, x); }
    const clip = path.join(dir, 'Self Test ü.mp4');
    run_(['-f', 'lavfi', '-i', 'color=c=0x204060:s=480x270:d=8:r=15', '-i', wav, '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', clip]);

    await step('the speech model starts from the packaged app and listens to the clip', async () => {
      engine = await E.createEngine();
      const r = await E.listen(engine, clip, { language: speech ? 'auto' : 'en' });
      const cues = S.buildCues(r.segments, { language: r.language });
      if (speech) {
        const heard = cues.map((c) => c.text.replace(/\n/g, ' ')).join(' ');
        const wer = SP.wordErrorRate(said, heard);
        if (!(wer <= 0.2)) throw new Error(`heard "${heard}" (word error rate ${wer.toFixed(2)})`);
        return `${cues.length} subtitle(s): "${heard}"`;
      }
      return cues.length ? `heard ${cues.length} subtitle(s) in a plain tone` : 'a plain tone gives no words, as it should';
    });

    await step('subtitles are burnt into a video (checked on the picture)', async () => {
      const out = path.join(dir, 'burnt.mp4');
      await M.exportVideo({ ffmpeg: ff, input: clip, output: out, mode: 'burn', info: await M.probe(ff, clip), style: { size: 'large' }, cues: [{ start: 1, end: 6, text: 'Self test — ünïcödé' }] });
      const r = spawnSync(ff, ['-v', 'error', '-ss', '3', '-i', out, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], { windowsHide: true, maxBuffer: 1 << 24 });
      const px = r.stdout; let white = 0;
      for (let i = Math.floor(px.length * 0.75); i < px.length; i++) if (px[i] > 220) white++;
      if (white < 200) throw new Error('no text found in the picture');
      return `${white} white pixels in the bottom quarter`;
    });

    const win = getWin && getWin();
    if (win) {
      const js = (c) => win.webContents.executeJavaScript(c, true);
      const errors = [];
      win.webContents.on('console-message', (_e, level, msg) => { if (level >= 2) errors.push(msg); });
      const waitFor = async (expr, ms = 180000) => { const end = Date.now() + ms; for (;;) { if (await js(expr)) return; if (Date.now() > end) throw new Error('timed out: ' + expr); await sleep(150); } };
      await step('the window opens the video, makes subtitles, and saves an .srt through the window', async () => {
        await waitFor('!!window.__app');
        const opened = await js(`window.sm.openMedia(${JSON.stringify(clip)}).then((r) => { if (r.ok) void window.__app.loadMedia(r); return r.ok ? 'ok' : r.error; })`);
        if (opened !== 'ok') throw new Error('could not open: ' + opened);
        await waitFor('window.__app.S.media !== null');
        await js('void window.__app.make()');
        await waitFor('window.__app.S.working');
        await waitFor('!window.__app.S.working');
        const n = await js('window.__app.S.cues.length');
        if (speech && n < 1) throw new Error('no subtitles were made');
        if (n) {
          const out = path.join(dir, 'saved.srt');
          const { dialog } = require('electron');
          dialog.showSaveDialog = async () => ({ canceled: false, filePath: out });
          await js('window.__app.save("srt")');
          await waitFor('!document.getElementById("result").hidden', 10000);
          const parsed = S.parseSrt(fs.readFileSync(out, 'utf8'));
          if (parsed.length !== n) throw new Error('saved file does not match: ' + JSON.stringify(parsed));
        }
        if (errors.length) throw new Error('console errors: ' + errors.join(' | '));
        return `${n} subtitle(s)`;
      });
    }
  } finally {
    if (engine) { try { await engine.release(); } catch { /* ignore */ } }
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return results;
}

module.exports = { run };
