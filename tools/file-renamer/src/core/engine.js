'use strict';
// Doing the renames, safely, and undoing them.
//  - Every file goes to a temporary name first, then to its new name, so swaps (a->b, b->a), chains (a->b, b->c) and
//    case-only changes ("photo.JPG" -> "photo.jpg" on Windows / macOS) all work.
//  - Files inside folders that are renamed in the same batch are renamed first (deepest first).
//  - A journal describing every step is written BEFORE anything is touched, and updated when done, so a batch can be
//    undone later (also after a restart) and an interrupted batch can be put back.
//  - If a rename fails half way, everything already done in that batch is put back.
let fs;
try { fs = require('original-fs'); } catch { fs = require('fs'); }
const path = require('path');
const crypto = require('crypto');

const depthOf = (p) => path.resolve(p).split(/[\\/]+/).filter(Boolean).length;
const same = (a, b, ci) => (ci ? a.toLowerCase() === b.toLowerCase() : a === b);
const exists = (p) => { try { fs.lstatSync(p); return true; } catch { return false; } };
const statOf = (p) => { try { const s = fs.lstatSync(p); return { ino: s.ino, size: s.isDirectory() ? 0 : s.size, dir: s.isDirectory() }; } catch { return null; } };

/** Group the operations by folder depth, deepest first. */
function groupOps(ops) {
  const byDepth = new Map();
  for (const op of ops) { const d = depthOf(op.from); if (!byDepth.has(d)) byDepth.set(d, []); byDepth.get(d).push(op); }
  return [...byDepth.keys()].sort((a, b) => b - a).map((d) => byDepth.get(d));
}

class RenameError extends Error {}

/**
 * Plan a batch: ops [{ from, to }] (absolute paths, same folder). Returns the journal (not yet written).
 */
function planBatch(ops, { label } = {}) {
  const id = new Date().toISOString().replace(/[:.]/g, '-') + '-' + crypto.randomBytes(3).toString('hex');
  const tag = crypto.randomBytes(4).toString('hex');
  let n = 0;
  const groups = groupOps(ops.map((o) => ({ from: path.resolve(o.from), to: path.resolve(o.to) }))).map((g) => g.map((o) => ({ ...o, tmp: path.join(path.dirname(o.from), `.renaming-${tag}-${n++}.tmp`) })));
  return { version: 1, id, time: Date.now(), label: label || '', state: 'planned', count: ops.length, groups };
}

/** Before starting: every source is still there and no target is taken by a file outside the batch. */
function preflight(journal, { ci } = {}) {
  const problems = [];
  const sources = new Set();
  for (const g of journal.groups) for (const o of g) sources.add(ci ? o.from.toLowerCase() : o.from);
  for (const g of journal.groups) {
    for (const o of g) {
      if (!exists(o.from)) problems.push(`"${path.basename(o.from)}" is not there any more`);
      if (exists(o.to) && !sources.has(ci ? o.to.toLowerCase() : o.to) && !same(o.to, o.from, true)) problems.push(`"${path.basename(o.to)}" already exists`);
    }
  }
  return problems;
}

/**
 * Run a planned batch. `save(journal)` is called before the first rename and after the last (and on failure).
 * @returns { done: n }  throws RenameError (with everything put back) if a rename fails.
 */
async function runBatch(journal, { save = () => {}, ci = process.platform === 'win32' || process.platform === 'darwin', onProgress } = {}) {
  const problems = preflight(journal, { ci });
  if (problems.length) throw new RenameError(problems.slice(0, 5).join('; ') + (problems.length > 5 ? ` (and ${problems.length - 5} more)` : ''));
  journal.state = 'running';
  await save(journal);
  const undo = []; // steps done so far, to put back on failure: [from, to]
  let done = 0; const total = journal.count;
  try {
    for (const g of journal.groups) {
      for (const o of g) { await fs.promises.rename(o.from, o.tmp); undo.push([o.tmp, o.from]); }
      for (const o of g) {
        if (exists(o.to)) throw new RenameError(`"${path.basename(o.to)}" appeared while renaming`);
        await fs.promises.rename(o.tmp, o.to);
        undo.push([o.to, o.tmp]);
        o.after = statOf(o.to);
        done++;
        if (onProgress && done % 25 === 0) onProgress({ done, total });
      }
    }
  } catch (e) {
    const failedBack = [];
    for (let i = undo.length - 1; i >= 0; i--) { try { await fs.promises.rename(undo[i][0], undo[i][1]); } catch { failedBack.push(undo[i][1]); } }
    journal.state = failedBack.length ? 'broken' : 'rolled-back';
    journal.error = String((e && e.message) || e);
    try { await save(journal); } catch { /* ignore */ }
    const why = e && e.code === 'EACCES' || e && e.code === 'EPERM' ? 'permission denied (is a file open in another program?)' : e && e.code === 'EBUSY' ? 'a file is in use by another program' : journal.error;
    throw new RenameError(`Renaming stopped: ${why}. ` + (failedBack.length ? `${failedBack.length} file(s) could not be put back: ${failedBack.slice(0, 3).join(', ')}` : 'Every file was put back the way it was.'));
  }
  journal.state = 'done';
  journal.doneAt = Date.now();
  await save(journal);
  return { done };
}

/** Where is the file of `o` now, given that shallower folders of the batch were renamed after it? */
function currentPath(p, laterOps) {
  let cur = p;
  for (const o of laterOps) {
    const pre = o.from + path.sep;
    if (cur.startsWith(pre)) cur = o.to + path.sep + cur.slice(pre.length);
  }
  return cur;
}

/**
 * Check that a finished batch can be undone: every renamed file is still where we left it (same size and file id),
 * and its old name is free. Returns per-operation results.
 */
function verifyUndo(journal) {
  const items = [];
  journal.groups.forEach((g, gi) => {
    const later = journal.groups.slice(gi + 1).flat();
    for (const o of g) {
      if (o.undone) continue;
      // both paths inside the parent folders as they are now (still renamed, when the batch renamed them too)
      items.push({ op: o, now: currentPath(o.to, later), back: currentPath(o.from, later), problem: null });
    }
  });
  const nows = new Set(items.map((i) => i.now.toLowerCase()));
  for (const it of items) {
    const st = statOf(it.now); const a = it.op.after;
    if (!st) it.problem = `"${path.basename(it.op.to)}" is not where it was left (moved, renamed or deleted)`;
    else if (a && (st.size !== a.size || st.dir !== a.dir || (st.ino && a.ino && st.ino !== a.ino))) it.problem = `"${path.basename(it.op.to)}" was changed or replaced since`;
    else if (exists(it.back) && !same(it.back, it.now, true) && !nows.has(it.back.toLowerCase())) it.problem = `"${path.basename(it.op.from)}" is taken by another file now`;
  }
  return items;
}

/**
 * Undo a finished batch (or only the operations that still check out, with `partial`). The undo is itself a batch run
 * by the same engine (temporary names, deepest first), so swaps undo cleanly.
 */
async function undoBatch(journal, { partial = false, save = () => {}, ci } = {}) {
  if (journal.state !== 'done' && journal.state !== 'partly-undone') throw new RenameError('This batch cannot be undone (' + journal.state + ')');
  const checks = verifyUndo(journal);
  const bad = checks.filter((c) => c.problem);
  if (bad.length && !partial) {
    const err = new RenameError(`${bad.length} of ${checks.length} file(s) are not as they were left: ${bad.slice(0, 3).map((b) => b.problem).join('; ')}`);
    err.problems = bad.map((b) => b.problem); err.okCount = checks.length - bad.length;
    throw err;
  }
  const good = checks.filter((c) => !c.problem);
  // the old names are worked out inside the parent folders as they are now, so the usual order (deepest first: files,
  // then the folders around them) puts everything back
  const undoJournal = planBatch(good.map((c) => ({ from: c.now, to: c.back })), { label: 'undo of ' + journal.id });
  await runBatch(undoJournal, { ci, save: () => {} });
  for (const c of good) c.op.undone = true;
  journal.state = journal.groups.flat().every((o) => o.undone) ? 'undone' : 'partly-undone';
  journal.undoneAt = Date.now();
  await save(journal);
  return { undone: good.length, skipped: bad.map((b) => b.problem) };
}

/**
 * Put back a batch that was interrupted (the app or the computer stopped half way): every file is found at its new
 * name, its temporary name, or its old name, and returned to the old name.
 */
async function recoverInterrupted(journal, { save = () => {} } = {}) {
  let restored = 0; const lost = [];
  for (const g of [...journal.groups].reverse()) {
    for (const o of g) {
      if (exists(o.from) && !exists(o.tmp) && !(o.after && exists(o.to) && !same(o.to, o.from, true))) continue;
      const at = exists(o.tmp) ? o.tmp : exists(o.to) ? o.to : null;
      if (!at) { if (!exists(o.from)) lost.push(path.basename(o.from)); continue; }
      if (exists(o.from) && !same(at, o.from, true)) { lost.push(path.basename(o.from)); continue; }
      try { await fs.promises.rename(at, o.from); restored++; } catch { lost.push(path.basename(o.from)); }
    }
  }
  journal.state = lost.length ? 'broken' : 'rolled-back';
  await save(journal);
  return { restored, lost };
}

module.exports = { planBatch, preflight, runBatch, verifyUndo, undoBatch, recoverInterrupted, groupOps, RenameError, currentPath };
