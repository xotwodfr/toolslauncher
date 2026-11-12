'use strict';
/* global importScripts, TextDiff, DiffReport */
// Runs the line diff off the window's thread, so big files never freeze it. The page sends both texts once per compare;
// patches and reports are made from the texts kept here.
importScripts('../core/textdiff.js', '../core/report.js');

let A = null; let B = null; let last = null;

self.onmessage = (ev) => {
  const msg = ev.data || {};
  try {
    if (msg.type === 'diff') {
      A = TextDiff.splitLines(msg.a); B = TextDiff.splitLines(msg.b);
      const t0 = Date.now();
      const r = TextDiff.diffLines(A, B, msg.opts);
      const rows = TextDiff.buildRows(r.blocks);
      last = { result: r, opts: msg.opts };
      const transfer = [];
      for (const v of [rows.side, rows.unified]) for (const k of ['left', 'right', 'kind', 'hunk']) transfer.push(v[k].buffer);
      self.postMessage({
        id: msg.id, type: 'diff', blocks: r.blocks, stats: r.stats, approximate: r.approximate, rows, ms: Date.now() - t0,
        eolA: TextDiff.lineEndingOf(A), eolB: TextDiff.lineEndingOf(B), linesA: A.lines.length, linesB: B.lines.length,
      }, transfer);
    } else if (msg.type === 'patch') {
      if (!A) throw new Error('Nothing compared yet');
      self.postMessage({ id: msg.id, type: 'patch', text: TextDiff.makePatch(A, B, msg.opts) });
    } else if (msg.type === 'report') {
      if (!A || !last) throw new Error('Nothing compared yet');
      self.postMessage({ id: msg.id, type: 'report', text: DiffReport.makeHtmlReport(A, B, last.result, msg.info) });
    } else if (msg.type === 'merge') {
      if (!A || !last) throw new Error('Nothing compared yet');
      self.postMessage({ id: msg.id, type: 'merge', text: TextDiff.mergeText(A, B, last.result.blocks, msg.choices) });
    }
  } catch (e) {
    self.postMessage({ id: msg.id, type: 'error', error: String((e && e.message) || e) });
  }
};
