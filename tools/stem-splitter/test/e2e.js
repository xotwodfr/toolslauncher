'use strict';
// End-to-end test: runs inside Electron (`npm run e2e`). Drives the REAL window with real mouse and keyboard input and
// the REAL Demucs model, then checks what the page shows AND the files it writes (decoded with ffmpeg and measured).
const fs = require('fs');
const os = require('os');
const path = require('path');
const K = require('../src/testkit');
const S = require('../src/stems');
const P = require('../src/plan');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A little "band" (invented): a kick-like pulse, a plucked chord, a lead melody and some hiss. */
function band(i, rate) {
  const t = i / rate;
  const beat = t % 0.5;
  const kick = Math.sin(2 * Math.PI * (50 + 90 * Math.exp(-beat * 30)) * t) * Math.exp(-beat * 9) * 0.55;
  const hat = ((i * 7919) % 1000 / 1000 - 0.5) * Math.exp(-(t % 0.25) * 40) * 0.25;
  const chord = (Math.sin(2 * Math.PI * 220 * t) + Math.sin(2 * Math.PI * 277.2 * t) + Math.sin(2 * Math.PI * 329.6 * t)) * 0.07 * (0.6 + 0.4 * Math.sin(t * 2));
  const lead = Math.sin(2 * Math.PI * (440 + 110 * Math.floor((t * 2) % 4)) * t) * 0.14 * Math.exp(-(t % 0.5) * 3);
  return kick + hat + chord + lead;
}

exports.run = async ({ app, getWin, openPaths, outFile, shotsDir, cacheRoot, dialog }) => {
  const results = [];
  const errors = [];
  const notes = {};
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stemsplit-e2e-'));
  const win = getWin();
  const wc = win.webContents;
  const ff = S.ffmpegPath();
  const js = (code) => wc.executeJavaScript(code, true);
  wc.on('console-message', (_e, level, msg) => { if (level >= 2) errors.push(msg); });
  const step = async (name, fn) => {
    try { const detail = await fn(); results.push({ name, ok: true, detail: detail === undefined ? '' : detail }); console.log('ok   ' + name); }
    catch (e) { results.push({ name, ok: false, error: String((e && e.message) || e) }); console.log('FAIL ' + name + ': ' + ((e && e.message) || e)); }
  };
  const eq = (a, b, what) => { if (a !== b) throw new Error(`${what}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); };
  const near = (a, b, tol, what) => { if (!(Math.abs(a - b) <= tol)) throw new Error(`${what}: expected ${b} +/- ${tol}, got ${a}`); };
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
  const key = async (keyCode, modifiers = [], char = false) => {
    wc.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
    if (char) wc.sendInputEvent({ type: 'char', keyCode: char === true ? keyCode : char, modifiers });
    wc.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
    await sleep(80);
  };
  const center = (selector) => js(`(()=>{const e=document.querySelector(${JSON.stringify(selector)}); if(!e) return null; e.scrollIntoView({block:'center'}); const b=e.getBoundingClientRect(); return {x:Math.round(b.x+b.width/2), y:Math.round(b.y+b.height/2), w:b.width, h:b.height, l:Math.round(b.left)};})()`);
  const clickAt = async (x, y) => {
    wc.sendInputEvent({ type: 'mouseMove', x, y });
    wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
    wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
    await sleep(100);
  };
  const click = async (selector) => { const r = await center(selector); if (!r) throw new Error('nothing to click: ' + selector); await clickAt(r.x, r.y); };
  const dec = (f) => { const d = K.decode(ff, f, 44100); if (d.errors) throw new Error('decode errors: ' + d.errors); return d; };
  const rms = (d) => { let s = 0; for (let i = 0; i < d.samples.length; i++) s += (d.samples[i] / 32768) ** 2; return Math.sqrt(s / d.samples.length); };
  const state = (expr) => js(`window.__app.${expr}`);

  try {
    win.setContentSize(1180, 820);
    const song = K.makeWav(path.join(dir, 'Demo Band.wav'), { rate: 44100, channels: 2, parts: [{ sec: 14, gen: band }] });
    const saved = path.join(dir, 'saved');
    fs.mkdirSync(saved, { recursive: true });
    let saveTo = null;
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [song] });
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: saveTo });

    await step('the window starts empty and the engine check passes', async () => {
      await waitFor('!!window.__app');
      eq(await js('document.getElementById("empty").hidden'), false, 'drop zone shown');
      eq(await js('document.getElementById("ready").hidden'), true, 'stems hidden');
      eq(await js('document.getElementById("open").disabled'), false, 'Open enabled (no engine problem; a low-memory note is allowed)');
      await shot('1-empty');
    });

    await step('Open song… (real click) splits it with the real model, with live progress', async () => {
      await click('#open');
      await waitFor('window.__app.S.view === "working"', 8000, 'working view');
      await waitFor('/Separating/.test(document.getElementById("wPhase").textContent) && parseFloat(document.getElementById("wFill").style.width) > 5', 60000, 'separation progress');
      eq(await js('document.getElementById("open").disabled'), true, 'Open disabled while working');
      await shot('2-working');
      const t0 = Date.now();
      await waitFor('window.__app.S.view === "ready"', 120000, 'the stems');
      notes.splitSeconds = Number(((Date.now() - t0) / 1000).toFixed(1));
      return `split + prepared in about ${notes.splitSeconds} s more`;
    });

    await step('all six lanes are drawn with their own waveform, and the preview is ready', async () => {
      await sleep(300);
      const info = await js(`(()=>{const out={}; for (const id of window.__app.P.STEM_IDS){ const c=document.querySelector('.lane[data-stem="'+id+'"] canvas'); const g=c.getContext('2d'); const d=g.getImageData(0,0,c.width,c.height).data; let cols=new Set(); let rows=new Set(); for(let i=3;i<d.length;i+=4){ if(d[i]>0){ const p=(i-3)/4; cols.add(p%c.width); rows.add(Math.floor(p/c.width)); } } out[id]={cols:cols.size/c.width, rows:rows.size, w:c.width}; } return out;})()`);
      for (const id of P.STEM_IDS) assert(info[id].cols > 0.9, `${id}: waveform covers the lane (${info[id].cols})`);
      const tall = P.STEM_IDS.filter((id) => info[id].rows > 8);
      assert(tall.length >= 2, 'at least two stems have real sound: ' + tall.join(','));
      eq(await js('document.getElementById("play").disabled'), false, 'Play enabled');
      eq(await state('S.song.name'), 'Demo Band.wav', 'name');
      assert(/split in/.test(await js('document.getElementById("rInfo").textContent')), 'says it was split');
      await shot('3-ready');
      return 'tall lanes: ' + tall.join(', ');
    });

    await step('a combination chip (real click) ticks exactly those stems and dims the rest', async () => {
      await click('.chip[data-preset="voice-bass"]');
      eq(JSON.stringify(await state('S.mix') && (await js('Object.entries(window.__app.S.mix).filter(([,m])=>m.on).map(([k])=>k)'))), JSON.stringify(['vocals', 'bass']), 'ticked stems');
      eq(await js('document.querySelector(".chip[data-preset=voice-bass]").getAttribute("aria-pressed")'), 'true', 'chip pressed');
      eq(await js('document.querySelectorAll(".lane.off").length'), 4, 'four lanes dimmed');
      eq(await js('document.getElementById("summary").textContent.includes("vocals + bass")'), true, 'summary says so');
    });

    await step('ticking a stem by clicking its box, and the "only" button, and the number keys', async () => {
      await click('.lane[data-stem="drums"] input[type="checkbox"]');
      eq(await state('S.mix.drums.on'), true, 'drums on');
      eq(await js('document.getElementById("summary").textContent.includes("vocals + drums + bass")'), true, 'summary updated');
      eq(await js('document.querySelector(".chip[data-preset=voice-rhythm]").getAttribute("aria-pressed")'), 'true', 'matches a preset');
      await click('.lane[data-stem="guitar"] .only');
      eq(JSON.stringify(await js('Object.entries(window.__app.S.mix).filter(([,m])=>m.on).map(([k])=>k)')), JSON.stringify(['guitar']), 'only guitar');
      await key('1', [], true);               // 1 = vocals
      eq(await state('S.mix.vocals.on'), true, 'key 1 ticks vocals');
      await key('1', [], true);
      eq(await state('S.mix.vocals.on'), false, 'key 1 unticks vocals');
    });

    await step('playing: sound runs, only the ticked stems are audible, Space pauses, a click seeks', async () => {
      await click('.chip[data-preset="rhythm"]');
      await click('#play');
      await waitFor('window.__app.S.playing === true && window.__app.position() > 0.6', 6000, 'playback');
      const gains = await js(`(()=>{const a=window.__app.audio(); return {state:a.ac.state, gains:Object.fromEntries(Object.entries(a.nodes).map(([k,n])=>[k, +n.gain.value.toFixed(3)]))};})()`);
      eq(gains.state, 'running', 'audio context');
      for (const id of P.STEM_IDS) near(gains.gains[id], ['drums', 'bass'].includes(id) ? 1 : 0, 0.02, 'gain of ' + id);
      eq(await js('document.getElementById("play").textContent.includes("Pause")'), true, 'button says Pause');
      await key('Space', [], ' ');
      eq(await state('S.playing'), false, 'Space paused');
      const at = await state('position()');
      await sleep(400);
      near(await state('position()'), at, 0.01, 'stays paused');
      // a click on the lane seeks to that spot
      const r = await center('.lane[data-stem="bass"] canvas');
      await clickAt(Math.round(r.l + r.w * 0.5), r.y);
      near(await state('position()'), 7, 0.4, 'seek to the middle');
      const ph = await js('parseFloat(document.getElementById("playhead").style.left)');
      near(ph, 50, 4, 'playhead at 50%');
    });

    await step('changing the combination during playback changes the sound at once', async () => {
      await click('#play');
      await waitFor('window.__app.S.playing === true', 4000);
      await click('.lane[data-stem="vocals"] .only');
      await sleep(250);
      const gains = await js(`(()=>{const a=window.__app.audio(); return Object.fromEntries(Object.entries(a.nodes).map(([k,n])=>[k, +n.gain.value.toFixed(3)]));})()`);
      near(gains.vocals, 1, 0.02, 'vocals audible'); near(gains.drums, 0, 0.02, 'drums silent');
      await js(`(()=>{const r=document.querySelector('.lane[data-stem="vocals"] input[type=range]'); r.value='50'; r.dispatchEvent(new Event('input',{bubbles:true}));})()`);
      await sleep(250);
      const g2 = await js(`window.__app.audio().nodes.vocals.gain.value`);
      near(g2, 0.5, 0.02, 'volume slider');
      await click('#play');
      eq(await state('S.playing'), false, 'paused');
      await js(`(()=>{const r=document.querySelector('.lane[data-stem="vocals"] input[type=range]'); r.value='100'; r.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    });

    // the three saves must agree with each other: "vocals only" + "no vocals" = "everything" (sample for sample)
    const saveAs = async (preset, format, name) => {
      saveTo = path.join(saved, name);
      await click(`.chip[data-preset="${preset}"]`);
      await js(`(()=>{const f=document.getElementById('format'); f.value=${JSON.stringify(format)}; f.dispatchEvent(new Event('change'));})()`);
      await click('#exportBtn');
      await waitFor('!document.getElementById("result").hidden && window.__app.S.busy === false', 30000, 'the save to finish');
      const cls = await js('document.getElementById("result").className');
      if (!cls.includes('ok')) throw new Error('save failed: ' + (await js('document.getElementById("result").textContent')));
      assert(fs.existsSync(saveTo), 'file exists: ' + saveTo);
      return saveTo;
    };

    await step('saving "everything", "vocals only" and "no vocals" gives files that add up', async () => {
      const all = dec(await saveAs('all', 'wav', 'all.wav'));
      const orig = dec(song);
      near(all.samples.length, orig.samples.length, 4, 'same length as the song');
      let num = 0; let den = 0;
      for (let i = 0; i < Math.min(all.samples.length, orig.samples.length); i++) { const d = all.samples[i] - orig.samples[i]; num += d * d; den += orig.samples[i] * orig.samples[i]; }
      const ratio = Math.sqrt(num / den);
      assert(ratio < 0.3, 'the six stems together are close to the original, got ' + ratio.toFixed(3));
      notes.rebuildError = Number(ratio.toFixed(3));
      const v = dec(await saveAs('vocals', 'wav', 'vocals.wav'));
      const nv = dec(await saveAs('instrumental', 'wav', 'novocals.wav'));
      let worst = 0;
      for (let i = 0; i < all.samples.length; i++) worst = Math.max(worst, Math.abs(v.samples[i] + nv.samples[i] - all.samples[i]));
      assert(worst <= 6, `vocals + no-vocals equals everything, largest difference ${worst}/32768`);
      assert(rms(v) < rms(all), 'the vocals alone are quieter than everything');
      await shot('4-saved');
      return `rebuild error ${(ratio * 100).toFixed(1)}%, parts add up to within ${worst} LSB`;
    });

    await step('every format saves, shows where, and names the mix', async () => {
      for (const fmt of ['flac', 'mp3']) {
        const f = await saveAs('rhythm', fmt, 'rhythm.' + fmt);
        const d = dec(f);
        near(d.samples.length / 44100, 14, fmt === 'mp3' ? 0.12 : 0.03, fmt + ' length');
        assert(fs.statSync(f).size > 5000, fmt + ' size');
      }
      const txt = await js('document.getElementById("result").textContent');
      assert(/Saved drums \+ bass/.test(txt), 'result text: ' + txt);
      assert(await js('!!document.querySelector("#result button")'), 'Show in folder button');
    });

    await step('saving with nothing ticked is refused with a readable message', async () => {
      await js(`(()=>{for (const id of window.__app.P.STEM_IDS) window.__app.S.mix[id].on=false; window.__app.applyMix();})()`);
      eq(await js('document.getElementById("exportBtn").disabled'), true, 'Save disabled');
      assert(/Tick at least one/.test(await js('document.getElementById("summary").textContent')), 'summary asks to tick');
      await click('.chip[data-preset="all"]');
    });

    await step('opening the same song again is instant (saved stems), and the cache is listed', async () => {
      const t0 = Date.now();
      const r = await openPaths([song]);
      eq(r.cached, true, 'cached flag');
      await js(`window.__app.handleOpened(${JSON.stringify(r)})`);
      await waitFor('window.__app.S.view === "ready"', 15000, 'ready from cache');
      const took = Date.now() - t0;
      assert(took < 8000, 'reopening took ' + took + ' ms');
      assert(/saved stems/.test(await js('document.getElementById("rInfo").textContent')), 'says saved stems');
      assert(/1 saved song/.test(await js('document.getElementById("cacheInfo").textContent')), 'cache info: ' + await js('document.getElementById("cacheInfo").textContent'));
      return `${took} ms`;
    });

    await step('Cancel during a split returns to the song, leaves nothing behind, and a retry works', async () => {
      const long = K.makeWav(path.join(dir, 'Longer.wav'), { rate: 44100, channels: 2, parts: [{ sec: 50, gen: band }] });
      const r = await openPaths([long]);
      assert(r.ok && !r.cached, 'opened, not cached');
      await js(`void window.__app.handleOpened(${JSON.stringify(r)})`); // not awaited: it resolves when the whole split is done
      await waitFor('window.__app.S.view === "working"', 8000);
      await js('window.__tl = []; window.ss.onProgress((p) => window.__tl.push([Date.now(), p.kind, p.phase, Math.round(p.fraction * 1000) / 1000])); void 0');
      await waitFor('parseFloat(document.getElementById("wFill").style.width) > 12', 60000, 'some progress');
      const t0 = Date.now();
      await click('#cancelBtn');
      const tClicked = Date.now();
      await waitFor('window.__app.S.view === "confirm" && window.__app.S.busy === false', 20000, 'back to the song');
      const took = Date.now() - t0;
      const tl = await js('window.__tl');
      notes.cancelTimeline = tl.map(([t, k, ph, f]) => `${t - t0}ms ${ph}@${f}`).join(' | ');
      // the split only notices a cancel between two segments (each takes about 4 s here), so a click can wait one segment
      assert(took < 9000, `cancel took ${took} ms (click handled after ${tClicked - t0} ms); progress: ${notes.cancelTimeline}`);
      const left = fs.readdirSync(cacheRoot()).filter((n) => n.endsWith('.part'));
      eq(left.length, 0, 'no half-made folders: ' + left);
      assert(/cancelled/i.test(await js('document.getElementById("cInfo").textContent')), 'says cancelled');
      await shot('5-cancelled');
      // retry: the same button starts it again and this time it runs to the end (nothing was left stuck by the cancel)
      await click('#splitBtn');
      await waitFor('window.__app.S.view === "working"', 8000, 'working again');
      await waitFor('window.__app.S.view === "ready"', 150000, 'the retried split');
      eq(await state('S.song.name'), 'Longer.wav', 'the retried song');
      assert(/split in/.test(await js('document.getElementById("rInfo").textContent')), 'was really split, not cached');
      eq(fs.readdirSync(cacheRoot()).filter((n) => n.endsWith('.part')).length, 0, 'no half-made folders after the retry');
      assert(fs.readdirSync(cacheRoot()).filter((n) => /^[0-9a-f]{20}$/.test(n)).length >= 2, 'both songs are saved');
    });

    await step('a long song waits for a click instead of starting a long split', async () => {
      const huge = K.makeWav(path.join(dir, 'Podcast.wav'), { rate: 8000, channels: 1, parts: [{ sec: 20 * 60, freq: 0 }] });
      const r = await openPaths([huge]);
      assert(r.ok, 'opened');
      await js(`window.__app.handleOpened(${JSON.stringify(r)})`);
      await waitFor('window.__app.S.view === "confirm"', 8000);
      assert(/20:00 long/.test(await js('document.getElementById("cInfo").textContent')), 'shows the length: ' + await js('document.getElementById("cInfo").textContent'));
      eq(await js('document.getElementById("splitBtn").hidden'), false, 'Split button shown');
    });

    await step('things that are not songs are refused with a message', async () => {
      const txt = path.join(dir, 'notes.txt');
      fs.writeFileSync(txt, 'hello');
      await js(`window.__app.handleOpened(${JSON.stringify(await openPaths([txt]))})`);
      assert(/not an audio file/i.test(await js('document.getElementById("banner").textContent')), 'banner: ' + await js('document.getElementById("banner").textContent'));
      const broken = path.join(dir, 'broken.mp3');
      fs.writeFileSync(broken, 'not really an mp3');
      await js(`window.__app.handleOpened(${JSON.stringify(await openPaths([broken]))})`);
      assert((await js('document.getElementById("banner").textContent')).length > 5, 'banner for a broken file');
    });

    await step('no errors reached the console', async () => {
      const real = errors.filter((m) => !/Autofill\.|ScriptProcessor/.test(m));
      eq(real.length, 0, 'console errors: ' + real.join(' | '));
    });
  } catch (e) {
    results.push({ name: 'test run', ok: false, error: String((e && e.stack) || e) });
  }
  const ok = results.every((r) => r.ok);
  if (outFile) fs.writeFileSync(outFile, JSON.stringify({ ok, results, notes }, null, 2));
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  app.exit(ok ? 0 : 1);

  function assert(c, m) { if (!c) throw new Error(m); }
};
