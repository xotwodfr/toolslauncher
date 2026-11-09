'use strict';
// Runs song analysis on a few worker threads so the window stays responsive and several songs are analysed at once.
// Electron-free. Cancel stops everything immediately (workers are terminated; new ones start for the next job).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Worker } = require('worker_threads');

const asarFix = (p) => p.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');

function ffmpegPath() {
  try {
    const p = require('ffmpeg-static');
    if (p) { const real = asarFix(p); if (fs.existsSync(real)) return real; }
  } catch { /* fall through */ }
  return 'ffmpeg';
}

const cancelledError = () => Object.assign(new Error('Cancelled'), { cancelled: true });

class Pool {
  /** @param {{size?:number, ffmpeg?:string}} [o] */
  constructor({ size, ffmpeg } = {}) {
    const cpus = os.cpus().length || 2;
    this.size = Math.max(1, Math.min(size || Math.floor(cpus / 2), 6)); // analysis is CPU-bound; leave half the processor for the rest
    this.ffmpeg = ffmpeg || ffmpegPath();
    this.workers = new Set();
    this.idle = [];
    this.queue = [];
    this.nextId = 1;
    this.closed = false;
  }

  _spawn() {
    const w = new Worker(path.join(__dirname, 'worker.js'));
    w.job = null;
    w.on('message', (m) => {
      const job = w.job;
      w.job = null;
      if (job && m.id === job.id) { if (m.error) job.reject(Object.assign(new Error(m.error), { analysis: true })); else job.resolve(m.result); }
      this._release(w);
    });
    const dead = (err) => {
      this.workers.delete(w);
      this.idle = this.idle.filter((x) => x !== w);
      const job = w.job; w.job = null;
      if (job) job.reject(err || new Error('The analysis stopped unexpectedly'));
      this._pump();
    };
    w.on('error', dead);
    w.on('exit', () => dead(null));
    this.workers.add(w);
    return w;
  }

  _release(w) { if (this.workers.has(w)) { this.idle.push(w); this._pump(); } }

  _pump() {
    while (!this.closed && this.queue.length) {
      let w = this.idle.pop();
      if (!w) { if (this.workers.size >= this.size) return; w = this._spawn(); }
      const job = this.queue.shift();
      w.job = job;
      w.postMessage({ id: job.id, file: job.file, duration: job.duration, ffmpeg: this.ffmpeg });
    }
  }

  /** @returns {Promise<object>} the analysis of one file (see analyse.js) */
  run(file, duration = 0) {
    if (this.closed) return Promise.reject(cancelledError());
    return new Promise((resolve, reject) => {
      this.queue.push({ id: this.nextId++, file, duration, resolve, reject });
      this._pump();
    });
  }

  /** Reject everything waiting or running and stop the workers. The pool can be used again afterwards. */
  cancel() {
    const err = cancelledError();
    for (const j of this.queue.splice(0)) j.reject(err);
    for (const w of [...this.workers]) {
      const job = w.job; w.job = null;
      this.workers.delete(w);
      this.idle = this.idle.filter((x) => x !== w);
      if (job) job.reject(err);
      w.terminate();
    }
  }

  close() { this.closed = true; this.cancel(); }
}

module.exports = { Pool, ffmpegPath };
