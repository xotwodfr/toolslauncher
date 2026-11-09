'use strict';
// End-to-end test: runs inside Electron (`npm run e2e`). Drives the REAL window with real mouse and keyboard input and the
// REAL ISNet model on an INVENTED picture (src/scene.js) whose true outline is known, then reads the saved files back and
// checks their pixels (transparent where the background was, the original colours on the subject, the right size).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { nativeImage } = require('electron');
const { drawScene } = require('../src/scene');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Picture file from raw RGB, using Electron's own encoders (no extra tools needed). */
function writePicture(file, rgb, w, h, kind) {
  const bgra = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) { bgra[i * 4] = rgb[i * 3 + 2]; bgra[i * 4 + 1] = rgb[i * 3 + 1]; bgra[i * 4 + 2] = rgb[i * 3]; bgra[i * 4 + 3] = 255; }
  const img = nativeImage.createFromBitmap(bgra, { width: w, height: h });
  fs.writeFileSync(file, kind === 'jpeg' ? img.toJPEG(92) : img.toPNG());
  return file;
}
/** Decode a PNG/JPEG file to { w, h, at(x, y) -> [r, g, b, a] }. */
function readPicture(file) {
  const img = nativeImage.createFromPath(file);
  const { width, height } = img.getSize();
  const bmp = img.toBitmap();
  return { w: width, h: height, at: (x, y) => { const i = (y * width + x) * 4; return [bmp[i + 2], bmp[i + 1], bmp[i], bmp[i + 3]]; } };
}

exports.run = async ({ app, getWin, outFile, shotsDir, dialog, modelLoaded }) => {
  const results = [];
  const errors = [];
  const notes = {};
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bgremover-e2e-'));
  const win = getWin();
  const wc = win.webContents;
  const js = (code) => wc.executeJavaScript(code, true);
  wc.on('console-message', (_e, level, msg) => { if (level >= 2) errors.push(msg); });
  const step = async (name, fn) => {
    try { const detail = await fn(); results.push({ name, ok: true, detail: detail === undefined ? '' : detail }); console.log('ok   ' + name); }
    catch (e) { results.push({ name, ok: false, error: String((e && e.message) || e) }); console.log('FAIL ' + name + ': ' + ((e && e.message) || e)); }
  };
  const assert = (c, m) => { if (!c) throw new Error(m); };
  const eq = (a, b, what) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${what}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); };
  const near = (a, b, tol, what) => { if (!(Math.abs(a - b) <= tol)) throw new Error(`${what}: expected ${b} +/- ${tol}, got ${a}`); };
  const closeRgb = (p, q, tol, what) => { if (![0, 1, 2].every((i) => Math.abs(p[i] - q[i]) <= tol)) throw new Error(`${what}: expected about rgb(${q.slice(0, 3)}), got rgb(${p.slice(0, 3)})`); };
  const waitFor = async (expr, ms = 8000, what = expr) => {
    const end = Date.now() + ms;
    for (;;) { const v = await js(expr); if (v) return v; if (Date.now() > end) throw new Error('timed out waiting for ' + what); await sleep(50); }
  };
  const shot = async (name) => {
    if (!shotsDir) return;
    fs.mkdirSync(shotsDir, { recursive: true });
    await sleep(300);
    fs.writeFileSync(path.join(shotsDir, name + '.png'), (await wc.capturePage()).toPNG());
  };
  const key = async (keyCode, modifiers = []) => { wc.sendInputEvent({ type: 'keyDown', keyCode, modifiers }); wc.sendInputEvent({ type: 'keyUp', keyCode, modifiers }); await sleep(80); };
  const center = (selector) => js(`(()=>{const e=document.querySelector(${JSON.stringify(selector)}); if(!e) return null; e.scrollIntoView({block:'nearest'}); const b=e.getBoundingClientRect(); return {x:Math.round(b.x+b.width/2), y:Math.round(b.y+b.height/2)};})()`);
  const mouse = async (type, x, y, extra = {}) => { wc.sendInputEvent({ type, x, y, button: 'left', clickCount: 1, ...extra }); await sleep(12); };
  const clickAt = async (x, y) => { await mouse('mouseMove', x, y); await mouse('mouseDown', x, y); await mouse('mouseUp', x, y); await sleep(100); };
  const click = async (selector) => { const r = await center(selector); if (!r) throw new Error('nothing to click: ' + selector); await clickAt(r.x, r.y); };
  const drag = async (from, to, steps = 14) => {
    const a = await js(`window.__app.toWindow(${from[0]}, ${from[1]})`); const b = await js(`window.__app.toWindow(${to[0]}, ${to[1]})`);
    await mouse('mouseMove', a.x, a.y); await mouse('mouseDown', a.x, a.y);
    for (let i = 1; i <= steps; i++) await mouse('mouseMove', Math.round(a.x + ((b.x - a.x) * i) / steps), Math.round(a.y + ((b.y - a.y) * i) / steps));
    await mouse('mouseUp', b.x, b.y); await sleep(150);
  };
  const S = (expr) => js(`window.__app.S.${expr}`);
  const viewPixel = (x, y) => js(`window.__app.viewPixel(${x}, ${y})`);
  const maskAlpha = (x, y) => js(`window.__app.maskAlpha(${x}, ${y})`);
  const CHECKER = [[217, 217, 222], [180, 180, 187]];
  const isChecker = (p) => CHECKER.some((c) => [0, 1, 2].every((i) => Math.abs(p[i] - c[i]) <= 2));
  const frames = async (n = 3) => { for (let i = 0; i < n; i++) await js('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))'); };

  try {
    win.setContentSize(1280, 820);
    const W = 960; const H = 720;
    const plant = drawScene('plant', W, H, 1);
    const lamp = drawScene('lamp', W, H, 2);
    const plantFile = writePicture(path.join(dir, 'Plant Pot.png'), plant.rgb, W, H, 'png');
    const lampFile = writePicture(path.join(dir, 'Lamp.jpg'), lamp.rgb, W, H, 'jpeg');
    const sky = new Uint8Array(400 * 300 * 3);
    for (let y = 0; y < 300; y++) for (let x = 0; x < 400; x++) { const t = y / 299; const o = (y * 400 + x) * 3; sky[o] = 40 + 200 * t; sky[o + 1] = 90 + 60 * t; sky[o + 2] = 220 - 150 * t; }
    const skyFile = writePicture(path.join(dir, 'Sky.png'), sky, 400, 300, 'png');
    const junk = path.join(dir, 'Broken.png'); fs.writeFileSync(junk, Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(300, 9)]));
    const notes_txt = path.join(dir, 'notes.png.txt'); fs.writeFileSync(notes_txt, 'hello');
    const orig = (x, y) => [plant.rgb[(y * W + x) * 3], plant.rgb[(y * W + x) * 3 + 1], plant.rgb[(y * W + x) * 3 + 2]];

    let openReturn = plantFile; let saveTo = null;
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [openReturn] });
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: saveTo });
    await js('void (window.__confirmAnswer = true, window.confirm = () => window.__confirmAnswer)');

    await step('the window starts empty, the engine check passes, and the controls are locked until a picture is cut out', async () => {
      await waitFor('!!window.__app');
      eq(await js('document.getElementById("empty").hidden'), false, 'drop zone shown');
      eq(await js('document.getElementById("work").hidden'), true, 'work area hidden');
      eq(await js('document.getElementById("engineWarn").hidden'), true, 'no engine problem');
      eq(await js('document.getElementById("open").disabled'), false, 'Open enabled');
      await shot('1-empty');
    });

    await step('Open picture… (real click): the original shows at once, the model starts, and progress text and Cancel are visible while it works', async () => {
      await click('#open2');
      await waitFor('window.__app.S.phase === "working"', 8000, 'working');
      eq(await js('document.getElementById("work").hidden'), false, 'work area shown');
      eq(await js('document.getElementById("busy").hidden'), false, 'busy box shown');
      eq(await js('document.getElementById("cancel").hidden'), false, 'Cancel shown');
      eq(await js('document.getElementById("saveSet").disabled'), true, 'saving locked meanwhile');
      await waitFor('/Starting the model|Finding the subject/.test(document.getElementById("busyText").textContent)', 20000, 'model phase text');
      await frames();
      closeRgb(await viewPixel(30, 30), orig(30, 30), 14, 'the original picture is shown while the model works');
      await shot('2-working');
      const t0 = Date.now();
      await waitFor('window.__app.S.phase === "ready"', 120000, 'the cutout');
      notes.firstCutoutSeconds = Number(((Date.now() - t0) / 1000).toFixed(1));
      eq(await js('document.getElementById("busy").hidden'), true, 'busy box gone');
      eq(await js('document.getElementById("saveSet").disabled'), false, 'saving unlocked');
      assert(/960 × 720/.test(await js('document.getElementById("fileInfo").textContent')), 'file info shows the size');
    });

    await step('the cutout matches the true outline of the plant, and the background is shown as a chequerboard', async () => {
      await frames();
      let inter = 0; let union = 0;
      for (let y = 4; y < H; y += 8) for (let x = 4; x < W; x += 8) {
        const m = (await maskAlpha(x, y)) >= 128; const t = plant.truth[y * W + x] >= 128;
        if (m && t) inter++; if (m || t) union++;
      }
      const q = inter / union;
      assert(q > 0.93, 'outline overlap (IoU) ' + q.toFixed(3));
      notes.iou = Number(q.toFixed(3));
      assert((await maskAlpha(480, 560)) >= 250, 'the pot is kept');
      assert((await maskAlpha(40, 40)) <= 5, 'the background is removed');
      assert(isChecker(await viewPixel(40, 40)), 'a transparent background shows the chequerboard: ' + (await viewPixel(40, 40)));
      closeRgb(await viewPixel(480, 560), orig(480, 560), 10, 'the subject keeps its own colours');
      await shot('3-ready');
    });

    await step('Colour background: a swatch (real clicks) fills the background and leaves the subject alone', async () => {
      await click('#bg-colour');
      eq(await js('document.getElementById("optColour").hidden'), false, 'colour options shown');
      await click('.sw[title="#e5484d"]');
      await frames();
      eq((await viewPixel(40, 40)).slice(0, 3), [229, 72, 77], 'background is the swatch colour');
      eq((await viewPixel(900, 680)).slice(0, 3), [229, 72, 77], 'everywhere');
      closeRgb(await viewPixel(480, 560), orig(480, 560), 10, 'subject unchanged');
      eq(await js('document.querySelector("#format option[value=jpeg]").disabled'), false, 'JPEG is allowed once there is a background');
      await shot('4-colour');
    });

    await step('Blur background: the old background is kept but blurred (much smoother), and the slider (real keys) changes it', async () => {
      await click('#bg-blur');
      eq(await js('document.getElementById("optBlur").hidden'), false, 'blur options shown');
      await frames();
      const std = async (x0, y0) => js(`(()=>{const v=[]; for(let y=${y0};y<${y0 + 30};y++) for(let x=${x0};x<${x0 + 30};x++){const p=window.__app.viewPixel(x,y); v.push(0.3*p[0]+0.59*p[1]+0.11*p[2]);} const m=v.reduce((a,b)=>a+b,0)/v.length; return Math.sqrt(v.reduce((a,b)=>a+(b-m)*(b-m),0)/v.length);})()`);
      const origStd = (() => { const v = []; for (let y = 20; y < 50; y++) for (let x = 20; x < 50; x++) { const p = orig(x, y); v.push(0.3 * p[0] + 0.59 * p[1] + 0.11 * p[2]); } const m = v.reduce((a, b) => a + b, 0) / v.length; return Math.sqrt(v.reduce((a, b) => a + (b - m) * (b - m), 0) / v.length); })();
      const s1 = await std(20, 20);
      assert(s1 < origStd * 0.6, `blurred patch is smoother (std ${s1.toFixed(2)} vs original ${origStd.toFixed(2)})`);
      await js('document.getElementById("blur").focus()');
      await key('End'); await frames();
      eq(await js('document.getElementById("blurVal").textContent'), '100', 'slider moved by the keyboard');
      const s2 = await std(20, 20);
      assert(s2 <= s1 + 0.5, 'a stronger blur is not rougher');
      closeRgb(await viewPixel(480, 560), orig(480, 560), 10, 'subject unchanged');
      await key('Home'); await frames();
      eq(await js('document.getElementById("blurVal").textContent'), '0', 'blur 0');
      closeRgb(await viewPixel(40, 40), orig(40, 40), 14, 'no blur = the original background behind the subject');
      await js('document.getElementById("blur").value = "40"; document.getElementById("blur").dispatchEvent(new Event("input"))');
    });

    await step('Picture background: Choose picture… (real click) fills the background with the picture, scaled to cover', async () => {
      await click('#bg-picture');
      eq(await js('document.getElementById("optPicture").hidden'), false, 'picture options shown');
      eq(await js('document.querySelector("#format option[value=jpeg]").disabled'), true, 'no picture chosen yet, so JPEG stays off');
      openReturn = skyFile;
      await click('#pickBg');
      await waitFor('document.getElementById("bgName").textContent === "Sky.png"', 6000, 'picture name');
      await frames();
      const top = await viewPixel(40, 20); const bottom = await viewPixel(40, 700);
      assert(top[2] > top[0] + 80, 'top of the sky is blue: ' + top);
      assert(bottom[0] > bottom[2] + 60, 'bottom of the sky is orange: ' + bottom);
      closeRgb(await viewPixel(480, 560), orig(480, 560), 10, 'subject unchanged');
      eq(await js('document.querySelector("#format option[value=jpeg]").disabled'), false, 'JPEG allowed now');
      await shot('5-picture');
    });

    await step('holding "Hold: original" (real mouse) and the O key show the untouched picture, and letting go brings the cutout back', async () => {
      const b = await center('#show');
      await mouse('mouseMove', b.x, b.y); await mouse('mouseDown', b.x, b.y); await frames();
      closeRgb(await viewPixel(40, 20), orig(40, 20), 14, 'original shown while held');
      eq(await js('document.getElementById("show").getAttribute("aria-pressed")'), 'true', 'pressed state');
      await mouse('mouseUp', b.x, b.y); await frames();
      assert((await viewPixel(40, 20))[2] > 150, 'the sky is back');
      wc.sendInputEvent({ type: 'keyDown', keyCode: 'o' }); await frames();
      closeRgb(await viewPixel(40, 20), orig(40, 20), 14, 'original shown while O is held');
      wc.sendInputEvent({ type: 'keyUp', keyCode: 'o' }); await frames();
      assert((await viewPixel(40, 20))[2] > 150, 'the sky is back again');
    });

    await step('the Edge slider (real keys) loosens and tightens the cutout without touching solid or empty areas, and Reset puts it back', async () => {
      await click('#bg-transparent');
      const count = async () => js(`(()=>{let n=0; for(let y=0;y<${H};y+=6) for(let x=0;x<${W};x+=6) n+=window.__app.maskAlpha(x,y)/255; return n;})()`);
      const base = await count();
      await js('document.getElementById("edge").focus()');
      await key('End'); await frames();
      const loose = await count();
      await key('Home'); await frames();
      const tight = await count();
      assert(loose >= base && base >= tight && loose > tight, `looser keeps more, tighter keeps less (${loose.toFixed(0)} / ${base.toFixed(0)} / ${tight.toFixed(0)})`);
      assert((await maskAlpha(480, 560)) >= 250 && (await maskAlpha(40, 40)) <= 5, 'solid and empty parts stay put at the extremes');
      await click('#edgeReset'); await frames();
      eq(await js('document.getElementById("edge").value'), '0', 'slider back at 0');
      near(await count(), base, 0.5, 'the original edge is back');
      notes.edge = `${tight.toFixed(0)} < ${base.toFixed(0)} < ${loose.toFixed(0)}`;
    });

    await step('zoom (wheel), pan (drag) and Fit work, and the picture stays inside reach', async () => {
      const c = await center('#view');
      const fit = await S('zoom.s');
      let sign = 240;
      wc.sendInputEvent({ type: 'mouseWheel', x: c.x, y: c.y, deltaX: 0, deltaY: sign }); await frames();
      if ((await S('zoom.s')) <= fit) { sign = -240; wc.sendInputEvent({ type: 'mouseWheel', x: c.x, y: c.y, deltaX: 0, deltaY: sign }); await frames(); }
      const zoomed = await S('zoom.s');
      assert(zoomed > fit * 1.2, `scrolling zooms in (${fit.toFixed(3)} -> ${zoomed.toFixed(3)})`);
      assert(/%$/.test(await js('document.getElementById("zoomInfo").textContent')), 'zoom shown');
      const ox = await S('zoom.ox');
      await mouse('mouseMove', c.x, c.y); await mouse('mouseDown', c.x, c.y);
      for (let i = 1; i <= 6; i++) await mouse('mouseMove', c.x + i * 15, c.y + i * 5);
      await mouse('mouseUp', c.x + 90, c.y + 30); await frames();
      near((await S('zoom.ox')) - ox, 90, 2, 'dragging moves the picture');
      await click('#fit'); await frames();
      near(await S('zoom.s'), fit, 1e-6, 'Fit goes back');
    });

    await step('Erase brush (real drag): paints out part of the subject, shows on screen, Undo (Ctrl+Z) and Redo bring it back and forth', async () => {
      await click('#tool-erase');
      eq(await js('document.getElementById("view").classList.contains("brush")'), true, 'brush cursor');
      eq(await js('document.getElementById("undo").disabled'), true, 'nothing to undo yet');
      await drag([400, 520], [560, 520]);
      assert((await maskAlpha(480, 520)) <= 5, 'the stroke erased the pot');
      assert(isChecker(await viewPixel(480, 520)), 'and it shows: ' + (await viewPixel(480, 520)));
      assert((await maskAlpha(480, 640)) >= 250, 'away from the stroke the pot is intact');
      eq(await S('strokes.length'), 1, 'one stroke');
      eq(await js('document.getElementById("undo").disabled'), false, 'Undo enabled');
      await key('z', ['control']); await frames();
      assert((await maskAlpha(480, 520)) >= 250, 'Ctrl+Z brings the pot back');
      eq(await js('document.getElementById("redo").disabled'), false, 'Redo enabled');
      await click('#redo'); await frames();
      assert((await maskAlpha(480, 520)) <= 5, 'Redo erases again');
      await shot('6-erased');
    });

    await step('Restore brush (real drag): brings back background that was removed, with the original colours', async () => {
      await click('#tool-restore');
      await drag([60, 60], [200, 60]);
      assert((await maskAlpha(130, 60)) >= 250, 'the stroke restored that part');
      closeRgb(await viewPixel(130, 60), orig(130, 60), 14, 'restored pixels are the original ones');
      eq(await S('strokes.length'), 2, 'two strokes');
      await click('#tool-off');
      eq(await js('document.getElementById("view").classList.contains("brush")'), false, 'brush off');
    });

    await step('Save PNG (real click): same size as the original, transparent where the background was, original colours on the subject, strokes included', async () => {
      await js('(() => { const s = document.getElementById("format"); s.value = "png"; s.dispatchEvent(new Event("change")); })()');
      saveTo = path.join(dir, 'out.png');
      await click('#save');
      await waitFor('/Saved/.test(document.getElementById("result").textContent)', 30000, 'saved');
      assert(fs.existsSync(saveTo), 'file written');
      assert(!fs.existsSync(saveTo + '.part'), 'no half-written file left');
      const png = readPicture(saveTo);
      eq([png.w, png.h], [W, H], 'size');
      eq(png.at(900, 680)[3], 0, 'the far background is fully transparent');
      assert(png.at(480, 600)[3] >= 252, 'the pot is opaque: ' + png.at(480, 600)[3]);
      closeRgb(png.at(480, 600), orig(480, 600), 3, 'the subject keeps its exact colours');
      eq(png.at(480, 520)[3], 0, 'the erased stroke is transparent in the file');
      assert(png.at(130, 60)[3] >= 250, 'the restored stroke is opaque in the file');
      let inter = 0; let union = 0;
      for (let y = 3; y < H; y += 7) for (let x = 3; x < W; x += 7) { const m = png.at(x, y)[3] >= 128; const t = plant.truth[y * W + x] >= 128; if (m && t) inter++; if (m || t) union++; }
      assert(inter / union > 0.9, 'the saved cutout still matches the plant (with two strokes applied) ' + (inter / union).toFixed(3));
      eq(fs.readFileSync(plantFile).equals(fs.readFileSync(plantFile)), true, 'original readable');
      assert(await js('!!document.querySelector("#result .btn")'), 'Show in folder offered');
      await shot('7-saved');
    });

    await step('Save JPEG on a colour background and WebP on the picture background: real encoders, right size, right colours', async () => {
      await click('#bg-colour'); await click('.sw[title="#ffffff"]');
      await js('(() => { const s = document.getElementById("format"); s.value = "jpeg"; s.dispatchEvent(new Event("change")); })()');
      saveTo = path.join(dir, 'out.jpg');
      await click('#save');
      await waitFor('/Saved out\\.jpg/.test(document.getElementById("result").textContent)', 30000, 'jpeg saved');
      const head = fs.readFileSync(saveTo).subarray(0, 3);
      eq(Array.from(head), [0xff, 0xd8, 0xff], 'a real JPEG');
      const jpg = readPicture(saveTo);
      eq([jpg.w, jpg.h], [W, H], 'jpeg size');
      closeRgb(jpg.at(900, 680), [255, 255, 255], 6, 'white background');
      closeRgb(jpg.at(480, 600), orig(480, 600), 10, 'subject colours');
      eq(jpg.at(900, 680)[3], 255, 'opaque');

      await click('#bg-picture');
      await js('(() => { const s = document.getElementById("format"); s.value = "webp"; s.dispatchEvent(new Event("change")); })()');
      saveTo = path.join(dir, 'out.webp');
      await click('#save');
      await waitFor('/Saved out\\.webp/.test(document.getElementById("result").textContent)', 30000, 'webp saved');
      const w = fs.readFileSync(saveTo);
      eq([w.toString('latin1', 0, 4), w.toString('latin1', 8, 12)], ['RIFF', 'WEBP'], 'a real WebP');
      assert(w.length > 5000, 'not empty');
    });

    await step('saving over the original picture is refused and the file is untouched; cancelling the save dialog saves nothing', async () => {
      const before = fs.readFileSync(plantFile);
      await js('(() => { const s = document.getElementById("format"); s.value = "png"; s.dispatchEvent(new Event("change")); })()');
      saveTo = plantFile;
      await click('#save');
      await waitFor('document.getElementById("result").classList.contains("err")', 30000, 'refusal');
      assert(/overwrite the original/.test(await js('document.getElementById("result").textContent')), 'says why');
      assert(fs.readFileSync(plantFile).equals(before), 'the original is untouched');
      const prev = dialog.showSaveDialog;
      dialog.showSaveDialog = async () => ({ canceled: true });
      await click('#save');
      await waitFor('document.getElementById("result").hidden', 30000, 'quiet cancel');
      dialog.showSaveDialog = prev;
    });

    await step('opening another picture asks before discarding touch-ups, then the model is let go when idle (memory given back)', async () => {
      await js('window.__confirmAnswer = false');
      openReturn = lampFile;
      await click('#open');
      await sleep(800);
      eq(await S('img.name'), 'Plant Pot.png', 'answering No keeps the current picture');
      eq(await S('strokes.length'), 2, 'and its strokes');
      await js('window.__confirmAnswer = true');
      await click('#open');
      await waitFor('window.__app.S.phase === "working" || window.__app.S.phase === "ready"', 8000, 'new picture');
      await waitFor('window.__app.S.phase === "ready" && window.__app.S.img.name === "Lamp.jpg"', 120000, 'second cutout (the model loads again)');
      eq(await S('strokes.length'), 0, 'strokes cleared for the new picture');
      assert(modelLoaded(), 'the model is loaded while in use');
      assert((await maskAlpha(480, 470)) >= 250, 'the lamp body is kept');
      assert((await maskAlpha(30, 30)) <= 5, 'its background is removed');
      const end = Date.now() + 15000;
      while (modelLoaded() && Date.now() < end) await sleep(200);
      assert(!modelLoaded(), 'the model was let go after the idle time (memory given back)');
    });

    await step('Cancel (real click) answers at once without crashing, says so, and Try again finishes it (the model starts again if it had been let go)', async () => {
      openReturn = plantFile;
      await js('window.__confirmAnswer = true');
      await click('#open');
      await waitFor('/Finding the subject/.test(document.getElementById("busyText").textContent)', 30000, 'the model is running');
      await click('#cancel');
      await waitFor('window.__app.S.phase === "failed"', 15000, 'cancelled');
      assert(/Cancelled/.test(await js('document.getElementById("busyText").textContent')), 'says cancelled');
      eq(await js('document.getElementById("retry").hidden'), false, 'Try again offered');
      await shot('8-cancelled');
      await click('#retry');
      await waitFor('window.__app.S.phase === "ready"', 120000, 'finished after Try again');
      assert((await maskAlpha(480, 560)) >= 250, 'the cutout is right');
    });

    await step('a broken picture and a file that is not a picture give clear messages and keep the current picture', async () => {
      openReturn = junk;
      await click('#open');
      await waitFor('/could not be opened as a picture/.test(document.getElementById("toast").textContent) && !document.getElementById("toast").hidden', 8000, 'broken picture message');
      eq(await S('img.name'), 'Plant Pot.png', 'still the same picture');
      eq(await S('phase'), 'ready', 'still ready');
      openReturn = notes_txt;
      await click('#open');
      await waitFor('/not a picture type/.test(document.getElementById("toast").textContent)', 8000, 'unsupported type message');
    });

    await step('the window never showed an error and every control has a name for screen readers', async () => {
      // (Chromium's "willReadFrequently" hint comes from this test's own pixel probes, which read single pixels back again and again)
      eq(errors.filter((e) => !/Autofill|willReadFrequently/.test(e)).join(' | '), '', 'console errors');
      const unnamed = await js(`[...document.querySelectorAll('button, input, select')].filter((e) => !e.closest('[hidden]') && !(e.getAttribute('aria-label') || e.textContent.trim() || (e.labels && e.labels.length) || e.title)).map((e) => e.outerHTML.slice(0, 80))`);
      eq(unnamed, [], 'unnamed controls');
    });
  } catch (e) {
    results.push({ name: 'the test itself', ok: false, error: String((e && e.stack) || e) });
    console.log('FAIL the test itself: ' + ((e && e.stack) || e));
  } finally {
    const ok = results.length > 0 && results.every((r) => r.ok);
    try { fs.writeFileSync(outFile, JSON.stringify({ ok, results, notes }, null, 2)); } catch (e) { console.log('could not write the report', e); }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    app.exit(ok ? 0 : 1);
  }
};
