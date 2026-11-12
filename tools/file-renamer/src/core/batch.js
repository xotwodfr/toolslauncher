'use strict';
// The list of files and the preview: adding files and folders, sorting, and turning a rule stack into new names with
// every problem found. Used by the main process and by the tests.
let fs;
try { fs = require('original-fs'); } catch { fs = require('fs'); }
const path = require('path');
const R = require('./rules');
const C = require('./checks');
const M = require('./meta');

const MAX_FILES = 20000;
const SKIP_DIRS = new Set(['.git', 'node_modules', '$RECYCLE.BIN', 'System Volume Information']);

class FileList {
  constructor() { this.items = []; this.byPath = new Map(); this.nextId = 1; }

  /**
   * Add files and folders. Folders add the files inside them (and inside sub-folders with `recursive`), or with
   * `folders: 'self'` the folder itself is added so its own name is changed.
   */
  async add(inputs, { recursive = false, folders = 'contents' } = {}) {
    const added = []; let skipped = 0; let capped = false;
    const push = (p, st) => {
      const key = process.platform === 'win32' ? p.toLowerCase() : p;
      if (this.byPath.has(key)) { skipped++; return; }
      if (this.items.length >= MAX_FILES) { capped = true; return; }
      const it = { id: this.nextId++, path: p, name: path.basename(p), dir: path.dirname(p), isDir: st.isDirectory(), size: st.isDirectory() ? 0 : st.size, mtimeMs: st.mtimeMs, birthtimeMs: st.birthtimeMs || null, order: this.nextId };
      this.items.push(it); this.byPath.set(key, it); added.push(it);
    };
    const visit = async (p, depth) => {
      if (capped) return;
      let st; try { st = await fs.promises.lstat(p); } catch { skipped++; return; }
      if (st.isSymbolicLink()) { skipped++; return; }
      if (st.isDirectory()) {
        if (depth === 0 && folders === 'self') { push(p, st); return; }
        if (depth > 0 && !recursive) return;
        if (depth > 0 && SKIP_DIRS.has(path.basename(p))) return;
        let names = []; try { names = await fs.promises.readdir(p); } catch { skipped++; return; }
        names.sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
        for (const n of names) await visit(path.join(p, n), depth + 1);
      } else if (st.isFile()) push(p, st);
    };
    for (const p of inputs) if (typeof p === 'string' && path.isAbsolute(p)) await visit(path.resolve(p), 0);
    return { added, skipped, capped };
  }

  remove(ids) { const set = new Set(ids); this.items = this.items.filter((i) => !set.has(i.id)); this.byPath = new Map(this.items.map((i) => [process.platform === 'win32' ? i.path.toLowerCase() : i.path, i])); }
  clear() { this.items = []; this.byPath.clear(); }

  /** After a batch: the files now have their new names. */
  moved(pairs) {
    for (const { id, to } of pairs) {
      const it = this.items.find((i) => i.id === id);
      if (!it) continue;
      it.path = to; it.name = path.basename(to); it.dir = path.dirname(to);
      try { const st = fs.statSync(to); it.mtimeMs = st.mtimeMs; it.size = st.isDirectory() ? 0 : st.size; } catch { /* ignore */ }
    }
    this.byPath = new Map(this.items.map((i) => [process.platform === 'win32' ? i.path.toLowerCase() : i.path, i]));
  }

  /** Re-read the files' details; files that are gone are dropped. */
  refresh() {
    const gone = [];
    for (const it of this.items) { try { const st = fs.statSync(it.path); it.mtimeMs = st.mtimeMs; it.size = st.isDirectory() ? 0 : st.size; } catch { gone.push(it.id); } }
    if (gone.length) this.remove(gone);
    return gone.length;
  }

  sorted(by = 'name', reverse = false) {
    const cmpName = (a, b) => a.dir.localeCompare(b.dir, undefined, { numeric: true, sensitivity: 'base' }) || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
    const sorters = {
      name: cmpName,
      added: (a, b) => a.order - b.order,
      modified: (a, b) => a.mtimeMs - b.mtimeMs || cmpName(a, b),
      size: (a, b) => a.size - b.size || cmpName(a, b),
    };
    const list = this.items.slice().sort(sorters[by] || cmpName);
    return reverse ? list.reverse() : list;
  }
}

/**
 * The preview: new names for the files in this order, checked.
 * @returns { rows: [{ id, oldName, newName, status, errors, warnings, caseOnly, swap, dir }], summary }
 */
async function preview(list, rules, opts = {}) {
  const clean = R.sanitizeRules(rules);
  const files = list.map((i) => ({ ...i }));
  await M.enrich(files, R.needs(clean), { signal: opts.signal });
  const named = R.applyRules(files, clean);
  const ruleTitle = (i) => `Rule ${i + 1}`;
  const rows = C.checkBatch(files.map((f, i) => ({ id: f.id, path: f.path, newName: named[i].name, ruleErrors: named[i].errors.map((e) => `${ruleTitle(e.rule)}: ${e.message}`) })), { strict: opts.strict, autoSuffix: opts.autoSuffix, ciDirs: opts.ciDirs });
  return { rows, summary: C.summarize(rows) };
}

module.exports = { FileList, preview, MAX_FILES };
