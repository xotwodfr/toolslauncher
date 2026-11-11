'use strict';
// File Encryptor & Hasher core tests (plain Node, no Electron): round trips at every chunk edge, folders with unicode
// names, wrong passwords, truncation / reordering / dropped chunks / flipped bits, cancel, the verify-then-trash path,
// archive path safety, hash known-answer vectors and checksum files in GNU and BSD formats.
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const L = require('../src/locked');
const A = require('../src/archive');
const J = require('../src/jobs');
const H = require('../src/hashing');
const { HashPool } = require('../src/hashpool');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fenc-test-'));
const FAST = { m: 8 * 1024, t: 1, p: 1 }; // smallest accepted settings, to keep the tests quick
const PW = 'correct horse battery staple';
const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const rejects = async (fn, re) => { try { await fn(); } catch (e) { if (re) assert(re.test(e.code + ' ' + e.message), `unexpected error: ${e.code} ${e.message}`); return e; } throw new Error('expected a failure, but it worked'); };
let n = 0;
const fresh = (name) => { const d = path.join(tmp, `${++n}-${name}`); fs.mkdirSync(d, { recursive: true }); return d; };
let masterP = null;
const master = () => masterP || (masterP = L.newMaster(PW, FAST));
const getter = (pw = PW) => L.masterCache(pw);
const encryptFile = async (file, opts = {}) => (await J.encryptItem(await J.plan(file), { master: await master(), ...opts })).output;
const ls = (d) => fs.readdirSync(d).sort();

// ---- round trips at the chunk edges -------------------------------------------------------------------------------
for (const [label, size] of [['empty', 0], ['1 byte', 1], ['exactly 64 KiB', 65536], ['64 KiB + 1', 65537], ['5 MiB + 123', 5 * 1024 * 1024 + 123]]) {
  test(`round trip: ${label} file, original name restored, size as expected`, async () => {
    const d = fresh('rt'); const out = fresh('rt-out');
    const f = path.join(d, `data ${label}.bin`);
    const data = crypto.randomBytes(size); fs.writeFileSync(f, data);
    const locked = await encryptFile(f);
    assert.strictEqual(path.basename(locked), `data ${label}.bin.locked`);
    assert(!fs.readFileSync(locked).includes(Buffer.from(`data ${label}`)), 'the name is encrypted, not in the clear');
    const h = L.parseHeader(fs.readFileSync(locked));
    const metaLen = Buffer.byteLength(JSON.stringify({ v: 1, kind: 'file', name: `data ${label}.bin`, bytes: size, mtime: Math.floor(fs.statSync(f).mtimeMs) }));
    const plain = 4 + metaLen + size;
    const chunks = Math.max(1, Math.ceil(plain / L.CHUNK));
    assert.strictEqual(fs.statSync(locked).size, h.length + plain + chunks * L.TAG, 'header + plaintext + one tag per chunk');
    const r = await J.decryptItem(locked, { getMaster: getter(), outDir: out });
    assert.strictEqual(r.output, path.join(out, `data ${label}.bin`));
    assert.strictEqual(sha(fs.readFileSync(r.output)), sha(data));
    assert(Math.abs(fs.statSync(r.output).mtimeMs - fs.statSync(f).mtimeMs) < 2, 'modified time restored (to the millisecond)');
    assert.deepStrictEqual(ls(out), [`data ${label}.bin`], 'no .part left');
  });
}

test('round trip: plaintext that ends exactly on a chunk boundary (the last chunk is a full one)', async () => {
  const d = fresh('edge');
  const name = 'x.bin';
  const metaLen = (sz, mt) => Buffer.byteLength(JSON.stringify({ v: 1, kind: 'file', name, bytes: sz, mtime: mt }));
  const f = path.join(d, name);
  fs.writeFileSync(f, ''); fs.utimesSync(f, new Date(1700000000000), new Date(1700000000000));
  const mt = Math.floor(fs.statSync(f).mtimeMs);
  let size = 2 * L.CHUNK - 4 - metaLen(2 * L.CHUNK, mt);
  size = 2 * L.CHUNK - 4 - metaLen(size, mt);
  const data = crypto.randomBytes(size); fs.writeFileSync(f, data); fs.utimesSync(f, new Date(mt), new Date(mt));
  const locked = await encryptFile(f);
  const h = L.parseHeader(fs.readFileSync(locked));
  assert.strictEqual(fs.statSync(locked).size - h.length, 2 * L.SEG, 'exactly two full chunks');
  const r = await J.decryptItem(locked, { getMaster: getter(), outDir: fresh('edge-out') });
  assert.strictEqual(sha(fs.readFileSync(r.output)), sha(data));
});

test('round trip: a folder tree with unicode names, sub-folders, an empty folder and an empty file', async () => {
  const root = path.join(fresh('tree'), 'Fotos & Notizen ü');
  const files = {
    'readme.txt': 'hello', 'Ünïcödé näme.md': '# title\n', '日本語/ファイル.txt': '内容', 'emoji 🎉/party 🎈.bin': crypto.randomBytes(70000),
    'deep/a/b/c/leaf.dat': crypto.randomBytes(3), 'deep/empty file': '', 'spaces  and  tabs/x y z.txt': 'z',
  };
  for (const [rel, data] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), data); }
  fs.mkdirSync(path.join(root, 'empty folder'));
  fs.utimesSync(path.join(root, 'readme.txt'), new Date(1600000000000), new Date(1600000000000));
  const item = await J.plan(root);
  assert.strictEqual(item.kind, 'folder'); assert.strictEqual(item.files, 7);
  const locked = (await J.encryptItem(item, { master: await master() })).output;
  assert.strictEqual(path.basename(locked), 'Fotos & Notizen ü.locked');
  const out = fresh('tree-out');
  const r = await J.decryptItem(locked, { getMaster: getter(), outDir: out });
  assert.strictEqual(r.kind, 'folder'); assert.strictEqual(r.files, 7);
  assert.strictEqual(r.output, path.join(out, 'Fotos & Notizen ü'));
  for (const [rel, data] of Object.entries(files)) assert.strictEqual(sha(fs.readFileSync(path.join(r.output, rel))), sha(Buffer.from(data)), rel);
  assert(fs.statSync(path.join(r.output, 'empty folder')).isDirectory());
  assert.strictEqual(Math.floor(fs.statSync(path.join(r.output, 'readme.txt')).mtimeMs), 1600000000000);
  assert.deepStrictEqual(ls(out), ['Fotos & Notizen ü'], 'no temporary folder left');
  // a second decrypt does not overwrite: it picks a new name
  const r2 = await J.decryptItem(locked, { getMaster: getter(), outDir: out });
  assert.strictEqual(path.basename(r2.output), 'Fotos & Notizen ü (2)'); assert(r2.renamed);
});

test('naming: encrypting or decrypting twice never replaces a file ("name (2).ext")', async () => {
  const d = fresh('names'); const f = path.join(d, 'report.pdf'); fs.writeFileSync(f, 'pdf');
  const a = await encryptFile(f); const b = await encryptFile(f);
  assert.deepStrictEqual([path.basename(a), path.basename(b)], ['report.pdf.locked', 'report.pdf (2).locked']);
  const r = await J.decryptItem(a, { getMaster: getter() });
  assert.strictEqual(path.basename(r.output), 'report (2).pdf', 'the original is still there, so a new name');
  assert.strictEqual(fs.readFileSync(f, 'utf8'), 'pdf');
  assert.strictEqual(J.safeName('../../etc/passwd'), 'passwd'); assert.strictEqual(J.safeName('a:b?.txt'), 'a_b_.txt'); assert.strictEqual(J.safeName('CON.txt'), '_CON.txt'); assert.strictEqual(J.safeName('..'), 'decrypted');
});

test('constant memory: a 1 GiB file is encrypted and decrypted with a flat memory use', async () => {
  const d = fresh('big'); const f = path.join(d, 'disk image.img');
  const SIZE = 1024 * 1024 * 1024;
  const fh = fs.openSync(f, 'w'); fs.ftruncateSync(fh, SIZE); fs.writeSync(fh, Buffer.from('start'), 0, 5, 0); fs.writeSync(fh, Buffer.from('end!'), 0, 4, SIZE - 4); fs.closeSync(fh);
  if (global.gc) global.gc();
  const before = process.memoryUsage().rss; let peak = before;
  const tick = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss); }, 20);
  const t0 = Date.now();
  const locked = await encryptFile(f);
  const out = fresh('big-out');
  const r = await J.decryptItem(locked, { getMaster: getter(), outDir: out });
  clearInterval(tick);
  const grew = (peak - before) / 1048576;
  console.log(`     (1 GiB in ${((Date.now() - t0) / 1000).toFixed(1)} s, memory grew by ${grew.toFixed(0)} MB at most)`);
  assert(grew < 120, 'memory grew by ' + grew.toFixed(0) + ' MB');
  assert.strictEqual(fs.statSync(r.output).size, SIZE);
  const rfh = fs.openSync(r.output, 'r'); const a = Buffer.alloc(5); const b = Buffer.alloc(4);
  fs.readSync(rfh, a, 0, 5, 0); fs.readSync(rfh, b, 0, 4, SIZE - 4); fs.closeSync(rfh);
  assert.strictEqual(a.toString() + b.toString(), 'startend!');
  fs.rmSync(d, { recursive: true, force: true }); fs.rmSync(out, { recursive: true, force: true });
});

// ---- wrong password and tampering ---------------------------------------------------------------------------------------
let sample = null;
async function sampleLocked() {
  if (sample) return sample;
  const d = fresh('sample'); const f = path.join(d, 'secret.bin');
  fs.writeFileSync(f, crypto.randomBytes(4 * L.CHUNK + 999));
  sample = { file: f, locked: await encryptFile(f) };
  return sample;
}
async function expectFail(buf, re) {
  const d = fresh('tamper'); const f = path.join(d, 'x.locked'); fs.writeFileSync(f, buf);
  const e = await rejects(() => J.decryptItem(f, { getMaster: getter() }), re);
  assert.deepStrictEqual(ls(d), ['x.locked'], 'nothing was left behind');
  return e;
}

test('a wrong password is refused with a plain message and leaves nothing behind', async () => {
  const { locked } = await sampleLocked();
  const d = fresh('wrong'); const f = path.join(d, 's.locked'); fs.copyFileSync(locked, f);
  const e = await rejects(() => J.decryptItem(f, { getMaster: getter('correct horse battery stapler') }), /wrong-password/);
  assert(/password is wrong/.test(e.message));
  assert.deepStrictEqual(ls(d), ['s.locked']);
  await rejects(() => L.deriveMaster('', Buffer.alloc(32)), /password/);
});

test('truncation exactly at a chunk boundary is detected (and mid-chunk, and extra bytes at the end)', async () => {
  const buf = fs.readFileSync((await sampleLocked()).locked);
  const h = L.parseHeader(buf);
  for (const k of [1, 2, 3, 4]) { const e = await expectFail(buf.subarray(0, h.length + k * L.SEG), /tampered/); assert(/cut short/.test(e.message), e.message); }
  await expectFail(buf.subarray(0, h.length), /damaged/);
  await expectFail(buf.subarray(0, h.length + 2 * L.SEG + 100), /tampered/);
  await expectFail(buf.subarray(0, buf.length - 1), /tampered/);
  await expectFail(Buffer.concat([buf, Buffer.from([0])]), /tampered|damaged/);
  await expectFail(Buffer.concat([buf, buf.subarray(h.length, h.length + L.SEG)]), /tampered/);
  await expectFail(buf.subarray(0, 20), /damaged/);
});

test('swapped, dropped and duplicated chunks are detected', async () => {
  const buf = fs.readFileSync((await sampleLocked()).locked);
  const h = L.parseHeader(buf);
  const seg = (i) => buf.subarray(h.length + i * L.SEG, h.length + (i + 1) * L.SEG);
  const head = buf.subarray(0, h.length); const tail = buf.subarray(h.length + 4 * L.SEG);
  await expectFail(Buffer.concat([head, seg(0), seg(2), seg(1), seg(3), tail]), /tampered/);
  await expectFail(Buffer.concat([head, seg(0), seg(1), seg(3), tail]), /tampered/);
  await expectFail(Buffer.concat([head, seg(0), seg(1), seg(1), seg(2), seg(3), tail]), /tampered/);
  await expectFail(Buffer.concat([head, seg(1), seg(0), seg(2), seg(3), tail]), /wrong-password|tampered/);
  // a chunk taken from ANOTHER file encrypted with the same password does not fit either (own key per file)
  const other = fs.readFileSync(await encryptFile((await sampleLocked()).file));
  const h2 = L.parseHeader(other);
  await expectFail(Buffer.concat([head, seg(0), other.subarray(h2.length + L.SEG, h2.length + 2 * L.SEG), seg(2), seg(3), tail]), /tampered/);
});

test('a flipped bit anywhere (header, any chunk, any tag) is detected', async () => {
  const buf = fs.readFileSync((await sampleLocked()).locked);
  const h = L.parseHeader(buf);
  const spots = [0, 5, 8, 11, 13, 20, h.length - 30, h.length - 2, h.length, h.length + 1000, h.length + L.SEG - 1, h.length + L.SEG + 7, h.length + 3 * L.SEG + 500, buf.length - 17, buf.length - 1];
  for (const i of spots) { const bad = Buffer.from(buf); bad[i] ^= 0x04; await expectFail(bad, /./); }
  // and every byte of the header
  for (let i = 0; i < h.length; i++) { const bad = Buffer.from(buf); bad[i] ^= 0x01; const d = path.join(tmp, 'hdr.locked'); fs.writeFileSync(d, bad); await rejects(() => L.decryptFile(d, { getMaster: getter(), onMeta: () => null })); }
});

test('a hostile header cannot make the app allocate huge memory', async () => {
  const buf = fs.readFileSync((await sampleLocked()).locked);
  const h = L.parseHeader(buf);
  const json = JSON.parse(h.raw.subarray(14).toString());
  json.argon2.m = 64 * 1024 * 1024;
  const hb = Buffer.from(JSON.stringify(json)); const pre = Buffer.from(h.raw.subarray(0, 14)); pre.writeUInt32BE(hb.length, 10);
  assert.throws(() => L.parseHeader(Buffer.concat([pre, hb])), (e) => e.code === 'damaged');
  const v2 = Buffer.from(buf); v2.writeUInt16BE(9, 8);
  assert.throws(() => L.parseHeader(v2), (e) => e.code === 'version');
  assert.throws(() => L.parseHeader(Buffer.from('just some text file content')), (e) => e.code === 'not-locked');
});

test('the format is exactly as FORMAT.md says: an independent reader decrypts chunk 0 with HKDF + prefix||counter', async () => {
  const buf = fs.readFileSync((await sampleLocked()).locked);
  const h = L.parseHeader(buf);
  const masterKey = await L.deriveMaster(PW, h.salt, h.kdf);
  const key = Buffer.from(crypto.hkdfSync('sha256', masterKey, h.fileSalt, Buffer.from('file-encryptor/v1 payload key'), 32));
  const nonce = Buffer.concat([h.noncePrefix, Buffer.from([0, 0, 0, 0])]);
  const aad = Buffer.concat([crypto.createHash('sha256').update(buf.subarray(0, h.length)).digest(), Buffer.from([0])]);
  const seg = buf.subarray(h.length, h.length + L.SEG);
  const d = crypto.createDecipheriv('aes-256-gcm', key, nonce); d.setAAD(aad); d.setAuthTag(seg.subarray(L.CHUNK));
  const plain = Buffer.concat([d.update(seg.subarray(0, L.CHUNK)), d.final()]);
  const metaLen = plain.readUInt32BE(0);
  assert.strictEqual(JSON.parse(plain.subarray(4, 4 + metaLen)).name, 'secret.bin');
  // HKDF-SHA256 itself: RFC 5869 test case 1
  const okm = crypto.hkdfSync('sha256', Buffer.from('0b'.repeat(22), 'hex'), Buffer.from('000102030405060708090a0b0c', 'hex'), Buffer.from('f0f1f2f3f4f5f6f7f8f9', 'hex'), 42);
  assert.strictEqual(Buffer.from(okm).toString('hex'), '3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865');
});

test('argon2id: hash-wasm gives the reference implementation\'s known answer; real settings are 64 MiB, 3 passes', async () => {
  const { argon2id } = require('hash-wasm');
  assert.strictEqual(await argon2id({ password: 'password', salt: 'somesalt', iterations: 2, memorySize: 65536, parallelism: 1, hashLength: 32, outputType: 'hex' }), '09316115d5cf24ed5a15a31a3ba326e5cf32edc24702987c02b6566f61913cf7');
  assert.deepStrictEqual(L.KDF, { m: 65536, t: 3, p: 1 });
  const t0 = Date.now(); const m = await L.newMaster('pw'); console.log(`     (one real key derivation: ${Date.now() - t0} ms)`);
  assert.strictEqual(m.key.length, 32); assert.strictEqual(m.salt.length, 32);
});

test('nonces: every file gets its own salt and nonce prefix, so no key and nonce pair is ever reused', async () => {
  const d = fresh('nonce'); const f = path.join(d, 'a'); fs.writeFileSync(f, 'same content');
  const seen = new Set();
  for (let i = 0; i < 20; i++) { const h = L.parseHeader(fs.readFileSync(await encryptFile(f))); seen.add(h.fileSalt.toString('hex')); seen.add(h.noncePrefix.toString('hex')); }
  assert.strictEqual(seen.size, 40);
});

// ---- cancel, change detection, delete originals ---------------------------------------------------------------------
test('cancel during encryption and during decryption removes the partial output', async () => {
  const d = fresh('cancel'); const f = path.join(d, 'big.bin'); fs.writeFileSync(f, crypto.randomBytes(8 * 1024 * 1024));
  const ac = new AbortController();
  await rejects(async () => J.encryptItem({ path: f, name: 'big.bin', kind: 'file' }, { master: await master(), signal: ac.signal, onBytes: () => ac.abort() }), /cancel/i);
  assert.deepStrictEqual(ls(d), ['big.bin']);
  const locked = await encryptFile(f);
  const out = fresh('cancel-out');
  const ac2 = new AbortController(); let got = 0;
  await rejects(() => J.decryptItem(locked, { getMaster: getter(), outDir: out, signal: ac2.signal, onBytes: (k) => { got += k; if (got > 1e6) ac2.abort(); } }), /cancel/i);
  assert.deepStrictEqual(ls(out), []);
});

test('a file that changes while it is being encrypted is refused (no half-old, half-new result)', async () => {
  const d = fresh('change'); const f = path.join(d, 'live.log'); fs.writeFileSync(f, crypto.randomBytes(3 * 1024 * 1024));
  let once = false;
  await rejects(async () => J.encryptItem({ path: f, name: 'live.log', kind: 'file' }, { master: await master(), onBytes: () => { if (!once) { once = true; fs.appendFileSync(f, 'more'); } } }), /changed while/);
  assert.deepStrictEqual(ls(d), ['live.log']);
});

test('delete originals: only after a full decrypt-check, and only through the trash function', async () => {
  const d = fresh('trash'); const f = path.join(d, 'tax return.pdf'); fs.writeFileSync(f, crypto.randomBytes(200000));
  const folder = path.join(d, 'Scans'); fs.mkdirSync(path.join(folder, 'old'), { recursive: true }); fs.writeFileSync(path.join(folder, 'old', 'a.png'), 'png');
  const binned = [];
  const trash = async (p) => { binned.push(path.basename(p)); fs.renameSync(p, path.join(fresh('bin'), path.basename(p))); };
  const r1 = await J.encryptItem(await J.plan(f), { master: await master(), deleteOriginal: true, trash });
  const r2 = await J.encryptItem(await J.plan(folder), { master: await master(), deleteOriginal: true, trash });
  assert(r1.verified && r1.trashed && r2.verified && r2.trashed);
  assert.deepStrictEqual(binned, ['tax return.pdf', 'Scans']);
  assert.deepStrictEqual(ls(d), ['Scans.locked', 'tax return.pdf.locked']);
  const r = await J.decryptItem(path.join(d, 'Scans.locked'), { getMaster: getter() });
  assert.strictEqual(fs.readFileSync(path.join(r.output, 'old', 'a.png'), 'utf8'), 'png');
  // without the option nothing is deleted
  const g = path.join(d, 'keep.txt'); fs.writeFileSync(g, 'k');
  const r3 = await J.encryptItem(await J.plan(g), { master: await master(), trash: () => { throw new Error('must not be called'); } });
  assert(!r3.trashed && fs.existsSync(g));
  // a folder changed after planning is kept
  const s = path.join(d, 'Changing'); fs.mkdirSync(s); fs.writeFileSync(path.join(s, '1.txt'), '1');
  const item = await J.plan(s);
  const r4 = await J.encryptItem(item, { master: await master(), deleteOriginal: true, trash, onBytes: () => fs.writeFileSync(path.join(s, '2.txt'), 'new file') });
  assert(r4.verified && !r4.trashed && /kept/.test(r4.note)); assert(fs.existsSync(s));
});

// ---- archive safety -------------------------------------------------------------------------------------------------
test('archive: unsafe paths are refused; names Windows cannot store are made safe', async () => {
  for (const bad of ['../x', 'a/../../x', '/etc/passwd', 'a//b', './a', 'C:/x', 'c:x', 'a\\b', 'a\u0000b', '']) assert.throws(() => A.safeParts(bad, 'linux'), /unsafe/, bad);
  assert.deepStrictEqual(A.safeParts('a/b c/d.txt', 'linux'), ['a', 'b c', 'd.txt']);
  assert.deepStrictEqual(A.safeParts('what?/con.txt/x.', 'win32'), ['what_', '_con.txt', 'x_']);
  // a hand-made archive trying to escape its folder writes nothing outside
  const root = fresh('evil-root');
  const evil = Buffer.concat([Buffer.from([2, 0, 9]), Buffer.from('../evil!!'), Buffer.alloc(16)]);
  const u = A.unpacker(root);
  await rejects(() => u.write(evil), /unsafe/);
  assert.deepStrictEqual(ls(root), []);
  assert(!fs.existsSync(path.join(path.dirname(root), 'evil!!')));
  // and an archive cut short is reported
  const u2 = A.unpacker(fresh('short'));
  await u2.write(Buffer.concat([Buffer.from([2, 0, 1]), Buffer.from('f'), Buffer.from([0, 0, 0, 0, 0, 0, 0, 10]), Buffer.alloc(8), Buffer.from('abc')]));
  await rejects(() => u2.end(), /incomplete/);
  await u2.abort();
});

test('archive: links are skipped (and reported) instead of followed', async () => {
  if (process.platform === 'win32') return;
  const root = path.join(fresh('links'), 'L'); fs.mkdirSync(root); fs.writeFileSync(path.join(root, 'real.txt'), 'r');
  fs.symlinkSync('/etc/hostname', path.join(root, 'link'));
  const w = await A.walk(root);
  assert.deepStrictEqual(w.entries.map((e) => e.rel), ['real.txt']);
  assert.deepStrictEqual(w.skipped, ['link (a link)']);
});

// ---- hashing ------------------------------------------------------------------------------------------------------------
test('hashes: known-answer vectors for "" and "abc" (FIPS 180-4, RFC 1321, RFC 7693)', async () => {
  const want = {
    '': { md5: 'd41d8cd98f00b204e9800998ecf8427e', sha1: 'da39a3ee5e6b4b0d3255bfef95601890afd80709', sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', sha512: 'cf83e1357eefb8bdf1542850d66d8007d620e4050b5715dc83f4a921d36ce9ce47d0d13c5d85f2b0ff8318d2877eec2f63b931bd47417a81a538327af927da3e', blake2b: '786a02f742015903c6c6fd852552d272912f4740e15847618a86e217f71f5419d25e1031afee585313896444934eb04b903a685b1448b755d56f701afe9be2ce' },
    abc: { md5: '900150983cd24fb0d6963f7d28e17f72', sha1: 'a9993e364706816aba3e25717850c26c9cd0d89d', sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad', sha512: 'ddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a2192992a274fc1a836ba3c23a3feebbd454d4423643ce80e2a9ac94fa54ca49f', blake2b: 'ba80a53f981c4d0d6a2797b69f12f6e94c212f14685ac4b74b12bb6fdbffa2d17d87c5392aab792dc252d5de4533cc9518d38aa8dbf1925ab92386edd4009923' },
  };
  for (const [input, algs] of Object.entries(want)) for (const [alg, hex] of Object.entries(algs)) assert.strictEqual(await H.hashBuffer(Buffer.from(input), alg), hex, `${alg}(${JSON.stringify(input)})`);
  assert.strictEqual(await H.hashBuffer(Buffer.from('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'), 'sha256'), '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1');
});

test('hashes: streaming a file gives the same digests as hashing it in one go, all algorithms in one pass', async () => {
  const d = fresh('hash'); const f = path.join(d, 'f.bin'); const data = crypto.randomBytes(3 * 1024 * 1024 + 17); fs.writeFileSync(f, data);
  let seen = 0;
  const r = await H.hashFile(f, H.ORDER, { onBytes: (k) => { seen += k; } });
  for (const a of H.ORDER) assert.strictEqual(r[a], await H.hashBuffer(data, a), a);
  assert.strictEqual(r.blake2b, crypto.createHash('blake2b512').update(data).digest('hex'), 'hash-wasm BLAKE2b agrees with OpenSSL');
  assert.strictEqual(seen, data.length);
  const e = path.join(d, 'empty'); fs.writeFileSync(e, '');
  assert.strictEqual((await H.hashFile(e, ['sha256'])).sha256, 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
});

test('hashes: the worker pool hashes several files in parallel and Cancel stops it', async () => {
  const d = fresh('pool'); const files = [];
  for (let i = 0; i < 6; i++) { const f = path.join(d, `f${i}`); fs.writeFileSync(f, crypto.randomBytes(400000 + i)); files.push(f); }
  const pool = new HashPool({ size: 3 });
  let bytes = 0;
  const res = await Promise.all(files.map((f) => pool.hash(f, ['sha256', 'md5'], (k) => { bytes += k; })));
  for (let i = 0; i < files.length; i++) assert.strictEqual(res[i].sha256, await H.hashBuffer(fs.readFileSync(files[i]), 'sha256'));
  assert.strictEqual(bytes, files.reduce((s, f) => s + fs.statSync(f).size, 0));
  await rejects(() => pool.hash(path.join(d, 'missing'), ['sha256']), /not there/);
  const big = path.join(d, 'big'); fs.writeFileSync(big, crypto.randomBytes(30 * 1024 * 1024));
  const p = pool.hash(big, ['sha512', 'sha256', 'blake2b']);
  setTimeout(() => pool.cancel(), 5);
  await rejects(() => p, /Cancel/);
  pool.close();
});

test('pasted hashes: the algorithm is recognised from the length (and Base64)', () => {
  assert.deepStrictEqual(H.detect('D41D8CD98F00B204E9800998ECF8427E').algs, ['md5']);
  assert.deepStrictEqual(H.detect(' da39a3ee5e6b4b0d3255bfef95601890afd80709 \n').algs, ['sha1']);
  assert.deepStrictEqual(H.detect('sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855').algs, ['sha256']);
  assert.deepStrictEqual(H.detect('a'.repeat(128)).algs, ['sha512', 'blake2b']);
  assert.deepStrictEqual(H.detect('47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=').algs, ['sha256']);
  assert.strictEqual(H.detect('47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=').hex, 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.deepStrictEqual(H.detect('xyz').algs, []); assert.deepStrictEqual(H.detect('abc123').algs, []);
});

test('checksum files: GNU format (text and binary markers, escaped names, comments, CRLF) and BSD format', () => {
  const gnu = '# made by sha256sum\r\n'
    + 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855  empty.txt\r\n'
    + 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad *sub dir/abc.bin\r\n'
    + '\\ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad  odd\\nname\\\\x\r\n'
    + 'not a checksum line\r\n\r\n';
  const g = H.parseChecksums(gnu, 'SHA256SUMS');
  assert.deepStrictEqual(g.lines.map((l) => [l.name, l.alg]), [['empty.txt', 'sha256'], ['sub dir/abc.bin', 'sha256'], ['odd\nname\\x', 'sha256']]);
  assert.deepStrictEqual(g.bad, [5]);
  const bsd = 'MD5 (empty.txt) = d41d8cd98f00b204e9800998ecf8427e\nSHA512 (a (1).txt) = ' + 'b'.repeat(128) + '\nBLAKE2b (x) = ' + 'c'.repeat(128) + '\nSHA256 (bad) = 1234\n';
  const b = H.parseChecksums(bsd);
  assert.deepStrictEqual(b.lines.map((l) => [l.name, l.alg]), [['empty.txt', 'md5'], ['a (1).txt', 'sha512'], ['x', 'blake2b']]);
  assert.deepStrictEqual(b.bad, [4]);
  // a 128-digit GNU line is SHA-512 or BLAKE2b: the file name decides, else both are tried later
  assert.strictEqual(H.parseChecksums('b'.repeat(128) + '  f\n', 'B2SUMS').lines[0].alg, 'blake2b');
  assert.strictEqual(H.parseChecksums('b'.repeat(128) + '  f\n', 'list.txt').lines[0].alg, null);
  // a ".sha256" file holding just the hash
  const bare = H.parseChecksums('E3B0C44298FC1C149AFBF4C8996FB92427AE41E4649B934CA495991B7852B855\n', 'ubuntu.iso.sha256');
  assert.deepStrictEqual([bare.lines[0].name, bare.lines[0].alg], [null, 'sha256']);
  assert.deepStrictEqual(['x.sha256', 'SHA512SUMS', 'file.md5', 'B2SUMS', 'sha1sums.txt', 'readme.txt'].map(H.algFromName), ['sha256', 'sha512', 'md5', 'blake2b', 'sha1', null]);
});

test('checksum files: what the app writes reads back the same, in both formats, with awkward names', () => {
  const items = [{ name: 'a.txt', hex: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' }, { name: 'dir/with space (1).bin', hex: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad' }, { name: 'back\\slash\nnewline', hex: '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1' }];
  for (const fmt of ['gnu', 'bsd']) {
    const text = H.formatChecksums(items, 'sha256', fmt);
    const back = H.parseChecksums(text, 'SHA256SUMS');
    assert.deepStrictEqual(back.lines.map((l) => ({ name: l.name, hex: l.hex })), items, fmt);
    assert.deepStrictEqual(back.bad, []);
  }
  assert.strictEqual(H.formatChecksums([items[0]], 'sha256', 'gnu'), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855 *a.txt\n');
  assert.strictEqual(H.formatChecksums([items[0]], 'md5', 'bsd').split(' (')[0], 'MD5');
});

// ---- the look --------------------------------------------------------------------------------------------------------
test('look: the accent and text colours are readable on the dark background', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'styles.css'), 'utf8');
  const tokens = {};
  for (const m of css.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-fA-F]{6})/g)) tokens[m[1]] = m[2];
  const lum = (hex) => { const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  const pairs = [['text', 'bg', 4.5], ['muted', 'bg', 4.5], ['muted', 'panel', 4.5], ['accent', 'bg', 4.5], ['err', 'bg', 4.5], ['ok', 'bg', 4.5]];
  const bad = pairs.filter(([a, b, min]) => !tokens[a] || !tokens[b] || ratio(tokens[a], tokens[b]) < min).map(([a, b, min]) => `${a} on ${b} < ${min}`);
  assert.deepStrictEqual(bad, []);
});

(async () => {
  let failed = 0;
  for (const [name, fn] of tests) {
    const t0 = Date.now();
    try { await fn(); console.log(`ok   ${name} (${Date.now() - t0} ms)`); }
    catch (e) { failed++; console.log(`FAIL ${name}\n     ${String((e && e.stack) || e).split('\n').slice(0, 6).join('\n     ')}`); }
  }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  console.log(failed ? `\n${failed} of ${tests.length} failed` : `\nall ${tests.length} passed`);
  process.exit(failed ? 1 : 0);
})();
