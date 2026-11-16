'use strict';
// Runs the puzzles' solvers for the main process (and the tests): worker threads (one per puzzle, or one per group of puzzles
// whose solvers share code, like the 4x4 and 5x5), solvers started in the background one after another (the 3x3 first, a puzzle the window asks for jumps the queue), start-up progress per puzzle, a time limit per
// request, and a check of every answer with the puzzle's own model (applyMoves + isSolved). Nothing reaches the window
// unverified.
const fs = require('fs');
const path = require('path');
const { Worker } = require('worker_threads');

/** Puzzles whose solvers use the same helper file next to them (require('./x')) share a worker, so shared tables are built once. */
function workerGroups(puzzles) {
  const helpers = (file) => { try { return [...fs.readFileSync(file, 'utf8').matchAll(/require\(\s*['"]\.\/([\w.-]+?)(?:\.js)?['"]\s*\)/g)].map((m) => path.join(path.dirname(file), m[1])); } catch { return []; } };
  const group = new Map(); const byHelper = new Map();
  for (const p of puzzles) {
    let g = p.id;
    for (const h of helpers(p.solverPath)) { if (byHelper.has(h)) { g = byHelper.get(h); break; } }
    for (const h of helpers(p.solverPath)) if (!byHelper.has(h)) byHelper.set(h, g);
    group.set(p.id, g);
  }
  return group;
}

const TIME_LIMIT = 60000;

class Engine {
  /** puzzles: [{ id, def, solverPath }] (from puzzles/index.js loadAll); first: the id to start first. */
  constructor({ onStatus, puzzles, first } = {}) {
    if (!puzzles) puzzles = require('./puzzles').loadAll();
    this.onStatus = onStatus || (() => {});
    this.puzzles = new Map(puzzles.map((p) => [p.id, p]));
    this.order = puzzles.map((p) => p.id);
    this.workers = new Map();   // puzzle id -> its worker (shared within a group)
    this.groupWorkers = new Map(); // group -> worker
    this.group = workerGroups(puzzles);
    this.status = { puzzles: Object.fromEntries(this.order.map((id) => [id, { ready: false, progress: 0, started: false, error: null }])), error: null };
    this.pending = new Map();
    this.nextId = 1;
    this.closing = false;
    this.want(first && this.puzzles.has(first) ? first : this.order[0]);
  }
  emit() { this.onStatus(JSON.parse(JSON.stringify(this.status))); }
  /** Starts this puzzle's solver now (if it is not running yet). */
  want(id) {
    if (!this.puzzles.has(id) || this.workers.has(id) || this.closing) return;
    this.startWorker(id);
  }
  /** The background queue: the next puzzle starts when no other is still building its tables. */
  next() {
    if (this.closing) return;
    const building = [...this.workers.keys()].some((id) => { const s = this.status.puzzles[id]; return !s.ready && !s.error; });
    if (building) return;
    const id = this.order.find((x) => !this.workers.has(x));
    if (id) this.startWorker(id);
  }
  startWorker(id) {
    const p = this.puzzles.get(id);
    const st = this.status.puzzles[id];
    Object.assign(st, { ready: false, progress: 0, started: true, error: null });
    const g = this.group.get(id);
    let w = this.groupWorkers.get(g);
    if (!w) {
      w = new Worker(path.join(__dirname, 'solver-worker.js'));
      this.groupWorkers.set(g, w);
      w.on('message', (m) => this.onMessage(m));
      w.on('error', (e) => { for (const [pid, pw] of this.workers) if (pw === w) { const s2 = this.status.puzzles[pid]; s2.error = String((e && e.message) || e); this.failFor(pid, s2.error); } this.emit(); this.next(); });
      w.on('exit', (code) => {
        if (this.closing || this.groupWorkers.get(g) !== w) return;
        this.groupWorkers.delete(g);
        for (const [pid, pw] of [...this.workers]) {
          if (pw !== w) continue;
          this.workers.delete(pid);
          const s2 = this.status.puzzles[pid];
          if (!s2.error) s2.error = 'The solver stopped (code ' + code + ')';
          s2.ready = false; this.failFor(pid, s2.error);
        }
        this.emit();
      });
    }
    this.workers.set(id, w);
    w.postMessage({ type: 'init', id, solverPath: p.solverPath });
    this.emit();
  }
  onMessage(m) {
    const st = m.id && this.status.puzzles[m.id];
    if (m.type === 'progress' && st) { st.progress = m.fraction; this.emit(); }
    else if (m.type === 'ready' && st) { st.ready = true; st.progress = 1; st.ms = m.ms; this.emit(); this.next(); }
    else if (m.type === 'failed' && st) { st.error = m.error; this.emit(); this.failFor(m.id, 'The ' + this.puzzles.get(m.id).def.short + ' solver could not start: ' + m.error); this.next(); }
    else if (m.type === 'solved') {
      const q = this.pending.get(m.reqId);
      if (!q) return;
      this.pending.delete(m.reqId);
      clearTimeout(q.timer);
      if (m.error) q.reject(new Error(m.error)); else q.resolve(m);
    }
  }
  failFor(id, why) { for (const [k, q] of this.pending) if (q.id === id) { clearTimeout(q.timer); q.reject(new Error(why)); this.pending.delete(k); } }
  isReady(id) { const s = this.status.puzzles[id]; return !!(s && s.ready); }
  /** Waits until this puzzle's solver is ready (starting it if needed). */
  whenReady(id) {
    if (!this.puzzles.has(id)) return Promise.reject(new Error('Unknown puzzle ' + id));
    this.want(id);
    if (this.isReady(id)) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const check = setInterval(() => {
        const s = this.status.puzzles[id];
        if (s.ready) { clearInterval(check); resolve(); }
        else if (s.error) { clearInterval(check); reject(new Error(s.error)); }
      }, 50);
    });
  }
  /**
   * colours: one colour key per sticker of a VALID state. Resolves { moves: [move objects], text, stages: [{ title, moves:
   * text, count }], ms, solverMs } with an answer that was checked to solve exactly these colours.
   */
  async solve(id, colours) {
    const p = this.puzzles.get(id);
    if (!p) throw new Error('Unknown puzzle ' + id);
    const P = p.def.puzzle;
    const arr = Array.from(colours);
    if (arr.length !== P.size) throw new Error(`A ${p.def.short} has ${P.size} stickers`);
    if (P.isSolved(arr)) return { moves: [], text: '', stages: [], ms: 0, solverMs: 0 };
    await this.whenReady(id);
    const t0 = Date.now();
    const m = await new Promise((resolve, reject) => {
      const reqId = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(reqId);
        reject(new Error('The solver took too long; it has been restarted. Please try again.'));
        this.restart(id);
      }, TIME_LIMIT);
      this.pending.set(reqId, { id, resolve, reject, timer });
      this.workers.get(id).postMessage({ type: 'solve', reqId, id, colours: arr });
    });
    let moves;
    try { moves = P.parseMoves(m.result.moves); } catch (e) { throw new Error('The solver gave an answer this app cannot read, so it is not shown. Please report this. (' + e.message + ')'); }
    if (!P.isSolved(P.applyMoves(arr, moves))) throw new Error('The solver gave an answer that does not solve this puzzle, so it is not shown. Please report this.');
    // the stages must add up to exactly the whole answer; if they do not, show it as one stage
    let stages = [];
    try {
      stages = m.result.stages.map((s) => ({ title: s.title || 'Solve', moves: P.parseMoves(s.moves) })).filter((s) => s.moves.length);
      const joined = stages.flatMap((s) => s.moves);
      if (P.formatMoves(joined) !== P.formatMoves(moves)) stages = [];
    } catch { stages = []; }
    if (!stages.length && moves.length) stages = [{ title: 'Solve', moves }];
    return {
      moves, text: P.formatMoves(moves),
      stages: stages.map((s) => ({ title: s.title, moves: P.formatMoves(s.moves), count: s.moves.length })),
      ms: Date.now() - t0, solverMs: m.ms,
    };
  }
  restart(id) {
    // the whole worker goes (it may be stuck); every puzzle it served starts again
    const w = this.workers.get(id);
    const ids = [...this.workers].filter(([, pw]) => pw === w).map(([pid]) => pid);
    this.groupWorkers.delete(this.group.get(id));
    for (const pid of ids) { this.workers.delete(pid); this.failFor(pid, 'restarted'); }
    if (w) { try { w.terminate(); } catch { /* ignore */ } }
    for (const pid of ids) this.startWorker(pid);
  }
  close() {
    this.closing = true;
    for (const q of this.pending.values()) { clearTimeout(q.timer); q.reject(new Error('closed')); }
    this.pending.clear();
    return Promise.all([...this.groupWorkers.values()].map((w) => w.terminate()));
  }
}
module.exports = { Engine };
