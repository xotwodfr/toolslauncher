'use strict';
// Runs the Demucs model in its own thread. onnxruntime's `session.run()` blocks the thread that calls it for the whole
// inference (about 3.5 s per segment): measured in plain Node, the event loop ticked ONCE during one run. In the app's
// main process that would freeze window events and IPC (the Cancel button!) for most of the split, so it lives here.
//
// Messages in:  { type: 'run', id, input: Float32Array(2 * segment) } | { type: 'release' }
// Messages out: { type: 'ready' } | { type: 'result', id, out: Float32Array(6 * 2 * segment) } | { type: 'error', id, message } | { type: 'released' }
const { parentPort, workerData } = require('worker_threads');

(async () => {
  const ort = require('onnxruntime-node');
  const N = workerData.segment;
  const session = await ort.InferenceSession.create(workerData.file, workerData.options);
  parentPort.on('message', async (m) => {
    if (m.type === 'run') {
      try {
        const res = await session.run({ mix: new ort.Tensor('float32', m.input, [1, 2, N]) });
        const t = res.stems || res[session.outputNames[0]];
        if (!t || t.data.length !== 6 * 2 * N) throw new Error('The model returned an unexpected result');
        const out = new Float32Array(t.data);            // copy out of onnxruntime's memory, then hand it over without another copy
        parentPort.postMessage({ type: 'result', id: m.id, out }, [out.buffer]);
      } catch (e) { parentPort.postMessage({ type: 'error', id: m.id, message: String((e && e.message) || e) }); }
    } else if (m.type === 'release') {
      try { await session.release(); } catch { /* ignore */ }
      parentPort.postMessage({ type: 'released' });
    }
  });
  parentPort.postMessage({ type: 'ready' });
})().catch((e) => parentPort.postMessage({ type: 'error', id: -1, message: String((e && e.message) || e) }));
