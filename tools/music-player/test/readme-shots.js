'use strict';
// Makes the README screenshots: `node ../../node_modules/electron/cli.js . --e2e --readme-shots=<folder>`.
// Builds a small library of INVENTED artists, albums and lyrics (generated tones and gradient covers), so the screenshots
// show a realistic window without anyone's real music or copyrighted lyrics.
const fs = require('fs');
const os = require('os');
const path = require('path');
const K = require('../src/testkit');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ALBUMS = [
  { artist: 'Lumen Harbor', album: 'Night Ferry', year: 2022, c: [[20, 150, 160], [60, 40, 140]], chord: [220, 277.2, 330, 440], tracks: [['Harbor Lights', 34], ['Slow Tide', 28], ['Paper Lanterns', 31], ['Night Ferry', 36], ['Static Bloom', 26]] },
  { artist: 'The Quiet Orchard', album: 'Seasons Folded', year: 2019, c: [[240, 170, 60], [170, 40, 60]], chord: [196, 247, 294, 392], tracks: [['First Thaw', 30], ['Green Hours', 27], ['Fallen Gold', 33], ['Salt and Snow', 29]] },
  { artist: 'Neon Meadow', album: 'Glass Garden', year: 2021, c: [[230, 70, 170], [100, 50, 200]], chord: [262, 330, 392, 523], tracks: [['Prism', 25], ['Glasshouse', 32], ['Bloom Cycle', 28], ['Soft Static', 30]] },
  { artist: 'Marlow & Pine', album: 'Small Hours', year: 2020, c: [[70, 90, 120], [130, 190, 230]], chord: [175, 220, 262, 349], tracks: [['Kettle Song', 27], ['Window Seat', 31], ['Two A.M.', 35], ['Porch Light', 26]] },
  { artist: 'Orbit Cafe', album: 'Late Fridays', year: 2023, c: [[250, 130, 50], [230, 60, 120]], chord: [247, 311, 370, 494], tracks: [['Lift Off', 29], ['Corner Booth', 33], ['Last Tram', 28], ['Rooftop Rain', 31]] },
  { artist: 'Ines Calder', album: 'Tidewater', year: 2018, c: [[40, 150, 90], [20, 90, 130]], chord: [208, 262, 311, 415], tracks: [['Low Sun', 32], ['Driftwood', 27], ['Salt Roads', 34]] },
];

const LYRICS = [
  '[ti:Harbor Lights]', '[ar:Lumen Harbor]',
  '[00:03.00]The ferry hums a slow goodbye', '[00:07.20]Lanterns trace the water\'s edge', '[00:11.40]We count the lights along the pier',
  '[00:15.60]And let the evening do the rest', '[00:19.80]Carry me past the harbor wall', '[00:24.00]Where the morning keeps its name',
  '[00:28.20]Carry me home, carry me slow', '[00:32.40]Under the harbor lights',
].join('\n');

exports.run = async ({ app, getWin, openLibrary, outDir }) => {
  const win = getWin();
  const wc = win.webContents;
  const js = (c) => wc.executeJavaScript(c, true);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'musicplayer-shots-'));
  const lib = path.join(dir, 'Music');
  fs.mkdirSync(outDir, { recursive: true });
  const shot = async (name) => { await sleep(400); fs.writeFileSync(path.join(outDir, name), (await wc.capturePage()).toPNG()); console.log('wrote', name); };
  const waitFor = async (expr, ms = 8000) => { const end = Date.now() + ms; for (;;) { if (await js(expr)) return; if (Date.now() > end) throw new Error('timed out: ' + expr); await sleep(50); } };
  let code = 0;
  try {
    for (const al of ALBUMS) {
      const cover = K.makeGradientPng(512, al.c[0], al.c[1]);
      al.tracks.forEach(([title, secs], i) => {
        const f = path.join(lib, al.artist, `${al.year} ${al.album}`, `${String(i + 1).padStart(2, '0')} ${title}.wav`);
        K.makeWav(f, { seconds: secs, freqs: al.chord.map((x) => x * (1 + i * 0.12)), amp: 0.5, rate: 22050 });
        K.tag(f, { title, artist: al.artist, album: al.album, year: al.year, track: i + 1, trackCount: al.tracks.length, genre: 'Indie', cover });
      });
    }
    fs.writeFileSync(path.join(lib, 'Lumen Harbor', '2022 Night Ferry', '01 Harbor Lights.lrc'), LYRICS);

    win.setContentSize(1280, 800);
    await new Promise((r) => (wc.isLoading() ? wc.once('did-finish-load', r) : r()));
    await waitFor('!!window.__app');
    await openLibrary(lib);
    await waitFor('window.__app.S.tracks.length === 24 && !window.__app.S.scanning');
    await js('window.__app.S.settings.volume = 0.2; window.__app.engine.setVolume(0.2, false); window.__app.S.settings.rg.mode = "off"; 0');

    await js('window.__app.go("albums")');
    await waitFor('document.querySelectorAll(".card").length === 6');
    await waitFor('![...document.querySelectorAll(".card .cover")].some(e => e.dataset.bg)');
    await shot('music-player-albums.png');

    await js('window.__app.go("songs")');
    await sleep(300);
    await js('window.__app.startQueue(window.__app.S.tracks.filter(t => t.title === "Harbor Lights").map(t => t.rel), 0)');
    await waitFor('window.__app.engine.position > 0.3');
    await js('window.__app.go("now"); window.__app.engine.seek(13.2)');
    await waitFor('(document.querySelector(".lyrics p.active")||{}).textContent === "We count the lights along the pier"', 6000);
    await sleep(700);
    await shot('music-player.png');

    await js('window.__app.go("songs")');
    await sleep(500);
    await shot('music-player-songs.png');
  } catch (e) {
    console.error('readme-shots failed:', e);
    code = 1;
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  app.exit(code);
};
