'use strict';
// The player's saved settings: defaults, validation, merging. Electron-free (testable with plain Node).
let fs;
try { fs = require('original-fs'); } catch { fs = require('fs'); }
const path = require('path');

const { BANDS: EQ_BANDS, PRESETS: EQ_PRESETS } = require('./eq-presets');

const DEFAULTS = {
  volume: 0.8,
  muted: false,
  shuffle: false,
  repeat: 'off',                       // off | all | one
  eq: { on: false, preset: 'Flat', preamp: 0, bands: EQ_PRESETS.Flat.slice() },
  rg: { mode: 'track', preamp: 0 },    // off | track | album
  sleepFade: true,
  lastRoot: '',
  recent: [],
  sort: { by: 'default', dir: 1 },
  view: 'songs',
  lyricsSize: 'm',                     // s | m | l
  last: { rel: '', pos: 0 },
};

const num = (v, min, max, d) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : d);
const oneOf = (v, list, d) => (list.includes(v) ? v : d);
const str = (v, max = 1024) => (typeof v === 'string' && v.length <= max && !v.includes('\0') ? v : '');

/** Validate a (possibly partial, possibly hostile) settings object into a full one, falling back to `base` per field. */
function clean(input, base = DEFAULTS) {
  const v = input && typeof input === 'object' ? input : {};
  const eq = v.eq && typeof v.eq === 'object' ? v.eq : {};
  const bands = Array.isArray(eq.bands) && eq.bands.length === EQ_BANDS.length ? eq.bands.map((b, i) => num(b, -12, 12, base.eq.bands[i])) : base.eq.bands.slice();
  const rg = v.rg && typeof v.rg === 'object' ? v.rg : {};
  const sort = v.sort && typeof v.sort === 'object' ? v.sort : {};
  const last = v.last && typeof v.last === 'object' ? v.last : {};
  return {
    volume: num(v.volume, 0, 1, base.volume),
    muted: typeof v.muted === 'boolean' ? v.muted : base.muted,
    shuffle: typeof v.shuffle === 'boolean' ? v.shuffle : base.shuffle,
    repeat: oneOf(v.repeat, ['off', 'all', 'one'], base.repeat),
    eq: {
      on: typeof eq.on === 'boolean' ? eq.on : base.eq.on,
      preset: typeof eq.preset === 'string' && (eq.preset === 'Custom' || EQ_PRESETS[eq.preset]) ? eq.preset : base.eq.preset,
      preamp: num(eq.preamp, -12, 12, base.eq.preamp),
      bands,
    },
    rg: { mode: oneOf(rg.mode, ['off', 'track', 'album'], base.rg.mode), preamp: num(rg.preamp, -12, 12, base.rg.preamp) },
    sleepFade: typeof v.sleepFade === 'boolean' ? v.sleepFade : base.sleepFade,
    lastRoot: 'lastRoot' in v ? str(v.lastRoot) : base.lastRoot,
    recent: Array.isArray(v.recent) ? [...new Set(v.recent.map((x) => str(x)).filter(Boolean))].slice(0, 8) : base.recent.slice(),
    sort: { by: oneOf(sort.by, ['default', 'title', 'artist', 'album', 'year', 'duration', 'added'], base.sort.by), dir: sort.dir === -1 ? -1 : (sort.dir === 1 ? 1 : base.sort.dir) },
    view: oneOf(v.view, ['songs', 'albums', 'artists', 'folders', 'queue', 'now'], base.view),
    lyricsSize: oneOf(v.lyricsSize, ['s', 'm', 'l'], base.lyricsSize),
    last: { rel: 'rel' in last ? str(last.rel) : base.last.rel, pos: num(last.pos, 0, 86400, base.last.pos) },
  };
}

const defaults = () => clean({});

function load(file) {
  try { return clean(JSON.parse(fs.readFileSync(file, 'utf8'))); } catch { return defaults(); }
}
function save(file, settings) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 1));
  fs.renameSync(tmp, file);
}

module.exports = { EQ_BANDS, EQ_PRESETS, DEFAULTS, clean, defaults, load, save };
