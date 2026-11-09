'use strict';
// Runs the ISNet model in its own thread: onnxruntime's `session.run()` blocks the thread that calls it for the whole
// inference (a few seconds), which in the app's main process would freeze the window's events and IPC.
//
// Messages in:  { type: 'run', id, input: Float32Array(3*size*size) } | { type: 'release' }
// Messages out: { type: 'ready' } | { type: 'result', id, out: Float32Array(size*size) } | { type: 'error', id, message } | { type: 'released' }
const { parentPort, workerData } = require('worker_threads');

(async () => {
  const ort = require('onnxruntime-node');
  const N = workerData.size;
  const session = await ort.InferenceSession.create(workerData.file, workerData.options);
  const inputName = session.inputNames[0];
  parentPort.on('message', async (m) => {
    if (m.type === 'run') {
      try {
        const res = await session.run({ [inputName]: new ort.Tensor('float32', m.input, [1, 3, N, N]) });
        const t = res[session.outputNames[0]];            // the first output is the finished mask; the others are side outputs
        if (!t || t.data.length !== N * N) throw new Error('The model returned an unexpected result');
        const out = new Float32Array(t.data);
        parentPort.postMessage({ type: 'result', id: m.id, out }, [out.buffer]);
      } catch (e) { parentPort.postMessage({ type: 'error', id: m.id, message: String((e && e.message) || e) }); }
    } else if (m.type === 'release') {
      try { await session.release(); } catch { /* ignore */ }
      parentPort.postMessage({ type: 'released' });
    }
  });
  parentPort.postMessage({ type: 'ready' });
})().catch((e) => parentPort.postMessage({ type: 'error', id: -1, message: String((e && e.message) || e) }));
