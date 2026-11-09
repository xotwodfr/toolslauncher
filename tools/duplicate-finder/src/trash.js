'use strict';
// Moving the chosen files to the Recycle Bin, with every safety check the app promises:
//  - at least one copy of every group is always left,
//  - files in protected folders and in system folders are refused,
//  - a file that changed since the scan (size or modified time) is skipped,
//  - for exact duplicates the file is compared byte for byte with the copy that stays, right before it is moved,
//  - nothing is ever deleted for good: the only thing done to a file is `trashItem`.
let fs;
try { fs = require('original-fs'); } catch { fs = require('fs'); }
const path = require('path');

const WIN = process.platform === 'win32';
const norm = (p) => (WIN ? path.resolve(p).toLowerCase() : path.resolve(p));

function systemDirs() {
  const list = [];
  if (WIN) {
    for (const v of ['SystemRoot', 'windir', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432', 'ProgramData']) if (process.env[v]) list.push(process.env[v]);
  } else {
    list.push('/bin', '/boot', '/dev', '/etc', '/lib', '/lib32', '/lib64', '/proc', '/run', '/sbin', '/sys', '/usr', '/System', '/Library');
  }
  return list.map(norm);
}

/** Is this path inside a folder that belongs to the operating system? */
function isSystemPath(p, dirs = systemDirs()) {
  const n = norm(p);
  return dirs.map(norm).some((d) => n === d || n.startsWith(d.endsWith(path.sep) ? d : d + path.sep));
}

class PlanError extends Error {}

/**
 * Check a selection against the scan results and describe what would happen.
 * @param groups  [{ id, kind, files: [{ id, path, size, mtimeMs, keep }] }]
 * @param selectedIds  ids of files to move to the Recycle Bin
 */
function planTrash(groups, selectedIds, { dirs } = {}) {
  const chosen = new Set(selectedIds);
  const items = [];
  const problems = [];
  const seen = new Set();
  for (const g of groups) {
    const picked = g.files.filter((f) => chosen.has(f.id));
    if (!picked.length) continue;
    if (picked.length >= g.files.length) { problems.push(`Every copy of "${path.basename(picked[0].path)}" is selected. At least one copy must stay.`); continue; }
    const stays = g.files.filter((f) => !chosen.has(f.id));
    for (const f of picked) {
      if (f.keep) { problems.push(`"${path.basename(f.path)}" is in a protected folder`); continue; }
      if (isSystemPath(f.path, dirs)) { problems.push(`"${path.basename(f.path)}" is in a system folder`); continue; }
      if (seen.has(norm(f.path))) continue;
      seen.add(norm(f.path));
      items.push({ id: f.id, path: f.path, size: f.size, mtimeMs: f.mtimeMs, groupId: g.id, kind: g.kind, stays: stays.map((s) => ({ id: s.id, path: s.path, size: s.size, mtimeMs: s.mtimeMs })) });
    }
  }
  return { items, problems, bytes: items.reduce((n, i) => n + i.size, 0) };
}

/** Are two files byte for byte the same? */
async function sameBytes(a, b) {
  const [sa, sb] = [fs.statSync(a), fs.statSync(b)];
  if (sa.size !== sb.size) return false;
  const [fa, fb] = [await fs.promises.open(a, 'r'), await fs.promises.open(b, 'r')];
  try {
    const A = Buffer.alloc(1 << 20);
    const B = Buffer.alloc(1 << 20);
    for (let pos = 0; pos < sa.size;) {
      const ra = await fa.read(A, 0, A.length, pos);
      const rb = await fb.read(B, 0, B.length, pos);
      if (ra.bytesRead !== rb.bytesRead || ra.bytesRead === 0) return false;
      if (Buffer.compare(A.subarray(0, ra.bytesRead), B.subarray(0, rb.bytesRead)) !== 0) return false;
      pos += ra.bytesRead;
    }
    return true;
  } finally { await fa.close(); await fb.close(); }
}

/** Is the file still the one that was scanned: there, a regular file, same size and modified time? null = yes. */
function unchanged(rec) {
  let st;
  try { st = fs.lstatSync(rec.path); } catch { return 'it is gone'; }
  if (!st.isFile()) return 'it is not a regular file any more';
  if (st.size !== rec.size || Math.abs(st.mtimeMs - rec.mtimeMs) > 2) return 'it changed after the scan';
  return null;
}

/**
 * Move the planned files to the Recycle Bin one by one.
 * @param plan   result of planTrash
 * @param hooks  { trashItem: (path) => Promise<void>, onProgress({done,total,item}), signal }
 * @returns {{ moved: [{id, path, size}], skipped: [{id, path, reason}] }}
 */
async function executeTrash(plan, hooks) {
  const moved = [];
  const skipped = [];
  const total = plan.items.length;
  const gone = new Set(); // paths already moved: a copy that was moved is no longer a copy that stays
  let done = 0;
  for (const item of plan.items) {
    if (hooks.signal && hooks.signal.aborted) { skipped.push({ id: item.id, path: item.path, reason: 'stopped' }); continue; }
    try {
      const problem = unchanged(item);
      if (problem) throw new PlanError(problem);
      // a copy must still be there to keep: same file as scanned, and not one we moved ourselves
      let keeper = null;
      for (const s of item.stays) { if (!gone.has(norm(s.path)) && !unchanged(s)) { keeper = s; break; } }
      if (!keeper) throw new PlanError('no other copy was found to keep');
      if (item.kind === 'exact' && !(await sameBytes(item.path, keeper.path))) throw new PlanError('it is not identical to the copy that stays any more');
      await hooks.trashItem(item.path);
      gone.add(norm(item.path));
      moved.push({ id: item.id, path: item.path, size: item.size });
    } catch (e) {
      skipped.push({ id: item.id, path: item.path, reason: e instanceof PlanError ? e.message : String((e && e.message) || e) });
    }
    done++;
    if (hooks.onProgress) hooks.onProgress({ done, total, item });
  }
  return { moved, skipped };
}

module.exports = { planTrash, executeTrash, sameBytes, isSystemPath, systemDirs, unchanged, PlanError };
