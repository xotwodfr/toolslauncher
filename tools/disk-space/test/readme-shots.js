'use strict';
// Makes the README screenshot: `node ../../node_modules/electron/cli.js . --e2e --readme-shots=<folder>`.
// The folder tree is INVENTED (about 190 MB of filler files with made-up names), scanned by the real scanner. Only the
// name of the top folder is changed afterwards so the picture does not show a temporary path.
const fs = require('fs');
const os = require('os');
const path = require('path');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MB = 1024 * 1024;

exports.run = async ({ app, getWin, outDir, dialog }) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'diskspace-shots-'));
  const win = getWin();
  const wc = win.webContents;
  const js = (c) => wc.executeJavaScript(c, true);
  const waitFor = async (expr, ms = 60000) => { const end = Date.now() + ms; for (;;) { if (await js(expr)) return; if (Date.now() > end) throw new Error('timed out: ' + expr); await sleep(80); } };
  let code = 1;
  try {
    win.setContentSize(1240, 840);
    const root = path.join(dir, 'home');
    const mk = (rel, bytes) => { const p = path.join(root, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, Buffer.alloc(Math.round(bytes), 1)); };
    mk('Videos/Lake trip 2024.mp4', 38 * MB);
    mk('Videos/Drone/Coastline take 1.mov', 9 * MB); mk('Videos/Drone/Coastline take 2.mov', 7.5 * MB); mk('Videos/Drone/Harbour.mov', 5 * MB);
    mk('Downloads/linux-desktop-24.04.iso', 26 * MB); mk('Downloads/PhotoEditor-Setup.exe', 11 * MB); mk('Downloads/old-backup.zip', 9 * MB);
    mk('Downloads/podcast-episode-41.mp3', 3.2 * MB); mk('Downloads/manual.pdf', 1.4 * MB);
    for (let i = 0; i < 26; i++) mk(`Pictures/2024/IMG_${4100 + i}.jpg`, (0.9 + ((i * 37) % 11) / 10) * MB);
    for (let i = 0; i < 18; i++) mk(`Pictures/2023/Garden/DSC0${2200 + i}.jpg`, (0.7 + ((i * 53) % 9) / 10) * MB);
    mk('Pictures/2023/Garden/panorama.tif', 6 * MB);
    const albums = [['Aster Vale', 'Paper Lanterns', 7], ['Nova Harbor', 'Slow Orbit', 6], ['Kite Season', 'Neon Fields', 5]];
    for (const [artist, album, n] of albums) for (let i = 1; i <= n; i++) mk(`Music/${artist}/${album}/${String(i).padStart(2, '0')} Track ${i}.flac`, (1.6 + (i % 4) * 0.35) * MB);
    for (let i = 0; i < 900; i++) mk(`Projects/weather-app/node_modules/pkg${i % 60}/lib/file${i}.js`, 2000 + (i * 997) % 30000);
    for (let i = 0; i < 40; i++) mk(`Projects/weather-app/src/part${i}.ts`, 1500 + i * 120);
    mk('Projects/weather-app/build/app.wasm', 2.4 * MB);
    for (let i = 0; i < 12; i++) mk(`Documents/Letters/letter-${i + 1}.docx`, 40000 + i * 3000);
    mk('Documents/Taxes 2025.pdf', 0.8 * MB); mk('Documents/Budget.xlsx', 0.3 * MB);
    mk('.cache/thumbnails/cache.db', 4 * MB);
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [root] });
    await waitFor('!!window.__app');
    await js('document.getElementById("pick2").click()');
    await waitFor('window.__app.S.root && !window.__app.S.scanning');
    await js(`(() => { const a = window.__app; a.S.root.n = '/home/sam'; a.S.ms = 380; a.setTab('map'); a.setView(a.S.root);
      const iso = a.nodeAt('/home/sam/Downloads/linux-desktop-24.04.iso'); a.select(iso); })()`);
    await js('document.getElementById("status").textContent = document.getElementById("status").textContent.replace(/ · [0-9.]+ s| · under a second/, " · 0.4 s")');
    await js('document.activeElement && document.activeElement.blur()');
    await sleep(600);
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'disk-space.png'), (await wc.capturePage()).toPNG());
    console.log('wrote', path.join(outDir, 'disk-space.png'));
    code = 0;
  } catch (e) { console.error('screenshot failed:', e); }
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  app.exit(code);
};
