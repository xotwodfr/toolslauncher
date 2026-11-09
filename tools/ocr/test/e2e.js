'use strict';
// End-to-end test: runs inside Electron (`npm run e2e`). Drives the REAL window with real clicks, drags and typing, runs the
// real OCR engine on pictures with known text, and checks the files it writes. (Only the native file dialogs are replaced,
// because a test cannot press buttons in them.)
const fs = require('fs');
const os = require('os');
const path = require('path');
const { dialog, clipboard, nativeImage } = require('electron');
const Tidy = require('../src/tidy');
const PNG = require('./pngtools');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const FX = path.join(__dirname, 'fixtures');
const FOX = 'The quick brown fox jumps over the lazy dog';
const PARA = 'Meeting notes: the budget review moved to Thursday.\nPlease bring the signed forms and a printed copy\nof the schedule. Lunch will be provided.';

exports.run = async ({ app, getWin, outFile, shotsDir }) => {
  const results = [];
  const errors = [];
  const notes = {};
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-e2e-'));
  const win = getWin();
  const wc = win.webContents;
  const js = (code) => wc.executeJavaScript(code, true);
  const step = async (name, fn) => {
    try { const detail = await fn(); results.push({ name, ok: true, detail: detail === undefined ? '' : detail }); console.log('ok   ' + name); }
    catch (e) { results.push({ name, ok: false, error: String((e && e.message) || e) }); console.log('FAIL ' + name + ': ' + ((e && e.message) || e)); }
  };
  const eq = (a, b, what) => { if (a !== b) throw new Error(`${what}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); };
  const ok = (c, m) => { if (!c) throw new Error(m); };
  const waitFor = async (expr, ms = 8000, what = expr) => {
    const end = Date.now() + ms;
    for (;;) { const v = await js(expr); if (v) return v; if (Date.now() > end) throw new Error('timed out waiting for ' + what); await sleep(40); }
  };
  const shot = async (name) => {
    if (!shotsDir) return;
    fs.mkdirSync(shotsDir, { recursive: true });
    await sleep(250);
    fs.writeFileSync(path.join(shotsDir, name + '.png'), (await wc.capturePage()).toPNG());
  };
  const center = (selector) => js(`(()=>{const e=document.querySelector(${JSON.stringify(selector)}); if(!e) return null; e.scrollIntoView({block:'center'}); const b=e.getBoundingClientRect(); return {x:Math.round(b.x+b.width/2), y:Math.round(b.y+b.height/2)};})()`);
  const click = async (selector) => {
    const r = await center(selector);
    if (!r) throw new Error('nothing to click: ' + selector);
    wc.sendInputEvent({ type: 'mouseMove', x: r.x, y: r.y });
    wc.sendInputEvent({ type: 'mouseDown', x: r.x, y: r.y, button: 'left', clickCount: 1 });
    wc.sendInputEvent({ type: 'mouseUp', x: r.x, y: r.y, button: 'left', clickCount: 1 });
    await sleep(120);
  };
  const typeText = async (text) => { for (const ch of text) wc.sendInputEvent({ type: 'char', keyCode: ch }); await sleep(120); };
  const text = () => js('document.getElementById("text").value');
  const addFiles = async (names) => js(`window.ocr.openPaths(${JSON.stringify(names.map((n) => path.join(FX, n)))}).then(l => window.__app.addItems(l))`);
  const readNow = async () => {
    await click('#read');
    await waitFor('window.__app.S.busy === false && window.__app.S.items[window.__app.S.cur].status !== "reading"', 60000, 'reading to finish');
  };
  const sim = (a, b) => Tidy.similarity(a, b);
  wc.on('console-message', (_e, level, message) => { if (level >= 2) errors.push(message); });

  try {
    win.setContentSize(1240, 800);
    await waitFor('!!window.__app');

    await step('starts empty, offers all 12 languages, and picks one from the system language', async () => {
      eq(await js('document.getElementById("empty").hidden'), false, 'empty state');
      await waitFor('document.getElementById("lang").options.length > 0', 4000, 'languages');
      eq(await js('document.getElementById("lang").options.length'), 12, 'languages');
      eq(await js('document.getElementById("read").disabled'), true, 'read disabled');
      eq(await js('document.getElementById("lang").value'), 'eng', 'default language for ' + (await js('navigator.language')));
    });

    await step('adding pictures (as a drop does) lists them with thumbnails and shows the first one', async () => {
      await addFiles(['fox.png', 'paragraph.png', 'swedish.png']);
      await waitFor('window.__app.S.items.length === 3', 8000, 'three pictures');
      eq(await js('document.querySelectorAll("#list .item").length'), 3, 'rows');
      eq(await js('[...document.querySelectorAll("#list img")].every(i => i.src.startsWith("data:image/png") && i.naturalWidth > 0)'), true, 'thumbnails');
      eq(await text(), '', 'no text yet');
      eq(await js('document.getElementById("fname").textContent'), 'fox.png', 'first shown');
      eq(await js('document.getElementById("empty").hidden'), true, 'empty state gone');
      const painted = await js(`(()=>{const c=document.getElementById('canvas'); const d=c.getContext('2d').getImageData(0,0,c.width,c.height).data; let dark=0; for(let i=0;i<d.length;i+=4) if(d[i]<100) dark++; return dark;})()`);
      ok(painted > 500, 'the picture is drawn on the canvas (dark text pixels: ' + painted + ')');
    });

    await step('Read the text (real click) reads the English line, draws the word boxes, and reports confidence', async () => {
      await readNow();
      ok(sim(await text(), FOX) >= 0.97, 'text: ' + JSON.stringify(await text()));
      eq(await js('window.__app.S.items[0].words.length'), 9, 'nine words');
      const boxes = await js(`(()=>{const c=document.getElementById('canvas'); const d=c.getContext('2d').getImageData(0,0,c.width,c.height).data; let green=0; for(let i=0;i<d.length;i+=4) if(d[i+1]>150 && d[i]<120 && d[i+2]<150) green++; return green;})()`);
      ok(boxes > 100, 'green word boxes drawn: ' + boxes);
      ok((await js('document.getElementById("stats").textContent')).includes('9 words'), 'stats: ' + (await js('document.getElementById("stats").textContent')));
      eq(await js('document.getElementById("copy").disabled'), false, 'copy enabled');
      ok((await js('document.querySelector("#list .item .meta").textContent')).includes('9 words'), 'list shows the result');
      await shot('01-read');
    });

    await step('"Show what was read" can be turned off', async () => {
      await click('#boxes');
      eq(await js('window.__app.S.opts.boxes'), false, 'off');
      const green = await js(`(()=>{const c=document.getElementById('canvas'); const d=c.getContext('2d').getImageData(0,0,c.width,c.height).data; let g=0; for(let i=0;i<d.length;i+=4) if(d[i+1]>150 && d[i]<120 && d[i+2]<150) g++; return g;})()`);
      eq(green, 0, 'no boxes');
      await click('#boxes');
    });

    await step('Copy puts the text on the clipboard', async () => {
      clipboard.writeText('old contents');
      await click('#copy');
      await sleep(200);
      eq(clipboard.readText(), await text(), 'clipboard');
      eq(await js('document.getElementById("toast").textContent'), 'Copied.', 'toast');
    });

    await step('a drawn box reads only that part of the picture (real drag), in the picture\'s own coordinates', async () => {
      await js('window.__app.selectItem(1, true)');
      await waitFor('window.__app.S.cur === 1 && window.__app.S.bitmapOf === window.__app.S.items[1]', 5000);
      await readNow();
      ok(sim(await text(), PARA) >= 0.96, 'whole paragraph: ' + JSON.stringify(await text()));
      const line2 = await js('window.__app.S.items[1].lines[1]');
      // drag a box around line 2, using the canvas scale
      const r = await js(`(()=>{const c=document.getElementById('canvas').getBoundingClientRect(); const it=window.__app.S.items[1]; const k=c.width/it.w; return {x:c.left, y:c.top, k};})()`);
      const x0 = Math.round(r.x + (line2.x - 10) * r.k); const y0 = Math.round(r.y + (line2.y - 6) * r.k);
      const x1 = Math.round(r.x + (line2.x + line2.w + 10) * r.k); const y1 = Math.round(r.y + (line2.y + line2.h + 6) * r.k);
      wc.sendInputEvent({ type: 'mouseMove', x: x0, y: y0 });
      wc.sendInputEvent({ type: 'mouseDown', x: x0, y: y0, button: 'left', clickCount: 1 });
      wc.sendInputEvent({ type: 'mouseMove', x: Math.round((x0 + x1) / 2), y: Math.round((y0 + y1) / 2), modifiers: ['leftButtonDown'] });
      wc.sendInputEvent({ type: 'mouseMove', x: x1, y: y1, modifiers: ['leftButtonDown'] });
      wc.sendInputEvent({ type: 'mouseUp', x: x1, y: y1, button: 'left', clickCount: 1 });
      await sleep(150);
      const sel = await js('window.__app.S.sel');
      ok(sel && sel.w > 100, 'a selection exists: ' + JSON.stringify(sel));
      eq(await js('document.getElementById("readSel").disabled'), false, 'Read selection enabled');
      await shot('02-selection');
      await click('#readSel');
      await waitFor('window.__app.S.busy === false && window.__app.S.items[1].region', 30000, 'selection read');
      ok(sim(await text(), 'Please bring the signed forms and a printed copy') >= 0.95, 'only line two: ' + JSON.stringify(await text()));
      const w0 = await js('window.__app.S.items[1].words[0]');
      near(w0.y, line2.y, 10, 'word box is where it is in the whole picture');
      eq(await js('window.__app.S.sel'), null, 'selection cleared after reading');
    });

    await step('typing edits the text; Join lines and Reset work', async () => {
      await click('#read');                                         // read the whole paragraph again
      await waitFor('window.__app.S.busy === false && !window.__app.S.items[1].region', 30000);
      const original = await text();
      await js('document.getElementById("text").focus(); document.getElementById("text").setSelectionRange(0, 0)');
      await typeText('NOTE: ');
      ok((await text()).startsWith('NOTE: Meeting'), 'typed: ' + (await text()).slice(0, 30));
      eq(await js('document.getElementById("reset").disabled'), false, 'reset enabled once edited');
      await click('#reset');
      eq(await text(), original, 'reset restores what was read');
      await click('#join');
      const joined = await text();
      eq(joined.includes('\n'), false, 'one line');
      ok(sim(joined, PARA.replace(/\n/g, ' ')) >= 0.96, 'joined: ' + joined);
    });

    await step('another language: Swedish letters are read; a second language can be added', async () => {
      await js('window.__app.selectItem(2, true)');
      await waitFor('window.__app.S.cur === 2 && window.__app.S.bitmapOf === window.__app.S.items[2]', 5000);
      await js('document.getElementById("lang").value = "swe"; document.getElementById("lang").dispatchEvent(new Event("change"))');
      eq(await js('window.__app.S.opts.lang'), 'swe', 'language chosen');
      eq(await js('[...document.getElementById("lang2").options].some(o => o.value === "swe")'), false, 'the main language is not offered as the second');
      await js('document.getElementById("lang2").value = "eng"; document.getElementById("lang2").dispatchEvent(new Event("change"))');
      await readNow();
      const t = await text();
      ok(sim(t, 'Smörgåsar och äppelpaj är gott på söndagen') >= 0.9, 'swedish: ' + JSON.stringify(t));
      ok(/[åäö]/i.test(t), 'letters kept');
      await sleep(500);
      const saved = JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'settings.json'), 'utf8'));
      eq(saved.lang, 'swe', 'language remembered'); eq(saved.lang2, 'eng', 'second language remembered');
    });

    await step('Save as .txt writes a text file (never a picture), with the text as shown', async () => {
      const target = path.join(dir, 'result.png');         // even if a picture name is typed, it becomes .txt
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: target });
      await click('#save');
      await waitFor('!document.getElementById("result").hidden', 5000, 'saved message');
      const written = path.join(dir, 'result.png.txt');
      eq(fs.existsSync(written), true, 'file exists: ' + fs.readdirSync(dir));
      eq(fs.readFileSync(written, 'utf8'), await text(), 'contents');
      eq(fs.existsSync(target), false, 'no picture file was made');
      dialog.showSaveDialog = async () => ({ canceled: true });
      await click('#save');
    });

    await step('Read all reads every picture; Copy all and Save all give one file each and never overwrite', async () => {
      await js('document.getElementById("lang").value = "eng"; document.getElementById("lang").dispatchEvent(new Event("change")); document.getElementById("lang2").value = ""; document.getElementById("lang2").dispatchEvent(new Event("change"))');
      await addFiles(['invoice.png', 'dark.png', 'blank.png']);
      await waitFor('window.__app.S.items.length === 6', 8000);
      eq(await js('document.getElementById("readAll").hidden'), false, 'Read all shown');
      await click('#readAll');
      await waitFor('window.__app.S.busy === false && window.__app.S.items.every(i => i.status === "done")', 90000, 'all read');
      const names = await js('window.__app.S.items.map(i => i.name + ":" + i.text.length)');
      ok(await js('window.__app.S.items[3].text.includes("1,249.50")'), 'invoice amount read: ' + names);
      ok(sim(await js('window.__app.S.items[4].text'), 'Light text on a dark background') >= 0.95, 'dark picture read');
      eq((await js('window.__app.S.items[5].text')).trim(), '', 'blank picture gives no text');
      clipboard.writeText('');
      await click('#copyAll');
      await sleep(200);
      const all = clipboard.readText();
      ok(all.includes('--- fox.png ---') && all.includes('--- invoice.png ---') && !all.includes('--- blank.png ---'), 'headings for pictures that have text: ' + all.slice(0, 80));
      const out = path.join(dir, 'all');
      fs.mkdirSync(out);
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [out] });
      await click('#saveAll');
      await waitFor('document.getElementById("result").textContent.includes("Saved 5 text files")', 5000, 'saved all');
      eq(fs.readdirSync(out).sort().join('|'), 'dark.txt|fox.txt|invoice.txt|paragraph.txt|swedish.txt', 'one file per picture, named after it');
      fs.writeFileSync(path.join(out, 'fox.txt'), 'MY OWN FILE');
      await click('#saveAll');
      await waitFor('document.getElementById("result").textContent.includes("Saved 5")', 5000);
      eq(fs.readFileSync(path.join(out, 'fox.txt'), 'utf8'), 'MY OWN FILE', 'an existing file is never overwritten');
      ok(fs.existsSync(path.join(out, 'fox (1).txt')), 'the new one got (1)');
      await shot('03-all');
    });

    await step('a blank picture says so and suggests what to try', async () => {
      await js('window.__app.selectItem(5, true)');
      await waitFor('window.__app.S.cur === 5 && window.__app.S.bitmapOf === window.__app.S.items[5]', 5000);
      await js('window.__app.fillText()');
      eq(await js('document.getElementById("hint").hidden'), false, 'hint shown');
      ok((await js('document.getElementById("hint").textContent')).includes('No text was found'), 'wording');
    });

    await step('Paste uses the picture on the clipboard (a screenshot)', async () => {
      clipboard.writeImage(nativeImage.createFromPath(path.join(FX, 'invoice.png')));
      await click('#paste');
      await waitFor('window.__app.S.items.length === 7 && window.__app.S.items[6].kind === "pasted"', 8000, 'pasted item');
      eq(await js('document.getElementById("fname").textContent'), 'Pasted picture 1', 'named');
      await readNow();
      ok((await text()).includes('1,249.50'), 'pasted picture read: ' + JSON.stringify(await text()));
      clipboard.clear();
      await click('#paste');
      eq(await js('document.getElementById("toast").textContent.includes("no picture on the clipboard")'), true, 'nothing to paste is explained');
    });

    await step('Stop ends a long reading at once, and reading works again afterwards', async () => {
      const para = PNG.decode(fs.readFileSync(path.join(FX, 'paragraph.png')));
      const big = path.join(dir, 'big.png');
      fs.writeFileSync(big, PNG.encode(PNG.resize(para, 4000, 800)));
      await js(`window.ocr.openPaths([${JSON.stringify(big)}]).then(l => window.__app.addItems(l))`);
      await waitFor('window.__app.S.items.length === 8', 8000);
      await js('window.__app.selectItem(7, true)');
      await waitFor('window.__app.S.cur === 7 && window.__app.S.bitmapOf === window.__app.S.items[7]', 5000);
      await js('document.getElementById("enlarge").checked = false; document.getElementById("enlarge").dispatchEvent(new Event("change"))');
      await click('#read');
      await waitFor('window.__app.S.busy === true', 3000);
      eq(await js('document.getElementById("read").hidden'), true, 'Read hidden while working');
      await sleep(250);
      const t0 = Date.now();
      await click('#cancel');
      await waitFor('window.__app.S.busy === false', 8000, 'idle');
      notes.stopMs = Date.now() - t0;
      ok(notes.stopMs < 4000, 'stopped in ' + notes.stopMs + ' ms');
      eq(await js('window.__app.S.items[7].status'), 'new', 'not marked as read');
      eq(await js('document.getElementById("read").hidden'), false, 'Read is back');
      await js('window.__app.selectItem(0, true)');
      await readNow();
      ok(sim(await text(), FOX) >= 0.97, 'reads again after a stop');
    });

    await step('zoom buttons change the picture size and Fit comes back', async () => {
      await js('window.__app.selectItem(1, true)');
      await waitFor('window.__app.S.cur === 1 && window.__app.S.bitmapOf === window.__app.S.items[1]', 5000);
      const fit = await js('document.getElementById("canvas").width');
      await click('#zoomIn');
      const bigger = await js('document.getElementById("canvas").width');
      ok(bigger > fit * 1.3, `zoom in: ${fit} -> ${bigger}`);
      await click('#zoomOut'); await click('#zoomOut');
      ok((await js('document.getElementById("canvas").width')) < fit, 'zoom out');
      await click('#zoomFit');
      near(await js('document.getElementById("canvas").width'), fit, 3, 'fit');
    });

    await step('removing a picture and Remove all', async () => {
      await js('window.__app.S.busy = false');
      await click('#list .item:last-child .x');
      eq(await js('window.__app.S.items.length'), 7, 'one removed');
      await click('#clear');
      eq(await js('window.__app.S.items.length'), 0, 'all removed');
      eq(await js('document.getElementById("empty").hidden'), false, 'back to the start');
    });

    await step('no errors reached the console', async () => {
      const real = errors.filter((m) => !/Autofill\.|Estimating resolution|willReadFrequently/.test(m));
      eq(real.length, 0, 'console errors: ' + real.join(' | '));
    });
  } catch (e) {
    results.push({ name: 'test run', ok: false, error: String((e && e.stack) || e) });
  }
  const pass = results.every((r) => r.ok);
  if (outFile) fs.writeFileSync(outFile, JSON.stringify({ ok: pass, results, notes }, null, 2));
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  app.exit(pass ? 0 : 1);

  function near(a, b, tol, what) { if (!(Math.abs(a - b) <= tol)) throw new Error(`${what}: expected ${b} +/- ${tol}, got ${a}`); }
};
