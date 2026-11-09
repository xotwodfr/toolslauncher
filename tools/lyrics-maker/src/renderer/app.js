'use strict';
(() => {
  const P = window.Plan;
  const $ = (id) => document.getElementById(id);
  const el = (tag, attrs, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) { if (v === false || v == null) continue; if (k === 'class') n.className = v; else n.setAttribute(k, v === true ? '' : v); }
    for (const kid of kids) if (kid != null) n.append(kid);
    return n;
  };
  const LANG_KEY = 'lyricsmaker.language';
  const round2 = (x) => Math.round(x * 100) / 100;

  const S = {
    song: null,                    // { id, name, duration, url, estimate, existingLrc }
    lines: [],                     // { uid, start, text }  what the window shows and saves
    made: [],                      // the lines as they were made, for "Undo all edits"
    sel: null,                     // the selected line object
    edited: false,
    working: false,
    language: 'auto',
    detected: null,
    uid: 1,
  };
  try { S.language = localStorage.getItem(LANG_KEY) || 'auto'; } catch { /* private mode: fine */ }

  // ---- messages ----------------------------------------------------------------------------------------------------------------
  let toastTimer = null;
  function toast(text, err = false) {
    const t = $('toast');
    t.textContent = text; t.className = 'toast' + (err ? ' err' : ''); t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 4200);
  }
  const banner = (text) => { const b = $('banner'); b.textContent = text || ''; b.hidden = !text; };
  function showResult(text, kind, file, extra) {
    const box = $('result');
    box.textContent = ''; box.hidden = !text; box.className = 'result' + (kind ? ' ' + kind : '');
    if (!text) return;
    box.append(el('span', null, text));
    if (extra) box.append(el('span', { class: 'muted small' }, extra));
    if (file) {
      box.append(el('span', { class: 'path', title: file }, file));
      const b = el('button', { class: 'btn small', type: 'button' }, 'Show in folder');
      b.addEventListener('click', () => window.lm.reveal(file));
      box.append(b);
    }
  }

  // ---- state -> controls ---------------------------------------------------------------------------------------------------------
  function syncControls() {
    const has = !!S.song;
    $('empty').hidden = has; $('work').hidden = !has;
    $('playSet').disabled = !has;
    $('makeSet').disabled = !has || S.working;
    const lines = S.lines.length > 0 && !S.working;
    $('timeSet').disabled = !lines; $('saveSet').disabled = !lines;
    $('revert').disabled = !S.edited || S.working;
    $('open').disabled = S.working;
    $('make').textContent = S.lines.length ? 'Make lyrics again' : 'Make lyrics';
    $('progressBox').hidden = !S.working;
    const n = S.lines.length;
    $('status').textContent = S.working ? `${n} line${n === 1 ? '' : 's'} so far…` : n ? `${n} line${n === 1 ? '' : 's'}${S.detected ? ' · ' + S.detected : ''}${S.edited ? ' · edited' : ''}` : '';
  }

  // ---- the lines -----------------------------------------------------------------------------------------------------------------
  const sortLines = () => { S.lines = S.lines.map((l, i) => ({ l, i })).sort((a, b) => a.l.start - b.l.start || a.i - b.i).map((x) => x.l); };
  const newLine = (start, text) => ({ uid: S.uid++, start: round2(start), text });

  function rowFor(line) {
    const idx = S.lines.indexOf(line);
    const n = idx + 1;
    const time = el('input', { class: 'time', value: P.formatTime(line.start), 'aria-label': `Time of line ${n}`, spellcheck: 'false' });
    const text = el('input', { class: 'text', value: line.text, 'aria-label': `Text of line ${n}`, spellcheck: 'false' });
    const go = el('button', { type: 'button', class: 'go', 'aria-label': `Play from line ${n}`, title: 'Play from here' }, '▶');
    const del = el('button', { type: 'button', class: 'del', 'aria-label': `Delete line ${n}`, title: 'Delete this line' }, '×');
    const row = el('div', { class: 'line' + (S.sel === line ? ' sel' : ''), 'data-uid': String(line.uid) }, go, time, text, del);
    if (S.working) { time.disabled = true; text.disabled = true; go.disabled = true; del.disabled = true; }
    const select = () => { if (S.sel !== line) { S.sel = line; for (const r of $('lines').children) r.classList.toggle('sel', r.dataset.uid === String(line.uid)); } };
    time.addEventListener('focus', select); text.addEventListener('focus', select);
    row.addEventListener('mousedown', select);
    text.addEventListener('input', () => { line.text = text.value; markEdited(); });
    time.addEventListener('change', () => {
      const t = P.parseTime(time.value);
      if (t == null) { time.value = P.formatTime(line.start); toast('Type a time like 1:05.30 (minutes:seconds)', true); return; }
      line.start = round2(t); markEdited(); sortLines(); renderLines(line, 'time');
    });
    go.addEventListener('click', () => playFrom(line.start));
    del.addEventListener('click', () => {
      if (S.sel === line) S.sel = null;
      S.lines = S.lines.filter((l) => l !== line); markEdited(); renderLines();
    });
    return row;
  }

  /** Rebuild the list. `focusLine`/`focusField` put the keyboard cursor back where the user was working. */
  function renderLines(focusLine, focusField) {
    const box = $('lines');
    const scroll = box.scrollTop;
    box.textContent = '';
    const frag = document.createDocumentFragment();
    for (const l of S.lines) frag.append(rowFor(l));
    box.append(frag);
    box.scrollTop = scroll;
    if (focusLine) { const r = box.querySelector(`[data-uid="${focusLine.uid}"]`); if (r) { const f = r.querySelector(focusField === 'time' ? '.time' : '.text'); if (f) f.focus(); r.scrollIntoView({ block: 'nearest' }); } }
    syncControls(); highlight(true);
  }
  function appendLines(list) {
    const box = $('lines');
    for (const l of list) { const line = newLine(l.start, l.text); S.lines.push(line); box.append(rowFor(line)); }
    syncControls();
  }
  function markEdited() { if (!S.edited) { S.edited = true; syncControls(); } }

  // ---- playing -----------------------------------------------------------------------------------------------------------------------
  const player = () => $('player');
  let lastNow = -2;
  function highlight(force) {
    const i = P.currentLine(S.lines, player().currentTime || 0);
    if (i === lastNow && !force) return;
    lastNow = i;
    const rows = $('lines').children;
    for (let k = 0; k < rows.length; k++) rows[k].classList.toggle('now', k === i);
    if (i >= 0 && rows[i] && !player().paused) rows[i].scrollIntoView({ block: 'nearest' });
  }
  function clock() {
    const p = player();
    const dur = isFinite(p.duration) && p.duration > 0 ? p.duration : (S.song ? S.song.duration : 0);
    $('pos').textContent = P.formatDuration(p.currentTime || 0);
    $('len').textContent = P.formatDuration(dur);
    if (document.activeElement !== $('seek')) $('seek').value = dur ? String(Math.round(((p.currentTime || 0) / dur) * 1000)) : '0';
  }
  function frame() { clock(); highlight(false); if (!player().paused) requestAnimationFrame(frame); }
  function playFrom(t) { const p = player(); p.currentTime = Math.max(0, t); p.play().catch(() => {}); }
  function togglePlay() { const p = player(); if (!S.song) return; if (p.paused) p.play().catch(() => {}); else p.pause(); }

  // ---- opening and making ----------------------------------------------------------------------------------------------------------------
  async function loadSong(r) {
    if (!r) return;
    if (!r.ok) { toast(r.error || 'Could not open that file', true); return; }
    if (S.working) return;
    if (S.edited && !window.confirm('Opening another song discards the changes you made to these lyrics. Continue?')) return;
    const old = S.song;
    S.song = r; S.lines = []; S.made = []; S.sel = null; S.edited = false; S.detected = null; lastNow = -2;
    banner('');
    if (old) window.lm.forget(old.id);
    const p = player();
    p.pause(); p.src = r.url; p.load();
    $('fileInfo').textContent = `${r.name} · ${P.formatDuration(r.duration)}`;
    $('makeNote').textContent = `Takes about ${P.formatDuration(r.estimate)} on this computer.` + (r.existingLrc ? ' A .lrc file already sits next to this song; saving keeps the old one as .lrc.bak.' : '');
    showResult('', '');
    renderLines(); clock();
  }

  const etaText = (s) => (s == null ? '' : `about ${P.formatDuration(Math.max(1, s))} left`);
  async function make() {
    if (!S.song || S.working) return;
    if (S.edited && !window.confirm('Making the lyrics again replaces the edits you made. Continue?')) return;
    S.working = true; S.lines = []; S.made = []; S.sel = null; S.edited = false; S.detected = null; lastNow = -2;
    showResult('', '');
    $('phase').textContent = 'Starting…'; $('eta').textContent = ''; $('fill').style.width = '0%'; $('bar').classList.add('indeterminate'); $('bar').setAttribute('aria-valuenow', '0');
    $('cancel').disabled = false;
    renderLines();
    let res;
    try { res = await window.lm.make(S.song.id, S.language); } catch (e) { res = { ok: false, error: (e && e.message) || String(e) }; }
    S.working = false;
    if (res.ok) {
      S.lines = res.lines.map((l) => newLine(l.start, l.text));
      S.made = S.lines.map((l) => ({ start: l.start, text: l.text }));
      S.detected = res.languageName + (S.language === 'auto' ? ' (detected)' : '');
      renderLines();
      if (!S.lines.length) toast('No words were found in this song. If it has singing, try choosing its language instead of detecting it.', true);
    } else {
      renderLines();
      if (!res.cancelled) banner(res.error || 'Something went wrong');
      else toast('Stopped. The lines found so far were dropped.');
    }
  }

  // ---- timing tools -------------------------------------------------------------------------------------------------------------------------
  function shiftAll(delta) { S.lines = P.shiftLines(S.lines, delta); markEdited(); renderLines(); }
  function stamp() {
    if (!S.sel || !S.lines.includes(S.sel)) { toast('Select a line first (click it), then press S at the moment it starts', true); return; }
    S.sel.start = round2(player().currentTime || 0); markEdited(); sortLines(); renderLines(S.sel, 'text');
  }
  function addLine() {
    const line = newLine(player().currentTime || 0, '');
    S.lines.push(line); sortLines(); S.sel = line; markEdited(); renderLines(line, 'text');
  }
  function revert() { S.lines = S.made.map((l) => newLine(l.start, l.text)); S.sel = null; S.edited = false; renderLines(); }

  async function save(kind) {
    const lines = S.lines.filter((l) => l.text.trim()).map((l) => ({ start: l.start, text: l.text.trim() }));
    if (!lines.length) { toast('There are no lyrics to save yet', true); return; }
    const r = await window.lm.save(S.song.id, kind, lines);
    if (r.dialogCancelled) return;
    if (!r.ok) { showResult(r.error || 'Could not save', 'err'); return; }
    showResult(`Saved ${P.baseName(r.path)} (${r.lines} line${r.lines === 1 ? '' : 's'})`, 'ok', r.path, r.backup ? `The file it replaced was kept as ${P.baseName(r.backup)}.` : null);
  }

  // ---- wiring ------------------------------------------------------------------------------------------------------------------------------
  async function pickSong() { try { await loadSong(await window.lm.pickSong()); } catch (e) { toast((e && e.message) || String(e), true); } }

  function wire() {
    $('open').addEventListener('click', pickSong); $('open2').addEventListener('click', pickSong);
    $('empty').addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pickSong(); } });
    const lang = $('lang');
    for (const l of P.languageList()) lang.append(el('option', { value: l.code }, l.name));
    lang.value = S.language;
    lang.addEventListener('change', () => { S.language = lang.value; try { localStorage.setItem(LANG_KEY, S.language); } catch { /* fine */ } });
    $('make').addEventListener('click', make);
    $('cancel').addEventListener('click', () => { $('cancel').disabled = true; $('phase').textContent = 'Stopping…'; window.lm.cancel(); });
    $('play').addEventListener('click', togglePlay);
    $('seek').addEventListener('input', () => { const p = player(); const dur = isFinite(p.duration) && p.duration > 0 ? p.duration : S.song.duration; p.currentTime = (Number($('seek').value) / 1000) * dur; clock(); highlight(false); });
    const p = player();
    p.addEventListener('play', () => { $('play').textContent = '❚❚ Pause'; requestAnimationFrame(frame); });
    p.addEventListener('pause', () => { $('play').textContent = '▶ Play'; clock(); });
    p.addEventListener('ended', () => { $('play').textContent = '▶ Play'; clock(); });
    p.addEventListener('loadedmetadata', clock);
    p.addEventListener('seeked', () => { clock(); highlight(false); });
    p.addEventListener('error', () => { if (S.song) toast('This song cannot be played in the window (the lyrics can still be made).', true); });
    for (const b of document.querySelectorAll('[data-shift]')) b.addEventListener('click', () => shiftAll(Number(b.dataset.shift)));
    $('stamp').addEventListener('click', stamp); $('addLine').addEventListener('click', addLine); $('revert').addEventListener('click', revert);
    $('saveLrc').addEventListener('click', () => save('lrc')); $('saveTxt').addEventListener('click', () => save('txt'));

    window.addEventListener('keydown', (e) => {
      const typing = /^(INPUT|SELECT|TEXTAREA)$/.test((e.target && e.target.tagName) || '') && e.target.type !== 'range' && e.target.type !== 'checkbox';
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 'o') { e.preventDefault(); if (!$('open').disabled) pickSong(); return; }
      if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); if (!$('saveSet').disabled) save('lrc'); return; }
      if (!S.song || mod) return;
      if (e.key === ' ' && !typing && e.target.tagName !== 'BUTTON') { e.preventDefault(); togglePlay(); return; }
      if (typing && e.key === 'Enter' && e.target.classList.contains('time')) { e.target.blur(); return; }
      if (!typing && e.key.toLowerCase() === 's' && !$('timeSet').disabled) { e.preventDefault(); stamp(); }
    });

    let depth = 0;
    window.addEventListener('dragenter', (e) => { e.preventDefault(); depth++; document.body.classList.add('dragging'); });
    window.addEventListener('dragleave', () => { depth = Math.max(0, depth - 1); if (!depth) document.body.classList.remove('dragging'); });
    window.addEventListener('dragover', (e) => e.preventDefault());
    window.addEventListener('drop', async (e) => {
      e.preventDefault(); depth = 0; document.body.classList.remove('dragging');
      const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (!f) return;
      const path = window.lm.pathForFile(f);
      if (path) loadSong(await window.lm.openSong(path));
    });
  }

  async function init() {
    wire();
    window.lm.onPhase((p) => {
      if (!S.working) return;
      $('phase').textContent = p.phase === 'loading' ? 'Starting the speech model (the first song takes a few seconds longer)…' : p.phase === 'reading' ? 'Reading the song…' : 'Listening…';
    });
    window.lm.onProgress((p) => {
      if (!S.working) return;
      const pct = Math.round(p.fraction * 100);
      $('bar').classList.remove('indeterminate'); $('fill').style.width = pct + '%'; $('bar').setAttribute('aria-valuenow', String(pct));
      $('phase').textContent = `Listening… ${pct}%`;
      $('eta').textContent = etaText(p.eta);
    });
    window.lm.onLines((p) => { if (S.working) appendLines(p.lines); });
    window.lm.onOpened((r) => loadSong(r));
    syncControls();
    try {
      const e = await window.lm.engine();
      if (!e.ok) { $('engineWarn').textContent = e.problems.join(' '); $('engineWarn').hidden = false; $('open').disabled = true; $('open2').disabled = true; }
      else if (e.warnings && e.warnings.length) { $('engineWarn').textContent = e.warnings.join(' '); $('engineWarn').hidden = false; }
    } catch { /* ignore */ }
  }

  window.__app = { S, P, loadSong, make, currentLine: () => P.currentLine(S.lines, player().currentTime || 0) };
  init();
})();
