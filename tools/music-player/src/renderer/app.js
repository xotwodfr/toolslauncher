'use strict';
(function () {
  const mp = window.mp;
  const M = window.Model;
  const LRC = window.LRC;
  const $ = (id) => document.getElementById(id);
  const REDUCED = matchMedia('(prefers-reduced-motion: reduce)');

  // ---------------------------------------------------------------------------------------------------------------
  // small helpers
  // ---------------------------------------------------------------------------------------------------------------
  /** Build an element. Text always goes in as text, never as HTML. */
  function h(tag, attrs, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') e.className = v;
      else if (k === 'text') e.textContent = v;
      else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v === true ? '' : String(v));
    }
    for (const c of kids.flat()) if (c != null && c !== false) e.append(c.nodeType ? c : document.createTextNode(String(c)));
    return e;
  }

  const ICONS = {
    play: '<path d="M8 5.5v13l11-6.5z"/>',
    pause: '<rect x="6.5" y="5" width="3.8" height="14" rx="1"/><rect x="13.7" y="5" width="3.8" height="14" rx="1"/>',
    prev: '<path d="M6.5 5.5v13"/><path d="M18 5.8v12.4L9 12z"/>',
    next: '<path d="M17.5 5.5v13"/><path d="M6 5.8v12.4L15 12z"/>',
    shuffle: '<path d="M3.5 7h3.2c3.5 0 4.6 10 8.3 10h3.5M3.5 17h3.2c1.6 0 2.7-2 3.6-4M13.6 8.6C14.4 7.7 15 7 16.2 7h2.3"/><path d="M16.5 4.5L19 7l-2.5 2.5M16.5 14.5L19 17l-2.5 2.5"/>',
    repeat: '<path d="M4 11V9.5A2.5 2.5 0 0 1 6.5 7H19l-2.5-2.5M20 13v1.5a2.5 2.5 0 0 1-2.5 2.5H5l2.5 2.5"/>',
    repeat1: '<path d="M4 11V9.5A2.5 2.5 0 0 1 6.5 7H19l-2.5-2.5M20 13v1.5a2.5 2.5 0 0 1-2.5 2.5H5l2.5 2.5"/><path d="M11 10.6l1.4-1v5.4"/>',
    volume: '<path d="M4.5 9.5h3L12 6v12l-4.5-3.5h-3z"/><path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11"/>',
    mute: '<path d="M4.5 9.5h3L12 6v12l-4.5-3.5h-3z"/><path d="M16 9.5l5 5M21 9.5l-5 5"/>',
    lyrics: '<path d="M4 6.5h16M4 11h16M4 15.5h9"/><path d="M17 14v5M14.5 16.5h5"/>',
    queue: '<path d="M4 7h12M4 12h12M4 17h7"/><path d="M17 14.5v5l4-2.5z"/>',
    sound: '<path d="M5 4v16M12 4v16M19 4v16"/><circle cx="5" cy="14" r="2" fill="var(--panel)"/><circle cx="12" cy="8" r="2" fill="var(--panel)"/><circle cx="19" cy="15" r="2" fill="var(--panel)"/>',
    sleep: '<path d="M19.5 14.5A8 8 0 1 1 9.5 4.5a6.5 6.5 0 0 0 10 10z"/>',
    mini: '<rect x="3.5" y="5" width="17" height="14" rx="2.5"/><rect x="11" y="11" width="7.5" height="5.5" rx="1"/>',
    folder: '<path d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2.5h7a2 2 0 0 1 2 2v7.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    import: '<path d="M12 4v11M7.5 10.5L12 15l4.5-4.5M5 19.5h14"/>',
    more: '<circle cx="5.5" cy="12" r="1.4" fill="currentColor"/><circle cx="12" cy="12" r="1.4" fill="currentColor"/><circle cx="18.5" cy="12" r="1.4" fill="currentColor"/>',
    sortdir: '<path d="M8 5v14M4.5 15.5L8 19l3.5-3.5M16 19V5M12.5 8.5L16 5l3.5 3.5"/>',
    note: '<path d="M9 18V6.5l10-2.2V16"/><circle cx="6.5" cy="18" r="2.6"/><circle cx="16.5" cy="16" r="2.6"/>',
  };
  const svg = (name) => `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] || ''}</svg>`;
  const setIcon = (el, name) => { el.innerHTML = svg(name); };

  let toastTimer = null;
  function toast(msg, isErr) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.toggle('err', !!isErr);
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), isErr ? 6000 : 3200);
  }
  const errText = (e) => String((e && e.message) || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

  /** Small question dialog. Resolves true/false, or the typed text / null when `input` is given. */
  function ask({ title, text = '', ok = 'OK', input = false, value = '', danger = false }) {
    return new Promise((resolve) => {
      const dlg = $('ask');
      $('askTitle').textContent = title;
      $('askText').textContent = text;
      $('askText').hidden = !text;
      const inp = $('askInput');
      inp.hidden = !input; inp.value = value;
      $('askOk').textContent = ok;
      $('askOk').classList.toggle('danger', danger);
      const done = (result) => { dlg.removeEventListener('close', onClose); resolve(result); };
      const onClose = () => done(dlg.returnValue === 'ok' ? (input ? inp.value.trim() || null : true) : (input ? null : false));
      dlg.addEventListener('close', onClose);
      dlg.returnValue = 'cancel';
      dlg.showModal();
      if (input) { inp.focus(); inp.select(); }
    });
  }

  // ---------------------------------------------------------------------------------------------------------------
  // state
  // ---------------------------------------------------------------------------------------------------------------
  const S = {
    settings: null, root: '', tracks: [], byRel: new Map(), hay: [], idx: { albums: [], artists: [] },
    view: 'songs', arg: null, back: null, query: '',
    q: { items: [], original: [], pos: -1 },
    playlists: { lists: [] },
    currentRel: '', playing: false,
    scanning: false, progress: null, skipped: {}, errors: 0, cachedStart: false,
    list: null, errorStreak: 0, miniOn: false,
    sleep: { until: 0, endOfSong: false, fading: false },
  };
  const engine = new window.Engine();

  const trackOf = (rel) => S.byRel.get(rel);
  const urlFor = (rel) => 'mpm://t/' + rel.split('/').map(encodeURIComponent).join('/');
  const coverUrl = (rel, size) => 'mpm://c/' + rel.split('/').map(encodeURIComponent).join('/') + (size ? '?s=' + size : '');
  const baseName = (p) => p.split(/[\\/]/).filter(Boolean).pop() || p;

  function saveSettings(patch) {
    S.settings = { ...S.settings, ...patch };
    mp.setSettings(patch).then((s) => { S.settings = s; }).catch(() => {});
  }

  // ---------------------------------------------------------------------------------------------------------------
  // covers
  // ---------------------------------------------------------------------------------------------------------------
  let coverObserver = null;
  /** Show a song's cover as the element's background. `lazy` (grids only) waits until the element scrolls into view. */
  function setCover(el, track, size, lazy) {
    el.classList.add('cover');
    if (!track || !track.cover) { el.classList.add('ph'); el.style.backgroundImage = ''; return; }
    el.classList.remove('ph');
    const url = coverUrl(track.rel, size);
    if (!lazy || !('IntersectionObserver' in window)) { el.style.backgroundImage = `url("${url}")`; return; }
    el.dataset.bg = url;
    if (!coverObserver) {
      coverObserver = new IntersectionObserver((entries) => {
        for (const en of entries) if (en.isIntersecting) { const t = en.target; if (t.dataset.bg) t.style.backgroundImage = `url("${t.dataset.bg}")`; delete t.dataset.bg; coverObserver.unobserve(t); }
      }, { root: $('view'), rootMargin: '300px' });
    }
    coverObserver.observe(el);
  }

  // ---------------------------------------------------------------------------------------------------------------
  // menus
  // ---------------------------------------------------------------------------------------------------------------
  let menuReturn = null;
  function closeMenu() { const m = $('menu'); if (!m.hidden) { m.hidden = true; m.textContent = ''; if (menuReturn && menuReturn.isConnected) menuReturn.focus(); menuReturn = null; } }
  /** items: { label, run, danger } | { caption } | { sep: true } */
  function showMenu(x, y, items, returnTo) {
    closeMenu(); closePops();
    const m = $('menu');
    m.textContent = '';
    for (const it of items) {
      if (!it) continue;
      if (it.sep) m.append(h('hr'));
      else if (it.caption) m.append(h('div', { class: 'cap', text: it.caption }));
      else m.append(h('button', { role: 'menuitem', class: it.danger ? 'danger' : '', text: it.label, title: it.label, onclick: () => { closeMenu(); it.run(); } }));
    }
    m.hidden = false;
    menuReturn = returnTo || null;
    const r = m.getBoundingClientRect();
    m.style.left = Math.max(8, Math.min(x, innerWidth - r.width - 8)) + 'px';
    m.style.top = Math.max(8, Math.min(y, innerHeight - r.height - 8)) + 'px';
    const first = m.querySelector('button');
    if (first) first.focus();
  }
  document.addEventListener('mousedown', (e) => { if (!$('menu').hidden && !$('menu').contains(e.target)) closeMenu(); }, true);
  $('menu').addEventListener('keydown', (e) => {
    const btns = [...$('menu').querySelectorAll('button')];
    const i = btns.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); btns[(i + 1) % btns.length].focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); btns[(i - 1 + btns.length) % btns.length].focus(); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeMenu(); }
    else if (e.key === 'Tab') { e.preventDefault(); closeMenu(); }
  });
  const menuAtButton = (btn, items) => { const r = btn.getBoundingClientRect(); showMenu(r.left, r.bottom + 4, items, btn); };

  // ---------------------------------------------------------------------------------------------------------------
  // playback: queue
  // ---------------------------------------------------------------------------------------------------------------
  const rgFactor = (t) => {
    const rg = S.settings.rg;
    return rg.mode === 'off' ? 1 : M.gainFactor(M.replayGainFor(t, rg.mode), rg.preamp);
  };

  function startQueue(rels, startPos) {
    const q = S.q;
    q.original = rels.slice();
    if (S.settings.shuffle) { q.items = M.shuffled(rels, rels[startPos]); q.pos = 0; } else { q.items = rels.slice(); q.pos = startPos; }
    playAt(q.pos);
  }

  async function playAt(pos, opts = {}) {
    const q = S.q;
    if (pos < 0 || pos >= q.items.length) return;
    const rel = q.items[pos];
    const t = trackOf(rel);
    q.pos = pos;
    if (!t) { skipAfterError(rel, 'is missing'); return; }
    S.currentRel = rel;
    S.playing = !opts.paused;
    onTrackChanged();
    await engine.play(urlFor(rel), rel, rgFactor(t), opts.startAt || 0, !!opts.paused);
    schedulePreload();
  }

  /** Where "next" goes from the current position (or -1 = stop). `auto` = natural end of song (repeat-one stays). */
  function nextPos(auto) {
    const q = S.q;
    if (!q.items.length) return -1;
    if (auto && S.settings.repeat === 'one') return q.pos;
    if (q.pos + 1 < q.items.length) return q.pos + 1;
    return S.settings.repeat === 'off' ? -1 : 0;
  }

  function schedulePreload() {
    if (S.sleep.endOfSong) { engine.clearPreload(); return; }
    const np = nextPos(true);
    if (np < 0) { engine.clearPreload(); return; }
    const rel = S.q.items[np];
    const t = trackOf(rel);
    if (!t) { engine.clearPreload(); return; }
    engine.preload(urlFor(rel), rel, rgFactor(t));
  }

  function next() {
    const q = S.q;
    if (!q.items.length) return;
    if (q.pos + 1 < q.items.length) playAt(q.pos + 1);
    else if (S.settings.repeat !== 'off') playAt(0);
    else { engine.seek(0); engine.pause(); }
  }
  function prev() {
    const q = S.q;
    if (!q.items.length) return;
    if (engine.position > 3 || q.pos === 0) { if (q.pos === 0 && engine.position <= 3 && S.settings.repeat === 'all' && q.items.length > 1) playAt(q.items.length - 1); else engine.seek(0); }
    else playAt(q.pos - 1);
  }
  function skipAfterError(rel, why) {
    const t = trackOf(rel);
    toast(`Can't play "${t ? M.titleOf(t) : baseName(rel)}" (${why || 'unsupported or damaged'}).`, true);
    S.errorStreak++;
    if (S.errorStreak >= 5) { S.errorStreak = 0; engine.stop(); S.playing = false; updateTransport(); return; }
    if (nextPos(false) >= 0) setTimeout(next, 50);
  }

  engine.on('advance', ({ rel }) => {
    const q = S.q;
    const np = nextPos(true);
    q.pos = np >= 0 ? np : q.pos;
    S.currentRel = rel; S.playing = true; S.errorStreak = 0;
    onTrackChanged();
    schedulePreload();
  });
  engine.on('ended', () => {
    if (S.sleep.endOfSong) { cancelSleep(); S.playing = false; updateTransport(); return; }
    const np = nextPos(true);
    if (np >= 0) playAt(np); else { S.playing = false; engine.seek(0); updateTransport(); saveLast(true); }
  });
  engine.on('state', ({ playing }) => { S.playing = playing; if (playing) S.errorStreak = 0; updateTransport(); if (!playing) saveLast(true); });
  engine.on('error', ({ rel }) => skipAfterError(rel));
  engine.on('preload-error', () => { /* the song is tried normally when its turn comes */ });

  function addToQueue(rels, where) {
    if (!rels.length) return;
    const q = S.q;
    if (!q.items.length || !S.currentRel) { startQueue(rels, 0); toast(`Playing ${rels.length} song${rels.length > 1 ? 's' : ''}`); return; }
    if (where === 'next') {
      q.items.splice(q.pos + 1, 0, ...rels);
      const at = q.original.indexOf(S.currentRel);
      q.original.splice(at < 0 ? q.original.length : at + 1, 0, ...rels);
    } else { q.items.push(...rels); q.original.push(...rels); }
    toast(where === 'next' ? `Playing next: ${rels.length === 1 ? M.titleOf(trackOf(rels[0])) : rels.length + ' songs'}` : `Added ${rels.length === 1 ? 'a song' : rels.length + ' songs'} to the queue`);
    schedulePreload(); updateCounts(); if (S.view === 'queue') render();
  }
  /** Drop queued songs that are no longer in the library (after a rescan), keeping the playing position right. */
  function pruneQueue() {
    const q = S.q;
    if (q.items.every((r) => trackOf(r))) return;
    let pos = q.pos;
    const keep = [];
    q.items.forEach((r, i) => { if (trackOf(r) || (i === q.pos && r === S.currentRel)) keep.push(r); else if (i < q.pos) pos--; });
    q.items = keep; q.original = q.original.filter((r) => trackOf(r) || r === S.currentRel); q.pos = Math.max(-1, Math.min(pos, keep.length - 1));
    updateCounts();
  }
  function removeFromQueue(pos) {
    const q = S.q;
    if (pos < 0 || pos >= q.items.length) return;
    const [rel] = q.items.splice(pos, 1);
    const oi = q.original.indexOf(rel); if (oi >= 0) q.original.splice(oi, 1);
    if (pos < q.pos) q.pos--;
    else if (pos === q.pos) { if (q.items.length) { q.pos = Math.min(q.pos, q.items.length - 1); playAt(q.pos); } else { engine.stop(); S.currentRel = ''; S.playing = false; onTrackChanged(); } }
    schedulePreload(); updateCounts();
  }
  function moveInQueue(pos, delta) {
    const q = S.q; const to = pos + delta;
    if (to < 0 || to >= q.items.length) return pos;
    const [rel] = q.items.splice(pos, 1); q.items.splice(to, 0, rel);
    if (q.pos === pos) q.pos = to; else if (pos < q.pos && to >= q.pos) q.pos--; else if (pos > q.pos && to <= q.pos) q.pos++;
    schedulePreload();
    return to;
  }
  function setShuffle(on) {
    const q = S.q;
    saveSettings({ shuffle: on });
    if (q.items.length && S.currentRel) {
      if (on) { q.items = M.shuffled(q.original, S.currentRel); q.pos = 0; }
      else { q.items = q.original.slice(); q.pos = Math.max(0, q.items.indexOf(S.currentRel)); }
      schedulePreload();
    }
    updateTransport(); if (S.view === 'queue') render();
  }
  function cycleRepeat() { const order = ['off', 'all', 'one']; saveSettings({ repeat: order[(order.indexOf(S.settings.repeat) + 1) % 3] }); schedulePreload(); updateTransport(); }

  // ---------------------------------------------------------------------------------------------------------------
  // bar, transport, media session
  // ---------------------------------------------------------------------------------------------------------------
  function onTrackChanged() {
    const t = trackOf(S.currentRel);
    $('barTitle').textContent = t ? M.titleOf(t) : 'Nothing playing';
    $('barArtist').textContent = t ? M.artistOf(t) : '';
    setCover($('barCover'), t, 120);
    document.title = t ? `${M.titleOf(t)} — ${M.artistOf(t)}` : 'Music Player';
    $('seek').disabled = !t;
    updateTransport();
    updateMediaSession(t);
    window.LyricsUI.load(S.currentRel);
    if (S.view === 'now') renderNowLeft();
    if (S.list) S.list.repaint();
    lastPos = -1;
  }

  function updateTransport() {
    const p = S.playing && engine.playing !== false;
    const play = $('bPlay');
    setIcon(play, S.playing ? 'pause' : 'play');
    play.setAttribute('aria-label', S.playing ? 'Pause' : 'Play');
    document.body.classList.toggle('paused', !S.playing);
    $('bShuffle').setAttribute('aria-pressed', String(S.settings.shuffle));
    const r = S.settings.repeat;
    setIcon($('bRepeat'), r === 'one' ? 'repeat1' : 'repeat');
    $('bRepeat').setAttribute('aria-pressed', String(r !== 'off'));
    $('bRepeat').setAttribute('aria-label', 'Repeat: ' + (r === 'off' ? 'off' : r === 'all' ? 'all songs' : 'this song'));
    const muted = S.settings.muted || S.settings.volume === 0;
    setIcon($('bMute'), muted ? 'mute' : 'volume');
    $('bMute').setAttribute('aria-label', muted ? 'Unmute' : 'Mute');
    $('bLyrics').setAttribute('aria-pressed', String(S.view === 'now'));
    $('bQueue').setAttribute('aria-pressed', String(S.view === 'queue'));
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = t0() ? (S.playing ? 'playing' : 'paused') : 'none';
    void p;
  }
  const t0 = () => !!S.currentRel;

  let artUrl = '';
  function updateMediaSession(t) {
    if (!('mediaSession' in navigator)) return;
    if (!t) { navigator.mediaSession.metadata = null; return; }
    const make = (artwork) => { try { navigator.mediaSession.metadata = new MediaMetadata({ title: M.titleOf(t), artist: M.artistOf(t), album: M.albumOf(t), artwork }); } catch { /* ignore */ } };
    make([]);
    if (!t.cover) return;
    // The OS only accepts http/https/data/blob artwork, so the cover is fetched from our own scheme and handed over as a blob.
    fetch(coverUrl(t.rel, 512)).then((r) => (r.ok ? r.blob() : null)).then((b) => {
      if (!b || S.currentRel !== t.rel) return;
      if (artUrl) URL.revokeObjectURL(artUrl);
      artUrl = URL.createObjectURL(b);
      make([{ src: artUrl, sizes: '512x512', type: b.type || 'image/jpeg' }]);
    }).catch(() => {});
  }
  function initMediaSession() {
    if (!('mediaSession' in navigator)) return;
    const set = (a, fn) => { try { navigator.mediaSession.setActionHandler(a, fn); } catch { /* not supported */ } };
    set('play', () => engine.resume());
    set('pause', () => engine.pause());
    set('stop', () => { engine.pause(); engine.seek(0); });
    set('previoustrack', prev);
    set('nexttrack', next);
    set('seekbackward', (d) => engine.seek(engine.position - (d.seekOffset || 10)));
    set('seekforward', (d) => engine.seek(engine.position + (d.seekOffset || 10)));
    set('seekto', (d) => engine.seek(d.seekTime || 0));
  }

  function fillRange(input) { input.style.setProperty('--p', ((input.value - input.min) / (input.max - input.min)) * 100 + '%'); }
  let seeking = false;
  let lastPos = -1;
  let lastDur = -1;
  let lastSave = 0;

  function frame() {
    requestAnimationFrame(frame);
    const dur = engine.duration;
    const pos = engine.position;
    if (!seeking) {
      const sec = Math.floor(pos);
      if (sec !== lastPos || dur !== lastDur) {
        lastPos = sec; lastDur = dur;
        $('tNow').textContent = M.formatDuration(pos * 1000);
        $('tTotal').textContent = dur ? M.formatDuration(dur * 1000) : (trackOf(S.currentRel) ? M.formatDuration(trackOf(S.currentRel).durationMs) : '0:00');
      }
      const v = dur ? Math.round((pos / dur) * 1000) : 0;
      if (Number($('seek').value) !== v) { $('seek').value = v; }
      fillRange($('seek'));
    }
    if (S.view === 'now') { window.LyricsUI.tick(); drawViz(); }
    const now = performance.now();
    if (S.playing && now - lastSave > 5000) { lastSave = now; saveLast(false); }
    if (S.sleep.until) sleepTick();
  }

  function saveLast(force) {
    if (!S.currentRel) return;
    if (!force && !S.playing) return;
    S.settings.last = { rel: S.currentRel, pos: Math.floor(engine.position) };
    mp.setSettings({ last: S.settings.last }).catch(() => {});
  }
  window.addEventListener('beforeunload', () => saveLast(true));

  // ---------------------------------------------------------------------------------------------------------------
  // track list (virtual)
  // ---------------------------------------------------------------------------------------------------------------
  const ROW = 52;
  /**
   * @param {number[]} items  indexes into S.tracks (for the queue: indexes of the queued songs, in order)
   * @param {{virtual?:boolean, numbering?:'pos'|'track', queue?:boolean, onPlay?:(pos:number)=>void, onRemove?:(pos:number)=>void, onMove?:(pos:number,d:number)=>number, removeLabel?:string, empty?:string}} o
   */
  function trackList(items, o = {}) {
    const virtual = o.virtual !== false && items.length > 0;
    const root = h('div', { class: 'tl' + (virtual ? '' : ' inflow') });
    const head = h('div', { class: 'thead', 'aria-hidden': 'true' }, h('span', { class: 'r', text: '#' }), h('span', { text: 'Title' }), h('span', { text: 'Album' }), h('span', { class: 'r', text: 'Year' }), h('span', { class: 'r', text: 'Time' }), h('span'));
    const vport = h('div', { class: virtual ? 'vport' : '', role: 'listbox', tabindex: '0', 'aria-label': o.label || 'Songs', 'aria-multiselectable': 'false' });
    const space = h('div', { class: 'vspace' });
    vport.append(space);
    root.append(head, vport);
    let sel = -1;
    let first = 0; let last = 0;

    if (!items.length) { root.textContent = ''; root.append(h('div', { class: 'emptylist', text: o.empty || 'Nothing here yet.' })); return { el: root, items, repaint() {}, select() {} }; }
    if (virtual) space.style.height = items.length * ROW + 'px';

    const isPlaying = (pos) => (o.queue ? pos === S.q.pos && !!S.currentRel : trackOf(S.tracks[items[pos]].rel) && S.tracks[items[pos]].rel === S.currentRel);

    function rowEl(pos) {
      const t = S.tracks[items[pos]];
      const playing = isPlaying(pos);
      const r = h('div', { class: 'row-t' + (playing ? ' playing' : '') + (pos === sel ? ' sel' : ''), role: 'option', id: 'r' + pos, 'data-pos': pos, 'aria-selected': String(pos === sel) });
      const num = o.numbering === 'track' ? (t.track || '') : pos + 1;
      const n = h('div', { class: 'n' }, h('span', { class: 'num', text: String(num) }),
        h('span', { class: 'eqi' }, h('i'), h('i'), h('i')),
        h('button', { class: 'go', tabindex: '-1', 'aria-label': 'Play ' + M.titleOf(t), html: null }));
      n.querySelector('.go').innerHTML = svg('play');
      const more = h('button', { class: 'iconbtn more', tabindex: '-1', 'aria-label': 'More actions for ' + M.titleOf(t), title: 'More' });
      setIcon(more, 'more');
      r.append(n,
        h('div', { class: 'cell' }, h('span', { class: 'tt', text: M.titleOf(t), title: M.titleOf(t) }), h('span', { class: 'sub', text: M.artistOf(t) })),
        h('div', { class: 'cell', text: M.albumOf(t), title: M.albumOf(t) }),
        h('div', { class: 'cell r', text: t.year ? String(t.year) : '' }),
        h('div', { class: 'cell r', text: t.durationMs ? M.formatDuration(t.durationMs) : '' }),
        more);
      if (virtual) r.style.top = pos * ROW + 'px';
      return r;
    }

    function paint(force) {
      let a = 0; let b = items.length;
      if (virtual) {
        const top = vport.scrollTop; const hgt = vport.clientHeight || 600;
        a = Math.max(0, Math.floor(top / ROW) - 6); b = Math.min(items.length, Math.ceil((top + hgt) / ROW) + 6);
        if (!force && a === first && b === last) return;
      } else if (!force && last === b) return;
      first = a; last = b;
      space.textContent = '';
      const frag = document.createDocumentFragment();
      for (let p = a; p < b; p++) frag.append(rowEl(p));
      space.append(frag);
      if (sel >= 0) vport.setAttribute('aria-activedescendant', 'r' + sel);
    }
    /** Mark the selected row in place. Rows are NOT rebuilt on a click: a rebuilt row would swallow the second click of a double-click. */
    function markSel() {
      for (const r of space.children) { const on = Number(r.dataset.pos) === sel; r.classList.toggle('sel', on); r.setAttribute('aria-selected', String(on)); }
      if (sel >= 0) vport.setAttribute('aria-activedescendant', 'r' + sel);
    }
    function select(pos, scroll = true) {
      sel = Math.max(0, Math.min(items.length - 1, pos));
      if (scroll && virtual) {
        const top = sel * ROW; const hgt = vport.clientHeight;
        if (top < vport.scrollTop) vport.scrollTop = top;
        else if (top + ROW > vport.scrollTop + hgt) vport.scrollTop = top + ROW - hgt;
      }
      paint(false);
      if (scroll && !virtual) { const el = space.children[sel]; if (el) el.scrollIntoView({ block: 'nearest' }); }
      markSel();
    }
    const play = (pos) => {
      if (o.onPlay) o.onPlay(pos);
      else startQueue(items.map((i) => S.tracks[i].rel), pos);
    };
    function menuFor(pos, x, y, ret) {
      const t = S.tracks[items[pos]];
      const rels = [t.rel];
      const entries = [
        { label: 'Play', run: () => play(pos) },
        { label: 'Play next', run: () => addToQueue(rels, 'next') },
        { label: 'Add to queue', run: () => addToQueue(rels, 'end') },
        { sep: true },
        ...playlistMenuItems(rels),
        { sep: true },
        { label: 'Go to album', run: () => go('albums', M.albumKey(t)) },
        { label: 'Go to artist', run: () => go('artists', t._aa || M.albumArtistOf(t)) },
        { label: 'Show in folder', run: () => mp.reveal(t.rel).catch((e) => toast(errText(e), true)) },
        { label: 'Edit tags in Audio Tagger', run: () => openTagger(t.rel) },
      ];
      if (o.onMove) entries.push({ sep: true }, { label: 'Move up (Alt+↑)', run: () => { const to = o.onMove(pos, -1); select(to); } }, { label: 'Move down (Alt+↓)', run: () => { const to = o.onMove(pos, 1); select(to); } });
      if (o.onRemove) entries.push({ sep: true }, { label: o.removeLabel || 'Remove', danger: true, run: () => o.onRemove(pos) });
      showMenu(x, y, entries, ret);
    }

    space.addEventListener('click', (e) => {
      const row = e.target.closest('.row-t'); if (!row) return;
      const pos = Number(row.dataset.pos);
      if (e.target.closest('.go')) { select(pos, false); play(pos); return; }
      if (e.target.closest('.more')) { select(pos, false); const r = e.target.closest('.more').getBoundingClientRect(); menuFor(pos, r.left, r.bottom + 4, vport); return; }
      select(pos, false); vport.focus({ preventScroll: true });
    });
    space.addEventListener('dblclick', (e) => { const row = e.target.closest('.row-t'); if (row && !e.target.closest('.more')) play(Number(row.dataset.pos)); });
    space.addEventListener('contextmenu', (e) => { const row = e.target.closest('.row-t'); if (!row) return; e.preventDefault(); const pos = Number(row.dataset.pos); select(pos, false); menuFor(pos, e.clientX, e.clientY, vport); });
    vport.addEventListener('keydown', (e) => {
      const page = Math.max(1, Math.floor((vport.clientHeight || 400) / ROW) - 1);
      const cur = sel < 0 ? 0 : sel;
      let handled = true;
      if (e.altKey && o.onMove && (e.key === 'ArrowUp' || e.key === 'ArrowDown') && sel >= 0) { select(o.onMove(sel, e.key === 'ArrowUp' ? -1 : 1)); }
      else if (e.key === 'ArrowDown') select(sel < 0 ? 0 : cur + 1);
      else if (e.key === 'ArrowUp') select(sel < 0 ? 0 : cur - 1);
      else if (e.key === 'PageDown') select(cur + page);
      else if (e.key === 'PageUp') select(cur - page);
      else if (e.key === 'Home') select(0);
      else if (e.key === 'End') select(items.length - 1);
      else if (e.key === 'Enter' && sel >= 0) play(sel);
      else if (e.key === 'Delete' && o.onRemove && sel >= 0) { const s = sel; o.onRemove(s); sel = Math.min(s, items.length - 2); }
      else if ((e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) && sel >= 0) { const el = $('r' + sel); const r = el ? el.getBoundingClientRect() : vport.getBoundingClientRect(); menuFor(sel, r.left + 40, r.bottom, vport); }
      else handled = false;
      if (handled) e.preventDefault();
    });
    vport.addEventListener('focus', () => { if (sel < 0 && items.length) { sel = 0; markSel(); } });
    if (virtual) vport.addEventListener('scroll', () => paint(false), { passive: true });
    queueMicrotask(() => paint(true));
    new ResizeObserver(() => paint(false)).observe(vport);

    const api = { el: root, items, repaint: () => paint(true), select, vport };
    return api;
  }

  // ---------------------------------------------------------------------------------------------------------------
  // playlists
  // ---------------------------------------------------------------------------------------------------------------
  async function savePlaylists() {
    try { S.playlists = await mp.savePlaylists(S.playlists); } catch (e) { toast(errText(e), true); }
    renderPlaylistsNav();
  }
  const newId = () => 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  async function createPlaylist(rels = [], suggested = '') {
    const name = await ask({ title: 'New playlist', input: true, value: suggested, ok: 'Create' });
    if (!name) return null;
    const pl = { id: newId(), name, tracks: [...new Set(rels)] };
    S.playlists.lists.push(pl);
    await savePlaylists();
    toast(`Created "${name}"` + (rels.length ? ` with ${pl.tracks.length} song${pl.tracks.length === 1 ? '' : 's'}` : ''));
    return pl;
  }
  function playlistMenuItems(rels) {
    const items = [{ caption: 'ADD TO PLAYLIST' }];
    for (const pl of S.playlists.lists.slice(0, 12)) {
      items.push({ label: pl.name, run: async () => {
        const have = new Set(pl.tracks);
        const add = rels.filter((r) => !have.has(r));
        if (!add.length) { toast(`Already in "${pl.name}"`); return; }
        pl.tracks.push(...add); await savePlaylists(); toast(`Added ${add.length === 1 ? 'a song' : add.length + ' songs'} to "${pl.name}"`);
        if (S.view === 'playlist' && S.arg === pl.id) render();
      } });
    }
    items.push({ label: 'New playlist…', run: () => createPlaylist(rels) });
    return items;
  }
  function renderPlaylistsNav() {
    const ul = $('plList');
    ul.textContent = '';
    if (!S.playlists.lists.length) ul.append(h('li', { class: 'empty', text: 'No playlists yet' }));
    for (const pl of S.playlists.lists) {
      const b = h('button', { 'aria-current': S.view === 'playlist' && S.arg === pl.id ? 'page' : null, onclick: () => go('playlist', pl.id) }, h('span', { class: 'nm', text: pl.name }), h('span', { class: 'count', text: String(pl.tracks.length) }));
      b.addEventListener('contextmenu', (e) => { e.preventDefault(); playlistMenu(pl, e.clientX, e.clientY, b); });
      ul.append(h('li', {}, b));
    }
  }
  function playlistMenu(pl, x, y, ret) {
    const rels = () => pl.tracks.filter((r) => trackOf(r));
    showMenu(x, y, [
      { label: 'Play', run: () => rels().length && startQueue(rels(), 0) },
      { label: 'Add to queue', run: () => addToQueue(rels(), 'end') },
      { sep: true },
      { label: 'Rename…', run: async () => { const n = await ask({ title: 'Rename playlist', input: true, value: pl.name, ok: 'Rename' }); if (n) { pl.name = n; await savePlaylists(); if (S.view === 'playlist') render(); } } },
      { label: 'Export as M3U8…', run: () => exportPlaylist(pl) },
      { label: 'Delete', danger: true, run: async () => { if (await ask({ title: `Delete "${pl.name}"?`, text: 'The songs themselves are not deleted.', ok: 'Delete', danger: true })) { S.playlists.lists = S.playlists.lists.filter((p) => p !== pl); await savePlaylists(); if (S.view === 'playlist' && S.arg === pl.id) go('songs'); } } },
    ], ret);
  }
  async function exportPlaylist(pl) {
    try { const r = await mp.exportPlaylist(pl.name, pl.tracks); if (r) toast(`Exported ${r.count} songs to ${baseName(r.file)}`); } catch (e) { toast(errText(e), true); }
  }
  async function importPlaylist() {
    try {
      const r = await mp.importPlaylist();
      if (!r) return;
      if (!r.tracks.length) { toast(`None of the ${r.missing} songs in that playlist are in this music folder.`, true); return; }
      S.playlists.lists.push({ id: newId(), name: r.name, tracks: r.tracks });
      await savePlaylists();
      toast(`Imported "${r.name}": ${r.tracks.length} songs` + (r.missing ? ` (${r.missing} not found in this folder)` : ''));
      go('playlist', S.playlists.lists[S.playlists.lists.length - 1].id);
    } catch (e) { toast(errText(e), true); }
  }

  async function openTagger(rel) {
    try { const r = await mp.openInTagger(rel); if (!r.ok) toast(r.reason, true); } catch (e) { toast(errText(e), true); }
  }

  // ---------------------------------------------------------------------------------------------------------------
  // views
  // ---------------------------------------------------------------------------------------------------------------
  const TITLES = { songs: 'Songs', albums: 'Albums', artists: 'Artists', folders: 'Folders', queue: 'Queue', now: 'Now playing', playlist: 'Playlist' };

  function go(view, arg = null, from = null) {
    S.back = from;
    S.view = view; S.arg = arg;
    if (['songs', 'albums', 'artists', 'folders', 'queue', 'now'].includes(view) && !arg) saveSettings({ view });
    closeMenu(); closePops();
    render();
  }

  function updateCounts() {
    $('cSongs').textContent = S.tracks.length ? S.tracks.length.toLocaleString() : '';
    $('cAlbums').textContent = S.idx.albums.length ? S.idx.albums.length.toLocaleString() : '';
    $('cArtists').textContent = S.idx.artists.length ? S.idx.artists.length.toLocaleString() : '';
    $('cQueue').textContent = S.q.items.length ? S.q.items.length.toLocaleString() : '';
  }

  function render() {
    const view = $('view');
    LyricsUIunmountIfNeeded();
    S.list = null;
    view.textContent = '';
    view.className = 'view';
    view.scrollTop = 0;
    for (const b of document.querySelectorAll('.navbtn')) { if (b.dataset.view === S.view && !S.arg) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); }
    renderPlaylistsNav();
    $('viewTitle').textContent = TITLES[S.view] || 'Songs';
    const searchable = ['songs', 'albums', 'artists'].includes(S.view) && !S.arg;
    $('search').disabled = !searchable;
    $('sortWrap').hidden = S.view !== 'songs';
    $('sortDir').hidden = S.view !== 'songs';
    updateTransport();
    if (!S.root) { renderHero(view); return; }
    if (!S.tracks.length && !S.scanning) { renderHero(view, true); return; }
    switch (S.view) {
      case 'songs': renderSongs(view); break;
      case 'albums': S.arg ? renderAlbumDetail(view) : renderAlbums(view); break;
      case 'artists': S.arg ? renderArtistDetail(view) : renderArtists(view); break;
      case 'folders': renderFolders(view); break;
      case 'queue': renderQueue(view); break;
      case 'playlist': renderPlaylist(view); break;
      case 'now': renderNow(view); break;
      default: renderSongs(view);
    }
  }
  let lyricsMounted = false;
  function LyricsUIunmountIfNeeded() { if (lyricsMounted) { window.LyricsUI.unmount(); lyricsMounted = false; } vizCanvas = null; }

  function mountList(view, api, fill = true) {
    view.classList.toggle('vlist', fill);
    view.append(api.el);
    S.list = api;
    return api;
  }

  function renderHero(view, empty) {
    view.append(h('div', { class: 'hero' },
      h('div', { class: 'big', html: null }),
      h('h2', { text: empty ? 'No playable music found' : 'Play your own music' }),
      h('p', { class: 'muted', text: empty ? 'This folder has no MP3, FLAC, OGG, Opus, M4A, AAC or WAV files. Pick another folder.' : 'Choose a folder and Music Player plays everything inside it, with covers, tags and lyrics. Nothing is uploaded and your files are never changed.' }),
      h('button', { class: 'btn primary', text: 'Choose music folder…', onclick: chooseFolder }),
      S.settings.recent.length ? h('div', { class: 'recent' }, h('span', { class: 'muted small', text: 'RECENT FOLDERS' }), S.settings.recent.map((r) => h('button', { text: r, title: r, onclick: () => openFolder(r) }))) : null,
      h('p', { class: 'muted small', text: 'You can also drop a folder anywhere on this window.' })));
    view.querySelector('.big').innerHTML = svg('note');
  }

  function songIndexes() {
    const hits = M.search(S.tracks, S.query, S.hay);
    const { by, dir } = S.settings.sort;
    return M.sortedIndexes(S.tracks, by, dir, hits);
  }
  function renderSongs(view) {
    const items = songIndexes();
    const api = trackList(items, { label: 'Songs', empty: S.query ? `No songs match "${S.query}".` : 'No songs.', numbering: 'pos' });
    mountList(view, api);
    if (items.length) view.append(h('div', { class: 'listfoot', text: `${items.length.toLocaleString()} song${items.length === 1 ? '' : 's'}` + (S.query ? ' found' : '') + ' · ' + M.formatTotal(items.reduce((s, i) => s + (S.tracks[i].durationMs || 0), 0)) }));
  }

  function albumCard(a, ai, fromView) {
    const t = S.tracks[a.coverTrack];
    const cover = h('span', { class: 'cover' });
    const fab = h('button', { class: 'playfab', tabindex: '-1', 'aria-label': 'Play ' + a.title, onclick: (e) => { e.stopPropagation(); startQueue(a.tracks.map((i) => S.tracks[i].rel), 0); } });
    fab.innerHTML = svg('play');
    cover.append(fab);
    const card = h('button', { class: 'card', title: `${a.title} — ${a.artist}`, onclick: () => go('albums', a.key, fromView) }, cover,
      h('span', { class: 'cname', text: a.title }), h('span', { class: 'csub', text: `${a.artist}${a.year ? ' · ' + a.year : ''}` }));
    card.addEventListener('contextmenu', (e) => { e.preventDefault(); albumMenu(a, e.clientX, e.clientY, card); });
    setCover(cover, t, 300, true);
    return card;
  }
  function albumMenu(a, x, y, ret) {
    const rels = a.tracks.map((i) => S.tracks[i].rel);
    showMenu(x, y, [
      { label: 'Play', run: () => startQueue(rels, 0) },
      { label: 'Shuffle', run: () => { saveSettings({ shuffle: true }); startQueue(rels, Math.floor(Math.random() * rels.length)); } },
      { label: 'Play next', run: () => addToQueue(rels, 'next') },
      { label: 'Add to queue', run: () => addToQueue(rels, 'end') },
      { sep: true }, ...playlistMenuItems(rels),
    ], ret);
  }

  function renderAlbums(view) {
    const words = M.fold(S.query).split(/\s+/).filter(Boolean);
    const albums = S.idx.albums.map((a, i) => ({ a, i })).filter(({ a }) => !words.length || words.every((w) => M.fold(a.title + ' ' + a.artist + ' ' + (a.year || '')).includes(w)));
    if (!albums.length) { view.append(h('div', { class: 'emptylist', text: `No albums match "${S.query}".` })); return; }
    const grid = h('div', { class: 'grid' });
    const frag = document.createDocumentFragment();
    for (const { a, i } of albums) frag.append(albumCard(a, i, { view: 'albums', arg: null }));
    grid.append(frag);
    view.append(grid);
  }

  function backButton(label) {
    const b = h('button', { class: 'btn ghost back', text: '← ' + label, onclick: () => (S.back ? go(S.back.view, S.back.arg) : go('albums')) });
    return b;
  }
  function renderAlbumDetail(view) {
    const a = S.idx.albums.find((x) => x.key === S.arg);
    if (!a) { go('albums'); return; }
    $('viewTitle').textContent = 'Album';
    const rels = a.tracks.map((i) => S.tracks[i].rel);
    const cover = h('span', { class: 'cover' });
    setCover(cover, S.tracks[a.coverTrack], 600);
    const head = h('div', { class: 'detailhead' }, cover, h('div', { class: 'info' },
      h('span', { class: 'muted small', text: 'ALBUM' }), h('h2', { text: a.title }),
      h('div', { class: 'muted' }, h('a', { href: '#', onclick: (e) => { e.preventDefault(); go('artists', a.artist, { view: 'albums', arg: a.key }); }, text: a.artist, style: null }), `${a.year ? ' · ' + a.year : ''} · ${rels.length} song${rels.length === 1 ? '' : 's'} · ${M.formatTotal(a.durationMs)}`),
      h('div', { class: 'acts' },
        h('button', { class: 'btn primary', text: 'Play', onclick: () => startQueue(rels, 0) }),
        h('button', { class: 'btn', text: 'Shuffle', onclick: () => { saveSettings({ shuffle: true }); startQueue(rels, Math.floor(Math.random() * rels.length)); } }),
        h('button', { class: 'btn', text: 'Add to queue', onclick: () => addToQueue(rels, 'end') }),
        h('button', { class: 'btn', text: 'Add to playlist…', onclick: (e) => menuAtButton(e.currentTarget, playlistMenuItems(rels)) }))));
    view.append(backButton(S.back && S.back.view === 'artists' ? 'Artist' : 'Albums'), head);
    mountList(view, trackList(a.tracks, { label: a.title, numbering: 'track', virtual: false }), false);
  }

  function renderArtists(view) {
    const words = M.fold(S.query).split(/\s+/).filter(Boolean);
    const artists = S.idx.artists.filter((a) => !words.length || words.every((w) => M.fold(a.name).includes(w)));
    if (!artists.length) { view.append(h('div', { class: 'emptylist', text: `No artists match "${S.query}".` })); return; }
    const list = h('div', { class: 'inline-list' });
    for (const a of artists) {
      list.append(h('button', { class: 'artistrow', onclick: () => go('artists', a.name, { view: 'artists', arg: null }) },
        h('span', { class: 'avatar', text: (a.name.match(/[\p{L}\p{N}]/u) || ['?'])[0].toUpperCase() }),
        h('span', {}, h('div', { text: a.name }), h('div', { class: 'muted small', text: `${a.albums.length} album${a.albums.length === 1 ? '' : 's'} · ${a.trackCount} song${a.trackCount === 1 ? '' : 's'}` }))));
    }
    view.append(list);
  }
  function renderArtistDetail(view) {
    const ar = S.idx.artists.find((x) => x.name === S.arg);
    if (!ar) { go('artists'); return; }
    $('viewTitle').textContent = ar.name;
    const rels = ar.albums.flatMap((ai) => S.idx.albums[ai].tracks.map((i) => S.tracks[i].rel));
    view.append(backButton('Artists'),
      h('div', { class: 'detailhead' }, h('span', { class: 'avatar', text: (ar.name.match(/[\p{L}\p{N}]/u) || ['?'])[0].toUpperCase() }), h('div', { class: 'info' },
        h('span', { class: 'muted small', text: 'ARTIST' }), h('h2', { text: ar.name }), h('div', { class: 'muted', text: `${ar.albums.length} album${ar.albums.length === 1 ? '' : 's'} · ${rels.length} songs` }),
        h('div', { class: 'acts' }, h('button', { class: 'btn primary', text: 'Play all', onclick: () => startQueue(rels, 0) }), h('button', { class: 'btn', text: 'Shuffle', onclick: () => { saveSettings({ shuffle: true }); startQueue(rels, Math.floor(Math.random() * rels.length)); } })))));
    const grid = h('div', { class: 'grid' });
    for (const ai of ar.albums) grid.append(albumCard(S.idx.albums[ai], ai, { view: 'artists', arg: ar.name }));
    view.append(grid);
  }

  function renderFolders(view) {
    const dir = typeof S.arg === 'string' ? S.arg : '';
    const { folders, files } = M.folderEntries(S.tracks, dir);
    const parts = dir ? dir.split('/') : [];
    const crumbs = h('div', { class: 'crumbs' }, h('button', { text: baseName(S.root), onclick: () => { S.arg = null; render(); } }));
    parts.forEach((p, i) => { crumbs.append(h('span', { class: 'sepc', text: '›' }), h('button', { text: p, onclick: () => { S.arg = parts.slice(0, i + 1).join('/'); render(); } })); });
    view.append(crumbs);
    for (const f of folders) {
      const row = h('button', { class: 'folderrow', onclick: () => { S.arg = f.path; render(); } }, h('span', { html: null }), h('span', { class: 'grow', text: f.name }), h('span', { class: 'muted small', text: `${f.count} song${f.count === 1 ? '' : 's'}` }));
      row.firstChild.innerHTML = svg('folder');
      view.append(row);
    }
    if (files.length) {
      view.append(h('div', { class: 'acts', style: null }, h('button', { class: 'btn small', text: 'Play this folder', onclick: () => startQueue(files.map((i) => S.tracks[i].rel), 0) })));
      mountList(view, trackList(files, { label: 'Songs in this folder', virtual: false }), false);
    } else if (!folders.length) view.append(h('div', { class: 'emptylist', text: 'This folder is empty.' }));
  }

  function renderQueue(view) {
    const q = S.q;
    pruneQueue();
    const items = q.items.map((r) => (trackOf(r) ? trackOf(r)._i : -1));
    if (!items.length) { view.append(h('div', { class: 'emptylist', text: 'The queue is empty. Play a song, or use "Add to queue" on any song.' })); return; }
    view.append(h('div', { class: 'acts', style: null },
      h('button', { class: 'btn small', text: 'Clear upcoming', onclick: () => { q.items.splice(q.pos + 1); q.original = q.original.filter((r) => q.items.includes(r)); schedulePreload(); updateCounts(); render(); } }),
      h('span', { class: 'muted small', text: `${q.items.length} songs · playing #${q.pos + 1}` })));
    const api = trackList(items, {
      label: 'Queue', queue: true, numbering: 'pos',
      onPlay: (pos) => playAt(pos),
      onRemove: (pos) => { removeFromQueue(pos); render(); },
      onMove: (pos, d) => { const to = moveInQueue(pos, d); render(); S.list.select(to); return to; },
      removeLabel: 'Remove from queue',
    });
    view.classList.add('vlist');
    view.append(api.el); S.list = api;
    api.select(Math.max(0, q.pos));
  }

  function renderPlaylist(view) {
    const pl = S.playlists.lists.find((p) => p.id === S.arg);
    if (!pl) { go('songs'); return; }
    $('viewTitle').textContent = pl.name;
    const known = pl.tracks.filter((r) => trackOf(r));
    const items = known.map((r) => trackOf(r)._i);
    const total = items.reduce((s, i) => s + (S.tracks[i].durationMs || 0), 0);
    const more = h('button', { class: 'iconbtn', 'aria-label': 'Playlist actions', title: 'More' });
    setIcon(more, 'more');
    more.addEventListener('click', () => { const r = more.getBoundingClientRect(); playlistMenu(pl, r.left, r.bottom + 4, more); });
    view.append(h('div', { class: 'acts', style: null },
      h('button', { class: 'btn primary', text: 'Play', disabled: !items.length, onclick: () => startQueue(known, 0) }),
      h('button', { class: 'btn', text: 'Shuffle', disabled: !items.length, onclick: () => { saveSettings({ shuffle: true }); startQueue(known, Math.floor(Math.random() * known.length)); } }),
      more, h('span', { class: 'muted small', text: `${items.length} songs${items.length ? ' · ' + M.formatTotal(total) : ''}${pl.tracks.length > known.length ? ` · ${pl.tracks.length - known.length} missing from this folder` : ''}` })));
    const api = trackList(items, {
      label: pl.name, numbering: 'pos', empty: 'This playlist is empty. Use the ⋯ menu on any song and choose "Add to playlist".',
      onRemove: (pos) => { const rel = known[pos]; pl.tracks.splice(pl.tracks.indexOf(rel), 1); savePlaylists().then(render); },
      onMove: (pos, d) => {
        const to = pos + d; if (to < 0 || to >= known.length) return pos;
        const a = pl.tracks.indexOf(known[pos]); const b = pl.tracks.indexOf(known[to]);
        [pl.tracks[a], pl.tracks[b]] = [pl.tracks[b], pl.tracks[a]];
        savePlaylists().then(() => { render(); if (S.list) S.list.select(to); });
        return to;
      },
      removeLabel: 'Remove from playlist',
    });
    mountList(view, api);
  }

  // ---- now playing ----
  let vizCanvas = null;
  const vizBars = new Array(48).fill(0);
  function renderNow(view) {
    const left = h('div', { class: 'now-left', id: 'nowLeft' });
    const right = h('div', { class: 'now-right', id: 'nowRight' });
    view.classList.add('vlist');
    view.append(h('div', { class: 'now' }, left, right));
    renderNowLeft();
    window.LyricsUI.mount(right);
    lyricsMounted = true;
  }
  function renderNowLeft() {
    const left = $('nowLeft'); if (!left) return;
    const t = trackOf(S.currentRel);
    left.textContent = '';
    const cover = h('span', { class: 'cover' });
    setCover(cover, t, 800);
    if (!t) { left.append(cover, h('div', { class: 'now-title', text: 'Nothing playing' }), h('div', { class: 'now-sub', text: 'Pick a song from Songs, Albums or Folders.' })); return; }
    const facts = [t.ext.toUpperCase(), t.bitrate ? t.bitrate + ' kbps' : '', t.sampleRate ? (t.sampleRate / 1000).toFixed(t.sampleRate % 1000 ? 1 : 0) + ' kHz' : '', t.channels === 1 ? 'Mono' : t.channels === 2 ? 'Stereo' : '', t.rg && t.rg.track != null ? 'ReplayGain ' + t.rg.track + ' dB' : ''].filter(Boolean);
    vizCanvas = h('canvas', { class: 'viz', width: '760', height: '128', 'aria-hidden': 'true' });
    left.append(cover,
      h('div', {}, h('div', { class: 'now-title', text: M.titleOf(t) }), h('div', { class: 'now-sub', text: M.artistOf(t) }), h('div', { class: 'now-sub', text: [M.albumOf(t), t.year || ''].filter(Boolean).join(' · ') })),
      h('div', { class: 'now-facts' }, facts.map((f) => h('span', { class: 'fact', text: f }))),
      h('div', { class: 'now-acts' },
        h('button', { class: 'btn small', text: 'Show in folder', onclick: () => mp.reveal(t.rel).catch((e) => toast(errText(e), true)) }),
        h('button', { class: 'btn small', text: 'Edit tags in Audio Tagger', onclick: () => openTagger(t.rel) })),
      vizCanvas);
  }
  function drawViz() {
    if (!vizCanvas || !vizCanvas.isConnected) return;
    const c = vizCanvas.getContext('2d');
    const w = vizCanvas.width; const hh = vizCanvas.height;
    c.clearRect(0, 0, w, hh);
    if (REDUCED.matches) return;
    if (S.playing) engine.bars(vizBars.length, vizBars); else for (let i = 0; i < vizBars.length; i++) vizBars[i] *= 0.85;
    const bw = w / vizBars.length;
    const g = c.createLinearGradient(0, hh, 0, 0); g.addColorStop(0, '#d6409f'); g.addColorStop(1, '#8b5cf6');
    c.fillStyle = g;
    for (let i = 0; i < vizBars.length; i++) { const v = Math.max(0.02, vizBars[i]) * hh * 0.92; c.fillRect(i * bw + 2, hh - v, bw - 4, v); }
  }

  // ---------------------------------------------------------------------------------------------------------------
  // library
  // ---------------------------------------------------------------------------------------------------------------
  function setTracks(tracks) {
    S.tracks = tracks;
    S.byRel = new Map();
    tracks.forEach((t, i) => { t._i = i; S.byRel.set(t.rel, t); });
    S.hay = tracks.map(M.searchText);
    S.idx = M.buildIndex(tracks);
    updateCounts();
  }

  function showNotice() {
    const n = $('notice');
    n.textContent = ''; n.hidden = true;
    if (S.scanning && S.progress) {
      n.hidden = false;
      const p = S.progress;
      const text = p.phase === 'find' ? `Looking for music… ${p.done.toLocaleString()} found` : `Reading tags… ${p.done.toLocaleString()} of ${p.total.toLocaleString()}`;
      const pct = p.phase === 'read' && p.total ? (p.done / p.total) * 100 : 0;
      const bar = h('span', { class: 'bar2' }, h('i'));
      bar.firstChild.style.width = pct + '%';
      n.append(h('span', { text }), p.phase === 'read' ? bar : null);
    } else if (!S.scanning && (Object.keys(S.skipped).length || S.errors) && !S.noticeDismissed) {
      const parts = [];
      const skipped = Object.entries(S.skipped).map(([e, c]) => `${c} ${e}`);
      if (skipped.length) parts.push(`${skipped.reduce((s, x) => s + Number(x.split(' ')[0]), 0)} files can't be played here (${skipped.join(', ')}).`);
      if (S.errors) parts.push(`${S.errors} file${S.errors === 1 ? '' : 's'} couldn't be read and may be damaged.`);
      n.hidden = false;
      n.append(h('span', { class: 'grow', text: parts.join(' ') }), h('button', { class: 'btn small', text: 'Dismiss', onclick: () => { S.noticeDismissed = true; showNotice(); } }));
    }
    $('libInfo').textContent = S.root ? (S.scanning ? 'Scanning…' : `${S.tracks.length.toLocaleString()} songs · ${S.idx.albums.length.toLocaleString()} albums`) : '';
  }

  function applyLibraryRoot(root) {
    S.root = root;
    $('folderName').textContent = root ? baseName(root) : 'Choose a folder';
    $('folderPath').textContent = root || 'No folder open';
    $('folderBtn').title = root || 'Choose music folder';
  }

  async function onLibraryEvent(ev) {
    if (ev.type === 'loaded') {
      const sameRoot = S.root === ev.root;
      if (ev.settings) S.settings = ev.settings;
      applyLibraryRoot(ev.root);
      S.scanning = true; S.progress = null; S.skipped = {}; S.errors = 0; S.noticeDismissed = false;
      if (!sameRoot && S.currentRel) { engine.stop(); S.currentRel = ''; S.q = { items: [], original: [], pos: -1 }; S.playing = false; onTrackChanged(); }
      setTracks(ev.tracks);
      try { S.playlists = await mp.getPlaylists(); } catch { S.playlists = { lists: [] }; }
      if (!sameRoot && (S.view === 'playlist' || S.arg)) { S.view = 'songs'; S.arg = null; }
      render(); showNotice();
      if (ev.playRel) { const t = trackOf(ev.playRel); if (t) startQueue(songIndexes().map((i) => S.tracks[i].rel), songIndexes().findIndex((i) => S.tracks[i].rel === ev.playRel)); }
      else if (ev.tracks.length) restoreLast();
    } else if (ev.type === 'progress') {
      S.progress = ev; showNotice();
    } else if (ev.type === 'done') {
      S.scanning = false; S.progress = null; S.skipped = ev.skipped || {}; S.errors = ev.errors || 0;
      const prevCount = S.tracks.length;
      const changed = ev.tracks.length !== prevCount || ev.tracks.some((t, i) => !S.tracks[i] || S.tracks[i].rel !== t.rel || S.tracks[i].mtime !== t.mtime);
      if (changed) { setTracks(ev.tracks); pruneQueue(); if (!S.q.items.length && ev.tracks.length) restoreLast(); }
      showNotice();
      if (changed || prevCount === 0) { const keep = S.list && S.list.vport ? S.list.vport.scrollTop : 0; render(); if (keep && S.list && S.list.vport) S.list.vport.scrollTop = keep; }
    } else if (ev.type === 'error') {
      S.scanning = false; S.progress = null; showNotice(); toast(ev.error, true);
    }
  }

  let restored = false;
  async function restoreLast() {
    if (restored || S.currentRel) return;
    const last = S.settings.last;
    if (!last || !last.rel || !trackOf(last.rel)) return;
    restored = true;
    const order = songIndexes().map((i) => S.tracks[i].rel);
    const at = order.indexOf(last.rel);
    if (at < 0) return;
    S.q.original = order.slice();
    if (S.settings.shuffle) { S.q.items = M.shuffled(order, last.rel); S.q.pos = 0; } else { S.q.items = order; S.q.pos = at; }
    await playAt(S.q.pos, { paused: true, startAt: last.pos });
  }

  async function chooseFolder() { try { await mp.chooseFolder(); } catch (e) { toast(errText(e), true); } }
  async function openFolder(p) { try { restored = false; await mp.openFolder(p); } catch (e) { toast(errText(e), true); } }

  $('folderBtn').addEventListener('click', () => {
    const items = [{ label: 'Open another folder…', run: chooseFolder }];
    const others = S.settings.recent.filter((r) => r !== S.root);
    if (others.length) items.push({ sep: true }, { caption: 'RECENT' }, ...others.map((r) => ({ label: r, run: () => openFolder(r) })));
    if (S.root) items.push({ sep: true }, { label: 'Rescan this folder', run: () => { restored = true; mp.rescan().catch((e) => toast(errText(e), true)); } }, { label: 'Show in file manager', run: () => mp.revealRoot() });
    menuAtButton($('folderBtn'), items);
  });

  // ---------------------------------------------------------------------------------------------------------------
  // popovers: sound + sleep
  // ---------------------------------------------------------------------------------------------------------------
  function closePops() {
    for (const [pop, btn] of [['popSound', 'bSound'], ['popSleep', 'bSleep']]) { if (!$(pop).hidden) { $(pop).hidden = true; $(btn).setAttribute('aria-expanded', 'false'); } }
  }
  function togglePop(pop, btn, onOpen) {
    const open = $(pop).hidden;
    closePops(); closeMenu();
    if (!open) return;
    $(pop).hidden = false; $(btn).setAttribute('aria-expanded', 'true');
    if (onOpen) onOpen();
    const f = $(pop).querySelector('input,select,button'); if (f) f.focus();
  }
  document.addEventListener('mousedown', (e) => {
    for (const [pop, btn] of [['popSound', 'bSound'], ['popSleep', 'bSleep']]) if (!$(pop).hidden && !$(pop).contains(e.target) && !$(btn).contains(e.target)) closePops();
  });

  function applyEq() { engine.setEq(S.settings.eq); }
  function applyVolume() { engine.setVolume(S.settings.volume, S.settings.muted); $('vol').value = Math.round(S.settings.volume * 100); fillRange($('vol')); }
  function applyRgNow() {
    const t = trackOf(S.currentRel);
    if (t) engine.setTrackGain(rgFactor(t));
    const np = nextPos(true);
    if (np >= 0 && trackOf(S.q.items[np])) engine.setPreloadGain(rgFactor(trackOf(S.q.items[np])));
  }

  function buildSoundUi() {
    const sel = $('eqPreset');
    sel.textContent = '';
    for (const name of Object.keys(window.EQ.PRESETS)) sel.append(h('option', { value: name, text: name }));
    sel.append(h('option', { value: 'Custom', text: 'Custom' }));
    const wrap = $('eqBands');
    wrap.textContent = '';
    window.EQ.BANDS.forEach((f, i) => {
      const label = f >= 1000 ? f / 1000 + 'k' : String(f);
      const inp = h('input', { type: 'range', min: '-12', max: '12', step: '0.5', value: '0', 'aria-label': `${label} Hz`, 'data-i': String(i) });
      wrap.append(h('div', { class: 'band' }, h('span', { class: 'db', id: 'db' + i, text: '0' }), inp, h('span', { text: label })));
      inp.addEventListener('input', () => {
        const bands = S.settings.eq.bands.slice(); bands[i] = Number(inp.value);
        saveEq({ bands, preset: 'Custom', on: true });
      });
    });
    $('eqOn').addEventListener('change', (e) => saveEq({ on: e.target.checked }));
    sel.addEventListener('change', () => { if (sel.value !== 'Custom') saveEq({ preset: sel.value, bands: window.EQ.PRESETS[sel.value].slice(), on: true }); });
    $('preamp').addEventListener('input', (e) => saveEq({ preamp: Number(e.target.value) }));
    $('rgMode').addEventListener('change', (e) => { saveSettings({ rg: { ...S.settings.rg, mode: e.target.value } }); syncSoundUi(); applyRgNow(); });
    $('rgPre').addEventListener('input', (e) => { saveSettings({ rg: { ...S.settings.rg, preamp: Number(e.target.value) } }); syncSoundUi(); applyRgNow(); });
  }
  function saveEq(patch) { S.settings.eq = { ...S.settings.eq, ...patch }; mp.setSettings({ eq: S.settings.eq }).catch(() => {}); applyEq(); syncSoundUi(); }
  function syncSoundUi() {
    const eq = S.settings.eq;
    $('eqOn').checked = eq.on;
    $('eqPreset').value = eq.preset;
    $('preamp').value = eq.preamp; $('preampOut').textContent = (eq.preamp > 0 ? '+' : '') + eq.preamp + ' dB';
    eq.bands.forEach((b, i) => { const inp = $('eqBands').children[i].querySelector('input'); inp.value = b; $('db' + i).textContent = (b > 0 ? '+' : '') + b; });
    $('popSound').classList.toggle('eqoff', !eq.on);
    $('rgMode').value = S.settings.rg.mode;
    $('rgPre').value = S.settings.rg.preamp; $('rgPreOut').textContent = (S.settings.rg.preamp > 0 ? '+' : '') + S.settings.rg.preamp + ' dB';
    $('rgPre').disabled = S.settings.rg.mode === 'off';
    $('bSound').classList.toggle('on', eq.on || S.settings.rg.mode !== 'off');
  }

  // ---- sleep timer ----
  function startSleep(v) {
    cancelSleep(true);
    if (v === 'end') { S.sleep.endOfSong = true; schedulePreload(); }
    else S.sleep.until = Date.now() + Number(v) * 60000;
    $('bSleep').classList.add('on');
    sleepUi();
    toast(v === 'end' ? 'Music will stop at the end of this song.' : `Music will stop in ${v} minutes.`);
  }
  function cancelSleep(silent) {
    S.sleep = { until: 0, endOfSong: false, fading: false };
    engine.resetFade();
    $('bSleep').classList.remove('on');
    if (!silent) { schedulePreload(); sleepUi(); }
  }
  function sleepTick() {
    const left = S.sleep.until - Date.now();
    if (left <= 0) { engine.pause(); cancelSleep(); toast('Sleep timer: music stopped.'); return; }
    if (left <= 8000 && $('sleepFade').checked && !S.sleep.fading && S.playing) { S.sleep.fading = true; engine.fadeOut(left / 1000); }
    if (!$('popSleep').hidden) sleepUi();
  }
  function sleepUi() {
    const st = $('sleepStatus');
    const active = S.sleep.until || S.sleep.endOfSong;
    $('sleepCancel').hidden = !active;
    if (S.sleep.endOfSong) st.textContent = 'Stops at the end of this song.';
    else if (S.sleep.until) { const s = Math.max(0, Math.round((S.sleep.until - Date.now()) / 1000)); st.textContent = `Stops in ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}.`; }
    else st.textContent = 'Stop the music automatically.';
  }

  // ---------------------------------------------------------------------------------------------------------------
  // mini player
  // ---------------------------------------------------------------------------------------------------------------
  function setMini(on) {
    S.miniOn = on;
    document.body.classList.toggle('mini', on);
    $('bMini').setAttribute('aria-pressed', String(on));
    mp.setMini(on);
    closePops(); closeMenu();
  }

  // ---------------------------------------------------------------------------------------------------------------
  // wiring
  // ---------------------------------------------------------------------------------------------------------------
  function initUi() {
    for (const [id, name] of [['bShuffle', 'shuffle'], ['bPrev', 'prev'], ['bNext', 'next'], ['bLyrics', 'lyrics'], ['bQueue', 'queue'], ['bSound', 'sound'], ['bSleep', 'sleep'], ['bMini', 'mini'], ['plNew', 'plus'], ['plImport', 'import'], ['sortDir', 'sortdir']]) setIcon($(id), name);
    $('folderIco').innerHTML = svg('folder');
    $('bPlay').innerHTML = svg('play');
    for (const b of document.querySelectorAll('.navbtn')) b.addEventListener('click', () => go(b.dataset.view));
    $('bPlay').addEventListener('click', () => { if (!S.currentRel) { if (S.tracks.length) { const order = songIndexes().map((i) => S.tracks[i].rel); startQueue(order, 0); } return; } engine.toggle(); });
    $('bNext').addEventListener('click', next);
    $('bPrev').addEventListener('click', prev);
    $('bShuffle').addEventListener('click', () => setShuffle(!S.settings.shuffle));
    $('bRepeat').addEventListener('click', cycleRepeat);
    $('barTrack').addEventListener('click', () => go('now'));
    $('bLyrics').addEventListener('click', () => go(S.view === 'now' ? (S.settings.view !== 'now' ? S.settings.view : 'songs') : 'now'));
    $('bQueue').addEventListener('click', () => go(S.view === 'queue' ? 'songs' : 'queue'));
    $('bSound').addEventListener('click', () => togglePop('popSound', 'bSound', syncSoundUi));
    $('bSleep').addEventListener('click', () => togglePop('popSleep', 'bSleep', sleepUi));
    $('bMini').addEventListener('click', () => setMini(!S.miniOn));
    $('bMute').addEventListener('click', () => { saveSettings({ muted: !(S.settings.muted || S.settings.volume === 0) }); if (S.settings.volume === 0 && !S.settings.muted) saveSettings({ volume: 0.5, muted: false }); applyVolume(); updateTransport(); });
    $('vol').addEventListener('input', (e) => { const v = Number(e.target.value) / 100; saveSettings({ volume: v, muted: false }); applyVolume(); updateTransport(); });
    $('seek').addEventListener('input', (e) => { seeking = true; fillRange(e.target); const d = engine.duration; $('tNow').textContent = M.formatDuration((Number(e.target.value) / 1000) * d * 1000); });
    $('seek').addEventListener('change', (e) => { engine.seek((Number(e.target.value) / 1000) * engine.duration); seeking = false; });
    $('sleepChips').addEventListener('click', (e) => { const b = e.target.closest('.chip'); if (b) startSleep(b.dataset.min); });
    $('sleepCancel').addEventListener('click', () => cancelSleep());
    $('sleepFade').addEventListener('change', (e) => saveSettings({ sleepFade: e.target.checked }));
    $('askCancel').addEventListener('click', () => $('ask').close('cancel'));
    $('plNew').addEventListener('click', () => createPlaylist([]));
    $('plImport').addEventListener('click', importPlaylist);

    let st = null;
    $('search').addEventListener('input', (e) => { clearTimeout(st); st = setTimeout(() => { S.query = e.target.value; render(); }, 120); });
    $('sort').addEventListener('change', (e) => { saveSettings({ sort: { by: e.target.value, dir: S.settings.sort.dir } }); render(); });
    $('sortDir').addEventListener('click', () => { saveSettings({ sort: { by: S.settings.sort.by, dir: -S.settings.sort.dir } }); $('sortDir').setAttribute('aria-pressed', String(S.settings.sort.dir === -1)); render(); });

    buildSoundUi();
  }

  function initKeys() {
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        if (!$('menu').hidden) return;
        if (!$('popSound').hidden || !$('popSleep').hidden) { closePops(); return; }
        if (S.miniOn) { setMini(false); return; }
        return;
      }
      if (document.querySelector('dialog[open]')) return;
      const tag = e.target && e.target.tagName;
      const typing = tag === 'INPUT' && e.target.type !== 'range' && e.target.type !== 'checkbox' || tag === 'TEXTAREA' || tag === 'SELECT';
      if (e.key === '/' && !typing) { e.preventDefault(); $('search').focus(); $('search').select(); return; }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') { e.preventDefault(); $('search').focus(); $('search').select(); return; }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'o') { e.preventDefault(); chooseFolder(); return; }
      if (typing) return;
      const onRange = tag === 'INPUT' && e.target.type === 'range';
      if (e.key === ' ' && !e.ctrlKey) { e.preventDefault(); if (S.currentRel) engine.toggle(); return; }
      if ((e.ctrlKey || e.metaKey) && e.key === 'ArrowUp') { e.preventDefault(); saveSettings({ volume: Math.min(1, S.settings.volume + 0.05), muted: false }); applyVolume(); return; }
      if ((e.ctrlKey || e.metaKey) && e.key === 'ArrowDown') { e.preventDefault(); saveSettings({ volume: Math.max(0, S.settings.volume - 0.05) }); applyVolume(); return; }
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (!onRange && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) { e.preventDefault(); engine.seek(engine.position + (e.key === 'ArrowRight' ? 1 : -1) * (e.shiftKey ? 30 : 5)); return; }
      const k = e.key.toLowerCase();
      if (k === 'n') next(); else if (k === 'p') prev(); else if (k === 's') setShuffle(!S.settings.shuffle); else if (k === 'r') cycleRepeat();
      else if (k === 'm') $('bMute').click(); else if (k === 'l') $('bLyrics').click(); else if (k === 'q') $('bQueue').click();
    });
  }

  function initDrop() {
    let depth = 0;
    const hasFiles = (e) => e.dataTransfer && [...(e.dataTransfer.types || [])].includes('Files');
    window.addEventListener('dragenter', (e) => { if (hasFiles(e)) { depth++; $('dropHint').hidden = false; } });
    window.addEventListener('dragleave', (e) => { if (hasFiles(e)) { depth = Math.max(0, depth - 1); if (!depth) $('dropHint').hidden = true; } });
    window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
    window.addEventListener('drop', (e) => {
      e.preventDefault(); depth = 0; $('dropHint').hidden = true;
      const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (!f) return;
      const p = mp.pathForFile(f);
      if (p) openFolder(p);
    });
  }

  // ---------------------------------------------------------------------------------------------------------------
  // start
  // ---------------------------------------------------------------------------------------------------------------
  async function init() {
    window.LyricsUI.init({ S, engine, mp, h, toast, ask, M, LRC });
    const snapshot = await mp.getLibrary();
    S.settings = snapshot.settings;
    S.view = ['songs', 'albums', 'artists', 'folders', 'queue', 'now'].includes(S.settings.view) ? S.settings.view : 'songs';
    initUi(); initKeys(); initDrop(); initMediaSession();
    applyVolume(); applyEq(); syncSoundUi();
    $('sort').value = S.settings.sort.by;
    $('sortDir').setAttribute('aria-pressed', String(S.settings.sort.dir === -1));
    $('sleepFade').checked = S.settings.sleepFade;
    mp.onLibrary(onLibraryEvent);
    if (snapshot.root) {
      applyLibraryRoot(snapshot.root);
      setTracks(snapshot.tracks);
      S.scanning = snapshot.scanning;
      try { S.playlists = await mp.getPlaylists(); } catch { /* none */ }
      if (snapshot.skipped) { S.skipped = snapshot.skipped; S.errors = snapshot.errors; }
      if (snapshot.tracks.length) restoreLast();
    }
    render(); showNotice(); onTrackChanged();
    requestAnimationFrame(frame);
    if (location.hash === '#e2e') window.__app = { S, engine, mp, go, startQueue, next, prev, setShuffle, cycleRepeat, trackOf, playAt, startSleep, cancelSleep, setMini, render, toast };
  }
  init().catch((e) => { console.error(e); document.body.prepend(h('pre', { text: 'Music Player failed to start: ' + errText(e) })); });
}());
