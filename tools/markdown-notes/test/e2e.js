'use strict';
// End-to-end test: runs inside Electron (`npm run e2e`). Drives the REAL window with real mouse and keyboard input on an
// invented notes folder, and checks both what the window shows and what ends up on disk.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { clipboard, nativeImage } = require('electron');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const { makePng } = require('../src/testpng');
const PNG = makePng(3, 2); // an invented 3x2 red picture

exports.run = async ({ app, getWin, outFile, shotsDir, dialog, main }) => {
  const results = [];
  const errors = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'markdown-notes-e2e-'));
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
  const waitFor = async (expr, ms = 8000, what = expr) => {
    const end = Date.now() + ms;
    for (;;) { const v = await js(expr); if (v) return v; if (Date.now() > end) throw new Error('timed out waiting for ' + what); await sleep(50); }
  };
  const waitDisk = async (fn, ms = 8000, what = 'the file') => { const end = Date.now() + ms; for (;;) { let v = false; try { v = fn(); } catch { /* not yet */ } if (v) return v; if (Date.now() > end) throw new Error('timed out waiting for ' + what); await sleep(60); } };
  const shot = async (name) => { if (!shotsDir) return; fs.mkdirSync(shotsDir, { recursive: true }); await sleep(250); fs.writeFileSync(path.join(shotsDir, name + '.png'), (await wc.capturePage()).toPNG()); };
  const key = async (keyCode, modifiers = [], char = false) => {
    wc.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
    if (char) wc.sendInputEvent({ type: 'char', keyCode: char === true ? keyCode : char, modifiers });
    wc.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
    await sleep(25);
  };
  const typeText = async (text) => { for (const ch of text) { if (ch === '\n') await key('Return', [], '\r'); else await key(ch, [], true); } };
  const center = (selector) => js(`(()=>{const e=document.querySelector(${JSON.stringify(selector)}); if(!e) return null; e.scrollIntoView({block:'nearest'}); const b=e.getBoundingClientRect(); if(!b.width) return null; return {x:Math.round(b.x+b.width/2), y:Math.round(b.y+b.height/2)};})()`);
  const clickAt = async (x, y, button = 'left') => {
    wc.sendInputEvent({ type: 'mouseMove', x, y });
    wc.sendInputEvent({ type: 'mouseDown', x, y, button, clickCount: 1 });
    wc.sendInputEvent({ type: 'mouseUp', x, y, button, clickCount: 1 });
    await sleep(120);
  };
  const click = async (selector, button = 'left') => { const r = await center(selector); if (!r) throw new Error('nothing to click: ' + selector); await clickAt(r.x, r.y, button); };
  const clickText = async (selector, text, button = 'left') => {
    const sel = await js(`(()=>{const all=[...document.querySelectorAll(${JSON.stringify(selector)})]; const i=all.findIndex(e=>e.textContent.trim()===${JSON.stringify(text)} || e.textContent.includes(${JSON.stringify(text)})); if(i<0) return null; document.querySelectorAll('[data-e2e]').forEach(e=>e.removeAttribute('data-e2e')); all[i].setAttribute('data-e2e','1'); return true;})()`);
    if (!sel) throw new Error(`nothing to click: ${selector} "${text}"`);
    await click('[data-e2e="1"]', button);
  };
  const S = (expr) => js(`window.__app.S.${expr}`);
  const editorText = () => js('window.__app.ed.getText()');
  const focusEditorEnd = async () => {
    const r = await js('(()=>{const b=window.__app.ed.view.contentDOM.getBoundingClientRect(); return {x:Math.round(b.x+40), y:Math.round(b.y+30)};})()');
    await clickAt(r.x, r.y); await key('End', ['control']);
  };

  try {
    win.setContentSize(1240, 800);
    // ---- fixtures: an invented notes folder ----
    const notes = path.join(dir, 'My Notes');
    const P = (...p) => path.join(notes, ...p);
    fs.mkdirSync(P('Projects', 'attachments'), { recursive: true });
    fs.mkdirSync(P('Journal'), { recursive: true });
    fs.mkdirSync(P('.hidden'), { recursive: true });
    fs.writeFileSync(P('Projects', 'attachments', 'red dot.png'), PNG);
    fs.writeFileSync(P('Welcome.md'), [
      '---', 'title: Welcome', 'tags: [start]', '---',
      '# Welcome', '', 'Plans live in [[Ideas]]; the [[Not written yet]] note does not exist.', '', 'Lantern festival is in #autumn.', '',
      '- [ ] water the plants', '- [x] buy paper', '',
      '<img src="nope.png" onerror="window.__pwned=1"><script>window.__pwned=2</script>', '<a href="javascript:window.__pwned=3">bad link</a>', '',
    ].join('\n'));
    fs.writeFileSync(P('Projects', 'Ideas.md'), '# Ideas\n\nA lamp made of paper. ![red dot](attachments/red%20dot.png)\n\n## Later\n\nMore #autumn things.\n');
    fs.writeFileSync(P('Projects', 'Old plan.md'), '# Old plan\n\nNothing here.\n');
    fs.writeFileSync(P('Journal', 'Café ☕ notes.md'), '# Café ☕ notes\n\nA quiet morning with crème brûlée.\n');
    fs.writeFileSync(P('.hidden', 'secret.md'), 'hidden notes are skipped');
    fs.writeFileSync(P('readme.txt'), 'not a note');
    const fakeTrash = path.join(dir, 'Trash');
    main.setTrash(fakeTrash);
    let folderReturn = notes; let saveTo = null;
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folderReturn] });
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: saveTo });

    await step('first start: a welcome screen asks for a notes folder', async () => {
      await waitFor('!!window.__app');
      await waitFor('!document.getElementById("welcome").hidden', 5000, 'welcome');
      eq(await js('document.getElementById("workspace").hidden'), true, 'workspace hidden');
      await shot('1-welcome');
    });

    await step('Choose notes folder (real click) lists the notes and folders, skipping hidden folders and non-notes', async () => {
      await click('#pickFolder');
      await waitFor('!document.getElementById("workspace").hidden', 8000, 'workspace');
      const f = await S('folder');
      eq(JSON.stringify(f.notes), JSON.stringify(['Journal/Café ☕ notes.md', 'Projects/Ideas.md', 'Projects/Old plan.md', 'Welcome.md']), 'notes');
      assert(!f.dirs.includes('Projects/attachments'), 'attachments folder hidden');
      const tags = await js('[...document.querySelectorAll("#tags .tag")].map(t=>t.firstChild.textContent)');
      eq(JSON.stringify(tags), JSON.stringify(['#autumn', '#start']), 'tag list (most used first)');
      const top = await js('[...document.querySelectorAll("#tree > .node .name")].map(e=>e.textContent)');
      eq(JSON.stringify(top), JSON.stringify(['Journal', 'Projects', 'Welcome']), 'tree top level: folders first');
    });

    await step('clicking a note opens it: editor, preview, word count; the malicious HTML in it does nothing', async () => {
      await clickText('#tree .node.file', 'Welcome');
      await waitFor('window.__app.S.rel === "Welcome.md"');
      await waitFor('document.querySelector("#preview h1") && document.querySelector("#preview h1").textContent === "Welcome"', 5000, 'preview heading');
      assert((await editorText()).startsWith('---\ntitle: Welcome'), 'editor text');
      eq(await js('window.__pwned'), undefined, 'no script ran');
      eq(await js('document.querySelectorAll("#preview script, #preview [onerror], #preview [onclick], #preview a[href^=\\"javascript\\"]").length'), 0, 'nothing dangerous in the preview');
      assert(/\d+ words/.test(await js('document.getElementById("words").textContent')), 'word count shown');
      eq(await js('document.querySelector("#preview a.wikilink.missing").dataset.wiki'), 'Not written yet', 'missing wiki link drawn as missing');
      await shot('2-open');
    });

    await step('typing in the editor (real keys) autosaves to the file, atomically', async () => {
      await focusEditorEnd();
      await typeText('\nA new line, typed — with ünïcode.');
      await waitFor('document.getElementById("saveState").textContent === "Saved"', 6000, 'saved');
      const disk = fs.readFileSync(P('Welcome.md'), 'utf8');
      assert(disk.endsWith('A new line, typed — with ünïcode.'), 'on disk: ' + JSON.stringify(disk.slice(-60)));
      eq(fs.readdirSync(notes).filter((n) => n.endsWith('.part')).length, 0, 'no .part file left');
    });

    await step('ticking a task in the preview changes the Markdown and saves it', async () => {
      await click('#preview input.task:not([checked])');
      await waitFor('window.__app.ed.getText().includes("- [x] water the plants")', 3000, 'editor changed');
      await waitDisk(() => fs.readFileSync(P('Welcome.md'), 'utf8').includes('- [x] water the plants'), 6000, 'task saved');
    });

    await step('Ctrl+B makes the selection bold; Ctrl+Z undoes it', async () => {
      await focusEditorEnd();
      await key('Home', ['shift']);
      await key('B', ['control']);
      assert((await editorText()).endsWith('**A new line, typed — with ünïcode.**'), 'bold');
      await key('Z', ['control']);
      assert((await editorText()).endsWith('\nA new line, typed — with ünïcode.'), 'undone');
    });

    await step('search finds notes as you type (accents ignored), shows the hit, and opens it', async () => {
      await click('#q');
      await typeText('creme');
      await waitFor('document.querySelectorAll("#results .it").length === 1', 4000, 'one result');
      eq(await js('document.querySelector("#results .it .t").textContent'), 'Café ☕ notes', 'result title');
      assert(await js('!!document.querySelector("#results .it mark")'), 'match highlighted');
      await click('#results .it');
      await waitFor('window.__app.S.rel === "Journal/Café ☕ notes.md"');
      await click('#q'); await key('A', ['control']); await key('Backspace');
      await waitFor('document.getElementById("results").hidden');
    });

    await step('a tag filters the notes; clearing it shows the tree again', async () => {
      await clickText('#tags .tag', '#autumn');
      await waitFor('document.querySelectorAll("#results .it").length === 2', 4000, 'two notes tagged #autumn');
      await click('#tagClear');
      await waitFor('!document.getElementById("browse").hidden');
    });

    await step('a [[wiki link]] opens the note; a link to a missing note creates it next to the linking note', async () => {
      await clickText('#tree .node.file', 'Welcome');
      await waitFor('window.__app.S.rel === "Welcome.md" && !!document.querySelector("#preview a.wikilink")');
      await click('#preview a.wikilink:not(.missing)');
      await waitFor('window.__app.S.rel === "Projects/Ideas.md"');
      await waitFor('(()=>{const i=document.querySelector("#preview img"); return i && i.complete && i.naturalWidth === 3;})()', 5000, 'the picture loads through the notes protocol');
      assert((await js('document.querySelector("#preview img").src')).startsWith('notefile://root/Projects/attachments/red%20dot.png'), 'notes protocol URL');
      eq(await js('document.getElementById("backlinks").textContent'), 'Linked from: Welcome', 'backlinks');
      await clickText('#tree .node.file', 'Welcome');
      await waitFor('window.__app.S.rel === "Welcome.md" && !!document.querySelector("#preview a.wikilink.missing")');
      await click('#preview a.wikilink.missing');
      await waitFor('window.__app.S.rel === "Not written yet.md"');
      eq(fs.readFileSync(P('Not written yet.md'), 'utf8'), '# Not written yet\n\n', 'new note on disk');
    });

    await step('a change made in another program reloads the open note when nothing is unsaved', async () => {
      fs.writeFileSync(P('Not written yet.md'), '# Not written yet\n\nWritten by another program.\n');
      await waitFor('window.__app.ed.getText().includes("Written by another program.")', 6000, 'reloaded');
      await waitFor('document.querySelector("#preview").textContent.includes("Written by another program.")', 3000, 'preview reloaded');
    });

    await step('a change elsewhere while you are typing is a conflict: nothing is overwritten until you choose', async () => {
      await focusEditorEnd();
      await typeText('Mine.');
      fs.writeFileSync(P('Not written yet.md'), '# Not written yet\n\nTheirs.\n');
      await waitFor('!document.getElementById("banner").hidden && /changed in another program/.test(document.getElementById("bannerText").textContent)', 8000, 'conflict banner');
      eq(fs.readFileSync(P('Not written yet.md'), 'utf8'), '# Not written yet\n\nTheirs.\n', 'the other version is still on disk');
      await shot('3-conflict');
      await clickText('#bannerActions button', 'Keep mine');
      await waitDisk(() => fs.readFileSync(P('Not written yet.md'), 'utf8').endsWith('Mine.'), 5000, 'mine saved');
      eq(await js('document.getElementById("banner").hidden'), true, 'banner gone');
    });

    await step('pasting a picture (Ctrl+V) saves it in attachments/ next to the note and links it', async () => {
      await clickText('#tree .node.file', 'Ideas');
      await waitFor('window.__app.S.rel === "Projects/Ideas.md"');
      clipboard.writeImage(nativeImage.createFromBuffer(PNG));
      await focusEditorEnd();
      await key('Return', [], '\r');
      await key('V', ['control']);
      await waitFor('/!\\[Pasted image [^\\]]+\\]\\(attachments\\/Pasted%20image%20[^)]+\\.png\\)/.test(window.__app.ed.getText())', 5000, 'link inserted');
      const pasted = fs.readdirSync(P('Projects', 'attachments')).filter((n) => n.startsWith('Pasted image'));
      eq(pasted.length, 1, 'one pasted picture');
      assert(fs.readFileSync(P('Projects', 'attachments', pasted[0])).slice(1, 4).toString() === 'PNG', 'a PNG');
      await waitFor('[...document.querySelectorAll("#preview img")].length === 2 && [...document.querySelectorAll("#preview img")].every(i=>i.complete && i.naturalWidth > 0)', 5000, 'both pictures show');
      await waitDisk(() => fs.readFileSync(P('Projects', 'Ideas.md'), 'utf8').includes('Pasted%20image'), 5000, 'saved');
      return pasted[0];
    });

    await step('New note (button, then the name dialog) creates the file and opens it', async () => {
      await click('#newNote');
      await waitFor('document.getElementById("dlg").open');
      await key('A', ['control']);
      await typeText('Shopping: list?');
      await key('Return', [], '\r');
      await waitFor('/cannot contain/.test(document.getElementById("dlgError").textContent)', 3000, 'bad name refused');
      await key('A', ['control']);
      await typeText('Shopping list');
      await key('Return', [], '\r');
      await waitFor('window.__app.S.rel === "Projects/Shopping list.md"', 5000, 'new note open');
      assert(fs.existsSync(P('Projects', 'Shopping list.md')), 'file exists');
    });

    await step('pin a note: it shows under Pinned and is remembered', async () => {
      await click('#pinBtn');
      await waitFor('[...document.querySelectorAll("#pinned .it")].some(b=>b.textContent==="Shopping list")', 3000, 'pinned');
    });

    await step('rename from the right-click menu: the file is renamed and the open note follows', async () => {
      await clickText('#tree .node.file', 'Shopping list', 'right');
      await waitFor('!document.getElementById("menu").hidden');
      await clickText('#menu button', 'Rename…');
      await waitFor('document.getElementById("dlg").open');
      await key('A', ['control']);
      await typeText('Groceries');
      await key('Return', [], '\r');
      await waitFor('window.__app.S.rel === "Projects/Groceries.md"', 5000, 'renamed');
      assert(fs.existsSync(P('Projects', 'Groceries.md')) && !fs.existsSync(P('Projects', 'Shopping list.md')), 'renamed on disk');
      await waitFor('[...document.querySelectorAll("#pinned .it")].some(b=>b.title==="Projects/Groceries.md")', 3000, 'pin follows the rename');
    });

    await step('Move to… puts the note in another folder', async () => {
      await click('#moreBtn');
      await clickText('#menu button', 'Move to…');
      await waitFor('document.getElementById("dlg").open');
      await js('(()=>{const s=document.getElementById("dlgSelect"); s.value="Journal";})()');
      await click('#dlgOk');
      await waitFor('window.__app.S.rel === "Journal/Groceries.md"', 5000, 'moved');
      assert(fs.existsSync(P('Journal', 'Groceries.md')), 'moved on disk');
    });

    await step('delete goes to the Recycle Bin after asking, never deleted for good', async () => {
      await clickText('#tree .node.file', 'Old plan', 'right');
      await clickText('#menu button', 'Move to Recycle Bin…');
      await waitFor('document.getElementById("dlg").open');
      assert(/Recycle Bin/.test(await js('document.getElementById("dlgText").textContent')), 'explains');
      await click('#dlgOk');
      await waitDisk(() => !fs.existsSync(P('Projects', 'Old plan.md')), 5000, 'gone from the folder');
      assert(fs.readdirSync(fakeTrash).some((n) => n.endsWith('Old plan.md')), 'in the bin');
      await waitFor('![...document.querySelectorAll("#tree .node.file")].some(b=>b.textContent.includes("Old plan"))', 3000, 'gone from the tree');
    });

    await step('Edit / Split / Preview views', async () => {
      await clickText('.seg .mode', 'Preview');
      eq(await js('getComputedStyle(document.getElementById("editor")).display'), 'none', 'editor hidden');
      await clickText('.seg .mode', 'Edit');
      eq(await js('getComputedStyle(document.getElementById("previewWrap")).display'), 'none', 'preview hidden');
      await clickText('.seg .mode', 'Split');
      eq(await js('getComputedStyle(document.getElementById("previewWrap")).display'), 'block', 'both');
    });

    const outDir = path.join(dir, 'exports');
    fs.mkdirSync(outDir);
    const exportVia = async (label, file) => {
      saveTo = path.join(outDir, file);
      await click('#exportBtn');
      await clickText('#menu button', label);
      await waitFor('/Exported/.test(document.getElementById("result").textContent)', 30000, 'exported ' + file);
      await js('document.getElementById("result").textContent = ""');
      return fs.readFileSync(saveTo);
    };
    await step('export to HTML: one self-contained file, pictures inlined, no scripts', async () => {
      await clickText('#tree .node.file', 'Ideas');
      await waitFor('window.__app.S.rel === "Projects/Ideas.md"');
      const html = (await exportVia('HTML page', 'Ideas.html')).toString('utf8');
      assert(/<h1[^>]*>Ideas<\/h1>/.test(html), 'heading');
      eq((html.match(/<img src="data:image\/png;base64,/g) || []).length, 2, 'both pictures inlined');
      assert(!/<script/i.test(html) && !/notefile:/.test(html), 'no scripts, no app links');
      assert(await js('!document.getElementById("result").hidden'), 'result shown');
    });
    await step('export to PDF and to Word', async () => {
      const pdf = await exportVia('PDF, A4', 'Ideas.pdf');
      eq(pdf.slice(0, 5).toString(), '%PDF-', 'PDF');
      const docx = await exportVia('Word document', 'Ideas.docx');
      const { unzipSync, strFromU8 } = require('fflate');
      const z = unzipSync(new Uint8Array(docx));
      assert(/Ideas/.test(strFromU8(z['word/document.xml'])), 'document.xml has the heading');
      eq(Object.keys(z).filter((k) => k.startsWith('word/media/')).length, 2, 'both pictures in the Word file');
      return `${pdf.length} + ${docx.length} bytes`;
    });

    await step('no errors in the window console (CSP, scripts)', async () => {
      const bad = errors.filter((m) => !/Picture not found|nope\.png/.test(m));
      eq(bad.length, 0, 'console errors: ' + bad.join(' | '));
    });
  } catch (e) {
    results.push({ name: 'harness', ok: false, error: String((e && e.stack) || e) });
  }
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  const ok = results.length > 0 && results.every((r) => r.ok);
  fs.writeFileSync(outFile, JSON.stringify({ ok, results }, null, 2));
  app.exit(ok ? 0 : 1);
};
