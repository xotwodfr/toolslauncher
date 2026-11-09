'use strict';
// Turning a flat list of scanned tracks into what the screens show: albums, artists, folders, sorting and search.
// Pure functions, shared by the renderer (a <script> tag exposing `window.Model`) and the tests (`require`).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Model = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
  const UNKNOWN_ARTIST = 'Unknown Artist';
  const UNKNOWN_ALBUM = 'Unknown Album';

  const fileBase = (rel) => { const n = rel.slice(rel.lastIndexOf('/') + 1); const d = n.lastIndexOf('.'); return d > 0 ? n.slice(0, d) : n; };
  const dirOf = (rel) => { const i = rel.lastIndexOf('/'); return i < 0 ? '' : rel.slice(0, i); };

  const titleOf = (t) => t.title || fileBase(t.rel);
  const artistOf = (t) => t.artist || t.albumArtist || UNKNOWN_ARTIST;
  const albumArtistOf = (t) => t.albumArtist || t.artist || UNKNOWN_ARTIST;
  const albumOf = (t) => t.album || UNKNOWN_ALBUM;

  /** "Disc 2" / "CD1" sub-folders belong to the album folder above them. */
  const albumDir = (rel) => dirOf(rel).replace(/\/(?:cd|disc|disk)\s*\d+[^/]*$/i, '');

  /**
   * Which album a track belongs to. With an album-artist tag: that artist + album name. Without one (compilations often
   * lack it, and have a different artist on every track): album name + the folder it lives in.
   */
  function albumKey(t) {
    const album = (t.album || '').trim().toLowerCase();
    if (!album) return `~folder:${albumDir(t.rel).toLowerCase()}`;
    if (t.albumArtist) return `${t.albumArtist.trim().toLowerCase()}\u0001${album}`;
    return `${albumDir(t.rel).toLowerCase()}\u0001${album}`;
  }

  /** Default play order inside one album. */
  const byDiscTrack = (a, b) => (a.disc || 1) - (b.disc || 1) || (a.track || 0) - (b.track || 0) || collator.compare(titleOf(a), titleOf(b));

  /**
   * @param {object[]} tracks
   * @returns {{ albums: object[], artists: object[] }}  `tracks` fields hold indexes into the given array.
   */
  function buildIndex(tracks) {
    const byAlbum = new Map();
    tracks.forEach((t, i) => {
      const k = albumKey(t);
      let a = byAlbum.get(k);
      if (!a) {
        a = { key: k, title: albumOf(t), artist: albumArtistOf(t), year: 0, durationMs: 0, tracks: [], dir: albumDir(t.rel), coverTrack: i, genres: new Set() };
        byAlbum.set(k, a);
      }
      a.tracks.push(i);
      a.durationMs += t.durationMs || 0;
      if (t.year && (!a.year || t.year < a.year)) a.year = t.year;
      if (!t.albumArtist && t.artist && a.artist !== t.artist && !a.mixed) { a.mixed = true; }
      if (t.cover && tracks[a.coverTrack].cover === '') a.coverTrack = i;
    });
    const albums = [...byAlbum.values()];
    for (const a of albums) {
      a.tracks.sort((x, y) => byDiscTrack(tracks[x], tracks[y]));
      if (a.mixed && !tracks[a.tracks[0]].albumArtist) a.artist = 'Various Artists'; // no album-artist tag and several artists
      a.discs = new Set(a.tracks.map((i) => tracks[i].disc || 1)).size;
      delete a.genres; delete a.mixed;
      for (const i of a.tracks) tracks[i]._aa = a.artist; // the album's artist: keeps a compilation together in the default sort
    }
    albums.sort((a, b) => collator.compare(a.artist, b.artist) || (a.year || 9999) - (b.year || 9999) || collator.compare(a.title, b.title));

    const byArtist = new Map();
    albums.forEach((a, ai) => {
      const k = a.artist.toLowerCase();
      let r = byArtist.get(k);
      if (!r) { r = { name: a.artist, albums: [], trackCount: 0 }; byArtist.set(k, r); }
      r.albums.push(ai);
      r.trackCount += a.tracks.length;
    });
    const artists = [...byArtist.values()].sort((a, b) => collator.compare(a.name, b.name));
    return { albums, artists };
  }

  const SORTS = {
    default: (a, b) => collator.compare(a._aa || albumArtistOf(a), b._aa || albumArtistOf(b)) || collator.compare(albumOf(a), albumOf(b)) || byDiscTrack(a, b),
    title: (a, b) => collator.compare(titleOf(a), titleOf(b)),
    artist: (a, b) => collator.compare(artistOf(a), artistOf(b)) || collator.compare(albumOf(a), albumOf(b)) || byDiscTrack(a, b),
    album: (a, b) => collator.compare(albumOf(a), albumOf(b)) || byDiscTrack(a, b),
    year: (a, b) => (a.year || 9999) - (b.year || 9999) || SORTS.default(a, b),
    duration: (a, b) => (a.durationMs || 0) - (b.durationMs || 0) || SORTS.default(a, b),
    added: (a, b) => (b.mtime || 0) - (a.mtime || 0) || SORTS.default(a, b),
  };

  /** Indexes of `tracks`, sorted. `dir` is 1 (ascending) or -1. */
  function sortedIndexes(tracks, by = 'default', dir = 1, subset = null) {
    const cmp = SORTS[by] || SORTS.default;
    const idx = subset ? subset.slice() : tracks.map((_, i) => i);
    idx.sort((x, y) => dir * cmp(tracks[x], tracks[y]) || x - y);
    return idx;
  }

  /** Lower-case, accent-free text: "Beyoncé" matches "beyonce". */
  const fold = (s) => String(s == null ? '' : s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const searchText = (t) => fold([titleOf(t), t.artist, t.albumArtist, t.album, t.genre, t.composer, t.year || '', fileBase(t.rel)].join('\u0001'));

  /** Indexes whose text contains every word of `query`. An empty query keeps everything. */
  function search(tracks, query, haystacks) {
    const words = fold(query).split(/\s+/).filter(Boolean);
    const out = [];
    for (let i = 0; i < tracks.length; i++) {
      if (!words.length) { out.push(i); continue; }
      const h = haystacks ? haystacks[i] : searchText(tracks[i]);
      if (words.every((w) => h.includes(w))) out.push(i);
    }
    return out;
  }

  /** Sub-folders and tracks directly inside `dir` ("" = the library root). */
  function folderEntries(tracks, dir) {
    const prefix = dir ? `${dir}/` : '';
    const folders = new Map();
    const files = [];
    tracks.forEach((t, i) => {
      if (!t.rel.startsWith(prefix)) return;
      const rest = t.rel.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash < 0) files.push(i);
      else { const name = rest.slice(0, slash); folders.set(name, (folders.get(name) || 0) + 1); }
    });
    const list = [...folders.entries()].sort((a, b) => collator.compare(a[0], b[0])).map(([name, count]) => ({ name, path: prefix + name, count }));
    files.sort((x, y) => collator.compare(fileBase(tracks[x].rel), fileBase(tracks[y].rel)));
    return { folders: list, files };
  }

  function formatDuration(ms) {
    const s = Math.max(0, Math.round((ms || 0) / 1000));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = String(s % 60).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
  }

  /** "2 h 5 min" / "41 min" for album and playlist totals. */
  function formatTotal(ms) {
    const min = Math.round((ms || 0) / 60000);
    return min >= 60 ? `${Math.floor(min / 60)} h ${min % 60} min` : `${Math.max(min, 1)} min`;
  }

  /** ReplayGain in dB for a track (null = no tags). `mode` is "track" or "album"; album falls back to track gain. */
  function replayGainFor(t, mode) {
    if (!t || !t.rg || (mode !== 'track' && mode !== 'album')) return null;
    const g = mode === 'album' && t.rg.album != null ? t.rg.album : t.rg.track;
    const peak = mode === 'album' && t.rg.album != null ? t.rg.albumPeak : t.rg.trackPeak;
    return g == null ? null : { gain: g, peak: peak || null };
  }

  /**
   * Linear volume factor for a ReplayGain value: gain + preamp (dB), never loud enough to clip (peak * factor <= 1).
   * Tracks without ReplayGain tags get `untaggedDb` (default 0).
   */
  function gainFactor(rg, preampDb = 0, untaggedDb = 0) {
    const db = rg ? rg.gain + preampDb : untaggedDb;
    let f = 10 ** (Math.max(-30, Math.min(20, db)) / 20);
    if (rg && rg.peak && rg.peak * f > 1) f = 1 / rg.peak;
    return f;
  }

  /** Fisher-Yates over a copy; `first` (if >= 0) is kept at the front, as when you press play on a song with shuffle on. */
  function shuffled(items, first = -1, rand = Math.random) {
    const a = items.slice();
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
    if (first >= 0) { const at = a.indexOf(first); if (at > 0) { a.splice(at, 1); a.unshift(first); } }
    return a;
  }

  return {
    UNKNOWN_ARTIST, UNKNOWN_ALBUM, collator, fileBase, dirOf, albumDir, titleOf, artistOf, albumArtistOf, albumOf,
    albumKey, buildIndex, sortedIndexes, SORTS, fold, searchText, search, folderEntries, formatDuration, formatTotal,
    replayGainFor, gainFactor, shuffled,
  };
}));
