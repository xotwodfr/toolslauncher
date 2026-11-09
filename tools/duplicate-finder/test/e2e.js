'use strict';
// End-to-end test: runs inside Electron (`npm run e2e`). Drives the REAL window with real mouse clicks, scans real
// folders, reviews the results and moves files, then checks the disk. Moving to the Recycle Bin is faked (files go to a
// folder) everywhere except one final step that sends one tiny file of its own to the real Recycle Bin.
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const Music = require('../src/music');
const { png } = require('../src/testkit');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rnd = (n) => crypto.randomBytes(n);

exports.run = async ({ app, getWin, outFile, shotsDir, setTrashMode }) => {
  const results = [];
  const errors = [];
  const notes = {};
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dupefinder-e2e-'));
  const bin = path.join(dir, '_fake_bin');
  const win = getWin();
  const wc = win.webContents;
  const ff = Music.ffmpegPath();
  const js = (code) => wc.executeJavaScript(code, true);
  const step = async (name, fn) => {
    try { const detail = await fn(); results.push({ name, ok: true, detail: detail === undefined ? '' : detail }); console.log('ok   ' + name); }
    catch (e) { results.push({ name, ok: false, error: String((e && e.message) || e) }); console.log('FAIL ' + name + ': ' + ((e && e.message) || e)); }
  };
  const eq = (a, b, what) => { if (a !== b) throw new Error(`${what}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); };
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
  const text = (sel) => js(`(document.querySelector(${JSON.stringify(sel)})||{}).textContent`);
  const rows = (gi) => js(`[...document.querySelectorAll('#groups .group')[${gi}].querySelectorAll('.frow')].map(r => ({ name: r.querySelector('.name').firstChild.textContent, sel: r.classList.contains('sel'), cb: !!r.querySelector('input[type=checkbox]'), lock: !!r.querySelector('.chip.lock') }))`);
  const groupNames = () => js(`[...document.querySelectorAll('#groups .group')].map(g => [...g.querySelectorAll('.frow .name')].map(n => n.firstChild.textContent).sort().join(' + '))`);
  const scanAndWait = async (ms = 60000) => {
    await click('#scan');
    await waitFor('window.__app.S.busy !== null || window.__app.S.scanned', 4000, 'scan to start');
    await waitFor('window.__app.S.busy === null', ms, 'scan to finish');
  };
  wc.on('console-message', (_e, level, message) => { if (level >= 2) errors.push(message); });

  try {
    win.setContentSize(1240, 800);
    setTrashMode(bin);
    await waitFor('!!window.__app');

    // ---------------------------------------------------------------- fixtures: files
    const holiday = rnd(40000); const report = rnd(3000); const master = rnd(9000);
    const when = (f, iso) => fs.utimesSync(f, new Date(iso), new Date(iso));
    const put = (rel, data, iso) => { const f = path.join(dir, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, data); if (iso) when(f, iso); return f; };
    const pHoliday = put('Pictures/holiday.jpg', holiday, '2020-01-01'); const bHoliday = put('Backup/holiday copy.jpg', holiday, '2021-01-01'); const dHoliday = put('Downloads/holiday (1).jpg', holiday, '2022-01-01');
    const dReport = put('Docs/report.txt', report, '2020-06-01'); const bReport = put('Backup/report.txt', report, '2021-06-01');
    put('Docs/unique.txt', rnd(3000), '2020-06-01');
    const mMaster = put('Protected/master.dat', master, '2023-01-01'); const dMaster = put('Downloads/master.dat', master, '2019-01-01');
    put('Docs/same size as report.txt', rnd(3000), '2020-06-01');
    const roots = ['Pictures', 'Backup', 'Downloads', 'Docs', 'Protected'].map((r) => path.join(dir, r));

    await step('starts with the three modes and an intro; scanning with no folders explains itself', async () => {
      eq(await js('document.querySelectorAll(".mode").length'), 3, 'modes');
      eq(await js('document.getElementById("intro").hidden'), false, 'intro');
      eq(await js('document.getElementById("results").hidden'), true, 'results hidden');
      await click('#scan');
      eq(await js('document.getElementById("toast").hidden'), false, 'toast shown');
      eq(await js('document.getElementById("toast").textContent.includes("Add a folder")'), true, 'message');
    });

    await step('adding folders (as a drop does); a folder can be protected with a real click; settings are remembered', async () => {
      await js(`window.__app.addRoots(${JSON.stringify(roots)})`);
      eq(await js('document.querySelectorAll("#roots .root").length'), 5, 'folders listed');
      const idx = roots.indexOf(path.join(dir, 'Protected')) + 1;
      await click(`#roots .root:nth-child(${idx}) button[aria-pressed]`);
      eq(await js(`window.__app.S.roots[${idx - 1}].keep`), true, 'protected');
      eq(await js(`document.querySelector("#roots .root:nth-child(${idx})").classList.contains("prot")`), true, 'looks protected');
      await sleep(600);
      const saved = JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'settings.json'), 'utf8'));
      eq(saved.roots.length, 5, 'saved folders'); eq(saved.roots[idx - 1].keep, true, 'saved protection');
    });

    await step('Files scan (real click) finds exactly the true duplicate groups', async () => {
      await scanAndWait();
      const g = await groupNames();
      eq(g.length, 3, 'groups: ' + g.join(' | '));
      eq(g.includes('holiday (1).jpg + holiday copy.jpg + holiday.jpg'), true, 'holiday trio');
      eq(g.includes('report.txt + report.txt'), true, 'report pair');
      eq(g.includes('master.dat + master.dat'), true, 'master pair');
      eq((await text('#summary')).includes('3 groups'), true, 'summary');
      await shot('01-files-results');
    });

    await step('the protected copy has no checkbox and is marked', async () => {
      const gi = (await groupNames()).findIndex((n) => n.startsWith('master'));
      const r = await rows(gi);
      eq(r.filter((x) => x.lock).length, 1, 'one protected row');
      eq(r.filter((x) => x.cb).length, 1, 'only the unprotected copy can be ticked');
    });

    await step('"Select the others" (keep the oldest) selects the right copies and never the protected one', async () => {
      await js('document.getElementById("rule").value = "oldest"');
      await click('#select');
      const names = await groupNames();
      const h = await rows(names.findIndex((n) => n.startsWith('holiday')));
      eq(JSON.stringify(h.filter((x) => x.sel).map((x) => x.name).sort()), JSON.stringify(['holiday (1).jpg', 'holiday copy.jpg']), 'holiday: the oldest (Pictures) stays');
      const m = await rows(names.findIndex((n) => n.startsWith('master')));
      eq(m.filter((x) => x.sel).length, 1, 'master: one selected');
      eq(m.find((x) => x.lock).sel, false, 'the protected copy is not selected, even though the other one is older');
      eq((await text('#picked')).startsWith('4 files selected'), true, 'four files: ' + (await text('#picked')));
      eq(await js('document.getElementById("trash").disabled'), false, 'move enabled');
    });

    await step('ticking the last copy of a group is refused', async () => {
      const names = await groupNames();
      const gi = names.findIndex((n) => n.startsWith('holiday'));
      // the kept copy of the holiday group is Pictures/holiday.jpg: try to tick it too
      const sel = `#groups .group:nth-child(${gi + 1}) .frow:nth-child(${(await rows(gi)).findIndex((x) => x.name === 'holiday.jpg') + 2}) input[type=checkbox]`;
      await click(sel);
      eq(await js(`document.querySelector(${JSON.stringify(sel)}).checked`), false, 'stays unticked');
      eq((await rows(gi)).filter((x) => x.sel).length, 2, 'still two selected');
      eq(await js('document.getElementById("toast").textContent.includes("At least one copy")'), true, 'explained');
    });

    await step('a single copy can be un-ticked by hand', async () => {
      const gi = (await groupNames()).findIndex((n) => n.startsWith('holiday'));
      const r = await rows(gi);
      const k = r.findIndex((x) => x.name === 'holiday (1).jpg');
      await click(`#groups .group:nth-child(${gi + 1}) .frow:nth-child(${k + 2}) input[type=checkbox]`);
      eq((await rows(gi)).filter((x) => x.sel).map((x) => x.name).join(), 'holiday copy.jpg', 'only the Backup copy is left selected');
    });

    await step('Move to Recycle Bin asks first; Cancel changes nothing', async () => {
      await click('#trash');
      await waitFor('document.getElementById("confirm").open', 3000, 'dialog');
      const t = await text('#confirmText');
      eq(t.includes('3 files'), true, 'dialog counts: ' + t);
      eq(await js('document.getElementById("confirmList").children.length'), 3, 'lists the files');
      await click('#confirmNo');
      await waitFor('!document.getElementById("confirm").open', 3000);
      for (const f of [pHoliday, bHoliday, dHoliday, dReport, bReport, mMaster, dMaster]) if (!fs.existsSync(f)) throw new Error('a file moved after Cancel: ' + f);
    });

    await step('confirming moves the files (checked on disk), the copies that stay are untouched, results update', async () => {
      await click('#trash');
      await waitFor('document.getElementById("confirm").open', 3000);
      await shot('02-confirm');
      await click('#confirmYes');
      await waitFor('window.__app.S.busy === null && document.getElementById("notice").className.includes("ok")', 10000, 'finished');
      // selected: holiday copy.jpg (Backup), and one of each report/master (oldest rule kept the oldest: Docs/report, Downloads/master was older but the protected copy stays)
      eq(fs.existsSync(bHoliday), false, 'Backup holiday copy moved');
      eq(fs.existsSync(pHoliday) && fs.existsSync(dHoliday), true, 'the other two holiday copies stay');
      eq(fs.existsSync(dReport), true, 'oldest report stays'); eq(fs.existsSync(bReport), false, 'newer report moved');
      eq(fs.existsSync(mMaster), true, 'the protected master stays'); eq(fs.existsSync(dMaster), false, 'the other master moved');
      eq(fs.readdirSync(bin).length, 3, 'three files in the (fake) bin');
      const g = await groupNames();
      eq(g.length, 1, 'only the holiday group is left: ' + g.join(' | '));
      eq(g[0], 'holiday (1).jpg + holiday.jpg', 'two copies left');
      eq((await text('#notice')).includes('Moved 3 files'), true, 'notice');
      await shot('03-after-move');
    });

    await step('a file changed after the scan is left alone, with the reason shown', async () => {
      await click('#clear');
      const gi = 0;
      const r = await rows(gi);
      const k = r.findIndex((x) => x.name === 'holiday (1).jpg');
      await click(`#groups .group:nth-child(1) .frow:nth-child(${k + 2}) input[type=checkbox]`);
      fs.appendFileSync(dHoliday, 'edited after the scan');
      await click('#trash');
      await waitFor('document.getElementById("confirm").open', 3000);
      await click('#confirmYes');
      await waitFor('window.__app.S.busy === null && document.getElementById("notice").className.includes("warn")', 10000);
      eq(fs.existsSync(dHoliday), true, 'the edited file is still there');
      eq((await text('#notice')).includes('changed after the scan'), true, 'reason: ' + (await text('#notice')));
    });

    // ---------------------------------------------------------------- music
    const music = path.join(dir, 'Music');
    fs.mkdirSync(music);
    const tone = (name, hz, meta, codec) => {
      const f = path.join(music, name);
      const m = Object.entries(meta).flatMap(([k, v]) => ['-metadata', `${k}=${v}`]);
      const r = spawnSync(ff, ['-hide_banner', '-v', 'error', '-y', '-f', 'lavfi', '-i', `sine=frequency=${hz}:duration=3`, ...codec, ...m, f], { encoding: 'utf8', windowsHide: true });
      if (r.status !== 0) throw new Error('ffmpeg: ' + r.stderr);
      return f;
    };
    const mp3 = tone('Halo (mp3).mp3', 440, { title: 'Halo', artist: 'Some Singer', album: 'First Album' }, ['-c:a', 'libmp3lame', '-b:a', '128k']);
    tone('Halo (lossless).flac', 440, { title: 'halo', artist: 'SOME SINGER' }, ['-c:a', 'flac']);
    tone('Other Song.mp3', 880, { title: 'Other', artist: 'Someone Else' }, ['-c:a', 'libmp3lame', '-b:a', '128k']);

    await step('Music mode: the same song as MP3 and FLAC is one group, the lossless one is "Best quality", previews play', async () => {
      await js(`window.__app.S.roots = []; window.__app.addRoots([${JSON.stringify(music)}])`);
      await click('#mode-music');
      eq(await js('window.__app.S.mode'), 'music', 'mode');
      eq(await js('document.getElementById("opt-music").hidden'), false, 'music options');
      await scanAndWait();
      const g = await groupNames();
      eq(g.length, 1, 'groups: ' + g.join('|'));
      eq(g[0], 'Halo (lossless).flac + Halo (mp3).mp3', 'the pair');
      eq((await text('#groups .ghead .kind')).startsWith('Same song'), true, 'kind label');
      eq((await text('#groups .chip')).includes('Best quality'), true, 'best quality chip');
      eq(await js('document.querySelector("#groups .frow .name").firstChild.textContent'), 'Halo (lossless).flac', 'best first');
      eq((await text('#groups .meta')).includes('halo — SOME SINGER'), true, 'tags shown (as written in the file)');
      await click('#groups .frow:nth-child(2) .playbtn');
      await waitFor('!document.getElementById("player").paused && document.getElementById("player").currentTime > 0.1', 5000, 'preview playing');
      await click('#groups .frow:nth-child(2) .playbtn');
      eq(await js('document.getElementById("player").paused'), true, 'stops on second click');
      await js('document.getElementById("rule").value = "best"');
      await click('#select');
      const r = await rows(0);
      eq(r.filter((x) => x.sel).map((x) => x.name).join(), 'Halo (mp3).mp3', 'the MP3 is suggested, the FLAC kept');
      await shot('04-music');
    });

    // ---------------------------------------------------------------- photos
    const pics = path.join(dir, 'Pics');
    fs.mkdirSync(path.join(pics, 'a'), { recursive: true }); fs.mkdirSync(path.join(pics, 'b'), { recursive: true });
    const lav = (out, vf, extra = []) => { const r = spawnSync(ff, ['-hide_banner', '-v', 'error', '-y', '-f', 'lavfi', '-i', vf, '-frames:v', '1', ...extra, out], { encoding: 'utf8', windowsHide: true }); if (r.status !== 0) throw new Error('ffmpeg: ' + r.stderr); };
    const base = path.join(pics, 'a', 'beach.jpg');
    lav(base, 'testsrc2=size=640x480', ['-q:v', '2']);
    const conv = (src, out, args) => { const r = spawnSync(ff, ['-hide_banner', '-v', 'error', '-y', '-i', src, ...args, out], { encoding: 'utf8', windowsHide: true }); if (r.status !== 0) throw new Error('ffmpeg: ' + r.stderr); };
    conv(base, path.join(pics, 'b', 'beach small.jpg'), ['-vf', 'scale=320:240', '-q:v', '4']);
    conv(base, path.join(pics, 'b', 'beach compressed.jpg'), ['-q:v', '24']);
    conv(base, path.join(pics, 'a', 'beach.png'), []);
    lav(path.join(pics, 'a', 'bars.jpg'), 'smptebars=size=640x480', ['-q:v', '2']);
    lav(path.join(pics, 'b', 'rings.png'), 'mandelbrot=size=640x480');

    await step('Photos mode: resized, recompressed and PNG copies of one picture are one group; other pictures are not', async () => {
      await js(`window.__app.S.roots = []; window.__app.addRoots([${JSON.stringify(pics)}])`);
      await click('#mode-photos');
      eq(await js('document.getElementById("opt-photos").hidden'), false, 'photo options');
      await scanAndWait();
      const g = await groupNames();
      eq(g.length, 1, 'groups: ' + g.join('|'));
      eq(g[0], 'beach compressed.jpg + beach small.jpg + beach.jpg + beach.png', 'the four versions');
      eq((await text('#groups .ghead .kind')).length > 0, true, 'kind label');
    });

    await step('pictures show thumbnails, sizes in pixels, and the largest first; clicking one opens a bigger view', async () => {
      await waitFor('[...document.querySelectorAll("#groups img.thumb")].every(i => i.complete && i.naturalWidth > 0)', 8000, 'thumbnails');
      eq(await js('document.querySelectorAll("#groups img.thumb").length'), 4, 'four thumbnails');
      const metas = await js('[...document.querySelectorAll("#groups .frow")].map(r => r.querySelector(".meta:last-child").textContent)');
      eq(metas.filter((m) => m.includes('640 × 480')).length, 3, 'dimensions from the file headers: ' + metas.join(' | '));
      eq(metas.some((m) => m.includes('320 × 240')), true, 'the small one');
      eq((await text('#groups .chip')).includes('Largest'), true, 'largest chip');
      await click('#groups .frow:nth-child(2) img.thumb');
      await waitFor('document.getElementById("lightbox").open', 3000, 'lightbox');
      await waitFor('document.getElementById("lightImg").naturalWidth > 0', 5000, 'big image');
      await shot('05-photos');
      await click('#lightbox .close');
      await waitFor('!document.getElementById("lightbox").open', 3000);
    });

    await step('the strictest setting still groups copies that are nearly identical', async () => {
      await js('document.getElementById("threshold").value = "4"; document.getElementById("threshold").dispatchEvent(new Event("change"))');
      await scanAndWait();
      const g = await groupNames();
      eq(g.length <= 1, true, 'strict: ' + g.join('|'));
      if (g.length) eq(g[0].split(' + ').length >= 2, true, 'strict group has at least 2: ' + g[0]);
      notes.strictGroup = g[0] || '(none)';
      await js('document.getElementById("threshold").value = "8"; document.getElementById("threshold").dispatchEvent(new Event("change"))');
    });

    // ---------------------------------------------------------------- stop a scan
    const many = path.join(dir, 'Many');
    fs.mkdirSync(many);
    for (let i = 0; i < 1500; i++) fs.writeFileSync(path.join(many, `p${i}.png`), png(160, 160, (x, y) => (Math.sin((x + i) * 0.13) * Math.cos((y * (1 + (i % 7))) * 0.09) * 127 + 128) | 0));

    await step('Stop ends a long picture scan at once and shows no results', async () => {
      await js(`window.__app.S.roots = []; window.__app.addRoots([${JSON.stringify(many)}])`);
      await click('#scan');
      await waitFor('document.getElementById("status").textContent.startsWith("Looking at pictures")', 15000, 'hashing to start');
      eq(await js('document.getElementById("stop").hidden'), false, 'Stop is shown');
      eq(await js('document.getElementById("scan").hidden'), true, 'Scan is hidden');
      const t0 = Date.now();
      await click('#stop');
      await waitFor('window.__app.S.busy === null', 8000, 'idle');
      notes.stopMs = Date.now() - t0;
      eq(notes.stopMs < 5000, true, 'stopped in ' + notes.stopMs + ' ms');
      eq(await js('document.getElementById("status").textContent'), 'Scan stopped.', 'status');
      eq(await js('document.getElementById("results").hidden'), true, 'no results shown');
      eq(await js('document.getElementById("scan").hidden'), false, 'Scan is back');
    });

    await step('a full scan of 1,500 pictures: fast the second time (hashes remembered)', async () => {
      const t0 = Date.now();
      await scanAndWait(120000);
      notes.photosFirstMs = Date.now() - t0;
      const t1 = Date.now();
      await scanAndWait(60000);
      notes.photosSecondMs = Date.now() - t1;
      eq(notes.photosSecondMs < notes.photosFirstMs, true, `second ${notes.photosSecondMs} ms vs first ${notes.photosFirstMs} ms`);
      eq((await text('#status')).includes('Done'), true, 'done');
    });

    // ---------------------------------------------------------------- the real Recycle Bin, once
    await step('the real Recycle Bin: one tiny file of ours is moved there (not deleted)', async () => {
      setTrashMode('');
      const tag = `dupefinder-e2e-delete-me-${process.pid}`;
      const rb = path.join(dir, 'RealBin');
      fs.mkdirSync(rb);
      const data = Buffer.from('this file was made by the Duplicate Finder test and can be deleted');
      const keepF = path.join(rb, `${tag}-keep.txt`); const goF = path.join(rb, `${tag}-move.txt`);
      fs.writeFileSync(keepF, data); fs.writeFileSync(goF, data);
      fs.utimesSync(keepF, new Date('2020-01-01'), new Date('2020-01-01')); fs.utimesSync(goF, new Date('2021-01-01'), new Date('2021-01-01'));
      await js('document.getElementById("mode-files").click()');
      await js(`window.__app.S.roots = []; window.__app.addRoots([${JSON.stringify(rb)}])`);
      await scanAndWait();
      eq((await groupNames()).length, 1, 'one group');
      await js('document.getElementById("rule").value = "oldest"');
      await click('#select');
      await click('#trash');
      await waitFor('document.getElementById("confirm").open', 3000);
      eq((await text('#confirmText')).includes('Recycle Bin') || (await text('#confirmText')).includes('Trash'), true, 'names the bin');
      await click('#confirmYes');
      await waitFor('window.__app.S.busy === null && document.getElementById("notice").className.includes("ok")', 15000, 'moved');
      eq(fs.existsSync(goF), false, 'gone from its folder');
      eq(fs.existsSync(keepF), true, 'the other copy stays');
      notes.realBinFile = path.basename(goF);
    });

    await step('no errors reached the console', async () => {
      const real = errors.filter((m) => !/Autofill\./.test(m));
      eq(real.length, 0, 'console errors: ' + real.join(' | '));
    });
  } catch (e) {
    results.push({ name: 'test run', ok: false, error: String((e && e.stack) || e) });
  }
  const ok = results.every((r) => r.ok);
  if (outFile) fs.writeFileSync(outFile, JSON.stringify({ ok, results, notes }, null, 2));
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  app.exit(ok ? 0 : 1);
};
