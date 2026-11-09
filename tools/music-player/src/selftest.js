'use strict';
// `--self-test=<result.json>`: proves that a PACKAGED build really works. It builds a small tagged library, scans it in the
// worker thread, loads the real window (hidden), plays a song through the mpm:// protocol and the Web Audio graph, and checks
// that sound reaches the output stage. No clicks, no files outside the temp folder.
const fs = require('fs');
const os = require('os');
const path = require('path');
const K = require('./testkit');
const Lyrics = require('./lyrics');
const LRC = require('./lrc');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function run({ createWindow, registerProtocol, getWin, openLibrary, getLib }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'musicplayer-selftest-'));
  const results = [];
  const step = async (name, fn) => {
    try { const detail = await fn(); results.push({ name, ok: true, detail }); } catch (e) { results.push({ name, ok: false, error: String((e && e.message) || e) }); }
  };
  try {
    const lib = path.join(dir, 'Music');
    const a = K.makeWav(path.join(lib, 'Band', 'First', '01 Alpha.wav'), { seconds: 3, freq: 440, rate: 22050 });
    K.tag(a, { title: 'Alpha', artist: 'Band', album: 'First', track: 1, year: 2020, rgTrack: -6, rgPeak: 0.9, cover: K.makePng(16) });
    const b = K.makeWav(path.join(lib, 'Band', 'First', '02 Beta.wav'), { seconds: 2, freq: 660, rate: 22050 });
    K.tag(b, { title: 'Beta', artist: 'Band', album: 'First', track: 2 });
    fs.writeFileSync(path.join(lib, 'Band', 'First', '01 Alpha.lrc'), '[00:00.50]one\n[00:01.50]two\n');
    const mp3 = K.makeMp3(path.join(lib, 'Band', 'First', '03 Gamma.mp3'));
    K.tag(mp3, { title: 'Gamma', artist: 'Band', album: 'First', track: 3, lyrics: 'plain words' });

    await step('tags, cover and ReplayGain are read', async () => {
      const Lib = require('./library');
      const r = await Lib.scan(lib);
      if (r.tracks.length !== 3) throw new Error('expected 3 tracks, got ' + r.tracks.length);
      const t = r.tracks.find((x) => x.title === 'Alpha');
      if (!t || t.artist !== 'Band' || t.cover !== 'embedded' || !t.rg || t.rg.track !== -6) throw new Error('tags not read correctly: ' + JSON.stringify(t));
      const cov = Lib.readCover(lib, t);
      if (!cov || cov.mime !== 'image/png') throw new Error('cover not read');
      return '3 tracks';
    });
    await step('lyrics: sidecar, embedded, save', async () => {
      const l = Lyrics.loadLyrics(a);
      if (!l.synced || l.lines.length !== 2) throw new Error('sidecar lyrics not read');
      const e = Lyrics.loadLyrics(mp3);
      if (e.source !== 'embedded' || e.synced) throw new Error('embedded lyrics not read');
      const s = Lyrics.saveSidecar(b, LRC.serialize([{ t: 1000, text: 'hi' }]));
      if (!fs.existsSync(s.file)) throw new Error('lyrics not saved');
      return 'ok';
    });

    registerProtocol();
    createWindow();
    const win = getWin();
    await step('window loads without script or CSP errors', async () => {
      const errors = [];
      win.webContents.on('console-message', (_e, level, message) => { if (level >= 2) errors.push(message); });
      await new Promise((resolve, reject) => { win.webContents.once('did-finish-load', resolve); win.webContents.once('did-fail-load', (_e, c, d) => reject(new Error(d))); });
      for (let i = 0; i < 100 && !(await win.webContents.executeJavaScript('!!window.__app')); i++) await sleep(50);
      if (!(await win.webContents.executeJavaScript('!!window.__app'))) throw new Error('the page did not start: ' + errors.join(' | '));
      if (errors.length) throw new Error(errors.join(' | '));
      return 'ok';
    });
    await step('scan in the worker thread and show the library', async () => {
      await openLibrary(lib);
      for (let i = 0; i < 200 && (getLib().scanning || !getLib().tracks.length); i++) await sleep(50);
      if (getLib().tracks.length !== 3) throw new Error('worker scan returned ' + getLib().tracks.length + ' tracks');
      for (let i = 0; i < 100 && (await win.webContents.executeJavaScript('window.__app.S.tracks.length')) !== 3; i++) await sleep(50);
      const rows = await win.webContents.executeJavaScript('document.querySelectorAll(".row-t").length');
      if (rows !== 3) throw new Error('song list shows ' + rows + ' rows');
      return '3 rows';
    });
    await step('plays a song: time advances and sound reaches the output', async () => {
      const js = (c) => win.webContents.executeJavaScript(c);
      await js('window.__app.startQueue(window.__app.S.tracks.filter(t=>t.title==="Alpha").map(t=>t.rel), 0), 0');
      let ok = false; let level = 0;
      for (let i = 0; i < 60; i++) {
        await sleep(100);
        level = Math.max(level, await js('(()=>{const a=window.__app.engine.analyser; const d=new Uint8Array(a.fftSize); a.getByteTimeDomainData(d); let m=0; for(const v of d) m=Math.max(m,Math.abs(v-128)); return m;})()'));
        if ((await js('window.__app.engine.position')) > 0.4 && level > 4) { ok = true; break; }
      }
      if (!ok) throw new Error('no sound: position=' + (await js('window.__app.engine.position')) + ' level=' + level);
      const gain = await js('window.__app.engine.deck.gain.gain.value');
      if (Math.abs(gain - 0.501) > 0.02) throw new Error('ReplayGain not applied, deck gain = ' + gain);
      await js('window.__app.engine.seek(1.5)');
      await sleep(300);
      const pos = await js('window.__app.engine.position');
      if (pos < 1.4 || pos > 2.6) throw new Error('seeking failed, position = ' + pos);
      const line = await js('window.__app.go("now"), new Promise(r=>setTimeout(()=>r((document.querySelector(".lyrics p.active")||{}).textContent),300))');
      if (line !== 'two') throw new Error('synced lyrics highlight wrong: ' + line);
      return `level ${level}, gain ${gain.toFixed(2)}, seek ok, lyric "${line}"`;
    });
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  return results;
}

module.exports = { run };
