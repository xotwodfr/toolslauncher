'use strict';
// Password Vault core tests (plain Node, no Electron): the file format and its crypto, tampering, the key file, atomic
// saves with .bak, TOTP against the RFC test vectors, the generator, CSV imports for each format and the vault model.
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const F = require('../src/vaultfile');
const V = require('../src/vault');
const T = require('../src/totp');
const G = require('../src/generator');
const C = require('../src/csv');
const S = require('../src/strength');
const { Session } = require('../src/session');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pwvault-test-'));
const FAST = { m: 8 * 1024, t: 1, p: 1 }; // the smallest settings the app accepts: keeps the tests quick
const fixture = (n) => fs.readFileSync(path.join(__dirname, 'fixtures', n), 'utf8');
const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const rejects = async (fn, code) => {
  try { await fn(); } catch (e) { if (code) assert.strictEqual(e.code, code, `expected error code ${code}, got ${e.code}: ${e.message}`); return e; }
  throw new Error('expected a failure, but it worked');
};
const sample = () => {
  const d = V.empty();
  V.saveEntry(d, { title: 'Example Mail', username: 'ada@example.com', password: 'Söme-Secret-Pässword', urls: ['https://mail.example.com'], notes: 'recovery codes in the safe', tags: ['mail'], folder: 'Personal' });
  return d;
};

// ---- the file and its crypto ----------------------------------------------------------------------------------------
test('file: encrypt then decrypt gives back exactly the same vault', async () => {
  const d = sample();
  const nk = await F.newKey('correct horse battery staple', null, FAST);
  const buf = F.seal(nk.key, nk.meta, d);
  assert(buf.subarray(0, 8).equals(F.MAGIC), 'magic');
  const r = await F.unlock(buf, 'correct horse battery staple', null);
  assert.deepStrictEqual(r.data, JSON.parse(JSON.stringify(d)));
  assert(r.key.equals(nk.key), 'same key');
  assert(!buf.includes(Buffer.from('Söme-Secret')), 'the password is not in the file in clear');
  assert(!buf.includes(Buffer.from('Example Mail')), 'the titles are not in the file in clear');
  assert.strictEqual((buf.length - F.parse(buf).aad.length - 16) % F.PAD, 0, 'the contents are padded');
});

test('file: a wrong password fails cleanly with a plain message, and an empty one is refused', async () => {
  const nk = await F.newKey('right one', null, FAST);
  const buf = F.seal(nk.key, nk.meta, sample());
  const e = await rejects(() => F.unlock(buf, 'wrong one', null), 'wrong-key');
  assert(/master password is wrong/.test(e.message), e.message);
  await rejects(() => F.unlock(buf, '', null), 'password');
  await rejects(() => F.unlock(buf, 'Right one', null), 'wrong-key');
});

test('file: changing ANY single byte (header or body), cutting it short or adding a byte is rejected', async () => {
  const nk = await F.newKey('pw', null, FAST);
  const buf = F.seal(nk.key, nk.meta, sample());
  let rejected = 0;
  for (let i = 0; i < buf.length; i++) {
    for (const flip of [0x01, 0x80]) {
      const bad = Buffer.from(buf); bad[i] ^= flip;
      try { F.open(nk.key, bad); } catch (e) { assert(e instanceof F.VaultError, 'a VaultError at byte ' + i); rejected++; continue; }
      throw new Error(`a change at byte ${i} was not noticed`);
    }
  }
  assert.strictEqual(rejected, buf.length * 2);
  for (const len of [0, 7, 14, 100, buf.length - 17, buf.length - 1]) assert.throws(() => F.open(nk.key, buf.subarray(0, len)), F.VaultError, 'cut at ' + len);
  assert.throws(() => F.open(nk.key, Buffer.concat([buf, Buffer.from([0])])), F.VaultError, 'one extra byte');
  // a header rewritten with weaker Argon2 settings is rejected too (it is part of the authenticated data)
  const p = F.parse(buf);
  const h = JSON.parse(p.aad.subarray(14).toString());
  h.argon2.t = 2;
  const hb = Buffer.from(JSON.stringify(h));
  const pre = Buffer.from(p.aad.subarray(0, 14)); pre.writeUInt32BE(hb.length, 10);
  assert.throws(() => F.open(nk.key, Buffer.concat([pre, hb, p.body, p.tag])), (e) => e.code === 'wrong-key');
});

test('file: a hostile header cannot make the app allocate huge memory or skip the key derivation', async () => {
  const nk = await F.newKey('pw', null, FAST);
  const buf = F.seal(nk.key, nk.meta, sample());
  const p = F.parse(buf);
  const remake = (fn) => { const h = JSON.parse(p.aad.subarray(14).toString()); fn(h); const hb = Buffer.from(JSON.stringify(h)); const pre = Buffer.from(p.aad.subarray(0, 14)); pre.writeUInt32BE(hb.length, 10); return Buffer.concat([pre, hb, p.body, p.tag]); };
  for (const fn of [(h) => { h.argon2.m = 16 * 1024 * 1024; }, (h) => { h.argon2.t = 0; }, (h) => { h.argon2.p = 64; }, (h) => { h.argon2.m = 1024; }, (h) => { h.cipher = 'none'; }, (h) => { h.extra = 1; }, (h) => { h.salt = 'AAAA'; }, (h) => { h.nonce = 'AAAAAAAA'; }, (h) => { h.keyFile = 'yes'; }]) {
    assert.throws(() => F.parse(remake(fn)), (e) => e.code === 'damaged');
  }
  const v2 = Buffer.from(buf); v2.writeUInt16BE(2, 8);
  assert.throws(() => F.parse(v2), (e) => e.code === 'version' && /newer version/.test(e.message));
  assert.throws(() => F.parse(Buffer.from('hello, this is just a text file')), (e) => e.code === 'not-vault');
  const huge = Buffer.from(buf); huge.writeUInt32BE(1 << 30, 10);
  assert.throws(() => F.parse(huge), (e) => e.code === 'damaged');
});

test('file: every save uses a fresh nonce (300 saves, no repeats) and the salt stays until the password changes', async () => {
  const nk = await F.newKey('pw', null, FAST);
  const nonces = new Set(); const salts = new Set();
  for (let i = 0; i < 300; i++) { const p = F.parse(F.seal(nk.key, nk.meta, sample())); nonces.add(p.nonce.toString('hex')); salts.add(p.salt.toString('hex')); }
  assert.strictEqual(nonces.size, 300);
  assert.strictEqual(salts.size, 1);
  // and through the session's real save path
  const s = new Session(); const f = path.join(tmp, 'nonces.pwvault');
  await s.create(f, 'pw', null, FAST);
  const seen = new Set();
  for (let i = 0; i < 25; i++) { V.saveEntry(s.data, { title: 'n' + i }); await s.save(); seen.add(F.parse(fs.readFileSync(f)).nonce.toString('hex')); }
  assert.strictEqual(seen.size, 25);
});

test('file: the master password is normalised, so é typed either way opens the vault', async () => {
  const nk = await F.newKey('café \u{1F511}', null, FAST);
  const buf = F.seal(nk.key, nk.meta, sample());
  await F.unlock(buf, 'café \u{1F511}', null);
});

test('key file: needed when the vault uses one, a wrong one fails, the right one opens it; any file works', async () => {
  const kf = path.join(tmp, 'my.key');
  await F.createKeyFile(kf);
  assert.strictEqual(fs.statSync(kf).size, 64);
  await rejects(() => F.createKeyFile(kf)); // never overwritten
  const other = path.join(tmp, 'photo.jpg'); fs.writeFileSync(other, crypto.randomBytes(5000));
  const hk = await F.hashKeyFile(kf);
  const nk = await F.newKey('pw', hk, FAST);
  const buf = F.seal(nk.key, nk.meta, sample());
  assert.strictEqual(F.parse(buf).keyFile, true);
  await rejects(() => F.unlock(buf, 'pw', null), 'keyfile-needed');
  const otherHash = await F.hashKeyFile(other);
  await rejects(() => F.unlock(buf, 'pw', otherHash), 'wrong-key');
  await rejects(() => F.unlock(buf, 'wrong', hk), 'wrong-key');
  const r = await F.unlock(buf, 'pw', hk);
  assert.strictEqual(r.data.entries.length, 1);
  // a vault without a key file says so when one is offered
  const nk2 = await F.newKey('pw', null, FAST);
  await rejects(() => F.unlock(F.seal(nk2.key, nk2.meta, sample()), 'pw', hk), 'keyfile-unexpected');
  const emptyKey = path.join(tmp, 'empty.key'); fs.writeFileSync(emptyKey, '');
  await rejects(() => F.hashKeyFile(emptyKey), 'keyfile');
  await rejects(() => F.hashKeyFile(path.join(tmp, 'nope.key')), 'keyfile');
});

test('key derivation: the real settings are 64 MiB Argon2id with at least 3 passes, tuned to about 0.5-1 s', async () => {
  const k = await F.calibrate();
  assert.strictEqual(k.m, 64 * 1024); assert.strictEqual(k.p, 1); assert(k.t >= 3 && k.t <= F.LIMITS.tMax, 't=' + k.t);
  const t0 = Date.now();
  await F.deriveKey(Buffer.alloc(32), crypto.randomBytes(32), k);
  const ms = Date.now() - t0;
  console.log(`     (calibrated t=${k.t}, one unlock = ${ms} ms on this machine)`);
  assert(ms < 4000, 'unlock should not take seconds: ' + ms);
  // Argon2id known answer (RFC 9106 style check via hash-wasm): same input, same output; different salt, different output
  const a = await F.deriveKey(Buffer.from('pw'), Buffer.alloc(16, 1), FAST);
  const b = await F.deriveKey(Buffer.from('pw'), Buffer.alloc(16, 1), FAST);
  const c = await F.deriveKey(Buffer.from('pw'), Buffer.alloc(16, 2), FAST);
  assert(a.equals(b) && !a.equals(c));
});

test('argon2id: hash-wasm matches the RFC 9106 test vector (with secret and associated data via the reference parameters)', async () => {
  // RFC 9106 section 5.3 uses secret and ad, which the vault does not use; we check the plain known-answer vector instead:
  // argon2id(password="password", salt="somesalt", t=2, m=65536 KiB, p=1, 32 bytes) from the reference implementation's test suite.
  const { argon2id } = require('hash-wasm');
  const h = await argon2id({ password: 'password', salt: 'somesalt', iterations: 2, memorySize: 65536, parallelism: 1, hashLength: 32, outputType: 'hex' });
  assert.strictEqual(h, '09316115d5cf24ed5a15a31a3ba326e5cf32edc24702987c02b6566f61913cf7');
});

// ---- atomic saves -----------------------------------------------------------------------------------------------------
test('saving: atomic, keeps the previous vault as .bak, leaves no .part, and both files open', async () => {
  const f = path.join(tmp, 'Main Vault.pwvault');
  const s = new Session();
  await s.create(f, 'pw', null, FAST);
  await rejects(() => new Session().create(f, 'pw', null, FAST), 'exists');
  assert(!fs.existsSync(f + '.bak'), 'no backup of nothing');
  V.saveEntry(s.data, { title: 'First' }); await s.save();
  V.saveEntry(s.data, { title: 'Second' }); await s.save();
  assert(!fs.existsSync(f + '.part'));
  const s2 = new Session(); await s2.unlock(f, 'pw', null);
  assert.deepStrictEqual(s2.data.entries.map((e) => e.title).sort(), ['First', 'Second']);
  const b = new Session(); await b.unlock(f + '.bak', 'pw', null);
  assert.deepStrictEqual(b.data.entries.map((e) => e.title), ['First'], 'the .bak is the save before');
  assert.strictEqual(fs.statSync(f).mode & 0o777 & (process.platform === 'win32' ? 0 : 0o077), 0, 'not readable by others');
});

test('saving: if the new file does not verify, the old vault is left untouched and the .part is removed', async () => {
  const f = path.join(tmp, 'verify.pwvault');
  fs.writeFileSync(f, 'OLD');
  await rejects(() => F.writeAtomic(f, Buffer.from('NEW'), { verify: () => { throw new Error('bad'); } }));
  assert.strictEqual(fs.readFileSync(f, 'utf8'), 'OLD');
  assert(!fs.existsSync(f + '.part') && !fs.existsSync(f + '.bak'));
});

test('saving: a vault changed on disk by something else is kept as a "changed elsewhere" copy, not lost', async () => {
  const f = path.join(tmp, 'sync.pwvault');
  const a = new Session(); await a.create(f, 'pw', null, FAST);
  const b = new Session(); await b.unlock(f, 'pw', null);
  V.saveEntry(b.data, { title: 'From laptop' }); await b.save();
  V.saveEntry(a.data, { title: 'From desktop' });
  const r = await a.save();
  assert(r.conflict && fs.existsSync(r.conflict), 'conflict copy');
  assert(/changed elsewhere/.test(path.basename(r.conflict)));
  const c = new Session(); await c.unlock(r.conflict, 'pw', null);
  assert.deepStrictEqual(c.data.entries.map((e) => e.title), ['From laptop']);
  assert.strictEqual((await a.save()).conflict, null, 'no conflict the second time');
});

test('session: lock forgets the key and contents; change master password; encrypted backup opens with the same password', async () => {
  const f = path.join(tmp, 'change.pwvault');
  const kf = path.join(tmp, 'change.key'); await F.createKeyFile(kf);
  const s = new Session(); await s.create(f, 'old pass', null, FAST);
  V.saveEntry(s.data, { title: 'Bank', password: 'p1' }); await s.save();
  assert.strictEqual(await s.verify('old pass', null), true);
  assert.strictEqual(await s.verify('nope', null), false);
  await rejects(() => s.changeMaster('nope', null, 'new pass', null));
  const saltBefore = s.meta.salt.toString('hex');
  await s.changeMaster('old pass', null, 'new pass', await F.hashKeyFile(kf));
  assert.notStrictEqual(s.meta.salt.toString('hex'), saltBefore, 'new salt');
  await rejects(() => new Session().unlock(f, 'old pass', null), 'keyfile-needed');
  const kfh = await F.hashKeyFile(kf);
  await rejects(() => new Session().unlock(f, 'old pass', kfh), 'wrong-key');
  const s2 = new Session(); await s2.unlock(f, 'new pass', await F.hashKeyFile(kf));
  assert.strictEqual(s2.data.entries[0].title, 'Bank');
  const dest = path.join(tmp, 'backup copy.pwvault');
  await s.exportBackup(dest);
  await rejects(() => s.exportBackup(dest));
  const s3 = new Session(); await s3.unlock(dest, 'new pass', await F.hashKeyFile(kf));
  assert.strictEqual(s3.data.entries[0].title, 'Bank');
  const key = s.key; s.lock();
  assert(!s.unlocked && s.data === null && s.file === f);
  assert(key.every((b) => b === 0), 'the key buffer is zeroed');
  await rejects(() => s.save());
});

// ---- TOTP -------------------------------------------------------------------------------------------------------------
test('totp: RFC 6238 appendix B test vectors (SHA-1, SHA-256, SHA-512, 8 digits)', () => {
  const keys = { SHA1: Buffer.from('12345678901234567890'), SHA256: Buffer.from('12345678901234567890123456789012'), SHA512: Buffer.from('1234567890123456789012345678901234567890123456789012345678901234') };
  const vectors = [
    [59, '94287082', '46119246', '90693936'], [1111111109, '07081804', '68084774', '25091201'], [1111111111, '14050471', '67062674', '99943326'],
    [1234567890, '89005924', '91819424', '93441116'], [2000000000, '69279037', '90698825', '38618901'], [20000000000, '65353130', '77737706', '47863826'],
  ];
  for (const [t, s1, s256, s512] of vectors) {
    assert.strictEqual(T.totp(keys.SHA1, t * 1000, { digits: 8, algorithm: 'SHA1' }).code, s1, 'sha1 ' + t);
    assert.strictEqual(T.totp(keys.SHA256, t * 1000, { digits: 8, algorithm: 'SHA256' }).code, s256, 'sha256 ' + t);
    assert.strictEqual(T.totp(keys.SHA512, t * 1000, { digits: 8, algorithm: 'SHA512' }).code, s512, 'sha512 ' + t);
  }
  assert.strictEqual(T.totp(keys.SHA1, 59000).remaining, 1);
  assert.strictEqual(T.totp(keys.SHA1, 60000).remaining, 30);
});

test('totp: RFC 4226 appendix D HOTP values and RFC 4648 Base32 vectors', () => {
  const want = ['755224', '287082', '359152', '969429', '338314', '254676', '287922', '162583', '399871', '520489'];
  want.forEach((c, i) => assert.strictEqual(T.hotp(Buffer.from('12345678901234567890'), i), c));
  const b32 = { '': '', f: 'MY', fo: 'MZXQ', foo: 'MZXW6', foob: 'MZXW6YQ', fooba: 'MZXW6YTB', foobar: 'MZXW6YTBOI' };
  for (const [plain, enc] of Object.entries(b32)) {
    assert.strictEqual(T.base32Encode(Buffer.from(plain)), enc);
    if (enc) assert.strictEqual(T.base32Decode(enc + '='.repeat((8 - (enc.length % 8)) % 8)).toString(), plain);
  }
  assert.strictEqual(T.base32Decode('mzxw 6ytb-oi').toString(), 'foobar', 'spaces, dashes and lower case');
  assert.throws(() => T.base32Decode('MZXW1'), /Base32/);
});

test('totp: otpauth:// links and bare secrets are read, bad ones are refused with a reason', () => {
  const o = T.parseTotp('otpauth://totp/Example%20Co:ada@example.com?secret=jbswy3dpehpk3pxp&issuer=Example%20Co&digits=8&period=60&algorithm=sha256');
  assert.deepStrictEqual({ ...o }, { algorithm: 'SHA256', digits: 8, period: 60, secret: 'JBSWY3DPEHPK3PXP', account: 'ada@example.com', issuer: 'Example Co' });
  assert.strictEqual(T.parseTotp('JBSW Y3DP EHPK 3PXP').secret, 'JBSWY3DPEHPK3PXP');
  assert.strictEqual(T.parseTotp(''), null);
  assert.throws(() => T.parseTotp('otpauth://hotp/x?secret=JBSWY3DPEHPK3PXP&counter=1'), /time-based/);
  assert.throws(() => T.parseTotp('otpauth://totp/x?secret=JBSWY3DPEHPK3PXP&digits=4'), /digits/);
  assert.throws(() => T.parseTotp('ABC'), /too short/);
  assert.throws(() => T.parseTotp('not base 32!'), /Base32/);
  // the code the app shows for a well-known demo secret at a fixed time
  assert.strictEqual(T.codeFor(T.parseTotp('JBSWY3DPEHPK3PXP'), 1700000000000).code, T.hotp(T.base32Decode('JBSWY3DPEHPK3PXP'), Math.floor(1700000000 / 30)));
});

// ---- generator --------------------------------------------------------------------------------------------------------
test('generator: length and character sets are respected, every chosen set appears, look-alikes can be left out', () => {
  for (let i = 0; i < 300; i++) {
    const length = 4 + (i % 60);
    const p = G.password({ length, lower: true, upper: i % 2 === 0, digits: true, symbols: i % 3 === 0, noLookalikes: i % 5 === 0 }).value;
    assert.strictEqual(p.length, length);
    assert(/[a-z]/.test(p) && /[0-9]/.test(p), p);
    if (i % 2 === 0) assert(/[A-Z]/.test(p), p); else assert(!/[A-Z]/.test(p), p);
    if (i % 3 === 0) assert([...p].some((c) => G.SETS.symbols.includes(c)), p); else assert(/^[A-Za-z0-9]+$/.test(p), p);
    if (i % 5 === 0) assert(![...p].some((c) => G.LOOKALIKES.has(c)), 'look-alike in ' + p);
  }
  assert.strictEqual(G.password({ length: 1000 }).value.length, 128, 'clamped');
  assert.strictEqual(G.password({ length: 1, digits: true, lower: false, upper: false, symbols: false }).value.length, 4);
  assert.throws(() => G.password({ lower: false, upper: false, digits: false, symbols: false }), /at least one/);
});

test('generator: characters are evenly spread (chi-square over 120,000 characters)', () => {
  const counts = {};
  const alphabet = G.SETS.lower + G.SETS.upper + G.SETS.digits + G.SETS.symbols;
  for (let i = 0; i < 1000; i++) for (const c of G.password({ length: 120 }).value) counts[c] = (counts[c] || 0) + 1;
  assert.strictEqual(Object.keys(counts).length, alphabet.length, 'every character shows up');
  const n = 120000; const exp = n / alphabet.length;
  const chi = [...alphabet].reduce((s, c) => s + ((counts[c] || 0) - exp) ** 2 / exp, 0);
  // 89 degrees of freedom: the 99.99th percentile is about 150. A biased generator (e.g. modulo bias) fails this.
  assert(chi < 150, 'chi-square ' + chi.toFixed(1));
});

test('generator: the entropy figure is exact (checked by counting every password on a small alphabet)', () => {
  // alphabet {a,b,A,1,2}: sets lower(2) upper(1) digits(2), length 4: count strings that have all three kinds
  const al = ['a', 'b', 'A', '1', '2']; let ok = 0;
  for (let i = 0; i < 5 ** 4; i++) { const s = [0, 1, 2, 3].map((k) => al[Math.floor(i / 5 ** k) % 5]).join(''); if (/[ab]/.test(s) && /A/.test(s) && /[12]/.test(s)) ok++; }
  assert(Math.abs(G.entropyBits(4, 5, [2, 1, 2]) - Math.log2(ok)) < 0.06);
  assert.strictEqual(G.password({ length: 20, lower: true, upper: false, digits: false, symbols: false }).bits, 94);
});

test('passphrase: words from the bundled EFF large list (7776 words, the published file), separator, capitals, number', () => {
  const list = G.wordlist();
  assert.strictEqual(list.length, 7776); assert.strictEqual(new Set(list).size, 7776);
  assert.strictEqual(list[0], 'abacus'); assert.strictEqual(list[7775], 'zoom');
  const raw = fs.readFileSync(path.join(__dirname, '..', 'src', 'data', 'eff_large_wordlist.txt'));
  assert.strictEqual(crypto.createHash('sha256').update(raw).digest('hex'), 'addd35536511597a02fa0a9ff1e5284677b8883b83e986e43f15a3db996b903e', 'identical to eff.org/files/2016/07/18/eff_large_wordlist.txt');
  const words = new Set(list);
  const p = G.passphrase({ words: 6 });
  assert.strictEqual(p.value.split('-').length, 6); assert(p.value.split('-').every((w) => words.has(w)));
  assert.strictEqual(p.bits, 77.5);
  const q = G.passphrase({ words: 5, separator: ' ', capitalize: true, number: true });
  const parts = q.value.split(' ');
  assert.strictEqual(parts.length, 5); assert(parts.every((w) => /^[A-Z]/.test(w))); assert.strictEqual(parts.filter((w) => /\d$/.test(w)).length, 1);
  const seen = new Set(); for (let i = 0; i < 2000; i++) seen.add(G.passphrase({ words: 3 }).value);
  assert(seen.size > 1990, 'no repeats to speak of');
});

test('strength: obvious passwords are weak, long random ones strong', () => {
  assert(S.check('password').score <= 1); assert(S.check('qwerty123').score <= 1);
  assert.strictEqual(S.check('kL9#vQ2!xR7@mN4$pT').score, 4);
  assert(S.check('ada2024', ['ada']).score <= 2);
  assert.strictEqual(S.check('').label, 'Empty');
});

// ---- CSV --------------------------------------------------------------------------------------------------------------
test('csv: quoted commas, doubled quotes, line breaks inside values, CRLF, BOM, blank lines', () => {
  assert.deepStrictEqual(C.parseCsv('﻿a,b\r\n"x, y","he said ""hi"""\r\n\r\n"multi\nline",\n'), [['a', 'b'], ['x, y', 'he said "hi"'], ['multi\nline', '']]);
  assert.deepStrictEqual(C.parseCsv('a,b'), [['a', 'b']]);
  assert.throws(() => C.parseCsv('a,"unclosed'), /cut short/);
  const back = C.parseCsv(C.toCsv([['a,b', 'q"q', 'l\nl', ' pad ']]));
  assert.deepStrictEqual(back, [['a,b', 'q"q', 'l\nl', ' pad ']]);
});

test('import: KeePassXC export (groups, TOTP, dates, quotes and line breaks)', () => {
  const r = C.importCsv(fixture('keepassxc.csv'));
  assert.strictEqual(r.format, 'keepassxc');
  assert.strictEqual(r.entries.length, 2);
  const [a, b] = r.entries;
  assert.deepStrictEqual([a.title, a.username, a.password, a.urls, a.folder, a.created], ['Example Mail', 'ada@example.com', 'c0rrect-h0rse', ['https://mail.example.com'], '', '2023-01-15T09:30:00.000Z']);
  assert(a.totp.startsWith('otpauth://'));
  assert.deepStrictEqual([b.folder, b.password, b.notes], ['Work/Servers', 'p@ss, with "quotes"', 'line one\nline two']);
});

test('import: KeePass 2 export', () => {
  const r = C.importCsv(fixture('keepass2.csv'));
  assert.strictEqual(r.format, 'keepass');
  assert.deepStrictEqual(r.entries.map((e) => [e.title, e.username, e.password, e.urls[0], e.notes]), [['Forum', 'quiet_owl', 'Rainy-Day-42', 'https://forum.example.net/login', 'Signed up in 2019'], ['Router', 'admin', 's3cret!', 'http://192.168.1.1', '']]);
});

test('import: Bitwarden export (folders, favourites, several URLs, custom fields, notes; cards skipped)', () => {
  const r = C.importCsv(fixture('bitwarden.csv'));
  assert.strictEqual(r.format, 'bitwarden'); assert.strictEqual(r.skipped, 1); assert.strictEqual(r.entries.length, 2);
  const [shop, wifi] = r.entries;
  assert.deepStrictEqual([shop.folder, shop.favorite, shop.urls, shop.username, shop.password, shop.totp], ['Shopping', true, ['https://shop.example.com', 'https://m.shop.example.com'], 'kim@example.com', 'Sh0p!ng-2024', 'JBSWY3DPEHPK3PXP']);
  assert.deepStrictEqual(shop.fields, [{ name: 'PIN', value: '4321', hidden: false }, { name: 'Customer no', value: '88-123', hidden: false }]);
  assert.deepStrictEqual([wifi.title, wifi.notes, wifi.password], ['Wifi at home', 'Network: ExampleNet\nKey: hunter22', '']);
});

test('import: Chrome / Edge export (CRLF; a missing name falls back to the site)', () => {
  const r = C.importCsv(fixture('chrome.csv'));
  assert.strictEqual(r.format, 'chrome');
  assert.deepStrictEqual(r.entries.map((e) => [e.title, e.username, e.password, e.notes]), [['example.org', 'lee', 'Tulip#Sunset9', ''], ['news.example.com', 'reader1', 'qwerty-not-really', 'remember me']]);
});

test('import: Firefox export (title from the site, dates from the millisecond timestamps)', () => {
  const r = C.importCsv(fixture('firefox.csv'));
  assert.strictEqual(r.format, 'firefox');
  assert.deepStrictEqual(r.entries.map((e) => [e.title, e.username, e.password]), [['travel.example.com', 'sam.r', 'Blue-Kite-77'], ['bank.example.com', 'sam.r', 'Long&Winding*Road']]);
  assert.strictEqual(r.entries[0].created, new Date(1700000000000).toISOString());
  assert.strictEqual(r.entries[0].modified, new Date(1705000000000).toISOString());
});

test('import: an unknown CSV is refused with a reason, and everything lands in the vault under one folder', () => {
  assert.throws(() => C.importCsv('a,b,c\n1,2,3\n'), /does not look like an export/);
  assert.throws(() => C.importCsv(''), /empty/);
  const d = V.empty();
  for (const f of ['keepassxc.csv', 'keepass2.csv', 'bitwarden.csv', 'chrome.csv', 'firefox.csv']) V.addImported(d, C.importCsv(fixture(f)).entries, 'Imported');
  assert.strictEqual(d.entries.length, 10);
  assert(d.entries.every((e) => e.folder === 'Imported' || e.folder.startsWith('Imported/')));
  assert(d.folders.includes('Imported/Work/Servers'));
  const mail = d.entries.find((e) => e.title === 'Example Mail');
  assert.strictEqual(mail.totp.secret, 'JBSWY3DPEHPK3PXP');
  V.normalise(JSON.parse(JSON.stringify(d)));
});

test('export: the CSV uses Bitwarden columns and imports back with the same logins', () => {
  const d = V.empty();
  V.addImported(d, C.importCsv(fixture('bitwarden.csv')).entries, '');
  V.addImported(d, C.importCsv(fixture('keepassxc.csv')).entries, '');
  V.trash(d, d.entries[0].id);
  const csv = C.exportCsv(V.exportable(d));
  const back = C.importCsv(csv);
  assert.strictEqual(back.format, 'bitwarden');
  assert.strictEqual(back.entries.length, 3, 'trash is not exported');
  const build = back.entries.find((e) => e.title === 'Build box');
  assert.deepStrictEqual([build.password, build.notes, build.folder], ['p@ss, with "quotes"', 'line one\nline two', 'Work/Servers']);
  assert.strictEqual(T.parseTotp(back.entries.find((e) => e.title === 'Example Mail').totp).secret, 'JBSWY3DPEHPK3PXP');
});

// ---- the vault model --------------------------------------------------------------------------------------------------
test('entries: create, edit (unchanged password kept), password history, hidden fields kept, TOTP set and removed', () => {
  const d = V.empty();
  const e = V.saveEntry(d, { title: ' Bank ', username: 'u', password: 'one', urls: ['bank.example.com', ''], tags: ['#money', 'money', ' '], folder: ' Finance / Banks ', fields: [{ name: 'PIN', value: '1234', hidden: true }, { name: 'Branch', value: 'North', hidden: false }], totp: 'JBSWY3DPEHPK3PXP' });
  assert.deepStrictEqual([e.title, e.urls, e.tags, e.folder], ['Bank', ['bank.example.com'], ['money'], 'Finance/Banks']);
  assert(d.folders.includes('Finance/Banks'));
  V.saveEntry(d, { id: e.id, title: 'Bank', password: null, fields: [{ name: 'PIN', value: null, hidden: true, from: 0 }], totp: null });
  assert.strictEqual(e.password, 'one'); assert.strictEqual(e.fields[0].value, '1234'); assert(e.totp); assert.strictEqual(e.history.length, 0);
  V.saveEntry(d, { id: e.id, title: 'Bank', password: 'two', totp: null });
  V.saveEntry(d, { id: e.id, title: 'Bank', password: 'three', totp: '' });
  assert.deepStrictEqual(e.history.map((h) => h.password), ['two', 'one']);
  assert.strictEqual(e.totp, null);
  for (let i = 0; i < 30; i++) V.saveEntry(d, { id: e.id, title: 'Bank', password: 'p' + i });
  assert.strictEqual(e.history.length, V.HISTORY_MAX);
  assert.throws(() => V.saveEntry(d, { title: '  ' }), /title/);
  assert.throws(() => V.saveEntry(d, { title: 'x', password: 5 }), /text/);
  assert.throws(() => V.saveEntry(d, { title: 'x', totp: 'nope!' }), /Base32/);
  assert.throws(() => V.saveEntry(d, { id: 'missing', title: 'x' }), /no longer exists/);
});

test('entries: the list and detail views never carry a secret; secrets only leave through secret()', () => {
  const d = V.empty();
  const e = V.saveEntry(d, { title: 'Mail', username: 'ada', password: 'TopSecretPw!', fields: [{ name: 'PIN', value: 'HiddenPin77', hidden: true }, { name: 'Shown', value: 'visible-ok' }], totp: 'JBSWY3DPEHPK3PXP', notes: 'n' });
  V.saveEntry(d, { id: e.id, title: 'Mail', password: 'NewerSecretPw!', fields: [{ name: 'PIN', value: null, hidden: true, from: 0 }, { name: 'Shown', value: 'visible-ok' }], totp: null });
  const seen = JSON.stringify([V.listView(d), V.detailView(d, e.id)]);
  for (const s of ['TopSecretPw!', 'NewerSecretPw!', 'HiddenPin77', 'JBSWY3DPEHPK3PXP']) assert(!seen.includes(s), 'leaked ' + s);
  assert(seen.includes('visible-ok'));
  assert.strictEqual(V.secret(d, e.id, 'password'), 'NewerSecretPw!');
  assert.strictEqual(V.secret(d, e.id, 'history', 0), 'TopSecretPw!');
  assert.strictEqual(V.secret(d, e.id, 'field', 0), 'HiddenPin77');
  assert.match(V.secret(d, e.id, 'totp'), /^\d{6}$/);
  assert.strictEqual(V.detailView(d, e.id).passwordLength, 14);
  assert.throws(() => V.secret(d, e.id, 'field', 9)); assert.throws(() => V.secret(d, e.id, 'nonsense'));
  const c = V.totpNow(d, e.id, 59000); assert.strictEqual(c.remaining, 1);
});

test('entries: search (words, #tags, not passwords), favourites, folders, sort, trash, restore, delete forever', () => {
  const d = V.empty();
  const a = V.saveEntry(d, { title: 'Zeta Forum', username: 'owl', password: 'findme', tags: ['social'], folder: 'Web/Forums' });
  const b = V.saveEntry(d, { title: 'alpha bank', username: 'ada', notes: 'branch north', tags: ['money'], folder: 'Finance' });
  const c = V.saveEntry(d, { title: 'Mail', urls: ['https://www.mail.example.com/login'] });
  const ids = (o) => V.listView(d, o).rows.map((r) => r.id);
  assert.deepStrictEqual(ids({}), [b.id, c.id, a.id], 'sorted by title, ignoring case');
  assert.deepStrictEqual(ids({ query: 'north' }), [b.id]);
  assert.deepStrictEqual(ids({ query: 'findme' }), [], 'passwords are not searched');
  assert.deepStrictEqual(ids({ query: '#money' }), [b.id]);
  assert.deepStrictEqual(ids({ query: 'mail.example' }), [c.id]);
  assert.deepStrictEqual(ids({ view: 'folder', folder: 'Web' }), [a.id]);
  assert.deepStrictEqual(ids({ view: 'tag', tag: 'social' }), [a.id]);
  assert.strictEqual(V.listView(d).rows.find((r) => r.id === c.id).host, 'mail.example.com');
  V.setFavorite(d, c.id, true);
  assert.deepStrictEqual(ids({ view: 'favorites' }), [c.id]);
  V.trash(d, a.id);
  assert.deepStrictEqual(ids({}), [b.id, c.id]); assert.deepStrictEqual(ids({ view: 'trash' }), [a.id]);
  assert.strictEqual(V.listView(d).counts.trash, 1);
  assert.deepStrictEqual(V.listView(d).folders.map((f) => f.name), ['Finance', 'Web', 'Web/Forums'], 'folders that were made stay, with their parents');
  V.restore(d, a.id); assert.strictEqual(ids({}).length, 3);
  assert.throws(() => V.purge(d, a.id), /trash first/);
  V.trash(d, a.id); V.purge(d, a.id); assert.strictEqual(d.entries.length, 2);
  V.trash(d, b.id); assert.strictEqual(V.emptyTrash(d), 1); assert.strictEqual(d.entries.length, 1);
  assert.throws(() => V.settings(d, { autoLockMinutes: -1 })); assert.strictEqual(V.settings(d, { autoLockMinutes: 10, clipboardSeconds: 45 }).clipboardSeconds, 45);
});

test('vault: contents from a file are checked and filled in (old or odd files do not crash the app)', () => {
  const d = V.normalise({ entries: [{ id: 'x', title: 'T', urls: 'not an array', fields: [null, { name: 'a', value: 1 }] }, null, { no: 'id' }] });
  assert.strictEqual(d.entries.length, 1); assert.deepStrictEqual(d.entries[0].urls, []); assert.deepStrictEqual(d.entries[0].fields, [{ name: 'a', value: '1', hidden: false }]);
  assert.strictEqual(d.settings.clipboardSeconds, 30);
  assert.throws(() => V.normalise({}), /not valid/);
  assert.throws(() => V.normalise({ schema: 99, entries: [] }), /newer/);
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
