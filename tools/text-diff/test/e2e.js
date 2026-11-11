'use strict';
// End-to-end test: runs inside Electron (`npm run e2e`). Drives the REAL window with real mouse and keyboard input on
// invented files, then checks what the page shows AND what ends up on disk (merged files, backups, patches that apply
// back with the `diff` package, copied folders, the Recycle Bin calls).
const fs = require('fs');
const os = require('os');
const path = require('path');
const JsDiff = require('diff');
const E = require('../src/core/encoding');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

exports.run = async ({ app, getWin, outFile, shotsDir, dialog, hooks }) => {
  const results = [];
  const errors = [];
  const notes = {};
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'textdiff-e2e-'));
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
    await sleep(25);
  };
  const typeText = async (text) => { for (const ch of text) { if (ch === '\n') await key('Return', [], '\r'); else await key(ch, [], true); } };
  const center = (selector) => js(`(()=>{const e=document.querySelector(${JSON.stringify(selector)}); if(!e) return null; e.scrollIntoView({block:'nearest'}); const b=e.getBoundingClientRect(); if(!b.width) return null; return {x:Math.round(b.x+b.width/2), y:Math.round(b.y+b.height/2)};})()`);
  const clickAt = async (x, y, clickCount = 1) => {
    wc.sendInputEvent({ type: 'mouseMove', x, y });
    wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount });
    wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount });
    await sleep(90);
  };
  const click = async (selector) => { const r = await center(selector); if (!r) throw new Error('nothing to click: ' + selector); await clickAt(r.x, r.y); };
  const dblclick = async (selector) => { const r = await center(selector); if (!r) throw new Error('nothing to click: ' + selector); await clickAt(r.x, r.y, 1); await clickAt(r.x, r.y, 2); };
  const text = (sel) => js(`(document.querySelector(${JSON.stringify(sel)})||{}).textContent`);
  const waitDiff = () => waitFor('window.__app.S.diff && document.getElementById("busy").hidden', 30000, 'the comparison');

  try {
    win.setContentSize(1280, 820);
    // ---- fixtures -------------------------------------------------------------------------------------------------------
    const leftText = 'Shopping list\r\nApples: 4\r\nBread: 1 loaf\r\nMilk: 2 litres\r\nCheese\r\nTea: green\r\n';
    const rightText = 'Shopping list\nApples: 6\nBread: 1 loaf\nMilk: 2 litres\nCheese\nTea: green\nHoney\n';
    const fileL = path.join(dir, 'list (utf16).txt'); fs.writeFileSync(fileL, E.encode(leftText, 'utf-16le', true));
    const fileR = path.join(dir, 'list.txt'); fs.writeFileSync(fileR, rightText);
    const binA = path.join(dir, 'photo-a.bin'); fs.writeFileSync(binA, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3, 4, 5]));
    const binB = path.join(dir, 'photo-b.bin'); fs.writeFileSync(binB, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3, 4, 6]));
    const binC = path.join(dir, 'photo-c.bin'); fs.copyFileSync(binA, binC);
    const big = Array.from({ length: 100000 }, (_, i) => `row ${i}: value ${(i * 7919) % 100003}`);
    const big2 = big.slice(); for (let i = 0; i < 400; i++) big2[(i * 241 + 17) % big2.length] = `row edited ${i}`; big2.splice(99990, 0, 'added near the end');
    const bigL = path.join(dir, 'big-left.log'); fs.writeFileSync(bigL, big.join('\n') + '\n');
    const bigR = path.join(dir, 'big-right.log'); fs.writeFileSync(bigR, big2.join('\n') + '\n');

    let openReturn = []; let saveTo = null; let boxAnswer = 0; const boxes = [];
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: openReturn });
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: saveTo });
    dialog.showMessageBox = async (_w, opts) => { boxes.push(opts); return { response: boxAnswer }; };
    const trashed = [];
    const realTrash = hooks.trash;
    hooks.trash = async (p) => { trashed.push(p); await realTrash(p); };

    await step('the window starts with two empty text boxes and a Compare button', async () => {
      await waitFor('!!window.__app');
      eq(await js('document.getElementById("editors").hidden'), false, 'editors shown');
      eq(await js('document.getElementById("viewer").hidden'), true, 'viewer hidden');
      eq(await js('document.getElementById("compare").hidden'), false, 'compare button');
      eq(await text('#nameL'), 'Empty', 'left name');
    });

    await step('typing two texts (real keyboard) and pressing Compare shows the changes with word highlights', async () => {
      await click('#edL');
      await typeText('alpha\nThe quick brown fox\nsame line\nCase Only\nend');
      await click('#edR');
      await typeText('alpha\nThe quick red fox\nsame line\ncase only\nend\nextra');
      await click('#compare');
      await waitDiff();
      eq(await js('document.getElementById("viewer").hidden'), false, 'viewer shown');
      const sum = await text('#summary');
      assert(/^3 changes: 2 lines changed, 1 added\./.test(sum), 'summary: ' + sum);
      const marks = await js('[...document.querySelectorAll("#paneL mark.hl")].map((m) => m.textContent)');
      assert(marks.includes('brown'), 'left highlight: ' + marks);
      const marksR = await js('[...document.querySelectorAll("#paneR mark.hl")].map((m) => m.textContent)');
      assert(marksR.includes('red'), 'right highlight: ' + marksR);
      eq(await js('document.querySelectorAll("#paneL .ln.gapln").length'), 1, 'one gap row on the left for the added line');
      eq(await js('document.querySelectorAll("#gutter .gh").length'), 3, 'three change markers in the gutter');
      await shot('1-typed');
      return sum;
    });

    await step('Next / Prev (real clicks and F7) move through the changes', async () => {
      await click('#next');
      eq(await text('#pos'), '1 / 3', 'first change');
      assert(await js('document.querySelectorAll("#paneL .ln.cur").length >= 1'), 'current change marked');
      await click('#next'); eq(await text('#pos'), '2 / 3', 'second');
      await key('F7'); eq(await text('#pos'), '3 / 3', 'F7');
      await key('F7'); eq(await text('#pos'), '3 / 3', 'stays on the last');
      await click('#prev'); eq(await text('#pos'), '2 / 3', 'prev');
      await key('F7', ['shift']); eq(await text('#pos'), '1 / 3', 'Shift+F7');
    });

    await step('Ignore case (real click) hides the case-only change; Characters mode highlights single letters', async () => {
      await click('#igCase');
      await waitFor('window.__app.S.diff && window.__app.S.diff.stats.changes === 2', 8000, 'two changes');
      assert(/^2 changes/.test(await text('#summary')), 'summary updated');
      await click('#igCase');
      await waitFor('window.__app.S.diff && window.__app.S.diff.stats.changes === 3', 8000, 'three again');
      await js('(() => { const s = document.getElementById("inline"); s.value = "char"; s.dispatchEvent(new Event("change")); })()');
      const marks = await js('[...document.querySelectorAll("#paneR mark.hl")].map((m) => m.textContent)');
      assert(marks.includes('C') === false && marks.some((m) => m === 'c' || m === 'red' || m === 're'), 'character marks: ' + marks);
      await js('(() => { const s = document.getElementById("inline"); s.value = "word"; s.dispatchEvent(new Event("change")); })()');
    });

    await step('the Unified view (real click) shows removed and added lines with both line numbers', async () => {
      await click('[data-view="unified"]');
      eq(await js('document.getElementById("vUni").hidden'), false, 'unified shown');
      const signs = await js('[...document.querySelectorAll("#paneU .ln .sg")].map((s) => s.textContent).join("")');
      eq(signs.replace(/ /g, '.'), '.−+.−+.+', 'signs');
      await click('[data-view="side"]');
      eq(await js('document.getElementById("vSide").hidden'), false, 'back to side by side');
    });

    await step('Edit texts goes back to the boxes with the texts kept', async () => {
      await click('#edit');
      eq(await js('document.getElementById("edL").value.split("\\n").length'), 5, 'left kept');
      await js('document.activeElement.blur()');
      await key('Return', ['control']);
      await waitDiff();
    });

    await step('Open… (real clicks) loads a UTF-16 CRLF file and a UTF-8 LF file; they compare automatically', async () => {
      openReturn = [fileL]; await click('#openL');
      openReturn = [fileR]; await click('#openR');
      await waitFor('window.__app.S.side.right.path && window.__app.S.diff && window.__app.S.diff.linesB === 7', 10000, 'files compared');
      const factsL = await text('#factsL'); const factsR = await text('#factsR');
      assert(/UTF-16 LE/.test(factsL) && /CRLF/.test(factsL), 'left facts: ' + factsL);
      assert(/UTF-8/.test(factsR) && /LF/.test(factsR) && !/CRLF/.test(factsR), 'right facts: ' + factsR);
      eq(await text('#nameL'), 'list (utf16).txt', 'left name');
      assert(/^2 changes: 1 line changed, 1 added/.test(await text('#summary')), 'line endings ignored: ' + await text('#summary'));
      await click('#igEol');
      await waitFor('window.__app.S.diff && window.__app.S.diff.stats.changes === 1', 8000, 'every line differs by its ending');
      await click('#igEol');
      await waitFor('window.__app.S.diff && window.__app.S.diff.stats.changes === 2', 8000, 'back to 2');
    });

    await step('Save patch… writes a unified diff that applies back to the left text and gives the right one', async () => {
      saveTo = path.join(dir, 'list.patch');
      await click('#patch');
      await waitFor('/Saved the patch/.test(document.getElementById("result").textContent)');
      const patch = fs.readFileSync(saveTo, 'utf8');
      assert(patch.startsWith('--- a/list (utf16).txt\n+++ b/list.txt\n'), patch.slice(0, 80));
      eq(JsDiff.applyPatch(leftText, patch), rightText, 'patch applied');
    });

    await step('HTML report… writes a self-contained page with the changes', async () => {
      saveTo = path.join(dir, 'report.html');
      await click('#report');
      await waitFor('/Saved the report/.test(document.getElementById("result").textContent)');
      const html = fs.readFileSync(saveTo, 'utf8');
      assert(html.includes('list (utf16).txt') && html.includes('<mark class="a">6</mark>') && html.includes('Honey'), 'report content');
      assert(!/<script/i.test(html) && !/https?:\/\//.test(html), 'no scripts, no links');
    });

    await step('taking the right side of one change (gutter button) builds the merged text; Save as… writes it in the left file\'s encoding', async () => {
      await click('#gutter .gh[data-h="0"] .pick[data-pick="right"]');
      await waitFor('!document.getElementById("merge").hidden && document.getElementById("merged").value.length > 0');
      const merged = await js('window.__app.S.mergedRaw');
      eq(merged, 'Shopping list\r\nApples: 6\nBread: 1 loaf\r\nMilk: 2 litres\r\nCheese\r\nTea: green\r\n', 'merged text (each line keeps its own line ending)');
      eq(await js('document.querySelector("#gutter .gh[data-h=\\"0\\"] .pick[data-pick=\\"right\\"]").getAttribute("aria-pressed")'), 'true', 'pressed');
      assert(/1 of 2/.test(await text('#mergeInfo')), 'merge info');
      await click('#gutter .gh[data-h="1"] .pick[data-pick="right"]');
      await waitFor('document.getElementById("merged").value.endsWith("Honey\\n")', 5000, 'second change taken');
      await shot('2-merge');
      // edit by hand, then save as a new file
      await click('#merged');
      await key('End', ['control']);
      await typeText('Lemons');
      saveTo = path.join(dir, 'merged.txt');
      await click('#saveNew');
      await waitFor('/Saved the merged text/.test(document.getElementById("result").textContent)');
      const d = E.detect(fs.readFileSync(saveTo));
      eq(d.encoding, 'utf-16le', 'same encoding as the left file');
      eq(d.text, 'Shopping list\r\nApples: 6\r\nBread: 1 loaf\r\nMilk: 2 litres\r\nCheese\r\nTea: green\r\nHoney\r\nLemons', 'saved text (edited by hand: the left file\'s CRLF line endings)');
      assert(!fs.existsSync(saveTo + '.part'), 'no .part left');
    });

    await step('Overwrite left… asks first (cancel leaves it), then replaces it and keeps a .bak with the original bytes', async () => {
      const before = fs.readFileSync(fileL);
      boxAnswer = 1;
      await click('#saveL');
      await sleep(300);
      assert(boxes.length >= 1 && /Overwrite/.test(boxes[boxes.length - 1].message), 'asked');
      assert(fs.readFileSync(fileL).equals(before), 'cancel leaves the file alone');
      boxAnswer = 0;
      await click('#saveL');
      await waitFor('/Overwrote/.test(document.getElementById("result").textContent)');
      assert(fs.readFileSync(fileL + '.bak').equals(before), '.bak has the original bytes');
      eq(E.detect(fs.readFileSync(fileL)).text, 'Shopping list\r\nApples: 6\r\nBread: 1 loaf\r\nMilk: 2 litres\r\nCheese\r\nTea: green\r\nHoney\r\nLemons', 'new content');
      await waitFor('window.__app.S.diff && window.__app.S.diff.stats.changes === 1', 8000, 'compared again with the new left');
      await click('#closeMerge');
    });

    await step('binary files are compared by hash: "differ" and "identical"', async () => {
      openReturn = [binA]; await click('#openL');
      openReturn = [binB]; await click('#openR');
      await waitFor('!document.getElementById("binary").hidden');
      eq(await text('#binary .big'), 'Binary files differ', 'differ');
      openReturn = [binC]; await click('#openR');
      await waitFor('document.querySelector("#binary .big").textContent === "Binary files are identical"');
      eq(await js('document.getElementById("patch").disabled'), true, 'no patch for binary files');
    });

    await step('100,000-line files: the diff runs in the worker, the page stays responsive and only draws what is on screen', async () => {
      const t0 = Date.now();
      await js(`window.td.loadFile("left", ${JSON.stringify(bigL)}).then((r) => window.__app.setSide("left", r))`);
      await js(`window.td.loadFile("right", ${JSON.stringify(bigR)}).then((r) => { window.__app.setSide("right", r); window.__app.compare(); })`);
      // while the worker diffs, the page must answer quickly
      const ping0 = Date.now(); await js('1'); const ping = Date.now() - ping0;
      await waitFor('window.__app.S.diff && window.__app.S.diff.linesA === 100000 && document.getElementById("busy").hidden', 60000, 'big diff');
      const total = Date.now() - t0;
      notes.bigDiffMs = total; notes.pingMs = ping;
      assert(ping < 500, 'page answered in ' + ping + ' ms');
      const stats = await js('window.__app.S.diff.stats');
      eq(stats.changes, 401, 'changes'); eq(stats.added, 1, 'added');
      const domRows = await js('document.querySelectorAll("#paneL .ln").length');
      assert(domRows < 150, 'virtualised: ' + domRows + ' rows in the page');
      // jump to the last change, then scroll to the very end
      await js('window.__app.goTo(400)');
      eq(await text('#pos'), '401 / 401', 'last change');
      await js('document.getElementById("paneL").scrollTop = 1e9');
      await sleep(150);
      const lastNo = await js('Math.max(...[...document.querySelectorAll("#paneL .ln .no")].map((n) => +n.textContent || 0))');
      eq(lastNo, 100000, 'last line drawn');
      eq(await js('document.getElementById("paneR").scrollTop === document.getElementById("paneL").scrollTop'), true, 'scrolling together');
      await shot('3-big');
      return `${total} ms to load and diff, page answered in ${ping} ms`;
    });

    // ---- folders ----------------------------------------------------------------------------------------------------------
    const L = path.join(dir, 'Project A'); const R = path.join(dir, 'Project B');
    const put = (side, rel, data, t) => { const p = path.join(side, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, data); if (t) fs.utimesSync(p, t, t); };
    const t0 = Date.UTC(2024, 4, 1) / 1000;
    put(L, 'readme.md', '# Notes\nfirst\n', t0); put(R, 'readme.md', '# Notes\nsecond\n', t0 + 60);
    put(L, 'same.txt', 'same', t0); put(R, 'same.txt', 'same', t0);
    put(L, 'src/app.js', 'let a = 1;\n', t0); put(R, 'src/app.js', 'let a = 1;\n', t0);
    put(L, 'src/new.js', 'new\n', t0);
    put(R, 'docs/only-right.txt', 'r', t0);
    put(L, 'node_modules/x/index.js', 'x', t0);

    await step('folder mode (real clicks): choose two folders, compare, see what differs; ignored folders are skipped', async () => {
      await click('#tabFolders');
      eq(await js('document.getElementById("folderMode").hidden'), false, 'folder mode');
      openReturn = [L]; await click('#fpickL');
      openReturn = [R]; await click('#fpickR');
      await waitFor('!document.getElementById("fcompare").disabled');
      await click('#fcompare');
      await waitFor('!!window.__app.S.folder.result && !window.__app.S.folder.busy', 10000, 'folder result');
      const c = await js('window.__app.S.folder.result.counts');
      eq(JSON.stringify(c), JSON.stringify({ same: 2, different: 1, left: 1, right: 1, error: 0 }), 'counts');
      const names = await js('[...document.querySelectorAll("#frows .frow .nm")].map((n) => n.textContent)');
      assert(!names.includes('node_modules'), 'ignored');
      assert(names.includes('readme.md') && names.includes('new.js') && names.includes('only-right.txt') && !names.includes('same.txt'), 'shown: ' + names);
      await click('#filters input[data-f="same"]');
      const names2 = await js('[...document.querySelectorAll("#frows .frow .nm")].map((n) => n.textContent)');
      assert(names2.includes('same.txt'), 'same files shown when ticked: ' + names2);
      await shot('4-folders');
    });

    await step('double-clicking a different file opens the pair in the text view', async () => {
      const i = await js('window.__app.S.folder.result.entries.findIndex((e) => e.rel === "readme.md")');
      await dblclick(`#frows .frow[data-i="${i}"] .nm`);
      await waitFor('window.__app.S.tab === "text" && window.__app.S.diff && window.__app.S.side.left.name === "readme.md"', 8000, 'pair opened');
      eq(await js('window.__app.S.diff.stats.changes'), 1, 'one change');
      await click('#tabFolders');
    });

    await step('copy to the right (real clicks): asks first, copies the missing file, replaces the different one via the Recycle Bin', async () => {
      const iNew = await js('window.__app.S.folder.result.entries.findIndex((e) => e.rel === "src/new.js")');
      const iReadme = await js('window.__app.S.folder.result.entries.findIndex((e) => e.rel === "readme.md")');
      await click(`#frows .frow[data-i="${iNew}"] .meta.c-l`); // a plain click selects just this row
      await click(`#frows .frow[data-i="${iReadme}"] input[type=checkbox]`);
      eq(await text('#fsel'), '2 items selected', 'selection');
      eq(await js('document.getElementById("copyLR").disabled'), false, 'copy enabled');
      boxAnswer = 1;
      await click('#copyLR');
      await sleep(300);
      assert(/Copy 2 files to the right/.test(boxes[boxes.length - 1].message) && /1 file on the right will be replaced/.test(boxes[boxes.length - 1].detail), 'the question says what will happen');
      assert(!fs.existsSync(path.join(R, 'src/new.js')), 'cancel copies nothing');
      boxAnswer = 0;
      await click('#copyLR');
      await waitFor('window.__app.S.folder.result && window.__app.S.folder.result.counts.left === 0 && !window.__app.S.folder.busy', 10000, 'compared again');
      eq(fs.readFileSync(path.join(R, 'src/new.js'), 'utf8'), 'new\n', 'copied');
      eq(fs.readFileSync(path.join(R, 'readme.md'), 'utf8'), '# Notes\nfirst\n', 'replaced');
      eq(JSON.stringify(trashed), JSON.stringify([path.join(R, 'readme.md')]), 'the old file went to the Recycle Bin');
      assert(fs.existsSync(path.join(R, 'docs/only-right.txt')), 'nothing removed on the right');
      const c = await js('window.__app.S.folder.result.counts');
      eq(c.different, 0, 'no differences left'); eq(c.right, 1, 'only-right file still there');
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
