'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const C = require('../src/convert');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-test-'));
const ff = C.ffmpegPath();
let n = 0;
const ok = (m) => { n++; console.log('  ok  ' + m); };
const run = (args) => { const r = spawnSync(ff, ['-y', '-hide_banner', '-loglevel', 'error', ...args]); assert.strictEqual(r.status, 0, 'ffmpeg: ' + r.stderr); };

(async () => {
  const ver = spawnSync(ff, ['-version']);
  assert.strictEqual(ver.status, 0, 'ffmpeg must be available (run `npm run setup`)');
  console.log('  using ' + String(ver.stdout).split('\n')[0]);

  // fixtures: 2s stereo 44.1k sine as WAV, and a FLAC with title/artist tags + embedded cover
  const wav = path.join(tmp, 'tone.wav');
  run(['-f', 'lavfi', '-i', 'sine=frequency=440:duration=2:sample_rate=44100', '-ac', '2', wav]);
  const cover = path.join(tmp, 'cover.png');
  run(['-f', 'lavfi', '-i', 'color=c=red:s=64x64', '-frames:v', '1', cover]);
  const tagged = path.join(tmp, 'tagged.flac');
  run(['-i', wav, '-i', cover, '-map', '0:a', '-map', '1:v', '-c:a', 'flac', '-c:v', 'copy', '-disposition:v', 'attached_pic',
    '-metadata', 'title=Café ♪', '-metadata', 'artist=The Band', '-metadata', 'album=Tests', tagged]);

  // ---- probe
  let info = await C.probe(wav);
  assert(Math.abs(info.durationSec - 2) < 0.1 && info.sampleRate === 44100);
  info = await C.probe(tagged);
  assert.strictEqual(info.tags.title, 'Café ♪');
  assert(info.coverStream != null, 'attached pic detected');
  ok('probe: duration, sample rate, tags, attached picture');

  // ---- every output format converts and reports the right codec
  const expectCodec = { mp3: 'mp3', m4a: 'aac', ogg: 'vorbis', opus: 'opus', flac: 'flac', wav: 'pcm_s16le' };
  for (const fmt of Object.keys(C.FORMATS)) {
    const r = await C.convertOne(wav, { format: fmt, outDir: path.join(tmp, 'out') });
    assert.strictEqual(path.extname(r.output), C.FORMATS[fmt].ext);
    const p = await C.probe(r.output);
    assert(Math.abs(p.durationSec - 2) < 0.2, `${fmt} duration ${p.durationSec}`);
    assert.strictEqual(p.codec, expectCodec[fmt], `${fmt} codec`);
  }
  ok('wav -> mp3/m4a/ogg/opus/flac/wav (codec + duration)');

  // ---- tags and cover survive (where the format can carry them)
  // Check every format before failing, and on a problem show ffmpeg's own report: different ffmpeg builds
  // (Windows vs Linux) can lay tags out differently, and a CI log is all we get to see.
  const problems = [];
  for (const fmt of ['mp3', 'flac', 'm4a', 'ogg', 'opus']) {
    const r = await C.convertOne(tagged, { format: fmt, outDir: path.join(tmp, 'tags') });
    const p = await C.probe(r.output);
    const bad = [];
    if (p.tags.title !== 'Café ♪') bad.push(`title=${JSON.stringify(p.tags.title)}`);
    if (p.tags.artist !== 'The Band') bad.push(`artist=${JSON.stringify(p.tags.artist)}`);
    if ((p.coverStream != null) !== C.FORMATS[fmt].cover) bad.push(`cover=${p.coverStream != null} (expected ${C.FORMATS[fmt].cover})`);
    if (bad.length) problems.push(`[${fmt}] ${bad.join(', ')}\n--- ffmpeg report for the ${fmt} output:\n${p.raw.split('\n').slice(0, 16).join('\n')}`);
  }
  assert.strictEqual(problems.length, 0, '\n' + problems.join('\n'));
  ok('tags preserved; cover kept for mp3/flac/m4a');
  const stripped = await C.convertOne(tagged, { format: 'mp3', keepTags: false, outDir: path.join(tmp, 'strip') });
  const sp = await C.probe(stripped.output);
  assert(!sp.tags.title && sp.coverStream == null);
  ok('keepTags=false strips tags and cover');

  // ---- quality options
  const lo = await C.convertOne(wav, { format: 'mp3', bitrate: 96, outDir: path.join(tmp, 'q') });
  const hi = await C.convertOne(wav, { format: 'mp3', bitrate: 320, outDir: path.join(tmp, 'q') });
  assert(hi.outBytes > lo.outBytes * 2, `320k (${hi.outBytes}) should be much bigger than 96k (${lo.outBytes})`);
  const mono = await C.convertOne(wav, { format: 'wav', channels: 1, sampleRate: 22050, outDir: path.join(tmp, 'q') });
  const mi = spawnSync(ff, ['-hide_banner', '-i', mono.output]).stderr.toString();
  assert(/22050 Hz, (mono|1 channels)/.test(mi), mi.split('\n').find((l) => /Audio:/.test(l)));
  ok('bitrate, channels and sample rate options applied');

  // ---- option validation / arg building
  assert.throws(() => C.normalizeOptions({ format: 'exe' }), /Unsupported/);
  assert.strictEqual(C.normalizeOptions({ format: 'mp3', bitrate: 999 }).bitrate, 192);
  assert.strictEqual(C.normalizeOptions({ format: 'flac', bitrate: 128 }).bitrate, null);
  assert.strictEqual(C.normalizeOptions({ format: 'mp3', sampleRate: 12345 }).sampleRate, 0);
  const a = C.buildArgs('/in.wav', '/out.part', { format: 'mp3', bitrate: 128 });
  assert(a.includes('-protocol_whitelist') && a.join(' ').includes('-b:a 128k') && a.includes('libmp3lame'));
  ok('option normalisation + ffmpeg arguments');

  // ---- never overwrites; no partial files left on failure or cancel
  const again = await C.convertOne(wav, { format: 'wav' }); // same dir, same ext -> "tone (1).wav"
  assert.strictEqual(path.basename(again.output), 'tone (1).wav');
  const bad = path.join(tmp, 'broken.mp3'); fs.writeFileSync(bad, 'definitely not audio'.repeat(50));
  await assert.rejects(() => C.convertOne(bad, { format: 'flac' }));
  await assert.rejects(() => C.convertOne(path.join(tmp, 'x.txt'), { format: 'flac' }), /Unsupported/);
  await assert.rejects(() => C.convertOne('relative.mp3', { format: 'flac' }), /absolute/);
  assert(!fs.readdirSync(tmp).some((f) => f.endsWith('.part')), 'no .part left after failures');
  ok('no overwrite; errors leave no partial files');

  // cancel mid-way: a long input so it is still running when we abort
  const long = path.join(tmp, 'long.wav');
  run(['-f', 'lavfi', '-i', 'sine=frequency=300:duration=1500:sample_rate=44100', '-ac', '2', long]);
  const ac = new AbortController();
  let progressSeen = 0;
  const job = C.convertOne(long, { format: 'flac', outDir: path.join(tmp, 'cancel') }, { signal: ac.signal, onProgress: (f) => { progressSeen = f; if (f > 0.02 && !ac.signal.aborted) ac.abort(); } });
  await assert.rejects(job, /Cancelled/);
  assert(progressSeen > 0, 'progress was reported');
  const left = fs.existsSync(path.join(tmp, 'cancel')) ? fs.readdirSync(path.join(tmp, 'cancel')) : [];
  assert.deepStrictEqual(left, [], 'nothing left after cancel: ' + left);
  ok('progress reported; cancel stops ffmpeg and cleans up');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${n} checks passed`);
})().catch((e) => { console.error('FAIL:', e); process.exit(1); });
