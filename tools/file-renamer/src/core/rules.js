'use strict';
// The renaming rules. A rule stack is an ordered list of plain objects ({ type, enabled, ...settings }); every file's
// name goes through the enabled rules in order. Each rule works on the name without its extension (the "stem") unless
// it says otherwise; the extension rule works on the extension. Nothing here touches the disk: the metadata a rule
// needs (dates, EXIF, audio tags) is handed in with each file.
//
//   applyRules(files, rules) -> [{ name, errors: [rule problems] }]   files: [{ name, isDir, dir, mtimeMs, birthtimeMs, exifDate, tags }]

const RULE_TYPES = ['replace', 'insert', 'remove', 'case', 'number', 'date', 'tags', 'extension', 'trim', 'translit'];

const DEFAULTS = {
  replace: { find: '', replace: '', regex: false, matchCase: false, all: true, includeExt: false },
  insert: { text: '', where: 'start', index: 0, fromEnd: false },
  remove: { mode: 'range', from: 1, count: 1, fromEnd: false, text: '' },
  case: { mode: 'title', ext: false },
  number: { start: 1, step: 1, pad: 2, where: 'start', separator: ' - ', perFolder: false, index: 0 },
  date: { source: 'modified', format: 'YYYY-MM-DD', where: 'start', separator: ' ' },
  tags: { pattern: '{track} - {title}', where: 'replace', separator: ' - ' },
  extension: { mode: 'lower', value: '' },
  trim: { trim: true, collapse: true, separators: false },
  translit: {},
};

function makeRule(type, settings) {
  if (!RULE_TYPES.includes(type)) throw new Error('Unknown rule: ' + type);
  return { type, enabled: true, ...DEFAULTS[type], ...(settings || {}) };
}

/** Split "photo.final.JPG" into "photo.final" and ".JPG". Folders and ".hidden" files have no extension. */
function splitName(name, isDir) {
  if (isDir) return { stem: name, ext: '' };
  const i = name.lastIndexOf('.');
  if (i <= 0 || i === name.length - 1) return { stem: name, ext: '' };
  return { stem: name.slice(0, i), ext: name.slice(i) };
}

// ---- helpers ------------------------------------------------------------------------------------------------------------
const chars = (s) => Array.from(s); // code points, so emoji and accents count as one character
const int = (v, d, min = -1e9, max = 1e9) => { const n = Math.trunc(Number(v)); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : d; };
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function insertAt(s, text, where, index, fromEnd) {
  const c = chars(s);
  if (where === 'start') return text + s;
  if (where === 'end') return s + text;
  let i = int(index, 0, 0, c.length);
  if (fromEnd) i = c.length - i;
  i = Math.max(0, Math.min(c.length, i));
  return c.slice(0, i).join('') + text + c.slice(i).join('');
}

function words(s) {
  // split camelCase and runs of separators: "myFile_name-2024" -> ["my", "File", "name", "2024"]
  return s
    .replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, '$1 $2')
    .replace(/(\p{Lu})(\p{Lu}\p{Ll})/gu, '$1 $2')
    .split(/[\s_\-.]+/u)
    .filter(Boolean);
}
const cap = (w) => { const c = chars(w); return c.length ? c[0].toLocaleUpperCase() + c.slice(1).join('').toLocaleLowerCase() : w; };

function changeCase(s, mode) {
  switch (mode) {
    case 'lower': return s.toLocaleLowerCase();
    case 'upper': return s.toLocaleUpperCase();
    case 'title': return s.toLocaleLowerCase().replace(/(^|[\s_\-([{.,])(\p{L})/gu, (m, a, b) => a + b.toLocaleUpperCase());
    case 'sentence': { const l = s.toLocaleLowerCase(); return l.replace(/\p{L}/u, (m) => m.toLocaleUpperCase()); }
    case 'camel': { const w = words(s); return w.map((x, i) => (i ? cap(x) : x.toLocaleLowerCase())).join(''); }
    case 'pascal': return words(s).map(cap).join('');
    case 'kebab': return words(s).map((x) => x.toLocaleLowerCase()).join('-');
    case 'snake': return words(s).map((x) => x.toLocaleLowerCase()).join('_');
    default: return s;
  }
}

// letters that do not fall apart into a base letter and an accent
const TRANSLIT = {
  ß: 'ss', ẞ: 'SS', æ: 'ae', Æ: 'AE', œ: 'oe', Œ: 'OE', ø: 'o', Ø: 'O', ł: 'l', Ł: 'L', đ: 'd', Đ: 'D', ð: 'd', Ð: 'D',
  þ: 'th', Þ: 'Th', ı: 'i', ĸ: 'k', ŋ: 'ng', Ŋ: 'NG', ŧ: 't', Ŧ: 'T', ħ: 'h', Ħ: 'H', ſ: 's',
  '‘': "'", '’': "'", '‚': "'", '“': '"', '”': '"', '„': '"', '–': '-', '—': '-', '…': '...', '€': 'EUR', '£': 'GBP', '©': '(c)', '®': '(r)', '™': '(tm)',
  ' ': ' ', '«': '"', '»': '"', '×': 'x',
};
function transliterate(s) {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\u0000-\u007f]/g, (c) => (c in TRANSLIT ? TRANSLIT[c] : c)).normalize('NFC');
}

/** Format a date with YYYY, YY, MM, M, DD, D, HH, H, mm, ss and MMM (Jan…); text in [brackets] is kept as is. */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function formatDate(d, fmt) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  const map = {
    YYYY: () => p(d.getFullYear(), 4), YY: () => p(d.getFullYear() % 100), MMM: () => MONTHS[d.getMonth()], MM: () => p(d.getMonth() + 1), M: () => String(d.getMonth() + 1),
    DD: () => p(d.getDate()), D: () => String(d.getDate()), HH: () => p(d.getHours()), H: () => String(d.getHours()), mm: () => p(d.getMinutes()), ss: () => p(d.getSeconds()),
  };
  return String(fmt || 'YYYY-MM-DD').replace(/\[([^\]]*)\]|YYYY|YY|MMM|MM|M|DD|D|HH|H|mm|ss/g, (m, lit) => (lit !== undefined ? lit : map[m]()));
}

function place(stem, text, where, sep) {
  if (where === 'replace') return text;
  if (where === 'end') return stem + (stem && text ? sep : '') + text;
  return text + (stem && text ? sep : '') + stem; // start
}

// ---- the rules ------------------------------------------------------------------------------------------------------------
/** Each returns { stem, ext } or throws a RuleProblem (shown on the row, the rest of the stack still runs). */
class RuleProblem extends Error {}

function compileReplace(r) {
  if (!r.find) return null;
  const flags = (r.all ? 'g' : '') + (r.matchCase ? '' : 'i') + 'u';
  try { return new RegExp(r.regex ? r.find : escapeRe(r.find), flags); } catch (e) { return { error: 'The pattern is not valid: ' + e.message.replace(/^Invalid regular expression: /, '') }; }
}

const APPLY = {
  replace(r, s, file, cache) {
    const re = cache.re;
    if (!re) return s;
    if (re.error) throw new RuleProblem(re.error);
    const rep = r.regex ? String(r.replace) : String(r.replace).replace(/\$/g, '$$$$');
    if (r.includeExt) { const full = (s.stem + s.ext).replace(re, rep); return splitName(full, file.isDir); }
    return { stem: s.stem.replace(re, rep), ext: s.ext };
  },
  insert(r, s) {
    const text = String(r.text || '');
    if (!text) return s;
    if (r.where === 'afterExt') return { stem: s.stem, ext: s.ext + text };
    return { stem: insertAt(s.stem, text, r.where === 'beforeExt' ? 'end' : r.where, r.index, r.fromEnd), ext: s.ext };
  },
  remove(r, s) {
    const c = chars(s.stem);
    switch (r.mode) {
      case 'range': {
        // characters `from` (1-based) for `count`, counted from the start or the end
        const count = int(r.count, 1, 0, 1e6); let from = int(r.from, 1, 1, 1e6) - 1;
        if (r.fromEnd) from = c.length - from - count;
        from = Math.max(0, from);
        return { stem: c.slice(0, from).concat(c.slice(from + count)).join(''), ext: s.ext };
      }
      case 'first': return { stem: c.slice(int(r.count, 1, 0, 1e6)).join(''), ext: s.ext };
      case 'last': { const n = int(r.count, 1, 0, 1e6); return { stem: c.slice(0, Math.max(0, c.length - n)).join(''), ext: s.ext }; }
      case 'digits': return { stem: s.stem.replace(/\p{Nd}/gu, ''), ext: s.ext };
      case 'symbols': return { stem: s.stem.replace(/[^\p{L}\p{N}\p{M}\s]/gu, ''), ext: s.ext };
      case 'text': return r.text ? { stem: s.stem.split(String(r.text)).join(''), ext: s.ext } : s;
      default: return s;
    }
  },
  case(r, s) {
    return { stem: changeCase(s.stem, r.mode), ext: r.ext ? changeCase(s.ext, r.mode === 'upper' ? 'upper' : 'lower') : s.ext };
  },
  number(r, s, file) {
    const n = int(r.start, 1) + (r.perFolder ? file.folderIndex : file.index) * int(r.step, 1);
    const pad = int(r.pad, 0, 0, 12);
    const num = (n < 0 ? '-' : '') + String(Math.abs(n)).padStart(pad, '0');
    const sep = String(r.separator == null ? '' : r.separator);
    if (r.where === 'index') return { stem: insertAt(s.stem, num, 'index', r.index, false), ext: s.ext };
    return { stem: place(s.stem, num, r.where, sep), ext: s.ext };
  },
  date(r, s, file) {
    let ms = null;
    if (r.source === 'exif') {
      if (file.exifDate == null) throw new RuleProblem(file.isDir ? 'Folders have no photo date' : 'No photo date (EXIF) in this file');
      ms = file.exifDate;
    } else if (r.source === 'created') ms = file.birthtimeMs || file.mtimeMs;
    else ms = file.mtimeMs;
    if (ms == null || !Number.isFinite(ms)) throw new RuleProblem('No date for this file');
    return { stem: place(s.stem, formatDate(new Date(ms), r.format), r.where, String(r.separator == null ? '' : r.separator)), ext: s.ext };
  },
  tags(r, s, file) {
    const t = file.tags;
    if (!t) throw new RuleProblem(file.isDir ? 'Folders have no tags' : 'No audio tags in this file');
    const missing = [];
    const text = String(r.pattern || '').replace(/\{(artist|title|album|track|year|albumartist|disc)\}/gi, (m, k) => {
      k = k.toLowerCase();
      let v = t[k];
      if (k === 'track' || k === 'disc') v = v ? String(v).padStart(k === 'track' ? 2 : 1, '0') : '';
      if (v == null || v === '') missing.push(k);
      return v == null ? '' : String(v);
    });
    if (missing.length) throw new RuleProblem('Missing tag: ' + missing.join(', '));
    return { stem: place(s.stem, text, r.where, String(r.separator == null ? '' : r.separator)), ext: s.ext };
  },
  extension(r, s, file) {
    if (file.isDir) return s;
    switch (r.mode) {
      case 'lower': return { stem: s.stem, ext: s.ext.toLowerCase() };
      case 'upper': return { stem: s.stem, ext: s.ext.toUpperCase() };
      case 'remove': return { stem: s.stem, ext: '' };
      case 'change': {
        let v = String(r.value || '').trim().replace(/^\.+/, '');
        if (!v) throw new RuleProblem('Type the new extension');
        v = '.' + v;
        return { stem: s.stem, ext: v };
      }
      default: return s;
    }
  },
  trim(r, s) {
    let x = s.stem;
    if (r.separators) x = x.replace(/[_.]+/g, ' ');
    if (r.collapse) x = x.replace(/\s{2,}/g, ' ');
    if (r.trim) x = x.trim();
    return { stem: x, ext: r.trim ? s.ext.trim() : s.ext };
  },
  translit(r, s) { return { stem: transliterate(s.stem), ext: transliterate(s.ext) }; },
};

/**
 * Run the rule stack over the files. `files[i].index` (position in the list) and `.folderIndex` (position among the
 * files of the same folder) are filled in here from the order given.
 */
function applyRules(files, rules) {
  const active = (Array.isArray(rules) ? rules : []).filter((r) => r && r.enabled !== false && RULE_TYPES.includes(r.type));
  const caches = active.map((r) => (r.type === 'replace' ? { re: compileReplace(r) } : {}));
  const perFolder = new Map();
  return files.map((f, index) => {
    const key = f.dir || '';
    const folderIndex = perFolder.get(key) || 0;
    perFolder.set(key, folderIndex + 1);
    const file = { ...f, index, folderIndex };
    let s = splitName(f.name, f.isDir);
    const errors = [];
    active.forEach((r, i) => {
      try { s = APPLY[r.type](r, s, file, caches[i]); }
      catch (e) { if (e instanceof RuleProblem) errors.push({ rule: rules.indexOf(r), message: e.message }); else throw e; }
    });
    return { name: s.stem + s.ext, errors };
  });
}

/** Which metadata the stack needs, so only that is read from the files. */
function needs(rules) {
  const on = (Array.isArray(rules) ? rules : []).filter((r) => r && r.enabled !== false);
  return { exif: on.some((r) => r.type === 'date' && r.source === 'exif'), tags: on.some((r) => r.type === 'tags') };
}

/** Clean a rule stack that came from the window or a preset file: known types and settings only. */
function sanitizeRules(rules) {
  if (!Array.isArray(rules)) return [];
  return rules.slice(0, 50).filter((r) => r && typeof r === 'object' && RULE_TYPES.includes(r.type)).map((r) => {
    const out = { type: r.type, enabled: r.enabled !== false };
    for (const [k, d] of Object.entries(DEFAULTS[r.type])) {
      const v = r[k];
      if (typeof d === 'boolean') out[k] = typeof v === 'boolean' ? v : d;
      else if (typeof d === 'number') out[k] = Number.isFinite(Number(v)) ? Number(v) : d;
      else out[k] = typeof v === 'string' ? v.slice(0, 1000) : d;
    }
    return out;
  });
}

module.exports = { RULE_TYPES, DEFAULTS, makeRule, splitName, applyRules, changeCase, transliterate, formatDate, needs, sanitizeRules, words };
