'use strict';
// Video Converter core tests. Clips are generated with ffmpeg itself (lavfi test patterns) and every output is
// checked by asking ffmpeg to fully decode it (zero errors) and by reading its properties back.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const C = require('../src/convert');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vidconv-'));
const ff = C.ffmpegPath();
const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const run = (args) => spawnSync(ff, ['-hide_banner', '-y', ...args], { encoding: 'utf8', windowsHide: true });
const mk = (name, args) => { const f = path.join(tmp, name); const r = run([...args, f]); assert.strictEqual(r.status, 0, 'fixture failed: ' + r.stderr.slice(-300)); return f; };
/** Decode the whole file and return ffmpeg's complaints (must be empty). */
const decodeErrors = (f) => run(['-v', 'error', '-i', f, '-f', 'null', '-']).stderr.trim();
const info = (f) => C.probe(f);
const near = (a, b, tol, msg) => assert(Math.abs(a - b) <= tol, `${msg || ''} expected ${b} +/- ${tol}, got ${a}`);

const SRC = 'testsrc2=size=640x360:rate=30:duration=4';
let clip, noisy, noisyLong;

async function fixtures() {
  clip = mk('clip.mp4', ['-f', 'lavfi', '-i', SRC, '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest',
    '-metadata', 'title=SecretTitle', '-metadata', 'location=+59.3293+018.0686/']);
  // noise makes the encoder need real bits, so a size target actually has to bite
  noisy = mk('noisy.mp4', ['-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30:duration=6,noise=alls=30:allf=t', '-f', 'lavfi', '-i', 'sine=frequency=330:duration=6', '-c:v', 'libx264', '-crf', '12', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest']);
  noisyLong = mk('long.mp4', ['-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30:duration=40,noise=alls=40:allf=t', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '20', '-pix_fmt', 'yuv420p']);
}
const out = (name) => path.join(tmp, 'out-' + name);

// ---- pure functions -----------------------------------------------------------------------------------------------
test('times: seconds, m:ss and h:mm:ss', () => {
  assert.strictEqual(C.parseTime('90'), 90);
  assert.strictEqual(C.parseTime('1:30'), 90);
  assert.strictEqual(C.parseTime('01:02:03.5'), 3723.5);
  assert.strictEqual(C.parseTime('  '), null);
  assert.strictEqual(C.parseTime(''), null);
  assert.strictEqual(C.parseTime(null), null);
  assert.strictEqual(C.parseTime('0:05.25'), 5.25);
  for (const bad of ['abc', '1:2:3:4', '-5', '1:', ':30', '1.2.3']) assert.throws(() => C.parseTime(bad, 'Start'), (e) => e instanceof C.UserError && /Start time/.test(e.message), bad);
});
test('options: validated and defaulted', () => {
  assert.throws(() => C.normalizeOptions({ format: 'avi' }), /Unsupported output format/);
  assert.throws(() => C.normalizeOptions({ format: 'mp4', targetMb: 0 }), /between 0.1 and 50000/);
  assert.throws(() => C.normalizeOptions({ format: 'mp4', targetMb: 'abc' }), /between/);
  assert.throws(() => C.normalizeOptions({ format: 'mp4', start: '10', end: '5' }), /end time must be later/);
  const o = C.normalizeOptions({ format: 'mp4', quality: 'weird', maxHeight: 999, fps: 7, targetMb: '', audio: 'x' });
  assert.deepStrictEqual([o.quality, o.maxHeight, o.fps, o.targetMb, o.audio], ['balanced', 0, 0, null, 'keep']);
  assert.strictEqual(C.normalizeOptions({ format: 'gif', targetMb: 5 }).targetMb, null, 'size target does not apply to GIF');
});
test('probe parser: normal video, cover-art stream ignored, audio-only, junk', () => {
  const good = `Input #0, mov,mp4, from 'a.mp4':\n  Duration: 00:01:02.50, start: 0.000000, bitrate: 2000 kb/s\n  Stream #0:0[0x1](und): Video: h264 (High) (avc1 / 0x31637661), yuv420p(tv, bt709, progressive), 1920x1080 [SAR 1:1 DAR 16:9], 1900 kb/s, 29.97 fps, 29.97 tbr, 30k tbn (default)\n  Stream #0:1[0x2](und): Audio: aac (LC), 48000 Hz, stereo, fltp, 128 kb/s (default)`;
  const p = C.parseProbeOutput(good);
  assert.deepStrictEqual([p.durationSec, p.videoIndex, p.codec, p.width, p.height, p.fps, p.pixFmt, p.hasAudio], [62.5, 0, 'h264', 1920, 1080, 29.97, 'yuv420p', true]);
  const cover = `  Duration: 00:03:00.00, start: 0.0\n  Stream #0:0: Audio: mp3, 44100 Hz, stereo, fltp, 192 kb/s\n  Stream #0:1: Video: mjpeg (Baseline), yuvj420p(pc), 500x500 [SAR 1:1 DAR 1:1], 90k tbr, 90k tbn (attached pic)`;
  assert.throws(() => C.parseProbeOutput(cover), /sound but no video/);
  assert.throws(() => C.parseProbeOutput('Invalid data found when processing input'), /Cannot read this file/);
  assert.throws(() => C.parseProbeOutput('hello'), /Not a readable video/);
  const two = `  Duration: 00:00:10.00\n  Stream #0:0: Video: mjpeg, yuvj420p, 300x300, 25 tbr (attached pic)\n  Stream #0:1: Video: vp9 (Profile 0), yuv420p(tv), 1280x720, 30 fps, 30 tbr`;
  const q = C.parseProbeOutput(two);
  assert.deepStrictEqual([q.videoIndex, q.codec, q.width, q.height], [1, 'vp9', 1280, 720]);
});
test('size target maths: bitrate leaves room for audio and the container', () => {
  const kbps = C.bitrateFor(10, 100, 128); // 10 MB over 100 s with 128k audio
  near(kbps, 658, 2); // (10 MB x 8192 x 0.96 - 128 x 100) / 100
  assert(C.bitrateFor(1, 600, 128) < C.MIN_VIDEO_KBPS, 'a 1 MB target for 10 minutes is hopeless');
  assert(C.bitrateFor(100, 60, 0) > 10000);
});
test('arguments: sensible defaults, no upscaling, GIF filter chain', async () => {
  const p = { videoIndex: 0, hasAudio: true, durationSec: 10, fps: 30, width: 1280, height: 720 };
  const a = C.buildArgs('/in.mp4', '/out.part', { format: 'mp4' }, p);
  assert(a.includes('libx264') && a.includes('-crf') && a.includes('23') && a.includes('+faststart') && a.includes('aac'));
  assert(!a.includes('-vf'), 'no filter when nothing to change');
  const b = C.buildArgs('/in.mp4', '/out.part', { format: 'mp4', maxHeight: 1080, fps: 60 }, p);
  assert(!b.includes('-vf'), 'never scales or resamples up');
  const c = C.buildArgs('/in.mp4', '/out.part', { format: 'mp4', maxHeight: 480, fps: 15 }, p);
  assert.strictEqual(c[c.indexOf('-vf') + 1], 'scale=-2:480,fps=15');
  const g = C.buildArgs('/in.mp4', '/out.part', { format: 'gif', gifWidth: 320, gifFps: 20 }, { ...p, fps: 12 });
  const vf = g[g.indexOf('-vf') + 1];
  assert(/^fps=12,scale='min\(320,iw\)':-2/.test(vf) && /palettegen/.test(vf) && /paletteuse/.test(vf), vf);
  assert(g.includes('-an') && g.includes('-loop'));
  assert.throws(() => C.buildArgs('/in', '/o', { format: 'mp4' }, { ...p, videoIndex: null }), /no video/);
  assert.throws(() => C.buildArgs('/in', '/o', { format: 'gif' }, { ...p, durationSec: 300 }), /enormous/);
  assert.throws(() => C.buildArgs('/in', '/o', { format: 'mp4', start: 20 }, p), /past the end/);
  assert.throws(() => C.buildArgs('/in', '/o', { format: 'mp4', targetMb: 0.2 }, { ...p, durationSec: 600 }), /too small for 600 seconds.*at least/);
});
test('arguments: a size target uses two passes (analysis without sound or output, then the real encode)', () => {
  const p = { videoIndex: 0, hasAudio: true, durationSec: 60, fps: 30, width: 1280, height: 720 };
  const o = { format: 'webm', targetMb: 20 };
  assert.strictEqual(C.needsTwoPass(C.normalizeOptions(o)), true);
  assert.strictEqual(C.needsTwoPass(C.normalizeOptions({ format: 'mp4' })), false);
  assert.strictEqual(C.needsTwoPass(C.normalizeOptions({ format: 'gif', targetMb: 5 })), false);
  const p1 = C.buildArgs('/in.mp4', '/out.part', o, p, { pass: 1, log: '/tmp/log' });
  const p2 = C.buildArgs('/in.mp4', '/out.part', o, p, { pass: 2, log: '/tmp/log' });
  assert(p1.includes('-an') && !p1.includes('libopus') && p1.includes('null') && !p1.includes('/out.part'), p1.join(' '));
  assert(p1[p1.indexOf('-pass') + 1] === '1' && p2[p2.indexOf('-pass') + 1] === '2');
  assert(p2.includes('libopus') && p2.includes('/out.part') && !p2.includes('-an'));
  const kb = (a) => a[a.indexOf('-b:v') + 1];
  assert.strictEqual(kb(p1), kb(p2), 'both passes must use the same bitrate');
  near(parseInt(kb(p2), 10), Math.floor((20 * 8192 * 0.96 - 96 * 60) / 60), 1, 'bitrate for 20 MB');
});
test('the bundled ffmpeg has every encoder we need', async () => {
  const r = await C.checkEncoders();
  assert.deepStrictEqual(r, { ok: true, missing: [] });
});

// ---- real conversions ------------------------------------------------------------------------------------------------
test('MP4: H.264 + AAC, yuv420p, even size, web-ready, decodes cleanly', async () => {
  const r = await C.convertOne(clip, { format: 'mp4', outDir: out('mp4') });
  const i = await info(r.output);
  assert.deepStrictEqual([i.codec, i.pixFmt, i.hasAudio], ['h264', 'yuv420p', true]);
  assert.deepStrictEqual([i.width, i.height], [640, 360]);
  near(i.durationSec, 4, 0.3, 'duration');
  assert.strictEqual(decodeErrors(r.output), '');
  const head = fs.readFileSync(r.output).subarray(0, 200000);
  assert(head.indexOf('moov') > 0 && head.indexOf('moov') < head.indexOf('mdat'), 'moov atom should come first (+faststart)');
  assert(/audio-clip|clip\.mp4$/.test(r.output));
});
test('WebM: VP9 + Opus, decodes cleanly', async () => {
  const r = await C.convertOne(clip, { format: 'webm', quality: 'small', outDir: out('webm') });
  const i = await info(r.output);
  assert.strictEqual(i.codec, 'vp9'); assert.strictEqual(i.hasAudio, true);
  assert(/Audio: opus/.test(i.raw));
  assert.strictEqual(decodeErrors(r.output), '');
});
test('resolution cap scales down (keeping aspect, even width) but never up', async () => {
  const down = await C.convertOne(clip, { format: 'mp4', maxHeight: 240, outDir: out('scale') });
  const d = await info(down.output); assert.deepStrictEqual([d.width, d.height], [426, 240]);
  const same = await C.convertOne(clip, { format: 'mp4', maxHeight: 720, outDir: out('scale') });
  const s = await info(same.output); assert.deepStrictEqual([s.width, s.height], [640, 360]);
  const odd = mk('odd.mp4', ['-f', 'lavfi', '-i', 'testsrc2=size=642x362:rate=30:duration=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p']);
  const o = await C.convertOne(odd, { format: 'mp4', maxHeight: 240, outDir: out('scale') });
  const oi = await info(o.output); assert(oi.width % 2 === 0 && oi.height === 240, `${oi.width}x${oi.height}`);
});
test('frame-rate cap lowers the rate but never raises it', async () => {
  const lo = await info((await C.convertOne(clip, { format: 'mp4', fps: 15, outDir: out('fps') })).output);
  near(lo.fps, 15, 0.5, 'fps');
  const hi = await info((await C.convertOne(clip, { format: 'mp4', fps: 60, outDir: out('fps') })).output);
  near(hi.fps, 30, 0.5, 'fps stays');
});
test('remove audio, and strip metadata', async () => {
  const keep = await info((await C.convertOne(clip, { format: 'mp4', outDir: out('meta') })).output);
  assert(/SecretTitle/.test(keep.raw), 'title is kept by default');
  const noAudio = await info((await C.convertOne(clip, { format: 'mp4', audio: 'remove', outDir: out('meta') })).output);
  assert.strictEqual(noAudio.hasAudio, false);
  const stripped = await info((await C.convertOne(clip, { format: 'mp4', stripMeta: true, outDir: out('meta') })).output);
  assert(!/SecretTitle/.test(stripped.raw) && !/59\.3293/.test(stripped.raw), 'title and location removed');
  assert(!/SecretTitle/.test(fs.readFileSync((await C.convertOne(clip, { format: 'mp4', stripMeta: true, outDir: out('meta') })).output).toString('latin1')), 'not in the raw bytes either');
});
test('trimming: start and end', async () => {
  const t = await info((await C.convertOne(clip, { format: 'mp4', start: '1', end: '3.5', outDir: out('trim') })).output);
  near(t.durationSec, 2.5, 0.3, 'trimmed length');
  const tail = await info((await C.convertOne(clip, { format: 'mp4', start: '0:02', outDir: out('trim') })).output);
  near(tail.durationSec, 2, 0.3, 'from 2 s to the end');
  const head = await info((await C.convertOne(clip, { format: 'mp4', end: '1.5', outDir: out('trim') })).output);
  near(head.durationSec, 1.5, 0.3, 'first 1.5 s');
  await assert.rejects(C.convertOne(clip, { format: 'mp4', start: '9', outDir: out('trim') }), /past the end/);
});
test('GIF: animated, scaled, no sound, 256-colour palette, trimmed', async () => {
  const r = await C.convertOne(clip, { format: 'gif', gifWidth: 240, gifFps: 10, start: '0', end: '2', outDir: out('gif') });
  const buf = fs.readFileSync(r.output);
  assert.strictEqual(buf.toString('latin1', 0, 6), 'GIF89a');
  assert.strictEqual(buf.readUInt16LE(6), 240, 'logical screen width');
  const i = await info(r.output);
  assert.strictEqual(i.hasAudio, false);
  near(i.fps, 10, 1, 'frame rate');
  near(i.durationSec, 2, 0.4, 'length');
  assert.strictEqual(decodeErrors(r.output), '');
  assert(/\.gif$/.test(r.output));
});
test('target size: lands at or under the target (MP4 and WebM)', async () => {
  const mb = 0.45;
  for (const format of ['mp4', 'webm']) {
    const r = await C.convertOne(noisy, { format, targetMb: mb, outDir: out('target') });
    const size = fs.statSync(r.output).size / 1048576;
    assert(size <= mb * 1.12, `${format}: ${size.toFixed(3)} MB is over the ${mb} MB target`);
    assert(size >= mb * 0.5, `${format}: ${size.toFixed(3)} MB is far below the target, quality is being wasted`);
    assert.strictEqual(decodeErrors(r.output), '');
    console.log(`     ${format}: target ${mb} MB -> ${size.toFixed(3)} MB`);
  }
  await assert.rejects(C.convertOne(noisy, { format: 'mp4', targetMb: 0.1, outDir: out('target') }), /too small/);
});
test('never overwrites; temp files never left behind', async () => {
  const dir = out('twice');
  const a = await C.convertOne(clip, { format: 'mp4', outDir: dir }), b = await C.convertOne(clip, { format: 'mp4', outDir: dir });
  assert.notStrictEqual(a.output, b.output);
  assert(/clip \(1\)\.mp4$/.test(b.output), b.output);
  assert.deepStrictEqual(fs.readdirSync(dir).filter((f) => f.endsWith('.part')), []);
});
test('cancel: stops promptly, reports cancelled, removes the partial file', async () => {
  const dir = out('cancel');
  const ac = new AbortController();
  let progressed = false;
  const t0 = Date.now();
  const p = C.convertOne(noisyLong, { format: 'webm', quality: 'high', outDir: dir }, { signal: ac.signal, onProgress: (f) => { if (!progressed) { progressed = true; ac.abort(); } } });
  await assert.rejects(p, (e) => e.cancelled === true);
  assert(progressed, 'it should have started before being cancelled');
  assert(Date.now() - t0 < 30000);
  await new Promise((r) => setTimeout(r, 300));
  assert.deepStrictEqual(fs.existsSync(dir) ? fs.readdirSync(dir) : [], [], 'no files left behind');
});
test('bad input is explained', async () => {
  const audio = mk('tone.wav', ['-f', 'lavfi', '-i', 'sine=frequency=440:duration=1']);
  await assert.rejects(C.convertOne(audio.replace('.wav', '.wav'), { format: 'mp4', outDir: out('bad') }), /Unsupported file type/);
  const asMp4 = path.join(tmp, 'tone-as.mp4'); fs.copyFileSync(audio, asMp4);
  await assert.rejects(C.convertOne(asMp4, { format: 'mp4', outDir: out('bad') }), /sound but no video|Cannot read|no video/);
  const junk = path.join(tmp, 'junk.mp4'); fs.writeFileSync(junk, 'this is not a video at all');
  await assert.rejects(C.convertOne(junk, { format: 'mp4', outDir: out('bad') }), /Cannot read this file|Not a readable video/);
  const cut = path.join(tmp, 'cut.mp4'); fs.writeFileSync(cut, fs.readFileSync(clip).subarray(0, 3000));
  await assert.rejects(C.convertOne(cut, { format: 'mp4', outDir: out('bad') }), /Cannot read|Not a readable|ffmpeg|moov/i);
  await assert.rejects(C.convertOne('relative.mp4', { format: 'mp4' }), /absolute/);
  await assert.rejects(C.convertOne(path.join(tmp, 'missing.mp4'), { format: 'mp4' }), /Cannot read|No such file|Not a readable/i);
  assert(!fs.existsSync(out('bad')) || fs.readdirSync(out('bad')).length === 0, 'failures leave no output');
});

(async () => {
  await fixtures();
  let failed = 0, passed = 0;
  for (const [name, fn] of tests) {
    try { await fn(); passed++; console.log('ok   ' + name); } catch (e) { failed++; console.log('FAIL ' + name + '\n     ' + String((e && e.stack) || e).split('\n').slice(0, 5).join('\n     ')); }
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${passed}/${tests.length} passed`);
  process.exit(failed ? 1 : 0);
})();
