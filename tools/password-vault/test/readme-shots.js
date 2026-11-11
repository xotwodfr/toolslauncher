'use strict';
// Makes the README screenshot: `node ../../node_modules/electron/cli.js . --e2e --readme-shots=<folder>`.
// Every entry is INVENTED (example.com-style sites, made-up names); the vault is a throwaway file in a temp folder.
const fs = require('fs');
const os = require('os');
const path = require('path');
const V = require('../src/vault');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// title, user, folder, tags, url, favourite, totp
const ENTRIES = [
  ['Code Hosting', 'river.otter', 'Work', ['dev'], 'https://git.example.dev', true, 'JBSWY3DPEHPK3PXP'],
  ['Northwind Bank', 'm.lindqvist', 'Finance', ['money'], 'https://northwind-bank.example', true, 'KRUGS4ZANFZSAYJA'],
  ['Example Mail', 'mira@example.com', 'Personal', ['mail'], 'https://mail.example.com', false, 'GEZDGNBVGY3TQOJQ'],
  ['Cloud Drive', 'mira@example.com', 'Personal', [], 'https://drive.example.net', false, null],
  ['Home Router', 'admin', 'Home', ['network'], 'http://192.168.1.1', false, null],
  ['Library Card', '2290 1184', 'Personal', [], 'https://library.example.org', false, null],
  ['Photo Forum', 'lenscap_42', 'Hobbies', ['social'], 'https://forum.example.photo', false, null],
  ['Recipe Club', 'mira.cooks', 'Hobbies', ['social'], 'https://recipes.example', false, null],
  ['Team Chat', 'mira.l', 'Work', ['dev'], 'https://chat.example.team', false, 'MFRGGZDFMZTWQ2LK'],
  ['Train Tickets', 'mira@example.com', 'Travel', [], 'https://rail.example.eu', false, null],
  ['Work VPN', 'mlindqvist', 'Work', [], 'vpn.example.dev', false, null],
  ['City Parking', '+46 70 000 00 00', 'Home', [], 'https://parking.example.city', false, null],
];

exports.run = async ({ app, getWin, outDir, internals }) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pwvault-shots-'));
  const win = getWin();
  const wc = win.webContents;
  const js = (c) => wc.executeJavaScript(c, true);
  const waitFor = async (expr, ms = 15000) => { const end = Date.now() + ms; for (;;) { if (await js(expr)) return; if (Date.now() > end) throw new Error('timed out: ' + expr); await sleep(80); } };
  const center = (sel) => js(`(()=>{const e=document.querySelector(${JSON.stringify(sel)}); const b=e.getBoundingClientRect(); return {x:Math.round(b.x+b.width/2), y:Math.round(b.y+b.height/2)};})()`);
  const click = async (sel) => { const { x, y } = await center(sel); wc.sendInputEvent({ type: 'mouseMove', x, y }); wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 }); wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 }); await sleep(150); };
  let code = 1;
  try {
    win.setContentSize(1240, 840);
    const s = internals.session;
    await s.create(path.join(dir, 'Lindqvist family.pwvault'), 'invented-master-password-for-the-screenshot', null, { m: 65536, t: 3, p: 1 });
    for (const [title, username, folder, tags, url, favorite, totp] of ENTRIES) {
      const e = V.saveEntry(s.data, { title, username, folder, tags, urls: [url], password: 'old-' + title, totp, favorite });
      if (title === 'Code Hosting') {
        V.saveEntry(s.data, { id: e.id, title, username, folder, tags, urls: [url, 'https://ci.example.dev'], password: 'Fjord-Pebble-Tundra-81', totp: null, notes: 'Recovery codes printed and kept in the desk drawer.\nSSH key is on the work laptop only.', fields: [{ name: 'Recovery code', value: 'K7Q2-99XP-TT41', hidden: true }, { name: 'Account ID', value: '40817', hidden: false }] });
        V.saveEntry(s.data, { id: e.id, title, username, folder, tags, urls: [url, 'https://ci.example.dev'], password: 'Harbor-Quartz-Ember-27', totp: null, fields: [{ name: 'Recovery code', value: null, hidden: true, from: 0 }, { name: 'Account ID', value: '40817' }], notes: s.data.entries.find((x) => x.id === e.id).notes });
      }
    }
    await s.save();
    wc.reload();
    await sleep(500);
    await waitFor('!!window.__app && !document.getElementById("vaultScreen").hidden && document.querySelectorAll("#rows li").length === 12');
    await click('#rows li[data-id="' + s.data.entries[0].id + '"]');
    await waitFor('/\\d{3} \\d{3}/.test((document.getElementById("dOtp")||{}).textContent||"")');
    await click('button[aria-label="Show Account ID"]').catch(() => {});
    await js('document.activeElement && document.activeElement.blur()');
    await sleep(400);
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'password-vault.png'), (await wc.capturePage()).toPNG());
    console.log('wrote', path.join(outDir, 'password-vault.png'));
    code = 0;
  } catch (e) { console.error('screenshot failed:', e); }
  try { internals.lock('quit'); fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  app.exit(code);
};
