'use strict';
// End-to-end test: runs inside Electron (`npm run e2e`). Drives the REAL window with real mouse and keyboard input.
// The microphone is Chromium's fake capture device playing invented speech (see run-e2e.js), so the record flow really
// runs: getUserMedia -> AudioWorklet -> 16-bit PCM over IPC -> WAV on disk. The files are checked with ffmpeg.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const W = require('../src/wav');
const C = require('../src/clean');
const { makeSpeech } = require('../src/synth');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

exports.run = async ({ app, getWin, outFile, shotsDir, dialog, shell, folder }) => {
  const results = [];
  const errors = [];
  const win = getWin();
  const wc = win.webContents;
  const ff = C.ffmpegPath();
  const js = (code) => wc.executeJavaScript(code, true);
  wc.on('console-message', (_e, level, msg) => { if (level >= 2) errors.push(msg); });
  const step = async (name, fn) => {
    try { const detail = await fn(); results.push({ name, ok: true, detail: detail === undefined ? '' : detail }); console.log('ok   ' + name); }
    catch (e) { results.push({ name, ok: false, error: String((e && e.message) || e) }); console.log('FAIL ' + name + ': ' + ((e && e.message) || e)); }
  };
  const assert = (c, m) => { if (!c) throw new Error(m); };
  const eq = (a, b, what) => { if (a !== b) throw new Error(`${what}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); };
  const near = (a, b, tol, what) => { if (!(Math.abs(a - b) <= tol)) throw new Error(`${what}: expected ${b} +/- ${tol}, got ${a}`); };
  const waitFor = async (expr, ms = 8000, what = expr) => {
    const end = Date.now() + ms;
    for (;;) { const v = await js(expr); if (v) return v; if (Date.now() > end) throw new Error('timed out waiting for ' + what); await sleep(50); }
  };
  const shot = async (name) => {
    if (!shotsDir) return;
    fs.mkdirSync(shotsDir, { recursive: true });
    await sleep(300);
    fs.writeFileSync(path.join(shotsDir, name + '.png'), (await wc.capturePage()).toPNG());
  };
  const key = async (keyCode, char = false) => {
    wc.sendInputEvent({ type: 'keyDown', keyCode });
    if (char) wc.sendInputEvent({ type: 'char', keyCode });
    wc.sendInputEvent({ type: 'keyUp', keyCode });
    await sleep(60);
  };
  const typeText = async (text) => { for (const ch of text) await key(ch, true); };
  const box = (selector) => js(`(()=>{const e=document.querySelector(${JSON.stringify(selector)}); if(!e) return null; e.scrollIntoView({block:'nearest'}); const b=e.getBoundingClientRect(); return {x:b.x, y:b.y, w:b.width, h:b.height, cx:Math.round(b.x+b.width/2), cy:Math.round(b.y+b.height/2)};})()`);
  const clickAt = async (x, y) => {
    wc.sendInputEvent({ type: 'mouseMove', x, y });
    wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
    wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
    await sleep(120);
  };
  const click = async (selector) => { const r = await box(selector); if (!r) throw new Error('nothing to click: ' + selector); await clickAt(r.cx, r.cy); };
  const dragAcross = async (selector, f0, f1) => {
    const r = await box(selector);
    const y = Math.round(r.cy); const x0 = Math.round(r.x + r.w * f0); const x1 = Math.round(r.x + r.w * f1);
    wc.sendInputEvent({ type: 'mouseMove', x: x0, y });
    wc.sendInputEvent({ type: 'mouseDown', x: x0, y, button: 'left', clickCount: 1 });
    for (let i = 1; i <= 8; i++) { wc.sendInputEvent({ type: 'mouseMove', x: Math.round(x0 + ((x1 - x0) * i) / 8), y, modifiers: ['leftButtonDown'] }); await sleep(20); }
    wc.sendInputEvent({ type: 'mouseUp', x: x1, y, button: 'left', clickCount: 1 });
    await sleep(120);
  };
  const probe = (file) => {
    const r = spawnSync(ff, ['-hide_banner', '-i', file, '-f', 'null', '-'], { encoding: 'utf8', windowsHide: true });
    const d = /Duration: (\d+):(\d+):([\d.]+)/.exec(r.stderr); const codec = /Audio: ([a-z0-9_]+)/.exec(r.stderr); const title = /title\s*:\s*(.*)/.exec(r.stderr);
    return { ok: r.status === 0, duration: d ? +d[1] * 3600 + +d[2] * 60 + +d[3] : NaN, codec: codec && codec[1], title: title && title[1].trim(), err: r.stderr.slice(-400) };
  };

  const dir = folder();
  const trash = fs.mkdtempSync(path.join(os.tmpdir(), 'vr-e2e-trash-'));
  const trashed = [];
  shell.trashItem = async (p) => { const to = path.join(trash, path.basename(p)); fs.renameSync(p, to); trashed.push(p); };
  let saveTo = null;
  dialog.showSaveDialog = async (_w, opts) => ({ canceled: false, filePath: saveTo || opts.defaultPath });

  try {
    win.setContentSize(1240, 840);

    await step('the window opens, finds the (fake) microphone and the level meter moves; no takes yet', async () => {
      await waitFor('window.__app && window.__app.ready', 15000);
      await waitFor('window.__app.S.mic.ok', 10000, 'microphone opened');
      eq(await js('document.getElementById("rec").disabled'), false, 'Record enabled');
      eq(await js('document.getElementById("noTakes").hidden'), false, 'empty list text shown');
      eq(await js('document.getElementById("banner").hidden'), true, 'no problem banner');
      const mics = await js('[...document.querySelectorAll("#mic option")].map((o) => o.textContent)');
      assert(mics.length >= 1, 'a microphone listed');
      await waitFor('window.__app.S.levels.length > 30 && Math.max(...window.__app.S.levels) > 0.05', 8000, 'level from the fake microphone');
      const hint = await js('document.getElementById("hint").textContent');
      assert(hint.length > 5, 'a level hint is shown');
      await shot('1-ready');
      return `${mics[0]}, ${await js('window.__app.S.mic.sampleRate')} Hz, hint: "${hint}"`;
    });

    let take = null;
    await step('Record (real click), a marker with M, Pause / Resume, then Stop & save writes a WAV take', async () => {
      await click('#rec');
      await waitFor('!!window.__app.S.rec', 4000, 'recording started');
      eq(await js('document.getElementById("recState").textContent'), 'Recording', 'state chip');
      // the part file exists on disk while recording (so a crash would not lose the take)
      await sleep(1500);
      const parts = fs.readdirSync(dir).filter((n) => n.endsWith('.wav.part'));
      eq(parts.length, 1, 'one .part file while recording');
      await key('M', true);
      await waitFor('window.__app.S.rec.markers.length === 1', 3000, 'marker added');
      await sleep(800);
      await click('#pause');
      await waitFor('window.__app.S.rec.paused', 3000, 'paused');
      const t1 = await js('window.__app.S.rec.frames / window.__app.S.mic.sampleRate');
      await sleep(1000);
      const t2 = await js('window.__app.S.rec.frames / window.__app.S.mic.sampleRate');
      near(t2, t1, 0.001, 'timer frozen while paused');
      eq(await js('document.getElementById("mark").disabled'), true, 'no markers while paused');
      await key(' ', true); // Space resumes
      await waitFor('!window.__app.S.rec.paused', 3000, 'resumed');
      await sleep(1500);
      const recorded = await js('window.__app.S.rec.frames / window.__app.S.mic.sampleRate');
      await click('#stop');
      await waitFor('!window.__app.S.rec && window.__app.S.takes.length === 1', 6000, 'take saved');
      take = await js('window.__app.S.takes[0]');
      assert(/^\d{4}-\d\d-\d\d \d\d\.\d\d\.\d\d\.wav$/.test(take.name), 'dated name: ' + take.name);
      near(take.duration, recorded, 0.3, 'take length');
      assert(take.duration > 3 && take.duration < 7, 'about four seconds: ' + take.duration);
      eq(take.markers.length, 1, 'marker stored in the file');
      const f = path.join(dir, take.name);
      const p = probe(f);
      assert(p.ok, p.err); near(p.duration, take.duration, 0.05, 'ffmpeg duration');
      eq(fs.readdirSync(dir).filter((n) => n.endsWith('.part')).length, 0, 'no .part left');
      // there was sound in it (the fake microphone's speech), not silence
      let peak = 0; W.readMono(f, (b) => { for (const v of b) peak = Math.max(peak, Math.abs(v)); });
      assert(peak > 0.05, 'audio recorded, peak ' + peak);
      await waitFor('!document.getElementById("editor").hidden && !!window.__app.S.info', 6000, 'the new take opens');
      await shot('2-recorded');
      return `${take.duration.toFixed(2)} s, marker at ${take.markers[0].t.toFixed(2)} s, peak ${peak.toFixed(2)}`;
    });

    await step('typing a title renames the file (the date stays in front)', async () => {
      await click('#title');
      await typeText('Café notes ✓');
      await key('Return');
      await waitFor('window.__app.S.takes[0].title === "Café notes ✓"', 4000, 'renamed');
      const name = await js('window.__app.S.current');
      assert(name.endsWith(' - Café notes ✓.wav'), name);
      assert(fs.existsSync(path.join(dir, name)), 'renamed file on disk');
      eq(await js('document.querySelector("#takeList .item.sel .t").textContent'), 'Café notes ✓', 'list shows the title');
      take = await js('window.__app.S.takes[0]');
      return name;
    });

    await step('drag on the waveform selects a part; "Learn noise here" and "Trim to selection" use it', async () => {
      await dragAcross('#wave', 0.05, 0.25);
      const sel = await js('window.__app.S.sel');
      assert(sel && sel.end - sel.start > 0.3, 'selection ' + JSON.stringify(sel));
      eq(await js('document.getElementById("selNoise").disabled'), false, 'buttons on');
      await click('#selNoise');
      const ns = await js(`window.__app.optsFor(window.__app.S.current).denoise.sample`);
      near(ns.start, sel.start, 0.01, 'noise sample start');
      assert(/your pick/.test(await js('document.getElementById("nrFrom").textContent')), 'shows where the noise is learned from');
      await dragAcross('#wave', 0.02, 0.96);
      await click('#selTrim');
      const tr = await js(`window.__app.optsFor(window.__app.S.current).trim`);
      assert(tr && tr.start > 0 && tr.end < take.duration, 'trim set ' + JSON.stringify(tr));
      eq(await js('document.getElementById("trimOn").checked'), true, 'trim switch on');
      return `noise ${ns.start.toFixed(2)}-${ns.end.toFixed(2)} s, trim ${tr.start.toFixed(2)}-${tr.end.toFixed(2)} s`;
    });

    await step('switching options by clicking, then Preview renders the cleaned part and A/B switches between them', async () => {
      if (!(await js('document.getElementById("psOn").checked'))) await click('#psOn');
      eq(await js('window.__app.optsFor(window.__app.S.current).pauses.on'), true, 'pauses switch read');
      await click('#preview');
      await waitFor('!!window.__app.S.preview', 20000, 'preview ready');
      eq(await js('window.__app.S.listen'), 'B', 'listening to the cleaned preview');
      eq(await js('document.getElementById("abB").disabled'), false, 'B enabled');
      assert(/^vr:\/\/preview\//.test(await js('document.getElementById("player").src')), 'player plays the preview');
      await waitFor('document.getElementById("player").readyState >= 1', 5000, 'preview loads in the player');
      const dur = await js('document.getElementById("player").duration');
      near(dur, await js('window.__app.S.preview.duration'), 0.15, 'preview duration');
      await click('#abA');
      eq(await js('window.__app.S.listen'), 'A', 'back to the original');
      assert(/^vr:\/\/take\//.test(await js('document.getElementById("player").src')), 'player plays the take');
      await waitFor('document.getElementById("player").readyState >= 1', 5000, 'take loads in the player');
      // a settings change re-renders the preview by itself
      const before = await js('window.__app.S.preview.url');
      await click('#ldTarget');
      await js('(() => { const s = document.getElementById("ldTarget"); s.value = "-19"; s.dispatchEvent(new Event("change")); })()');
      await key('Escape');
      await waitFor(`window.__app.S.preview && window.__app.S.preview.url !== ${JSON.stringify(before)}`, 20000, 'preview updated');
      await shot('3-preview');
      return await js('document.getElementById("pvInfo").textContent');
    });

    await step('Export as MP3 writes a cleaned, levelled file with the title; Show in folder is offered', async () => {
      await js('(() => { const s = document.getElementById("format"); s.value = "mp3"; s.dispatchEvent(new Event("change")); })()');
      await click('#export');
      await waitFor('!document.getElementById("result").hidden', 60000, 'export finished');
      const text = await js('document.getElementById("resultText").textContent');
      assert(/^Saved/.test(text), text);
      eq(await js('document.getElementById("resultReveal").hidden'), false, 'Show in folder button');
      const outDir = path.join(dir, 'Exported');
      const files = fs.readdirSync(outDir);
      eq(files.length, 1, 'one export'); assert(files[0].endsWith(' - Café notes ✓.mp3'), files[0]);
      const p = probe(path.join(outDir, files[0]));
      assert(p.ok, p.err); eq(p.codec, 'mp3', 'codec'); eq(p.title, 'Café notes ✓', 'title tag');
      const o = await js('window.__app.optsFor(window.__app.S.current)');
      assert(p.duration < o.trim.end - o.trim.start + 0.15, 'trimmed: ' + p.duration);
      const m = await C.loudnessOf(path.join(outDir, files[0]));
      near(m.i, -19, 1, 'loudness of the MP3');
      return `${files[0]}, ${p.duration.toFixed(2)} s, ${m.i} LUFS`;
    });

    await step('exporting again never overwrites: the second export gets "(2)"', async () => {
      await js('(() => { const s = document.getElementById("format"); s.value = "mp3"; s.dispatchEvent(new Event("change")); })()');
      await click('#export');
      await waitFor('/^Saved/.test(document.getElementById("resultText").textContent) && /\\(2\\)/.test(document.getElementById("resultText").textContent)', 60000, 'second export');
      return fs.readdirSync(path.join(dir, 'Exported')).sort().join(' | ');
    });

    await step('Cancel stops a long export and leaves nothing behind', async () => {
      // a long invented take put into the folder (it shows up as a take after a refresh)
      const long = makeSpeech({ phrases: Array(60).fill(3), pauses: Array(60).fill(0.6), noise: 0.004, seed: 9 });
      W.writeFloatWav(path.join(dir, '2026-01-15 10.00.00 - Long talk.wav'), long.samples, long.sampleRate);
      await js('window.vr.list().then((r) => { window.__app.S.takes = r.takes; })');
      eq(await js('window.__app.S.takes.length'), 2, 'the long take is listed');
      await js('window.__app.openTake("2026-01-15 10.00.00 - Long talk.wav")');
      await waitFor('!!window.__app.S.info && window.__app.S.info.duration > 200', 10000, 'long take open');
      for (const id of ['nrOn', 'dcOn', 'ldOn']) if (!(await js(`document.getElementById("${id}").checked`))) await click('#' + id);
      await js('(() => { const s = document.getElementById("format"); s.value = "flac"; s.dispatchEvent(new Event("change")); })()');
      await click('#export');
      await waitFor('!document.getElementById("xbar").hidden', 3000, 'progress shown');
      await sleep(400);
      await click('#xcancel');
      await waitFor('/cancelled/.test(document.getElementById("resultText").textContent)', 10000, 'cancelled message');
      const left = fs.readdirSync(path.join(dir, 'Exported')).filter((n) => /Long talk/.test(n));
      eq(left.length, 0, 'no file or .part left: ' + left.join(','));
      return 'cancelled';
    });

    await step('an unfinished take (as after a crash) is recovered at start-up and listed as "recovered"', async () => {
      const part = path.join(dir, '2026-02-03 04.05.06.wav.part');
      const pcm = W.floatToInt16(makeSpeech({ phrases: [2], pauses: [0.5], seed: 4 }).samples);
      fs.writeFileSync(part, Buffer.concat([W.header({ sampleRate: 48000, dataBytes: 0 }), pcm]));
      const r = await js('window.vr.init()');
      eq(r.recovered.length, 1, 'recovered: ' + JSON.stringify(r.recovered));
      eq(r.recovered[0].name, '2026-02-03 04.05.06 (recovered).wav', 'name');
      const t = r.takes.find((x) => x.recovered);
      assert(t, 'listed'); near(t.duration, 3, 0.01, 'duration');
      assert(!fs.existsSync(part), 'part file gone');
      return t.name;
    });

    await step('Delete moves the take to the Recycle Bin (after asking)', async () => {
      await js('window.vr.list().then((r) => { window.__app.S.takes = r.takes; })');
      const name = await js('window.__app.S.takes.find((t) => t.title === "Café notes ✓").name');
      await js(`window.__app.openTake(${JSON.stringify(name)})`);
      await waitFor('!!window.__app.S.info', 5000);
      await js('window.confirm = () => true; 1');
      await click('#delete');
      await waitFor(`!window.__app.S.takes.some((t) => t.name === ${JSON.stringify(name)})`, 5000, 'gone from the list');
      eq(trashed.length, 1, 'trashItem called once');
      assert(!fs.existsSync(path.join(dir, name)) && fs.existsSync(path.join(trash, name)), 'moved, not destroyed');
      eq(await js('document.getElementById("editor").hidden'), true, 'editor closed');
      return name;
    });

    await step('no errors in the window console', async () => { if (errors.length) throw new Error(errors.join(' | ')); });
  } catch (e) {
    results.push({ name: 'e2e crashed', ok: false, error: String((e && e.stack) || e) });
  }
  try { fs.rmSync(trash, { recursive: true, force: true }); } catch { /* ignore */ }
  const ok = results.every((r) => r.ok);
  fs.writeFileSync(outFile, JSON.stringify({ ok, results }, null, 2));
  app.exit(ok ? 0 : 1);
};
