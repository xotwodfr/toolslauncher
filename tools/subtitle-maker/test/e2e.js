'use strict';
// End-to-end test: runs inside Electron (`npm run e2e`). Drives the REAL window with real mouse and keyboard input: opens a
// video whose speech is known (spoken by espeak-ng or a Windows voice), makes subtitles with the REAL Whisper model, plays
// them over the picture, edits them every way the window offers, saves .srt and .vtt and reads them back, opens an .srt,
// burns the subtitles into a new MP4 (and looks at its picture), adds a subtitle track, and cancels both kinds of work.
// Without a speech voice, the model steps are skipped and the rest runs on opened subtitles.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const S = require('../src/subs');
const A = require('../src/audio');
const SP = require('../src/speech');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

exports.run = async ({ app, getWin, outFile, shotsDir, dialog, shell, engineLoaded }) => {
  const results = [];
  const errors = [];
  const notes = {};
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'subtitle-e2e-'));
  const ff = A.ffmpegPath();
  const win = getWin();
  const wc = win.webContents;
  const js = (code) => wc.executeJavaScript(code, true);
  wc.on('console-message', (_e, level, msg) => { if (level >= 2 && !/Autofill/.test(msg)) errors.push(msg); });
  const step = async (name, fn) => {
    try { const detail = await fn(); results.push({ name, ok: true, detail: detail === undefined ? '' : detail }); console.log('ok   ' + name); }
    catch (e) { results.push({ name, ok: false, error: String((e && e.message) || e) }); console.log('FAIL ' + name + ': ' + ((e && e.message) || e)); }
  };
  const assert = (c, m) => { if (!c) throw new Error(m); };
  const eq = (a, b, what) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${what}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); };
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
  const key = async (keyCode, modifiers = [], char = false) => {
    wc.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
    if (char) wc.sendInputEvent({ type: 'char', keyCode: char === true ? keyCode : char, modifiers });
    wc.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
    await sleep(40);
  };
  const typeText = async (text) => { for (const ch of text) await key(ch === ' ' ? 'Space' : ch, [], ch); };
  const center = (selector) => js(`(()=>{const e=document.querySelector(${JSON.stringify(selector)}); if(!e) return null; e.scrollIntoView({block:'nearest'}); const b=e.getBoundingClientRect(); return {x:Math.round(b.x+b.width/2), y:Math.round(b.y+b.height/2)};})()`);
  const clickAt = async (x, y) => {
    wc.sendInputEvent({ type: 'mouseMove', x, y });
    wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
    wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
    await sleep(90);
  };
  const click = async (selector) => { const r = await center(selector); if (!r) throw new Error('nothing to click: ' + selector); await clickAt(r.x, r.y); };
  const cues = () => js('window.__app.S.cues.map((c) => ({ start: c.start, end: c.end, text: c.text }))');
  const rowCount = () => js('document.querySelectorAll("#cues .cue").length');
  const ffmpeg = (args) => { const r = spawnSync(ff, ['-y', '-hide_banner', '-v', 'error', ...args], { encoding: 'utf8', windowsHide: true }); if (r.status !== 0) throw new Error('ffmpeg: ' + r.stderr); };
  const whiteBottom = (file, t, w, h) => {
    const r = spawnSync(ff, ['-v', 'error', '-ss', String(t), '-i', file, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], { windowsHide: true, maxBuffer: 1 << 26 });
    let white = 0; const from = Math.floor(h * 0.72) * w;
    for (let i = from; i < r.stdout.length; i++) if (r.stdout[i] > 220) white++;
    return white / (r.stdout.length - from);
  };
  const speech = SP.available();

  try {
    win.setContentSize(1240, 840);
    // test material: a video with three spoken sentences at known times (or a tone without a voice), a sound-only file,
    // a longer video for cancelling, a junk file and an .srt from "another program"
    const at = [1.0, 9.0, 17.0];
    const wav = path.join(dir, 'speech.wav');
    if (speech) await SP.makeClip(SP.SENTENCES.slice(0, 3).map((text, i) => ({ text, at: at[i], voice: i % 2 ? 'Microsoft Zira Desktop' : 'Microsoft David Desktop' })), 26, wav, dir);
    else { const x = new Float32Array(16000 * 26); for (let i = 0; i < x.length; i++) x[i] = 0.2 * Math.sin((2 * Math.PI * 300 * i) / 16000); SP.writeWav(wav, x); }
    const video = path.join(dir, 'Holiday Clip ü.mp4');
    ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=s=640x360:d=26:r=25', '-i', wav, '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', video]);
    const audioOnly = path.join(dir, 'Voice memo.m4a');
    ffmpeg(['-i', wav, '-t', '6', '-c:a', 'aac', audioOnly]);
    const long = path.join(dir, 'Long film.mp4');
    ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=s=1280x720:d=90:r=30', '-f', 'lavfi', '-i', 'sine=d=90', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-shortest', long]);
    const junk = path.join(dir, 'Broken.mp4'); fs.writeFileSync(junk, Buffer.alloc(6000, 4));
    const imported = path.join(dir, 'From elsewhere.srt');
    fs.writeFileSync(imported, '﻿1\r\n00:00:01,000 --> 00:00:04,000\r\nImported first line\r\n\r\n2\r\n00:00:05,500 --> 00:00:08,250\r\n<i>Zweite Zeile</i>, ünïcödé\r\nand a second line\r\n\r\n3\r\n00:00:09,000 --> 00:00:09,400\r\nWay too fast for anybody to read this\r\n');
    let openReturn = video; let saveTo = null; let subsReturn = imported;
    dialog.showOpenDialog = async (_w, o) => ({ canceled: false, filePaths: [/subtitles/i.test(o.title) ? subsReturn : openReturn] });
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: saveTo });
    shell.trashItem = async (p) => { fs.renameSync(p, p + '.trashed'); };
    await js('void (window.__confirmAnswer = true, window.confirm = () => window.__confirmAnswer)');

    await step('the window starts empty with the drop zone, and nothing can be saved yet', async () => {
      await waitFor('!!window.__app');
      eq(await js('document.getElementById("empty").hidden'), false, 'drop zone shown');
      eq(await js('document.getElementById("work").hidden'), true, 'work area hidden');
      assert(await js('document.getElementById("engineWarn").hidden') || /memory/.test(await js('document.getElementById("engineWarn").textContent')), 'no engine problem');
      await shot('1-empty');
    });

    await step('a file that is not a video is refused in plain words', async () => {
      openReturn = junk;
      await click('#open2');
      await waitFor('!document.getElementById("toast").hidden', 8000, 'toast');
      assert(/could not be read/.test(await js('document.getElementById("toast").textContent')), 'message: ' + await js('document.getElementById("toast").textContent'));
      eq(await js('window.__app.S.media'), null, 'nothing opened');
    });

    await step('Open video… (real click): the video plays in the window, with its size and length, and Make is ready', async () => {
      openReturn = video;
      await click('#open2');
      await waitFor('window.__app.S.media && window.__app.S.media.name === "Holiday Clip ü.mp4"', 10000, 'video opened');
      eq(await js('document.getElementById("work").hidden'), false, 'work area shown');
      eq(await js('document.getElementById("makeSet").disabled'), false, 'Make enabled');
      eq(await js('document.getElementById("saveSet").disabled'), true, 'nothing to save yet');
      eq(await js('document.getElementById("videoSet").disabled'), true, 'nothing to burn yet');
      assert(/Holiday Clip ü\.mp4 · 0:26 · 640×360/.test(await js('document.getElementById("fileInfo").textContent')), 'file info: ' + await js('document.getElementById("fileInfo").textContent'));
      await waitFor('document.getElementById("player").readyState >= 2', 10000, 'video loaded through subs://');
      eq(await js('document.getElementById("player").videoWidth'), 640, 'the picture decodes');
      eq(await js('document.getElementById("noPicture").hidden'), true, 'no "sound only" note');
    });

    if (speech) {
      await step('Make subtitles, then Cancel (real clicks): it stops, and nothing is kept', async () => {
        await click('#make');
        await waitFor('window.__app.S.working', 4000, 'working');
        eq(await js('document.getElementById("progressBox").hidden'), false, 'progress shown');
        await click('#cancel');
        await waitFor('!window.__app.S.working', 30000, 'stopped');
        eq(await js('window.__app.S.cues.length'), 0, 'no subtitles kept');
        assert(/Stopped/.test(await js('document.getElementById("toast").textContent')), 'told it stopped');
      });

      await step('Make subtitles (real click): progress, subtitles stream in, then they match what was said, at the right times, within the rules', async () => {
        await click('#make');
        await waitFor('window.__app.S.working', 4000, 'working');
        eq(await js('document.getElementById("makeSet").disabled'), true, 'Make locked meanwhile');
        await waitFor('/Starting|Reading|Listening/.test(document.getElementById("phase").textContent)', 10000, 'phase text');
        await shot('2-working');
        const t0 = Date.now();
        await waitFor('!window.__app.S.working', 180000, 'finished');
        notes.makeSeconds = Number(((Date.now() - t0) / 1000).toFixed(1));
        const got = await cues();
        assert(got.length >= 3, 'at least three subtitles: ' + JSON.stringify(got));
        const heard = got.map((c) => c.text.replace(/\n/g, ' ')).join(' ');
        const wer = SP.wordErrorRate(SP.SENTENCES.slice(0, 3).join(' '), heard);
        notes.wer = Number(wer.toFixed(3));
        assert(wer <= 0.2, `word error rate ${wer.toFixed(2)}: "${heard}"`);
        near(got[0].start, at[0], 0.6, 'first subtitle');
        near(got.find((c) => /walked/i.test(c.text)).start, at[1], 0.6, 'second sentence');
        near(got.find((c) => /hold on|little/i.test(c.text)).start, at[2], 0.6, 'third sentence');
        for (const c of got) { assert(c.text.split('\n').length <= 2 && c.text.split('\n').every((l) => l.length <= 42), 'two lines of 42 at most: ' + c.text); assert(c.end - c.start <= 7.001, 'at most 7 s'); }
        eq(await rowCount(), got.length, 'one row per subtitle');
        assert(/English \(detected\)/.test(await js('document.getElementById("status").textContent')), 'language shown: ' + await js('document.getElementById("status").textContent'));
        eq(await js('document.getElementById("saveSet").disabled'), false, 'saving unlocked');
        eq(await js('document.getElementById("videoSet").disabled'), false, 'video export unlocked');
        await shot('3-made');
      });

      await step('▶ on a subtitle (real click) plays from it, its text is drawn over the picture, its row is highlighted; Space pauses', async () => {
        const list = await cues();
        const i = list.findIndex((c) => /walked/i.test(c.text));
        await click(`#cues .cue:nth-child(${i + 1}) .go`);
        await waitFor('!document.getElementById("player").paused', 5000, 'playing');
        await sleep(700);
        const ov = await js('document.getElementById("overlay").textContent');
        assert(/walked/i.test(ov), 'overlay shows the subtitle: ' + ov);
        eq(await js('[...document.querySelectorAll("#cues .cue")].findIndex((r) => r.classList.contains("now"))'), i, 'row highlighted');
        await js('document.activeElement && document.activeElement.blur()');
        await key('Space');
        await waitFor('document.getElementById("player").paused', 3000, 'paused by Space');
      });

      await step('the model is let go after a while of not being used (its memory is given back)', async () => {
        await waitFor('true', 100);
        const end = Date.now() + 15000;
        while (engineLoaded() && Date.now() < end) await sleep(200);
        assert(!engineLoaded(), 'the model was released when idle');
      });
    } else {
      results.push({ name: 'making subtitles with the real model needs a speech voice (espeak-ng or Windows) for a spoken test video', ok: true, detail: 'skipped on this system' });
      subsReturn = imported;
      await click('#importSubs');
      await waitFor('window.__app.S.cues.length === 3', 8000, 'imported to have something to edit');
    }

    await step('typing in a subtitle (real keys) changes it, its reading speed and the picture at once; Ctrl+Z undoes it', async () => {
      const before = await cues();
      await js('document.getElementById("player").currentTime = ' + (before[0].start + 0.3));
      await sleep(300);
      await click('#cues .cue:nth-child(1) .text');
      await key('End', ['control']);
      await typeText(' Yes!');
      const after = await cues();
      eq(after[0].text, before[0].text + ' Yes!', 'text');
      assert(/Yes!/.test(await js('document.getElementById("overlay").textContent')), 'overlay follows the edit');
      const cps = Number(await js('document.querySelector("#cues .cue:nth-child(1) .cps").textContent'));
      near(cps, S.cps(after[0]), 0.6, 'reading speed updated');
      await js('document.activeElement.blur()');
      await key('z', ['control']);
      eq((await cues())[0].text, before[0].text, 'undone');
      assert(/edited/.test(await js('document.getElementById("status").textContent')), 'marked edited');
    });

    await step('typing a start time (real keys) moves the subtitle and keeps the list in order; a nonsense time is refused', async () => {
      const before = await cues();
      await click('#cues .cue:nth-child(1) .start');
      await key('a', ['control']);
      await typeText('0:00.250');
      await key('Enter');
      await sleep(150);
      eq((await cues())[0].start, 0.25, 'new start');
      await click('#cues .cue:nth-child(1) .end');
      await key('a', ['control']);
      await typeText('soon');
      await key('Enter');
      await sleep(150);
      eq((await cues())[0].end, before[0].end, 'end unchanged');
      assert(/Type a time/.test(await js('document.getElementById("toast").textContent')), 'explained');
    });

    await step('split (✂), merge (⇣), delete (×) and Undo (real clicks) change the list as they should', async () => {
      const before = await cues();
      const n = before.length;
      await click('#cues .cue:nth-child(1) .split');
      eq(await rowCount(), n + 1, 'split in two');
      const sp = await cues();
      eq((sp[0].text + ' ' + sp[1].text).replace(/\n/g, ' '), before[0].text.replace(/\n/g, ' '), 'no word lost');
      assert(sp[0].end < sp[1].start, 'a gap between the halves');
      await click('#cues .cue:nth-child(1) .merge');
      eq(await rowCount(), n, 'merged back');
      eq((await cues())[0].text.replace(/\n/g, ' '), before[0].text.replace(/\n/g, ' '), 'same words');
      await click(`#cues .cue:nth-child(${n}) .del`);
      eq(await rowCount(), n - 1, 'deleted');
      await click('#undo'); await click('#undo'); await click('#undo');
      eq(await cues(), before, 'three undos give the list back');
    });

    await step('Shift all +1 s and −1 s (real clicks) move every subtitle; [ and ] (real keys) stamp the selected one at the playhead', async () => {
      const before = await cues();
      await click('[data-shift="1"]');
      eq((await cues()).map((c) => c.start), before.map((c) => Math.round((c.start + 1) * 1000) / 1000), 'all later');
      await click('[data-shift="-1"]');
      eq(await cues(), before, 'and back');
      await click('#cues .cue:nth-child(2) .n');
      await js('document.getElementById("player").currentTime = 8.5; void 0');
      await sleep(200);
      await key('[', [], '[');
      const after = await cues();
      const moved = after.find((c) => c.text === before[1].text);
      eq(moved.start, 8.5, 'start stamped');
      await js(`document.getElementById("player").currentTime = ${moved.start + 2.2}; void 0`);
      await sleep(200);
      await key(']', [], ']');
      near((await cues()).find((c) => c.text === before[1].text).end, moved.start + 2.2, 0.01, 'end stamped');
    });

    await step('N (real key) adds a subtitle at the playhead and puts the cursor in it; the new text is typed in', async () => {
      const n = (await cues()).length;
      await js('document.getElementById("player").currentTime = 24.0; void 0');
      await sleep(150);
      await js('document.activeElement && document.activeElement.blur()');
      await key('n', [], 'n');
      await sleep(150);
      eq((await cues()).length, n + 1, 'one more');
      await typeText('The end.');
      const c = (await cues()).find((x) => x.text === 'The end.');
      assert(c, 'typed into the new subtitle');
      eq(c.start, 24, 'at the playhead');
      assert(c.end > 24 && c.end <= 26.01, 'ends within the video');
      await js('document.activeElement.blur()');
    });

    await step('Save .srt and .vtt (real clicks): the files hold exactly the subtitles in the window; replacing keeps a .bak', async () => {
      const want = (await cues()).filter((c) => c.text.trim());
      saveTo = path.join(dir, 'Holiday Clip ü.srt');
      await click('#saveSrt');
      await waitFor('/Saved/.test(document.getElementById("result").textContent)', 8000, 'saved');
      const srt = fs.readFileSync(saveTo, 'utf8');
      assert(srt.charCodeAt(0) === 0xfeff && srt.includes('\r\n'), 'BOM and CRLF');
      eq(S.parseSrt(srt), want.map((c) => ({ start: c.start, end: c.end, text: S.fileText(c.text) })), 'srt matches');
      await click('#saveSrt');
      await waitFor('/kept as/.test(document.getElementById("result").textContent)', 8000, 'second save');
      assert(fs.existsSync(saveTo + '.bak'), '.bak kept');
      saveTo = path.join(dir, 'Holiday Clip ü.vtt');
      await click('#saveVtt');
      await waitFor('/\\.vtt/.test(document.getElementById("result").textContent)', 8000, 'saved vtt');
      eq(S.parseVtt(fs.readFileSync(saveTo, 'utf8')), want.map((c) => ({ start: c.start, end: c.end, text: S.fileText(c.text) })), 'vtt matches');
      assert(!/edited/.test(await js('document.getElementById("status").textContent')), 'no longer marked edited');
    });

    await step('Burn into video (real click): progress, then a new MP4 whose picture shows the subtitles; the original is unchanged', async () => {
      const before = fs.statSync(video).mtimeMs;
      const list = await cues();
      saveTo = path.join(dir, 'Holiday Clip ü (subtitled).mp4');
      await js('document.getElementById("size").value = "large"; void 0');
      await click('#burn');
      await waitFor('window.__app.S.exporting', 4000, 'export started');
      await shot('4-burning');
      await waitFor('!window.__app.S.exporting', 120000, 'export finished');
      assert(/Wrote Holiday Clip ü \(subtitled\)\.mp4/.test(await js('document.getElementById("videoResult").textContent')), 'result: ' + await js('document.getElementById("videoResult").textContent'));
      assert(fs.existsSync(saveTo) && !fs.existsSync(saveTo + '.part'), 'file written');
      const c = list.find((x) => x.end - x.start > 1);
      const on = whiteBottom(saveTo, (c.start + c.end) / 2, 640, 360);
      assert(on > 0.01, 'text in the picture: ' + on);
      eq(fs.statSync(video).mtimeMs, before, 'original untouched');
      // a second burn onto the same name (the save dialog asked): the old file goes to the recycle bin
      await click('#burn');
      await waitFor('!window.__app.S.exporting && /Wrote/.test(document.getElementById("videoResult").textContent)', 120000, 'second export');
      assert(fs.existsSync(saveTo + '.trashed'), 'the replaced file went to the recycle bin');
    });

    await step('Add as subtitle track (real click): a new MP4 with a mov_text track that holds the subtitles', async () => {
      saveTo = path.join(dir, 'with track.mp4');
      await click('#soft');
      await waitFor('!window.__app.S.exporting && /with track/.test(document.getElementById("videoResult").textContent)', 60000, 'soft export');
      const desc = spawnSync(ff, ['-hide_banner', '-i', saveTo], { encoding: 'utf8' }).stderr;
      assert(/Subtitle: mov_text/.test(desc), desc);
      const r = spawnSync(ff, ['-v', 'error', '-i', saveTo, '-map', '0:s:0', '-f', 'srt', '-'], { encoding: 'utf8' });
      eq(S.parseSrt(r.stdout).length, (await cues()).filter((c) => c.text.trim()).length, 'every subtitle in the track');
      saveTo = video;
      await click('#soft');
      await waitFor('/cannot replace the original/.test(document.getElementById("videoResult").textContent)', 8000, 'refused to overwrite the original');
    });

    await step('Open .srt / .vtt (real click): an existing file is read, its rule breaks are marked red with the reason', async () => {
      subsReturn = imported;
      await click('#importSubs');
      await waitFor('window.__app.S.subsName === "From elsewhere.srt"', 8000, 'imported');
      eq(await cues(), [{ start: 1, end: 4, text: 'Imported first line' }, { start: 5.5, end: 8.25, text: '<i>Zweite Zeile</i>, ünïcödé\nand a second line' }, { start: 9, end: 9.4, text: 'Way too fast for anybody to read this' }], 'cues');
      eq(await js('[...document.querySelectorAll("#cues .cue")].map((r) => r.classList.contains("bad"))'), [false, false, true], 'the fast one is red');
      assert(/Too fast to read/.test(await js('document.querySelector("#cues .cue:nth-child(3)").title')), 'reason on hover');
      eq(await js('document.querySelector("#cues .cue:nth-child(3) .cps").classList.contains("warn")'), true, 'cps warned');
      assert(/1 breaks a rule/.test(await js('document.getElementById("status").textContent')), 'counted in the status line');
      await js('document.getElementById("player").currentTime = 6; void 0'); await sleep(300);
      eq(await js('document.getElementById("overlay").textContent'), 'Zweite Zeile, ünïcödéand a second line', 'tags are not shown on the picture');
      await shot('5-imported');
    });

    await step('Burn, then Cancel (real clicks) on a long video: it stops, and no file is left behind', async () => {
      openReturn = long;
      await click('#open');
      await waitFor('window.__app.S.media.name === "Long film.mp4"', 10000, 'long video open');
      await click('#importSubs');
      await waitFor('window.__app.S.cues.length === 3', 8000, 'subtitles for it');
      saveTo = path.join(dir, 'cancelled.mp4');
      await click('#burn');
      await waitFor('window.__app.S.exporting && /Writing… [1-9]/.test(document.getElementById("exportPhase").textContent)', 30000, 'progress shown');
      await click('#exportCancel');
      await waitFor('!window.__app.S.exporting', 5000, 'stopped within seconds');
      assert(/No video was written/.test(await js('document.getElementById("toast").textContent')), 'told');
      await sleep(300);
      assert(!fs.existsSync(saveTo) && !fs.existsSync(saveTo + '.part'), 'nothing left behind');
    });

    await step('a sound-only file: the subtitles show without a picture, and the video export says why it is off', async () => {
      openReturn = audioOnly;
      await click('#open');
      await waitFor('window.__app.S.media.name === "Voice memo.m4a"', 10000, 'audio open');
      eq(await js('document.getElementById("noPicture").hidden'), false, 'sound-only note');
      await click('#importSubs');
      await waitFor('window.__app.S.cues.length === 3', 8000, 'subtitles');
      eq(await js('document.getElementById("videoSet").disabled'), true, 'no video export');
      assert(/sound only/.test(await js('document.getElementById("videoNote").textContent')), 'explained');
      eq(await js('document.getElementById("saveSet").disabled'), false, 'saving still works');
    });

    await step('no errors in the window console', async () => { assert(!errors.length, errors.join(' | ')); });
  } catch (e) {
    results.push({ name: 'test setup', ok: false, error: String((e && e.stack) || e) });
  }
  fs.writeFileSync(outFile, JSON.stringify({ ok: results.every((r) => r.ok), results, notes }, null, 2));
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  app.exit(results.every((r) => r.ok) ? 0 : 1);
};
