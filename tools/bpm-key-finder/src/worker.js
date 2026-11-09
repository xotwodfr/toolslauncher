'use strict';
// One analysis worker thread: gets { id, file, duration, ffmpeg }, answers { id, result } or { id, error }.
const { parentPort } = require('worker_threads');
const A = require('./analyse');

parentPort.on('message', async (m) => {
  try {
    const result = await A.analyseFile(m.ffmpeg, m.file, { duration: m.duration });
    parentPort.postMessage({ id: m.id, result });
  } catch (e) {
    parentPort.postMessage({ id: m.id, error: String((e && e.message) || e) });
  }
});
