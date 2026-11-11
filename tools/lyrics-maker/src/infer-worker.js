'use strict';
// Runs Whisper in its own thread: onnxruntime's `session.run()` blocks the thread that calls it for the whole run, which in the
// app's main process would freeze the window. This thread is never killed while it is inside a run (that takes the whole process
// down with it - measured): cancelling sets a flag that is looked at between runs, and releasing waits for the work in progress.
//
// Messages in:  { type: 'transcribe', id, samples: Float32Array (16 kHz mono), language, lyrics?: string[] } | { type: 'cancel', id } | { type: 'release' }
//               With `lyrics` (the user's own lines), the song is listened to first and then those lines are timed word by word.
// Messages out: { type: 'ready' } | { type: 'segments', id, segments } | { type: 'progress', id, ... }
//               | { type: 'done', id, language, segments, lines?, matched? } | { type: 'cancelled', id } | { type: 'error', id, message } | { type: 'released' }
const { parentPort, workerData } = require('worker_threads');

(async () => {
  const ort = require('onnxruntime-node');
  const W = require('./whisper');
  const whisper = await W.createWhisper({ ort, dir: workerData.dir, options: workerData.options, decoderOptions: workerData.decoderOptions });
  let current = null;
  let releaseAfter = false;
  const post = (m) => parentPort.postMessage(m);
  async function doRelease() { try { await whisper.release(); } catch { /* ignore */ } post({ type: 'released' }); }

  parentPort.on('message', async (m) => {
    if (m.type === 'transcribe') {
      if (current) { post({ type: 'error', id: m.id, message: 'Already working on another song' }); return; }
      const job = { id: m.id, stop: false };
      current = job;
      const lyrics = Array.isArray(m.lyrics) && m.lyrics.length ? m.lyrics : null;
      const LISTEN = lyrics ? 0.7 : 1;               // with pasted lyrics, listening is the first 70 % of the work
      const shouldStop = () => job.stop || releaseAfter;
      try {
        const r = await whisper.transcribe(m.samples, {
          language: m.language || 'auto',
          shouldStop,
          onSegments: (segments) => { if (!lyrics) post({ type: 'segments', id: m.id, segments }); },
          onProgress: (p) => post({ type: 'progress', id: m.id, ...p, fraction: p.fraction * LISTEN, phase: 'listening' }),
        });
        if (!lyrics) { post({ type: 'done', id: m.id, language: r.language, segments: r.segments }); return; }
        const heard = [];
        for (const s of r.segments) for (const w of s.words || []) heard.push(w);
        const t0 = Date.now();
        const a = await whisper.alignLyrics(m.samples, lyrics, {
          language: r.language, heard, shouldStop,
          onProgress: (p) => post({ type: 'progress', id: m.id, fraction: LISTEN + (1 - LISTEN) * p.fraction, elapsed: (Date.now() - t0) / 1000, phase: 'timing' }),
        });
        post({ type: 'done', id: m.id, language: r.language, segments: r.segments, lines: a.lines, matched: a.matched });
      } catch (e) {
        if (e && e.cancelled) post({ type: 'cancelled', id: m.id });
        else post({ type: 'error', id: m.id, message: String((e && e.message) || e), userError: !!(e && e.userError) });
      } finally {
        current = null;
        if (releaseAfter) await doRelease();
      }
    } else if (m.type === 'cancel') {
      if (current && current.id === m.id) current.stop = true;
    } else if (m.type === 'release') {
      if (current) releaseAfter = true; else await doRelease();
    }
  });
  post({ type: 'ready' });
})().catch((e) => parentPort.postMessage({ type: 'error', id: -1, message: String((e && e.message) || e) }));
