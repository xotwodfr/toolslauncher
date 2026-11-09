'use strict';
// Duplicate Finder core tests: real files in a temp folder, real hashing, real ffmpeg and real tags for the music part.
// The safety promises (never delete the last copy, protected folders, files that changed, byte-for-byte check) each have
// a test that tries to break them.
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { walk, TYPES } = require('../src/walk');
const { findExact } = require('../src/exact');
const Rules = require('../src/rules');
const Trash = require('../src/trash');
const Similar = require('../src/similar');
const { imageSize } = require('../src/imgsize');
const Music = require('../src/music');
const Scan = require('../src/scan');
const Cache = require('../src/cache');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dupefinder-test-'));
const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const near = (a, b, tol, msg) => assert(Math.abs(a - b) <= tol, `${msg || ''} expected ${b} +/- ${tol}, got ${a}`);
const ff = Music.ffmpegPath();
const sh = (args) => { const r = spawnSync(ff, ['-hide_banner', '-y', '-v', 'error', ...args], { encoding: 'utf8', windowsHide: true }); assert.strictEqual(r.status, 0, 'ffmpeg failed: ' + r.stderr.slice(-300)); };

let n = 0;
const dir = (...p) => { const d = path.join(tmp, ...p); fs.mkdirSync(d, { recursive: true }); return d; };
const put = (file, data, mtime) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data);
  if (mtime) fs.utimesSync(file, new Date(mtime), new Date(mtime));
  return file;
};
const rnd = (size) => crypto.randomBytes(size);
const rec = (file, extra = {}) => { const st = fs.statSync(file); return { path: file, size: st.size, mtimeMs: st.mtimeMs, keep: false, root: 0, ...extra }; };
const names = (g) => g.files.map((f) => path.basename(f.path)).sort();
const resetDir = (name) => { const d = path.join(tmp, name + (++n)); fs.mkdirSync(d, { recursive: true }); return d; };

// ---- walking ---------------------------------------------------------------------------------------------------------
test('walk: lists files in folders and sub-folders, with size and time', async () => {
  const d = resetDir('walk');
  put(path.join(d, 'a.txt'), 'hello'); put(path.join(d, 'sub', 'deep', 'b.bin'), rnd(100)); put(path.join(d, 'sub', 'c.mp3'), rnd(10));
  const r = await walk([{ path: d }]);
  assert.deepStrictEqual(r.files.map((f) => path.basename(f.path)).sort(), ['a.txt', 'b.bin', 'c.mp3']);
  const a = r.files.find((f) => f.path.endsWith('a.txt'));
  assert.strictEqual(a.size, 5); assert(a.mtimeMs > 0); assert.strictEqual(a.keep, false);
});

test('walk: skips junk folders, hidden folders, empty files; honours type and minimum size', async () => {
  const d = resetDir('walk-skip');
  put(path.join(d, 'keep.jpg'), rnd(2000)); put(path.join(d, 'node_modules', 'x.jpg'), rnd(2000)); put(path.join(d, '.git', 'y.jpg'), rnd(2000));
  put(path.join(d, '.hidden', 'z.jpg'), rnd(2000)); put(path.join(d, '$RECYCLE.BIN', 'w.jpg'), rnd(2000));
  put(path.join(d, 'empty.jpg'), Buffer.alloc(0)); put(path.join(d, 'tiny.jpg'), rnd(10)); put(path.join(d, 'song.mp3'), rnd(5000));
  const all = (await walk([{ path: d }], { minSize: 1 })).files.map((f) => path.basename(f.path)).sort();
  assert.deepStrictEqual(all, ['keep.jpg', 'song.mp3', 'tiny.jpg']);
  const imgs = (await walk([{ path: d }], { exts: TYPES.images, minSize: 1024 })).files.map((f) => path.basename(f.path));
  assert.deepStrictEqual(imgs, ['keep.jpg']);
  const withHidden = (await walk([{ path: d }], { skipHidden: false })).files.length;
  assert(withHidden > 3, 'hidden folders are included when asked');
});

test('walk: a file reached through two folders is one file, and protection wins', async () => {
  const d = resetDir('walk-overlap');
  put(path.join(d, 'x', 'one.bin'), rnd(50)); put(path.join(d, 'x', 'y', 'two.bin'), rnd(60));
  const r = await walk([{ path: d, keep: false }, { path: path.join(d, 'x'), keep: true }]);
  assert.strictEqual(r.files.length, 2, 'two files, not four');
  assert(r.files.every((f) => f.keep), 'both are inside the protected folder, so protected');
});

test('walk: does not follow junctions/symlinks (no loops, no escaping the folder)', async () => {
  const d = resetDir('walk-links');
  const outside = resetDir('walk-outside');
  put(path.join(outside, 'secret.bin'), rnd(100)); put(path.join(d, 'real.bin'), rnd(100));
  try { fs.symlinkSync(outside, path.join(d, 'link'), 'junction'); } catch { return 'skipped: cannot create a link here'; }
  try { fs.symlinkSync(d, path.join(d, 'loop'), 'junction'); } catch { /* one link is enough */ }
  const r = await walk([{ path: d }]);
  assert.deepStrictEqual(r.files.map((f) => path.basename(f.path)), ['real.bin']);
  assert(r.skippedLinks >= 1, 'links are counted');
});

test('walk: hard links to one file count once', async () => {
  const d = resetDir('walk-hard');
  const a = put(path.join(d, 'a.bin'), rnd(100));
  try { fs.linkSync(a, path.join(d, 'b.bin')); } catch { return 'skipped: no hard links here'; }
  const r = await walk([{ path: d }]);
  assert.strictEqual(r.files.length, 1);
  assert.strictEqual(r.files[0].links, 2);
});

test('walk: can be cancelled', async () => {
  const d = resetDir('walk-cancel');
  for (let i = 0; i < 20; i++) put(path.join(d, `f${i}.bin`), rnd(10));
  const ac = new AbortController(); ac.abort();
  await assert.rejects(() => walk([{ path: d }], { signal: ac.signal }), (e) => e.cancelled === true);
});

// ---- exact duplicates ---------------------------------------------------------------------------------------------------
test('exact: same content in different folders and names is a group; different content is not', async () => {
  const d = resetDir('exact');
  const data = rnd(5000);
  put(path.join(d, 'a', 'photo.jpg'), data); put(path.join(d, 'b', 'copy of photo.jpg'), data); put(path.join(d, 'c', 'IMG_1.jpg'), data);
  put(path.join(d, 'a', 'other.jpg'), rnd(5000));          // same size, different content
  put(path.join(d, 'a', 'lonely.txt'), rnd(123));
  const files = (await walk([{ path: d }])).files;
  const r = await findExact(files);
  assert.strictEqual(r.groups.length, 1);
  assert.deepStrictEqual(names(r.groups[0]), ['IMG_1.jpg', 'copy of photo.jpg', 'photo.jpg']);
  assert.strictEqual(r.groups[0].size, 5000);
  assert.strictEqual(r.groups[0].kind, 'exact');
});

test('exact: files that differ only in the middle are told apart (big files)', async () => {
  const d = resetDir('exact-middle');
  const base = rnd(400 * 1024);
  const changed = Buffer.from(base); changed[200 * 1024] ^= 0xff;
  put(path.join(d, 'one.bin'), base); put(path.join(d, 'two.bin'), changed); put(path.join(d, 'three.bin'), base);
  const r = await findExact((await walk([{ path: d }])).files);
  assert.strictEqual(r.groups.length, 1);
  assert.deepStrictEqual(names(r.groups[0]), ['one.bin', 'three.bin']);
});

test('exact: empty files and unique sizes are never read, groups are ordered by wasted space', async () => {
  const d = resetDir('exact-order');
  const small = rnd(1000); const big = rnd(50000);
  put(path.join(d, 's1'), small); put(path.join(d, 's2'), small); put(path.join(d, 'b1'), big); put(path.join(d, 'b2'), big); put(path.join(d, 'b3'), big);
  put(path.join(d, 'e1'), Buffer.alloc(0)); put(path.join(d, 'e2'), Buffer.alloc(0));
  const r = await findExact((await walk([{ path: d }], { minSize: 0 })).files);
  assert.strictEqual(r.groups.length, 2, 'the empty files are not a group');
  assert.strictEqual(r.groups[0].size, 50000, 'the group that wastes the most space comes first');
  assert.strictEqual(r.hashed, 5, 'only the 5 files with a twin were read in full');
});

test('exact: a cache makes the second scan free, and a changed file is read again', async () => {
  const d = resetDir('exact-cache');
  const data = rnd(300000);
  const a = put(path.join(d, 'a'), data, '2020-01-01'); put(path.join(d, 'b'), data, '2020-01-02');
  const cache = new Map();
  const first = await findExact((await walk([{ path: d }])).files, { cache });
  assert.strictEqual(first.hashed, 2); assert.strictEqual(first.fromCache, 0);
  const second = await findExact((await walk([{ path: d }])).files, { cache });
  assert.strictEqual(second.hashed, 0); assert.strictEqual(second.fromCache, 2); assert.strictEqual(second.groups.length, 1);
  const edited = Buffer.from(data); edited[150000] ^= 1;
  fs.writeFileSync(a, edited);                                                           // same size, same start and end, new middle, new time
  const third = await findExact((await walk([{ path: d }])).files, { cache });
  assert.strictEqual(third.groups.length, 0, 'no longer identical');
  assert.strictEqual(third.hashed, 1, 'only the changed file was read again');
  const file = path.join(d, '..', 'cache.json');
  Cache.save(file, 1, cache, [...cache.keys()]);
  assert.strictEqual(Cache.load(file, 1).size, cache.size, 'saved and loaded');
  assert.strictEqual(Cache.load(file, 2).size, 0, 'another version is ignored');
});

test('exact: progress is reported and a scan can be cancelled', async () => {
  const d = resetDir('exact-progress');
  const data = rnd(2 * 1024 * 1024);
  for (let i = 0; i < 6; i++) put(path.join(d, `f${i}.bin`), data);
  const phases = new Set();
  await findExact((await walk([{ path: d }])).files, { onProgress: (p) => phases.add(p.phase) });
  assert(phases.has('size') && phases.has('quick') && phases.has('full'), [...phases].join());
  const ac = new AbortController();
  const p = findExact((await walk([{ path: d }])).files, { signal: ac.signal, onProgress: (x) => { if (x.phase === 'full') ac.abort(); } });
  await assert.rejects(p, (e) => e.cancelled === true);
});

test('exact: a file that cannot be read is counted, not fatal', async () => {
  const d = resetDir('exact-gone');
  const data = rnd(2000);
  put(path.join(d, 'a'), data); put(path.join(d, 'b'), data);
  const files = (await walk([{ path: d }])).files;
  fs.rmSync(path.join(d, 'b'));            // disappears between listing and reading
  const r = await findExact(files);
  assert.strictEqual(r.groups.length, 0); assert.strictEqual(r.unreadable, 1);
});

// ---- which copy to keep -----------------------------------------------------------------------------------------------
test('rules: oldest, newest, shortest path, first folder, best quality', () => {
  const mk = (id, p, m, root, extra = {}) => ({ id, path: p, size: 10, mtimeMs: m, keep: false, root, ...extra });
  const g = { files: [mk(1, '/a/long/path/x.jpg', 300, 1, { pixels: 100 }), mk(2, '/b/x.jpg', 100, 2, { pixels: 400 }), mk(3, '/c/deeper/x.jpg', 200, 0, { pixels: 200 })] };
  assert.strictEqual(Rules.pickKeeper(g.files, 'oldest').id, 2);
  assert.strictEqual(Rules.pickKeeper(g.files, 'newest').id, 1);
  assert.strictEqual(Rules.pickKeeper(g.files, 'shortest').id, 2);
  assert.strictEqual(Rules.pickKeeper(g.files, 'firstroot').id, 3);
  assert.strictEqual(Rules.pickKeeper(g.files, 'best').id, 2);
  assert.deepStrictEqual(Rules.suggestTrash(g, 'oldest').sort(), [1, 3]);
  const tie = { files: [mk(5, '/z', 1, 0), mk(4, '/a', 1, 0)] };
  assert.deepStrictEqual(Rules.suggestTrash(tie, 'oldest'), [5], 'ties keep the first path alphabetically');
});

test('rules: a copy in a protected folder is always the one that stays; the rest are suggested', () => {
  const g = { files: [{ id: 1, path: '/p/a', size: 1, mtimeMs: 5, keep: true, root: 0 }, { id: 2, path: '/q/a', size: 1, mtimeMs: 1, keep: false, root: 1 }, { id: 3, path: '/r/a', size: 1, mtimeMs: 2, keep: false, root: 2 }] };
  for (const rule of Object.keys(Rules.RULES)) assert.deepStrictEqual(Rules.suggestTrash(g, rule).sort(), [2, 3], rule);
  const allSafe = { files: [{ id: 1, path: '/p/a', size: 1, mtimeMs: 5, keep: true, root: 0 }, { id: 2, path: '/p2/a', size: 1, mtimeMs: 1, keep: true, root: 0 }] };
  assert.deepStrictEqual(Rules.suggestTrash(allSafe, 'oldest'), [], 'nothing is suggested when every copy is protected');
  for (const rule of Object.keys(Rules.RULES)) {
    const sel = Rules.suggestAll([{ files: [{ id: 1, path: 'a', size: 1, mtimeMs: 1, keep: false, root: 0 }, { id: 2, path: 'b', size: 1, mtimeMs: 2, keep: false, root: 0 }] }], rule);
    assert.strictEqual(sel.size, 1, rule + ' never selects everything');
  }
});

// ---- moving to the Recycle Bin: the safety checks --------------------------------------------------------------------------
/** Build scan-like groups from real files and a fake "recycle bin" that moves files into a folder. */
function setup(contents, { protectedIdx = [] } = {}) {
  const d = resetDir('trash');
  const bin = path.join(d, '_bin'); fs.mkdirSync(bin);
  const files = contents.map((c, i) => { const f = put(path.join(d, `f${i}.dat`), c, '2021-05-05'); return { id: i + 1, ...rec(f, { keep: protectedIdx.includes(i) }) }; });
  const group = { id: 1, kind: 'exact', files };
  const trashed = [];
  const trashItem = async (p) => { trashed.push(p); fs.renameSync(p, path.join(bin, path.basename(p))); };
  return { d, bin, files, group, trashItem, trashed };
}

test('trash: moves the selected copies and leaves one', async () => {
  const s = setup([rnd(3000)].concat([null, null]).map((x, i, a) => a[0]));
  const plan = Trash.planTrash([s.group], [2, 3]);
  assert.strictEqual(plan.items.length, 2); assert.strictEqual(plan.bytes, 6000); assert.deepStrictEqual(plan.problems, []);
  const r = await Trash.executeTrash(plan, { trashItem: s.trashItem });
  assert.strictEqual(r.moved.length, 2); assert.strictEqual(r.skipped.length, 0);
  assert(fs.existsSync(s.files[0].path), 'the copy that stays is still there');
  assert(!fs.existsSync(s.files[1].path) && !fs.existsSync(s.files[2].path));
});

test('trash: selecting every copy of a group is refused', async () => {
  const s = setup([rnd(100), null, null].map((x, i, a) => a[0]));
  const plan = Trash.planTrash([s.group], [1, 2, 3]);
  assert.strictEqual(plan.items.length, 0);
  assert(plan.problems.some((p) => /At least one copy must stay/.test(p)));
  assert.strictEqual(s.trashed.length, 0);
});

test('trash: files in protected folders and system folders are refused', async () => {
  const s = setup([rnd(100), null].map((x, i, a) => a[0]), { protectedIdx: [0] });
  const p1 = Trash.planTrash([s.group], [1]);
  assert.strictEqual(p1.items.length, 0); assert(p1.problems.some((p) => /protected/.test(p)));
  const s2 = setup([rnd(100), null].map((x, i, a) => a[0]));
  const p2 = Trash.planTrash([s2.group], [2], { dirs: [path.resolve(s2.d)] });
  assert.strictEqual(p2.items.length, 0); assert(p2.problems.some((p) => /system folder/.test(p)));
  assert(Trash.isSystemPath(process.platform === 'win32' ? path.join(process.env.SystemRoot, 'System32', 'x.dll') : '/usr/lib/x.so'));
  assert(!Trash.isSystemPath(path.join(os.homedir(), 'Pictures', 'a.jpg')));
});

test('trash: a file changed after the scan is skipped (size, or time)', async () => {
  const s = setup([rnd(500), null, null].map((x, i, a) => a[0]));
  const plan = Trash.planTrash([s.group], [2, 3]);
  fs.appendFileSync(s.files[1].path, 'x');                                   // grew
  fs.utimesSync(s.files[2].path, new Date('2030-01-01'), new Date('2030-01-01')); // touched
  const r = await Trash.executeTrash(plan, { trashItem: s.trashItem });
  assert.strictEqual(r.moved.length, 0); assert.strictEqual(r.skipped.length, 2);
  assert(r.skipped.every((k) => /changed after the scan/.test(k.reason)), JSON.stringify(r.skipped));
  assert.strictEqual(s.trashed.length, 0);
});

test('trash: byte-for-byte check catches a file that was edited to the same size with the old time restored', async () => {
  const s = setup([rnd(2000), null].map((x, i, a) => a[0]));
  const plan = Trash.planTrash([s.group], [2]);
  const edited = Buffer.from(fs.readFileSync(s.files[1].path)); edited[1000] ^= 1;
  fs.writeFileSync(s.files[1].path, edited);
  fs.utimesSync(s.files[1].path, new Date(s.files[1].mtimeMs), new Date(s.files[1].mtimeMs));
  const r = await Trash.executeTrash(plan, { trashItem: s.trashItem });
  assert.strictEqual(r.moved.length, 0);
  assert(/not identical/.test(r.skipped[0].reason), r.skipped[0].reason);
  assert(fs.existsSync(s.files[1].path), 'it was left alone');
});

test('trash: if the copy that stays has disappeared, nothing is moved', async () => {
  const s = setup([rnd(300), null, null].map((x, i, a) => a[0]));
  const plan = Trash.planTrash([s.group], [2, 3]);
  fs.rmSync(s.files[0].path);                                                // the only keeper vanishes
  const r = await Trash.executeTrash(plan, { trashItem: s.trashItem });
  assert.strictEqual(r.moved.length, 0);
  assert(r.skipped.every((k) => /no other copy/.test(k.reason)), JSON.stringify(r.skipped));
  assert(fs.existsSync(s.files[1].path) && fs.existsSync(s.files[2].path));
});

test('trash: never removes the last copy even when several are selected and the keeper is one of them', async () => {
  // group of 3, the user selects 2 and 3; between plan and run file 1 (the keeper) is replaced by a different file
  const s = setup([rnd(300), null, null].map((x, i, a) => a[0]));
  const plan = Trash.planTrash([s.group], [2, 3]);
  fs.writeFileSync(s.files[0].path, rnd(300)); fs.utimesSync(s.files[0].path, new Date(s.files[0].mtimeMs), new Date(s.files[0].mtimeMs));
  const r = await Trash.executeTrash(plan, { trashItem: s.trashItem });
  assert.strictEqual(r.moved.length, 0, 'the "twin" is no longer identical, so nothing is moved');
});

test('trash: look-alikes (not byte-identical by nature) skip the byte check but keep all the others', async () => {
  const s = setup([rnd(100), rnd(120)]);
  s.group.kind = 'look-alike';
  const plan = Trash.planTrash([s.group], [2]);
  const r = await Trash.executeTrash(plan, { trashItem: s.trashItem });
  assert.strictEqual(r.moved.length, 1); assert(fs.existsSync(s.files[0].path));
});

test('trash: a failing trash call is reported per file and the rest carry on; abort stops', async () => {
  const s = setup([rnd(100), null, null, null].map((x, i, a) => a[0]));
  let calls = 0;
  const flaky = async (p) => { if (++calls === 1) throw new Error('Access is denied'); return s.trashItem(p); };
  const plan = Trash.planTrash([s.group], [2, 3, 4]);
  const r = await Trash.executeTrash(plan, { trashItem: flaky });
  assert.strictEqual(r.moved.length, 2); assert.strictEqual(r.skipped.length, 1); assert(/Access is denied/.test(r.skipped[0].reason));
  const s2 = setup([rnd(100), null, null].map((x, i, a) => a[0]));
  const ac = new AbortController(); ac.abort();
  const r2 = await Trash.executeTrash(Trash.planTrash([s2.group], [2, 3]), { trashItem: s2.trashItem, signal: ac.signal });
  assert.strictEqual(r2.moved.length, 0); assert.strictEqual(r2.skipped.length, 2);
});

test('trash: sameBytes', async () => {
  const d = resetDir('same'); const a = put(path.join(d, 'a'), rnd(3 * 1024 * 1024 + 7));
  const b = put(path.join(d, 'b'), fs.readFileSync(a)); const c = Buffer.from(fs.readFileSync(a)); c[c.length - 1] ^= 1; put(path.join(d, 'c'), c);
  assert.strictEqual(await Trash.sameBytes(a, b), true);
  assert.strictEqual(await Trash.sameBytes(a, path.join(d, 'c')), false);
});

// ---- look-alike pictures ------------------------------------------------------------------------------------------------
/** A synthetic 32x32 "picture": a few soft blobs, so it has shape. `seed` picks the layout. */
function blobs(seed, noise = 0, bright = 0) {
  const g = new Float64Array(32 * 32);
  let s = seed * 7919 + 13;
  const rand = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  const spots = Array.from({ length: 6 }, () => ({ x: rand() * 32, y: rand() * 32, r: 3 + rand() * 6, v: 60 + rand() * 180 }));
  let nz = 99;
  const nrand = () => { nz = (nz * 1103515245 + 12345) & 0x7fffffff; return nz / 0x7fffffff - 0.5; };
  for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) {
    let v = 30;
    for (const p of spots) v += p.v * Math.exp(-(((x - p.x) ** 2 + (y - p.y) ** 2) / (2 * p.r * p.r)));
    g[y * 32 + x] = Math.max(0, Math.min(255, v + bright + nrand() * noise));
  }
  return g;
}

test('similar: a picture and its recompressed / brightened copy are close, different pictures are far', () => {
  const a = Similar.dhash(blobs(1));
  const noisy = Similar.dhash(blobs(1, 6));
  const bright = Similar.dhash(blobs(1, 0, 20));
  assert(Similar.distance(a, noisy) <= 6, 'noise: ' + Similar.distance(a, noisy));
  assert(Similar.distance(a, bright) <= 6, 'brightness: ' + Similar.distance(a, bright));
  let far = 0;
  for (let s = 2; s < 12; s++) if (Similar.distance(a, Similar.dhash(blobs(s))) >= 16) far++;
  assert(far >= 8, 'most other pictures are far away: ' + far + '/10');
  assert.strictEqual(Similar.distance(a, a), 0);
});

test('similar: flat pictures are flagged, hex round trip, popcount', () => {
  assert.strictEqual(Similar.dhash(new Uint8Array(1024).fill(255)).flat, true);
  assert.strictEqual(Similar.dhash(blobs(3)).flat, false);
  const h = Similar.dhash(blobs(4));
  assert.deepStrictEqual(Similar.fromHex(Similar.toHex(h)), { hi: h.hi, lo: h.lo });
  assert.strictEqual(Similar.toHex({ hi: 1, lo: 255 }), '00000001000000ff');
  assert.strictEqual(Similar.popcount(0xffffffff), 32); assert.strictEqual(Similar.popcount(0), 0); assert.strictEqual(Similar.popcount(0x80000001), 2);
});

test('similar: grouping by threshold, flat and odd-shaped pictures left out, chains not followed too far', () => {
  const mk = (g, w = 100, h = 100, extra = {}) => ({ ...Similar.dhash(g), w, h, ...extra });
  const items = [mk(blobs(1)), mk(blobs(1, 6)), mk(blobs(1, 0, 15)), mk(blobs(2)), mk(blobs(2, 5)), mk(blobs(9)),
    { ...mk(blobs(1)), w: 300, h: 100 },                                   // same hash, very different shape
    mk(new Uint8Array(1024).fill(200)), mk(new Uint8Array(1024).fill(200))]; // two blank pictures
  const groups = Similar.group(items, 8);
  const sets = groups.map((g) => g.members.join(','));
  assert(sets.includes('0,1,2'), sets.join(' | '));
  assert(sets.includes('3,4'), sets.join(' | '));
  assert(!groups.some((g) => g.members.includes(6)), 'a different shape is not a look-alike');
  assert(!groups.some((g) => g.members.includes(7) || g.members.includes(8)), 'blank pictures are not matched');
  assert(!groups.some((g) => g.members.includes(5)), 'a unique picture stays out');
  assert(Similar.group(items, 0).every((g) => g.maxDistance === 0), 'strict 0 bits: only identical hashes match');
  // chain A-B-C-D, each pair of neighbours 4 bits apart: no picture is more than 4 bits from the group's first
  const bits = (n) => ({ hi: 0, lo: n >>> 0, w: 1, h: 1, flat: false });
  const chain = [bits(0), bits(0b1111), bits(0b11111111), bits(0b111111111111)];
  const cg = Similar.group(chain, 4);
  assert(cg.every((g) => g.members.every((m) => Similar.distance(chain[g.members[0]], chain[m]) <= 8)));
  assert(cg.length >= 1 && !cg.some((g) => g.members.length === 4), 'the chain is not swallowed whole');
});

test('similar: 3000 pictures compare quickly', () => {
  const items = Array.from({ length: 3000 }, (_, i) => ({ hi: (Math.imul(i, 2654435761) >>> 0), lo: (Math.imul(i, 40503) >>> 0), w: 10, h: 10, flat: false }));
  const t0 = Date.now();
  Similar.group(items, 8);
  assert(Date.now() - t0 < 3000, 'took ' + (Date.now() - t0) + ' ms');
});

test('picture sizes read from headers: PNG, JPEG, GIF, BMP, WebP, and EXIF rotation', () => {
  const dirp = resetDir('img');
  const out = {};
  for (const ext of ['png', 'jpg', 'gif', 'bmp', 'webp']) { out[ext] = path.join(dirp, 'p.' + ext); sh(['-f', 'lavfi', '-i', 'testsrc=size=96x64:duration=1', '-frames:v', '1', out[ext]]); }
  for (const [ext, f] of Object.entries(out)) assert.deepStrictEqual(imageSize(new Uint8Array(fs.readFileSync(f))), { w: 96, h: 64 }, ext);
  // a JPEG whose EXIF says "turned 90 degrees" is shown 64 x 96
  const jpg = fs.readFileSync(out.jpg);
  const tiff = Buffer.from([0x49, 0x49, 0x2a, 0, 8, 0, 0, 0, 1, 0, 0x12, 0x01, 3, 0, 1, 0, 0, 0, 6, 0, 0, 0, 0, 0, 0, 0]);
  const app1 = Buffer.concat([Buffer.from('Exif\0\0'), tiff]);
  const seg = Buffer.concat([Buffer.from([0xff, 0xe1, (app1.length + 2) >> 8, (app1.length + 2) & 255]), app1]);
  const rotated = Buffer.concat([jpg.subarray(0, 2), seg, jpg.subarray(2)]);
  assert.deepStrictEqual(imageSize(new Uint8Array(rotated)), { w: 64, h: 96 });
  assert.strictEqual(imageSize(new Uint8Array(10)), null); assert.strictEqual(imageSize(new Uint8Array(100)), null);
});

test('photos: grouping through the scan module keeps the biggest picture first', () => {
  const mk = (p, g, w, h, size) => ({ path: p, size, mtimeMs: 1, keep: false, root: 0, hex: Similar.toHex(Similar.dhash(g)), w, h, flat: false });
  const groups = Scan.groupPhotos([mk('/a/small.jpg', blobs(1, 3), 400, 300, 50), mk('/a/big.jpg', blobs(1), 4000, 3000, 900), mk('/a/other.jpg', blobs(7), 400, 300, 40)], 8);
  assert.strictEqual(groups.length, 1);
  assert.deepStrictEqual(groups[0].files.map((f) => path.basename(f.path)), ['big.jpg', 'small.jpg']);
  assert.strictEqual(groups[0].kind, 'look-alike');
  assert.strictEqual(groups[0].files[0].pixels, 12000000);
});

// ---- songs ----------------------------------------------------------------------------------------------------------------
test('music: text is compared without case, accents or punctuation', () => {
  assert.strictEqual(Music.normalizeText('Beyoncé – Halo!'), 'beyonce halo');
  assert.strictEqual(Music.normalizeText('  AC/DC  '), 'ac dc');
  assert.strictEqual(Music.normalizeText('Rock & Roll'), 'rock and roll');
  assert.strictEqual(Music.normalizeText('日本語 の 歌'), '日本語 の 歌');
  assert.strictEqual(Music.normalizeText(null), '');
});

test('music: grouping by tags and length, by identical audio, and by both', () => {
  const e = (name, artist, title, ms, md5 = '', extra = {}) => ({ rec: { path: '/m/' + name, size: 4e6, mtimeMs: 1, keep: false, root: 0 }, tags: { artist, title, album: '', durationMs: ms, bitrate: 192, sampleRate: 44100, codec: 'MPEG Version 1 Audio, Layer 3', ...extra }, md5 });
  const entries = [
    e('a.mp3', 'The Band', 'Song One', 200000), e('b.flac', 'the band', 'SONG one!', 201500, '', { codec: 'Flac Audio', bitrate: 900 }),   // same song, 1.5 s apart
    e('c.mp3', 'The Band', 'Song One', 260000),                                                                                            // same tags but a different length: a different version
    e('d.mp3', 'X', 'Y', 100000, 'aaaa'), e('e.mp3', 'Other', 'Name', 100020, 'aaaa'),                                                       // identical audio, different tags
    e('f.mp3', '', '', 50000), e('g.mp3', '', '', 50000),                                                                                    // no tags at all, no md5: not matched
    e('h.mp3', 'Q', 'R', 70000, 'bbbb'), e('i.mp3', 'Q', 'R', 70000, 'bbbb'),                                                               // both: identical
  ];
  const groups = Music.groupSongs(entries);
  const by = (k) => groups.filter((g) => g.kind === k).map((g) => g.files.map((f) => path.basename(f.path)).sort().join('+'));
  assert.deepStrictEqual(by('same-song'), ['a.mp3+b.flac']);
  assert.deepStrictEqual(by('identical').sort(), ['d.mp3+e.mp3', 'h.mp3+i.mp3']);
  assert.strictEqual(groups.length, 3);
  const song = groups.find((g) => g.kind === 'same-song');
  assert.strictEqual(path.basename(song.files[0].path), 'b.flac', 'lossless first');
  assert(song.files[0].quality > song.files[1].quality);
});

test('music: real files - tags, decoded-audio hash, and the three kinds of match', async () => {
  const d = resetDir('music');
  const tone = (name, hz, meta = {}, codec = ['-c:a', 'libmp3lame', '-b:a', '128k']) => {
    const f = path.join(d, name);
    const m = Object.entries(meta).flatMap(([k, v]) => ['-metadata', `${k}=${v}`]);
    sh(['-f', 'lavfi', '-i', `sine=frequency=${hz}:duration=3`, ...codec, ...m, f]);
    return f;
  };
  const a = tone('A.mp3', 440, { title: 'Real Song', artist: 'Some Artist' });
  tone('B.flac', 440, { title: 'real song', artist: 'SOME ARTIST' }, ['-c:a', 'flac']);
  const c = path.join(d, 'C copy.mp3');
  sh(['-i', a, '-c', 'copy', '-map_metadata', '-1', '-metadata', 'title=Different Name', '-metadata', 'artist=Nobody', c]); // same audio data, different tags
  tone('D.mp3', 880, { title: 'Another', artist: 'Someone' });
  assert.strictEqual(await Music.audioHash(a), await Music.audioHash(c), 'same audio, different tags: same hash');
  assert.notStrictEqual(await Music.audioHash(a), await Music.audioHash(path.join(d, 'D.mp3')));
  const t = Music.readTags({ path: a });
  assert.strictEqual(t.title, 'Real Song'); assert.strictEqual(t.artist, 'Some Artist'); near(t.durationMs, 3000, 120);
  const r = await Scan.scan('music', [{ path: d }], {});
  assert.strictEqual(r.groups.length, 1, JSON.stringify(r.groups.map((g) => g.files.map((f) => f.path))));
  assert.deepStrictEqual(r.groups[0].files.map((f) => path.basename(f.path)).sort(), ['A.mp3', 'B.flac', 'C copy.mp3']);
  assert.strictEqual(r.groups[0].kind, 'same-song');
  assert.strictEqual(path.basename(r.groups[0].files[0].path), 'B.flac');
  const cacheFile = path.join(d, '..', 'music-cache.json');
  const first = await Scan.scan('music', [{ path: d }], {}, { cacheFile });
  const second = await Scan.scan('music', [{ path: d }], {}, { cacheFile });
  assert.strictEqual(second.groups.length, first.groups.length);
  assert(fs.existsSync(cacheFile), 'cache written');
});

test('scan: files mode end to end, with type filter, minimum size and a protected folder', async () => {
  const d = resetDir('scan');
  const pic = rnd(4000); const doc = rnd(4000);
  put(path.join(d, 'keepme', 'pic.jpg'), pic); put(path.join(d, 'downloads', 'pic (1).jpg'), pic); put(path.join(d, 'downloads', 'doc.txt'), doc); put(path.join(d, 'x', 'doc.txt'), doc);
  const all = await Scan.scan('files', [{ path: path.join(d, 'keepme'), keep: true }, { path: path.join(d, 'downloads') }, { path: path.join(d, 'x') }], {});
  assert.strictEqual(all.groups.length, 2); assert.strictEqual(all.stats.files, 4);
  const picGroup = all.groups.find((g) => g.files.some((f) => f.path.endsWith('pic.jpg')));
  assert.deepStrictEqual(picGroup.files.map((f) => f.keep).sort(), [false, true]);
  const onlyImages = await Scan.scan('files', [{ path: d }], { type: 'images' });
  assert.strictEqual(onlyImages.groups.length, 1);
  const big = await Scan.scan('files', [{ path: d }], { minSize: 1048576 });
  assert.strictEqual(big.groups.length, 0);
  const odd = Scan.cleanOptions({ type: 'nonsense', minSize: 7, threshold: 99 });
  assert.deepStrictEqual(odd, { type: 'all', minSize: 1, skipHidden: true, threshold: 8 });
  await assert.rejects(() => Scan.scan('nope', [{ path: d }], {}), /Unknown mode/);
});

// ---- the window's colours ----------------------------------------------------------------------------------------------
test('colours: text and controls meet WCAG contrast (AA)', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'styles.css'), 'utf8');
  const root = /:root\s*\{([^}]*)\}/.exec(css)[1];
  const v = (name) => { const m = new RegExp('--' + name + ':\\s*(#[0-9a-fA-F]{6})').exec(root); assert(m, 'missing --' + name); return m[1]; };
  const lum = (hex) => { const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((x) => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4)); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05); };
  const pairs = [
    ['text', 'bg', 4.5], ['text', 'panel', 4.5], ['text', 'panel-2', 4.5], ['text', 'del-bg', 4.5],
    ['muted', 'bg', 4.5], ['muted', 'panel', 4.5], ['muted', 'panel-2', 4.5], ['muted', 'del-bg', 4.5],
    ['on-accent', 'accent', 4.5], ['accent', 'bg', 4.5], ['accent', 'panel', 4.5],
    ['err', 'bg', 4.5], ['err', 'panel', 4.5], ['err', 'del-bg', 4.5], ['ok', 'bg', 4.5], ['ok', 'panel', 4.5], ['keep', 'panel', 4.5], ['keep', 'bg', 4.5],
    ['warn', 'bg', 4.5], ['warn', 'panel', 4.5], ['warn', 'panel-2', 4.5],
  ];
  const bad = pairs.filter(([a, b, min]) => ratio(v(a), v(b)) < min).map(([a, b, min]) => `${a} on ${b}: ${ratio(v(a), v(b)).toFixed(2)} < ${min}`);
  assert.deepStrictEqual(bad, []);
  assert(ratio('#ffb3b3', '#3a1f24') >= 4.5, 'text on the red Move button');
});

(async () => {
  let failed = 0;
  for (const [name, fn] of tests) {
    const t0 = Date.now();
    try { const note = await fn(); console.log(`ok   ${name} (${Date.now() - t0} ms)${typeof note === 'string' ? '  [' + note + ']' : ''}`); }
    catch (e) { failed++; console.log(`FAIL ${name}\n     ${String((e && e.stack) || e).split('\n').slice(0, 5).join('\n     ')}`); }
  }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  console.log(failed ? `\n${failed} of ${tests.length} failed` : `\nall ${tests.length} passed`);
  process.exit(failed ? 1 : 0);
})();
