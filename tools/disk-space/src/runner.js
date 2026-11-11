'use strict';
// Runs one scan on a worker thread so the window stays responsive. Electron-free (used by main.js and the self-test).
const path = require('path');
const { Worker } = require('worker_threads');

/**
 * @returns {{ promise: Promise<object>, cancel: () => void }}  the promise resolves with the result (also when cancelled:
 *          then `partial` is true and it holds what was found so far)
 */
function runScan(root, opts = {}, hooks = {}) {
  const stopBuf = new SharedArrayBuffer(4);
  const stop = new Int32Array(stopBuf);
  const worker = new Worker(path.join(__dirname, 'worker.js'), {
    workerData: { root, oneDrive: opts.oneDrive !== false, delayMs: opts.delayMs || 0, seen: Array.isArray(opts.seen) ? opts.seen : undefined, live: !!hooks.onSnapshot, stopBuf },
  });
  let settled = false;
  const promise = new Promise((resolve, reject) => {
    worker.on('message', (m) => {
      if (m.type === 'progress' && hooks.onProgress) hooks.onProgress(m.progress);
      else if (m.type === 'snapshot' && hooks.onSnapshot) hooks.onSnapshot(m.tree);
      else if (m.type === 'done') { settled = true; resolve({ json: m.json }); worker.terminate(); }
      else if (m.type === 'error') { settled = true; reject(Object.assign(new Error(m.error), { code: m.code })); worker.terminate(); }
    });
    worker.on('error', (e) => { if (!settled) { settled = true; reject(e); } });
    worker.on('exit', (code) => { if (!settled) { settled = true; reject(new Error('The scan stopped unexpectedly (code ' + code + ')')); } });
  });
  return { promise, cancel: () => Atomics.store(stop, 0, 1), kill: () => worker.terminate() };
}

module.exports = { runScan };
