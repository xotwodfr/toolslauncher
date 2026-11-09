'use strict';
// Electron-free core (testable with plain Node): finds the model files, starts Whisper in a worker thread, and turns a song file
// into timed segments. The worker is never killed in the middle of a run (see infer-worker.js): cancel asks it to stop and it does
// so at the next step, which is a fraction of a second away while decoding and a couple of seconds while encoding.
let fs;
try { fs = require('original-fs'); } catch { fs = require('fs'); }
const path = require('path');
const { Worker } = require('worker_threads');
const A = require('./audio');

const MODEL_FILES = ['encoder_model_int8.onnx', 'decoder_model_merged_int8.onnx', 'tokenizer.json', 'config.json', 'generation_config.json'];
// CPU only. The decoder gets onnxruntime's memory arena: measured 27% faster per word, for about 400 MB more memory (peak ~1.5 GB).
const ENCODER_OPTIONS = Object.freeze({ executionProviders: ['cpu'], graphOptimizationLevel: 'all', enableCpuMemArena: false, enableMemPattern: false, logSeverityLevel: 3 });
const DECODER_OPTIONS = Object.freeze({ executionProviders: ['cpu'], graphOptimizationLevel: 'all', enableCpuMemArena: true, enableMemPattern: false, logSeverityLevel: 3 });

const asarFix = (p) => p.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
const modelDir = () => asarFix(path.join(__dirname, '..', 'models'));
const missingFiles = (dir = modelDir()) => MODEL_FILES.filter((f) => !fs.existsSync(path.join(dir, f)));
const cancelled = () => Object.assign(new Error('Cancelled'), { cancelled: true });

/** Start the model. The runner makes lyrics for one song at a time and must be released when done. */
async function createEngine({ dir = modelDir() } = {}) {
  const missing = missingFiles(dir);
  if (missing.length) throw new A.UserError('The speech model is missing (' + missing.join(', ') + '). Run "npm run setup" in the tool folder to download it.');
  const worker = new Worker(path.join(__dirname, 'infer-worker.js'), { workerData: { dir, options: { ...ENCODER_OPTIONS }, decoderOptions: { ...DECODER_OPTIONS } } });
  const jobs = new Map();                      // id -> { resolve, reject, onSegments, onProgress }
  let nextId = 1; let dead = null; let onReady = null; let onReleased = null; let exited = false;
  const ready = new Promise((resolve, reject) => { onReady = { resolve, reject }; });
  const failAll = (err) => { dead = dead || err; for (const j of jobs.values()) j.reject(err); jobs.clear(); onReady.reject(err); };
  worker.on('message', (m) => {
    if (m.type === 'ready') return onReady.resolve();
    if (m.type === 'released') { if (onReleased) onReleased(); return undefined; }
    if (m.type === 'error' && m.id === -1) return failAll(new Error(m.message));
    const job = jobs.get(m.id);
    if (!job) return undefined;
    if (m.type === 'segments') job.onSegments(m.segments);
    else if (m.type === 'progress') job.onProgress(m);
    else if (m.type === 'done') { jobs.delete(m.id); job.resolve({ language: m.language, segments: m.segments }); }
    else if (m.type === 'cancelled') { jobs.delete(m.id); job.reject(cancelled()); }
    else if (m.type === 'error') { jobs.delete(m.id); job.reject(m.userError ? new A.UserError(m.message) : new Error(m.message)); }
    return undefined;
  });
  worker.on('error', (e) => failAll(e));
  worker.on('exit', (code) => { exited = true; if (onReleased) onReleased(); failAll(dead || new Error(`The speech model process stopped unexpectedly (code ${code})`)); });
  await ready;
  return {
    /**
     * @param {Float32Array} samples 16 kHz mono (handed over to the worker, so do not use it afterwards)
     * @param {{ language?: string, signal?: AbortSignal, onSegments?: Function, onProgress?: Function }} [o]
     */
    transcribe(samples, { language = 'auto', signal, onSegments = () => {}, onProgress = () => {} } = {}) {
      if (dead) return Promise.reject(dead);
      return new Promise((resolve, reject) => {
        const id = nextId++;
        jobs.set(id, { resolve, reject, onSegments, onProgress });
        const stop = () => { try { worker.postMessage({ type: 'cancel', id }); } catch { /* the worker is gone */ } };
        if (signal) { if (signal.aborted) { jobs.delete(id); return reject(cancelled()); } signal.addEventListener('abort', stop, { once: true }); }
        worker.postMessage({ type: 'transcribe', id, samples, language }, [samples.buffer]);
        return undefined;
      });
    },
    /** Free the model's memory. Waits for any song in progress to stop first (it is asked to), then ends the thread. */
    async release() {
      dead = dead || cancelled();
      if (!exited) {
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, 60000);
          onReleased = () => { clearTimeout(timer); resolve(); };
          try { worker.postMessage({ type: 'release' }); } catch { clearTimeout(timer); resolve(); }
        });
        await worker.terminate();
      }
      for (const j of jobs.values()) j.reject(cancelled());
      jobs.clear();
    },
  };
}

/** Read a song file and make lyrics for it. */
async function makeLyrics(engine, file, { language = 'auto', signal, ffmpeg = A.ffmpegPath(), onSegments, onProgress, onPhase = () => {} } = {}) {
  onPhase('reading');
  const samples = await A.decode16k(ffmpeg, file, { signal });
  onPhase('working');
  return engine.transcribe(samples, { language, signal, onSegments, onProgress });
}

module.exports = { MODEL_FILES, ENCODER_OPTIONS, DECODER_OPTIONS, modelDir, missingFiles, createEngine, makeLyrics, cancelled };
