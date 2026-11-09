'use strict';
// Pure helpers shared by the main process, the tests and the window (loaded with <script> there): key names in three
// notations, reading keys back from tags, confidence words, and deciding what to write.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Music = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  const INPUT_EXTS = ['.mp3', '.flac', '.ogg', '.oga', '.opus', '.m4a', '.mp4', '.aac', '.wav', '.wma', '.aif', '.aiff', '.ape', '.wv'];
  const TAG_EXTS = ['.mp3', '.flac', '.ogg', '.oga', '.opus', '.m4a', '.mp4', '.wav', '.wma', '.aif', '.aiff', '.ape', '.wv']; // .aac has no tag container
  const extOf = (f) => { const m = /\.[^.\\/]+$/.exec(String(f)); return m ? m[0].toLowerCase() : ''; };
  const isAudio = (f) => INPUT_EXTS.includes(extOf(f));
  const canWriteTags = (f) => TAG_EXTS.includes(extOf(f));

  // Tonic 0 = C ... 11 = B. The usual spelling of each key (Db not C#, F# not Gb, and so on).
  const MAJOR_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
  const MINOR_NAMES = ['Cm', 'C#m', 'Dm', 'Ebm', 'Em', 'Fm', 'F#m', 'Gm', 'G#m', 'Am', 'Bbm', 'Bm'];
  // Camelot wheel: number for each tonic. Major = B, minor = A.
  const CAMELOT_MAJOR = [8, 3, 10, 5, 12, 7, 2, 9, 4, 11, 6, 1];
  const CAMELOT_MINOR = [5, 12, 7, 2, 9, 4, 11, 6, 1, 8, 3, 10];
  const wrap12 = (n) => ((n - 1) % 12 + 12) % 12 + 1;

  const STYLES = {
    musical: { label: 'Musical (Am, F#, Bbm)' },
    camelot: { label: 'Camelot (8A, 11B)' },
    openkey: { label: 'Open Key (1m, 6d)' },
  };

  /** @param {{tonic:number, mode:'major'|'minor'}} key */
  function keyName(key, style = 'musical') {
    if (!key) return '';
    const t = ((key.tonic % 12) + 12) % 12;
    const minor = key.mode === 'minor';
    if (style === 'camelot') return (minor ? CAMELOT_MINOR : CAMELOT_MAJOR)[t] + (minor ? 'A' : 'B');
    if (style === 'openkey') return wrap12((minor ? CAMELOT_MINOR : CAMELOT_MAJOR)[t] - 7) + (minor ? 'm' : 'd');
    return (minor ? MINOR_NAMES : MAJOR_NAMES)[t];
  }
  /** "A minor", "Db major" (for tooltips and screen readers). */
  const keyLong = (key) => (key ? `${keyName(key).replace(/m$/, '')} ${key.mode === 'minor' ? 'minor' : 'major'}` : '');

  const NOTE_INDEX = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
  /** Read a key written in any of the common ways ("Am", "F# minor", "Db major", "8A", "08B", "1m", "6d"). */
  function parseKey(text) {
    const s = String(text == null ? '' : text).trim();
    if (!s) return null;
    let m = /^0?(\d{1,2})\s*([ABab])$/.exec(s);                 // Camelot
    if (m && +m[1] >= 1 && +m[1] <= 12) {
      const minor = m[2].toUpperCase() === 'A';
      const table = minor ? CAMELOT_MINOR : CAMELOT_MAJOR;
      const tonic = table.indexOf(+m[1]);
      return tonic < 0 ? null : { tonic, mode: minor ? 'minor' : 'major' };
    }
    m = /^0?(\d{1,2})\s*([md])$/i.exec(s);                      // Open Key
    if (m && +m[1] >= 1 && +m[1] <= 12) {
      const minor = m[2].toLowerCase() === 'm';
      const table = minor ? CAMELOT_MINOR : CAMELOT_MAJOR;
      const tonic = table.indexOf(wrap12(+m[1] + 7));
      return tonic < 0 ? null : { tonic, mode: minor ? 'minor' : 'major' };
    }
    const words = s.replace(/\s*(minor|min)$/i, 'm').replace(/\s*(major|maj)$/i, '');   // "F# minor" -> "F#m"
    m = /^([A-Ga-g])\s*([#b♯♭]?)\s*(m|M)?$/.exec(words);                          // C, c#, Bb, Ebm
    if (!m) return null;
    let tonic = NOTE_INDEX[m[1].toUpperCase()];
    if (m[2] === '#' || m[2] === '♯') tonic += 1;
    if (m[2] === 'b' || m[2] === '♭') tonic -= 1;
    tonic = ((tonic % 12) + 12) % 12;
    return { tonic, mode: m[3] === 'm' ? 'minor' : 'major' };
  }

  const ALL_KEYS = [];
  for (let t = 0; t < 12; t++) { ALL_KEYS.push({ tonic: t, mode: 'major' }); ALL_KEYS.push({ tonic: t, mode: 'minor' }); }
  // in Camelot order (1A, 1B, 2A ...) which is how DJs think of them
  const KEYS_BY_WHEEL = ALL_KEYS.slice().sort((a, b) => {
    const na = parseInt(keyName(a, 'camelot'), 10); const nb = parseInt(keyName(b, 'camelot'), 10);
    return na - nb || (a.mode === 'minor' ? -1 : 1) - (b.mode === 'minor' ? -1 : 1);
  });
  const sameKey = (a, b) => !!a && !!b && a.tonic === b.tonic && a.mode === b.mode;

  // ---- tempo ---------------------------------------------------------------------------------------------------------------
  const MIN_BPM = 20;
  const MAX_BPM = 400;
  const clampBpm = (x) => Math.max(MIN_BPM, Math.min(MAX_BPM, x));
  /** 128 -> "128", 127.96 -> "128", 92.98 -> "93", 87.5 -> "87.5" (one decimal at most). */
  const bpmLabel = (bpm) => (bpm == null || !isFinite(bpm) ? '' : String(Math.round(bpm * 10) / 10));
  const halve = (bpm) => clampBpm(bpm / 2);
  const double = (bpm) => clampBpm(bpm * 2);
  /** What goes into the BPM tag (a whole number; most players and DJ programs expect one). */
  const bpmForTag = (bpm) => Math.round(bpm);

  /** Words for a 0..1 confidence, so colour is never the only signal. */
  function sureness(c, { clear = 0.6, fair = 0.3 } = {}) {
    if (c == null || !isFinite(c)) return 'unsure';
    return c >= clear ? 'clear' : c >= fair ? 'fair' : 'unsure';
  }
  const tempoSureness = (c) => sureness(c, { clear: 0.6, fair: 0.3 });
  const keySureness = (c) => sureness(c, { clear: 0.7, fair: 0.4 });

  const formatTime = (sec) => {
    if (!isFinite(sec) || sec < 0) return '';
    const s = Math.round(sec);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  };

  // ---- deciding what to write -----------------------------------------------------------------------------------------------
  /**
   * @param {{tagBpm:number, tagKey:string, bpm:number|null, key:object|null}} row  tag values and the (possibly corrected) found values
   * @param {{bpm:boolean, key:boolean, style:string, replace:boolean}} opt
   * @returns {{bpm?:number, key?:string, skipped:string[]}}  what to write; `skipped` says what was left alone and why
   */
  function planWrite(row, opt) {
    const out = { skipped: [] };
    if (opt.bpm) {
      if (row.bpm == null) out.skipped.push('no BPM found');
      else if (row.tagBpm && !opt.replace) out.skipped.push('already has a BPM');
      else if (row.tagBpm && row.tagBpm === bpmForTag(row.bpm)) out.skipped.push('BPM already the same');
      else out.bpm = bpmForTag(row.bpm);
    }
    if (opt.key) {
      if (!row.key) out.skipped.push('no key found');
      else if (row.tagKey && !opt.replace) out.skipped.push('already has a key');
      else {
        const text = keyName(row.key, opt.style);
        if (row.tagKey && row.tagKey === text) out.skipped.push('key already the same');
        else out.key = text;
      }
    }
    return out;
  }

  const KEY_TEXT_RE = /^(?:[A-G](?:#|b)?m?|(?:[1-9]|1[0-2])[AB]|(?:[1-9]|1[0-2])[md])$/;

  // ---- CSV -----------------------------------------------------------------------------------------------------------------------
  const csvCell = (v) => {
    let s = v == null ? '' : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // a spreadsheet would run this as a formula
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const CSV_HEADER = ['File', 'Title', 'Artist', 'Length', 'BPM', 'BPM confidence', 'Key', 'Camelot', 'Open Key', 'Key confidence', 'BPM in tag', 'Key in tag'];
  function toCsv(rows) {
    const lines = [CSV_HEADER.map(csvCell).join(',')];
    for (const r of rows) {
      lines.push([
        r.name, r.title, r.artist, r.durationMs ? formatTime(r.durationMs / 1000) : '',
        r.bpm == null ? '' : bpmLabel(r.bpm), r.bpm == null ? '' : tempoSureness(r.bpmConfidence),
        r.key ? keyName(r.key) : '', r.key ? keyName(r.key, 'camelot') : '', r.key ? keyName(r.key, 'openkey') : '', r.key ? keySureness(r.keyConfidence) : '',
        r.tagBpm || '', r.tagKey || '',
      ].map(csvCell).join(','));
    }
    return lines.join('\r\n') + '\r\n';
  }

  return {
    INPUT_EXTS, extOf, isAudio, canWriteTags, STYLES, keyName, keyLong, parseKey, ALL_KEYS, KEYS_BY_WHEEL, sameKey,
    MIN_BPM, MAX_BPM, clampBpm, bpmLabel, halve, double, bpmForTag, sureness, tempoSureness, keySureness, formatTime,
    planWrite, KEY_TEXT_RE, toCsv, csvCell,
  };
}));
