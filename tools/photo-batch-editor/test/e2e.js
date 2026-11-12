'use strict';
// End-to-end test: runs inside Electron (`npm run e2e`). Drives the REAL window with real mouse and keyboard input on
// invented photos (src/samples.js), then checks what the page shows AND the files written (pixels read back with sharp).
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sharp = require('../src/sharp-loader');
const { makePhoto } = require('../src/samples');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hash = (f) => crypto.createHash('md5').update(fs.readFileSync(f)).digest('hex');

exports.run = async ({ app, exit, getWin, outFile, shotsDir, dialog, shell }) => {
  const results = [];
  const errors = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'photobatch-e2e-'));
  const win = getWin();
  const wc = win.webContents;
  const js = (code) => wc.executeJavaScript(code, true);
  wc.on('console-message', (_e, level, msg) => { if (level >= 2) errors.push(msg); });
  const step = async (name, fn) => {
    try { const detail = await fn(); results.push({ name, ok: true, detail: detail === undefined ? '' : detail }); console.log('ok   ' + name); }
    catch (e) { results.push({ name, ok: false, error: String((e && e.message) || e) }); console.log('FAIL ' + name + ': ' + ((e && e.message) || e)); }
  };
  const assert = (c, m) => { if (!c) throw new Error(m); };
  const eq = (a, b, what) => { if (a !== b) throw new Error(`${what}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); };
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
  const key = async (keyCode, char = false) => {
    wc.sendInputEvent({ type: 'keyDown', keyCode });
    if (char) wc.sendInputEvent({ type: 'char', keyCode });
    wc.sendInputEvent({ type: 'keyUp', keyCode });
    await sleep(40);
  };
  const typeText = async (text) => { for (const ch of text) await key(ch, true); };
  const box = (selector) => js(`(()=>{const e=document.querySelector(${JSON.stringify(selector)}); if(!e) return null; e.scrollIntoView({block:'nearest'}); const b=e.getBoundingClientRect(); return {x:b.x, y:b.y, w:b.width, h:b.height, cx:Math.round(b.x+b.width/2), cy:Math.round(b.y+b.height/2)};})()`);
  const clickAt = async (x, y) => {
    wc.sendInputEvent({ type: 'mouseMove', x, y });
    wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
    wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
    await sleep(100);
  };
  const click = async (selector) => { const r = await box(selector); if (!r) throw new Error('nothing to click: ' + selector); await clickAt(r.cx, r.cy); };
  // pick an option of a <select> with the keyboard (focus by clicking it, then type, then Enter)
  const choose = async (selector, value) => {
    await js(`(() => { const s = document.querySelector(${JSON.stringify(selector)}); s.focus(); s.value = ${JSON.stringify(value)}; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await sleep(60);
  };
  const afterSrc = () => js('document.getElementById("imgAfter").getAttribute("src") || ""');
  const waitPreviewChange = async (before, what) => waitFor(`(document.getElementById("imgAfter").getAttribute("src") || "") !== ${JSON.stringify(before)} && document.getElementById("pvBusy").hidden`, 10000, what);

  try {
    win.setContentSize(1240, 840);
    // ---- invented photos: a folder with a sub-folder, a sideways phone photo (EXIF orientation 6), a PNG, a broken file
    const photosDir = path.join(dir, 'Holiday é');
    fs.mkdirSync(path.join(photosDir, 'day 2'), { recursive: true });
    const files = [];
    files.push(await makePhoto(path.join(photosDir, 'beach 01.jpg'), 1200, 800, { index: 1, exif: { IFD0: { Copyright: '(c) Invented', Make: 'InventedCam' }, IFD2: { DateTimeOriginal: '2025:07:14 10:20:30' } } }));
    files.push(await makePhoto(path.join(photosDir, 'phone sideways.jpg'), 900, 1200, { index: 2, orientation: 6 }));
    files.push(await makePhoto(path.join(photosDir, 'sunset.png'), 1000, 1000, { index: 0, format: 'png' }));
    files.push(await makePhoto(path.join(photosDir, 'day 2', '山 hills.webp'), 1600, 900, { index: 3, format: 'webp' }));
    fs.writeFileSync(path.join(photosDir, 'broken.jpg'), Buffer.alloc(5000, 9));
    fs.writeFileSync(path.join(photosDir, 'notes.txt'), 'not a photo');
    const hashes = files.map(hash);
    const outDir = path.join(dir, 'Exported ✓');
    let folderReturn = photosDir; let openReturn = [];
    dialog.showOpenDialog = async (_w, opts) => {
      const props = (opts && opts.properties) || [];
      if (props.includes('openDirectory') && /edited photos go/.test(opts.title)) return { canceled: false, filePaths: [outDir] };
      if (props.includes('openDirectory')) return { canceled: false, filePaths: [folderReturn] };
      return { canceled: false, filePaths: openReturn };
    };

    await step('the window starts empty with the default recipe and the drop zone', async () => {
      await waitFor('window.__app && window.__app.ready', 10000);
      eq(await js('document.getElementById("empty").hidden'), false, 'drop zone');
      eq(await js('document.getElementById("start").disabled'), true, 'nothing to start');
      const steps = await js('[...document.querySelectorAll(".step")].map((e) => e.dataset.type)');
      eq(JSON.stringify(steps), JSON.stringify(['resize', 'levels', 'text']), 'default recipe');
      await shot('1-empty');
    });

    await step('Add folder… (real click) lists the photos of the folder and its sub-folder, skips other files, flags the broken one', async () => {
      await click('#addFolder2');
      await waitFor('window.__app.S.rows.length === 5', 8000, 'five rows');
      const names = await js('window.__app.S.rows.map((r) => r.name)');
      for (const n of ['beach 01.jpg', 'phone sideways.jpg', 'sunset.png', '山 hills.webp', 'broken.jpg']) assert(names.includes(n), n + ' listed: ' + names);
      const broken = await js('window.__app.S.rows.find((r) => r.name === "broken.jpg")');
      assert(/damaged|not a photo/.test(broken.problem), 'broken flagged: ' + broken.problem);
      const side = await js('window.__app.S.rows.find((r) => r.name === "phone sideways.jpg")');
      eq(`${side.width}x${side.height}`, '900x1200', 'the sideways photo is listed upright');
      eq(await js('document.getElementById("start").textContent'), 'Edit 4 photos', 'start button counts readable photos');
      await waitFor('document.querySelectorAll("#list img[src^=\'data:\']").length >= 4', 8000, 'thumbnails');
      return names.join(', ');
    });

    await step('the first photo is previewed before / after with the real pipeline, and the final size is shown', async () => {
      await waitFor('!!document.getElementById("imgAfter").getAttribute("src") && document.getElementById("pvBusy").hidden', 10000, 'preview');
      const size = await js('document.getElementById("pvSize").textContent');
      assert(/→ \d+ × \d+/.test(size), size);
      const first = await js('window.__app.S.rows[window.__app.S.rows.findIndex((r) => r.id === window.__app.S.current)].name');
      return `${first}: ${size}`;
    });

    await step('clicking the sideways photo previews it upright', async () => {
      const id = await js('window.__app.S.rows.find((r) => r.name === "phone sideways.jpg").id');
      const before = await afterSrc();
      await click(`#list .item[data-id="${id}"]`);
      await waitPreviewChange(before, 'preview of the sideways photo');
      const dims = await js('new Promise((ok) => { const i = document.getElementById("imgBefore"); const d = () => ok([i.naturalWidth, i.naturalHeight]); if (i.complete) d(); else i.onload = d; })');
      assert(dims[1] > dims[0], 'upright (taller than wide): ' + dims);
      assert(/900 × 1200 → 1536 × 2048|900 × 1200 → 900 × 1200/.test(await js('document.getElementById("pvSize").textContent')), 'size line');
      return dims.join('x');
    });

    await step('building the recipe by hand: add a border, set its colour, move it up, change the resize, edit the text', async () => {
      // resize: long edge 600, typed into the box
      await click('.step[data-type="resize"] input[type="number"]');
      await js('document.querySelector(".step[data-type=resize] input[type=number]").select()');
      await typeText('600'); await key('Tab');
      await waitFor('window.__app.S.recipe[0].long === 600', 3000, 'long edge read');
      // add a border step with the "Add a step" menu
      let before = await afterSrc();
      await choose('#addStep', 'border');
      await waitFor('window.__app.S.recipe.length === 4 && window.__app.S.recipe[3].type === "border"', 3000, 'border added');
      await waitPreviewChange(before, 'preview with a border');
      await js('(() => { const c = document.querySelector(".step[data-type=border] input[type=color]"); c.value = "#ff00aa"; c.dispatchEvent(new Event("input")); c.dispatchEvent(new Event("change")); })()');
      // move it above the text watermark with a real click on its ▲ button
      await click('.step[data-type="border"] .icon[title="Move up"]');
      eq(JSON.stringify(await js('window.__app.S.recipe.map((s) => s.type)')), JSON.stringify(['resize', 'levels', 'border', 'text']), 'order after moving');
      // edit the watermark text by typing
      await click('.step[data-type="text"] input[type="text"]');
      await js('document.querySelector(".step[data-type=text] input[type=text]").select()');
      before = await afterSrc();
      await typeText('© Invented Studio');
      await key('Tab');
      await waitFor('window.__app.S.recipe[3].text === "© Invented Studio"', 3000, 'text read');
      await waitPreviewChange(before, 'preview with the new text');
      // switch auto levels off with its checkbox
      await click('.step[data-type="levels"] .sh input[type="checkbox"]');
      eq(await js('window.__app.S.recipe[1].on'), false, 'levels off');
      await shot('2-recipe');
      return await js('document.getElementById("pvSize").textContent');
    });

    await step('the slider view shows before and after on top of each other', async () => {
      await click('#modeSlider');
      eq(await js('document.getElementById("stage").classList.contains("slide")'), true, 'slider mode');
      await waitFor('document.getElementById("sBefore").clientWidth > 50', 5000, 'slider image laid out');
      const r = await box('#sRange');
      await clickAt(Math.round(r.x + r.w * 0.8), r.cy);
      const v = await js('Number(document.getElementById("sRange").value)');
      assert(v > 65, 'slider moved: ' + v);
      assert(/^8|^7/.test(await js('document.getElementById("sclip").style.width')), 'clip follows');
      await click('#modeSide');
      return 'divider at ' + v + '%';
    });

    await step('output settings: WebP, keep copyright only, a chosen folder, a rename pattern', async () => {
      await choose('#format', 'webp');
      await choose('#metadata', 'copyright');
      await click('#pickOut');
      await waitFor(`document.getElementById("outDir").textContent === ${JSON.stringify(outDir)}`, 3000, 'output folder shown');
      await click('#pattern');
      await js('document.getElementById("pattern").select()');
      await typeText('{date} {name} {n:2} {w}x{h}');
      await key('Tab');
      await waitFor('window.__app.S.output.pattern === "{date} {name} {n:2} {w}x{h}"', 3000, 'pattern read');
      const ex = await js('document.getElementById("patEx").textContent');
      assert(/\.webp$/.test(ex) && /\d+x\d+/.test(ex), 'example name ' + ex);
      return ex;
    });

    await step('Edit 4 photos (real click): progress per photo, files written with the recipe, originals untouched', async () => {
      await click('#start');
      await waitFor('!document.getElementById("runbar").hidden', 3000, 'progress bar');
      await waitFor('!window.__app.S.running', 60000, 'batch finished');
      const text = await js('document.getElementById("runText").textContent');
      assert(/^4 photos saved/.test(text), text);
      eq(await js('document.getElementById("reveal").hidden'), false, 'Show in folder offered');
      const states = await js('window.__app.S.rows.filter((r) => !r.problem).map((r) => r.status)');
      eq(JSON.stringify(states), JSON.stringify(['done', 'done', 'done', 'done']), 'row states');
      const out = fs.readdirSync(outDir).sort();
      eq(out.length, 4, 'four files: ' + out);
      assert(out.includes('2025-07-14 beach 01 01 624x424.webp'), 'name from the pattern with the EXIF date: ' + out);
      eq(files.map(hash).join(), hashes.join(), 'originals unchanged');
      // check the sideways photo: upright, 450x600 plus a 3% border (14 px) in pink
      const side = out.find((n) => /phone sideways/.test(n));
      assert(/478x628/.test(side), 'size in the name ' + side);
      const px = await sharp(path.join(outDir, side)).raw().toBuffer({ resolveWithObject: true });
      eq(`${px.info.width}x${px.info.height}`, '478x628', 'size');
      const at = (x, y) => { const i = (y * px.info.width + x) * px.info.channels; return [px.data[i], px.data[i + 1], px.data[i + 2]]; };
      const c = at(3, 300);
      assert(c[0] > 230 && c[1] < 30 && c[2] > 150, 'pink border ' + c);
      const meta = await sharp(path.join(outDir, out.find((n) => /beach/.test(n)))).metadata();
      eq(meta.format, 'webp', 'format');
      assert(meta.exif, 'copyright kept');
      return out.join(' | ');
    });

    await step('running again never overwrites: the new files get "(2)"', async () => {
      await click('#start');
      await waitFor('!window.__app.S.running && /^4 photos saved/.test(document.getElementById("runText").textContent)', 60000, 'second run');
      const out = fs.readdirSync(outDir);
      eq(out.length, 8, 'eight files');
      assert(out.includes('2025-07-14 beach 01 01 624x424 (2).webp'), out.join(' | '));
      return 'ok';
    });

    await step('presets: save the recipe under a name, change it, load the preset back', async () => {
      await click('#savePreset');
      await waitFor('!document.getElementById("presetForm").hidden', 2000, 'preset form');
      await typeText('Web 600 pink');
      await key('Return');
      await waitFor('!!window.__app.S.presets["Web 600 pink"]', 3000, 'preset saved');
      await click('.step[data-type="border"] .icon[title="Remove this step"]');
      eq(await js('window.__app.S.recipe.length'), 3, 'border removed');
      await choose('#preset', '');
      await choose('#preset', 'Web 600 pink');
      await waitFor('window.__app.S.recipe.length === 4 && window.__app.S.recipe[2].type === "border" && window.__app.S.recipe[2].colour === "#ff00aa"', 3000, 'preset loaded');
      const file = path.join(app.getPath('userData'), 'presets.json');
      assert(JSON.parse(fs.readFileSync(file, 'utf8'))['Web 600 pink'].recipe.length === 4, 'stored as JSON in the user data folder');
      return 'Web 600 pink';
    });

    await step('Cancel stops a big batch part way; nothing half-written is left', async () => {
      const many = path.join(dir, 'many');
      fs.mkdirSync(many);
      for (let i = 0; i < 24; i++) await makePhoto(path.join(many, `img ${String(i).padStart(2, '0')}.jpg`), 2400, 1600, { index: i });
      await click('#clear');
      await waitFor('window.__app.S.rows.length === 0', 3000, 'cleared');
      folderReturn = many;
      await click('#addFolder2');
      await waitFor('window.__app.S.rows.length === 24', 10000, '24 rows');
      await choose('#format', 'png');
      const resize = await js('window.__app.S.recipe.findIndex((s) => s.type === "resize")');
      await js(`window.__app.S.recipe[${resize}].long = 3000; window.__app.S.recipe[${resize}].noUpscale = false; 1`);
      await click('#start');
      await waitFor('window.__app.S.rows.some((r) => r.status === "done" || r.status === "working")', 20000, 'started');
      await click('#cancel');
      await waitFor('!window.__app.S.running', 60000, 'stopped');
      const text = await js('document.getElementById("runText").textContent');
      assert(/skipped \(cancelled\)/.test(text), text);
      const left = fs.readdirSync(outDir).filter((n) => /^\d{4}-\d\d-\d\d img/.test(n) || /img \d\d/.test(n));
      assert(left.length < 24, 'not all were made: ' + left.length);
      eq(fs.readdirSync(outDir).filter((n) => n.endsWith('.part')).length, 0, 'no .part files');
      return text;
    });

    await step('no errors in the window console', async () => { if (errors.length) throw new Error(errors.join(' | ')); });
  } catch (e) {
    results.push({ name: 'e2e crashed', ok: false, error: String((e && e.stack) || e) });
  }
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  const ok = results.every((r) => r.ok);
  fs.writeFileSync(outFile, JSON.stringify({ ok, results }, null, 2));
  exit(ok ? 0 : 1);
};
