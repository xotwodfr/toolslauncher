'use strict';
// Worker thread that reads codes from pictures, so a big picture does not freeze the app.
const { parentPort } = require('worker_threads');
const { decode } = require('./reader');

parentPort.on('message', async (m) => {
  try { parentPort.postMessage({ id: m.id, results: await decode(m.img) }); }
  catch (e) { parentPort.postMessage({ id: m.id, error: String((e && e.message) || e) }); }
});
