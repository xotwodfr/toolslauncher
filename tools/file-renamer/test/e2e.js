'use strict';
// End-to-end test: runs inside Electron (`npm run e2e`). Drives the REAL window with real mouse and keyboard input on
// invented files in a temporary folder, and checks both what the page shows and the names on disk after renaming and
// undoing.
const fs = require('fs');
const os = require('os');
const path = require('path');
const K = require('../src/core/testkit');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

exports.run = async ({ app, getWin, outFile, shotsDir, dialog }) => {
  const results = [];
  const errors = [];
  const notes = {};
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'renamer-e2e-'));
  const win = getWin();
  const wc = win.webContents;
  const js = (code) => wc.executeJavaScript(code, true);
  wc.on('console-message', (_e, level, msg) => { if (level >= 2) errors.push(msg); });
  const step = async (name, fn) => {
    try { const detail = await fn(); results.push({ name, ok: true, detail: detail === undefined ? '' : detail }); console.log('ok   ' + name); }
    catch (e) { results.push({ name, ok: false, error: String((e && e.message) || e) }); console.log('FAIL ' + name + ': ' + ((e && e.message) || e)); }
  };
  const assert = (c, m) => { if (!c) throw new Error(m); };
  const eq = (a, b, what) => { const x = JSON.stringify(a); const y = JSON.stringify(b); if (x !== y) throw new Error(`${what}: expected ${y}, got ${x}`); };
  const waitFor = async (expr, ms = 10000, what = expr) => {
    const end = Date.now() + ms;
    for (;;) { const v = await js(expr); if (v) return v; if (Date.now() > end) throw new Error('timed out waiting for ' + what); await sleep(40); }
  };
  const shot = async (name) => { if (!shotsDir) return; fs.mkdirSync(shotsDir, { recursive: true }); await sleep(250); fs.writeFileSync(path.join(shotsDir, name + '.png'), (await wc.capturePage()).toPNG()); };
  const key = async (keyCode, modifiers = [], char = false) => {
    wc.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
    if (char) wc.sendInputEvent({ type: 'char', keyCode: char === true ? keyCode : char, modifiers });
    wc.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
    await sleep(25);
  };
  const typeText = async (text) => { for (const ch of text) await key(ch, [], true); };
  const center = (selector) => js(`(()=>{const e=document.querySelector(${JSON.stringify(selector)}); if(!e) return null; e.scrollIntoView({block:'nearest'}); const b=e.getBoundingClientRect(); if(!b.width) return null; return {x:Math.round(b.x+b.width/2), y:Math.round(b.y+b.height/2)};})()`);
  const clickAt = async (x, y) => {
    wc.sendInputEvent({ type: 'mouseMove', x, y });
    wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
    wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
    await sleep(90);
  };
  const click = async (selector) => { const r = await center(selector); if (!r) throw new Error('nothing to click: ' + selector); await clickAt(r.x, r.y); };
  const typeInto = async (selector, text) => { await click(selector); await key('a', ['control']); await key('Backspace'); await typeText(text); };
  /** Choose an option of a <select>: focus it with a real click (closing the popup again) and pick with the keyboard. */
  const choose = async (selector, value) => {
    await js(`(() => { const s = document.querySelector(${JSON.stringify(selector)}); s.focus(); s.value = ${JSON.stringify(value)}; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await sleep(60);
  };
  const settled = () => waitFor('window.__app.S.ready', 5000).then(() => sleep(250)).then(() => waitFor('!document.getElementById("rename").textContent.includes("…")', 5000));
  const newNames = () => js('window.__app.rows().map((r) => r.newName)');
  const ls = (d) => fs.readdirSync(d).sort();
  const lastRule = '#ruleList .rule:last-child';

  try {
    win.setContentSize(1280, 820);
    // ---- invented files ----------------------------------------------------------------------------------------------------
    const photos = path.join(dir, 'Camera Roll'); fs.mkdirSync(photos);
    K.jpegWithDate(path.join(photos, 'IMG_0412.JPG'), '2023:08:19 10:15:00');
    K.jpegWithDate(path.join(photos, 'IMG_0413.JPG'), '2023:08:19 16:42:30');
    K.jpegWithDate(path.join(photos, 'IMG_0420.JPG'), '2023:08:21 08:05:10');
    fs.writeFileSync(path.join(photos, 'screenshot.JPG'), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    const photoNames = ls(photos);
    const music = path.join(dir, 'Music'); fs.mkdirSync(music);
    K.mp3WithTags(path.join(music, 'track1.mp3'), { title: 'Paper Lanterns', artist: 'Aster Vale', track: '1' });
    K.mp3WithTags(path.join(music, 'track2.mp3'), { title: 'Slow Orbit', artist: 'Aster Vale', track: '2' });
    K.flacWithTags(path.join(music, 'track3.flac'), { title: 'Glass Avenue', artist: 'Aster Vale', track: '3' });
    const docs = path.join(dir, 'Docs'); fs.mkdirSync(docs);
    for (const [n, c] of [['a.txt', 'A'], ['b.txt', 'B'], ['report v1.txt', '1'], ['report v2.txt', '2'], ['Notes.TXT', 'N']]) fs.writeFileSync(path.join(docs, n), c);

    let openReturn = [];
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: openReturn });

    await step('the window starts empty with Rename disabled', async () => {
      await waitFor('window.__app && window.__app.S.ready');
      eq(await js('document.getElementById("empty").hidden'), false, 'drop zone');
      eq(await js('document.getElementById("rename").disabled'), true, 'rename disabled');
      eq(await js('document.getElementById("noRules").hidden'), false, 'rules hint');
    });

    await step('Add folder… (real click) lists the photos; a Date rule from EXIF previews new names and marks the photo without a date', async () => {
      openReturn = [photos];
      await click('#addFolder2');
      await waitFor('window.__app.rows().length === 4', 8000, 'four files');
      await choose('#addRule', 'date');
      await waitFor('document.querySelectorAll("#ruleList .rule").length === 1');
      await choose(`${lastRule} select[data-key="source"]`, 'exif');
      await typeInto(`${lastRule} input[data-key="format"]`, 'YYYY-MM-DD HH.mm.ss');
      await choose(`${lastRule} select[data-key="where"]`, 'replace');
      await settled();
      eq(await newNames(), ['2023-08-19 10.15.00.JPG', '2023-08-19 16.42.30.JPG', '2023-08-21 08.05.10.JPG', 'screenshot.JPG'], 'new names');
      eq(await js('document.getElementById("rename").disabled'), true, 'rename waits for the problem');
      assert(/No photo date/.test(await js('document.querySelector("#rows .trow.error .note").textContent')), 'the problem is shown on the row');
      assert(await js('document.querySelector("#ruleList .rule").classList.contains("bad")'), 'the rule is marked');
      await shot('1-problem');
    });

    await step('a second rule (extension lower case) applies after the first; untick and reorder change the result', async () => {
      await choose('#addRule', 'extension');
      await settled();
      eq((await newNames())[0], '2023-08-19 10.15.00.jpg', 'extension lowered');
      await click('#ruleList .rule:last-child .rtitle input[type=checkbox]');
      await settled();
      eq((await newNames())[0], '2023-08-19 10.15.00.JPG', 'rule switched off');
      await click('#ruleList .rule:last-child .rtitle input[type=checkbox]');
      await click('#ruleList .rule:last-child [data-act="up"]');
      await settled();
      eq(await js('[...document.querySelectorAll("#ruleList .rname")].map((e) => e.textContent)'), ['Extension', 'Date'], 'order');
      eq((await newNames())[0], '2023-08-19 10.15.00.jpg', 'same result in the other order');
    });

    await step('"Remove files with problems" then Rename (real clicks) renames the photos on disk', async () => {
      await click('#dropBad');
      await settled();
      eq(await js('window.__app.rows().length'), 3, 'three files left');
      eq(await js('document.getElementById("rename").textContent'), 'Rename 3 files', 'button says how many');
      await click('#rename');
      await waitFor('/Renamed 3 files/.test(document.getElementById("result").textContent)');
      eq(ls(photos), ['2023-08-19 10.15.00.jpg', '2023-08-19 16.42.30.jpg', '2023-08-21 08.05.10.jpg', 'screenshot.JPG'], 'on disk');
      await settled();
      eq(await js('window.__app.S.summary.same'), 3, 'the list follows the new names (nothing left to do)');
      await shot('2-renamed');
    });

    await step('Undo (real click) puts back the exact old names', async () => {
      await click('#undoLast');
      await waitFor('/Undone: 3 files/.test(document.getElementById("result").textContent)');
      eq(ls(photos), photoNames, 'old names');
    });

    await step('audio tags: {track} - {artist} - {title} from MP3 and FLAC tags', async () => {
      await click('#clear');
      await waitFor('window.__app.rows().length === 0');
      await js('window.__app.clearRules()');
      openReturn = [music];
      await click('#addFolder');
      await waitFor('window.__app.rows().length === 3', 8000, 'three songs');
      await choose('#addRule', 'tags');
      await typeInto(`${lastRule} input[data-key="pattern"]`, '{track} - {artist} - {title}');
      await choose(`${lastRule} select[data-key="where"]`, 'replace');
      await settled();
      eq(await newNames(), ['01 - Aster Vale - Paper Lanterns.mp3', '02 - Aster Vale - Slow Orbit.mp3', '03 - Aster Vale - Glass Avenue.flac'], 'tag names');
      await click('#rename');
      await waitFor('/Renamed 3 files/.test(document.getElementById("result").textContent)');
      eq(ls(music), ['01 - Aster Vale - Paper Lanterns.mp3', '02 - Aster Vale - Slow Orbit.mp3', '03 - Aster Vale - Glass Avenue.flac'], 'on disk');
    });

    await step('a swap typed with the keyboard (a→b, b→a via three find & replace rules) renames through temporary names', async () => {
      await click('#clear');
      await js('window.__app.clearRules()');
      openReturn = [path.join(docs, 'a.txt'), path.join(docs, 'b.txt')];
      await click('#addFiles');
      await waitFor('window.__app.rows().length === 2');
      for (const [f, r] of [['a', '#'], ['b', 'a'], ['#', 'b']]) {
        await choose('#addRule', 'replace');
        await typeInto(`${lastRule} input[data-key="find"]`, f);
        await typeInto(`${lastRule} input[data-key="replace"]`, r);
      }
      await settled();
      eq(await newNames(), ['b.txt', 'a.txt'], 'swap preview');
      assert(/Takes the name of another file/.test(await js('document.querySelector("#rows .trow .note").textContent')), 'swap explained');
      await click('#rename');
      await waitFor('/Renamed 2 files/.test(document.getElementById("result").textContent)');
      eq(fs.readFileSync(path.join(docs, 'a.txt'), 'utf8'), 'B', 'a.txt now holds B');
      eq(fs.readFileSync(path.join(docs, 'b.txt'), 'utf8'), 'A', 'b.txt now holds A');
      assert(!ls(docs).some((n) => n.includes('.renaming-')), 'no temporary names left');
    });

    await step('duplicates and Windows-invalid names block Rename; "Fix clashes" adds (2)', async () => {
      await click('#clear');
      await js('window.__app.clearRules()');
      openReturn = [path.join(docs, 'report v1.txt'), path.join(docs, 'report v2.txt')];
      await click('#addFiles');
      await waitFor('window.__app.rows().length === 2');
      await choose('#addRule', 'remove');
      await choose(`${lastRule} select[data-key="mode"]`, 'last');
      await typeInto(`${lastRule} input[data-key="count"]`, '3');
      await settled();
      eq(await newNames(), ['report.txt', 'report.txt'], 'same name twice');
      eq(await js('document.querySelectorAll("#rows .trow.error").length'), 2, 'both marked');
      eq(await js('document.getElementById("rename").disabled'), true, 'blocked');
      await click('#autoSuffix');
      await settled();
      eq(await newNames(), ['report.txt', 'report (2).txt'], 'fixed with (2)');
      eq(await js('document.getElementById("rename").disabled'), false, 'allowed now');
      await click('#autoSuffix');
      await choose('#addRule', 'insert');
      await typeInto(`${lastRule} input[data-key="text"]`, '?');
      await settled();
      assert(/Not allowed on Windows: "\?"/.test(await js('document.querySelector("#rows .trow.error .note").textContent')), 'Windows check: ' + await js('document.querySelector("#rows .trow.error .note").textContent'));
      await shot('3-problems');
      await click(`${lastRule} [data-act="del"]`);
    });

    await step('presets: save the stack under a name, clear it, load it back', async () => {
      await typeInto('#presetName', 'Drop version');
      await click('#savePreset');
      await waitFor('[...document.getElementById("preset").options].some((o) => o.value === "Drop version")');
      await click('#ruleList .rule [data-act="del"]');
      await waitFor('document.querySelectorAll("#ruleList .rule").length === 0');
      await choose('#preset', 'Drop version');
      await waitFor('document.querySelectorAll("#ruleList .rule").length === 1');
      eq(await js('document.querySelector("#ruleList .rule select[data-key=mode]").value'), 'last', 'settings restored');
    });

    await step('History & undo (real clicks) lists every batch and undoes the music batch', async () => {
      await click('#histBtn');
      await waitFor('document.getElementById("histDlg").open && document.querySelectorAll("#histList .hitem").length === 3');
      const states = await js('[...document.querySelectorAll("#histList .hitem .st")].map((e) => e.textContent)');
      eq(states, ['Done', 'Done', 'Undone'], 'swap, music, photos (newest first)');
      await shot('4-history');
      await click('#histList .hitem:nth-child(2) [data-undo]');
      await waitFor('/Undone: 3 files/.test(document.getElementById("result").textContent)');
      eq(ls(music), ['track1.mp3', 'track2.mp3', 'track3.flac'], 'music names back');
      await waitFor('[...document.querySelectorAll("#histList .hitem .st")].map((e) => e.textContent).join() === "Done,Undone,Undone"');
      await click('#histClose');
    });

    await step('undo refuses a file that was changed since, and offers to undo the rest', async () => {
      await click('#clear');
      await js('window.__app.clearRules()');
      openReturn = [path.join(docs, 'Notes.TXT'), path.join(docs, 'report v1.txt')];
      await click('#addFiles');
      await waitFor('window.__app.rows().length === 2');
      await choose('#addRule', 'case');
      await choose(`${lastRule} select[data-key="mode"]`, 'upper');
      await settled();
      await click('#rename');
      await waitFor('/Renamed 2 files/.test(document.getElementById("result").textContent)');
      fs.writeFileSync(path.join(docs, 'REPORT V1.txt'), 'edited after renaming');
      await click('#undoLast');
      await waitFor('!!document.getElementById("undoPartial")');
      assert(/changed or replaced/.test(await js('document.getElementById("result").textContent')), 'says why');
      await click('#undoPartial');
      await waitFor('/Undone: 1 file/.test(document.getElementById("result").textContent)');
      assert(ls(docs).includes('Notes.TXT') && ls(docs).includes('REPORT V1.txt'), 'only the unchanged file was undone: ' + ls(docs));
    });

    await step('no errors in the console', async () => { if (errors.length) throw new Error(errors.join(' | ')); });
  } catch (e) {
    results.push({ name: 'test harness', ok: false, error: String((e && e.stack) || e) });
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  const ok = results.every((r) => r.ok);
  fs.writeFileSync(outFile, JSON.stringify({ ok, results, notes }, null, 2));
  app.exit(ok ? 0 : 1);
};
