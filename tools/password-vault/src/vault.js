'use strict';
// The vault CONTENTS (what is inside the encrypted file) and every change to it. Pure data, no files, no Electron.
// The renderer is only ever given `listView` / `detailView` projections: passwords, hidden fields, TOTP secrets and
// password history stay here and leave only through `secret()` (for an explicit reveal or copy).
const crypto = require('crypto');
const T = require('./totp');

const SCHEMA = 1;
const HISTORY_MAX = 20;
const LIMITS = { title: 500, username: 1000, password: 10000, url: 4000, urls: 20, notes: 100000, tag: 60, tags: 30, folder: 300, fields: 50, fieldName: 200, fieldValue: 10000 };

const now = () => new Date().toISOString();
const newId = () => crypto.randomUUID();

function empty() {
  const t = now();
  return { schema: SCHEMA, created: t, modified: t, settings: { autoLockMinutes: 5, clipboardSeconds: 30, lockOnMinimize: false }, folders: [], entries: [] };
}

function str(v, max, what) {
  if (v == null) return '';
  if (typeof v !== 'string') throw new Error(`${what} must be text`);
  if (v.length > max) throw new Error(`${what} is too long (at most ${max} characters)`);
  return v;
}
const cleanFolder = (f) => str(f, LIMITS.folder, 'Folder').split('/').map((p) => p.trim()).filter(Boolean).join('/');

/** Checks a whole vault object read from a file and fills in anything missing, so old or imported vaults are safe to use. */
function normalise(d) {
  if (!d || typeof d !== 'object' || !Array.isArray(d.entries)) throw new Error('The vault contents are not valid.');
  if (d.schema > SCHEMA) throw new Error('This vault was made by a newer version of Password Vault.');
  const out = { ...empty(), ...d, settings: { ...empty().settings, ...(d.settings || {}) } };
  out.folders = Array.isArray(d.folders) ? [...new Set(d.folders.filter((f) => typeof f === 'string').map(cleanFolder).filter(Boolean))] : [];
  out.entries = d.entries.filter((e) => e && typeof e === 'object' && typeof e.id === 'string').map((e) => ({
    id: e.id, title: String(e.title || ''), username: String(e.username || ''), password: String(e.password || ''),
    urls: Array.isArray(e.urls) ? e.urls.map(String) : [], notes: String(e.notes || ''), tags: Array.isArray(e.tags) ? e.tags.map(String) : [],
    folder: typeof e.folder === 'string' ? e.folder : '', favorite: !!e.favorite,
    fields: Array.isArray(e.fields) ? e.fields.filter((f) => f && typeof f === 'object').map((f) => ({ name: String(f.name || ''), value: String(f.value || ''), hidden: !!f.hidden })) : [],
    totp: e.totp && typeof e.totp === 'object' && typeof e.totp.secret === 'string' ? { secret: e.totp.secret, algorithm: e.totp.algorithm || 'SHA1', digits: e.totp.digits || 6, period: e.totp.period || 30 } : null,
    history: Array.isArray(e.history) ? e.history.filter((h) => h && typeof h.password === 'string').map((h) => ({ password: h.password, until: String(h.until || '') })) : [],
    created: String(e.created || now()), modified: String(e.modified || e.created || now()), trashed: e.trashed ? String(e.trashed) : null,
  }));
  return out;
}

function find(d, id) {
  const e = d.entries.find((x) => x.id === id);
  if (!e) throw new Error('That entry no longer exists.');
  return e;
}

/**
 * Creates (no id) or updates an entry from what the edit form sent. In an update, `password: null` and a hidden field's
 * `value: null` mean "keep what is stored" (the form never received them unless the user pressed Show).
 * A changed password goes into the entry's history. `totp` is text (otpauth:// link or Base32), '' to remove, or null to keep.
 */
function saveEntry(d, input) {
  if (!input || typeof input !== 'object') throw new Error('Nothing to save');
  const old = input.id ? find(d, input.id) : null;
  const title = str(input.title, LIMITS.title, 'Title').trim();
  if (!title) throw new Error('Give the entry a title.');
  const urls = (Array.isArray(input.urls) ? input.urls : []).slice(0, LIMITS.urls).map((u) => str(u, LIMITS.url, 'Web address').trim()).filter(Boolean);
  const tags = [...new Set((Array.isArray(input.tags) ? input.tags : []).slice(0, LIMITS.tags).map((t) => str(t, LIMITS.tag, 'Tag').trim().replace(/^#/, '')).filter(Boolean))];
  const fieldsIn = Array.isArray(input.fields) ? input.fields.slice(0, LIMITS.fields) : [];
  const fields = fieldsIn.map((f, i) => {
    if (!f || typeof f !== 'object') throw new Error('A custom field is not valid');
    let value = f.value;
    if (value === null && old && Number.isInteger(f.from) && old.fields[f.from]) value = old.fields[f.from].value; // kept as it was
    return { name: str(f.name, LIMITS.fieldName, 'Field name').trim() || `Field ${i + 1}`, value: str(value, LIMITS.fieldValue, 'Field value'), hidden: !!f.hidden };
  });
  let password = input.password === null && old ? old.password : str(input.password, LIMITS.password, 'Password');
  let totp;
  if (input.totp === null && old) totp = old.totp;
  else if (!input.totp) totp = null;
  else { const t = T.parseTotp(str(input.totp, 2000, 'One-time code secret')); totp = { secret: t.secret, algorithm: t.algorithm, digits: t.digits, period: t.period }; }
  const t = now();
  const e = old || { id: newId(), created: t, history: [], trashed: null, favorite: false };
  if (old && old.password && old.password !== password) {
    e.history = [{ password: old.password, until: t }, ...old.history].slice(0, HISTORY_MAX);
  }
  Object.assign(e, {
    title, username: str(input.username, LIMITS.username, 'User name'), password, urls, notes: str(input.notes, LIMITS.notes, 'Notes'),
    tags, folder: cleanFolder(input.folder), fields, totp, modified: t,
  });
  if (typeof input.favorite === 'boolean') e.favorite = input.favorite;
  if (!old) d.entries.push(e);
  if (e.folder && !d.folders.includes(e.folder)) d.folders.push(e.folder);
  touch(d);
  return e;
}

/** Adds imported entries (from csv.importCsv) under a folder. Returns { added, totpErrors }. */
function addImported(d, items, intoFolder) {
  let added = 0; let totpErrors = 0;
  for (const it of items) {
    let totp = null;
    if (it.totp) { try { const t = T.parseTotp(it.totp); totp = { secret: t.secret, algorithm: t.algorithm, digits: t.digits, period: t.period }; } catch { totpErrors++; } }
    const folder = cleanFolder([intoFolder, it.folder].filter(Boolean).join('/'));
    const t = now();
    const cut = (v, n) => String(v || '').slice(0, n);
    d.entries.push({
      id: newId(), title: cut(it.title, LIMITS.title) || 'Untitled', username: cut(it.username, LIMITS.username), password: cut(it.password, LIMITS.password),
      urls: (it.urls || []).slice(0, LIMITS.urls).map((u) => cut(u, LIMITS.url)), notes: cut(it.notes, LIMITS.notes), tags: [], folder, favorite: !!it.favorite,
      fields: (it.fields || []).slice(0, LIMITS.fields).map((f) => ({ name: cut(f.name, LIMITS.fieldName), value: cut(f.value, LIMITS.fieldValue), hidden: !!f.hidden })),
      totp, history: [], created: it.created || t, modified: it.modified || it.created || t, trashed: null,
    });
    if (folder && !d.folders.includes(folder)) d.folders.push(folder);
    added++;
  }
  touch(d);
  return { added, totpErrors };
}

function touch(d) { d.modified = now(); }
function setFavorite(d, id, on) { const e = find(d, id); e.favorite = !!on; touch(d); }
function trash(d, id) { const e = find(d, id); e.trashed = now(); touch(d); }
function restore(d, id) { const e = find(d, id); e.trashed = null; touch(d); }
function purge(d, id) { const e = find(d, id); if (!e.trashed) throw new Error('Move the entry to the trash first.'); d.entries = d.entries.filter((x) => x !== e); touch(d); }
function emptyTrash(d) { const n = d.entries.filter((e) => e.trashed).length; d.entries = d.entries.filter((e) => !e.trashed); touch(d); return n; }
function addFolder(d, name) { const f = cleanFolder(name); if (!f) throw new Error('Type a folder name.'); if (!d.folders.includes(f)) d.folders.push(f); touch(d); return f; }

function settings(d, s) {
  if (!s || typeof s !== 'object') return d.settings;
  if (s.autoLockMinutes != null) { const v = Number(s.autoLockMinutes); if (!Number.isInteger(v) || v < 0 || v > 720) throw new Error('Auto-lock must be 0 (never) to 720 minutes'); d.settings.autoLockMinutes = v; }
  if (s.clipboardSeconds != null) { const v = Number(s.clipboardSeconds); if (!Number.isInteger(v) || v < 5 || v > 600) throw new Error('Clipboard clearing must be 5 to 600 seconds'); d.settings.clipboardSeconds = v; }
  if (s.lockOnMinimize != null) d.settings.lockOnMinimize = !!s.lockOnMinimize;
  touch(d);
  return d.settings;
}

// ---- what the window may see ------------------------------------------------------------------------------------------
const hostOf = (u) => { try { return new URL(/^[a-z][a-z0-9+.-]*:/i.test(u) ? u : 'https://' + u).hostname.replace(/^www\./, ''); } catch { return u; } };

function matches(e, q) {
  if (!q) return true;
  const hay = [e.title, e.username, e.notes, e.folder, ...e.urls, ...e.tags, ...e.fields.filter((f) => !f.hidden).flatMap((f) => [f.name, f.value])].join('\n').toLowerCase();
  return q.toLowerCase().split(/\s+/).filter(Boolean).every((w) => (w.startsWith('#') && w.length > 1 ? e.tags.some((t) => t.toLowerCase() === w.slice(1)) : hay.includes(w)));
}

/**
 * The list the window shows. view: 'all' | 'favorites' | 'trash' | 'folder' | 'tag'; sort: 'title' | 'modified' | 'created'.
 * Rows carry no secrets: no password, no hidden field, no TOTP secret, no history.
 */
function listView(d, { view = 'all', folder = '', tag = '', query = '', sort = 'title' } = {}) {
  let list = d.entries.filter((e) => (view === 'trash' ? e.trashed : !e.trashed));
  if (view === 'favorites') list = list.filter((e) => e.favorite);
  if (view === 'folder') list = list.filter((e) => e.folder === folder || e.folder.startsWith(folder + '/'));
  if (view === 'tag') list = list.filter((e) => e.tags.includes(tag));
  list = list.filter((e) => matches(e, String(query || '').slice(0, 200)));
  const coll = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });
  if (sort === 'modified' || sort === 'created') list.sort((a, b) => b[sort].localeCompare(a[sort]) || coll.compare(a.title, b.title));
  else list.sort((a, b) => coll.compare(a.title, b.title) || coll.compare(a.username, b.username));
  const live = d.entries.filter((e) => !e.trashed);
  const ancestors = (f) => f.split('/').map((_p, i, a) => a.slice(0, i + 1).join('/')); // "A/B" also lists "A"
  const folders = [...new Set([...d.folders, ...live.map((e) => e.folder).filter(Boolean)].flatMap(ancestors))].sort(coll.compare);
  const tags = [...new Set(live.flatMap((e) => e.tags))].sort(coll.compare);
  return {
    rows: list.map((e) => ({ id: e.id, title: e.title, username: e.username, host: e.urls[0] ? hostOf(e.urls[0]) : '', folder: e.folder, tags: e.tags, favorite: e.favorite, hasTotp: !!e.totp, hasPassword: !!e.password, modified: e.modified, created: e.created, trashed: e.trashed })),
    counts: { all: live.length, favorites: live.filter((e) => e.favorite).length, trash: d.entries.length - live.length },
    folders: folders.map((f) => ({ name: f, count: live.filter((e) => e.folder === f || e.folder.startsWith(f + '/')).length })),
    tags: tags.map((t) => ({ name: t, count: live.filter((e) => e.tags.includes(t)).length })),
  };
}

/** One entry as the detail pane shows it: hidden values are replaced by their length (for the dots). */
function detailView(d, id) {
  const e = find(d, id);
  return {
    id: e.id, title: e.title, username: e.username, hasPassword: !!e.password, passwordLength: [...e.password].length, urls: e.urls, notes: e.notes,
    tags: e.tags, folder: e.folder, favorite: e.favorite, created: e.created, modified: e.modified, trashed: e.trashed,
    fields: e.fields.map((f) => (f.hidden ? { name: f.name, hidden: true, length: [...f.value].length } : { name: f.name, hidden: false, value: f.value })),
    totp: e.totp ? { digits: e.totp.digits, period: e.totp.period, algorithm: e.totp.algorithm } : null,
    history: e.history.map((h) => ({ until: h.until, length: [...h.password].length })),
  };
}

/** The one way a secret leaves: what = 'password' | 'username' | 'url' | 'field' | 'history' | 'totp'. */
function secret(d, id, what, index = 0) {
  const e = find(d, id);
  if (what === 'password') return e.password;
  if (what === 'username') return e.username;
  if (what === 'url') { if (!e.urls[index]) throw new Error('No such web address'); return e.urls[index]; }
  if (what === 'field') { const f = e.fields[index]; if (!f) throw new Error('No such field'); return f.value; }
  if (what === 'history') { const h = e.history[index]; if (!h) throw new Error('No such old password'); return h.password; }
  if (what === 'totp') { if (!e.totp) throw new Error('This entry has no one-time code'); return T.codeFor(e.totp).code; }
  throw new Error('Unknown value');
}

function totpNow(d, id, timeMs = Date.now()) {
  const e = find(d, id);
  if (!e.totp) return null;
  return T.codeFor(e.totp, timeMs);
}

/** Entries with their secrets, for the CSV export (not in the trash). */
const exportable = (d) => d.entries.filter((e) => !e.trashed);

module.exports = { SCHEMA, HISTORY_MAX, LIMITS, empty, normalise, saveEntry, addImported, setFavorite, trash, restore, purge, emptyTrash, addFolder, settings, listView, detailView, secret, totpNow, exportable, matches };
