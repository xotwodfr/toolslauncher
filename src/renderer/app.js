'use strict';
(() => {
  const $ = (s) => document.querySelector(s);
  const state = { tools: [], view: 'library', query: '', progress: {}, busy: new Set() };

  const TITLES = { library: 'Library', installed: 'Installed', settings: 'Settings' };

  function toast(msg, isErr = false) {
    const el = document.createElement('div');
    el.className = 'toast' + (isErr ? ' err' : '');
    el.textContent = msg;
    $('#toasts').appendChild(el);
    setTimeout(() => el.remove(), isErr ? 6000 : 3000);
  }

  function fmtBytes(n) {
    if (!n) return '';
    const u = ['B', 'KB', 'MB', 'GB'];
    let i = 0;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return `${n.toFixed(n < 10 && i ? 1 : 0)} ${u[i]}`;
  }

  function el(tag, props = {}, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === 'class') e.className = v;
      else if (k === 'style') e.style.cssText = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v);
    }
    for (const kid of kids) if (kid != null) e.append(kid);
    return e;
  }

  function visibleTools() {
    const q = state.query.trim().toLowerCase();
    return state.tools.filter((t) => {
      if (state.view === 'installed' && !t.installedVersion) return false;
      if (!q) return true;
      return (t.name + ' ' + t.description + ' ' + t.category).toLowerCase().includes(q);
    });
  }

  function card(t) {
    const prog = state.progress[t.id];
    const busy = state.busy.has(t.id);

    const meta = el('div', { class: 'card-meta' }, el('span', {}, t.category),
      t.state === 'update'
        ? el('span', { class: 'upd', title: 'A newer version is available' }, `v${t.installedVersion} → v${t.version}`)
        : el('span', {}, `v${t.installedVersion || t.version}`));
    if (t.size) meta.append(el('span', {}, fmtBytes(t.size)));

    const head = el('div', { class: 'card-head' },
      el('div', { class: 'icon', style: `background:${t.accent}` }, t.glyph),
      el('div', {}, el('div', { class: 'card-title' }, t.name), meta));

    const foot = el('div', { class: 'card-foot' });
    if (busy) {
      const indet = !prog || prog.phase !== 'download' || !prog.total;
      const pct = prog && prog.total ? Math.round((prog.bytes / prog.total) * 100) : 0;
      const label = { download: 'Downloading', verify: 'Verifying', install: 'Installing', done: 'Done' }[prog && prog.phase] || 'Starting';
      foot.append(
        el('div', { class: 'grow' },
          el('div', { class: 'phase' }, `${label}${prog && prog.phase === 'download' && prog.total ? ` ${pct}%` : '…'}`),
          el('div', { class: 'progress' + (indet ? ' indet' : '') }, el('i', { style: `width:${indet ? 40 : pct}%` }))));
    } else if (t.state === 'unavailable') {
      foot.append(el('span', { class: 'pill' }, 'Coming soon'));
    } else if (t.state === 'available') {
      foot.append(el('button', { class: 'btn primary main', onclick: () => act('install', t) }, 'Install'));
    } else {
      if (t.state === 'update') {
        // the update gets its own full-width row so it can't be missed
        foot.classList.add('wrap');
        foot.append(el('button', { class: 'btn primary full', title: `Download and install v${t.version}`, onclick: () => act('install', t) }, `Update to v${t.version}`));
      }
      foot.append(el('button', { class: 'btn go main', onclick: () => act('launch', t) }, 'Launch'));
      foot.append(
        el('button', { class: 'btn ghost small', title: 'Show files', onclick: () => act('reveal', t) }, 'Files'),
        el('button', { class: 'btn ghost small', title: 'Uninstall', onclick: () => act('uninstall', t) }, 'Remove'));
    }

    return el('article', { class: 'card' }, head, el('div', { class: 'card-desc' }, t.description), foot);
  }

  function render() {
    const grid = $('#grid');
    grid.replaceChildren(...visibleTools().map(card));
    $('#empty').hidden = grid.children.length > 0;
    $('#installedCount').textContent = state.tools.filter((t) => t.installedVersion).length;
    const updates = state.tools.filter((t) => t.state === 'update');
    $('#updateAll').hidden = updates.length === 0;
    $('#updateAll').textContent = `Update all (${updates.length})`;
    $('#viewTitle').textContent = TITLES[state.view];
    $('#view-library').hidden = state.view === 'settings';
    $('#view-settings').hidden = state.view !== 'settings';
    $('.topbar-actions').querySelector('#search').hidden = state.view === 'settings';
    document.querySelectorAll('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.view === state.view));
  }

  async function load(refresh = false) {
    try {
      const lib = await window.launcher.getLibrary(refresh);
      state.tools = lib.tools;
      $('#envLabel').textContent = lib.dev ? 'Dev catalog' : (lib.platform === 'win32' ? 'Windows' : lib.platform);
      $('#versionLabel').textContent = `v${lib.appVersion}`;
      const offline = {
        cache: 'Can\'t reach the online catalog - showing the last list that was downloaded.',
        bundled: 'Can\'t reach the online catalog - showing the built-in list, so some tools may be unavailable.',
      }[lib.source];
      $('#banner').hidden = !offline;
      if (offline) $('#banner').textContent = offline;
      $('#envLabel').title = lib.remoteError || '';
    } catch (e) {
      $('#banner').hidden = false;
      $('#banner').textContent = `Could not load the catalog: ${e.message}`;
    }
    render();
  }

  async function act(kind, t) {
    try {
      if (kind === 'install') {
        state.busy.add(t.id);
        state.progress[t.id] = { phase: 'download', bytes: 0, total: 0 };
        render();
        await window.launcher.install(t.id);
        toast(`${t.name} ${t.state === 'update' ? 'updated' : 'installed'}`);
      } else if (kind === 'launch') {
        await window.launcher.launch(t.id);
      } else if (kind === 'reveal') {
        await window.launcher.reveal(t.id);
      } else if (kind === 'uninstall') {
        if (!confirm(`Remove ${t.name}?`)) return;
        await window.launcher.uninstall(t.id);
        toast(`${t.name} removed`);
      }
    } catch (e) {
      toast(e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), true);
    } finally {
      state.busy.delete(t.id);
      delete state.progress[t.id];
      await load();
    }
  }

  async function loadSettings() {
    const s = await window.launcher.getSettings();
    $('#catalogUrl').value = s.catalogUrl || '';
    $('#checkUpdates').checked = !!s.checkUpdatesOnStart;
  }

  function wire() {
    document.querySelectorAll('.nav-item').forEach((b) =>
      b.addEventListener('click', () => { state.view = b.dataset.view; if (state.view === 'settings') loadSettings(); render(); }));
    $('#search').addEventListener('input', (e) => { state.query = e.target.value; render(); });
    $('#refresh').addEventListener('click', async () => { await load(true); toast('Catalog refreshed'); });
    $('#updateAll').addEventListener('click', () => {
      state.tools.filter((t) => t.state === 'update').forEach((t) => act('install', t));
    });
    $('#openData').addEventListener('click', () => window.launcher.openDataDir());
    $('#saveSettings').addEventListener('click', async () => {
      try {
        await window.launcher.setSettings({
          catalogUrl: $('#catalogUrl').value,
          checkUpdatesOnStart: $('#checkUpdates').checked,
        });
        $('#settingsMsg').textContent = 'Saved.';
        await load(true);
      } catch (e) {
        $('#settingsMsg').textContent = e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
      }
    });
    window.launcher.onProgress((p) => {
      state.progress[p.id] = p;
      render();
    });
  }

  wire();
  load().then(async () => {
    const s = await window.launcher.getSettings();
    if (s.checkUpdatesOnStart) {
      const n = state.tools.filter((t) => t.state === 'update').length;
      if (n) toast(`${n} update${n > 1 ? 's' : ''} available`);
    }
  });
})();
