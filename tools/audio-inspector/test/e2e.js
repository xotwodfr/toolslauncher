'use strict';
// End-to-end test: runs inside Electron (`npm run e2e`). Drives the REAL window with real mouse and keyboard input on files
// made here from scratch (a genuine FLAC, one made from an MP3, an upsampled 96 kHz file, a padded 24-bit WAV, an MP3, a broken
// file, a folder with a sub-folder), checks every verdict the window shows, the spectrogram that is drawn, the numbers, the
// reports it saves, cancelling, and that no file was changed.
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const G = require('../src/signals');
const { ffmpegPath } = require('../src/pool');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

exports.run = async ({ app, getWin, outFile, shotsDir, dialog, shell }) => {
  const results = [];
  const errors = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inspector-e2e-'));
  const ff = ffmpegPath();
  const win = getWin();
  const wc = win.webContents;
  const js = (code) => wc.executeJavaScript(code, true);
  wc.on('console-message', (_e, level, msg) => { if (level >= 2 && !/Autofill|willReadFrequently/.test(msg)) errors.push(msg); });   // the canvas hint comes from this test's own pixel reads
  const step = async (name, fn) => {
    try { const detail = await fn(); results.push({ name, ok: true, detail: detail === undefined ? '' : detail }); console.log('ok   ' + name); }
    catch (e) { results.push({ name, ok: false, error: String((e && e.message) || e) }); console.log('FAIL ' + name + ': ' + ((e && e.message) || e)); }
  };
  const assert = (c, m) => { if (!c) throw new Error(m); };
  const eq = (a, b, what) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${what}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); };
  const waitFor = async (expr, ms = 8000, what = expr) => {
    const end = Date.now() + ms;
    for (;;) { const v = await js(expr); if (v) return v; if (Date.now() > end) throw new Error('timed out waiting for ' + what); await sleep(50); }
  };
  const shot = async (name) => { if (!shotsDir) return; fs.mkdirSync(shotsDir, { recursive: true }); await sleep(300); fs.writeFileSync(path.join(shotsDir, name + '.png'), (await wc.capturePage()).toPNG()); };
  const center = (selector) => js(`(()=>{const e=document.querySelector(${JSON.stringify(selector)}); if(!e) return null; e.scrollIntoView({block:'nearest'}); const b=e.getBoundingClientRect(); return {x:Math.round(b.x+b.width/2), y:Math.round(b.y+b.height/2)};})()`);
  const click = async (selector) => {
    const r = await center(selector); if (!r) throw new Error('nothing to click: ' + selector);
    wc.sendInputEvent({ type: 'mouseMove', x: r.x, y: r.y });
    wc.sendInputEvent({ type: 'mouseDown', x: r.x, y: r.y, button: 'left', clickCount: 1 });
    wc.sendInputEvent({ type: 'mouseUp', x: r.x, y: r.y, button: 'left', clickCount: 1 });
    await sleep(120);
  };
  const key = async (keyCode) => { wc.sendInputEvent({ type: 'keyDown', keyCode }); wc.sendInputEvent({ type: 'keyUp', keyCode }); await sleep(80); };
  const ffm = (args) => { const r = spawnSync(ff, ['-y', '-hide_banner', '-v', 'error', ...args], { encoding: 'utf8', windowsHide: true }); if (r.status !== 0) throw new Error(r.stderr); };
  const md5 = (f) => crypto.createHash('md5').update(fs.readFileSync(f)).digest('hex');
  const rowFor = (name) => `[...document.querySelectorAll("#list .item")].find((e) => e.querySelector(".nm").textContent === ${JSON.stringify(name)})`;
  const chipOf = (name) => js(`(() => { const e = ${rowFor(name)}; return e ? e.querySelector(".chip").textContent + "|" + e.querySelector(".chip").className : null; })()`);
  const clickRow = async (name) => { const id = await js(`window.__app.S.rows.find((r) => r.name === ${JSON.stringify(name)}).id`); await click(`#list .item[data-id="${id}"]`); };

  try {
    win.setContentSize(1240, 840);
    // test material, made from scratch
    const src = path.join(dir, 'src'); const lib = path.join(dir, 'Ünïcödé Library'); const sub = path.join(lib, 'Disc 2');
    fs.mkdirSync(sub, { recursive: true }); fs.mkdirSync(src);
    const n = 44100 * 8;
    const wav = G.writeWav(path.join(src, 'noise.wav'), [G.white(n, 0.18, 1), G.white(n, 0.18, 2)], 44100, 16);
    const mp3 = path.join(src, 'noise.mp3'); ffm(['-i', wav, '-b:a', '128k', mp3]);
    const F = {
      real: path.join(src, 'Genuine – CD rip.flac'), fake: path.join(src, 'Fake from MP3.flac'), up: path.join(src, 'Hi-res 24-96.flac'),
      padded: path.join(src, 'Padded 24-bit.wav'), lossy: path.join(src, 'Plain.mp3'), broken: path.join(src, 'Broken.flac'),
    };
    ffm(['-i', wav, F.real]); ffm(['-i', mp3, '-sample_fmt', 's16', F.fake]);
    ffm(['-i', wav, '-af', G.upsampleFilter(ff, 96000), '-sample_fmt', 's32', F.up]);
    ffm(['-i', wav, '-c:a', 'pcm_s24le', F.padded]); fs.copyFileSync(mp3, F.lossy); fs.writeFileSync(F.broken, Buffer.alloc(9000, 1));
    ffm(['-i', wav, path.join(lib, 'Track 01 名前.flac')]); ffm(['-i', mp3, '-sample_fmt', 's16', path.join(sub, 'Track 02.flac')]);
    fs.writeFileSync(path.join(sub, 'cover.jpg'), 'not audio'); fs.writeFileSync(path.join(lib, 'notes.txt'), 'hello');
    // long files, to cancel
    const longDir = path.join(dir, 'Long ones');
    fs.mkdirSync(longDir);
    const longSrc = G.writeWav(path.join(src, 'long.wav'), [G.white(44100 * 240, 0.18, 5), G.white(44100 * 240, 0.18, 6)], 44100, 16);
    for (let i = 1; i <= 8; i++) ffm(['-i', longSrc, '-compression_level', '0', path.join(longDir, `Long ${i}.flac`)]);
    const all = [...Object.values(F), path.join(lib, 'Track 01 名前.flac'), path.join(sub, 'Track 02.flac')];
    const before = new Map(all.map((f) => [f, md5(f)]));
    let openReturn = Object.values(F); let saveTo = null;
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: openReturn });
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: saveTo });
    const revealed = []; shell.showItemInFolder = (p) => revealed.push(p);

    await step('the window starts empty with the drop zone; reports cannot be saved yet', async () => {
      await waitFor('!!window.__app');
      eq(await js('document.getElementById("empty").hidden'), false, 'drop zone');
      eq(await js('document.getElementById("saveCsv").disabled'), true, 'no CSV yet');
      eq(await js('document.getElementById("engineWarn").hidden'), true, 'ffmpeg found');
    });

    await step('Add files… (real click): every file gets the right verdict chip, in the right colour, with format details', async () => {
      await click('#addFiles2');
      await waitFor('window.__app.S.rows.length === 6', 5000, 'rows');
      await waitFor('window.__app.S.rows.every((r) => r.status === "done" || r.status === "error")', 60000, 'all inspected');
      eq(await chipOf('Genuine – CD rip.flac'), 'Real lossless|chip real', 'real');
      eq(await chipOf('Fake from MP3.flac'), 'Fake lossless|chip fake', 'fake');
      eq(await chipOf('Hi-res 24-96.flac'), 'Upsampled|chip upsampled', 'upsampled');
      eq(await chipOf('Padded 24-bit.wav'), 'Real lossless|chip real', 'padded');
      eq(await chipOf('Plain.mp3'), 'Lossy (MP3 128 kbps)|chip lossy', 'lossy');
      eq(await chipOf('Broken.flac'), 'Could not read|chip error', 'broken');
      assert(/really 16-bit/.test(await js(`${rowFor('Padded 24-bit.wav')}.querySelector(".sub").textContent`)), 'padded marked');
      eq(await js(`${rowFor('Hi-res 24-96.flac')}.querySelector(".sub").textContent`), 'FLAC · 96 kHz · 24-bit', 'details');
      const counts = await js('document.getElementById("counts").textContent');
      assert(/6 files/.test(counts) && /1 fake lossless/.test(counts) && /1 upsampled/.test(counts) && /2 real lossless/.test(counts) && /1 lossy/.test(counts) && /1 could not be read/.test(counts), counts);
      eq(await js('document.getElementById("saveCsv").disabled'), false, 'CSV possible');
    });

    await step('clicking the fake file (real click) shows the verdict in words, the flags, the numbers and a drawn spectrogram with the cutoff marked', async () => {
      await clickRow('Fake from MP3.flac');
      await waitFor('window.__app.S.detail && window.__app.S.detail.name === "Fake from MP3.flac"', 8000, 'detail');
      eq(await js('document.querySelector("#dVerdict .vt").textContent'), 'Fake lossless file', 'title');
      assert(/^This FLAC was probably made from a lossy file \(MP3\/AAC ~128.*\): the sound stops at 1[67]\.\d kHz\.$/.test(await js('document.querySelector("#dVerdict .ve").textContent')), 'explain');
      const facts = await js('[...document.querySelectorAll("#dFacts .f")].map((f) => f.querySelector("dt").textContent + "=" + f.querySelector("dd").textContent)');
      for (const want of [/^Format=FLAC$/, /^Sample rate=44\.1 kHz$/, /^Bit depth=16-bit$/, /^Channels=Stereo$/, /^Duration=0:08$/, /^Loudness=-\d+\.\d LUFS$/, /^True peak=-\d+\.\d dBTP$/, /^Highest frequency=1[67]\.\d kHz \(sharp cutoff/, /^Clipping=None$/]) assert(facts.some((f) => want.test(f)), 'fact ' + want + ' in ' + JSON.stringify(facts));
      // the spectrogram is really drawn: bright pixels low down, dark above the cutoff, and the blue cutoff line
      const px = await js(`(() => { const c = document.getElementById("spectrogram"); const g = c.getContext("2d"); const w = c.width, h = c.height;
        const at = (fx, fy) => Array.from(g.getImageData(Math.round(w * fx), Math.round(h * fy), 1, 1).data);
        let blue = 0; const col = Math.round(w * 0.5); const d = g.getImageData(col, 0, 1, h).data;
        for (let y = 0; y < h; y++) if (d[y * 4 + 2] > 200 && d[y * 4] < 190) blue++;
        return { low: at(0.5, 0.8), high: at(0.5, 0.1), blue }; })()`);
      assert(px.low[0] + px.low[1] + px.low[2] > 150, 'sound drawn below the cutoff: ' + px.low);
      assert((px.high[0] + px.high[1] + px.high[2]) * 4 < px.low[0] + px.low[1] + px.low[2], 'much darker above the cutoff: ' + px.high + ' vs ' + px.low);
      assert(px.blue >= 1, 'the cutoff line is drawn');
      await shot('1-fake');
    });

    await step('arrow keys (real keys) move through the list; the broken file explains itself; the upsampled file says from what', async () => {
      await clickRow('Genuine – CD rip.flac');
      await waitFor('window.__app.S.detail && window.__app.S.detail.name === "Genuine – CD rip.flac"', 8000, 'real detail');
      eq(await js('document.querySelector("#dVerdict .vt").textContent'), 'Real lossless', 'real title');
      await key('Down');
      await waitFor('window.__app.S.detail && window.__app.S.detail.name === "Fake from MP3.flac"', 8000, 'down');
      await key('Down');
      await waitFor('window.__app.S.detail && window.__app.S.detail.name === "Hi-res 24-96.flac"', 8000, 'down again');
      eq(await js('document.querySelector("#dVerdict .vt").textContent'), 'Upsampled from 44.1 kHz', 'upsampled title');
      await clickRow('Broken.flac');
      await waitFor('/could not be inspected/.test(document.querySelector("#dVerdict .vt").textContent)', 5000, 'broken detail');
      assert(/could not be (read|decoded)|no sound/.test(await js('document.querySelector("#dVerdict .ve").textContent')), 'reason given');
      await clickRow('Padded 24-bit.wav');
      await waitFor('window.__app.S.detail && window.__app.S.detail.name === "Padded 24-bit.wav"', 8000, 'padded detail');
      assert(/Really 16-bit: stored as 24-bit/.test(await js('document.getElementById("dFlags").textContent')), 'flag shown');
    });

    await step('Add folder… (real click): audio files in sub-folders are found, other files and files already listed are skipped', async () => {
      openReturn = [lib, src];
      await click('#addFolder');
      await waitFor('window.__app.S.rows.length >= 8', 5000, 'folder rows');
      await waitFor('window.__app.S.rows.every((r) => r.status === "done" || r.status === "error")', 60000, 'inspected');
      const names = await js('window.__app.S.rows.map((r) => r.name)');
      assert(names.includes('Track 01 名前.flac') && names.includes('Track 02.flac'), 'nested files: ' + names);
      assert(!names.includes('cover.jpg') && !names.includes('notes.txt'), 'only audio');
      eq(names.filter((x) => x === 'Fake from MP3.flac').length, 1, 'no duplicate');
      eq(await chipOf('Track 02.flac'), 'Fake lossless|chip fake', 'nested fake');
      // the source folder also holds noise.wav, noise.mp3 and long.wav
      eq(names.length, 11, 'count');
    });

    await step('Save CSV… and Save report… (real clicks): the files hold every row; replacing keeps a .bak; Show in folder reveals only the report', async () => {
      saveTo = path.join(dir, 'report.csv');
      await click('#saveCsv');
      await waitFor('/Saved report\\.csv/.test(document.getElementById("toast").textContent)', 8000, 'saved');
      const csv = fs.readFileSync(saveTo, 'utf8');
      assert(csv.charCodeAt(0) === 0xfeff, 'BOM');
      eq(csv.trim().split('\r\n').length, 12, 'header + 11 rows');
      assert(/Fake from MP3\.flac,.*,Fake lossless,/.test(csv) && /Track 01 名前\.flac/.test(csv) && /Broken\.flac,.*,Could not inspect,/.test(csv), 'rows');
      await click('#toast .btn');
      eq(revealed, [saveTo], 'revealed the report');
      await click('#saveCsv');
      await waitFor('/old one kept as \\.bak/.test(document.getElementById("toast").textContent)', 8000, 'second save');
      assert(fs.existsSync(saveTo + '.bak'), '.bak');
      saveTo = path.join(dir, 'report.txt');
      await click('#saveTxt');
      await waitFor('/Saved report\\.txt/.test(document.getElementById("toast").textContent)', 8000, 'text saved');
      const txt = fs.readFileSync(saveTo, 'utf8');
      assert(/11 files: 5 real lossless, 2 fake lossless, 1 upsampled, 0 can't tell, 2 lossy, 1 could not be inspected/.test(txt), txt.slice(0, 400));
    });

    await step('Clear list, then add long files and Cancel (real clicks): work stops, rows say Stopped, nothing is left running', async () => {
      await click('#clear');
      await waitFor('document.getElementById("empty").hidden === false', 3000, 'empty again');
      openReturn = [longDir];
      await click('#addFolder2');
      await waitFor('window.__app.S.rows.length === 8 && window.__app.S.rows.some((r) => r.status === "working")', 8000, 'working');
      eq(await js('document.getElementById("progressRow").hidden'), false, 'progress shown');
      await sleep(300);
      await click('#cancel');
      await waitFor('window.__app.S.rows.every((r) => r.status !== "working" && r.status !== "waiting")', 10000, 'all stopped');
      const st = await js('window.__app.S.rows.map((r) => r.status)');
      assert(st.filter((s) => s === 'cancelled').length >= 4, 'most were stopped: ' + st);
      await waitFor('document.getElementById("progressRow").hidden', 3000, 'progress hidden');
      assert(/Stopped/.test(await js('document.getElementById("list").textContent')), 'shown as Stopped');
    });

    await step('no file was changed by inspecting it (hashes before and after)', async () => {
      for (const [f, h] of before) eq(md5(f), h, 'unchanged ' + path.basename(f));
    });
    await step('no errors in the window console', async () => { assert(!errors.length, errors.join(' | ')); });
  } catch (e) {
    results.push({ name: 'test setup', ok: false, error: String((e && e.stack) || e) });
  }
  fs.writeFileSync(outFile, JSON.stringify({ ok: results.every((r) => r.ok), results }, null, 2));
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  app.exit(results.every((r) => r.ok) ? 0 : 1);
};
