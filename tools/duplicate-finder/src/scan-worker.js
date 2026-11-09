'use strict';
// Runs one scan job off the main thread. workerData = { job: 'scan' | 'list-photos' | 'group-photos', ... }.
const { parentPort, workerData } = require('worker_threads');
const S = require('./scan');

const ac = new AbortController();
parentPort.on('message', (m) => { if (m === 'cancel') ac.abort(); });

const hooks = {
  signal: ac.signal,
  cacheFile: workerData.cacheFile || '',
  onProgress: (p) => parentPort.postMessage({ type: 'progress', ...p }),
};

(async () => {
  try {
    let result;
    if (workerData.job === 'scan') result = await S.scan(workerData.mode, workerData.roots, workerData.options, hooks);
    else if (workerData.job === 'list-photos') result = await S.listPhotos(workerData.roots, workerData.options, hooks);
    else if (workerData.job === 'group-photos') result = { groups: S.groupPhotos(workerData.items, workerData.threshold, hooks) };
    else throw new Error('Unknown job');
    parentPort.postMessage({ type: 'done', result });
  } catch (e) {
    parentPort.postMessage({ type: e.cancelled ? 'cancelled' : 'error', error: String((e && e.message) || e) });
  }
})();
