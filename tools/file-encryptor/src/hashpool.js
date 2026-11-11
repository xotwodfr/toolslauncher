'use strict';
// Hashes several files at once on worker threads (hashing is CPU work; this keeps the window responsive and uses more
// than one core for many files). Cancel terminates the workers at once; new ones start for the next job.
const os = require('os');
const path = require('path');
const { Worker } = require('worker_threads');

const cancelledError = () => Object.assign(new Error('Cancelled'), { cancelled: true });

class HashPool {
  constructor({ size } = {}) {
    this.size = Math.max(1, Math.min(size || (os.cpus().length || 2) - 1, 4));
    this.workers = new Set(); this.idle = []; this.queue = []; this.nextId = 1;
  }

  _spawn() {
    const w = new Worker(path.join(__dirname, 'hash-worker.js'));
    w.job = null;
    w.on('message', (m) => {
      const job = w.job;
      if (!job || m.id !== job.id) return;
      if (m.progress && job.onBytes) job.onBytes(m.progress);
      if (m.digests || m.error) {
        w.job = null;
        if (m.error) job.reject(new Error(m.error)); else job.resolve(m.digests);
        this.idle.push(w); this._pump();
      }
    });
    const dead = (err) => {
      this.workers.delete(w); this.idle = this.idle.filter((x) => x !== w);
      const job = w.job; w.job = null;
      if (job) job.reject(err || new Error('Hashing stopped unexpectedly'));
      this._pump();
    };
    w.on('error', dead); w.on('exit', () => dead(null));
    this.workers.add(w);
    return w;
  }

  _pump() {
    while (this.queue.length) {
      let w = this.idle.pop();
      if (!w && this.workers.size < this.size) w = this._spawn();
      if (!w) return;
      const job = this.queue.shift();
      w.job = job;
      w.postMessage({ id: job.id, file: job.file, algs: job.algs });
    }
  }

  /** Resolves with { sha256: hex, ... }. onBytes(n) reports progress. */
  hash(file, algs, onBytes) {
    return new Promise((resolve, reject) => { this.queue.push({ id: this.nextId++, file, algs, onBytes, resolve, reject }); this._pump(); });
  }

  cancel() {
    const q = this.queue; this.queue = [];
    for (const j of q) j.reject(cancelledError());
    for (const w of [...this.workers]) { const j = w.job; w.job = null; if (j) j.reject(cancelledError()); w.terminate(); }
    this.workers.clear(); this.idle = [];
  }

  close() { this.cancel(); }
}

module.exports = { HashPool };
