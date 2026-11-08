'use strict';
(() => {
  const $ = (s) => document.querySelector(s);
  const FIELDS = ['title', 'artist', 'album', 'albumArtist', 'year', 'genre', 'track', 'trackCount', 'disc', 'discCount', 'composer', 'comment'];
  const NUMERIC = new Set(['year', 'track', 'trackCount', 'disc', 'discCount']);

  let items = [];                    // {path, name, tags, ..., status}
  let selected = new Set();          // paths
  let anchor = null;                 // last clicked path (shift-range)
  let sortKey = null, sortDesc = false;
  let dirty = new Set();             // edited field names
  let coverState = null;             // null | {action:'set', dataUrl} | {action:'remove'}
  let saving = false;

  const fmtDur = (ms) => { const s = Math.round(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
  const fmtBytes = (n) => { const u = ['B', 'KB', 'MB', 'GB']; let i = 0; while (n >= 1024 && i < 3) { n /= 1024; i++; } return `${n.toFixed(n < 10 && i ? 1 : 0)} ${u[i]}`; };
  const errText = (e) => String(e && e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
  const setStatus = (msg, err) => { const s = $('#status'); s.textContent = msg || ''; s.style.color = err ? 'var(--err)' : ''; };

  const sortValue = (it, key) => {
    if (key === 'name') return it.name.toLowerCase();
    if (!it.tags) return '';
    const v = it.tags[key];
    return typeof v === 'string' ? v.toLowerCase() : v;
  };
  const view = () => {
    if (!sortKey) return items;
    const out = [...items].sort((a, b) => {
      const x = sortValue(a, sortKey), y = sortValue(b, sortKey);
      const c = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), undefined, { numeric: true });
      return sortDesc ? -c : c;
    });
    return out;
  };

  // ---------- list ----------
  function renderList() {
    const tbody = $('#rows');
    tbody.replaceChildren(...view().map((it) => {
      const tr = document.createElement('tr');
      tr.className = 'row' + (selected.has(it.path) ? ' selected' : '') + (it.error ? ' error' : '') + (it.status ? ' ' + it.status : '');
      tr.dataset.path = it.path;
      const cells = it.error
        ? ['', it.name, it.error, '', it.name]
        : [it.tags.track ? String(it.tags.track) : '', it.tags.title || '', it.tags.artist, it.tags.album, it.name];
      cells.forEach((text, i) => { const td = document.createElement('td'); if (i === 0) td.className = 'num'; td.textContent = text; td.title = text; tr.append(td); });
      const st = document.createElement('td'); st.className = 'st';
      st.textContent = { working: 'Saving…', done: 'Saved', failed: 'Failed' }[it.status] || (it.error ? '' : fmtDur(it.durationMs));
      if (it.saveError) st.title = it.saveError;
      tr.append(st);
      return tr;
    }));
    $('#empty').hidden = items.length > 0;
    $('#count').textContent = items.length ? `${items.length} file${items.length > 1 ? 's' : ''}${selected.size ? ` · ${selected.size} selected` : ''}` : 'No files';
    $('#clear').hidden = !items.length;
    document.querySelectorAll('th[data-sort]').forEach((th) => {
      th.classList.toggle('sorted', th.dataset.sort === sortKey);
      th.classList.toggle('desc', th.dataset.sort === sortKey && sortDesc);
    });
  }

  function addItems(list) {
    const have = new Set(items.map((i) => i.path));
    let added = 0;
    for (const it of list) if (!have.has(it.path)) { items.push(it); added++; }
    setStatus(added ? `Added ${added} file${added > 1 ? 's' : ''}.` : (list.length ? 'Those files are already in the list.' : ''));
    renderList();
  }

  const selItems = () => view().filter((i) => selected.has(i.path) && !i.error);

  // ---------- editor ----------
  function confirmDiscard() {
    return !dirty.size && !coverState || confirm('Discard your unsaved changes?');
  }

  function clearDirty() {
    dirty = new Set(); coverState = null;
    document.querySelectorAll('[data-field]').forEach((el) => el.classList.remove('dirty'));
  }

  async function loadEditor() {
    const sel = selItems();
    $('#noSel').hidden = sel.length > 0;
    $('#editor').hidden = sel.length === 0;
    clearDirty();
    if (!sel.length) { updateButtons(); return; }

    for (const f of FIELDS) {
      const el = document.querySelector(`[data-field="${f}"]`);
      const vals = sel.map((i) => i.tags[f]);
      const same = vals.every((v) => v === vals[0]);
      el.value = same ? (NUMERIC.has(f) && !vals[0] ? '' : vals[0]) : '';
      el.placeholder = same ? '' : '(multiple)';
    }
    if (sel.length === 1) {
      const i = sel[0];
      $('#selInfo').replaceChildren();
      const b = document.createElement('b'); b.textContent = i.name; b.title = i.path;
      const meta = document.createElement('span');
      meta.textContent = [i.format.toUpperCase(), fmtDur(i.durationMs), i.bitrate ? `${Math.round(i.bitrate)} kbps` : '', i.sampleRate ? `${(i.sampleRate / 1000).toFixed(1)} kHz` : '', i.channels === 1 ? 'mono' : i.channels === 2 ? 'stereo' : '', fmtBytes(i.bytes)].filter(Boolean).join(' · ');
      $('#selInfo').append(b, meta);
    } else {
      $('#selInfo').textContent = `${sel.length} files selected - only fields you edit are changed.`;
    }
    $('#autoNumRow').hidden = sel.length < 2;
    $('#autoNum').checked = false;
    await showCover(sel);
    updateButtons();
  }

  async function showCover(sel) {
    const img = $('#coverImg');
    let src = null, note = '';
    if (coverState && coverState.action === 'set') { src = coverState.dataUrl; note = sel.length > 1 ? `Will be set on all ${sel.length} files` : 'Will replace the current cover'; }
    else if (coverState && coverState.action === 'remove') { note = 'Cover will be removed'; }
    else if (sel.length === 1) { if (sel[0].hasCover) { const c = await window.at.readCover(sel[0].path); src = c && c.dataUrl; } }
    else { const withCover = sel.filter((s) => s.hasCover).length; note = withCover ? `${withCover} of ${sel.length} have a cover` : 'None have a cover'; }
    img.hidden = !src; if (src) img.src = src; else img.removeAttribute('src');
    $('#coverNone').hidden = !!src;
    $('#coverFrame').classList.toggle('pending', !!coverState);
    $('#coverNote').textContent = note;
  }

  function updateButtons() {
    const changed = dirty.size > 0 || !!coverState || $('#autoNum').checked || $('#renameOn').checked;
    $('#save').disabled = saving || !changed;
    $('#revert').disabled = saving || !(dirty.size || coverState);
    $('#renamePat').disabled = !$('#renameOn').checked;
  }

  async function save(e) {
    e.preventDefault();
    const sel = selItems();
    if (!sel.length || saving) return;
    const patch = {};
    for (const f of dirty) patch[f] = document.querySelector(`[data-field="${f}"]`).value;
    if (coverState) patch.cover = { action: coverState.action };
    const rename = { enabled: $('#renameOn').checked, pattern: $('#renamePat').value };
    if (rename.enabled && !rename.pattern.trim()) { setStatus('Enter a file name pattern.', true); return; }
    if (rename.enabled && !confirm(`Rename ${sel.length} file${sel.length > 1 ? 's' : ''} using "${rename.pattern}"?`)) return;
    const paths = sel.map((i) => i.path);
    saving = true; updateButtons(); setStatus('Saving…');
    try {
      const results = await window.at.save({ paths, patch, rename, autoNumber: $('#autoNum').checked && sel.length > 1 });
      // apply renames, then re-read everything we touched
      const failed = results.filter((r) => !r.ok);
      const moved = new Map(results.filter((r) => r.ok).map((r) => [r.path, r.newPath]));
      const reread = await window.at.readTags([...moved.values()]);
      const byNew = new Map(reread.map((r) => [r.path, r]));
      selected = new Set();
      items = items.map((it) => {
        if (!moved.has(it.path)) { const f = failed.find((x) => x.path === it.path); return f ? { ...it, status: 'failed', saveError: f.error } : it; }
        const fresh = byNew.get(moved.get(it.path));
        if (fresh) selected.add(fresh.path);
        return fresh ? { ...fresh, status: 'done' } : it;
      });
      failed.forEach((f) => selected.add(f.path));
      clearDirty();
      setStatus(failed.length ? `Saved ${results.length - failed.length}, ${failed.length} failed: ${failed[0].error}` : `Saved ${results.length} file${results.length > 1 ? 's' : ''}.`, failed.length > 0);
    } catch (err) {
      setStatus(errText(err), true);
    } finally {
      saving = false; renderList(); await loadEditor();
    }
  }

  // ---------- selection ----------
  async function select(path, ev) {
    const order = view().map((i) => i.path);
    let next = new Set(selected);
    if (ev.shiftKey && anchor && order.includes(anchor)) {
      const a = order.indexOf(anchor), b = order.indexOf(path);
      next = new Set(order.slice(Math.min(a, b), Math.max(a, b) + 1));
    } else if (ev.ctrlKey || ev.metaKey) {
      next.has(path) ? next.delete(path) : next.add(path); anchor = path;
    } else { next = new Set([path]); anchor = path; }
    if (next.size === selected.size && [...next].every((p) => selected.has(p))) return;
    if (!confirmDiscard()) return;
    selected = next;
    items.forEach((i) => { if (i.status) delete i.status; });
    renderList(); await loadEditor();
  }

  // ---------- wiring ----------
  $('#rows').addEventListener('click', (e) => { const tr = e.target.closest('tr.row'); if (tr) select(tr.dataset.path, e); });
  $('#tableWrap').addEventListener('keydown', async (e) => {
    const order = view().map((i) => i.path);
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') { e.preventDefault(); if (!confirmDiscard()) return; selected = new Set(order); renderList(); await loadEditor(); return; }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const cur = anchor && order.includes(anchor) ? order.indexOf(anchor) : -1;
      const nxt = order[Math.min(order.length - 1, Math.max(0, cur + (e.key === 'ArrowDown' ? 1 : -1)))];
      if (nxt) select(nxt, e);
    }
  });
  document.querySelectorAll('th[data-sort]').forEach((th) => th.addEventListener('click', () => {
    sortDesc = sortKey === th.dataset.sort ? !sortDesc : false; sortKey = th.dataset.sort; renderList();
  }));
  $('#addFiles').addEventListener('click', async () => addItems(await window.at.pickFiles()));
  $('#addFolder').addEventListener('click', async () => addItems(await window.at.pickFolder()));
  $('#clear').addEventListener('click', async () => {
    if (!confirmDiscard()) return;
    items = []; selected = new Set(); anchor = null; setStatus(''); renderList(); await loadEditor();
  });

  document.querySelectorAll('[data-field]').forEach((el) => el.addEventListener('input', () => {
    dirty.add(el.dataset.field); el.classList.add('dirty'); updateButtons();
  }));
  $('#renameOn').addEventListener('change', updateButtons);
  $('#autoNum').addEventListener('change', updateButtons);
  $('#coverSet').addEventListener('click', async () => {
    try {
      const c = await window.at.pickCover();
      if (c) { coverState = { action: 'set', dataUrl: c.dataUrl }; await showCover(selItems()); updateButtons(); }
    } catch (err) { setStatus(errText(err), true); }
  });
  $('#coverRemove').addEventListener('click', async () => { coverState = { action: 'remove' }; await showCover(selItems()); updateButtons(); });
  $('#revert').addEventListener('click', loadEditor);
  $('#editor').addEventListener('submit', save);

  window.at.onSaveProgress((p) => {
    const it = items.find((i) => i.path === p.path);
    if (!it) return;
    it.status = p.status === 'error' ? 'failed' : p.status;
    renderList();
  });

  // drag & drop
  const wrap = $('#tableWrap');
  ['dragenter', 'dragover'].forEach((ev) => document.addEventListener(ev, (e) => { e.preventDefault(); wrap.classList.add('over'); }));
  document.addEventListener('dragleave', (e) => { if (e.target === document.documentElement || !e.relatedTarget) wrap.classList.remove('over'); });
  document.addEventListener('drop', async (e) => {
    e.preventDefault(); wrap.classList.remove('over');
    if (!e.dataTransfer || !e.dataTransfer.files.length) return;
    const paths = [...e.dataTransfer.files].map((f) => window.at.pathForFile(f)).filter(Boolean);
    addItems(await window.at.loadPaths(paths));
  });

  renderList(); updateButtons();
})();
