'use strict';
// End-to-end test: runs inside Electron (`npm run e2e`), builds a library, drives the REAL window with real mouse/keyboard
// input, checks what the page shows and what reaches the audio output, and saves screenshots.
const fs = require('fs');
const os = require('os');
const path = require('path');
const K = require('../src/testkit');
const LRC = require('../src/lrc');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

exports.run = async ({ app, getWin, getLib, openLibrary, outFile, shotsDir }) => {
  const results = [];
  const notes = {};
  const errors = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'musicplayer-e2e-'));
  const lib = path.join(dir, 'Music');
  const win = getWin();
  const wc = win.webContents;
  const js = (code) => wc.executeJavaScript(code, true);
  const step = async (name, fn) => {
    try { const detail = await fn(); results.push({ name, ok: true, detail: detail === undefined ? '' : detail }); console.log('ok   ' + name); } catch (e) { results.push({ name, ok: false, error: String((e && e.message) || e) }); console.log('FAIL ' + name + ': ' + ((e && e.message) || e)); }
  };
  const eq = (a, b, what) => { if (a !== b) throw new Error(`${what}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); };
  const waitFor = async (expr, ms = 5000, what = expr) => {
    const end = Date.now() + ms;
    for (;;) { const v = await js(expr); if (v) return v; if (Date.now() > end) throw new Error('timed out waiting for ' + what); await sleep(40); }
  };
  const shot = async (name) => {
    if (!shotsDir) return;
    fs.mkdirSync(shotsDir, { recursive: true });
    await sleep(250);
    const img = await wc.capturePage();
    fs.writeFileSync(path.join(shotsDir, name + '.png'), img.toPNG());
  };
  const key = async (keyCode, modifiers = []) => {
    wc.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
    if (keyCode.length === 1) wc.sendInputEvent({ type: 'char', keyCode, modifiers });
    else if (keyCode === 'Enter' || keyCode === 'Return') wc.sendInputEvent({ type: 'char', keyCode: String.fromCharCode(13), modifiers });
    wc.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
    await sleep(60);
  };
  const click = async (selector) => {
    const r = await js(`(()=>{const e=document.querySelector(${JSON.stringify(selector)}); if(!e) return null; e.scrollIntoView({block:'center'}); const b=e.getBoundingClientRect(); return {x:Math.round(b.x+b.width/2), y:Math.round(b.y+b.height/2)};})()`);
    if (!r) throw new Error('nothing to click: ' + selector);
    wc.sendInputEvent({ type: 'mouseMove', x: r.x, y: r.y });
    wc.sendInputEvent({ type: 'mouseDown', x: r.x, y: r.y, button: 'left', clickCount: 1 });
    wc.sendInputEvent({ type: 'mouseUp', x: r.x, y: r.y, button: 'left', clickCount: 1 });
    await sleep(80);
  };
  const typeText = async (text) => { for (const ch of text) { wc.sendInputEvent({ type: 'char', keyCode: ch }); } await sleep(150); };
  wc.on('console-message', (_e, level, message) => { if (level >= 2 && !/ScriptProcessorNode is deprecated/.test(message)) errors.push(message); });

  try {
    // ---------------------------------------------------------------- fixtures
    const RATE = 44100;
    const album = (n) => path.join(lib, 'Gapless Band', n);
    const one = K.makeWav(album('2020 Gapless Album/01 One.wav'), { seconds: 2, freq: 441, amp: 0.5, rate: RATE });
    K.tag(one, { title: 'One', artist: 'Gapless Band', album: 'Gapless Album', year: 2020, track: 1, trackCount: 2, cover: K.makePng(64, [214, 64, 159]) });
    const two = K.makeWav(album('2020 Gapless Album/02 Two.wav'), { seconds: 2, freq: 441, amp: 0.5, rate: RATE });
    K.tag(two, { title: 'Two', artist: 'Gapless Band', album: 'Gapless Album', year: 2020, track: 2, trackCount: 2 });
    const sing = K.makeWav(path.join(lib, 'Singer', 'Karaoke', '01 Sing Along.wav'), { seconds: 12, freq: 330, amp: 0.3, rate: 22050 });
    K.tag(sing, { title: 'Sing Along', artist: 'Singer', album: 'Karaoke', year: 2019, track: 1, rgTrack: -6, rgPeak: 0.5, cover: K.makePng(64, [60, 140, 220]) });
    fs.writeFileSync(path.join(lib, 'Singer', 'Karaoke', '01 Sing Along.lrc'), ['[ti:Sing Along]', '[00:01.00]First line of the song', '[00:03.00]Second line goes here', '[00:05.00]Third line follows', '[00:07.00]Fourth line, nearly done', '[00:09.00]The very last line'].join('\n'));
    const quiet = K.makeWav(path.join(lib, 'Singer', 'Karaoke', '02 No Words.wav'), { seconds: 8, freq: 220, amp: 0.2, rate: 22050 });
    K.tag(quiet, { title: 'No Words', artist: 'Singer', album: 'Karaoke', track: 2 });
    for (const [n, i] of [['a', 1], ['b', 2]]) K.tag(K.makeWav(path.join(lib, 'Cal Band', 'Cal Album', `0${i} Cal ${n}.wav`), { seconds: 35200 / RATE, freq: 441, amp: 0.5, rate: RATE }), { title: `Cal ${n}`, artist: 'Cal Band', album: 'Cal Album', track: i });
    for (const [d, n, a, t] of [['CD1', 'c1', 'Ann', 1], ['CD1', 'c2', 'Bob', 2], ['CD2', 'c3', 'Cy', 1]]) K.tag(K.makeWav(path.join(lib, 'Hits', d, `${n}.wav`), { seconds: 1 }), { title: `Hit ${n}`, artist: a, album: 'Now Hits', track: t, disc: d === 'CD1' ? 1 : 2, year: 1999 });
    for (let i = 1; i <= 1500; i++) {
      const f = path.join(lib, 'Bulk', `Bulk ${String(i).padStart(4, '0')}.wav`);
      K.makeWav(f, { seconds: 0.05, rate: 8000 });
      K.tag(f, { title: `Bulk Song ${String(i).padStart(4, '0')}`, artist: 'Bulk Artist ' + (i % 30), album: 'Bulk Album ' + (i % 60), track: i % 15 + 1 });
    }
    fs.writeFileSync(path.join(lib, 'Bulk', 'old.wma'), 'x');

    // ---------------------------------------------------------------- start
    await step('page starts without script, CSP or runtime errors', async () => {
      await new Promise((r) => (wc.isLoading() ? wc.once('did-finish-load', r) : r()));
      await waitFor('!!window.__app', 8000, 'the app');
      await openLibrary(lib);
      await waitFor('window.__app.S.tracks.length >= 1509 && !window.__app.S.scanning', 60000, 'scan to finish');
      await sleep(300);
      const bad = errors.filter((e) => !/Autofill/.test(e));
      if (bad.length) throw new Error(bad.join(' | '));
      return (await js('window.__app.S.tracks.length')) + ' songs';
    });

    await step('library: folder name, counts, skipped-file notice', async () => {
      eq(await js('document.getElementById("folderName").textContent'), 'Music', 'folder name');
      eq(await js('document.getElementById("cSongs").textContent.replace(/\\D/g,"")'), '1509', 'song count');
      const n = await js('document.getElementById("notice").textContent');
      if (!/1 \.wma/.test(n)) throw new Error('skipped-file notice missing: ' + n);
      await js('document.querySelector("#notice button")?.click()');
      eq(await js('document.getElementById("notice").hidden'), true, 'notice dismissed');
    });
    await shot('01-songs');

    await step('song list is virtual: 1,509 songs but only a few dozen rows in the page', async () => {
      const rows = await js('document.querySelectorAll(".row-t").length');
      if (rows > 80 || rows < 8) throw new Error('rows in DOM: ' + rows);
      await js('(()=>{const v=document.querySelector(".vport"); v.scrollTop=v.scrollHeight;})()');
      await sleep(250);
      const last = await js('[...document.querySelectorAll(".row-t .tt")].map(e=>e.textContent).pop()');
      if (!last) throw new Error('no rows after scrolling to the end');
      await js('document.querySelector(".vport").scrollTop=0');
      return rows + ' rows rendered; last row after scrolling: ' + last;
    });

    await step('search narrows the list (accent/case-insensitive) and "/" focuses it', async () => {
      await js('document.body.focus()');
      await key('/');
      eq(await js('document.activeElement.id'), 'search', 'search focused by "/"');
      await typeText('GAPLESS band');
      await waitFor('document.querySelectorAll(".row-t").length === 2', 3000, 'two results');
      eq(await js('document.querySelector(".listfoot").textContent.split(" ")[0]'), '2', 'footer count');
      await js('(()=>{const s=document.getElementById("search"); s.value=""; s.dispatchEvent(new Event("input"));})()');
      await waitFor('document.querySelectorAll(".row-t").length > 8', 3000, 'list back');
      await js('document.activeElement.blur()');
    });

    await step('double-click plays; time advances; the playing row is marked', async () => {
      await js('(()=>{const s=document.getElementById("search"); s.value="sing along"; s.dispatchEvent(new Event("input"));})()');
      await waitFor('document.querySelectorAll(".row-t").length === 1', 3000);
      const r = await js('(()=>{const e=document.querySelector(".row-t .tt"); const b=e.getBoundingClientRect(); return {x:Math.round(b.x+20), y:Math.round(b.y+5)};})()');
      wc.sendInputEvent({ type: 'mouseMove', x: r.x, y: r.y });
      for (const clickCount of [1, 2]) { wc.sendInputEvent({ type: 'mouseDown', x: r.x, y: r.y, button: 'left', clickCount }); wc.sendInputEvent({ type: 'mouseUp', x: r.x, y: r.y, button: 'left', clickCount }); }
      await waitFor('window.__app.S.currentRel.endsWith("01 Sing Along.wav") && window.__app.engine.position > 0.5', 5000, 'playback');
      eq(await js('document.getElementById("barTitle").textContent'), 'Sing Along', 'bar title');
      eq(await js('document.getElementById("bPlay").getAttribute("aria-label")'), 'Pause', 'play button label');
      eq(await js('document.querySelectorAll(".row-t.playing").length'), 1, 'playing row');
      eq(await js('navigator.mediaSession.metadata && navigator.mediaSession.metadata.title'), 'Sing Along', 'media session title');
      await js('(()=>{const s=document.getElementById("search"); s.value=""; s.dispatchEvent(new Event("input"));})()');
    });

    await step('Space pauses/plays once, even when a button has focus', async () => {
      await js('document.getElementById("bNext").focus(); document.getElementById("bNext").blur(); document.getElementById("bShuffle").focus()');
      const before = await js('window.__app.engine.playing');
      await key('Space');
      await sleep(200);
      const mid = await js('window.__app.engine.playing');
      await key('Space');
      await sleep(250);
      const after = await js('window.__app.engine.playing');
      eq([before, mid, after].join(), 'true,false,true', 'play states');
      eq(await js('document.getElementById("bShuffle").getAttribute("aria-pressed")'), 'false', 'shuffle not toggled by Space');
    });

    await step('seek bar, volume and mute', async () => {
      await js('window.__app.engine.seek(4)');
      await sleep(250);
      const t = await js('document.getElementById("tNow").textContent');
      if (!/^0:0[4-6]$/.test(t)) throw new Error('time label ' + t);
      await js('(()=>{const v=document.getElementById("vol"); v.value=40; v.dispatchEvent(new Event("input"));})()');
      await sleep(100);
      const g = await js('window.__app.engine.volumeNode.gain.value');
      if (Math.abs(g - 0.16) > 0.03) throw new Error('volume gain ' + g);
      await key('M'); await sleep(200);
      eq(await js('document.getElementById("bMute").getAttribute("aria-label")'), 'Unmute', 'mute label');
      await key('M'); await sleep(100);
      return 'volume gain ' + g.toFixed(2);
    });

    await step('Now playing: cover, synced lyrics follow the song, click a line to seek', async () => {
      await key('L');
      await waitFor('window.__app.S.view === "now"', 2000);
      await js('window.__app.engine.seek(3.4)');
      await waitFor('(document.querySelector(".lyrics p.active")||{}).textContent === "Second line goes here"', 3000, 'second line active');
      await shot('02-now-playing-lyrics');
      const r = await js('(()=>{const e=document.querySelector(".lyrics p[data-i=\'4\']"); const b=e.getBoundingClientRect(); return {x:Math.round(b.x+40), y:Math.round(b.y+8)};})()');
      wc.sendInputEvent({ type: 'mouseDown', x: r.x, y: r.y, button: 'left', clickCount: 1 });
      wc.sendInputEvent({ type: 'mouseUp', x: r.x, y: r.y, button: 'left', clickCount: 1 });
      await waitFor('window.__app.engine.position > 8.8', 3000, 'seek to the last line');
      await waitFor('(document.querySelector(".lyrics p.active")||{}).textContent === "The very last line"', 3000, 'last line active');
      eq(await js('getComputedStyle(document.querySelector(".now-left .cover")).backgroundImage.includes("mpm://c/")'), true, 'cover shown');
    });

    await step('ReplayGain: the loud-tagged song is turned down, an untagged one is not', async () => {
      const g1 = await js('window.__app.engine.deck.gain.gain.value');
      if (Math.abs(g1 - 0.501) > 0.02) throw new Error('tagged gain ' + g1);
      await js('window.__app.S.settings.rg.mode = "off"; document.getElementById("rgMode").value = "off"; document.getElementById("rgMode").dispatchEvent(new Event("change"))');
      await sleep(250);
      const g2 = await js('window.__app.engine.deck.gain.gain.value');
      if (Math.abs(g2 - 1) > 0.02) throw new Error('gain with levelling off ' + g2);
      await js('document.getElementById("rgMode").value = "track"; document.getElementById("rgMode").dispatchEvent(new Event("change"))');
      await sleep(250);
    });

    await step('equalizer: preset applies to the filters; off flattens them', async () => {
      await click('#bSound');
      eq(await js('document.getElementById("popSound").hidden'), false, 'popover open');
      await js('(()=>{const s=document.getElementById("eqPreset"); s.value="Bass boost"; s.dispatchEvent(new Event("change"));})()');
      await sleep(400);
      const g = await js('window.__app.engine.filters.map(f=>Math.round(f.gain.value*10)/10)');
      eq(g.slice(0, 3).join(), '6,5,4', 'low bands');
      eq(await js('document.getElementById("eqOn").checked'), true, 'EQ switched on by choosing a preset');
      await shot('03-sound-popover');
      await js('(()=>{const c=document.getElementById("eqOn"); c.checked=false; c.dispatchEvent(new Event("change"));})()');
      await sleep(400);
      eq(await js('Math.max(...window.__app.engine.filters.map(f=>Math.abs(f.gain.value)))<0.05'), true, 'flat when off');
      await key('Escape');
      eq(await js('document.getElementById("popSound").hidden'), true, 'Escape closes the popover');
    });

    await step('queue: play next, add to queue, move down, remove, next song stays preloaded', async () => {
      await js('window.__app.go("albums")');
      await waitFor('document.querySelectorAll(".card").length >= 3', 3000);
      await js('window.__app.go("songs")');
      await js('(()=>{const s=document.getElementById("search"); s.value="Hit c"; s.dispatchEvent(new Event("input"));})()');
      await waitFor('document.querySelectorAll(".row-t").length === 3', 3000);
      await click('.row-t[data-pos="0"] .more');
      await waitFor('!document.getElementById("menu").hidden', 2000, 'menu');
      const labels = await js('[...document.querySelectorAll("#menu button")].map(b=>b.textContent)');
      for (const want of ['Play', 'Play next', 'Add to queue', 'Go to album', 'Show in folder', 'Edit tags in Audio Tagger', 'New playlist…']) if (!labels.includes(want)) throw new Error('menu is missing "' + want + '": ' + labels.join(' | '));
      await click('#menu button:nth-of-type(2)'); // Play next
      await sleep(150);
      await js('window.__app.go("queue")');
      await waitFor('document.querySelectorAll(".row-t").length >= 2', 3000);
      const q = await js('window.__app.S.q.items.map(r=>r.split("/").pop())');
      eq(q[1], 'c1.wav', 'next song in the queue');
      // add the other two songs from the list to the end of the queue through their menus
      await js('window.__app.go("songs")');
      await js('(()=>{const s=document.getElementById("search"); s.value="Hit c"; s.dispatchEvent(new Event("input"));})()');
      await waitFor('document.querySelectorAll(".row-t").length === 3', 3000);
      for (const pos of [1, 2]) {
        await click(`.row-t[data-pos="${pos}"] .more`);
        await waitFor('!document.getElementById("menu").hidden', 2000, 'menu');
        await js('[...document.querySelectorAll("#menu button")].find(b=>b.textContent==="Add to queue").click()');
        await sleep(120);
      }
      const names = () => js('window.__app.S.q.items.map(r=>r.split("/").pop().replace(".wav","")).join()');
      eq(await names(), '01 Sing Along,c1,c2,c3', 'queue after play next + add to queue');
      await js('window.__app.go("queue")');
      await waitFor('document.querySelectorAll(".row-t").length === 4', 3000);
      await js('document.querySelector(".vport").focus()');
      await key('Down');                               // focusing the list selects row 1 (playing song); Down moves to c1
      await key('Down', ['alt']);                      // Alt+Down moves the selected song down one place
      await waitFor('window.__app.S.q.items[2].endsWith("c1.wav")', 3000, 'c1 moved down');
      eq(await names(), '01 Sing Along,c2,c1,c3', 'queue after moving c1 down');
      eq(await js('window.__app.S.q.pos'), 0, 'the playing song keeps its place');
      await js('document.querySelector(".vport").focus()');
      await key('Down', ['alt']);                      // the selection followed c1 to the third place: move it once more
      await waitFor('window.__app.S.q.items[3].endsWith("c1.wav")', 3000, 'c1 at the end');
      await js('document.querySelector(".vport").focus()');
      await key('Delete');                             // remove the selected song from the queue
      await waitFor('window.__app.S.q.items.length === 3', 3000, 'c1 removed');
      eq(await names(), '01 Sing Along,c2,c3', 'queue after removing c1');
      eq(await js('window.__app.engine.preloaded.endsWith("c2.wav")'), true, 'the next song is preloaded again after the changes');
      await js('window.__app.go("songs")');
      await js('(()=>{const s=document.getElementById("search"); s.value=""; s.dispatchEvent(new Event("input"));})()');
      return 'queue: ' + q.join(', ');
    });

    await step('playlists: create (Enter confirms), add through the menu, saved to disk', async () => {
      await click('#plNew');
      await waitFor('document.getElementById("ask").open', 2000, 'dialog');
      await typeText('Road trip');
      await key('Enter');
      await waitFor('window.__app.S.playlists.lists.length === 1', 3000, 'playlist created');
      eq(await js('window.__app.S.playlists.lists[0].name'), 'Road trip', 'name');
      await js('(()=>{const s=document.getElementById("search"); s.value="Hit c"; s.dispatchEvent(new Event("input"));})()');
      await waitFor('document.querySelectorAll(".row-t").length === 3', 3000);
      await click('.row-t[data-pos="1"] .more');
      await waitFor('!document.getElementById("menu").hidden', 2000);
      const added = await js('(()=>{const b=[...document.querySelectorAll("#menu button")].find(x=>x.textContent==="Road trip"); b.click(); return !!b;})()');
      eq(added, true, 'playlist offered in the menu');
      await waitFor('window.__app.S.playlists.lists[0].tracks.length === 1', 3000);
      await click('#plList button');
      await waitFor('window.__app.S.view === "playlist"', 2000);
      eq(await js('document.querySelectorAll(".row-t").length'), 1, 'playlist rows');
      const saved = await js('window.__app.mp.getPlaylists()');
      eq(saved.lists[0].tracks[0].split("/").pop(), 'c2.wav', 'persisted to disk');
      await js('window.__app.go("songs")');
      await js('(()=>{const s=document.getElementById("search"); s.value=""; s.dispatchEvent(new Event("input"));})()');
    });

    await step('gapless: two songs back to back leave no audible gap', async () => {
      await js('window.__app.S.settings.repeat = "off"');
      await js(`(()=>{
        const A = window.__app; const e = A.engine;
        const rels = A.S.tracks.filter(t => /Gapless Album/.test(t.album)).sort((a,b)=>a.track-b.track).map(t => t.rel);
        window.__cap = { chunks: [], rate: e.ctx.sampleRate };
        const sp = e.ctx.createScriptProcessor(1024, 1, 1);
        sp.onaudioprocess = (ev) => { window.__cap.chunks.push(new Float32Array(ev.inputBuffer.getChannelData(0))); };
        e.analyser.connect(sp); sp.connect(e.ctx.destination);
        window.__cap.sp = sp;
        A.S.settings.volume = 1; A.S.settings.muted = false; e.setVolume(1, false);
        A.S.settings.rg.mode = 'off'; A.startQueue(rels, 0);
        return rels.length;
      })()`);
      await waitFor('window.__app.S.currentRel.endsWith("02 Two.wav")', 6000, 'handover to song two');
      await waitFor('window.__app.engine.position > 1.3', 4000, 'song two to play for a while');
      const res = await js(`(()=>{
        const c = window.__cap; const n = c.chunks.reduce((s,x)=>s+x.length,0); const all = new Float32Array(n); let o=0; for (const x of c.chunks) { all.set(x,o); o+=x.length; }
        window.__app.engine.analyser.disconnect(c.sp);
        let first=-1,last=-1; for (let i=0;i<n;i++) if (Math.abs(all[i])>0.05) { if (first<0) first=i; last=i; }
        const boundary = first + Math.round(2 * c.rate); let run=0, runStart=-1, near=0, early=0;
        for (let i=first;i<=last;i++) { if (Math.abs(all[i])<0.002) { if (!run) runStart=i; run++; } else { if (run) { if (Math.abs(runStart-boundary) < 4800) near=Math.max(near,run); else early=Math.max(early,run); } run=0; } }
        return { rate: c.rate, samples: n, loud: last-first, maxRun: near, early };
      })()`);
      const gapMs = (res.maxRun / res.rate) * 1000;
      notes.gapless = { silentRunSamples: res.maxRun, gapMs: Math.round(gapMs * 100) / 100, startupSilenceMs: Math.round((res.early / res.rate) * 1000 * 10) / 10, loudSamples: res.loud, rate: res.rate };
      if (res.loud < res.rate * 3) throw new Error('did not capture both songs: ' + JSON.stringify(res));
      if (gapMs > 25) throw new Error(`gap between songs: ${gapMs.toFixed(1)} ms`);
      return `longest silence at the song change: ${gapMs.toFixed(2)} ms (${res.maxRun} samples at ${res.rate} Hz)`;
    });

    if (process.env.MP_CAL) {
      await step('gapless calibration (MP_CAL=1): gap and overlap for different hand-over leads', async () => {
        const out = await js(`(async () => {
          const A = window.__app; const e = A.engine; const sleep = (ms) => new Promise(r => setTimeout(r, ms));
          const rels = A.S.tracks.filter(t => t.album === 'Cal Album').sort((a,b)=>a.track-b.track).map(t => t.rel);
          const cap = { chunks: [] };
          const sp = e.ctx.createScriptProcessor(1024, 1, 1);
          sp.onaudioprocess = (ev) => { cap.chunks.push(new Float32Array(ev.inputBuffer.getChannelData(0))); };
          e.analyser.connect(sp); sp.connect(e.ctx.destination);
          A.S.settings.volume = 1; e.setVolume(1, false); A.S.settings.rg.mode = 'off';
          const rows = []; const ORIG_LEAD = e.lead;
          for (const lead of ${process.env.MP_CAL_LEADS || '[0, 0.012, 0.025, 0.04, 0.06]'}) {
            const trials = [];
            for (let k = 0; k < ${process.env.MP_CAL_TRIALS || 8}; k++) {
              e.lead = lead; cap.chunks = [];
              A.startQueue(rels, 0);
              for (let i = 0; i < 200 && !(e.currentRel.endsWith('02 Cal b.wav') && e.position > 0.3); i++) await sleep(20);
              const n = cap.chunks.reduce((s,x)=>s+x.length,0); const all = new Float32Array(n); let o=0; for (const x of cap.chunks) { all.set(x,o); o+=x.length; }
              let first=-1,last=-1; for (let i=0;i<n;i++) if (Math.abs(all[i])>0.05) { if (first<0) first=i; last=i; }
              const boundary = first + Math.round(35200 / 44100 * e.ctx.sampleRate); let run=0, runStart=-1, near=0, early=0;
              for (let i=first;i<=last;i++) { if (Math.abs(all[i])<0.002) { if (!run) runStart=i; run++; } else { if (run) { if (Math.abs(runStart-boundary) < 4800) near=Math.max(near,run); else early=Math.max(early,run); } run=0; } }
              let over=0; for (let i=first;i<=last;i++) if (Math.abs(all[i])>0.56) over++;
              trials.push({ gapMs: +(near / e.ctx.sampleRate * 1000).toFixed(1), earlyMs: +(early / e.ctx.sampleRate * 1000).toFixed(1), overlapMs: +(over / e.ctx.sampleRate * 1000).toFixed(1) });
              e.pause(); await sleep(120);
            }
            rows.push({ leadMs: lead * 1000, trials });
          }
          e.analyser.disconnect(sp); e.lead = ORIG_LEAD;
          return rows;
        })()`);
        notes.calibration = out.map((r) => `${r.leadMs}ms lead: ` + r.trials.map((t) => `${t.gapMs}/${t.overlapMs}/start${t.earlyMs}`).join(' '));
        return 'see notes';
      });
    }

    await step('lyrics editor: type lyrics, tap-sync them to the song, save a .lrc file', async () => {
      const rel = await js('window.__app.S.tracks.find(t=>t.title==="No Words").rel');
      await js(`window.__app.startQueue([${JSON.stringify(rel)}], 0)`);
      await waitFor('window.__app.engine.position > 0.3', 4000);
      await js('window.__app.go("now")');
      await waitFor('document.querySelector(".nolyrics button")', 3000, 'Add lyrics button');
      await shot('04-no-lyrics');
      await click('.nolyrics button');
      await waitFor('document.getElementById("editor").open', 2000, 'editor');
      await js('(()=>{const t=document.getElementById("edText"); t.value="Alpha line\\nBravo line\\n\\nCharlie line"; t.dispatchEvent(new Event("input"));})()');
      await click('#tabSync');
      eq(await js('document.querySelectorAll("#syList li").length'), 3, 'blank lines are ignored in sync mode');
      await js('window.__app.engine.seek(0.5)'); await sleep(200);
      await key('Return'); await sleep(900);
      await key('Return'); await sleep(900);
      await key('Return'); await sleep(200);
      eq(await js('document.querySelectorAll("#syList li.stamped").length'), 3, 'stamped lines');
      await shot('05-lyrics-editor-sync');
      await click('#edSave');
      await waitFor('!document.getElementById("editor").open', 3000, 'editor to close');
      const file = path.join(path.dirname(path.join(lib, 'Singer', 'Karaoke', '02 No Words.wav')), '02 No Words.lrc');
      if (!fs.existsSync(file)) throw new Error('no .lrc file was written');
      const parsed = LRC.parse(fs.readFileSync(file, 'utf8'));
      eq(parsed.synced, true, 'file is synced LRC');
      eq(parsed.lines.map((l) => l.text).join('|'), 'Alpha line|Bravo line|Charlie line', 'line texts');
      const gaps = parsed.lines.map((l, i) => (i ? l.t - parsed.lines[i - 1].t : l.t));
      if (gaps[1] < 600 || gaps[2] < 600) throw new Error('timestamps do not follow the taps: ' + parsed.lines.map((l) => l.t).join(','));
      await waitFor('document.querySelectorAll(".lyrics p").length === 3', 3000, 'new lyrics shown');
      await js('window.__app.engine.seek(0)');
      return 'saved: ' + parsed.lines.map((l) => LRC.formatTime(l.t)).join(' ');
    });

    await js('(()=>{const d=document.getElementById("editor"); if (d.open) d.close();})()');
    await step('sleep timer fades out and pauses', async () => {
      await js('window.__app.engine.resume()');
      await waitFor('window.__app.engine.playing', 2000);
      await js('window.__app.startSleep(0.03)'); // 1.8 s
      await waitFor('!window.__app.engine.playing', 6000, 'the sleep timer to pause');
      eq(await js('window.__app.S.sleep.until'), 0, 'timer cleared');
    });

    await step('mini player shrinks the window and comes back', async () => {
      const big = win.getSize();
      await js('window.__app.setMini(true)');
      await sleep(400);
      const small = win.getSize();
      if (small[0] > 600 || small[1] > 260) throw new Error('window did not shrink: ' + small);
      eq(await js('document.body.classList.contains("mini")'), true, 'mini class');
      await js('document.getElementById("toast").classList.remove("show")');
      await shot('06-mini');
      await js('window.__app.setMini(false)');
      await sleep(400);
      const back = win.getSize();
      if (Math.abs(back[0] - big[0]) > 4) throw new Error(`size not restored: ${big} -> ${back}`);
    });

    await step('albums and artists: grid, detail page, compilation grouped as one album', async () => {
      await js('window.__app.go("albums")');
      await waitFor('document.querySelectorAll(".card").length >= 3', 3000);
      await sleep(400);
      await shot('07-albums');
      const hits = await js('[...document.querySelectorAll(".card")].filter(c=>/Now Hits/.test(c.textContent)).length');
      eq(hits, 1, 'one Now Hits card');
      await click('.card[title^="Karaoke"]');
      await waitFor('document.querySelector(".detailhead h2")', 3000);
      eq(await js('document.querySelector(".detailhead h2").textContent'), 'Karaoke', 'album title');
      eq(await js('document.querySelectorAll(".row-t").length'), 2, 'album tracks');
      await shot('08-album-detail');
      await js('window.__app.go("artists")');
      await waitFor('document.querySelectorAll(".artistrow").length > 3', 3000);
    });

    await step('folders view browses the real directory tree', async () => {
      await js('window.__app.go("folders")');
      await waitFor('document.querySelectorAll(".folderrow").length >= 3', 3000);
      const names = await js('[...document.querySelectorAll(".folderrow .grow")].map(e=>e.textContent).join()');
      eq(names, 'Bulk,Cal Band,Gapless Band,Hits,Singer', 'top-level folders');
      await click('.folderrow:nth-of-type(5)');
      await waitFor('document.querySelector(".crumbs").textContent.includes("Singer")', 2000);
    });

    await step('no console errors during the whole run', async () => {
      const bad = errors.filter((e) => !/Autofill/.test(e));
      if (bad.length) throw new Error(bad.slice(0, 5).join(' | '));
    });
    await js('window.__app.go("songs")');
    await sleep(200);
    await shot('09-songs-final');
  } catch (e) {
    results.push({ name: 'harness', ok: false, error: String((e && e.stack) || e) });
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  const ok = results.every((r) => r.ok);
  if (outFile) fs.writeFileSync(outFile, JSON.stringify({ ok, notes, results }, null, 2));
  app.exit(ok ? 0 : 1);
};
