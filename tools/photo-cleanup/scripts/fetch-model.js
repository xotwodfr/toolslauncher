'use strict';
// Downloads the two offline models Photo Cleanup ships with into models/ (run at build time by dist:win / dist:linux; the
// app itself never downloads anything):
//   - LaMa inpainting ("big-lama", Apache-2.0, Suvorov et al. / advimman), the ONNX export published by Carve (Apache-2.0).
//     Fills the area of a removed object, and the new area when a photo is extended.
//   - MobileSAM (Apache-2.0, Zhang et al.) image encoder plus the Segment Anything mask decoder (Apache-2.0, Meta AI), the ONNX
//     exports published by Acly (MIT). Outlines the object the user taps.
// Each file is pinned by repository revision, size and SHA-256. Idempotent: a file that is already there with the right
// checksum is left alone. Writes a .part file first, so an interrupted download never looks finished.
const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');

const MODELS = [
  {
    file: 'lama_fp32.onnx',
    url: 'https://huggingface.co/Carve/LaMa-ONNX/resolve/c3c0c9e468934d62e79c329e35d82dd09ff8c444/lama_fp32.onnx',
    sha256: '1faef5301d78db7dda502fe59966957ec4b79dd64e16f03ed96913c7a4eb68d6',
    bytes: 208044816,
  },
  {
    file: 'mobile_sam_image_encoder.onnx',
    url: 'https://huggingface.co/Acly/MobileSAM/resolve/0d3b403339b4674a82493d5e97964dd78089ddc8/mobile_sam_image_encoder.onnx',
    sha256: '580f5fb648ea1062c0aabc26217aed56921985f03f0cbbd852bba81d760cc749',
    bytes: 28157093,
  },
  {
    file: 'sam_mask_decoder_multi.onnx',
    url: 'https://huggingface.co/Acly/MobileSAM/resolve/0d3b403339b4674a82493d5e97964dd78089ddc8/sam_mask_decoder_multi.onnx',
    sha256: '8976b90a87ba50a6a72217a5ff994f7d25ce16f2229fcc1ed259e1294c622ffe',
    bytes: 16496559,
  },
];

const dir = path.join(__dirname, '..', 'models');

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file).on('data', (d) => h.update(d)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
  });
}

function download(url, to, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 8) return reject(new Error('Too many redirects'));
    https.get(url, { headers: { 'User-Agent': 'photo-cleanup-setup' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(download(new URL(res.headers.location, url).toString(), to, redirects + 1));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
      const total = Number(res.headers['content-length']) || 0;
      let got = 0; let lastPct = -1;
      const out = fs.createWriteStream(to);
      res.on('data', (c) => {
        got += c.length;
        if (total) {
          const pct = Math.floor((got / total) * 100);
          if (pct !== lastPct && pct % 20 === 0) { lastPct = pct; console.log(`  ${pct}% (${(got / 1048576).toFixed(0)} MB)`); }
        }
      });
      res.pipe(out);
      out.on('finish', () => out.close(() => resolve(got)));
      out.on('error', reject);
      res.on('error', reject);
    }).on('error', reject);
  });
}

async function fetchOne(m) {
  const dest = path.join(dir, m.file);
  if (fs.existsSync(dest) && fs.statSync(dest).size === m.bytes) {
    if ((await sha256File(dest)) === m.sha256) { console.log('Model already present:', m.file); return; }
    console.log(m.file + ' does not match the pinned checksum; fetching again.');
  }
  console.log(`Fetching ${m.file} (${(m.bytes / 1048576).toFixed(0)} MB)...`);
  const part = dest + '.part';
  const size = await download(m.url, part);
  if (size !== m.bytes) { fs.rmSync(part, { force: true }); throw new Error(`${m.file}: download is ${size} bytes, expected ${m.bytes}.`); }
  const sum = await sha256File(part);
  if (sum !== m.sha256) { fs.rmSync(part, { force: true }); throw new Error(`${m.file}: checksum mismatch: ${sum}`); }
  fs.renameSync(part, dest);
  console.log('Model ready:', dest);
}

(async () => {
  fs.mkdirSync(dir, { recursive: true });
  // files in models/ that are not pinned here would be packaged too (files: models/*.onnx); remove them
  for (const f of fs.readdirSync(dir)) if (!MODELS.some((m) => m.file === f)) { fs.rmSync(path.join(dir, f), { force: true }); console.log('Removed unpinned file:', f); }
  for (const m of MODELS) await fetchOne(m);
})().catch((e) => { console.error('Model download failed:', e.message); process.exit(1); });
