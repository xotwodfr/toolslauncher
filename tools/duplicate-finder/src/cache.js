'use strict';
// A small JSON cache (path + size + modified time -> something expensive like a hash), so scanning the same folders again
// is fast. If it is missing, damaged or from another version it is simply ignored.
let fs;
try { fs = require('original-fs'); } catch { fs = require('fs'); }
const path = require('path');

const key = (rec) => `${rec.path}|${rec.size}|${Math.round(rec.mtimeMs)}`;

function load(file, version) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (j && j.version === version && j.entries && typeof j.entries === 'object') return new Map(Object.entries(j.entries));
  } catch { /* none yet */ }
  return new Map();
}

/** Writes only the entries in `keep` (the files seen in this scan), so the cache never grows with deleted files. */
function save(file, version, map, keep) {
  try {
    const entries = {};
    for (const k of keep || map.keys()) if (map.has(k)) entries[k] = map.get(k);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version, entries }));
    fs.renameSync(tmp, file);
  } catch { /* read-only profile: carry on without a cache */ }
}

module.exports = { key, load, save };
