'use strict';
// Downloads the Demucs 6-stem ONNX model (MIT licence, StemSplitio/htdemucs-6s-onnx on Hugging Face) into models/, for the
// optional "Isolate vocals first" step (src/vocals.js). Same pinned file as tools/stem-splitter (copied: each tool is packaged alone).
// Idempotent: does nothing when the file is already there and its SHA-256 matches. Writes a .part file first.
const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');

const MODEL = {
  file: 'htdemucs_6s_fp16weights.onnx',
  url: 'https://huggingface.co/StemSplitio/htdemucs-6s-onnx/resolve/main/htdemucs_6s_fp16weights.onnx',
  // Filled in after the first verified download; an empty value means "trust size only" (printed so it can be pinned).
  sha256: '7ce55792e2231c93fbf92de95f5fd5b3a5e6c89f7db690dfd693e8f1dce56869',
  minBytes: 100 * 1024 * 1024,
};

const dir = path.join(__dirname, '..', 'models');
const dest = path.join(dir, MODEL.file);

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file).on('data', (d) => h.update(d)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
  });
}

function download(url, to, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 6) return reject(new Error('Too many redirects'));
    https.get(url, { headers: { 'User-Agent': 'lyrics-maker-setup' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(download(new URL(res.headers.location, url).toString(), to, redirects + 1));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
      const total = Number(res.headers['content-length']) || 0;
      let got = 0, lastPct = -1;
      const out = fs.createWriteStream(to);
      res.on('data', (c) => {
        got += c.length;
        if (total) {
          const pct = Math.floor((got / total) * 100);
          if (pct !== lastPct && pct % 10 === 0) { lastPct = pct; console.log(`  ${pct}% (${(got / 1048576).toFixed(0)} MB)`); }
        }
      });
      res.pipe(out);
      out.on('finish', () => out.close(() => resolve(got)));
      out.on('error', reject);
      res.on('error', reject);
    }).on('error', reject);
  });
}

(async () => {
  fs.mkdirSync(dir, { recursive: true });
  if (fs.existsSync(dest) && fs.statSync(dest).size >= MODEL.minBytes) {
    if (!MODEL.sha256 || (await sha256File(dest)) === MODEL.sha256) { console.log('Model already present:', dest); return; }
    console.log('Model file does not match the pinned checksum; fetching again.');
  }
  console.log('Fetching the Demucs 6-stem model (~136 MB)...');
  const part = dest + '.part';
  const size = await download(MODEL.url, part);
  if (size < MODEL.minBytes) throw new Error(`Download too small (${size} bytes).`);
  const sum = await sha256File(part);
  if (MODEL.sha256 && sum !== MODEL.sha256) { fs.rmSync(part, { force: true }); throw new Error('Checksum mismatch: ' + sum); }
  fs.renameSync(part, dest);
  console.log('Model ready:', dest);
  console.log('SHA-256:', sum);
})().catch((e) => { console.error('Model download failed:', e.message); process.exit(1); });
