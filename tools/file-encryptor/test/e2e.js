'use strict';
// End-to-end test: runs inside Electron (`npm run e2e`). Drives the REAL window with real mouse and keyboard input:
// encrypt a file and a folder with unicode names (originals to the Recycle Bin after the check), decrypt them with a
// wrong and then the right password, decrypt again without overwriting, cancel a large job, compute checksums, compare a
// pasted checksum, save a SHA256SUMS file and check it (all OK, then a changed and a missing file).
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const H = require('../src/hashing');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

exports.run = async ({ app, getWin, outFile, shotsDir, dialog, internals, shell }) => {
  const results = [];
  const errors = [];
  const notes = {};
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fenc-e2e-'));
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
    for (;;) { const v = await js(expr); if (v) return v; if (Date.now() > end) throw new Error('timed out waiting for ' + what + ' [result: ' + (await js('document.getElementById("result").textContent + " | toast: " + document.getElementById("toast").textContent + " | status: " + document.getElementById("status").textContent + " | running: " + window.__app.S.running + " | verifyHidden: " + document.getElementById("verify").hidden')) + ']'); await sleep(50); }
  };
  const shot = async (name) => { if (!shotsDir) return; fs.mkdirSync(shotsDir, { recursive: true }); await sleep(300); fs.writeFileSync(path.join(shotsDir, name + '.png'), (await wc.capturePage()).toPNG()); };
  const key = async (keyCode, modifiers = [], char = false) => {
    wc.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
    if (char) wc.sendInputEvent({ type: 'char', keyCode: char === true ? keyCode : char, modifiers });
    wc.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
    await sleep(25);
  };
  const typeText = async (text) => { for (const ch of text) await key(ch, [], true); };
  const center = (selector) => js(`(()=>{const e=document.querySelector(${JSON.stringify(selector)}); if(!e || !e.getClientRects().length) return null; e.scrollIntoView({block:'nearest'}); const b=e.getBoundingClientRect(); return {x:Math.round(b.x+b.width/2), y:Math.round(b.y+b.height/2)};})()`);
  const clickAt = async (x, y) => { wc.sendInputEvent({ type: 'mouseMove', x, y }); wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 }); wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 }); await sleep(120); };
  const click = async (selector) => { const r = await center(selector); if (!r) throw new Error('nothing to click: ' + selector); await clickAt(r.x, r.y); };
  const typeInto = async (selector, text) => { await click(selector); await js(`document.querySelector(${JSON.stringify(selector)}).select()`); await typeText(text); };
  const text = (selector) => js(`(document.querySelector(${JSON.stringify(selector)})||{}).textContent`);
  const rows = () => js('window.__app.S.tabs[window.__app.S.mode].rows.map((r) => ({ name: r.name, status: r.status, error: r.error, output: r.output, digests: r.digests, trashed: r.trashed, verified: r.verified, renamed: r.renamed }))');
  const ls = (d) => fs.readdirSync(d).sort();

  let openReturn = []; let saveReturn = [];
  dialog.showOpenDialog = async () => ({ canceled: !openReturn.length, filePaths: openReturn.splice(0) });
  dialog.showSaveDialog = async () => ({ canceled: !saveReturn.length, filePath: saveReturn.shift() });
  // The Recycle Bin: use the real one (shell.trashItem) and record whether it worked in this environment; if it is not
  // available here, move the item to a test folder so the rest of the flow can still be checked.
  const bin = path.join(dir, 'bin'); fs.mkdirSync(bin);
  internals.trash = async (p) => {
    try { await shell.trashItem(p); notes.realRecycleBin = 'worked'; }
    catch (e) { notes.realRecycleBin = 'not available here: ' + e.message; fs.renameSync(p, path.join(bin, path.basename(p))); }
  };

  const PW = 'Copper-Meadow-Lantern-58';
  const work = path.join(dir, 'work'); fs.mkdirSync(work);
  const fileA = path.join(work, 'Tax return 2025 – final.pdf');
  const dataA = crypto.randomBytes(300000); fs.writeFileSync(fileA, dataA);
  const folder = path.join(work, 'Fotos från sommaren');
  const tree = { 'IMG_0001.jpg': crypto.randomBytes(200000), 'Ünder/日本.txt': Buffer.from('こんにちは'), 'Ünder/deeper/empty.txt': Buffer.alloc(0) };
  for (const [rel, data] of Object.entries(tree)) { fs.mkdirSync(path.dirname(path.join(folder, rel)), { recursive: true }); fs.writeFileSync(path.join(folder, rel), data); }

  try {
    win.setContentSize(1240, 800);
    await step('the window starts on Encrypt with the drop zone and the options', async () => {
      await waitFor('!!window.__app');
      eq(await js('document.getElementById("empty").hidden'), false, 'drop zone');
      eq(await js('document.querySelector(".tabs [aria-selected=true]").dataset.mode'), 'encrypt', 'tab');
      eq(await js('document.getElementById("cryptBar").hidden'), false, 'options');
      await shot('1-start');
    });

    await step('Add files… (real click) lists a file and a folder with their sizes', async () => {
      openReturn = [fileA, folder];
      await click('#addFiles2');
      await waitFor('window.__app.S.tabs.encrypt.rows.length === 2');
      const kinds = await js('[...document.querySelectorAll("#rows .c-kind")].map((e) => e.textContent)');
      eq(JSON.stringify(kinds), JSON.stringify(['File', 'Folder · 3 files']), 'kinds');
    });

    await step('the password is checked: too short, then not repeated the same, then a good one', async () => {
      await typeInto('#pw', 'short');
      await click('#go');
      assert(/at least 8/.test(await text('#toast')), await text('#toast'));
      await typeInto('#pw', PW);
      await typeInto('#pw2', PW + '!');
      await click('#go');
      assert(/not the same/.test(await text('#toast')), await text('#toast'));
      await waitFor('document.getElementById("meter").dataset.score >= "3"', 4000, 'strength meter');
      await typeInto('#pw2', PW);
    });

    await step('Encrypt with "move originals to the Recycle Bin": each .locked file is checked, then the original goes', async () => {
      await click('#del');
      eq(await js('document.getElementById("delWarn").hidden'), false, 'the warning shows');
      assert(/not.*secure deletion/i.test(await text('#delWarn')), 'it says the Recycle Bin is not secure deletion');
      await shot('2-ready');
      await click('#go');
      await waitFor('window.__app.S.tabs.encrypt.rows.every((r) => r.status === "done") && !window.__app.S.running', 30000, 'encrypted');
      const r = await rows();
      assert(r.every((x) => x.verified && x.trashed), 'checked and trashed: ' + JSON.stringify(r));
      eq(JSON.stringify(ls(work)), JSON.stringify(['Fotos från sommaren.locked', 'Tax return 2025 – final.pdf.locked']), 'only the .locked files are left');
      assert(/Encrypted 2 of 2\. 2 originals moved to the Recycle Bin/.test(await text('#result')), await text('#result'));
      eq(await js('document.getElementById("pw").value'), '', 'the password box is cleared afterwards');
      await shot('3-encrypted');
      const raw = fs.readFileSync(path.join(work, 'Tax return 2025 – final.pdf.locked'));
      assert(!raw.includes(Buffer.from('Tax return')), 'the name is not in the clear');
    });

    const out = path.join(dir, 'restored'); fs.mkdirSync(out);
    await step('Decrypt tab: a wrong password is refused for both files and nothing is written', async () => {
      await click('#tab-decrypt');
      openReturn = [work]; // a folder: it is searched for .locked files
      await click('#addFolder2');
      await waitFor('window.__app.S.tabs.decrypt.rows.length === 2');
      eq(await js('document.getElementById("pw2Box").hidden'), true, 'no repeat box when decrypting');
      saveReturn = [];
      openReturn = [out];
      await click('input[name="dest"][value="dir"]');
      await waitFor(`document.getElementById("destDir").textContent === ${JSON.stringify(out)}`, 3000, 'destination folder');
      await typeInto('#pw', 'Copper-Meadow-Lantern-57');
      await click('#go');
      await waitFor('window.__app.S.tabs.decrypt.rows.every((r) => r.status === "error") && !window.__app.S.running', 20000, 'refused');
      assert(/password did not fit/.test(await text('#result')), await text('#result'));
      eq(ls(out).length, 0, 'nothing written');
    });

    await step('the right password brings back the file and the folder tree exactly, with their names', async () => {
      await typeInto('#pw', PW);
      await key('Enter', [], '\r');
      await waitFor('window.__app.S.tabs.decrypt.rows.every((r) => r.status === "done") && !window.__app.S.running', 20000, 'decrypted');
      eq(JSON.stringify(ls(out)), JSON.stringify(['Fotos från sommaren', 'Tax return 2025 – final.pdf']), 'names');
      eq(sha(fs.readFileSync(path.join(out, 'Tax return 2025 – final.pdf'))), sha(dataA), 'file content');
      for (const [rel, data] of Object.entries(tree)) eq(sha(fs.readFileSync(path.join(out, 'Fotos från sommaren', rel))), sha(data), rel);
      await shot('4-decrypted');
    });

    await step('decrypting again never overwrites: the copies get "(2)" names', async () => {
      await js('window.__app.S.tabs.decrypt.rows.forEach((r) => { r.status = "ready"; })');
      await typeInto('#pw', PW);
      await click('#go');
      await waitFor('window.__app.S.tabs.decrypt.rows.every((r) => r.status === "done") && !window.__app.S.running', 20000);
      eq(JSON.stringify(ls(out)), JSON.stringify(['Fotos från sommaren', 'Fotos från sommaren (2)', 'Tax return 2025 – final (2).pdf', 'Tax return 2025 – final.pdf']), 'new names');
      assert((await rows()).every((r) => r.renamed), 'marked as renamed');
    });

    await step('Cancel (real click) stops a large encryption and removes the partial file', async () => {
      await click('#tab-encrypt');
      await click('#clear');
      const big = path.join(dir, 'big'); fs.mkdirSync(big);
      const bigFile = path.join(big, 'disk.img');
      const fh = fs.openSync(bigFile, 'w'); fs.ftruncateSync(fh, 1.5 * 1024 * 1024 * 1024); fs.closeSync(fh);
      openReturn = [bigFile];
      await click('#addFiles2');
      await waitFor('window.__app.S.tabs.encrypt.rows.length === 1');
      await js('document.getElementById("del").checked && document.getElementById("del").click()');
      await typeInto('#pw', PW); await typeInto('#pw2', PW);
      await click('#go');
      await waitFor('!document.getElementById("cancel").hidden && parseFloat(document.getElementById("fill").style.width) > 0', 15000, 'running with progress');
      await click('#cancel');
      await waitFor('!window.__app.S.running', 15000, 'stopped');
      eq((await rows())[0].status, 'skipped', 'row cancelled');
      assert(/Cancelled/.test(await text('#result')), await text('#result'));
      eq(JSON.stringify(ls(big)), '["disk.img"]', 'no .locked or .part left');
      fs.rmSync(big, { recursive: true, force: true });
      await click('#clear');
    });

    const sumsDir = path.join(dir, 'Release 1.0');
    await step('Checksums: a folder is listed file by file and SHA-256 + BLAKE2b are computed on worker threads', async () => {
      fs.mkdirSync(path.join(sumsDir, 'docs'), { recursive: true });
      fs.writeFileSync(path.join(sumsDir, 'app.zip'), crypto.randomBytes(2 * 1024 * 1024));
      fs.writeFileSync(path.join(sumsDir, 'docs', 'read me.txt'), 'abc');
      fs.writeFileSync(path.join(sumsDir, 'notes.md'), '');
      await click('#tab-hash');
      eq(await js('document.getElementById("hashBar").hidden'), false, 'checksum options');
      openReturn = [sumsDir];
      await click('#addFolder2');
      await waitFor('window.__app.S.tabs.hash.rows.length === 3');
      await js('for (const c of document.querySelectorAll(".alg")) c.checked = c.value === "sha256"');
      await click('input.alg[value="blake2b"]');
      await click('#hashGo');
      await waitFor('window.__app.S.tabs.hash.rows.every((r) => r.status === "done") && !window.__app.S.running', 20000, 'hashed');
      const r = await rows();
      const readme = r.find((x) => x.name === 'read me.txt');
      eq(readme.digests.sha256, 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad', 'sha256(abc)');
      assert(readme.digests.blake2b.startsWith('ba80a53f981c4d0d'), 'blake2b(abc)');
      eq(r.find((x) => x.name === 'app.zip').digests.sha256, sha(fs.readFileSync(path.join(sumsDir, 'app.zip'))), 'app.zip');
    });

    await step('Compare with a pasted checksum: a match is shown, a wrong one is not; 128 digits computes SHA-512 too', async () => {
      const want = sha(fs.readFileSync(path.join(sumsDir, 'app.zip')));
      await click('#compare'); await typeText(want.toUpperCase());
      await waitFor('/✓ Match: Release 1.0\\/app.zip/.test(document.getElementById("result").textContent)', 5000, 'match');
      eq(await js('document.querySelectorAll("tr.matchrow").length'), 1, 'one row highlighted');
      assert(/SHA-256/.test(await text('#compareInfo')), await text('#compareInfo'));
      await shot('5-compare');
      await js('document.getElementById("compare").select()'); await typeText('0'.repeat(64));
      await waitFor('/No match/.test(document.getElementById("result").textContent)', 5000, 'no match');
      const sha512 = crypto.createHash('sha512').update('abc').digest('hex');
      await js('document.getElementById("compare").select()'); await typeText(sha512);
      await waitFor('/✓ Match: Release 1.0\\/docs\\/read me.txt/.test(document.getElementById("result").textContent)', 15000, 'sha512 computed and matched');
      await js('document.getElementById("compare").value = ""; document.getElementById("compare").dispatchEvent(new Event("input"))');
    });

    await step('Save checksum file writes SHA256SUMS with relative names that sha256sum would accept', async () => {
      await js('document.getElementById("sumAlg").value = "sha256"; document.getElementById("sumFmt").value = "gnu"');
      saveReturn = [path.join(sumsDir, 'SHA256SUMS')];
      await click('#saveSums');
      await waitFor('/Saved 3 checksums to SHA256SUMS/.test(document.getElementById("result").textContent)', 5000, 'saved');
      const lines = fs.readFileSync(path.join(sumsDir, 'SHA256SUMS'), 'utf8').trim().split('\n');
      eq(JSON.stringify(lines.map((l) => l.slice(66))), JSON.stringify(['app.zip', 'docs/read me.txt', 'notes.md']), 'relative names');
      assert(lines.every((l) => /^[0-9a-f]{64} \*/.test(l)), 'GNU format');
    });

    await step('Check a checksum file: all match; then a changed file and a missing file are reported', async () => {
      openReturn = [path.join(sumsDir, 'SHA256SUMS')];
      await click('#verifyFile');
      await waitFor('!document.getElementById("verify").hidden && /all 3 files match/.test(document.getElementById("result").textContent)', 15000, 'all ok');
      await shot('6-verify');
      fs.writeFileSync(path.join(sumsDir, 'notes.md'), 'changed');
      fs.rmSync(path.join(sumsDir, 'docs', 'read me.txt'));
      await click('#verifyBack');
      openReturn = [path.join(sumsDir, 'SHA256SUMS')];
      await click('#verifyFile');
      await waitFor('/2 of 3 files did not check out/.test(document.getElementById("result").textContent)', 15000, 'problems found');
      eq(await text('#verifySummary'), '1 OK · 1 different · 1 missing', 'summary');
      const res = await js('[...document.querySelectorAll("#vrows tr")].map((t) => t.lastChild.textContent)');
      assert(/OK/.test(res[0]) && /File not found/.test(res[1]) && /NOT match/.test(res[2]), JSON.stringify(res));
      // a BSD-format file is read too
      const bsd = path.join(sumsDir, 'CHECKSUMS.md5');
      fs.writeFileSync(bsd, `MD5 (app.zip) = ${crypto.createHash('md5').update(fs.readFileSync(path.join(sumsDir, 'app.zip'))).digest('hex')}\n`);
      await click('#verifyBack');
      openReturn = [bsd];
      await click('#verifyFile');
      await waitFor('/all 1 file match/.test(document.getElementById("result").textContent)', 15000, 'bsd ok');
      await click('#verifyBack');
    });

    await step('the window never showed an error and every control has a name for screen readers', async () => {
      eq(errors.filter((e) => !/Autofill/.test(e)).join(' | '), '', 'console errors');
      for (const m of ['encrypt', 'decrypt', 'hash']) {
        await click('#tab-' + m);
        const unnamed = await js(`[...document.querySelectorAll('button, input, select')].filter((e) => e.getClientRects().length && !(e.getAttribute('aria-label') || e.textContent.trim() || (e.labels && e.labels.length) || e.title || e.placeholder)).map((e) => e.outerHTML.slice(0, 80))`);
        eq(JSON.stringify(unnamed), '[]', 'unnamed controls on ' + m);
      }
    });
  } finally {
    const ok = results.every((r) => r.ok);
    try { fs.writeFileSync(outFile, JSON.stringify({ ok, results, notes }, null, 2)); } catch (e) { console.log('could not write the report', e); }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    app.exit(ok ? 0 : 1);
  }
};
