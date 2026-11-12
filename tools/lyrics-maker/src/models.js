'use strict';
// The speech models Lyrics Maker can use. "standard" (Whisper small) is inside the app. "accurate" (Whisper large-v3-turbo) is
// better at singing, accents and fast words, but about 1.1 GB, so it is not in the download for everyone: the user can fetch it
// once, from the app, and from then on it works offline like the other. Every file is pinned (a fixed revision, size and SHA-256)
// and checked before it is used, so a damaged or swapped file is never loaded. Electron-free (testable with plain Node): the
// caller passes the fetch function (Electron's net.fetch in the app, which follows the computer's proxy settings).
let fs;
try { fs = require('original-fs'); } catch { fs = require('fs'); }
const path = require('path');
const crypto = require('crypto');

const MODEL_FILES = ['encoder_model_int8.onnx', 'decoder_model_merged_int8.onnx', 'tokenizer.json', 'config.json', 'generation_config.json'];

const TURBO_REPO = 'onnx-community/whisper-large-v3-turbo_timestamped';
const TURBO_REV = 'b3f77bf9a8c4d5ea3415827033d1ffea7955fd9a';
const MODELS = {
  standard: { id: 'standard', name: 'Standard', detail: 'Whisper small, inside the app', bundled: true, speed: 1 },
  accurate: {
    id: 'accurate', name: 'Accurate', detail: 'Whisper large-v3-turbo, a one-time 1.1 GB download', bundled: false,
    speed: 0, // set below from the measured factor
    folder: `whisper-large-v3-turbo-${TURBO_REV.slice(0, 7)}`,
    files: [
      // name in the folder, path in the repository, size, SHA-256 (the JSON files' hashes were measured on the pinned revision)
      { name: 'tokenizer.json', from: 'tokenizer.json', size: 2480645, sha256: 'b3c8202bbf06d8ee4232c5984baa563784ac4737e2e7fdc42fa180200d3cfcdb' },
      { name: 'config.json', from: 'config.json', size: 1330, sha256: '32c02d1dfb9a93ff236cdcf0f741f8f3a4cedb437c407a361a022451ac009131' },
      { name: 'generation_config.json', from: 'generation_config.json', size: 3797, sha256: '8568ddf83476167b4607014956b87142763fa6923e71259a606734beb39bdfc8' },
      { name: 'decoder_model_merged_int8.onnx', from: 'onnx/decoder_model_merged_int8.onnx', size: 439997434, sha256: 'b4ab1c92a9bcf8c8fdc49deacb57ac51b707d5248bc7868af42371b896c3ae52' },
      { name: 'encoder_model_int8.onnx', from: 'onnx/encoder_model_int8.onnx', size: 644883258, sha256: '3cb43fe7c779110a2f33635fbe24d0db175720834215cb1e4dcc51d4786af156' },
    ],
  },
};
MODELS.accurate.bytes = MODELS.accurate.files.reduce((s, f) => s + f.size, 0);
const urlFor = (f) => `https://huggingface.co/${TURBO_REPO}/resolve/${TURBO_REV}/${f.from}`;
const MARK = 'verified.json';

const known = (id) => { if (!Object.prototype.hasOwnProperty.call(MODELS, id)) throw new Error('Unknown model'); return MODELS[id]; };

/** The folder a model's files are in. */
function dirFor(id, { bundledDir, userDir }) {
  const m = known(id);
  return m.bundled ? bundledDir : path.join(userDir, 'models', m.folder);
}

/** Is the model there and checked? (Downloaded files are hashed once, when they arrive; after that their sizes are checked.) */
function installed(id, dirs) {
  const m = known(id);
  const dir = dirFor(id, dirs);
  if (m.bundled) return MODEL_FILES.every((f) => fs.existsSync(path.join(dir, f)));
  try {
    const mark = JSON.parse(fs.readFileSync(path.join(dir, MARK), 'utf8'));
    if (mark.revision !== TURBO_REV) return false;
    return m.files.every((f) => { try { return fs.statSync(path.join(dir, f.name)).size === f.size; } catch { return false; } });
  } catch { return false; }
}

const cancelled = () => Object.assign(new Error('Cancelled'), { cancelled: true });

/**
 * Fetch a downloadable model into its folder: each file is written as "<name>.part" while its SHA-256 is worked out, checked
 * (size and hash), and only then renamed into place. Files that are already there and right are kept, so an interrupted
 * download goes on where it stopped (file by file). Nothing outside the model's own folder is ever written.
 * @param {string} id
 * @param {{bundledDir:string,userDir:string}} dirs
 * @param {{ fetch: (url:string, init:object) => Promise<Response>, signal?: AbortSignal, onProgress?: (p:{done:number,total:number,file:string}) => void, urlFor?: Function }} o
 */
async function download(id, dirs, { fetch: doFetch, signal, onProgress = () => {}, urlFor: makeUrl = urlFor, model } = {}) {
  const m = model || known(id);               // `model`: a stand-in description, for tests
  if (m.bundled) return;
  const dir = model ? path.join(dirs.userDir, 'models', m.folder) : dirFor(id, dirs);
  await fs.promises.mkdir(dir, { recursive: true });
  let done = 0;
  const total = m.bytes;
  for (const f of m.files) {
    if (signal && signal.aborted) throw cancelled();
    const dest = path.join(dir, f.name);
    const have = await fs.promises.stat(dest).catch(() => null);
    if (have && have.size === f.size && (await hashFile(dest)) === f.sha256) { done += f.size; onProgress({ done, total, file: f.name }); continue; }
    const part = dest + '.part';
    const res = await doFetch(makeUrl(f), { signal, redirect: 'follow' });
    if (!res.ok || !res.body) throw new Error(`The download failed (${res.status} for ${f.name}). Check the internet connection and try again.`);
    const hash = crypto.createHash('sha256');
    const fh = await fs.promises.open(part, 'w');
    let got = 0;
    try {
      const reader = res.body.getReader();
      for (;;) {
        if (signal && signal.aborted) { try { await reader.cancel(); } catch { /* ignore */ } throw cancelled(); }
        const { value, done: end } = await reader.read();
        if (end) break;
        const buf = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
        hash.update(buf); await fh.write(buf); got += buf.length;
        if (got > f.size) throw new Error(`${f.name} is bigger than expected; the download was stopped.`);
        onProgress({ done: done + got, total, file: f.name });
      }
    } catch (e) {
      await fh.close().catch(() => {}); await fs.promises.rm(part, { force: true }).catch(() => {});
      throw e;
    }
    await fh.close();
    const sha = hash.digest('hex');
    if (got !== f.size || sha !== f.sha256) {
      await fs.promises.rm(part, { force: true }).catch(() => {});
      throw new Error(`${f.name} did not arrive intact (${got} of ${f.size} bytes, or a different file). Nothing was kept; try again.`);
    }
    await fs.promises.rename(part, dest);
    done += f.size;
  }
  await fs.promises.writeFile(path.join(dir, MARK), JSON.stringify({ repository: TURBO_REPO, revision: TURBO_REV, files: m.files.map((f) => ({ name: f.name, size: f.size, sha256: f.sha256 })) }, null, 2));
}

function hashFile(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file).on('data', (d) => h.update(d)).on('error', reject).on('end', () => resolve(h.digest('hex')));
  });
}

/** Delete a downloaded model (only its own folder). */
async function remove(id, dirs) {
  const m = known(id);
  if (m.bundled) throw new Error('The standard model is part of the app');
  await fs.promises.rm(dirFor(id, dirs), { recursive: true, force: true });
}

/** [{ id, name, detail, installed, bytes, bundled }] for the window. */
const list = (dirs) => Object.values(MODELS).map((m) => ({ id: m.id, name: m.name, detail: m.detail, bundled: m.bundled, bytes: m.bytes || 0, installed: installed(m.id, dirs) }));

module.exports = { MODELS, MODEL_FILES, TURBO_REPO, TURBO_REV, urlFor, dirFor, installed, download, remove, list, hashFile };
