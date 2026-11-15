'use strict';
// `--self-test=<result.json>`: proves a PACKAGED build works. Checks the bundled model files (size and SHA-256), runs both
// models from the packaged app on an invented photo, then opens the real window, opens a photo in it, taps the object,
// removes it, extends the photo, saves a PNG through the window and reads the file back.
// Used by CI and by hand on the unpacked build.
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { nativeImage } = require('electron');
const C = require('./core');
const E = require('./engine');
const M = require('./meta');
const { testPhoto } = require('./scene');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha256 = (f) => new Promise((resolve, reject) => { const h = crypto.createHash('sha256'); fs.createReadStream(f).on('data', (d) => h.update(d)).on('end', () => resolve(h.digest('hex'))).on('error', reject); });

async function run({ getWin, dialog } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'photocleanup-selftest-'));
  const results = [];
  const step = async (name, fn) => { const t0 = Date.now(); try { results.push({ name, ok: true, detail: await fn(), ms: Date.now() - t0 }); } catch (e) { results.push({ name, ok: false, error: String((e && e.message) || e) }); } };
  try {
    await step('the model files are bundled and are the pinned ones (size and SHA-256)', async () => {
      const out = [];
      for (const [k, m] of Object.entries(E.MODELS)) {
        const f = E.modelPath(k);
        if (!fs.existsSync(f)) throw new Error('missing: ' + f);
        if (fs.statSync(f).size !== m.bytes) throw new Error(`${m.file}: size ${fs.statSync(f).size}`);
        const sum = await sha256(f);
        if (sum !== m.sha256) throw new Error(`${m.file}: checksum differs: ${sum}`);
        out.push(`${m.file} ${(m.bytes / 1048576).toFixed(0)} MB`);
      }
      return out.join(', ');
    });

    const photo = testPhoto(640, 480, 11);
    const { W, H, disc, bg } = photo;
    const file = path.join(dir, 'Self Test.png');
    fs.writeFileSync(file, await M.encodePng(photo.rgba, W, H));

    await step('the selection model starts from the packaged app and outlines the ball with one tap', async () => {
      const r = await E.createRunner('sam');
      try {
        const ss = C.samSize(W, H); const small = C.resample(photo.rgba, W, H, 4, ss.w, ss.h, 3);
        await r.call({ type: 'encode', key: 1, rgb: Uint8Array.from(small, (v) => Math.round(v)), w: ss.w, h: ss.h });
        const a = await r.call({ type: 'decode', key: 1, points: [[disc.cx * ss.s, disc.cy * ss.s]], labels: [1] });
        const m = C.logitsToMask(a.logits, a.w, a.h, W, H);
        let i = 0; let u = 0;
        for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const t = Math.hypot(x + 0.5 - disc.cx, y + 0.5 - disc.cy) <= disc.r; if (t && m[y * W + x]) i++; if (t || m[y * W + x]) u++; }
        if (!(i / u > 0.9)) throw new Error('outline overlap too low: ' + (i / u).toFixed(3));
        return 'IoU ' + (i / u).toFixed(3);
      } finally { await r.release(); }
    });

    const win = getWin && getWin();
    if (win) {
      const wc = win.webContents;
      const js = (c) => wc.executeJavaScript(c, true);
      const errors = [];
      wc.on('console-message', (_e, level, msg) => { if (level >= 2 && !/willReadFrequently/.test(msg)) errors.push(msg); });
      const waitFor = async (expr, ms = 180000) => { const end = Date.now() + ms; for (;;) { if (await js(expr)) return; if (Date.now() > end) throw new Error('timed out: ' + expr); await sleep(100); } };
      await step('the window opens a photo, a tap outlines the ball, Remove fills it with the sky, Extend makes it 16:9, and a PNG is saved', async () => {
        await waitFor('!!window.__app');
        const opened = await js(`window.pc.openImage(${JSON.stringify(file)}).then((r) => { if (r.ok) void window.__app.handleOpened(r); return r.ok ? 'ok' : r.error; })`);
        if (opened !== 'ok') throw new Error('could not open: ' + opened);
        await waitFor('window.__app.S.phase === "ready" && window.__app.S.doc && window.__app.S.doc.w === 640');
        await waitFor('window.__app.ensureEmbedding()');
        const p = await js(`window.__app.toWindow(${disc.cx}, ${disc.cy})`);
        for (const type of ['mouseMove', 'mouseDown', 'mouseUp']) { wc.sendInputEvent({ type, x: p.x, y: p.y, button: 'left', clickCount: 1 }); await sleep(20); }
        await waitFor('window.__app.maskCount() > 0', 30000);
        await js('document.getElementById("remove").click()');
        await waitFor('window.__app.S.phase === "ready" && window.__app.S.lastEdit && window.__app.S.lastEdit.kind === "remove"');
        const px = await js(`window.__app.docPixel(${disc.cx}, ${disc.cy})`);
        const want = bg(disc.cx, disc.cy);
        if (![0, 1, 2].every((i) => Math.abs(px[i] - want[i]) < 20)) throw new Error(`the ball is still there: rgb(${px.slice(0, 3)}) vs sky rgb(${want.map(Math.round)})`);
        await js('document.getElementById("preset-16-9").click()');
        await js('document.getElementById("extend").click()');
        await waitFor('window.__app.S.phase === "ready" && window.__app.S.lastEdit.kind === "extend"');
        const size = await js('[window.__app.S.doc.w, window.__app.S.doc.h]');
        if (size[0] !== 853 || size[1] !== 480) throw new Error('extended size ' + size);
        const out = path.join(dir, 'saved.png');
        dialog.showSaveDialog = async () => ({ canceled: false, filePath: out });
        await js('document.getElementById("format").value = "png"; document.getElementById("format").dispatchEvent(new Event("change")); document.getElementById("save").click()');
        await waitFor('!!window.__app.S.lastSave', 30000);
        const img = nativeImage.createFromPath(out);
        const s = img.getSize();
        if (s.width !== 853 || s.height !== 480) throw new Error('saved size ' + s.width + 'x' + s.height);
        const bmp = img.toBitmap(); const o = (disc.cy * 853 + disc.cx + 106) * 4;
        if (Math.abs(bmp[o + 2] - want[0]) > 20) throw new Error('saved file does not show the removal');
        if (errors.length) throw new Error('console errors: ' + errors.join(' | '));
        return `removed (rgb ${px.slice(0, 3)}), extended to ${size.join('x')}, saved ${s.width}x${s.height}`;
      });
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return results;
}

module.exports = { run };
