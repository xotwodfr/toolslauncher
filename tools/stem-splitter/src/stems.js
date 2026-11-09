'use strict';
// Electron-free processing (testable with plain Node): reading a song, running the Demucs model over it in overlapping
// segments, keeping the six stems in a cache folder, and mixing a chosen combination into a new file with ffmpeg.
// Originals are only ever read. Every result is built in a ".part" name and renamed when complete, so a cancelled or
// crashed run leaves nothing half-made behind.
let fs;
try { fs = require('original-fs'); } catch { fs = require('fs'); }
const crypto = require('crypto');
const path = require('path');
const { spawn } = require('child_process');
const { Worker } = require('worker_threads');
const P = require('./plan');

const { UserError } = P;
const MODEL_ID = 'htdemucs_6s-fp16-v1';
const MODEL_FILE = 'htdemucs_6s_fp16weights.onnx';
const CACHE_VERSION = 1;
const FRAME_BYTES = 8; // raw decode is stereo float32

const cancelled = () => Object.assign(new Error('Cancelled'), { cancelled: true });
const asarFix = (p) => p.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');

/** The bundled ffmpeg (unpacked from asar when packaged), else `ffmpeg` on PATH. */
function ffmpegPath() {
  try {
    const p = require('ffmpeg-static');
    if (p) { const real = asarFix(p); if (fs.existsSync(real)) return real; }
  } catch { /* fall through */ }
  return 'ffmpeg';
}

/** Where the model file is (unpacked from asar when packaged). */
const modelPath = () => asarFix(path.join(__dirname, '..', 'models', MODEL_FILE));

// ---- running ffmpeg --------------------------------------------------------------------------------------------------
/** Run ffmpeg to completion. `hooks.signal` aborts it; `onSeconds(t)` is told how far along the output is. */
function run(args, hooks = {}, onSeconds = null) {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpegPath(), args, { windowsHide: true });
    let err = '';
    let buf = '';
    p.stdout.setEncoding('utf8'); p.stderr.setEncoding('utf8');
    const onAbort = () => { p.kill('SIGKILL'); };
    if (hooks.signal) { if (hooks.signal.aborted) onAbort(); else hooks.signal.addEventListener('abort', onAbort, { once: true }); }
    p.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        const m = /^out_time_(?:us|ms)=(\d+)/.exec(line); // both report microseconds
        if (m && onSeconds) onSeconds(Number(m[1]) / 1e6);
      }
    });
    p.stderr.on('data', (d) => { err += d; if (err.length > 120000) err = err.slice(-120000); });
    p.on('error', (e) => reject(new Error(e.code === 'ENOENT' ? 'ffmpeg was not found' : e.message)));
    p.on('close', (code) => {
      if (hooks.signal) hooks.signal.removeEventListener('abort', onAbort);
      if (hooks.signal && hooks.signal.aborted) return reject(cancelled());
      if (code === 0) return resolve(err);
      const lines = err.trim().split(/\r?\n/).filter(Boolean);
      reject(new Error(lines.length ? lines[lines.length - 1].slice(0, 220) : `ffmpeg exited with code ${code}`));
    });
  });
}

const ffmpegText = (args) => new Promise((resolve, reject) => {
  const p = spawn(ffmpegPath(), ['-hide_banner', ...args], { windowsHide: true });
  let out = '';
  p.stdout.setEncoding('utf8');
  p.stdout.on('data', (d) => { out += d; });
  p.on('error', (e) => reject(new Error(e.code === 'ENOENT' ? 'ffmpeg was not found' : e.message)));
  p.on('close', () => resolve(out));
});

/** Does the bundled ffmpeg have what saving needs (the three encoders and the two mixing filters)? */
async function checkEncoders() {
  const enc = await ffmpegText(['-encoders']);
  const fil = await ffmpegText(['-filters']);
  const missing = [];
  for (const e of ['libmp3lame', 'flac', 'pcm_s16le']) if (!new RegExp(`\\s${e}\\s`).test(enc)) missing.push(e);
  for (const f of ['amix', 'alimiter', 'volume']) if (!new RegExp(`\\s${f}\\s`).test(fil)) missing.push(f);
  return { ok: missing.length === 0, missing };
}

/** What ffmpeg says about a file: length, sample rate. Throws a readable error if it isn't audio. */
function probe(input) {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpegPath(), ['-hide_banner', '-nostdin', '-protocol_whitelist', 'file', '-i', input], { windowsHide: true });
    let err = '';
    p.stderr.setEncoding('utf8');
    p.stderr.on('data', (d) => { err += d; if (err.length > 300000) err = err.slice(-300000); });
    p.on('error', (e) => reject(new UserError(e.code === 'ENOENT' ? 'ffmpeg was not found' : e.message)));
    p.on('close', () => {
      const dur = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(err);
      if (!dur) {
        const reason = /No such file|Invalid data|does not contain any stream|Permission denied|Duration: N\/A/i.exec(err);
        return reject(new UserError(reason ? `Cannot read this file (${reason[0].toLowerCase()})` : 'Not a readable audio file'));
      }
      const audio = /Stream #0:(\d+)[^\n]*?: Audio: ([^\n]*)/.exec(err);
      if (!audio) return reject(new UserError('This file has no audio'));
      const rate = /(\d+) Hz/.exec(audio[2]);
      resolve({ duration: Number(dur[1]) * 3600 + Number(dur[2]) * 60 + Number(dur[3]), rate: rate ? Number(rate[1]) : 44100, codec: audio[2].split(/[,(\s]/)[0] });
    });
  });
}

/** Decode any audio file to raw stereo float32 at 44.1 kHz (what the model wants). Returns the number of frames. */
async function decodeToRaw(input, outFile, { signal, duration = 0, onFraction } = {}) {
  const args = ['-hide_banner', '-nostdin', '-loglevel', 'error', '-nostats', '-progress', 'pipe:1', '-protocol_whitelist', 'file', '-i', input,
    '-vn', '-map', '0:a:0', '-ac', '2', '-ar', String(P.SAMPLE_RATE), '-f', 'f32le', '-y', outFile];
  await run(args, { signal }, (t) => { if (onFraction && duration > 0) onFraction(Math.min(1, t / duration)); });
  const bytes = fs.statSync(outFile).size;
  if (bytes < FRAME_BYTES) throw new UserError('This file has no sound');
  return Math.floor(bytes / FRAME_BYTES);
}

// ---- writing stems -----------------------------------------------------------------------------------------------------
/** A 16-bit stereo WAV written as the audio arrives; the header is filled in when it is closed. */
class WavWriter {
  constructor(file, rate = P.SAMPLE_RATE, channels = 2) {
    this.fd = fs.openSync(file, 'w');
    this.rate = rate; this.channels = channels; this.bytes = 0;
    fs.writeSync(this.fd, Buffer.alloc(44));
  }
  write(buf) { fs.writeSync(this.fd, buf); this.bytes += buf.length; }
  close() {
    const h = Buffer.alloc(44);
    h.write('RIFF', 0); h.writeUInt32LE(36 + this.bytes, 4); h.write('WAVEfmt ', 8); h.writeUInt32LE(16, 16);
    h.writeUInt16LE(1, 20); h.writeUInt16LE(this.channels, 22); h.writeUInt32LE(this.rate, 24);
    h.writeUInt32LE(this.rate * this.channels * 2, 28); h.writeUInt16LE(this.channels * 2, 32); h.writeUInt16LE(16, 34);
    h.write('data', 36); h.writeUInt32LE(this.bytes, 40);
    fs.writeSync(this.fd, h, 0, 44, 0);
    fs.closeSync(this.fd);
  }
}

// ---- the model -------------------------------------------------------------------------------------------------------
/**
 * onnxruntime settings. The CPU memory arena and the memory pattern are OFF on purpose. Measured on Windows with a
 * thread sampling the process every 2 ms: with the arena on, memory stays at about 4.7 GB the whole time the song is
 * being separated; with it off it peaks at about 2.5 GB while separating, the output is identical and a segment takes
 * about 10% longer. (Both peak at about 4.5 GB for a few seconds while the model loads: onnxruntime's constant folding
 * of the graph. Switching that off removes the spike but makes every segment 1.8x slower, so it is left on.)
 */
const SESSION_OPTIONS = Object.freeze({ executionProviders: ['cpu'], graphOptimizationLevel: 'all', enableCpuMemArena: false, enableMemPattern: false });

/**
 * Loads the Demucs model (onnxruntime, on the CPU) in a worker thread, so the calling thread stays free (see infer-worker.js).
 * `infer(planar)`: Float32Array(2*SEGMENT) -> Promise<Float32Array(6*2*SEGMENT)>. `release()` stops the thread.
 */
async function createRunner(file = modelPath()) {
  if (!fs.existsSync(file)) throw new UserError('The separation model is missing. Run "npm run setup" in the tool folder to download it.');
  const N = P.SEGMENT;
  const worker = new Worker(path.join(__dirname, 'infer-worker.js'), { workerData: { file, segment: N, options: { ...SESSION_OPTIONS } } });
  const pending = new Map();                 // id -> { resolve, reject }
  let nextId = 1;
  let dead = null;                           // set when the thread has failed or stopped
  let onReady = null;
  const ready = new Promise((resolve, reject) => { onReady = { resolve, reject }; });
  const failAll = (err) => { dead = dead || err; for (const p of pending.values()) p.reject(err); pending.clear(); onReady.reject(err); };
  worker.on('message', (m) => {
    if (m.type === 'ready') onReady.resolve();
    else if (m.type === 'result' || (m.type === 'error' && m.id !== -1)) {
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      if (m.type === 'result') p.resolve(m.out); else p.reject(new Error(m.message));
    } else if (m.type === 'error') failAll(new Error(m.message));
  });
  worker.on('error', (e) => failAll(e));
  worker.on('exit', (code) => failAll(new Error(`The model process stopped unexpectedly (code ${code})`)));
  await ready;
  return {
    segment: N,
    infer(planar) {
      if (dead) return Promise.reject(dead);
      return new Promise((resolve, reject) => {
        const id = nextId++;
        pending.set(id, { resolve, reject });
        worker.postMessage({ type: 'run', id, input: planar });   // copied, so the caller can reuse its buffer
      });
    },
    async release() {
      dead = dead || new Error('The model was released');
      await worker.terminate();
    },
  };
}

// ---- separating --------------------------------------------------------------------------------------------------------
/**
 * Runs `runner` over the raw decoded song in overlapping segments, blends the overlaps with a triangle window and writes
 * the six stems as WAVs into `outDir` as it goes (only about two segments of audio are in memory at any time).
 * onProgress({ done, count, etaSeconds }) after every segment.
 */
async function separate({ rawFile, frames, runner, outDir, signal, onProgress, overlap = P.OVERLAP }) {
  const N = runner.segment;
  const plan = P.segmentPlan(frames, N, overlap);
  const S = plan.stride;
  const w = P.weights(N);
  const order = P.MODEL_ORDER;                       // model output index -> stem id
  const acc = new Float32Array(6 * 2 * N);           // weighted sum of the segments covering the current window
  const wsum = new Float32Array(N);
  const planar = new Float32Array(2 * N);
  const raw = new Float32Array(2 * N);               // one segment of interleaved input
  const rawBytes = Buffer.from(raw.buffer);
  const writers = order.map((id) => new WavWriter(path.join(outDir, P.stemFile(id))));
  const fd = fs.openSync(rawFile, 'r');
  const t0 = Date.now();
  try {
    for (let k = 0; k < plan.count; k++) {
      if (signal && signal.aborted) throw cancelled();
      const start = plan.starts[k];
      const have = Math.min(N, frames - start);
      const got = fs.readSync(fd, rawBytes, 0, have * FRAME_BYTES, start * FRAME_BYTES);
      if (got < have * FRAME_BYTES) throw new Error('The decoded audio is shorter than expected');
      planar.fill(0);
      for (let i = 0; i < have; i++) { planar[i] = raw[2 * i]; planar[N + i] = raw[2 * i + 1]; }
      const out = await runner.infer(planar);
      if (signal && signal.aborted) throw cancelled();

      for (let i = 0; i < have; i++) wsum[i] += w[i];
      for (let c = 0; c < 12; c++) {
        const base = c * N;
        for (let i = 0; i < have; i++) acc[base + i] += out[base + i] * w[i];
      }

      const last = k === plan.count - 1;
      const emit = last ? have : S;                  // everything before the next segment starts is final
      for (let s = 0; s < 6; s++) {
        const buf = Buffer.allocUnsafe(emit * 4);
        const bl = s * 2 * N;
        const br = bl + N;
        for (let i = 0; i < emit; i++) {
          const inv = 1 / wsum[i];
          let l = acc[bl + i] * inv;
          let r = acc[br + i] * inv;
          l = l > 1 ? 1 : l < -1 ? -1 : l;
          r = r > 1 ? 1 : r < -1 ? -1 : r;
          buf.writeInt16LE(Math.round(l * 32767), i * 4);
          buf.writeInt16LE(Math.round(r * 32767), i * 4 + 2);
        }
        writers[s].write(buf);
      }
      if (!last) {                                   // slide the window forward by one stride
        for (let c = 0; c < 12; c++) {
          const base = c * N;
          acc.copyWithin(base, base + S, base + N);
          acc.fill(0, base + N - S, base + N);
        }
        wsum.copyWithin(0, S, N);
        wsum.fill(0, N - S, N);
      }
      if (onProgress) {
        const done = k + 1;
        const elapsed = (Date.now() - t0) / 1000;
        onProgress({ done, count: plan.count, etaSeconds: done < plan.count ? (elapsed / done) * (plan.count - done) : 0 });
      }
    }
  } finally {
    fs.closeSync(fd);
    for (const wr of writers) { try { wr.close(); } catch { /* already closed */ } }
  }
  return { segments: plan.count, seconds: (Date.now() - t0) / 1000 };
}

// ---- the stem cache --------------------------------------------------------------------------------------------------------
/** Same song file + same model = same key. */
function cacheKey(source) {
  const st = fs.statSync(source);
  const h = crypto.createHash('sha1').update(`${CACHE_VERSION}|${MODEL_ID}|${path.resolve(source)}|${st.size}|${Math.round(st.mtimeMs)}`).digest('hex');
  return h.slice(0, 20);
}
const KEY_RE = /^[0-9a-f]{20}$/;
const isKey = (k) => typeof k === 'string' && KEY_RE.test(k);
const dirFor = (root, key) => { if (!isKey(key)) throw new Error('Bad key'); return path.join(root, key); };

/** The saved result for a key, or null when it is missing, from another model, or damaged. */
function readCache(root, key) {
  const dir = dirFor(root, key);
  let meta;
  try { meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8')); } catch { return null; }
  if (!meta || meta.version !== CACHE_VERSION || meta.model !== MODEL_ID || !(meta.frames > 0)) return null;
  const expect = meta.frames * 4 + 44;
  for (const id of P.STEM_IDS) {
    try { if (fs.statSync(path.join(dir, P.stemFile(id))).size !== expect) return null; } catch { return null; }
  }
  return { dir, meta };
}

const writeMeta = (dir, meta) => fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta));

/**
 * The six stems of `source`: from the cache if they were made before, otherwise separated now.
 * `getRunner()` is only called when there is work to do. Reports { phase: 'read'|'load'|'separate', fraction, etaSeconds }.
 */
async function ensureStems({ source, root, getRunner, signal, onProgress = () => {} }) {
  const info = await probe(source);
  const key = cacheKey(source);
  const dir = dirFor(root, key);
  const hit = readCache(root, key);
  if (hit) {
    hit.meta.lastUsed = Date.now();
    try { writeMeta(hit.dir, hit.meta); } catch { /* read-only cache is fine */ }
    return { key, dir, meta: hit.meta, fromCache: true };
  }

  fs.mkdirSync(root, { recursive: true });
  const part = dir + '.part';
  fs.rmSync(part, { recursive: true, force: true });
  fs.mkdirSync(part, { recursive: true });
  const rawFile = path.join(part, 'mix.f32');
  try {
    onProgress({ phase: 'read', fraction: 0 });
    const frames = await decodeToRaw(source, rawFile, { signal, duration: info.duration, onFraction: (f) => onProgress({ phase: 'read', fraction: f * 0.03 }) });
    if (signal && signal.aborted) throw cancelled();
    onProgress({ phase: 'load', fraction: 0.03 });
    const runner = await getRunner();
    if (signal && signal.aborted) throw cancelled();
    const r = await separate({
      rawFile, frames, runner, outDir: part, signal,
      onProgress: (p) => onProgress({ phase: 'separate', fraction: 0.03 + 0.97 * (p.done / p.count), etaSeconds: p.etaSeconds }),
    });
    fs.rmSync(rawFile, { force: true });
    const meta = {
      version: CACHE_VERSION, model: MODEL_ID, key, source: path.resolve(source), name: path.basename(source),
      frames, rate: P.SAMPLE_RATE, duration: frames / P.SAMPLE_RATE, bytes: frames * 4 * 6 + 6 * 44,
      created: Date.now(), lastUsed: Date.now(), seconds: r.seconds,
    };
    writeMeta(part, meta);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.renameSync(part, dir);
    return { key, dir, meta, fromCache: false };
  } catch (e) {
    fs.rmSync(part, { recursive: true, force: true });
    throw e;
  }
}

/** Saved songs, newest first: [{ key, name, bytes, lastUsed }]. */
function listCache(root) {
  let names = [];
  try { names = fs.readdirSync(root); } catch { return []; }
  const out = [];
  for (const n of names) {
    if (!isKey(n)) continue;
    const hit = readCache(root, n);
    if (hit) out.push({ key: n, name: hit.meta.name, bytes: hit.meta.bytes, lastUsed: hit.meta.lastUsed || hit.meta.created });
  }
  return out.sort((a, b) => b.lastUsed - a.lastUsed);
}

/** Delete half-made folders and, beyond `keep` newest songs, old ones. `protect` = keys that are open right now. */
function pruneCache(root, { keep = 4, protect = [] } = {}) {
  try {
    for (const n of fs.readdirSync(root)) if (n.endsWith('.part') && !protect.includes(n.slice(0, -5))) fs.rmSync(path.join(root, n), { recursive: true, force: true });
  } catch { /* no cache yet */ }
  const list = listCache(root);
  let removed = 0;
  list.slice(keep).forEach((e) => { if (!protect.includes(e.key)) { fs.rmSync(dirFor(root, e.key), { recursive: true, force: true }); removed++; } });
  return removed;
}

function clearCache(root, protect = []) {
  let removed = 0;
  for (const e of listCache(root)) if (!protect.includes(e.key)) { fs.rmSync(dirFor(root, e.key), { recursive: true, force: true }); removed++; }
  return removed;
}

// ---- mixing and saving ------------------------------------------------------------------------------------------------------
/**
 * Mix the chosen stems (each with its volume) into one file. `mix` = [{ id, gain }] from Plan.activeStems.
 * The sum is passed through a limiter that only acts on peaks above -0.2 dB, so adding stems can never clip.
 * (`latency=1` matters: without it the limiter delays the audio by its 5 ms look-ahead.)
 */
async function exportMix({ dir, meta, mix, format, output, sourcePath, signal, onProgress }) {
  const fmt = P.FORMATS[format];
  if (!fmt) throw new UserError('Unknown format');
  if (!Array.isArray(mix) || !mix.length) throw new UserError('Tick at least one stem to export');
  if (sourcePath && path.resolve(output) === path.resolve(sourcePath)) throw new UserError('Choose a different name: this would replace the original song');
  const useSource = !!sourcePath && fs.existsSync(sourcePath);
  const args = ['-hide_banner', '-nostdin', '-loglevel', 'error', '-nostats', '-progress', 'pipe:1', '-protocol_whitelist', 'file'];
  for (const m of mix) args.push('-i', path.join(dir, P.stemFile(m.id)));
  if (useSource) args.push('-i', sourcePath);
  const n = mix.length;
  const chain = mix.map((m, i) => `[${i}:a]volume=${Number(m.gain).toFixed(4)}[a${i}]`);
  const joined = n > 1 ? `${mix.map((_, i) => `[a${i}]`).join('')}amix=inputs=${n}:duration=longest:normalize=0[m]` : '[a0]anull[m]';
  const graph = [...chain, joined, '[m]alimiter=limit=0.98:level=0:latency=1[out]'].join(';');
  args.push('-filter_complex', graph, '-map', '[out]');
  if (useSource) args.push('-map_metadata', String(n)); else args.push('-map_metadata', '-1');
  args.push('-map_chapters', '-1', ...fmt.ffmpeg, '-y');
  const part = output + '.part';
  fs.rmSync(part, { force: true });
  args.push(part);
  const t0 = Date.now();
  try {
    await run(args, { signal }, (t) => { if (onProgress && meta.duration > 0) onProgress(Math.min(1, t / meta.duration)); });
    const bytes = fs.statSync(part).size;
    if (bytes < 100) throw new Error('The file came out empty');
    fs.renameSync(part, output);
    return { output, bytes, seconds: meta.duration, elapsed: (Date.now() - t0) / 1000 };
  } catch (e) {
    fs.rmSync(part, { force: true });
    throw e;
  }
}

module.exports = {
  MODEL_ID, MODEL_FILE, SESSION_OPTIONS, ffmpegPath, modelPath, run, probe, checkEncoders, decodeToRaw, WavWriter, createRunner, separate,
  cacheKey, isKey, dirFor, readCache, ensureStems, listCache, pruneCache, clearCache, exportMix, cancelled,
};
