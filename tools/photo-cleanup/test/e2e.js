'use strict';
// End-to-end test: runs inside Electron (`npm run e2e`). Drives the REAL window with real mouse and keyboard input and the
// REAL models on INVENTED photos (src/scene.js) whose background colour is known exactly, then checks the pixels in the
// window and in the saved files: the removed objects match the background, everything else is bit-identical, an extension
// continues the edges, undo / redo restore exact pixels, and saving keeps (or strips) the photo details.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { nativeImage } = require('electron');
const C = require('../src/core');
const M = require('../src/meta');
const { testPhoto } = require('../src/scene');
const { makeTiff } = require('./fixtures');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Decode a PNG/JPEG file to RGBA with Electron's own decoder. */
function readPicture(file) {
  const img = nativeImage.createFromPath(file);
  const { width, height } = img.getSize();
  const bmp = img.toBitmap(); const rgba = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < rgba.length; i += 4) { rgba[i] = bmp[i + 2]; rgba[i + 1] = bmp[i + 1]; rgba[i + 2] = bmp[i]; rgba[i + 3] = bmp[i + 3]; }
  return { w: width, h: height, rgba };
}

exports.run = async ({ app, getWin, outFile, shotsDir, dialog, clipboard, releaseAll }) => {
  const results = [];
  const errors = [];
  const notes = {};
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'photocleanup-e2e-'));
  const win = getWin();
  const wc = win.webContents;
  const js = (code) => wc.executeJavaScript(code, true);
  wc.on('console-message', (_e, level, msg) => { if (level >= 2 && !/willReadFrequently/.test(msg)) errors.push(msg); });
  const step = async (name, fn) => {
    const t0 = Date.now();
    try { const detail = await fn(); results.push({ name, ok: true, detail: detail === undefined ? '' : detail }); console.log(`ok   ${name} (${((Date.now() - t0) / 1000).toFixed(1)} s)`); }
    catch (e) { results.push({ name, ok: false, error: String((e && e.message) || e) }); console.log('FAIL ' + name + ': ' + ((e && e.message) || e)); }
  };
  const assert = (c, m) => { if (!c) throw new Error(m); };
  const eq = (a, b, what) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${what}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); };
  const waitFor = async (expr, ms = 15000, what = expr) => {
    const end = Date.now() + ms;
    for (;;) { const v = await js(expr); if (v) return v; if (Date.now() > end) throw new Error('timed out waiting for ' + what); await sleep(60); }
  };
  const shot = async (name) => {
    if (!shotsDir) return;
    fs.mkdirSync(shotsDir, { recursive: true }); await sleep(300);
    fs.writeFileSync(path.join(shotsDir, name + '.png'), (await wc.capturePage()).toPNG());
  };
  const key = async (keyCode, modifiers = []) => { wc.sendInputEvent({ type: 'keyDown', keyCode, modifiers }); wc.sendInputEvent({ type: 'char', keyCode, modifiers }); wc.sendInputEvent({ type: 'keyUp', keyCode, modifiers }); await sleep(120); };
  const center = (selector) => js(`(()=>{const e=document.querySelector(${JSON.stringify(selector)}); if(!e) return null; e.scrollIntoView({block:'nearest'}); const b=e.getBoundingClientRect(); return {x:Math.round(b.x+b.width/2), y:Math.round(b.y+b.height/2)};})()`);
  const mouse = async (type, x, y, extra = {}) => { wc.sendInputEvent({ type, x, y, button: 'left', clickCount: 1, ...extra }); await sleep(12); };
  const clickAt = async (x, y, extra = {}) => { await mouse('mouseMove', x, y); await mouse('mouseDown', x, y, extra); await mouse('mouseUp', x, y, extra); await sleep(120); };
  const click = async (selector) => { const r = await center(selector); if (!r) throw new Error('nothing to click: ' + selector); await clickAt(r.x, r.y); };
  const dragWin = async (a, b, steps = 16) => {
    await mouse('mouseMove', a.x, a.y); await mouse('mouseDown', a.x, a.y);
    for (let i = 1; i <= steps; i++) await mouse('mouseMove', Math.round(a.x + ((b.x - a.x) * i) / steps), Math.round(a.y + ((b.y - a.y) * i) / steps));
    await mouse('mouseUp', b.x, b.y); await sleep(150);
  };
  const toWin = (x, y) => js(`window.__app.toWindow(${x}, ${y})`);
  const drag = async (from, to) => dragWin(await toWin(from[0], from[1]), await toWin(to[0], to[1]));
  const S = (expr) => js(`window.__app.S.${expr}`);
  const doc = async () => { const [w, h] = await js('[window.__app.S.doc.w, window.__app.S.doc.h]'); const b = Buffer.from(await js('window.__app.docBase64()'), 'base64'); return { w, h, rgba: new Uint8ClampedArray(b.buffer, b.byteOffset, b.length) }; };
  const setRange = (id, v) => js(`(()=>{const e=document.getElementById(${JSON.stringify(id)}); e.value=${v}; e.dispatchEvent(new Event('input')); return e.value; })()`);
  const isRed = (p) => p[0] > 140 && p[1] < 80 && p[2] < 80;

  try {
    win.setContentSize(1320, 860);
    // the test photo: sky gradient, a red ball and a dark post
    const P = testPhoto(1200, 900, 1);
    const { W, H, disc, post, bg } = P;
    const photoFile = path.join(dir, 'Ball and post.png');
    fs.writeFileSync(photoFile, await M.encodePng(P.rgba, W, H));
    let openReturn = photoFile; let saveTo = null;
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [openReturn] });
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: saveTo });
    await js('void (window.confirm = () => true)');

    await step('the window starts empty with the drop zone, the model check passes', async () => {
      await waitFor('!!window.__app');
      eq(await js('document.getElementById("empty").hidden'), false, 'drop zone shown');
      eq(await js('document.getElementById("work").hidden'), true, 'work area hidden');
      eq(await js('document.getElementById("engineWarn").hidden'), true, 'no model problem');
      await shot('1-empty');
    });

    await step('Open photo… (real click) shows the photo, its size, and unlocks the controls', async () => {
      await click('#open2');
      await waitFor('window.__app.S.phase === "ready"', 15000, 'photo opened');
      assert(/1200 × 900/.test(await js('document.getElementById("fileInfo").textContent')), 'file info shows the size');
      eq(await js('document.getElementById("removeSet").disabled'), false, 'controls unlocked');
      eq(await js('window.__app.docHash()'), C.hash(P.rgba), 'pixels in the window are exactly the file\'s');
      const t0 = Date.now();
      await waitFor('window.__app.ensureEmbedding()', 60000, 'the selection model has looked at the photo');
      notes.selectionReadySeconds = Number(((Date.now() - t0) / 1000).toFixed(1));
    });

    let afterBall = null; let afterPost = null;
    await step('tap the ball (real click): it is outlined automatically, closely matching its true shape', async () => {
      const p = await toWin(disc.cx, disc.cy);
      const t0 = Date.now();
      await clickAt(p.x, p.y);
      await waitFor('window.__app.maskCount() > 0', 30000, 'a selection');
      notes.tapSeconds = Number(((Date.now() - t0) / 1000).toFixed(2));
      const iou = await js(`(()=>{const a=window.__app; let i=0,u=0; for(let y=0;y<${H};y+=2)for(let x=0;x<${W};x+=2){const t=Math.hypot(x+.5-${disc.cx},y+.5-${disc.cy})<=${disc.r}; const m=a.maskAt(x,y); if(t&&m)i++; if(t||m)u++;} return i/u;})()`);
      assert(iou > 0.9, 'outline overlap (IoU) ' + iou.toFixed(3));
      eq(await js('document.getElementById("remove").disabled'), false, 'Remove enabled');
      notes.tapIoU = Number(iou.toFixed(3));
      await shot('2-tapped');
      return 'IoU ' + iou.toFixed(3);
    });

    await step('Alt-click on the background does not take the ball away; Remove fills it with sky and leaves every other pixel bit-identical', async () => {
      const before = await js('window.__app.maskCount()');
      const p = await toWin(80, 80);
      await clickAt(p.x, p.y, { modifiers: ['alt'] });
      await sleep(1500);
      const after = await js('window.__app.maskCount()');
      assert(after >= before * 0.95, `the ball is still selected (${before} -> ${after})`);
      await click('#remove');
      await waitFor('window.__app.S.phase === "busy"', 5000, 'busy');
      eq(await js('document.getElementById("busy").hidden'), false, 'progress shown');
      await waitFor('window.__app.S.phase === "ready" && window.__app.S.lastEdit && window.__app.S.lastEdit.kind === "remove"', 120000, 'the removal');
      notes.firstRemovalSeconds = Number((await S('lastEdit.seconds')).toFixed(1));
      notes.firstRemovalModelSeconds = await js('window.__app.S.modelSeconds.map((v) => Number(v.toFixed(1)))');
      eq(await js('window.__app.maskCount()'), 0, 'selection cleared');
      const d = await doc(); afterBall = d;
      const grow = await S('grow');
      const reach = disc.r + grow + 2 + 6;
      let worst = 0; let sum = 0; let n = 0; let changedFar = 0; let changed = 0;
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const o = (y * W + x) * 4; const dist = Math.hypot(x + 0.5 - disc.cx, y + 0.5 - disc.cy);
        const diff = d.rgba[o] !== P.rgba[o] || d.rgba[o + 1] !== P.rgba[o + 1] || d.rgba[o + 2] !== P.rgba[o + 2] || d.rgba[o + 3] !== P.rgba[o + 3];
        if (diff) { changed++; if (dist > reach) changedFar++; }
        if (dist <= disc.r) { const b = bg(x, y); for (let c = 0; c < 3; c++) { const e = Math.abs(d.rgba[o + c] - b[c]); worst = Math.max(worst, e); sum += e; n++; } }
      }
      eq(changedFar, 0, `pixels changed further than ${reach} px from the ball`);
      assert(changed > Math.PI * disc.r * disc.r * 0.9, 'the ball area changed');
      assert(sum / n < 6 && worst < 30, `the ball area now matches the sky: mean difference ${(sum / n).toFixed(2)}, worst ${worst.toFixed(0)}`);
      notes.ballMeanDiff = Number((sum / n).toFixed(2));
      const items = await js('[...document.querySelectorAll("#history li")].map((l) => l.textContent)');
      assert(items.length === 1 && /Removed/.test(items[0]), 'history lists the removal: ' + items);
      await shot('3-ball-removed');
      return `mean ${(sum / n).toFixed(2)}, worst ${worst.toFixed(0)}, ${changed} px changed, none beyond ${reach} px`;
    });

    await step('brush (real drag) selects the post; erase mode takes a stray stroke back out; Ctrl+Z / Ctrl+Y undo and redo strokes', async () => {
      await click('#tool-brush');
      await setRange('brush', 120);
      await drag([post.x + post.w / 2, post.y - 12], [post.x + post.w / 2, post.y + post.h + 12]);
      let all = true;
      for (let y = post.y; y < post.y + post.h; y += 3) for (let x = post.x; x < post.x + post.w; x += 3) if (!(await js(`window.__app.maskAt(${x}, ${y})`))) { all = false; break; }
      assert(all, 'the whole post is painted');
      await drag([500, 150], [600, 150]);
      eq(await js('window.__app.maskAt(550, 150)'), 1, 'stray stroke painted');
      await click('#tool-erase');
      await drag([470, 150], [630, 150]);
      eq(await js('window.__app.maskAt(550, 150)'), 0, 'erase mode took it out');
      eq(await js(`window.__app.maskAt(${post.x + 30}, ${post.y + 100})`), 1, 'the post is still selected');
      await key('Z', ['control']);
      eq(await js('window.__app.maskAt(550, 150)'), 1, 'Ctrl+Z brings the erased stroke back');
      await key('Y', ['control']);
      eq(await js('window.__app.maskAt(550, 150)'), 0, 'Ctrl+Y erases it again');
      await shot('4-brushed');
    });

    await step('Enter removes the post: it matches the sky, the ball\'s fill and everything else stay identical', async () => {
      await key('Enter');
      await waitFor('window.__app.S.phase === "ready" && window.__app.S.lastEdit.patches && window.__app.S.undo.filter((e) => e.kind === "pixels").length === 2', 120000, 'the second removal');
      notes.secondRemovalSeconds = Number((await S('lastEdit.seconds')).toFixed(1));
      const d = await doc(); afterPost = d;
      const patches = await S('lastEdit.patches');
      let worst = 0; let sum = 0; let n = 0;
      for (let y = post.y; y < post.y + post.h; y++) for (let x = post.x; x < post.x + post.w; x++) { const o = (y * W + x) * 4; const b = bg(x, y); for (let c = 0; c < 3; c++) { const e = Math.abs(d.rgba[o + c] - b[c]); worst = Math.max(worst, e); sum += e; n++; } }
      assert(sum / n < 6 && worst < 35, `the post area now matches the sky: mean ${(sum / n).toFixed(2)}, worst ${worst.toFixed(0)}`);
      const inPatch = (x, y) => patches.some((r) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h);
      let outside = 0;
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (!inPatch(x, y)) { const o = (y * W + x) * 4; for (let c = 0; c < 4; c++) if (d.rgba[o + c] !== afterBall.rgba[o + c]) outside++; }
      eq(outside, 0, 'values changed outside the edited area');
      notes.postMeanDiff = Number((sum / n).toFixed(2));
      return `mean ${(sum / n).toFixed(2)}, worst ${worst.toFixed(0)}`;
    });

    await step('Undo (button) brings the post back exactly, Redo removes it again exactly', async () => {
      await click('#undo');
      eq(await js('window.__app.docHash()'), C.hash(afterBall.rgba), 'after undo = after the first removal');
      assert(await js(`window.__app.maskAt(${post.x + 30}, ${post.y + 100})`), 'undo restores the selection too');
      await click('#redo');
      eq(await js('window.__app.docHash()'), C.hash(afterPost.rgba), 'after redo = after the second removal');
      eq(await js('window.__app.maskCount()'), 0, 'redo clears the selection again');
    });

    let extended = null;
    await step('Extend 16:9 (real clicks; an edge drag switches to Free): the new strips continue the edges; the photo inside is unchanged', async () => {
      await click('#preset-16-9');
      await waitFor('window.__app.S.mode === "extend"', 3000, 'frame shown');
      eq(await S('ext.m'), { l: 200, t: 0, r: 200, b: 0 }, '16:9 margins');
      const hnd = await js('window.__app.edgeHandle("r")');
      await dragWin(hnd, { x: hnd.x + 40, y: hnd.y });
      eq(await S('ext.preset'), 'free', 'dragging an edge switches to Free');
      assert((await S('ext.m.r')) > 220, 'the right edge moved out');
      await shot('5-frame');
      await click('#preset-16-9');
      eq(await S('ext.m'), { l: 200, t: 0, r: 200, b: 0 }, 'back to 16:9');
      await click('#extend');
      await waitFor('window.__app.S.phase === "ready" && window.__app.S.lastEdit.kind === "extend"', 300000, 'the extension');
      notes.extendSeconds = Number((await S('lastEdit.seconds')).toFixed(1));
      notes.extendParts = await S('lastEdit.plan.count');
      notes.extendModelSeconds = await js('window.__app.S.modelSeconds.map((v) => Number(v.toFixed(1)))');
      const d = await doc(); extended = d;
      eq([d.w, d.h], [1600, 900], 'new size');
      assert(/1600 × 900/.test(await js('document.getElementById("fileInfo").textContent')), 'file info shows the new size');
      let inner = 0;
      for (let y = 0; y < H; y++) for (let x = 8; x < W - 8; x++) { const o = (y * 1600 + x + 200) * 4; const q = (y * W + x) * 4; for (let c = 0; c < 4; c++) if (d.rgba[o + c] !== afterPost.rgba[q + c]) inner++; }
      eq(inner, 0, 'values changed inside the original photo (beyond the 8 px seam)');
      const mean = (x0, x1, y0, y1) => { const m = [0, 0, 0]; let n = 0; for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const o = (y * 1600 + x) * 4; m[0] += d.rgba[o]; m[1] += d.rgba[o + 1]; m[2] += d.rgba[o + 2]; n++; } return m.map((v) => v / n); };
      let worst = 0;
      for (let y = 10; y < 880; y += 30) {
        const L = mean(10, 190, y, y + 20); const Le = mean(200, 230, y, y + 20); const R = mean(1410, 1590, y, y + 20); const Re = mean(1370, 1400, y, y + 20);
        for (let c = 0; c < 3; c++) worst = Math.max(worst, Math.abs(L[c] - Le[c]), Math.abs(R[c] - Re[c]));
      }
      assert(worst < 15, 'new strips resemble the edge next to them: worst row difference ' + worst.toFixed(1));
      for (let y = 0; y < 900; y += 7) for (const x of [3, 100, 1500, 1596]) assert(d.rgba[(y * 1600 + x) * 4 + 3] === 255, 'new pixels are opaque');
      notes.extendEdgeDiff = Number(worst.toFixed(1));
      eq(await S('mode'), 'edit', 'back to editing');
      await shot('6-extended');
      return `worst row difference ${worst.toFixed(1)}, ${notes.extendParts} parts, ${notes.extendSeconds} s`;
    });

    await step('Undo the extension (Ctrl+Z) gives back 1200 × 900 exactly; Redo (Ctrl+Shift+Z) gives the extension back exactly', async () => {
      await key('Z', ['control']);
      eq(await js('[window.__app.S.doc.w, window.__app.S.doc.h]'), [1200, 900], 'size after undo');
      eq(await js('window.__app.docHash()'), C.hash(afterPost.rgba), 'pixels after undo');
      await key('Z', ['control', 'shift']);
      eq(await js('[window.__app.S.doc.w, window.__app.S.doc.h]'), [1600, 900], 'size after redo');
      eq(await js('window.__app.docHash()'), C.hash(extended.rgba), 'pixels after redo');
      const items = await js('[...document.querySelectorAll("#history li")].map((l) => l.className + ":" + l.textContent)');
      assert(items.length === 3 && /current:Extended to 16:9/.test(items[2]), 'history: ' + items.join(' | '));
    });

    await step('before / after: the Compare slider (real drag) and Hold: original show the ball where it was', async () => {
      const bx = disc.cx + 200; const by = disc.cy;
      assert(!isRed(await js(`window.__app.viewPixel(${bx}, ${by})`)), 'after: no ball');
      await click('#compare');
      eq(await S('compare'), true, 'compare on');
      await dragWin(await toWin(800, 450), await toWin(1560, 450));
      await sleep(100);
      const px = await js(`window.__app.viewPixel(${bx}, ${by})`);
      assert(isRed(px), `left of the slider shows the original, with the ball: split ${await S('split')}, pixel ${px}`);
      await shot('7-compare');
      await click('#compare');
      const h = await center('#hold');
      await mouse('mouseMove', h.x, h.y); await mouse('mouseDown', h.x, h.y); await sleep(120);
      assert(isRed(await js(`window.__app.viewPixel(${bx}, ${by})`)), 'holding shows the original');
      await mouse('mouseUp', h.x, h.y); await sleep(120);
      assert(!isRed(await js(`window.__app.viewPixel(${bx}, ${by})`)), 'letting go shows the result');
    });

    let savedPng = null;
    await step('Save as PNG writes exactly the edited pixels; Copy puts the picture on the clipboard; re-opening the saved file gives the same picture', async () => {
      await js('document.getElementById("format").value = "png"; document.getElementById("format").dispatchEvent(new Event("change"))');
      eq(await js('document.getElementById("qualityRow").hidden'), true, 'no quality for PNG');
      saveTo = path.join(dir, 'saved.png');
      await click('#save');
      await waitFor('!!window.__app.S.lastSave', 30000, 'saved');
      savedPng = readPicture(saveTo);
      eq([savedPng.w, savedPng.h], [1600, 900], 'saved size');
      eq(C.hash(savedPng.rgba), C.hash(extended.rgba), 'saved pixels are exactly the edited ones');
      assert(/Saved PNG/.test(await js('document.getElementById("result").textContent')), 'save result shown');
      clipboard.clear();
      await click('#copy');
      await sleep(300);
      const ci = clipboard.readImage().getSize();
      eq([ci.width, ci.height], [1600, 900], 'clipboard picture size');
      openReturn = saveTo;
      await click('#open');
      await waitFor('window.__app.S.img.name === "saved.png" && window.__app.S.phase === "ready"', 15000, 're-opened');
      eq(await js('[window.__app.S.doc.w, window.__app.S.doc.h]'), [1600, 900], 're-opened size');
      eq(await js('window.__app.docHash()'), C.hash(extended.rgba), 're-opened pixels');
      eq(await js('window.__app.S.undo.length'), 0, 'fresh history');
    });

    await step('a JPEG with EXIF orientation 6 opens upright; saving keeps the details (orientation reset, thumbnail gone) or strips them; WebP too', async () => {
      const w0 = 400; const h0 = 300; const bgra = Buffer.alloc(w0 * h0 * 4);
      for (let y = 0; y < h0; y++) for (let x = 0; x < w0; x++) { const o = (y * w0 + x) * 4; const red = x < w0 / 2; bgra[o] = red ? 40 : 220; bgra[o + 1] = 40; bgra[o + 2] = red ? 220 : 40; bgra[o + 3] = 255; }
      const jpeg = M.jpegWithMeta(nativeImage.createFromBitmap(bgra, { width: w0, height: h0 }).toJPEG(95), { exif: makeTiff({ orientation: 6 }), icc: null, xmp: null });
      const jf = path.join(dir, 'Phone photo.jpg'); fs.writeFileSync(jf, jpeg);
      openReturn = jf;
      await click('#open');
      await waitFor('window.__app.S.img.name === "Phone photo.jpg" && window.__app.S.phase === "ready"', 15000, 'opened');
      eq(await js('[window.__app.S.doc.w, window.__app.S.doc.h]'), [300, 400], 'turned upright');
      assert(isRed(await js('window.__app.docPixel(150, 60)')), 'the left (red) half is now at the top');
      eq(await js('document.getElementById("format").value'), 'jpeg', 'keeps the JPEG format');
      const info = await js('document.getElementById("detailsInfo").textContent');
      assert(/TestCam/.test(info) && /GPS/.test(info), 'details shown: ' + info);
      saveTo = path.join(dir, 'kept.jpg');
      await setRange('quality', 90);
      await click('#save');
      await waitFor('window.__app.S.lastSave && /kept/.test(window.__app.S.lastSave.path)', 15000, 'saved');
      const kept = fs.readFileSync(saveTo); const km = M.readMeta(kept); const ks = M.exifSummary(km.exif);
      eq([ks.orientation, ks.camera, ks.gps], [1, 'TestCam', true], 'kept details, upright');
      assert(kept.indexOf('THUMBNAILDATA') < 0, 'the old thumbnail is gone');
      const kp = readPicture(saveTo); eq([kp.w, kp.h], [300, 400], 'saved JPEG size');
      await click('#keepDetails');
      saveTo = path.join(dir, 'stripped.jpg');
      await click('#save');
      await waitFor('window.__app.S.lastSave && /stripped/.test(window.__app.S.lastSave.path)', 15000, 'saved');
      eq(M.readMeta(fs.readFileSync(saveTo)).exif, null, 'details stripped');
      await click('#keepDetails');
      await js('document.getElementById("format").value = "webp"; document.getElementById("format").dispatchEvent(new Event("change"))');
      saveTo = path.join(dir, 'kept.webp');
      await click('#save');
      await waitFor('window.__app.S.lastSave && /webp/.test(window.__app.S.lastSave.path)', 15000, 'saved');
      const wb = fs.readFileSync(saveTo);
      eq(wb.toString('latin1', 12, 16), 'VP8X', 'extended WebP');
      eq(M.exifSummary(M.readMeta(wb).exif).camera, 'TestCam', 'WebP keeps the details');
    });

    await step('a HEIC file is refused with a clear message', async () => {
      const hf = path.join(dir, 'IMG_0001.HEIC');
      fs.writeFileSync(hf, Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypheic', 'latin1'), Buffer.alloc(64)]));
      openReturn = hf;
      await click('#open');
      await waitFor('!document.getElementById("toast").hidden && /HEIC/.test(document.getElementById("toast").textContent)', 5000, 'message');
      eq(await js('window.__app.S.img.name'), 'Phone photo.jpg', 'the open photo stays');
    });

    if (process.env.PC_E2E_12MP === '1') {
      await step('12 MP timing (PC_E2E_12MP=1): open, tap, remove and extend to 16:9 a 4000 x 3000 photo in the real window', async () => {
        const B = testPhoto(4000, 3000, 5);
        const bf = path.join(dir, 'Twelve megapixels.png'); fs.writeFileSync(bf, await M.encodePng(B.rgba, 4000, 3000));
        openReturn = bf;
        let t0 = Date.now();
        await click('#open');
        await waitFor('window.__app.S.img.name === "Twelve megapixels.png" && window.__app.S.phase === "ready"', 60000, 'opened');
        notes.mp12OpenSeconds = Number(((Date.now() - t0) / 1000).toFixed(1));
        await click('#tool-tap');
        t0 = Date.now(); await waitFor('window.__app.ensureEmbedding()', 60000, 'embedding');
        notes.mp12SelectionReadySeconds = Number(((Date.now() - t0) / 1000).toFixed(1));
        const p = await toWin(B.disc.cx, B.disc.cy);
        t0 = Date.now(); await clickAt(p.x, p.y);
        await waitFor('window.__app.maskCount() > 0', 30000, 'selection');
        notes.mp12TapSeconds = Number(((Date.now() - t0) / 1000).toFixed(2));
        await click('#remove');
        await waitFor('window.__app.S.phase === "ready" && window.__app.S.lastEdit && window.__app.S.lastEdit.kind === "remove"', 300000, 'removal');
        notes.mp12RemoveSeconds = Number((await S('lastEdit.seconds')).toFixed(1));
        notes.mp12RemoveModelSeconds = await js('window.__app.S.modelSeconds.map((v) => Number(v.toFixed(1)))');
        const px = await js(`window.__app.docPixel(${B.disc.cx}, ${B.disc.cy})`); const want = B.bg(B.disc.cx, B.disc.cy);
        assert([0, 1, 2].every((c) => Math.abs(px[c] - want[c]) < 20), 'ball removed at 12 MP: ' + px);
        await click('#preset-16-9'); await click('#extend');
        await waitFor('window.__app.S.phase === "ready" && window.__app.S.lastEdit.kind === "extend"', 600000, 'extension');
        notes.mp12ExtendSeconds = Number((await S('lastEdit.seconds')).toFixed(1));
        notes.mp12ExtendParts = await S('lastEdit.plan.count');
        notes.mp12ExtendModelSeconds = await js('window.__app.S.modelSeconds.map((v) => Number(v.toFixed(1)))');
        t0 = Date.now(); await key('Z', ['control']); notes.mp12UndoExtendSeconds = Number(((Date.now() - t0) / 1000).toFixed(2));
        return `remove ${notes.mp12RemoveSeconds} s, extend ${notes.mp12ExtendSeconds} s (${notes.mp12ExtendParts} parts)`;
      });
    }

    await step('no errors in the window console', async () => { eq(errors, [], 'console errors'); });
  } catch (e) {
    results.push({ name: 'test harness', ok: false, error: String((e && e.stack) || e) });
  }
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  if (releaseAll) await releaseAll();
  const report = { ok: results.length > 0 && results.every((r) => r.ok), results, notes };
  if (outFile) fs.writeFileSync(outFile, JSON.stringify(report, null, 2));
  app.exit(report.ok ? 0 : 1);
};
