'use strict';
// "Isolate vocals first": separates the singing from the band with the Demucs 6-stem model (the same pinned file as
// tools/stem-splitter, fetched by scripts/fetch-demucs.js) and returns only the vocals, as the 16 kHz mono samples Whisper
// wants (the same shape and length as audio.decode16k gives for the plain song). Electron-free.
//
// The song streams through: ffmpeg decodes it to 44.1 kHz stereo into a pipe, it is cut into the model's 7.8 s segments
// overlapping by a quarter (blended with a triangle window, as in stem-splitter), the vocals of each finished stretch are
// piped into a second ffmpeg that resamples them to 16 kHz. Only about two segments of the song are in memory at any time,
// whatever its length; the result (4 bytes per output sample, 115 MB for 30 minutes) is the only thing that grows.
//
// The model runs in its own worker thread (vocals-worker.js), loaded for this one song and released at the end. That
// thread is never terminated in the middle of a run (it crashes the process): cancelling stops feeding it, the promise is
// rejected at once with `cancelled: true`, and the clean-up (wait for the segment in progress, free the model, end the
// thread) finishes in the background a few seconds later. `idle()` waits for it. A new call first waits for every earlier
// one to finish and free its model, so two copies of the model are never loaded at once.
let fs;
try { fs = require('original-fs'); } catch { fs = require('fs'); }
const path = require('path');
const { spawn } = require('child_process');
const { Worker } = require('worker_threads');
const A = require('./audio');

const MODEL_FILE = 'htdemucs_6s_fp16weights.onnx';
const MODEL_RATE = 44100;        // the model's sample rate
const SEGMENT = 343980;          // the model takes exactly this many frames (7.8 s) per call
const OVERLAP = 0.25;            // neighbouring segments share this fraction
const FRAME_BYTES = 8;           // stereo float32
// stem-splitter's settings (memory arena and pattern off), plus onnxruntime's ConstantFolding pass switched off on its own.
// Measured on Linux (4 cores, VmHWM): with folding the process peaks at 6.2 GB while loading the model (folding the fp16
// weights into fp32 copies) and keeps ~3.7-6 GB; without it the peak is ~1.5 GB, the output is the same (difference
// -133 dB) and a segment takes the same time (interleaved runs, 6.6-7.1 s each under load). Every other optimisation is kept.
const SESSION_OPTIONS = Object.freeze({
  executionProviders: ['cpu'], graphOptimizationLevel: 'all', enableCpuMemArena: false, enableMemPattern: false, logSeverityLevel: 3,
  extra: { optimization: { disable_specified_optimizers: 'ConstantFolding' } },
});

const asarFix = (p) => p.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
const modelPath = () => asarFix(path.join(__dirname, '..', 'models', MODEL_FILE));
/** Is the separation model file absent? */
const missing = (file = modelPath()) => !fs.existsSync(file);
const { cancelled } = A;

/** Triangle blend window (peak 1), so a seam between segments never clicks. */
function weights(n) {
  const w = new Float32Array(n);
  const half = Math.floor(n / 2);
  for (let i = 0; i < half; i++) w[i] = i + 1;
  for (let i = half; i < n; i++) w[i] = n - i;
  const max = Math.max(half, n - half);
  for (let i = 0; i < n; i++) w[i] /= max;
  return w;
}

// ---- the model thread --------------------------------------------------------------------------------------------------
/** Load the model in a worker. `infer(planar Float32Array(2N))` -> Promise<Float32Array(N)> mono vocals. */
async function createRunner(file) {
  const N = SEGMENT;
  const options = { ...SESSION_OPTIONS, extra: { optimization: { ...SESSION_OPTIONS.extra.optimization } } };
  const worker = new Worker(path.join(__dirname, 'vocals-worker.js'), { workerData: { file, segment: N, options } });
  const pending = new Map();
  let nextId = 1; let dead = null; let exited = false; let onReleased = null; let onReady = null;
  const ready = new Promise((resolve, reject) => { onReady = { resolve, reject }; });
  const failAll = (err) => { dead = dead || err; for (const p of pending.values()) p.reject(err); pending.clear(); onReady.reject(err); };
  worker.on('message', (m) => {
    if (m.type === 'ready') onReady.resolve();
    else if (m.type === 'released') { if (onReleased) onReleased(); }
    else if (m.type === 'error' && m.id === -1) failAll(new Error(m.message));
    else if (m.type === 'result' || m.type === 'error') {
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      if (m.type === 'result') p.resolve(m.out); else p.reject(new Error(m.message));
    }
  });
  worker.on('error', (e) => failAll(e));
  worker.on('exit', (code) => { exited = true; if (onReleased) onReleased(); failAll(dead || new Error(`The separation model stopped unexpectedly (code ${code})`)); });
  try { await ready; } catch (e) { if (!exited) await worker.terminate(); throw e; } // a failed load has no run in progress
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
    /** Free the model: waits for the run in progress (the worker does them in order), then ends the thread. */
    async release() {
      if (exited) return;
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 120000);
        onReleased = () => { clearTimeout(timer); resolve(); };
        try { worker.postMessage({ type: 'release' }); } catch { clearTimeout(timer); resolve(); }
      });
      dead = dead || new Error('The separation model was released');
      if (!exited) await worker.terminate();
    },
  };
}

// ---- pipes -------------------------------------------------------------------------------------------------------------
/** Reads a child's stdout in exact-size pieces, pausing the child while enough is buffered (back-pressure). */
class PullReader {
  constructor(stream, high = 4 * 1024 * 1024) {
    this.chunks = []; this.size = 0; this.ended = false; this.error = null; this.high = high; this.wake = null; this.stream = stream;
    stream.on('data', (d) => { this.chunks.push(d); this.size += d.length; if (this.size >= this.high) stream.pause(); this.poke(); });
    stream.on('end', () => { this.ended = true; this.poke(); });
    stream.on('error', (e) => { this.error = e; this.ended = true; this.poke(); });
  }
  poke() { if (this.wake) { const w = this.wake; this.wake = null; w(); } }
  async wait(n) {
    while (this.size < n && !this.ended) {
      if (this.stream.isPaused()) this.stream.resume();
      await new Promise((r) => { this.wake = r; });
    }
  }
  /** Copy up to `n` bytes into `dest` (a Uint8Array) at `offset`; fewer only at the end of the stream. Returns the count. */
  async readInto(dest, offset, n) {
    await this.wait(n);
    let got = 0;
    while (got < n && this.chunks.length) {
      const c = this.chunks[0];
      const take = Math.min(c.length, n - got);
      dest.set(c.subarray(0, take), offset + got);
      got += take;
      if (take === c.length) this.chunks.shift(); else this.chunks[0] = c.subarray(take);
    }
    this.size -= got;
    if (this.size < this.high && this.stream.isPaused() && !this.ended) this.stream.resume();
    return got;
  }
  /** True when nothing more will come. */
  async atEnd() { await this.wait(1); return this.size === 0 && this.ended; }
}

/** Collects float32 samples from a stream into one growing Float32Array (no second copy of the whole song). */
function collectFloats(stream, expect) {
  let out = new Float32Array(Math.max(1024, expect));
  let n = 0;
  const carry = new Uint8Array(4); let carried = 0;
  const bytesOf = () => new Uint8Array(out.buffer);
  const ensure = (more) => {
    if (n + more <= out.length) return;
    const bigger = new Float32Array(Math.max(out.length * 2, n + more));
    bigger.set(out.subarray(0, n)); out = bigger;
  };
  stream.on('data', (d) => {
    let off = 0;
    if (carried) {
      const take = Math.min(4 - carried, d.length);
      carry.set(d.subarray(0, take), carried); carried += take; off = take;
      if (carried < 4) return;
      ensure(1); bytesOf().set(carry, n * 4); n++; carried = 0;
    }
    const whole = Math.floor((d.length - off) / 4);
    ensure(whole);
    bytesOf().set(d.subarray(off, off + whole * 4), n * 4);
    n += whole;
    const rest = d.length - off - whole * 4;
    if (rest) { carry.set(d.subarray(d.length - rest), 0); carried = rest; }
  });
  return () => (n === out.length ? out : out.slice(0, n));
}

function startFfmpeg(ffmpeg, args, label) {
  const child = spawn(ffmpeg, args, { windowsHide: true });
  let err = '';
  child.stderr.on('data', (d) => { if (err.length < 4000) err += d; });
  const done = new Promise((resolve, reject) => {
    child.on('error', (e) => reject(new A.UserError('Could not start ffmpeg: ' + e.message)));
    child.on('close', (code, sig) => resolve({ code, sig, err: err.trim() }));
  });
  done.catch(() => {});
  child.stdin.on('error', () => { /* the process ended; reported by `done` */ });
  return { child, done, label };
}

/** Write to a child's stdin, waiting while its buffer is full. */
function writeTo(proc, buf) {
  if (proc.child.stdin.write(buf)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const ok = () => { off(); resolve(); };
    const bad = () => { off(); reject(new Error('The resampler stopped unexpectedly')); };
    const off = () => { proc.child.stdin.off('drain', ok); proc.child.removeListener('close', bad); };
    proc.child.stdin.once('drain', ok);
    proc.child.once('close', bad);
  });
}

// ---- separating --------------------------------------------------------------------------------------------------------
let queue = Promise.resolve();
/** Resolves when every separation started so far (finished, failed or cancelled) has freed its model and ended its thread. */
const idle = () => queue;

/**
 * The vocals of `file`, as 16 kHz mono (at most audio.MAX_SECONDS, like decode16k).
 * @param {string} file
 * @param {{ ffmpeg?: string, signal?: AbortSignal, onProgress?: (p: { fraction: number, phase: 'load'|'separate', etaSeconds?: number }) => void,
 *           model?: string, runner?: object }} [o] `model`: another model file (tests); `runner`: a stand-in for the model (tests).
 * @returns {Promise<Float32Array>}
 */
async function isolateVocals(file, { ffmpeg = A.ffmpegPath(), signal, onProgress = () => {}, model = modelPath(), runner: given = null } = {}) {
  if (!given && missing(model)) throw new A.UserError('The vocal separation model is missing. Run "npm run setup" in the tool folder to download it.');
  if (signal && signal.aborted) throw cancelled();

  let stop = false;
  const procs = [];
  const killAll = () => { for (const p of procs) { try { p.child.kill('SIGKILL'); } catch { /* gone */ } } };
  let rejectNow = null;
  const aborted = new Promise((_, reject) => { rejectNow = reject; });
  aborted.catch(() => {});
  const onAbort = () => { stop = true; killAll(); rejectNow(cancelled()); };
  if (signal) signal.addEventListener('abort', onAbort, { once: true });

  // One separation at a time (each holds ~1.5 GB): wait for the earlier ones, including ones still freeing their model
  // after a cancel. Our turn is handed on only when our own model is freed (`handOn` below).
  const before = queue;
  let handOn = null;
  queue = new Promise((resolve) => { handOn = resolve; });
  let seconds;
  try {
    await Promise.race([before, aborted]);
    seconds = Math.min(await Promise.race([A.probe(ffmpeg, file), aborted]), A.MAX_SECONDS);
    if (stop) throw cancelled();
  } catch (e) {
    before.then(handOn);
    if (signal) signal.removeEventListener('abort', onAbort);
    throw stop ? cancelled() : e;
  }

  const work = (async () => {
    let runner = given;
    try {
      onProgress({ fraction: 0, phase: 'load' });
      if (!runner) runner = await createRunner(model);
      if (stop) throw cancelled();
      const N = runner.segment;
      const S = Math.max(1, Math.floor(N * (1 - OVERLAP)));
      const estFrames = Math.max(1, Math.round(seconds * MODEL_RATE));

      const dec = startFfmpeg(ffmpeg, ['-hide_banner', '-nostdin', '-v', 'error', '-i', file, '-vn', '-map', '0:a:0', '-ac', '2', '-ar', String(MODEL_RATE),
        '-t', String(A.MAX_SECONDS), '-f', 'f32le', 'pipe:1'], 'decode');
      const res = startFfmpeg(ffmpeg, ['-hide_banner', '-nostdin', '-v', 'error', '-f', 'f32le', '-ar', String(MODEL_RATE), '-ac', '1', '-i', 'pipe:0',
        '-ar', String(A.SAMPLE_RATE), '-f', 'f32le', 'pipe:1'], 'resample');
      procs.push(dec, res);
      if (stop) { killAll(); throw cancelled(); }
      const reader = new PullReader(dec.child.stdout);
      const result = collectFloats(res.child.stdout, Math.ceil(seconds * A.SAMPLE_RATE) + 1024);

      const w = weights(N);
      const inter = new Float32Array(2 * N);             // interleaved input frames of the current window
      const interBytes = new Uint8Array(inter.buffer);
      const planar = new Float32Array(2 * N);
      const acc = new Float32Array(N);                   // weighted sum of the vocals of the segments covering the window
      const wsum = new Float32Array(N);
      const fill = async (from, frames) => Math.floor(await reader.readInto(interBytes, from * FRAME_BYTES, frames * FRAME_BYTES) / FRAME_BYTES);

      let have = await fill(0, N);
      if (have === 0) {
        const r = await dec.done;
        if (stop) throw cancelled();
        throw new A.UserError(r.code === 0 ? 'This file has no sound' : 'This file could not be read as audio' + (r.err ? ` (${r.err.split('\n').pop().slice(0, 90)})` : ''));
      }
      let start = 0;
      const t0 = Date.now();
      for (;;) {
        if (stop) throw cancelled();
        const last = have < N || await reader.atEnd();
        planar.fill(0);
        for (let i = 0; i < have; i++) { planar[i] = inter[2 * i]; planar[N + i] = inter[2 * i + 1]; }
        const out = await runner.infer(planar);
        if (stop) throw cancelled();
        for (let i = 0; i < have; i++) { acc[i] += out[i] * w[i]; wsum[i] += w[i]; }
        const emit = last ? have : S;                    // everything before the next segment starts is final
        const chunk = new Float32Array(emit);
        for (let i = 0; i < emit; i++) chunk[i] = acc[i] / wsum[i];
        await writeTo(res, Buffer.from(chunk.buffer));
        const done = start + emit;
        const elapsed = (Date.now() - t0) / 1000;
        const fraction = last ? 1 : Math.min(0.99, done / estFrames);
        onProgress({ fraction, phase: 'separate', etaSeconds: fraction > 0 ? elapsed * (1 - fraction) / fraction : undefined });
        if (last) break;
        acc.copyWithin(0, S, N); acc.fill(0, N - S, N);
        wsum.copyWithin(0, S, N); wsum.fill(0, N - S, N);
        inter.copyWithin(0, 2 * S, 2 * N);
        have = N - S + await fill(N - S, S);
        start += S;
      }
      res.child.stdin.end();
      const [d, r] = await Promise.all([dec.done, res.done]);
      if (stop) throw cancelled();
      if (d.code !== 0) throw new A.UserError('This file could not be read as audio' + (d.err ? ` (${d.err.split('\n').pop().slice(0, 90)})` : ''));
      if (r.code !== 0) throw new Error('Resampling the vocals failed' + (r.err ? ': ' + r.err.split('\n').pop().slice(0, 120) : ''));
      return result();
    } catch (e) {
      throw stop ? cancelled() : e;
    } finally {
      killAll();
      if (runner && !given) await runner.release().catch(() => {});
    }
  })();

  // Rejected at once on cancel; `work` keeps running until the segment in progress is done and the model is freed.
  work.then(handOn, handOn);
  try {
    return await Promise.race([work, aborted]);
  } finally {
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

module.exports = { MODEL_FILE, MODEL_RATE, SEGMENT, OVERLAP, SESSION_OPTIONS, modelPath, missing, isolateVocals, idle, weights };
