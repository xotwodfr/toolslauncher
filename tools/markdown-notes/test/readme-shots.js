'use strict';
// Makes the README screenshot: `node ../../node_modules/electron/cli.js . --e2e --readme-shots=<folder>`.
// The notes are INVENTED (a made-up trip and garden plans); the picture is drawn here.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { makePng } = require('../src/testpng');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

exports.run = async ({ app, getWin, outDir, dialog }) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'markdown-notes-shots-'));
  const win = getWin();
  const wc = win.webContents;
  const js = (c) => wc.executeJavaScript(c, true);
  const waitFor = async (expr, ms = 20000) => { const end = Date.now() + ms; for (;;) { if (await js(expr)) return; if (Date.now() > end) throw new Error('timed out: ' + expr); await sleep(80); } };
  let code = 1;
  try {
    win.setContentSize(1240, 840);
    const notes = path.join(dir, 'Notes');
    const P = (...p) => path.join(notes, ...p);
    for (const d of ['Trips/attachments', 'Garden', 'Reading', 'Work']) fs.mkdirSync(P(d), { recursive: true });
    // a little drawn picture: hills at sunset
    fs.writeFileSync(P('Trips', 'attachments', 'harbour sketch.png'), makePng(520, 150, (x, y) => {
      const hill = 95 + Math.sin(x / 55) * 18 + Math.sin(x / 17) * 5;
      if (y > hill + 22) return [32, 36, 58];
      if (y > hill) return [58, 54, 84];
      const t = y / 150; return [Math.round(255 - t * 40), Math.round(180 - t * 70), Math.round(162 - t * 40)];
    }));
    fs.writeFileSync(P('Trips', 'Coastal weekend.md'), [
      '---', 'tags: [travel]', '---', '# Coastal weekend', '',
      'Two slow days by the sea. Train leaves **Friday 17:40**; see [[Packing list]] and the [[Budget#Trips|trip budget]].', '',
      '![harbour sketch](attachments/harbour%20sketch.png)', '',
      '## To do', '', '- [x] Book the guesthouse', '- [x] Train tickets', '- [ ] Pick up a paper map', '- [ ] Ask about the ferry #todo', '',
      '## Days', '', '| Day | Plan | Walk |', '|-----|------|-----:|', '| Sat | Lighthouse and the old harbour | 9 km |', '| Sun | Market, then the cliff path | 6 km |', '',
      '> Pack light: the guesthouse is up 80 steps.', '',
      '```js', '// split the costs', 'const each = (total) => Math.ceil(total / 3);', '```', '',
    ].join('\n'));
    fs.writeFileSync(P('Trips', 'Packing list.md'), '# Packing list\n\n- [ ] Rain jacket\n- [ ] Charger\n- [ ] Book #reading\n');
    fs.writeFileSync(P('Budget.md'), '# Budget\n\n## Trips\n\nAbout 240 for the weekend. #money\n');
    fs.writeFileSync(P('Garden', 'Spring sowing.md'), '---\ntags: [garden]\n---\n# Spring sowing\n\nPeas in March, beans in May. #todo\n');
    fs.writeFileSync(P('Garden', 'Compost.md'), '# Compost\n\nTurn it every two weeks. #garden\n');
    fs.writeFileSync(P('Reading', 'Books to read.md'), '# Books to read\n\n- The Lighthouse Keeper (invented)\n- A Year of Small Gardens (invented) #reading\n');
    fs.writeFileSync(P('Work', 'Meeting notes.md'), '# Meeting notes\n\nDecide the colour of the new sign. #work\n');
    fs.writeFileSync(P('Ideas.md'), '# Ideas\n\nA tide clock for the kitchen. #ideas\n');
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [notes] });
    await waitFor('!!window.__app');
    await js('document.getElementById("pickFolder").click()');
    await waitFor('!document.getElementById("workspace").hidden');
    await js('window.__app.openNote("Budget.md")');
    await js('window.__app.openNote("Trips/Packing list.md")');
    await js('window.__app.openNote("Trips/Coastal weekend.md")');
    await waitFor('document.querySelector("#preview img") && document.querySelector("#preview img").complete');
    await js('document.getElementById("pinBtn").click()');
    await sleep(400);
    await js('window.__app.S.open.add("Garden"); window.__app.setTag(""); document.activeElement && document.activeElement.blur(); window.__app.ed.view.dispatch({ selection: { anchor: 120 } })');
    await sleep(600);
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'markdown-notes.png'), (await wc.capturePage()).toPNG());
    console.log('wrote', path.join(outDir, 'markdown-notes.png'));
    code = 0;
  } catch (e) { console.error('screenshot failed:', e); }
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  app.exit(code);
};
