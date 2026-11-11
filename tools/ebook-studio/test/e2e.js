'use strict';
// End-to-end test: runs inside Electron (`npm run e2e`). Drives the REAL window with real mouse and keyboard input on
// invented books, and checks what the window shows and what is written to disk.
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const E = require('../src/epub');
const S = require('../src/samples');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const md5 = (f) => crypto.createHash('md5').update(fs.readFileSync(f)).digest('hex');

exports.run = async ({ app, getWin, outFile, shotsDir, dialog }) => {
  const results = [];
  const errors = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ebook-studio-e2e-'));
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
  const waitFor = async (expr, ms = 8000, what = expr) => { const end = Date.now() + ms; for (;;) { const v = await js(expr); if (v) return v; if (Date.now() > end) throw new Error('timed out waiting for ' + what); await sleep(50); } };
  const shot = async (name) => { if (!shotsDir) return; fs.mkdirSync(shotsDir, { recursive: true }); await sleep(250); fs.writeFileSync(path.join(shotsDir, name + '.png'), (await wc.capturePage()).toPNG()); };
  const key = async (keyCode, modifiers = [], char = false) => {
    wc.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
    if (char) wc.sendInputEvent({ type: 'char', keyCode: char === true ? keyCode : char, modifiers });
    wc.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
    await sleep(40);
  };
  const typeText = async (text) => { for (const ch of text) await key(ch, [], true); };
  const clickAt = async (x, y) => { wc.sendInputEvent({ type: 'mouseMove', x, y }); wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 }); wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 }); await sleep(120); };
  const center = (selector) => js(`(()=>{const e=document.querySelector(${JSON.stringify(selector)}); if(!e) return null; e.scrollIntoView({block:'nearest'}); const b=e.getBoundingClientRect(); if(!b.width) return null; return {x:Math.round(b.x+b.width/2), y:Math.round(b.y+b.height/2)};})()`);
  const click = async (selector) => { const r = await center(selector); if (!r) throw new Error('nothing to click: ' + selector); await clickAt(r.x, r.y); };
  const clickText = async (selector, text) => {
    const ok = await js(`(()=>{document.querySelectorAll('[data-e2e]').forEach(e=>e.removeAttribute('data-e2e')); const e=[...document.querySelectorAll(${JSON.stringify(selector)})].find(e=>e.textContent.includes(${JSON.stringify(text)})); if(!e) return false; e.setAttribute('data-e2e','1'); return true;})()`);
    if (!ok) throw new Error(`nothing to click: ${selector} "${text}"`);
    await click('[data-e2e="1"]');
  };
  // an element inside the reading frame, in window coordinates
  const clickInFrame = async (selector) => {
    const r = await js(`(()=>{const f=document.getElementById('frame'); const e=f.contentDocument.querySelector(${JSON.stringify(selector)}); if(!e) return null; const a=f.getBoundingClientRect(); const b=e.getBoundingClientRect(); return {x:Math.round(a.x+b.x+Math.min(b.width/2, 20)), y:Math.round(a.y+b.y+b.height/2), vis: b.x >= 0 && b.x < a.width};})()`);
    if (!r) throw new Error('nothing in the frame: ' + selector);
    if (!r.vis) throw new Error('not on this page: ' + selector);
    await clickAt(r.x, r.y);
  };
  const fr = (expr) => js(`(()=>{const d=document.getElementById('frame').contentDocument; return ${expr};})()`);
  const R = (expr) => js(`window.__app.R.${expr}`);

  try {
    win.setContentSize(1240, 820);
    const books = path.join(dir, 'Books ünï');
    fs.mkdirSync(books);
    const epub = path.join(books, 'Almanac.epub');
    fs.writeFileSync(epub, S.makeEpub2({ chapters: 4 }));
    const epubHash = md5(epub);
    const txt = path.join(books, 'The Small Harbour.txt');
    fs.writeFileSync(txt, S.sampleText());
    const html = path.join(books, 'Notes page.html');
    fs.writeFileSync(path.join(books, 'pic.png'), S.makePng(20, 10));
    fs.writeFileSync(html, '<!doctype html><html lang="en"><head><title>Garden Notes</title><script>window.parent.__pwned=9</script></head><body><h1>Spring</h1><p>Sow peas. <img src="pic.png" alt="pic"></p><h1>Summer</h1><p>Water often.<img src="../../etc/passwd" alt="sneaky"></p><img src="x" onerror="window.parent.__pwned=10"></body></html>');
    const cover = path.join(dir, 'new cover.png');
    fs.writeFileSync(cover, S.coverPng(120, 180, [150, 60, 40]));
    let pick = []; let saveTo = null; let dirPick = null;
    dialog.showOpenDialog = async (_w, o) => ({ canceled: false, filePaths: o && o.properties && o.properties.includes('openDirectory') ? [dirPick] : (o && /cover/i.test(o.title || '') ? [cover] : pick) });
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: saveTo });

    await step('an empty library asks for a book', async () => {
      await waitFor('!!window.__app');
      eq(await js('document.getElementById("libEmpty").hidden'), false, 'empty library');
      await shot('1-empty');
    });

    await step('Open book… (real click) shows the EPUB in the sandboxed frame; nothing in the book runs', async () => {
      pick = [epub];
      await click('#openBook2');
      await waitFor('!document.getElementById("viewReader").hidden', 8000, 'reader');
      await waitFor('(()=>{const d=document.getElementById("frame").contentDocument; return d && d.body && /Winter Light/.test(d.body.textContent);})()', 8000, 'chapter 1');
      eq(await js('document.getElementById("rTitle").textContent'), 'The Lighthouse Keeper’s Almanac', 'title');
      eq(await js('document.getElementById("frame").getAttribute("sandbox")'), 'allow-same-origin', 'frame sandbox: no scripts');
      eq(await js('window.__pwned'), undefined, 'no script ran');
      eq(await fr('d.querySelectorAll("script, iframe, form, input, style, [onclick], [onerror]").length'), 0, 'nothing active in the page');
      eq(await fr('[...d.querySelectorAll("a[href]")].some(a => /^javascript:/i.test(a.getAttribute("href")))'), false, 'no javascript: links');
      await waitFor('(()=>{const i=document.getElementById("frame").contentDocument.querySelector("img"); return i && i.complete && i.naturalWidth === 60;})()', 5000, 'the picture loads from inside the book (book://)');
      assert(/^book:\/\/[0-9a-f]+\/images\//.test(await fr('d.querySelector("img").src')), 'book protocol');
      assert(/^Page 1 of \d+ · chapter 1 of 4$/.test(await js('document.getElementById("rPage").textContent')), 'page indicator');
      await shot('2-reader');
    });

    await step('keyboard paging: → turns pages and runs into the next chapter, ← goes back to the last page before', async () => {
      const pages = await R('pages');
      assert(pages >= 2, 'more than one page: ' + pages);
      await clickAt(640, 300); // focus the page
      await key('Right');
      await waitFor('window.__app.R.page === 1');
      eq(await fr('d.body.style.transform'), `translateX(-${await fr('d.defaultView.innerWidth')}px)`, 'moved one page');
      for (let i = 1; i < pages; i++) await key('Right');
      await waitFor('window.__app.R.chapter === 1', 4000, 'next chapter');
      await key('Left');
      await waitFor('window.__app.R.chapter === 0 && window.__app.R.page === window.__app.R.pages - 1', 4000, 'last page of chapter 1');
      return `${pages} pages in chapter 1`;
    });

    await step('Contents: clicking a chapter opens it', async () => {
      await click('#tocBtn');
      await waitFor('!document.getElementById("side").hidden');
      await clickText('#toc button', 'Spring Tides');
      await waitFor('window.__app.R.chapter === 2', 5000, 'chapter 3');
      assert(/Spring Tides/.test(await js('document.getElementById("rChapter").textContent')), 'chapter title in the bar');
    });

    await step('a link inside the book jumps to the right chapter and place', async () => {
      await clickText('#toc button', 'Winter Light');
      await waitFor('window.__app.R.chapter === 0');
      // the link is in paragraph 4 of chapter 1, on the first page
      await clickInFrame('a[href^="chapter-002"]');
      await waitFor('window.__app.R.chapter === 1', 5000, 'chapter 2');
    });

    await step('text size, colours and layout change the page and are kept', async () => {
      await click('#aaBtn');
      const before = await R('pages');
      await click('#fsUp'); await click('#fsUp');
      eq(await js('window.__app.prefs.fs'), 120, 'size');
      eq(await fr('d.documentElement.style.getPropertyValue("--fs")'), '120%', 'size applied');
      eq(await fr('getComputedStyle(d.querySelector("p")).fontSize'), '19.2px', 'bigger text');
      assert((await R('pages')) >= before, `pages counted again (${before} -> ${await R('pages')})`);
      await clickText('[data-theme]', 'Sepia');
      assert(/sepia/.test(await fr('d.documentElement.className')), 'sepia');
      eq(await fr('getComputedStyle(d.body).backgroundColor'), 'rgb(244, 236, 216)', 'sepia background');
      await clickText('[data-layout]', 'Scroll');
      await waitFor('/scrolled/.test(document.getElementById("frame").contentDocument.documentElement.className)', 4000, 'scrolled');
      await clickText('[data-layout]', 'Pages');
      await waitFor('/paged/.test(document.getElementById("frame").contentDocument.documentElement.className)', 4000, 'paged again');
      await clickText('[data-theme]', 'Dark');
      await click('#fsDown'); await click('#fsDown');
      await click('#aaBtn');
    });

    await step('search in the book lists every place and shows the one you pick', async () => {
      await click('#findBtn');
      await waitFor('document.activeElement === document.getElementById("findInput")');
      await typeText('beacon');
      await waitFor('document.querySelectorAll("#findResults button").length === 4', 5000, 'four places');
      eq(await js('document.getElementById("findCount").textContent'), '4 places', 'count');
      await clickText('#findResults button', 'Spring Tides');
      await waitFor('window.__app.R.chapter === 2', 5000, 'chapter 3');
      await waitFor('(()=>{const m=document.getElementById("frame").contentDocument.querySelector("mark.hit.current"); if(!m) return false; const r=m.getBoundingClientRect(); return r.x >= 0 && r.x < innerWidth;})()', 4000, 'the hit is marked and on the page');
      await shot('3-search');
      await click('#findBtn');
    });

    await step('the place is remembered: the library shows progress and the book reopens there', async () => {
      await key('Right');
      await sleep(700);
      const where = { chapter: await R('chapter'), page: await R('page') };
      await click('#back');
      await waitFor('!document.getElementById("viewLibrary").hidden && document.querySelectorAll("#libGrid .card").length === 1', 5000, 'library');
      assert(/\d+%/.test(await js('document.querySelector("#libGrid .card .meta").textContent')), 'progress shown');
      await waitFor('(()=>{const i=document.querySelector("#libGrid .card img"); return i && i.complete && i.naturalWidth === 300;})()', 4000, 'cover shown in the library');
      await shot('4-library');
      await click('#libGrid .card');
      await waitFor(`window.__app.R.chapter === ${where.chapter} && window.__app.R.page === ${where.page}`, 6000, 'same place');
      await click('#back');
    });

    await step('a plain text book opens split into chapters', async () => {
      pick = [txt];
      await click('#openBook');
      await waitFor('window.__app.R.book && window.__app.R.book.chapters.length === 4', 6000, 'four chapters');
      eq(await js('JSON.stringify(window.__app.R.book.chapters.map(c=>c.title))'), JSON.stringify(['The Small Harbour', 'CHAPTER I: The Arrival', 'CHAPTER II: Market Day', 'CHAPTER III: The Storm']), 'chapter titles');
      await click('#back');
    });

    await step('an HTML page opens: its script does not run, a picture from outside its folder is not loaded', async () => {
      pick = [html];
      await click('#openBook');
      await waitFor('window.__app.R.book && window.__app.R.book.meta.title === "Garden Notes"', 6000, 'opened');
      eq(await js('window.__app.R.book.chapters.length'), 2, 'split at the two headings');
      eq(await js('window.__pwned'), undefined, 'no script');
      await waitFor('(()=>{const i=document.getElementById("frame").contentDocument.querySelector("img"); return i && i.complete && i.naturalWidth === 20;})()', 4000, 'its own picture loads');
      await click('#next'); await waitFor('window.__app.R.chapter === 1');
      eq(await fr('d.querySelectorAll("img").length'), 0, 'the outside picture is not there');
      assert(/sneaky/.test(await fr('d.body.textContent')), 'its alt text is shown instead');
      await click('#back');
    });

    const out = path.join(dir, 'out');
    fs.mkdirSync(out);
    await step('Convert: an EPUB and a text file to EPUB (real clicks), into a chosen folder', async () => {
      await clickText('.tabs button', 'Convert');
      pick = [epub, txt, path.join(books, 'pic.png')];
      await click('#convAdd');
      await waitFor('document.querySelectorAll("#convList .item").length === 2', 4000, 'two files (the picture is skipped)');
      dirPick = out;
      await click('#outDirBtn');
      await waitFor(`document.getElementById("outDirLabel").textContent === ${JSON.stringify(out)}`);
      await click('#convGo');
      await waitFor('/Converted 2 files/.test(document.getElementById("result").textContent)', 30000, 'done');
      const a = E.readEpub(new Uint8Array(fs.readFileSync(path.join(out, 'Almanac.epub'))));
      eq(a.toc.length, 4, 'chapters in the converted EPUB');
      const t = E.readEpub(new Uint8Array(fs.readFileSync(path.join(out, 'The Small Harbour.epub'))));
      eq(t.meta.authors[0], 'Ada Invented', 'author from the text file');
      eq(E.zipEntries(fs.readFileSync(path.join(out, 'Almanac.epub')))[0].name, 'mimetype', 'mimetype first');
      await shot('5-convert');
    });

    await step('Convert again: nothing is overwritten (a "(2)" name), and PDF / Markdown / text work', async () => {
      await click('#convGo');
      await waitFor('/Converted 2 files/.test(document.getElementById("result").textContent) && !window.__app.CV.running', 30000, 'done again');
      assert(fs.existsSync(path.join(out, 'Almanac (2).epub')), 'Almanac (2).epub');
      await clickText('[data-format]', 'PDF');
      eq(await js('document.getElementById("pageSizeBox").hidden'), false, 'page size shown for PDF');
      await click('#convGo');
      await waitFor('/Converted 2 files/.test(document.getElementById("result").textContent) && !window.__app.CV.running', 60000, 'pdf done');
      eq(fs.readFileSync(path.join(out, 'Almanac.pdf')).slice(0, 5).toString(), '%PDF-', 'PDF');
      await clickText('[data-format]', 'Markdown');
      await click('#convGo');
      await waitFor('/Converted 2 files/.test(document.getElementById("result").textContent) && !window.__app.CV.running', 30000, 'md done');
      assert(/^---\ntitle: "The Lighthouse Keeper’s Almanac"/.test(fs.readFileSync(path.join(out, 'Almanac.md'), 'utf8')), 'markdown front matter');
      assert(fs.readdirSync(path.join(out, 'Almanac images')).length === 1, 'pictures folder');
      eq(md5(epub), epubHash, 'the original EPUB is unchanged');
    });

    await step('Edit details: new title, author and cover go into a NEW EPUB; the original is untouched', async () => {
      await clickText('.tabs button', 'Edit details');
      pick = [epub];
      await click('#detOpen');
      await waitFor('!document.getElementById("detForm").hidden && document.getElementById("fTitle").value === "The Lighthouse Keeper’s Almanac"', 5000, 'form');
      await click('#fTitle'); await key('A', ['control']); await typeText('A Year at the Point');
      await click('#fAuthors'); await key('A', ['control']); await typeText('Mara Invented; Jon Made-Up');
      await click('#coverPick');
      await waitFor('/new cover\\.png/.test(document.getElementById("coverNew").textContent)', 4000, 'cover chosen');
      saveTo = path.join(out, 'Almanac edited.epub');
      await click('#detSave');
      await waitFor('/Saved a new book/.test(document.getElementById("result").textContent)', 8000, 'saved');
      const ep = E.readEpub(new Uint8Array(fs.readFileSync(saveTo)));
      eq(ep.meta.title, 'A Year at the Point', 'title');
      eq(JSON.stringify(ep.meta.authors), JSON.stringify(['Mara Invented', 'Jon Made-Up']), 'authors');
      eq(ep.meta.publisher, 'Imaginary Press', 'other details kept');
      eq(Buffer.from(ep.files[ep.cover.path]).length, fs.readFileSync(cover).length, 'new cover');
      eq(md5(epub), epubHash, 'original unchanged');
      await shot('6-details');
    });

    await step('no errors in the window console', async () => { eq(errors.length, 0, 'console errors: ' + errors.join(' | ')); });
  } catch (e) {
    results.push({ name: 'harness', ok: false, error: String((e && e.stack) || e) });
  }
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  const ok = results.length > 0 && results.every((r) => r.ok);
  fs.writeFileSync(outFile, JSON.stringify({ ok, results }, null, 2));
  app.exit(ok ? 0 : 1);
};
