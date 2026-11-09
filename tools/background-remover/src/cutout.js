'use strict';
// Electron-free core (testable with plain Node): finds the model file, starts it in a worker thread, and answers
// "where is the subject?" for a prepared picture. The picture's decoding, resizing and compositing happen in the window
// (canvas), because that is where every image format is already understood.
let fs;
try { fs = require('original-fs'); } catch { fs = require('fs'); }
const path = require('path');
const { Worker } = require('worker_threads');
const P = require('./plan');

const MODEL_FILE = 'isnet-general-use.onnx';
// CPU only. Measured on a Ryzen 5 5600X: ~1.6-6 s per picture and under 1 GB of memory with the memory arena off.
const SESSION_OPTIONS = Object.freeze({ executionProviders: ['cpu'], graphOptimizationLevel: 'all', enableCpuMemArena: false, enableMemPattern: false, logSeverityLevel: 3 });

const asarFix = (p) => p.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
const modelPath = () => asarFix(path.join(__dirname, '..', 'models', MODEL_FILE));
const cancelled = () => Object.assign(new Error('Cancelled'), { cancelled: true });

/** Start the model. The returned runner answers one picture at a time and must be released when done. */
async function createRunner(file = modelPath()) {
  if (!fs.existsSync(file)) throw new P.UserError('The background-removal model is missing. Run "npm run setup" in the tool folder to download it.');
  const worker = new Worker(path.join(__dirname, 'infer-worker.js'), { workerData: { file, size: P.SIZE, options: { ...SESSION_OPTIONS } } });
  const pending = new Map();
  let nextId = 1;
  let dead = null;
  let onReady = null;
  const ready = new Promise((resolve, reject) => { onReady = { resolve, reject }; });
  const failAll = (err) => { dead = dead || err; for (const p of pending.values()) p.reject(err); pending.clear(); onReady.reject(err); };
  let onReleased = null;
  let exited = false;
  worker.on('message', (m) => {
    if (m.type === 'ready') onReady.resolve();
    else if (m.type === 'released') { if (onReleased) onReleased(); }
    else if (m.type === 'result' || (m.type === 'error' && m.id !== -1)) {
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      if (m.type === 'result') p.resolve(m.out); else p.reject(new Error(m.message));
    } else if (m.type === 'error') failAll(new Error(m.message));
  });
  worker.on('error', (e) => failAll(e));
  worker.on('exit', (code) => { exited = true; if (onReleased) onReleased(); failAll(dead || new Error(`The model process stopped unexpectedly (code ${code})`)); });
  await ready;
  return {
    /** @param {Float32Array} tensor 3*SIZE*SIZE from Plan.toTensor. @returns {Promise<{mask: Float32Array, flat: boolean}>} */
    async run(tensor) {
      if (dead) throw dead;
      if (!(tensor instanceof Float32Array) || tensor.length !== 3 * P.SIZE * P.SIZE) throw new P.UserError('The picture was not prepared correctly');
      const out = await new Promise((resolve, reject) => {
        const id = nextId++;
        pending.set(id, { resolve, reject });
        worker.postMessage({ type: 'run', id, input: tensor });
      });
      return P.normaliseMask(out);
    },
    /**
     * Give up on the picture being worked on: its caller hears "cancelled" at once. The model itself cannot be interrupted
     * (killing the thread in the middle of onnxruntime's run() takes the whole process down with it - measured), so the
     * thread finishes that picture, the result is thrown away, and the thread is ready for the next one.
     */
    cancelPending() { const err = cancelled(); for (const p of pending.values()) p.reject(err); pending.clear(); },
    /** Free the model's memory. Asks the thread to stop (it does so after any picture in progress) instead of killing it. */
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

module.exports = { MODEL_FILE, SESSION_OPTIONS, modelPath, createRunner, cancelled };
