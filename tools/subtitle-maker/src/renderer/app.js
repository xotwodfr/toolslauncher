'use strict';
(() => {
  const X = window.Subs;
  const $ = (id) => document.getElementById(id);
  const el = (tag, attrs, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) { if (v === false || v == null) continue; if (k === 'class') n.className = v; else n.setAttribute(k, v === true ? '' : v); }
    for (const kid of kids) if (kid != null) n.append(kid);
    return n;
  };
  const LANG_KEY = 'subtitlemaker.language';
  const STYLE_KEY = 'subtitlemaker.style';
  const r3 = (x) => Math.round(x * 1000) / 1000;

  const S = {
    media: null,                   // what opening the file returned: { id, name, duration, hasVideo, url, estimate, sibling }
    subsName: null,                // the subtitle file the cues came from, if any
    cues: [],                      // { uid, start, end, text }
    sel: null,                     // uid of the selected cue
    history: [],                   // earlier versions of the cues, for Undo
    dirty: false,                  // changed since made, opened or saved
    working: false,
    exporting: false,
    language: 'auto',
    translate: false,
    detected: null,                // the language code the model heard
    detectedText: null,
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
  function showResult(boxId, text, kind, file, extra) {
    const box = $(boxId);
    box.textContent = ''; box.hidden = !text; box.className = 'result' + (kind ? ' ' + kind : '');
    if (!text) return;
    box.append(el('span', null, text));
    if (extra) box.append(el('span', { class: 'muted small' }, extra));
    if (file) {
      box.append(el('span', { class: 'path', title: file }, file));
      const b = el('button', { class: 'btn small', type: 'button' }, 'Show in folder');
      b.addEventListener('click', () => window.sm.reveal(file));
      box.append(b);
    }
  }

  // ---- state -> controls ---------------------------------------------------------------------------------------------------------
  const lang = () => (S.translate && S.detected ? 'en' : S.detected || (S.language === 'auto' ? 'en' : S.language));
  const spaced = () => !X.NO_SPACE.has(lang());
  const rules = () => X.rulesFor(lang());
  function syncControls() {
    const open = !!S.media || S.subsName != null;
    $('empty').hidden = open; $('work').hidden = !open;
    const busy = S.working || S.exporting;
    $('makeSet').disabled = !S.media || busy;
    const has = S.cues.length > 0 && !S.working;
    $('editSet').disabled = !open || S.working;
    $('saveSet').disabled = !has;
    $('videoSet').disabled = !has || !S.media || !S.media.hasVideo;
    for (const id of ['burn', 'soft', 'size', 'box']) $(id).disabled = S.exporting;
    $('undo').disabled = !S.history.length || S.working;
    $('open').disabled = busy; $('importSubs').disabled = busy;
    $('make').textContent = S.cues.length ? 'Make subtitles again' : 'Make subtitles';
    $('progressBox').hidden = !S.working;
    $('exportBox').hidden = !S.exporting;
    $('videoNote').textContent = S.media && !S.media.hasVideo ? 'This file is sound only, so there is no picture to put the subtitles on. Save an .srt or .vtt instead.' : !S.media && S.subsName ? 'Open the video too, to see the subtitles on it and to write a new video.' : '';
    status();
  }
  function status() {
    const n = S.cues.length;
    if (S.working) { $('status').textContent = `${n} subtitle${n === 1 ? '' : 's'} so far…`; return; }
    if (!n) { $('status').textContent = ''; return; }
    const bad = S.cues.filter((c, i) => X.cueProblems(c, S.cues[i + 1], rules()).length).length;
    const parts = [`${n} subtitle${n === 1 ? '' : 's'}`];
    if (S.detectedText) parts.push(S.detectedText);
    if (S.subsName) parts.push('from ' + S.subsName);
    parts.push(bad ? `${bad} break${bad === 1 ? 's' : ''} a rule (red)` : 'all within the rules');
    if (S.dirty) parts.push('edited');
    $('status').textContent = parts.join(' · ');
  }

  // ---- the cues ------------------------------------------------------------------------------------------------------------------
  const newCue = (c) => ({ uid: S.uid++, start: r3(c.start), end: r3(c.end), text: String(c.text || '') });
  const plain = () => S.cues.map((c) => ({ start: c.start, end: c.end, text: c.text }));
  const sortCues = () => { S.cues = S.cues.map((c, i) => ({ c, i })).sort((a, b) => a.c.start - b.c.start || a.i - b.i).map((x) => x.c); };
  const selected = () => S.cues.find((c) => c.uid === S.sel) || null;
  function remember() {
    S.history.push(S.cues.map((c) => ({ ...c })));
    if (S.history.length > 100) S.history.shift();
    S.dirty = true;
  }
  function undo() {
    if (!S.history.length || S.working) return;
    S.cues = S.history.pop();
    S.dirty = true;
    renderCues();
  }

  function decorate(row, cue, i) {
    const problems = X.cueProblems(cue, S.cues[i + 1], rules());
    row.classList.toggle('bad', problems.length > 0);
    row.title = problems.map((p) => p.message).join('\n');
    const speed = X.cps(cue);
    const c = row.querySelector('.cps');
    c.textContent = Number.isFinite(speed) ? speed.toFixed(0) : '—';
    c.classList.toggle('warn', speed > rules().maxCps);
  }

  function rowFor(cue, i) {
    const n = i + 1;
    const start = el('input', { class: 'time start', value: X.formatTime(cue.start), 'aria-label': `Start of subtitle ${n}`, spellcheck: 'false' });
    const end = el('input', { class: 'time end', value: X.formatTime(cue.end), 'aria-label': `End of subtitle ${n}`, spellcheck: 'false' });
    const text = el('textarea', { class: 'text', rows: '2', 'aria-label': `Text of subtitle ${n}`, spellcheck: 'false' });
    text.value = cue.text;
    const btn = (cls, label, title, glyph) => el('button', { type: 'button', class: cls, 'aria-label': `${label} ${n}`, title }, glyph);
    const go = btn('go', 'Play subtitle', 'Play from here', '▶');
    const split = btn('split', 'Split subtitle', 'Split in two (at the playhead when it is inside)', '✂');
    const merge = btn('merge', 'Merge subtitle', 'Join with the next one', '⇣');
    const del = btn('del', 'Delete subtitle', 'Delete', '×');
    if (i === S.cues.length - 1) merge.disabled = true;
    const row = el('div', { class: 'cue' + (S.sel === cue.uid ? ' sel' : ''), 'data-uid': String(cue.uid) },
      el('span', { class: 'n' }, String(n)), start, end, text, el('span', { class: 'cps' }), el('span', { class: 'acts' }, go, split, merge, del));
    if (S.working) for (const f of [start, end, text, go, split, merge, del]) f.disabled = true;
    decorate(row, cue, i);
    const select = () => { if (S.sel !== cue.uid) { S.sel = cue.uid; for (const r of $('cues').children) r.classList.toggle('sel', r.dataset.uid === String(cue.uid)); } };
    for (const f of [start, end, text]) f.addEventListener('focus', select);
    row.addEventListener('mousedown', select);
    let typed = false;
    text.addEventListener('focus', () => { typed = false; });
    text.addEventListener('input', () => {
      if (!typed) { remember(); typed = true; syncControls(); }
      cue.text = text.value;
      decorate(row, cue, S.cues.indexOf(cue)); drawOverlay(true); status();
    });
    const timeEdit = (field, input) => () => {
      const t = X.parseTime(input.value);
      if (t == null) { input.value = X.formatTime(cue[field]); toast('Type a time like 1:05.300 (minutes:seconds)', true); return; }
      if (r3(t) === cue[field]) { input.value = X.formatTime(cue[field]); return; }
      remember();
      cue[field] = r3(t);
      if (field === 'start' && cue.end < cue.start) cue.end = r3(cue.start + 1);
      sortCues(); renderCues(cue, field === 'start' ? '.start' : '.end');
    };
    start.addEventListener('change', timeEdit('start', start));
    end.addEventListener('change', timeEdit('end', end));
    go.addEventListener('click', () => playFrom(cue.start));
    split.addEventListener('click', () => splitCue(cue));
    merge.addEventListener('click', () => mergeNext(cue));
    del.addEventListener('click', () => { remember(); if (S.sel === cue.uid) S.sel = null; S.cues = S.cues.filter((c) => c !== cue); renderCues(); });
    return row;
  }

  /** Rebuild the list. `focusCue`/`focusSel` put the keyboard cursor back where the user was working. */
  function renderCues(focusCue, focusSel) {
    const box = $('cues');
    const scroll = box.scrollTop;
    box.textContent = '';
    const frag = document.createDocumentFragment();
    S.cues.forEach((c, i) => frag.append(rowFor(c, i)));
    box.append(frag);
    box.scrollTop = scroll;
    if (focusCue) { const r = box.querySelector(`[data-uid="${focusCue.uid}"]`); if (r) { const f = r.querySelector(focusSel || '.text'); if (f) f.focus(); r.scrollIntoView({ block: 'nearest' }); } }
    lastNow = -2;
    syncControls(); highlight(true); drawOverlay(true);
  }

  function splitCue(cue) {
    const t = player().currentTime || 0;
    const parts = X.splitCue(cue, t, spaced());
    if (!parts) { toast('This subtitle has only one word: there is nothing to split', true); return; }
    remember();
    const i = S.cues.indexOf(cue);
    const a = newCue(parts[0]); const b = newCue(parts[1]);
    S.cues.splice(i, 1, a, b); S.sel = b.uid;
    renderCues(b);
  }
  function mergeNext(cue) {
    const i = S.cues.indexOf(cue);
    if (i < 0 || i >= S.cues.length - 1) return;
    remember();
    const m = newCue(X.mergeCues(cue, S.cues[i + 1], spaced()));
    S.cues.splice(i, 2, m); S.sel = m.uid;
    renderCues(m);
  }
  function shiftAll(delta) { if (!S.cues.length) return; remember(); S.cues = X.shiftCues(S.cues, delta); renderCues(); toast(`Moved every subtitle ${delta > 0 ? 'later' : 'earlier'} by ${Math.abs(delta)} s`); }
  function stamp(field) {
    const cue = selected();
    if (!cue) { toast('Select a subtitle first (click it), then press [ or ] at the right moment', true); return; }
    const t = r3(player().currentTime || 0);
    remember();
    cue[field] = t;
    if (field === 'start' && cue.end <= t) cue.end = r3(t + Math.max(1, X.visibleLength(cue.text) / rules().targetCps));
    if (field === 'end' && cue.start >= t) { cue.start = r3(Math.max(0, t - 1)); }
    sortCues(); renderCues();
  }
  function addAtPlayhead() {
    const t = r3(player().currentTime || 0);
    const next = S.cues.find((c) => c.start > t);
    const end = Math.min(t + 2, next ? next.start - X.RULES.gap : Infinity, S.media ? S.media.duration || Infinity : Infinity);
    remember();
    const cue = newCue({ start: t, end: Math.max(t + 0.5, end), text: '' });
    S.cues.push(cue); sortCues(); S.sel = cue.uid;
    renderCues(cue);
  }

  // ---- playing -----------------------------------------------------------------------------------------------------------------------
  const player = () => $('player');
  let lastNow = -2; let lastOverlay = null;
  function highlight(force) {
    const i = X.cueAt(S.cues, player().currentTime || 0);
    if (i === lastNow && !force) return;
    lastNow = i;
    const rows = $('cues').children;
    for (let k = 0; k < rows.length; k++) rows[k].classList.toggle('now', k === i);
    if (i >= 0 && rows[i] && !player().paused) rows[i].scrollIntoView({ block: 'nearest' });
  }
  function drawOverlay(force) {
    const i = X.cueAt(S.cues, player().currentTime || 0);
    const text = i >= 0 ? S.cues[i].text.replace(/<\/?[a-z][^>]*>/gi, '').trim() : '';
    if (text === lastOverlay && !force) return;
    lastOverlay = text;
    const o = $('overlay');
    o.textContent = '';
    o.classList.toggle('box', $('box').checked);
    text.split('\n').forEach((line, k) => { if (k) o.append(document.createElement('br')); o.append(el('span', null, line)); });
  }
  function clock() {
    const p = player();
    const dur = isFinite(p.duration) && p.duration > 0 ? p.duration : (S.media ? S.media.duration : 0);
    $('pos').textContent = X.formatTime(p.currentTime || 0);
    $('len').textContent = X.formatDuration(dur);
    if (document.activeElement !== $('seek')) $('seek').value = dur ? String(Math.round(((p.currentTime || 0) / dur) * 10000)) : '0';
  }
  function frame() { clock(); highlight(false); drawOverlay(false); if (!player().paused) requestAnimationFrame(frame); }
  function seekTo(t) { const p = player(); if (!S.media) return; p.currentTime = Math.max(0, t); clock(); highlight(false); drawOverlay(false); }
  function playFrom(t) { if (!S.media) { toast('Open the video to play it', true); return; } seekTo(t); player().play().catch(() => {}); }
  function togglePlay() { const p = player(); if (!S.media) return; if (p.paused) p.play().catch(() => {}); else p.pause(); }

  // ---- opening -----------------------------------------------------------------------------------------------------------------------------
  const confirmDiscard = (what) => !S.dirty || !S.cues.length || window.confirm(`${what} discards the changes you made to these subtitles. Continue?`);
  async function loadMedia(r) {
    if (!r) return;
    if (!r.ok) { toast(r.error || 'Could not open that file', true); return; }
    if (S.working || S.exporting) return;
    // subtitles opened on their own are kept for the video opened next; subtitles of another video are not
    const keep = S.subsName != null && !S.media;
    if (!keep && !confirmDiscard('Opening another file')) { window.sm.forget(r.id); return; }
    const old = S.media;
    S.media = r; S.sel = null; S.detected = null; S.detectedText = null; lastNow = -2;
    if (!keep) { S.cues = []; S.history = []; S.dirty = false; S.subsName = null; }
    banner('');
    if (old) window.sm.forget(old.id);
    const p = player();
    p.pause(); p.src = r.url; p.load();
    $('screen').classList.toggle('audio', !r.hasVideo);
    $('screen').style.aspectRatio = r.hasVideo && r.width && r.height ? `${r.width} / ${r.height}` : '';
    $('noPicture').hidden = r.hasVideo; $('noPicture').textContent = r.hasVideo ? '' : 'Sound only: no picture. The subtitles still show here as it plays.';
    $('fileInfo').textContent = `${r.name} · ${X.formatDuration(r.duration)}${r.hasVideo && r.width ? ` · ${r.width}×${r.height}` : ''}`;
    const note = $('makeNote'); note.textContent = `Takes about ${X.formatDuration(r.estimate)} on this computer.`;
    if (r.sibling && !keep) {
      note.append(' ', el('span', null, `${r.sibling} sits next to it: `));
      const b = el('button', { type: 'button', class: 'btn small', id: 'loadSibling' }, 'Open it');
      b.addEventListener('click', async () => loadSubs(await window.sm.siblingSubs(S.media.id)));
      note.append(b);
    }
    showResult('result', ''); showResult('videoResult', '');
    renderCues(); clock();
  }
  async function loadSubs(r) {
    if (!r) return;
    if (!r.ok) { toast(r.error || 'Could not open those subtitles', true); return; }
    if (S.working || S.exporting) return;
    if (!confirmDiscard('Opening these subtitles')) return;
    S.cues = r.cues.map(newCue); S.history = []; S.dirty = false; S.subsName = r.name; S.sel = null;
    S.detected = null; S.detectedText = null;
    banner('');
    if (!S.media) $('fileInfo').textContent = r.name;
    showResult('result', ''); showResult('videoResult', '');
    renderCues();
    toast(`Opened ${r.cues.length} subtitle${r.cues.length === 1 ? '' : 's'} from ${r.name}`);
  }

  // ---- making ------------------------------------------------------------------------------------------------------------------------------
  const etaText = (s) => (s == null ? '' : `about ${X.formatDuration(Math.max(1, s))} left`);
  async function make() {
    if (!S.media || S.working) return;
    if (S.cues.length && !window.confirm('Making the subtitles again replaces the ones in the list. Continue?')) return;
    S.working = true; S.cues = []; S.history = []; S.sel = null; S.dirty = false; S.detected = null; S.detectedText = null; S.subsName = null; lastNow = -2;
    showResult('result', ''); showResult('videoResult', ''); banner('');
    $('phase').textContent = 'Starting…'; $('eta').textContent = ''; $('fill').style.width = '0%'; $('bar').classList.add('indeterminate'); $('bar').setAttribute('aria-valuenow', '0');
    $('cancel').disabled = false;
    renderCues();
    let res;
    try { res = await window.sm.make(S.media.id, S.language, S.translate); } catch (e) { res = { ok: false, error: (e && e.message) || String(e) }; }
    S.working = false;
    if (res.ok) {
      S.detected = res.language;
      S.detectedText = (res.languageName + (S.language === 'auto' ? ' (detected)' : '')) + (res.translated ? ', translated to English' : '');
      S.cues = res.cues.map(newCue);
      renderCues();
      if (!S.cues.length) toast('No speech was found in this file. If it has speech, try choosing its language instead of detecting it.', true);
    } else {
      S.cues = [];
      renderCues();
      if (!res.cancelled) banner(res.error || 'Something went wrong');
      else toast('Stopped. The subtitles found so far were dropped.');
    }
  }

  // ---- saving ---------------------------------------------------------------------------------------------------------------------------
  async function save(kind) {
    const list = plain().filter((c) => c.text.trim());
    if (!list.length) { toast('There are no subtitles to save yet', true); return; }
    const r = await window.sm.save(S.media ? S.media.id : null, kind, list, S.subsName || 'subtitles');
    if (r.dialogCancelled) return;
    if (!r.ok) { showResult('result', r.error || 'Could not save', 'err'); return; }
    S.dirty = false; status();
    showResult('result', `Saved ${X.baseName(r.path)} (${r.count} subtitle${r.count === 1 ? '' : 's'})`, 'ok', r.path, r.backup ? `The file it replaced was kept as ${X.baseName(r.backup)}.` : null);
  }

  async function exportVideo(mode) {
    if (!S.media || S.exporting) return;
    const list = plain().filter((c) => c.text.trim());
    if (!list.length) { toast('There are no subtitles to put in yet', true); return; }
    const style = { size: $('size').value, box: $('box').checked };
    try { localStorage.setItem(STYLE_KEY, JSON.stringify(style)); } catch { /* fine */ }
    S.exporting = true;
    showResult('videoResult', '');
    $('exportPhase').textContent = mode === 'burn' ? 'Writing the video with the subtitles burnt in…' : 'Adding the subtitle track…';
    $('exportFill').style.width = '0%'; $('exportBar').classList.add('indeterminate'); $('exportCancel').disabled = false;
    syncControls();
    let r;
    try { r = await window.sm.exportVideo(S.media.id, mode, list, style, S.translate ? 'en' : S.detected || (S.language !== 'auto' ? S.language : null)); } catch (e) { r = { ok: false, error: (e && e.message) || String(e) }; }
    S.exporting = false; syncControls();
    if (r.dialogCancelled) return;
    if (r.cancelled) { toast('Stopped. No video was written.'); return; }
    if (!r.ok) { showResult('videoResult', r.error || 'Could not write the video', 'err'); return; }
    showResult('videoResult', `Wrote ${X.baseName(r.path)} in ${X.formatDuration(Math.max(1, r.seconds))}`, 'ok', r.path, mode === 'soft' ? 'Turn the subtitles on in your player\'s subtitle menu.' : null);
  }

  // ---- wiring ------------------------------------------------------------------------------------------------------------------------------
  async function pickMedia() { try { await loadMedia(await window.sm.pickMedia()); } catch (e) { toast((e && e.message) || String(e), true); } }
  async function pickSubs() { try { await loadSubs(await window.sm.pickSubs()); } catch (e) { toast((e && e.message) || String(e), true); } }

  function wire() {
    $('open').addEventListener('click', pickMedia); $('open2').addEventListener('click', pickMedia);
    $('importSubs').addEventListener('click', pickSubs);
    $('empty').addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pickMedia(); } });
    const sel = $('lang');
    for (const l of X.languageList()) sel.append(el('option', { value: l.code }, l.name));
    sel.value = X.LANGUAGES[S.language] ? S.language : 'auto'; S.language = sel.value;
    sel.addEventListener('change', () => { S.language = sel.value; try { localStorage.setItem(LANG_KEY, S.language); } catch { /* fine */ } });
    $('translate').addEventListener('change', () => { S.translate = $('translate').checked; });
    try { const st = JSON.parse(localStorage.getItem(STYLE_KEY) || 'null'); if (st) { if (['small', 'medium', 'large'].includes(st.size)) $('size').value = st.size; $('box').checked = !!st.box; } } catch { /* fine */ }
    $('box').addEventListener('change', () => drawOverlay(true));
    $('make').addEventListener('click', make);
    $('cancel').addEventListener('click', () => { $('cancel').disabled = true; $('phase').textContent = 'Stopping…'; window.sm.cancel(); });
    $('exportCancel').addEventListener('click', () => { $('exportCancel').disabled = true; $('exportPhase').textContent = 'Stopping…'; window.sm.cancelExport(); });
    $('play').addEventListener('click', togglePlay);
    $('back').addEventListener('click', () => seekTo((player().currentTime || 0) - 2));
    $('fwd').addEventListener('click', () => seekTo((player().currentTime || 0) + 2));
    $('seek').addEventListener('input', () => { const p = player(); const dur = isFinite(p.duration) && p.duration > 0 ? p.duration : (S.media ? S.media.duration : 0); seekTo((Number($('seek').value) / 10000) * dur); });
    const p = player();
    p.addEventListener('play', () => { $('play').textContent = '❚❚ Pause'; requestAnimationFrame(frame); });
    p.addEventListener('pause', () => { $('play').textContent = '▶ Play'; clock(); });
    p.addEventListener('ended', () => { $('play').textContent = '▶ Play'; clock(); });
    p.addEventListener('loadedmetadata', clock);
    p.addEventListener('seeked', () => { clock(); highlight(false); drawOverlay(false); });
    p.addEventListener('error', () => {
      if (!S.media) return;
      $('noPicture').hidden = false; $('screen').classList.add('audio');
      $('noPicture').textContent = 'This file cannot be previewed here (the preview does not know its format). Subtitles can still be made, saved and put into a new video.';
    });
    for (const b of document.querySelectorAll('[data-shift]')) b.addEventListener('click', () => shiftAll(Number(b.dataset.shift)));
    $('addCue').addEventListener('click', addAtPlayhead); $('undo').addEventListener('click', undo);
    $('stampStart').addEventListener('click', () => stamp('start')); $('stampEnd').addEventListener('click', () => stamp('end'));
    $('saveSrt').addEventListener('click', () => save('srt')); $('saveVtt').addEventListener('click', () => save('vtt'));
    $('burn').addEventListener('click', () => exportVideo('burn')); $('soft').addEventListener('click', () => exportVideo('soft'));

    window.addEventListener('keydown', (e) => {
      const t = e.target;
      const typing = /^(INPUT|SELECT|TEXTAREA)$/.test((t && t.tagName) || '') && t.type !== 'range' && t.type !== 'checkbox';
      const mod = e.ctrlKey || e.metaKey;
      const k = e.key.toLowerCase();
      if (mod && k === 'o') { e.preventDefault(); if (!$('open').disabled) pickMedia(); return; }
      if (mod && k === 's') { e.preventDefault(); if (!$('saveSet').disabled) save('srt'); return; }
      if (mod && k === 'z' && !typing) { e.preventDefault(); undo(); return; }
      if (mod) return;
      if (typing && e.key === 'Enter' && t.classList.contains('time')) { t.blur(); return; }
      if (typing || $('editSet').disabled) { if (!typing && e.key === ' ' && t.tagName !== 'BUTTON' && S.media) { e.preventDefault(); togglePlay(); } return; }
      if (e.key === ' ' && t.tagName !== 'BUTTON') { e.preventDefault(); togglePlay(); }
      else if (e.key === '[') { e.preventDefault(); stamp('start'); }
      else if (e.key === ']') { e.preventDefault(); stamp('end'); }
      else if (k === 'n') { e.preventDefault(); addAtPlayhead(); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); seekTo((player().currentTime || 0) - 2); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); seekTo((player().currentTime || 0) + 2); }
    });

    let depth = 0;
    window.addEventListener('dragenter', (e) => { e.preventDefault(); depth++; document.body.classList.add('dragging'); });
    window.addEventListener('dragleave', () => { depth = Math.max(0, depth - 1); if (!depth) document.body.classList.remove('dragging'); });
    window.addEventListener('dragover', (e) => e.preventDefault());
    window.addEventListener('drop', async (e) => {
      e.preventDefault(); depth = 0; document.body.classList.remove('dragging');
      const files = [...((e.dataTransfer && e.dataTransfer.files) || [])];
      const paths = files.map((f) => window.sm.pathForFile(f)).filter(Boolean);
      const m = paths.find((p) => X.isMedia(p)); const s = paths.find((p) => X.isSubtitle(p));
      if (!m && !s) { if (paths.length) toast('Drop a video, an audio file, or an .srt / .vtt file', true); return; }
      if (m) await loadMedia(await window.sm.openMedia(m));
      if (s) await loadSubs(await window.sm.openSubs(s));
    });
    window.addEventListener('beforeunload', (e) => { if (S.dirty && S.cues.length && !location.hash.includes('e2e')) { e.preventDefault(); e.returnValue = ''; } });
  }

  async function init() {
    wire();
    window.sm.onPhase((p) => {
      if (!S.working) return;
      $('phase').textContent = p.phase === 'loading' ? 'Starting the speech model (the first file takes a few seconds longer)…' : p.phase === 'reading' ? 'Reading the sound…' : 'Listening…';
    });
    window.sm.onProgress((p) => {
      if (!S.working) return;
      const pct = Math.round(p.fraction * 100);
      $('bar').classList.remove('indeterminate'); $('fill').style.width = pct + '%'; $('bar').setAttribute('aria-valuenow', String(pct));
      $('phase').textContent = `Listening… ${pct}%` + (p.language && X.LANGUAGES[p.language] && S.language === 'auto' ? ` · ${X.LANGUAGES[p.language]}` : '');
      $('eta').textContent = etaText(p.eta);
    });
    window.sm.onCues((p) => { if (S.working) { S.cues = p.cues.map(newCue); renderCues(); } });
    window.sm.onExportProgress((p) => {
      if (!S.exporting || $('exportCancel').disabled) return;
      const pct = Math.round(p.fraction * 100);
      $('exportBar').classList.remove('indeterminate'); $('exportFill').style.width = pct + '%'; $('exportBar').setAttribute('aria-valuenow', String(pct));
      $('exportPhase').textContent = `Writing… ${pct}%` + (p.eta != null ? ` · ${etaText(p.eta)}` : '');
    });
    window.sm.onMediaOpened((r) => loadMedia(r));
    window.sm.onSubsOpened((r) => loadSubs(r));
    syncControls();
    try {
      const e = await window.sm.engine();
      if (!e.ok) { $('engineWarn').textContent = e.problems.join(' '); $('engineWarn').hidden = false; $('make').disabled = true; }
      else if (e.warnings && e.warnings.length) { $('engineWarn').textContent = e.warnings.join(' '); $('engineWarn').hidden = false; }
    } catch { /* ignore */ }
  }

  window.__app = { S, X, loadMedia, loadSubs, make, save, exportVideo, undo, renderCues, overlayText: () => $('overlay').textContent };
  init();
})();
