'use strict';
(() => {
  const M = window.Music;
  const $ = (id) => document.getElementById(id);
  const el = (tag, attrs, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) { if (v === false || v == null) continue; if (k === 'class') n.className = v; else n.setAttribute(k, v === true ? '' : v); }
    for (const kid of kids) if (kid != null) n.append(kid);
    return n;
  };

  const OPTS_KEY = 'bpmkey.options';
  const loadOpts = () => {
    const d = { bpm: true, key: true, style: 'musical', replace: false };
    try { return { ...d, ...JSON.parse(localStorage.getItem(OPTS_KEY) || '{}') }; } catch { return d; }
  };
  const saveOpts = () => { try { localStorage.setItem(OPTS_KEY, JSON.stringify(S.opts)); } catch { /* private mode: fine */ } };

  const S = { rows: [], byId: new Map(), pending: new Set(), runTotal: 0, runDone: 0, sort: { by: null, dir: 1 }, opts: loadOpts(), writing: false };

  const keyValue = (k) => (k ? `${k.tonic}${k.mode === 'minor' ? 'm' : 'M'}` : '');
  const keyFromValue = (v) => (v ? { tonic: parseInt(v, 10), mode: v.endsWith('m') ? 'minor' : 'major' } : null);
  const keyLabel = (k) => `${M.keyName(k)} · ${M.keyName(k, 'camelot')}`;

  // ---- messages --------------------------------------------------------------------------------------------------------
  let toastTimer = null;
  function toast(text, err = false) {
    const t = $('toast');
    t.textContent = text; t.className = 'toast' + (err ? ' err' : ''); t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 4200);
  }
  function banner(text) { const b = $('banner'); b.textContent = text || ''; b.hidden = !text; }
  function showResult(text, kind) { const r = $('result'); r.textContent = text || ''; r.className = 'result' + (kind ? ' ' + kind : ''); r.hidden = !text; }

  // ---- rows ------------------------------------------------------------------------------------------------------------
  function makeRow(info) {
    const r = {
      ...info, status: 'queued', bpm: null, bpmFound: null, bpmConfidence: 0, key: null, keyFound: null, keyConfidence: 0,
      alternatives: [], tuningCents: 0, selected: false, note: '', noteKind: '', error: '',
    };
    const chk = el('input', { type: 'checkbox', 'aria-label': `Select ${info.name}` });
    const title = el('div', { class: 't trunc' });
    const artist = el('div', { class: 'a trunc' });
    const note = el('div', { class: 'note-row' });
    const time = el('td', { class: 'time' });
    const bpmInput = el('input', { type: 'number', class: 'bpm', min: String(M.MIN_BPM), max: String(M.MAX_BPM), step: '0.1', 'aria-label': `BPM of ${info.name}` });
    const half = el('button', { class: 'mini', type: 'button', 'aria-label': `Halve the BPM of ${info.name}`, title: 'Half speed' }, '÷2');
    const dbl = el('button', { class: 'mini', type: 'button', 'aria-label': `Double the BPM of ${info.name}`, title: 'Double speed' }, '×2');
    const bpmSub = el('div', { class: 'sub' });
    const keySel = el('select', { class: 'key', 'aria-label': `Key of ${info.name}` });
    const keySub = el('div', { class: 'sub' });
    const sure = el('div');
    r.ui = { chk, title, artist, note, time, bpmInput, half, dbl, bpmSub, keySel, keySub, sure };
    r.tr = el('tr', { 'data-id': String(info.id) },
      el('td', { class: 'c-sel' }, chk),
      el('td', { class: 'c-song' }, el('div', { class: 'song' }, title, artist, note)),
      time,
      el('td', { class: 'c-bpm' }, el('div', { class: 'cell' }, el('div', { class: 'line' }, bpmInput, half, dbl), bpmSub)),
      el('td', { class: 'c-key' }, el('div', { class: 'cell' }, keySel, keySub)),
      el('td', { class: 'c-sure' }, sure));

    chk.addEventListener('change', () => { r.selected = chk.checked; paintSelection(r); updateBar(); });
    bpmInput.addEventListener('change', () => {
      const v = parseFloat(bpmInput.value);
      if (!isFinite(v) || v < M.MIN_BPM || v > M.MAX_BPM) { bpmInput.value = M.bpmLabel(r.bpm); toast(`BPM must be between ${M.MIN_BPM} and ${M.MAX_BPM}`, true); return; }
      setBpm(r, v);
    });
    half.addEventListener('click', () => { if (r.bpm != null) setBpm(r, M.halve(r.bpm)); });
    dbl.addEventListener('click', () => { if (r.bpm != null) setBpm(r, M.double(r.bpm)); });
    const fill = () => ensureKeyOptions(r);
    keySel.addEventListener('mousedown', fill); keySel.addEventListener('focus', fill); keySel.addEventListener('keydown', fill);
    keySel.addEventListener('change', () => { r.key = keyFromValue(keySel.value); paint(r); updateBar(); });
    paint(r);
    return r;
  }

  function ensureKeyOptions(r) {
    const sel = r.ui.keySel;
    if (sel.dataset.full) return;
    sel.dataset.full = '1';
    sel.textContent = '';
    sel.append(el('option', { value: '' }, '—'));
    for (const k of M.KEYS_BY_WHEEL) sel.append(el('option', { value: keyValue(k) }, keyLabel(k)));
    sel.value = keyValue(r.key);
  }

  function setBpm(r, v) {
    r.bpm = Math.round(M.clampBpm(v) * 100) / 100;
    paint(r); updateBar();
  }
  function setKey(r, key) { r.key = key; ensureKeyOptions(r); paint(r); updateBar(); }

  function paintSelection(r) { r.tr.classList.toggle('sel', r.selected); r.ui.chk.checked = r.selected; }

  function paint(r) {
    const u = r.ui;
    u.title.textContent = r.title || r.name;
    u.title.title = r.name;
    u.artist.textContent = [r.artist, r.folder].filter(Boolean).join(' · ') + (r.ext ? `  ·  ${r.ext.toUpperCase()}` : '');
    u.time.textContent = r.durationMs ? M.formatTime(r.durationMs / 1000) : '';
    const done = r.status === 'done';
    r.tr.classList.toggle('failed', r.status === 'error');
    u.bpmInput.disabled = !done; u.half.disabled = !done || r.bpm == null; u.dbl.disabled = !done || r.bpm == null;
    u.keySel.disabled = !done;
    u.chk.disabled = !done;
    u.note.textContent = r.note || (r.status === 'error' ? r.error : '') || (!r.canWrite && done ? 'This kind of file cannot hold tags (the result can still be exported)' : '');
    u.note.className = 'note-row' + (r.noteKind ? ' ' + r.noteKind : r.status === 'error' ? ' err' : '');
    if (!done) {
      u.bpmInput.value = '';
      u.bpmInput.placeholder = r.status === 'queued' ? 'waiting…' : r.status === 'cancelled' ? 'cancelled' : r.status === 'error' ? 'failed' : '';
      u.bpmSub.textContent = r.tagBpm ? `in tag: ${r.tagBpm}` : '';
      if (u.keySel.dataset.full !== '1') u.keySel.textContent = '';
      u.keySub.textContent = r.tagKey ? `in tag: ${r.tagKey}` : '';
      u.sure.textContent = '';
      return;
    }
    if (document.activeElement !== u.bpmInput) u.bpmInput.value = r.bpm == null ? '' : M.bpmLabel(r.bpm);
    u.bpmInput.placeholder = '';
    const edited = r.bpm != null && r.bpmFound != null && M.bpmLabel(r.bpm) !== M.bpmLabel(r.bpmFound);
    u.bpmSub.textContent = [r.tagBpm ? `in tag: ${r.tagBpm}` : '', edited ? `found ${M.bpmLabel(r.bpmFound)}` : ''].filter(Boolean).join(' · ');
    if (u.keySel.dataset.full !== '1') {
      u.keySel.textContent = '';
      u.keySel.append(el('option', { value: keyValue(r.key) }, r.key ? keyLabel(r.key) : '—'));
    }
    u.keySel.value = keyValue(r.key);
    const tagKey = M.parseKey(r.tagKey);
    const keyEdited = !M.sameKey(r.key, r.keyFound);
    u.keySub.textContent = [r.tagKey ? `in tag: ${r.tagKey}${tagKey && r.key && !M.sameKey(tagKey, r.key) ? ' (differs)' : ''}` : '', keyEdited && r.keyFound ? `found ${M.keyName(r.keyFound)}` : ''].filter(Boolean).join(' · ');
    u.keySel.title = r.alternatives.length ? `Other likely keys: ${r.alternatives.map((k) => M.keyName(k)).join(', ')}` : '';
    u.sure.textContent = '';
    if (r.bpmFound != null) { const w = M.tempoSureness(r.bpmConfidence); u.sure.append(el('span', { class: 'sure ' + w, title: 'How steady and clear the beat is' }, `BPM ${w}`)); }
    if (r.keyFound) { const w = M.keySureness(r.keyConfidence); u.sure.append(el('span', { class: 'sure ' + w, title: r.tuningCents ? `Tuned ${r.tuningCents > 0 ? '+' : ''}${r.tuningCents} cents from A = 440 Hz` : 'How clearly one key stands out' }, `Key ${w}`)); }
  }

  function applyResult(r, res) {
    r.status = 'done';
    r.bpmFound = res.bpm; r.bpm = res.bpm; r.bpmConfidence = res.bpmConfidence;
    r.keyFound = res.key ? { tonic: res.key.tonic, mode: res.key.mode } : null; r.key = r.keyFound ? { ...r.keyFound } : null;
    r.keyConfidence = res.keyConfidence; r.alternatives = res.keyAlternatives || []; r.tuningCents = res.tuningCents || 0;
    if (!r.durationMs && res.seconds) r.durationMs = Math.round(res.seconds * 1000);
    // tick the ones worth writing; leave the doubtful ones for the user to look at
    const worth = (M.tempoSureness(r.bpmConfidence) !== 'unsure' && r.bpm != null) || (M.keySureness(r.keyConfidence) !== 'unsure' && r.key);
    r.selected = !!worth && r.canWrite;
    paintSelection(r);
    paint(r);
  }

  // ---- list ------------------------------------------------------------------------------------------------------------
  function showList() {
    const any = S.rows.length > 0;
    $('empty').hidden = any; $('list').hidden = !any; $('writebar').hidden = !any; $('clear').hidden = !any;
  }

  function addRows(res) {
    if (res.capped) banner('The list holds up to 5000 songs, so some were not added.');
    if (!res.rows.length) { if (res.ignored) toast('No songs found in that selection', true); return; }
    const frag = document.createDocumentFragment();
    for (const info of res.rows) { const r = makeRow(info); S.rows.push(r); S.byId.set(r.id, r); frag.append(r.tr); }
    $('rows').append(frag);
    if (S.sort.by) applySort();
    showList(); updateBar();
    startAnalysis(res.rows.map((x) => x.id));
  }

  async function startAnalysis(ids) {
    const fresh = ids.filter((id) => !S.pending.has(id));
    if (!fresh.length) return;
    if (!S.pending.size) { S.runTotal = 0; S.runDone = 0; }
    for (const id of fresh) { S.pending.add(id); const r = S.byId.get(id); if (r) { r.status = 'queued'; r.error = ''; paint(r); } }
    S.runTotal += fresh.length;
    updateStatus();
    try { await window.bk.analyse(fresh); } catch (e) { banner('Analysis failed: ' + ((e && e.message) || e)); }
    for (const id of fresh) S.pending.delete(id);
    updateStatus(); updateBar();
  }

  function onRow(ev) {
    const r = S.byId.get(ev.id);
    S.pending.delete(ev.id);
    S.runDone++;
    if (r) {
      if (ev.status === 'done') applyResult(r, ev.result);
      else { r.status = ev.status; r.error = ev.error || ''; paint(r); }
    }
    updateStatus(); updateBar();
  }

  function updateStatus() {
    const running = S.pending.size > 0;
    const analysed = S.rows.filter((r) => r.status === 'done').length;
    const rest = S.rows.filter((r) => r.status === 'cancelled').length;
    $('prog').hidden = !running;
    $('cancel').hidden = !running;
    $('analyseRest').hidden = running || rest === 0;
    if (running) {
      const pct = S.runTotal ? Math.round((S.runDone / S.runTotal) * 100) : 0;
      $('status').textContent = `Analysing… ${S.runDone} of ${S.runTotal} songs`;
      $('fill').style.width = pct + '%';
      $('prog').setAttribute('aria-valuenow', String(pct));
    } else {
      const bad = S.rows.filter((r) => r.status === 'error').length;
      $('status').textContent = S.rows.length ? `${S.rows.length} song${S.rows.length === 1 ? '' : 's'} · ${analysed} analysed${bad ? ` · ${bad} could not be read` : ''}` : '';
    }
  }

  // ---- selection and the write bar -------------------------------------------------------------------------------------------
  const selectable = () => S.rows.filter((r) => r.status === 'done' && r.canWrite);
  const chosen = () => S.rows.filter((r) => r.selected && r.status === 'done' && r.canWrite);

  function updateBar() {
    const sel = chosen();
    const all = selectable();
    const sa = $('selAll');
    sa.checked = all.length > 0 && sel.length === all.length;
    sa.indeterminate = sel.length > 0 && sel.length < all.length;
    sa.disabled = all.length === 0;
    $('selInfo').textContent = sel.length ? `${sel.length} selected` : '';
    const w = $('write');
    w.textContent = sel.length ? `Write to ${sel.length} song${sel.length === 1 ? '' : 's'}` : 'Write to tags';
    w.disabled = S.writing || sel.length === 0 || (!S.opts.bpm && !S.opts.key);
    $('remove').disabled = !S.rows.some((r) => r.selected) || S.writing;
    $('csv').disabled = !S.rows.some((r) => r.status === 'done');
  }

  function wireBar() {
    $('wBpm').checked = S.opts.bpm; $('wKey').checked = S.opts.key; $('replace').checked = S.opts.replace;
    const style = $('style');
    for (const [k, v] of Object.entries(M.STYLES)) style.append(el('option', { value: k }, v.label));
    style.value = S.opts.style;
    $('wBpm').addEventListener('change', (e) => { S.opts.bpm = e.target.checked; saveOpts(); updateBar(); });
    $('wKey').addEventListener('change', (e) => { S.opts.key = e.target.checked; saveOpts(); updateBar(); });
    $('replace').addEventListener('change', (e) => { S.opts.replace = e.target.checked; saveOpts(); });
    style.addEventListener('change', (e) => { S.opts.style = e.target.value; saveOpts(); });
    $('selAll').addEventListener('change', (e) => { for (const r of selectable()) { r.selected = e.target.checked; paintSelection(r); } updateBar(); });
    $('write').addEventListener('click', writeTags);
    $('csv').addEventListener('click', exportCsv);
    $('remove').addEventListener('click', removeSelected);
    $('clear').addEventListener('click', clearAll);
    $('cancel').addEventListener('click', () => window.bk.cancel());
    $('analyseRest').addEventListener('click', () => startAnalysis(S.rows.filter((r) => r.status === 'cancelled').map((r) => r.id)));
  }

  async function writeTags() {
    if (S.writing) return;
    const items = [];
    const left = { already: 0, same: 0, nothing: 0 };
    for (const r of chosen()) {
      const plan = M.planWrite({ tagBpm: r.tagBpm, tagKey: r.tagKey, bpm: r.bpm, key: r.key }, S.opts);
      if (plan.bpm == null && plan.key == null) {
        if (plan.skipped.some((s) => /already has/.test(s))) left.already++;
        else if (plan.skipped.some((s) => /same/.test(s))) left.same++;
        else left.nothing++;
        r.note = plan.skipped.join('; '); r.noteKind = '';
        paint(r);
        continue;
      }
      r.note = ''; r.noteKind = '';
      items.push({ id: r.id, bpm: plan.bpm, key: plan.key });
    }
    const leftText = [left.already && `${left.already} already had values (tick "Replace" to overwrite them)`, left.same && `${left.same} already had the same values`, left.nothing && `${left.nothing} had nothing to write`].filter(Boolean).join('; ');
    if (!items.length) { showResult(`Nothing to write. ${leftText}`, ''); return; }
    S.writing = true; updateBar();
    showResult(`Writing 0 of ${items.length}…`, '');
    let results = [];
    try { results = await window.bk.write(items); } catch (e) { showResult('Writing failed: ' + ((e && e.message) || e), 'err'); S.writing = false; updateBar(); return; }
    S.writing = false;
    let ok = 0; const failed = [];
    for (const res of results) {
      const r = S.byId.get(res.id);
      if (!r) continue;
      if (res.ok) { ok++; r.tagBpm = res.tagBpm; r.tagKey = res.tagKey; r.note = 'Written to the tags'; r.noteKind = 'ok'; }
      else { failed.push(`${r.name}: ${res.error}`); r.note = res.error; r.noteKind = 'err'; }
      paint(r);
    }
    updateBar();
    const text = `Wrote ${ok} song${ok === 1 ? '' : 's'}.${leftText ? ' Left alone: ' + leftText + '.' : ''}${failed.length ? ` ${failed.length} failed (each file was left unchanged): ${failed.slice(0, 2).join(' | ')}${failed.length > 2 ? ' …' : ''}` : ''}`;
    showResult(text, failed.length ? 'err' : 'ok');
  }

  async function exportCsv() {
    const rows = sortedRows().filter((r) => r.status === 'done');
    if (!rows.length) return;
    try {
      const r = await window.bk.saveCsv(M.toCsv(rows));
      if (r.ok) toast('Saved the results as a CSV file');
    } catch (e) { toast('Could not save: ' + ((e && e.message) || e), true); }
  }

  async function removeSelected() {
    const gone = S.rows.filter((r) => r.selected && !S.pending.has(r.id));
    if (!gone.length) return;
    await window.bk.remove(gone.map((r) => r.id));
    for (const r of gone) { r.tr.remove(); S.byId.delete(r.id); }
    S.rows = S.rows.filter((r) => S.byId.has(r.id));
    showList(); updateStatus(); updateBar();
  }

  async function clearAll() {
    await window.bk.clear();
    for (const r of S.rows) r.tr.remove();
    S.rows = []; S.byId.clear(); S.pending.clear(); S.runTotal = 0; S.runDone = 0;
    showResult('', ''); banner('');
    showList(); updateStatus(); updateBar();
  }

  // ---- sorting ----------------------------------------------------------------------------------------------------------------
  const wheelIndex = (k) => (k ? M.KEYS_BY_WHEEL.findIndex((x) => M.sameKey(x, k)) : 99);
  const SORTERS = {
    name: (a, b) => (a.title || a.name).localeCompare(b.title || b.name, undefined, { numeric: true, sensitivity: 'base' }),
    time: (a, b) => (a.durationMs || 0) - (b.durationMs || 0),
    bpm: (a, b) => (a.bpm || 0) - (b.bpm || 0),
    key: (a, b) => wheelIndex(a.key) - wheelIndex(b.key),
  };
  function sortedRows() {
    if (!S.sort.by) return S.rows.slice();
    const missing = (r) => (S.sort.by === 'bpm' ? r.bpm == null : S.sort.by === 'key' ? !r.key : false); // songs with no answer stay at the bottom either way
    return S.rows.slice().sort((a, b) => (missing(a) - missing(b)) || SORTERS[S.sort.by](a, b) * S.sort.dir || a.id - b.id);
  }
  function applySort() {
    const frag = document.createDocumentFragment();
    for (const r of sortedRows()) frag.append(r.tr);
    $('rows').append(frag);
    for (const th of document.querySelectorAll('#grid thead th')) {
      const b = th.querySelector('.sort');
      if (b) th.setAttribute('aria-sort', b.dataset.sort === S.sort.by ? (S.sort.dir > 0 ? 'ascending' : 'descending') : 'none');
    }
  }
  function wireSort() {
    for (const b of document.querySelectorAll('button.sort')) {
      b.addEventListener('click', () => {
        S.sort = S.sort.by === b.dataset.sort ? { by: b.dataset.sort, dir: -S.sort.dir } : { by: b.dataset.sort, dir: 1 };
        applySort();
      });
    }
  }

  // ---- adding -------------------------------------------------------------------------------------------------------------------
  async function pick(fn) { try { addRows(await fn()); } catch (e) { banner((e && e.message) || String(e)); } }
  function wireAdd() {
    for (const id of ['addFiles', 'addFiles2']) $(id).addEventListener('click', () => pick(() => window.bk.pickFiles()));
    for (const id of ['addFolder', 'addFolder2']) $(id).addEventListener('click', () => pick(() => window.bk.pickFolder()));
    $('empty').addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(() => window.bk.pickFiles()); } });
    let depth = 0;
    window.addEventListener('dragenter', (e) => { e.preventDefault(); depth++; document.body.classList.add('dragging'); });
    window.addEventListener('dragleave', () => { depth = Math.max(0, depth - 1); if (!depth) document.body.classList.remove('dragging'); });
    window.addEventListener('dragover', (e) => e.preventDefault());
    window.addEventListener('drop', (e) => {
      e.preventDefault(); depth = 0; document.body.classList.remove('dragging');
      const paths = [...(e.dataTransfer ? e.dataTransfer.files : [])].map((f) => window.bk.pathForFile(f)).filter(Boolean);
      if (paths.length) pick(() => window.bk.addPaths(paths));
    });
  }

  // ---- start ----------------------------------------------------------------------------------------------------------------------
  async function init() {
    wireBar(); wireSort(); wireAdd();
    window.bk.onRow(onRow);
    window.bk.onOpened((res) => addRows(res));
    window.bk.onWriteProgress((p) => { if (S.writing) showResult(`Writing ${p.done} of ${p.total}…`, ''); });
    showList(); updateBar();
    try { const e = await window.bk.engine(); if (!e.ok) { banner(e.problem + '. Analysis will not work.'); } } catch { /* ignore */ }
  }
  window.__app = { S, M, addRows, setBpm, setKey, byName: (n) => S.rows.find((r) => r.name === n), sortedRows, applySort, writeTags, exportCsv, ensureKeyOptions };
  init();
})();
