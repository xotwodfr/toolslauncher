'use strict';
// Password and passphrase generator. Every random choice is crypto.randomInt (uniform, from the OS's secure source).
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SETS = {
  lower: 'abcdefghijklmnopqrstuvwxyz',
  upper: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  digits: '0123456789',
  symbols: '!#$%&()*+,-./:;<=>?@[]^_{|}~',
};
const LOOKALIKES = new Set('Il1|O0o'.split(''));

let words = null;
/** The EFF large wordlist (7776 words, CC BY 3.0 US, Electronic Frontier Foundation), bundled as src/data/eff_large_wordlist.txt. */
function wordlist() {
  if (!words) {
    const text = fs.readFileSync(path.join(__dirname, 'data', 'eff_large_wordlist.txt'), 'utf8');
    words = text.split('\n').filter(Boolean).map((l) => l.split('\t')[1]);
    if (words.length !== 7776) throw new Error('The word list is damaged');
  }
  return words;
}

function clampInt(v, lo, hi, d) { v = Math.round(Number(v)); return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d; }

function charsets(o) {
  const chosen = ['lower', 'upper', 'digits', 'symbols'].filter((k) => o[k]).map((k) => {
    let s = SETS[k];
    if (o.noLookalikes) s = [...s].filter((c) => !LOOKALIKES.has(c)).join('');
    return s;
  });
  return chosen;
}

/**
 * Random password. Options: length 4-128, lower/upper/digits/symbols, noLookalikes. Every chosen set appears at least
 * once: a candidate missing one is thrown away and drawn again (rejection sampling keeps the result uniform over all
 * valid passwords).
 */
function password(opts = {}) {
  const o = { length: 20, lower: true, upper: true, digits: true, symbols: true, noLookalikes: false, ...opts };
  const length = clampInt(o.length, 4, 128, 20);
  const sets = charsets(o);
  if (!sets.length) throw new Error('Choose at least one kind of character.');
  const alphabet = [...new Set(sets.join(''))];
  for (let tries = 0; tries < 10000; tries++) {
    let out = '';
    for (let i = 0; i < length; i++) out += alphabet[crypto.randomInt(alphabet.length)];
    if (length < sets.length || sets.every((s) => [...out].some((c) => s.includes(c)))) {
      return { value: out, bits: entropyBits(length, alphabet.length, sets.map((s) => s.length)), kind: 'password' };
    }
  }
  throw new Error('Could not make a password with these settings.');
}

/** log2 of the number of valid passwords: inclusion-exclusion over the sets that must appear. */
function entropyBits(length, alphabetSize, setSizes) {
  // count = sum over subsets S of required sets of (-1)^|S| * (N - size(S))^length
  const n = setSizes.length;
  let total = 0;
  for (let mask = 0; mask < 1 << n; mask++) {
    let removed = 0; let bitsSet = 0;
    for (let i = 0; i < n; i++) if (mask & (1 << i)) { removed += setSizes[i]; bitsSet++; }
    const term = Math.pow((alphabetSize - removed) / alphabetSize, length);
    total += (bitsSet % 2 ? -1 : 1) * term;
  }
  return Math.round((length * Math.log2(alphabetSize) + Math.log2(Math.max(total, 1e-300))) * 10) / 10;
}

/** Diceware-style passphrase from the EFF list. Options: words 3-20, separator, capitalize, number (adds one digit to one word). */
function passphrase(opts = {}) {
  const o = { words: 6, separator: '-', capitalize: false, number: false, ...opts };
  const count = clampInt(o.words, 3, 20, 6);
  const sep = typeof o.separator === 'string' ? o.separator.slice(0, 3) : '-';
  const list = wordlist();
  const parts = [];
  for (let i = 0; i < count; i++) parts.push(list[crypto.randomInt(list.length)]);
  if (o.capitalize) for (let i = 0; i < count; i++) parts[i] = parts[i][0].toUpperCase() + parts[i].slice(1);
  let bits = count * Math.log2(list.length);
  if (o.number) {
    const at = crypto.randomInt(count);
    parts[at] += String(crypto.randomInt(10));
    bits += Math.log2(10 * count);
  }
  return { value: parts.join(sep), bits: Math.round(bits * 10) / 10, kind: 'passphrase' };
}

module.exports = { SETS, LOOKALIKES, password, passphrase, wordlist, entropyBits };
