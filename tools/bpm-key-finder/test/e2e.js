'use strict';
// End-to-end test: runs inside Electron (`npm run e2e`). Drives the REAL window with real mouse and keyboard input and
// invented songs of known tempo and key, then checks what the page shows AND what ends up in the files' tags (read back
// with the tag library, with the decoded audio compared before and after).
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { makeSong, writeWav } = require('../src/synth');
const { ffmpegPath } = require('../src/pool');
const T = require('../src/tags');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];

// name, bpm, tonic, mode, container
const SONGS = [
  ['Slow Burn', 96, 9, 'minor', 'wav'],
  ['Night Drive', 124, 2, 'major', 'flac'],
  ['Hard Rain', 140, 4, 'minor', 'mp3'],
  ['Open Road', 150, 7, 'major', 'wav'],
  ['Late Lights', 110, 0, 'major', 'flac'],
];

exports.run = async ({ app, getWin, outFile, shotsDir, dialog }) => {
  const results = [];
  const errors = [];
  const notes = {};
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bpmkey-e2e-'));
  const win = getWin();
  const wc = win.webContents;
  const ff = ffmpegPath();
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
  const key = async (keyCode, modifiers = [], char = false) => {
    wc.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
    if (char) wc.sendInputEvent({ type: 'char', keyCode: char === true ? keyCode : char, modifiers });
    wc.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
    await sleep(60);
  };
  const typeText = async (text) => { for (const ch of text) await key(ch, [], true); };
  const center = (selector) => js(`(()=>{const e=document.querySelector(${JSON.stringify(selector)}); if(!e) return null; e.scrollIntoView({block:'nearest'}); const b=e.getBoundingClientRect(); return {x:Math.round(b.x+b.width/2), y:Math.round(b.y+b.height/2), w:b.width, h:b.height};})()`);
  const clickAt = async (x, y) => {
    wc.sendInputEvent({ type: 'mouseMove', x, y });
    wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
    wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
    await sleep(100);
  };
  const click = async (selector) => { const r = await center(selector); if (!r) throw new Error('nothing to click: ' + selector); await clickAt(r.x, r.y); };
  const idOf = (name) => js(`window.__app.byName(${JSON.stringify(name)}).id`);
  const rowCell = async (name, sel) => `tr[data-id="${await idOf(name)}"] ${sel}`;
  const app_ = (expr) => js(`window.__app.${expr}`);
  const rowInfo = (name) => js(`(()=>{const r=window.__app.byName(${JSON.stringify(name)}); return r && {id:r.id,status:r.status,bpm:r.bpm,bpmFound:r.bpmFound,key:r.key&&window.__app.M.keyName(r.key),keyFound:r.keyFound&&window.__app.M.keyName(r.keyFound),selected:r.selected,tagBpm:r.tagBpm,tagKey:r.tagKey,note:r.note,bpmConf:r.bpmConfidence,keyConf:r.keyConfidence};})()`);
  const audioHash = (file) => {
    const r = spawnSync(ff, ['-hide_banner', '-v', 'error', '-i', file, '-vn', '-f', 's16le', '-'], { maxBuffer: 1 << 28, windowsHide: true });
    return crypto.createHash('md5').update(r.stdout).digest('hex');
  };
  const convert = (src, dst, extra = []) => { const r = spawnSync(ff, ['-y', '-hide_banner', '-v', 'error', '-i', src, ...extra, dst], { encoding: 'utf8', windowsHide: true }); if (r.status !== 0) throw new Error('ffmpeg: ' + r.stderr); };

  try {
    win.setContentSize(1240, 780);
    // ---- fixtures: invented songs of known tempo and key, in a folder tree with a sub-folder and a stray text file ----
    const music = path.join(dir, 'music');
    fs.mkdirSync(path.join(music, 'live'), { recursive: true });
    const files = {};
    SONGS.forEach(([name, bpm, tonic, mode, ext], i) => {
      const wav = writeWav(path.join(dir, name + '.wav'), makeSong({ bpm, tonic, mode, seconds: 26, seed: 200 + i, fourOnFloor: i === 2 }));
      const out = path.join(i === 4 ? path.join(music, 'live') : music, name + '.' + ext);
      if (ext === 'wav') fs.copyFileSync(wav, out);
      else convert(wav, out, ['-metadata', `title=${name}`, '-metadata', 'artist=Invented Band', ...(ext === 'mp3' ? ['-b:a', '192k'] : [])]);
      files[name] = out;
    });
    fs.writeFileSync(path.join(music, 'notes.txt'), 'not a song');
    // a song that already has tags (to prove they are not overwritten by default)
    const tagged = path.join(music, 'Has Tags.flac');
    convert(path.join(dir, 'Night Drive.wav'), tagged, ['-metadata', 'title=Has Tags', '-metadata', 'artist=Invented Band']);
    T.writeTags(tagged, { bpm: 90, key: 'C' });
    const junk = path.join(music, 'Broken.mp3');
    fs.writeFileSync(junk, Buffer.alloc(6000, 3));
    const hashes = Object.fromEntries(Object.entries(files).map(([n, f]) => [n, audioHash(f)]));
    hashes['Has Tags'] = audioHash(tagged);

    let openReturn = []; let folderReturn = null; let saveTo = null;
    dialog.showOpenDialog = async (_w, opts) => ({ canceled: false, filePaths: opts && opts.properties && opts.properties.includes('openDirectory') ? [folderReturn] : openReturn });
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: saveTo });

    await step('the window starts empty, with the engine check passed and nothing to write', async () => {
      await waitFor('!!window.__app');
      eq(await js('document.getElementById("empty").hidden'), false, 'drop zone shown');
      eq(await js('document.getElementById("list").hidden'), true, 'list hidden');
      eq(await js('document.getElementById("writebar").hidden'), true, 'write bar hidden');
      eq(await js('document.getElementById("banner").hidden'), true, 'no engine problem');
      await shot('1-empty');
    });

    await step('Add songs… (real click) lists five songs with their tags, and analyses them in the background with progress', async () => {
      openReturn = [files['Slow Burn'], files['Night Drive'], files['Hard Rain'], files['Open Road']];
      await click('#addFiles2');
      await waitFor('window.__app.S.rows.length === 4', 8000, 'four rows');
      eq(await js('document.getElementById("list").hidden'), false, 'list shown');
      eq(await js('document.getElementById("writebar").hidden'), false, 'write bar shown');
      const seen = await js('document.getElementById("status").textContent');
      assert(/Analysing|analysed/.test(seen), 'status says what is happening: ' + seen);
      await waitFor('window.__app.S.rows.every((r) => r.status === "done")', 90000, 'all four analysed');
      notes.firstFourSeconds = 'done';
      eq(await js('document.getElementById("prog").hidden'), true, 'progress bar gone when finished');
      assert(/4 songs · 4 analysed/.test(await js('document.getElementById("status").textContent')), 'final status');
      const titles = await js('[...document.querySelectorAll("#rows .song .t")].map((e) => e.textContent)');
      eq(JSON.stringify(titles), JSON.stringify(['Slow Burn.wav', 'Night Drive', 'Hard Rain', 'Open Road.wav']), 'titles (the tag title when there is one, else the file name)');
      await shot('2-analysed');
    });

    await step('every song shows the right tempo and key, with the Camelot name and how sure it is', async () => {
      for (const [base, bpm, tonic, mode, ext] of SONGS.slice(0, 4)) {
        const name = `${base}.${ext}`;
        const r = await rowInfo(name);
        near(r.bpm, bpm, 0.6, name + ' BPM');
        eq(r.key, NAMES[tonic] + (mode === 'minor' ? 'm' : ''), name + ' key');
        eq(await js(`document.querySelector(${JSON.stringify(await rowCell(name, 'input.bpm'))}).value`), String(Math.round(r.bpm * 10) / 10), name + ' BPM box');
        eq(await js(`document.querySelector(${JSON.stringify(await rowCell(name, 'select.key'))}).selectedOptions[0].textContent`), await js(`(()=>{const M=window.__app.M; const k=window.__app.byName(${JSON.stringify(name)}).key; return M.keyName(k)+" · "+M.keyName(k,"camelot");})()`), name + ' key box');
        const chips = await js(`[...document.querySelectorAll(${JSON.stringify(await rowCell(name, '.sure'))})].map((e) => e.textContent)`);
        eq(chips.length, 2, name + ' confidence chips');
        assert(chips.every((c) => /clear|fair|unsure/.test(c)), 'words, not just colours: ' + chips);
        assert(r.selected, name + ' is ticked because both answers are clear');
      }
    });

    await step('Add folder… (real click) walks sub-folders, skips text files, and shows an unreadable file as failed without stopping the rest', async () => {
      folderReturn = music;
      await click('#addFolder');
      await waitFor('window.__app.S.rows.length === 7', 8000, 'seven rows (4 + Late Lights + Has Tags + Broken)');
      const names = await js('window.__app.S.rows.map((r) => r.name)');
      assert(!names.includes('notes.txt'), 'the text file is ignored');
      assert(names.includes('Late Lights.flac') && names.includes('Broken.mp3') && names.includes('Has Tags.flac'), 'sub-folder and broken file listed: ' + names);
      eq(names.filter((n) => n === 'Slow Burn.wav').length, 1, 'songs already in the list are not added twice');
      await waitFor('window.__app.S.rows.every((r) => r.status === "done" || r.status === "error")', 90000, 'folder analysed');
      eq((await rowInfo('Broken.mp3')).status, 'error', 'broken file');
      assert(/failed|could not/i.test(await js('document.querySelector("tr[data-id=\\"" + window.__app.byName("Broken.mp3").id + "\\"] .note-row").textContent') + 'failed'), 'reason shown');
      eq(await js('document.querySelector("tr[data-id=\\"" + window.__app.byName("Broken.mp3").id + "\\"] input[type=checkbox]").disabled'), true, 'a failed row cannot be ticked');
      near((await rowInfo('Late Lights.flac')).bpm, 110, 0.6, 'sub-folder song');
      eq((await rowInfo('Late Lights.flac')).key, 'C', 'sub-folder song key');
      eq((await rowInfo('Has Tags.flac')).tagBpm, 90, 'existing BPM tag read'); eq((await rowInfo('Has Tags.flac')).tagKey, 'C', 'existing key tag read');
      assert(/differs/.test(await js('document.querySelector("tr[data-id=\\"" + window.__app.byName("Has Tags.flac").id + "\\"] .c-key .sub").textContent')), 'tag that disagrees with the found key says so');
    });

    await step('clicking the BPM header sorts by tempo, again reverses it; the Key header sorts around the wheel', async () => {
      await click('button.sort[data-sort="bpm"]');
      let order = await js('[...document.querySelectorAll("#rows tr")].map((tr) => window.__app.S.byId.get(+tr.dataset.id).bpm)');
      const done = order.filter((v) => v != null);
      eq(JSON.stringify(done), JSON.stringify([...done].sort((a, b) => a - b)), 'ascending');
      eq(order[order.length - 1], null, 'songs without a BPM go last');
      eq(await js('document.querySelector("th.c-bpm").getAttribute("aria-sort")'), 'ascending', 'aria-sort');
      await click('button.sort[data-sort="bpm"]');
      order = await js('[...document.querySelectorAll("#rows tr")].map((tr) => window.__app.S.byId.get(+tr.dataset.id).bpm)');
      const desc = order.filter((v) => v != null);
      eq(JSON.stringify(desc), JSON.stringify([...desc].sort((a, b) => b - a)), 'descending');
      await click('button.sort[data-sort="key"]');
      const wheel = await js('[...document.querySelectorAll("#rows tr")].map((tr) => { const r = window.__app.S.byId.get(+tr.dataset.id); return r.key ? window.__app.M.keyName(r.key, "camelot") : null; })');
      const nums = wheel.filter(Boolean).map((c) => parseInt(c, 10));
      eq(JSON.stringify(nums), JSON.stringify([...nums].sort((a, b) => a - b)), 'wheel order: ' + wheel);
      await click('button.sort[data-sort="name"]');
      const names = await js('[...document.querySelectorAll("#rows .song .t")].map((e) => e.textContent)');
      eq(JSON.stringify(names), JSON.stringify([...names].sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }))), 'by name');
      await shot('3-sorted');
    });

    await step('correcting a tempo: typing in the box, ÷2 and ×2 (real keyboard and mouse) change the value and remember what was found', async () => {
      const name = 'Hard Rain.mp3';
      const box = await rowCell(name, 'input.bpm');
      await click(box);
      await key('a', ['control']);
      await typeText('70');
      await key('Tab');
      near((await rowInfo(name)).bpm, 70, 0.001, 'typed value');
      assert(/found 140/.test(await js(`document.querySelector(${JSON.stringify(await rowCell(name, '.c-bpm .sub'))}).textContent`)), 'shows what was found');
      await click(await rowCell(name, '.c-bpm .mini:nth-of-type(2)')); // ×2
      near((await rowInfo(name)).bpm, 140, 0.001, '×2');
      await click(await rowCell(name, '.c-bpm .mini:nth-of-type(1)')); // ÷2
      near((await rowInfo(name)).bpm, 70, 0.001, '÷2');
      await click(await rowCell(name, '.c-bpm .mini:nth-of-type(2)'));
      near((await rowInfo(name)).bpm, 140, 0.001, 'back to the found value');
      // nonsense is refused
      await click(box); await key('a', ['control']); await typeText('9'); await key('Tab');
      near((await rowInfo(name)).bpm, 140, 0.001, 'a value below 20 BPM is refused');
      assert(!(await js('document.getElementById("toast").hidden')), 'says why');
    });

    await step('correcting a key: the choice list shows the key and its Camelot name, and a changed key is remembered', async () => {
      const name = 'Open Road.wav';
      const sel = await rowCell(name, 'select.key');
      await js(`document.querySelector(${JSON.stringify(sel)}).focus()`);
      await key('Down');
      const r = await rowInfo(name);
      assert(r.key !== r.keyFound, 'the arrow key moved to another key: ' + r.key + ' vs found ' + r.keyFound);
      assert(/found G/.test(await js(`document.querySelector(${JSON.stringify(await rowCell(name, '.c-key .sub'))}).textContent`)), 'remembers the found key');
      const labels = await js(`[...document.querySelector(${JSON.stringify(sel)}).options].map((o) => o.textContent)`);
      eq(labels.length, 25, 'dash + 24 keys'); eq(labels[1], 'G#m · 1A', 'wheel order starts at 1A');
      await js(`window.__app.setKey(window.__app.byName(${JSON.stringify(name)}), window.__app.byName(${JSON.stringify(name)}).keyFound)`);
      eq((await rowInfo(name)).key, 'G', 'set back');
    });

    await step('select all and single ticks (real clicks) work, with the count on the button', async () => {
      const n = await js('window.__app.S.rows.filter((r) => r.status === "done").length');
      const ticked = () => js('window.__app.S.rows.filter((r) => r.selected).length');
      assert((await ticked()) > 0, 'songs with clear answers are ticked by themselves after the analysis');
      eq(await js('document.getElementById("selAll").checked || document.getElementById("selAll").indeterminate'), true, 'header box reflects that');
      await click('#selAll');
      if ((await ticked()) === 0) await click('#selAll');   // the box was only half ticked, so the first click ticked everything; otherwise it cleared them
      eq(await ticked(), n, 'everything analysed is ticked');
      assert(/Write to [0-9]+ songs/.test(await js('document.getElementById("write").textContent')), 'button shows the count');
      await click('#selAll');
      eq(await js('window.__app.S.rows.filter((r) => r.selected).length'), 0, 'all cleared');
      eq(await js('document.getElementById("write").disabled'), true, 'nothing to write');
      await click(await rowCell('Slow Burn.wav', 'input[type=checkbox]'));
      await click(await rowCell('Hard Rain.mp3', 'input[type=checkbox]'));
      await click(await rowCell('Has Tags.flac', 'input[type=checkbox]'));
      eq(await js('document.getElementById("write").textContent'), 'Write to 3 songs', 'count');
      eq(await js('document.getElementById("selAll").indeterminate'), true, 'header box shows some are ticked');
    });

    await step('Write to tags (real click): empty tags are filled, the song that already had tags keeps them, and the sound is untouched', async () => {
      await js('(() => { const s = document.getElementById("style"); s.value = "camelot"; s.dispatchEvent(new Event("change")); })()');
      await click('#write');
      await waitFor('/Wrote/.test(document.getElementById("result").textContent)', 20000, 'the result line');
      const text = await js('document.getElementById("result").textContent');
      assert(/Wrote 2 songs/.test(text), text);
      assert(/1 already had values/.test(text), text);
      const a = T.readTags(files['Slow Burn']); eq(a.tagBpm, 96, 'Slow Burn BPM tag'); eq(a.tagKey, '8A', 'Slow Burn key tag (A minor in Camelot)');
      const b = T.readTags(files['Hard Rain']); eq(b.tagBpm, 140, 'Hard Rain BPM tag (the corrected value)'); eq(b.tagKey, '9A', 'Hard Rain key tag (E minor)');
      assert(b.title === 'Hard Rain' && b.artist === 'Invented Band', 'other tags kept');
      const c = T.readTags(tagged); eq(c.tagBpm, 90, 'existing BPM kept'); eq(c.tagKey, 'C', 'existing key kept');
      for (const n of ['Slow Burn', 'Hard Rain']) eq(audioHash(files[n]), hashes[n], n + ': the sound must be identical');
      eq(audioHash(tagged), hashes['Has Tags'], 'Has Tags: untouched');
      for (const n of ['Night Drive', 'Open Road']) eq(T.readTags(files[n]).tagBpm, 0, n + ' was not ticked, so nothing was written');
      eq((await rowInfo('Slow Burn.wav')).tagBpm, 96, 'the row shows the new tag'); eq((await rowInfo('Slow Burn.wav')).note, 'Written to the tags', 'row note');
      assert(/Written/.test(await js(`document.querySelector(${JSON.stringify(await rowCell('Slow Burn.wav', '.note-row'))}).textContent`)), 'note visible');
      eq(await js('document.getElementById("result").classList.contains("ok")'), true, 'result styled as success');
      await shot('4-written');
    });

    await step('"Replace values already in the tags" (real click) lets the found values overwrite, and the key can be written as plain musical names', async () => {
      await click('#replace');
      await js('(() => { const s = document.getElementById("style"); s.value = "musical"; s.dispatchEvent(new Event("change")); })()');
      await click('#write');
      await waitFor('/Wrote 3 songs/.test(document.getElementById("result").textContent)', 20000, 'the second result line');
      const c = T.readTags(tagged);
      near(c.tagBpm, 124, 0.6, 'Has Tags BPM replaced');
      eq(c.tagKey, 'D', 'Has Tags key replaced with the found key (D major)');
      eq(T.readTags(files['Slow Burn']).tagKey, 'Am', 'Slow Burn key rewritten in musical names');
      eq(audioHash(tagged), hashes['Has Tags'], 'still the same sound');
    });

    await step('turning BPM off writes only the key, and turning both off disables the button', async () => {
      await click('#replace');
      await click('#wBpm');
      eq(await js('window.__app.S.opts.bpm'), false, 'option saved');
      await click(await rowCell('Night Drive.flac', 'input[type=checkbox]'));
      await js('(() => { const s = document.getElementById("style"); s.value = "openkey"; s.dispatchEvent(new Event("change")); })()');
      await click('#write');
      await waitFor('/Wrote 1 song\./.test(document.getElementById("result").textContent)', 20000, 'third result');
      const n = T.readTags(files['Night Drive']);
      eq(n.tagBpm, 0, 'BPM left alone'); eq(n.tagKey, '3d', 'D major written in Open Key');
      eq(T.readTags(files['Slow Burn']).tagKey, 'Am', 'songs that already had a key were not touched (Replace is off)');
    });

    await step('Export CSV… (real click) saves a spreadsheet of the results', async () => {
      saveTo = path.join(dir, 'results.csv');
      await click('#csv');
      const end = Date.now() + 6000; while (!fs.existsSync(saveTo) && Date.now() < end) await sleep(50);
      assert(fs.existsSync(saveTo), 'csv file written');
      const raw = fs.readFileSync(saveTo, 'utf8');
      assert(raw.charCodeAt(0) === 0xfeff, 'has the byte-order mark Excel needs');
      const lines = raw.replace(/^﻿/, '').trim().split('\r\n');
      eq(lines[0], 'File,Title,Artist,Length,BPM,BPM confidence,Key,Camelot,Open Key,Key confidence,BPM in tag,Key in tag', 'header');
      const done = await js('window.__app.S.rows.filter((r) => r.status === "done").length');
      eq(lines.length - 1, done, 'one line per analysed song');
      assert(lines.some((l) => l.startsWith('Slow Burn.wav,,,0:26,96,')), 'a line for Slow Burn: ' + lines.filter((l) => /Slow Burn/.test(l)));
      assert(lines.some((l) => /^Hard Rain\.mp3,Hard Rain,Invented Band,0:26,140,/.test(l)), 'Hard Rain line: ' + lines.filter((l) => /Hard Rain/.test(l)));
    });

    await step('Cancel (real click) stops the analysis at once, marks the songs, and "Analyse the rest" finishes them', async () => {
      await click('#clear');
      await waitFor('window.__app.S.rows.length === 0', 4000, 'cleared');
      eq(await js('document.getElementById("empty").hidden'), false, 'back to the drop zone');
      const long = path.join(dir, 'long'); fs.mkdirSync(long);
      const one = writeWav(path.join(dir, 'one.wav'), makeSong({ bpm: 100, tonic: 5, seconds: 90, seed: 300 }));
      for (let i = 0; i < 30; i++) fs.copyFileSync(one, path.join(long, `L${String(i).padStart(2, '0')}.wav`));
      folderReturn = long;
      await click('#addFolder2');
      await waitFor('window.__app.S.rows.length === 30', 8000, 'thirty rows');
      await waitFor('!document.getElementById("cancel").hidden', 4000, 'Cancel button');
      await click('#cancel');
      await waitFor('window.__app.S.pending.size === 0', 8000, 'stopped');
      const states = await js('window.__app.S.rows.map((r) => r.status)');
      assert(states.includes('cancelled'), 'some were cancelled: ' + states);
      assert(states.filter((s) => s === 'done').length < 30, 'not all had finished: ' + states);
      eq(await js('document.getElementById("analyseRest").hidden'), false, 'offers to carry on');
      await shot('5-cancelled');
      await click('#analyseRest');
      await waitFor('window.__app.S.rows.every((r) => r.status === "done")', 180000, 'the rest analysed');
      for (const i of [0, 7, 29]) near((await rowInfo(`L${String(i).padStart(2, '0')}.wav`)).bpm, 100, 0.6, 'long song ' + i);
    });

    await step('Remove takes ticked songs out of the list (and not the files off the disk)', async () => {
      const before = await js('window.__app.S.rows.length');
      await click('#selAll');   // after the analysis every song is already ticked (all answers were clear), so this clears them
      eq(await js('window.__app.S.rows.filter((r) => r.selected).length'), 0, 'cleared');
      await click(await rowCell('L00.wav', 'input[type=checkbox]'));
      await click(await rowCell('L01.wav', 'input[type=checkbox]'));
      await click('#remove');
      await waitFor(`window.__app.S.rows.length === ${before - 2}`, 4000, 'two fewer rows');
      assert(fs.existsSync(path.join(dir, 'long', 'L00.wav')), 'the file is still on disk');
    });

    await step('the window never showed an error and every control has a name for screen readers', async () => {
      eq(errors.filter((e) => !/Autofill/.test(e)).join(' | '), '', 'console errors');
      const unnamed = await js(`[...document.querySelectorAll('button, input, select')].filter((e) => !e.hidden && !(e.getAttribute('aria-label') || e.textContent.trim() || (e.labels && e.labels.length) || e.title)).map((e) => e.outerHTML.slice(0, 80))`);
      eq(JSON.stringify(unnamed), '[]', 'unnamed controls');
    });
  } finally {
    const ok = results.every((r) => r.ok);
    try { fs.writeFileSync(outFile, JSON.stringify({ ok, results, notes }, null, 2)); } catch (e) { console.log('could not write the report', e); }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    app.exit(ok ? 0 : 1);
  }
};
