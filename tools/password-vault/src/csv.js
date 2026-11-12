'use strict';
// CSV import (KeePass / KeePassXC, Bitwarden, Chrome, Firefox exports) and CSV export (Bitwarden's columns, which most
// password managers can import). Pure functions: text in, plain entry objects out.

/** RFC 4180 CSV parser: quoted fields, "" escapes, commas and newlines inside quotes, CRLF or LF, a leading BOM. */
function parseCsv(text) {
  const s = String(text).replace(/^﻿/, '');
  const rows = [];
  let row = []; let field = ''; let i = 0; let quoted = false; let any = false;
  while (i < s.length) {
    const c = s[i];
    if (quoted) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i += 2; continue; }
        quoted = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === '"' && field === '') { quoted = true; any = true; i++; continue; }
    if (c === ',') { row.push(field); field = ''; any = true; i++; continue; }
    if (c === '\r' || c === '\n') {
      row.push(field); field = '';
      if (row.length > 1 || row[0] !== '' || any) rows.push(row);
      row = []; any = false;
      i += c === '\r' && s[i + 1] === '\n' ? 2 : 1;
      continue;
    }
    field += c; any = true; i++;
  }
  if (quoted) throw new Error('The CSV file ends inside a quoted value, so it looks cut short.');
  if (field !== '' || row.length || any) { row.push(field); rows.push(row); }
  return rows;
}

const csvCell = (v) => { const t = v == null ? '' : String(v); return /[",\r\n]/.test(t) || /^\s|\s$/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t; };
const toCsv = (rows) => rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';

const norm = (h) => String(h).trim().toLowerCase();

const FORMATS = {
  keepassxc: { name: 'KeePassXC', need: ['group', 'title', 'username', 'password', 'url', 'notes'] },
  keepass: { name: 'KeePass 2', need: ['account', 'login name', 'password', 'web site', 'comments'] },
  bitwarden: { name: 'Bitwarden', need: ['folder', 'favorite', 'type', 'name', 'login_uri', 'login_username', 'login_password'] },
  firefox: { name: 'Firefox', need: ['url', 'username', 'password', 'httprealm', 'formactionorigin', 'guid'] },
  chrome: { name: 'Chrome / Edge', need: ['name', 'url', 'username', 'password'] },
};

function detect(header) {
  const h = header.map(norm);
  for (const [id, f] of Object.entries(FORMATS)) if (f.need.every((n) => h.includes(n))) return id;
  return null;
}

function hostOf(url) {
  try { return new URL(/^[a-z][a-z0-9+.-]*:/i.test(url) ? url : 'https://' + url).hostname.replace(/^www\./, ''); } catch { return ''; }
}
function dateOr(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  const d = Number.isFinite(n) && /^\d+$/.test(String(v).trim()) ? new Date(n) : new Date(v);
  return isNaN(d.getTime()) || d.getFullYear() < 1990 || d.getFullYear() > 2200 ? null : d.toISOString();
}

/** "name: value" lines (Bitwarden custom fields). */
function parseFields(text) {
  return String(text || '').split(/\r?\n/).filter((l) => l.trim()).map((l) => {
    const at = l.indexOf(': ');
    return at > 0 ? { name: l.slice(0, at), value: l.slice(at + 2), hidden: false } : { name: l.trim(), value: '', hidden: false };
  });
}

/**
 * CSV text -> { format, formatName, entries: [{title, username, password, urls, notes, folder, favorite, fields, totp, created, modified}], skipped }.
 * `totp` is the raw text (otpauth:// link or Base32) and is checked by the caller.
 */
function importCsv(text) {
  const rows = parseCsv(text);
  if (rows.length < 1) throw new Error('The file is empty.');
  const header = rows[0];
  const format = detect(header);
  if (!format) throw new Error('This CSV does not look like an export from KeePass, KeePassXC, Bitwarden, Chrome, Edge or Firefox (the column names do not match).');
  const idx = Object.fromEntries(header.map((h, i) => [norm(h), i]));
  const get = (r, name) => { const i = idx[name]; return i == null ? '' : (r[i] || ''); };
  const entries = [];
  let skipped = 0;
  for (const r of rows.slice(1)) {
    if (r.every((c) => !String(c).trim())) continue;
    let e;
    if (format === 'keepassxc') {
      const group = get(r, 'group').split('/').filter(Boolean);
      if (group[0] === 'Root') group.shift();
      e = { title: get(r, 'title'), username: get(r, 'username'), password: get(r, 'password'), urls: [get(r, 'url')], notes: get(r, 'notes'), folder: group.join('/'), totp: get(r, 'totp'), created: dateOr(get(r, 'created')), modified: dateOr(get(r, 'last modified')) };
    } else if (format === 'keepass') {
      e = { title: get(r, 'account'), username: get(r, 'login name'), password: get(r, 'password'), urls: [get(r, 'web site')], notes: get(r, 'comments') };
    } else if (format === 'bitwarden') {
      const type = norm(get(r, 'type'));
      if (type && type !== 'login' && type !== 'note') { skipped++; continue; } // cards and identities are not in this vault
      e = {
        title: get(r, 'name'), username: get(r, 'login_username'), password: get(r, 'login_password'),
        urls: get(r, 'login_uri').split(/[\r\n,]+/), notes: get(r, 'notes'), folder: get(r, 'folder'),
        favorite: get(r, 'favorite') === '1' || norm(get(r, 'favorite')) === 'true', fields: parseFields(get(r, 'fields')), totp: get(r, 'login_totp'),
      };
    } else if (format === 'firefox') {
      const url = get(r, 'url');
      e = { title: hostOf(url) || url, username: get(r, 'username'), password: get(r, 'password'), urls: [url], created: dateOr(get(r, 'timecreated')), modified: dateOr(get(r, 'timepasswordchanged')) };
    } else {
      const url = get(r, 'url');
      e = { title: get(r, 'name') || hostOf(url), username: get(r, 'username'), password: get(r, 'password'), urls: [url], notes: get(r, 'note') || get(r, 'notes') };
    }
    e.urls = (e.urls || []).map((u) => u.trim()).filter(Boolean);
    e.title = (e.title || '').trim() || hostOf(e.urls[0] || '') || e.username || 'Untitled';
    entries.push(e);
  }
  return { format, formatName: FORMATS[format].name, entries, skipped };
}

const EXPORT_HEADER = ['folder', 'favorite', 'type', 'name', 'notes', 'fields', 'reprompt', 'login_uri', 'login_username', 'login_password', 'login_totp'];

/** Entries (with secrets) -> Bitwarden-style CSV. Trash is never exported. Tags and history are not part of this format. */
function exportCsv(entries) {
  const rows = [EXPORT_HEADER];
  for (const e of entries) {
    rows.push([
      e.folder || '', e.favorite ? '1' : '', 'login', e.title, e.notes || '',
      (e.fields || []).map((f) => `${f.name}: ${f.value}`).join('\n'), '0',
      (e.urls || []).join(','), e.username || '', e.password || '', e.totp ? totpUri(e) : '',
    ]);
  }
  return toCsv(rows);
}

function totpUri(e) {
  const t = e.totp;
  const label = encodeURIComponent(e.title || 'account') + (e.username ? ':' + encodeURIComponent(e.username) : '');
  return `otpauth://totp/${label}?secret=${t.secret}&algorithm=${t.algorithm}&digits=${t.digits}&period=${t.period}`;
}

module.exports = { parseCsv, toCsv, importCsv, exportCsv, detect, FORMATS, totpUri, hostOf };
