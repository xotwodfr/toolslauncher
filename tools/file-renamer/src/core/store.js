'use strict';
// What the app keeps in its own folder (userData): the journal of every batch (for undo, also after a restart) and the
// saved rule stacks (presets). Every file is written to "<name>.part" first and then renamed.
let fs;
try { fs = require('original-fs'); } catch { fs = require('fs'); }
const path = require('path');
const { sanitizeRules } = require('./rules');

const KEEP = 50;

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const part = file + '.part';
  fs.writeFileSync(part, JSON.stringify(data, null, 1));
  fs.renameSync(part, file);
}
function readJson(file, fallback) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } }

class History {
  constructor(dir) { this.dir = dir; }
  file(id) { if (!/^[\w-]+$/.test(id)) throw new Error('Bad batch id'); return path.join(this.dir, id + '.json'); }
  save(journal) { writeJson(this.file(journal.id), journal); }
  get(id) { const j = readJson(this.file(id), null); if (!j) throw new Error('That batch is not in the history any more'); return j; }
  /** Newest first; batches that never started are left out. Older ones beyond KEEP are removed. */
  list() {
    let names = [];
    try { names = fs.readdirSync(this.dir).filter((n) => n.endsWith('.json')); } catch { return []; }
    const all = names.map((n) => readJson(path.join(this.dir, n), null)).filter((j) => j && j.groups && j.state !== 'planned');
    all.sort((a, b) => b.time - a.time);
    for (const old of all.slice(KEEP)) { try { fs.rmSync(this.file(old.id), { force: true }); } catch { /* ignore */ } }
    return all.slice(0, KEEP);
  }
  /** Batches that were running when the app stopped. */
  interrupted() { return this.list().filter((j) => j.state === 'running'); }
}

/** A short description of a batch for the history list (no file contents, just names). */
function describe(j) {
  const ops = j.groups.flat();
  const folders = [...new Set(ops.map((o) => path.dirname(o.from)))];
  return {
    id: j.id, time: j.time, state: j.state, count: j.count, label: j.label || '',
    folder: folders.length === 1 ? folders[0] : `${folders.length} folders`,
    sample: ops.slice(0, 3).map((o) => ({ from: path.basename(o.from), to: path.basename(o.to) })),
    undone: ops.filter((o) => o.undone).length,
  };
}

class Presets {
  constructor(file) { this.file = file; }
  all() { const d = readJson(this.file, { presets: [] }); return Array.isArray(d.presets) ? d.presets.filter((p) => p && typeof p.name === 'string').map((p) => ({ name: p.name, rules: sanitizeRules(p.rules) })) : []; }
  save(name, rules) {
    name = String(name || '').trim().slice(0, 80);
    if (!name) throw new Error('Give the preset a name');
    const list = this.all().filter((p) => p.name !== name);
    list.push({ name, rules: sanitizeRules(rules) });
    list.sort((a, b) => a.name.localeCompare(b.name));
    writeJson(this.file, { presets: list });
    return list;
  }
  remove(name) { const list = this.all().filter((p) => p.name !== name); writeJson(this.file, { presets: list }); return list; }
}

module.exports = { History, Presets, describe, writeJson, readJson };
