'use strict';
// Runs the solver worker for the main process (and the tests): start-up progress, one request at a time, a time limit, and
// a check of every solution against our own cube model. Nothing reaches the window unverified.
const path = require('path');
const { Worker } = require('worker_threads');
const C = require('./cube');

const TIME_LIMIT = 60000;

class Engine {
  constructor({ onStatus } = {}) {
    this.onStatus = onStatus || (() => {});
    this.status = { ready2: false, ready3: false, progress2: 0, progress3: 0, error: null };
    this.pending = new Map();
    this.nextId = 1;
    this.start();
  }
  start() {
    this.status = { ready2: false, ready3: false, progress2: 0, progress3: 0, error: null };
    const w = new Worker(path.join(__dirname, 'solver-worker.js'));
    this.worker = w;
    w.on('message', (m) => {
      if (m.type === 'progress') { this.status[`progress${m.which}`] = m.fraction; this.onStatus({ ...this.status }); }
      else if (m.type === 'ready') { this.status[`ready${m.which}`] = true; this.status[`progress${m.which}`] = 1; this.status[`ms${m.which}`] = m.ms; this.onStatus({ ...this.status }); }
      else if (m.type === 'solved') {
        const p = this.pending.get(m.id);
        if (!p) return;
        this.pending.delete(m.id);
        clearTimeout(p.timer);
        if (m.error) p.reject(new Error(m.error)); else p.resolve(m);
      }
    });
    w.on('error', (e) => { this.status.error = String((e && e.message) || e); this.onStatus({ ...this.status }); this.failAll(this.status.error); });
    w.on('exit', (code) => { if (this.worker === w && !this.closing) { this.failAll('The solver stopped (code ' + code + ')'); } });
  }
  failAll(why) { for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error(why)); } this.pending.clear(); }
  /** Waits until the solver for this size is ready. */
  whenReady(size) {
    if (this.status[`ready${size}`]) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const check = setInterval(() => {
        if (this.status[`ready${size}`]) { clearInterval(check); resolve(); }
        else if (this.status.error) { clearInterval(check); reject(new Error(this.status.error)); }
      }, 50);
    });
  }
  /** size 2 or 3, faces = face letters. Resolves { moves, ms } with a solution that was checked to solve the cube. */
  async solve(size, faces) {
    const arr = Array.from(faces);
    const t0 = Date.now();
    const m = await new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('The solver took too long; it has been restarted. Please try again.'));
        this.restart();
      }, TIME_LIMIT);
      this.pending.set(id, { resolve, reject, timer });
      this.worker.postMessage({ id, size, faces: arr });
    });
    const moves = C.parseMoves(m.moves);
    if (!C.isSolved(size, C.applyMoves(size, arr, moves))) throw new Error('The solver gave an answer that does not solve this cube, so it is not shown. Please report this.');
    return { moves, ms: Date.now() - t0, solverMs: m.ms };
  }
  restart() { this.closing = true; try { this.worker.terminate(); } catch { /* ignore */ } this.closing = false; this.failAll('restarted'); this.start(); }
  close() { this.closing = true; this.failAll('closed'); return this.worker.terminate(); }
}
module.exports = { Engine };
