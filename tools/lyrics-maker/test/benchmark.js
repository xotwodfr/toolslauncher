'use strict';
// Measures Lyrics Maker on real songs with human word timings: the JamendoLyrics benchmark (Creative Commons songs; clone
// https://github.com/f90/jamendolyrics somewhere, about 400 MB). Not part of `npm test` (it needs those songs and takes minutes).
//   npm run benchmark -- <path to jamendolyrics> [mix|vocals] [standard|accurate] [song name filter]
// For each song: the word error rate of what was heard, and, with the song's lyrics pasted, how far each word's start is from
// the annotated start (mean error, share within 0.3 s and 1 s). "vocals" separates the vocals first (experimental option);
// "accurate" needs the downloaded accurate model in models/turbo (or the app's download folder: set LM_ACCURATE_DIR).
const fs = require('fs'); const path = require('path');
const root = path.join(__dirname, '..');
const SP = require(root + '/src/speech'); const E = require(root + '/src/engine'); const A = require(root + '/src/audio'); const P = require(root + '/src/plan');
const V = require(root + '/src/vocals');
const [JLarg, input = 'mix', model = 'standard', only = ''] = process.argv.slice(2);
if (!JLarg) { console.error('usage: npm run benchmark -- <path to jamendolyrics> [mix|vocals] [standard|accurate] [filter]'); process.exit(1); }
const JL = path.resolve(JLarg); const label = `${input}, ${model}`;
const SONGS = ['Kinematic_-_Peyote', 'Avercage_-_Embers', 'The_Rinn_-_Voices__2017_Version_', 'Songwriterz_-_Back_In_Time', 'Pure_Mids_-_The_Leader'].filter((s) => s.includes(only));
const collapse = (t) => { let w = SP.words(t); for (const n of [1, 2, 3]) { const o = []; for (let i = 0; i < w.length;) { o.push(...w.slice(i, i + n)); let j = i + n, reps = 1; while (j + n <= w.length && w.slice(j, j + n).join(' ') === w.slice(i, i + n).join(' ')) { j += n; reps++; } if (reps > 3) { o.push(...w.slice(i + n, i + 3 * n)); i = j; } else i += n; } w = o; } return w.join(' '); };
(async () => {
  const eng = await E.createEngine(model === 'accurate' ? { dir: process.env.LM_ACCURATE_DIR || root + '/models/turbo' } : {});
  let tot = { n: 0, wer: 0, cwer: 0, err: [], secs: 0 };
  for (const s of SONGS) {
    const said = fs.readFileSync(`${JL}/lyrics/${s}.txt`, 'utf8');
    const lines = P.pastedLines(said);
    const truth = fs.readFileSync(`${JL}/annotations/words/${s}.csv`, 'utf8').trim().split('\n').slice(1).map((r) => Number(r.split(',')[0]));
    let samples;
    const mp3 = `${JL}/mp3/${s}.mp3`;
    if (input === 'vocals') samples = await V.isolateVocals(mp3);
    else samples = await A.decode16k(A.ffmpegPath(), mp3);
    const t0 = Date.now();
    const r = await eng.transcribe(samples, { language: 'en', lyrics: lines });
    const secs = (Date.now() - t0) / 1000;
    const heard = r.segments.map((x) => x.text).join(' ');
    const n = SP.words(said).length;
    const wer = SP.wordErrorRate(said, heard); const cwer = SP.wordErrorRate(said, collapse(heard));
    const got = r.lines.flatMap((l) => l.words.map((w) => w.start));
    let err = [];
    if (got.length === truth.length) err = got.map((t, i) => Math.abs(t - truth[i]));
    else console.log(`   (word count differs: ${got.length} timed vs ${truth.length} annotated)`);
    const within = (x) => err.length ? (err.filter((e) => e <= x).length / err.length * 100).toFixed(0) : '-';
    const mae = err.length ? (err.reduce((a, b) => a + b, 0) / err.length).toFixed(2) : '-';
    console.log(`${s.padEnd(34)} ${String(n).padStart(4)} words | heard WER ${(wer * 100).toFixed(1)}% (loops collapsed ${(cwer * 100).toFixed(1)}%) | pasted lyrics: mean error ${mae} s, ${within(0.3)}% within 0.3 s, ${within(1)}% within 1 s | ${secs.toFixed(0)} s`);
    tot.n += n; tot.wer += wer * n; tot.cwer += cwer * n; tot.err.push(...err); tot.secs += secs;
  }
  const e = tot.err; const w = (x) => (e.filter((v) => v <= x).length / e.length * 100).toFixed(0);
  console.log(`== [${label}] ALL ${tot.n} words | heard WER ${(tot.wer / tot.n * 100).toFixed(1)}% (collapsed ${(tot.cwer / tot.n * 100).toFixed(1)}%) | pasted: mean error ${(e.reduce((a, b) => a + b, 0) / e.length).toFixed(2)} s, ${w(0.3)}% within 0.3 s, ${w(1)}% within 1 s | ${tot.secs.toFixed(0)} s`);
  await eng.release();
})().catch((e) => { console.error(e); process.exit(1); });
