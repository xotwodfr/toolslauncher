'use strict';
// `--self-test=<out.json>`: proves a PACKAGED build works: Argon2id (WebAssembly), the streaming AES-GCM format, a folder
// archive, tamper detection, the hash worker threads and checksum files, and the window under its strict CSP.
// Everything happens in a temporary folder that is removed afterwards.
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const L = require('./locked');
const J = require('./jobs');
const H = require('./hashing');
const Strength = require('./strength');
const { HashPool } = require('./hashpool');

exports.run = async ({ getWin } = {}) => {
  const results = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fenc-selftest-'));
  const step = async (name, fn) => {
    const t0 = Date.now();
    try { const detail = await fn(); results.push({ name, ok: true, ms: Date.now() - t0, detail: detail === undefined ? '' : detail }); }
    catch (e) { results.push({ name, ok: false, ms: Date.now() - t0, error: String((e && e.stack) || e) }); }
  };
  const assert = (c, m) => { if (!c) throw new Error(m); };
  const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
  try {
    let master;
    await step('Argon2id runs with the real settings and gives the known answer', async () => {
      const { argon2id } = require('hash-wasm');
      const h = await argon2id({ password: 'password', salt: 'somesalt', iterations: 2, memorySize: 65536, parallelism: 1, hashLength: 32, outputType: 'hex' });
      assert(h === '09316115d5cf24ed5a15a31a3ba326e5cf32edc24702987c02b6566f61913cf7', h);
      const t0 = Date.now(); master = await L.newMaster('self-test pässword'); return `key in ${Date.now() - t0} ms`;
    });
    const src = path.join(dir, 'Ünïcode folder');
    const data = crypto.randomBytes(3 * L.CHUNK + 5);
    await step('a file and a folder are encrypted and decrypted back exactly', async () => {
      fs.mkdirSync(path.join(src, 'sub'), { recursive: true });
      fs.writeFileSync(path.join(src, 'sub', 'data.bin'), data);
      fs.writeFileSync(path.join(src, 'empty.txt'), '');
      const f = path.join(dir, 'report 2026.pdf'); fs.writeFileSync(f, data);
      const a = await J.encryptItem(await J.plan(f), { master, deleteOriginal: false });
      const b = await J.encryptItem(await J.plan(src), { master });
      const out = path.join(dir, 'out'); fs.mkdirSync(out);
      const getMaster = L.masterCache('self-test pässword');
      const ra = await J.decryptItem(a.output, { getMaster, outDir: out });
      const rb = await J.decryptItem(b.output, { getMaster, outDir: out });
      assert(sha(fs.readFileSync(ra.output)) === sha(data), 'file content');
      assert(sha(fs.readFileSync(path.join(rb.output, 'sub', 'data.bin'))) === sha(data), 'folder content');
      assert(fs.existsSync(path.join(rb.output, 'empty.txt')), 'empty file');
      return `${path.basename(ra.output)}, ${path.basename(rb.output)}`;
    });
    await step('a wrong password and a cut-short file are refused, leaving nothing behind', async () => {
      const f = path.join(dir, 'report 2026.pdf.locked');
      const out = path.join(dir, 'out2'); fs.mkdirSync(out);
      let code = null;
      try { await J.decryptItem(f, { getMaster: L.masterCache('nope'), outDir: out }); } catch (e) { code = e.code; }
      assert(code === 'wrong-password', 'wrong password: ' + code);
      const buf = fs.readFileSync(f); const h = L.parseHeader(buf);
      const cut = path.join(dir, 'cut.locked'); fs.writeFileSync(cut, buf.subarray(0, h.length + 2 * L.SEG));
      code = null;
      try { await J.decryptItem(cut, { getMaster: L.masterCache('self-test pässword'), outDir: out }); } catch (e) { code = e.code; }
      assert(code === 'tampered', 'truncation: ' + code);
      assert(fs.readdirSync(out).length === 0, 'nothing left');
    });
    await step('hash worker threads give the known SHA-256 / BLAKE2b answers', async () => {
      const f = path.join(dir, 'abc.txt'); fs.writeFileSync(f, 'abc');
      const pool = new HashPool({ size: 2 });
      try {
        const d = await pool.hash(f, ['sha256', 'blake2b', 'md5']);
        assert(d.sha256 === 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad', d.sha256);
        assert(d.blake2b.startsWith('ba80a53f981c4d0d'), d.blake2b);
        assert(d.md5 === '900150983cd24fb0d6963f7d28e17f72', d.md5);
      } finally { pool.close(); }
    });
    await step('checksum files are written and read in both formats', () => {
      for (const fmt of ['gnu', 'bsd']) {
        const t = H.formatChecksums([{ name: 'a b.txt', hex: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad' }], 'sha256', fmt);
        const p = H.parseChecksums(t, 'SHA256SUMS');
        assert(p.lines.length === 1 && p.lines[0].name === 'a b.txt' && p.lines[0].alg === 'sha256', fmt);
      }
      assert(Strength.check('password1').score <= 1, 'strength meter');
    });
    const win = getWin && getWin();
    if (win) {
      await step('the window loads under its strict CSP', async () => {
        const js = (c) => win.webContents.executeJavaScript(c, true);
        const end = Date.now() + 15000;
        while (!(await js('!!window.__app').catch(() => false))) { if (Date.now() > end) throw new Error('the page did not start'); await new Promise((r) => setTimeout(r, 100)); }
        assert(/default-src 'none'/.test(await js('document.querySelector("meta[http-equiv=Content-Security-Policy]").content')), 'CSP');
        assert(await js('!document.getElementById("empty").hidden'), 'drop zone');
      });
    }
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  return results;
};
