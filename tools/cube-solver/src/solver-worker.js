'use strict';
// Worker thread: builds both solvers' tables once at start (reporting progress), then answers solve requests. Main checks
// every answer against its own cube model before the window sees it.
const { parentPort } = require('worker_threads');
const S2 = require('./solver2');
const S3 = require('./solver3');

const t0 = Date.now();
S2.init((f) => parentPort.postMessage({ type: 'progress', which: 2, fraction: f }));
parentPort.postMessage({ type: 'ready', which: 2, ms: Date.now() - t0 });
const t1 = Date.now();
S3.init((f) => parentPort.postMessage({ type: 'progress', which: 3, fraction: f }));
parentPort.postMessage({ type: 'ready', which: 3, ms: Date.now() - t1 });

parentPort.on('message', (msg) => {
  const { id, size, faces } = msg || {};
  const t = Date.now();
  try {
    const moves = size === 2 ? S2.solve(faces) : S3.solve(faces);
    parentPort.postMessage({ type: 'solved', id, moves, ms: Date.now() - t });
  } catch (e) {
    parentPort.postMessage({ type: 'solved', id, error: String((e && e.message) || e) });
  }
});
