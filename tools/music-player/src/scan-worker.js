'use strict';
// Runs the library scan off the main thread so a big folder never freezes the window.
const { parentPort, workerData } = require('worker_threads');
const Lib = require('./library');

let cancelled = false;
parentPort.on('message', (m) => { if (m === 'cancel') cancelled = true; });

(async () => {
  const { root, cacheFile } = workerData;
  try {
    const cache = Lib.loadCache(cacheFile, root);
    const res = await Lib.scan(root, {
      cache,
      isCancelled: () => cancelled,
      onProgress: (p) => parentPort.postMessage({ type: 'progress', ...p }),
    });
    if (!res.cancelled) { try { Lib.saveCache(cacheFile, root, res.tracks); } catch { /* a read-only profile folder must not break playback */ } }
    parentPort.postMessage({ type: 'done', result: res });
  } catch (e) {
    parentPort.postMessage({ type: 'error', error: String((e && e.message) || e) });
  }
})();
