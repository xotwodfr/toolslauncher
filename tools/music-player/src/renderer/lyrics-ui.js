'use strict';
// Lyrics: the scrolling, click-to-seek lyrics view on the Now playing screen, and the editor (type lyrics, or tap along to
// the song to time every line). Saves a "<song>.lrc" file next to the song; the audio file itself is never changed.
(function () {
  let C = null; // context handed over by app.js: { S, engine, mp, h, toast, ask, M }
  let cur = { rel: '', data: null, loading: false };
  let host = null;         // the .lyrics element currently on screen
  let activeIdx = -2;
  let manualUntil = 0;
  const ed = { rel: '', mode: 'text', lines: [], meta: {}, pointer: 0, sel: -1, dirty: false, data: null };

  const msOf = () => Math.round(C.engine.position * 1000);

  async function load(rel) {
    cur = { rel, data: null, loading: true };
    activeIdx = -2;
    if (!rel) { cur.loading = false; renderInto(); return; }
    try { const d = await C.mp.getLyrics(rel); if (cur.rel === rel) cur = { rel, data: d, loading: false }; } catch { if (cur.rel === rel) cur = { rel, data: null, loading: false, failed: true }; }
    renderInto();
  }

  /** Build the lyrics area for the Now playing screen. */
  function mount(container) {
    const { h } = C;
    host = null;
    container.textContent = '';
    const head = h('div', { class: 'lyrhead' },
      h('strong', { text: 'Lyrics' }),
      h('span', { class: 'muted small', id: 'lyrSrc' }),
      h('span', { class: 'grow' }),
      h('button', { class: 'iconbtn', title: 'Smaller text', 'aria-label': 'Smaller lyrics text', text: 'A−', onclick: () => size(-1) }),
      h('button', { class: 'iconbtn', title: 'Larger text', 'aria-label': 'Larger lyrics text', text: 'A+', onclick: () => size(1) }),
      h('button', { class: 'btn small', id: 'lyrEdit', text: 'Edit lyrics', onclick: () => openEditor(cur.rel) }));
    const body = h('div', { class: 'lyrics ' + C.S.settings.lyricsSize, id: 'lyrBody', tabindex: '0', 'aria-label': 'Lyrics' });
    for (const ev of ['wheel', 'touchmove', 'keydown']) body.addEventListener(ev, () => { manualUntil = performance.now() + 3500; }, { passive: true });
    container.append(head, body);
    host = body;
    renderInto();
  }
  function unmount() { host = null; }

  function size(dir) {
    const order = ['s', 'm', 'l'];
    const i = Math.max(0, Math.min(2, order.indexOf(C.S.settings.lyricsSize) + dir));
    C.S.settings.lyricsSize = order[i];
    C.mp.setSettings({ lyricsSize: order[i] });
    if (host) host.className = 'lyrics ' + order[i] + (cur.data && cur.data.synced ? ' synced' : ' plain');
  }

  function renderInto() {
    if (!host) return;
    const { h } = C;
    const d = cur.data;
    host.textContent = '';
    const srcEl = document.getElementById('lyrSrc');
    const edit = document.getElementById('lyrEdit');
    if (edit) edit.disabled = !cur.rel;
    if (srcEl) srcEl.textContent = '';
    if (!cur.rel) { host.append(h('div', { class: 'nolyrics' }, h('div', { text: 'Play a song to see its lyrics.' }))); return; }
    if (cur.loading) return;
    if (!d || !d.lines.length) {
      host.className = 'lyrics ' + C.S.settings.lyricsSize;
      host.append(h('div', { class: 'nolyrics' },
        h('div', { text: cur.failed ? 'Couldn\'t read the lyrics for this song.' : 'No lyrics for this song yet.' }),
        h('div', { class: 'small', text: 'Put a "' + (d ? d.sidecarName : 'Song.lrc') + '" file next to the song, or add lyrics yourself.' }),
        h('button', { class: 'btn primary', text: 'Add lyrics', onclick: () => openEditor(cur.rel) })));
      return;
    }
    host.className = 'lyrics ' + C.S.settings.lyricsSize + (d.synced ? ' synced' : ' plain');
    if (srcEl) srcEl.textContent = (d.synced ? 'Synced' : 'Plain') + ' · ' + (d.source === 'sidecar' ? d.fileName : 'from the song\'s tags');
    d.lines.forEach((l, i) => {
      const p = h('p', { text: l.text || ' ', 'data-i': String(i) });
      if (!l.text) p.classList.add('gap');
      if (d.synced) { p.addEventListener('click', () => { C.engine.seek(l.t / 1000); }); }
      host.append(p);
    });
    activeIdx = -2;
    tick();
  }

  /** Called every frame: highlights the line being sung and keeps it in view. */
  function tick() {
    const d = cur.data;
    if (!host || !d || !d.synced || !d.lines.length) return;
    const idx = C.LRC.activeIndex(d.lines, msOf() + 120); // a touch early: the eye needs a moment to find the line
    if (idx === activeIdx) return;
    activeIdx = idx;
    const ps = host.children;
    for (let i = 0; i < ps.length; i++) {
      ps[i].classList.toggle('active', i === idx);
      ps[i].classList.toggle('past', i < idx);
    }
    const p = ps[idx];
    if (p && performance.now() > manualUntil) host.scrollTo({ top: Math.max(0, p.offsetTop - host.clientHeight * 0.38), behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  }

  // ---- editor ----------------------------------------------------------------------------------------------------
  const $ = (id) => document.getElementById(id);
  const fmt = (t) => (t == null ? '' : C.LRC.formatTime(t));

  async function openEditor(rel) {
    if (!rel) return;
    const t = C.S.byRel.get(rel);
    let d = cur.rel === rel ? cur.data : null;
    if (!d) { try { d = await C.mp.getLyrics(rel); } catch { d = null; } }
    ed.rel = rel; ed.data = d; ed.mode = 'text'; ed.pointer = 0; ed.sel = -1; ed.dirty = false;
    let text = '';
    if (d && d.lines.length) {
      const meta = { ...d.meta };
      if (!meta.title && t) meta.title = C.M.titleOf(t);
      text = d.synced ? C.LRC.serialize(d.lines, { title: meta.title, artist: meta.artist || (t && t.artist), album: meta.album || (t && t.album) }) : d.lines.map((l) => l.text).join('\n') + '\n';
    }
    $('edText').value = text;
    $('edSong').textContent = t ? C.M.titleOf(t) + ' — ' + C.M.artistOf(t) : '';
    $('edInfo').textContent = d && d.source === 'sidecar' ? 'Will replace ' + d.fileName + ' (a backup is kept).' : 'Will be saved as ' + (d ? d.sidecarName : 'Song.lrc') + ' next to the song.';
    setMode('text');
    $('editor').showModal();
    $('edText').focus();
  }

  function parseText() {
    const p = C.LRC.parse($('edText').value);
    ed.meta = {};
    for (const k of ['title', 'artist', 'album']) if (p.meta[k]) ed.meta[k] = p.meta[k];
    ed.lines = p.lines.map((l) => ({ t: l.t, text: l.text }));
    const firstOpen = ed.lines.findIndex((l) => l.t == null);
    ed.pointer = firstOpen < 0 ? 0 : firstOpen; // start at the first line that still needs a time
    ed.sel = -1;
  }

  function currentText() { return ed.mode === 'sync' ? C.LRC.serialize(ed.lines, ed.meta) : $('edText').value; }

  function setMode(mode) {
    if (mode === 'sync' && ed.mode !== 'sync') { parseText(); if (!ed.lines.length) { C.toast('Type the lyrics on the Text tab first.', true); return; } }
    if (mode === 'text' && ed.mode === 'sync') $('edText').value = C.LRC.serialize(ed.lines, ed.meta);
    ed.mode = mode;
    $('tabText').setAttribute('aria-selected', String(mode === 'text'));
    $('tabSync').setAttribute('aria-selected', String(mode === 'sync'));
    $('paneText').hidden = mode !== 'text';
    $('paneSync').hidden = mode !== 'sync';
    if (mode === 'sync') { if (ed.pointer >= ed.lines.length) ed.pointer = 0; renderSync(); $('syList').focus({ preventScroll: true }); }
  }

  function renderSync() {
    const { h } = C;
    const list = $('syList');
    list.textContent = '';
    ed.lines.forEach((l, i) => {
      const li = h('li', { 'data-i': String(i) }, h('span', { class: 'ts', text: l.t == null ? '--:--.--' : fmt(l.t) }), h('span', { text: l.text || '(pause)' }));
      if (l.t != null) li.classList.add('stamped');
      if (i === ed.pointer) li.classList.add('cur');
      if (i === ed.sel) li.setAttribute('aria-current', 'true');
      list.append(li);
    });
    const c = list.children[Math.min(ed.pointer, list.children.length - 1)];
    if (c) c.scrollIntoView({ block: 'center' });
  }

  function stamp() {
    if (!ed.lines.length) return;
    if (ed.pointer >= ed.lines.length) { C.toast('Every line is stamped. Save, or click a line to redo it.'); return; }
    ed.lines[ed.pointer].t = msOf();
    ed.sel = ed.pointer; ed.pointer++; ed.dirty = true;
    renderSync();
  }
  function back() {
    if (ed.pointer <= 0) return;
    ed.pointer--;
    const old = ed.lines[ed.pointer].t;
    ed.lines[ed.pointer].t = null; ed.sel = -1; ed.dirty = true;
    if (old != null) C.engine.seek(Math.max(0, old / 1000 - 2));
    renderSync();
  }
  function nudge(all, ms) {
    if (all) ed.lines = C.LRC.shift(ed.lines, ms);
    else if (ed.sel >= 0 && ed.lines[ed.sel] && ed.lines[ed.sel].t != null) ed.lines[ed.sel].t = Math.max(0, ed.lines[ed.sel].t + ms);
    else { C.toast('Click a stamped line first.'); return; }
    ed.dirty = true; renderSync();
  }

  async function save() {
    const text = currentText();
    if (!text.trim()) { C.toast('There is nothing to save.', true); return; }
    const exists = ed.data && ed.data.source === 'sidecar';
    if (exists) {
      const ok = await C.ask({ title: 'Replace ' + ed.data.fileName + '?', text: 'The current file is kept as ' + ed.data.fileName + '.bak.', ok: 'Replace' });
      if (!ok) return;
    }
    try {
      const r = await C.mp.saveLyrics(ed.rel, text);
      ed.dirty = false;
      $('editor').close();
      C.toast('Saved ' + r.fileName);
      if (C.S.currentRel === ed.rel || cur.rel === ed.rel) await load(ed.rel);
    } catch (e) { C.toast('Couldn\'t save: ' + String((e && e.message) || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), true); }
  }

  async function closeEditor() {
    if (ed.dirty) { const ok = await C.ask({ title: 'Discard your changes?', text: 'The lyrics you typed have not been saved.', ok: 'Discard' }); if (!ok) return; }
    $('editor').close();
  }

  function initEditor() {
    $('edText').addEventListener('input', () => { ed.dirty = true; });
    $('tabText').addEventListener('click', () => setMode('text'));
    $('tabSync').addEventListener('click', () => setMode('sync'));
    $('edSave').addEventListener('click', save);
    $('edCancel').addEventListener('click', closeEditor);
    $('editor').addEventListener('cancel', (e) => { e.preventDefault(); closeEditor(); });
    $('syStamp').addEventListener('click', stamp);
    $('syBack').addEventListener('click', back);
    $('syPlay').addEventListener('click', () => C.engine.toggle());
    $('syMinus').addEventListener('click', () => nudge(false, -100));
    $('syPlus').addEventListener('click', () => nudge(false, 100));
    $('syAllMinus').addEventListener('click', () => nudge(true, -500));
    $('syAllPlus').addEventListener('click', () => nudge(true, 500));
    $('syList').addEventListener('click', (e) => {
      const li = e.target.closest('li'); if (!li) return;
      const i = Number(li.dataset.i);
      ed.pointer = i; ed.sel = i;
      if (ed.lines[i].t != null) C.engine.seek(Math.max(0, ed.lines[i].t / 1000 - 1));
      renderSync();
    });
    $('editor').addEventListener('keydown', (e) => {
      if (ed.mode !== 'sync') return;
      const tag = e.target && e.target.tagName;
      if (tag === 'BUTTON' || tag === 'SELECT' || tag === 'TEXTAREA' || tag === 'INPUT') return;
      if (e.key === 'Enter') { e.preventDefault(); stamp(); }
      else if (e.key === ' ') { e.preventDefault(); C.engine.toggle(); }
      else if (e.key === 'Backspace') { e.preventDefault(); back(); }
    });
    // keep the sync clock and the Play button label fresh while the editor is open
    setInterval(() => {
      const dlg = $('editor');
      if (!dlg.open || ed.mode !== 'sync') return;
      $('syNow').textContent = C.LRC.formatTime(msOf());
      $('syPlay').textContent = C.engine.playing ? 'Pause' : 'Play';
    }, 60);
  }

  window.LyricsUI = {
    init(ctx) { C = ctx; initEditor(); },
    load, mount, unmount, tick, openEditor,
    get editorOpen() { return !!(C && $('editor').open); },
  };
}());
