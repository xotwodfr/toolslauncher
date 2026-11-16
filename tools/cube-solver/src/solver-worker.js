'use strict';
// Worker thread for one or more puzzles' solvers. Puzzles whose solvers share code (the 4x4 and 5x5 both use bigcube.js and
// the 3x3 tables) share a worker, so those tables are built once; every other puzzle has its own, so a slow table never
// holds up another puzzle. Messages: { type: 'init', id, solverPath } builds that solver's tables (reporting progress);
// { type: 'solve', reqId, id, colours } answers. The main process checks every answer with the puzzle's own model.
const { parentPort } = require('worker_threads');

const solvers = new Map();
parentPort.on('message', async (msg) => {
  if (!msg) return;
  if (msg.type === 'init') {
    const { id, solverPath } = msg;
    try {
      const solver = require(solverPath);
      const t0 = Date.now();
      let last = 0;
      if (typeof solver.init === 'function') {
        await solver.init((f) => {
          const now = Date.now();
          if (now - last < 40 && f < 1) return; // enough to show progress, not a flood of messages
          last = now;
          parentPort.postMessage({ type: 'progress', id, fraction: Math.max(0, Math.min(1, Number(f) || 0)) });
        });
      }
      solvers.set(id, solver);
      parentPort.postMessage({ type: 'ready', id, ms: Date.now() - t0 });
    } catch (e) {
      parentPort.postMessage({ type: 'failed', id, error: String((e && e.message) || e) });
    }
    return;
  }
  const { reqId, id, colours } = msg;
  const t = Date.now();
  try {
    const solver = solvers.get(id);
    if (!solver) throw new Error('This solver could not start');
    const r = await solver.solve(colours);
    parentPort.postMessage({ type: 'solved', reqId, result: { moves: String((r && r.moves) || ''), stages: Array.isArray(r && r.stages) ? r.stages.map((s) => ({ title: String(s.title || ''), moves: String(s.moves || '') })) : [] }, ms: Date.now() - t });
  } catch (e) {
    parentPort.postMessage({ type: 'solved', reqId, error: String((e && e.message) || e) });
  }
});
