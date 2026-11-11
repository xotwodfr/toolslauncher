'use strict';
// `--self-test=<result.json>`: proves a PACKAGED build works: the Markdown renderer and sanitiser, the search index, the
// three exports (HTML, PDF through a hidden window, DOCX) on an invented notes folder, and that the real window loads its
// editor bundle and shows a note.
const fs = require('fs');
const os = require('os');
const path = require('path');
const Meta = require('./meta');
const R = require('./markdown');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PNG = require('./testpng').makePng(2, 2);

async function run({ getWin, main }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'markdown-notes-selftest-'));
  const results = [];
  const step = async (name, fn) => { try { results.push({ name, ok: true, detail: await fn() }); } catch (e) { results.push({ name, ok: false, error: String((e && e.stack) || e) }); } };
  const assert = (c, m) => { if (!c) throw new Error(m); };
  try {
    const notes = path.join(dir, 'Notes ünïcode');
    fs.mkdirSync(path.join(notes, 'Projects', 'attachments'), { recursive: true });
    fs.writeFileSync(path.join(notes, 'Projects', 'attachments', 'dot.png'), PNG);
    const plan = '---\ntags: [work]\n---\n# Garden plan\n\nSee [[Seeds]] and #spring.\n\n- [ ] dig\n- [x] buy soil\n\n| bed | crop |\n|---|---|\n| 1 | peas |\n\n![dot](attachments/dot.png)\n\n```js\nconst x = 1;\n```\n';
    fs.writeFileSync(path.join(notes, 'Projects', 'Garden plan.md'), plan);
    fs.writeFileSync(path.join(notes, 'Seeds.md'), '# Seeds\n\nPeas, beans, café crème.\n');

    await step('the renderer makes safe HTML (no script, no event handlers, no javascript: links)', async () => {
      const html = R.render('<script>alert(1)</script><img src=x onerror="alert(1)">[x](javascript:alert(1))<a href="javascript:alert(2)">y</a>');
      assert(!/<script|\sonerror=|href="javascript:/i.test(html), html);
      return html.length + ' bytes';
    });

    await step('the folder opens and the search index finds notes (accents folded, tags)', async () => {
      const f = await main.openFolder(notes);
      assert(f.notes.length === 2, 'notes: ' + f.notes);
      const idx = main.getIndex();
      assert(idx.search('cafe')[0].rel === 'Seeds.md', 'accent search');
      assert(idx.search('#spring')[0].rel === 'Projects/Garden plan.md', 'tag search');
      assert(Meta.resolveWikiLink('Seeds', 'Projects/Garden plan.md', idx.paths()) === 'Seeds.md', 'wiki link');
      return f.notes.join(', ');
    });

    await step('HTML export is self-contained (picture inlined, no scripts)', async () => {
      const html = (await main.exportNote('Projects/Garden plan.md', plan, 'html')).toString('utf8');
      assert(/<img src="data:image\/png;base64,/.test(html), 'picture inlined');
      assert(!/<script/i.test(html), 'no scripts');
      return html.length + ' bytes';
    });

    await step('PDF export prints through a hidden window', async () => {
      const pdf = await main.exportNote('Projects/Garden plan.md', plan, 'pdf', { pageSize: 'A4' });
      assert(pdf.slice(0, 5).toString() === '%PDF-', 'PDF header');
      return pdf.length + ' bytes';
    });

    await step('DOCX export is a Word file with the heading, the table and the picture', async () => {
      const docx = await main.exportNote('Projects/Garden plan.md', plan, 'docx');
      const { unzipSync, strFromU8 } = require('fflate'); // comes with docx
      const z = unzipSync(new Uint8Array(docx));
      const xml = strFromU8(z['word/document.xml']);
      assert(/Garden plan/.test(xml) && /Heading1/.test(xml), 'heading in document.xml');
      assert(/<w:tbl>/.test(xml), 'table');
      assert(Object.keys(z).some((k) => k.startsWith('word/media/')), 'picture in the zip');
      return docx.length + ' bytes';
    });

    await step('the window loads the editor and shows a note', async () => {
      const win = getWin();
      const wc = win.webContents;
      const js = (c) => wc.executeJavaScript(c, true);
      const end = Date.now() + 20000;
      while (!(await js('!!(window.__app && window.NotesEditor)'))) { if (Date.now() > end) throw new Error('the window did not start'); await sleep(100); }
      await js('window.__app.openNote("Seeds.md")');
      const endR = Date.now() + 10000;
      while (!(await js('document.getElementById("preview").textContent.includes("café")'))) { if (Date.now() > endR) throw new Error('the preview did not show the note'); await sleep(100); }
      return 'editor ' + (await js('window.__app.ed.getText().length')) + ' characters';
    });
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  return results;
}

module.exports = { run };
