'use strict';
// `--self-test=<result.json>`: proves a PACKAGED build works. Scans real files (exact copies, songs with the bundled
// ffmpeg and tag reader), checks the safety rules, then opens the real window and scans a folder of pictures through it
// (which exercises picture decoding and the dfx:// protocol). Files are only ever moved to a temporary folder here, never
// to the real Recycle Bin.
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const Scan = require('./scan');
const Trash = require('./trash');
const Music = require('./music');
const { png } = require('./testkit');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function run({ getWin, setTrashMode } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dupefinder-selftest-'));
  const bin = path.join(dir, '_bin');
  const results = [];
  const step = async (name, fn) => { try { results.push({ name, ok: true, detail: await fn() }); } catch (e) { results.push({ name, ok: false, error: String((e && e.message) || e) }); } };
  const eq = (a, b, what) => { if (a !== b) throw new Error(`${what}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); };
  const put = (rel, data, iso) => { const f = path.join(dir, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, data); if (iso) fs.utimesSync(f, new Date(iso), new Date(iso)); return f; };
  try {
    const data = crypto.randomBytes(20000);
    const files = [put('A/one.bin', data, '2020-01-01'), put('B/two.bin', data, '2021-01-01'), put('B/other.bin', crypto.randomBytes(20000))];
    let scan;
    await step('finds exact copies of a file', async () => {
      scan = await Scan.scan('files', [{ path: path.join(dir, 'A') }, { path: path.join(dir, 'B') }], {});
      eq(scan.groups.length, 1, 'groups'); eq(scan.groups[0].files.length, 2, 'files in group');
      return `${scan.stats.files} files, ${scan.groups.length} group`;
    });
    await step('never leaves a group empty, and moves the extra copy (to a temporary folder)', async () => {
      const g = scan.groups.map((x, i) => ({ id: i + 1, kind: x.kind, files: x.files.map((f, k) => ({ ...f, id: (i + 1) * 100 + k })) }));
      const all = Trash.planTrash(g, g[0].files.map((f) => f.id));
      eq(all.items.length, 0, 'selecting every copy is refused');
      const one = Trash.planTrash(g, [g[0].files[1].id]);
      eq(one.items.length, 1, 'one copy planned');
      const r = await Trash.executeTrash(one, { trashItem: async (p) => { fs.mkdirSync(bin, { recursive: true }); fs.renameSync(p, path.join(bin, path.basename(p))); } });
      eq(r.moved.length, 1, 'moved');
      eq(fs.existsSync(files[0]) && !fs.existsSync(files[1]), true, 'the first copy stays, the second moved');
      return 'ok';
    });
    await step('reads song tags and compares decoded audio with the bundled tools', async () => {
      const m = path.join(dir, 'Music');
      fs.mkdirSync(m);
      const make = (name, hz, title, codec) => {
        const r = spawnSync(Music.ffmpegPath(), ['-hide_banner', '-v', 'error', '-y', '-f', 'lavfi', '-i', `sine=frequency=${hz}:duration=2`, ...codec, '-metadata', `title=${title}`, '-metadata', 'artist=Self Test', path.join(m, name)], { encoding: 'utf8', windowsHide: true });
        if (r.status !== 0) throw new Error('ffmpeg: ' + r.stderr);
      };
      make('a.mp3', 440, 'Same Song', ['-c:a', 'libmp3lame', '-b:a', '128k']);
      make('b.flac', 440, 'same song', ['-c:a', 'flac']);
      const r = await Scan.scan('music', [{ path: m }], {});
      eq(r.groups.length, 1, 'one group'); eq(r.groups[0].kind, 'same-song', 'kind');
      eq(path.basename(r.groups[0].files[0].path), 'b.flac', 'lossless first');
      return r.groups[0].files.map((f) => `${path.basename(f.path)} q${f.quality}`).join(', ');
    });

    const win = getWin && getWin();
    if (win) {
      const js = (c) => win.webContents.executeJavaScript(c, true);
      const errors = [];
      win.webContents.on('console-message', (_e, level, msg) => { if (level >= 2) errors.push(msg); });
      const waitFor = async (expr, ms = 15000) => { const end = Date.now() + ms; for (;;) { if (await js(expr)) return; if (Date.now() > end) throw new Error('timed out: ' + expr); await sleep(50); } };
      setTrashMode(bin);
      await step('the window scans a folder for exact copies and shows the group', async () => {
        await waitFor('!!window.__app');
        await js(`window.__app.addRoots([${JSON.stringify(path.join(dir, 'A'))}, ${JSON.stringify(path.join(dir, 'B'))}])`);
        put('B/three.bin', data, '2022-01-01');
        await js('document.getElementById("scan").click()');
        await waitFor('window.__app.S.scanned && window.__app.S.busy === null');
        eq(await js('document.querySelectorAll("#groups .group").length'), 1, 'groups shown');
        return await js('document.getElementById("summary").textContent');
      });
      await step('the window finds look-alike pictures (picture decoding and dfx:// work in this build)', async () => {
        const pics = path.join(dir, 'Pics');
        const wave = (i) => (x, y) => (Math.sin((x + i) * 0.21) * Math.cos(y * 0.17 * (1 + (i % 3))) * 120 + 128) | 0;
        fs.mkdirSync(pics);
        fs.writeFileSync(path.join(pics, 'one.png'), png(96, 96, wave(1)));
        fs.writeFileSync(path.join(pics, 'one big.png'), png(192, 192, (x, y) => wave(1)(x / 2, y / 2)));
        fs.writeFileSync(path.join(pics, 'two.png'), png(96, 96, (x, y) => ((x * 7 + y * 3) % 256)));
        await js(`window.__app.S.roots = []; window.__app.addRoots([${JSON.stringify(pics)}]); document.getElementById('mode-photos').click()`);
        await js('document.getElementById("scan").click()');
        await waitFor('window.__app.S.scanned && window.__app.S.busy === null');
        const names = await js('[...document.querySelectorAll("#groups .group")].map(g => [...g.querySelectorAll(".name")].map(n => n.firstChild.textContent).sort().join(" + "))');
        eq(names.join('|'), 'one big.png + one.png', 'the look-alikes');
        await waitFor('[...document.querySelectorAll("#groups img.thumb")].every(i => i.complete && i.naturalWidth > 0)');
        if (errors.length) throw new Error('console errors: ' + errors.join(' | '));
        return names[0];
      });
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return results;
}

module.exports = { run };
