'use strict';
// Downloads the Whisper "small" speech model (OpenAI, MIT licence) as ONNX files with 8-bit weights, from the
// onnx-community/whisper-small_timestamped repository on Hugging Face at a pinned revision, into models/. The "timestamped"
// export is the same model whose decoder also hands out its cross-attention, which is what gives every word its own time.
// Idempotent: a file that is already there with the right size and SHA-256 is left alone. Each file is written as .part first.
const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');

const REVISION = '65caa70f294b46e1c33ff820aae6b16d048ab818';
const BASE = `https://huggingface.co/onnx-community/whisper-small_timestamped/resolve/${REVISION}/`;
const FILES = [
  { file: 'encoder_model_int8.onnx', remote: 'onnx/encoder_model_int8.onnx', bytes: 92240465, sha256: '496dac83b9392d70cc6f5d54a0abf0d6965e3fbf429910377e8c30dfecb2e1a7' },
  { file: 'decoder_model_merged_int8.onnx', remote: 'onnx/decoder_model_merged_int8.onnx', bytes: 156795750, sha256: 'c831996a6d5a535cf17447b0d7ecc36da6b72696e6fb906852ba6136b9199abb' },
  { file: 'tokenizer.json', remote: 'tokenizer.json', bytes: 2480466, sha256: '27fc476bfe7f17299480be2273fc0608e4d5a99aba2ab5dec5374b4482d1a566' },
  { file: 'config.json', remote: 'config.json', bytes: 2227, sha256: '457854d452f17661e197d74aee12b8e74fb75ba30ebfaa7426d0d61ea1e08a18' },
  { file: 'generation_config.json', remote: 'generation_config.json', bytes: 3893, sha256: 'f538b28220c6a6d6f1af1458d4141cacb4ef4963df3de98a19490440c412ddf0' },
];

const dir = path.join(__dirname, '..', 'models');

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file).on('data', (d) => h.update(d)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
  });
}

function download(url, to, label, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 6) return reject(new Error('Too many redirects'));
    https.get(url, { headers: { 'User-Agent': 'subtitle-maker-setup' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(download(new URL(res.headers.location, url).toString(), to, label, redirects + 1));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
      const total = Number(res.headers['content-length']) || 0;
      let got = 0; let lastPct = -1;
      const out = fs.createWriteStream(to);
      res.on('data', (c) => {
        got += c.length;
        if (total > 5e6) {
          const pct = Math.floor((got / total) * 100);
          if (pct !== lastPct && pct % 10 === 0) { lastPct = pct; console.log(`  ${label}: ${pct}% (${(got / 1048576).toFixed(0)} MB)`); }
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
  let fetched = 0;
  for (const f of FILES) {
    const dest = path.join(dir, f.file);
    if (fs.existsSync(dest) && fs.statSync(dest).size === f.bytes && (await sha256File(dest)) === f.sha256) continue;
    if (!fetched) console.log('Fetching the Whisper small model (~250 MB)...');
    fetched++;
    const part = dest + '.part';
    const size = await download(BASE + f.remote, part, f.file);
    if (size !== f.bytes) { fs.rmSync(part, { force: true }); throw new Error(`${f.file}: downloaded ${size} bytes, expected ${f.bytes}`); }
    const sum = await sha256File(part);
    if (sum !== f.sha256) { fs.rmSync(part, { force: true }); throw new Error(`${f.file}: checksum mismatch (${sum})`); }
    fs.renameSync(part, dest);
  }
  console.log(fetched ? `Model ready: ${dir}` : `Model already present: ${dir}`);
})().catch((e) => { console.error('Model download failed:', e.message); process.exit(1); });
