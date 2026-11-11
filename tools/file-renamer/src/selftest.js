'use strict';
// `--self-test=<result.json>`: proves a PACKAGED build works. Reads a photo date with exifr and audio tags with
// music-metadata (an ES module, loaded with import()) from invented files, previews a rule stack, renames a swap and a
// case change in a temporary folder, undoes it from the saved journal, and checks the hidden window starts.
const fs = require('fs');
const os = require('os');
const path = require('path');
const K = require('./core/testkit');
const B = require('./core/batch');
const G = require('./core/engine');
const S = require('./core/store');
const M = require('./core/meta');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function run({ getWin } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'renamer-selftest-'));
  const results = [];
  const step = async (name, fn) => { try { results.push({ name, ok: true, detail: await fn() }); } catch (e) { results.push({ name, ok: false, error: String((e && e.stack) || e) }); } };
  const assert = (c, m) => { if (!c) throw new Error(m); };
  try {
    await step('exifr reads the photo date of an invented JPEG', async () => {
      const f = K.jpegWithDate(path.join(dir, 'p.jpg'), '2021:07:14 09:30:00');
      const ms = await M.exifDate(f);
      const d = new Date(ms);
      assert(d.getFullYear() === 2021 && d.getMonth() === 6 && d.getDate() === 14 && d.getHours() === 9, 'date: ' + d);
      return d.toISOString();
    });
    await step('music-metadata reads MP3 and FLAC tags', async () => {
      const a = await M.audioTags(K.mp3WithTags(path.join(dir, 's.mp3'), { title: 'Night Swim', artist: 'Kite Season', track: '4' }));
      const b = await M.audioTags(K.flacWithTags(path.join(dir, 's.flac'), { title: 'Lantern', artist: 'Aster Vale', track: '7' }));
      assert(a && a.title === 'Night Swim' && a.track === 4, JSON.stringify(a));
      assert(b && b.artist === 'Aster Vale' && b.track === 7, JSON.stringify(b));
      return `${a.artist} / ${b.artist}`;
    });
    await step('preview, rename (swap + case change) and undo from the saved journal', async () => {
      const d = path.join(dir, 'files'); fs.mkdirSync(d);
      for (const [n, c] of [['a.txt', 'A'], ['b.txt', 'B'], ['Loud.TXT', 'L']]) fs.writeFileSync(path.join(d, n), c);
      const L = new B.FileList(); await L.add([d]);
      const rules = [{ type: 'replace', find: 'a', replace: '#', matchCase: true }, { type: 'replace', find: 'b', replace: 'a', matchCase: true }, { type: 'replace', find: '#', replace: 'b' }, { type: 'case', mode: 'lower', ext: true }];
      const p = await B.preview(L.sorted('name'), rules);
      assert(p.summary.errors === 0 && p.summary.rename === 3, JSON.stringify(p.summary));
      const h = new S.History(path.join(dir, 'history'));
      const j = G.planBatch(p.rows.filter((r) => r.status === 'ok').map((r) => ({ from: r.from, to: r.to })));
      await G.runBatch(j, { save: (x) => h.save(x) });
      assert(fs.readFileSync(path.join(d, 'a.txt'), 'utf8') === 'B' && fs.existsSync(path.join(d, 'loud.txt')), 'renamed');
      await G.undoBatch(new S.History(path.join(dir, 'history')).get(j.id));
      assert(fs.readFileSync(path.join(d, 'a.txt'), 'utf8') === 'A' && fs.readdirSync(d).sort().join() === 'Loud.TXT,a.txt,b.txt', 'undone: ' + fs.readdirSync(d));
      return 'ok';
    });
    await step('the window starts and shows the empty list', async () => {
      const win = getWin && getWin();
      if (!win) throw new Error('no window');
      const wc = win.webContents;
      if (wc.isLoading()) await new Promise((r) => wc.once('did-finish-load', r));
      const end = Date.now() + 15000;
      while (!(await wc.executeJavaScript('!!(window.__app && window.__app.S.ready)', true))) { if (Date.now() > end) throw new Error('page did not start'); await sleep(50); }
      const t = await wc.executeJavaScript('document.getElementById("summary").textContent', true);
      assert(/No files/.test(t), t);
      return t;
    });
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  return results;
}

module.exports = { run };
