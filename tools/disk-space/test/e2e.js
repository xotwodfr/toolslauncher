'use strict';
// End-to-end test: runs inside Electron (`npm run e2e`). Drives the REAL window with real mouse and keyboard input on a
// generated folder tree, and checks what the page shows against sizes measured independently with fs.lstat, and what
// happens on disk (Move to Recycle Bin really moves the folder away).
const fs = require('fs');
const os = require('os');
const path = require('path');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const WIN = process.platform === 'win32';
const alloc = (p) => { const st = fs.lstatSync(p); return !WIN && typeof st.blocks === 'number' ? st.blocks * 512 : st.size; };

exports.run = async ({ app, getWin, outFile, shotsDir, dialog, shell, clipboard, testHooks }) => {
  const results = [];
  const errors = [];
  const notes = {};
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'diskspace-e2e-'));
  const win = getWin();
  const wc = win.webContents;
  const js = (code) => wc.executeJavaScript(code, true);
  wc.on('console-message', (_e, level, msg) => { if (level >= 2) errors.push(msg); });
  const step = async (name, fn) => {
    try { const detail = await fn(); results.push({ name, ok: true, detail: detail === undefined ? '' : detail }); console.log('ok   ' + name); }
    catch (e) { results.push({ name, ok: false, error: String((e && e.message) || e) }); console.log('FAIL ' + name + ': ' + ((e && e.message) || e)); }
  };
  const assert = (c, m) => { if (!c) throw new Error(m); };
  const eq = (a, b, what) => { if (a !== b) throw new Error(`${what}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); };
  const waitFor = async (expr, ms = 10000, what = expr) => {
    const end = Date.now() + ms;
    for (;;) { const v = await js(expr); if (v) return v; if (Date.now() > end) throw new Error('timed out waiting for ' + what); await sleep(50); }
  };
  const shot = async (name) => {
    if (!shotsDir) return;
    fs.mkdirSync(shotsDir, { recursive: true });
    await sleep(300);
    fs.writeFileSync(path.join(shotsDir, name + '.png'), (await wc.capturePage()).toPNG());
  };
  const key = async (keyCode, modifiers = []) => { wc.sendInputEvent({ type: 'keyDown', keyCode, modifiers }); wc.sendInputEvent({ type: 'keyUp', keyCode, modifiers }); await sleep(80); };
  const center = (selector) => js(`(()=>{const e=document.querySelector(${JSON.stringify(selector)}); if(!e) return null; e.scrollIntoView({block:'nearest'}); const b=e.getBoundingClientRect(); return {x:Math.round(b.x+b.width/2), y:Math.round(b.y+b.height/2)};})()`);
  const move = async (x, y) => { wc.sendInputEvent({ type: 'mouseMove', x, y }); await sleep(60); };
  const clickAt = async (x, y, clickCount = 1) => {
    wc.sendInputEvent({ type: 'mouseMove', x, y });
    wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount });
    wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount });
    await sleep(120);
  };
  const click = async (selector) => { const r = await center(selector); if (!r) throw new Error('nothing to click: ' + selector); await clickAt(r.x, r.y); };
  /** page coordinates of a box on the map: its middle, or the middle of its name bar */
  const mapBox = async (name, header = false) => js(`(()=>{const c=document.getElementById('map').getBoundingClientRect(); const r=window.__app.S.rects.find((r)=>r.node.n===${JSON.stringify(name)}); if(!r) return null; return {x:Math.round(c.x+r.x+Math.min(r.w/2, 40)), y:Math.round(c.y+r.y+(${header} ? 8 : r.h/2)), header:r.header};})()`);
  const rowFor = (p) => `tr[data-path=${JSON.stringify(p)}]`;

  try {
    win.setContentSize(1240, 840);
    // ---- fixture: a folder tree with known sizes --------------------------------------------------------------------
    const root = path.join(dir, 'Fixture Drive');
    const mk = (rel, bytes) => { const p = path.join(root, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, Buffer.alloc(bytes, 1)); return p; };
    const files = [];
    files.push(mk('Videos/holiday.mkv', 3_000_000), mk('Videos/clip.mp4', 1_000_000));
    files.push(mk('Music/song.flac', 800_000), mk('Music/Ünïcödé 名前.mp3', 300_000));
    for (let i = 0; i < 20; i++) files.push(mk(`Photos/2023/IMG_${1000 + i}.jpg`, 50_000 + i * 1000));
    for (let i = 0; i < 150; i++) files.push(mk(`Code/src/file${i}.js`, 2000 + i));
    files.push(mk('Old Stuff/backup.zip', 2_000_000), mk('Old Stuff/notes.txt', 4000));
    files.push(mk('Tools/setup.exe', 400_000));
    fs.symlinkSync(root, path.join(root, 'Music', 'loop'), 'dir');
    fs.linkSync(path.join(root, 'Videos', 'clip.mp4'), path.join(root, 'clip-hardlink.mp4'));
    const total = files.reduce((t, f) => t + alloc(f), 0);
    const sizeOf = (rel) => files.filter((f) => f.startsWith(path.join(root, rel) + path.sep)).reduce((t, f) => t + alloc(f), 0);

    let openReturn = [root]; let saveTo = null; let confirm = 0; const shown = []; const opened = []; const boxes = [];
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: openReturn });
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: saveTo });
    dialog.showMessageBox = async (_w, o) => { boxes.push(o); return { response: confirm }; };
    shell.showItemInFolder = (p) => { shown.push(p); };
    shell.openPath = async (p) => { opened.push(p); return ''; };

    await step('the start page lists the drives with their free space, and the drop area', async () => {
      await waitFor('!!window.__app && document.querySelectorAll("#drives .drive").length > 0', 8000, 'drives');
      const first = await js('document.querySelector("#drives .drive .free").textContent');
      assert(/free of .* used/.test(first), first);
      eq(await js('document.getElementById("results").hidden'), true, 'no results yet');
      await shot('1-start');
      return first;
    });

    await step('Choose a folder… (real click) scans it: totals match the files on disk, the hard link counts once, the link loop is not followed', async () => {
      await click('#pick2');
      await waitFor('window.__app.S.root && !window.__app.S.scanning', 20000, 'scan finished');
      const t = await js('({ s: window.__app.S.root.s, f: window.__app.S.root.f, status: document.getElementById("status").textContent })');
      eq(t.s, total, 'total size');
      eq(t.f, files.length, 'file count');
      assert(/Scanned 177 files in 8 folders/.test(t.status), t.status);
      assert(/1 extra hard link counted once/.test(t.status) && /1 link not followed/.test(t.status), t.status);
      eq(await js('document.getElementById("cancel").hidden'), true, 'no Cancel after the scan');
      eq(await js('document.getElementById("csv").hidden'), false, 'export offered');
      await shot('2-map');
      return t.status;
    });

    await step('the map shows every folder and the big files in the right colours; hovering shows the path and size', async () => {
      const n = await js('window.__app.S.rects.length');
      assert(n > 30, 'boxes drawn: ' + n);
      const mkv = await js('(()=>{const r=window.__app.S.rects.find((r)=>r.node.n==="holiday.mkv"); return r && {area:r.w*r.h, k:r.node.k};})()');
      eq(mkv.k, 0, 'video colour group');
      const b = await mapBox('holiday.mkv');
      await move(b.x, b.y);
      await waitFor('!document.getElementById("tip").hidden', 3000, 'tooltip');
      const tip = await js('document.getElementById("tip").textContent');
      assert(tip.includes(path.join(root, 'Videos', 'holiday.mkv')) && /2\.\d+ MB/.test(tip), tip);
      // the pixel under the mouse has the video colour (orange): checks the canvas really draws
      const px = await js(`(()=>{const c=document.getElementById('map'); const b=c.getBoundingClientRect(); const d=c.getContext('2d').getImageData((${b.x}-b.x)*devicePixelRatio,(${b.y}-b.y)*devicePixelRatio,1,1).data; return [d[0],d[1],d[2]];})()`);
      assert(px[0] > px[2] + 40, 'orange-ish pixel: ' + px);
    });

    await step('clicking a file on the map selects it; clicking a folder\'s name bar goes into it; the path bar and Backspace go back up', async () => {
      const b = await mapBox('holiday.mkv');
      await clickAt(b.x, b.y);
      eq(await js('document.getElementById("selName").textContent'), 'holiday.mkv', 'selected');
      assert(/2\.\d+ MB/.test(await js('document.getElementById("selSize").textContent')), 'size shown');
      eq(await js('document.getElementById("aZoom").hidden'), true, 'no "go into" for a file');
      const h = await mapBox('Photos', true);
      assert(h && h.header, 'Photos has a name bar');
      await clickAt(h.x, h.y);
      eq(await js('window.__app.S.view.n'), 'Photos', 'went into Photos');
      eq(await js('[...document.querySelectorAll("#crumbs button")].map((b)=>b.textContent.replace(/\u200e/g, "")).join(">")'), `${root}>Photos`, 'path bar');
      const h2 = await mapBox('2023', true);
      await clickAt(h2.x, h2.y);
      eq(await js('window.__app.S.view.n'), '2023', 'went into 2023');
      eq(await js('window.__app.S.rects.filter((r)=>r.depth===1).length'), 20, 'twenty photos');
      await key('Backspace');
      eq(await js('window.__app.S.view.n'), 'Photos', 'Backspace goes up');
      await click('#crumbs button:first-child');
      eq(await js('window.__app.S.view === window.__app.S.root'), true, 'back at the top');
      // double-click anywhere in a folder goes into it as well
      const m = await mapBox('song.flac');
      await clickAt(m.x, m.y, 2);
      eq(await js('window.__app.S.view.n'), 'Music', 'double-click went into Music');
      await click('#crumbs button:first-child');
    });

    await step('the Folders list (real clicks) shows sizes and % of the folder, sorts by any column and opens folders', async () => {
      await click('#tab-tree');
      eq(await js('document.getElementById("v-tree").hidden'), false, 'list shown');
      let names = await js('[...document.querySelectorAll("#treeRows tr .t")].map((e)=>e.textContent)');
      eq(names[0], 'Videos', 'largest first');
      const vrow = rowFor(path.join(root, 'Videos'));
      // the hard link pair: whichever of the two is met first is counted (here the one at the top), the other is not
      const vs = await js(`window.__app.nodeAt(${JSON.stringify(path.join(root, 'Videos'))}).s`);
      const clipInVideos = await js(`window.__app.nodeAt(${JSON.stringify(path.join(root, 'Videos', 'clip.mp4'))}) != null`);
      const clipAtTop = await js(`window.__app.nodeAt(${JSON.stringify(path.join(root, 'clip-hardlink.mp4'))}) != null`);
      assert(clipInVideos !== clipAtTop, 'exactly one of the two hard links is counted');
      eq(vs, alloc(files[0]) + (clipInVideos ? alloc(files[1]) : 0), 'Videos size');
      eq(await js(`document.querySelector(${JSON.stringify(vrow)} + " .pbar .v").textContent`), (vs / total * 100).toFixed(0) + ' %', 'percent of the folder');
      await click('#v-tree button.sort[data-sort="name"]');
      names = await js('[...document.querySelectorAll("#treeRows tr .t")].map((e)=>e.textContent)');
      eq(JSON.stringify(names), JSON.stringify([...names].sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }))), 'by name');
      await click('#v-tree button.sort[data-sort="size"]');
      await click('#v-tree button.sort[data-sort="size"]');
      eq(await js('document.querySelector("#v-tree th.c-size").getAttribute("aria-sort")'), 'ascending', 'size ascending after two clicks');
      await click('#v-tree button.sort[data-sort="files"]');
      names = await js('[...document.querySelectorAll("#treeRows tr .t")].map((e)=>e.textContent)');
      eq(names[0], 'Code', 'most files first');
      await click(`${rowFor(path.join(root, 'Code'))} .tog`);
      await click(`${rowFor(path.join(root, 'Code', 'src'))} .tog`);
      const smaller = await js('[...document.querySelectorAll("#treeRows tr .t")].map((e)=>e.textContent).find((t)=>/smaller files/.test(t))');
      eq(smaller, '86 smaller files', 'the folded rest of a big folder');
      await shot('3-folders');
    });

    await step('Largest files and File types show the right numbers', async () => {
      await click('#tab-big');
      const first = await js('[...document.querySelectorAll("#bigRows tr")[0].children].map((t)=>t.textContent)');
      eq(first[1], 'holiday.mkv', 'largest file'); eq(first[3], 'Video', 'type');
      eq(await js('document.querySelectorAll("#bigRows tr").length'), 177, 'every file is listed (fewer than 200)');
      await click('#tab-types');
      const video = await js('document.querySelector("#groupRows tr[data-group=video] .c-size").textContent');
      eq(video, await js(`window.__app.fmt(${alloc(files[0]) + alloc(files[1])})`), 'video size');
      const exts = await js('[...document.querySelectorAll("#extRows tr td:first-child")].map((e)=>e.textContent)');
      assert(exts.includes('.js') && exts.includes('.jpg'), exts);
    });

    await step('Show in folder, Open and Copy path work on the selected item; programs are not started', async () => {
      await click('#tab-big');
      await click(rowFor(path.join(root, 'Music', 'Ünïcödé 名前.mp3')));
      eq(await js('document.getElementById("selName").textContent'), 'Ünïcödé 名前.mp3', 'unicode name selected');
      await click('#aShow'); await sleep(150);
      eq(shown[shown.length - 1], path.join(root, 'Music', 'Ünïcödé 名前.mp3'), 'revealed');
      await click('#aOpen'); await sleep(150);
      eq(opened[opened.length - 1], path.join(root, 'Music', 'Ünïcödé 名前.mp3'), 'opened');
      await click('#aCopy'); await sleep(150);
      eq(clipboard.readText(), path.join(root, 'Music', 'Ünïcödé 名前.mp3'), 'clipboard');
      await click(rowFor(path.join(root, 'Tools', 'setup.exe')));
      eq(await js('document.getElementById("aOpen").disabled'), true, 'Open is off for a program');
      const r = await js(`window.ds.open(${JSON.stringify(path.join(root, 'Tools', 'setup.exe'))})`);
      assert(!r.ok && /not started/.test(r.error), 'main refuses too: ' + JSON.stringify(r));
      const outside = await js(`window.ds.show(${JSON.stringify(os.homedir())})`);
      assert(!outside.ok && /not in the scanned folder/.test(outside.error), 'paths outside the scan are refused: ' + JSON.stringify(outside));
    });

    await step('Move to Recycle Bin (real click): asks first with the size; Cancel keeps it; confirming moves the folder away and the totals drop', async () => {
      await click('#tab-tree');
      await click('#v-tree button.sort[data-sort="size"]');
      const old = path.join(root, 'Old Stuff');
      await click(rowFor(old));
      eq(await js('document.getElementById("selName").textContent'), 'Old Stuff', 'selected');
      confirm = 1;
      await click('#aTrash'); await sleep(300);
      const box = boxes[boxes.length - 1];
      assert(box && /Old Stuff/.test(box.message) && /2 files/.test(box.message) && /1\.9\d MB/.test(box.detail), 'confirmation with name, count and size: ' + JSON.stringify(box));
      assert(fs.existsSync(old), 'Cancel kept it');
      const freed = sizeOf('Old Stuff');
      confirm = 0;
      await click('#aTrash');
      await waitFor('!window.__app.nodeAt(' + JSON.stringify(old) + ')', 15000, 'removed from the tree');
      assert(!fs.existsSync(old), 'the folder is gone from its place (in the Recycle Bin)');
      eq(await js('window.__app.S.root.s'), total - freed, 'total reduced');
      eq(await js('window.__app.S.root.f'), files.length - 2, 'files reduced');
      assert(/Recycle Bin/.test(await js('document.getElementById("toast").textContent')), 'says so');
      notes.trash = 'real shell.trashItem';
    });

    await step('Rescan this folder picks up new files in just that folder and updates the totals above it', async () => {
      fs.writeFileSync(path.join(root, 'Videos', 'new.webm'), Buffer.alloc(500_000, 2));
      const before = await js('window.__app.S.root.s');
      await click(rowFor(path.join(root, 'Videos')));
      await click('#aRescan');
      await waitFor('/Rescanned/.test(document.getElementById("toast").textContent)', 15000, 'rescan done');
      const added = alloc(path.join(root, 'Videos', 'new.webm'));
      eq(await js('window.__app.S.root.s'), before + added, 'total grew by the new file');
      const inV = await js(`window.__app.nodeAt(${JSON.stringify(path.join(root, 'Videos', 'clip.mp4'))}) != null`);
      const atTop = await js(`window.__app.nodeAt(${JSON.stringify(path.join(root, 'clip-hardlink.mp4'))}) != null`);
      assert(inV !== atTop, 'the hard-linked clip is still counted exactly once after the rescan');
      eq(await js(`window.__app.nodeAt(${JSON.stringify(path.join(root, 'Videos'))}).f`), inV ? 3 : 2, 'videos counted');
      eq(await js('window.__app.S.root.g[0]'), alloc(files[0]) + alloc(files[1]) + added, 'video group updated');
    });

    await step('Export CSV… (real click) saves the current folder as a spreadsheet', async () => {
      saveTo = path.join(dir, 'summary.csv');
      await click('#csv');
      const end = Date.now() + 6000; while (!fs.existsSync(saveTo) && Date.now() < end) await sleep(50);
      const raw = fs.readFileSync(saveTo, 'utf8');
      assert(raw.charCodeAt(0) === 0xfeff, 'BOM for Excel');
      const lines = raw.slice(1).trim().split('\r\n');
      eq(lines[0], 'Path,Kind,Size on disk (bytes),Size,% of folder,Files,Folders', 'header');
      assert(lines.some((l) => l.startsWith(path.join(root, 'Videos') + ',folder,')), 'Videos line');
      assert(!fs.existsSync(saveTo + '.part'), 'no temporary file left');
    });

    await step('scanning a whole drive (real click on the drive\'s Scan button) shows live progress and the map so far; Cancel (real click) keeps the partial result', async () => {
      testHooks.delayMs = 15;
      await click('#newScan');
      await waitFor('!document.getElementById("start").hidden', 3000, 'start page');
      const sys = WIN ? process.env.SystemDrive + '\\' : '/';
      await click(`#drives .drive[data-path=${JSON.stringify(sys)}] button`);
      await waitFor('window.__app.S.scanning && /Scanning/.test(document.getElementById("status").textContent)', 8000, 'progress shown');
      await waitFor('!!window.__app.S.live', 15000, 'a live map');
      eq(await js('document.getElementById("prog").hidden'), false, 'progress bar');
      assert((await js('document.getElementById("current").textContent')).length > 0, 'current folder shown');
      await shot('4-live');
      await click('#cancel');
      await waitFor('!window.__app.S.scanning && window.__app.S.root', 15000, 'stopped');
      testHooks.delayMs = 0;
      assert(/^Stopped early/.test(await js('document.getElementById("status").textContent')), 'says it is partial');
      const unscanned = await js('(()=>{let n=0; const st=[window.__app.S.root]; while(st.length){const x=st.pop(); if(x.u) n++; (x.c||[]).forEach((c)=>{ if(c.c) st.push(c); });} return n;})()');
      assert(unscanned > 0, 'folders not reached are marked');
      return `${await js('window.__app.S.root.f')} files before Cancel`;
    });

    await step('system folders are refused for the Recycle Bin, before any question is asked', async () => {
      const n = boxes.length;
      const targets = WIN ? [process.env.SystemRoot || 'C:\\Windows', process.env.ProgramFiles || 'C:\\Program Files'] : ['/usr', '/etc', '/bin'];
      for (const t of targets) {
        if (!fs.existsSync(t)) continue;
        const r = await js(`window.ds.trash(${JSON.stringify(t)}, 1, 1)`);
        assert(!r.ok && r.refused && /system/i.test(r.error), t + ': ' + JSON.stringify(r));
      }
      const home = await js(`window.ds.trash(${JSON.stringify(os.homedir())}, 1, 1)`);
      assert(!home.ok && home.refused, 'home folder: ' + JSON.stringify(home));
      eq(boxes.length, n, 'no confirmation was shown');
      assert(fs.existsSync(targets[0]));
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
