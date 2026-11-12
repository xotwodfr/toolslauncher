'use strict';
// `--self-test=<out.json>`: proves a PACKAGED build works: Argon2id (WebAssembly) and AES-GCM run, a vault is created,
// saved, reopened, rejected when tampered with, TOTP and the generator work, the word list and zxcvbn load, CSV import
// works, and the window loads under its strict CSP. Writes nothing outside a temporary folder.
const fs = require('fs');
const os = require('os');
const path = require('path');
const F = require('./vaultfile');
const V = require('./vault');
const T = require('./totp');
const G = require('./generator');
const C = require('./csv');
const Strength = require('./strength');
const { Session } = require('./session');

exports.run = async ({ getWin } = {}) => {
  const results = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pwvault-selftest-'));
  const step = async (name, fn) => {
    const t0 = Date.now();
    try { const detail = await fn(); results.push({ name, ok: true, ms: Date.now() - t0, detail: detail === undefined ? '' : detail }); }
    catch (e) { results.push({ name, ok: false, ms: Date.now() - t0, error: String((e && e.stack) || e) }); }
  };
  const assert = (c, m) => { if (!c) throw new Error(m); };
  try {
    let kdf;
    await step('Argon2id runs and is calibrated to the real settings', async () => {
      kdf = await F.calibrate();
      assert(kdf.m === 65536 && kdf.t >= 3, JSON.stringify(kdf));
      const { argon2id } = require('hash-wasm');
      const h = await argon2id({ password: 'password', salt: 'somesalt', iterations: 2, memorySize: 65536, parallelism: 1, hashLength: 32, outputType: 'hex' });
      assert(h === '09316115d5cf24ed5a15a31a3ba326e5cf32edc24702987c02b6566f61913cf7', 'argon2id known answer: ' + h);
      return `m=64 MiB t=${kdf.t}`;
    });
    const file = path.join(dir, 'Self Test ünïcode.pwvault');
    await step('a vault is created, saved twice (with .bak), locked and opened again', async () => {
      const s = new Session();
      await s.create(file, 'self-test pässword', null, kdf);
      V.saveEntry(s.data, { title: 'Example', username: 'ada', password: 'Secret-1', totp: 'JBSWY3DPEHPK3PXP' });
      await s.save();
      s.lock();
      const t0 = Date.now();
      await s.unlock(file, 'self-test pässword', null);
      const ms = Date.now() - t0;
      assert(s.data.entries[0].password === 'Secret-1', 'contents');
      assert(fs.existsSync(file + '.bak') && !fs.existsSync(file + '.part'), 'backup');
      return `unlock took ${ms} ms`;
    });
    await step('a wrong password and a changed byte are both refused', async () => {
      let code = null;
      try { await new Session().unlock(file, 'wrong', null); } catch (e) { code = e.code; }
      assert(code === 'wrong-key', 'wrong password: ' + code);
      const buf = fs.readFileSync(file); buf[buf.length - 40] ^= 1;
      const bad = path.join(dir, 'bad.pwvault'); fs.writeFileSync(bad, buf);
      code = null;
      try { await new Session().unlock(bad, 'self-test pässword', null); } catch (e) { code = e.code; }
      assert(code === 'wrong-key', 'tampered: ' + code);
    });
    await step('TOTP matches RFC 6238', () => {
      const c = T.totp(Buffer.from('12345678901234567890'), 1111111109000, { digits: 8 }).code;
      assert(c === '07081804', c);
    });
    await step('the generator, the EFF word list and the strength meter load', () => {
      assert(G.password({ length: 24 }).value.length === 24, 'password');
      assert(G.wordlist().length === 7776, 'word list');
      assert(Strength.check('password1').score <= 1 && Strength.check('wiry-anvil-scoop-oyster-gecko').score >= 3, 'zxcvbn');
      return G.passphrase({ words: 5 }).value.split('-').length + ' words';
    });
    await step('a CSV export is recognised and imported', () => {
      const r = C.importCsv('name,url,username,password,note\nExample,https://example.com,ada,pw,\n');
      assert(r.format === 'chrome' && r.entries.length === 1, JSON.stringify(r));
    });
    const win = getWin && getWin();
    if (win) {
      await step('the window loads under its strict CSP and shows the lock screen', async () => {
        const js = (c) => win.webContents.executeJavaScript(c, true);
        const end = Date.now() + 15000;
        while (!(await js('!!window.__app').catch(() => false))) { if (Date.now() > end) throw new Error('the page did not start'); await new Promise((r) => setTimeout(r, 100)); }
        const csp = await js('document.querySelector("meta[http-equiv=Content-Security-Policy]").content');
        assert(/default-src 'none'/.test(csp), csp);
        assert(await js('!document.getElementById("lockScreen").hidden'), 'lock screen');
      });
    }
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  return results;
};
