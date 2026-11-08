'use strict';
// Makes a short test clip with the bundled ffmpeg and converts it to every format, checking each result by reading it
// back. Used by `--self-test=` to prove a packaged build works.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const C = require('./convert');

async function run() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vidconv-selftest-'));
  const results = [];
  const step = async (name, fn) => { try { results.push({ name, ok: true, detail: await fn() }); } catch (e) { results.push({ name, ok: false, error: String((e && e.message) || e) }); } };
  try {
    await step('bundled ffmpeg has the encoders', async () => {
      const r = await C.checkEncoders();
      if (!r.ok) throw new Error('missing encoders: ' + r.missing.join(', '));
      return 'ok';
    });
    const clip = path.join(dir, 'clip.mp4');
    await step('make a test clip', async () => {
      const r = spawnSync(C.ffmpegPath(), ['-hide_banner', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=15:duration=2', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', clip], { encoding: 'utf8', windowsHide: true });
      if (r.status !== 0) throw new Error(String(r.stderr).slice(-200));
      return `${fs.statSync(clip).size} bytes`;
    });
    for (const [format, extra] of [['mp4', {}], ['webm', {}], ['gif', { gifWidth: 240 }], ['mp4', { targetMb: 0.2 }]]) {
      await step(`convert to ${format}${extra.targetMb ? ' (two-pass size target)' : ''}`, async () => {
        const r = await C.convertOne(clip, { format, outDir: dir, ...extra });
        const i = await C.probe(r.output);
        if (format === 'gif' ? i.width !== 240 : !i.width) throw new Error('unexpected result size');
        return `${r.outBytes} bytes, ${i.width}x${i.height}, ${i.codec}`;
      });
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return results;
}

module.exports = { run };
