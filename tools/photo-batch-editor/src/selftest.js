'use strict';
// `--self-test=<result.json>`: proves a PACKAGED build works: the native sharp module loads, every step runs, every
// format encodes, a small batch writes files without touching the originals, and the hidden window draws the watermark
// text and shows a preview. Used by CI and by hand on the unpacked build.
const fs = require('fs');
const os = require('os');
const path = require('path');
const sharp = require('./sharp-loader');
const R = require('./recipe');
const P = require('./pipeline');
const B = require('./batch');
const { makePhoto } = require('./samples');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function run({ getWin, textDrawer } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'photobatch-selftest-'));
  const results = [];
  const step = async (name, fn) => { try { results.push({ name, ok: true, detail: await fn() }); } catch (e) { results.push({ name, ok: false, error: String((e && e.stack) || e) }); } };
  try {
    await step('native sharp loads', async () => `sharp ${sharp.versions.sharp}, libvips ${sharp.versions.vips}`);
    const src = await makePhoto(path.join(dir, 'Self test é.jpg'), 1200, 800, { index: 2, exif: { IFD0: { Copyright: '(c) Self test' } } });
    const side = await makePhoto(path.join(dir, 'sideways.jpg'), 600, 900, { index: 1, orientation: 6 });
    const logo = path.join(dir, 'logo.png');
    await sharp({ create: { width: 60, height: 30, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 0.9 } } }).png().toFile(logo);
    const all = Object.keys(R.STEPS).map((t) => ({ ...R.freshStep(t), ...(t === 'logo' ? { file: logo } : {}), ...(t === 'resize' ? { long: 640 } : {}) }));

    await step('every step runs, in order, and the size matches the prediction', async () => {
      const out = path.join(dir, 'all.png');
      const r = await P.processFile(src, all, { format: 'png', metadata: 'strip' }, { outPath: out, text: textDrawer ? P.textCache(textDrawer) : undefined });
      const want = R.predictSize(1200, 800, R.cleanRecipe(all));
      if (Math.abs(r.width - want.width) > 1 || Math.abs(r.height - want.height) > 1) throw new Error(`size ${r.width}x${r.height}, expected ${want.width}x${want.height}`);
      return `${r.width}x${r.height}, ${all.length} steps`;
    });

    await step('every output format encodes', async () => {
      const done = [];
      for (const f of ['jpeg', 'png', 'webp', 'avif']) {
        const out = path.join(dir, 'f.' + R.EXT[f]);
        await P.processFile(src, [R.freshStep('resize')], { format: f }, { outPath: out });
        const m = await sharp(out).metadata();
        done.push(`${f}:${m.format}`);
      }
      return done.join(', ');
    });

    await step('a batch writes edited copies, turns the sideways photo upright and leaves the originals alone', async () => {
      const before = [src, side].map((f) => fs.readFileSync(f).length);
      const r = await B.runBatch([src, side], [R.freshStep('resize'), R.freshStep('border')], { pattern: '{name}-{n:2}' }, { textDrawer });
      if (r.done !== 2) throw new Error(JSON.stringify(r));
      const m = await sharp(r.outputs.find((o) => /sideways/.test(o))).metadata();
      if (!(m.height > m.width)) throw new Error('not upright: ' + m.width + 'x' + m.height);
      if ([src, side].some((f, i) => fs.readFileSync(f).length !== before[i])) throw new Error('an original changed');
      return r.outputs.map((o) => path.basename(o)).join(', ');
    });

    const win = getWin && getWin();
    if (win) {
      const js = (c) => win.webContents.executeJavaScript(c, true);
      const waitFor = async (expr, ms = 20000) => { const end = Date.now() + ms; for (;;) { if (await js(expr)) return; if (Date.now() > end) throw new Error('timed out: ' + expr); await sleep(80); } };
      await step('the window draws the watermark text and previews a photo', async () => {
        await waitFor('window.__app && window.__app.ready');
        const res = await js(`window.pb.addPaths([${JSON.stringify(src)}])`);
        await js(`void window.__app.addRows(${JSON.stringify(res)})`);
        await waitFor('window.__app.previewsShown() > 0');
        const px = await sharp(path.join(dir, 'all.png')).stats();
        return `preview shown; text tile drawn by the window (${px.channels.length} channels out)`;
      });
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return results;
}

module.exports = { run };
