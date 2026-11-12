'use strict';
// `--self-test=<result.json>`: proves a PACKAGED build works. Scans an invented folder tree on a worker thread (so it proves
// the worker starts from the packaged app) and checks the totals against fs, lists the drives, checks the system-folder
// refusal, then opens the real window, scans the same tree in it and checks what it shows.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runScan } = require('./runner');
const { listDrives } = require('./drives');
const { protectedReason } = require('./protect');
const { squarify } = require('./treemap');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const WIN = process.platform === 'win32';
const alloc = (p) => { const st = fs.lstatSync(p); return !WIN && typeof st.blocks === 'number' ? st.blocks * 512 : st.size; };

async function run({ getWin } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'diskspace-selftest-'));
  const results = [];
  const step = async (name, fn) => { try { results.push({ name, ok: true, detail: await fn() }); } catch (e) { results.push({ name, ok: false, error: String((e && e.message) || e) }); } };
  const root = path.join(dir, 'Self Test');
  const files = [];
  const mk = (rel, n) => { const p = path.join(root, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, Buffer.alloc(n, 3)); files.push(p); };
  mk('Films/one.mkv', 900000); mk('Songs/über.flac', 300000); mk('Notes/a.txt', 1200);
  for (let i = 0; i < 100; i++) mk(`Many/f${i}.dat`, 500 + i);
  const total = files.reduce((t, f) => t + alloc(f), 0);
  try {
    await step('a worker thread scans a folder and the totals match the files', async () => {
      const job = runScan(root, {}, {});
      const r = JSON.parse((await job.promise).json);
      if (r.tree.s !== total) throw new Error(`size ${r.tree.s} != ${total}`);
      if (r.tree.f !== files.length) throw new Error(`files ${r.tree.f} != ${files.length}`);
      return `${r.tree.f} files, ${r.tree.s} bytes`;
    });
    await step('the drives are listed with their size', async () => {
      const d = listDrives();
      if (!d.length || !d.every((x) => x.total > 0)) throw new Error(JSON.stringify(d));
      return d.map((x) => x.path).join(', ');
    });
    await step('system folders are refused and normal ones are not', async () => {
      const sys = WIN ? (process.env.SystemRoot || 'C:\\Windows') : '/usr';
      if (!protectedReason(sys)) throw new Error(sys + ' was not refused');
      if (!protectedReason(os.homedir())) throw new Error('the home folder was not refused');
      if (protectedReason(path.join(root, 'Films'))) throw new Error('a normal folder was refused');
      return 'ok';
    });
    await step('the treemap layout fills the space', async () => {
      const b = squarify([5, 3, 2], { x: 0, y: 0, w: 100, h: 50 });
      const area = b.reduce((t, r) => t + r.w * r.h, 0);
      if (Math.abs(area - 5000) > 1e-6) throw new Error('area ' + area);
      return 'ok';
    });
    const win = getWin && getWin();
    if (win) {
      const js = (c) => win.webContents.executeJavaScript(c, true);
      const errors = [];
      win.webContents.on('console-message', (_e, level, msg) => { if (level >= 2) errors.push(msg); });
      const waitFor = async (expr, ms = 30000) => { const end = Date.now() + ms; for (;;) { if (await js(expr)) return; if (Date.now() > end) throw new Error('timed out: ' + expr); await sleep(80); } };
      await step('the window scans the folder and shows the map, the totals and the largest file', async () => {
        await waitFor('!!window.__app');
        await js(`void window.__app.startScan(${JSON.stringify(root)})`);
        await waitFor('window.__app.S.root && !window.__app.S.scanning');
        const s = await js('({ s: window.__app.S.root.s, rects: window.__app.S.rects.length, status: document.getElementById("status").textContent, top: window.__app.S.largest[0].p })');
        if (s.s !== total) throw new Error('size shown ' + s.s);
        if (s.rects < 5) throw new Error('map boxes: ' + s.rects);
        if (!/Scanned 103 files/.test(s.status)) throw new Error('status: ' + s.status);
        if (s.top !== path.join(root, 'Films', 'one.mkv')) throw new Error('largest: ' + s.top);
        if (errors.length) throw new Error('console errors: ' + errors.join(' | '));
        return s.status;
      });
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return results;
}

module.exports = { run };
