'use strict';
// Runs the Demucs separation model in its own thread for src/vocals.js (copied from tools/stem-splitter's infer-worker.js:
// each tool is packaged alone). onnxruntime's `session.run()` blocks the thread that calls it for the whole run, so in the
// app's main process it would freeze the window. This thread is never terminated while it is inside a run (that takes the
// whole process down): the caller stops sending segments, waits for the one in progress, asks for 'release', and only then
// ends the thread.
//
// Only the vocals stem leaves this thread, already downmixed to mono as (L + R) / sqrt(2): the same level ffmpeg's `-ac 1`
// gives, so the vocals come out at the level audio.decode16k gives for the whole song. The blend of overlapping segments in
// vocals.js is linear, so downmixing here gives the same result as downmixing afterwards, for a sixth of the copying.
//
// Messages in:  { type: 'run', id, input: Float32Array(2 * segment) planar L then R } | { type: 'release' }
// Messages out: { type: 'ready' } | { type: 'result', id, out: Float32Array(segment) } | { type: 'error', id, message } | { type: 'released' }
const { parentPort, workerData } = require('worker_threads');

const VOCALS = 3; // the model writes its stems in this order: drums, bass, other, vocals, guitar, piano

(async () => {
  const ort = require('onnxruntime-node');
  const N = workerData.segment;
  const session = await ort.InferenceSession.create(workerData.file, workerData.options);
  let busy = Promise.resolve();      // runs are done one at a time, and 'release' waits for the one in progress
  let released = false;
  parentPort.on('message', (m) => {
    if (m.type === 'run') {
      busy = busy.then(async () => {
        try {
          if (released) throw new Error('The model was released');
          const res = await session.run({ mix: new ort.Tensor('float32', m.input, [1, 2, N]) });
          const t = res.stems || res[session.outputNames[0]];
          if (!t || t.data.length !== 6 * 2 * N) throw new Error('The model returned an unexpected result');
          const out = new Float32Array(N);
          const l = VOCALS * 2 * N; const r = l + N;
          for (let i = 0; i < N; i++) out[i] = Math.SQRT1_2 * (t.data[l + i] + t.data[r + i]);
          parentPort.postMessage({ type: 'result', id: m.id, out }, [out.buffer]);
        } catch (e) { parentPort.postMessage({ type: 'error', id: m.id, message: String((e && e.message) || e) }); }
      });
    } else if (m.type === 'release') {
      busy = busy.then(async () => {
        if (!released) { released = true; try { await session.release(); } catch { /* ignore */ } }
        parentPort.postMessage({ type: 'released' });
      });
    }
  });
  parentPort.postMessage({ type: 'ready' });
})().catch((e) => parentPort.postMessage({ type: 'error', id: -1, message: String((e && e.message) || e) }));
