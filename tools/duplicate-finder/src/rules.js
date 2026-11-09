'use strict';
// "Which copy do I keep?" Rules that suggest what to keep in each group. They only SUGGEST: the review screen shows the
// result and the person can change it before anything is moved.
//
// A group is { kind, files: [{ id, path, size, mtimeMs, keep, root, quality?, pixels? }] }.
// A file with keep = true lives in a protected folder and is never offered for deletion.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Rules = factory();
}(typeof self !== 'undefined' ? self : this, function () {

const RULES = {
  oldest:    { label: 'Keep the oldest' },
  newest:    { label: 'Keep the newest' },
  shortest:  { label: 'Keep the one with the shortest path' },
  firstroot: { label: 'Keep the one in the first folder in the list' },
  best:      { label: 'Keep the best quality' },
};

const byPath = (a, b) => a.path.localeCompare(b.path, undefined, { numeric: true });

/** The one file to keep from a list, by rule. Always returns a file. Ties go to the first path in alphabetical order. */
function pickKeeper(files, rule) {
  const list = files.slice().sort(byPath);
  const best = (score) => list.reduce((b, f) => (score(f) > score(b) ? f : b), list[0]);
  switch (rule) {
    case 'newest': return best((f) => f.mtimeMs);
    case 'shortest': return best((f) => -f.path.length);
    case 'firstroot': return best((f) => -f.root);
    case 'best': return best((f) => (f.quality || f.pixels || 0) * 1e3 + Math.min(999, f.size / 1e6));
    case 'oldest':
    default: return best((f) => -f.mtimeMs);
  }
}

/**
 * Ids to move to the Recycle Bin for one group under a rule.
 * If the group has a copy in a protected folder, that copy IS the keeper and every other copy is suggested.
 */
function suggestTrash(group, rule) {
  const protectedFiles = group.files.filter((f) => f.keep);
  if (protectedFiles.length) return group.files.filter((f) => !f.keep).map((f) => f.id);
  const keeper = pickKeeper(group.files, rule);
  return group.files.filter((f) => f !== keeper).map((f) => f.id);
}

/** Apply a rule to every group: returns the set of ids suggested for the Recycle Bin. */
function suggestAll(groups, rule) {
  const out = new Set();
  for (const g of groups) for (const id of suggestTrash(g, rule)) out.add(id);
  return out;
}

  return { RULES, pickKeeper, suggestTrash, suggestAll };
}));
