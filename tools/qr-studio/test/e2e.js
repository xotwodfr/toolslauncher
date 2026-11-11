'use strict';
// End-to-end test: runs inside Electron (`npm run e2e`). Drives the REAL window with real mouse and keyboard input: makes
// QR codes and barcodes, saves them, and reads the saved files back with the app's reader; reads a picture with several
// codes, a pasted picture and the screen; makes a batch into a folder twice (nothing is overwritten).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { decode } = require('../src/reader');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

exports.run = async ({ app, getWin, outFile, shotsDir, dialog, shell, clipboard, nativeImage }) => {
  const results = [];
  const errors = [];
  const notes = {};
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qrstudio-e2e-'));
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
  const waitFor = async (expr, ms = 10000, what = expr) => {
    const end = Date.now() + ms;
    for (;;) { const v = await js(expr); if (v) return v; if (Date.now() > end) throw new Error('timed out waiting for ' + what); await sleep(50); }
  };
  const shot = async (name) => {
    if (!shotsDir) return;
    fs.mkdirSync(shotsDir, { recursive: true });
    await sleep(300);
    fs.writeFileSync(path.join(shotsDir, name + '.png'), (await wc.capturePage()).toPNG());
  };
  const key = async (keyCode, modifiers = [], char = false) => {
    wc.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
    if (char) wc.sendInputEvent({ type: 'char', keyCode: char === true ? keyCode : char, modifiers });
    wc.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
    await sleep(25);
  };
  const typeText = async (text) => { for (const ch of text) { if (ch === '\n') await key('Enter', [], '\r'); else await key(ch, [], true); } };
  const center = (selector) => js(`(()=>{const e=document.querySelector(${JSON.stringify(selector)}); if(!e) return null; e.scrollIntoView({block:'nearest'}); const b=e.getBoundingClientRect(); return {x:Math.round(b.x+b.width/2), y:Math.round(b.y+b.height/2)};})()`);
  const clickAt = async (x, y) => {
    wc.sendInputEvent({ type: 'mouseMove', x, y });
    wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
    wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
    await sleep(120);
  };
  const click = async (selector) => { const r = await center(selector); if (!r) throw new Error('nothing to click: ' + selector); await clickAt(r.x, r.y); };
  const fill = async (selector, text) => { await click(selector); await key('a', ['control']); await key('Backspace'); await typeText(text); };
  const checked = (id) => waitFor(`/Checked: it scans/.test(document.getElementById(${JSON.stringify(id)}).textContent)`, 10000, id + ' says it scans');
  /** read a PNG file with the app's reader */
  const readFile = async (file) => {
    const img = nativeImage.createFromPath(file);
    const { width, height } = img.getSize();
    const bgra = img.toBitmap(); const data = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < data.length; i += 4) { data[i] = bgra[i + 2]; data[i + 1] = bgra[i + 1]; data[i + 2] = bgra[i]; data[i + 3] = 255; }
    return { size: { width, height }, codes: await decode({ width, height, data }) };
  };
  const waitFile = async (f, ms = 8000) => { const end = Date.now() + ms; while (!fs.existsSync(f) && Date.now() < end) await sleep(50); assert(fs.existsSync(f), 'file written: ' + f); };

  try {
    win.setContentSize(1240, 840);
    let saveTo = null; let openReturn = []; let dirReturn = null; let confirm = 1; const boxes = []; const opened = [];
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: saveTo });
    dialog.showOpenDialog = async (_w, o) => ({ canceled: false, filePaths: o && o.properties && o.properties.includes('openDirectory') ? [dirReturn] : openReturn });
    dialog.showMessageBox = async (_w, o) => { boxes.push(o); return { response: confirm }; };
    shell.openExternal = async (u) => { opened.push(u); };
    shell.openPath = async () => '';

    await step('the window starts on Make QR; typing a web address (real keys) draws the code and checks that it scans', async () => {
      await waitFor('!!window.__app');
      await js('window.__app.setTab("make")');
      await click('#kinds [data-kind="url"]');
      await fill('#f-url', 'example.org/menu?table=7');
      await waitFor('!document.getElementById("qrImg").hidden', 6000, 'preview');
      eq(await js('document.getElementById("qrText").textContent'), 'https://example.org/menu?table=7', 'https:// added');
      await checked('qrCheck');
      assert(/Version \d+ · \d+ × \d+ modules · error correction M/.test(await js('document.getElementById("qrInfo").textContent')), 'info line');
    });

    const ssid = 'Café;Net,"5G"'; const pw = 'p@ss:w;rd\\1';
    await step('a Wi-Fi code (real clicks and keys) escapes the special characters and scans', async () => {
      await click('#kinds [data-kind="wifi"]');
      eq(await js('document.querySelector("#kinds [data-kind=wifi]").getAttribute("aria-checked")'), 'true', 'Wi-Fi chosen');
      await fill('#f-ssid', ssid);
      await fill('#f-password', pw);
      await waitFor(`document.getElementById("qrText").textContent === ${JSON.stringify('WIFI:T:WPA;S:Café\\;Net\\,\\"5G\\";P:p@ss\\:w\\;rd\\\\1;;')}`, 6000, 'escaped Wi-Fi text');
      await checked('qrCheck');
      await click('#f-security'); await key('Escape');
      await js('(() => { const s = document.getElementById("f-security"); s.value = "nopass"; s.dispatchEvent(new Event("change")); })()');
      await waitFor('!document.getElementById("f-password")', 3000, 'password field hidden for an open network');
      await waitFor('document.getElementById("qrText").textContent.startsWith("WIFI:T:nopass;")', 3000, 'open network');
      await js('(() => { const s = document.getElementById("f-security"); s.value = "WPA"; s.dispatchEvent(new Event("change")); })()');
      await waitFor('!!document.getElementById("f-password") && document.getElementById("f-password").value === ' + JSON.stringify(pw), 3000, 'password kept');
      await shot('1-wifi');
    });

    await step('styles and colours: dots still scan; light-on-dark colours give a plain warning', async () => {
      await click('[data-style="dots"]');
      await checked('qrCheck');
      await js('(() => { const f = document.getElementById("fg"); f.value = "#f0f0f0"; f.dispatchEvent(new Event("input")); const b = document.getElementById("bg"); b.value = "#111111"; b.dispatchEvent(new Event("input")); })()');
      await waitFor('/inverted/.test(document.getElementById("qrWarn").textContent)', 4000, 'inverted warning');
      await js('(() => { const f = document.getElementById("fg"); f.value = "#14213d"; f.dispatchEvent(new Event("input")); const b = document.getElementById("bg"); b.value = "#ffffff"; b.dispatchEvent(new Event("input")); })()');
      await waitFor('document.getElementById("qrWarn").textContent === ""', 4000, 'warning gone');
      await click('[data-style="rounded"]');
      await checked('qrCheck');
    });

    const logoFile = path.join(dir, 'logo.png');
    await step('a logo (Choose a logo…, real click) forces level H, and the code still scans', async () => {
      const bmp = Buffer.alloc(96 * 96 * 4);
      for (let y = 0; y < 96; y++) for (let x = 0; x < 96; x++) { const i = (y * 96 + x) * 4; const inC = (x - 48) ** 2 + (y - 48) ** 2 < 44 ** 2; bmp[i] = inC ? 77 : 255; bmp[i + 1] = inC ? 72 : 255; bmp[i + 2] = inC ? 229 : 255; bmp[i + 3] = 255; }
      fs.writeFileSync(logoFile, nativeImage.createFromBitmap(bmp, { width: 96, height: 96 }).toPNG());
      openReturn = [logoFile];
      await click('#logoPick');
      await waitFor('!document.getElementById("logoPrev").hidden', 4000, 'logo shown');
      eq(await js('document.getElementById("level").value'), 'H', 'level H');
      eq(await js('document.getElementById("level").disabled'), true, 'level locked');
      await waitFor('/error correction H/.test(document.getElementById("qrInfo").textContent)', 4000, 'H used');
      await checked('qrCheck');
      await shot('2-logo');
    });

    await step('Save PNG… (real click) writes a PNG of the chosen size that reads back as the same Wi-Fi network', async () => {
      await fill('#qrSize', '800'); await key('Tab');
      saveTo = path.join(dir, 'wifi.png');
      await click('#qrPng');
      await waitFile(saveTo);
      const r = await readFile(saveTo);
      eq(r.size.width, 800, 'width'); eq(r.size.height, 800, 'height');
      eq(r.codes.length, 1, 'one code');
      eq(r.codes[0].parsed.kind, 'wifi', 'kind');
      eq(r.codes[0].parsed.fields.find((f) => f.label === 'Network').value, ssid, 'network');
      eq(r.codes[0].parsed.fields.find((f) => f.label === 'Password').value, pw, 'password');
      assert(!fs.existsSync(saveTo + '.part'), 'no temporary file left');
    });

    await step('Save SVG… and Copy picture (real clicks) work', async () => {
      saveTo = path.join(dir, 'wifi.svg');
      await click('#qrSvg');
      await waitFile(saveTo);
      const svg = fs.readFileSync(saveTo, 'utf8');
      assert(svg.startsWith('<svg') && svg.includes('<image'), 'an SVG with the logo');
      clipboard.clear();
      await click('#qrCopy');
      await waitFor('/Copied/.test(document.getElementById("toast").textContent)', 4000, 'copied');
      const img = clipboard.readImage();
      assert(!img.isEmpty() && img.getSize().width === 800, 'picture on the clipboard: ' + JSON.stringify(img.getSize()));
      await click('#logoClear');
      await waitFor('document.getElementById("logoPrev").hidden && !document.getElementById("level").disabled', 3000, 'logo removed');
    });

    await step('a contact (vCard) and a calendar event are built from the forms and scan', async () => {
      await click('#kinds [data-kind="contact"]');
      await fill('#f-first', 'Ada');
      await fill('#f-last', 'Example');
      await fill('#f-org', 'Engines, Ltd');
      await fill('#f-phone', '+44 20 7946 0000');
      await waitFor('document.getElementById("qrText").textContent.includes("ORG:Engines\\\\, Ltd")', 4000, 'escaped comma');
      await checked('qrCheck');
      await click('#kinds [data-kind="event"]');
      await fill('#f-title', 'Planning; room 2');
      await js('(() => { const s = document.getElementById("f-start"); s.value = "2026-11-20T10:00"; s.dispatchEvent(new Event("input")); const e = document.getElementById("f-end"); e.value = "2026-11-20T11:30"; e.dispatchEvent(new Event("input")); })()');
      await waitFor('/DTSTART:20261120T100000/.test(document.getElementById("qrText").textContent)', 4000, 'event text');
      assert(/SUMMARY:Planning\\; room 2/.test(await js('document.getElementById("qrText").textContent')), 'escaped summary');
      await checked('qrCheck');
      await js('(() => { const e = document.getElementById("f-end"); e.value = "2026-11-20T09:00"; e.dispatchEvent(new Event("input")); })()');
      await waitFor('/ends before it starts/.test(document.getElementById("qrWarn").textContent)', 4000, 'end before start explained');
    });

    await step('Barcodes (real clicks and keys): a wrong EAN check digit is explained, the right one scans; Code 39 / Code 128 / ITF too', async () => {
      await click('#tab-bar');
      await js('(() => { const s = document.getElementById("sym"); s.value = "ean13"; s.dispatchEvent(new Event("change")); })()');
      await fill('#barValue', '5901234123458');
      await waitFor('/should be 7/.test(document.getElementById("barStatus").textContent)', 4000, 'check digit explained');
      eq(await js('document.getElementById("barPng").disabled'), true, 'nothing to save');
      await key('Backspace');
      await waitFor('/Check digit 7 added/.test(document.getElementById("barStatus").textContent)', 4000, 'check digit added');
      await checked('barCheckLine');
      for (const [kind, value, want] of [['code39', 'part-77', 'PART-77'], ['code128', 'Box #42 / a', 'Box #42 / a'], ['itf', '12345', '012345'], ['upca', '03600029145', '036000291452'], ['ean8', '9638507', '96385074']]) {
        await js(`(() => { const s = document.getElementById("sym"); s.value = ${JSON.stringify(kind)}; s.dispatchEvent(new Event("change")); })()`);
        await fill('#barValue', value);
        await waitFor(`document.getElementById("barStatus").textContent.endsWith("Encodes ${want}")`, 4000, kind + ' encodes ' + want);
        await checked('barCheckLine');
      }
      saveTo = path.join(dir, 'ean8.png');
      await click('#barPng');
      await waitFile(saveTo);
      const r = await readFile(saveTo);
      eq(r.codes.length, 1, 'one barcode'); eq(r.codes[0].text, '96385074', 'EAN-8 read back from the file'); eq(r.size.width, 1200, 'PNG width');
      await shot('3-barcode');
    });

    // a picture with three codes: the Wi-Fi PNG saved above, a link QR and the EAN-8 barcode
    const multi = path.join(dir, 'several codes.png');
    await step('Read: Open picture… (real click) finds every code in a picture, outlines them and shows what each holds; links are not opened', async () => {
      const qrUrl = await js('(async () => { const r = await window.qs.makeQr("http://example.org/offer", { size: 400 }); const c = await window.__app.svgCanvas(r.svg, 400, 400, true); return c.toDataURL(); })()');
      const parts = [nativeImage.createFromPath(path.join(dir, 'wifi.png')).resize({ width: 420 }), nativeImage.createFromDataURL(qrUrl), nativeImage.createFromPath(path.join(dir, 'ean8.png')).resize({ width: 520 })];
      const W = parts.reduce((t, p) => t + p.getSize().width + 60, 60); const H = Math.max(...parts.map((p) => p.getSize().height)) + 120;
      const page = Buffer.alloc(W * H * 4, 255);
      let ox = 60;
      for (const p of parts) {
        const { width, height } = p.getSize(); const b = p.toBitmap();
        for (let y = 0; y < height; y++) b.copy(page, ((y + 60) * W + ox) * 4, y * width * 4, (y + 1) * width * 4);
        ox += width + 60;
      }
      fs.writeFileSync(multi, nativeImage.createFromBitmap(page, { width: W, height: H }).toPNG());
      openReturn = [multi];
      await click('#tab-read');
      await click('#readOpen');
      await waitFor('document.querySelectorAll("#readList .code").length === 3', 15000, 'three codes');
      assert(/3 codes found in several codes\.png/.test(await js('document.getElementById("readStatus").textContent')), 'status');
      eq(await js('document.getElementById("readCanvas").hidden'), false, 'picture with outlines shown');
      const kinds = await js('[...document.querySelectorAll("#readList .code")].map((c) => c.dataset.kind).sort().join(",")');
      eq(kinds, 'product,url,wifi', 'kinds');
      eq(await js('document.querySelector("#readList .code[data-kind=wifi] dd[data-field=Network]").textContent'), ssid, 'network shown');
      eq(await js('document.querySelector("#readList .code[data-kind=wifi] dd[data-field=Password]").textContent'), pw, 'password shown');
      await click('#readList .code[data-kind=wifi] button[aria-label="Copy Password"]');
      await sleep(150);
      eq(clipboard.readText(), pw, 'password copied');
      assert(/not secure/.test(await js('document.querySelector("#readList .code[data-kind=url]").textContent')), 'http link flagged');
      eq(opened.length, 0, 'the link was not opened by itself');
      confirm = 1;
      await click('#readList .code[data-kind=url] .acts button:nth-child(2)');
      await sleep(200);
      assert(boxes.length && /example\.org\/offer/.test(boxes[boxes.length - 1].detail), 'asks first, showing the address');
      eq(opened.length, 0, 'Cancel keeps it closed');
      // the outline colours are drawn on the canvas where the codes are
      const px = await js('(() => { const c = document.getElementById("readCanvas"); const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i] === 184 && d[i + 1] === 242 && d[i + 2] === 230) n++; return n; })()');
      assert(px > 50, 'outline pixels drawn: ' + px);
      await shot('4-read');
    });

    await step('Paste (real Ctrl+V) reads a picture from the clipboard', async () => {
      const r = await js('(async () => { const x = await window.qs.makeQr("PASTED 42", { size: 300 }); const c = await window.__app.svgCanvas(x.svg, 300, 300, true); return c.toDataURL(); })()');
      clipboard.writeImage(nativeImage.createFromDataURL(r));
      await js('document.activeElement && document.activeElement.blur()');
      await key('v', ['control']);
      await waitFor('document.querySelectorAll("#readList .code").length === 1 && /PASTED 42/.test(document.getElementById("readList").textContent)', 10000, 'pasted code read');
      await click('#readPaste');
      await waitFor('/pasted picture/.test(document.getElementById("readStatus").textContent)', 6000, 'Paste picture button');
    });

    await step('Read from screen (real click) captures the screen and finds the code shown on it', async () => {
      await js('(() => { document.getElementById("hideWin").checked = false; document.getElementById("hideWin").dispatchEvent(new Event("change")); })()');
      await click('#readScreen');
      await waitFor('!window.__app.S.reading', 30000, 'capture finished');
      const status = await js('document.getElementById("readStatus").textContent');
      const toastText = await js('document.getElementById("toast").hidden ? "" : document.getElementById("toast").textContent');
      if (/could not be captured/.test(toastText)) { notes.screen = 'screen capture not available here: ' + toastText; return 'skipped: ' + toastText; }
      assert(/code/.test(status), status);
      assert(/PASTED 42/.test(await js('document.getElementById("readList").textContent')), 'the code that was on the screen (the pasted one) was found');
      notes.screen = status;
      return status;
    });

    await step('Batch (real clicks): a list becomes a folder of PNG and SVG files; bad lines are explained; a second run never overwrites', async () => {
      const out = path.join(dir, 'batch out'); fs.mkdirSync(out);
      dirReturn = out;
      await click('#tab-batch');
      await js('(() => { const s = document.getElementById("batchKind"); s.value = "ean13"; s.dispatchEvent(new Event("change")); })()');
      await click('#batchText');
      await typeText('590123412345\n400638133393\n123\n');
      await click('#batchDir');
      await waitFor('!document.getElementById("batchGo").disabled', 3000, 'ready');
      eq(await js('document.getElementById("batchGo").textContent'), 'Make 3 codes', 'count on the button');
      await click('[data-fmt="both"]');
      await click('#batchGo');
      await waitFor('!document.getElementById("batchResult").hidden', 20000, 'batch done');
      assert(/Made 2 codes \(4 files\), 1 could not be made/.test(await js('document.getElementById("batchResult").textContent')), await js('document.getElementById("batchResult").textContent'));
      assert(/Line 3 .*12 or 13 digits/.test(await js('document.getElementById("batchErrors").textContent')), 'bad line explained');
      let names = fs.readdirSync(out).sort();
      eq(JSON.stringify(names), JSON.stringify(['1 5901234123457.png', '1 5901234123457.svg', '2 4006381333931.png', '2 4006381333931.svg']), 'files');
      const r = await readFile(path.join(out, '2 4006381333931.png'));
      eq(r.codes[0].text, '4006381333931', 'batch PNG reads back');
      await click('#batchGo');
      await waitFor('/Made 2 codes/.test(document.getElementById("batchResult").textContent) && document.getElementById("batchCancel").hidden', 20000, 'second run');
      names = fs.readdirSync(out).sort();
      eq(names.length, 8, 'eight files'); assert(names.includes('1 5901234123457 (2).png'), 'new names: ' + names);
      // a CSV with names in the second column, as QR codes
      await js('(() => { const s = document.getElementById("batchKind"); s.value = "qr"; s.dispatchEvent(new Event("change")); const t = document.getElementById("batchText"); t.value = "\\"https://example.org/a,1\\",Table A\\nhttps://example.org/b,Table B"; t.dispatchEvent(new Event("input")); })()');
      await click('[data-fmt="png"]');
      await waitFor('document.getElementById("batchGo").textContent === "Make 2 codes"', 3000, 'csv parsed');
      await click('#batchGo');
      await waitFor('/Made 2 codes \\(2 files\\)\\./.test(document.getElementById("batchResult").textContent)', 20000, 'csv batch');
      const a = await readFile(path.join(out, '1 Table A.png'));
      eq(a.codes[0].text, 'https://example.org/a,1', 'CSV quoting kept the comma');
      await shot('5-batch');
    });

    await step('the window never showed an error and every control has a name for screen readers', async () => {
      eq(errors.filter((e) => !/Autofill/.test(e)).join(' | '), '', 'console errors');
      for (const t of ['make', 'bar', 'read', 'batch']) {
        await js(`window.__app.setTab(${JSON.stringify(t)})`);
        const unnamed = await js(`[...document.querySelectorAll('button, input, select, textarea')].filter((e) => e.offsetParent && !(e.getAttribute('aria-label') || e.textContent.trim() || (e.labels && e.labels.length) || e.title)).map((e) => e.outerHTML.slice(0, 80))`);
        eq(JSON.stringify(unnamed), '[]', 'unnamed controls on ' + t);
      }
    });
  } finally {
    const ok = results.every((r) => r.ok);
    try { fs.writeFileSync(outFile, JSON.stringify({ ok, results, notes }, null, 2)); } catch (e) { console.log('could not write the report', e); }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    app.exit(ok ? 0 : 1);
  }
};
