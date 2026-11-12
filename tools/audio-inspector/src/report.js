'use strict';
// Shared by the main process, the tests and the window (loaded with <script> there): number formats, the facts of one file
// as label/value pairs, and the CSV and text reports.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Report = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  const fin = (x) => typeof x === 'number' && Number.isFinite(x);
  const dB = (x, unit = 'dBFS') => (fin(x) ? `${x > 0 ? '+' : ''}${x.toFixed(1)} ${unit}` : x === -Infinity ? `−∞ ${unit}` : '—');
  const lufs = (x) => (fin(x) ? `${x.toFixed(1)} LUFS` : '—');
  const kbps = (x) => (x ? `${Math.round(x)} kbps` : '—');
  const hz = (x) => (x ? (x % 1000 === 0 ? `${x / 1000} kHz` : `${(x / 1000).toFixed(1)} kHz`) : '—');
  function duration(sec) {
    if (!fin(sec)) return '—';
    const s = Math.round(sec); const h = Math.floor(s / 3600); const m = Math.floor((s % 3600) / 60);
    return (h ? `${h}:${String(m).padStart(2, '0')}` : `${m}`) + `:${String(s % 60).padStart(2, '0')}`;
  }
  function size(bytes) {
    if (!bytes) return '—';
    const u = ['B', 'KB', 'MB', 'GB']; let i = 0; let v = bytes;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    return `${v < 10 && i ? v.toFixed(1) : Math.round(v)} ${u[i]}`;
  }
  const channels = (n, layout) => (n === 1 ? 'Mono' : n === 2 ? 'Stereo' : layout ? `${n} (${layout})` : `${n}`);
  const pct = (x) => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(3)}%`;

  /** Everything about one inspected file, as [label, value] pairs in the order the window and the report show them. */
  function facts(r) {
    const i = r.info; const m = r.m; const v = r.verdict;
    const bits = i.lossless ? (i.float ? `${i.bitsDeclared}-bit float` : i.bitsDeclared ? `${i.bitsDeclared}-bit` + (m.effectiveBits && m.effectiveBits !== i.bitsDeclared ? ` (${m.effectiveBits} used)` : '') : '—') : '— (lossy)';
    const clip = m.clipping.runs ? `${m.clipping.runs.toLocaleString('en-US')} places, ${m.clipping.samples.toLocaleString('en-US')} samples` : 'None';
    const mono = !m.mono ? (m.channels === 1 ? 'Mono file' : '—') : m.mono.identical ? 'Yes: both channels identical' : m.mono.sideDb < -50 ? 'Practically (channels almost identical)' : 'No';
    const dc = m.dcOffset.map(pct).join(' / ');
    return [
      ['Verdict', v.title],
      ['Why', v.explain],
      ['Format', `${i.codecName}${i.profile ? ' ' + i.profile : ''}`],
      ['Container', i.container || '—'],
      ['Sample rate', hz(i.sampleRate)],
      ['Bit depth', bits],
      ['Channels', channels(m.channels, i.layout)],
      ['Duration', duration(m.seconds || i.duration)],
      ['File size', size(i.fileSize)],
      ['Bitrate (stated)', kbps(i.streamBitrate || i.containerBitrate)],
      ['Bitrate (actual)', kbps(i.actualBitrate)],
      ['Highest frequency', v.cutoffHz ? `${hz(v.cutoffHz)} (sharp cutoff, ${v.cliffDb} dB)` : v.reachHz ? `${hz(v.reachHz)} (no sharp cutoff)` : 'No sharp cutoff'],
      ['Peak', dB(m.samplePeakDb)],
      ['True peak', dB(m.truePeakDb, 'dBTP')],
      ['Loudness', lufs(m.integrated)],
      ['Loudness range', fin(m.lra) ? `${m.lra.toFixed(1)} LU` : '—'],
      ['Dynamic range', m.dr != null ? `DR${m.dr}` : '—'],
      ['Average level (RMS)', dB(m.rmsDb)],
      ['Clipping', clip],
      ['DC offset', dc],
      ['Mono in stereo', mono],
      ['Silence at start / end', m.silence.all ? 'All silent' : `${m.silence.start.toFixed(2)} s / ${m.silence.end.toFixed(2)} s`],
    ];
  }

  const CSV_COLUMNS = ['File', 'Folder', 'Verdict', 'Explanation', 'Format', 'Sample rate (Hz)', 'Bit depth', 'Bits used', 'Channels', 'Duration (s)', 'Bitrate stated (kbps)', 'Bitrate actual (kbps)',
    'Cutoff (Hz)', 'Peak (dBFS)', 'True peak (dBTP)', 'Loudness (LUFS)', 'Loudness range (LU)', 'DR', 'Clipped places', 'Clipped samples', 'DC offset', 'Mono in stereo', 'Silence start (s)', 'Silence end (s)', 'Notes'];
  const cell = (x) => { const s = x == null ? '' : String(x); return /[",\r\n;]/.test(s) || /^[=+\-@]/.test(s) ? `"${(/^[=+\-@]/.test(s) ? "'" : '') + s.replace(/"/g, '""')}"` : s; };
  const num = (x, d = 1) => (fin(x) ? x.toFixed(d) : '');

  /** @param {{name:string, folder:string, result?:object, error?:string}[]} rows */
  function csv(rows) {
    const lines = [CSV_COLUMNS.map(cell).join(',')];
    for (const row of rows) {
      if (!row.result) { lines.push([row.name, row.folder, 'Could not inspect', row.error || ''].map(cell).join(',')); continue; }
      const { info: i, m, verdict: v } = row.result;
      lines.push([
        row.name, row.folder, v.chip, v.explain, `${i.codecName}${i.profile ? ' ' + i.profile : ''}`, i.sampleRate, i.lossless ? (i.float ? `${i.bitsDeclared} float` : i.bitsDeclared) : '', m.effectiveBits || '',
        m.channels, num(m.seconds, 2), i.streamBitrate || i.containerBitrate || '', i.actualBitrate || '', v.cutoffHz || '', num(m.samplePeakDb, 2), num(m.truePeakDb, 2), num(m.integrated, 1), num(m.lra, 1),
        m.dr == null ? '' : m.dr, m.clipping.runs, m.clipping.samples, m.dcOffset.map((x) => x.toFixed(5)).join(' / '), m.mono ? (m.mono.identical ? 'identical' : m.mono.sideDb < -50 ? 'practically' : 'no') : '',
        num(m.silence.start, 2), num(m.silence.end, 2), v.flags.map((f) => f.text).join('; '),
      ].map(cell).join(','));
    }
    return lines.join('\r\n') + '\r\n';
  }

  /** A readable plain-text report: a summary, then every file with all its facts. */
  function text(rows, when = new Date()) {
    const out = [];
    const done = rows.filter((r) => r.result);
    const count = (k) => done.filter((r) => r.result.verdict.kind === k).length;
    out.push('Audio Inspector report', `Made ${when.toISOString().replace('T', ' ').slice(0, 16)} UTC`, '');
    out.push(`${rows.length} file${rows.length === 1 ? '' : 's'}: ${count('real')} real lossless, ${count('fake')} fake lossless, ${count('upsampled')} upsampled, ${count('unsure')} can't tell, ${count('lossy')} lossy` + (rows.length - done.length ? `, ${rows.length - done.length} could not be inspected` : ''), '');
    for (const row of rows) {
      out.push('='.repeat(78), `${row.name}`, `${row.folder}`, '-'.repeat(78));
      if (!row.result) { out.push(`Could not inspect: ${row.error || 'unknown problem'}`, ''); continue; }
      const f = facts(row.result);
      const w = Math.max(...f.map(([k]) => k.length));
      for (const [k, v] of f) out.push(`${k.padEnd(w)}  ${v}`);
      if (row.result.verdict.flags.length) { out.push('', 'Worth knowing:'); for (const fl of row.result.verdict.flags) out.push(`  - ${fl.text}`); }
      out.push('');
    }
    return out.join('\r\n');
  }

  return { dB, lufs, kbps, hz, duration, size, channels, facts, csv, text, CSV_COLUMNS };
}));
