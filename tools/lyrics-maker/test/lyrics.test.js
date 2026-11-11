'use strict';
// Lyrics Maker core tests. The audio front end, the decoding rules, the word timing maths and the lyric lines are checked
// exactly with small known inputs. The real Whisper model is then run on SPOKEN test clips (made with the voices that ship with
// Windows, or espeak-ng where it is installed; otherwise those tests are skipped) whose words and timing are known, and on silence. How it does on real
// singing over a band is NOT claimed here.
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Mel = require('../src/mel');
const W = require('../src/whisper');
const P = require('../src/plan');
const A = require('../src/audio');
const E = require('../src/engine');
const SP = require('../src/speech');
const M = require('../src/models');
const http = require('http');

const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const skipUnlessSpeech = (fn) => async () => { if (!SP.available()) { console.log('     (skipped: needs the Windows speech voices or espeak-ng)'); return; } await fn(); };
const near = (a, b, tol, msg) => assert(Math.abs(a - b) <= tol, `${msg || ''} expected ${b} +/- ${tol}, got ${a}`);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lyrics-test-'));
const modelDir = E.modelDir();
let assets = null;
const T = () => assets || (assets = W.loadAssets(modelDir));

// ---- the audio front end ----------------------------------------------------------------------------------------------------------
test('mel: the filter bank has 80 area-normalised triangles that climb with frequency (Slaney scale)', () => {
  const { bands, edges } = Mel.tables();
  assert.strictEqual(bands.length, 80);
  near(Mel.hzToMel(1000), 15, 1e-9, '1 kHz is mel 15'); near(Mel.melToHz(Mel.hzToMel(4321)), 4321, 1e-6, 'round trip'); near(Mel.hzToMel(100), 1.5, 1e-9, 'linear below 1 kHz');
  near(edges[0], 0, 1e-9); near(edges[81], 8000, 1e-6);
  for (let i = 1; i < edges.length; i++) assert(edges[i] > edges[i - 1], 'edges increase');
  const df = Mel.SAMPLE_RATE / Mel.N_FFT;
  for (let m = 0; m < 80; m++) {
    const area = bands[m].w.reduce((s, v) => s + v, 0) * df;                       // area-normalised: each triangle integrates to about 1
    assert(area > 0.85 && area < 1.15, `band ${m} area ${area.toFixed(3)}`);
  }
  assert(bands[79].first > bands[40].first && bands[40].first > bands[0].first);
});

test('mel: a pure tone lights the right band, silence is flat, and the values sit in the range the model expects', () => {
  const tone = new Float32Array(Mel.SAMPLE_RATE * 5);
  for (let i = 0; i < tone.length; i++) tone[i] = 0.5 * Math.sin((2 * Math.PI * 1000 * i) / Mel.SAMPLE_RATE);
  const m = Mel.logMel(tone, 0);
  assert.strictEqual(m.length, 80 * 3000);
  const { edges } = Mel.tables();
  let best = 0; let bv = -Infinity;
  for (let b = 0; b < 80; b++) if (m[b * 3000 + 100] > bv) { bv = m[b * 3000 + 100]; best = b; }
  const centre = edges[best + 1];
  assert(Math.abs(centre - 1000) < 60, `the loudest band is centred at ${centre.toFixed(0)} Hz`);
  let lo = Infinity; let hi = -Infinity;
  for (const v of m) { if (v < lo) lo = v; if (v > hi) hi = v; }
  assert(hi - lo <= 2 + 1e-5 && hi <= 1.6 && lo >= -1.2, `range ${lo.toFixed(2)}..${hi.toFixed(2)} (log10 clamped 8 below the peak, then (x+4)/4)`);
  const after = m[best * 3000 + 2000];            // the clip is 5 s long: the rest of the 30 s window is padding, which is silent
  assert(after < bv - 0.5, 'padding is quieter than the tone');
  const silent = Mel.logMel(new Float32Array(Mel.SAMPLE_RATE * 3), 0);
  assert(silent.every((v) => Math.abs(v - silent[0]) < 1e-6), 'silence is the same everywhere');
  near(silent[0], (-10 + 4) / 4, 1e-6, 'the floor of silence');
});

test('mel: a window that starts later in a song uses the right part of the audio', () => {
  const x = new Float32Array(Mel.SAMPLE_RATE * 40);
  for (let i = Mel.SAMPLE_RATE * 30; i < x.length; i++) x[i] = 0.4 * Math.sin((2 * Math.PI * 2000 * i) / Mel.SAMPLE_RATE);
  const a = Mel.logMel(x, 0); const b = Mel.logMel(x, Mel.SAMPLE_RATE * 30);
  const bandAt = (m, t) => { let best = 0; let v = -Infinity; for (let k = 0; k < 80; k++) if (m[k * 3000 + t] > v) { v = m[k * 3000 + t]; best = k; } return v; };
  assert(bandAt(b, 100) > bandAt(a, 100) + 0.3, 'the second window hears the tone, the first only silence');
});

// ---- the model's files and tokens --------------------------------------------------------------------------------------------------
test('files: the model on disk is the pinned one (every size and SHA-256), so a damaged or swapped file is caught', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'fetch-model.js'), 'utf8');
  const entries = [...src.matchAll(/file: '([^']+)', remote: '[^']+', bytes: (\d+), sha256: '([0-9a-f]{64})'/g)];
  assert.strictEqual(entries.length, E.MODEL_FILES.length);
  for (const [, file, bytes, sha] of entries) {
    const f = path.join(modelDir, file);
    assert(fs.existsSync(f), file + ' is missing - run npm run setup');
    assert.strictEqual(fs.statSync(f).size, Number(bytes), file + ' size');
    assert.strictEqual(crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex'), sha, file + ' checksum');
  }
});

test('tokens: special token ids, the 99 languages and the suppressed tokens are read from the model files', () => {
  const t = T();
  assert.strictEqual(t.eot, 50257); assert.strictEqual(t.sot, 50258); assert.strictEqual(t.transcribe, 50359);
  assert.strictEqual(t.noTimestamps, 50363); assert.strictEqual(t.timestampBegin, 50364); assert.strictEqual(t.langs.en, 50259);
  assert.strictEqual(Object.keys(t.langs).length, 99);
  assert.strictEqual(t.alignmentHeads.length, 10);
  assert(t.suppress.length > 80 && t.suppress.includes(50362) && t.beginSuppress.includes(220));
  // every language the model has is in the window's list, and the list has no extras
  assert.deepStrictEqual(Object.keys(t.langs).sort(), Object.keys(P.LANGUAGES).sort());
});

test('tokens: text pieces join back into words, including characters split across several tokens', () => {
  const t = T();
  const vocab = JSON.parse(fs.readFileSync(path.join(modelDir, 'tokenizer.json'), 'utf8')).model.vocab;
  assert.strictEqual(W.detokenize(t, [vocab['Hello'], vocab['\u0120world'], vocab['!']]), 'Hello world!');
  assert.strictEqual(W.detokenize(t, [t.sot, vocab['\u0120hi'], t.timestampBegin + 12, t.eot]), 'hi', 'special and timestamp tokens are skipped');
  // "é" is the two bytes C3 A9: written as the byte-level characters "Ã" and "©", they may arrive as two tokens
  const a = vocab['\u00c3']; const b = vocab['\u00a9'];
  if (a != null && b != null) assert.strictEqual(W.detokenize(t, [a, b]), '\u00e9');
});

// ---- the decoding rules ---------------------------------------------------------------------------------------------------------------
const flat = () => new Float32Array(51865).fill(0);
const finite = (l, from, to) => { let n = 0; for (let i = from; i < to; i++) if (l[i] > -Infinity) n++; return n; };

test('rules: a window must open with a timestamp, not later than a second in, and never with blank or end', () => {
  const t = T(); const l = flat(); l[t.eot] = 99; l[220] = 99; l[t.timestampBegin + 400] = 99;
  W.applyRules(l, [], t);
  assert.strictEqual(finite(l, 0, t.timestampBegin), 0, 'no text first');
  assert.strictEqual(finite(l, t.timestampBegin + t.maxInitialTimestamp + 1, 51865), 0, 'no late start');
  assert(finite(l, t.timestampBegin, t.timestampBegin + t.maxInitialTimestamp + 1) === t.maxInitialTimestamp + 1);
});

test('rules: timestamps come in pairs: after one, only a timestamp (or the end); after a pair, only text', () => {
  const t = T(); const tb = t.timestampBegin;
  let l = flat(); l[t.eot] = 20; W.applyRules(l, [tb + 10, 500, tb + 60], t);  // a segment's text, then its closing timestamp is open (and the end is likely) ...
  assert.strictEqual(finite(l, 0, t.eot), 0, '... so no text while a timestamp is open');
  assert(l[t.eot] > -Infinity && finite(l, tb, 51865) > 0, 'a timestamp or the end');
  l = flat(); W.applyRules(l, [tb + 10], t);                                  // the opening timestamp has just been written: text must follow
  assert.strictEqual(finite(l, tb, 51865), 0, 'no second timestamp straight after the opening one');
  assert(finite(l, 0, t.eot) > 0, 'text follows');
  l = flat(); W.applyRules(l, [tb + 10, 500, tb + 80, tb + 80], t);          // a closed pair, then another timestamp
  assert.strictEqual(finite(l, tb, 51865), 0, 'after a complete pair no more timestamps');
  l = flat(); l[600] = 30; W.applyRules(l, [tb + 10, 500, 501], t);          // plain text in the middle, with a clearly likely next word
  assert(l[600] > -Infinity, 'text may go on');
});

test('rules: time never goes backwards, and special tokens are never chosen', () => {
  const t = T(); const tb = t.timestampBegin;
  let l = flat(); W.applyRules(l, [tb + 100, 500, tb + 200, 501], t);        // the last stamp was 200 (a pair is complete, text follows)
  assert.strictEqual(finite(l, tb, tb + 201), 0, 'no timestamp earlier than or equal to the last');
  assert(l[tb + 201] > -Infinity || l[500] > -Infinity);
  l = flat(); W.applyRules(l, [tb + 100, 500, tb + 200], t);                 // an open stamp at 200: the closing one may be 200 or later
  assert(l[tb + 200] > -Infinity && l[tb + 199] === -Infinity);
  l = flat(); for (const id of [t.noTimestamps, 50362, 50358, 50359, 50360, 50361]) l[id] = 50;
  W.applyRules(l, [tb + 1, 500], t);
  for (const id of [t.noTimestamps, 50362, 50358, 50359, 50360, 50361]) assert.strictEqual(l[id], -Infinity, 'token ' + id + ' is suppressed');
});

test('rules: when the timestamps together are likelier than any one piece of text, a timestamp is forced', () => {
  const t = T(); const tb = t.timestampBegin;
  const l = flat(); l[600] = 5;                                              // one text token a little likely ...
  for (let i = 0; i < 1500; i++) l[tb + i] = 3;                              // ... but 1500 timestamps together beat it
  W.applyRules(l, [tb + 1, 600, tb + 50, 601], t);
  assert.strictEqual(finite(l, 0, tb), 0, 'text is out');
  const l2 = flat(); l2[600] = 20; l2[tb + 300] = 0;
  W.applyRules(l2, [tb + 1, 600, tb + 50, 601], t);
  assert(l2[600] > -Infinity, 'a clearly likelier piece of text stays');
});

test('segments: a window is cut into timed segments at its timestamp pairs, and the next window starts where the speech stopped', () => {
  const t = T(); const tb = t.timestampBegin; const ts = (s) => tb + Math.round(s / 0.02);
  const toks = [ts(0), 500, 501, ts(3), ts(3.5), 502, 503, ts(7), ts(7), 504, ts(9.2)];
  let r = W.parseSegments(toks, 60, 30, 3000, t);
  assert.strictEqual(r.segments.length, 3);
  near(r.segments[0].start, 60, 1e-9); near(r.segments[0].end, 63, 1e-9); near(r.segments[1].start, 63.5, 1e-9); near(r.segments[1].end, 67, 1e-9);
  near(r.segments[2].start, 67, 1e-9); near(r.segments[2].end, 69.2, 1e-9);
  assert.strictEqual(r.advance, 3000, 'the window ended on a single timestamp: it is used up');
  r = W.parseSegments([ts(0), 500, ts(4), ts(4), 501, ts(8), ts(8)], 0, 30, 3000, t);
  assert.strictEqual(r.segments.length, 2); assert.strictEqual(r.advance, 800, 'moves on to the last timestamp: 8 s = 800 frames of 10 ms');
  r = W.parseSegments([ts(0), 500, 501, ts(5)], 10, 30, 3000, t);           // no pairs: one segment up to the last timestamp
  assert.strictEqual(r.segments.length, 1); near(r.segments[0].end, 15, 1e-9);
  r = W.parseSegments([500, 501, 502], 0, 12, 1200, t);                      // no timestamps at all: the whole window
  near(r.segments[0].end, 12, 1e-9); assert.strictEqual(r.advance, 1200);
  r = W.parseSegments([ts(0), 500, ts(0.4), ts(0.4), 501, ts(0.6)], 0, 30, 3000, t);
  assert(r.advance >= 50, 'always moves forward at least half a second');
});

test('segments: repeated lines are trimmed (a loop of the same line is a failure, a repeated hook is not), silence and loops are recognised', () => {
  const mk = (txt, n) => Array.from({ length: n }, (_, i) => ({ start: i, end: i + 1, text: txt }));
  assert.strictEqual(W.dropLoops(mk('Thank you.', 9)).length, 2);
  assert.strictEqual(W.dropLoops([...mk('Hey hey', 2), { start: 5, end: 6, text: 'Something else' }, ...mk('Hey hey', 2)]).length, 5);
  const stutter = [{ start: 13, end: 17, text: 'singing songs we used to know.' }, { start: 17, end: 17.5, text: 'to know.' }, { start: 26, end: 28, text: 'Hold on.' }];
  assert.deepStrictEqual(W.dropLoops(stutter).map((x) => x.text), ['singing songs we used to know.', 'Hold on.'], 'a repeated sentence end is a stutter');
  assert.strictEqual(W.dropLoops([{ start: 0, end: 2, text: 'we used to know' }, { start: 5, end: 6, text: 'to know' }]).length, 2, 'an echo sung later is kept');
  assert(W.compressionRatio('la la la la la la la la la la la la la la la la la la la la la la la la') > 3.5);
  assert(W.compressionRatio('The river runs down to the sea and the morning light is warm') < 2);
  assert.strictEqual(W.compressionRatio(''), 0);
  assert.strictEqual(W.isSilent(new Float32Array(16000 * 5)), true);
  assert.strictEqual(W.isSilent(new Float32Array(16000 * 5).fill(0.0001)), true);
  const loud = new Float32Array(16000 * 5); for (let i = 0; i < loud.length; i++) loud[i] = 0.2 * Math.sin(i * 0.05);
  assert.strictEqual(W.isSilent(loud), false);
});

// ---- word timing -------------------------------------------------------------------------------------------------------------------------
test('timing: the median filter smooths spikes and keeps the length', () => {
  const row = Float32Array.from([0, 0, 9, 0, 0, 0, 0, 5, 5, 5, 5, 5]);
  const out = W.medianFilter(row, 7);
  assert.strictEqual(out.length, row.length); assert.strictEqual(out[2], 0, 'a single spike is removed'); assert.strictEqual(out[9], 5);
});

test('timing: dynamic time warping follows a diagonal ridge, steps through rows in order, and jump times say when each row begins', () => {
  const rows = 6; const cols = 30;
  const cost = new Float32Array(rows * cols).fill(1);
  for (let r = 0; r < rows; r++) for (let c = r * 5; c < r * 5 + 5; c++) cost[r * cols + c] = -1;   // row r is "active" in columns 5r .. 5r+4
  const path = W.dtw(cost, rows, cols);
  assert.strictEqual(path.text[0], 0); assert.strictEqual(path.time[0], 0);
  assert.strictEqual(path.text[path.text.length - 1], rows - 1); assert.strictEqual(path.time[path.time.length - 1], cols - 1);
  for (let k = 1; k < path.text.length; k++) { assert(path.text[k] >= path.text[k - 1] && path.time[k] >= path.time[k - 1]); assert(path.text[k] - path.text[k - 1] <= 1 && path.time[k] - path.time[k - 1] <= 1); }
  const jt = W.jumpTimes(path, 1);
  assert.strictEqual(jt.length, rows);
  assert.deepStrictEqual(jt, [0, 5, 10, 15, 20, 25]);
});

test('timing: tokens are grouped into words at the spaces (and character by character for languages written without spaces)', () => {
  const t = T();
  const vocab = JSON.parse(fs.readFileSync(path.join(modelDir, 'tokenizer.json'), 'utf8')).model.vocab;
  const ids = [vocab['Hello'], vocab[','], vocab['\u0120world'], vocab['\u0120again'], vocab['!']];
  const words = W.splitWords(t, ids, 'en');
  assert.deepStrictEqual(words.map((w) => w.text), ['Hello,', 'world', 'again!']);
  assert.deepStrictEqual(words.map((w) => [w.first, w.last]), [[0, 1], [2, 2], [3, 4]]);
  const cn = W.splitWords(t, [vocab['\u0120the'], vocab['\u0120of']], 'zh');
  assert(cn.length >= 1);
});

test('timing: a pause before a line is cut off using the real silence in the audio, and a word that swallowed a pause is trimmed', () => {
  const sr = 16000; const x = new Float32Array(sr * 12);
  for (let i = sr * 8; i < sr * 8.4; i++) x[i] = 0.3 * Math.sin(i * 0.2);                      // a 0.4 s word at 8.0 s, silence around it
  near(W.quietOnset(x, sr, 0, 8.6), 8.0, 0.1, 'onset found');
  near(W.quietOffset(x, sr, 7.8, 12), 8.4, 0.15, 'offset found');
  assert.strictEqual(W.quietOnset(x, sr, 7.99, 8.4), null, 'no quiet prefix = nothing to correct');
  const busy = new Float32Array(sr * 12); for (let i = 0; i < busy.length; i++) busy[i] = 0.2 * Math.sin(i * 0.05);   // music all the time
  assert.strictEqual(W.quietOnset(busy, sr, 0, 8), null, 'continuous sound is not a pause');
  const words = [{ text: 'The', start: 0, end: 8.22 }, { text: 'river', start: 8.22, end: 8.5 }];
  W.trimEdges(words, x, sr, 0.25);
  near(words[0].start, 8.0, 0.1, 'first word starts at the sound');
  const noisy = [{ text: 'Oh', start: 0, end: 9 }, { text: 'no', start: 9, end: 9.3 }];
  W.trimEdges(noisy, busy, sr, 0.25);
  near(noisy[0].start, 9 - 0.8, 1e-6, 'with music under it, an implausibly long first word is trimmed to a plausible length');
});

// ---- lyric lines ------------------------------------------------------------------------------------------------------------------------------
test('lines: a long segment is cut where the singer pauses, at punctuation, or when it gets too long', () => {
  const w = (text, start, end) => ({ text, start, end });
  const seg = { start: 10, end: 20, text: '', words: [w('We', 10, 10.3), w('walked', 10.3, 10.8), w('all', 10.8, 11), w('night,', 11, 11.6), w('through', 11.7, 12), w('the', 12, 12.1), w('empty', 12.1, 12.5), w('streets', 12.5, 13), w('and', 15, 15.2), w('then', 15.2, 15.5), w('we', 15.5, 15.6), w('sang', 15.6, 16)] };
  const lines = P.buildLines([seg]);
  assert.deepStrictEqual(lines.map((l) => l.text), ['We walked all night,', 'through the empty streets', 'and then we sang']);
  assert.deepStrictEqual(lines.map((l) => l.start), [10, 11.7, 15]);
  const long = { start: 0, end: 9, text: '', words: Array.from({ length: 30 }, (_, i) => w('word' + i, i * 0.3, i * 0.3 + 0.25)) };
  const cut = P.buildLines([long], { maxChars: 40 });
  assert(cut.length >= 5 && cut.every((l) => l.text.length <= 44), 'long lines are cut: ' + cut.map((l) => l.text.length));
  const sung = { start: 0, end: 6, text: '', words: 'We walked all night through the empty streets, singing songs we used to know.'.split(' ').map((x, i) => w(x, i * 0.4, i * 0.4 + 0.35)) };
  assert.deepStrictEqual(P.buildLines([sung]).map((l) => l.text), ['We walked all night through the empty streets,', 'singing songs we used to know.'], 'a word that finishes a phrase may run a few characters over the limit');
  assert.deepStrictEqual(P.buildLines([{ start: 3, end: 5, text: ' Just a line ' }]), [{ start: 3, end: 5, text: 'Just a line' }], 'a segment without word times stays whole');
  const cn = P.buildLines([{ start: 0, end: 2, text: '', words: [w('\u4f60', 0, 0.3), w('\u597d', 0.3, 0.6)] }], { spaced: false });
  assert.strictEqual(cn[0].text, '\u4f60\u597d');
  const odd = P.buildLines([{ start: 5, end: 6, text: 'later', words: [w('later', 5, 6)] }, { start: 2, end: 3, text: 'earlier', words: [w('earlier', 2, 3)] }]);
  assert(odd[1].start >= odd[0].start, 'lines never start before the one above');
});

test('lines: music symbols and labels recognisers add are removed, and a line with no words disappears', () => {
  assert.strictEqual(P.cleanText('\u266a Hold on \u266a'), 'Hold on');
  assert.strictEqual(P.cleanText('[Music] la la'), 'la la');
  assert.strictEqual(P.cleanText('(applause)'), '');
  assert.strictEqual(P.cleanText('\u266a\u266a'), '');
  assert.strictEqual(P.cleanText('  spaced   out  '), 'spaced out');
  assert.strictEqual(P.cleanText('\u00bfD\u00f3nde est\u00e1s?'), '\u00bfD\u00f3nde est\u00e1s?');
  assert.strictEqual(P.buildLines([{ start: 0, end: 5, text: '\u266a' }]).length, 0);
});

test('lrc: times are written as [mm:ss.xx] with the carry done right, sorted, and read back exactly', () => {
  assert.strictEqual(P.lrcStamp(0), '[00:00.00]'); assert.strictEqual(P.lrcStamp(65.4), '[01:05.40]'); assert.strictEqual(P.lrcStamp(59.996), '[01:00.00]');
  assert.strictEqual(P.lrcStamp(3599.999), '[60:00.00]'); assert.strictEqual(P.lrcStamp(-4), '[00:00.00]');
  const lines = [{ start: 12.34, text: 'second' }, { start: 1, text: 'first' }, { start: 20, text: '   ' }, { start: 20.005, text: 'last\nline' }];
  const lrc = P.formatLrc(lines);
  assert.strictEqual(lrc, '[00:01.00]first\r\n[00:12.34]second\r\n[00:20.01]last line\r\n');
  assert.deepStrictEqual(P.parseLrc(lrc), [{ start: 1, text: 'first' }, { start: 12.34, text: 'second' }, { start: 20.01, text: 'last line' }]);
  assert.strictEqual(P.formatLrc([]), '');
  const other = '\uFEFF[ar:Someone]\r\n[ti:Song]\r\n[00:05.5][01:00.00]repeat me\r\n[00:07]no hundredths\r\nplain line\r\n[00:09.123]three digits\r\n';
  assert.deepStrictEqual(P.parseLrc(other), [{ start: 5.5, text: 'repeat me' }, { start: 7, text: 'no hundredths' }, { start: 9.12, text: 'three digits' }, { start: 60, text: 'repeat me' }]);
  assert.strictEqual(P.formatPlain([{ start: 2, text: 'a' }, { start: 1, text: ' ' }, { start: 3, text: 'b' }]), 'a\r\nb\r\n');
});

test('lines: every line keeps the time of each of its words, and a cleaned-away label does not leave a stray word', () => {
  const w = (text, start, end) => ({ text, start, end });
  const lines = P.buildLines([{ start: 10, end: 14, text: '', words: [w('We', 10, 10.3), w('walked', 10.3, 10.8), w('all', 10.8, 11), w('night,', 11, 11.6), w('and', 13, 13.2), w('sang', 13.2, 13.9)] }]);
  assert.deepStrictEqual(lines.map((l) => l.words.map((x) => x.text).join(' ')), lines.map((l) => l.text), 'the words spell the line');
  assert.deepStrictEqual(lines[0].words[1], { text: 'walked', start: 10.3, end: 10.8 });
  assert.strictEqual(lines[1].end, 13.9);
  const music = P.buildLines([{ start: 0, end: 3, text: '', words: [w('♪', 0, 0.5), w('Hold', 0.5, 1), w('on', 1, 1.4)] }]);
  assert.deepStrictEqual(music[0].words.map((x) => x.text), ['Hold', 'on']);
  const shifted = P.shiftLines(lines, 0.25);
  assert.deepStrictEqual(shifted[0].words[1], { text: 'walked', start: 10.55, end: 11.05 }, 'shifting moves the words too');
  assert.deepStrictEqual(P.shiftLines([{ start: 0.1, text: 'a', words: [w('a', 0.1, 0.3)] }], -1)[0].words[0], { text: 'a', start: 0, end: 0 }, 'never before 0');
  assert.strictEqual(P.currentWord(lines[0].words, 10.5), 1); assert.strictEqual(P.currentWord(lines[0].words, 9), -1); assert.strictEqual(P.currentWord(lines[0].words, 99), 3); assert.strictEqual(P.currentWord(undefined, 1), -1);
});

test('words: a changed line keeps word times when the words still line up, and shares its time out by length when they do not', () => {
  const line = { start: 2, end: 4, text: 'Hello big world', words: [{ text: 'Hello', start: 2, end: 2.6 }, { text: 'big', start: 2.7, end: 3 }, { text: 'world', start: 3.1, end: 3.9 }] };
  assert.deepStrictEqual(P.timeWords({ ...line, text: 'Hello bright world' }, 4).map((x) => [x.text, x.start, x.end]), [['Hello', 2, 2.6], ['bright', 2.7, 3], ['world', 3.1, 3.9]], 'a word typed over keeps its time');
  const spread = P.timeWords({ ...line, text: 'Hello there big wide world' }, 4);
  assert.strictEqual(spread.length, 5); near(spread[0].start, 2, 1e-9); near(spread[4].end, 4, 1e-9);
  for (let i = 1; i < spread.length; i++) near(spread[i].start, spread[i - 1].end, 1e-9, 'one after the other');
  assert(spread[4].end - spread[4].start > spread[2].end - spread[2].start, 'a longer word gets longer');
  assert.deepStrictEqual(P.splitWords('  two   words '), ['two', 'words']); assert.deepStrictEqual(P.splitWords('你好 世', false), ['你', '好', '世']); assert.deepStrictEqual(P.splitWords(''), []);
  assert.strictEqual(P.looksUnspaced('你好世界'), true); assert.strictEqual(P.looksUnspaced('Hello world'), false);
  // a line without an end runs to the next one (at most 8 s), and the last one to the end of the song
  const ls = [{ start: 1, text: 'a' }, { start: 30, text: 'b' }];
  assert.strictEqual(P.lineEnd(ls, 0), 9); assert.strictEqual(P.lineEnd([{ start: 1, text: 'a' }, { start: 3, text: 'b' }], 0), 3); assert.strictEqual(P.lineEnd(ls, 1, 33), 33);
  // ready to write: sorted, empty lines gone, words never go backwards or overlap, and stay inside their line
  const messy = [{ start: 9, text: 'second line here' }, { start: 1, end: 5, text: 'first', words: [{ text: 'first', start: 0.5, end: 7 }] }, { start: 4, text: '   ' }, { start: 6, text: 'odd times', words: [{ text: 'odd', start: 7, end: 6.5 }, { text: 'times', start: 6.2, end: 8 }] }];
  const t = P.timedLines(messy, { duration: 12 });
  assert.deepStrictEqual(t.map((l) => l.text), ['first', 'odd times', 'second line here']);
  for (const l of t) {
    assert(l.end > l.start, 'a line ends after it starts');
    l.words.forEach((x, k) => { assert(x.start >= l.start - 1e-9 && x.end <= l.end + 1e-9, `${x.text} inside its line`); assert(x.end >= x.start); if (k) assert(x.start >= l.words[k - 1].end - 1e-9, 'no overlap'); });
  }
  assert.strictEqual(t[0].words[0].start, 1, 'a word cannot start before its line'); assert(t[0].words[0].end <= 6, 'or run into the next line');
  assert.strictEqual(t[2].end, 12, 'the last line ends with the song');
});

test('pasted lyrics: one line per row; blank rows, section headings and notes in brackets are left out', () => {
  assert.deepStrictEqual(P.pastedLines('[Verse 1]\r\nI said, ooh, I\'m blinded by the lights\n\n(x2)\n  No, I can\'t   sleep \n[Chorus: Someone]\n♪\n(Ooh, yeah) singing\n'),
    ["I said, ooh, I'm blinded by the lights", "No, I can't sleep", '(Ooh, yeah) singing'], 'a sung bracket next to words is kept');
  assert.deepStrictEqual(P.pastedLines(''), []); assert.deepStrictEqual(P.pastedLines(null), []);
  assert.strictEqual(P.pastedLines('x\n'.repeat(3000)).length, 2000, 'a sane limit');
});

test('tokens: text is turned into exactly the tokens the model writes itself, and back', () => {
  const t = T();
  for (const text of [" Hello world, it's me!", " I'm blinded by the lights", ' Café 2024 — naïve', ' 你好世界', '  two  spaces', ' emoji 🎵 ok']) {
    const ids = W.encodeText(t, text);
    assert(ids.every((id) => Number.isInteger(id) && id < t.eot), 'plain text tokens only');
    assert.strictEqual(Buffer.concat(ids.map((id) => t.pieces[id])).toString('utf8'), text, 'the bytes come back exactly: ' + text);
  }
  // the most common words are one token each, with the leading space (as the model writes them)
  assert.deepStrictEqual(W.encodeText(t, ' the').length, 1); assert.deepStrictEqual(W.encodeText(t, ' and the').length, 2);
});

test('matching: pasted words line up with heard words despite misheard, missing and extra words, and repeated choruses', () => {
  const norm = (s) => s.split(' ').map(W.normWord);
  assert.strictEqual(W.normWord('Can\'t,'), 'cant'); assert.strictEqual(W.normWord('Été!'), 'ete');
  assert(W.editSimilarity('walked', 'walk') >= 0.6 && W.editSimilarity('lights', 'fight') < 0.67 && W.editSimilarity('a', 'a') === 1);
  const pasted = norm('I said ooh I\'m blinded by the lights No I can\'t sleep until I feel your touch I said ooh I\'m blinded by the lights');
  const heard = norm('I said oh I\'m blind by the light no I can sleep until I feel your touch thank you I said ooh I\'m blinded by the lights');
  const m = W.matchWords(pasted, heard);
  assert.strictEqual(m[4], 4, '"blinded" matches "blind"'); assert.strictEqual(m[7], 7, '"lights" matches "light"');
  assert.strictEqual(m[10], 10, '"can\'t" matches "can"');
  assert.deepStrictEqual(Array.from(m.slice(17)), [19, 20, 21, 22, 23, 24, 25, 26], 'the repeated chorus lines up with its own repeat, after the extra words');
  for (let i = 1; i < m.length; i++) if (m[i] >= 0 && m[i - 1] >= 0) assert(m[i] > m[i - 1], 'in order');
  // a line the model did not hear at all gets times between its neighbours
  const est = W.estimateTimes(Int32Array.from([0, 1, -1, -1, 2]), [10, 11, 20], 60);
  assert.deepStrictEqual(Array.from(est).map((x) => Math.round(x * 100) / 100), [10, 11, 14, 17, 20]);
  const before = W.estimateTimes(Int32Array.from([-1, -1, 0]), [5], 60); assert.deepStrictEqual(Array.from(before).map((x) => Math.round(x * 100) / 100), [4.3, 4.65, 5]);
  const none = W.estimateTimes(Int32Array.from([-1, -1]), [], 60); assert.deepStrictEqual(Array.from(none), [0, 30], 'nothing heard: spread over the song');
});

test('timing: under music, a voice coming in is found where the sound gets clearly louder (single drum hits do not count)', () => {
  const sr = 16000; const s = new Float32Array(sr * 2);
  let seed = 3; const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296) * 2 - 1;
  for (let i = 0; i < s.length; i++) { const t = i / sr; s[i] = 0.05 * rnd() + ((t * 4) % 1 < 0.03 ? 0.2 * rnd() : 0) + (t >= 1.2 ? 0.4 * Math.sin(2 * Math.PI * 200 * t) : 0); }
  near(W.riseOnset(s, sr, 0, 2), 1.2, 0.1, 'the voice comes in at 1.2 s');
  const flat = new Float32Array(sr); for (let i = 0; i < flat.length; i++) flat[i] = 0.1 * rnd();
  assert.strictEqual(W.riseOnset(flat, sr, 0, 1), null, 'steady music alone: nothing');
});

test('ttml: word-synced lyrics are written as TTML with a <span> per word, escaped, and read back exactly', () => {
  assert.strictEqual(P.ttmlTime(0), '00:00:00.000'); assert.strictEqual(P.ttmlTime(65.4), '00:01:05.400'); assert.strictEqual(P.ttmlTime(3725.0006), '01:02:05.001'); assert.strictEqual(P.ttmlTime(59.9996), '00:01:00.000'); assert.strictEqual(P.ttmlTime(-3), '00:00:00.000');
  for (const [s, v] of [['00:01:05.400', 65.4], ['1:05.4', 65.4], ['01:02:05', 3725], ['65.4s', 65.4], ['1200ms', 1.2], ['1.5m', 90], ['0.5h', 1800], ['12.25', 12.25]]) near(P.parseTtmlTime(s), v, 1e-9, s);
  for (const bad of ['', 'abc', '1:75', '-3s', null, '12f']) assert.strictEqual(P.parseTtmlTime(bad), null, JSON.stringify(bad));
  const w = (text, start, end) => ({ text, start, end });
  const lines = [
    { start: 1, end: 3, text: 'Hello big world', words: [w('Hello', 1, 1.5), w('big', 1.6, 2), w('world', 2.1, 2.9)] },
    { start: 4, end: 6, text: 'Tom & "Jerry" <3 été', words: [w('Tom', 4, 4.3), w('&', 4.3, 4.5), w('"Jerry"', 4.5, 5), w('<3', 5, 5.4), w('été', 5.4, 6)] },
    { start: 7, end: 9, text: '你好世界', words: [w('你', 7, 7.5), w('好', 7.5, 8), w('世', 8, 8.5), w('界', 8.5, 9)] },
  ];
  const xml = P.formatTtml(lines, { language: 'en', title: 'Songs & <More>', duration: 200 });
  assert(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<tt xmlns="http://www.w3.org/ns/ttml"'), 'a TTML document');
  assert(/itunes:timing="Word"/.test(xml) && /xml:lang="en"/.test(xml) && /<body dur="00:03:20.000">/.test(xml));
  assert(/<ttm:title>Songs &amp; &lt;More&gt;<\/ttm:title>/.test(xml), 'the title is escaped');
  assert(xml.includes('<span begin="00:00:01.000" end="00:00:01.500">Hello</span> <span begin="00:00:01.600" end="00:00:02.000">big</span>'), 'one span per word, a space between');
  assert(xml.includes('>&amp;</span>') && xml.includes('>&quot;Jerry&quot;</span>') && xml.includes('>&lt;3</span>'), 'special characters are escaped');
  assert(xml.includes('你</span><span'), 'no space between words of a language written without spaces');
  assert.strictEqual((xml.match(/<p /g) || []).length, 3); assert.strictEqual((xml.match(/<span /g) || []).length, 12);
  const back = P.parseTtml(xml);
  assert.deepStrictEqual(back, lines, 'read back exactly');
  assert.deepStrictEqual(P.parseTtml('﻿' + xml.replace(/\n/g, '\r\n')), lines, 'with a BOM and Windows line ends too');
  const empty = P.formatTtml([], {}); assert(/<body dur="00:00:00.000">\s*<\/body>/.test(empty)); assert.deepStrictEqual(P.parseTtml(empty), []);
  assert(!/xml:lang/.test(P.formatTtml(lines, { language: 'bad" onload="x' })), 'a strange language code is left out');
  assert(!/\u0001/.test(P.formatTtml([{ start: 1, text: 'bell\u0001' }])), 'characters XML does not allow are dropped');
  // a line typed in without word times gets its words timed from the line
  const typed = P.parseTtml(P.formatTtml([{ start: 2, text: 'one two' }, { start: 4, text: 'three' }]));
  assert.deepStrictEqual(typed[0].words.map((x) => [x.text, x.start, x.end]), [['one', 2, 3], ['two', 3, 4]]);
});

test('ttml: files from other programs are read: syllables, background vocals, line-only timing, offset times, nested <div>s', () => {
  const apple = '<?xml version="1.0"?><!-- made elsewhere --><tt xmlns="http://www.w3.org/ns/ttml" xmlns:ttm="http://www.w3.org/ns/ttml#metadata" xml:lang="en"><body><div begin="1.5">'
    + '<p begin="1.5" end="3.2"><span begin="1.5" end="1.9">Ba</span><span begin="1.9" end="2.3">by</span> <span begin="2.4" end="3.0">come</span><span ttm:role="x-bg" begin="3" end="3.6"><span begin="3.0" end="3.2">oh</span> <span begin="3.2" end="3.6">yeah</span></span></p>'
    + '</div><div><p begin="00:04.000" end="00:05.000">Line only<br/>two</p><p begin="6s" dur="1500ms"><span begin="6s" dur="0.5s">Fast</span> <span begin="6.5s" end="7.5s">one &#x2764;&#65;</span></p><p>no time at all</p></div></body></tt>';
  assert.deepStrictEqual(P.parseTtml(apple), [
    { start: 1.5, end: 3.6, text: 'Baby come (oh yeah)', words: [{ text: 'Baby', start: 1.5, end: 2.3 }, { text: 'come', start: 2.4, end: 3 }, { text: '(oh', start: 3, end: 3.2 }, { text: 'yeah)', start: 3.2, end: 3.6 }] },
    { start: 4, end: 5, text: 'Line only two' },
    { start: 6, end: 7.5, text: 'Fast one ❤A', words: [{ text: 'Fast', start: 6, end: 6.5 }, { text: 'one ❤A', start: 6.5, end: 7.5 }] },
  ]);
  assert.throws(() => P.parseTtml('[00:01.00]an lrc file'), /not a TTML/);
  assert.throws(() => P.parseTtml(''), /not a TTML/);
});

test('lines: times are typed and shown as m:ss.cc, lines can be shifted, and the playing line is found', () => {
  assert.strictEqual(P.formatTime(65.4), '1:05.40'); assert.strictEqual(P.formatTime(0), '0:00.00'); assert.strictEqual(P.formatTime(600.005), '10:00.01');
  assert.strictEqual(P.parseTime('1:05.4'), 65.4); assert.strictEqual(P.parseTime('1:05'), 65); assert.strictEqual(P.parseTime('65.25'), 65.25); assert.strictEqual(P.parseTime(' 0:12,50 '), 12.5); assert.strictEqual(P.parseTime('70'), 70);
  for (const bad of ['', 'abc', '1:75', '1:2:3', '-3', null, '1:05.']) assert.strictEqual(P.parseTime(bad), null, JSON.stringify(bad));
  const shifted = P.shiftLines([{ start: 0.3, text: 'a' }, { start: 5, text: 'b' }], -0.5);
  assert.deepStrictEqual(shifted.map((l) => l.start), [0, 4.5]);
  const lines = [{ start: 1 }, { start: 5 }, { start: 9 }];
  assert.strictEqual(P.currentLine(lines, 0), -1); assert.strictEqual(P.currentLine(lines, 1), 0); assert.strictEqual(P.currentLine(lines, 7), 1); assert.strictEqual(P.currentLine(lines, 99), 2); assert.strictEqual(P.currentLine([], 5), -1);
});

test('plan: the language list has "detect" first, the commonly sung languages next, then all 99 once; names and estimates', () => {
  const list = P.languageList();
  assert.strictEqual(list[0].code, 'auto'); assert.strictEqual(list[1].code, 'en'); assert.strictEqual(list.length, 100);
  assert.strictEqual(new Set(list.map((l) => l.code)).size, 100);
  assert(list.slice(17).every((l, i, a) => !i || a[i - 1].name.localeCompare(l.name) <= 0), 'the rest is A to Z');
  assert.strictEqual(P.defaultName('C:\\music\\Song One.flac', '.lrc'), 'Song One.lrc'); assert.strictEqual(P.defaultName('noext', '.txt'), 'noext.txt');
  assert(P.isAudio('a.MP3') && P.isAudio('b.flac') && !P.isAudio('c.txt') && !P.isAudio('d'));
  near(P.estimateSeconds(240), 120, 1, 'a 4 minute song is estimated at about 2 minutes'); assert.strictEqual(P.formatDuration(125), '2:05');
});

// ---- reading songs ---------------------------------------------------------------------------------------------------------------------------------
test('audio: the length is read from the header, songs are decoded to 16 kHz mono, and a file that is not audio gives a readable error', async () => {
  const ff = A.ffmpegPath();
  const x = new Float32Array(44100 * 3); for (let i = 0; i < x.length; i++) x[i] = 0.3 * Math.sin((2 * Math.PI * 440 * i) / 44100);
  const f = SP.writeWav(path.join(tmp, 'tone44.wav'), x, 44100);
  near(await A.probe(ff, f), 3, 0.05, 'length');
  const pcm = await A.decode16k(ff, f);
  near(pcm.length, 48000, 400, 'samples at 16 kHz');
  let peak = 0; for (const v of pcm) peak = Math.max(peak, Math.abs(v));
  near(peak, 0.3, 0.03, 'level kept');
  const junk = path.join(tmp, 'junk.mp3'); fs.writeFileSync(junk, Buffer.alloc(4000, 5));
  await assert.rejects(A.probe(ff, junk), (e) => e instanceof A.UserError);
  await assert.rejects(A.decode16k(ff, junk), (e) => e instanceof A.UserError && /could not be read as audio/.test(e.message));
  const ac = new AbortController(); ac.abort();
  await assert.rejects(A.decode16k(ff, f, { signal: ac.signal }), (e) => e.cancelled === true);
});

// ---- the real model ---------------------------------------------------------------------------------------------------------------------------------
let engine = null;
const getEngine = async () => engine || (engine = await E.createEngine());

test('model: silence is skipped without asking the model, quickly, and an unknown language is refused', async () => {
  const eng = await getEngine();
  const t0 = Date.now();
  const r = await eng.transcribe(new Float32Array(16000 * 40), { language: 'auto' });
  assert.strictEqual(r.segments.length, 0);
  assert(Date.now() - t0 < 3000, 'a silent song takes no model time: ' + (Date.now() - t0) + ' ms');
  await assert.rejects(eng.transcribe(new Float32Array(16000 * 5).fill(0.1), { language: 'xx' }), /Unknown language/);
});

test('model: spoken sentences are written down correctly, with their start times, words and language (spoken test voices)', skipUnlessSpeech(async () => {
  const eng = await getEngine();
  const at = [1.0, 13.0, 26.0];
  const clip = await SP.makeClip(SP.SENTENCES.slice(0, 3).map((text, i) => ({ text, at: at[i], voice: i % 2 ? 'Microsoft Zira Desktop' : 'Microsoft David Desktop' })), 45, path.join(tmp, 'speech.wav'));
  const seen = []; const progress = []; let streamed = 0;
  const t0 = Date.now();
  const r = await eng.transcribe(clip.samples.slice(), { language: 'auto', onSegments: (s) => { streamed += s.length; }, onProgress: (p) => progress.push(p) });
  const secs = (Date.now() - t0) / 1000;
  assert.strictEqual(r.language, 'en');
  assert.strictEqual(r.segments.length, 3, JSON.stringify(r.segments.map((s) => s.text)));
  r.segments.forEach((s, i) => {
    const wer = SP.wordErrorRate(SP.SENTENCES[i], s.text);
    assert(wer <= 0.15, `sentence ${i + 1}: word error rate ${wer.toFixed(2)} ("${s.text}")`);
    near(s.start, at[i], 0.5, `sentence ${i + 1} starts`);
    assert(s.end > s.start && s.end <= 45.01, 'ends after it starts');
    assert(s.words.length >= 8 && s.words.every((w, k) => w.end >= w.start && (k === 0 || w.start >= s.words[k - 1].start - 0.01)), 'word times are in order');
    assert(s.words[0].start >= s.start - 1e-6 && s.words[s.words.length - 1].end <= s.end + 1e-6, 'words sit inside their segment');
    seen.push(s.start.toFixed(2));
  });
  const lines = P.buildLines(r.segments);
  assert(lines.length >= 3 && lines[0].text.startsWith('The river'), 'lines were built: ' + lines.map((l) => l.text).join(' | '));
  assert(lines.every((l) => l.words && l.words.length && l.words.map((x) => x.text).join(' ') === l.text), 'every line keeps its timed words');
  const back = P.parseTtml(P.formatTtml(lines, { language: r.language, duration: 45 }));
  assert.strictEqual(back.length, lines.length, 'the TTML holds every line');
  back.forEach((l, i) => {
    assert.strictEqual(l.text, lines[i].text);
    assert.deepStrictEqual(l.words.map((x) => x.text), lines[i].words.map((x) => x.text), 'and every word');
    l.words.forEach((x, k) => { near(x.start, lines[i].words[k].start, 0.011, 'word start kept'); assert(x.start >= l.start - 1e-9 && x.end <= l.end + 1e-9); });
  });
  const second = lines.find((l) => /walked/i.test(l.text));
  const walked = second.words.find((x) => /walked/i.test(x.text));
  assert(walked.start > 13 && walked.start < 14.2, `"walked" is the second word said at 13 s: ${walked.start}`);

  assert(streamed >= 3, 'segments were streamed while working (' + streamed + ')');
  assert(progress.length >= 6 && progress.every((p, i) => i === 0 || p.fraction >= progress[i - 1].fraction - 1e-9), 'progress only goes forward');
  assert(progress[progress.length - 1].fraction === 1 && progress.some((p) => p.language === 'en'), 'progress ends at 1 and reports the language');
  console.log(`     starts ${seen.join(', ')} (truth ${at.join(', ')}); ${secs.toFixed(1)} s for 45 s of audio`);
}));

test('model: pasted lyrics come back exactly as pasted (lines and words), each word timed, also with music under the voice (spoken test voices)', skipUnlessSpeech(async () => {
  const eng = await getEngine();
  const at = [1.0, 13.0, 26.0];
  const clip = await SP.makeClip(SP.SENTENCES.slice(0, 3).map((text, i) => ({ text, at: at[i] })), 45, path.join(tmp, 'pasted.wav'));
  const lyrics = ['The river runs down to the sea,', 'and the morning light is warm on the hills.', 'We walked all night through the empty streets,', 'singing songs we used to know.', 'Hold on to the little things,', 'they will carry you home.'];
  let pw = 0; for (const v of clip.samples) pw += v * v; const rms = Math.sqrt(pw / clip.samples.length);
  let seed = 7; const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296) * 2 - 1;
  const music = clip.samples.slice();
  for (let i = 0; i < music.length; i++) { const t = i / 16000; const beat = (t * 2) % 1 < 0.12 ? 1 : 0.25; music[i] += rms * 0.6 * (0.5 * rnd() * beat + 0.2 * (Math.sin(2 * Math.PI * 220 * t) + Math.sin(2 * Math.PI * 277 * t) + Math.sin(2 * Math.PI * 330 * t))); }
  for (const [what, samples] of [['clean', clip.samples], ['with music', music]]) {
    const r = await eng.transcribe(samples.slice(), { language: 'auto', lyrics });
    assert.strictEqual(r.language, 'en');
    assert(r.matched > 0.9, `${what}: most words were heard (${r.matched})`);
    assert.deepStrictEqual(r.lines.map((l) => l.text), lyrics, `${what}: the lines are the pasted ones`);
    r.lines.forEach((l, i) => {
      assert.deepStrictEqual(l.words.map((w) => w.text), lyrics[i].split(' '), `${what}: the words are the pasted ones`);
      l.words.forEach((w, k) => { assert(w.end >= w.start); if (k) assert(w.start >= l.words[k - 1].end - 1e-9, 'in order, no overlap'); });
      if (i) assert(l.start >= r.lines[i - 1].end - 1e-9, 'lines in order');
    });
    near(r.lines[0].start, at[0], 0.35, `${what}: first sentence starts`); near(r.lines[2].start, at[1], 0.35, `${what}: second sentence`); near(r.lines[4].start, at[2], 0.35, `${what}: third sentence`);
    const walked = r.lines[2].words[1]; assert(walked.start > 13.0 && walked.start < 13.6, `${what}: "walked" ${walked.start}`);
    console.log(`     ${what}: starts ${[0, 2, 4].map((i) => r.lines[i].start.toFixed(2)).join(', ')} (truth ${at.join(', ')}), ${Math.round(r.matched * 100)}% heard`);
  }
}));

test('model: cancelling in the middle of a song stops it within seconds without crashing, and the engine keeps working', skipUnlessSpeech(async () => {
  const eng = await getEngine();
  const clip = await SP.makeClip(SP.SENTENCES.map((text, i) => ({ text, at: 1 + i * 11 })), 50, path.join(tmp, 'cancel.wav'));
  const ac = new AbortController();
  const p = eng.transcribe(clip.samples.slice(), { signal: ac.signal }).then(() => 'finished', (e) => (e.cancelled ? 'cancelled' : 'error: ' + e.message));
  await new Promise((r) => setTimeout(r, 3500));
  const t0 = Date.now();
  ac.abort();
  assert.strictEqual(await p, 'cancelled');
  assert(Date.now() - t0 < 8000, 'stopped in ' + (Date.now() - t0) + ' ms');
  const again = await eng.transcribe(clip.samples.slice(0, 16000 * 12), { language: 'en' });
  assert(again.segments.length >= 1 && /river/i.test(again.segments[0].text), 'the engine still works afterwards: ' + JSON.stringify(again.segments));
}));

test('model: releasing in the middle of a song waits for it to stop, never crashes the process, and a new engine starts fine', skipUnlessSpeech(async () => {
  const eng = await E.createEngine();
  const clip = await SP.makeClip(SP.SENTENCES.map((text, i) => ({ text, at: 1 + i * 11 })), 50, path.join(tmp, 'release.wav'));
  const p = eng.transcribe(clip.samples.slice()).then(() => 'finished', (e) => (e.cancelled ? 'cancelled' : 'error: ' + e.message));
  await new Promise((r) => setTimeout(r, 3500));
  await eng.release();
  assert.strictEqual(await p, 'cancelled');
  await assert.rejects(eng.transcribe(new Float32Array(16000 * 3)), (e) => e.cancelled === true);
  const fresh = await E.createEngine();
  const r = await fresh.transcribe(clip.samples.slice(0, 16000 * 10), { language: 'en' });
  assert(r.segments.length >= 1);
  await fresh.release();
}));

// ---- the downloadable "accurate" model ---------------------------------------------------------------------------------------------------
test('models: the accurate model downloads file by file, every file is checked, an interrupted download goes on, a damaged one is refused, cancel leaves nothing half-written', async () => {
  const files = { 'a.json': Buffer.from('{"x":1}'), 'big.onnx': crypto.randomBytes(3 * 1024 * 1024 + 17) };
  let served = []; let corrupt = false; let slow = false;
  const server = http.createServer((req, res) => {
    const name = decodeURIComponent(req.url.slice(1)); served.push(name);
    const body = files[name];
    if (!body) { res.writeHead(404); res.end(); return; }
    const out = corrupt && name === 'big.onnx' ? Buffer.concat([body.subarray(0, 100), Buffer.from([body[100] ^ 1]), body.subarray(101)]) : body;
    res.writeHead(200, { 'content-length': out.length });
    if (!slow) { res.end(out); return; }
    let i = 0; const t = setInterval(() => { if (i >= out.length || res.destroyed) { clearInterval(t); res.end(); return; } res.write(out.subarray(i, i + 65536)); i += 65536; }, 20);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
  const model = { id: 'accurate', folder: 'test-model', files: Object.entries(files).map(([name, b]) => ({ name, from: name, size: b.length, sha256: sha(b) })) };
  model.bytes = model.files.reduce((n, f) => n + f.size, 0);
  const dirs = { bundledDir: modelDir, userDir: path.join(tmp, 'user') };
  const dir = path.join(dirs.userDir, 'models', 'test-model');
  const opts = (o = {}) => ({ fetch, model, urlFor: (f) => `${base}/${f.name}`, ...o });
  try {
    const progress = [];
    await M.download('accurate', dirs, opts({ onProgress: (p) => progress.push(p.done) }));
    for (const [name, b] of Object.entries(files)) assert(fs.readFileSync(path.join(dir, name)).equals(b), name + ' arrived intact');
    assert.strictEqual(progress[progress.length - 1], model.bytes, 'progress ends at the full size');
    assert(progress.every((x, i) => !i || x >= progress[i - 1]), 'progress only goes forward');
    assert(JSON.parse(fs.readFileSync(path.join(dir, 'verified.json'), 'utf8')).revision, 'a record of what was checked');
    // run again: nothing is fetched again (the files are already right)
    served = [];
    await M.download('accurate', dirs, opts());
    assert.deepStrictEqual(served, [], 'files that are already right are kept');
    // a damaged file on disk is fetched again; a damaged download is refused and nothing of it is kept
    fs.writeFileSync(path.join(dir, 'big.onnx'), 'broken');
    corrupt = true;
    await assert.rejects(M.download('accurate', dirs, opts()), /did not arrive intact/);
    assert(!fs.existsSync(path.join(dir, 'big.onnx.part')), 'no half-written file left');
    corrupt = false;
    served = [];
    await M.download('accurate', dirs, opts());
    assert.deepStrictEqual(served, ['big.onnx'], 'only the damaged file is fetched again');
    // cancel in the middle
    fs.rmSync(path.join(dir, 'big.onnx'));
    slow = true;
    const ac = new AbortController();
    const p = M.download('accurate', dirs, opts({ signal: ac.signal }));
    setTimeout(() => ac.abort(), 150);
    await assert.rejects(p, (e) => e.cancelled === true || e.name === 'AbortError');
    assert(!fs.existsSync(path.join(dir, 'big.onnx.part')) && !fs.existsSync(path.join(dir, 'big.onnx')), 'cancel leaves nothing half-written');
    // the real list: standard is in the app; accurate is not downloaded in this test folder; remove only touches its own folder
    const list = M.list(dirs);
    assert.deepStrictEqual(list.map((m) => [m.id, m.bundled]), [['standard', true], ['accurate', false]]);
    assert.strictEqual(list[0].installed, true); assert.strictEqual(list[1].installed, false);
    assert(list[1].bytes > 1e9 && list[1].bytes < 1.2e9, 'about 1.1 GB');
    await assert.rejects(M.remove('standard', dirs), /part of the app/);
    assert.throws(() => M.dirFor('../evil', dirs), /Unknown model/);
  } finally { server.close(); }
});

test('models: the pinned accurate model (if it is on this computer) has exactly the pinned sizes and SHA-256 hashes', async () => {
  const dir = path.join(modelDir, 'turbo');
  if (!fs.existsSync(path.join(dir, 'encoder_model_int8.onnx'))) { console.log('     (skipped: the accurate model is not in models/turbo)'); return; }
  for (const f of M.MODELS.accurate.files) {
    assert.strictEqual(fs.statSync(path.join(dir, f.name)).size, f.size, f.name + ' size');
    assert.strictEqual(await M.hashFile(path.join(dir, f.name)), f.sha256, f.name + ' hash');
  }
  const t = W.loadAssets(dir);
  assert.strictEqual(t.nMels, 128); assert.strictEqual(t.layers, 4); assert(t.alignmentHeads.length > 0, 'it can time words');
  assert.notStrictEqual(t.noSpeech, 50362, 'its "no speech" token is read from its own files');
});

test('model: the accurate model (if present) writes the spoken sentences down and times pasted lyrics too (spoken test voices)', skipUnlessSpeech(async () => {
  const dir = path.join(modelDir, 'turbo');
  if (!fs.existsSync(path.join(dir, 'encoder_model_int8.onnx'))) { console.log('     (skipped: the accurate model is not in models/turbo)'); return; }
  const at = [1.0, 13.0, 26.0];
  const clip = await SP.makeClip(SP.SENTENCES.slice(0, 3).map((text, i) => ({ text, at: at[i] })), 45, path.join(tmp, 'turbo.wav'));
  const eng = await E.createEngine({ dir });
  try {
    const t0 = Date.now();
    const r = await eng.transcribe(clip.samples.slice(), { language: 'auto' });
    const secs = (Date.now() - t0) / 1000;
    const text = r.segments.map((x) => x.text).join(' ');
    const wer = SP.wordErrorRate(SP.SENTENCES.slice(0, 3).join(' '), text);
    assert.strictEqual(r.language, 'en'); assert(wer <= 0.1, `word error rate ${wer.toFixed(2)}: ${text}`);
    near(r.segments[0].start, at[0], 0.5); assert(r.segments.some((x) => Math.abs(x.start - at[1]) < 0.6) && r.segments.some((x) => Math.abs(x.start - at[2]) < 0.6), 'sentence starts');
    const lyrics = ['We walked all night through the empty streets,', 'singing songs we used to know.'];
    const a = await eng.transcribe(clip.samples.slice(), { language: 'en', lyrics: ['The river runs down to the sea,', 'and the morning light is warm on the hills.', ...lyrics, 'Hold on to the little things,', 'they will carry you home.'] });
    near(a.lines[2].start, at[1], 0.35, 'pasted lyrics timed with the accurate model');
    console.log(`     accurate model: WER ${wer.toFixed(2)}, ${secs.toFixed(1)} s for 45 s of audio`);
  } finally { await eng.release(); }
}));

test('model: a missing model file gives a clear message', async () => {
  await assert.rejects(E.createEngine({ dir: path.join(tmp, 'nothing-here') }), (e) => e instanceof A.UserError && /npm run setup/.test(e.message));
});

// ---- the look ------------------------------------------------------------------------------------------------------------------------------------------
test('look: the accent and text colours are readable on the dark background', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'styles.css'), 'utf8');
  const tokens = {};
  for (const m of css.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-fA-F]{6})/g)) tokens[m[1]] = m[2];
  const lum = (hex) => { const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  const pairs = [['text', 'bg', 4.5], ['muted', 'bg', 4.5], ['muted', 'panel', 4.5], ['accent', 'bg', 4.5], ['accent', 'panel', 4.5], ['err', 'bg', 4.5], ['ok', 'bg', 4.5], ['on-accent', 'accent', 4.5]];
  const bad = pairs.filter(([a, b, min]) => !tokens[a] || !tokens[b] || ratio(tokens[a], tokens[b]) < min).map(([a, b, min]) => `${a} on ${b} < ${min}`);
  assert.deepStrictEqual(bad, []);
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
