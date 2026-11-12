'use strict';
// Subtitle Maker core tests: the subtitle rules (cue building, line wrapping, reading speed, timing), .srt and .vtt writing
// and reading (round trips with tricky timings, unicode and several lines, files from other programs), editing (shift, split,
// merge), the export to MP4 (burnt in, checked on the picture; soft track, checked in the file), the pipeline with a fake
// engine, and the REAL Whisper model: on silence everywhere, and on spoken clips where a speech voice exists (espeak-ng on
// Linux, the Windows voices on Windows; skipped, with a note, elsewhere).
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const S = require('../src/subs');
const M = require('../src/media');
const A = require('../src/audio');
const E = require('../src/engine');
const W = require('../src/whisper');
const SP = require('../src/speech');

const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const near = (a, b, tol, msg) => assert(Math.abs(a - b) <= tol, `${msg || ''} expected ${b} +/- ${tol}, got ${a}`);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'subtitle-test-'));
const ff = A.ffmpegPath();
const skipUnlessSpeech = (fn) => async () => { if (!SP.available()) { console.log('     (skipped: needs espeak-ng or the Windows speech voices to make a spoken clip)'); return; } await fn(); };
const skipUnlessEspeak = (fn) => async () => { if (!SP.espeakAvailable()) { console.log('     (skipped: needs espeak-ng for a German voice)'); return; } await fn(); };
function ffmpeg(args) { const r = spawnSync(ff, ['-y', '-hide_banner', '-v', 'error', ...args], { encoding: 'utf8', windowsHide: true, maxBuffer: 1 << 26 }); assert.strictEqual(r.status, 0, 'ffmpeg failed: ' + r.stderr); return r; }

/** Words with times, as the recogniser gives them: `spec` is "word@start-end word@start-end ..." */
const words = (spec) => spec.trim().split(/\s+/).map((t) => { const [text, times] = t.split('@'); const [a, b] = times.split('-').map(Number); return { text: text.replace(/_/g, ' '), start: a, end: b }; });
const seg = (spec) => { const w = words(spec); return { start: w[0].start, end: w[w.length - 1].end, text: w.map((x) => x.text).join(' '), words: w }; };
/** Evenly timed words for a sentence starting at `t`, `rate` words per second. */
function sentence(text, t, rate = 2.8) {
  const ws = text.split(' ').map((w, i) => ({ text: w, start: t + i / rate, end: t + (i + 0.85) / rate }));
  return { start: ws[0].start, end: ws[ws.length - 1].end, text, words: ws };
}
function checkRules(cues, R = S.RULES) {
  for (let i = 0; i < cues.length; i++) {
    const c = cues[i]; const next = cues[i + 1];
    const lines = c.text.split('\n');
    assert(lines.length <= R.maxLines, `cue ${i} has ${lines.length} lines: ${JSON.stringify(c.text)}`);
    for (const l of lines) assert([...l].length <= R.maxLineChars, `cue ${i} line too long (${[...l].length}): ${l}`);
    assert(c.end - c.start <= R.maxDuration + 1e-6, `cue ${i} too long: ${c.end - c.start}`);
    assert(c.end > c.start, `cue ${i} has no time`);
    if (next) assert(next.start - c.end >= R.gap - 1e-6, `no gap between cue ${i} and ${i + 1}: ${c.end} -> ${next.start}`);
  }
}

// ---- time formats ---------------------------------------------------------------------------------------------------------------
test('time: SRT and VTT stamps, with the carry done on whole milliseconds; typed times are read in every usual form', () => {
  assert.strictEqual(S.srtTime(0), '00:00:00,000');
  assert.strictEqual(S.srtTime(3661.5), '01:01:01,500');
  assert.strictEqual(S.srtTime(59.9996), '00:01:00,000');
  assert.strictEqual(S.srtTime(3599.9995), '01:00:00,000');
  assert.strictEqual(S.srtTime(1.0005), '00:00:01,001');
  assert.strictEqual(S.srtTime(-2), '00:00:00,000');
  assert.strictEqual(S.vttTime(61.25), '00:01:01.250');
  assert.strictEqual(S.srtTime(100 * 3600 + 1), '100:00:01,000');
  assert.strictEqual(S.formatTime(65.4), '1:05.400'); assert.strictEqual(S.formatTime(3725.007), '1:02:05.007');
  assert.strictEqual(S.parseTime('1:05.4'), 65.4); assert.strictEqual(S.parseTime('01:01:05,400'), 3665.4); assert.strictEqual(S.parseTime('65.25'), 65.25);
  assert.strictEqual(S.parseTime(' 0:12,5 '), 12.5); assert.strictEqual(S.parseTime('1:02:05.007'), 3725.007); assert.strictEqual(S.parseTime('90'), 90);
  for (const bad of ['', 'abc', '1:75', '1:61:00', '-3', null, '1:05.', '1:2:3:4', '1:05.1234']) assert.strictEqual(S.parseTime(bad), null, JSON.stringify(bad));
  assert.strictEqual(S.formatDuration(125), '2:05'); assert.strictEqual(S.formatDuration(3725), '1:02:05');
});

// ---- wrapping and reading speed ----------------------------------------------------------------------------------------------------
test('wrap: short text stays on one line; longer text is split into two even lines at a word, preferring punctuation', () => {
  assert.deepStrictEqual(S.wrapText('Hello there.'), ['Hello there.']);
  const two = S.wrapText('The quick brown fox jumps over the lazy dog near the riverbank today');
  assert.strictEqual(two.length, 2); assert(two.every((l) => l.length <= 42), JSON.stringify(two));
  assert(Math.abs(two[0].length - two[1].length) <= 10, 'even lines: ' + JSON.stringify(two));
  assert.deepStrictEqual(S.wrapText('I was going to call you, but the phone died on the way home'), ['I was going to call you,', 'but the phone died on the way home']);
  assert.deepStrictEqual(S.wrapText('  line one\nline   two  '), ['line one line two']);
  const many = S.wrapText('word '.repeat(40).trim());
  assert(many.length > 2 && many.every((l) => l.length <= 42), 'too long for two lines: filled greedily');
  const cjk = S.wrapText('今日はとても良い天気ですね。散歩に行きましょうか。', 16, false);
  assert.strictEqual(cjk.length, 2); assert(cjk.every((l) => [...l].length <= 16), JSON.stringify(cjk));
  assert.deepStrictEqual(S.wrapText(''), []);
  // characters, not UTF-16 units: emoji and accents count once
  assert.deepStrictEqual(S.wrapText('😀'.repeat(42)), ['😀'.repeat(42)]);
});

test('reading speed: characters per second (tags and line breaks do not count) and every rule gives a plain-words warning', () => {
  near(S.cps({ start: 0, end: 2, text: 'Hello world!\nOK' }), 7, 1e-9);
  near(S.cps({ start: 0, end: 1, text: '<i>abc</i>' }), 3, 1e-9);
  assert.strictEqual(S.cps({ start: 1, end: 1, text: 'x' }), Infinity);
  const codes = (c, n) => S.cueProblems(c, n).map((p) => p.code).sort();
  assert.deepStrictEqual(codes({ start: 0, end: 2, text: 'Fine.' }), []);
  assert.deepStrictEqual(codes({ start: 0, end: 1.5, text: 'Far too much text to read in that time' }), ['fast']);
  assert(/Too fast to read: 25 characters per second/.test(S.cueProblems({ start: 0, end: 1.5, text: 'Far too much text to read in that time' })[0].message));
  assert.deepStrictEqual(codes({ start: 0, end: 0.5, text: 'Hi' }), ['short']);
  assert.deepStrictEqual(codes({ start: 0, end: 9, text: 'Long one' }), ['long']);
  assert.deepStrictEqual(codes({ start: 0, end: 6, text: 'a\nb\nc' }), ['lines']);
  assert.deepStrictEqual(codes({ start: 0, end: 6, text: 'x'.repeat(50) }), ['width']);
  assert.deepStrictEqual(codes({ start: 0, end: 3, text: 'one' }, { start: 2, end: 4, text: 'two' }), ['overlap']);
  assert.deepStrictEqual(codes({ start: 3, end: 2, text: 'back' }), ['order']);
  assert.deepStrictEqual(codes({ start: 0, end: 2, text: '  ' }), ['empty']);
});

// ---- building cues ------------------------------------------------------------------------------------------------------------------
test('cues: a pause in the speech starts a new cue, each cue starts with its first word, and short cues stay up at least 1 s', () => {
  const cues = S.buildCues([seg('Hello@1.0-1.3 there.@1.35-1.7'), seg('How@4.0-4.2 are@4.25-4.4 you?@4.45-4.8')]);
  assert.strictEqual(cues.length, 2);
  assert.deepStrictEqual(cues.map((c) => c.text), ['Hello there.', 'How are you?']);
  assert.strictEqual(cues[0].start, 1.0); assert.strictEqual(cues[1].start, 4.0);
  near(cues[0].end - cues[0].start, 1.0, 0.001, 'stretched to the minimum');
  checkRules(cues);
});

test('cues: long speech is cut into cues of at most two lines of 42 characters and 7 s, at sentence ends and commas first', () => {
  const text = 'So the plan for tomorrow is simple. We leave the house at seven, we drive to the coast, and if the weather holds we take the boat out to the island where my grandfather used to fish every summer when he was a boy.';
  const cues = S.buildCues([sentence(text, 2.0, 3.2)]);
  checkRules(cues);
  assert.strictEqual(cues.map((c) => c.text.replace(/\n/g, ' ')).join(' '), text, 'no word lost or doubled');
  assert(cues.length >= 4, `${cues.length} cues`);
  assert.strictEqual(cues[0].text.replace(/\n/g, ' '), 'So the plan for tomorrow is simple.', 'cut at the sentence end');
  assert(cues.some((c) => /,$/.test(c.text)), 'some cue ends at a comma: ' + JSON.stringify(cues.map((c) => c.text)));
  for (const c of cues) assert(S.cps(c) <= 22, `readable: ${S.cps(c).toFixed(1)} cps for ${JSON.stringify(c.text)}`);
});

test('cues: there is always a gap between cues, words that run into the next cue are cut back, and nothing lasts over 7 s', () => {
  // two segments with no pause at all between them, then a single slow word held for 12 seconds
  const cues = S.buildCues([
    seg('This@0.0-0.3 is@0.3-0.5 the@0.5-0.6 first@0.6-0.9 sentence@0.9-1.4 here.@1.4-1.8'),
    seg('And@1.8-2.0 this@2.0-2.2 one@2.2-2.4 follows@2.4-2.8 right@2.8-3.0 away.@3.0-3.4'),
    seg('Wait@10.0-22.0'),
  ]);
  checkRules(cues);
  assert.strictEqual(cues.length, 3);
  near(cues[1].start - cues[0].end, S.RULES.gap, 0.002, 'the gap');
  near(cues[2].end - cues[2].start, 7, 0.001, 'capped at 7 s');
});

test('cues: fast speech is kept on screen longer when there is room, and the warning shows when there is none', () => {
  const quick = S.buildCues([seg('Absolutely@5.0-5.3 extraordinary@5.3-5.6 circumstances.@5.6-5.9')]);
  assert.strictEqual(quick.length, 1);
  assert(S.cps(quick[0]) <= S.RULES.targetCps + 0.01, 'stretched to a readable speed: ' + S.cps(quick[0]));
  const squeezed = S.buildCues([seg('Absolutely@5.0-5.3 extraordinary@5.3-5.6 circumstances.@5.6-5.9'), seg('Next!@6.2-6.5')]);
  assert(squeezed[0].end <= 6.2 - S.RULES.gap + 1e-9);
  assert(S.cueProblems(squeezed[0], squeezed[1]).some((p) => p.code === 'fast'), 'the reader is warned');
});

test('cues: segments without word times are shared out by length; noise labels and empty segments are dropped; no-space languages', () => {
  const cues = S.buildCues([{ start: 0, end: 4, text: ' [Music] ' }, { start: 5, end: 8, text: 'Without word times this still becomes a cue.' }, { start: 9, end: 10, text: '♪ ♪' }]);
  assert.strictEqual(cues.length, 1); assert.strictEqual(cues[0].start, 5); assert(cues[0].end >= 7.9);
  assert.strictEqual(cues[0].text.replace(/\n/g, ' '), 'Without word times this still becomes a cue.');
  const ja = S.buildCues([{ start: 1, end: 6, text: '今日はとても良い天気ですね。散歩に行きましょうか。', words: [...'今日はとても良い天気ですね。散歩に行きましょうか。'].map((ch, i) => ({ text: ch, start: 1 + i * 0.2, end: 1.18 + i * 0.2 })) }], { language: 'ja' });
  checkRules(ja, S.rulesFor('ja'));
  assert.strictEqual(ja.map((c) => c.text.replace(/\n/g, '')).join(''), '今日はとても良い天気ですね。散歩に行きましょうか。');
  assert(!ja.some((c) => / /.test(c.text)), 'no spaces added between characters');
  assert.deepStrictEqual(S.buildCues([]), []);
});

test('cues: a 20 minute talk with natural pauses gives cues that all keep the rules', () => {
  const lorem = 'we should probably talk about the budget before anyone leaves, because the numbers changed again this morning and nobody told the design team what that means for them';
  const parts = lorem.split(' ');
  const segs = []; let t = 0.5; let k = 0;
  let rnd = 7; const next = () => { rnd = (rnd * 1103515245 + 12345) % 2147483648; return rnd / 2147483648; };
  while (t < 1200) {
    const n = 4 + Math.floor(next() * 18);
    const ws = [];
    for (let i = 0; i < n; i++) { const d = 0.15 + next() * 0.35; ws.push({ text: parts[k++ % parts.length] + (i === n - 1 ? '.' : ''), start: t, end: t + d }); t += d + (next() < 0.1 ? 0.3 : 0.05); }
    segs.push({ start: ws[0].start, end: ws[ws.length - 1].end, text: ws.map((w) => w.text).join(' '), words: ws });
    t += next() < 0.5 ? 0.2 : 1.5;
  }
  const t0 = Date.now();
  const cues = S.buildCues(segs);
  assert(Date.now() - t0 < 2000, 'quick enough');
  checkRules(cues);
  assert.strictEqual(cues.map((c) => c.text.replace(/\n/g, ' ')).join(' '), segs.map((s) => s.text).join(' '));
});

// ---- editing --------------------------------------------------------------------------------------------------------------------------
test('edit: shift moves every cue and never before 0; split at the playhead or by text; merge joins and re-wraps', () => {
  const cues = [{ start: 0.3, end: 1.5, text: 'a' }, { start: 5, end: 7, text: 'b' }];
  assert.deepStrictEqual(S.shiftCues(cues, 1.25).map((c) => [c.start, c.end]), [[1.55, 2.75], [6.25, 8.25]]);
  assert.deepStrictEqual(S.shiftCues(cues, -1).map((c) => [c.start, c.end]), [[0, 0.5], [4, 6]]);
  assert.deepStrictEqual(S.shiftCues(cues, -10).map((c) => [c.start, c.end]), [[0, 0.1], [0, 0.1]], 'pushed before 0, each keeps a moment');
  assert.deepStrictEqual(S.shiftCues(S.shiftCues(cues, 0.1), -0.1), cues, 'no rounding drift');

  const [a, b] = S.splitCue({ start: 10, end: 14, text: 'I was going to call you,\nbut the phone died' });
  assert.deepStrictEqual([a.text, b.text], ['I was going to call you,', 'but the phone died']);
  assert.strictEqual(a.start, 10); assert.strictEqual(b.end, 14); assert(a.end < b.start && a.end > 11 && a.end < 13);
  const [c, d] = S.splitCue({ start: 0, end: 4, text: 'one two three four' }, 3.0);
  assert.deepStrictEqual([c.text, d.text, c.end], ['one two', 'three four', 3]);
  near(d.start, 3.084, 0.001);
  assert.strictEqual(S.splitCue({ start: 0, end: 2, text: 'single' }), null);
  const [e, f] = S.splitCue({ start: 0, end: 2, text: 'こんにちは世界' }, null, false);
  assert.strictEqual(e.text + f.text, 'こんにちは世界');

  const m = S.mergeCues({ start: 1, end: 2, text: 'First part of a longer thought,' }, { start: 2.1, end: 4, text: 'and the end\nof it.' });
  assert.deepStrictEqual([m.start, m.end], [1, 4]);
  assert.strictEqual(m.text.replace(/\n/g, ' '), 'First part of a longer thought, and the end of it.');
  assert(m.text.split('\n').length === 2 && m.text.split('\n').every((l) => l.length <= 42));
  const list = [{ start: 1, end: 2 }, { start: 2.5, end: 4 }];
  assert.strictEqual(S.cueAt(list, 0.5), -1); assert.strictEqual(S.cueAt(list, 1), 0); assert.strictEqual(S.cueAt(list, 2.2), -1); assert.strictEqual(S.cueAt(list, 3.9), 1); assert.strictEqual(S.cueAt(list, 4), -1);
});

// ---- files ------------------------------------------------------------------------------------------------------------------------------
const TRICKY = [
  { start: 0, end: 0.001, text: 'At zero, one millisecond' },
  { start: 59.9996, end: 61.0004, text: 'Rounds over a minute' },
  { start: 3599.9995, end: 3601.5, text: 'Over the hour' },
  { start: 4.5, end: 6, text: 'Two lines,\nsecond line' },
  { start: 7, end: 9, text: 'Unicode: café, naïve, Ελληνικά, русский, 日本語, עברית, 😀 👍🏽' },
  { start: 10, end: 12, text: '<i>Italic</i> and <b>bold</b> & "quotes" — 5 < 6 > 4' },
  { start: 13, end: 15, text: '42' },
  { start: 16, end: 18, text: '00:00:01,000 --> looks like a time' },
  { start: 19, end: 21, text: 'Line one\n\n\nafter blank lines   ' },
  { start: 22, end: 22, text: 'zero length' },
  { start: 36000, end: 36002.5, text: 'Ten hours in' },
];
const rounded = (cues) => cues.map((c) => ({ start: Math.round(c.start * 1000) / 1000, end: Math.round(c.end * 1000) / 1000, text: S.fileText(c.text) })).sort((a, b) => a.start - b.start);

test('srt: write and read back gives the same cues, with tricky timings, unicode, tags, several lines and a number-only line', () => {
  const text = S.formatSrt(TRICKY);
  assert(text.startsWith('1\r\n00:00:00,000 --> 00:00:00,001\r\nAt zero'), text.slice(0, 60));
  assert(text.includes('\r\n00:01:00,000 --> 00:01:01,000\r\nRounds'), 'carry');
  assert(text.includes('\r\n01:00:00,000 --> 01:00:01,500\r\nOver the hour'));
  assert(text.includes('\r\n\r\n11\r\n10:00:00,000 --> 10:00:02,500\r\nTen hours in\r\n'), 'numbered in order of time');
  assert(text.includes('Line one\r\nafter blank lines\r\n'), 'blank lines inside a cue are dropped (they would end it)');
  assert(!/\r\n\r\n\r\n/.test(text), 'blocks are separated by exactly one blank line');
  const back = S.parseSrt(text);
  assert.deepStrictEqual(back, rounded(TRICKY));
  assert.deepStrictEqual(S.parseSrt(S.formatSrt(back)), back, 'stable');
  // sorted by start, cues without text are not written
  assert.deepStrictEqual(S.parseSrt(S.formatSrt([{ start: 5, end: 6, text: 'b' }, { start: 1, end: 2, text: '  ' }, { start: 2, end: 3, text: 'a' }])).map((c) => c.text), ['a', 'b']);
});

test('srt: files from other programs are read: LF, no numbers, dots, BOM, extra blank lines, missing hours, ASS codes, positions', () => {
  const messy = '\uFEFF\n\n1\n00:00:01.5 --> 00:00:03,25\nfirst\n\n\n\n00:00:04,000 --> 00:00:05,000 X1:10 X2:20\n{\\an8}no number, a position\n\n3\r\n00:06,000 --> 00:07,000\r\nno hours\r\n\r\nnot a cue at all\njust text\n\n7\n00:00:09,000 --> 00:00:10,000\n';
  assert.deepStrictEqual(S.parseSrt(messy), [
    { start: 1.5, end: 3.25, text: 'first' },
    { start: 4, end: 5, text: 'no number, a position' },
    { start: 6, end: 7, text: 'no hours' },
    { start: 9, end: 10, text: '' },
  ]);
  assert.throws(() => S.parseSubtitles('just some notes\nwith no times'), /No subtitles/);
  assert.deepStrictEqual(S.parseSubtitles('').cues, []);
});

test('vtt: write and read back gives the same cues; &, < and --> are escaped; i/b/u tags are kept', () => {
  const text = S.formatVtt(TRICKY);
  assert(text.startsWith('WEBVTT\n\n00:00:00.000 --> 00:00:00.001\nAt zero'));
  assert(text.includes('<i>Italic</i> and <b>bold</b> &amp; "quotes" — 5 &lt; 6 '), 'escaped');
  assert(text.includes('00:00:01,000 → looks like a time'), 'an arrow inside text would end the cue');
  const back = S.parseVtt(text);
  const want = rounded(TRICKY).map((c) => ({ ...c, text: c.text.replace('-->', '→') }));
  assert.deepStrictEqual(back, want);
  assert.deepStrictEqual(S.parseVtt(S.formatVtt(back)), back, 'stable');
  // SRT -> VTT -> SRT keeps everything a player shows
  assert.deepStrictEqual(S.parseSrt(S.formatSrt(S.parseVtt(S.formatVtt(TRICKY)))), want);
});

test('vtt: files from other programs are read: header text, NOTE/STYLE/REGION, ids, settings, short times, voices, entities', () => {
  const vtt = 'WEBVTT - made by another program\nKind: captions\n\nSTYLE\n::cue { color: yellow }\n\nNOTE this is a comment\nover two lines\n\nintro\n00:01.000 --> 00:02.500 align:start position:10%\n<v Roger>Hi &amp; welcome</v>\n\n2\n00:00:03.000 --> 00:00:04.000\n<c.loud>Loud</c> &lt;3 &nbsp;<i>it</i>\n\nREGION\nid:fred\n\n00:05.000 --> 00:06.000\n<00:05.500>karaoke\n';
  assert.deepStrictEqual(S.parseVtt(vtt), [
    { start: 1, end: 2.5, text: 'Hi & welcome' },
    { start: 3, end: 4, text: 'Loud <3 \u00A0<i>it</i>' },
    { start: 5, end: 6, text: 'karaoke' },
  ]);
  assert.throws(() => S.parseVtt('1\n00:00:01,000 --> 00:00:02,000\nsrt'), /not a WebVTT/);
  assert.strictEqual(S.parseSubtitles(vtt).format, 'vtt');
  assert.strictEqual(S.parseSubtitles('1\n00:00:01,000 --> 00:00:02,000\nsrt').format, 'srt');
});

test('names, kinds of file and languages', () => {
  assert(S.isMedia('a.MP4') && S.isMedia('b.mkv') && S.isMedia('c.flac') && !S.isMedia('d.srt') && !S.isMedia('e'));
  assert(S.isSubtitle('x.SRT') && S.isSubtitle('y.vtt') && !S.isSubtitle('z.ass'));
  assert.strictEqual(S.defaultName('C:\\videos\\Holiday 2024.mov', '.srt'), 'Holiday 2024.srt');
  assert.strictEqual(S.defaultName('/home/a/Ünïcödé 名前.mkv', '.vtt'), 'Ünïcödé 名前.vtt');
  const list = S.languageList();
  assert.strictEqual(list[0].code, 'auto'); assert.strictEqual(list.length, 100); assert.strictEqual(new Set(list.map((l) => l.code)).size, 100);
  const T = W.loadAssets(E.modelDir());
  for (const l of list.slice(1)) assert(T.langs[l.code], 'the model knows ' + l.code);
  assert.strictEqual(T.translate, 50358, 'the translate task token'); assert.strictEqual(T.transcribe, 50359);
  const n = path.join(tmp, 'x'); fs.mkdirSync(n);
  fs.writeFileSync(path.join(n, 'Clip (subtitled).mp4'), 'x');
  assert.strictEqual(path.basename(M.freeName(n, 'Clip (subtitled)', '.mp4')), 'Clip (subtitled) (2).mp4');
  assert.strictEqual(path.basename(M.freeName(n, 'Other', '.mp4')), 'Other.mp4');
});

// ---- media and export ---------------------------------------------------------------------------------------------------------------------
let video = null;
function makeVideo() {
  if (video) return video;
  video = path.join(tmp, 'Test Clip ünï 名.mp4');
  ffmpeg(['-f', 'lavfi', '-i', 'color=c=0x336699:s=640x360:d=4:r=25', '-f', 'lavfi', '-i', 'sine=f=440:d=4', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', video]);
  return video;
}
/** One frame at `t` as raw RGB. */
function frameAt(file, t) {
  const r = spawnSync(ff, ['-hide_banner', '-v', 'error', '-ss', String(t), '-i', file, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { windowsHide: true, maxBuffer: 1 << 26 });
  assert.strictEqual(r.status, 0, String(r.stderr));
  return r.stdout;
}
/** Fraction of pixels in the bottom fifth that are near white (the subtitle text). */
function whiteBottom(buf, w = 640, h = 360) {
  let n = 0; let white = 0;
  for (let y = Math.floor(h * 0.75); y < h; y++) for (let x = 0; x < w; x++) { const i = (y * w + x) * 3; n++; if (buf[i] > 220 && buf[i + 1] > 220 && buf[i + 2] > 220) white++; }
  return white / n;
}

test('media: a video is described (size, codecs, length), music cover art is not a video, a file with no sound is refused', async () => {
  const v = makeVideo();
  const info = await M.probe(ff, v);
  assert.deepStrictEqual([info.hasVideo, info.hasAudio, info.width, info.height, info.videoCodec, info.audioCodec], [true, true, 640, 360, 'h264', 'aac']);
  near(info.duration, 4, 0.1);
  const p = M.parseProbe('Duration: 00:03:00.50, start\n  Stream #0:0: Audio: mp3, 44100 Hz, stereo\n  Stream #0:1: Video: mjpeg (Baseline), yuvj420p, 500x500, 90k tbr (attached pic)\n  Stream #0:2(eng): Subtitle: subrip');
  assert.deepStrictEqual([p.hasVideo, p.hasAudio, p.duration, p.subtitleTracks], [false, true, 180.5, 1]);
  const silentVideo = path.join(tmp, 'mute.mp4');
  ffmpeg(['-f', 'lavfi', '-i', 'color=c=black:s=160x90:d=1', '-c:v', 'libx264', '-preset', 'ultrafast', silentVideo]);
  await assert.rejects(M.probe(ff, silentVideo), /no sound/);
  const junk = path.join(tmp, 'junk.mp4'); fs.writeFileSync(junk, Buffer.alloc(3000, 7));
  await assert.rejects(M.probe(ff, junk), /could not be read/);
});

test('burn: the subtitles really appear in the picture while they are on, and not before; the original is untouched', async () => {
  const v = makeVideo();
  const before = fs.readFileSync(v);
  const info = await M.probe(ff, v);
  const out = path.join(tmp, 'Burnt (subtitled).mp4');
  const seen = [];
  const r = await M.exportVideo({ ffmpeg: ff, input: v, output: out, mode: 'burn', info, style: { size: 'large' }, language: 'en', cues: [{ start: 2, end: 3.6, text: 'Burnt in — ça marche!\nÜnïcödé line two' }], onProgress: (p) => seen.push(p.fraction) });
  assert.strictEqual(r.path, out);
  assert(!fs.existsSync(out + '.part'), 'no part file left');
  assert(seen.length && seen[seen.length - 1] === 1, 'progress reached 100%');
  const o = await M.probe(ff, out);
  assert.deepStrictEqual([o.videoCodec, o.hasAudio, o.width, o.subtitleTracks], ['h264', true, 640, 0]);
  near(o.duration, 4, 0.15);
  const off = whiteBottom(frameAt(out, 1.0)); const on = whiteBottom(frameAt(out, 2.8));
  assert(off < 0.001, 'no text before the cue: ' + off);
  assert(on > 0.01, 'white text in the bottom of the picture during the cue: ' + on);
  assert(before.equals(fs.readFileSync(v)), 'the original is unchanged');
});

test('burn: works with no system fonts at all (the bundled font is used), and a box style', async () => {
  const conf = path.join(tmp, 'empty-fonts.conf');
  fs.writeFileSync(conf, `<?xml version="1.0"?>\n<!DOCTYPE fontconfig SYSTEM "fonts.dtd">\n<fontconfig><cachedir>${tmp.replace(/\\/g, '/')}/fc</cachedir></fontconfig>\n`);
  const old = process.env.FONTCONFIG_FILE;
  process.env.FONTCONFIG_FILE = conf;
  try {
    const v = makeVideo();
    const out = path.join(tmp, 'nofonts.mp4');
    await M.exportVideo({ ffmpeg: ff, input: v, output: out, mode: 'burn', info: await M.probe(ff, v), style: { size: 'medium', box: true }, cues: [{ start: 0.5, end: 3, text: 'Still readable' }] });
    assert(whiteBottom(frameAt(out, 1.5)) > 0.004, 'text drawn with the bundled font');
  } finally { if (old === undefined) delete process.env.FONTCONFIG_FILE; else process.env.FONTCONFIG_FILE = old; }
  assert(M.fontFiles().length === 2, 'both font files are bundled');
  assert(/FontName=DejaVu Sans/.test(M.forceStyle()) && /BorderStyle=3/.test(M.forceStyle({ box: true })));
});

test('soft track: the MP4 gets a mov_text subtitle track with the language, the picture is copied as it is, and the text reads back', async () => {
  const v = makeVideo();
  const out = path.join(tmp, 'soft.mp4');
  const cues = [{ start: 0.5, end: 1.5, text: 'Première ligne' }, { start: 2, end: 3.5, text: 'Two\nlines 日本' }];
  await M.exportVideo({ ffmpeg: ff, input: v, output: out, mode: 'soft', info: await M.probe(ff, v), cues, language: 'fr' });
  const desc = spawnSync(ff, ['-hide_banner', '-i', out], { encoding: 'utf8' }).stderr;
  assert(/Stream #0:2(?:\[[^\]]*\])?\(fre\): Subtitle: mov_text/.test(desc), desc);
  const srt = ffmpeg(['-i', out, '-map', '0:s:0', '-f', 'srt', '-']).stdout.toString('utf8');
  assert.deepStrictEqual(S.parseSrt(srt).map((c) => [c.start, c.end, c.text]), cues.map((c) => [c.start, c.end, c.text]));
  const args = M.exportArgs({ mode: 'soft', input: 'in', output: 'out', info: { videoCodec: 'h264', audioCodec: 'vorbis' }, language: 'en' });
  assert(args.join(' ').includes('-c:v copy') && args.join(' ').includes('-c:a aac'), 'an MP4 cannot hold Vorbis: the sound is re-encoded, the picture copied');
  const args2 = M.exportArgs({ mode: 'soft', input: 'in', output: 'out', info: { videoCodec: 'wmv2', audioCodec: 'aac' }, language: 'xx' });
  assert(args2.join(' ').includes('-c:v libx264') && !args2.includes('-metadata:s:s:0'));
});

test('export: cancel stops ffmpeg and leaves no file; an audio-only file, no text and replacing the original are refused', async () => {
  const long = path.join(tmp, 'long.mp4');
  ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=s=1280x720:d=60:r=30', '-f', 'lavfi', '-i', 'sine=d=60', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-shortest', long]);
  const info = await M.probe(ff, long);
  const out = path.join(tmp, 'cancelled.mp4');
  const ac = new AbortController();
  let at = 0;
  const p = M.exportVideo({ ffmpeg: ff, input: long, output: out, mode: 'burn', info, cues: [{ start: 1, end: 50, text: 'x' }], signal: ac.signal, onProgress: (q) => { if (q.fraction > 0.02 && !at) { at = Date.now(); ac.abort(); } } });
  await assert.rejects(p, (e) => e.cancelled === true);
  assert(Date.now() - at < 3000, 'stopped at once: ' + (Date.now() - at) + ' ms');
  assert(!fs.existsSync(out) && !fs.existsSync(out + '.part'), 'nothing left behind');
  await assert.rejects(M.exportVideo({ ffmpeg: ff, input: long, output: out, mode: 'burn', info: { ...info, hasVideo: false }, cues: [{ start: 1, end: 2, text: 'x' }] }), /no picture/);
  await assert.rejects(M.exportVideo({ ffmpeg: ff, input: long, output: out, mode: 'burn', info, cues: [{ start: 1, end: 2, text: ' ' }] }), /no subtitles/);
  await assert.rejects(M.exportVideo({ ffmpeg: ff, input: long, output: long, mode: 'soft', info, cues: [{ start: 1, end: 2, text: 'x' }] }), /cannot replace the original/);
});

// ---- the pipeline with a fake engine ---------------------------------------------------------------------------------------------------------
test('pipeline (fake engine): the sound of a video is read at 16 kHz and handed to the engine; its segments become rule-keeping cues', async () => {
  const v = makeVideo();
  const got = {};
  const fake = {
    async transcribe(samples, o) {
      got.samples = samples.length; got.language = o.language; got.task = o.task;
      const segs = [sentence('This is a fake engine speaking in a test.', 0.4, 3), sentence('It never listens, it only pretends.', 2.6, 3.5)];
      o.onSegments(segs.slice(0, 1)); o.onProgress({ fraction: 1 });
      return { language: 'en', segments: segs };
    },
  };
  const phases = [];
  const r = await E.listen(fake, v, { language: 'de', task: 'translate', onPhase: (p) => phases.push(p), onSegments: () => {}, onProgress: () => {} });
  near(got.samples, 64000, 400, 'four seconds at 16 kHz'); assert.strictEqual(got.language, 'de'); assert.strictEqual(got.task, 'translate');
  assert.deepStrictEqual(phases, ['reading', 'working']);
  const cues = S.buildCues(r.segments, { language: r.language });
  checkRules(cues);
  assert.deepStrictEqual(cues.map((c) => c.text.replace(/\n/g, ' ')), ['This is a fake engine speaking in a test.', 'It never listens, it only pretends.']);
  const ac = new AbortController(); ac.abort();
  await assert.rejects(E.listen(fake, v, { signal: ac.signal }), (e) => e.cancelled === true);
});

// ---- the real model ----------------------------------------------------------------------------------------------------------------------------
let engine = null;
const getEngine = async () => engine || (engine = await E.createEngine());

test('model: the real model starts, silence is skipped quickly, unknown languages and tasks are refused', async () => {
  const eng = await getEngine();
  const t0 = Date.now();
  const r = await eng.transcribe(new Float32Array(16000 * 40), { language: 'auto' });
  assert.strictEqual(r.segments.length, 0);
  assert(Date.now() - t0 < 3000, 'silence takes no model time');
  await assert.rejects(eng.transcribe(new Float32Array(16000 * 5).fill(0.1), { language: 'xx' }), /Unknown language/);
  await assert.rejects(eng.transcribe(new Float32Array(16000 * 5).fill(0.1), { language: 'en', task: 'summarise' }), /Unknown task/);
});

test('model: spoken sentences in a video become correct subtitles, at the right times, keeping the rules (spoken test voices)', skipUnlessSpeech(async () => {
  const eng = await getEngine();
  const at = [1.0, 9.0, 17.0];
  const clip = await SP.makeClip(SP.SENTENCES.slice(0, 3).map((text, i) => ({ text, at: at[i], voice: i % 2 ? 'Microsoft Zira Desktop' : 'Microsoft David Desktop' })), 26, path.join(tmp, 'speech.wav'));
  const vid = path.join(tmp, 'spoken.mp4');
  ffmpeg(['-f', 'lavfi', '-i', 'color=c=black:s=320x180:d=26:r=10', '-i', clip.file, '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-shortest', vid]);
  const t0 = Date.now();
  const r = await E.listen(eng, vid, { language: 'auto' });
  const cues = S.buildCues(r.segments, { language: r.language });
  const heard = cues.map((c) => c.text.replace(/\n/g, ' ')).join(' ');
  const wer = SP.wordErrorRate(SP.SENTENCES.slice(0, 3).join(' '), heard);
  console.log(`     heard (${((Date.now() - t0) / 1000).toFixed(1)} s, WER ${wer.toFixed(2)}): ${heard}`);
  assert.strictEqual(r.language, 'en');
  assert(wer <= 0.2, `word error rate ${wer.toFixed(2)}`);
  checkRules(cues);
  near(cues[0].start, at[0], 0.6, 'first subtitle starts with the speech');
  const second = cues.find((c) => /walked/i.test(c.text)); assert(second, 'second sentence found'); near(second.start, at[1], 0.6, 'second sentence');
  const third = cues.find((c) => /hold on|little/i.test(c.text)); assert(third, 'third sentence found'); near(third.start, at[2], 0.6, 'third sentence');
  for (const c of cues) assert(c.start >= 0.5 && c.end <= 26.01, 'inside the clip');
  for (const c of cues) assert(S.cps(c) <= 25, 'readable speed: ' + S.cps(c));
}));

test('model: "Translate to English" turns German speech into English subtitles (Whisper\'s translate task)', skipUnlessEspeak(async () => {
  const eng = await getEngine();
  const clip = await SP.makeClip([{ text: 'Guten Morgen. Das Wetter ist heute sehr schön, und wir gehen in den Park.', at: 1, voice: 'espeak:de' }], 12, path.join(tmp, 'german.wav'));
  const plain = await eng.transcribe(clip.samples.slice(), { language: 'auto' });
  const de = plain.segments.map((s) => s.text).join(' ');
  const tr = await eng.transcribe(clip.samples.slice(), { language: 'auto', task: 'translate' });
  const en = tr.segments.map((s) => s.text).join(' ');
  console.log(`     transcribed (${plain.language}): ${de}\n     translated: ${en}`);
  assert.strictEqual(plain.language, 'de');
  assert(/\b(Morgen|Wetter|Park)\b/i.test(de), 'German words written down');
  assert(/\b(morning|weather|park|today|beautiful|nice)\b/i.test(en) && !/\bWetter\b/.test(en), 'English words in the translation');
  assert(S.buildCues(tr.segments).length >= 1);
}));

test('model: cancelling in the middle stops quickly and the engine keeps working', skipUnlessSpeech(async () => {
  const eng = await getEngine();
  const clip = await SP.makeClip(SP.SENTENCES.map((text, i) => ({ text, at: 1 + i * 11 })), 50, path.join(tmp, 'cancel.wav'));
  const ac = new AbortController();
  const p = eng.transcribe(clip.samples.slice(), { signal: ac.signal, onProgress: (q) => { if (q.fraction > 0.05) ac.abort(); } });
  const t0 = Date.now();
  await assert.rejects(p, (e) => e.cancelled === true);
  assert(Date.now() - t0 < 15000, 'stopped within seconds');
  const r = await eng.transcribe(new Float32Array(16000 * 3), {});
  assert.deepStrictEqual(r.segments, []);
}));

test('ui: the window code has no remote content and a strict content security policy', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'index.html'), 'utf8');
  assert(/default-src 'none'/.test(html) && /script-src 'self'/.test(html));
  assert(!/https?:\/\//.test(html.replace(/<meta[^>]*Content-Security-Policy[^>]*>/, '')));
  const js = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'app.js'), 'utf8');
  assert(!/https?:\/\/|eval\(|new Function/.test(js));
});

(async () => {
  let failed = 0;
  for (const [name, fn] of tests) {
    if (process.env.ONLY && !new RegExp(process.env.ONLY, 'i').test(name)) continue;
    const t0 = Date.now();
    try { await fn(); console.log(`ok   ${name} (${Date.now() - t0} ms)`); }
    catch (e) { failed++; console.log(`FAIL ${name}\n     ${String((e && e.stack) || e).split('\n').slice(0, 6).join('\n     ')}`); }
  }
  if (engine) { try { await engine.release(); } catch { /* ignore */ } }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  console.log(failed ? `\n${failed} of ${tests.length} failed` : `\nall ${tests.length} passed`);
  process.exit(failed ? 1 : 0);
})();
