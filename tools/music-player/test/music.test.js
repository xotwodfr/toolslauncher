'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const LRC = require('../src/lrc');
const Lyrics = require('../src/lyrics');
const Lib = require('../src/library');
const M = require('../src/model');
const PL = require('../src/playlists');
const F = require('./fixtures');
const Link = require('../src/launcher-link');
const Settings = require('../src/settings');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-test-'));
let n = 0;
const ok = (m) => { n++; console.log('  ok  ' + m); };
const p = (...a) => path.join(tmp, ...a);

(async () => {
  // ---- LRC -------------------------------------------------------------------------------------------------------
  {
    const r = LRC.parse('[ti:Song]\n[ar:Band]\n[al:Rec]\n[00:12.00]First\n[00:17.5]Second\n[01:02.345]Third\n');
    assert.deepStrictEqual(r.lines, [{ t: 12000, text: 'First' }, { t: 17500, text: 'Second' }, { t: 62345, text: 'Third' }]);
    assert.strictEqual(r.synced, true);
    assert.deepStrictEqual(r.meta, { title: 'Song', artist: 'Band', album: 'Rec' });
    ok('lrc: timestamps with 1, 2 and 3 fraction digits, header tags');

    const m = LRC.parse('[00:30.00][00:10.00]Chorus\n[00:20.00]Verse');
    assert.deepStrictEqual(m.lines.map((l) => [l.t, l.text]), [[10000, 'Chorus'], [20000, 'Verse'], [30000, 'Chorus']]);
    ok('lrc: one line with several time tags is repeated and sorted');

    assert.strictEqual(LRC.parse('[00:05:50]colon fraction').lines[0].t, 5500);
    assert.strictEqual(LRC.parse('[00:05]no fraction').lines[0].t, 5000);
    assert.strictEqual(LRC.parse('[100:00.00]long song').lines[0].t, 6000000);
    assert.strictEqual(LRC.parse('[00:75.00]bad seconds').synced, false);
    ok('lrc: [mm:ss:xx], [mm:ss], minutes above 99, and seconds >= 60 rejected');

    const off = LRC.parse('[offset:+500]\n[00:10.00]a');
    assert.strictEqual(off.lines[0].t, 9500);
    assert.strictEqual(LRC.parse('[offset:-500]\n[00:10.00]a').lines[0].t, 10500);
    assert.strictEqual(LRC.parse('[offset:+500]\n[00:10.00]a', { applyOffset: false }).lines[0].t, 10000);
    assert.strictEqual(LRC.parse('[offset:+5000]\n[00:01.00]a').lines[0].t, 0);
    ok('lrc: [offset] shifts lines earlier when positive, never below 0');

    assert.strictEqual(LRC.parse('[00:10.00]<00:10.00>Hel<00:10.50>lo <00:11.00>world').lines[0].text, 'Hello world');
    ok('lrc: enhanced word-time tags are removed');

    const plain = LRC.parse('Just words\n\nSecond line');
    assert.strictEqual(plain.synced, false);
    assert.deepStrictEqual(plain.lines, [{ t: null, text: 'Just words' }, { t: null, text: 'Second line' }]);
    const mixed = LRC.parse('credit line\n[00:01.00]a\n[00:02.00]');
    assert.deepStrictEqual(mixed.lines, [{ t: 1000, text: 'a' }, { t: 2000, text: '' }]);
    ok('lrc: plain text; untimed lines in a synced file dropped; empty timed line kept as a pause');

    assert.strictEqual(LRC.parse('\uFEFF[00:01.00]bom').lines[0].text, 'bom');
    assert.strictEqual(LRC.parse('[00:01.00]a\r\n[00:02.00]b\r[00:03.00]c').lines.length, 3);
    assert.strictEqual(LRC.parse(null).lines.length, 0);
    assert(LRC.parse('x'.repeat(LRC.MAX_CHARS + 1000)).lines[0].text.length <= LRC.MAX_CHARS);
    ok('lrc: BOM, CRLF / CR / LF, null and oversized input');

    assert.strictEqual(LRC.formatTime(0), '00:00.00');
    assert.strictEqual(LRC.formatTime(62345), '01:02.35');
    assert.strictEqual(LRC.formatTime(59999), '01:00.00');
    assert.strictEqual(LRC.formatTime(6000000), '100:00.00');
    const text = LRC.serialize([{ t: 12000, text: 'First' }, { t: 62340, text: '' }, { t: null, text: 'loose' }], { title: 'T', artist: 'A', album: 'B' });
    assert.strictEqual(text, '[ti:T]\n[ar:A]\n[al:B]\n[00:12.00]First\n[01:02.34]\nloose\n');
    const back = LRC.parse(text);
    assert.deepStrictEqual(back.lines.map((l) => l.t), [12000, 62340]);
    assert.strictEqual(back.meta.title, 'T');
    ok('lrc: formatTime rounds and carries, serialize -> parse round trip');

    const lines = LRC.parse('[00:10.00]a\n[00:20.00]b\n[00:30.00]c').lines;
    assert.strictEqual(LRC.activeIndex(lines, 5000), -1);
    assert.strictEqual(LRC.activeIndex(lines, 10000), 0);
    assert.strictEqual(LRC.activeIndex(lines, 29999), 1);
    assert.strictEqual(LRC.activeIndex(lines, 999999), 2);
    assert.strictEqual(LRC.activeIndex([], 100), -1);
    assert.deepStrictEqual(LRC.shift(lines, -15000).map((l) => l.t), [0, 5000, 15000]);
    assert(LRC.looksSynced('hi\n[01:02.03] x') && !LRC.looksSynced('[Chorus]\nla la'));
    ok('lrc: activeIndex (binary search), shift, looksSynced');
  }

  // ---- fixtures: a small library ---------------------------------------------------------------------------------
  const lib = p('Music');
  const wav1 = F.makeWav(path.join(lib, 'Band', '2001 First', '01 Alpha.wav'), { seconds: 2 });
  F.tag(wav1, { title: 'Alpha', artist: 'Band', album: 'First', year: 2001, track: 1, trackCount: 3, genre: 'Rock', rgTrack: -6.5, rgPeak: 0.8, rgAlbum: -5 });
  const wav2 = F.makeWav(path.join(lib, 'Band', '2001 First', '02 Beta.wav'));
  F.tag(wav2, { title: 'Beta', artist: 'Band', album: 'First', year: 2001, track: 2, trackCount: 3 });
  const mp3 = F.makeMp3(path.join(lib, 'Band', '2001 First', '03 Gamma.mp3'));
  F.tag(mp3, { title: 'Gamma', artist: 'Band', album: 'First', year: 2001, track: 3, cover: F.makePng(12), lyrics: '[00:01.00]one\n[00:02.00]two', sylt: null });
  fs.writeFileSync(path.join(lib, 'Band', '2001 First', 'cover.png'), F.makePng(6, [10, 200, 10]));
  fs.writeFileSync(path.join(lib, 'Band', '2001 First', 'notes.txt'), 'ignore me');
  // a compilation without album-artist tags, spread over two disc folders
  for (const [disc, name, artist, trk] of [['CD1', 'x1', 'Ann', 1], ['CD1', 'x2', 'Bob', 2], ['CD2', 'x3', 'Cy', 1]]) {
    const f = F.makeWav(path.join(lib, 'Hits', disc, `${name}.wav`));
    F.tag(f, { title: name, artist, album: 'Now Hits', track: trk, disc: disc === 'CD1' ? 1 : 2, year: 1999 });
  }
  const noTags = F.makeWav(path.join(lib, 'loose', 'My Demo - take 3.wav'));
  // not playable here, only counted
  fs.mkdirSync(path.join(lib, 'old'), { recursive: true });
  fs.writeFileSync(path.join(lib, 'old', 'a.wma'), 'x'); fs.writeFileSync(path.join(lib, 'old', 'b.ape'), 'x'); fs.writeFileSync(path.join(lib, 'old', 'c.WMA'), 'x');
  fs.mkdirSync(path.join(lib, '.hidden'), { recursive: true }); F.makeWav(path.join(lib, '.hidden', 'secret.wav'));
  fs.writeFileSync(path.join(lib, 'broken.mp3'), 'this is not audio');

  // ---- library ---------------------------------------------------------------------------------------------------
  let result;
  {
    const progress = [];
    result = await Lib.scan(lib, { onProgress: (x) => progress.push(x.phase) });
    const byRel = Object.fromEntries(result.tracks.map((t) => [t.rel, t]));
    assert.strictEqual(result.tracks.length, 8, 'wav x6 + mp3 + broken.mp3 (kept, flagged), hidden folder skipped: ' + result.tracks.map((t) => t.rel));
    assert.deepStrictEqual(result.skipped, { '.wma': 2, '.ape': 1 });
    assert(!byRel['.hidden/secret.wav']);
    const a = byRel['Band/2001 First/01 Alpha.wav'];
    assert.strictEqual(a.title, 'Alpha'); assert.strictEqual(a.artist, 'Band'); assert.strictEqual(a.album, 'First');
    assert.strictEqual(a.year, 2001); assert.strictEqual(a.track, 1); assert.strictEqual(a.trackCount, 3); assert.strictEqual(a.genre, 'Rock');
    assert(Math.abs(a.durationMs - 2000) < 60, 'duration ' + a.durationMs);
    assert.strictEqual(a.sampleRate, 8000); assert.strictEqual(a.channels, 1);
    ok('library: scan reads tags and duration, skips hidden folders, counts unplayable formats');

    assert.deepStrictEqual(a.rg, { track: -6.5, trackPeak: 0.8, album: -5, albumPeak: null });
    assert.strictEqual(byRel['Band/2001 First/02 Beta.wav'].rg, null);
    ok('library: ReplayGain tags are read (and absent when missing)');

    const g = byRel['Band/2001 First/03 Gamma.mp3'];
    assert.strictEqual(g.cover, 'embedded'); assert.strictEqual(g.lyrics, true);
    assert.strictEqual(byRel['Band/2001 First/02 Beta.wav'].cover, 'folder');
    assert.strictEqual(byRel['Band/2001 First/02 Beta.wav'].coverFile, 'Band/2001 First/cover.png');
    assert.strictEqual(byRel['loose/My Demo - take 3.wav'].cover, '');
    ok('library: embedded cover beats folder cover; folder cover.png found; none when absent');

    assert.strictEqual(byRel['broken.mp3'].bad, true);
    assert.strictEqual(M.titleOf(byRel['broken.mp3']), 'broken');
    assert.strictEqual(M.titleOf(byRel['loose/My Demo - take 3.wav']), 'My Demo - take 3');
    assert(progress.includes('read'));
    ok('library: unreadable file kept and flagged, untagged files fall back to the file name');
  }

  {
    const cache = new Map(result.tracks.map((t) => [t.rel, t]));
    const again = await Lib.scan(lib, { cache });
    assert.strictEqual(again.reused, 8);
    // change one file: only that one is read again
    await new Promise((r) => setTimeout(r, 20));
    F.tag(wav2, { title: 'Beta 2' });
    const third = await Lib.scan(lib, { cache });
    assert.strictEqual(third.reused, 7);
    assert.strictEqual(third.tracks.find((t) => t.rel.endsWith('02 Beta.wav')).title, 'Beta 2');
    // remove one file: it disappears
    fs.rmSync(noTags);
    const fourth = await Lib.scan(lib, { cache });
    assert.strictEqual(fourth.tracks.length, 7);
    ok('library: cache reuses unchanged files, re-reads changed ones, drops deleted ones');

    const cacheFile = p('cache', 'lib.json');
    Lib.saveCache(cacheFile, lib, third.tracks);
    assert.strictEqual(Lib.loadCache(cacheFile, lib).size, 8);
    assert.strictEqual(Lib.loadCache(cacheFile, p('other')).size, 0, 'cache for another folder is ignored');
    fs.writeFileSync(cacheFile, '{not json');
    assert.strictEqual(Lib.loadCache(cacheFile, lib).size, 0);
    assert.strictEqual(Lib.loadCache(p('nope.json'), lib).size, 0);
    ok('library: cache file round trip, wrong folder / damaged / missing cache ignored');

    let polled = 0;
    const cut = await Lib.scan(lib, { isCancelled: () => ++polled > 0 });
    assert.strictEqual(cut.cancelled, true);
    assert.strictEqual(cut.tracks.length, 0);
    ok('library: scan can be cancelled');
  }

  {
    const t = result.tracks.find((x) => x.rel.endsWith('03 Gamma.mp3'));
    const c = Lib.readCover(lib, t);
    assert.strictEqual(c.mime, 'image/png'); assert.strictEqual(c.data.slice(1, 4).toString(), 'PNG');
    const folderCover = Lib.readCover(lib, result.tracks.find((x) => x.rel.endsWith('02 Beta.wav')));
    assert.strictEqual(folderCover.mime, 'image/png');
    assert.notDeepStrictEqual(folderCover.data, c.data);
    assert.strictEqual(Lib.readCover(lib, result.tracks.find((x) => x.rel.startsWith('Hits/'))), null);
    assert.strictEqual(Lib.readCover(lib, { rel: '../../etc/passwd', cover: 'embedded' }), null);
    ok('library: readCover returns embedded or folder art, null otherwise, refuses paths outside the folder');

    assert.strictEqual(Lib.resolveInside(lib, 'Band/2001 First/01 Alpha.wav', 'audio'), path.join(lib, 'Band', '2001 First', '01 Alpha.wav'));
    // a drive-letter / backslash name is only refused on Windows: on Linux it is a legal file name that stays inside the folder
    for (const bad of ['../x.mp3', 'Band/../../x.mp3', '/etc/passwd.mp3', ...(process.platform === 'win32' ? ['C:\\Windows\\x.mp3'] : []), '', 'Band/notes.txt', 'a\0.mp3', '..', '.']) {
      assert.throws(() => Lib.resolveInside(lib, bad, 'audio'), undefined, `should refuse ${JSON.stringify(bad)}`);
    }
    assert.throws(() => Lib.resolveInside(lib, 'Band/2001 First/cover.png', 'audio'));
    assert.doesNotThrow(() => Lib.resolveInside(lib, 'Band/2001 First/cover.png', 'image'));
    assert.throws(() => Lib.resolveInside(lib, 42, 'audio'));
    ok('library: resolveInside refuses traversal, absolute paths, wrong file types');
  }

  // ---- model -----------------------------------------------------------------------------------------------------
  {
    const tracks = result.tracks;
    const idx = M.buildIndex(tracks);
    const first = idx.albums.find((a) => a.title === 'First');
    assert.strictEqual(first.artist, 'Band'); assert.strictEqual(first.tracks.length, 3); assert.strictEqual(first.year, 2001);
    assert.deepStrictEqual(first.tracks.map((i) => tracks[i].title), ['Alpha', 'Beta', 'Gamma']);
    assert.strictEqual(tracks[first.coverTrack].cover !== '', true);
    const hits = idx.albums.find((a) => a.title === 'Now Hits');
    assert.strictEqual(hits.tracks.length, 3, 'CD1 and CD2 folders are one album');
    assert.strictEqual(hits.artist, 'Various Artists');
    assert.strictEqual(hits.discs, 2);
    assert.deepStrictEqual(hits.tracks.map((i) => tracks[i].title), ['x1', 'x2', 'x3']);
    assert(idx.albums.some((a) => a.title === M.UNKNOWN_ALBUM));
    assert.deepStrictEqual(idx.artists.map((a) => a.name), ['Band', 'Unknown Artist', 'Various Artists']);
    ok('model: albums (disc folders merged, compilations -> Various Artists), artists');

    const other = [{ rel: 'a/x.mp3', album: 'Greatest', artist: 'P' }, { rel: 'b/y.mp3', album: 'Greatest', artist: 'Q' }];
    assert.strictEqual(M.buildIndex(other).albums.length, 2, 'same album name in different folders and no album-artist stays separate');
    const tagged = [{ rel: 'a/x.mp3', album: 'Greatest', albumArtist: 'Z' }, { rel: 'b/y.mp3', album: 'greatest', albumArtist: 'z' }];
    assert.strictEqual(M.buildIndex(tagged).albums.length, 1, 'album-artist + album name merge across folders, case-insensitively');
    ok('model: album grouping rules');

    const all = M.sortedIndexes(tracks, 'default').map((i) => tracks[i].title || M.titleOf(tracks[i]));
    assert.deepStrictEqual(all.slice(0, 3), ['Alpha', 'Beta', 'Gamma']);
    const byTitle = M.sortedIndexes(tracks, 'title').map((i) => M.titleOf(tracks[i]));
    assert.deepStrictEqual(byTitle, [...byTitle].sort(M.collator.compare));
    assert.deepStrictEqual(M.sortedIndexes(tracks, 'title', -1).map((i) => M.titleOf(tracks[i])), [...byTitle].reverse());
    const nums = [{ rel: 'a', title: 'Track 10' }, { rel: 'b', title: 'Track 9' }, { rel: 'c', title: 'track 1' }];
    assert.deepStrictEqual(M.sortedIndexes(nums, 'title'), [2, 1, 0], 'natural, case-insensitive order');
    ok('model: sorting (default, title, descending, natural numbers)');

    const words = [{ rel: 'x/Beyoncé - Halo.mp3', title: 'Halo', artist: 'Beyoncé', album: 'I Am', year: 2008 }, { rel: 'x/b.mp3', title: 'Other', artist: 'Someone' }];
    assert.deepStrictEqual(M.search(words, 'beyonce'), [0]);
    assert.deepStrictEqual(M.search(words, 'HALO i am'), [0]);
    assert.deepStrictEqual(M.search(words, '2008'), [0]);
    assert.deepStrictEqual(M.search(words, 'halo zzz'), []);
    assert.deepStrictEqual(M.search(words, '   '), [0, 1]);
    ok('model: search is accent- and case-insensitive and needs every word');

    const f0 = M.folderEntries(tracks, '');
    assert.deepStrictEqual(f0.folders.map((x) => x.name), ['Band', 'Hits', 'loose']);
    assert.deepStrictEqual(f0.files.map((i) => tracks[i].rel), ['broken.mp3']);
    const f1 = M.folderEntries(tracks, 'Band/2001 First');
    assert.strictEqual(f1.files.length, 3); assert.strictEqual(f1.folders.length, 0);
    assert.strictEqual(M.folderEntries(tracks, 'Hits').folders.map((x) => x.path).join(), 'Hits/CD1,Hits/CD2');
    ok('model: folder browsing');

    assert.strictEqual(M.formatDuration(0), '0:00'); assert.strictEqual(M.formatDuration(61999), '1:02');
    assert.strictEqual(M.formatDuration(3723000), '1:02:03'); assert.strictEqual(M.formatDuration(-5), '0:00');
    assert.strictEqual(M.formatTotal(41 * 60000), '41 min'); assert.strictEqual(M.formatTotal(125 * 60000), '2 h 5 min'); assert.strictEqual(M.formatTotal(1000), '1 min');
    ok('model: duration formatting');

    const t = tracks.find((x) => x.rel.endsWith('01 Alpha.wav'));
    assert.deepStrictEqual(M.replayGainFor(t, 'track'), { gain: -6.5, peak: 0.8 });
    assert.deepStrictEqual(M.replayGainFor(t, 'album'), { gain: -5, peak: null });
    assert.strictEqual(M.replayGainFor(t, 'off'), null);
    assert.strictEqual(M.replayGainFor({ rg: { track: -3, trackPeak: 1, album: null, albumPeak: null } }, 'album').gain, -3, 'album mode falls back to the track gain');
    assert.strictEqual(M.replayGainFor({ rg: null }, 'track'), null);
    assert(Math.abs(M.gainFactor({ gain: -6, peak: null }) - 0.501) < 0.001);
    assert(Math.abs(M.gainFactor({ gain: -6, peak: null }, 6) - 1) < 1e-9, 'preamp adds to the gain');
    assert(Math.abs(M.gainFactor({ gain: 6, peak: 0.9 }) - 1 / 0.9) < 1e-9, 'loud boost is limited so the peak stays at full scale');
    assert.strictEqual(M.gainFactor(null), 1); assert.strictEqual(M.gainFactor(null, 0, -3) < 1, true);
    assert(M.gainFactor({ gain: 99, peak: null }) <= 10 ** (20 / 20) + 1e-9);
    ok('model: ReplayGain selection and a clip-safe gain factor');

    const ids = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
    const s = M.shuffled(ids, 6, () => 0.3);
    assert.strictEqual(s[0], 6); assert.deepStrictEqual([...s].sort((a, b) => a - b), ids); assert.notDeepStrictEqual(s, ids);
    assert.deepStrictEqual(ids, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], 'input untouched');
    ok('model: shuffle keeps every track once and puts the chosen one first');
  }

  // ---- lyrics ----------------------------------------------------------------------------------------------------
  {
    assert.strictEqual(Lyrics.decodeText(Buffer.from('héllo', 'utf8')), 'héllo');
    assert.strictEqual(Lyrics.decodeText(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('bom')])), 'bom');
    assert.strictEqual(Lyrics.decodeText(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('hé', 'utf16le')])), 'hé');
    assert.strictEqual(Lyrics.decodeText(Buffer.from([0x63, 0x61, 0x66, 0xe9])), 'café', 'Windows-1252 fallback');
    ok('lyrics: text decoding (UTF-8, BOMs, UTF-16, Windows-1252)');

    const song = F.makeWav(p('lyr', 'song.wav'));
    assert.strictEqual(Lyrics.loadLyrics(song).source, 'none');
    assert.strictEqual(Lyrics.findSidecar(song), null);

    fs.writeFileSync(p('lyr', 'song.txt'), 'plain one\nplain two');
    let l = Lyrics.loadLyrics(song);
    assert.deepStrictEqual([l.source, l.synced, l.lines.length], ['sidecar', false, 2]);
    fs.writeFileSync(p('lyr', 'song.lrc'), '[00:01.00]sync one\n[00:02.00]sync two');
    l = Lyrics.loadLyrics(song);
    assert.deepStrictEqual([l.source, l.synced, l.lines[0].text, l.file], ['sidecar', true, 'sync one', p('lyr', 'song.lrc')]);
    ok('lyrics: sidecar .lrc preferred over .txt, plain sidecar read');

    const mp = F.makeMp3(p('lyr', 'emb.mp3'));
    F.tag(mp, { title: 'e', lyrics: 'embedded plain\nsecond' });
    l = Lyrics.loadLyrics(mp);
    assert.deepStrictEqual([l.source, l.synced, l.lines.map((x) => x.text)], ['embedded', false, ['embedded plain', 'second']]);
    const mp2 = F.makeMp3(p('lyr', 'emb2.mp3'));
    F.tag(mp2, { title: 'e', lyrics: '[00:05.00]lrc text in tag\n[00:09.00]more' });
    l = Lyrics.loadLyrics(mp2);
    assert.deepStrictEqual([l.source, l.synced, l.lines[1].t], ['embedded', true, 9000]);
    ok('lyrics: embedded lyrics, including LRC text stored in the tag');

    const mp3s = F.makeMp3(p('lyr', 'sylt.mp3'));
    F.tag(mp3s, { title: 's', lyrics: 'ignored plain', sylt: [{ time: 1500, text: 'hello' }, { time: 500, text: 'first' }] });
    l = Lyrics.loadLyrics(mp3s);
    assert.deepStrictEqual([l.source, l.synced, l.lines.map((x) => [x.t, x.text])], ['embedded', true, [[500, 'first'], [1500, 'hello']]]);
    fs.writeFileSync(p('lyr', 'sylt.txt'), 'plain sidecar');
    assert.strictEqual(Lyrics.loadLyrics(mp3s).synced, true, 'embedded synced beats a plain sidecar');
    fs.writeFileSync(p('lyr', 'sylt.lrc'), '[00:00.10]sidecar sync');
    assert.strictEqual(Lyrics.loadLyrics(mp3s).source, 'sidecar', 'sidecar synced beats embedded synced');
    ok('lyrics: ID3 SYLT read; priority sidecar synced > embedded synced > plain');

    const target = p('lyr', 'new.wav'); F.makeWav(target);
    const s1 = Lyrics.saveSidecar(target, '[00:01.00]one\n');
    assert.strictEqual(s1.file, p('lyr', 'new.lrc')); assert.strictEqual(s1.backup, null);
    const s2 = Lyrics.saveSidecar(target, '[00:01.00]two\r\n');
    assert.strictEqual(fs.readFileSync(s2.backup, 'utf8'), '[00:01.00]one\n');
    assert.strictEqual(fs.readFileSync(s2.file, 'utf8'), '[00:01.00]two\n');
    assert.deepStrictEqual(fs.readdirSync(p('lyr')).filter((x) => x.endsWith('.tmp')), []);
    assert.throws(() => Lyrics.saveSidecar(target, '   \n'), /nothing to save/);
    assert.throws(() => Lyrics.saveSidecar(target, 'x'.repeat(LRC.MAX_CHARS + 1)), /too long/);
    assert.strictEqual(fs.readFileSync(s2.file, 'utf8'), '[00:01.00]two\n', 'a refused save leaves the file as it was');
    const audioBefore = fs.readFileSync(target);
    Lyrics.saveSidecar(target, '[00:03.00]three');
    assert.deepStrictEqual(fs.readFileSync(target), audioBefore, 'the audio file is never touched');
    ok('lyrics: save writes <song>.lrc atomically, keeps a .bak, refuses empty / huge, never touches the audio');
  }

  // ---- playlists -------------------------------------------------------------------------------------------------
  {
    const dir = p('pl');
    const text = '#EXTM3U\n#EXTINF:215,Band - Alpha\nMusic/a.mp3\n\n# a comment\n..\\other\\b.flac\nhttp://radio.example/stream\nfile:///C:/Music/c%20d.mp3\n#EXTINF:-1,No path after this\n';
    const e = PL.parseM3U(text, dir);
    assert.strictEqual(e.length, 3);
    assert.deepStrictEqual(e[0], { file: path.resolve(dir, 'Music', 'a.mp3'), title: 'Band - Alpha' });
    assert.strictEqual(e[1].file, path.resolve(dir, '..', 'other', 'b.flac'));
    assert(e[2].file.endsWith('c d.mp3'));
    ok('playlists: M3U parsing (relative paths, either slash, #EXTINF, streams skipped, file:// URLs)');

    const out = PL.writeM3U([{ file: path.join(dir, 'sub', 'x.mp3'), title: 'X', seconds: 61.6 }, { file: path.resolve(dir, '..', 'far', 'y.mp3'), title: 'Y\nline2' }], dir);
    assert.strictEqual(out, '#EXTM3U\n#EXTINF:62,X\nsub/x.mp3\n#EXTINF:-1,Y line2\n' + path.resolve(dir, '..', 'far', 'y.mp3').split(path.sep).join('/') + '\n');
    const round = PL.parseM3U(out, dir);
    assert.deepStrictEqual(round.map((x) => x.file), [path.join(dir, 'sub', 'x.mp3'), path.resolve(dir, '..', 'far', 'y.mp3')]);
    ok('playlists: M3U8 writing uses relative paths with / and round-trips');

    const f = p('pl', 'a.m3u8'); fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(f, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('#EXTM3U\nsong.mp3\n')]));
    assert.strictEqual(PL.readM3UFile(f).length, 1);
    ok('playlists: file reader handles a UTF-8 BOM');

    const clean = PL.cleanStore({ lists: [{ id: 'a b!', name: '  Road trip  ', tracks: ['x.mp3', 5, 'y.mp3'] }, { id: 'p1', name: 5, tracks: [] }, null, { name: '', tracks: [] }, { id: 'p1', name: 'dup', tracks: [] }] });
    assert.deepStrictEqual(clean.lists.map((x) => [x.name, x.tracks.length]), [['Road trip', 2], ['Playlist', 0], ['dup', 0]]);
    assert.strictEqual(new Set(clean.lists.map((x) => x.id)).size, 3, 'ids are unique and well-formed');
    assert(clean.lists.every((x) => /^[\w-]+$/.test(x.id)));
    assert.deepStrictEqual(PL.cleanStore('junk'), { lists: [] });
    const sf = p('pl', 'store.json');
    PL.saveStore(sf, clean);
    assert.deepStrictEqual(PL.loadStore(sf).lists.map((x) => x.name), ['Road trip', 'Playlist', 'dup']);
    fs.writeFileSync(sf, 'garbage'); assert.deepStrictEqual(PL.loadStore(sf), { lists: [] });
    ok('playlists: saved playlist store is validated, saved atomically, survives a damaged file');
  }

  // ---- launcher link ---------------------------------------------------------------------------------------------
  {
    const data = p('launcher', 'data');
    const exe = path.join(data, 'tools', 'audio-tagger', '0.2.0', 'audio-tagger.exe');
    fs.mkdirSync(path.dirname(exe), { recursive: true }); fs.writeFileSync(exe, 'x');
    const write = (obj) => fs.writeFileSync(path.join(data, 'installed.json'), typeof obj === 'string' ? obj : JSON.stringify(obj));
    write({ 'audio-tagger': { version: '0.2.0', exec: 'audio-tagger.exe' } });
    assert.deepStrictEqual(Link.findInstalledTool([data], 'audio-tagger'), { file: exe, cwd: path.dirname(exe) });
    assert.strictEqual(Link.findInstalledTool([p('nowhere'), data], 'audio-tagger').file, exe, 'tries the next place');
    assert.strictEqual(Link.findInstalledTool([data], 'video-converter'), null, 'not installed');
    for (const bad of [{ version: '0.2.0', exec: '../../../../evil.exe' }, { version: '..', exec: 'audio-tagger.exe' }, { version: '0.2.0/../0.2.0', exec: 'audio-tagger.exe' }, { version: '0.2.0', exec: path.resolve(tmp, 'outside.exe') }, { version: '0.2.0', exec: 'missing.exe' }, { version: '0.2.0', exec: '' }, { version: 5, exec: 'audio-tagger.exe' }, { version: '0.2.0', exec: '.' }]) {
      write({ 'audio-tagger': bad });
      assert.strictEqual(Link.findInstalledTool([data], 'audio-tagger'), null, 'must refuse ' + JSON.stringify(bad));
    }
    write('not json'); assert.strictEqual(Link.findInstalledTool([data], 'audio-tagger'), null);
    write('{"__proto__": {"version": "1", "exec": "a"}}'); assert.strictEqual(Link.findInstalledTool([data], 'constructor'), null);
    assert.strictEqual(Link.findInstalledTool([data], '../x'), null);
    ok('launcher link: finds an installed tool, refuses a path that escapes its folder, bad ids, damaged files');
  }

  // ---- settings --------------------------------------------------------------------------------------------------
  {
    const d = Settings.defaults();
    assert.strictEqual(d.volume, 0.8); assert.strictEqual(d.eq.bands.length, 10);
    const c = Settings.clean({ volume: 7, repeat: 'sideways', shuffle: 'yes', eq: { on: true, bands: [99, -99, 1, 2, 3, 4, 5, 6, 7, 8], preamp: 'x', preset: 'Nope' }, rg: { mode: 'album', preamp: 3 }, sort: { by: 'bogus', dir: -1 }, recent: ['a', 'a', 5, 'b'], last: { rel: 'x/y.mp3', pos: -3 }, view: 'hacked', constructor: 1 }, d);
    assert.strictEqual(c.volume, 1); assert.strictEqual(c.repeat, 'off'); assert.strictEqual(c.shuffle, false);
    assert.deepStrictEqual(c.eq.bands.slice(0, 3), [12, -12, 1]); assert.strictEqual(c.eq.preamp, 0); assert.strictEqual(c.eq.preset, 'Flat'); assert.strictEqual(c.eq.on, true);
    assert.deepStrictEqual(c.rg, { mode: 'album', preamp: 3 }); assert.deepStrictEqual(c.sort, { by: 'default', dir: -1 });
    assert.deepStrictEqual(c.recent, ['a', 'b']); assert.deepStrictEqual(c.last, { rel: 'x/y.mp3', pos: 0 }); assert.strictEqual(c.view, 'songs');
    assert.strictEqual(Settings.clean({ volume: 0.3 }, c).eq.on, true, 'a partial patch keeps the other values');
    assert.strictEqual(Settings.clean('junk', c).volume, c.volume);
    assert.strictEqual(Settings.clean({ eq: { preset: 'Custom' } }, d).eq.preset, 'Custom');
    const f = p('settings', 's.json'); Settings.save(f, c); assert.deepStrictEqual(Settings.load(f), c);
    fs.writeFileSync(f, '{broken'); assert.deepStrictEqual(Settings.load(f), d);
    ok('settings: defaults, clamping, rejecting bad values, partial patches, save/load, damaged file');
    const EQ = require('../src/eq-presets');
    assert(Object.values(EQ.PRESETS).every((b) => b.length === EQ.BANDS.length && b.every((v) => Math.abs(v) <= 12)));
    ok('eq presets: every preset has one value per band, within +-12 dB');
  }

  // ---- colour contrast of the UI (WCAG AA) -----------------------------------------------------------------------
  {
    const css = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'styles.css'), 'utf8');
    const root = /:root\s*\{([\s\S]*?)\n\}/.exec(css)[1];
    const tok = {}; for (const m of root.matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{6})\b/g)) tok[m[1]] = m[2];
    const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
    const lin = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
    const lum = (c) => 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
    const ratio = (a, b) => { const [x, y] = [lum(rgb(a)), lum(rgb(b))].sort((i, j) => j - i); return (x + 0.05) / (y + 0.05); };
    const pairs = [
      ['text on page', tok.text, tok.bg, 4.5], ['text on panel', tok.text, tok.panel, 4.5], ['text on selected row', tok.text, tok['panel-3'], 4.5],
      ['muted text on page', tok.muted, tok.bg, 4.5], ['muted text on panel', tok.muted, tok.panel, 4.5], ['muted text on hovered row', tok.muted, tok['panel-2'], 4.5], ['muted text on selected row', tok.muted, tok['panel-3'], 4.5],
      ['accent text on page', tok.accent, tok.bg, 4.5], ['accent (playing song) on selected row', tok.accent, tok['panel-3'], 4.5], ['accent on panel', tok.accent, tok.panel, 4.5],
      ['white on primary button', '#ffffff', tok.btn, 4.5], ['white on primary button (hover)', '#ffffff', tok['btn-hover'], 4.5],
      ['error text on panel', tok.err, tok['panel-2'], 4.5], ['focus ring on page', tok.focus, tok.bg, 3], ['focus ring on panel', tok.focus, tok.panel, 3],
      ['inactive lyrics (large text) on page', '#6c7390', tok.bg, 3], ['past lyrics (large text) on page', '#8a91ab', tok.bg, 3], ['plain lyrics on page', '#cfd3e3', tok.bg, 4.5],
    ];
    const failed = pairs.filter(([, fg, bg, min]) => ratio(fg, bg) < min).map(([name, fg, bg, min]) => `${name}: ${ratio(fg, bg).toFixed(2)} < ${min}`);
    assert.deepStrictEqual(failed, []);
    ok(`contrast: ${pairs.length} colour pairs meet WCAG AA`);
  }

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${n} test groups passed`);
})().catch((e) => { console.error('\nFAILED:', e && e.stack || e); fs.rmSync(tmp, { recursive: true, force: true }); process.exit(1); });
