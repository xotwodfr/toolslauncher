'use strict';
(() => {
  const pv = window.pv;
  const $ = (id) => document.getElementById(id);
  const el = (tag, attrs, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === false || v == null) continue;
      if (k === 'class') n.className = v; else if (k === 'text') n.textContent = v; else if (k.startsWith('on')) n.addEventListener(k.slice(2), v); else n.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids) if (kid != null && kid !== false) n.append(kid);
    return n;
  };
  const ICON = '<svg viewBox="0 0 24 24"><rect x="3.5" y="4" width="17" height="15" rx="2.5"/><circle cx="12" cy="11.5" r="3.4"/><path d="M12 8.1v1.2M12 13.7v1.2M8.6 11.5h1.2M14.2 11.5h1.2M6.5 19v1.5M17.5 19v1.5"/></svg>';
  document.querySelectorAll('.glyph').forEach((g) => { g.innerHTML = ICON; });

  const S = { vault: null, settings: null, view: { view: 'all', folder: '', tag: '' }, sort: 'title', query: '', list: null, selected: null, detail: null, editing: null, totpTimer: null, genTarget: null };
  try { S.sort = localStorage.getItem('pv.sort') || 'title'; } catch { /* fine */ }

  // ---- messages ----------------------------------------------------------------------------------------------------------------
  let toastTimer = null;
  function toast(text, err = false) {
    const t = $('toast');
    t.textContent = text; t.className = 'toast' + (err ? ' err' : ''); t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 4200);
  }
  const fail = (e) => toast(String((e && e.message) || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), true);
  const safe = (fn) => async (...a) => { try { return await fn(...a); } catch (e) { fail(e); return undefined; } };
  const when = (iso) => { try { return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }); } catch { return iso; } };
  const initial = (t) => ([...(t || '?').trim()][0] || '?').toUpperCase();

  function ask(title, text, yes) {
    const d = $('askDlg');
    $('askTitle').textContent = title; $('askText').textContent = text; $('askYes').textContent = yes;
    d.returnValue = '';
    d.showModal();
    return new Promise((res) => d.addEventListener('close', () => res(d.returnValue === 'yes'), { once: true }));
  }

  // ---- auto-lock: tell the main process the window is in use (at most every 10 s) ------------------------------------------------
  let lastPing = 0;
  const ping = () => { if (S.vault && Date.now() - lastPing > 10000) { lastPing = Date.now(); pv.activity(); } };
  for (const ev of ['mousedown', 'keydown', 'wheel', 'mousemove']) window.addEventListener(ev, ping, { passive: true });

  // ---- strength meter ------------------------------------------------------------------------------------------------------------
  function meter(box, input, extra = () => []) {
    let t = null;
    const paint = async () => {
      const v = input.value;
      if (!v) { box.removeAttribute('data-score'); box.querySelector('.mlabel').textContent = ''; return; }
      const r = await pv.strength(v, extra());
      if (input.value !== v) return;
      box.dataset.score = String(r.score);
      box.querySelector('.mlabel').textContent = `${r.label} · about ${r.bits} bits${r.warning ? ' · ' + r.warning : ''}`;
    };
    input.addEventListener('input', () => { clearTimeout(t); t = setTimeout(paint, 120); });
    return paint;
  }

  // =================================================================================================================================
  // lock screen
  // =================================================================================================================================
  const lockUi = { keyFile: null, newKeyFile: null };
  const REASONS = { idle: 'Locked because it was not used for a while.', screen: 'Locked because the computer was locked.', sleep: 'Locked because the computer went to sleep.', minimized: 'Locked because the window was minimised.', button: 'Locked.' };

  function showLock(st, reason) {
    S.vault = null; S.list = null; S.selected = null; S.detail = null; S.editing = null;
    stopTotp();
    $('rows').replaceChildren(); $('detail').replaceChildren(); $('side').replaceChildren(); $('search').value = ''; S.query = '';
    for (const d of document.querySelectorAll('dialog[open]')) d.close();
    $('vaultScreen').hidden = true; $('lockScreen').hidden = false;
    $('masterPw').value = ''; $('masterPw').type = 'password'; $('masterShow').textContent = 'Show';
    $('unlockErr').textContent = ''; $('createErr').textContent = '';
    lockUi.keyFile = null; $('kfName').textContent = 'No key file chosen';
    const r = $('lockReason'); r.textContent = (reason && REASONS[reason]) || ''; r.hidden = !r.textContent;
    $('createPane').hidden = true;
    if (st.state === 'start' || !st.vault) { $('startPane').hidden = false; $('unlockPane').hidden = true; return; }
    $('startPane').hidden = true; $('unlockPane').hidden = false;
    $('vaultName').textContent = st.vault.name; $('vaultName').title = st.vault.file;
    $('vaultFolder').textContent = st.vault.folder;
    $('vaultProblem').textContent = st.vault.problem || ''; $('vaultProblem').hidden = !st.vault.problem;
    $('kfRow').hidden = !st.vault.keyFile;
    $('unlockBtn').disabled = !!st.vault.problem;
    setTimeout(() => $('masterPw').focus(), 30);
  }

  function setBusy(text) { const b = $('busy'); b.textContent = text || ''; b.hidden = !text; for (const id of ['unlockBtn', 'createBtn']) $(id).disabled = !!text; }

  const toggleShow = (btn, input) => btn.addEventListener('click', () => {
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password'; btn.textContent = show ? 'Hide' : 'Show'; btn.setAttribute('aria-pressed', String(show));
  });
  toggleShow($('masterShow'), $('masterPw'));
  toggleShow($('newPwShow'), $('newPw'));

  $('kfPick').addEventListener('click', safe(async () => {
    const k = await pv.pickKeyFile();
    if (k) { lockUi.keyFile = k.file; $('kfName').textContent = k.name; $('kfName').classList.remove('muted'); }
  }));

  $('unlockPane').addEventListener('submit', safe(async (e) => {
    e.preventDefault();
    const password = $('masterPw').value;
    if (!password) { $('unlockErr').textContent = 'Type the master password.'; return; }
    $('unlockErr').textContent = '';
    setBusy('Unlocking…');
    let r;
    try { r = await pv.unlock({ password, keyFile: lockUi.keyFile }); } finally { setBusy(''); }
    if (!r.ok) { $('unlockErr').textContent = r.error; $('masterPw').select(); return; }
    $('masterPw').value = '';
    enterVault(r);
  }));

  const chooseVault = safe(async () => {
    const r = await pv.pickVault();
    if (!r) return;
    if (!r.ok) { toast(r.error, true); return; }
    showLock(r);
  });
  $('openVault').addEventListener('click', chooseVault);
  $('openOther').addEventListener('click', chooseVault);

  const startCreate = () => {
    $('startPane').hidden = true; $('unlockPane').hidden = true; $('createPane').hidden = false; $('lockReason').hidden = true;
    $('newPw').value = ''; $('newPw2').value = ''; $('createErr').textContent = ''; lockUi.newKeyFile = null; $('newKfName').textContent = '';
    document.querySelector('input[name="newKf"][value="none"]').checked = true;
    newMeter();
    setTimeout(() => $('newPw').focus(), 30);
  };
  $('newVault').addEventListener('click', startCreate);
  $('newVault2').addEventListener('click', startCreate);
  $('createCancel').addEventListener('click', async () => showLock(await pv.state()));
  const newMeter = meter($('newMeter'), $('newPw'));

  // key file choice in "new vault" and "change master password": none / a file I choose / make a new one
  function keyFileChoice(name, label, store) {
    for (const radio of document.querySelectorAll(`input[name="${name}"]`)) {
      radio.addEventListener('change', safe(async () => {
        store.file = null; $(label).textContent = '';
        if (radio.value === 'existing') { const k = await pv.pickKeyFile(); if (k) { store.file = k.file; $(label).textContent = 'Key file: ' + k.name; } }
        if (radio.value === 'create') {
          const k = await pv.createKeyFile();
          if (k && !k.ok) toast(k.error, true);
          if (k && k.ok) { store.file = k.file; $(label).textContent = 'New key file saved: ' + k.name + ' (keep a copy of it!)'; }
        }
        if (!store.file) document.querySelector(`input[name="${name}"][value="none"]`).checked = true;
      }));
    }
  }
  const newKf = { file: null };
  keyFileChoice('newKf', 'newKfName', newKf);

  $('createPane').addEventListener('submit', safe(async (e) => {
    e.preventDefault();
    const pw = $('newPw').value;
    const err = (t) => { $('createErr').textContent = t; };
    if (pw.length < 8) return err('Use at least 8 characters (a few random words are best).');
    if (pw !== $('newPw2').value) return err('The two passwords are not the same.');
    const st = await pv.strength(pw, []);
    if (st.score < 2 && !(await ask('This master password is weak', `It could be guessed (${st.label.toLowerCase()}${st.warning ? ': ' + st.warning : ''}). Everything in the vault is only as safe as this password. Use it anyway?`, 'Use it anyway'))) return undefined;
    err('');
    setBusy('Creating the vault (tuning the key strength for this computer)…');
    let r;
    try { r = await pv.create({ password: pw, keyFile: newKf.file }); } finally { setBusy(''); }
    if (r.cancelled) return undefined;
    if (!r.ok) return err(r.error);
    $('newPw').value = ''; $('newPw2').value = '';
    enterVault(r);
    toast('Your new vault is ready. Remember: the master password cannot be recovered.');
    return undefined;
  }));

  // drop a vault file on the lock screen
  document.addEventListener('dragover', (e) => e.preventDefault());
  document.addEventListener('drop', safe(async (e) => {
    e.preventDefault();
    if (S.vault) return;
    const f = e.dataTransfer.files[0];
    if (!f) return;
    const r = await pv.chooseVault(pv.pathForFile(f));
    if (!r.ok) toast(r.error, true); else showLock(r);
  }));

  // =================================================================================================================================
  // unlocked
  // =================================================================================================================================
  function enterVault(st) {
    S.vault = st.vault; S.settings = st.settings; S.kdf = st.kdf;
    S.view = { view: 'all', folder: '', tag: '' }; S.selected = null; S.editing = null;
    $('lockScreen').hidden = true; $('vaultScreen').hidden = false;
    $('openName').textContent = st.vault.name; $('openName').title = st.vault.file;
    $('sort').value = S.sort;
    refresh().then(() => { if (!S.list.rows.length) placeholder(); });
    setTimeout(() => $('search').focus(), 30);
  }

  async function refresh(keepDetail = true) {
    if (!S.vault) return;
    S.list = await pv.list({ ...S.view, query: S.query, sort: S.sort });
    paintSide(); paintList();
    if (S.selected && !S.list.rows.some((r) => r.id === S.selected) && !S.editing) { S.selected = null; placeholder(); }
    else if (keepDetail && S.selected && !S.editing) await openEntry(S.selected, false);
  }

  function navButton(label, count, view, extra = {}) {
    const current = S.view.view === view && (view !== 'folder' || S.view.folder === extra.folder) && (view !== 'tag' || S.view.tag === extra.tag);
    return el('button', { class: 'nav', type: 'button', 'aria-current': current ? 'true' : 'false', 'data-view': view, 'data-name': extra.folder || extra.tag || '', title: extra.folder || '', onclick: () => { S.view = { view, folder: extra.folder || '', tag: extra.tag || '' }; S.selected = null; S.editing = null; placeholder(); refresh(false); } },
      el('span', { class: 'trunc' }, label), el('span', { class: 'n' }, String(count)));
  }

  function paintSide() {
    const L = S.list; const side = $('side');
    const kids = [
      navButton('All entries', L.counts.all, 'all'),
      navButton('★ Favourites', L.counts.favorites, 'favorites'),
      el('h2', {}, 'Folders'),
      ...L.folders.map((f) => { const depth = f.name.split('/').length - 1; const b = navButton(f.name.split('/').pop(), f.count, 'folder', { folder: f.name }); b.style.paddingLeft = (18 + depth * 14) + 'px'; return b; }),
      el('button', { class: 'btn ghost small addfolder', type: 'button', id: 'addFolder', onclick: addFolder }, '+ Folder'),
    ];
    if (L.tags.length) kids.push(el('h2', {}, 'Tags'), ...L.tags.map((t) => navButton('#' + t.name, t.count, 'tag', { tag: t.name })));
    kids.push(el('span', { class: 'grow' }), navButton('Trash', L.counts.trash, 'trash'));
    side.replaceChildren(...kids);
  }

  async function addFolder() {
    const box = el('input', { type: 'text', 'aria-label': 'New folder name', placeholder: 'Folder name (use / for sub-folders)' });
    const btn = $('addFolder'); btn.replaceWith(box); box.focus();
    const done = safe(async (ok) => {
      const name = box.value.trim();
      box.remove();
      if (ok && name) { const f = await pv.addFolder(name); S.view = { view: 'folder', folder: f, tag: '' }; }
      await refresh(false);
    });
    box.addEventListener('keydown', (e) => { if (e.key === 'Enter') done(true); if (e.key === 'Escape') done(false); });
    box.addEventListener('blur', () => done(true), { once: true });
  }

  function listTitle() {
    const v = S.view;
    if (v.view === 'favorites') return 'Favourites';
    if (v.view === 'trash') return 'Trash';
    if (v.view === 'folder') return v.folder;
    if (v.view === 'tag') return '#' + v.tag;
    return 'All entries';
  }

  function paintList() {
    const L = S.list;
    $('listTitle').textContent = `${listTitle()} · ${L.rows.length}`;
    $('trashBar').hidden = !(S.view.view === 'trash' && L.rows.length);
    const ul = $('rows');
    ul.replaceChildren(...L.rows.map((r) => el('li', { role: 'option', 'data-id': r.id, 'aria-selected': r.id === S.selected ? 'true' : 'false', onclick: () => openEntry(r.id) },
      el('span', { class: 'avatar', 'aria-hidden': 'true' }, initial(r.title)),
      el('span', { class: 'txt' }, el('span', { class: 't trunc' }, r.title), el('span', { class: 'u trunc' }, [r.username, r.host].filter(Boolean).join(' · ') || ' ')),
      el('span', { class: 'marks' }, r.hasTotp ? el('span', { title: 'Has a one-time code' }, '2FA') : null, r.favorite ? el('span', { class: 'star', title: 'Favourite', 'aria-label': 'Favourite' }, '★') : null))));
    ul.hidden = !L.rows.length;
    const empty = $('listEmpty');
    empty.hidden = !!L.rows.length;
    empty.textContent = S.query ? `Nothing matches “${S.query}”.` : S.view.view === 'trash' ? 'The trash is empty.' : S.view.view === 'favorites' ? 'No favourites yet. Open an entry and press ☆ to add it here.' : 'No entries here yet. Press New entry, or import a CSV from another password manager (Vault ▾ → Import).';
  }

  function select(id) {
    S.selected = id;
    for (const li of $('rows').children) li.setAttribute('aria-selected', li.dataset.id === id ? 'true' : 'false');
    const li = $('rows').querySelector(`li[data-id="${id}"]`);
    if (li) li.scrollIntoView({ block: 'nearest' });
  }

  $('rows').addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const rows = S.list ? S.list.rows : [];
    if (!rows.length) return;
    const i = rows.findIndex((r) => r.id === S.selected);
    const next = rows[Math.max(0, Math.min(rows.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))];
    if (next) openEntry(next.id);
  });

  let searchTimer = null;
  $('search').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => { S.query = $('search').value.trim(); refresh(false); }, 90); });
  $('search').addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { $('search').value = ''; S.query = ''; refresh(false); }
    if (e.key === 'Enter' && S.list && S.list.rows[0]) { openEntry(S.list.rows[0].id); $('rows').focus(); }
  });
  $('sort').addEventListener('change', () => { S.sort = $('sort').value; try { localStorage.setItem('pv.sort', S.sort); } catch { /* fine */ } refresh(false); });

  // ---- detail view -----------------------------------------------------------------------------------------------------------------
  function stopTotp() { clearInterval(S.totpTimer); S.totpTimer = null; }

  function placeholder() {
    stopTotp(); S.detail = null;
    $('detail').replaceChildren(el('div', { class: 'placeholder' },
      el('span', { class: 'glyph', 'aria-hidden': 'true' }), el('strong', {}, S.list && S.list.counts.all ? 'Choose an entry' : 'Your vault is empty'),
      el('span', { class: 'small' }, S.list && S.list.counts.all ? 'Its details show here. Passwords stay hidden until you ask.' : 'Add your first login with New entry, or import from another password manager.')));
    $('detail').querySelector('.glyph').innerHTML = ICON;
  }

  const copyBtn = (id, what, index, label) => el('button', { class: 'btn small', type: 'button', 'data-copy': what + (index != null ? ':' + index : ''), 'aria-label': `Copy ${label}`, onclick: safe(async () => {
    const r = await pv.copy(id, what, index);
    toast(`${label[0].toUpperCase() + label.slice(1)} copied. ${what === 'username' || what === 'url' ? '' : `It is cleared from the clipboard in ${r.seconds} s.`}`);
  }) }, 'Copy');

  function secretRow(id, key, what, index, length, label) {
    const v = el('span', { class: 'v secret', 'data-secret': what + (index != null ? ':' + index : '') }, '•'.repeat(Math.min(16, Math.max(8, length))));
    let shown = false;
    const show = el('button', { class: 'btn small', type: 'button', 'aria-pressed': 'false', 'aria-label': `Show ${label}`, onclick: safe(async () => {
      shown = !shown;
      if (shown) { v.textContent = await pv.reveal(id, what, index); show.textContent = 'Hide'; }
      else { v.textContent = '•'.repeat(Math.min(16, Math.max(8, length))); show.textContent = 'Show'; }
      show.setAttribute('aria-pressed', String(shown));
    }) }, 'Show');
    return el('div', { class: 'frow' }, el('span', { class: 'k' }, key), v, el('span', { class: 'acts' }, show, copyBtn(id, what, index, label)));
  }

  async function openEntry(id, focusRow = true) {
    if (S.editing && !(await leaveEditor())) return;
    S.editing = null;
    let d;
    try { d = await pv.get(id); } catch (e) { fail(e); return; }
    S.detail = d;
    select(id);
    stopTotp();
    const box = $('detail');
    const rows = [];
    if (d.username) rows.push(el('div', { class: 'frow' }, el('span', { class: 'k' }, 'User name'), el('span', { class: 'v plain', id: 'dUser' }, d.username), el('span', { class: 'acts' }, copyBtn(d.id, 'username', null, 'user name'))));
    if (d.hasPassword) rows.push(secretRow(d.id, 'Password', 'password', null, d.passwordLength, 'password'));
    if (d.totp) {
      const code = el('span', { class: 'otp', id: 'dOtp' }, '··· ···'); const bar = el('div', { class: 'otpbar' }, el('i'));
      rows.push(el('div', { class: 'frow' }, el('span', { class: 'k' }, 'One-time code'), el('span', { class: 'v' }, code, bar), el('span', { class: 'acts' }, copyBtn(d.id, 'totp', null, 'one-time code'))));
      const tick = async () => {
        if (!S.detail || S.detail.id !== d.id) return;
        const c = await pv.totp(d.id).catch(() => null);
        if (!c) return;
        code.textContent = c.code.length === 6 ? c.code.slice(0, 3) + ' ' + c.code.slice(3) : c.code;
        bar.firstChild.style.width = Math.round((c.remaining / c.period) * 100) + '%';
        bar.classList.toggle('low', c.remaining <= 5);
        bar.title = `${c.remaining} s left`;
      };
      tick(); S.totpTimer = setInterval(tick, 1000);
    }
    d.urls.forEach((u, i) => rows.push(el('div', { class: 'frow' }, el('span', { class: 'k' }, i ? 'Web address ' + (i + 1) : 'Web address'), el('span', { class: 'v plain' }, u), el('span', { class: 'acts' }, copyBtn(d.id, 'url', i, 'web address')))));
    d.fields.forEach((f, i) => rows.push(f.hidden ? secretRow(d.id, f.name, 'field', i, f.length, f.name) : el('div', { class: 'frow' }, el('span', { class: 'k' }, f.name), el('span', { class: 'v plain' }, f.value), el('span', { class: 'acts' }, copyBtn(d.id, 'field', i, f.name)))));

    const parts = [];
    if (d.trashed) parts.push(el('div', { class: 'notice warn trashnote small' }, `In the trash since ${when(d.trashed)}. Restore it to use it again.`));
    parts.push(el('div', { class: 'dhead' }, el('span', { class: 'avatar', 'aria-hidden': 'true' }, initial(d.title)),
      el('div', { class: 'grow' }, el('h3', { id: 'dTitle' }, d.title), el('div', { class: 'sub' }, d.folder ? 'In ' + d.folder : 'No folder')),
      d.trashed ? null : el('button', { class: 'btn small', type: 'button', id: 'dFav', 'aria-pressed': String(d.favorite), title: d.favorite ? 'Remove from favourites' : 'Add to favourites', onclick: safe(async () => { await pv.favorite(d.id, !d.favorite); await refresh(); }) }, d.favorite ? '★ Favourite' : '☆ Favourite')));
    parts.push(rows.length ? el('div', { class: 'fieldlist' }, ...rows) : el('p', { class: 'muted' }, 'This entry has no fields yet.'));
    if (d.notes) parts.push(el('div', { class: 'section' }, el('h2', {}, 'Notes'), el('div', { class: 'notes' }, d.notes)));
    if (d.tags.length) parts.push(el('div', { class: 'section' }, el('h2', {}, 'Tags'), el('div', { class: 'chips' }, ...d.tags.map((t) => el('button', { class: 'chip', type: 'button', onclick: () => { S.view = { view: 'tag', tag: t, folder: '' }; refresh(); } }, '#' + t)))));
    if (d.history.length) {
      const hist = el('div', { class: 'fieldlist' }, ...d.history.map((h, i) => secretRow(d.id, 'Until ' + new Date(h.until).toLocaleDateString(), 'history', i, h.length, 'old password')));
      const det = el('details', { class: 'section' }, el('summary', { class: 'link small' }, `Password history (${d.history.length})`), hist);
      parts.push(det);
    }
    parts.push(el('div', { class: 'meta' }, el('span', {}, 'Created ' + when(d.created)), el('span', {}, 'Changed ' + when(d.modified))));
    const acts = d.trashed
      ? [el('button', { class: 'btn primary', type: 'button', id: 'dRestore', onclick: safe(async () => { await pv.restore(d.id); toast('Restored.'); await refresh(); }) }, 'Restore'),
        el('button', { class: 'btn danger', type: 'button', id: 'dPurge', onclick: safe(async () => { if (!(await ask('Delete forever?', `“${d.title}” will be removed from the vault for good. This cannot be undone (the .bak file keeps the previous save until the next change).`, 'Delete forever'))) return; await pv.purge(d.id); S.selected = null; placeholder(); await refresh(false); }) }, 'Delete forever')]
      : [el('button', { class: 'btn primary', type: 'button', id: 'dEdit', onclick: () => edit(d.id) }, 'Edit'),
        el('button', { class: 'btn ghost', type: 'button', id: 'dTrash', onclick: safe(async () => { await pv.trash(d.id); toast(`“${d.title}” moved to the trash.`); S.selected = null; placeholder(); await refresh(false); }) }, 'Move to trash')];
    parts.push(el('div', { class: 'dactions' }, ...acts));
    box.replaceChildren(...parts);
    box.scrollTop = 0;
    if (focusRow && document.activeElement === document.body) $('rows').focus();
  }

  // ---- editor ----------------------------------------------------------------------------------------------------------------------
  let dirty = false;
  async function leaveEditor() {
    if (!dirty) return true;
    return ask('Discard changes?', 'This entry has changes that are not saved.', 'Discard');
  }

  async function edit(id) {
    if (S.editing && !(await leaveEditor())) return;
    stopTotp();
    const d = id ? await pv.get(id) : null;
    S.editing = { id: id || null }; dirty = false;
    if (!id) { S.selected = null; select(null); }
    const input = (attrs) => { const i = el('input', { type: 'text', spellcheck: 'false', ...attrs }); i.addEventListener('input', () => { dirty = true; }); return i; };
    const title = input({ id: 'eTitle', 'aria-label': 'Title', value: d ? d.title : '' });
    const user = input({ id: 'eUser', 'aria-label': 'User name', value: d ? d.username : '', autocomplete: 'off' });
    const pw = el('input', { type: 'password', id: 'ePw', 'aria-label': 'Password', autocomplete: 'new-password', spellcheck: 'false', placeholder: d && d.hasPassword ? 'Unchanged (press Show to see it)' : '' });
    let pwLoaded = !(d && d.hasPassword);
    pw.addEventListener('input', () => { dirty = true; pwLoaded = true; });
    const pwShow = el('button', { class: 'btn small', type: 'button', id: 'ePwShow', 'aria-pressed': 'false', onclick: safe(async () => {
      if (!pwLoaded && d) { pw.value = await pv.reveal(d.id, 'password'); pwLoaded = true; paintPw(); }
      const show = pw.type === 'password'; pw.type = show ? 'text' : 'password'; pwShow.textContent = show ? 'Hide' : 'Show'; pwShow.setAttribute('aria-pressed', String(show));
    }) }, 'Show');
    const pwGen = el('button', { class: 'btn small', type: 'button', id: 'ePwGen', onclick: () => openGenerator((v) => { pw.value = v; pwLoaded = true; dirty = true; pw.type = 'text'; pwShow.textContent = 'Hide'; paintPw(); }) }, 'Generate…');
    const pwMeter = el('div', { class: 'meter', 'aria-live': 'polite' }, el('div', { class: 'bars' }, el('i'), el('i'), el('i'), el('i')), el('span', { class: 'mlabel small muted' }));
    const paintPw = meter(pwMeter, pw, () => [title.value, user.value]);
    const urls = el('textarea', { id: 'eUrls', 'aria-label': 'Web addresses, one per line', rows: '2', spellcheck: 'false' }); urls.value = d ? d.urls.join('\n') : '';
    urls.addEventListener('input', () => { dirty = true; });
    const folders = el('datalist', { id: 'folderList' }, ...(S.list ? S.list.folders : []).map((f) => el('option', { value: f.name })));
    const folder = input({ id: 'eFolder', 'aria-label': 'Folder', list: 'folderList', value: d ? d.folder : (S.view.view === 'folder' ? S.view.folder : ''), placeholder: 'e.g. Work/Servers' });
    const tags = input({ id: 'eTags', 'aria-label': 'Tags', value: d ? d.tags.join(', ') : (S.view.view === 'tag' ? S.view.tag : ''), placeholder: 'comma separated' });
    const notes = el('textarea', { id: 'eNotes', 'aria-label': 'Notes', rows: '4' }); notes.value = d ? d.notes : '';
    notes.addEventListener('input', () => { dirty = true; });

    // TOTP: null = keep, '' = remove, text = new secret
    let totpValue = d && d.totp ? null : '';
    const totpBox = el('div', { class: 'f' });
    const paintTotp = () => {
      if (totpValue === null) {
        totpBox.replaceChildren(el('label', {}, 'One-time code (2FA)'), el('div', { class: 'otpset' }, el('span', { class: 'grow small' }, `Set up · ${d.totp.digits} digits every ${d.totp.period} s`),
          el('button', { class: 'btn small', type: 'button', id: 'eTotpReplace', onclick: () => { totpValue = ''; dirty = true; paintTotp(); } }, 'Replace'),
          el('button', { class: 'btn small ghost', type: 'button', id: 'eTotpRemove', onclick: () => { totpValue = ''; dirty = true; paintTotp(); toast('The one-time code will be removed when you save.'); } }, 'Remove')));
      } else {
        const t = input({ id: 'eTotp', 'aria-label': 'One-time code secret', placeholder: 'otpauth://totp/… link or the secret key (Base32)', autocomplete: 'off' });
        t.value = totpValue;
        t.addEventListener('input', () => { totpValue = t.value; });
        totpBox.replaceChildren(el('label', { for: 'eTotp' }, 'One-time code (2FA), optional'), t, el('span', { class: 'muted small' }, 'Paste the setup key a site shows next to its QR code, or the otpauth:// link.'));
      }
    };
    paintTotp();

    // custom fields; a hidden value that was not shown is sent as null (= keep)
    const cfs = el('div', { class: 'cfs', id: 'eFields' });
    const addField = (f, from) => {
      const name = input({ 'aria-label': 'Field name', value: f ? f.name : '', placeholder: 'Name' });
      const loaded = { v: !(f && f.hidden) };
      const value = el('input', { type: f && f.hidden ? 'password' : 'text', 'aria-label': 'Field value', spellcheck: 'false', placeholder: f && f.hidden ? 'Unchanged (hidden)' : 'Value' });
      if (f && !f.hidden) value.value = f.value;
      value.addEventListener('input', () => { dirty = true; loaded.v = true; });
      const hid = el('input', { type: 'checkbox', 'aria-label': 'Hide this value' }); hid.checked = !!(f && f.hidden);
      hid.addEventListener('change', safe(async () => {
        dirty = true;
        if (!hid.checked && !loaded.v && d && from != null) { value.value = await pv.reveal(d.id, 'field', from); loaded.v = true; }
        value.type = hid.checked ? 'password' : 'text';
      }));
      const row = el('div', { class: 'cf' }, name, value, el('label', { class: 'check small' }, hid, 'Hidden'),
        el('button', { class: 'btn small ghost', type: 'button', 'aria-label': 'Remove this field', onclick: () => { row.remove(); dirty = true; } }, '✕'));
      row.collect = () => ({ name: name.value, value: !loaded.v && !value.value ? null : value.value, hidden: hid.checked, from });
      cfs.append(row);
      return name;
    };
    if (d) d.fields.forEach((f, i) => addField(f, i));

    const err = el('p', { class: 'err small', role: 'alert', id: 'eErr' });
    const saveIt = safe(async () => {
      const input2 = {
        id: d ? d.id : undefined, title: title.value, username: user.value, password: !pwLoaded && pw.value === '' ? null : pw.value,
        urls: urls.value.split('\n'), folder: folder.value, tags: tags.value.split(','), notes: notes.value,
        fields: [...cfs.children].map((r) => r.collect()), totp: totpValue === null ? null : totpValue.trim(),
      };
      if (!input2.title.trim()) { err.textContent = 'Give the entry a title (for example the site or app name).'; title.focus(); return; }
      let newId;
      try { newId = await pv.save(input2); } catch (e) { err.textContent = String(e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''); return; }
      dirty = false; S.editing = null;
      if (S.view.view === 'trash') S.view = { view: 'all', folder: '', tag: '' };
      S.selected = newId;
      await refresh(false);
      await openEntry(newId, false);
      toast(d ? 'Saved.' : 'Entry added.');
    });
    const cancel = safe(async () => {
      if (!(await leaveEditor())) return;
      dirty = false; S.editing = null;
      if (d) openEntry(d.id); else placeholder();
    });

    const f = (label, forId, ...kids) => el('div', { class: 'f' }, el('label', { for: forId }, label), ...kids);
    const form = el('form', { class: 'editor', autocomplete: 'off', onsubmit: (e) => { e.preventDefault(); saveIt(); } },
      el('h2', {}, d ? 'Edit entry' : 'New entry'),
      f('Title', 'eTitle', title),
      el('div', { class: 'two' }, f('User name or email', 'eUser', user), f('Folder', 'eFolder', folder, folders)),
      f('Password', 'ePw', el('div', { class: 'pwrow' }, pw, pwShow, pwGen), pwMeter),
      f('Web addresses (one per line)', 'eUrls', urls),
      totpBox,
      el('div', { class: 'f' }, el('label', {}, 'Custom fields'), cfs, el('button', { class: 'btn small selfstart', type: 'button', id: 'eAddField', onclick: () => { addField(null, null).focus(); dirty = true; } }, '+ Add field')),
      f('Tags', 'eTags', tags),
      f('Notes', 'eNotes', notes),
      err,
      el('div', { class: 'eactions' }, el('button', { class: 'btn ghost', type: 'button', id: 'eCancel', onclick: cancel }, 'Cancel'), el('button', { class: 'btn primary', type: 'submit', id: 'eSave' }, d ? 'Save' : 'Add entry')));
    form.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !document.querySelector('dialog[open]')) { e.preventDefault(); cancel(); } if (e.key === 's' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); saveIt(); } });
    $('detail').replaceChildren(form);
    $('detail').scrollTop = 0;
    title.focus();
    if (d) title.select();
  }

  $('newEntry').addEventListener('click', () => { if (S.view.view === 'trash') { S.view = { view: 'all', folder: '', tag: '' }; refresh(false); } edit(null); });
  $('lockBtn').addEventListener('click', safe(async () => { if (S.editing && !(await leaveEditor())) return; dirty = false; showLock(await pv.lock(), 'button'); }));
  $('emptyTrash').addEventListener('click', safe(async () => {
    const n = S.list.counts.trash;
    if (!(await ask('Empty the trash?', `${n} ${n === 1 ? 'entry' : 'entries'} will be removed for good. This cannot be undone.`, 'Empty trash'))) return;
    await pv.emptyTrash(); S.selected = null; placeholder(); await refresh(false); toast('The trash is empty.');
  }));

  // ---- generator -------------------------------------------------------------------------------------------------------------------
  const G = { kind: 'password', value: '' };
  try { Object.assign(G, JSON.parse(localStorage.getItem('pv.gen') || '{}'), { value: '' }); } catch { /* fine */ }
  const genOpts = () => (G.kind === 'password'
    ? { length: +$('genLen').value, lower: $('gLower').checked, upper: $('gUpper').checked, digits: $('gDigits').checked, symbols: $('gSymbols').checked, noLookalikes: $('gLook').checked }
    : { words: +$('genWords').value, separator: $('gSep').value, capitalize: $('gCap').checked, number: $('gNum').checked });
  const genMeter = $('genMeter');
  async function regen() {
    $('genLenV').textContent = $('genLen').value; $('genWordsV').textContent = $('genWords').value;
    for (const b of document.querySelectorAll('#genDlg .mode')) b.setAttribute('aria-checked', String(b.dataset.kind === G.kind));
    $('genPwOpts').hidden = G.kind !== 'password'; $('genPpOpts').hidden = G.kind !== 'passphrase';
    try {
      const r = G.kind === 'password' ? await pv.genPassword(genOpts()) : await pv.genPassphrase(genOpts());
      G.value = r.value;
      $('genOut').textContent = r.value;
      const score = r.bits >= 100 ? 4 : r.bits >= 72 ? 3 : r.bits >= 50 ? 2 : r.bits >= 35 ? 1 : 0;
      genMeter.dataset.score = String(score);
      genMeter.querySelector('.mlabel').textContent = `${r.bits} bits of randomness`;
    } catch (e) { G.value = ''; $('genOut').textContent = ''; fail(e); }
    try { localStorage.setItem('pv.gen', JSON.stringify({ kind: G.kind, opts: genOpts() })); } catch { /* fine */ }
  }
  (() => { // restore the last generator settings
    const o = G.opts || {};
    if (G.kind === 'password' && o.length) { $('genLen').value = o.length; for (const [k, id] of [['lower', 'gLower'], ['upper', 'gUpper'], ['digits', 'gDigits'], ['symbols', 'gSymbols'], ['noLookalikes', 'gLook']]) if (k in o) $(id).checked = !!o[k]; }
    if (G.kind === 'passphrase' && o.words) { $('genWords').value = o.words; $('gSep').value = o.separator; $('gCap').checked = !!o.capitalize; $('gNum').checked = !!o.number; }
  })();
  for (const b of document.querySelectorAll('#genDlg .mode')) b.addEventListener('click', () => { G.kind = b.dataset.kind; regen(); });
  for (const id of ['genLen', 'genWords', 'gLower', 'gUpper', 'gDigits', 'gSymbols', 'gLook', 'gSep', 'gCap', 'gNum']) $(id).addEventListener('input', regen);
  $('genAgain').addEventListener('click', regen);
  $('genCopy').addEventListener('click', safe(async () => { if (!G.value) return; const r = await pv.copyText(G.value); toast(`Copied. It is cleared from the clipboard in ${r.seconds} s.`); }));
  $('genUse').addEventListener('click', () => { if (S.genTarget && G.value) S.genTarget(G.value); $('genDlg').close(); });
  $('genDlg').addEventListener('close', () => { S.genTarget = null; G.value = ''; $('genOut').textContent = ''; }); // do not leave it in the page
  function openGenerator(target) {
    S.genTarget = target || null;
    $('genUse').hidden = !target;
    $('genDlg').showModal();
    regen();
  }
  $('genOpen').addEventListener('click', () => openGenerator(null));

  // ---- menu ----------------------------------------------------------------------------------------------------------------------
  const menu = $('moreMenu');
  const closeMenu = () => { menu.hidden = true; $('moreBtn').setAttribute('aria-expanded', 'false'); };
  $('moreBtn').addEventListener('click', (e) => { e.stopPropagation(); const open = menu.hidden; menu.hidden = !open; $('moreBtn').setAttribute('aria-expanded', String(open)); if (open) menu.querySelector('button').focus(); });
  document.addEventListener('click', (e) => { if (!menu.hidden && !menu.contains(e.target)) closeMenu(); });
  menu.addEventListener('keydown', (e) => {
    const items = [...menu.querySelectorAll('button')]; const i = items.indexOf(document.activeElement);
    if (e.key === 'Escape') { closeMenu(); $('moreBtn').focus(); }
    if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length].focus(); }
    if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
  });
  const item = (id, fn) => $(id).addEventListener('click', (e) => { e.stopPropagation(); closeMenu(); fn(); });

  item('mImport', safe(async () => {
    const r = await pv.importPick();
    if (!r) return;
    if (!r.ok) { toast(r.error, true); return; }
    $('impTitle').textContent = `Import from ${r.formatName}`;
    $('impSummary').textContent = `${r.file}: ${r.count} ${r.count === 1 ? 'entry' : 'entries'} found${r.skipped ? `, ${r.skipped} skipped (cards and identities are not supported)` : ''}.`;
    $('impSample').replaceChildren(...r.sample.map((s) => el('li', {}, [s.title, s.username].filter(Boolean).join(' · '))), ...(r.count > r.sample.length ? [el('li', {}, `… and ${r.count - r.sample.length} more`)] : []));
    $('impGo').disabled = !r.count;
    $('impDlg').showModal();
  }));
  $('impGo').addEventListener('click', safe(async () => {
    const r = await pv.importCommit();
    $('impDlg').close('done');
    S.view = { view: 'folder', folder: r.folder, tag: '' }; S.selected = null; placeholder();
    await refresh(false);
    toast(`Imported ${r.added} ${r.added === 1 ? 'entry' : 'entries'} into “${r.folder}”.${r.totpErrors ? ` ${r.totpErrors} one-time code secret(s) could not be read and were left out.` : ''} Now delete the CSV file.`);
  }));
  $('impDlg').addEventListener('close', () => { if ($('impDlg').returnValue !== 'done') pv.importCancel(); });

  item('mExport', () => { $('expOk').checked = false; $('expGo').disabled = true; $('expDlg').showModal(); });
  $('expOk').addEventListener('change', () => { $('expGo').disabled = !$('expOk').checked; });
  $('expGo').addEventListener('click', safe(async () => {
    const r = await pv.exportCsv();
    if (r.cancelled) return;
    $('expDlg').close();
    toast(`Exported ${r.count} entries to ${r.name}. Delete it as soon as you have imported it elsewhere.`);
  }));
  item('mBackup', safe(async () => {
    const r = await pv.exportBackup();
    if (r.cancelled) return;
    if (!r.ok) { toast(r.error, true); return; }
    toast(`Encrypted backup saved as ${r.name}. It opens with the same master password${S.vault.keyFile ? ' and key file' : ''}.`);
  }));
  item('mShow', () => pv.revealVault());

  item('mSettings', () => {
    $('sLock').value = String(S.settings.autoLockMinutes); if (!$('sLock').value) $('sLock').value = '5';
    $('sClip').value = String(S.settings.clipboardSeconds); if (!$('sClip').value) $('sClip').value = '30';
    $('sMin').checked = !!S.settings.lockOnMinimize;
    $('kdfInfo').textContent = S.kdf ? `Key: Argon2id · ${S.kdf.m / 1024} MiB · ${S.kdf.t} passes · AES-256-GCM` : '';
    $('setDlg').showModal();
  });
  $('setSave').addEventListener('click', safe(async () => {
    S.settings = await pv.setSettings({ autoLockMinutes: +$('sLock').value, clipboardSeconds: +$('sClip').value, lockOnMinimize: $('sMin').checked });
    $('setDlg').close(); toast('Settings saved.');
  }));

  const mpKf = { file: null }; let mpCurKf = null;
  keyFileChoice('mpKf', 'mpKfName', mpKf);
  const mpMeter = meter($('mpMeter'), $('mpNew'));
  item('mMaster', () => {
    for (const id of ['mpCur', 'mpNew', 'mpNew2']) $(id).value = '';
    $('mpErr').textContent = ''; mpKf.file = null; mpCurKf = null; $('mpKfName').textContent = ''; $('mpCurKf').textContent = 'none chosen';
    document.querySelector('input[name="mpKf"][value="none"]').checked = true;
    $('mpCurKfRow').hidden = !S.vault.keyFile;
    mpMeter();
    $('mpDlg').showModal();
  });
  $('mpCurKfPick').addEventListener('click', safe(async () => { const k = await pv.pickKeyFile(); if (k) { mpCurKf = k.file; $('mpCurKf').textContent = k.name; } }));
  $('mpGo').addEventListener('click', safe(async () => {
    const err = (t) => { $('mpErr').textContent = t; };
    if (!$('mpCur').value) return err('Type the current master password.');
    if ($('mpNew').value.length < 8) return err('The new master password needs at least 8 characters.');
    if ($('mpNew').value !== $('mpNew2').value) return err('The two new passwords are not the same.');
    err(''); $('mpGo').disabled = true; $('mpGo').textContent = 'Changing…';
    let r;
    try { r = await pv.changeMaster({ current: $('mpCur').value, currentKeyFile: mpCurKf, next: $('mpNew').value, nextKeyFile: mpKf.file }); } finally { $('mpGo').disabled = false; $('mpGo').textContent = 'Change'; }
    if (!r.ok) return err(r.error);
    S.vault = r.vault; S.kdf = r.kdf;
    for (const id of ['mpCur', 'mpNew', 'mpNew2']) $(id).value = '';
    $('mpDlg').close();
    toast('Master password changed. The previous version of the vault (old password) is kept as the .bak file until the next change.');
    return undefined;
  }));

  // ---- keyboard shortcuts ----------------------------------------------------------------------------------------------------------
  document.addEventListener('keydown', (e) => {
    if (!S.vault || document.querySelector('dialog[open]')) return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 'f') { e.preventDefault(); $('search').focus(); $('search').select(); }
    if (mod && e.key.toLowerCase() === 'n') { e.preventDefault(); $('newEntry').click(); }
    if (mod && e.key.toLowerCase() === 'l') { e.preventDefault(); $('lockBtn').click(); }
    if (mod && e.key.toLowerCase() === 'g') { e.preventDefault(); openGenerator(null); }
  });

  // ---- events from the main process ------------------------------------------------------------------------------------------------
  pv.onLocked((st) => { dirty = false; if (st.reason !== 'switch' && st.reason !== 'button') showLock(st, st.reason); });
  pv.onConflict((c) => toast(`The vault file had been changed by something else (another computer or a sync program). That version was kept as “${c.name}”, and your changes were saved.`, true));
  pv.onClipboardCleared(() => { if (S.vault) toast('The clipboard was cleared.'); });

  pv.state().then((st) => { if (st.state === 'unlocked') enterVault(st); else showLock(st); });
  window.__app = { S, refresh, openEntry, edit };
})();
