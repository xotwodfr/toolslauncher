'use strict';
// Small clean-ups for text that came out of a picture.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Tidy = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  /** Even out line endings and spacing: no trailing spaces, no run of blank lines, no blank lines at the ends. */
  function clean(text) {
    return String(text || '').replace(/\r\n?/g, '\n').replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').replace(/^\n+|\n+$/g, '');
  }

  /**
   * Join the lines of each paragraph into one flowing line. A paragraph is text between blank lines. A word split
   * across lines with a hyphen ("exam-" / "ple") is put back together.
   */
  function joinLines(text) {
    return clean(text).split(/\n\s*\n/).map((para) => {
      const lines = para.split('\n').map((l) => l.trim()).filter(Boolean);
      let out = '';
      for (const line of lines) {
        if (!out) out = line;
        else if (/[A-Za-zÀ-ÿ]-$/.test(out) && /^[a-zà-ÿ]/.test(line)) out = out.slice(0, -1) + line;
        else out += ' ' + line;
      }
      return out;
    }).filter(Boolean).join('\n\n');
  }

  function stats(text) {
    const t = String(text || '').trim();
    return { words: t ? t.split(/\s+/).length : 0, chars: t.length, lines: t ? t.split('\n').length : 0 };
  }

  /** How alike two texts are, 0..1 (1 = same), ignoring case and spacing. Used by the tests to grade a reading. */
  function similarity(a, b) {
    const norm = (s) => String(s).toLowerCase().replace(/\s+/g, ' ').trim();
    const x = norm(a); const y = norm(b);
    if (!x.length && !y.length) return 1;
    const prev = Array.from({ length: y.length + 1 }, (_, i) => i);
    for (let i = 1; i <= x.length; i++) {
      let diag = prev[0]; prev[0] = i;
      for (let j = 1; j <= y.length; j++) {
        const keep = prev[j];
        prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (x[i - 1] === y[j - 1] ? 0 : 1));
        diag = keep;
      }
    }
    return 1 - prev[y.length] / Math.max(x.length, y.length);
  }

  return { clean, joinLines, stats, similarity };
}));
