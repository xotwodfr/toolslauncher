'use strict';
// Worker thread: scans one folder and reports progress, live snapshots and the result to the main process.
const { parentPort, workerData } = require('worker_threads');
const { scan } = require('./scan');

const stop = new Int32Array(workerData.stopBuf);
try {
  const r = scan(workerData.root, {
    oneDrive: workerData.oneDrive !== false,
    delayMs: workerData.delayMs || 0,
    seen: workerData.seen,
    shouldStop: () => Atomics.load(stop, 0) === 1,
    onProgress: (p) => parentPort.postMessage({ type: 'progress', progress: p }),
    onSnapshot: workerData.live ? (snap) => parentPort.postMessage({ type: 'snapshot', tree: snap }) : undefined,
  });
  // one JSON string: much cheaper to pass on to the window than a deep object
  parentPort.postMessage({ type: 'done', json: JSON.stringify(r) });
} catch (e) {
  parentPort.postMessage({ type: 'error', error: String((e && e.message) || e), code: e && e.code });
}
