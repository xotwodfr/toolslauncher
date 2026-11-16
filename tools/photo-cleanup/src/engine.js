'use strict';
// Electron-free model management (testable with plain Node): where the bundled model files are, and a "runner" per model
// that lives in a worker thread and answers one request at a time.
let fs;
try { fs = require('original-fs'); } catch { fs = require('fs'); }
const path = require('path');
const { Worker } = require('worker_threads');
const C = require('./core');

// Pinned in scripts/fetch-model.js too (that script downloads them; the self-test checks them in the packaged app).
const MODELS = Object.freeze({
  lama: { file: 'lama_fp32.onnx', bytes: 208044816, sha256: '1faef5301d78db7dda502fe59966957ec4b79dd64e16f03ed96913c7a4eb68d6' },
  encoder: { file: 'mobile_sam_image_encoder.onnx', bytes: 28157093, sha256: '580f5fb648ea1062c0aabc26217aed56921985f03f0cbbd852bba81d760cc749' },
  decoder: { file: 'sam_mask_decoder_multi.onnx', bytes: 16496559, sha256: '8976b90a87ba50a6a72217a5ff994f7d25ce16f2229fcc1ed259e1294c622ffe' },
});
// CPU only. The memory arena stays ON: inside Electron, LaMa with the arena off spends half its time in the allocator
// (measured: 5.9 s instead of 2.5 s per 512 x 512 run on 4 cores). With it, LaMa holds about 1 GB while loaded, so the app
// lets the model go after a few idle minutes.
const SESSION_OPTIONS = Object.freeze({ executionProviders: ['cpu'], graphOptimizationLevel: 'all', enableCpuMemArena: true, enableMemPattern: true, logSeverityLevel: 3 });

const asarFix = (p) => p.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
const modelPath = (key) => asarFix(path.join(__dirname, '..', 'models', MODELS[key].file));
const cancelled = () => Object.assign(new Error('Cancelled'), { cancelled: true });

/** Problems that stop the models from running (missing files), as sentences. */
function missingModels() {
  return Object.keys(MODELS).filter((k) => !fs.existsSync(modelPath(k))).map((k) => MODELS[k].file);
}

/**
 * Start a model in a worker thread. kind 'lama' (filling) or 'sam' (selection: encoder + decoder).
 * The runner queues requests and answers them one at a time; release() frees its memory.
 */
async function createRunner(kind) {
  const files = kind === 'lama' ? { lama: modelPath('lama') } : { encoder: modelPath('encoder'), decoder: modelPath('decoder') };
  for (const f of Object.values(files)) if (!fs.existsSync(f)) throw new C.UserError(`A model file is missing (${path.basename(f)}). Run "npm run setup" in the tool folder.`);
  const worker = new Worker(path.join(__dirname, 'infer-worker.js'), { workerData: { kind, files, options: { ...SESSION_OPTIONS } } });
  const pending = new Map();
  let nextId = 1; let dead = null; let exited = false; let onReleased = null; let onReady = null;
  const ready = new Promise((resolve, reject) => { onReady = { resolve, reject }; });
  const failAll = (err) => { dead = dead || err; for (const p of pending.values()) p.reject(err); pending.clear(); onReady.reject(err); };
  worker.on('message', (m) => {
    if (m.type === 'ready') onReady.resolve();
    else if (m.type === 'released') { if (onReleased) onReleased(); }
    else if (m.type === 'result' || (m.type === 'error' && m.id !== -1)) {
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      if (m.type === 'result') p.resolve(m); else p.reject(new Error(m.message));
    } else if (m.type === 'error') failAll(new Error(m.message));
  });
  worker.on('error', (e) => failAll(e));
  worker.on('exit', (code) => { exited = true; if (onReleased) onReleased(); failAll(dead || new Error(`The model stopped unexpectedly (code ${code})`)); });
  await ready;

  let chain = Promise.resolve();
  const send = (msg, transfer) => new Promise((resolve, reject) => {
    if (dead) { reject(dead); return; }
    const id = nextId++;
    pending.set(id, { resolve, reject });
    worker.postMessage({ ...msg, id }, transfer || []);
  });
  return {
    kind,
    /** Queue a request: { type, ...payload }. Resolves with the worker's answer. */
    call(msg, transfer) {
      const run = chain.then(() => send(msg, transfer));
      chain = run.catch(() => {});
      return run;
    },
    /** Callers waiting now hear "cancelled" at once; a run already inside the model finishes and is thrown away. */
    cancelPending() { const err = cancelled(); for (const p of pending.values()) p.reject(err); pending.clear(); },
    async release() {
      dead = dead || cancelled();
      for (const p of pending.values()) p.reject(dead);
      pending.clear();
      if (!exited) {
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, 60000);
          onReleased = () => { clearTimeout(timer); resolve(); };
          try { worker.postMessage({ type: 'release' }); } catch { clearTimeout(timer); resolve(); }
        });
        await worker.terminate();
      }
    },
  };
}

module.exports = { MODELS, SESSION_OPTIONS, modelPath, missingModels, createRunner, cancelled };
