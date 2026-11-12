'use strict';
// End-to-end test: runs inside Electron (`npm run e2e`). Drives the REAL window with real mouse and keyboard input:
// create a vault, add and edit entries, reveal and copy, the clipboard clearing, search, trash, lock and unlock, the
// auto-lock (idle and system lock), import, both exports, changing the master password and adding a key file. It checks
// what the page shows AND what is on disk (the vault file decrypted independently, the exports parsed).
const fs = require('fs');
const os = require('os');
const path = require('path');
const F = require('../src/vaultfile');
const T = require('../src/totp');
const C = require('../src/csv');
const { Session } = require('../src/session');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

exports.run = async ({ app, getWin, outFile, shotsDir, dialog, internals }) => {
  const results = [];
  const errors = [];
  const notes = {};
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pwvault-e2e-'));
  const win = getWin();
  const wc = win.webContents;
  const { session, clipboard } = internals;
  const js = (code) => wc.executeJavaScript(code, true);
  wc.on('console-message', (_e, level, msg) => { if (level >= 2) errors.push(msg); });
  const step = async (name, fn) => {
    try { const detail = await fn(); results.push({ name, ok: true, detail: detail === undefined ? '' : detail }); console.log('ok   ' + name); }
    catch (e) { results.push({ name, ok: false, error: String((e && e.message) || e) }); console.log('FAIL ' + name + ': ' + ((e && e.message) || e)); }
  };
  const assert = (c, m) => { if (!c) throw new Error(m); };
  const eq = (a, b, what) => { if (a !== b) throw new Error(`${what}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); };
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
    await sleep(25);
  };
  const typeText = async (text) => { for (const ch of text) await key(ch, [], true); };
  const center = (selector) => js(`(()=>{const e=document.querySelector(${JSON.stringify(selector)}); if(!e || !e.getClientRects().length) return null; e.scrollIntoView({block:'nearest'}); const b=e.getBoundingClientRect(); return {x:Math.round(b.x+b.width/2), y:Math.round(b.y+b.height/2)};})()`);
  const clickAt = async (x, y) => {
    wc.sendInputEvent({ type: 'mouseMove', x, y });
    wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
    wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
    await sleep(120);
  };
  const click = async (selector) => { const r = await center(selector); if (!r) throw new Error('nothing to click: ' + selector); await clickAt(r.x, r.y); };
  const typeInto = async (selector, text) => { await click(selector); await js(`document.querySelector(${JSON.stringify(selector)}).select && document.querySelector(${JSON.stringify(selector)}).select()`); await typeText(text); };
  const setVal = (selector, v) => js(`(()=>{const e=document.querySelector(${JSON.stringify(selector)}); e.value=${JSON.stringify(v)}; e.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  const text = (selector) => js(`(document.querySelector(${JSON.stringify(selector)})||{}).textContent`);
  const visible = (selector) => js(`(()=>{const e=document.querySelector(${JSON.stringify(selector)}); return !!(e && e.getClientRects().length);})()`);
  const bodyText = () => js('document.body.innerText');
  const rowTitles = () => js('[...document.querySelectorAll("#rows li .t")].map((e) => e.textContent)');
  const rowFor = (title) => js(`(()=>{const li=[...document.querySelectorAll('#rows li')].find((l)=>l.querySelector('.t').textContent===${JSON.stringify(title)}); return li ? '#rows li[data-id="'+li.dataset.id+'"]' : null;})()`);
  const decrypt = async (file, pw, kf) => { const s = new Session(); await s.unlock(file, pw, kf ? await F.hashKeyFile(kf) : null); const d = s.data; s.close(); return d; };

  const MASTER = 'Velvet-Comet-Harbor-42';
  const MASTER2 = 'Quiet Lantern Paper Moose 7';
  const vaultFile = path.join(dir, 'Family Vault.pwvault');
  let openReturn = []; let saveReturn = [];
  dialog.showOpenDialog = async () => ({ canceled: !openReturn.length, filePaths: openReturn.length ? [openReturn.shift()] : [] });
  dialog.showSaveDialog = async () => ({ canceled: !saveReturn.length, filePath: saveReturn.length ? saveReturn.shift() : undefined });

  try {
    win.setContentSize(1240, 800);

    await step('the window starts on the welcome screen with nothing open', async () => {
      await waitFor('!!window.__app');
      await waitFor('!document.getElementById("startPane").hidden', 5000, 'start pane');
      eq(await js('document.getElementById("vaultScreen").hidden'), true, 'vault hidden');
      await shot('1-start');
    });

    await step('creating a vault: a short password and a mismatch are refused, then a real one makes the file', async () => {
      await click('#newVault');
      await waitFor('!document.getElementById("createPane").hidden');
      await typeInto('#newPw', 'short');
      await click('#createBtn');
      assert(/at least 8/.test(await text('#createErr')), 'short refused: ' + await text('#createErr'));
      await typeInto('#newPw', MASTER);
      await waitFor('document.getElementById("newMeter").dataset.score >= "3"', 4000, 'strength meter');
      await typeInto('#newPw2', MASTER + 'x');
      await click('#createBtn');
      assert(/not the same/.test(await text('#createErr')), 'mismatch: ' + await text('#createErr'));
      await typeInto('#newPw2', MASTER);
      saveReturn = [path.join(dir, 'Family Vault')]; // without the extension: the app adds it
      await click('#createBtn');
      await waitFor('!document.getElementById("vaultScreen").hidden', 15000, 'vault opened');
      assert(fs.existsSync(vaultFile), 'vault file on disk');
      const raw = fs.readFileSync(vaultFile);
      assert(raw.subarray(0, 8).equals(F.MAGIC), 'magic');
      assert(!raw.includes(Buffer.from(MASTER)), 'no password in the file');
      const p = F.parse(raw);
      assert(p.kdf.m === 65536 && p.kdf.t >= 3, 'real Argon2 settings: ' + JSON.stringify(p.kdf));
      eq(await text('#openName'), 'Family Vault.pwvault', 'vault name shown');
      notes.kdf = p.kdf;
    });

    let mailId = null;
    await step('New entry (real typing): generator fills the password, TOTP secret, folder, tags, a hidden field', async () => {
      await click('#newEntry');
      await waitFor('!!document.getElementById("eTitle")');
      await typeText('Example Mail');
      await typeInto('#eUser', 'ada@example.com');
      await click('#ePwGen');
      await waitFor('document.getElementById("genDlg").open && document.getElementById("genOut").textContent.length === 20', 4000, 'generator');
      const generated = await text('#genOut');
      await click('#genUse');
      await waitFor('!document.getElementById("genDlg").open');
      eq(await js('document.getElementById("ePw").value'), generated, 'password filled');
      await setVal('#eUrls', 'https://mail.example.com\nhttps://example.com/login');
      await setVal('#eFolder', 'Personal/Email');
      await setVal('#eTags', 'mail, important');
      await typeInto('#eTotp', 'JBSWY3DPEHPK3PXP');
      await click('#eAddField');
      await typeText('Recovery PIN');
      await js(`(()=>{const r=document.querySelector('#eFields .cf'); const v=r.querySelectorAll('input')[1]; v.value='8812-4471'; v.dispatchEvent(new Event('input')); const c=r.querySelector('input[type=checkbox]'); c.checked=true; c.dispatchEvent(new Event('change'));})()`);
      await setVal('#eNotes', 'Backup codes are in the blue folder.');
      await shot('2a-editor');
      await click('#eSave');
      await waitFor('!!document.getElementById("dTitle")', 5000, 'detail view');
      eq(await text('#dTitle'), 'Example Mail', 'title');
      const e = session.data.entries.find((x) => x.title === 'Example Mail');
      assert(e && e.password === generated && e.totp.secret === 'JBSWY3DPEHPK3PXP' && e.fields[0].hidden && e.fields[0].value === '8812-4471', 'stored: ' + JSON.stringify(e && { ...e, password: '…' }));
      mailId = e.id;
      const page = await js('document.documentElement.outerHTML');
      for (const [what, v] of [['password', generated], ['hidden field', '8812-4471'], ['TOTP secret', 'JBSWY3DPEHPK3PXP']]) assert(!page.includes(v), `the ${what} is still in the page`);
      assert(/^\d{3} \d{3}$/.test(await text('#dOtp')), 'live code shown: ' + await text('#dOtp'));
      const want = T.codeFor(e.totp).code;
      const shown = (await text('#dOtp')).replace(' ', '');
      const near = [-2500, 0, 2500].map((dt) => T.codeFor(e.totp, Date.now() + dt).code); // the 30 s step may roll over while we look
      assert(near.includes(shown), `code ${shown} vs ${want}`);
      const data = await decrypt(vaultFile, MASTER);
      eq(data.entries.length, 1, 'saved to disk at once');
      assert((await rowTitles()).includes('Example Mail'), 'listed');
      await shot('2-entry');
    });

    await step('Show reveals the password through the main process; Hide puts the dots back', async () => {
      const pw = session.data.entries.find((x) => x.id === mailId).password;
      await click('button[aria-label="Show password"]');
      await waitFor(`document.querySelector('[data-secret="password"]').textContent === ${JSON.stringify(pw)}`, 3000, 'revealed');
      await click('button[aria-label="Show password"]');
      assert(/^•+$/.test(await text('[data-secret="password"]')), 'hidden again');
      await click('button[aria-label="Show Recovery PIN"]');
      eq(await text('[data-secret="field:0"]'), '8812-4471', 'hidden field revealed');
    });

    await step('Copy puts the password on the clipboard and it is cleared after the set time, only if still ours', async () => {
      session.data.settings.clipboardSeconds = 5; // the window offers 10 s and up; 5 keeps the test short
      const pw = session.data.entries.find((x) => x.id === mailId).password;
      await click('[data-copy="password"]');
      eq(clipboard.readText(), pw, 'copied');
      assert(/cleared from the clipboard in 5 s/.test(await text('#toast')), 'toast says when: ' + await text('#toast'));
      await sleep(5600);
      eq(clipboard.readText(), '', 'cleared after 5 s');
      await click('[data-copy="username"]');
      eq(clipboard.readText(), 'ada@example.com', 'user name copied');
      clipboard.writeText('something the user copied later');
      await sleep(5600);
      eq(clipboard.readText(), 'something the user copied later', 'a later copy is left alone');
      await click('[data-copy="totp"]');
      assert(/^\d{6}$/.test(clipboard.readText()), 'code copied');
      session.data.settings.clipboardSeconds = 30;
    });

    await step('Edit: changing the password keeps the old one in the history; an untouched password stays the same', async () => {
      const before = session.data.entries.find((x) => x.id === mailId).password;
      await click('#dEdit');
      await waitFor('!!document.getElementById("ePw")');
      eq(await js('document.getElementById("ePw").value'), '', 'the password is not sent to the form unless asked');
      await setVal('#eNotes', 'Backup codes are in the blue folder. Updated.');
      await click('#eSave');
      await waitFor('!!document.getElementById("dTitle")');
      eq(session.data.entries.find((x) => x.id === mailId).password, before, 'unchanged');
      eq(session.data.entries.find((x) => x.id === mailId).fields[0].value, '8812-4471', 'hidden field kept');
      await click('#dEdit');
      await waitFor('!!document.getElementById("ePw")');
      await typeInto('#ePw', 'Brand-New-Passw0rd!');
      await click('#eSave');
      await waitFor('!!document.querySelector("details.section summary")', 4000, 'history shown');
      assert(/Password history \(1\)/.test(await text('details.section summary')), 'history count');
      await click('details.section summary');
      await click('button[aria-label="Show old password"]');
      eq(await text('[data-secret="history:0"]'), before, 'old password revealed');
    });

    await step('more entries, then search, favourites, folders and tags narrow the list', async () => {
      for (const [title, user, folder, tags] of [['Bank of Example', 'ada.l', 'Finance', 'money'], ['Forum', 'quiet_owl', '', 'social'], ['Router', 'admin', 'Home', '']]) {
        await click('#newEntry');
        await waitFor('!!document.getElementById("eTitle")');
        await typeText(title);
        await setVal('#eUser', user); await setVal('#eFolder', folder); await setVal('#eTags', tags); await setVal('#ePw', 'pw-' + title);
        await click('#eSave');
        await waitFor(`document.getElementById("dTitle") && document.getElementById("dTitle").textContent === ${JSON.stringify(title)}`);
      }
      eq(JSON.stringify(await rowTitles()), JSON.stringify(['Bank of Example', 'Example Mail', 'Forum', 'Router']), 'A to Z');
      await click('#search'); await typeText('owl');
      await waitFor('document.querySelectorAll("#rows li").length === 1', 3000, 'search');
      eq(JSON.stringify(await rowTitles()), '["Forum"]', 'search by user name');
      await js('document.getElementById("search").select()'); await typeText('#money');
      await waitFor('document.querySelectorAll("#rows li").length === 1 && document.querySelector("#rows li .t").textContent === "Bank of Example"', 3000, 'tag search');
      await key('Escape');
      await waitFor('document.querySelectorAll("#rows li").length === 4', 3000, 'search cleared');
      await click(await rowFor('Router'));
      await click('#dFav');
      await click('button.nav[data-view="favorites"]');
      await waitFor('document.querySelectorAll("#rows li").length === 1', 3000, 'favourites');
      await click('button.nav[data-view="folder"][data-name="Personal/Email"]');
      await waitFor('document.querySelectorAll("#rows li").length === 1 && document.querySelector("#rows li .t").textContent === "Example Mail"', 3000, 'folder');
      await click('button.nav[data-view="folder"][data-name="Personal"]');
      await waitFor('document.querySelectorAll("#rows li").length === 1', 3000, 'parent folder includes sub-folders');
      await click('button.nav[data-view="tag"][data-name="social"]');
      await waitFor('document.querySelectorAll("#rows li").length === 1 && document.querySelector("#rows li .t").textContent === "Forum"', 3000, 'tag');
      await click('button.nav[data-view="all"]');
      await waitFor('document.querySelectorAll("#rows li").length === 4');
      await click('#rows li'); // keyboard: arrows move through the list
      await key('Down');
      await waitFor('document.getElementById("dTitle").textContent === "Example Mail"', 3000, 'arrow down');
    });

    await step('trash: move, see it in Trash, restore it, delete another forever', async () => {
      await click(await rowFor('Forum'));
      await click('#dTrash');
      await waitFor('document.querySelectorAll("#rows li").length === 3');
      await click('button.nav[data-view="trash"]');
      await waitFor('document.querySelectorAll("#rows li").length === 1 && !document.getElementById("trashBar").hidden');
      await click('#rows li');
      await click('#dRestore');
      await waitFor('document.querySelectorAll("#rows li").length === 0');
      await click('button.nav[data-view="all"]');
      await waitFor('document.querySelectorAll("#rows li").length === 4');
      await click(await rowFor('Router'));
      await click('#dTrash');
      await click('button.nav[data-view="trash"]');
      await waitFor('document.querySelectorAll("#rows li").length === 1');
      await click('#rows li');
      await click('#dPurge');
      await waitFor('document.getElementById("askDlg").open');
      await click('#askYes');
      await waitFor('document.querySelectorAll("#rows li").length === 0');
      eq(session.data.entries.length, 3, 'deleted for good');
      eq((await decrypt(vaultFile, MASTER)).entries.length, 3, 'on disk too');
      await click('button.nav[data-view="all"]');
    });

    await step('Lock (real click) empties the window; a wrong password is refused; the right one opens it again', async () => {
      await click('#lockBtn');
      await waitFor('!document.getElementById("lockScreen").hidden && !document.getElementById("unlockPane").hidden');
      eq(session.unlocked, false, 'main process forgot the key');
      const page = await bodyText();
      assert(!/Example Mail|Bank of Example/.test(page), 'no entry titles left in the page');
      eq(await text('#vaultName'), 'Family Vault.pwvault', 'remembers which vault');
      await click('#masterPw'); await typeText('Velvet-Comet-Harbor-41');
      await key('Enter', [], '\r');
      await waitFor('/master password is wrong/.test(document.getElementById("unlockErr").textContent)', 8000, 'wrong password message');
      eq(session.unlocked, false, 'still locked');
      await js('document.getElementById("masterPw").select()'); await typeText(MASTER);
      const t0 = Date.now();
      await key('Enter', [], '\r');
      await waitFor('!document.getElementById("vaultScreen").hidden', 10000, 'unlocked');
      notes.unlockMs = Date.now() - t0;
      await waitFor('document.querySelectorAll("#rows li").length === 3', 4000, 'entries back');
    });

    await step('auto-lock after the idle time, and on a system lock (powerMonitor)', async () => {
      internals.setIdle(6 * 60000); // pretend nothing happened for 6 minutes (the default auto-lock is 5)
      await waitFor('!document.getElementById("lockScreen").hidden', 8000, 'idle lock');
      assert(/not used for a while/.test(await text('#lockReason')), 'says why: ' + await text('#lockReason'));
      await click('#masterPw'); await typeText(MASTER); await key('Enter', [], '\r');
      await waitFor('!document.getElementById("vaultScreen").hidden', 10000);
      internals.powerMonitor.emit('lock-screen');
      await waitFor('!document.getElementById("lockScreen").hidden', 3000, 'screen lock');
      assert(/computer was locked/.test(await text('#lockReason')), await text('#lockReason'));
      await click('#masterPw'); await typeText(MASTER); await key('Enter', [], '\r');
      await waitFor('!document.getElementById("vaultScreen").hidden', 10000);
    });

    await step('the TOTP code ticking does not keep the vault awake', async () => {
      await click(await rowFor('Example Mail'));
      await waitFor('!!document.getElementById("dOtp")');
      internals.setIdle(6 * 60000);
      await sleep(2500); // the code refreshes twice meanwhile
      await waitFor('!document.getElementById("lockScreen").hidden', 8000, 'still locks');
      await click('#masterPw'); await typeText(MASTER); await key('Enter', [], '\r');
      await waitFor('!document.getElementById("vaultScreen").hidden', 10000);
    });

    await step('Import CSV (Bitwarden): a preview, then the entries land in their own folder', async () => {
      openReturn = [path.join(__dirname, 'fixtures', 'bitwarden.csv')];
      await click('#moreBtn'); await click('#mImport');
      await waitFor('document.getElementById("impDlg").open', 4000, 'import preview');
      assert(/2 entries found, 1 skipped/.test(await text('#impSummary')), await text('#impSummary'));
      eq(await text('#impTitle'), 'Import from Bitwarden', 'format detected');
      await click('#impGo');
      await waitFor('!document.getElementById("impDlg").open && document.querySelectorAll("#rows li").length === 2', 4000, 'imported');
      assert(/^Imported from Bitwarden/.test(await text('#listTitle')), await text('#listTitle'));
      const shop = session.data.entries.find((e) => e.title === 'Example Shop');
      assert(shop && shop.password === 'Sh0p!ng-2024' && shop.totp && shop.favorite && shop.urls.length === 2, 'imported shop entry');
      await click('button.nav[data-view="all"]');
    });

    await step('Export CSV warns first, needs the tick, then writes a CSV that imports back', async () => {
      await click('#moreBtn'); await click('#mExport');
      await waitFor('document.getElementById("expDlg").open');
      eq(await js('document.getElementById("expGo").disabled'), true, 'disabled until ticked');
      assert(/plain text/.test(await text('#expDlg .notice')), 'big warning');
      await click('#expOk');
      eq(await js('document.getElementById("expGo").disabled'), false, 'enabled');
      const out = path.join(dir, 'export.csv');
      saveReturn = [out];
      await click('#expGo');
      const end = Date.now() + 5000; while (!fs.existsSync(out) && Date.now() < end) await sleep(50);
      const back = C.importCsv(fs.readFileSync(out, 'utf8'));
      eq(back.entries.length, 5, 'all live entries');
      assert(back.entries.find((e) => e.title === 'Example Mail').password === 'Brand-New-Passw0rd!', 'password in the CSV');
      if (process.platform !== 'win32') eq(fs.statSync(out).mode & 0o077, 0, 'only the owner can read it');
    });

    await step('Save encrypted backup writes a copy that opens with the same password', async () => {
      const out = path.join(dir, 'backup copy.pwvault');
      saveReturn = [out];
      await click('#moreBtn'); await click('#mBackup');
      await waitFor('/Encrypted backup saved/.test(document.getElementById("toast").textContent)', 5000);
      eq((await decrypt(out, MASTER)).entries.length, 5, 'backup opens');
    });

    await step('Settings: auto-lock and clipboard time are saved inside the vault', async () => {
      await click('#moreBtn'); await click('#mSettings');
      await waitFor('document.getElementById("setDlg").open');
      assert(/Argon2id · 64 MiB/.test(await text('#kdfInfo')), await text('#kdfInfo'));
      await js('document.getElementById("sLock").value = "15"; document.getElementById("sClip").value = "45";');
      await click('#setSave');
      await waitFor('!document.getElementById("setDlg").open');
      const s = (await decrypt(vaultFile, MASTER)).settings;
      eq(`${s.autoLockMinutes}/${s.clipboardSeconds}`, '15/45', 'saved settings');
    });

    const keyFile = path.join(dir, 'family.key');
    await step('Change master password and add a new key file; the old password stops working, .bak keeps the old one', async () => {
      await click('#moreBtn'); await click('#mMaster');
      await waitFor('document.getElementById("mpDlg").open');
      await typeInto('#mpCur', 'not it');
      await typeInto('#mpNew', MASTER2); await typeInto('#mpNew2', MASTER2);
      saveReturn = [keyFile];
      await click('input[name="mpKf"][value="create"]');
      await waitFor('/New key file saved/.test(document.getElementById("mpKfName").textContent)', 4000, 'key file made');
      assert(fs.existsSync(keyFile) && fs.statSync(keyFile).size === 64, 'key file on disk');
      await click('#mpGo');
      await waitFor('/not right/.test(document.getElementById("mpErr").textContent)', 10000, 'wrong current refused');
      await typeInto('#mpCur', MASTER);
      await click('#mpGo');
      await waitFor('!document.getElementById("mpDlg").open', 15000, 'changed');
      let code = null;
      try { await decrypt(vaultFile, MASTER); } catch (e) { code = e.code; }
      eq(code, 'keyfile-needed', 'old password alone');
      eq((await decrypt(vaultFile, MASTER2, keyFile)).entries.length, 5, 'new password + key file');
      eq((await decrypt(vaultFile + '.bak', MASTER)).entries.length, 5, '.bak is the previous save');
    });

    await step('with a key file, unlocking needs both: without it it is refused, with it it opens', async () => {
      await click('#lockBtn');
      await waitFor('!document.getElementById("unlockPane").hidden && !document.getElementById("kfRow").hidden', 4000, 'key file row');
      await click('#masterPw'); await typeText(MASTER2); await key('Enter', [], '\r');
      await waitFor('/key file/.test(document.getElementById("unlockErr").textContent)', 8000, 'asks for the key file');
      await shot('4-keyfile');
      openReturn = [keyFile];
      await click('#kfPick');
      await waitFor('document.getElementById("kfName").textContent === "family.key"');
      await click('#unlockBtn');
      await waitFor('!document.getElementById("vaultScreen").hidden', 10000, 'opened with both');
    });

    await step('the generator makes passphrases from the word list and copies them', async () => {
      await click('#genOpen');
      await waitFor('document.getElementById("genDlg").open');
      await click('#genDlg .mode[data-kind="passphrase"]');
      await waitFor('document.getElementById("genOut").textContent.split("-").length === 6', 3000, 'six words');
      const words = new Set(require('../src/generator').wordlist());
      const v = await text('#genOut');
      assert(v.split('-').every((w) => words.has(w)), 'real words: ' + v);
      await click('#genCopy');
      eq(clipboard.readText(), v, 'copied');
      await key('Escape');
      await waitFor('!document.getElementById("genDlg").open');
    });

    await step('the window never showed an error, and every control has a name for screen readers', async () => {
      eq(errors.filter((e) => !/Autofill/.test(e)).join(' | '), '', 'console errors');
      const unnamed = await js(`[...document.querySelectorAll('button, input, select, textarea')].filter((e) => e.getClientRects().length && !(e.getAttribute('aria-label') || e.textContent.trim() || (e.labels && e.labels.length) || e.title || e.placeholder)).map((e) => e.outerHTML.slice(0, 80))`);
      eq(JSON.stringify(unnamed), '[]', 'unnamed controls');
      await shot('3-final');
    });
  } finally {
    const ok = results.every((r) => r.ok);
    try { fs.writeFileSync(outFile, JSON.stringify({ ok, results, notes }, null, 2)); } catch (e) { console.log('could not write the report', e); }
    try { internals.lock('quit'); } catch { /* ignore */ }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    app.exit(ok ? 0 : 1);
  }
};
