'use strict';
// Makes the README screenshot: `node ../../node_modules/electron/cli.js . --e2e --readme-shots=<folder>`.
// The picture that is read is INVENTED (a recipe card drawn by the window), so the screenshot shows a real reading
// without anyone's documents in it.
const fs = require('fs');
const path = require('path');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

exports.run = async ({ app, getWin, outDir }) => {
  const win = getWin();
  const wc = win.webContents;
  const js = (c) => wc.executeJavaScript(c, true);
  fs.mkdirSync(outDir, { recursive: true });
  const waitFor = async (expr, ms = 30000) => { const end = Date.now() + ms; for (;;) { if (await js(expr)) return; if (Date.now() > end) throw new Error('timed out: ' + expr); await sleep(50); } };
  let code = 0;
  try {
    win.setContentSize(1240, 800);
    await waitFor('!!window.__app');
    await js(`(async () => {
      const draw = async (w, h, paint) => { const c = document.createElement('canvas'); c.width = w; c.height = h; paint(c.getContext('2d')); return new Promise((r) => c.toBlob(r, 'image/png')); };
      const card = await draw(760, 560, (g) => {
        g.fillStyle = '#fbf4e2'; g.fillRect(0, 0, 760, 560);
        g.strokeStyle = '#c9a96a'; g.lineWidth = 6; g.strokeRect(14, 14, 732, 532);
        g.fillStyle = '#3b2a1a'; g.font = 'bold 46px Georgia, serif'; g.fillText('Lemon Drizzle Cake', 50, 96);
        g.font = '26px Georgia, serif';
        ['Serves 8. Bake for 45 minutes at 175 degrees.', '', '200 g flour, 200 g sugar, 200 g butter', '3 eggs and the zest of 2 lemons', '4 tbsp lemon juice for the drizzle', '', 'Cream the butter and sugar until pale,', 'beat in the eggs one at a time, then fold', 'in the flour. Pour the drizzle over while', 'the cake is still warm.'].forEach((t, i) => g.fillText(t, 50, 160 + i * 40));
      });
      await window.__app.addItems([{ blob: card, name: 'Recipe card.png' }, { blob: await draw(500, 200, (g) => { g.fillStyle = '#fff'; g.fillRect(0, 0, 500, 200); g.fillStyle = '#222'; g.font = '34px Arial'; g.fillText('Invoice 1042 - total 86.00 EUR', 24, 70); g.fillText('Payment due 15 March', 24, 130); }), name: 'Receipt.png' }]);
    })()`);
    await waitFor('window.__app.S.items.length === 2');
    await js('document.getElementById("read").click()');
    await waitFor('window.__app.S.items[0].status === "done"');
    await js('window.__app.S.items[1].status = "new"');
    await sleep(600);
    fs.writeFileSync(path.join(outDir, 'image-text-extractor.png'), (await wc.capturePage()).toPNG());
    console.log('wrote image-text-extractor.png');
  } catch (e) {
    console.error('readme-shots failed:', e);
    code = 1;
  }
  app.exit(code);
};
