'use strict';
// One scan = list the files in the chosen folders, then find the groups. This runs inside a worker thread (see
// scan-worker.js) so the window stays responsive, and directly in the tests.
const { walk, TYPES, IMAGE_EXTS, AUDIO_EXTS } = require('./walk');
const Cache = require('./cache');
const Similar = require('./similar');
const { findExact } = require('./exact');
const { findSongs } = require('./music');

const HASH_CACHE_VERSION = 1;
const MUSIC_CACHE_VERSION = 1;
const MIN_SIZES = [1, 1024, 102400, 1048576, 10485760];

function cleanOptions(o = {}) {
  const minSize = Number(o.minSize);
  return {
    type: Object.prototype.hasOwnProperty.call(TYPES, o.type) ? o.type : 'all',
    minSize: MIN_SIZES.includes(minSize) ? minSize : 1,
    skipHidden: o.skipHidden !== false,
    threshold: [4, 8, 12].includes(Number(o.threshold)) ? Number(o.threshold) : 8,
  };
}

/** @param roots [{ path, keep }] */
async function listFor(mode, roots, opts, hooks) {
  const exts = mode === 'music' ? AUDIO_EXTS : mode === 'photos' ? IMAGE_EXTS : TYPES[opts.type];
  const minSize = mode === 'files' ? opts.minSize : 1;
  return walk(roots, { exts, minSize, skipHidden: opts.skipHidden, signal: hooks.signal, onProgress: (n) => hooks.onProgress && hooks.onProgress({ phase: 'list', done: n }) });
}

/** Mode 'files' or 'music': list, then group. Returns { groups, stats }. */
async function scan(mode, roots, rawOpts, hooks = {}) {
  const opts = cleanOptions(rawOpts);
  const listed = await listFor(mode, roots, opts, hooks);
  const stats = { files: listed.files.length, skippedLinks: listed.skippedLinks, unreadable: listed.unreadable, truncated: listed.truncated };
  if (mode === 'files') {
    const cache = hooks.cacheFile ? Cache.load(hooks.cacheFile, HASH_CACHE_VERSION) : null;
    const r = await findExact(listed.files, { signal: hooks.signal, onProgress: hooks.onProgress, cache });
    if (cache) Cache.save(hooks.cacheFile, HASH_CACHE_VERSION, cache, listed.files.map(Cache.key));
    stats.unreadable += r.unreadable; stats.hashed = r.hashed; stats.fromCache = r.fromCache;
    return { groups: r.groups, stats };
  }
  if (mode === 'music') {
    const cache = hooks.cacheFile ? Cache.load(hooks.cacheFile, MUSIC_CACHE_VERSION) : null;
    const r = await findSongs(listed.files, { signal: hooks.signal, onProgress: hooks.onProgress, cache });
    if (cache) Cache.save(hooks.cacheFile, MUSIC_CACHE_VERSION, cache, listed.files.map(Cache.key));
    stats.unreadable += r.unreadable;
    return { groups: r.groups, stats };
  }
  throw new Error('Unknown mode: ' + mode);
}

/** Mode 'photos', step 1: just the list of pictures (the window works out each picture's hash). */
async function listPhotos(roots, rawOpts, hooks = {}) {
  const opts = cleanOptions(rawOpts);
  const listed = await listFor('photos', roots, opts, hooks);
  return { files: listed.files, stats: { files: listed.files.length, skippedLinks: listed.skippedLinks, unreadable: listed.unreadable, truncated: listed.truncated } };
}

/** Mode 'photos', step 2: group pictures by their hashes. `items` = [{ ...file, hex, w, h, flat }]. */
function groupPhotos(items, threshold, hooks = {}) {
  const hashed = items.map((it) => ({ ...it, ...Similar.fromHex(it.hex) }));
  const groups = Similar.group(hashed, threshold, { signal: hooks.signal, onProgress: (f) => hooks.onProgress && hooks.onProgress({ phase: 'compare', fraction: f }) });
  return groups.map((g) => ({
    kind: 'look-alike',
    maxDistance: g.maxDistance,
    size: hashed[g.members[0]].size,
    files: g.members.map((i) => { const { hi, lo, ...rest } = hashed[i]; return { ...rest, pixels: (rest.w || 0) * (rest.h || 0) }; })
      .sort((a, b) => b.pixels - a.pixels || b.size - a.size || a.path.localeCompare(b.path, undefined, { numeric: true })),
  }));
}

module.exports = { scan, listPhotos, groupPhotos, cleanOptions, HASH_CACHE_VERSION, MUSIC_CACHE_VERSION, MIN_SIZES };
