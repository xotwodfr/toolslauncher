'use strict';
// Used by `--self-test`: proves every output format (and the new input decoders) work in THIS build.
const fs = require('fs');
const os = require('os');
const path = require('path');
const sharp = require('sharp');
const { convertOne } = require('./convert');
const { FORMATS } = require('./formats');

async function run() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-selftest-'));
  const W = 64, H = 48, px = Buffer.alloc(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const o = (y * W + x) * 4; px[o] = x * 4; px[o + 1] = y * 5; px[o + 2] = 128; px[o + 3] = x > 48 ? 0 : 255;
  }
  const src = path.join(dir, 'src.png');
  await sharp(px, { raw: { width: W, height: H, channels: 4 } }).png().toFile(src);
  const results = [];
  for (const id of Object.keys(FORMATS)) {
    const r = { format: id, ok: false };
    try {
      const out = await convertOne(src, { format: id, outDir: dir, icoSizes: [16, 32] });
      r.bytes = out.outBytes; r.file = path.basename(out.output);
      if (!(out.outBytes > 0) || fs.statSync(out.output).size !== out.outBytes) throw new Error('bad output size');
      // read it back through the app's own input path where the format can be read
      if (!['pdf'].includes(id)) {
        const back = await convertOne(out.output, { format: 'png', outDir: path.join(dir, 'back') });
        const meta = await sharp(back.output).metadata();
        r.readBack = `${meta.width}x${meta.height}`;
        const want = id === 'ico' ? 32 : null;
        if (want ? meta.width !== want : (meta.width !== W || meta.height !== H)) throw new Error(`read back as ${meta.width}x${meta.height}`);
      }
      r.ok = true;
    } catch (e) { r.error = String(e && e.message || e); }
    results.push(r);
  }
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* temp dir cleanup is best effort */ }
  return results;
}

module.exports = { run };
