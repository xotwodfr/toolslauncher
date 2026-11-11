'use strict';
// Working out what a file is: text in UTF-8 (with or without a byte order mark) or UTF-16 (little or big endian, with or
// without a BOM), or something else, which the app treats as binary and compares by hash. Also turns text back into
// bytes in the same encoding when the merged result is saved.

const ENCODINGS = ['utf-8', 'utf-8-bom', 'utf-16le', 'utf-16be'];
const LABELS = { 'utf-8': 'UTF-8', 'utf-8-bom': 'UTF-8 with BOM', 'utf-16le': 'UTF-16 LE', 'utf-16be': 'UTF-16 BE', binary: 'Binary' };

/** Guess UTF-16 without a BOM: text in Latin-script languages has a zero in every other byte. */
function guessUtf16(buf) {
  const n = Math.min(buf.length, 8192) & ~1;
  if (n < 4) return null;
  let evenZero = 0; let oddZero = 0;
  for (let i = 0; i < n; i += 2) { if (buf[i] === 0) evenZero++; if (buf[i + 1] === 0) oddZero++; }
  const pairs = n / 2;
  if (oddZero / pairs > 0.4 && evenZero / pairs < 0.05) return 'utf-16le';
  if (evenZero / pairs > 0.4 && oddZero / pairs < 0.05) return 'utf-16be';
  return null;
}

function decodeUtf16(buf, enc, skip) {
  let body = buf.subarray(skip);
  if (body.length & 1) return null; // half a character: not UTF-16
  if (enc === 'utf-16be') { body = Buffer.from(body); body.swap16(); }
  const text = Buffer.from(body.buffer, body.byteOffset, body.length).toString('utf16le');
  // unpaired surrogates mean it was not really UTF-16
  if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text)) return null;
  return text;
}

/** Text with control characters other than tab/newline/CR/form feed/escape is very likely not text. */
function looksBinaryText(text) {
  const sample = text.length > 65536 ? text.slice(0, 65536) : text;
  let bad = 0;
  for (let i = 0; i < sample.length; i++) {
    const c = sample.charCodeAt(i);
    if (c === 0) return true;
    if (c < 32 && c !== 9 && c !== 10 && c !== 13 && c !== 12 && c !== 27 && c !== 11) bad++;
  }
  return bad > 0 && bad / Math.max(1, sample.length) > 0.01;
}

/**
 * @returns {{ encoding: 'utf-8'|'utf-8-bom'|'utf-16le'|'utf-16be'|'binary', text?: string, bom: boolean }}
 */
function detect(buf) {
  if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf);
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    const text = decodeUtf8(buf.subarray(3));
    if (text != null && !looksBinaryText(text)) return { encoding: 'utf-8-bom', text, bom: true };
    return { encoding: 'binary', bom: false };
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    const text = decodeUtf16(buf, 'utf-16le', 2);
    if (text != null && !looksBinaryText(text)) return { encoding: 'utf-16le', text, bom: true };
    return { encoding: 'binary', bom: false };
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    const text = decodeUtf16(buf, 'utf-16be', 2);
    if (text != null && !looksBinaryText(text)) return { encoding: 'utf-16be', text, bom: true };
    return { encoding: 'binary', bom: false };
  }
  const g = guessUtf16(buf);
  if (g) {
    const text = decodeUtf16(buf, g, 0);
    if (text != null && !looksBinaryText(text)) return { encoding: g, text, bom: false };
  }
  const text = decodeUtf8(buf);
  if (text != null && !looksBinaryText(text)) return { encoding: 'utf-8', text, bom: false };
  return { encoding: 'binary', bom: false };
}

function decodeUtf8(buf) {
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buf); } catch { return null; }
}

/** Text -> bytes in the given encoding. UTF-16 files that had a BOM get it back. */
function encode(text, encoding, bom) {
  text = String(text);
  switch (encoding) {
    case 'utf-8': return Buffer.from(text, 'utf8');
    case 'utf-8-bom': return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, 'utf8')]);
    case 'utf-16le': { const b = Buffer.from(text, 'utf16le'); return bom === false ? b : Buffer.concat([Buffer.from([0xff, 0xfe]), b]); }
    case 'utf-16be': { const b = Buffer.from(text, 'utf16le'); b.swap16(); return bom === false ? b : Buffer.concat([Buffer.from([0xfe, 0xff]), b]); }
    default: throw new Error('Unknown encoding: ' + encoding);
  }
}

module.exports = { detect, encode, ENCODINGS, LABELS, guessUtf16, looksBinaryText };
