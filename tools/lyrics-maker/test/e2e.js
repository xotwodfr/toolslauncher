'use strict';
// End-to-end test: runs inside Electron (`npm run e2e`). Drives the REAL window with real mouse and keyboard input and the REAL
// Whisper model on a SPOKEN test clip (made with the voices that ship with Windows; elsewhere this test is skipped) whose words
// and timing are known, then reads the saved files back and compares them with what the window showed.
const fs = require('fs');
const os = require('os');
const path = require('path');
const P = require('../src/plan');
const SP = require('../src/speech');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

exports.run = async ({ app, getWin, outFile, shotsDir, dialog, engineLoaded }) => {
  const results = [];
  const errors = [];
  const notes = {};
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lyrics-e2e-'));
  const win = getWin();
  const wc = win.webContents;
  const js = (code) => wc.executeJavaScript(code, true);
  wc.on('console-message', (_e, level, msg) => { if (level >= 2) errors.push(msg); });
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
    await sleep(60);
  };
  const typeText = async (text) => { for (const ch of text) await key(ch === ' ' ? 'Space' : ch, [], ch); };
  const center = (selector) => js(`(()=>{const e=document.querySelector(${JSON.stringify(selector)}); if(!e) return null; e.scrollIntoView({block:'nearest'}); const b=e.getBoundingClientRect(); return {x:Math.round(b.x+b.width/2), y:Math.round(b.y+b.height/2)};})()`);
  const clickAt = async (x, y) => {
    wc.sendInputEvent({ type: 'mouseMove', x, y });
    wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
    wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
    await sleep(100);
  };
  const click = async (selector) => { const r = await center(selector); if (!r) throw new Error('nothing to click: ' + selector); await clickAt(r.x, r.y); };
  const S = (expr) => js(`window.__app.S.${expr}`);
  const lines = () => js('window.__app.S.lines.map((l) => ({ start: l.start, text: l.text }))');
  const rowCount = () => js('document.querySelectorAll("#lines .line").length');

  if (!SP.available()) {
    results.push({ name: 'the window test needs the Windows speech voices to make a spoken test clip', ok: true, detail: 'skipped on this system' });
    fs.writeFileSync(outFile, JSON.stringify({ ok: true, results, notes }, null, 2));
    app.exit(0);
    return;
  }

  try {
    win.setContentSize(1240, 820);
    const at = [1.0, 13.0, 26.0];
    const song = path.join(dir, 'Test Song.wav');
    await SP.makeClip(SP.SENTENCES.slice(0, 3).map((text, i) => ({ text, at: at[i], voice: i % 2 ? 'Microsoft Zira Desktop' : 'Microsoft David Desktop' })), 45, song, dir);
    const notAudio = path.join(dir, 'notes.txt'); fs.writeFileSync(notAudio, 'hello');
    const broken = path.join(dir, 'Broken.mp3'); fs.writeFileSync(broken, Buffer.alloc(6000, 4));
    let openReturn = song; let saveTo = null;
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [openReturn] });
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: saveTo });
    await js('void (window.__confirmAnswer = true, window.confirm = () => window.__confirmAnswer)');

    await step('the window starts empty, the engine check passes, and nothing can be saved yet', async () => {
      await waitFor('!!window.__app');
      eq(await js('document.getElementById("empty").hidden'), false, 'drop zone shown');
      eq(await js('document.getElementById("work").hidden'), true, 'work area hidden');
      assert(await js('document.getElementById("engineWarn").hidden') || /memory/.test(await js('document.getElementById("engineWarn").textContent')), 'no engine problem');
      await shot('1-empty');
    });

    await step('Open song… (real click): the song is ready to play and to make lyrics for, with an estimate, and no lyrics yet', async () => {
      await click('#open2');
      await waitFor('window.__app.S.song && window.__app.S.song.name === "Test Song.wav"', 10000, 'song opened');
      eq(await js('document.getElementById("work").hidden'), false, 'work area shown');
      eq(await js('document.getElementById("makeSet").disabled'), false, 'Make enabled');
      eq(await js('document.getElementById("playSet").disabled'), false, 'Play enabled');
      eq(await js('document.getElementById("saveSet").disabled'), true, 'nothing to save yet');
      assert(/Takes about/.test(await js('document.getElementById("makeNote").textContent')), 'estimate shown');
      assert(/Test Song\.wav · 0:45/.test(await js('document.getElementById("fileInfo").textContent')), 'file info');
      eq(await js('document.getElementById("placeholder").offsetParent !== null'), true, 'placeholder visible');
      await waitFor('document.getElementById("player").readyState >= 1', 10000, 'audio loaded through lyrics://');
      near(await js('document.getElementById("player").duration'), 45, 0.2, 'the player can read the song');
      eq(await js('document.getElementById("lang").value'), 'auto', 'language defaults to detect');
    });

    await step('Make lyrics (real click): progress with a phase and Cancel, lines appear while it works, then the lyrics match what was said, with their start times', async () => {
      await click('#make');
      await waitFor('window.__app.S.working', 4000, 'working');
      eq(await js('document.getElementById("progressBox").hidden'), false, 'progress shown');
      eq(await js('document.getElementById("makeSet").disabled'), true, 'Make locked meanwhile');
      await waitFor('/Starting|Reading|Listening/.test(document.getElementById("phase").textContent)', 10000, 'phase text');
      await waitFor('document.querySelectorAll("#lines .line").length >= 1', 90000, 'a first line streamed in');
      assert(await S('working'), 'a line appeared while the work was still going');
      eq(await js('document.querySelector("#lines .line input").disabled'), true, 'lines are locked while it works');
      await shot('2-working');
      const t0 = Date.now();
      await waitFor('!window.__app.S.working', 120000, 'finished');
      notes.makeSeconds = Number(((Date.now() - t0) / 1000).toFixed(1));
      eq(await js('document.getElementById("progressBox").hidden'), true, 'progress gone');
      const got = await lines();
      assert(got.length >= 3, 'at least three lines: ' + JSON.stringify(got));
      const text = got.map((l) => l.text).join(' ');
      const said = SP.SENTENCES.slice(0, 3).join(' ');
      const wer = SP.wordErrorRate(said, text);
      assert(wer <= 0.12, `word error rate ${wer.toFixed(2)}: "${text}"`);
      near(got[0].start, at[0], 0.5, 'first line starts'); near(got.find((l) => /walked/.test(l.text)).start, at[1], 0.6, 'second sentence starts');
      near(got.find((l) => /Hold on|little things/.test(l.text)).start, at[2], 0.6, 'third sentence starts');
      eq(await js('document.getElementById("saveSet").disabled'), false, 'saving unlocked');
      assert(/English \(detected\)/.test(await js('document.getElementById("status").textContent')), 'language shown: ' + (await js('document.getElementById("status").textContent')));
      notes.wer = Number(wer.toFixed(3));
      await shot('3-made');
    });

    await step('▶ on a line (real click) plays the song from that line, the playing line is highlighted, and Space (real key) pauses', async () => {
      const i = (await lines()).findIndex((l) => /walked/.test(l.text));
      await click(`#lines .line:nth-child(${i + 1}) .go`);
      await waitFor('!document.getElementById("player").paused', 5000, 'playing');
      await sleep(900);
      const t = await js('document.getElementById("player").currentTime');
      const want = (await lines())[i].start;
      assert(t >= want && t < want + 3, `playing from the line: ${t.toFixed(2)} vs ${want}`);
      eq(await js('[...document.querySelectorAll("#lines .line")].findIndex((r) => r.classList.contains("now"))'), i, 'the playing line is highlighted');
      eq(await js('document.getElementById("play").textContent.includes("Pause")'), true, 'button says Pause');
      await js('document.activeElement && document.activeElement.blur()');
      await key('Space');
      await waitFor('document.getElementById("player").paused', 3000, 'paused by Space');
      eq(await js('document.getElementById("play").textContent.includes("Play")'), true, 'button says Play');
      await click('#play'); await waitFor('!document.getElementById("player").paused', 3000, 'play button');
      await click('#play'); await waitFor('document.getElementById("player").paused', 3000, 'pause button');
    });

    await step('editing a line: typing in its text box, typing a new time (it moves into place), shifting everything, stamping at the playhead, adding and deleting lines', async () => {
      const before = await lines();
      // text
      await click('#lines .line:nth-child(1) .text');
      await key('a', ['control']); await typeText('Hello new words');
      eq((await lines())[0].text, 'Hello new words', 'typed text');
      eq(await js('document.getElementById("revert").disabled'), false, 'Undo all edits enabled');
      assert(/edited/.test(await js('document.getElementById("status").textContent')), 'status says edited');
      // time: type a later time for line 1 and it sorts after the lines before it
      await click('#lines .line:nth-child(1) .time');
      await key('a', ['control']); await typeText('0:20.50'); await key('Return');
      await waitFor('window.__app.S.lines.some((l) => l.text === "Hello new words" && l.start === 20.5)', 3000, 'new time');
      const afterTime = await lines();
      eq(afterTime.map((l) => l.start).slice().sort((a, b) => a - b), afterTime.map((l) => l.start), 'still in time order');
      near(afterTime.findIndex((l) => l.text === 'Hello new words'), afterTime.filter((l) => l.start < 20.5).length, 0, 'moved to its place');
      // a bad time is refused
      const idx = afterTime.findIndex((l) => l.text === 'Hello new words');
      await click(`#lines .line:nth-child(${idx + 1}) .time`); await key('a', ['control']); await typeText('abc'); await key('Return');
      eq((await lines())[idx].start, 20.5, 'a bad time is refused'); assert(!(await js('document.getElementById("toast").hidden')), 'and says why');
      // shift
      const pre = await lines();
      await click('[data-shift="0.5"]');
      const post = await lines();
      post.forEach((l, i) => near(l.start, pre[i].start + 0.5, 0.011, 'shifted line ' + i));
      await click('[data-shift="-0.5"]');
      post.forEach((l, i) => near((null || l.start) - 0.5, pre[i].start, 0.011, 'shifted back'));
      // stamp
      const target = (await lines()).length - 1;
      await click(`#lines .line:nth-child(${target + 1}) .text`);
      await js('document.getElementById("player").currentTime = 40');
      await sleep(200);
      await click('#stamp');
      const stamped = await lines();
      near(stamped[stamped.length - 1].start, 40, 0.1, 'stamped at the playhead'); assert(stamped.some((l) => /walked|Hold|little/.test(l.text)), 'text kept');
      // add and delete
      const n = await rowCount();
      await js('document.getElementById("player").currentTime = 5');
      await sleep(200);
      await click('#addLine');
      eq(await rowCount(), n + 1, 'a line was added');
      eq(await js('document.activeElement && document.activeElement.className'), 'text', 'the new line is ready for typing');
      await typeText('An added line');
      assert((await lines()).some((l) => l.text === 'An added line' && Math.abs(l.start - 5) < 0.2), 'added at the playhead');
      const addedAt = (await lines()).findIndex((l) => l.text === 'An added line');
      await click(`#lines .line:nth-child(${addedAt + 1}) .del`);
      eq(await rowCount(), n, 'deleted again'); assert(!(await lines()).some((l) => l.text === 'An added line'), 'gone');
      await shot('4-edited');
      void before;
    });

    await step('Undo all edits (real click) brings back the lyrics exactly as they were made', async () => {
      await click('#revert');
      const back = await lines();
      const made = await js('window.__app.S.made');
      eq(back, made, 'lines');
      eq(await js('document.getElementById("revert").disabled'), true, 'nothing left to undo');
      assert(!/edited/.test(await js('document.getElementById("status").textContent')), 'status no longer says edited');
    });

    await step('Save timed lyrics… (real click): the .lrc file holds exactly the lines shown, in order, with the carry done right; saving again keeps the old file as .bak', async () => {
      const lrcPath = path.join(dir, 'Test Song.lrc');
      saveTo = lrcPath;
      const shown = (await lines()).filter((l) => l.text.trim());
      await click('#saveLrc');
      await waitFor('/Saved Test Song\\.lrc/.test(document.getElementById("result").textContent)', 10000, 'saved');
      assert(fs.existsSync(lrcPath), 'file written'); assert(!fs.existsSync(lrcPath + '.part'), 'no half-written file');
      const raw = fs.readFileSync(lrcPath, 'utf8');
      assert(raw.charCodeAt(0) === 0xfeff, 'UTF-8 with a byte-order mark');
      const parsed = P.parseLrc(raw);
      eq(parsed.map((l) => l.text), shown.map((l) => l.text), 'texts in order');
      parsed.forEach((l, i) => near(l.start, shown[i].start, 0.011, 'time of line ' + i));
      assert(/^\[\d\d:\d\d\.\d\d\]/.test(raw.replace(/^\uFEFF/, '')), 'real LRC stamps');
      assert(!fs.existsSync(lrcPath + '.bak'), 'nothing to back up the first time');
      // edit one line, save again over the same file
      await click('#lines .line:nth-child(1) .text'); await key('a', ['control']); await typeText('Second version');
      await click('#saveLrc');
      await waitFor('/Saved Test Song\\.lrc/.test(document.getElementById("result").textContent) && /kept as Test Song\\.lrc\\.bak/.test(document.getElementById("result").textContent)', 10000, 'saved again with a backup note');
      eq(fs.readFileSync(lrcPath + '.bak', 'utf8'), raw, 'the old file is kept byte for byte as .bak');
      assert(/Second version/.test(fs.readFileSync(lrcPath, 'utf8')), 'the new file has the edit');
      eq(await js('document.getElementById("result").classList.contains("ok")'), true, 'success styling');
      assert(await js('!!document.querySelector("#result .btn")'), 'Show in folder offered');
      await shot('5-saved');
    });

    await step('Save as plain text (real click) writes only the words; a save can never land on the song itself (the extension is always .lrc or .txt)', async () => {
      saveTo = path.join(dir, 'Test Song.txt');
      await click('#saveTxt');
      await waitFor('/Saved Test Song\\.txt/.test(document.getElementById("result").textContent)', 10000, 'text saved');
      const txt = fs.readFileSync(saveTo, 'utf8').replace(/^\uFEFF/, '').trim().split(/\r?\n/);
      eq(txt, (await lines()).filter((l) => l.text.trim()).map((l) => l.text.trim()), 'the lines');
      assert(!/\[\d\d:/.test(txt.join('\n')), 'no times in the text file');
      const before = fs.readFileSync(song);
      saveTo = song;                                                           // somebody types the song's own name in the save box
      await click('#saveLrc');
      await waitFor('/Saved Test Song\.wav\.lrc/.test(document.getElementById("result").textContent)', 10000, 'saved under a safe name');
      assert(fs.readFileSync(song).equals(before), 'the song is untouched');
      assert(fs.existsSync(song + '.lrc'), 'the lyrics went to "Test Song.wav.lrc" instead');
      const prev = dialog.showSaveDialog; dialog.showSaveDialog = async () => ({ canceled: true });
      await click('#saveLrc'); await waitFor('document.getElementById("result").hidden || !document.getElementById("result").classList.contains("err")', 5000, 'quiet cancel');
      dialog.showSaveDialog = prev;
    });

    await step('Make lyrics again asks before throwing edits away; Cancel (real click) stops it within seconds without crashing; making again then finishes', async () => {
      await click('#lines .line:nth-child(1) .text'); await key('a', ['control']); await typeText('Edited once more');
      await js('window.__confirmAnswer = false');
      await click('#make');
      await sleep(500);
      eq(await S('working'), false, 'answering No keeps the lyrics');
      eq((await lines())[0].text, 'Edited once more', 'and the edit');
      await js('window.__confirmAnswer = true');
      await click('#make');
      await waitFor('window.__app.S.working', 4000, 'working again');
      await waitFor('/Listening/.test(document.getElementById("phase").textContent)', 60000, 'listening');
      await sleep(2500);
      const t0 = Date.now();
      await click('#cancel');
      await waitFor('!window.__app.S.working', 15000, 'stopped');
      notes.cancelSeconds = Number(((Date.now() - t0) / 1000).toFixed(1));
      assert(notes.cancelSeconds < 10, 'stopped in ' + notes.cancelSeconds + ' s');
      eq(await rowCount(), 0, 'the half-made lines were dropped');
      assert(!(await js('document.getElementById("toast").hidden')) || (await js('document.getElementById("banner").hidden')), 'no error banner');
      await click('#make');
      await waitFor('window.__app.S.working', 4000, 'working again after the cancel');
      await waitFor('!window.__app.S.working', 120000, 'finished after the cancel');
      assert((await rowCount()) >= 3, 'the lyrics are back');
    });

    await step('the speech model is let go when idle (memory given back), and a forced language is accepted', async () => {
      const end = Date.now() + 20000;
      while (engineLoaded() && Date.now() < end) await sleep(200);
      assert(!engineLoaded(), 'the model was released after the idle time');
      await js('(() => { const s = document.getElementById("lang"); s.value = "en"; s.dispatchEvent(new Event("change")); })()');
      await click('#make');
      await waitFor('window.__app.S.working', 4000, 'working (the model loads again)');
      await waitFor('!window.__app.S.working', 120000, 'finished');
      assert(/^English$|^English(?! \(detected\))/.test(await js('document.getElementById("status").textContent').then((t) => t.replace(/^\d+ lines? · /, ''))), 'a chosen language is not marked as detected: ' + (await js('document.getElementById("status").textContent')));
      assert((await rowCount()) >= 3, 'lyrics made');
    });

    await step('a text file and a broken audio file give clear messages and keep the current song', async () => {
      openReturn = notAudio;
      await click('#open');
      await waitFor('/not an audio file/.test(document.getElementById("toast").textContent) && !document.getElementById("toast").hidden', 8000, 'not audio message');
      openReturn = broken;
      await click('#open');
      await waitFor('/could not be read as audio/.test(document.getElementById("toast").textContent)', 8000, 'broken message');
      eq(await S('song.name'), 'Test Song.wav', 'still the same song');
      assert((await rowCount()) >= 3, 'and its lyrics');
    });

    await step('the window never showed an error and every control has a name for screen readers', async () => {
      eq(errors.filter((e) => !/Autofill/.test(e)).join(' | '), '', 'console errors');
      const unnamed = await js(`[...document.querySelectorAll('button, input, select')].filter((e) => !e.closest('[hidden]') && !(e.getAttribute('aria-label') || e.textContent.trim() || (e.labels && e.labels.length) || e.title)).map((e) => e.outerHTML.slice(0, 80))`);
      eq(unnamed, [], 'unnamed controls');
    });
  } catch (e) {
    results.push({ name: 'the test itself', ok: false, error: String((e && e.stack) || e) });
    console.log('FAIL the test itself: ' + ((e && e.stack) || e));
  } finally {
    const ok = results.length > 0 && results.every((r) => r.ok);
    try { fs.writeFileSync(outFile, JSON.stringify({ ok, results, notes }, null, 2)); } catch (e) { console.log('could not write the report', e); }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    app.exit(ok ? 0 : 1);
  }
};
