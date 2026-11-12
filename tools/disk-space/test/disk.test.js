'use strict';
// Disk Space Visualizer core tests: the scanner on a generated folder tree (with a link loop, a hard link, unicode names,
// a deep chain of folders and an unreadable folder), the treemap layout, the file type groups, drive listing and the
// folders that must never go to the Recycle Bin.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { scan, snapshot, KEEP_FILES, MinHeap } = require('../src/scan');
const { squarify } = require('../src/treemap');
const T = require('../src/types');
const { protectedReason } = require('../src/protect');
const { parseMounts, listDrives } = require('../src/drives');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'diskspace-test-'));
const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const IS_ROOT = typeof process.getuid === 'function' && process.getuid() === 0;
const WIN = process.platform === 'win32';
const notes = [];

/** allocated size the way the scanner counts it */
const alloc = (p) => { const st = fs.lstatSync(p); return !WIN && typeof st.blocks === 'number' ? st.blocks * 512 : st.size; };
const write = (p, bytes) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, Buffer.alloc(bytes, 7)); return p; };
const find = (node, ...names) => { let n = node; for (const name of names) { n = n.c.find((c) => c.n === name); if (!n) return null; } return n; };

function makeTree() {
  const root = path.join(tmp, 'tree');
  const files = [];
  files.push(write(path.join(root, 'movie.mkv'), 300000));
  files.push(write(path.join(root, 'Music', 'song.flac'), 120000));
  files.push(write(path.join(root, 'Music', 'Ünïcödé 名前 🎵.mp3'), 50000));
  files.push(write(path.join(root, 'Photos', '2024', 'a.jpg'), 40000));
  files.push(write(path.join(root, 'Photos', '2024', 'b.JPG'), 41000));
  files.push(write(path.join(root, 'Code', 'app.js'), 3000));
  files.push(write(path.join(root, 'Code', 'README'), 10));
  files.push(write(path.join(root, 'empty.txt'), 0));
  for (let i = 0; i < 150; i++) files.push(write(path.join(root, 'Many', `f${String(i).padStart(3, '0')}.log`), 1000 + i * 37));
  // a deep chain of folders (an iterative scanner handles any depth)
  let deep = path.join(root, 'Deep');
  for (let i = 0; i < 120; i++) deep = path.join(deep, 'd' + i);
  files.push(write(path.join(deep, 'bottom.bin'), 9000));
  // a link loop: Music/loop -> the root
  let links = 0;
  try { fs.symlinkSync(root, path.join(root, 'Music', 'loop'), 'dir'); links++; } catch (e) { notes.push('could not make a folder link: ' + e.code); }
  try { fs.symlinkSync(path.join(root, 'movie.mkv'), path.join(root, 'movie-link.mkv'), 'file'); links++; } catch { /* Windows without the right */ }
  // a hard link: the same file twice
  const hl = path.join(root, 'Photos', 'a-hardlink.jpg');
  fs.linkSync(path.join(root, 'Photos', '2024', 'a.jpg'), hl);
  return { root, files, links };
}

const fixture = makeTree();

test('scanner: totals match the files on disk, the hard link is counted once and links are not followed (no loop)', () => {
  const r = scan(fixture.root);
  const expected = fixture.files.reduce((t, f) => t + alloc(f), 0);
  assert.strictEqual(r.tree.s, expected, 'total size');
  assert.strictEqual(r.stats.bytes, expected);
  assert.strictEqual(r.tree.f, fixture.files.length, 'file count (the hard link not counted again)');
  assert.strictEqual(r.stats.files, fixture.files.length);
  assert.strictEqual(r.stats.hardlinks, 1, 'one extra hard link seen');
  assert.strictEqual(r.stats.links, fixture.links, 'links counted and skipped');
  assert.strictEqual(r.partial, false);
  assert.strictEqual(r.stats.apparent, fixture.files.reduce((t, f) => t + fs.statSync(f).size, 0), 'apparent size');
  // folders: Music, Photos, 2024, Code, Many, Deep + 120 chain folders
  assert.strictEqual(r.tree.d, 6 + 120, 'folder count');
  // every folder's size is the sum of what is in it
  const check = (n) => { if (!n.c) return n.s; const sum = n.c.reduce((t, c) => t + check(c), 0) + (n.o ? n.o.s : 0); assert.strictEqual(sum, n.s, 'sum of ' + n.n); assert.strictEqual(n.g.reduce((a, b) => a + b, 0), n.s, 'groups of ' + n.n); return n.s; };
  check(r.tree);
  assert(!find(r.tree, 'Music', 'loop'), 'the link is not in the tree');
});

test('scanner: unicode names, sorting, the "smaller files" block and the largest-files list', () => {
  const r = scan(fixture.root);
  assert(find(r.tree, 'Music', 'Ünïcödé 名前 🎵.mp3'), 'unicode name kept');
  for (const stack = [r.tree]; stack.length;) { const n = stack.pop(); for (let i = 1; i < n.c.length; i++) assert(n.c[i - 1].s >= n.c[i].s, 'sorted by size in ' + n.n); n.c.filter((c) => c.c).forEach((c) => stack.push(c)); }
  const many = find(r.tree, 'Many');
  assert.strictEqual(many.c.length, KEEP_FILES, 'only the biggest files are listed one by one');
  assert.strictEqual(many.o.n, 150 - KEEP_FILES, 'the rest are counted');
  assert(many.c[KEEP_FILES - 1].s >= 0 && many.f === 150);
  assert.strictEqual(r.largest[0].p, path.join(fixture.root, 'movie.mkv'));
  assert.strictEqual(r.largest[0].k, T.GROUPS.indexOf('video'));
  for (let i = 1; i < r.largest.length; i++) assert(r.largest[i - 1].s >= r.largest[i].s);
  const jpg = r.exts.find((e) => e.e === 'jpg');
  assert.strictEqual(jpg.n, 2, 'a.jpg and b.JPG (the hard link counted once)');
  assert.strictEqual(r.tree.g[T.GROUPS.indexOf('video')], alloc(path.join(fixture.root, 'movie.mkv')));
  const deep = find(r.tree, 'Deep');
  assert.strictEqual(deep.f, 1); assert.strictEqual(deep.d, 120);
});

test('scanner: a folder that cannot be read is listed and the scan goes on (permission part)', () => {
  if (WIN || IS_ROOT) { notes.push('the real unreadable-folder check was skipped: ' + (WIN ? 'Windows' : 'running as root, which can read everything') + '; the simulated one below covers the same code'); return; }
  const locked = path.join(tmp, 'locked');
  write(path.join(locked, 'ok.txt'), 5000);
  write(path.join(locked, 'secret', 'hidden.bin'), 5000);
  fs.chmodSync(path.join(locked, 'secret'), 0o000);
  try {
    const r = scan(locked);
    assert.strictEqual(r.stats.skipped, 1);
    assert.strictEqual(r.stats.errors[0].path, path.join(locked, 'secret'));
    assert.strictEqual(r.stats.errors[0].message, 'No permission to look inside');
    assert.strictEqual(find(r.tree, 'secret').e, 'EACCES');
    assert.strictEqual(r.tree.f, 1);
  } finally { fs.chmodSync(path.join(locked, 'secret'), 0o755); }
});

test('scanner: unreadable folders and files (simulated, works as any user) are counted, listed and skipped', () => {
  const blocked = path.join(fixture.root, 'Photos');
  const fakeFs = {
    ...fs,
    readdirSync: (p, ...a) => { if (p === blocked) throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }); return fs.readdirSync(p, ...a); },
    lstatSync: (p, ...a) => { if (p.endsWith('app.js')) throw Object.assign(new Error('EPERM'), { code: 'EPERM' }); return fs.lstatSync(p, ...a); },
  };
  const r = scan(fixture.root, { fs: fakeFs });
  assert.strictEqual(r.stats.skipped, 2);
  assert.deepStrictEqual(r.stats.errors.map((e) => e.path).sort(), [blocked, path.join(fixture.root, 'Code', 'app.js')].sort());
  assert.strictEqual(find(r.tree, 'Photos').e, 'EACCES');
  assert.strictEqual(find(r.tree, 'Photos').s, 0);
  assert.strictEqual(r.stats.hardlinks, 0, 'the hard link was inside the blocked folder');
  assert(r.tree.s > 0);
});

test('scanner: Cancel stops it and keeps what was found so far, marked as not finished', () => {
  let calls = 0;
  const r = scan(fixture.root, { shouldStop: () => ++calls > 8 });
  assert.strictEqual(r.partial, true);
  assert(r.stats.dirs < 127, 'stopped early: ' + r.stats.dirs);
  assert(r.tree.s < scan(fixture.root).tree.s);
  const unscanned = []; for (const stack = [r.tree]; stack.length;) { const n = stack.pop(); if (n.u) unscanned.push(n.n); (n.c || []).filter((c) => c.c).forEach((c) => stack.push(c)); }
  assert(unscanned.length > 0, 'folders not reached are marked');
});

test('scanner: progress and live snapshots arrive, and the snapshot only holds big items', () => {
  const progress = [];
  const r = scan(fixture.root, { onProgress: (p) => progress.push(p) });
  assert(progress.length >= 1);
  const last = progress[progress.length - 1];
  assert.strictEqual(last.files, r.stats.files); assert.strictEqual(last.bytes, r.stats.bytes);
  const snap = JSON.parse(snapshot(r.tree, r.tree.s));
  assert.strictEqual(snap.s, r.tree.s);
  const tiny = find(snap, 'empty.txt');
  assert(!tiny, 'a 0-byte file is left out of the live view');
  assert(find(snap, 'movie.mkv'));
});

test('scanner: refuses a file or a missing folder with a clear error', () => {
  assert.throws(() => scan(path.join(fixture.root, 'movie.mkv')), /not a folder/);
  assert.throws(() => scan(path.join(tmp, 'nope')), /ENOENT/);
});

test('scanner: a big flat folder (20 000 files) is scanned quickly and correctly', () => {
  const big = path.join(tmp, 'big');
  fs.mkdirSync(big);
  for (let i = 0; i < 20000; i++) fs.writeFileSync(path.join(big, `x${i}.dat`), '');
  const t0 = Date.now();
  const r = scan(big);
  assert.strictEqual(r.tree.f, 20000);
  assert.strictEqual(r.tree.c.length, KEEP_FILES);
  assert.strictEqual(r.tree.o.n, 20000 - KEEP_FILES);
  assert(Date.now() - t0 < 8000, 'took ' + (Date.now() - t0) + ' ms');
});

test('min-heap keeps the N biggest', () => {
  const h = new MinHeap(5);
  const vals = [5, 1, 9, 3, 7, 8, 2, 10, 4, 6];
  vals.forEach((s) => h.push({ s }));
  assert.deepStrictEqual(h.sorted().map((x) => x.s), [10, 9, 8, 7, 6]);
});

// ---- treemap ----------------------------------------------------------------------------------------------------------------
function checkLayout(values, rect) {
  const out = squarify(values, rect);
  assert.strictEqual(out.length, values.length);
  const total = values.reduce((t, v) => t + (v > 0 ? v : 0), 0);
  const area = rect.w * rect.h;
  const eps = 1e-6;
  out.forEach((r, i) => {
    const v = values[i] > 0 ? values[i] : 0;
    const want = (v / total) * area;
    if (v > 0) assert(Math.abs(r.w * r.h - want) <= want * 0.01 + 1e-9, `area ${i}: ${r.w * r.h} vs ${want}`);
    else assert.strictEqual(r.w * r.h, 0);
    assert(r.x >= rect.x - eps && r.y >= rect.y - eps && r.x + r.w <= rect.x + rect.w + eps && r.y + r.h <= rect.y + rect.h + eps, 'inside the bounds: ' + JSON.stringify(r));
    assert(r.w >= -eps && r.h >= -eps);
  });
  for (let i = 0; i < out.length; i++) for (let j = i + 1; j < out.length; j++) {
    const a = out[i]; const b = out[j];
    const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
    const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
    assert(!(ox > 1e-6 && oy > 1e-6), `rectangles ${i} and ${j} overlap`);
  }
  const sum = out.reduce((t, r) => t + r.w * r.h, 0);
  assert(Math.abs(sum - area) < area * 1e-9, 'the rectangles fill the space');
  return out;
}

test('treemap: areas are proportional to the sizes (within 1 %), inside the bounds and never overlapping', () => {
  checkLayout([6, 6, 4, 3, 2, 2, 1], { x: 0, y: 0, w: 6, h: 4 });
  checkLayout([1], { x: 10, y: 20, w: 300, h: 100 });
  checkLayout([5, 0, 3, -1, NaN, 2], { x: 0, y: 0, w: 100, h: 100 });
  checkLayout([1e12, 1, 1, 1, 50000], { x: 3, y: 7, w: 1200, h: 640 });
  let seed = 1; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let k = 0; k < 40; k++) {
    const n = 1 + Math.floor(rnd() * 60);
    const vals = Array.from({ length: n }, () => Math.floor(rnd() ** 3 * 1e6) + 1);
    checkLayout(vals, { x: rnd() * 50, y: rnd() * 50, w: 10 + rnd() * 900, h: 10 + rnd() * 600 });
  }
});

test('treemap: the rectangles are reasonably square (the point of squarifying)', () => {
  const vals = Array.from({ length: 30 }, (_, i) => 30 - i);
  const out = squarify(vals, { x: 0, y: 0, w: 800, h: 500 });
  const ratios = out.map((r) => Math.max(r.w / r.h, r.h / r.w));
  const median = ratios.sort((a, b) => a - b)[15];
  assert(median < 2.5, 'median aspect ratio ' + median);
});

test('treemap: empty input, zero-size space', () => {
  assert.deepStrictEqual(squarify([], { x: 0, y: 0, w: 10, h: 10 }), []);
  assert.strictEqual(squarify([1, 2], { x: 0, y: 0, w: 0, h: 10 })[0].w, 0);
});

// ---- types --------------------------------------------------------------------------------------------------------------
test('file types: names land in the right group, case and odd names included', () => {
  const g = (n) => T.GROUPS[T.groupOf(n)];
  const cases = {
    'Holiday.MP4': 'video', 'a.mkv': 'video', 'x.mp3': 'audio', 'track.FLAC': 'audio', 'IMG_0001.JPG': 'images', 'raw.cr2': 'images',
    'backup.zip': 'archives', 'disk.iso': 'archives', 'big.7z.001': 'archives', 'part.r01': 'archives', 'site.tar.gz': 'archives',
    'main.rs': 'code', 'data.json': 'code', 'report.pdf': 'documents', 'notes.TXT': 'documents', 'book.xlsx': 'documents',
    'setup.exe': 'apps', 'lib.dll': 'apps', 'tool.AppImage': 'apps', 'film.mp4.part': 'video',
    '.bashrc': 'other', 'README': 'other', 'weird.': 'other', 'thing.unknownext': 'other', 'a.b c': 'other',
  };
  for (const [name, want] of Object.entries(cases)) assert.strictEqual(g(name), want, name);
  assert.strictEqual(T.extOf('Archive.TAR.GZ'), 'gz');
  assert.strictEqual(T.extOf('.hidden'), '');
  assert.strictEqual(T.GROUPS.length, T.LABELS.length); assert.strictEqual(T.GROUPS.length, T.COLORS.length);
});

// ---- protected folders ---------------------------------------------------------------------------------------------------
test('protected folders (Windows rules): system folders, drive roots, the user folder itself are refused; normal folders are not', () => {
  const o = { platform: 'win32', home: 'C:\\Users\\Ann', env: { SystemRoot: 'C:\\Windows', ProgramFiles: 'C:\\Program Files', 'ProgramFiles(x86)': 'C:\\Program Files (x86)', ProgramData: 'C:\\ProgramData', APPDATA: 'C:\\Users\\Ann\\AppData\\Roaming', LOCALAPPDATA: 'C:\\Users\\Ann\\AppData\\Local' } };
  const refused = ['C:\\', 'C:', 'D:\\', 'C:\\Windows', 'c:\\windows\\System32', 'C:\\WINDOWS\\Temp\\x', 'C:\\Program Files', 'C:\\Program Files\\App\\app.exe',
    'C:\\Program Files (x86)\\Steam', 'C:\\ProgramData', 'C:\\Users', 'C:\\Users\\Ann', 'C:\\Users\\Ann\\', 'C:\\Users\\Ann\\AppData', 'C:\\Users\\Ann\\AppData\\Local',
    'C:\\Users\\Ann\\Documents', 'C:\\pagefile.sys', 'C:\\$Recycle.Bin', '\\\\server\\share'];
  for (const p of refused) assert(protectedReason(p, o), 'should refuse ' + p);
  const allowed = ['C:\\Users\\Ann\\Downloads\\big.iso', 'C:\\Users\\Ann\\Videos\\Old', 'D:\\Games\\Old', 'C:\\Users\\Ann\\AppData\\Local\\Temp\\junk', 'C:\\Windows.old', 'C:\\Users\\Ann\\Documents\\x.pdf'];
  for (const p of allowed) assert.strictEqual(protectedReason(p, o), '', 'should allow ' + p);
  assert(/system/i.test(protectedReason('C:\\Windows', o)));
});

test('protected folders (Linux rules): /usr, /bin, /etc, home itself and its parents are refused; things inside home are not', () => {
  const o = { platform: 'linux', home: '/home/ann', env: {} };
  const refused = ['/', '/usr', '/usr/lib/x.so', '/bin', '/bin/', '/etc/passwd', '/boot', '/home', '/home/ann', '/home/ann/', '/var/lib/apt', '/proc/1', '/home/ann/.config', '/root'];
  for (const p of refused) assert(protectedReason(p, o), 'should refuse ' + p);
  const allowed = ['/home/ann/Videos', '/home/ann/Downloads/old.iso', '/home/ann/.cache', '/mnt/data/old', '/tmp/x', '/home/ann/.config/app/cache', '/usrdata/x', '/var/cache/apt/archives/a.deb'];
  for (const p of allowed) assert.strictEqual(protectedReason(p, o), '', 'should allow ' + p);
  assert(protectedReason('', o)); assert(protectedReason(null, o));
});

// ---- drives -------------------------------------------------------------------------------------------------------------
test('drives: /proc/mounts is read for real file systems only, with escaped names', () => {
  const text = [
    'proc /proc proc rw 0 0', 'sysfs /sys sysfs rw 0 0', '/dev/sda1 / ext4 rw 0 0', 'tmpfs /run tmpfs rw 0 0',
    '/dev/sdb1 /media/ann/My\\040Disk vfat rw 0 0', '/dev/loop3 /snap/core/1 squashfs ro 0 0', '/dev/sda2 /boot/efi vfat rw 0 0',
    '/dev/sdc1 /mnt/data ntfs3 rw 0 0', '/dev/sda1 / ext4 rw 0 0',
  ].join('\n');
  const m = parseMounts(text);
  assert.deepStrictEqual(m.map((x) => x.path), ['/', '/media/ann/My Disk', '/mnt/data']);
  const real = listDrives();
  assert(real.length >= 1, 'this computer has at least one drive');
  assert(real.every((d) => d.total > 0 && d.free >= 0 && d.free <= d.total));
});

(async () => {
  let failed = 0;
  for (const [name, fn] of tests) {
    const t0 = Date.now();
    try { await fn(); console.log(`ok   ${name} (${Date.now() - t0} ms)`); }
    catch (e) { failed++; console.log(`FAIL ${name}\n     ${String((e && e.stack) || e).split('\n').slice(0, 6).join('\n     ')}`); }
  }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  for (const n of notes) console.log('note: ' + n);
  console.log(failed ? `\n${failed} of ${tests.length} failed` : `\nall ${tests.length} passed`);
  process.exit(failed ? 1 : 0);
})();
