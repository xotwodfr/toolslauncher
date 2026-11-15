'use strict';
// Worker thread for ONE puzzle's solver (workerData: { id, solverPath }): builds its tables once (reporting progress), then
// answers solve requests. Each puzzle has its own worker, so a slow table (Megaminx) never holds up another puzzle. The main
// process checks every answer with the puzzle's own model before the window sees it.
const { parentPort, workerData } = require('worker_threads');

const { id, solverPath } = workerData;
let solver;
try {
  solver = require(solverPath);
  const t0 = Date.now();
  let last = 0;
  if (typeof solver.init === 'function') {
    solver.init((f) => {
      const now = Date.now();
      if (now - last < 40 && f < 1) return; // enough to show progress, not a flood of messages
      last = now;
      parentPort.postMessage({ type: 'progress', id, fraction: Math.max(0, Math.min(1, Number(f) || 0)) });
    });
  }
  parentPort.postMessage({ type: 'ready', id, ms: Date.now() - t0 });
} catch (e) {
  parentPort.postMessage({ type: 'failed', id, error: String((e && e.message) || e) });
}

parentPort.on('message', async (msg) => {
  const { reqId, colours } = msg || {};
  const t = Date.now();
  try {
    if (!solver) throw new Error('This solver could not start');
    const r = await solver.solve(colours);
    parentPort.postMessage({ type: 'solved', reqId, result: { moves: String((r && r.moves) || ''), stages: Array.isArray(r && r.stages) ? r.stages.map((s) => ({ title: String(s.title || ''), moves: String(s.moves || '') })) : [] }, ms: Date.now() - t });
  } catch (e) {
    parentPort.postMessage({ type: 'solved', reqId, error: String((e && e.message) || e) });
  }
});
