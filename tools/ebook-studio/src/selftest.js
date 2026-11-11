'use strict';
// `--self-test=<result.json>`: proves a PACKAGED build works: reads an invented EPUB 2, converts it to every format
// (PDF through a hidden window), checks the EPUB we write, edits its details into a new file, and opens the book in the
// real window's sandboxed reading frame.
const fs = require('fs');
const os = require('os');
const path = require('path');
const E = require('./epub');
const S = require('./samples');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function run({ getWin, main }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ebook-studio-selftest-'));
  const results = [];
  const step = async (name, fn) => { try { results.push({ name, ok: true, detail: await fn() }); } catch (e) { results.push({ name, ok: false, error: String((e && e.stack) || e) }); } };
  const assert = (c, m) => { if (!c) throw new Error(m); };
  try {
    const src = path.join(dir, 'Almanac.epub');
    fs.writeFileSync(src, S.makeEpub2());
    const txt = path.join(dir, 'Harbour.txt');
    fs.writeFileSync(txt, S.sampleText());

    await step('an EPUB 2 is read: details, chapters, NCX contents, cover', async () => {
      const ep = E.readEpub(new Uint8Array(fs.readFileSync(src)));
      assert(ep.meta.title === 'The Lighthouse Keeper’s Almanac', 'title');
      assert(ep.toc.length === 4 && ep.cover, 'toc and cover');
      return `${ep.spine.length} spine items`;
    });

    for (const fmt of ['epub', 'html', 'md', 'txt', 'pdf']) {
      await step(`EPUB -> ${fmt.toUpperCase()}`, async () => {
        const r = await main.convertOne(src, fmt, {});
        const out = r.outputs[0];
        const data = fs.readFileSync(out);
        if (fmt === 'pdf') assert(data.slice(0, 5).toString() === '%PDF-', 'PDF header');
        if (fmt === 'epub') { const ep = E.readEpub(new Uint8Array(data)); assert(ep.spine.length >= 3 && E.zipEntries(data)[0].name === 'mimetype', 'epub'); }
        if (fmt === 'html') assert(/<img src="data:image\/png;base64,/.test(data.toString()) && !/<script/i.test(data.toString()), 'html');
        if (fmt === 'md') assert(/^---\ntitle: /.test(data.toString()) && r.outputs.length === 2, 'markdown and its pictures folder');
        if (fmt === 'txt') assert(/Spring Tides/.test(data.toString()), 'text');
        return `${path.basename(out)} ${data.length} bytes`;
      });
    }

    await step('TXT -> EPUB splits the chapters', async () => {
      const r = await main.convertOne(txt, 'epub', {});
      const ep = E.readEpub(new Uint8Array(fs.readFileSync(r.outputs[0])));
      assert(ep.meta.title === 'The Small Harbour' && ep.meta.authors[0] === 'Ada Invented', 'details');
      assert(ep.toc.map((t) => t.label).join('|') === 'The Small Harbour|CHAPTER I: The Arrival|CHAPTER II: Market Day|CHAPTER III: The Storm', ep.toc.map((t) => t.label).join('|'));
      return `${ep.toc.length} chapters`;
    });

    await step('details are changed into a new EPUB; the original stays the same', async () => {
      const before = fs.readFileSync(src);
      const bytes = E.editMetadata(new Uint8Array(before), { title: 'Renamed', authors: 'A One; B Two', cover: { data: S.coverPng(100, 150), mediaType: 'image/png' } });
      const ep = E.readEpub(bytes);
      assert(ep.meta.title === 'Renamed' && ep.meta.authors.join() === 'A One,B Two', 'new details');
      assert(Buffer.compare(before, fs.readFileSync(src)) === 0, 'original unchanged');
      return ep.cover.path;
    });

    await step('the window opens the book in the sandboxed reading frame', async () => {
      const wc = getWin().webContents;
      const js = (c) => wc.executeJavaScript(c, true);
      const end = Date.now() + 20000;
      while (!(await js('!!window.__app'))) { if (Date.now() > end) throw new Error('the window did not start'); await sleep(100); }
      await js(`window.__app.openBook(${JSON.stringify(src)})`);
      const end2 = Date.now() + 15000;
      while (!(await js('(()=>{const d=document.getElementById("frame").contentDocument; return !!(d && d.body && /Winter Light/.test(d.body.textContent));})()'))) { if (Date.now() > end2) throw new Error('the chapter did not show'); await sleep(100); }
      assert(await js('window.__pwned === undefined'), 'no script from the book ran');
      return await js('document.getElementById("rPage").textContent');
    });
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  return results;
}

module.exports = { run };
