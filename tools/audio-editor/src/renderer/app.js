'use strict';
(function () {
  const P = window.Plan;
  const $ = (id) => document.getElementById(id);
  const A = new Audio();                     // plays the file being edited
  A.preload = 'auto';
  const wave = new window.Wave($('wave'), {
    seek: (t) => seek(t),
    select: (sel) => { S.sel = sel ? [sel[0], sel[1]] : null; syncSelection(); refresh(false); },
    view: (w) => syncScroll(w),
  });

  const S = {
    items: [], cur: -1, sel: null, head: 0,
    history: [], future: [],
    busy: null,            // 'export' | 'preview' | null
    playing: false, playUntil: null, playSelStart: null, timer: null,
    nextUid: 1, previewKey: '', encodersOk: true,
  };
  const cur = () => S.items[S.cur] || null;

  // ---- small helpers ---------------------------------------------------------------------------------------------------
  let toastTimer = null;
  function toast(message, isErr) {
    const t = $('toast');
    t.textContent = message; t.className = 'toast' + (isErr ? ' err' : ''); t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, isErr ? 7000 : 3500);
  }
  const fmt = (sec, ms = true) => P.formatTime(sec, ms);
  const bytesText = (b) => (b >= 1048576 ? `${(b / 1048576).toFixed(b >= 10485760 ? 0 : 1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

  // ---- options ----------------------------------------------------------------------------------------------------------
  function readOpts() {
    return {
      format: $('format').value,
      bitrate: Number($('bitrate').value) || 0,
      fadeIn: $('fadeIn').value, fadeOut: $('fadeOut').value,
      gain: $('gain').value,
      normalize: $('normalize').value, loudness: Number($('loudness').value),
      trimSilence: $('trimSilence').checked,
      join: $('join').value, joinSeconds: $('joinSeconds').value,
      keepTags: $('keepTags').checked,
      name: $('name').value, outDir: $('outDir').dataset.path || '',
    };
  }

  function fillFormats() {
    const sel = $('format');
    const first = S.items[0];
    const keep = sel.value || 'same';
    sel.textContent = '';
    const sameLabel = first ? `Same as the first file (${P.FORMATS[P.sameFormatFor(first.path)].label.replace(/ \(.*\)$/, '')})` : 'Same as the first file';
    sel.append(new Option(sameLabel, 'same'));
    for (const [k, f] of Object.entries(P.FORMATS)) sel.append(new Option(f.label, k));
    sel.value = [...sel.options].some((o) => o.value === keep) ? keep : 'same';
    fillQuality();
  }

  function fillQuality() {
    const first = S.items[0];
    const f = P.normalizeOptions({ format: $('format').value }, first ? first.path : 'x.mp3');
    const F = P.FORMATS[f.format];
    const sel = $('bitrate');
    const keep = sel.value;
    sel.textContent = '';
    if (F.lossy) for (const b of F.bitrates) sel.append(new Option(`${b} kbps`, String(b)));
    sel.value = [...sel.options].some((o) => o.value === keep) ? keep : String(F.dflt);
    $('qualityRow').hidden = !F.lossy;
    const hint = F.lossy ? 'The sound is encoded again when it is saved. For editing in several steps, save as FLAC or WAV and make the final MP3 last.'
      : 'Lossless: no sound quality is lost when saving.';
    $('formatHint').textContent = hint + (!F.cover && $('keepTags').checked ? ' Cover art cannot be stored in this format.' : '');
  }

  // ---- project state ----------------------------------------------------------------------------------------------------
  function snapshot() {
    S.history.push({ list: S.items.slice(), cuts: S.items.map((i) => i.cuts), cur: S.cur });
    if (S.history.length > 150) S.history.shift();
    S.future = [];
  }
  function current() { return { list: S.items.slice(), cuts: S.items.map((i) => i.cuts), cur: S.cur }; }
  function applySnap(s) {
    stopPlayback();
    S.items = s.list.slice();
    S.items.forEach((it, k) => { it.cuts = s.cuts[k]; });
    S.cur = Math.min(s.cur, S.items.length - 1);
    S.sel = null;
    loadCurrent();
  }
  function undo() { if (S.busy || !S.history.length) return; S.future.push(current()); applySnap(S.history.pop()); }
  function redo() { if (S.busy || !S.future.length) return; S.history.push(current()); applySnap(S.future.pop()); }

  function setCuts(item, cuts) { item.cuts = cuts; }

  function cutSelection() {
    const it = cur();
    if (!it || !S.sel || S.busy) return;
    try {
      const cuts = P.cutOut(it, S.sel[0], S.sel[1]);
      snapshot(); setCuts(it, cuts);
      const at = S.sel[0];
      const len = S.sel[1] - S.sel[0];
      S.sel = null; wave.setSelection(null); syncSelection();
      wave.setCuts(it.cuts); seek(at);
      toast(`Cut out ${len < 10 ? len.toFixed(2) : len.toFixed(1)} s. Undo with Ctrl+Z.`);
      refresh();
    } catch (e) { toast(e.message, true); }
  }
  function keepSelection() {
    const it = cur();
    if (!it || !S.sel || S.busy) return;
    try {
      const cuts = P.keepOnly(it, S.sel[0], S.sel[1]);
      snapshot(); setCuts(it, cuts);
      S.sel = null; wave.setSelection(null); syncSelection();
      wave.setCuts(it.cuts); seek(P.keptRanges(it.cuts, it.duration)[0][0]);
      refresh();
    } catch (e) { toast(e.message, true); }
  }
  function restoreCut(index) {
    const it = cur();
    if (!it || S.busy) return;
    snapshot(); setCuts(it, it.cuts.filter((_, k) => k !== index));
    wave.setCuts(it.cuts); refresh();
  }
  function restoreAll() {
    const it = cur();
    if (!it || S.busy || !it.cuts.length) return;
    snapshot(); setCuts(it, []);
    wave.setCuts(it.cuts); refresh();
  }
  function selectAll() {
    const it = cur();
    if (!it) return;
    S.sel = [0, it.duration]; wave.setSelection(0, it.duration); syncSelection(); refresh(false);
  }

  function moveItem(i, dir) {
    const j = i + dir;
    if (S.busy || j < 0 || j >= S.items.length) return;
    snapshot();
    const [it] = S.items.splice(i, 1);
    S.items.splice(j, 0, it);
    if (S.cur === i) S.cur = j; else if (S.cur === j) S.cur = i;
    fillFormats(); refresh();
  }
  function removeItem(i) {
    if (S.busy) return;
    snapshot();
    S.items.splice(i, 1);
    if (S.cur === i) { stopPlayback(); S.cur = Math.min(i, S.items.length - 1); S.sel = null; loadCurrent(); }
    else if (S.cur > i) S.cur--;
    fillFormats(); refresh();
  }
  function removeAll() {
    if (S.busy || !S.items.length) return;
    snapshot(); stopPlayback();
    S.items = []; S.cur = -1; S.sel = null; loadCurrent(); fillFormats(); refresh();
  }

  // ---- adding files -------------------------------------------------------------------------------------------------------
  function addOpened(list) {
    const good = list.filter((f) => f.ok);
    const bad = list.filter((f) => !f.ok);
    if (bad.length) toast(bad.length === 1 ? `${bad[0].name}: ${bad[0].error}` : `${bad.length} files could not be opened (${bad[0].name}: ${bad[0].error})`, true);
    if (!good.length) return;
    snapshot();
    const wasEmpty = S.items.length === 0;
    for (const f of good) {
      S.items.push({ uid: S.nextUid++, id: f.id, path: f.path, name: f.name, duration: f.duration, rate: f.rate, channels: f.channels, coverStream: f.coverStream, codec: f.codec, kbps: f.kbps, cuts: [], peaks: null, peaksState: 'loading' });
    }
    if (wasEmpty || S.cur < 0) { S.cur = 0; loadCurrent(); }
    fillFormats(); refresh();
    for (const it of S.items.filter((x) => x.peaksState === 'loading' && !x.requested)) loadPeaks(it);
  }
  const loadQueue = [];
  let loading = 0;
  function loadPeaks(it) {
    it.requested = true;
    loadQueue.push(it);
    pump();
  }
  function pump() {
    while (loading < 2 && loadQueue.length) {
      const it = loadQueue.shift();
      loading++;
      window.ae.peaks(it.id).then((r) => {
        if (r) { it.peaks = r.data; it.perSec = r.perSec; it.peaksState = 'ready'; } else it.peaksState = 'error';
      }).catch((e) => { it.peaksState = 'error'; toast(`Could not draw the waveform of ${it.name}: ${e.message || e}`, true); }).finally(() => {
        loading--;
        if (cur() === it) showWave();
        pump();
      });
    }
  }

  async function addFiles() {
    const list = await window.ae.pickFiles();
    if (list.length) addOpened(list);
  }

  // ---- showing the current file -----------------------------------------------------------------------------------------------
  function showWave() {
    const it = cur();
    if (!it) { wave.clear(); return; }
    if (it.peaksState === 'ready') { wave.setData(it.peaks, it.perSec, it.duration); wave.setCuts(it.cuts); wave.setSelection(S.sel ? S.sel[0] : null, S.sel ? S.sel[1] : null); wave.setPlayhead(S.head); }
    else { wave.setData(null, 200, 0); wave.duration = it.duration; wave.setLoading(it.peaksState === 'loading'); }
  }

  function loadCurrent() {
    const it = cur();
    S.head = 0; S.sel = null;
    A.pause(); A.removeAttribute('src'); A.load();
    if (it) {
      A.dataset.tried = '';
      A.src = `aed://f/${it.id}`;
    }
    showWave(); syncSelection(); updateClock(); refresh();
  }

  function selectItem(i, fromKeyboard) {
    if (i === S.cur || i < 0 || i >= S.items.length) return;
    stopPlayback();
    S.cur = i;
    loadCurrent();
    if (!fromKeyboard && document.activeElement && document.activeElement.blur) document.activeElement.blur();
  }

  // ---- playback --------------------------------------------------------------------------------------------------------------
  A.addEventListener('error', async () => {
    const it = cur();
    if (!it || A.dataset.tried === '1' || !A.getAttribute('src')) return;
    A.dataset.tried = '1';
    try { A.src = await window.ae.playable(it.id); A.load(); if (S.head) A.currentTime = S.head; } catch (e) { toast(`This file cannot be played here (${e.message || e}). You can still edit and save it.`, true); }
  });
  A.addEventListener('ended', () => { stopPlayback(); S.head = cur() ? cur().duration : 0; wave.setPlayhead(S.head); updateClock(); });

  function seek(t) {
    const it = cur();
    if (!it) return;
    S.head = Math.max(0, Math.min(it.duration, t));
    try { A.currentTime = S.head; } catch { /* not ready yet: it is set again when playback starts */ }
    wave.setPlayhead(S.head); updateClock();
  }

  function play(from, until) {
    const it = cur();
    if (!it) return;
    let t = from == null ? S.head : from;
    if (t >= it.duration - 0.01) t = 0;
    for (const c of it.cuts) if (t >= c[0] && t < c[1]) { t = c[1]; break; }
    if (t >= it.duration - 0.01) t = 0;
    S.playUntil = until == null ? null : until;
    S.playSelStart = until == null ? null : from;
    try { A.currentTime = t; } catch { /* ignore */ }
    S.head = t;
    const p = A.play();
    if (p && p.catch) p.catch(() => {});
    S.playing = true;
    clearInterval(S.timer);
    S.timer = setInterval(tick, 12);
    refreshTransport();
  }
  function stopPlayback() {
    A.pause();
    S.playing = false; S.playUntil = null; S.playSelStart = null;
    clearInterval(S.timer); S.timer = null;
    refreshTransport();
  }
  function togglePlay() { if (S.playing) { stopPlayback(); S.head = A.currentTime; wave.setPlayhead(S.head); updateClock(); } else play(); }

  function tick() {
    const it = cur();
    if (!it) return;
    let t = A.currentTime;
    // the parts you cut out are skipped, so you hear what the result will sound like
    for (const c of it.cuts) {
      if (t >= c[0] - 0.004 && t < c[1]) {
        if (c[1] >= it.duration - 0.02) { stopPlayback(); S.head = it.duration; wave.setPlayhead(S.head); updateClock(); return; }
        A.currentTime = c[1]; t = c[1];
        break;
      }
    }
    if (S.playUntil != null && t >= S.playUntil) {
      const back = S.playSelStart;
      stopPlayback();
      seek(back == null ? t : back);
      return;
    }
    S.head = t;
    wave.setPlayhead(t);
    if (S.playing) wave.reveal(t);
    updateClock();
  }

  function updateClock() {
    const it = cur();
    $('pos').textContent = fmt(S.head);
    $('len').textContent = fmt(it ? it.duration : 0);
  }
  function refreshTransport() {
    $('play').textContent = S.playing ? '❚❚ Pause' : '▶ Play';
    $('play').disabled = !cur();
    $('playSel').disabled = !cur() || !S.sel || S.sel[1] - S.sel[0] < 0.02;
  }

  // ---- selection ------------------------------------------------------------------------------------------------------------
  function syncSelection() {
    const a = $('selStart'); const b = $('selEnd');
    if (document.activeElement !== a) a.value = S.sel ? fmt(S.sel[0]) : '';
    if (document.activeElement !== b) b.value = S.sel ? fmt(S.sel[1]) : '';
    $('selLen').textContent = S.sel ? fmt(S.sel[1] - S.sel[0]) : '–';
  }
  function selectionFromInputs() {
    const it = cur();
    if (!it) return;
    const ta = P.parseTime($('selStart').value);
    const tb = P.parseTime($('selEnd').value);
    if (Number.isNaN(ta) || Number.isNaN(tb)) { toast('Times look like 90, 1:30 or 1:30.5', true); S.sel = S.sel; syncSelection(); return; }
    if (ta == null && tb == null) { S.sel = null; wave.setSelection(null); syncSelection(); refresh(false); return; }
    let a = ta == null ? 0 : ta;
    let b = tb == null ? it.duration : tb;
    a = Math.max(0, Math.min(it.duration, a)); b = Math.max(0, Math.min(it.duration, b));
    if (a > b) [a, b] = [b, a];
    S.sel = b - a < 0.005 ? null : [a, b];
    wave.setSelection(S.sel ? S.sel[0] : null, S.sel ? S.sel[1] : null);
    if (S.sel) wave.reveal(S.sel[0], false);
    syncSelection(); refresh(false);
  }

  function syncScroll(w) {
    const th = $('thumb');
    const vis = w.duration ? Math.min(1, w.visible / w.duration) : 1;
    const pct = Math.max(3, vis * 100);
    const span = w.duration - w.visible;
    th.style.width = `${pct}%`;
    th.style.left = `${span > 0 ? (w.t0 / span) * (100 - pct) : 0}%`;
  }

  // ---- rendering the page -----------------------------------------------------------------------------------------------------
  function describeNow() {
    return P.describe(S.items.map((i) => ({ path: i.path, duration: i.duration, rate: i.rate, channels: i.channels, cuts: i.cuts })), readOpts());
  }

  function renderList() {
    const list = $('list');
    list.textContent = '';
    S.items.forEach((it, i) => {
      const li = el('li', 'item' + (i === S.cur ? ' current' : ''));
      const pick = el('button', 'pick');
      pick.type = 'button';
      if (i === S.cur) pick.setAttribute('aria-current', 'true');
      pick.append(el('span', 'name', it.name));
      const meta = el('span', 'meta');
      const kept = P.keptDuration(it);
      meta.append(document.createTextNode(`${fmt(it.duration, false)} · ${it.codec} · ${it.channels === 1 ? 'mono' : 'stereo'}`));
      if (it.cuts.length) { meta.append(document.createTextNode(' · now ')); meta.append(el('span', 'changed', fmt(kept, false))); }
      pick.append(meta);
      pick.title = it.path;
      pick.addEventListener('click', (e) => selectItem(i, e.detail === 0));
      const tools = el('div', 'tools');
      const mk = (label, text, fn, disabled) => { const b = el('button', null, text); b.type = 'button'; b.setAttribute('aria-label', label); b.title = label; b.disabled = !!disabled || !!S.busy; b.addEventListener('click', fn); return b; };
      tools.append(mk(`Move ${it.name} earlier`, '▲', () => moveItem(i, -1), i === 0), mk(`Move ${it.name} later`, '▼', () => moveItem(i, 1), i === S.items.length - 1), mk(`Remove ${it.name}`, '✕', () => removeItem(i)));
      li.append(pick, tools);
      list.append(li);
    });
    $('count').textContent = S.items.length ? `${S.items.length} file${S.items.length === 1 ? '' : 's'}` : 'No files';
    $('clear').hidden = S.items.length < 2;
    $('joinHint').hidden = S.items.length < 2;
  }

  function renderCuts() {
    const it = cur();
    const ul = $('cuts');
    ul.textContent = '';
    if (!it) return;
    it.cuts.forEach((c, k) => {
      const li = el('li');
      const go = el('button', null, `${fmt(c[0])} – ${fmt(c[1])}`);
      go.type = 'button'; go.title = 'Select this removed part';
      go.addEventListener('click', () => { S.sel = [c[0], c[1]]; wave.setSelection(c[0], c[1]); wave.reveal(c[0], false); syncSelection(); refresh(false); });
      const x = el('button', 'x', '↺'); x.type = 'button'; x.title = 'Put this part back'; x.setAttribute('aria-label', `Put back ${fmt(c[0])} to ${fmt(c[1])}`);
      x.addEventListener('click', () => restoreCut(k));
      li.append(go, x); ul.append(li);
    });
    const removed = it.cuts.reduce((s, c) => s + c[1] - c[0], 0);
    $('cutsLabel').textContent = it.cuts.length ? `Removed (${fmt(removed, false)} in ${it.cuts.length} part${it.cuts.length === 1 ? '' : 's'}):` : 'Nothing removed yet. Drag on the waveform to select a part, then press Delete.';
    $('restoreAll').hidden = it.cuts.length < 2;
  }

  function renderSummary() {
    const box = $('summary');
    if (S.busy) return;
    const d = describeNow();
    box.className = 'summary';
    box.textContent = '';
    if (!S.items.length) return;
    if (d.error) { box.className = 'summary error'; box.textContent = d.error; return; }
    const o = d.opts;
    const first = S.items[0];
    const bytes = P.estimateBytes(o, d.seconds, first.rate, first.channels);
    const b = el('b', null, fmt(d.seconds, false));
    box.append(document.createTextNode('Result: '), b, document.createTextNode(` · ${P.FORMATS[o.format].label}${o.bitrate ? ` ${o.bitrate} kbps` : ''} · about ${bytesText(bytes)}`));
  }

  function refreshControls() {
    const it = cur();
    const o = readOpts();
    $('loudRow').hidden = o.normalize !== 'loudness';
    $('gain').disabled = o.normalize !== 'off';
    $('gainRow').style.opacity = o.normalize !== 'off' ? '.5' : '';
    $('joinBox').hidden = S.items.length < 2;
    $('joinSecRow').hidden = S.items.length < 2 || o.join === 'none';
    $('joinSecLabel').textContent = o.join === 'cross' ? 'Crossfade length (s)' : 'Pause length (s)';
    const d = describeNow();
    const ok = !!S.items.length && !d.error && !S.busy;
    $('export').disabled = !ok;
    $('preview').disabled = !ok;
    const hasSel = !!S.sel && S.sel[1] - S.sel[0] >= P.MIN_PART && !!it;
    $('cut').disabled = !hasSel || !!S.busy;
    $('keep').disabled = !hasSel || S.sel[1] - S.sel[0] < P.MIN_KEEP || !!S.busy;
    $('undo').disabled = !S.history.length || !!S.busy;
    $('redo').disabled = !S.future.length || !!S.busy;
    $('cancel').hidden = !S.busy;
    $('export').hidden = !!S.busy;
    $('preview').hidden = !!S.busy;
    $('clear').disabled = !!S.busy;
    $('addFiles').disabled = !!S.busy;
    refreshTransport();
  }

  function refresh(full = true) {
    const has = S.items.length > 0;
    $('empty').hidden = has;
    $('editor').hidden = !has;
    const it = cur();
    if (full) {
      renderList();
      renderCuts();
      if (it) {
        $('fname').textContent = it.name;
        $('fname').title = it.path;
        $('finfo').textContent = `${fmt(it.duration)} · ${it.codec}${it.kbps ? ` ${it.kbps} kbps` : ''} · ${(it.rate / 1000).toFixed(it.rate % 1000 ? 1 : 0)} kHz · ${it.channels === 1 ? 'mono' : 'stereo'}`;
      }
      // a preview is only valid for the edit it was made from
      const key = JSON.stringify([S.items.map((i) => [i.id, i.cuts]), readOpts()]);
      if (!$('previewBox').hidden && key !== S.previewKey) closePreview();
    }
    renderSummary();
    refreshControls();
  }

  // ---- export and preview ----------------------------------------------------------------------------------------------------------
  const payload = () => S.items.map((i) => ({ id: i.id, cuts: i.cuts }));

  function setBusy(kind) {
    S.busy = kind;
    $('progress').hidden = !kind;
    $('bar').style.width = '0%';
    $('result').hidden = true;
    if (kind) { stopPlayback(); $('summary').className = 'summary'; $('summary').textContent = kind === 'preview' ? 'Making the preview…' : 'Saving…'; }
    refresh(true);
  }

  async function doExport() {
    if (S.busy) return;
    const d = describeNow();
    if (d.error) { toast(d.error, true); return; }
    setBusy('export');
    let r;
    try { r = await window.ae.exportStart(payload(), readOpts()); } catch (e) { r = { ok: false, error: e.message || String(e) }; }
    setBusy(null);
    const box = $('result');
    box.hidden = false; box.textContent = '';
    if (r.ok) {
      box.className = 'result ok';
      box.append(el('strong', null, `Saved (${fmt(r.seconds, false)}, ${bytesText(r.bytes)})`));
      box.append(el('span', 'path', r.output));
      for (const n of r.notes || []) box.append(el('span', 'small', n));
      const b = el('button', 'btn small', 'Show in folder'); b.type = 'button';
      b.addEventListener('click', () => window.ae.reveal(r.output));
      box.append(b);
    } else if (r.cancelled) {
      box.className = 'result';
      box.textContent = 'Cancelled. Nothing was saved.';
    } else {
      box.className = 'result err';
      box.textContent = r.error || 'Saving failed';
    }
  }

  function closePreview() {
    $('previewBox').hidden = true;
    const pa = $('previewAudio');
    pa.pause(); pa.removeAttribute('src'); pa.load();
  }

  async function doPreview() {
    if (S.busy) return;
    const d = describeNow();
    if (d.error) { toast(d.error, true); return; }
    closePreview();
    setBusy('preview');
    let r;
    try { r = await window.ae.previewStart(payload(), readOpts()); } catch (e) { r = { ok: false, error: e.message || String(e) }; }
    setBusy(null);
    if (!r.ok) { if (!r.cancelled) toast(r.error || 'Could not make the preview', true); return; }
    S.previewKey = JSON.stringify([S.items.map((i) => [i.id, i.cuts]), readOpts()]);
    const pa = $('previewAudio');
    pa.src = r.url;
    $('previewInfo').textContent = `${fmt(r.seconds, false)} · with all fades and volume changes`;
    $('previewBox').hidden = false;
    const p = pa.play();
    if (p && p.catch) p.catch(() => {});
  }

  window.ae.onProgress((p) => { if (S.busy) $('bar').style.width = `${Math.round(p.fraction * 100)}%`; });
  window.ae.onOpened((list) => addOpened(list));

  // ---- wiring ------------------------------------------------------------------------------------------------------------------------
  $('addFiles').addEventListener('click', addFiles);
  $('addFiles2').addEventListener('click', addFiles);
  $('clear').addEventListener('click', removeAll);
  $('play').addEventListener('click', togglePlay);
  $('playSel').addEventListener('click', () => { if (S.sel) play(S.sel[0], S.sel[1]); });
  $('cut').addEventListener('click', cutSelection);
  $('keep').addEventListener('click', keepSelection);
  $('undo').addEventListener('click', undo);
  $('redo').addEventListener('click', redo);
  $('restoreAll').addEventListener('click', restoreAll);
  $('zoomIn').addEventListener('click', () => wave.zoom(1.6, S.head >= wave.t0 && S.head <= wave.t0 + wave.visible ? S.head : null));
  $('zoomOut').addEventListener('click', () => wave.zoom(1 / 1.6, S.head >= wave.t0 && S.head <= wave.t0 + wave.visible ? S.head : null));
  $('zoomFit').addEventListener('click', () => wave.fit());
  $('boost').addEventListener('change', (e) => wave.setBoost(e.target.checked));
  $('export').addEventListener('click', doExport);
  $('preview').addEventListener('click', doPreview);
  $('previewClose').addEventListener('click', closePreview);
  $('cancel').addEventListener('click', () => window.ae.cancel());
  $('pickDir').addEventListener('click', async () => {
    const d = await window.ae.pickOutputDir();
    if (d) { $('outDir').value = d; $('outDir').dataset.path = d; $('outDir').title = d; refresh(false); }
  });
  for (const id of ['selStart', 'selEnd']) {
    $(id).addEventListener('change', selectionFromInputs);
    $(id).addEventListener('keydown', (e) => { if (e.key === 'Enter') { selectionFromInputs(); e.target.blur(); } });
  }
  $('format').addEventListener('change', () => { fillQuality(); refresh(); });
  $('keepTags').addEventListener('change', () => { fillQuality(); refresh(); });
  $('join').addEventListener('change', () => { $('joinSeconds').value = $('join').value === 'cross' ? '2' : '1'; refresh(); });
  for (const id of ['bitrate', 'fadeIn', 'fadeOut', 'gain', 'normalize', 'loudness', 'trimSilence', 'joinSeconds', 'name']) {
    $(id).addEventListener('input', () => refresh(true));
    $(id).addEventListener('change', () => refresh(true));
  }

  // scrollbar under the waveform
  (function () {
    const track = $('hscroll');
    const thumb = $('thumb');
    let drag = null;
    thumb.addEventListener('pointerdown', (e) => { e.preventDefault(); thumb.setPointerCapture(e.pointerId); drag = { x: e.clientX, t0: wave.t0 }; });
    thumb.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const w = track.clientWidth - thumb.offsetWidth;
      const span = Math.max(1e-9, wave.duration - wave.visible);
      wave.scrollTo(drag.t0 + ((e.clientX - drag.x) / Math.max(1, w)) * span);
    });
    thumb.addEventListener('pointerup', () => { drag = null; });
    track.addEventListener('pointerdown', (e) => {
      if (e.target === thumb) return;
      const r = track.getBoundingClientRect();
      wave.scrollTo(((e.clientX - r.left) / r.width) * wave.duration - wave.visible / 2);
    });
  }());

  // drag and drop
  const drop = $('drop');
  const dragging = (e) => e.dataTransfer && [...e.dataTransfer.types].includes('Files');
  window.addEventListener('dragover', (e) => { if (dragging(e)) { e.preventDefault(); drop.classList.add('over'); } });
  window.addEventListener('dragleave', (e) => { if (e.target === document.documentElement || !e.relatedTarget) drop.classList.remove('over'); });
  window.addEventListener('drop', async (e) => {
    if (!dragging(e)) return;
    e.preventDefault(); drop.classList.remove('over');
    if (S.busy) return;
    const paths = [...e.dataTransfer.files].map((f) => window.ae.pathForFile(f)).filter(Boolean);
    if (!paths.length) return;
    const list = await window.ae.openPaths(paths);
    if (!list.length) toast('No audio files found in what you dropped', true);
    else addOpened(list);
  });
  drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); addFiles(); } });
  drop.addEventListener('click', (e) => { if (e.target === drop || e.target.tagName === 'STRONG' || e.target.tagName === 'SPAN') addFiles(); });

  // keyboard
  window.addEventListener('keydown', (e) => {
    const t = e.target;
    const typing = t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA') && t.type !== 'checkbox';
    const onControl = t && (t.tagName === 'BUTTON' || t.tagName === 'AUDIO' || t.type === 'checkbox');
    const ctrl = e.ctrlKey || e.metaKey;
    if (ctrl && !typing) {
      const k = e.key.toLowerCase();
      if (k === 'z') { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
      if (k === 'y') { e.preventDefault(); redo(); return; }
      if (k === 'a') { e.preventDefault(); selectAll(); return; }
      if (k === 'o') { e.preventDefault(); addFiles(); return; }
    }
    if (typing || !cur() || ctrl) return;
    const it = cur();
    switch (e.key) {
      case ' ': if (onControl && t.id !== 'play') return; e.preventDefault(); togglePlay(); break;
      case 'Delete': case 'Backspace': e.preventDefault(); cutSelection(); break;
      case 'Escape': if (S.sel) { S.sel = null; wave.setSelection(null); syncSelection(); refresh(false); } break;
      case '[': if (S.sel || S.head < it.duration) { const b = S.sel ? S.sel[1] : it.duration; S.sel = [Math.min(S.head, b), Math.max(S.head, b)]; wave.setSelection(S.sel[0], S.sel[1]); syncSelection(); refresh(false); } break;
      case ']': { const a = S.sel ? S.sel[0] : 0; S.sel = [Math.min(a, S.head), Math.max(a, S.head)]; wave.setSelection(S.sel[0], S.sel[1]); syncSelection(); refresh(false); break; }
      case 'ArrowLeft': case 'ArrowRight': {
        e.preventDefault();
        const step = (e.shiftKey ? 5 : e.altKey ? 0.01 : 0.5) * (e.key === 'ArrowLeft' ? -1 : 1);
        const to = Math.max(0, Math.min(it.duration, (S.playing ? A.currentTime : S.head) + step));
        seek(to); wave.reveal(to, false);
        break;
      }
      case 'Home': e.preventDefault(); seek(0); wave.reveal(0, false); break;
      case 'End': e.preventDefault(); seek(it.duration); wave.reveal(it.duration, false); break;
      case '+': case '=': wave.zoom(1.6, S.head >= wave.t0 && S.head <= wave.t0 + wave.visible ? S.head : null); break;
      case '-': case '_': wave.zoom(1 / 1.6, S.head >= wave.t0 && S.head <= wave.t0 + wave.visible ? S.head : null); break;
      default: break;
    }
  });

  // ---- start ---------------------------------------------------------------------------------------------------------------------------
  window.ae.encoders().then((r) => {
    S.encodersOk = r.ok;
    if (!r.ok) { const w = $('engineWarn'); w.hidden = false; w.textContent = `The built-in audio engine is missing: ${r.missing.join(', ')}. Saving to some formats will not work.`; }
  }).catch(() => {});
  fillFormats();
  refresh();

  if (location.hash === '#e2e') window.__app = { S, wave, A, P, readOpts, describeNow, undo, redo, seek, play, stopPlayback, addOpened, doExport, doPreview, selectItem };
}());
