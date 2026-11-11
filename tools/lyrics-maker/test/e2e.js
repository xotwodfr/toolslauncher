'use strict';
// End-to-end test: runs inside Electron (`npm run e2e`). Drives the REAL window with real mouse and keyboard input and the REAL
// Whisper model on a SPOKEN test clip (made with the voices that ship with Windows, or espeak-ng; without either this test is
// skipped) whose words and timing are known, then reads the saved files back and compares them with what the window showed.
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
  const fullLines = () => js('window.__app.S.lines.map((l) => ({ start: l.start, text: l.text, words: (l.words || []).map((w) => ({ text: w.text, start: w.start, end: w.end, est: !!w.est })) }))');
  const chipTexts = (i) => js(`[...document.querySelectorAll("#lines .line:nth-child(${i + 1}) .w")].map((c) => c.firstChild.textContent)`);

  if (!SP.available()) {
    results.push({ name: 'the window test needs the Windows speech voices or espeak-ng to make a spoken test clip', ok: true, detail: 'skipped on this system' });
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

    await step('every line shows its words, each with the time it is sung (none guessed), and the words light up one by one as the song plays', async () => {
      const got = await fullLines();
      for (let i = 0; i < got.length; i++) {
        eq(await chipTexts(i), got[i].text.split(' '), `the words of line ${i + 1}`);
        assert(got[i].words.every((w) => !w.est), 'no guessed times after making');
        got[i].words.forEach((w, k) => { assert(w.end >= w.start, 'ends after it starts'); if (k) assert(w.start >= got[i].words[k - 1].start, 'in order'); });
      }
      const walked = got.flatMap((l) => l.words).find((w) => /walked/i.test(w.text));
      assert(walked.start > at[1] && walked.start < at[1] + 1.2, `"walked" is sung just after 13 s: ${walked.start}`);
      notes.walked = walked.start;
      const i = got.findIndex((l) => /walked/.test(l.text));
      const w4 = got[i].words[Math.min(3, got[i].words.length - 1)];
      await js(`(() => { const p = document.getElementById("player"); p.currentTime = ${w4.start + 0.02}; return p.play(); })()`);
      await waitFor(`document.querySelector("#lines .line:nth-child(${i + 1}).now .w.now")`, 3000, 'a word lit up');
      const lit = await js(`(() => { const cs = [...document.querySelectorAll("#lines .line:nth-child(${i + 1}) .w")]; return { now: cs.findIndex((c) => c.classList.contains("now")), sung: cs.filter((c) => c.classList.contains("sung")).length }; })()`);
      assert(lit.now >= Math.min(3, got[i].words.length - 1) && lit.sung >= lit.now, 'the word being sung and the ones before it: ' + JSON.stringify(lit));
      await sleep(700);
      const later = await js(`[...document.querySelectorAll("#lines .line:nth-child(${i + 1}) .w")].findIndex((c) => c.classList.contains("now"))`);
      assert(later >= lit.now, 'the highlight moves on as the song plays');
      await js('document.getElementById("player").pause()');
      await shot('3b-karaoke');
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

    await step('fixing single words: clicking a word (real click) jumps to it, arrow keys pick the next word, S stamps it at the playhead and [ ] nudge it; a retyped line keeps or re-times its words', async () => {
      const i = (await lines()).findIndex((l) => /walked/.test(l.text));
      const before = (await fullLines())[i];
      await click(`#lines .line:nth-child(${i + 1}) .w:nth-child(2)`);
      eq(await js('window.__app.S.selWord'), 1, 'the second word is selected');
      near(await js('document.getElementById("player").currentTime'), before.words[1].start, 0.05, 'the song jumped to the word');
      assert(await js(`!!document.querySelector("#lines .line:nth-child(${i + 1}) .w.sel small")`), 'the selected line shows each word\'s time');
      await key('Right');
      eq(await js('window.__app.S.selWord'), 2, 'Right arrow picks the next word');
      const t = Math.round((before.words[2].start + 0.3) * 100) / 100;
      await js(`document.getElementById("player").currentTime = ${t}`);
      await sleep(150);
      await key('s', [], 's');
      let now = (await fullLines())[i];
      near(now.words[2].start, t, 0.011, 'S stamped the word at the playhead');
      near(now.words[1].end, t, 0.011, 'the word before now ends there');
      eq(now.start, before.start, 'the line itself did not move');
      await key(']', [], ']'); await key(']', [], ']'); await key('[', [], '[');
      now = (await fullLines())[i];
      near(now.words[2].start, t + 0.05, 0.011, '] ] [ moved it 0.05 s later');
      // retype one word: the times stay; add a word: the line's time is shared out again (guessed, in italics)
      const field = `#lines .line:nth-child(${i + 1}) .text`;
      const words = now.text.split(' ');
      await click(field); await key('a', ['control']); await typeText(['We', 'strolled', ...words.slice(2)].join(' ')); await key('Tab');
      now = (await fullLines())[i];
      eq(now.words[1].text, 'strolled', 'the retyped word'); near(now.words[1].start, before.words[1].start, 0.011, 'kept its time'); assert(!now.words[1].est, 'not guessed');
      await click(field); await key('a', ['control']); await typeText(['We', 'strolled', 'slowly', ...words.slice(2)].join(' ')); await key('Tab');
      now = (await fullLines())[i];
      eq(now.words.length, words.length + 1, 'one more word');
      assert(now.words.every((w) => w.est), 'the words are now guessed');
      eq(await js(`document.querySelectorAll("#lines .line:nth-child(${i + 1}) .w.est").length`), words.length + 1, 'and shown in italics');
    });

    await step('Tap words (real click, then W on every word): each tap times the next word at the playhead, running on into the next line; Esc stops', async () => {
      const i = (await lines()).findIndex((l) => /strolled/.test(l.text));
      await click(`#lines .line:nth-child(${i + 1}) .text`);
      await js('document.activeElement.blur()');
      await click('#tap');
      eq(await js('document.getElementById("tap").getAttribute("aria-pressed")'), 'true', 'tapping is on');
      eq(await js('document.getElementById("tapHint").hidden'), false, 'with a hint');
      await waitFor('!document.getElementById("player").paused', 3000, 'it starts playing');
      const n = (await fullLines())[i].words.length;
      const taps = [];
      for (let k = 0; k < n + 2; k++) {
        await sleep(160);
        taps.push(await js('document.getElementById("player").currentTime'));
        await key('w', [], 'w');
      }
      await key('Escape');
      eq(await js('window.__app.S.tap'), null, 'Esc stops tapping');
      await js('document.getElementById("player").pause()');
      const all = await fullLines();
      const line = all[i]; const next = all[i + 1];
      line.words.forEach((w, k) => { near(w.start, taps[k], 0.12, `word ${k + 1} was timed by its tap`); assert(!w.est, 'no longer guessed'); });
      near(line.start, line.words[0].start, 0.011, 'the line starts with its first tapped word');
      near(next.words[0].start, taps[n], 0.12, 'the taps ran on into the next line'); near(next.start, next.words[0].start, 0.011, 'which moved to its first word');
      near(next.words[1].start, taps[n + 1], 0.12, 'second word of the next line');
      await shot('4b-tapped');
    });

    await step('Undo all edits (real click) brings back the lyrics exactly as they were made', async () => {
      await click('#revert');
      const back = await lines();
      const made = await js('window.__app.S.made.map((l) => ({ start: l.start, text: l.text }))');
      eq(back, made, 'lines');
      eq((await fullLines()).map((l) => l.words.map((w) => [w.text, w.start])), await js('window.__app.S.made.map((l) => l.words.map((w) => [w.text, w.start]))'), 'and their word times');
      eq(await js('document.getElementById("revert").disabled'), true, 'nothing left to undo');
      assert(!/edited/.test(await js('document.getElementById("status").textContent')), 'status no longer says edited');
    });

    await step('Save word-synced lyrics (real click): the .ttml file is valid XML with a <span> for every word, holds exactly the words and times shown, and Ctrl+S saves it again (old file kept as .bak)', async () => {
      const ttmlPath = path.join(dir, 'Test Song.ttml');
      saveTo = ttmlPath;
      const shown = (await fullLines()).filter((l) => l.text.trim());
      await click('#saveTtml');
      await waitFor('/Saved Test Song\\.ttml/.test(document.getElementById("result").textContent)', 10000, 'saved');
      assert(fs.existsSync(ttmlPath) && !fs.existsSync(ttmlPath + '.part'), 'file written, no half-written file');
      const raw = fs.readFileSync(ttmlPath, 'utf8');
      assert(raw.startsWith('<?xml version="1.0" encoding="UTF-8"?>'), 'an XML document, without a byte-order mark');
      const check = await js(`(() => { const d = new DOMParser().parseFromString(${JSON.stringify(raw)}, 'application/xml'); if (d.getElementsByTagName('parsererror').length) return { error: d.getElementsByTagName('parsererror')[0].textContent }; const ns = 'http://www.w3.org/ns/ttml'; return { root: d.documentElement.localName, ns: d.documentElement.namespaceURI, lang: d.documentElement.getAttribute('xml:lang'), ps: d.getElementsByTagNameNS(ns, 'p').length, spans: [...d.getElementsByTagNameNS(ns, 'span')].map((s) => s.textContent) }; })()`);
      assert(!check.error, 'the browser reads it as XML: ' + check.error);
      eq([check.root, check.ns, check.lang], ['tt', 'http://www.w3.org/ns/ttml', 'en'], 'a TTML root with the language');
      eq(check.ps, shown.length, 'one <p> per line');
      eq(check.spans, shown.flatMap((l) => l.words.map((w) => w.text)), 'one <span> per word, in order');
      const parsed = P.parseTtml(raw);
      eq(parsed.map((l) => l.text), shown.map((l) => l.text), 'the lines');
      parsed.forEach((l, i) => { near(l.start, shown[i].start, 0.011, 'line ' + i); l.words.forEach((w, k) => near(w.start, shown[i].words[k].start, 0.011, `word ${k} of line ${i}`)); });
      assert(!fs.existsSync(ttmlPath + '.bak'), 'nothing to back up the first time');
      await click('#lines .line:nth-child(1) .text'); await key('a', ['control']); await typeText('Word synced edit'); await key('Tab');
      await key('s', ['control']);
      await waitFor('/kept as Test Song\\.ttml\\.bak/.test(document.getElementById("result").textContent)', 10000, 'Ctrl+S saved the TTML again, with a backup');
      eq(fs.readFileSync(ttmlPath + '.bak', 'utf8'), raw, 'the old file is kept byte for byte');
      assert(fs.readFileSync(ttmlPath, 'utf8').includes('>Word</span> <span') && fs.readFileSync(ttmlPath, 'utf8').includes('>edit</span>'), 'the new file has the edit');
      await shot('5a-saved-ttml');
    });

    await step('Load lyrics file… (real click): a saved .ttml comes back with every word time; an .lrc comes back with line times and guessed words', async () => {
      const ttmlPath = path.join(dir, 'Test Song.ttml');
      const want = P.parseTtml(fs.readFileSync(ttmlPath, 'utf8'));
      openReturn = ttmlPath;
      await click('#load');
      await waitFor('/loaded from Test Song\\.ttml/.test(document.getElementById("status").textContent)', 8000, 'loaded');
      const got = await fullLines();
      eq(got.map((l) => l.text), want.map((l) => l.text), 'the lines');
      got.forEach((l, i) => l.words.forEach((w, k) => { near(w.start, want[i].words[k].start, 0.011, `word ${k} of line ${i}`); assert(!w.est, 'real word times'); }));
      eq(await js('document.getElementById("revert").disabled'), true, 'loaded lyrics are not "edited"');
      const lrc = path.join(dir, 'Other.lrc');
      fs.writeFileSync(lrc, '\uFEFF[ar:Someone]\r\n[00:02.00]First line here\r\n[00:06.50]And a second one\r\n');
      openReturn = lrc;
      await click('#load');
      await waitFor('/loaded from Other\\.lrc/.test(document.getElementById("status").textContent)', 8000, 'lrc loaded');
      const l2 = await fullLines();
      eq(l2.map((l) => [l.start, l.text]), [[2, 'First line here'], [6.5, 'And a second one']], 'lines from the .lrc');
      assert(l2.every((l) => l.words.length === l.text.split(' ').length && l.words.every((w) => w.est)), 'words guessed from the line times');
      near(l2[0].words[0].start, 2, 0.011, 'the first word starts with its line'); assert(l2[0].words[2].end <= 6.5 + 1e-9, 'and the line ends before the next');
      fs.writeFileSync(path.join(dir, 'junk.lrc'), 'just some text');
      openReturn = path.join(dir, 'junk.lrc');
      await click('#load');
      await waitFor('/No timed lines/.test(document.getElementById("toast").textContent)', 8000, 'a file without times is refused');
      eq((await lines()).length, 2, 'and the lyrics stay');
      // back to the made lyrics for the next steps
      openReturn = ttmlPath; await click('#load');
      await waitFor('/loaded from Test Song\\.ttml/.test(document.getElementById("status").textContent)', 8000, 'reloaded');
      openReturn = song;
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

    await step('Save as plain text (real click) writes only the words; a save can never land on the song itself (the extension is always .ttml, .lrc or .txt)', async () => {
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

    await step('pasted lyrics (real Ctrl+V into the box, real click): the button says "Time my lyrics", and the result is exactly the pasted lines with every word timed', async () => {
      const { clipboard } = require('electron');
      const lyrics = ['[Verse 1]', 'The river runs down to the sea,', 'and the morning light is warm on the hills.', '', 'We walked all night through the empty streets,', 'singing songs we used to know.', '[Chorus]', 'Hold on to the little things,', 'they will carry you home.'];
      clipboard.writeText(lyrics.join('\r\n'));
      await click('#lyricsIn');
      await key('v', ['control']);
      await waitFor('document.getElementById("lyricsIn").value.includes("carry you home")', 3000, 'pasted');
      eq(await js('document.getElementById("make").textContent'), 'Time my lyrics again', 'the button says what it will do');
      eq(await js('document.getElementById("lyricsCount").textContent'), '6 lines to time', 'headings and blank rows are not counted');
      await click('#make');
      await waitFor('window.__app.S.working', 4000, 'working');
      await waitFor('/Timing your lyrics/.test(document.getElementById("phase").textContent)', 120000, 'the timing phase is shown');
      await waitFor('!window.__app.S.working', 120000, 'finished');
      const got = await fullLines();
      const want = lyrics.filter((l) => l && !l.startsWith('['));
      eq(got.map((l) => l.text), want, 'the pasted lines, in order');
      got.forEach((l, i) => { eq(l.words.map((w) => w.text), want[i].split(' '), `words of line ${i + 1}`); assert(l.words.every((w) => !w.est), 'every word has a real time'); });
      near(got[0].start, at[0], 0.4, 'first line'); near(got[2].start, at[1], 0.4, 'third line'); near(got[4].start, at[2], 0.4, 'fifth line');
      assert(/Timed your 6 lines/.test(await js('document.getElementById("toast").textContent')), 'says how it went: ' + await js('document.getElementById("toast").textContent'));
      await shot('6-pasted-lyrics');
      await js('(() => { const t = document.getElementById("lyricsIn"); t.value = ""; t.dispatchEvent(new Event("input")); })()');
      eq(await js('document.getElementById("make").textContent'), 'Make lyrics again', 'an empty box means listening for the words again');
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

    await step('experimental "Isolate vocals first" (real click): the vocals are separated first, with their own progress, then the lyrics are made from them', async () => {
      const V = require('../src/vocals');
      if (V.missing()) return 'skipped: the vocal separation model is not downloaded (npm run setup)';
      await js('(() => { const t = document.getElementById("lyricsIn"); t.value = ""; t.dispatchEvent(new Event("input")); })()');
      eq(await js('document.getElementById("isolate").disabled'), false, 'the switch can be used');
      await click('#isolate');
      eq(await js('document.getElementById("isolate").checked'), true, 'ticked');
      assert(/vocal separation/.test(await js('document.getElementById("makeNote").textContent')), 'the time estimate includes the separation');
      await click('#make');
      await waitFor('window.__app.S.working', 4000, 'working');
      await waitFor('/Separating the vocals|Starting the vocal separation/.test(document.getElementById("phase").textContent)', 30000, 'the separation phase is shown');
      await waitFor('/Separating the vocals… [1-9]/.test(document.getElementById("phase").textContent)', 120000, 'its progress moves');
      await waitFor('!window.__app.S.working', 600000, 'finished');
      const got = await lines();
      const wer = SP.wordErrorRate(SP.SENTENCES.slice(0, 3).join(' '), got.map((l) => l.text).join(' '));
      assert(wer <= 0.2, `made from the separated vocals (word error rate ${wer.toFixed(2)})`);
      notes.isolatedWer = Number(wer.toFixed(3));
      await click('#isolate');
      eq(await js('document.getElementById("isolate").checked'), false, 'switched off again');
      return undefined;
    });

    await step('the accurate model: choosing it asks for the one-time download (real clicks); it downloads with progress, is checked, makes lyrics, and can be removed', async () => {
      const turbo = path.join(__dirname, '..', 'models', 'turbo');
      if (!fs.existsSync(path.join(turbo, 'encoder_model_int8.onnx'))) return 'skipped: the accurate model is not in models/turbo';
      // the model files come from a local server in this test (the app fetches them from Hugging Face)
      const http = require('http');
      const server = http.createServer((req, res) => {
        const f = path.join(turbo, path.basename(decodeURIComponent(req.url)));
        if (!fs.existsSync(f)) { res.writeHead(404); res.end(); return; }
        res.writeHead(200, { 'content-length': fs.statSync(f).size }); fs.createReadStream(f).pipe(res);
      });
      await new Promise((r) => server.listen(0, '127.0.0.1', r));
      process.env.LM_MODEL_BASE = `http://127.0.0.1:${server.address().port}`;
      try {
        await js('(() => { const s = document.getElementById("model"); s.value = "accurate"; s.dispatchEvent(new Event("change")); })()');
        eq(await js('document.getElementById("modelBox").hidden'), false, 'the model box opens');
        assert(/one-time 1\.1 GB download/.test(await js('document.getElementById("modelInfo").textContent')), 'it says what the download is');
        eq(await js('document.getElementById("make").disabled'), true, 'nothing can be made before it is downloaded');
        await click('#modelGet');
        await waitFor('!document.getElementById("modelBar").hidden', 5000, 'progress shown');
        await waitFor('/Downloading… [1-9]/.test(document.getElementById("modelInfo").textContent)', 60000, 'progress moves');
        await shot('7-model-download');
        await waitFor('/accurate model is ready/.test(document.getElementById("toast").textContent)', 300000, 'downloaded and checked');
        eq(await js('document.getElementById("make").disabled'), false, 'now it can be used');
        eq(await js('document.getElementById("modelRemove").hidden'), false, 'and removed');
        await js('(() => { const t = document.getElementById("lyricsIn"); t.value = ""; t.dispatchEvent(new Event("input")); })()');
        await click('#make');
        await waitFor('window.__app.S.working', 4000, 'working');
        await waitFor('!window.__app.S.working', 300000, 'finished with the accurate model');
        const got = await lines();
        const wer = SP.wordErrorRate(SP.SENTENCES.slice(0, 3).join(' '), got.map((l) => l.text).join(' '));
        assert(wer <= 0.1, `the accurate model wrote it down (word error rate ${wer.toFixed(2)})`);
        notes.accurateWer = Number(wer.toFixed(3));
        await click('#modelRemove');
        await waitFor('/accurate model was removed/.test(document.getElementById("toast").textContent)', 20000, 'removed');
        eq(await js('document.getElementById("make").disabled'), true, 'gone again: it would need downloading');
        await js('(() => { const s = document.getElementById("model"); s.value = "standard"; s.dispatchEvent(new Event("change")); })()');
        eq(await js('document.getElementById("make").disabled'), false, 'the standard model is always there');
      } finally { server.close(); delete process.env.LM_MODEL_BASE; }
      return undefined;
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
