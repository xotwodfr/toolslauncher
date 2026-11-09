'use strict';
(() => {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];

  const state = {
    tools: [], view: 'library', query: '', category: 'All', filter: 'all', progress: {}, busy: new Set(),
    loaded: false, source: '', remoteError: null, dev: false, platform: '', appVersion: '', checkedAt: 0,
  };

  // ---- icons (static, trusted strings: never built from catalog data) -------------------------------------------
  const ICONS = {
    logo: '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l8 5v8l-8 5-8-5V8z"/><path d="M12 12l8-4M12 12v9M12 12L4 8"/></svg>',
    grid: '<svg viewBox="0 0 24 24"><rect x="3" y="3" width="7.5" height="7.5" rx="2"/><rect x="13.5" y="3" width="7.5" height="7.5" rx="2"/><rect x="3" y="13.5" width="7.5" height="7.5" rx="2"/><rect x="13.5" y="13.5" width="7.5" height="7.5" rx="2"/></svg>',
    check: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M8 12.5l2.7 2.7L16.5 9.5"/></svg>',
    cog: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>',
    search: '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>',
    refresh: '<svg viewBox="0 0 24 24"><path d="M20 11a8 8 0 0 0-14.5-4.4L4 8"/><path d="M4 4v4h4"/><path d="M4 13a8 8 0 0 0 14.5 4.4L20 16"/><path d="M20 20v-4h-4"/></svg>',
    alert: '<svg viewBox="0 0 24 24"><path d="M12 3.5L2.5 20h19z"/><path d="M12 10v4.5M12 17.5v.1"/></svg>',
    folder: '<svg viewBox="0 0 24 24"><path d="M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>',
    trash: '<svg viewBox="0 0 24 24"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/></svg>',
    play: '<svg viewBox="0 0 24 24"><path d="M7 4.5v15l12-7.5z" fill="currentColor"/></svg>',
    download: '<svg viewBox="0 0 24 24"><path d="M12 4v11M7.5 11L12 15.5 16.5 11M5 20h14"/></svg>',
    up: '<svg viewBox="0 0 24 24"><path d="M12 20V9M7.5 13.5L12 9l4.5 4.5M5 4h14"/></svg>',
    ok: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M8 12.5l2.7 2.7L16.5 9.5"/></svg>',
    err: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7.5v5.5M12 16v.1"/></svg>',
    info: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 11v5.5M12 7.8v.1"/></svg>',
  };
  // one icon per known tool; unknown tools fall back to the catalog's glyph character
  const TOOL_ICONS = {
    'audio-tagger': '<svg viewBox="0 0 24 24"><path d="M9 18V6.5l10-2.2V16"/><circle cx="6.5" cy="18" r="2.6"/><circle cx="16.5" cy="16" r="2.6"/></svg>',
    'audio-converter': '<svg viewBox="0 0 24 24"><path d="M4 8.5h12.5M13 5l3.5 3.5L13 12M20 15.5H7.5M11 12l-3.5 3.5L11 19"/></svg>',
    'picture-converter': '<svg viewBox="0 0 24 24"><rect x="3.5" y="4.5" width="17" height="15" rx="3.2"/><circle cx="9" cy="10" r="1.9"/><path d="M4 17.5l4.6-4.6 3.6 3.6 2.8-2.8 5 5"/></svg>',
    // a page with a folded corner and lines of text
    'pdf-toolkit': '<svg viewBox="0 0 24 24"><path d="M7 3.5h6.5L19 9v10a1.5 1.5 0 0 1-1.5 1.5h-10A1.5 1.5 0 0 1 6 19V5a1.5 1.5 0 0 1 1-1.5z"/><path d="M13.5 3.5V9H19M9 13h6M9 16.5h4"/></svg>',
    // a shield with a check mark
    'photo-privacy': '<svg viewBox="0 0 24 24"><path d="M12 3.5l7 2.8v5.4c0 4.2-2.8 7.4-7 8.8-4.2-1.4-7-4.6-7-8.8V6.3z"/><path d="M8.8 12.2l2.2 2.2 4.2-4.4"/></svg>',
    // headphones
    'music-player': '<svg viewBox="0 0 24 24"><path d="M4.5 14.5v-2.5a7.5 7.5 0 0 1 15 0v2.5"/><rect x="3.5" y="13.5" width="4.2" height="6.5" rx="1.7"/><rect x="16.3" y="13.5" width="4.2" height="6.5" rx="1.7"/></svg>',
    // waveform bars
    'audio-editor': '<svg viewBox="0 0 24 24"><path d="M4 10.5v3M8 7v10M12 4v16M16 8.5v7M20 10.5v3"/></svg>',
    // three stacked wave lines: the separate parts of one song
    'stem-splitter': '<svg viewBox="0 0 24 24"><path d="M3.5 5h3.5l1.4-2 1.6 4 1.4-2h8.6M3.5 12h7.5l1.4-2.2 1.6 4.4 1.4-2.2h4.6M3.5 19h3l1.4-2 1.6 4 1.4-2h9.6"/></svg>',
    // a metronome: the beat
    'bpm-key-finder': '<svg viewBox="0 0 24 24"><path d="M8.2 20.5h7.6l-2.3-15.5h-3z"/><path d="M12 16.2l3.8-8.4"/><circle cx="15.8" cy="7.8" r="1.1"/><path d="M9.4 12.5h5.2"/></svg>',
    // a picture with the subject cut out of a dashed outline
    'background-remover': '<svg viewBox="0 0 24 24"><rect x="3.5" y="3.5" width="17" height="17" rx="2.6" stroke-dasharray="3.2 2.6"/><circle cx="12" cy="10" r="2.7"/><path d="M6.9 18c.7-3.1 2.8-4.5 5.1-4.5s4.4 1.4 5.1 4.5"/></svg>',
    // a speech bubble with two lines of words
    'lyrics-maker': '<svg viewBox="0 0 24 24"><path d="M5.2 4.8h13.6a1.7 1.7 0 0 1 1.7 1.7v8a1.7 1.7 0 0 1-1.7 1.7h-6.6l-4.4 3.5v-3.5H5.2a1.7 1.7 0 0 1-1.7-1.7v-8a1.7 1.7 0 0 1 1.7-1.7z"/><path d="M8 9h8M8 12.2h5"/></svg>',
    // two overlapping pages
    'duplicate-finder': '<svg viewBox="0 0 24 24"><rect x="8.5" y="8.5" width="11" height="12" rx="2.4"/><path d="M15.5 8.5V6a2 2 0 0 0-2-2H6.5a2 2 0 0 0-2 2v8.5a2 2 0 0 0 2 2h2"/></svg>',
    // a picture with lines of text
    'ocr': '<svg viewBox="0 0 24 24"><path d="M4 8V6a2 2 0 0 1 2-2h2M16 4h2a2 2 0 0 1 2 2v2M20 16v2a2 2 0 0 1-2 2h-2M8 20H6a2 2 0 0 1-2-2v-2"/><path d="M8 9h8M8 12h8M8 15h5"/></svg>',
    // a film frame with a play triangle
    'video-converter': '<svg viewBox="0 0 24 24"><rect x="3.5" y="5" width="17" height="14" rx="3"/><path d="M10 9.2v5.6l4.8-2.8z"/><path d="M3.5 8.5H6M3.5 15.5H6M18 8.5h2.5M18 15.5h2.5"/></svg>',
  };
  const icon = (name, cls = 'ico') => { const s = document.createElement('span'); s.className = cls; s.setAttribute('aria-hidden', 'true'); s.innerHTML = ICONS[name] || ''; return s; };

  // ---- helpers ---------------------------------------------------------------------------------------------------
  const el = (tag, props = {}, ...kids) => {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === 'class') e.className = v;
      else if (k === 'style') { if (v) e.style.cssText = v; } // CSSOM, not setAttribute: the CSP blocks inline style attributes
      else if (k === 'dataset') Object.assign(e.dataset, v);
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else if (v === false || v == null) continue;
      else e.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids) if (kid != null && kid !== false) e.append(kid);
    return e;
  };
  const fmtBytes = (n) => {
    if (!n) return '';
    const u = ['B', 'KB', 'MB', 'GB']; let i = 0;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return `${n.toFixed(n < 10 && i ? 1 : 0)} ${u[i]}`;
  };
  const timeAgo = (iso) => {
    const t = Date.parse(iso); if (!t) return '';
    const s = Math.max(0, (Date.now() - t) / 1000);
    if (s < 60) return 'just now';
    const units = [[60, 'minute'], [3600, 'hour'], [86400, 'day'], [2592000, 'month']];
    let label = 'minute', div = 60;
    for (const [d, l] of units) if (s >= d) { div = d; label = l; }
    const n = Math.floor(s / div);
    return `${n} ${label}${n > 1 ? 's' : ''} ago`;
  };
  const cleanError = (e) => String((e && e.message) || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
  const PHASES = { download: 'Downloading', verify: 'Verifying', install: 'Installing', done: 'Finishing' };

  function toast(msg, kind = 'ok') {
    const root = $('#toasts');
    while (root.children.length >= 3) root.firstChild.remove();
    const t = el('div', { class: `toast ${kind}`, role: kind === 'err' ? 'alert' : 'status' }, icon(kind === 'err' ? 'err' : kind === 'info' ? 'info' : 'ok'), el('span', {}, msg));
    root.append(t);
    setTimeout(() => { t.classList.add('leaving'); setTimeout(() => t.remove(), 260); }, kind === 'err' ? 6500 : 3200);
  }

  /** In-app confirmation dialog (replaces window.confirm). Resolves true/false. */
  function confirmDialog({ title, body, confirmLabel, danger }) {
    return new Promise((resolve) => {
      const previous = document.activeElement;
      const done = (v) => { scrim.remove(); document.removeEventListener('keydown', onKey, true); if (previous && previous.focus) previous.focus(); resolve(v); };
      const cancel = el('button', { class: 'btn', onclick: () => done(false) }, 'Cancel');
      const ok = el('button', { class: `btn ${danger ? 'danger' : 'primary'}`, 'data-action': 'confirm', onclick: () => done(true) }, confirmLabel);
      const scrim = el('div', { class: 'scrim', onclick: (e) => { if (e.target === scrim) done(false); } },
        el('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'modalTitle' },
          el('h3', { id: 'modalTitle' }, title), el('p', {}, body), el('div', { class: 'row' }, cancel, ok)));
      const onKey = (e) => {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(false); }
        else if (e.key === 'Tab') { const f = [cancel, ok]; const i = f.indexOf(document.activeElement); e.preventDefault(); f[(i + (e.shiftKey ? -1 : 1) + f.length) % f.length].focus(); }
      };
      document.addEventListener('keydown', onKey, true);
      $('#modalRoot').append(scrim);
      cancel.focus();
    });
  }

  // ---- tool UI pieces ------------------------------------------------------------------------------------------------
  const artIcon = (t) => {
    const a = el('div', { class: 'art-icon', 'aria-hidden': 'true' });
    if (TOOL_ICONS[t.id]) a.innerHTML = TOOL_ICONS[t.id]; else a.append(el('span', { class: 'glyph' }, t.glyph));
    return a;
  };
  const accentOf = (t) => /^#[0-9a-f]{3,8}$/i.test(t.accent) ? t.accent : '#8e6dff';

  function statusPill(t) {
    if (state.busy.has(t.id)) return el('span', { class: 'tag info' }, 'Downloading…');
    if (t.state === 'update') return el('span', { class: 'tag warn' }, 'Update available');
    if (t.state === 'installed') return el('span', { class: 'tag ok' }, 'Installed · up to date');
    if (t.state === 'unavailable') return el('span', { class: 'tag' }, 'Coming soon');
    return el('span', { class: 'tag info' }, 'Available to install');
  }

  function progressBlock(t) {
    const p = state.progress[t.id];
    const determinate = p && p.phase === 'download' && p.total;
    const pct = determinate ? Math.round((p.bytes / p.total) * 100) : 0;
    const label = PHASES[p && p.phase] || 'Starting';
    return el('div', { class: 'progress-block', role: 'progressbar', 'aria-label': `${label} ${t.name}`, 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': determinate ? pct : undefined },
      el('div', { class: 'progress-head' }, el('span', {}, `${label}…`), el('span', {}, determinate ? `${pct}%` : '')),
      el('div', { class: `bar-track${determinate ? '' : ' indet'}` }, el('i', { style: determinate ? `width:${pct}%` : null })));
  }

  const btn = (cls, label, action, t, extra = {}) => el('button', { class: `btn ${cls}`, 'data-action': action, 'data-tool': t.id, onclick: () => act(action, t), ...extra }, ...(Array.isArray(label) ? label : [label]));
  const iconBtn = (name, text, action, t) => btn('icon ghost', [icon(name)], action, t, { title: text, 'aria-label': `${text} ${t.name}` });

  function actions(t, layout) {
    const frag = [];
    if (state.busy.has(t.id)) return [progressBlock(t)];
    if (t.state === 'unavailable') return [el('span', { class: 'muted small' }, 'Not available for this system yet')];
    if (t.state === 'available') return [btn('primary grow', [icon('download'), `Install${t.size ? ` · ${fmtBytes(t.size)}` : ''}`], 'install', t)];
    if (t.state === 'update') frag.push(btn(`primary ${layout === 'card' ? 'full' : ''}`, [icon('up'), `Update to v${t.version}`], 'install', t, { title: `Download and install v${t.version}` }));
    frag.push(btn('go grow', [icon('play'), 'Launch'], 'launch', t));
    frag.push(iconBtn('folder', 'Show files of', 'reveal', t), iconBtn('trash', 'Remove', 'uninstall', t));
    return frag;
  }

  const pad2 = (n) => String(n).padStart(2, '0');

  function versionLine(t) {
    if (t.state === 'update') return el('div', { class: 'card-version' }, `v${t.installedVersion} installed → `, el('span', { class: 'upd-ver' }, `v${t.version}`), ' available');
    const bits = [];
    if (t.installedVersion && t.installedAt) bits.push(`Installed ${timeAgo(t.installedAt)}`);
    if (t.size) bits.push(t.installedVersion ? fmtBytes(t.size) : `${fmtBytes(t.size)} download`);
    return el('div', { class: 'card-version' }, bits.join(' · ') || ' ');
  }

  function card(t, index, enter, number) {
    const c = el('article', { class: `card${enter ? ' enter' : ''}`, 'data-tool': t.id, 'data-state': t.state, 'aria-label': t.name },
      el('div', { class: 'card-top' }, el('span', { class: 'num', 'aria-hidden': 'true' }, pad2(number)), el('span', { class: 'card-cat' }, `v${t.installedVersion || t.version}`)),
      el('div', { class: 'card-head' }, artIcon(t), el('div', {}, el('h3', { class: 'card-title' }, t.name), el('p', { class: 'card-desc' }, t.description))),
      el('div', { class: 'card-status' }, statusPill(t)),
      versionLine(t),
      el('div', { class: 'card-foot' }, ...actions(t, 'card')));
    c.style.setProperty('--a', accentOf(t));
    c.style.setProperty('--i', String(index));
    return c;
  }

  function row(t) {
    const r = el('article', { class: 'row-item', 'data-tool': t.id, 'data-state': t.state },
      artIcon(t),
      el('div', { class: 'row-main' },
        el('div', { class: 'row-title' }, t.name, el('span', { class: 'pill plain' }, `v${t.installedVersion}`)),
        el('div', { class: 'row-sub' }, `${t.category}${t.installedAt ? ` · installed ${timeAgo(t.installedAt)}` : ''}`)),
      el('div', { class: 'row-actions' }, ...actions(t, 'row').map((n) => { if (n.classList && n.classList.contains('grow')) n.classList.remove('grow'); return n; })));
    r.style.setProperty('--a', accentOf(t));
    return r;
  }

  // ---- rendering -------------------------------------------------------------------------------------------------------
  let firstGridRender = true;
  const FILTERS = [
    ['all', 'All', () => true],
    ['installed', 'Installed', (t) => !!t.installedVersion],
    ['updates', 'Updates', (t) => t.state === 'update'],
    ['new', 'Not installed', (t) => !t.installedVersion],
  ];
  const matches = (t, withStatus) => {
    const q = state.query.trim().toLowerCase();
    if (state.category !== 'All' && t.category !== state.category) return false;
    if (withStatus && !FILTERS.find((f) => f[0] === state.filter)[2](t)) return false;
    return !q || `${t.name} ${t.description} ${t.category}`.toLowerCase().includes(q);
  };
  const updatable = () => state.tools.filter((t) => t.state === 'update');

  function renderChrome() {
    const installed = state.tools.filter((t) => t.installedVersion);
    $('#installedCount').textContent = String(installed.length);
    const n = updatable().length;
    const ua = $('#updateAll');
    ua.hidden = n === 0 || state.view === 'settings';
    ua.replaceChildren(icon('up'), `Update all (${n})`);
    ua.disabled = [...state.busy].length > 0 && updatable().every((t) => state.busy.has(t.id));
    $('#toolbar').hidden = state.view === 'settings';
    $('#stateFilter').hidden = state.view !== 'library';
    $$('.nav-item').forEach((b) => { const on = b.dataset.view === state.view; b.classList.toggle('active', on); if (on) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); });
    $('#view-library').hidden = state.view !== 'library';
    $('#view-installed').hidden = state.view !== 'installed';
    $('#view-settings').hidden = state.view !== 'settings';
    // sidebar status chip
    const tone = { remote: ['ok', 'Online catalog'], cache: ['warn', 'Offline · saved list'], bundled: ['warn', 'Offline · built-in list'], dev: ['info', 'Dev catalog'] }[state.source] || ['info', state.loaded ? 'Catalog' : 'Loading…'];
    $('#statusChip').dataset.tone = tone[0];
    $('#statusText').textContent = tone[1];
    $('#statusChip').title = state.remoteError ? `Could not reach the online catalog: ${state.remoteError}` : '';
    $('#versionLabel').textContent = state.appVersion ? `v${state.appVersion}` : '';
    $('#footEnd').textContent = [state.appVersion && `Tools Launcher v${state.appVersion}`, { win32: 'Windows', linux: 'Linux', darwin: 'macOS' }[state.platform]].filter(Boolean).join(' · ');
    renderChecked();
    $('#aboutVersion').textContent = state.appVersion ? `v${state.appVersion}` : '';
    $('#aboutPlatform').textContent = { win32: 'Windows', linux: 'Linux', darwin: 'macOS' }[state.platform] || state.platform;
    $('#aboutSource').textContent = { remote: 'Online (GitHub)', cache: 'Saved copy (offline)', bundled: 'Built-in (offline)', dev: 'Development' }[state.source] || '';
  }

  /** "Checked 3 min ago" in the footer; shows nothing until the first catalog answer. */
  function renderChecked() {
    $('#checkedLabel').textContent = state.checkedAt ? `Checked ${timeAgo(new Date(state.checkedAt).toISOString())}` : '';
  }

  /** The status tabs (All / Installed / Updates / Not installed, each with its count) and the category select. */
  function renderFilters() {
    $('#stateFilter').replaceChildren(...FILTERS.map(([id, label, test]) => {
      const n = state.tools.filter(test).length;
      return el('button', { class: `seg-btn${id === 'updates' && n ? ' hot' : ''}`, 'aria-pressed': String(state.filter === id), 'data-filter': id, onclick: () => { state.filter = id; render(); } },
        label, ' ', el('span', { class: 'n' }, String(n)));
    }));
    const cats = ['All', ...new Set(state.tools.map((t) => t.category))];
    const sel = $('#category');
    $('#categoryBox').hidden = cats.length <= 2;
    if (state.category !== 'All' && !cats.includes(state.category)) state.category = 'All';
    sel.replaceChildren(...cats.map((c) => el('option', { value: c }, c === 'All' ? 'All categories' : c)));
    sel.value = state.category;
  }

  function renderGrid() {
    const grid = $('#grid');
    if (!state.loaded) { grid.replaceChildren(el('div', { class: 'grid' }, ...[0, 1, 2].map(() => el('div', { class: 'skeleton', 'aria-hidden': 'true' })))); $('#empty').hidden = true; return; }
    const list = state.tools.filter((t) => matches(t, true));
    // one labelled group per category, numbered continuously (01, 02, ...) the way the list reads top to bottom
    const groups = new Map();
    for (const t of list) { if (!groups.has(t.category)) groups.set(t.category, []); groups.get(t.category).push(t); }
    let number = 0, index = 0, g = 0;
    grid.replaceChildren(...[...groups].map(([cat, tools]) => el('section', { class: 'group', 'aria-label': cat },
      el('div', { class: 'group-head' }, el('span', {}, pad2(++g), ' / ', el('b', {}, cat)), el('span', {}, `${tools.length} ${tools.length === 1 ? 'tool' : 'tools'}`)),
      el('div', { class: 'grid' }, ...tools.map((t) => card(t, index++, firstGridRender, ++number))))));
    if (list.length) firstGridRender = false;
    $('#empty').hidden = list.length > 0;
  }

  function renderInstalled() {
    const list = state.tools.filter((t) => t.installedVersion && matches(t));
    $('#installedList').replaceChildren(...list.map(row));
    const none = state.loaded && !state.tools.some((t) => t.installedVersion);
    $('#installedEmpty').hidden = !none;
    if (state.loaded && !none && !list.length) $('#installedList').replaceChildren(el('p', { class: 'muted', style: null }, 'No installed tools match your search.'));
  }

  function render() {
    renderChrome(); renderFilters();
    if (state.view === 'library') renderGrid();
    if (state.view === 'installed') renderInstalled();
  }

  /** Re-render only the cards/rows of one tool (progress ticks) without replaying animations or losing hover/focus. */
  function patchTool(id) {
    const t = state.tools.find((x) => x.id === id);
    if (!t) return;
    $$(`[data-tool="${id}"].card, [data-tool="${id}"].row-item`).forEach((node) => {
      const status = $('.card-status', node);
      if (status) status.replaceChildren(statusPill(t));
      const foot =node.classList.contains('card') ? $('.card-foot', node) : $('.row-actions', node);
      if (foot) foot.replaceChildren(...actions(t, node.classList.contains('card') ? 'card' : 'row').map((n) => { if (!node.classList.contains('card') && n.classList && n.classList.contains('grow')) n.classList.remove('grow'); return n; }));
    });
  }

  // ---- data ---------------------------------------------------------------------------------------------------------------
  async function load(refresh = false) {
    const btnEl = $('#refresh');
    btnEl.classList.add('spin'); btnEl.disabled = true;
    try {
      const lib = await window.launcher.getLibrary(refresh);
      Object.assign(state, { tools: lib.tools, source: lib.source, remoteError: lib.remoteError, dev: lib.dev, platform: lib.platform, appVersion: lib.appVersion, loaded: true, checkedAt: Date.now() });
      const offline = { cache: 'Can\'t reach the online catalog, so this is the last list that was downloaded.', bundled: 'Can\'t reach the online catalog, so this is the built-in list and some tools may be unavailable.' }[lib.source];
      $('#banner').hidden = !offline;
      if (offline) $('#bannerText').textContent = offline;
    } catch (e) {
      state.loaded = true;
      $('#banner').hidden = false;
      $('#bannerText').textContent = `Could not load the catalog: ${cleanError(e)}`;
    } finally {
      btnEl.classList.remove('spin'); btnEl.disabled = false;
    }
    render();
  }

  async function act(kind, t) {
    let changed = true; // false when the user backed out: then nothing happened and nothing should be rebuilt
    try {
      if (kind === 'install') {
        const isUpdate = t.state === 'update';
        state.busy.add(t.id); state.progress[t.id] = { phase: 'download', bytes: 0, total: 0 };
        patchTool(t.id); renderChrome();
        await window.launcher.install(t.id);
        toast(`${t.name} ${isUpdate ? `updated to v${t.version}` : 'installed'}`);
      } else if (kind === 'launch') {
        await window.launcher.launch(t.id);
        toast(`Starting ${t.name}…`, 'info');
      } else if (kind === 'reveal') {
        await window.launcher.reveal(t.id);
      } else if (kind === 'uninstall') {
        const yes = await confirmDialog({ title: `Remove ${t.name}?`, body: 'The tool and its downloaded files are deleted. Your own files are not touched, and you can install it again any time.', confirmLabel: 'Remove', danger: true });
        if (!yes) { changed = false; return; }
        await window.launcher.uninstall(t.id);
        toast(`${t.name} removed`);
      }
    } catch (e) {
      toast(cleanError(e), 'err');
    } finally {
      state.busy.delete(t.id); delete state.progress[t.id];
      // Only install/remove change what is shown. Launch / "show files" / a cancelled dialog must NOT rebuild the
      // buttons: that would drop keyboard focus from the control the user just used.
      if (changed && (kind === 'install' || kind === 'uninstall')) await load();
    }
  }

  async function loadSettings() {
    const s = await window.launcher.getSettings();
    $('#catalogUrl').value = s.catalogUrl || '';
    $('#checkUpdates').checked = !!s.checkUpdatesOnStart;
  }
  const setMsg = (text, err) => { const m = $('#settingsMsg'); m.textContent = text; m.classList.toggle('err', !!err); };

  // ---- wiring --------------------------------------------------------------------------------------------------------------
  function setView(v) {
    state.view = v;
    if (v === 'settings') loadSettings().catch(() => {});
    render();
    $('#content').scrollTo({ top: 0, behavior: 'instant' });
  }
  $$('[data-icon]').forEach((n) => { n.innerHTML = ICONS[n.dataset.icon] || ''; });
  $$('.nav-item').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));
  $('#goLibrary').addEventListener('click', () => setView('library'));
  $('#search').addEventListener('input', (e) => { state.query = e.target.value; render(); });
  $('#category').addEventListener('change', (e) => { state.category = e.target.value; render(); });
  setInterval(renderChecked, 30000);
  $('#refresh').addEventListener('click', async () => { await load(true); toast(updatable().length ? `${updatable().length} update${updatable().length > 1 ? 's' : ''} available` : 'Everything is up to date', 'info'); });
  $('#bannerRetry').addEventListener('click', () => load(true));
  $('#updateAll').addEventListener('click', () => updatable().forEach((t) => act('install', t)));
  $('#openData').addEventListener('click', () => window.launcher.openDataDir());
  $('#resetCatalog').addEventListener('click', async () => {
    $('#catalogUrl').value = '';
    try { await window.launcher.setSettings({ catalogUrl: '' }); setMsg('Using the official catalog.'); await load(true); } catch (e) { setMsg(cleanError(e), true); }
  });
  $('#saveSettings').addEventListener('click', async () => {
    try {
      await window.launcher.setSettings({ catalogUrl: $('#catalogUrl').value, checkUpdatesOnStart: $('#checkUpdates').checked });
      setMsg('Saved.');
      await load(true);
    } catch (e) { setMsg(cleanError(e), true); }
  });
  $('#checkUpdates').addEventListener('change', async () => {
    try { await window.launcher.setSettings({ checkUpdatesOnStart: $('#checkUpdates').checked }); toast('Preference saved', 'info'); } catch (e) { toast(cleanError(e), 'err'); }
  });
  window.launcher.onProgress((p) => {
    if (!state.busy.has(p.id)) return;
    state.progress[p.id] = p;
    patchTool(p.id);
  });
  document.addEventListener('keydown', (e) => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test((document.activeElement || {}).tagName || '');
    if (e.key === '/' && !typing && !e.ctrlKey && !e.metaKey && state.view !== 'settings') { e.preventDefault(); $('#search').focus(); }
    else if (e.key === 'Escape' && document.activeElement === $('#search')) { if ($('#search').value) { $('#search').value = ''; state.query = ''; render(); } else $('#search').blur(); }
  });

  render(); // skeletons first
  load().then(async () => {
    const s = await window.launcher.getSettings().catch(() => ({}));
    if (s.checkUpdatesOnStart) { const n = updatable().length; if (n) toast(`${n} update${n > 1 ? 's' : ''} available`, 'info'); }
  });
})();
