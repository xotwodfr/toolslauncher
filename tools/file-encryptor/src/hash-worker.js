'use strict';
// One file at a time: streams it once through every chosen hash and reports progress about five times a second.
const { parentPort } = require('worker_threads');
const H = require('./hashing');

parentPort.on('message', async ({ id, file, algs }) => {
  let pending = 0; let last = Date.now();
  try {
    const digests = await H.hashFile(file, algs, {
      onBytes: (n) => {
        pending += n;
        if (Date.now() - last > 200) { parentPort.postMessage({ id, progress: pending }); pending = 0; last = Date.now(); }
      },
    });
    parentPort.postMessage({ id, progress: pending, digests });
  } catch (e) {
    parentPort.postMessage({ id, progress: pending, error: e.code === 'ENOENT' ? 'The file is not there any more.' : e.code === 'EACCES' || e.code === 'EPERM' ? 'This file cannot be read (no permission).' : String(e.message || e) });
  }
});
