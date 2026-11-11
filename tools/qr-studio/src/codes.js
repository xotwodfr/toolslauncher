'use strict';
// Barcode symbologies: what each accepts, check digit maths, and turning what the user typed into what gets encoded.
// Shared by main (rendering, batch), the window (live hints) and the tests.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Codes = factory();
})(typeof self !== 'undefined' ? self : this, () => {
  const SYMBOLOGIES = {
    ean13: { name: 'EAN-13', bcid: 'ean13', digits: 13, hint: '12 digits (the 13th, the check digit, is added) or all 13' },
    ean8: { name: 'EAN-8', bcid: 'ean8', digits: 8, hint: '7 digits (the check digit is added) or all 8' },
    upca: { name: 'UPC-A', bcid: 'upca', digits: 12, hint: '11 digits (the check digit is added) or all 12' },
    code128: { name: 'Code 128', bcid: 'code128', hint: 'Letters, digits and punctuation (plain ASCII), up to 80 characters' },
    code39: { name: 'Code 39', bcid: 'code39', hint: 'Capital letters, digits, space and - . $ / + %' },
    itf: { name: 'ITF (Interleaved 2 of 5)', bcid: 'interleaved2of5', hint: 'Digits only; an odd count gets a leading 0 (or a check digit when that is ticked)' },
  };
  // the names the reader (ZXing) reports, mapped to ours
  const READER_FORMATS = { EAN13: 'ean13', EAN8: 'ean8', UPCA: 'upca', Code128: 'code128', Code39: 'code39', ITF: 'itf', QRCode: 'qr', MicroQRCode: 'qr', rMQRCode: 'qr' };

  /** GS1 mod-10 check digit for the digits given (without the check digit) */
  function gtinCheckDigit(body) {
    const s = String(body);
    if (!/^\d+$/.test(s)) throw new Error('Only digits can have a check digit');
    let sum = 0;
    for (let i = s.length - 1, w = 3; i >= 0; i--, w = w === 3 ? 1 : 3) sum += Number(s[i]) * w;
    return String((10 - (sum % 10)) % 10);
  }
  const gtinValid = (full) => /^\d{2,}$/.test(String(full)) && gtinCheckDigit(String(full).slice(0, -1)) === String(full).slice(-1);

  const C39 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ-. $/+%';
  /** Code 39 mod-43 check character */
  function code39Check(text) {
    let sum = 0;
    for (const ch of text) { const v = C39.indexOf(ch); if (v < 0) throw new Error('Not allowed in Code 39: ' + ch); sum += v; }
    return C39[sum % 43];
  }

  /**
   * Check and complete what the user typed for a symbology.
   * @returns {{ ok: boolean, text?: string, error?: string, note?: string, check?: string }}
   *   text: exactly what will be encoded (with the check digit for EAN/UPC)
   */
  function prepare(kind, input, opts = {}) {
    const sym = SYMBOLOGIES[kind];
    if (!sym) return { ok: false, error: 'Unknown barcode type' };
    let s = String(input == null ? '' : input).trim();
    if (!s) return { ok: false, error: 'Type what the barcode should hold.' };
    if (sym.digits) {
      s = s.replace(/[\s-]/g, '');
      if (!/^\d+$/.test(s)) return { ok: false, error: `${sym.name} holds digits only.` };
      if (s.length === sym.digits - 1) { const c = gtinCheckDigit(s); return { ok: true, text: s + c, check: c, note: `Check digit ${c} added.` }; }
      if (s.length === sym.digits) {
        const c = gtinCheckDigit(s.slice(0, -1));
        if (c !== s.slice(-1)) return { ok: false, error: `The last digit should be ${c} (the check digit), not ${s.slice(-1)}. Check the number, or leave the last digit off and it is worked out for you.`, check: c };
        return { ok: true, text: s, check: c, note: 'Check digit is correct.' };
      }
      return { ok: false, error: `${sym.name} needs ${sym.digits - 1} or ${sym.digits} digits; this has ${s.length}.` };
    }
    if (kind === 'code128') {
      if (s.length > 80) return { ok: false, error: 'Too long for a barcode (80 characters at most). Use a QR code for longer text.' };
      if (!/^[\x20-\x7e]+$/.test(s)) return { ok: false, error: 'Code 128 can only hold plain letters, digits and punctuation (no accents or emoji). Use a QR code for those.' };
      return { ok: true, text: s };
    }
    if (kind === 'code39') {
      const up = s.toUpperCase();
      const bad = [...up].filter((ch) => !C39.includes(ch));
      if (bad.length) return { ok: false, error: `Code 39 cannot hold ${[...new Set(bad)].map((b) => `"${b}"`).join(', ')}. Use capital letters, digits, space and - . $ / + %.` };
      if (up.length > 43) return { ok: false, error: 'Too long for Code 39 (43 characters at most).' };
      const check = opts.check ? code39Check(up) : '';
      return { ok: true, text: up, check: check || undefined, note: (up !== s ? 'Small letters were made capitals (Code 39 has no small letters). ' : '') + (check ? `Check character ${check} added.` : '') };
    }
    if (kind === 'itf') {
      s = s.replace(/[\s-]/g, '');
      if (!/^\d+$/.test(s)) return { ok: false, error: 'ITF holds digits only.' };
      if (s.length > 60) return { ok: false, error: 'Too long for ITF (60 digits at most).' };
      if (opts.check) {
        // the check digit makes the count even: pad first so that body + check is even
        let body = s; if (body.length % 2 === 0) body = '0' + body;
        const c = gtinCheckDigit(body);
        return { ok: true, text: body + c, check: c, note: `Check digit ${c} added${body !== s ? ' (and a leading 0 to make the count even)' : ''}.` };
      }
      if (s.length % 2) return { ok: true, text: '0' + s, note: 'A leading 0 was added: ITF needs an even number of digits.' };
      return { ok: true, text: s };
    }
    return { ok: false, error: 'Unknown barcode type' };
  }

  return { SYMBOLOGIES, READER_FORMATS, gtinCheckDigit, gtinValid, code39Check, prepare };
});
