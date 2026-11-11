'use strict';
(() => {
  const api = window.notes;
  const $ = (id) => document.getElementById(id);
  const el = (tag, attrs, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) { if (v === false || v == null) continue; if (k === 'class') n.className = v; else if (k.startsWith('on')) n.addEventListener(k.slice(2), v); else n.setAttribute(k, v === true ? '' : v); }
    for (const kid of kids) if (kid != null) n.append(kid);
    return n;
  };
  const stem = (rel) => rel.split('/').pop().replace(/\.(md|markdown)$/i, '');
  const dirOf = (rel) => rel.split('/').slice(0, -1).join('/');

  const S = {
    folder: null,          // summary from main: root, name, notes, dirs, tags, pinned, recent
    rel: null,             // the open note
    base: null,            // content hash the editor started from (for conflict checks)
    dirty: false, saving: null, saveTimer: null, renderTimer: null,
    conflict: null,        // { text, hash } when the file changed outside while you were typing
    view: 'split', open: new Set(), selectedDir: '', tag: '', query: '',
    lastRender: '', words: 0,
  };

  // ---- small UI helpers ------------------------------------------------------------------------------------------------
  let toastTimer = null;
  function toast(text, err = false) {
    const t = $('toast'); t.textContent = text; t.className = 'toast' + (err ? ' err' : ''); t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 4200);
  }
  function banner(text, actions = [], kind = '') {
    $('bannerText').textContent = text || '';
    $('banner').className = 'banner' + (kind ? ' ' + kind : '');
    const box = $('bannerActions'); box.replaceChildren(...actions.map(([label, fn, cls]) => el('button', { class: 'btn small' + (cls ? ' ' + cls : ''), onclick: fn }, label)));
    $('banner').hidden = !text;
  }
  function result(text, kind, file) {
    const r = $('result');
    r.replaceChildren(el('span', {}, text));
    if (file) r.append(el('button', { class: 'btn ghost small', onclick: () => api.reveal(file) }, 'Show in folder'));
    r.className = 'result' + (kind ? ' ' + kind : ''); r.hidden = !text;
  }
  const failed = (r) => { if (r && r.error) { toast(r.error, true); return true; } return false; };
  function setSaveState(text, kind) { const s = $('saveState'); s.textContent = text; s.className = 'save' + (kind ? ' ' + kind : ''); }

  /** A small modal: title, text, optional text box or list. Resolves to the value, or null when cancelled. */
  function ask({ title, text = '', value = null, options = null, ok = 'OK', danger = false, validate = null }) {
    const d = $('dlg');
    $('dlgTitle').textContent = title; $('dlgText').textContent = text; $('dlgText').hidden = !text;
    const input = $('dlgInput'); const select = $('dlgSelect'); const errBox = $('dlgError');
    input.hidden = value == null; select.hidden = !options; errBox.hidden = true;
    if (value != null) input.value = value;
    if (options) select.replaceChildren(...options.map(([v, label]) => el('option', { value: v }, label)));
    $('dlgOk').textContent = ok; $('dlgOk').className = 'btn ' + (danger ? 'danger' : 'primary');
    return new Promise((resolve) => {
      const done = (v) => { d.close(); cleanup(); resolve(v); };
      const submit = (e) => {
        e.preventDefault();
        const v = value != null ? input.value : options ? select.value : true;
        const problem = validate ? validate(v) : '';
        if (problem) { errBox.textContent = problem; errBox.hidden = false; return; }
        done(v);
      };
      const cancel = () => done(null);
      const onCancelEvt = (e) => { e.preventDefault(); cancel(); };
      const cleanup = () => { $('dlgForm').removeEventListener('submit', submit); $('dlgCancel').removeEventListener('click', cancel); d.removeEventListener('cancel', onCancelEvt); };
      $('dlgForm').addEventListener('submit', submit); $('dlgCancel').addEventListener('click', cancel); d.addEventListener('cancel', onCancelEvt);
      d.showModal();
      if (value != null) { input.focus(); const dot = input.value.lastIndexOf('.'); input.setSelectionRange(0, dot > 0 && /\.(md|markdown)$/i.test(input.value) ? dot : input.value.length); }
      else if (options) select.focus(); else $('dlgOk').focus();
    });
  }
  const nameProblem = (s) => {
    if (!String(s).trim()) return 'Type a name.';
    if (/[<>:"/\\|?*]/.test(s)) return 'A name cannot contain any of these: < > : " / \\ | ? *';
    if (/^\./.test(s.trim()) || /[. ]$/.test(s)) return 'A name cannot start with a dot or end with a dot or a space.';
    return '';
  };

  /** A pop-up menu at a point or under an element. items: [label, fn, {danger}] or '-' for a line. */
  function menu(items, at) {
    const m = $('menu');
    m.replaceChildren(...items.map((it) => (it === '-' ? el('hr') : el('button', { role: 'menuitem', class: it[2] && it[2].danger ? 'danger' : '', onclick: () => { hideMenu(); it[1](); } }, it[0]))));
    m.hidden = false;
    const r = at instanceof Element ? at.getBoundingClientRect() : null;
    let x = r ? r.right - m.offsetWidth : at.x; let y = r ? r.bottom + 4 : at.y;
    x = Math.max(4, Math.min(x, innerWidth - m.offsetWidth - 4)); y = Math.max(4, Math.min(y, innerHeight - m.offsetHeight - 4));
    m.style.left = x + 'px'; m.style.top = y + 'px';
    const first = m.querySelector('button'); if (first) first.focus();
  }
  const hideMenu = () => { $('menu').hidden = true; };
  document.addEventListener('mousedown', (e) => { if (!$('menu').hidden && !$('menu').contains(e.target)) hideMenu(); });
  $('menu').addEventListener('keydown', (e) => {
    const b = [...$('menu').querySelectorAll('button')]; const i = b.indexOf(document.activeElement);
    if (e.key === 'Escape') hideMenu();
    else if (e.key === 'ArrowDown') { e.preventDefault(); (b[i + 1] || b[0]).focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); (b[i - 1] || b[b.length - 1]).focus(); }
  });

  // ---- the editor --------------------------------------------------------------------------------------------------------
  const shadow = $('editor').attachShadow({ mode: 'open' });
  const mount = document.createElement('div');
  mount.style.height = '100%';
  shadow.append(mount);
  const ed = window.NotesEditor.create(mount, {
    root: shadow,
    placeholder: 'Start writing…',
    onChange: () => { markDirty(); scheduleRender(); },
    onFiles: (files, pos) => addPictures(files, pos),
    onScroll: () => syncScroll(),
  });

  function markDirty() {
    if (!S.rel) return;
    S.dirty = true; setSaveState('Not saved yet', 'dirty');
    clearTimeout(S.saveTimer);
    S.saveTimer = setTimeout(() => save(), 700);
  }

  /** Save the open note (atomic in main). A change made in another program meanwhile is a conflict, never overwritten. */
  async function save({ force = false } = {}) {
    clearTimeout(S.saveTimer);
    if (!S.rel || (!S.dirty && !force)) return true;
    if (S.conflict && !force) return false;
    if (S.saving) { await S.saving; if (!S.dirty && !force) return true; }
    const rel = S.rel; const text = ed.getText();
    setSaveState('Saving…', 'dirty');
    S.saving = api.save(rel, text, S.base, force);
    let r;
    try { r = await S.saving; } finally { S.saving = null; }
    if (rel !== S.rel) return true;
    if (r && r.conflict) { showConflict(r.text, r.hash); return false; }
    if (failed(r)) { setSaveState('Could not save', 'err'); banner('This note could not be saved: ' + r.error, [['Try again', () => save({ force: true })]]); return false; }
    S.base = r.hash;
    if (ed.getText() === text) { S.dirty = false; setSaveState('Saved', 'ok'); } else markDirty();
    if (S.conflict) { S.conflict = null; banner(''); }
    return true;
  }

  function showConflict(text, hash) {
    S.conflict = { text, hash };
    setSaveState('Not saved: changed elsewhere', 'err');
    banner('This note was changed in another program while you were typing here. Which version do you want to keep?', [
      ['Keep mine', async () => { S.conflict = null; banner(''); S.dirty = true; await save({ force: true }); }, 'primary'],
      ['Use the other version', () => { const c = S.conflict; S.conflict = null; banner(''); ed.replaceAll(c.text); S.base = c.hash; S.dirty = false; setSaveState('Reloaded', 'ok'); renderNow(); }],
    ], 'warn');
  }

  api.onExternal(async (ev) => {
    if (!S.rel || ev.rel !== S.rel) return;
    if (ev.gone) {
      if (!S.dirty) banner('This note was moved or deleted outside the app. Typing here will save it again under its old name.', [['Close note', () => { banner(''); closeNote(); }]], 'warn');
      return;
    }
    if (ev.text === ed.getText()) { S.base = ev.hash; return; }
    if (!S.dirty && !S.saving) { ed.replaceAll(ev.text); S.base = ev.hash; setSaveState('Reloaded (changed outside)', 'ok'); renderNow(); return; }
    showConflict(ev.text, ev.hash);
  });

  // ---- preview -------------------------------------------------------------------------------------------------------------
  function scheduleRender() {
    clearTimeout(S.renderTimer);
    const len = ed.view.state.doc.length;
    S.renderTimer = setTimeout(renderNow, len > 400000 ? 900 : len > 60000 ? 350 : 120);
  }
  async function renderNow() {
    clearTimeout(S.renderTimer);
    if (!S.rel) return;
    const rel = S.rel; const text = ed.getText();
    const r = await api.render(rel, text);
    if (rel !== S.rel || !r || r.error) return;
    S.words = r.words;
    $('words').textContent = `${r.words.toLocaleString()} word${r.words === 1 ? '' : 's'} · ${text.length.toLocaleString()} characters`;
    if (r.html === S.lastRender) return;
    S.lastRender = r.html;
    const wrap = $('previewWrap'); const top = wrap.scrollTop;
    $('preview').innerHTML = r.html; // sanitised in main by an allow-list; the page's CSP forbids inline scripts too
    wrap.scrollTop = top;
  }

  let syncing = false;
  function syncScroll() {
    if (S.view !== 'split' || syncing) return;
    syncing = true;
    requestAnimationFrame(() => {
      syncing = false;
      const line = ed.topLine();
      const blocks = [...$('preview').querySelectorAll('[data-line]')];
      let best = null;
      for (const b of blocks) { if (Number(b.dataset.line) <= line) best = b; else break; }
      const wrap = $('previewWrap');
      if (!best) { wrap.scrollTop = 0; return; }
      wrap.scrollTop = best.offsetTop - 16;
    });
  }

  $('preview').addEventListener('click', async (e) => {
    const box = e.target.closest('input.task');
    if (box) { e.preventDefault(); toggleTask(Number(box.dataset.line)); return; }
    const a = e.target.closest('a');
    if (!a) return;
    e.preventDefault();
    if (a.classList.contains('wikilink')) { followWiki(a.dataset.wiki, a.dataset.heading); return; }
    if (a.classList.contains('tag')) { setTag(a.dataset.tag); return; }
    const href = a.getAttribute('href') || '';
    if (href.startsWith('#')) { scrollToId(decodeURIComponent(href.slice(1))); return; }
    const r = await api.openLink(href, S.rel);
    if (failed(r)) return;
    if (r.rel) { await openNote(r.rel); if (r.anchor) scrollToId(r.anchor); }
  });
  function scrollToId(id) {
    const t = id && document.getElementById(id);
    if (!t || !$('preview').contains(t)) return;
    $('previewWrap').scrollTop = t.offsetTop - 12;
    t.classList.remove('flash'); void t.offsetWidth; t.classList.add('flash');
    if (t.dataset.line) ed.gotoLine(Number(t.dataset.line));
  }
  function toggleTask(line) {
    const text = ed.getText();
    const lines = text.split('\n');
    if (!(line >= 0 && line < lines.length)) return;
    const m = /^(\s*(?:[-*+]|\d+[.)])\s+\[)([ xX])(\].*)$/.exec(lines[line].replace(/\r$/, ''));
    if (!m) return;
    const from = lines.slice(0, line).reduce((n, l) => n + l.length + 1, 0) + m[1].length;
    ed.view.dispatch({ changes: { from, to: from + 1, insert: m[2] === ' ' ? 'x' : ' ' } });
    renderNow();
  }
  async function followWiki(target, heading) {
    if (!target) { if (heading) scrollToHeading(heading); return; }
    await save();
    const r = await api.openWiki(target, S.rel);
    if (failed(r)) return;
    await openNote(r.rel);
    if (r.created) toast(`Made a new note “${stem(r.rel)}”.`);
    if (heading) scrollToHeading(heading);
  }
  function scrollToHeading(h) {
    const want = String(h).toLowerCase().trim();
    const hs = [...$('preview').querySelectorAll('h1,h2,h3,h4,h5,h6')];
    const t = hs.find((x) => x.textContent.toLowerCase().trim() === want) || hs.find((x) => x.id === want.replace(/\s+/g, '-'));
    if (t) scrollToId(t.id);
  }

  // ---- pictures ------------------------------------------------------------------------------------------------------------
  async function addPictures(files, pos) {
    if (!S.rel) return;
    const pics = files.filter((f) => /^image\//.test(f.type) || /\.(png|jpe?g|gif|webp|bmp|avif)$/i.test(f.name));
    if (!pics.length) { toast('Only pictures can be dropped into a note.', true); return; }
    const links = [];
    for (const f of pics) {
      if (f.size > 50 * 1024 * 1024) { toast(`“${f.name}” is bigger than 50 MB.`, true); continue; }
      const bytes = new Uint8Array(await f.arrayBuffer());
      const r = await api.saveAttachment(S.rel, bytes, f.name && f.name !== 'image.png' ? f.name : '');
      if (failed(r)) continue;
      links.push(r.markdown);
    }
    if (!links.length) return;
    ed.insert(links.join('\n') + (pos == null ? '' : '\n'), pos);
    toast(links.length === 1 ? 'Picture saved in the attachments folder.' : `${links.length} pictures saved in the attachments folder.`);
  }

  // ---- notes: open, close ---------------------------------------------------------------------------------------------------
  async function openNote(rel) {
    if (rel === S.rel) return true;
    if (!(await save())) { if (S.conflict) { toast('Decide which version of this note to keep first.', true); return false; } }
    const r = await api.read(rel);
    if (failed(r)) return false;
    S.rel = r.rel; S.base = r.hash; S.dirty = false; S.conflict = null; S.lastRender = '';
    banner('');
    ed.load(r.text);
    $('empty').hidden = true; $('note').hidden = false; $('statusbar').hidden = false; $('exportBtn').disabled = false;
    setSaveState('Saved', '');
    setPinned(r.pinned);
    setBacklinks(r.backlinks);
    if (S.folder) S.folder.recent = r.recent;
    showCrumbs();
    // make sure its folder is open in the tree
    const parts = rel.split('/'); for (let i = 1; i < parts.length; i++) S.open.add(parts.slice(0, i).join('/'));
    S.selectedDir = dirOf(rel);
    drawSide();
    await renderNow();
    $('previewWrap').scrollTop = 0;
    if (S.view !== 'preview') ed.focus();
    return true;
  }
  function closeNote() {
    S.rel = null; S.base = null; S.dirty = false; S.conflict = null;
    api.close();
    $('note').hidden = true; $('empty').hidden = false; $('exportBtn').disabled = true; $('statusbar').hidden = true;
    drawSide();
  }
  function showCrumbs() {
    const parts = S.rel.split('/');
    const c = $('crumbs'); c.replaceChildren();
    parts.slice(0, -1).forEach((p) => c.append(p, ' / '));
    c.append(el('b', {}, stem(S.rel)));
    c.title = S.rel;
    document.title = stem(S.rel) + ' · Markdown Notes';
  }
  function setPinned(on) { $('pinBtn').setAttribute('aria-pressed', on ? 'true' : 'false'); $('pinBtn').textContent = on ? '★ Pinned' : '☆ Pin'; }
  function setBacklinks(list) {
    const b = $('backlinks');
    b.textContent = list && list.length ? `Linked from: ${list.map(stem).join(', ')}` : '';
    b.title = list && list.length ? list.join('\n') : '';
  }

  // ---- the sidebar ----------------------------------------------------------------------------------------------------------
  function drawSide() {
    const f = S.folder; if (!f) return;
    $('folderBtn').textContent = '▸ ' + f.name; $('folderBtn').title = f.root + '\n(click to choose another notes folder)';
    // pinned and recent
    const itemBtn = (n) => el('button', { class: 'it trunc' + (n.rel === S.rel ? ' on' : ''), title: n.rel, onclick: () => openNote(n.rel) }, n.title || stem(n.rel));
    $('pinned').replaceChildren(...f.pinned.map(itemBtn)); $('pinnedSec').hidden = !f.pinned.length;
    const recent = (f.recent || []).filter((n) => n.rel !== S.rel).slice(0, 5);
    $('recent').replaceChildren(...recent.map(itemBtn)); $('recentSec').hidden = !recent.length;
    // tags
    $('tags').replaceChildren(...f.tags.slice(0, 60).map((t) => el('button', { class: 'tag' + (t.tag === S.tag ? ' on' : ''), onclick: () => setTag(t.tag === S.tag ? '' : t.tag), title: `${t.count} note${t.count === 1 ? '' : 's'}` }, '#' + t.tag, el('span', { class: 'n' }, String(t.count)))));
    $('tagsSec').hidden = !f.tags.length;
    $('noteCount').textContent = f.notes.length ? String(f.notes.length) : '';
    drawTree();
  }

  function buildTree() {
    const rootNode = { name: '', rel: '', dirs: new Map(), notes: [] };
    const ensure = (rel) => {
      let n = rootNode;
      if (!rel) return n;
      let acc = '';
      for (const part of rel.split('/')) { acc = acc ? acc + '/' + part : part; if (!n.dirs.has(part)) n.dirs.set(part, { name: part, rel: acc, dirs: new Map(), notes: [] }); n = n.dirs.get(part); }
      return n;
    };
    for (const d of S.folder.dirs) ensure(d);
    for (const rel of S.folder.notes) ensure(dirOf(rel)).notes.push(rel);
    return rootNode;
  }
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
  function drawTree() {
    const tree = $('tree');
    const t = buildTree();
    const out = [];
    const walk = (node, depth) => {
      const dirs = [...node.dirs.values()].sort((a, b) => collator.compare(a.name, b.name));
      for (const d of dirs) {
        const open = S.open.has(d.rel);
        out.push(el('button', { class: 'node dir' + (S.selectedDir === d.rel && !S.rel ? ' on' : ''), role: 'treeitem', 'aria-expanded': open ? 'true' : 'false', 'data-rel': d.rel, 'data-dir': '1', draggable: 'true', style: null, title: d.rel },
          el('span', { class: 'ico' }, open ? '▾' : '▸'), el('span', { class: 'name trunc' }, d.name)));
        out[out.length - 1].style.paddingLeft = (10 + depth * 16) + 'px';
        if (open) {
          walk(d, depth + 1);
          if (!d.dirs.size && !d.notes.length) { const e = el('div', { class: 'empty-dir' }, 'empty'); e.style.paddingLeft = (38 + depth * 16) + 'px'; out.push(e); }
        }
      }
      for (const rel of node.notes.slice().sort((a, b) => collator.compare(stem(a), stem(b)))) {
        const b = el('button', { class: 'node file' + (rel === S.rel ? ' on' : ''), role: 'treeitem', 'data-rel': rel, draggable: 'true', title: rel }, el('span', { class: 'ico' }, '·'), el('span', { class: 'name trunc' }, stem(rel)));
        b.style.paddingLeft = (10 + depth * 16) + 'px';
        out.push(b);
      }
    };
    walk(t, 0);
    tree.replaceChildren(...out);
    if (!S.folder.notes.length && !S.folder.dirs.length) tree.append(el('div', { class: 'empty-dir' }, 'No notes yet.'));
  }

  $('tree').addEventListener('click', (e) => {
    const n = e.target.closest('.node'); if (!n) return;
    const rel = n.dataset.rel;
    if (n.dataset.dir) { if (S.open.has(rel)) S.open.delete(rel); else S.open.add(rel); S.selectedDir = rel; drawTree(); return; }
    openNote(rel);
  });
  $('tree').addEventListener('contextmenu', (e) => {
    const n = e.target.closest('.node'); if (!n) return;
    e.preventDefault();
    entryMenu(n.dataset.rel, !!n.dataset.dir, { x: e.clientX, y: e.clientY });
  });
  $('tree').addEventListener('keydown', (e) => {
    const n = e.target.closest('.node'); if (!n) return;
    const nodes = [...$('tree').querySelectorAll('.node')]; const i = nodes.indexOf(n);
    if (e.key === 'ArrowDown') { e.preventDefault(); (nodes[i + 1] || n).focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); (nodes[i - 1] || n).focus(); }
    else if (e.key === 'F2') { e.preventDefault(); renameEntry(n.dataset.rel, !!n.dataset.dir); }
    else if (e.key === 'Delete') { e.preventDefault(); deleteEntry(n.dataset.rel, !!n.dataset.dir); }
    else if (n.dataset.dir && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) { e.preventDefault(); if (e.key === 'ArrowRight') S.open.add(n.dataset.rel); else S.open.delete(n.dataset.rel); drawTree(); const again = $('tree').querySelector(`.node[data-rel="${CSS.escape(n.dataset.rel)}"]`); if (again) again.focus(); }
  });
  // drag a note or folder onto a folder (or onto the "Notes" heading for the top level) to move it
  let dragRel = null;
  $('tree').addEventListener('dragstart', (e) => { const n = e.target.closest('.node'); if (!n) return; dragRel = n.dataset.rel; e.dataTransfer.setData('text/x-note', dragRel); e.dataTransfer.effectAllowed = 'move'; });
  $('tree').addEventListener('dragend', () => { dragRel = null; document.querySelectorAll('.over').forEach((x) => x.classList.remove('over')); });
  const dropTarget = (e) => { const n = e.target.closest('.node.dir'); if (n) return n.dataset.rel; if (e.target.closest('#treeHead')) return ''; return null; };
  for (const zone of [$('tree'), $('treeHead')]) {
    zone.addEventListener('dragover', (e) => {
      if (!dragRel) return;
      const t = dropTarget(e); document.querySelectorAll('.over').forEach((x) => x.classList.remove('over'));
      if (t == null) return;
      e.preventDefault(); e.dataTransfer.dropEffect = 'move';
      (t === '' ? $('treeHead') : e.target.closest('.node.dir')).classList.add('over');
    });
    zone.addEventListener('drop', (e) => { const t = dropTarget(e); if (dragRel && t != null) { e.preventDefault(); moveEntry(dragRel, t); } });
  }

  function entryMenu(rel, isDir, at) {
    const items = [];
    if (isDir) items.push(['New note here', () => newNote(rel)], ['New folder here', () => newFolder(rel)], '-');
    else items.push(['Open', () => openNote(rel)], [S.folder.pinned.some((p) => p.rel === rel) ? 'Unpin' : 'Pin', () => togglePin(rel)], '-');
    items.push(['Rename…', () => renameEntry(rel, isDir)], ['Move to…', () => moveDialog(rel, isDir)], '-', ['Move to Recycle Bin…', () => deleteEntry(rel, isDir), { danger: true }]);
    menu(items, at);
  }

  async function newNote(dirRel) {
    const dir = dirRel != null ? dirRel : (S.rel ? dirOf(S.rel) : S.selectedDir || '');
    const name = await ask({ title: 'New note', text: dir ? `In “${dir}”.` : 'At the top of your notes folder.', value: 'Untitled', ok: 'Create', validate: nameProblem });
    if (name == null) return;
    const r = await api.createNote(dir, name.trim());
    if (failed(r)) return;
    if (r.rel) { await openNote(r.rel); ed.gotoLine(2); }
  }
  async function newFolder(dirRel) {
    const dir = dirRel != null ? dirRel : (S.rel ? dirOf(S.rel) : S.selectedDir || '');
    const name = await ask({ title: 'New folder', text: dir ? `Inside “${dir}”.` : 'At the top of your notes folder.', value: '', ok: 'Create', validate: nameProblem });
    if (name == null) return;
    const r = await api.createFolder(dir, name.trim());
    if (failed(r)) return;
    S.open.add(r.rel); if (dir) S.open.add(dir); S.selectedDir = r.rel; drawTree();
  }
  async function renameEntry(rel, isDir) {
    const old = isDir ? rel.split('/').pop() : stem(rel);
    const name = await ask({ title: isDir ? 'Rename folder' : 'Rename note', value: old, ok: 'Rename', validate: nameProblem });
    if (name == null || name.trim() === old) return;
    if (!isDir && rel === S.rel && !(await save())) return;
    S.moving = true;
    try { afterMove(rel, await api.rename(rel, name.trim())); } finally { S.moving = false; }
  }
  async function moveDialog(rel, isDir) {
    const dirs = ['', ...S.folder.dirs].filter((d) => !(isDir && (d === rel || d.startsWith(rel + '/'))) && d !== dirOf(rel));
    if (!dirs.length) { toast('There is no other folder to move it to. Make one with New folder.'); return; }
    const to = await ask({ title: `Move “${isDir ? rel.split('/').pop() : stem(rel)}”`, text: 'To which folder?', options: dirs.map((d) => [d, d ? d : '(top of the notes folder)']), ok: 'Move' });
    if (to == null) return;
    moveEntry(rel, to);
  }
  async function moveEntry(rel, toDir) {
    if (rel === S.rel && !(await save())) return;
    S.moving = true;
    try { afterMove(rel, await api.move(rel, toDir)); } finally { S.moving = false; }
  }
  function afterMove(oldRel, r) {
    if (failed(r)) return;
    if (S.rel && (S.rel === oldRel || S.rel.startsWith(oldRel + '/'))) { S.rel = r.current || r.rel; showCrumbs(); }
    if (S.open.has(oldRel)) { S.open.delete(oldRel); S.open.add(r.rel); }
    const parts = r.rel.split('/'); for (let i = 1; i < parts.length; i++) S.open.add(parts.slice(0, i).join('/'));
    drawSide();
  }
  async function deleteEntry(rel, isDir) {
    let text = `“${isDir ? rel : stem(rel)}” goes to the Recycle Bin, so you can get it back from there.`;
    if (isDir) { const info = await api.info(rel); if (info && info.notes) text = `The folder “${rel}” and the ${info.notes} note${info.notes === 1 ? '' : 's'} in it go to the Recycle Bin, so you can get them back from there.`; }
    const ok = await ask({ title: isDir ? 'Delete folder?' : 'Delete note?', text, ok: 'Move to Recycle Bin', danger: true });
    if (!ok) return;
    if (S.rel && (S.rel === rel || S.rel.startsWith(rel + '/'))) { clearTimeout(S.saveTimer); S.dirty = false; closeNote(); }
    const r = await api.trash(rel);
    if (failed(r)) return;
    toast(isDir ? 'Folder moved to the Recycle Bin.' : 'Note moved to the Recycle Bin.');
  }
  async function togglePin(rel) {
    const r = await api.togglePin(rel);
    if (failed(r)) return;
    if (rel === S.rel) setPinned(r.pinned);
  }

  // ---- search and tags ---------------------------------------------------------------------------------------------------
  let searchTimer = null; let searchSeq = 0;
  $('q').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(runSearch, 120); });
  $('q').addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { $('q').value = ''; setTag(''); runSearch(); }
    if (e.key === 'Enter') { const first = $('results').querySelector('.it'); if (first) first.click(); }
    if (e.key === 'ArrowDown') { const first = $('results').querySelector('.it'); if (first) { e.preventDefault(); first.focus(); } }
  });
  $('results').addEventListener('keydown', (e) => {
    const items = [...$('results').querySelectorAll('.it')]; const i = items.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); (items[i + 1] || items[i]).focus(); }
    if (e.key === 'ArrowUp') { e.preventDefault(); if (i <= 0) $('q').focus(); else items[i - 1].focus(); }
  });
  function setTag(tag) {
    S.tag = tag || '';
    $('tagFilter').hidden = !S.tag; $('tagFilterName').textContent = '#' + S.tag;
    drawSide(); runSearch();
  }
  $('tagClear').addEventListener('click', () => setTag(''));
  /** Accent-free lowercase, character by character, so a hit for "creme" can be marked inside "crème". */
  const foldChar = (c) => c.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
  function highlightSnippet(snippet, query) {
    const words = query.replace(/"/g, ' ').split(/\s+/).filter((w) => w && !w.startsWith('#')).map((w) => [...w].map(foldChar).join(''));
    const span = el('span', { class: 's' });
    if (!words.length) { span.textContent = snippet; return span; }
    // folded text plus, for every folded position, the index of the original character
    const chars = [...snippet]; let folded = ''; const map = []; let off = 0;
    chars.forEach((c) => { const f = foldChar(c); for (let k = 0; k < f.length; k++) map.push(off); folded += f; off += c.length; });
    map.push(snippet.length);
    let i = 0; let last = 0;
    for (;;) {
      let best = -1; let len = 0;
      for (const w of words) { const j = folded.indexOf(w, i); if (j !== -1 && (best === -1 || j < best)) { best = j; len = w.length; } }
      if (best === -1) break;
      const from = map[best]; const to = map[best + len];
      if (from >= last) { span.append(snippet.slice(last, from), el('mark', {}, snippet.slice(from, to))); last = to; }
      i = best + len;
    }
    span.append(snippet.slice(last));
    return span;
  }
  async function runSearch() {
    const q = $('q').value.trim(); S.query = q;
    const active = !!(q || S.tag);
    $('results').hidden = !active; $('browse').hidden = active;
    if (!active) return;
    const seq = ++searchSeq;
    const r = await api.search(q, S.tag);
    if (seq !== searchSeq || failed(r)) return;
    const items = r.results.map((x) => el('button', { class: 'it' + (x.rel === S.rel ? ' on' : ''), 'data-rel': x.rel, onclick: () => openNote(x.rel) },
      el('span', { class: 't trunc' }, x.title), el('span', { class: 'p trunc' }, x.rel), highlightSnippet(x.snippet, q)));
    const what = r.results.length === 0 ? 'No notes match.' : `${r.results.length === 300 ? '300+' : r.results.length} note${r.results.length === 1 ? '' : 's'}`;
    $('results').replaceChildren(el('div', { class: 'count' }, what), ...items);
  }

  // ---- folder --------------------------------------------------------------------------------------------------------------
  function showFolder(f) {
    S.folder = f;
    $('welcome').hidden = true; $('workspace').hidden = false; $('noteTools').hidden = false; $('folderBtn').hidden = false;
    setView(f.view || 'split', false);
    if (f.capped) banner('This folder has more than 20,000 notes; only the first 20,000 are shown and searched.', [], 'warn');
    if (S.rel && !S.moving && !f.notes.includes(S.rel) && !S.dirty) closeNote();
    drawSide();
    if (S.query || S.tag) runSearch();
  }
  async function pickFolder() {
    if (!(await save())) return;
    const r = await api.pickFolder();
    if (!r || r.cancelled || failed(r)) return;
    if (S.rel) closeNote();
    S.open.clear(); S.selectedDir = ''; S.tag = ''; $('q').value = ''; S.query = '';
    showFolder(r);
    if (!r.notes.length) toast('This folder has no notes yet. Make one with New note.');
  }
  api.onFolderChanged((f) => { if (S.folder && f.root === S.folder.root) showFolder(f); });

  // ---- view and export -------------------------------------------------------------------------------------------------------
  function setView(v, remember = true) {
    S.view = v;
    $('panes').className = 'panes ' + v;
    document.querySelectorAll('.seg .mode').forEach((b) => b.setAttribute('aria-checked', b.dataset.view === v ? 'true' : 'false'));
    if (remember) api.setView(v);
    if (v !== 'preview' && S.rel) ed.view.requestMeasure();
  }
  document.querySelectorAll('.seg .mode').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));

  async function exportAs(format, opts = {}) {
    if (!S.rel) return;
    await save();
    const label = { html: 'HTML', pdf: 'PDF', docx: 'Word' }[format];
    result(`Exporting as ${label}…`, '');
    const r = await api.exportNote(S.rel, ed.getText(), format, opts);
    if (!r || r.cancelled) { result(''); return; }
    if (r.error) { result('Export failed: ' + r.error, 'err'); return; }
    result(`Exported: ${r.path.split(/[\\/]/).pop()}`, 'ok', r.path);
  }
  $('exportBtn').addEventListener('click', () => menu([
    ['HTML page (one self-contained file)…', () => exportAs('html')],
    ['PDF, A4…', () => exportAs('pdf', { pageSize: 'A4' })],
    ['PDF, Letter…', () => exportAs('pdf', { pageSize: 'Letter' })],
    ['Word document (.docx)…', () => exportAs('docx')],
  ], $('exportBtn')));
  $('moreBtn').addEventListener('click', () => S.rel && menu([
    ['Rename…', () => renameEntry(S.rel, false)], ['Move to…', () => moveDialog(S.rel, false)], '-', ['Move to Recycle Bin…', () => deleteEntry(S.rel, false), { danger: true }],
  ], $('moreBtn')));
  $('pinBtn').addEventListener('click', () => S.rel && togglePin(S.rel));
  $('newNote').addEventListener('click', () => newNote());
  $('newNote2').addEventListener('click', () => newNote());
  $('newFolder').addEventListener('click', () => newFolder());
  $('pickFolder').addEventListener('click', pickFolder);
  $('folderBtn').addEventListener('click', pickFolder);

  document.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (!mod || $('dlg').open) return;
    const k = e.key.toLowerCase();
    if (k === 's') { e.preventDefault(); save({ force: false }).then((ok) => { if (ok) setSaveState('Saved', 'ok'); }); }
    else if (k === 'n' && S.folder) { e.preventDefault(); newNote(); }
    else if (k === 'e' && S.folder) { e.preventDefault(); setView({ edit: 'split', split: 'preview', preview: 'edit' }[S.view]); }
    else if (k === 'f' && e.shiftKey && S.folder) { e.preventDefault(); $('q').focus(); $('q').select(); }
  });
  window.addEventListener('blur', () => { if (S.dirty) save(); });
  let closing = false;
  window.addEventListener('beforeunload', (e) => {
    if (closing || !S.dirty || S.conflict) return;
    e.preventDefault(); e.returnValue = false;
    save().then((ok) => { if (ok) { closing = true; window.close(); } });
  });

  // ---- start ------------------------------------------------------------------------------------------------------------------
  (async () => {
    const f = await api.getFolder();
    if (f && !f.error) showFolder(f); else $('welcome').hidden = false;
  })();

  window.__app = { S, ed, openNote, save, renderNow, setTag, runSearch, setView, exportAs };
})();
