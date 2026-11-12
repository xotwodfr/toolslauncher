'use strict';
// Makes the README screenshot: `node ../../node_modules/electron/cli.js . --e2e --readme-shots=<folder>`.
// The book is INVENTED here (text, title, author and the drawn cover).
const fs = require('fs');
const os = require('os');
const path = require('path');
const E = require('../src/epub');
const S = require('../src/samples');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PARAS = [
  'The lamp at Gull Point was lit at dusk, as it had been every evening for ninety years, and Mara climbed the iron stairs with the oil can swinging from her hand.',
  'Below her the harbour settled into its night sounds: ropes creaking against the bollards, a dog somewhere on the quay, the slow breathing of the sea against the breakwater.',
  'She wrote the weather in the almanac before she did anything else. Wind north-west, falling. Swell from the south. Two fishing boats still out past the reef, their lights small and steady.',
  'Her grandmother had kept the same book in the same careful hand, and the pages before Mara’s were full of storms that had come and gone, ships that had made it home and a few that had not.',
  'When the beam began to turn, she sat by the window with tea gone cold and watched the light sweep the water, finding the white tops of the waves and letting them go again.',
  'At midnight the first boat rounded the point. At half past, the second. She drew a small mark beside each name, closed the almanac, and let herself sleep for an hour in the chair.',
];

exports.run = async ({ app, getWin, outDir, dialog }) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ebook-shots-'));
  const win = getWin();
  const wc = win.webContents;
  const js = (c) => wc.executeJavaScript(c, true);
  const waitFor = async (expr, ms = 20000) => { const end = Date.now() + ms; for (;;) { if (await js(expr)) return; if (Date.now() > end) throw new Error('timed out: ' + expr); await sleep(80); } };
  let code = 1;
  try {
    win.setContentSize(1240, 840);
    const titles = ['Winter Light', 'The Fog Bell', 'Spring Tides', 'Gulls Over the Quay', 'The Long Night', 'Ships Coming Home', 'The Last Entry'];
    const book = path.join(dir, 'Gull Point.epub');
    fs.writeFileSync(book, E.writeEpub({
      meta: { title: 'The Keeper of Gull Point', authors: ['Mara Invented'], language: 'en' },
      chapters: titles.map((t, i) => ({ title: `${i + 1}. ${t}`, body: `<h1>${i + 1}. ${t}</h1>\n` + [...PARAS, ...PARAS].map((p) => `<p>${p}</p>`).join('\n') })),
      cover: { data: S.coverPng(300, 450), mediaType: 'image/png' },
    }));
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [book] });
    await waitFor('!!window.__app');
    await js('window.__app.prefs.theme = "sepia"; window.__app.prefs.fs = 110;');
    await js(`window.__app.openBook(${JSON.stringify(book)})`);
    await waitFor('window.__app.R.book && /Winter Light/.test(document.getElementById("frame").contentDocument.body.textContent)');
    await js('window.__app.loadChapter(1, { frac: 0 })');
    await sleep(500);
    await js('document.getElementById("tocBtn").click()');
    await sleep(400);
    await sleep(600);
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'ebook-studio.png'), (await wc.capturePage()).toPNG());
    console.log('wrote', path.join(outDir, 'ebook-studio.png'));
    code = 0;
  } catch (e) { console.error('screenshot failed:', e); }
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  app.exit(code);
};
