'use strict';
// One-time codes: HOTP (RFC 4226) and TOTP (RFC 6238) on top of Node's HMAC, Base32 (RFC 4648) and otpauth:// links.
const crypto = require('crypto');

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const ALGS = { SHA1: 'sha1', SHA256: 'sha256', SHA512: 'sha512' };

/** Base32 -> bytes. Spaces, dashes, lower case and missing "=" padding are accepted (people paste secrets in many shapes). */
function base32Decode(text) {
  const s = String(text).toUpperCase().replace(/[\s-]/g, '').replace(/=+$/, '');
  if (!s.length || /[^A-Z2-7]/.test(s)) throw new Error('The secret is not valid Base32 (letters A-Z and digits 2-7).');
  const out = [];
  let bits = 0; let value = 0;
  for (const ch of s) {
    value = (value << 5) | B32.indexOf(ch);
    bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 0xff); bits -= 8; }
  }
  return Buffer.from(out);
}

function base32Encode(buf) {
  let bits = 0; let value = 0; let out = '';
  for (const b of buf) {
    value = (value << 8) | b; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

/** RFC 4226: HMAC of the 8-byte big-endian counter, dynamic truncation, modulo 10^digits. */
function hotp(key, counter, { digits = 6, algorithm = 'SHA1' } = {}) {
  const alg = ALGS[algorithm];
  if (!alg) throw new Error('Unknown algorithm ' + algorithm);
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac(alg, key).update(msg).digest();
  const off = h[h.length - 1] & 0x0f;
  const bin = ((h[off] & 0x7f) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3];
  return String(bin % 10 ** digits).padStart(digits, '0');
}

/** RFC 6238: the counter is floor((unixTime - T0) / period), T0 = 0. */
function totp(key, timeMs = Date.now(), { period = 30, digits = 6, algorithm = 'SHA1' } = {}) {
  const counter = Math.floor(Math.floor(timeMs / 1000) / period);
  return { code: hotp(key, counter, { digits, algorithm }), remaining: period - (Math.floor(timeMs / 1000) % period), period };
}

/**
 * Reads what the user pasted: an otpauth://totp/... link (from a QR code) or a bare Base32 secret.
 * Returns { secret (normalised Base32), algorithm, digits, period, issuer?, account? }.
 */
function parseTotp(input) {
  const text = String(input || '').trim();
  if (!text) return null;
  let o = { algorithm: 'SHA1', digits: 6, period: 30 };
  if (/^otpauth:/i.test(text)) {
    let u;
    try { u = new URL(text); } catch { throw new Error('That otpauth:// link is not valid.'); }
    if (u.hostname.toLowerCase() !== 'totp') throw new Error('Only time-based codes (otpauth://totp) are supported, not counter-based (hotp) ones.');
    const q = u.searchParams;
    if (!q.get('secret')) throw new Error('The otpauth:// link has no secret in it.');
    o.secret = q.get('secret');
    if (q.get('algorithm')) o.algorithm = q.get('algorithm').toUpperCase();
    if (q.get('digits')) o.digits = Number(q.get('digits'));
    if (q.get('period')) o.period = Number(q.get('period'));
    const label = decodeURIComponent(u.pathname.replace(/^\/+/, ''));
    const colon = label.indexOf(':');
    o.account = colon >= 0 ? label.slice(colon + 1).trim() : label;
    o.issuer = q.get('issuer') || (colon >= 0 ? label.slice(0, colon) : '');
  } else {
    o.secret = text;
  }
  if (!ALGS[o.algorithm]) throw new Error('Unsupported code algorithm: ' + o.algorithm);
  if (![6, 7, 8].includes(o.digits)) throw new Error('Codes must have 6, 7 or 8 digits.');
  if (!Number.isInteger(o.period) || o.period < 5 || o.period > 300) throw new Error('The code period must be between 5 and 300 seconds.');
  const key = base32Decode(o.secret);
  if (key.length < 10) throw new Error('That secret is too short to be a real one-time-code secret.');
  o.secret = base32Encode(key);
  return o;
}

function codeFor(t, timeMs = Date.now()) {
  return totp(base32Decode(t.secret), timeMs, t);
}

module.exports = { base32Decode, base32Encode, hotp, totp, parseTotp, codeFor };
