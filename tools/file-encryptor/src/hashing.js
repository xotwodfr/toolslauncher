'use strict';
// Checksums: streaming hashes with Node's crypto, and reading/writing checksum files in the GNU coreutils format
// ("<hex>  name", "<hex> *name", backslash-escaped names) and the BSD format ("SHA256 (name) = <hex>").
const crypto = require('crypto');
const fs = require('fs');
const { createBLAKE2b } = require('hash-wasm');
const path = require('path');

const ALGS = {
  sha256: { node: 'sha256', label: 'SHA-256', bsd: 'SHA256', hex: 64, ext: 'sha256', sums: 'SHA256SUMS' },
  sha512: { node: 'sha512', label: 'SHA-512', bsd: 'SHA512', hex: 128, ext: 'sha512', sums: 'SHA512SUMS' },
  sha1: { node: 'sha1', label: 'SHA-1', bsd: 'SHA1', hex: 40, ext: 'sha1', sums: 'SHA1SUMS' },
  md5: { node: 'md5', label: 'MD5', bsd: 'MD5', hex: 32, ext: 'md5', sums: 'MD5SUMS' },
  blake2b: { node: null, label: 'BLAKE2b-512', bsd: 'BLAKE2b', hex: 128, ext: 'b2', sums: 'B2SUMS' },
};
const ORDER = ['sha256', 'sha512', 'sha1', 'md5', 'blake2b'];

/**
 * A hasher { update(buf), digest() -> hex }. Node's crypto for SHA-x and MD5; BLAKE2b-512 comes from hash-wasm (the
 * reference BLAKE2 C code compiled to WebAssembly) because Electron's BoringSSL has no BLAKE2.
 */
async function makeHasher(alg) {
  if (!ALGS[alg]) throw new Error('Unknown algorithm ' + alg);
  if (alg === 'blake2b') { const h = await createBLAKE2b(512); h.init(); return { update: (b) => h.update(b), digest: () => h.digest('hex') }; }
  const h = crypto.createHash(ALGS[alg].node);
  return { update: (b) => h.update(b), digest: () => h.digest('hex') };
}

/** Hashes a file once for all chosen algorithms: { sha256: 'hex', ... }. */
async function hashFile(file, algs, { signal, onBytes } = {}) {
  const hs = await Promise.all(algs.map(async (a) => [a, await makeHasher(a)]));
  const stream = fs.createReadStream(file, { highWaterMark: 1 << 20 });
  for await (const chunk of stream) {
    if (signal && signal.aborted) { stream.destroy(); throw Object.assign(new Error('Cancelled'), { cancelled: true }); }
    for (const [, h] of hs) h.update(chunk);
    if (onBytes) onBytes(chunk.length);
  }
  return Object.fromEntries(hs.map(([a, h]) => [a, h.digest('hex')]));
}

const hashBuffer = async (buf, alg) => { const h = await makeHasher(alg); h.update(buf); return h.digest(); };

/** Which algorithms a pasted hash could be, from its length (128 hex digits: SHA-512 or BLAKE2b-512). */
function detect(text) {
  const h = String(text || '').trim().toLowerCase().replace(/^(sha256|sha512|sha1|md5|blake2b):/, '');
  if (!/^[0-9a-f]+$/.test(h)) {
    const b64 = String(text || '').trim();
    // also accept Base64 (some sites publish SHA-256/512 that way)
    if (/^[A-Za-z0-9+/]+={0,2}$/.test(b64) && b64.length >= 24) {
      const hex = Buffer.from(b64, 'base64').toString('hex');
      const algs = ORDER.filter((a) => ALGS[a].hex === hex.length);
      if (algs.length) return { hex, algs, base64: true };
    }
    return { hex: null, algs: [] };
  }
  return { hex: h, algs: ORDER.filter((a) => ALGS[a].hex === h.length) };
}

/** Guesses the algorithm of a checksum file from its name (".sha256", "SHA256SUMS", "md5sum.txt", ...). */
function algFromName(name) {
  const n = path.basename(name).toLowerCase();
  if (/sha512|\.sha-?512/.test(n)) return 'sha512';
  if (/sha256|\.sha-?256/.test(n)) return 'sha256';
  if (/sha1|\.sha-?1(sum)?$/.test(n)) return 'sha1';
  if (/md5/.test(n)) return 'md5';
  if (/b2sum|blake2|\.b2$/.test(n)) return 'blake2b';
  return null;
}

const unescapeGnu = (s) => s.replace(/\\(\\|n|r)/g, (_m, c) => (c === 'n' ? '\n' : c === 'r' ? '\r' : '\\'));
const BSD_ALG = { sha256: 'sha256', sha512: 'sha512', sha1: 'sha1', md5: 'md5', blake2b: 'blake2b', 'blake2b-512': 'blake2b', 'sha2-256': 'sha256', 'sha2-512': 'sha512' };

/**
 * Parses a checksum file. Returns { lines: [{ name, hex, alg (or null when only the length tells), line }], bad: [line numbers] }.
 * Comment lines (#) and blank lines are skipped.
 */
function parseChecksums(text, fileName = '') {
  const fallback = algFromName(fileName);
  const lines = []; const bad = [];
  String(text).replace(/^﻿/, '').split(/\r?\n/).forEach((raw, i) => {
    const l = raw.replace(/\s+$/, '');
    if (!l.trim() || l.trim().startsWith('#')) return;
    let m = /^\\?([A-Za-z0-9-]+) \((.*)\) = ([0-9a-fA-F]+)$/.exec(l); // BSD
    if (m) {
      const alg = BSD_ALG[m[1].toLowerCase()];
      if (!alg || ALGS[alg].hex !== m[3].length) { bad.push(i + 1); return; }
      lines.push({ name: l.startsWith('\\') ? unescapeGnu(m[2]) : m[2], hex: m[3].toLowerCase(), alg, line: i + 1 });
      return;
    }
    m = /^(\\?)([0-9a-fA-F]{32,128}) [ *](.+)$/.exec(l); // GNU: two spaces (text) or space-star (binary)
    if (m) {
      const hex = m[2].toLowerCase();
      const fits = ORDER.filter((a) => ALGS[a].hex === hex.length);
      if (!fits.length) { bad.push(i + 1); return; }
      const alg = fallback && fits.includes(fallback) ? fallback : (fits.length === 1 ? fits[0] : null);
      lines.push({ name: m[1] ? unescapeGnu(m[3]) : m[3], hex, alg, algs: fits, line: i + 1 });
      return;
    }
    m = /^([0-9a-fA-F]{32,128})$/.exec(l.trim()); // a bare hash (a ".sha256" file that only holds the hash)
    if (m) {
      const hex = m[1].toLowerCase();
      const fits = ORDER.filter((a) => ALGS[a].hex === hex.length);
      if (!fits.length) { bad.push(i + 1); return; }
      lines.push({ name: null, hex, alg: fallback && fits.includes(fallback) ? fallback : (fits.length === 1 ? fits[0] : null), algs: fits, line: i + 1 });
      return;
    }
    bad.push(i + 1);
  });
  return { lines, bad };
}

const needsEscape = (name) => /[\\\n\r]/.test(name);
const escapeGnu = (name) => name.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/\r/g, '\\r');

/** Writes a checksum file: [{ name, hex }] -> text. format 'gnu' (sha256sum style, binary marker) or 'bsd'. */
function formatChecksums(items, alg, format = 'gnu') {
  return items.map(({ name, hex }) => {
    const n = name.split(path.sep).join('/');
    if (format === 'bsd') return `${needsEscape(n) ? '\\' : ''}${ALGS[alg].bsd} (${needsEscape(n) ? escapeGnu(n) : n}) = ${hex}`;
    return `${needsEscape(n) ? '\\' : ''}${hex} *${needsEscape(n) ? escapeGnu(n) : n}`;
  }).join('\n') + '\n';
}

/** Lists every file under a folder (sorted, relative "/" paths), skipping links. */
async function listFiles(root, { skip = [] } = {}) {
  const out = [];
  async function visit(abs, rel) {
    const names = await fs.promises.readdir(abs, { withFileTypes: true });
    names.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const d of names) {
      const a = path.join(abs, d.name); const r = rel ? rel + '/' + d.name : d.name;
      if (d.isDirectory()) await visit(a, r);
      else if (d.isFile() && !skip.includes(a)) out.push({ abs: a, rel: r });
    }
  }
  await visit(root, '');
  return out;
}

module.exports = { ALGS, ORDER, makeHasher, hashFile, hashBuffer, detect, algFromName, parseChecksums, formatChecksums, listFiles };
