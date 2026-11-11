'use strict';
/* global TextDiff */
(() => {
  const T = window.TextDiff;
  const $ = (id) => document.getElementById(id);
  const el = (tag, attrs, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) { if (v === false || v == null) continue; if (k === 'class') n.className = v; else n.setAttribute(k, v === true ? '' : v); }
    for (const kid of kids) if (kid != null) n.append(kid);
    return n;
  };
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const plural = (n, w) => `${n.toLocaleString('en')} ${w}${n === 1 ? '' : 's'}`;
  const LH = 20;
  const MAX_SHOWN = 2000; // characters shown of one line; the rest is cut with "…"

  const OPTS_KEY = 'textdiff.options';
  const loadOpts = () => {
    const d = { view: 'side', inline: 'word', algorithm: 'myers', ignoreWhitespace: false, ignoreCase: false, ignoreEol: true, sync: true, fmode: 'quick', ignore: 'node_modules, .git, .DS_Store, Thumbs.db, desktop.ini' };
    try { return { ...d, ...JSON.parse(localStorage.getItem(OPTS_KEY) || '{}') }; } catch { return d; }
  };
  const saveOpts = () => { try { localStorage.setItem(OPTS_KEY, JSON.stringify(S.opts)); } catch { /* private mode: fine */ } };

  const blankSide = () => ({ kind: 'text', name: '', path: null, text: '', encoding: 'utf-8', encodingLabel: 'UTF-8', size: 0, sha256: null, edited: false });
  const S = {
    opts: loadOpts(),
    tab: 'text',
    mode: 'edit',                    // 'edit' (text boxes) or 'view' (the comparison)
    side: { left: blankSide(), right: blankSide() },
    split: { left: null, right: null },
    boxStale: { left: false, right: false },
    diff: null,                      // the last answer from the worker
    cur: -1,                         // the current change
    choices: [],                     // per change: 'left' | 'right'
    mergeEdited: false,
    mergedRaw: '',
    inlineCache: new Map(),
    diffSeq: 0,
    folder: { left: null, right: null, result: null, collapsed: new Set(), selected: new Set(), visible: [], filters: { different: true, left: true, right: true, same: false, error: true }, busy: false, anchor: null },
  };

  // ---- messages --------------------------------------------------------------------------------------------------------
  let toastTimer = null;
  function toast(text, err = false) {
    const t = $('toast');
    t.textContent = text; t.className = 'toast' + (err ? ' err' : ''); t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 4200);
  }
  function banner(text) { const b = $('banner'); b.textContent = text || ''; b.hidden = !text; }
  function showResult(text, kind, showPath) {
    const r = $('result'); r.replaceChildren(); r.className = 'result' + (kind ? ' ' + kind : ''); r.hidden = !text;
    if (!text) return;
    r.append(el('span', { class: 'grow' }, text));
    if (showPath) { const b = el('button', { class: 'btn small' }, 'Show in folder'); b.addEventListener('click', () => window.td.show(showPath)); r.append(b); }
    const x = el('button', { class: 'btn small ghost', 'aria-label': 'Dismiss' }, 'Close'); x.addEventListener('click', () => { r.hidden = true; }); r.append(x);
  }
  const errText = (e) => String((e && e.message) || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

  // ---- worker ----------------------------------------------------------------------------------------------------------
  let worker = null; let reqId = 0; const pending = new Map();
  function getWorker() {
    if (worker) return worker;
    worker = new Worker('diff-worker.js');
    worker.onmessage = (ev) => { const m = ev.data; const p = pending.get(m.id); if (!p) return; pending.delete(m.id); if (m.type === 'error') p.reject(new Error(m.error)); else p.resolve(m); };
    worker.onerror = (ev) => { for (const p of pending.values()) p.reject(new Error(ev.message || 'The comparison stopped')); pending.clear(); worker = null; };
    return worker;
  }
  function ask(msg) { return new Promise((resolve, reject) => { const id = ++reqId; pending.set(id, { resolve, reject }); getWorker().postMessage({ ...msg, id }); }); }
  /** Stop a long comparison that is no longer wanted (new texts or options). */
  function resetWorker() { if (worker) { worker.terminate(); worker = null; } for (const p of pending.values()) p.reject(Object.assign(new Error('superseded'), { superseded: true })); pending.clear(); }

  // ---- sides -------------------------------------------------------------------------------------------------------------
  const SIDE_KEY = { left: 'L', right: 'R' };
  function sideFacts(side) {
    const s = S.side[side]; const k = SIDE_KEY[side];
    $('name' + k).textContent = s.path ? s.name + (s.edited ? ' (edited)' : '') : s.text ? 'Pasted text' : 'Empty';
    $('name' + k).title = s.path || '';
    const facts = [];
    if (s.kind === 'binary') facts.push([s.tooLarge ? 'too big to show' : 'binary', 'warn']);
    else facts.push([s.encodingLabel || 'UTF-8', '']);
    const sp = S.split[side];
    if (s.kind === 'text' && sp) {
      const eol = T.lineEndingOf(sp);
      if (eol !== 'None') facts.push([eol, eol === 'Mixed' ? 'warn' : '']);
      facts.push([plural(sp.lines.length, 'line'), '']);
    }
    if (s.path) facts.push([sizeText(s.size), '']);
    $('facts' + k).replaceChildren(...facts.map(([t, c]) => el('span', { class: 'fact' + (c ? ' ' + c : '') }, t)));
    $('clear' + k).hidden = !s.path && !s.text;
  }
  const sizeText = (n) => (n == null ? '' : n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : n < 1073741824 ? `${(n / 1048576).toFixed(1)} MB` : `${(n / 1073741824).toFixed(2)} GB`);

  function setSide(side, info) {
    const s = blankSide();
    if (info) Object.assign(s, { kind: info.kind, name: info.name, path: info.path, text: info.text || '', encoding: info.encoding, encodingLabel: info.encodingLabel, size: info.size, sha256: info.sha256, tooLarge: !!info.tooLarge, bom: info.bom });
    S.side[side] = s;
    S.split[side] = s.kind === 'text' ? T.splitLines(s.text) : null;
    S.diff = null; // it described the old texts
    S.boxStale[side] = true; // the text box still shows the old text until fillEditors()
    sideFacts(side);
  }

  const eolOf = (side) => { const sp = S.split[side]; const e = sp ? T.lineEndingOf(sp) : 'None'; return e === 'CRLF' ? '\r\n' : e === 'CR' ? '\r' : '\n'; };
  const withEol = (text, eol) => (eol === '\n' ? text : text.replace(/\n/g, eol));
  /** Read the text boxes back into the sides (typing in a box makes that side "edited"). */
  function takeEditors() {
    for (const side of ['left', 'right']) {
      const box = $('ed' + SIDE_KEY[side]); const s = S.side[side];
      if (s.kind !== 'text' || box.disabled || S.boxStale[side]) continue;
      // text boxes show every line ending as \n: only a real edit counts, and it keeps the side's usual line ending
      if (box.value !== s.text.replace(/\r\n?/g, '\n')) {
        s.text = withEol(box.value, eolOf(side)); s.edited = !!s.path; if (!s.path) s.name = '';
        S.split[side] = T.splitLines(s.text);
        S.diff = null;
        sideFacts(side);
      }
    }
  }
  function fillEditors() {
    for (const side of ['left', 'right']) {
      const box = $('ed' + SIDE_KEY[side]); const s = S.side[side];
      S.boxStale[side] = false;
      if (s.kind === 'binary') { box.value = ''; box.disabled = true; box.placeholder = `"${s.name}" is not a text file (or is too big to show). It is compared by its contents' hash.`; }
      else { box.disabled = false; box.placeholder = side === 'left' ? 'Paste or type the first text here, or drop a file on this side.' : 'Paste or type the second text here, or drop a file on this side.'; if (box.value !== s.text) box.value = s.text; }
    }
  }

  async function openSide(side, filePath) {
    try {
      const info = filePath ? await window.td.loadFile(side, filePath) : await window.td.pickFile(side);
      if (!info) return false;
      setSide(side, info);
      banner('');
      afterSidesChanged();
      return true;
    } catch (e) { toast(errText(e), true); return false; }
  }
  function afterSidesChanged() {
    const both = S.side.left.path && S.side.right.path;
    if (S.mode === 'view' || both) compare();
    else fillEditors();
  }
  function clearSide(side) {
    window.td.forgetFile(side);
    setSide(side, null);
    if (S.mode === 'view') compare(); else fillEditors();
  }

  // ---- comparing ---------------------------------------------------------------------------------------------------------
  const diffOpts = () => ({ algorithm: S.opts.algorithm, ignoreWhitespace: S.opts.ignoreWhitespace, ignoreCase: S.opts.ignoreCase, ignoreEol: S.opts.ignoreEol });

  async function compare() {
    if (S.mode === 'edit') takeEditors();
    const L = S.side.left; const R = S.side.right;
    setMode('view');
    S.inlineCache.clear();
    const seq = ++S.diffSeq;
    if (L.kind === 'binary' || R.kind === 'binary') { resetWorker(); S.diff = null; showBinary(); return; }
    $('binary').hidden = true;
    const busyTimer = setTimeout(() => { if (seq === S.diffSeq) { $('busy').hidden = false; $('summary').textContent = 'Comparing…'; } }, 120);
    resetWorker();
    let res;
    try { res = await ask({ type: 'diff', a: L.text, b: R.text, opts: diffOpts() }); }
    catch (e) { if (!e.superseded) { banner('The comparison failed: ' + errText(e)); } return; }
    finally { clearTimeout(busyTimer); if (seq === S.diffSeq) $('busy').hidden = true; }
    if (seq !== S.diffSeq) return;
    S.diff = res;
    S.choices = res.rows.hunks.map(() => 'left');
    S.cur = -1; S.mergeEdited = false;
    sideFacts('left'); sideFacts('right');
    layoutViews();
    updateSummary();
    if (!$('merge').hidden) rebuildMerged();
    updateButtons();
  }

  function updateSummary() {
    const d = S.diff;
    if (!d) return;
    const s = d.stats;
    let text;
    if (!s.changes) {
      const exact = S.side.left.text === S.side.right.text;
      text = exact ? 'No differences: the two texts are identical.' : 'No differences with the current options.';
      if (!exact && S.opts.ignoreEol && d.eolA !== d.eolB) text = `No differences apart from line endings (left ${d.eolA}, right ${d.eolB}).`;
      else if (!exact) text += ' The texts are not byte-for-byte the same (whitespace, case or line endings differ).';
    } else {
      const parts = [];
      if (s.modified) parts.push(`${plural(s.modified, 'line')} changed`);
      if (s.added) parts.push(`${s.added.toLocaleString('en')} added`);
      if (s.removed) parts.push(`${s.removed.toLocaleString('en')} removed`);
      text = `${plural(s.changes, 'change')}: ${parts.join(', ')}.`;
      if (d.approximate) text += ' (Very different texts: some lines are shown as replaced rather than matched.)';
    }
    $('summary').textContent = text;
    $('pos').textContent = s.changes ? `${S.cur < 0 ? '–' : S.cur + 1} / ${s.changes}` : '';
  }

  function updateButtons() {
    const view = S.mode === 'view';
    const changes = view && S.diff ? S.diff.stats.changes : 0;
    $('prev').disabled = !changes; $('next').disabled = !changes;
    $('compare').hidden = view;
    $('edit').hidden = !view;
    const textDiff = view && !!S.diff;
    $('mergeBtn').disabled = !textDiff; $('patch').disabled = !textDiff || !changes; $('report').disabled = !textDiff;
    $('saveL').disabled = !S.side.left.path; $('saveR').disabled = !S.side.right.path;
    $('saveL').title = S.side.left.path ? `Replace ${S.side.left.name} (a .bak copy is kept)` : 'The left side is not a file';
    $('saveR').title = S.side.right.path ? `Replace ${S.side.right.name} (a .bak copy is kept)` : 'The right side is not a file';
  }

  function setMode(mode) {
    S.mode = mode;
    $('editors').hidden = mode !== 'edit';
    $('viewer').hidden = mode !== 'view';
    if (mode === 'edit') { fillEditors(); $('merge').hidden = true; }
    updateButtons();
  }

  function showBinary() {
    const L = S.side.left; const R = S.side.right;
    $('vSide').hidden = true; $('vUni').hidden = true;
    const box = $('binary'); box.hidden = false;
    let same = false; let head;
    if (L.kind === 'binary' && R.kind === 'binary') { same = L.sha256 && L.sha256 === R.sha256; head = same ? 'Binary files are identical' : 'Binary files differ'; }
    else head = 'A text and a binary file: they differ';
    box.className = 'binary ' + (same ? 'same' : 'diff');
    const row = (label, l, r) => `<tr><td class="label">${esc(label)}</td><td>${l}</td><td>${r}</td></tr>`;
    const hashOf = (s) => (s.sha256 ? `<code>${esc(s.sha256)}</code>` : '<span class="muted">pasted text</span>');
    box.innerHTML = `<div class="big">${esc(head)}</div>
      <p class="muted">${same ? 'Both files have exactly the same bytes (same SHA-256).' : 'The contents are not the same. Files that are not UTF-8 or UTF-16 text are compared by hash only.'}</p>
      <table>${row('', '<b>Left</b>', '<b>Right</b>')}${row('Name', esc(L.name || 'Pasted text'), esc(R.name || 'Pasted text'))}${row('Kind', esc(L.kind === 'binary' ? 'binary' : L.encodingLabel), esc(R.kind === 'binary' ? 'binary' : R.encodingLabel))}${row('Size', esc(sizeText(L.size)), esc(sizeText(R.size)))}${row('SHA-256', hashOf(L), hashOf(R))}</table>`;
    $('summary').textContent = head + '.';
    $('pos').textContent = '';
    updateButtons();
  }

  // ---- the virtual views -----------------------------------------------------------------------------------------------------
  const panes = () => (S.opts.view === 'side' ? [$('paneL'), $('paneR')] : [$('paneU')]);
  let charW = 7.5;
  function measure() {
    const probe = el('span', { class: 'ln' }, el('span', { class: 'tx' }, 'x'.repeat(100)));
    probe.style.position = 'absolute'; probe.style.visibility = 'hidden';
    $('paneL').append(probe);
    const w = probe.firstChild.getBoundingClientRect().width;
    probe.remove();
    if (w > 0) charW = (w - 20) / 100; // minus the text cell's padding
  }
  function maxLen(sp) {
    let m = 0;
    if (!sp) return 0;
    for (const l of sp.lines) {
      let n = l.length;
      if (n > MAX_SHOWN) n = MAX_SHOWN + 2;
      else if (l.includes('\t')) n += (l.split('\t').length - 1) * 3;
      if (n > m) m = n;
    }
    return m;
  }

  function layoutViews() {
    const side = S.opts.view === 'side';
    $('vSide').hidden = !side; $('vUni').hidden = side;
    if (!S.diff) return;
    measure();
    const rows = side ? S.diff.rows.side : S.diff.rows.unified;
    const digits = String(Math.max(S.split.left.lines.length, S.split.right.lines.length, 9)).length;
    const now = Math.ceil(digits * charW + 18);
    const wL = maxLen(S.split.left); const wR = maxLen(S.split.right);
    for (const p of [$('paneL'), $('paneR'), $('paneU')]) p.style.setProperty('--now', now + 'px');
    const height = rows.kind.length * LH + 8;
    if (side) {
      $('paneL').querySelector('.spacer').style.cssText = `height:${height}px;width:${now + wL * charW + 40}px`;
      $('paneR').querySelector('.spacer').style.cssText = `height:${height}px;width:${now + wR * charW + 40}px`;
      $('gutter').querySelector('.gin').style.height = height + 'px';
    } else {
      $('paneU').querySelector('.spacer').style.cssText = `height:${height}px;width:${2 * now + 18 + Math.max(wL, wR) * charW + 40}px`;
    }
    for (const p of panes()) { const r = p.querySelector('.rows'); r.style.minWidth = `max(100%, ${p.querySelector('.spacer').style.width})`; }
    render();
  }

  function lineHtml(text, ranges) {
    let shown = text; let cut = false;
    if (shown.length > MAX_SHOWN) { shown = shown.slice(0, MAX_SHOWN); cut = true; }
    let html = '';
    if (!ranges || !ranges.length) html = esc(shown);
    else {
      let pos = 0;
      for (const [f, t] of ranges) {
        if (f >= shown.length) break;
        html += esc(shown.slice(pos, f)) + '<mark class="hl">' + esc(shown.slice(f, Math.min(t, shown.length))) + '</mark>';
        pos = Math.min(t, shown.length);
      }
      html += esc(shown.slice(pos));
    }
    return html + (cut ? `<span class="more" title="This line is ${text.length.toLocaleString('en')} characters long; the rest is not shown">…</span>` : '');
  }
  function inlineFor(li, ri) {
    if (S.opts.inline === 'off' || li < 0 || ri < 0) return null;
    const key = li * 4294967296 + ri;
    if (S.inlineCache.has(key)) return S.inlineCache.get(key);
    const v = T.inlineDiff(S.split.left.lines[li], S.split.right.lines[ri], S.opts.inline, diffOpts());
    if (S.inlineCache.size > 20000) S.inlineCache.clear();
    S.inlineCache.set(key, v);
    return v;
  }
  const visibleRange = (pane, count) => {
    const first = Math.max(0, Math.floor(pane.scrollTop / LH) - 10);
    const last = Math.min(count, Math.ceil((pane.scrollTop + pane.clientHeight) / LH) + 10);
    return [first, last];
  };

  function renderSidePane(pane, which) {
    const R = S.diff.rows.side; const sp = S.split[which];
    const [first, last] = visibleRange(pane, R.kind.length);
    const idx = which === 'left' ? R.left : R.right;
    const cls = which === 'left' ? 'l' : 'r';
    const curHunk = S.cur;
    let html = '';
    for (let r = first; r < last; r++) {
      const i = idx[r]; const k = R.kind[r]; const h = R.hunk[r];
      const cur = h >= 0 && h === curHunk ? ' cur' : '';
      if (i < 0) { html += `<div class="ln gapln${cur}"><span class="no"></span><span class="tx"></span></div>`; continue; }
      let ranges = null;
      if (k === 1) { const v = inlineFor(R.left[r], R.right[r]); if (v) ranges = which === 'left' ? v.a : v.b; }
      html += `<div class="ln k${k} ${cls}${cur}" data-row="${r}"><span class="no">${i + 1}</span><span class="tx">${lineHtml(sp.lines[i], ranges)}</span></div>`;
    }
    const rows = pane.querySelector('.rows');
    rows.style.transform = `translateY(${first * LH}px)`;
    rows.innerHTML = html;
  }
  function renderUnified(pane) {
    const R = S.diff.rows.unified;
    const [first, last] = visibleRange(pane, R.kind.length);
    let html = '';
    for (let r = first; r < last; r++) {
      const k = R.kind[r]; const h = R.hunk[r]; const cur = h >= 0 && h === S.cur ? ' cur' : '';
      const li = R.left[r]; const ri = R.right[r];
      let text; let ranges = null; let a = ''; let b = ''; let sign = ' ';
      if (k === 0) { text = S.split.left.lines[li]; a = li + 1; b = ri + 1; }
      else if (k === 2) { text = S.split.left.lines[li]; a = li + 1; sign = '−'; if (ri >= 0) { const v = inlineFor(li, ri); if (v) ranges = v.a; } }
      else { text = S.split.right.lines[ri]; b = ri + 1; sign = '+'; if (li >= 0) { const v = inlineFor(li, ri); if (v) ranges = v.b; } }
      html += `<div class="ln k${k}${cur}" data-row="${r}"><span class="no">${a}</span><span class="no no2">${b}</span><span class="sg">${sign}</span><span class="tx">${lineHtml(text, ranges)}</span></div>`;
    }
    const rows = pane.querySelector('.rows');
    rows.style.transform = `translateY(${first * LH}px)`;
    rows.innerHTML = html;
  }
  function renderGutter() {
    const g = $('gutter'); const gin = g.querySelector('.gin'); const pane = $('paneL');
    gin.style.transform = `translateY(${-pane.scrollTop}px)`;
    const top = pane.scrollTop - 200; const bottom = pane.scrollTop + pane.clientHeight + 200;
    const frag = document.createDocumentFragment();
    for (const h of S.diff.rows.hunks) {
      const y = h.sideRow * LH;
      if (y + h.sideRows * LH < top) continue;
      if (y > bottom) break;
      const c = S.choices[h.index];
      const box = el('div', { class: 'gh' + (h.index === S.cur ? ' cur' : ''), 'data-h': String(h.index) },
        el('button', { class: 'pick', type: 'button', 'data-pick': 'left', 'aria-pressed': String(c === 'left'), title: 'Use the left version of this change in the merged result', 'aria-label': `Change ${h.index + 1}: take left` }, '◀ L'),
        el('button', { class: 'pick', type: 'button', 'data-pick': 'right', 'aria-pressed': String(c === 'right'), title: 'Use the right version of this change in the merged result', 'aria-label': `Change ${h.index + 1}: take right` }, 'R ▶'));
      box.style.top = y + 'px'; box.style.height = Math.max(1, h.sideRows) * LH + 'px'; // CSSOM, which the page's CSP allows
      frag.append(box);
    }
    gin.replaceChildren(frag);
  }
  let rafPending = false;
  function render() {
    if (!S.diff || S.mode !== 'view') return;
    if (S.opts.view === 'side') { renderSidePane($('paneL'), 'left'); renderSidePane($('paneR'), 'right'); renderGutter(); }
    else renderUnified($('paneU'));
  }
  const scheduleRender = () => { if (rafPending) return; rafPending = true; requestAnimationFrame(() => { rafPending = false; render(); }); };

  let syncing = false;
  function wireScroll() {
    const pl = $('paneL'); const pr = $('paneR');
    const follow = (from, to) => () => {
      if (syncing) { syncing = false; scheduleRender(); return; }
      if (S.opts.sync && (to.scrollTop !== from.scrollTop || to.scrollLeft !== from.scrollLeft)) { syncing = true; to.scrollTop = from.scrollTop; to.scrollLeft = from.scrollLeft; }
      scheduleRender();
    };
    pl.addEventListener('scroll', follow(pl, pr), { passive: true });
    pr.addEventListener('scroll', follow(pr, pl), { passive: true });
    $('paneU').addEventListener('scroll', scheduleRender, { passive: true });
    $('gutter').addEventListener('wheel', (e) => { pl.scrollTop += e.deltaY; }, { passive: true });
    window.addEventListener('resize', scheduleRender);
  }

  // ---- change navigation ----------------------------------------------------------------------------------------------------
  function goTo(index) {
    if (!S.diff || !S.diff.stats.changes) return;
    const n = S.diff.rows.hunks.length;
    S.cur = Math.max(0, Math.min(n - 1, index));
    const h = S.diff.rows.hunks[S.cur];
    const row = S.opts.view === 'side' ? h.sideRow : h.uniRow;
    for (const p of panes()) p.scrollTop = Math.max(0, row * LH - p.clientHeight / 3);
    updateSummary();
    render();
  }
  function step(dir) {
    if (!S.diff || !S.diff.stats.changes) return;
    if (S.cur < 0) {
      // start from what is on screen
      const p = panes()[0]; const top = p.scrollTop / LH;
      const hs = S.diff.rows.hunks; const key = S.opts.view === 'side' ? 'sideRow' : 'uniRow';
      let i = dir > 0 ? hs.findIndex((h) => h[key] >= top) : hs.length - 1 - [...hs].reverse().findIndex((h) => h[key] < top + p.clientHeight / LH);
      if (i < 0 || i >= hs.length) i = dir > 0 ? 0 : hs.length - 1;
      goTo(i);
    } else goTo(S.cur + dir);
  }

  // ---- merging ------------------------------------------------------------------------------------------------------------
  function choose(h, side) {
    if (!S.diff || h < 0 || h >= S.choices.length) return;
    S.choices[h] = side;
    S.cur = h;
    if ($('merge').hidden) openMerge(); else rebuildMerged();
    render(); updateSummary();
  }
  async function rebuildMerged(force) {
    if (!S.diff) return;
    const n = S.choices.filter((c) => c === 'right').length;
    $('mergeInfo').textContent = `${n} of ${S.choices.length} change${S.choices.length === 1 ? '' : 's'} taken from the right`;
    if (S.mergeEdited && !force) { $('mergeNote').hidden = false; return; }
    try {
      const r = await ask({ type: 'merge', choices: S.choices });
      S.mergedRaw = r.text; // a text box turns every line ending into \n, so the exact text is kept here
      $('merged').value = r.text;
      S.mergeEdited = false; $('mergeNote').hidden = true;
    } catch (e) { if (!e.superseded) toast(errText(e), true); }
  }
  function openMerge() { $('merge').hidden = false; rebuildMerged(); scheduleRender(); }
  async function saveMerged(target) {
    // untouched: the exact merged text (each line keeps its own ending); edited by hand: the box's text with the line
    // endings of the file it goes into
    const like = target === 'right' ? 'right' : 'left';
    const text = S.mergeEdited ? withEol($('merged').value, eolOf(like)) : S.mergedRaw;
    try {
      const r = await window.td.saveMerged({ text, target, encoding: target === 'new' ? null : undefined });
      if (!r || !r.ok) return;
      if (target === 'new') showResult(`Saved the merged text as ${r.path}`, 'ok', r.path);
      else {
        showResult(`Overwrote ${r.path}. The old version is kept as ${r.backup.split(/[\\/]/).pop()}.`, 'ok', r.path);
        // the side now holds the merged text
        const info = await window.td.reloadFile(target);
        setSide(target, info);
        compare();
      }
    } catch (e) { showResult('Could not save: ' + errText(e), 'err'); }
  }

  // ---- exports -------------------------------------------------------------------------------------------------------------
  const sideName = (side) => S.side[side].name || (side === 'left' ? 'left' : 'right');
  async function exportPatch() {
    try {
      const L = S.side.left; const R = S.side.right;
      const r = await ask({ type: 'patch', opts: { algorithm: S.opts.algorithm, aName: 'a/' + (L.name || 'left'), bName: 'b/' + (R.name || 'right') } });
      const stem = (L.name || 'changes').replace(/\.[^.]+$/, '');
      const s = await window.td.exportSave({ kind: 'patch', text: r.text, name: stem });
      if (s && s.ok) showResult(`Saved the patch as ${s.path}. It is made from the exact texts (the ignore options do not apply to it).`, 'ok', s.path);
    } catch (e) { showResult('Could not save the patch: ' + errText(e), 'err'); }
  }
  async function exportReport() {
    try {
      const created = new Date().toISOString().replace('T', ' ').slice(0, 16);
      const r = await ask({ type: 'report', info: { leftName: sideName('left'), rightName: sideName('right'), options: diffOpts(), inline: S.opts.inline, context: 3, created } });
      const stem = (S.side.left.name || 'changes').replace(/\.[^.]+$/, '') + ' diff';
      const s = await window.td.exportSave({ kind: 'html', text: r.text, name: stem });
      if (s && s.ok) showResult(`Saved the report as ${s.path}`, 'ok', s.path);
    } catch (e) { showResult('Could not save the report: ' + errText(e), 'err'); }
  }

  // ---- options -----------------------------------------------------------------------------------------------------------------
  function wireOptions() {
    const segs = document.querySelectorAll('#textMode .seg .mode');
    const paintSeg = () => segs.forEach((b) => b.setAttribute('aria-checked', String(b.dataset.view === S.opts.view)));
    segs.forEach((b) => b.addEventListener('click', () => {
      if (S.opts.view === b.dataset.view) return;
      // keep the same part of the text on screen
      const topRow = S.diff ? Math.floor(panes()[0].scrollTop / LH) : 0;
      let line = -1;
      if (S.diff) { const R = S.opts.view === 'side' ? S.diff.rows.side : S.diff.rows.unified; line = R.left[Math.min(topRow, R.left.length - 1)]; }
      S.opts.view = b.dataset.view; saveOpts(); paintSeg();
      layoutViews();
      if (S.diff && line >= 0) {
        const R = S.opts.view === 'side' ? S.diff.rows.side : S.diff.rows.unified;
        const at = R.left.indexOf(line);
        if (at >= 0) for (const p of panes()) p.scrollTop = at * LH;
      }
      if (S.cur >= 0) goTo(S.cur); else render();
    }));
    paintSeg();
    const checks = { igWs: 'ignoreWhitespace', igCase: 'ignoreCase', igEol: 'ignoreEol' };
    for (const [id, key] of Object.entries(checks)) {
      $(id).checked = !!S.opts[key];
      $(id).addEventListener('change', () => { S.opts[key] = $(id).checked; saveOpts(); if (S.mode === 'view') compare(); });
    }
    $('sync').checked = !!S.opts.sync;
    $('sync').addEventListener('change', () => { S.opts.sync = $('sync').checked; saveOpts(); if (S.opts.sync) { $('paneR').scrollTop = $('paneL').scrollTop; } });
    $('inline').value = S.opts.inline;
    $('inline').addEventListener('change', () => { S.opts.inline = $('inline').value; saveOpts(); S.inlineCache.clear(); render(); });
    $('algo').value = S.opts.algorithm;
    $('algo').addEventListener('change', () => { S.opts.algorithm = $('algo').value; saveOpts(); if (S.mode === 'view') compare(); });
  }

  function wireText() {
    $('compare').addEventListener('click', () => compare());
    $('edit').addEventListener('click', () => { resetWorker(); S.diffSeq++; S.diff = null; setMode('edit'); $('summary').textContent = ''; $('pos').textContent = ''; $('edL').focus(); });
    $('openL').addEventListener('click', () => openSide('left'));
    $('openR').addEventListener('click', () => openSide('right'));
    $('clearL').addEventListener('click', () => clearSide('left'));
    $('clearR').addEventListener('click', () => clearSide('right'));
    $('prev').addEventListener('click', () => step(-1));
    $('next').addEventListener('click', () => step(1));
    $('mergeBtn').addEventListener('click', () => { if ($('merge').hidden) openMerge(); else { $('merge').hidden = true; scheduleRender(); } });
    $('closeMerge').addEventListener('click', () => { $('merge').hidden = true; scheduleRender(); });
    $('allL').addEventListener('click', () => { S.choices = S.choices.map(() => 'left'); rebuildMerged(); render(); });
    $('allR').addEventListener('click', () => { S.choices = S.choices.map(() => 'right'); rebuildMerged(); render(); });
    $('rebuild').addEventListener('click', () => rebuildMerged(true));
    $('merged').addEventListener('input', () => { S.mergeEdited = true; });
    $('saveNew').addEventListener('click', () => saveMerged('new'));
    $('saveL').addEventListener('click', () => saveMerged('left'));
    $('saveR').addEventListener('click', () => saveMerged('right'));
    $('patch').addEventListener('click', exportPatch);
    $('report').addEventListener('click', exportReport);
    $('gutter').addEventListener('click', (e) => {
      const b = e.target.closest('.pick'); if (!b) return;
      choose(+b.parentElement.dataset.h, b.dataset.pick);
    });
    // clicking a changed line makes it the current change
    for (const p of [$('paneL'), $('paneR'), $('paneU')]) {
      p.addEventListener('click', (e) => {
        const ln = e.target.closest('.ln[data-row]'); if (!ln || !S.diff) return;
        const R = S.opts.view === 'side' ? S.diff.rows.side : S.diff.rows.unified;
        const h = R.hunk[+ln.dataset.row];
        if (h >= 0 && h !== S.cur) { S.cur = h; updateSummary(); render(); }
      });
    }
    document.addEventListener('keydown', (e) => {
      if (S.tab !== 'text' || S.mode !== 'view') return;
      const inBox = e.target && (e.target.tagName === 'TEXTAREA' || e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT');
      if (e.key === 'F7') { e.preventDefault(); step(e.shiftKey ? -1 : 1); }
      else if (!inBox && e.altKey && e.key === 'ArrowDown') { e.preventDefault(); step(1); }
      else if (!inBox && e.altKey && e.key === 'ArrowUp') { e.preventDefault(); step(-1); }
      else if (!inBox && e.altKey && e.key === 'ArrowLeft' && S.cur >= 0) { e.preventDefault(); choose(S.cur, 'left'); }
      else if (!inBox && e.altKey && e.key === 'ArrowRight' && S.cur >= 0) { e.preventDefault(); choose(S.cur, 'right'); }
    });
    document.addEventListener('keydown', (e) => {
      if (S.tab === 'text' && S.mode === 'edit' && e.ctrlKey && e.key === 'Enter') { e.preventDefault(); compare(); }
    });
  }

  // ---- drag and drop -------------------------------------------------------------------------------------------------------
  function wireDrop() {
    let depth = 0;
    const targets = () => [...document.querySelectorAll('.edwrap, #paneL, #paneR, #paneU, .fside, .sidehead')];
    const sideOf = (e) => {
      const t = e.target && e.target.closest && e.target.closest('[data-side], #paneL, #paneR');
      if (!t) return null;
      if (t.id === 'paneL') return 'left';
      if (t.id === 'paneR') return 'right';
      return t.dataset.side || null;
    };
    const clearOver = () => targets().forEach((t) => t.classList.remove('over'));
    window.addEventListener('dragenter', (e) => { e.preventDefault(); depth++; document.body.classList.add('dragging'); });
    window.addEventListener('dragleave', () => { depth = Math.max(0, depth - 1); if (!depth) { document.body.classList.remove('dragging'); clearOver(); } });
    window.addEventListener('dragover', (e) => {
      e.preventDefault(); clearOver();
      const t = e.target && e.target.closest && e.target.closest('.edwrap, #paneL, #paneR, .fside, .sidehead');
      if (t) t.classList.add('over');
    });
    window.addEventListener('drop', async (e) => {
      e.preventDefault(); depth = 0; document.body.classList.remove('dragging'); clearOver();
      const paths = [...(e.dataTransfer ? e.dataTransfer.files : [])].map((f) => window.td.pathForFile(f)).filter(Boolean);
      if (!paths.length) return;
      const side = sideOf(e);
      if (S.tab === 'folders') {
        if (paths.length >= 2) { await setFolder('left', paths[0]); await setFolder('right', paths[1]); }
        else await setFolder(side || (S.folder.left ? 'right' : 'left'), paths[0]);
        return;
      }
      // folders dropped on the text view switch to folder mode
      const checks = await Promise.all(paths.slice(0, 2).map((p) => window.td.checkFolder(p)));
      if (checks.some((c) => c.ok)) {
        setTab('folders');
        if (paths.length >= 2) { await setFolder('left', paths[0]); await setFolder('right', paths[1]); }
        else await setFolder(side || 'left', paths[0]);
        return;
      }
      if (paths.length >= 2) { if (S.mode === 'edit') takeEditors(); await openSideQuiet('left', paths[0]); await openSideQuiet('right', paths[1]); compare(); return; }
      if (S.mode === 'edit') takeEditors();
      await openSide(side || (S.side.left.path || S.side.left.text ? 'right' : 'left'), paths[0]);
    });
  }
  async function openSideQuiet(side, p) {
    try { setSide(side, await window.td.loadFile(side, p)); } catch (e) { toast(errText(e), true); }
  }

  // ---- tabs ----------------------------------------------------------------------------------------------------------------------
  function setTab(tab) {
    S.tab = tab;
    $('tabText').setAttribute('aria-selected', String(tab === 'text'));
    $('tabFolders').setAttribute('aria-selected', String(tab === 'folders'));
    $('textMode').hidden = tab !== 'text';
    $('folderMode').hidden = tab !== 'folders';
    banner('');
    if (tab === 'text') scheduleRender(); else scheduleFolderRender();
  }

  // ======================================= folders =======================================================================
  const F = S.folder;
  const FRH = 28;
  async function setFolder(side, p) {
    if (!p) return;
    const c = await window.td.checkFolder(p);
    if (!c.ok) { toast(`"${p.split(/[\\/]/).pop()}" is not a folder`, true); return; }
    F[side] = p;
    paintFolders();
  }
  function paintFolders() {
    for (const [side, k] of [['left', 'L'], ['right', 'R']]) {
      const p = F[side];
      $('fpath' + k).textContent = p || 'Drop a folder here or choose one';
      $('fpath' + k).title = p || '';
      $('fside' + k).classList.toggle('set', !!p);
    }
    $('fcompare').disabled = !(F.left && F.right) || F.busy;
  }
  function wireFolders() {
    $('tabText').addEventListener('click', () => setTab('text'));
    $('tabFolders').addEventListener('click', () => setTab('folders'));
    $('fpickL').addEventListener('click', async () => setFolder('left', await window.td.pickFolder('left')));
    $('fpickR').addEventListener('click', async () => setFolder('right', await window.td.pickFolder('right')));
    $('fswap').addEventListener('click', () => { [F.left, F.right] = [F.right, F.left]; paintFolders(); if (F.result) compareFolders(); });
    const segs = document.querySelectorAll('#folderMode .seg .mode');
    const paint = () => segs.forEach((b) => b.setAttribute('aria-checked', String(b.dataset.fmode === S.opts.fmode)));
    segs.forEach((b) => b.addEventListener('click', () => { S.opts.fmode = b.dataset.fmode; saveOpts(); paint(); }));
    paint();
    $('ignore').value = S.opts.ignore;
    $('ignore').addEventListener('change', () => { S.opts.ignore = $('ignore').value; saveOpts(); });
    $('ignore').addEventListener('keydown', (e) => { if (e.key === 'Enter') { S.opts.ignore = $('ignore').value; saveOpts(); compareFolders(); } });
    $('fcompare').addEventListener('click', () => compareFolders());
    $('fcancel').addEventListener('click', () => window.td.cancelFolders());
    for (const c of document.querySelectorAll('#filters input[data-f]')) {
      c.checked = !!F.filters[c.dataset.f];
      c.addEventListener('change', () => { F.filters[c.dataset.f] = c.checked; rebuildVisible(); });
    }
    $('expandAll').addEventListener('click', () => { F.collapsed.clear(); rebuildVisible(); });
    $('collapseAll').addEventListener('click', () => { if (F.result) for (const e of F.result.entries) if (e.type === 'dir') F.collapsed.add(e.rel); rebuildVisible(); });
    $('fscroll').addEventListener('scroll', scheduleFolderRender, { passive: true });
    window.addEventListener('resize', scheduleFolderRender);
    $('frows').addEventListener('click', onFolderRowClick);
    $('fselAll').addEventListener('change', () => {
      if ($('fselAll').checked) for (const i of F.visible) F.selected.add(F.result.entries[i].rel);
      else F.selected.clear();
      folderSelectionChanged();
    });
    $('fopen').addEventListener('click', () => { const one = selectedFiles(); if (one.length) openPair(one[0]); });
    $('copyLR').addEventListener('click', () => copyFiles('ltr'));
    $('copyRL').addEventListener('click', () => copyFiles('rtl'));
    $('fscroll').addEventListener('keydown', (e) => {
      if (!F.visible.length) return;
      const cur = F.anchor == null ? -1 : F.visible.findIndex((i) => F.result.entries[i].rel === F.anchor);
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const n = Math.max(0, Math.min(F.visible.length - 1, cur + (e.key === 'ArrowDown' ? 1 : -1)));
        const rel = F.result.entries[F.visible[n]].rel;
        if (!e.shiftKey) F.selected.clear();
        F.selected.add(rel); F.anchor = rel; ensureVisible(n); folderSelectionChanged();
      } else if (e.key === 'Enter' && cur >= 0) {
        const en = F.result.entries[F.visible[cur]];
        if (en.type === 'dir') toggleDir(en.rel); else openPair(en.rel);
      } else if ((e.key === 'ArrowRight' || e.key === 'ArrowLeft') && cur >= 0) {
        const en = F.result.entries[F.visible[cur]];
        if (en.type === 'dir' && (e.key === 'ArrowLeft') !== F.collapsed.has(en.rel)) toggleDir(en.rel);
      }
    });
    window.td.onFolderProgress((p) => { if (F.busy) $('fstatus').textContent = p.toHash ? `Comparing contents: ${p.hashed.toLocaleString('en')} of ${p.toHash.toLocaleString('en')} files…` : `Looking through folders: ${p.seen.toLocaleString('en')} items…`; });
    window.td.onCopyProgress((p) => { $('fstatus').textContent = `Copying ${p.done} of ${p.total}…`; });
  }
  function ensureVisible(n) {
    const sc = $('fscroll');
    if (n * FRH < sc.scrollTop) sc.scrollTop = n * FRH;
    else if ((n + 1) * FRH > sc.scrollTop + sc.clientHeight) sc.scrollTop = (n + 1) * FRH - sc.clientHeight;
  }

  async function compareFolders() {
    if (!F.left || !F.right) { toast('Choose a folder on each side first', true); return; }
    S.opts.ignore = $('ignore').value; saveOpts();
    const ignore = S.opts.ignore.split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
    F.busy = true; paintFolders();
    $('fcancel').hidden = false; $('fprog').hidden = false; banner('');
    $('fstatus').textContent = 'Looking through folders…';
    try {
      const r = await window.td.compareFolders({ left: F.left, right: F.right, mode: S.opts.fmode, ignore });
      if (r && r.cancelled) { $('fstatus').textContent = 'Cancelled.'; return; }
      const keepSel = new Set([...F.selected].filter((rel) => r.entries.some((e) => e.rel === rel)));
      F.result = r; F.selected = keepSel;
      // folders that are the same start folded
      if (!F.everCompared) { F.collapsed.clear(); F.everCompared = true; }
      for (const e of r.entries) if (e.type === 'dir' && e.status === 'same') F.collapsed.add(e.rel);
      paintCounts();
      rebuildVisible();
      const c = r.counts; const total = c.same + c.different + c.left + c.right + c.error;
      $('fstatus').textContent = total
        ? `${plural(total, 'file')} · ${c.different} different · ${c.left} only left · ${c.right} only right · ${c.same} same${c.error ? ` · ${c.error} with problems` : ''}${r.mode === 'quick' ? ' (by size and date)' : ' (by contents)'}`
        : 'Both folders are empty (or everything is ignored).';
    } catch (e) { banner(errText(e)); $('fstatus').textContent = ''; }
    finally { F.busy = false; paintFolders(); $('fcancel').hidden = true; $('fprog').hidden = true; }
  }
  function paintCounts() {
    const c = F.result.counts;
    $('cDifferent').textContent = c.different; $('cLeft').textContent = c.left; $('cRight').textContent = c.right; $('cSame').textContent = c.same; $('cError').textContent = c.error;
    $('filters').hidden = false; $('ftable').hidden = false; $('fempty').hidden = true;
  }
  /** Which entries are listed: those whose status is ticked, the folders on the way to them, minus folded folders. */
  function rebuildVisible() {
    if (!F.result) return;
    const ents = F.result.entries;
    const show = new Uint8Array(ents.length);
    const childShown = new Set();
    for (let i = ents.length - 1; i >= 0; i--) {
      const e = ents[i];
      const own = e.type === 'file' ? !!F.filters[e.status] : (!!F.filters[e.status] || childShown.has(e.rel));
      if (own) {
        show[i] = 1;
        const parent = e.rel.includes('/') ? e.rel.slice(0, e.rel.lastIndexOf('/')) : '';
        childShown.add(parent);
      }
    }
    const vis = [];
    let hideUnder = null;
    for (let i = 0; i < ents.length; i++) {
      const e = ents[i];
      if (hideUnder && e.rel.startsWith(hideUnder)) continue;
      hideUnder = null;
      if (!show[i]) { if (e.type === 'dir') hideUnder = e.rel + '/'; continue; }
      vis.push(i);
      if (e.type === 'dir' && F.collapsed.has(e.rel)) hideUnder = e.rel + '/';
    }
    F.visible = vis;
    $('fscroll').querySelector('.spacer').style.height = vis.length * FRH + 'px';
    folderSelectionChanged();
  }
  function toggleDir(rel) { if (F.collapsed.has(rel)) F.collapsed.delete(rel); else F.collapsed.add(rel); rebuildVisible(); }
  const fmtDate = (ms) => { const d = new Date(ms); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`; };
  const STATUS_WORD = { same: 'same', different: 'different', left: 'only left', right: 'only right', error: 'problem', pending: '…' };
  function metaOf(e, side) {
    const m = e[side];
    if (!m) return '—';
    if (e.type === 'dir') return 'folder';
    return `${sizeText(m.size)} · ${fmtDate(m.mtimeMs)}`;
  }
  let fRaf = false;
  const scheduleFolderRender = () => { if (fRaf) return; fRaf = true; requestAnimationFrame(() => { fRaf = false; renderFolders(); }); };
  function renderFolders() {
    if (!F.result || S.tab !== 'folders') return;
    const sc = $('fscroll');
    const first = Math.max(0, Math.floor(sc.scrollTop / FRH) - 6);
    const last = Math.min(F.visible.length, Math.ceil((sc.scrollTop + sc.clientHeight) / FRH) + 6);
    let html = '';
    for (let n = first; n < last; n++) {
      const i = F.visible[n]; const e = F.result.entries[i];
      const sel = F.selected.has(e.rel);
      const dir = e.type === 'dir';
      const tw = dir ? `<button class="twisty" data-t="1" aria-label="${F.collapsed.has(e.rel) ? 'Open' : 'Fold'} ${esc(e.name)}">${F.collapsed.has(e.rel) ? '▸' : '▾'}</button>` : '<span class="twisty"></span>';
      const note = e.note ? ` title="${esc(e.note)}"` : '';
      html += `<div class="frow${sel ? ' sel' : ''}${dir ? ' dir' : ''}${e.left ? '' : ' absent-l'}${e.right ? '' : ' absent-r'}" data-i="${i}" role="row" aria-selected="${sel}">` +
        `<span><input type="checkbox" ${sel ? 'checked' : ''} aria-label="Select ${esc(e.name)}"></span>` +
        `<span class="fname2" data-d="${e.depth}">${tw}<span class="ficon">${dir ? '▣' : '▢'}</span><span class="nm trunc" title="${esc(e.rel)}">${esc(e.name)}</span></span>` +
        `<span class="meta c-l">${esc(metaOf(e, 'left'))}</span>` +
        `<span><span class="st ${e.status}"${note}>${STATUS_WORD[e.status] || e.status}</span></span>` +
        `<span class="meta c-r">${esc(metaOf(e, 'right'))}</span></div>`;
    }
    const rows = $('frows');
    rows.style.transform = `translateY(${first * FRH}px)`;
    rows.innerHTML = html;
    for (const n of rows.querySelectorAll('.fname2')) n.style.paddingLeft = 8 + n.dataset.d * 16 + 'px';
  }
  function onFolderRowClick(e) {
    const row = e.target.closest('.frow'); if (!row) return;
    const en = F.result.entries[+row.dataset.i];
    if (e.target.closest('.twisty[data-t]')) { toggleDir(en.rel); return; }
    if (e.detail === 2 && !e.target.matches('input')) { if (en.type === 'dir') toggleDir(en.rel); else openPair(en.rel); return; }
    if (e.target.matches('input[type=checkbox]')) {
      if (e.target.checked) F.selected.add(en.rel); else F.selected.delete(en.rel);
      F.anchor = en.rel;
    } else if (e.shiftKey && F.anchor) {
      const a = F.visible.findIndex((i) => F.result.entries[i].rel === F.anchor); const b = F.visible.indexOf(+row.dataset.i);
      if (a >= 0 && b >= 0) for (let n = Math.min(a, b); n <= Math.max(a, b); n++) F.selected.add(F.result.entries[F.visible[n]].rel);
    } else if (e.ctrlKey || e.metaKey) {
      if (F.selected.has(en.rel)) F.selected.delete(en.rel); else F.selected.add(en.rel);
      F.anchor = en.rel;
    } else { F.selected.clear(); F.selected.add(en.rel); F.anchor = en.rel; }
    folderSelectionChanged();
    $('fscroll').focus({ preventScroll: true });
  }
  const selectedFiles = () => (F.result ? F.result.entries.filter((e) => e.type === 'file' && F.selected.has(e.rel)).map((e) => e.rel) : []);
  function folderSelectionChanged() {
    const n = F.selected.size;
    const files = F.result ? F.result.entries.filter((e) => F.selected.has(e.rel)) : [];
    $('fsel').textContent = n ? `${plural(n, 'item')} selected` : '';
    const one = files.length === 1 && files[0].type === 'file' && files[0].left && files[0].right;
    $('fopen').disabled = !one;
    $('copyLR').disabled = !files.some((e) => e.left && e.status !== 'same' && e.status !== 'error');
    $('copyRL').disabled = !files.some((e) => e.right && e.status !== 'same' && e.status !== 'error');
    $('fselAll').checked = !!F.visible.length && F.visible.every((i) => F.selected.has(F.result.entries[i].rel));
    renderFolders();
  }
  async function openPair(rel) {
    try {
      const r = await window.td.openPair(rel);
      setSide('left', r.left || null); setSide('right', r.right || null);
      setTab('text');
      compare();
    } catch (e) { toast(errText(e), true); }
  }
  async function copyFiles(dir) {
    const rels = [...F.selected];
    if (!rels.length) return;
    try {
      const r = await window.td.copyFiles({ rels, dir });
      if (!r || r.cancelled) return;
      if (r.nothing) { toast('Nothing to copy: the selected files are already the same'); return; }
      const msg = `Copied ${plural(r.done.length, 'file')} to the ${dir === 'ltr' ? 'right' : 'left'}.` + (r.failed.length ? ` ${r.failed.length} could not be copied: ${r.failed.slice(0, 3).map((f) => `${f.rel} (${f.error})`).join('; ')}` : '');
      toast(msg, r.failed.length > 0);
      await compareFolders();
      $('fstatus').textContent = msg + ' ' + $('fstatus').textContent;
    } catch (e) { banner(errText(e)); }
  }

  // ---- start ------------------------------------------------------------------------------------------------------------------
  function init() {
    wireOptions(); wireText(); wireScroll(); wireDrop(); wireFolders();
    setSide('left', null); setSide('right', null);
    setMode('edit');
    paintFolders();
    window.td.onOpened((r) => {
      if (r.error) toast(r.error, true);
      if (r.folders) { setTab('folders'); setFolder('left', r.folders[0]); if (r.folders[1]) setFolder('right', r.folders[1]); return; }
      if (r.left) setSide('left', r.left);
      if (r.right) setSide('right', r.right);
      if (r.left && r.right) compare(); else fillEditors();
    });
  }
  window.__app = { S, T, compare, goTo, step, choose, setSide, setTab, setFolder, compareFolders, rebuildVisible, openPair, render, layoutViews };
  init();
})();
