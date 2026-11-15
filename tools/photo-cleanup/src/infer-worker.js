'use strict';
// Runs one of the models in its own thread: onnxruntime's `session.run()` blocks the calling thread for the whole inference
// (seconds for LaMa), which in the main process would freeze the window's IPC. The pixel work around the model (shrinking
// the window to 512 x 512, enlarging and blending the answer back) runs here too, so it never blocks anything either.
//
// workerData: { kind: 'lama' | 'sam', files: { lama } | { encoder, decoder }, options }
// Messages in:  { type: 'fill', id, rgba, w, h, unknown, feather, pads?, match? }                       (lama)
//               { type: 'encode', id, key, rgb, w, h } | { type: 'decode', id, key, points, labels, maskInput? }   (sam)
//               { type: 'release' }
// Messages out: { type: 'ready' } | { type: 'result', id, ...answer } | { type: 'error', id, message } | { type: 'released' }
const { parentPort, workerData } = require('worker_threads');
const C = require('./core');

(async () => {
  const ort = require('onnxruntime-node');
  const opts = workerData.options;
  const sessions = [];
  const open = async (f) => { const s = await ort.InferenceSession.create(f, opts); sessions.push(s); return s; };
  const handlers = {};

  if (workerData.kind === 'lama') {
    const lama = await open(workerData.files.lama);
    handlers.fill = async (m) => {
      const t0 = Date.now();
      let rgba = new Uint8ClampedArray(m.rgba.buffer, m.rgba.byteOffset, m.rgba.byteLength);
      let unknown = m.unknown; let w = m.w; let h = m.h; let padded = null;
      if (m.pads && (m.pads.l || m.pads.t || m.pads.r || m.pads.b)) {
        padded = C.mirrorPad(rgba, m.w, m.h, m.unknown, m.pads);
        rgba = padded.rgba; unknown = padded.unknown; w = padded.w; h = padded.h;
      }
      const prep = C.prepareFill(rgba, w, h, unknown);
      const N = C.MODEL;
      const res = await lama.run({ image: new ort.Tensor('float32', prep.image, [1, 3, N, N]), mask: new ort.Tensor('float32', prep.mask, [1, 1, N, N]) });
      const out = res[lama.outputNames[0]];
      if (!out || out.data.length !== 3 * N * N) throw new Error('The fill model returned an unexpected result');
      const answer = m.match ? C.matchTone(prep, Float32Array.from(out.data), m.match) : out.data;
      let done = C.finishFill(answer, prep, rgba, unknown, m.feather, { grain: true, seed: m.w * 31 + m.h });
      if (padded) done = C.unpad(done, w, padded.l, padded.t, m.w, m.h);
      return { answer: { rgba: done, seconds: (Date.now() - t0) / 1000 }, transfer: [done.buffer] };
    };
  } else if (workerData.kind === 'sam') {
    const encoder = await open(workerData.files.encoder);
    const decoder = await open(workerData.files.decoder);
    let embedding = null; let embKey = null; let embSize = null;
    handlers.encode = async (m) => {
      const t0 = Date.now();
      const input = new Float32Array(m.w * m.h * 3);
      for (let i = 0; i < input.length; i++) input[i] = m.rgb[i];
      const res = await encoder.run({ [encoder.inputNames[0]]: new ort.Tensor('float32', input, [m.h, m.w, 3]) });
      embedding = res[encoder.outputNames[0]]; embKey = m.key; embSize = { w: m.w, h: m.h };
      return { answer: { key: m.key, seconds: (Date.now() - t0) / 1000 } };
    };
    handlers.decode = async (m) => {
      if (!embedding || embKey !== m.key) throw new Error('stale-embedding');
      const t0 = Date.now();
      const n = m.points.length;
      const coords = new Float32Array((n + 1) * 2); const labels = new Float32Array(n + 1);
      m.points.forEach((p, i) => { coords[i * 2] = p[0]; coords[i * 2 + 1] = p[1]; labels[i] = m.labels[i]; });
      labels[n] = -1;                                            // the "no box" padding point the exported decoder expects
      const hasMask = m.maskInput && m.maskInput.length === 256 * 256;
      const feeds = {
        image_embeddings: embedding,
        point_coords: new ort.Tensor('float32', coords, [1, n + 1, 2]),
        point_labels: new ort.Tensor('float32', labels, [1, n + 1]),
        mask_input: new ort.Tensor('float32', hasMask ? Float32Array.from(m.maskInput) : new Float32Array(256 * 256), [1, 1, 256, 256]),
        has_mask_input: new ort.Tensor('float32', new Float32Array([hasMask ? 1 : 0]), [1]),
        orig_im_size: new ort.Tensor('float32', new Float32Array([embSize.h, embSize.w]), [2]),
      };
      const res = await decoder.run(feeds);
      const masks = res.masks; const scores = res.iou_predictions.data; const low = res.low_res_masks;
      const count = masks.dims[1]; const mh = masks.dims[2]; const mw = masks.dims[3];
      const areas = [];
      for (let k = 0; k < count; k++) { let a = 0; const d = masks.data; for (let i = k * mw * mh, e = (k + 1) * mw * mh; i < e; i++) if (d[i] > 0) a++; areas.push(a); }
      const pick = count === 4 ? C.pickSamMask(Array.from(scores), m.labels, areas, mw * mh) : 0;
      const logits = Float32Array.from(masks.data.subarray(pick * mw * mh, (pick + 1) * mw * mh));
      const lowRes = Float32Array.from(low.data.subarray(pick * 65536, (pick + 1) * 65536));
      return { answer: { logits, w: mw, h: mh, lowRes, score: scores[pick], seconds: (Date.now() - t0) / 1000 }, transfer: [logits.buffer, lowRes.buffer] };
    };
  } else throw new Error('unknown model kind');

  parentPort.on('message', async (m) => {
    if (m.type === 'release') {
      for (const s of sessions) { try { await s.release(); } catch { /* ignore */ } }
      parentPort.postMessage({ type: 'released' });
      return;
    }
    const h = handlers[m.type];
    if (!h) { parentPort.postMessage({ type: 'error', id: m.id, message: 'unknown request ' + m.type }); return; }
    try {
      const { answer, transfer } = await h(m);
      parentPort.postMessage({ type: 'result', id: m.id, ...answer }, transfer || []);
    } catch (e) { parentPort.postMessage({ type: 'error', id: m.id, message: String((e && e.message) || e) }); }
  });
  parentPort.postMessage({ type: 'ready' });
})().catch((e) => parentPort.postMessage({ type: 'error', id: -1, message: String((e && e.message) || e) }));
