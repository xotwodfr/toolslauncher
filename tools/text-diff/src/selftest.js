'use strict';
// `--self-test=<result.json>`: proves a PACKAGED build works. Runs the diff engine on known texts and on 100,000 lines,
// checks a patch re-applies (with a small applier written here, the `diff` package is a test-only dependency), detects
// encodings, writes with a backup, compares and copies two generated folders, then checks that the hidden window's Web
// Worker loads from the package and returns a comparison.
const fs = require('fs');
const os = require('os');
const path = require('path');
const T = require('./core/textdiff');
const E = require('./core/encoding');
const F = require('./core/files');
const D = require('./core/folders');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Apply a unified patch made by makePatch (LF or CRLF, "\ No newline" markers) to a text. */
function applyPatch(text, patch) {
  const src = T.splitLines(text);
  const lines = patch.split('\n');
  const out = []; let ai = 0; let i = 0;
  while (i < lines.length && !lines[i].startsWith('@@')) i++;
  const rawOf = (body, next) => { const noNl = next && next.startsWith('\\ No newline'); return body.replace(/\r$/, '') + (noNl ? '' : body.endsWith('\r') ? '\r\n' : '\n'); };
  while (i < lines.length) {
    const m = /^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@/.exec(lines[i]);
    if (!m) { i++; continue; }
    let start = +m[1] - 1; if (m[2] === '0') start++;
    while (ai < start) { out.push(src.lines[ai] + src.eols[ai]); ai++; }
    i++;
    while (i < lines.length && !lines[i].startsWith('@@')) {
      const l = lines[i]; const c = l[0];
      if (c === ' ') { out.push(src.lines[ai] + src.eols[ai]); ai++; }
      else if (c === '-') ai++;
      else if (c === '+') out.push(rawOf(l.slice(1), lines[i + 1]));
      i++;
    }
  }
  while (ai < src.lines.length) { out.push(src.lines[ai] + src.eols[ai]); ai++; }
  return out.join('');
}

async function run({ getWin, hooks } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'textdiff-selftest-'));
  const results = [];
  const step = async (name, fn) => { try { results.push({ name, ok: true, detail: await fn() }); } catch (e) { results.push({ name, ok: false, error: String((e && e.stack) || e) }); } };
  const assert = (c, m) => { if (!c) throw new Error(m); };
  try {
    await step('the line diff finds the minimal changes on a known case', () => {
      const r = T.diffLines(T.splitLines('A\nB\nC\nA\nB\nB\nA\n'), T.splitLines('C\nB\nA\nB\nA\nC\n'));
      const n = r.blocks.filter((b) => b.type === 'change').reduce((s, b) => s + b.aEnd - b.aStart + b.bEnd - b.bStart, 0);
      assert(n === 5, 'edits: ' + n);
      return '5 edits';
    });
    await step('100,000 lines diff in well under a few seconds', () => {
      const a = Array.from({ length: 100000 }, (_, i) => `line ${i}`);
      const b = a.slice(); for (let i = 0; i < 200; i++) b[i * 499] = 'x' + i;
      const t0 = Date.now();
      const r = T.diffLines(T.splitLines(a.join('\n')), T.splitLines(b.join('\n')));
      const ms = Date.now() - t0;
      assert(r.stats.modified === 200, 'modified ' + r.stats.modified);
      assert(ms < 5000, ms + ' ms');
      return ms + ' ms';
    });
    await step('a patch re-applies (CRLF and a missing last newline)', () => {
      const a = 'one\r\ntwo\r\nthree\r\nfour'; const b = 'one\r\n2\r\nthree\r\nfour\r\nfive';
      const p = T.makePatch(T.splitLines(a), T.splitLines(b));
      assert(applyPatch(a, p) === b, 'applied: ' + JSON.stringify(applyPatch(a, p)));
      return p.split('\n').length + ' patch lines';
    });
    await step('encodings are detected and written back the same', () => {
      const t = 'Grüße – 😀\r\n';
      for (const [enc, bom] of [['utf-8', false], ['utf-8-bom', true], ['utf-16le', true], ['utf-16be', true]]) {
        const bytes = E.encode(t, enc, bom); const d = E.detect(bytes);
        assert(d.encoding === enc && d.text === t, enc + ' detected as ' + d.encoding);
      }
      assert(E.detect(Buffer.from([0, 1, 2, 3, 200, 201, 0, 9])).encoding === 'binary', 'binary');
      return 'UTF-8, UTF-8 BOM, UTF-16 LE/BE, binary';
    });
    await step('overwriting keeps a .bak and writes through a .part file', async () => {
      const f = path.join(dir, 'a.txt'); fs.writeFileSync(f, 'old');
      const st = fs.statSync(f);
      const r = await F.overwriteWithBackup(f, 'new', { size: st.size, mtimeMs: st.mtimeMs });
      assert(fs.readFileSync(f, 'utf8') === 'new' && fs.readFileSync(r.backup, 'utf8') === 'old', 'contents');
      assert(!fs.existsSync(f + '.part'), 'part left');
      return path.basename(r.backup);
    });
    await step('two folders are compared (quick and by contents) and a copy replaces through the Recycle Bin hook', async () => {
      const L = path.join(dir, 'L'); const R = path.join(dir, 'R');
      const put = (p, d) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, d); };
      put(path.join(L, 'a.txt'), 'same'); put(path.join(R, 'a.txt'), 'same');
      put(path.join(L, 'sub/b.txt'), 'left'); put(path.join(R, 'sub/b.txt'), 'rite');
      put(path.join(L, 'only.txt'), 'x');
      const t = new Date('2024-01-01T00:00:00Z');
      for (const p of [path.join(L, 'a.txt'), path.join(R, 'a.txt'), path.join(L, 'sub/b.txt'), path.join(R, 'sub/b.txt')]) fs.utimesSync(p, t, t);
      const q = await D.compareFolders(L, R, { mode: 'quick' });
      const c = await D.compareFolders(L, R, { mode: 'content' });
      const st = (r, rel) => r.entries.find((e) => e.rel === rel).status;
      assert(st(q, 'sub/b.txt') === 'same' && st(c, 'sub/b.txt') === 'different', 'quick vs content');
      assert(st(c, 'only.txt') === 'left', 'only left');
      const binned = [];
      const res = await D.runCopy(D.planCopy(c, ['sub', 'only.txt'], 'ltr'), { trash: async (p) => { binned.push(p); fs.renameSync(p, p + '.binned'); } });
      assert(res.done.length === 2 && binned.length === 1, JSON.stringify(res));
      assert(fs.readFileSync(path.join(R, 'sub/b.txt'), 'utf8') === 'left', 'copied');
      return `${c.entries.length} entries, ${res.done.length} copied`;
    });
    await step('the window starts and its Web Worker compares two texts', async () => {
      const win = getWin && getWin();
      if (!win) throw new Error('no window');
      const wc = win.webContents;
      if (wc.isLoading()) await new Promise((r) => wc.once('did-finish-load', r));
      const js = (c) => wc.executeJavaScript(c, true);
      const end = Date.now() + 15000;
      while (!(await js('!!window.__app'))) { if (Date.now() > end) throw new Error('page did not start'); await sleep(50); }
      await js('(() => { document.getElementById("edL").value = "a\\nb\\nc\\n"; document.getElementById("edR").value = "a\\nB\\nc\\nd\\n"; window.__app.compare(); })()');
      while (!(await js('!!window.__app.S.diff'))) { if (Date.now() > end) throw new Error('the worker did not answer'); await sleep(50); }
      const sum = await js('document.getElementById("summary").textContent');
      assert(/^2 changes/.test(sum), sum);
      return sum;
    });
    void hooks;
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  return results;
}

module.exports = { run, applyPatch };
