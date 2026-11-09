'use strict';
// `--self-test=<result.json>`: proves a PACKAGED build works. Checks the bundled model file (size and SHA-256), starts the model
// from the packaged app and cuts out an invented picture (compared with its known outline), then opens the real window, opens a
// picture in it, waits for the cutout and saves a PNG through the window, and reads the saved file back.
// Used by CI and by hand on the unpacked build.
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { nativeImage } = require('electron');
const P = require('./plan');
const C = require('./cutout');
const { drawScene } = require('./scene');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MODEL_SHA = '60920e99c45464f2ba57bee2ad08c919a52bbf852739e96947fbb4358c0d964a';

/** SIZE x SIZE RGBA from an RGB picture (nearest neighbour is enough for a smooth invented picture). */
function squeeze(rgb, w, h) {
  const out = new Uint8ClampedArray(P.SIZE * P.SIZE * 4);
  for (let y = 0; y < P.SIZE; y++) for (let x = 0; x < P.SIZE; x++) {
    const sx = Math.min(w - 1, Math.floor(((x + 0.5) * w) / P.SIZE)); const sy = Math.min(h - 1, Math.floor(((y + 0.5) * h) / P.SIZE));
    const o = (y * P.SIZE + x) * 4; const s = (sy * w + sx) * 3;
    out[o] = rgb[s]; out[o + 1] = rgb[s + 1]; out[o + 2] = rgb[s + 2]; out[o + 3] = 255;
  }
  return out;
}
function writePng(file, rgb, w, h) {
  const bgra = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) { bgra[i * 4] = rgb[i * 3 + 2]; bgra[i * 4 + 1] = rgb[i * 3 + 1]; bgra[i * 4 + 2] = rgb[i * 3]; bgra[i * 4 + 3] = 255; }
  fs.writeFileSync(file, nativeImage.createFromBitmap(bgra, { width: w, height: h }).toPNG());
}

async function run({ getWin, dialog } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bgremover-selftest-'));
  const results = [];
  const step = async (name, fn) => { try { results.push({ name, ok: true, detail: await fn() }); } catch (e) { results.push({ name, ok: false, error: String((e && e.message) || e) }); } };
  try {
    await step('the model file is bundled and is the pinned one (size and SHA-256)', async () => {
      const f = C.modelPath();
      if (!fs.existsSync(f)) throw new Error('missing: ' + f);
      const sum = crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
      if (sum !== MODEL_SHA) throw new Error('checksum differs: ' + sum);
      return (fs.statSync(f).size / 1048576).toFixed(0) + ' MB';
    });

    const W = 640; const H = 480;
    const scene = drawScene('plant', W, H, 7);
    const file = path.join(dir, 'Self Test.png');
    writePng(file, scene.rgb, W, H);

    await step('the model starts from the packaged app and cuts the invented plant out of its background', async () => {
      const runner = await C.createRunner();
      try {
        const r = await runner.run(P.toTensor(squeeze(scene.rgb, W, H)));
        let inter = 0; let union = 0;
        for (let y = 0; y < P.SIZE; y++) for (let x = 0; x < P.SIZE; x++) {
          const m = r.mask[y * P.SIZE + x] >= 0.5;
          const t = scene.truth[Math.min(H - 1, Math.floor(((y + 0.5) * H) / P.SIZE)) * W + Math.min(W - 1, Math.floor(((x + 0.5) * W) / P.SIZE))] >= 128;
          if (m && t) inter++; if (m || t) union++;
        }
        const q = inter / union;
        if (!(q > 0.9)) throw new Error('outline overlap too low: ' + q.toFixed(3));
        return 'IoU ' + q.toFixed(3);
      } finally { await runner.release(); }
    });

    const win = getWin && getWin();
    if (win) {
      const js = (c) => win.webContents.executeJavaScript(c, true);
      const errors = [];
      win.webContents.on('console-message', (_e, level, msg) => { if (level >= 2 && !/willReadFrequently/.test(msg)) errors.push(msg); });
      const waitFor = async (expr, ms = 120000) => { const end = Date.now() + ms; for (;;) { if (await js(expr)) return; if (Date.now() > end) throw new Error('timed out: ' + expr); await sleep(100); } };
      await step('the window opens a picture, cuts it out, and saves a PNG whose background is transparent', async () => {
        await waitFor('!!window.__app');
        const opened = await js(`window.br.openImage(${JSON.stringify(file)}).then((r) => { if (r.ok) void window.__app.handleOpened(r); return r.ok ? 'ok' : r.error; })`);
        if (opened !== 'ok') throw new Error('could not open: ' + opened);
        await waitFor('window.__app.S.phase === "ready"');
        const alpha = await js('({ pot: window.__app.maskAlpha(320, 380), corner: window.__app.maskAlpha(20, 20) })');
        if (alpha.pot < 250 || alpha.corner > 5) throw new Error('mask in the window: ' + JSON.stringify(alpha));
        const out = path.join(dir, 'saved.png');
        dialog.showSaveDialog = async () => ({ canceled: false, filePath: out });
        const saved = await js(`(async () => { const c = window.__app.renderFull(); const blob = await new Promise((r) => c.toBlob(r, 'image/png')); const bytes = new Uint8Array(await blob.arrayBuffer()); const r = await window.br.save({ id: window.__app.S.img.id, format: 'png', bytes }); return { ok: r.ok, error: r.error }; })()`);
        if (!saved.ok) throw new Error('save failed: ' + saved.error);
        const img = nativeImage.createFromPath(out);
        const size = img.getSize();
        if (size.width !== W || size.height !== H) throw new Error('saved size ' + size.width + 'x' + size.height);
        const bmp = img.toBitmap();
        const a = (x, y) => bmp[(y * W + x) * 4 + 3];
        if (a(20, 20) !== 0 || a(320, 380) < 250) throw new Error(`alpha in the file: corner ${a(20, 20)}, pot ${a(320, 380)}`);
        if (errors.length) throw new Error('console errors: ' + errors.join(' | '));
        return `saved ${size.width}x${size.height}, corner alpha ${a(20, 20)}, pot alpha ${a(320, 380)}`;
      });
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return results;
}

module.exports = { run };
