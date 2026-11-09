'use strict';
// Downloads the ISNet "general use" background-removal model (ONNX, ~170 MB) into models/. The network is the one from the
// DIS project (Apache-2.0, Xuebin Qin et al.); the ONNX file is the one the rembg project publishes (MIT).
// Idempotent: does nothing when the file is already there and its SHA-256 matches. Writes a .part file first.
const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');

const MODEL = {
  file: 'isnet-general-use.onnx',
  url: 'https://github.com/danielgatis/rembg/releases/download/v0.0.0/isnet-general-use.onnx',
  sha256: '60920e99c45464f2ba57bee2ad08c919a52bbf852739e96947fbb4358c0d964a',
  bytes: 178648008,
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
    https.get(url, { headers: { 'User-Agent': 'background-remover-setup' } }, (res) => {
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
  if (fs.existsSync(dest) && fs.statSync(dest).size === MODEL.bytes) {
    if ((await sha256File(dest)) === MODEL.sha256) { console.log('Model already present:', dest); return; }
    console.log('Model file does not match the pinned checksum; fetching again.');
  }
  console.log('Fetching the ISNet background-removal model (~170 MB)...');
  const part = dest + '.part';
  const size = await download(MODEL.url, part);
  if (size !== MODEL.bytes) { fs.rmSync(part, { force: true }); throw new Error(`Download is ${size} bytes, expected ${MODEL.bytes}.`); }
  const sum = await sha256File(part);
  if (sum !== MODEL.sha256) { fs.rmSync(part, { force: true }); throw new Error('Checksum mismatch: ' + sum); }
  fs.renameSync(part, dest);
  console.log('Model ready:', dest);
})().catch((e) => { console.error('Model download failed:', e.message); process.exit(1); });
