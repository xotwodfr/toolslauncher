'use strict';
// The HTML report: one self-contained page (no scripts, no outside files) with the changes side by side, a few lines of
// context around each, and the word highlights. Runs in the Web Worker and in Node.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./textdiff'));
  else root.DiffReport = factory(root.TextDiff);
}(typeof self !== 'undefined' ? self : this, function (T) {
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const MAX_LINE = 2000;

  function marked(text, ranges, cls) {
    if (text.length > MAX_LINE) return esc(text.slice(0, MAX_LINE)) + '<span class="more">…</span>';
    if (!ranges || !ranges.length) return esc(text);
    let out = ''; let pos = 0;
    for (const [f, t] of ranges) { out += esc(text.slice(pos, f)) + `<mark class="${cls}">` + esc(text.slice(f, t)) + '</mark>'; pos = t; }
    return out + esc(text.slice(pos));
  }

  /**
   * @param a, b   splitLines() results
   * @param result diffLines() result (with the options the user chose)
   * @param info   { leftName, rightName, options: {...}, inline: 'word'|'char'|'off', context, created }
   */
  function makeHtmlReport(a, b, result, info) {
    info = info || {};
    const ctx = info.context == null ? 3 : info.context;
    const hunks = T.groupHunks(result.blocks, ctx, a.lines.length, b.lines.length);
    const s = result.stats;
    const opts = info.options || {};
    const optWords = [opts.ignoreWhitespace && 'whitespace ignored', opts.ignoreCase && 'case ignored', opts.ignoreEol && 'line endings ignored', opts.algorithm === 'patience' ? 'patience diff' : 'Myers diff'].filter(Boolean).join(' · ');
    let rows = '';
    let n = 0;
    for (const h of hunks) {
      n++;
      rows += `<tr class="hh"><td colspan="4">Change group ${n} · left lines ${h.aStart + 1}–${h.aEnd} · right lines ${h.bStart + 1}–${h.bEnd}</td></tr>`;
      let ai = h.aStart; let bi = h.bStart;
      const same = (to) => { while (ai < to) { rows += `<tr><td class="n">${ai + 1}</td><td class="t">${marked(a.lines[ai], null)}</td><td class="n">${bi + 1}</td><td class="t">${marked(b.lines[bi], null)}</td></tr>`; ai++; bi++; } };
      for (const c of h.changes) {
        same(c.aStart);
        const na = c.aEnd - c.aStart; const nb = c.bEnd - c.bStart;
        for (let i = 0; i < Math.max(na, nb); i++) {
          const hasA = i < na; const hasB = i < nb;
          const la = hasA ? a.lines[c.aStart + i] : ''; const lb = hasB ? b.lines[c.bStart + i] : '';
          const inl = hasA && hasB && info.inline !== 'off' ? T.inlineDiff(la, lb, info.inline === 'char' ? 'char' : 'word', opts) : null;
          rows += '<tr>' +
            (hasA ? `<td class="n del">${c.aStart + i + 1}</td><td class="t del">${marked(la, inl && inl.a, 'd')}</td>` : '<td class="n gap"></td><td class="t gap"></td>') +
            (hasB ? `<td class="n add">${c.bStart + i + 1}</td><td class="t add">${marked(lb, inl && inl.b, 'a')}</td>` : '<td class="n gap"></td><td class="t gap"></td>') +
            '</tr>';
        }
        ai = c.aEnd; bi = c.bEnd;
      }
      same(h.aEnd);
    }
    const summary = s.changes
      ? `${s.changes} change${s.changes === 1 ? '' : 's'}: ${s.modified} line${s.modified === 1 ? '' : 's'} changed, ${s.added} added, ${s.removed} removed`
      : 'No differences';
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
<title>Diff: ${esc(info.leftName || 'left')} ↔ ${esc(info.rightName || 'right')}</title>
<style>
body{margin:24px;background:#0b0b0d;color:#f3f3f4;font:13px/1.45 "Segoe UI",system-ui,sans-serif}
h1{font-size:16px;margin:0 0 4px}.m{color:#a4a4ae;margin:0 0 16px}
table{border-collapse:collapse;width:100%;table-layout:fixed;font:12px/1.5 ui-monospace,Consolas,"Liberation Mono",monospace}
td{padding:0 8px;vertical-align:top;white-space:pre-wrap;word-break:break-all;border-bottom:1px solid #17171b}
td.n{width:56px;text-align:right;color:#8e8e98;user-select:none}
tr.hh td{background:#17171b;color:#b9b9c1;padding:4px 8px;font-family:"Segoe UI",system-ui,sans-serif}
.del{background:#3a1d22}.add{background:#173326}.gap{background:#121215}
mark.d{background:#7a2f3a;color:#fff}mark.a{background:#22684a;color:#fff}.more{color:#8e8e98}
@media print{body{background:#fff;color:#000}.del{background:#fde8ea}.add{background:#e6f6ec}mark.d{background:#f4a9b3;color:#000}mark.a{background:#9fdcb7;color:#000}tr.hh td{background:#eee;color:#000}}
</style></head><body>
<h1>${esc(info.leftName || 'left')} ↔ ${esc(info.rightName || 'right')}</h1>
<p class="m">${esc(summary)} · ${esc(optWords)}${info.created ? ' · ' + esc(info.created) : ''}</p>
${s.changes ? `<table><colgroup><col style="width:56px"><col><col style="width:56px"><col></colgroup>${rows}</table>` : '<p>The two texts are the same.</p>'}
</body></html>
`;
  }

  return { makeHtmlReport };
}));
