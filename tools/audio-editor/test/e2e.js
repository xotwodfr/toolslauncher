'use strict';
// End-to-end test: runs inside Electron (`npm run e2e`). Drives the REAL window with real mouse and keyboard input, then
// checks what the page shows AND the files it writes (decoded with ffmpeg and measured: length, pitch, loudness).
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const K = require('../src/testkit');
const E = require('../src/edit');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

exports.run = async ({ app, getWin, openPaths, outFile, shotsDir }) => {
  const results = [];
  const errors = [];
  const notes = {};
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audioeditor-e2e-'));
  const outDir = path.join(dir, 'saved');
  const win = getWin();
  const wc = win.webContents;
  const ff = E.ffmpegPath();
  const js = (code) => wc.executeJavaScript(code, true);
  const step = async (name, fn) => {
    try { const detail = await fn(); results.push({ name, ok: true, detail: detail === undefined ? '' : detail }); console.log('ok   ' + name); }
    catch (e) { results.push({ name, ok: false, error: String((e && e.message) || e) }); console.log('FAIL ' + name + ': ' + ((e && e.message) || e)); }
  };
  const eq = (a, b, what) => { if (a !== b) throw new Error(`${what}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); };
  const near = (a, b, tol, what) => { if (!(Math.abs(a - b) <= tol)) throw new Error(`${what}: expected ${b} +/- ${tol}, got ${a}`); };
  const waitFor = async (expr, ms = 6000, what = expr) => {
    const end = Date.now() + ms;
    for (;;) { const v = await js(expr); if (v) return v; if (Date.now() > end) throw new Error('timed out waiting for ' + what); await sleep(40); }
  };
  const shot = async (name) => {
    if (!shotsDir) return;
    fs.mkdirSync(shotsDir, { recursive: true });
    await sleep(250);
    fs.writeFileSync(path.join(shotsDir, name + '.png'), (await wc.capturePage()).toPNG());
  };
  const key = async (keyCode, modifiers = [], char = false) => {
    wc.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
    if (char) wc.sendInputEvent({ type: 'char', keyCode: char === true ? keyCode : char, modifiers });
    wc.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
    await sleep(70);
  };
  const center = (selector) => js(`(()=>{const e=document.querySelector(${JSON.stringify(selector)}); if(!e) return null; e.scrollIntoView({block:'center'}); const b=e.getBoundingClientRect(); return {x:Math.round(b.x+b.width/2), y:Math.round(b.y+b.height/2)};})()`);
  const clickAt = async (x, y) => {
    wc.sendInputEvent({ type: 'mouseMove', x, y });
    wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
    wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
    await sleep(90);
  };
  const click = async (selector) => {
    const r = await center(selector);
    if (!r) throw new Error('nothing to click: ' + selector);
    await clickAt(r.x, r.y);
  };
  const typeText = async (text) => { for (const ch of text) wc.sendInputEvent({ type: 'char', keyCode: ch }); await sleep(120); };
  /** Click into a text field, replace its content, and commit with Enter. */
  const fill = async (selector, text) => {
    await click(selector);
    await js(`document.querySelector(${JSON.stringify(selector)}).select()`);
    await typeText(text);
    await key('Return', [], String.fromCharCode(13));
  };
  // waveform helpers (CSS pixels of the page)
  const wavePos = (t) => js(`(()=>{const w=window.__app.wave; const r=document.getElementById('wave').getBoundingClientRect(); return {x:Math.round(r.left + w.xAt(${t})), y:Math.round(r.top + r.height*0.6)};})()`);
  const dragSelect = async (t1, t2) => {
    const a = await wavePos(t1); const b = await wavePos(t2);
    wc.sendInputEvent({ type: 'mouseMove', x: a.x, y: a.y });
    wc.sendInputEvent({ type: 'mouseDown', x: a.x, y: a.y, button: 'left', clickCount: 1 });
    const mid = Math.round((a.x + b.x) / 2);
    wc.sendInputEvent({ type: 'mouseMove', x: mid, y: a.y, modifiers: ['leftButtonDown'] });
    wc.sendInputEvent({ type: 'mouseMove', x: b.x, y: b.y, modifiers: ['leftButtonDown'] });
    wc.sendInputEvent({ type: 'mouseUp', x: b.x, y: b.y, button: 'left', clickCount: 1 });
    await sleep(120);
  };
  const S = (expr) => js(`(()=>{const S=window.__app.S; return ${expr};})()`);
  const decodeFile = (f) => { const d = K.decode(ff, f); if (d.errors) throw new Error('decode errors: ' + d.errors); return d; };
  const heardSeconds = (d, secs) => secs.map((t) => Math.round(K.freqOf(d, t - 0.35, t + 0.35) / 100) * 100);
  wc.on('console-message', (_e, level, message) => { if (level >= 2) errors.push(message); });

  try {
    win.setContentSize(1240, 800);
    // ---------------------------------------------------------------- fixtures
    const ten = K.makeWav(path.join(dir, 'Ten Steps.wav'), { rate: 44100, channels: 2, parts: K.steps(10) });  // second n = 200 + 100n Hz
    const six = K.makeWav(path.join(dir, 'Six Steps.wav'), { rate: 48000, channels: 1, parts: K.steps(6).map((p, i) => ({ ...p, freq: 2000 - i * 100 })) });
    const tenSha = sha(ten);
    const wma = path.join(dir, 'Old Format.wma');
    const mk = spawnSync(ff, ['-hide_banner', '-v', 'error', '-y', '-i', ten, '-t', '3', '-c:a', 'wmav2', wma], { encoding: 'utf8', windowsHide: true });
    notes.wma = mk.status === 0 ? 'made' : 'could not make: ' + String(mk.stderr).slice(-100);
    await waitFor('!!window.__app');

    await step('starts empty, with a hint and no editor', async () => {
      eq(await js('document.getElementById("empty").hidden'), false, 'empty state shown');
      eq(await js('document.getElementById("editor").hidden'), true, 'editor hidden');
      eq(await js('document.getElementById("export").disabled'), true, 'save disabled');
      eq(await js('window.ae.encoders().then(r => r.ok)'), true, 'all encoders present');
    });

    await step('adding a file (as a drop does) shows its waveform', async () => {
      await js(`window.ae.openPaths([${JSON.stringify(ten)}]).then(l => window.__app.addOpened(l))`);
      await waitFor('window.__app.S.items.length === 1 && window.__app.S.items[0].peaksState === "ready"', 8000, 'waveform');
      eq(await js('document.getElementById("editor").hidden'), false, 'editor shown');
      eq(await js('document.getElementById("fname").textContent'), 'Ten Steps.wav', 'file name');
      eq(await js('document.getElementById("len").textContent'), '0:10.000', 'length');
      await sleep(250);
      // the canvas has really been drawn: coloured waveform pixels in the middle band, one for each second of the steps
      const drawn = await js(`(()=>{const w=window.__app.wave; const c=w.base; const g=c.getContext('2d'); const y=Math.round(c.height*0.6); const row=g.getImageData(0,y,c.width,1).data; let n=0; for(let i=0;i<row.length;i+=4){ if(row[i+2]>200 && row[i]<150) n++; } return {n, w:c.width};})()`);
      if (drawn.n < drawn.w * 0.5) throw new Error(`waveform barely drawn: ${drawn.n} of ${drawn.w} columns`);
      eq(await S('S.items[0].channels'), 2, 'stereo detected');
      eq(await js('document.getElementById("summary").textContent.includes("Result: 0:10")'), true, 'summary');
      await shot('01-loaded');
    });

    await step('dragging on the waveform selects a part (real mouse)', async () => {
      await dragSelect(2, 5);
      const sel = await S('S.sel');
      if (!sel) throw new Error('no selection made');
      near(sel[0], 2, 0.15, 'selection start'); near(sel[1], 5, 0.15, 'selection end');
      eq(await js('document.getElementById("cut").disabled'), false, 'cut enabled');
      eq(await js('document.getElementById("selStart").value.length > 0'), true, 'start box filled');
      await shot('02-selected');
    });

    await step('the selection edge can be dragged to change it', async () => {
      const before = await S('S.sel');
      const e = await wavePos(before[1]);
      const to = await wavePos(before[1] + 1);
      wc.sendInputEvent({ type: 'mouseMove', x: e.x, y: e.y });
      wc.sendInputEvent({ type: 'mouseDown', x: e.x, y: e.y, button: 'left', clickCount: 1 });
      wc.sendInputEvent({ type: 'mouseMove', x: to.x, y: to.y, modifiers: ['leftButtonDown'] });
      wc.sendInputEvent({ type: 'mouseUp', x: to.x, y: to.y, button: 'left', clickCount: 1 });
      await sleep(120);
      const after = await S('S.sel');
      near(after[0], before[0], 0.05, 'start unchanged'); near(after[1], before[1] + 1, 0.2, 'end moved by 1 s');
    });

    await step('typing times in the Start and End boxes sets the selection', async () => {
      await fill('#selStart', '2');
      await fill('#selEnd', '0:05');
      const sel = await S('S.sel');
      near(sel[0], 2, 1e-6, 'start'); near(sel[1], 5, 1e-6, 'end');
      eq(await js('document.getElementById("selLen").textContent'), '0:03.000', 'length shown');
      await fill('#selEnd', 'banana');
      eq(await js('document.getElementById("toast").hidden'), false, 'bad time is reported');
      near((await S('S.sel'))[1], 5, 1e-6, 'bad time leaves the selection alone');
    });

    await step('Cut out selection (real click) removes the part, shows it dimmed, updates the summary', async () => {
      await click('#cut');
      const cuts = await S('S.items[0].cuts');
      eq(JSON.stringify(cuts), '[[2,5]]', 'cuts');
      eq(await S('S.sel'), null, 'selection cleared');
      eq(await js('document.getElementById("summary").textContent.includes("Result: 0:07")'), true, 'summary says 0:07');
      eq(await js('document.querySelectorAll("#cuts li").length'), 1, 'one removed-part chip');
      eq(await js('document.querySelector(".item .meta").textContent.includes("now 0:07")'), true, 'list shows the new length');
      await shot('03-cut');
    });

    await step('Ctrl+Z undoes and Ctrl+Y redoes', async () => {
      await js('document.activeElement && document.activeElement.blur()');
      await key('Z', ['control']);
      eq(await S('S.items[0].cuts.length'), 0, 'undone');
      eq(await js('document.getElementById("summary").textContent.includes("Result: 0:10")'), true, 'summary back to 0:10');
      await key('Y', ['control']);
      eq(await S('JSON.stringify(S.items[0].cuts)'), '[[2,5]]', 'redone');
    });

    await step('Delete cuts the selection; the cut list can put a part back', async () => {
      await fill('#selStart', '6');
      await fill('#selEnd', '8');
      await js('document.activeElement && document.activeElement.blur()');
      await key('Delete');
      eq(await S('JSON.stringify(S.items[0].cuts)'), '[[2,5],[6,8]]', 'two cuts');
      eq(await js('document.querySelectorAll("#cuts li").length'), 2, 'two chips');
      await click('#cuts li:last-child .x');
      eq(await S('JSON.stringify(S.items[0].cuts)'), '[[2,5]]', 'second put back');
      await js('document.activeElement && document.activeElement.blur()');
      await fill('#selStart', '6'); await fill('#selEnd', '8');
      await js('document.activeElement && document.activeElement.blur()');
      await key('Delete');
      eq(await S('JSON.stringify(S.items[0].cuts)'), '[[2,5],[6,8]]', 'cut again');
    });

    await step('playback skips the removed parts and really plays', async () => {
      await js('window.__app.seek(1.6)');
      await js('document.activeElement && document.activeElement.blur()');
      await key('Space', [], ' ');
      eq(await S('S.playing'), true, 'playing after Space');
      const seen = [];
      const end = Date.now() + 2500;
      while (Date.now() < end) { seen.push(await js('window.__app.A.currentTime')); if (seen[seen.length - 1] > 5.6) break; await sleep(15); }
      const insideCut = seen.filter((t) => t > 2.06 && t < 4.94).length;
      const last = seen[seen.length - 1];
      if (last < 5.2) throw new Error(`playback never got past the cut (reached ${last.toFixed(2)})`);
      if (insideCut > 0) throw new Error(`${insideCut} samples of playback were inside the removed part`);
      eq(await js('window.__app.A.paused'), false, 'audio element is playing');
      near(await js('window.__app.wave.head'), last, 0.4, 'playhead follows the audio');
      await key('Space', [], ' ');
      eq(await S('S.playing'), false, 'paused by Space');
    });

    await step('a file the player cannot play (WMA) is still editable and playable through a decoded copy', async () => {
      if (mk.status !== 0) return 'skipped: ffmpeg could not make a WMA here';
      await js(`window.ae.openPaths([${JSON.stringify(wma)}]).then(l => window.__app.addOpened(l))`);
      await waitFor('window.__app.S.items.length === 2 && window.__app.S.items[1].peaksState === "ready"', 8000, 'wma waveform');
      await js('window.__app.selectItem(1, true)');
      await waitFor('window.__app.A.currentSrc.startsWith("aed://p/")', 8000, 'fallback source');
      await waitFor('window.__app.A.readyState >= 2', 8000, 'fallback ready');
      await js('window.__app.selectItem(0, true)');
      await click('.item:nth-child(2) .tools button:nth-child(3)'); // remove the WMA again
      eq(await S('S.items.length'), 1, 'removed');
    });

    await step('format, fades and volume controls change the plan', async () => {
      await js(`(()=>{const f=document.getElementById('format'); f.value='flac'; f.dispatchEvent(new Event('change'));})()`);
      eq(await js('document.getElementById("qualityRow").hidden'), true, 'no quality choice for lossless');
      await js(`(()=>{const f=document.getElementById('format'); f.value='mp3'; f.dispatchEvent(new Event('change'));})()`);
      eq(await js('document.getElementById("qualityRow").hidden'), false, 'quality choice for MP3');
      await fill('#fadeIn', '0.5'); await fill('#fadeOut', '1');
      eq(await js('window.__app.readOpts().fadeOut'), '1', 'fade out read');
      await js(`(()=>{const f=document.getElementById('format'); f.value='wav'; f.dispatchEvent(new Event('change'));})()`);
      await fill('#fadeIn', '20'); await fill('#fadeOut', '20');
      eq(await js('document.getElementById("export").disabled'), true, 'fades longer than the result disable saving');
      eq(await js('document.getElementById("summary").className'), 'summary error', 'with a readable reason');
      await fill('#fadeIn', '0.5'); await fill('#fadeOut', '1');
      eq(await js('document.getElementById("export").disabled'), false, 'fixed again');
    });

    await step('Preview result renders the edit and plays it', async () => {
      await click('#preview');
      await waitFor('!document.getElementById("previewBox").hidden', 15000, 'preview box');
      await waitFor('document.getElementById("previewAudio").duration > 0', 8000, 'preview duration');
      near(await js('document.getElementById("previewAudio").duration'), 5, 0.1, 'previewed length (10 s minus the 3 s and 2 s cuts)');
      await waitFor('document.getElementById("previewAudio").currentTime > 0.2', 6000, 'preview playing');
      await js('document.getElementById("previewAudio").pause()');
      await shot('04-preview');
    });

    await step('Save (real click) writes a new file; the original is untouched; the file sounds as edited', async () => {
      await js(`(()=>{const o=document.getElementById('outDir'); o.value=${JSON.stringify(outDir)}; o.dataset.path=${JSON.stringify(outDir)}; document.getElementById('format').value='wav'; document.getElementById('format').dispatchEvent(new Event('change'));})()`);
      await click('#export');
      await waitFor('!document.getElementById("result").hidden && document.getElementById("result").className.includes("ok")', 20000, 'saved');
      const files = fs.readdirSync(outDir);
      eq(files.length, 1, 'one output file: ' + files);
      eq(files[0], 'Ten Steps (edited).wav', 'default name');
      const d = decodeFile(path.join(outDir, files[0]));
      near(K.seconds(d), 5, 0.06, 'saved length');
      // kept: 0-2 (200, 300 Hz), 5-6 (700), 8-10 (1000, 1100)
      eq(JSON.stringify(heardSeconds(d, [0.5, 1.5, 2.5, 3.5, 4.5])), JSON.stringify([200, 300, 700, 1000, 1100]), 'what was kept, in order');
      assert(K.rmsDb(d, 0, 0.04) < K.rmsDb(d, 0.8, 1.2) - 15, 'fade in at the start');
      assert(K.peakDb(d, 4.99, 5) < -40, 'fade out at the end');
      eq(sha(ten), tenSha, 'the original file is unchanged');
      eq(await js('document.querySelector("#result .path").textContent'), path.join(outDir, files[0]), 'path shown');
      await shot('05-saved');
    });

    await step('saving again never overwrites: the second file gets (1)', async () => {
      await click('#export');
      await waitFor('document.getElementById("result").className.includes("ok") && document.querySelector("#result .path").textContent.includes("(1)")', 20000, 'second save');
      eq(fs.readdirSync(outDir).sort().join('|'), 'Ten Steps (edited) (1).wav|Ten Steps (edited).wav', 'both files exist');
    });

    await step('adding a second file turns on joining; order can be changed; crossfade is offered', async () => {
      await js(`window.ae.openPaths([${JSON.stringify(six)}]).then(l => window.__app.addOpened(l))`);
      await waitFor('window.__app.S.items.length === 2 && window.__app.S.items[1].peaksState === "ready"', 8000);
      eq(await js('document.getElementById("joinBox").hidden'), false, 'between-files box');
      eq(await js('document.getElementById("joinHint").hidden'), false, 'join hint');
      await js(`(()=>{const j=document.getElementById('join'); j.value='cross'; j.dispatchEvent(new Event('change'));})()`);
      eq(await js('document.getElementById("joinSecRow").hidden'), false, 'crossfade length box');
      eq(await js('document.getElementById("joinSeconds").value'), '2', 'default crossfade 2 s');
      // 5 s of the first file are left after the cuts (10 s minus 3 s and 2 s), + 6 s - 2 s crossfade = 9 s
      eq(await js('document.getElementById("summary").textContent.includes("Result: 0:09")'), true, 'joined length in the summary');
      await click('.item:nth-child(1) .tools button:nth-child(2)'); // move the first file later
      eq(await S('S.items.map(i => i.name).join("|")'), 'Six Steps.wav|Ten Steps.wav', 'order changed');
      eq(await S('S.cur'), 1, 'the selection followed the file');
      await shot('06-joined');
    });

    await step('the joined result has both files, in the new order, with a crossfade', async () => {
      await fill('#fadeIn', '0'); await fill('#fadeOut', '0');
      await fill('#name', 'joined result');
      await click('#export');
      await waitFor('document.getElementById("result").className.includes("ok") && document.querySelector("#result .path").textContent.includes("joined result")', 25000, 'joined save');
      const f = path.join(outDir, 'joined result.wav');
      const d = decodeFile(f);
      near(K.seconds(d), 9, 0.08, 'joined length');
      // six.wav first: 2000, 1900, 1800... Hz per second (mono 48 kHz), 6 s; then ten.wav's kept parts
      near(K.freqOf(d, 0.2, 0.8), 2000, 40, 'starts with the Six Steps file');
      near(K.freqOf(d, 6.4, 6.9), 700, 20, 'then the Ten Steps file: it starts at 4 s (6 s minus the 2 s crossfade), so 6.4 s is 2.4 s into it = its 3rd kept second (700 Hz)');
      assert(K.rmsDb(d, 3.0, 3.5) > -14, 'no gap in the first file (a mono file played in stereo is 3 dB lower per side)');
      eq(sha(ten), tenSha, 'the original is still unchanged');
    });

    await step('Undo brings the removed file back with its cuts', async () => {
      await js('document.activeElement && document.activeElement.blur()');
      await click('.item:nth-child(2) .tools button:nth-child(3)');
      eq(await S('S.items.length'), 1, 'removed');
      await key('Z', ['control']);
      eq(await S('S.items.length'), 2, 'back');
      eq(await S('JSON.stringify(S.items.find(i => i.name === "Ten Steps.wav").cuts)'), '[[2,5],[6,8]]', 'its cuts are still there');
    });

    await step('zoom with Ctrl+wheel, scrollbar follows, Fit restores', async () => {
      const w0 = await js('window.__app.wave.pps');
      const r = await center('#wave');
      wc.sendInputEvent({ type: 'mouseWheel', x: r.x, y: r.y, deltaX: 0, deltaY: 120, modifiers: ['control'], canScroll: true });
      wc.sendInputEvent({ type: 'mouseWheel', x: r.x, y: r.y, deltaX: 0, deltaY: 120, modifiers: ['control'], canScroll: true });
      await sleep(150);
      const w1 = await js('window.__app.wave.pps');
      if (!(w1 > w0 * 1.4)) throw new Error(`zoom did not increase: ${w0} -> ${w1}`);
      const thumb = await js('parseFloat(document.getElementById("thumb").style.width)');
      if (!(thumb < 90)) throw new Error('scrollbar thumb did not shrink: ' + thumb);
      await click('#zoomFit');
      near(await js('window.__app.wave.pps'), w0, w0 * 0.01, 'fit goes back');
    });

    await step('Cancel stops a long save at once and leaves nothing behind', async () => {
      const long = K.makeWav(path.join(dir, 'Long.wav'), { rate: 44100, channels: 2, parts: [{ sec: 900, freq: 330 }] });
      const cdir = path.join(dir, 'cancel');
      // a fresh project with only the long file
      await js(`(()=>{const a=window.__app; while(a.S.items.length) { const i=a.S.items.length-1; document.querySelectorAll('.item .tools button:nth-child(3)')[i].click(); } })()`);
      await js(`window.ae.openPaths([${JSON.stringify(long)}]).then(l => window.__app.addOpened(l))`);
      await waitFor('window.__app.S.items.length === 1', 8000);
      await js(`(()=>{const o=document.getElementById('outDir'); o.dataset.path=${JSON.stringify(cdir)}; o.value=${JSON.stringify(cdir)}; const n=document.getElementById('normalize'); n.value='loudness'; n.dispatchEvent(new Event('change')); document.getElementById('format').value='flac'; document.getElementById('format').dispatchEvent(new Event('change')); document.getElementById('name').value=''; document.getElementById('fadeIn').value='0'; document.getElementById('fadeOut').value='0'; document.getElementById('fadeIn').dispatchEvent(new Event('input'));})()`);
      await click('#export');
      await waitFor('window.__app.S.busy === "export" && !document.getElementById("cancel").hidden', 4000, 'busy');
      eq(await js('document.getElementById("export").hidden'), true, 'Save hidden while working');
      await waitFor('parseFloat(document.getElementById("bar").style.width) > 1', 20000, 'progress');
      const t0 = Date.now();
      await click('#cancel');
      await waitFor('window.__app.S.busy === null', 8000, 'idle again');
      if (Date.now() - t0 > 4000) throw new Error('cancel was slow: ' + (Date.now() - t0) + ' ms');
      eq(await js('document.getElementById("result").textContent.startsWith("Cancelled")'), true, 'says cancelled');
      const left = fs.existsSync(cdir) ? fs.readdirSync(cdir) : [];
      eq(left.length, 0, 'nothing left behind: ' + left);
      eq(await js('document.getElementById("export").hidden'), false, 'Save is back');
    });

    await step('no errors reached the console', async () => {
      const real = errors.filter((m) => !/Autofill\.|ScriptProcessor/.test(m));
      eq(real.length, 0, 'console errors: ' + real.join(' | '));
    });
  } catch (e) {
    results.push({ name: 'test run', ok: false, error: String((e && e.stack) || e) });
  }
  const ok = results.every((r) => r.ok);
  if (outFile) fs.writeFileSync(outFile, JSON.stringify({ ok, results, notes }, null, 2));
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  app.exit(ok ? 0 : 1);

  function assert(c, m) { if (!c) throw new Error(m); }
};
