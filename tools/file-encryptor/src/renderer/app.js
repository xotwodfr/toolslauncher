'use strict';
(() => {
  const fe = window.fe;
  const $ = (id) => document.getElementById(id);
  const el = (tag, attrs, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === false || v == null) continue;
      if (k === 'class') n.className = v; else if (k.startsWith('on')) n.addEventListener(k.slice(2), v); else n.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids) if (kid != null && kid !== false) n.append(kid);
    return n;
  };
  const ICON = '<svg viewBox="0 0 24 24"><path d="M7 3.5h6.5L18 8v12.5H7z"/><path d="M13.5 3.5V8H18"/><rect x="9.5" y="13" width="6" height="5" rx="1"/><path d="M10.8 13v-1.6a1.7 1.7 0 0 1 3.4 0V13"/></svg>';
  document.querySelector('.glyph').innerHTML = ICON;

  const LABEL = { sha256: 'SHA-256', sha512: 'SHA-512', sha1: 'SHA-1', md5: 'MD5', blake2b: 'BLAKE2b' };
  const S = {
    mode: 'encrypt', running: null, compare: null, weakOk: false,
    tabs: { encrypt: { rows: [], dest: null }, decrypt: { rows: [], dest: null }, hash: { rows: [] } },
  };
  const T = () => S.tabs[S.mode];

  const fmtBytes = (n) => { if (!(n >= 0)) return ''; const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0; while (n >= 1000 && i < u.length - 1) { n /= 1000; i++; } return (i ? n.toFixed(n < 10 ? 2 : n < 100 ? 1 : 0) : n) + ' ' + u[i]; };
  let toastTimer = null;
  function toast(text, err = false) { const t = $('toast'); t.textContent = text; t.className = 'toast' + (err ? ' err' : ''); t.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 4500); }
  const errText = (e) => String((e && e.message) || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
  function showResult(text, kind) { S.compareShown = false; const r = $('result'); r.replaceChildren(); if (text instanceof Node) r.append(text); else r.textContent = text || ''; r.className = 'result' + (kind ? ' ' + kind : ''); r.hidden = !text; }

  // ---- tabs ------------------------------------------------------------------------------------------------------------------
  const EMPTY = {
    encrypt: ['Drop files or folders to encrypt', 'Any file, any size. A folder becomes one encrypted file.', 'Each file or folder becomes a <name>.locked file, protected with your password (Argon2id + AES-256-GCM). Your originals are not changed unless you ask for them to go to the Recycle Bin. Nothing leaves this computer.'],
    decrypt: ['Drop .locked files to decrypt', 'Files made by File Encryptor. Folders are searched for them.', 'The original file or folder comes back under its original name next to the .locked file (or in a folder you choose). Nothing is ever overwritten: if the name is taken you get "name (2)".'],
    hash: ['Drop files or folders to check', 'SHA-256, SHA-512, SHA-1, MD5 and BLAKE2b.', 'Compute checksums, compare one with a checksum published on a download page, check a .sha256 / .md5 / SHA256SUMS file, or save such a file for a folder.'],
  };
  function setMode(mode) {
    if (S.running) return;
    S.mode = mode;
    for (const b of document.querySelectorAll('.tabs button')) b.setAttribute('aria-selected', String(b.dataset.mode === mode));
    $('panel').setAttribute('aria-labelledby', 'tab-' + mode);
    const [title, sub, fine] = EMPTY[mode];
    $('emptyTitle').textContent = title; $('emptySub').textContent = sub; $('emptyFine').textContent = fine;
    $('cryptBar').hidden = mode === 'hash'; $('hashBar').hidden = mode !== 'hash';
    $('pw2Box').hidden = mode !== 'encrypt'; $('delBox').hidden = mode !== 'encrypt'; $('delWarn').hidden = mode !== 'encrypt' || !$('del').checked;
    $('go').textContent = mode === 'decrypt' ? 'Decrypt' : 'Encrypt';
    $('pw').value = ''; $('pw2').value = ''; paintMeter();
    $('pw').setAttribute('autocomplete', mode === 'encrypt' ? 'new-password' : 'off');
    $('verify').hidden = true;
    S.weakOk = false;
    paintDest(); showResult(''); paint();
  }
  for (const b of document.querySelectorAll('.tabs button')) b.addEventListener('click', () => setMode(b.dataset.mode));
  document.querySelector('.tabs').addEventListener('keydown', (e) => {
    const order = ['encrypt', 'decrypt', 'hash']; const i = order.indexOf(S.mode);
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { e.preventDefault(); const m = order[(i + (e.key === 'ArrowRight' ? 1 : 2)) % 3]; setMode(m); $('tab-' + m).focus(); }
  });

  // ---- list ------------------------------------------------------------------------------------------------------------------
  function kindText(r) {
    if (r.kind === 'folder') return `Folder · ${r.files} file${r.files === 1 ? '' : 's'}`;
    if (r.kind === 'locked') return 'Encrypted';
    return 'File';
  }
  function statusCell(r) {
    const td = el('td', { class: 'c-status' });
    const st = el('div', { class: 'st' });
    if (r.status === 'working') st.className = 'st work', st.append(S.mode === 'hash' ? 'Computing…' : S.mode === 'decrypt' ? 'Decrypting…' : 'Encrypting…');
    else if (r.status === 'skipped') st.className = 'st muted', st.append('Cancelled');
    else if (r.status === 'error') st.className = 'st err', st.append(r.error);
    else if (r.status === 'done' && S.mode !== 'hash') {
      st.className = 'st ok';
      st.append(`✓ ${S.mode === 'decrypt' ? 'Decrypted' : 'Encrypted'} → `, el('button', { class: 'link', type: 'button', title: 'Show in folder', onclick: () => fe.reveal(r.output) }, r.outName));
      const notes = [];
      if (r.trashed) notes.push('checked · original moved to the Recycle Bin');
      else if (r.verified) notes.push('checked');
      if (r.renamed) notes.push('the original name was taken');
      if (r.note) notes.push(r.note);
      if (notes.length) st.append(el('span', { class: 'note' }, notes.join(' · ')));
    } else if (r.skipped) st.className = 'st muted', st.append(`${r.skipped} link(s) will be skipped`);
    else st.className = 'st muted', st.append('Ready');
    td.append(st);
    return td;
  }
  function hashCell(r) {
    const td = el('td', { class: 'c-status' });
    if (r.status === 'working') return td.append(el('div', { class: 'st work' }, 'Computing…')), td;
    if (r.status === 'error') return td.append(el('div', { class: 'st err' }, r.error)), td;
    if (r.status === 'skipped') return td.append(el('div', { class: 'st muted' }, 'Cancelled')), td;
    const d = r.digests || {};
    const keys = Object.keys(LABEL).filter((a) => d[a]);
    if (!keys.length) return td.append(el('div', { class: 'st muted' }, 'Not computed yet')), td;
    td.append(el('div', { class: 'hashes' }, ...keys.map((a) => el('div', { class: 'hl' + (S.compare && S.compare.hex === d[a] ? ' match' : ''), 'data-alg': a },
      el('span', { class: 'k' }, LABEL[a]), el('code', { title: d[a] }, d[a]),
      el('button', { class: 'copy', type: 'button', 'aria-label': `Copy the ${LABEL[a]} of ${r.name}`, onclick: () => { fe.copy(d[a]); toast(`${LABEL[a]} copied.`); } }, 'Copy')))));
    return td;
  }
  function rowEl(r) {
    const remove = el('button', { class: 'x', type: 'button', 'aria-label': `Remove ${r.name} from the list`, title: 'Remove from the list (the file stays)', onclick: () => removeRows([r.id]) }, '✕');
    const name = el('td', { class: 'c-name' }, el('div', { class: 'name' }, el('div', { class: 't trunc', title: r.rel }, S.mode === 'hash' ? r.rel : r.name), el('div', { class: 'd trunc', title: r.dir }, r.dir)));
    const matched = S.mode === 'hash' && S.compare && S.compare.hex && Object.values(r.digests || {}).includes(S.compare.hex);
    if (S.mode === 'hash') return el('tr', { 'data-id': String(r.id), class: matched ? 'matchrow' : '' }, name, el('td', { class: 'c-size size' }, fmtBytes(r.bytes)), hashCell(r), el('td', { class: 'c-x' }, remove));
    return el('tr', { 'data-id': String(r.id) }, name, el('td', { class: 'c-kind' }, kindText(r)), el('td', { class: 'c-size size' }, fmtBytes(r.bytes)), statusCell(r), el('td', { class: 'c-x' }, remove));
  }
  function paint() {
    const rows = T().rows;
    $('empty').hidden = !!rows.length; $('list').hidden = !rows.length || !$('verify').hidden;
    $('clear').hidden = !rows.length || !!S.running;
    $('thead').replaceChildren(S.mode === 'hash'
      ? el('tr', {}, el('th', { class: 'c-name' }, 'File'), el('th', { class: 'c-size' }, 'Size'), el('th', { class: 'c-status' }, 'Checksums'), el('th', { class: 'c-x' }, el('span', { class: 'sr' })))
      : el('tr', {}, el('th', { class: 'c-name' }, 'Name'), el('th', { class: 'c-kind' }, 'Kind'), el('th', { class: 'c-size' }, 'Size'), el('th', { class: 'c-status' }, 'Status'), el('th', { class: 'c-x' })));
    $('grid').setAttribute('aria-label', S.mode === 'hash' ? 'Files and their checksums' : S.mode === 'decrypt' ? 'Files to decrypt' : 'Files and folders to encrypt');
    $('rows').replaceChildren(...rows.map(rowEl));
    if (!S.running) {
      const total = rows.reduce((s, r) => s + (r.bytes || 0), 0);
      const done = rows.filter((r) => r.status === 'done').length;
      $('status').textContent = rows.length ? `${rows.length} item${rows.length === 1 ? '' : 's'} · ${fmtBytes(total)}${done ? ` · ${done} done` : ''}` : '';
    }
    paintSumAlg();
  }
  function paintRow(r) { const tr = $('rows').querySelector(`tr[data-id="${r.id}"]`); if (tr) tr.replaceWith(rowEl(r)); }
  async function removeRows(ids) { if (S.running) return; const t = T(); t.rows = t.rows.filter((r) => !ids.includes(r.id)); await fe.forget(ids); paint(); }
  $('clear').addEventListener('click', () => { removeRows(T().rows.map((r) => r.id)); showResult(''); });

  async function addResult(res, mode = S.mode) {
    const t = S.tabs[mode];
    const have = new Set(t.rows.map((r) => r.dir + '/' + r.rel));
    const fresh = res.rows.filter((r) => !have.has(r.dir + '/' + r.rel));
    const dupes = res.rows.filter((r) => !fresh.includes(r)).map((r) => r.id);
    if (dupes.length) fe.forget(dupes);
    t.rows.push(...fresh.map((r) => ({ ...r, status: 'ready' })));
    if (mode === S.mode) paint();
    if (res.problems && res.problems.length) toast(res.problems.slice(0, 3).join(' · ') + (res.problems.length > 3 ? ` (and ${res.problems.length - 3} more)` : ''), true);
    else if (!res.rows.length && mode === 'decrypt') toast('No .locked files were found there.', true);
    return fresh.length;
  }
  const add = (how) => async () => { if (S.running) return; try { await addResult(await (how === 'folder' ? fe.pickFolder(S.mode) : fe.pickFiles(S.mode))); } catch (e) { toast(errText(e), true); } };
  for (const [id, how] of [['addFiles', 'files'], ['addFiles2', 'files'], ['addFolder', 'folder'], ['addFolder2', 'folder']]) $(id).addEventListener('click', add(how));
  $('empty').addEventListener('keydown', (e) => { if (e.target === $('empty') && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); add('files')(); } });

  // drag and drop
  let dragDepth = 0;
  document.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; document.body.classList.add('dragging'); });
  document.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('dragging'); } });
  document.addEventListener('dragover', (e) => e.preventDefault());
  document.addEventListener('drop', async (e) => {
    e.preventDefault(); dragDepth = 0; document.body.classList.remove('dragging');
    if (S.running) return;
    const paths = [...e.dataTransfer.files].map((f) => fe.pathForFile(f)).filter(Boolean);
    if (!paths.length) return;
    if (S.mode === 'hash' && paths.length === 1 && /(\.(sha256|sha512|sha1|md5|b2)|sums?(\.txt)?)$/i.test(paths[0])) { verify(paths[0]); return; }
    if (S.mode === 'encrypt' && paths.every((p) => /\.locked$/i.test(p))) { setMode('decrypt'); }
    try { await addResult(await fe.addPaths(paths, S.mode)); } catch (err) { toast(errText(err), true); }
  });
  fe.onOpened(async (paths) => {
    if (S.running) return;
    setMode(paths.every((p) => /\.locked$/i.test(p)) ? 'decrypt' : 'encrypt');
    await addResult(await fe.addPaths(paths, S.mode));
  });

  // ---- password, destination ---------------------------------------------------------------------------------------------------
  $('pwShow').addEventListener('click', () => {
    const show = $('pw').type === 'password';
    for (const id of ['pw', 'pw2']) $(id).type = show ? 'text' : 'password';
    $('pwShow').textContent = show ? 'Hide' : 'Show'; $('pwShow').setAttribute('aria-pressed', String(show));
  });
  let meterTimer = null;
  async function paintMeter() {
    const m = $('meter'); const v = $('pw').value;
    if (S.mode !== 'encrypt' || !v) { m.removeAttribute('data-score'); m.querySelector('.mlabel').textContent = ''; return; }
    const r = await fe.strength(v);
    if ($('pw').value !== v) return;
    m.dataset.score = String(r.score);
    m.querySelector('.mlabel').textContent = `${r.label}${r.warning ? ' · ' + r.warning : ''}`;
  }
  $('pw').addEventListener('input', () => { S.weakOk = false; clearTimeout(meterTimer); meterTimer = setTimeout(paintMeter, 120); });
  for (const id of ['pw', 'pw2']) $(id).addEventListener('keydown', (e) => { if (e.key === 'Enter') $('go').click(); });

  function paintDest() {
    const t = S.tabs[S.mode];
    if (!t || S.mode === 'hash') return;
    document.querySelector(`input[name="dest"][value="${t.dest ? 'dir' : 'same'}"]`).checked = true;
    $('destDir').textContent = t.dest ? t.dest : 'A folder I choose…';
    $('destDir').title = t.dest || '';
  }
  for (const r of document.querySelectorAll('input[name="dest"]')) {
    r.addEventListener('change', async () => {
      const t = T();
      if (r.value === 'dir') { const d = await fe.pickDir(); t.dest = d || t.dest || null; } else t.dest = null;
      paintDest();
    });
  }
  $('del').addEventListener('change', () => { $('delWarn').hidden = !$('del').checked; });

  // ---- running ---------------------------------------------------------------------------------------------------------------
  function setRunning(kind) {
    S.running = kind;
    for (const id of ['go', 'hashGo', 'addFiles', 'addFolder', 'verifyFile', 'saveSums']) $(id).disabled = !!kind;
    for (const b of document.querySelectorAll('.tabs button')) b.disabled = !!kind;
    $('cancel').hidden = !kind; $('prog').hidden = !kind; $('clear').hidden = !!kind || !T().rows.length;
    if (kind) { $('fill').style.width = '0%'; $('prog').setAttribute('aria-valuenow', '0'); }
  }
  fe.onProgress((p) => {
    const pct = p.total ? Math.min(100, Math.round((p.done / p.total) * 100)) : 0;
    $('fill').style.width = pct + '%'; $('prog').setAttribute('aria-valuenow', String(pct));
    if (S.running && p.total) $('status').textContent = `${S.phase || 'Working…'} ${pct}% · ${fmtBytes(p.done)} of ${fmtBytes(p.total)}`;
  });
  fe.onPhase((p) => { S.phase = p.text; $('status').textContent = p.text; });
  fe.onItem((p) => {
    const r = T().rows.find((x) => x.id === p.id);
    if (!r) return;
    Object.assign(r, p);
    paintRow(r);
    if (p.status === 'working') { const tr = $('rows').querySelector(`tr[data-id="${p.id}"]`); if (tr) tr.scrollIntoView({ block: 'nearest' }); }
  });
  $('cancel').addEventListener('click', () => { fe.cancel(); $('status').textContent = 'Cancelling…'; });

  $('go').addEventListener('click', async () => {
    if (S.running) return;
    const mode = S.mode; const t = T();
    const pending = t.rows.filter((r) => r.status !== 'done');
    if (!pending.length) { toast(t.rows.length ? 'Everything in the list is already done. Add more, or clear the list.' : (mode === 'decrypt' ? 'Add .locked files first.' : 'Add files or folders first.'), true); return; }
    const pw = $('pw').value;
    if (!pw) { toast('Type the password.', true); $('pw').focus(); return; }
    if (mode === 'encrypt') {
      if (pw.length < 8) { toast('Use a password of at least 8 characters. Four or five random words are easy to remember and strong.', true); return; }
      if (pw !== $('pw2').value) { toast('The two passwords are not the same.', true); $('pw2').focus(); return; }
      const s = await fe.strength(pw);
      if (s.score < 2 && !S.weakOk) { S.weakOk = true; toast(`This password is ${s.label.toLowerCase()} and could be guessed. Press Encrypt again to use it anyway.`, true); return; }
    }
    showResult(''); $('toast').hidden = true;
    for (const r of pending) { r.status = 'ready'; r.error = null; }
    paint();
    setRunning(mode);
    S.phase = '';
    let res;
    try {
      res = mode === 'encrypt'
        ? await fe.encrypt({ ids: pending.map((r) => r.id), password: pw, outDir: t.dest, deleteOriginals: $('del').checked })
        : await fe.decrypt({ ids: pending.map((r) => r.id), password: pw, outDir: t.dest });
    } catch (e) { setRunning(null); paint(); showResult(errText(e), 'err'); return; }
    setRunning(null);
    paint();
    const verb = mode === 'encrypt' ? 'Encrypted' : 'Decrypted';
    const parts = [`${verb} ${res.done} of ${pending.length}.`];
    if (res.trashed) parts.push(`${res.trashed} original${res.trashed === 1 ? '' : 's'} moved to the Recycle Bin.`);
    if (res.wrongPassword) parts.push(res.wrongPassword === res.failed ? 'The password did not fit: check it and try again.' : `${res.wrongPassword} did not open with this password.`);
    else if (res.failed) parts.push(`${res.failed} failed (see the list).`);
    if (res.cancelled) parts.push('Cancelled: unfinished files were removed.');
    const box = el('span', {}, parts.join(' '));
    if (res.outputs.length) box.append(' ', el('button', { class: 'link', type: 'button', onclick: () => fe.reveal(res.outputs[0]) }, 'Show in folder'));
    showResult(box, res.failed ? 'err' : res.cancelled ? '' : 'ok');
    if (!res.failed && !res.cancelled) { $('pw').value = ''; $('pw2').value = ''; paintMeter(); }
  });

  // ---- checksums --------------------------------------------------------------------------------------------------------------
  const chosenAlgs = () => [...document.querySelectorAll('.alg:checked')].map((c) => c.value);
  try { const saved = JSON.parse(localStorage.getItem('fe.algs') || 'null'); if (Array.isArray(saved) && saved.length) for (const c of document.querySelectorAll('.alg')) c.checked = saved.includes(c.value); } catch { /* fine */ }
  for (const c of document.querySelectorAll('.alg')) c.addEventListener('change', () => { try { localStorage.setItem('fe.algs', JSON.stringify(chosenAlgs())); } catch { /* fine */ } });

  async function runHash(rows, algs) {
    if (!rows.length) return;
    setRunning('hash'); S.phase = 'Computing';
    for (const r of rows) { r.status = 'ready'; r.error = null; }
    paint();
    let res;
    try { res = await fe.hash({ ids: rows.map((r) => r.id), algs }); } catch (e) { setRunning(null); showResult(errText(e), 'err'); return; }
    setRunning(null); paint();
    paintCompare();
    if (!S.compare) showResult(`Computed ${algs.map((a) => LABEL[a]).join(', ')} for ${res.done} file${res.done === 1 ? '' : 's'}${res.failed ? `; ${res.failed} could not be read` : ''}${res.cancelled ? '; cancelled' : ''}.`, res.failed ? 'err' : 'ok');
  }
  $('hashGo').addEventListener('click', () => {
    if (S.running) return;
    const algs = chosenAlgs();
    if (!algs.length) { toast('Tick at least one kind of checksum.', true); return; }
    if (!T().rows.length) { toast('Add files or a folder first.', true); return; }
    runHash(T().rows.filter((r) => !algs.every((a) => r.digests && r.digests[a])), algs).then(() => { if (!T().rows.some((r) => r.status === 'working')) paint(); });
  });

  let compareTimer = null;
  $('compare').addEventListener('input', () => { clearTimeout(compareTimer); compareTimer = setTimeout(onCompare, 400); });
  async function onCompare() {
    const text = $('compare').value.trim();
    if (!text) { const shown = S.compareShown; S.compare = null; $('compareInfo').textContent = ''; if (shown) showResult(''); paint(); return; }
    const d = await fe.detect(text);
    if (!d.algs.length) { S.compare = null; $('compareInfo').textContent = 'Not a checksum this app knows (expected 32, 40, 64 or 128 hex digits).'; paint(); return; }
    S.compare = d;
    $('compareInfo').textContent = 'Looks like ' + d.algs.map((a) => LABEL[a]).join(' or ') + (d.base64 ? ' (Base64)' : '');
    const missing = T().rows.filter((r) => r.status !== 'error' && !d.algs.every((a) => r.digests && r.digests[a])); // 128 digits: SHA-512 and BLAKE2b are both tried
    if (missing.length && !S.running) {
      for (const c of document.querySelectorAll('.alg')) if (d.algs.includes(c.value)) c.checked = true;
      await runHash(missing, d.algs);
    }
    paint(); paintCompare();
  }
  function paintCompare() {
    if (!S.compare) return;
    const rows = T().rows;
    if (!rows.length) { showResult('Add the downloaded file to compare it with this checksum.', ''); return; }
    const hits = rows.filter((r) => Object.values(r.digests || {}).includes(S.compare.hex));
    if (hits.length) showResult(`✓ Match: ${hits.map((r) => r.rel).join(', ')} ${hits.length === 1 ? 'has' : 'have'} exactly this checksum.`, 'ok');
    else showResult(`✗ No match. None of the ${rows.length} file${rows.length === 1 ? '' : 's'} has this checksum: the download may be damaged or a different version.`, 'err');
    S.compareShown = true;
  }

  function paintSumAlg() {
    const sel = $('sumAlg'); const keep = sel.value;
    const have = Object.keys(LABEL).filter((a) => T().rows.some((r) => r.digests && r.digests[a]));
    sel.replaceChildren(...(have.length ? have : ['sha256']).map((a) => el('option', { value: a }, LABEL[a])));
    if (have.includes(keep)) sel.value = keep;
  }
  $('saveSums').addEventListener('click', async () => {
    const alg = $('sumAlg').value;
    const rows = T().rows.filter((r) => r.digests && r.digests[alg]);
    if (!rows.length) { toast('Compute the checksums first.', true); return; }
    try {
      const r = await fe.saveSums({ ids: rows.map((x) => x.id), alg, format: $('sumFmt').value });
      if (r.ok) showResult(el('span', {}, `Saved ${r.count} checksum${r.count === 1 ? '' : 's'} to ${r.name}. `, el('button', { class: 'link', type: 'button', onclick: () => fe.reveal(r.file) }, 'Show in folder')), 'ok');
    } catch (e) { toast(errText(e), true); }
  });

  // checking a checksum file
  const V = { rows: [] };
  fe.onSumsStart((p) => {
    V.rows = p.lines.map((l) => ({ n: l.n, name: l.name, expected: l.expected, kind: l.alg, status: 'waiting' }));
    $('verifyTitle').textContent = `Checking ${p.name}`;
    $('verifySummary').textContent = p.unreadable ? `${p.unreadable} line(s) could not be read` : '';
    $('verify').hidden = false; $('list').hidden = true; $('empty').hidden = true;
    $('vrows').replaceChildren(...V.rows.map(vrow));
  });
  function vrow(r) {
    const res = { waiting: ['muted', 'Waiting…'], ok: ['ok', `✓ OK${r.kind && r.kind.includes(' or ') && r.okAlg ? ' (' + r.okAlg + ')' : ''}`], bad: ['err', '✗ Does NOT match'], missing: ['err', 'File not found'], error: ['err', r.error || 'Could not be read'], skipped: ['muted', 'Cancelled'] }[r.status] || ['muted', ''];
    return el('tr', { 'data-n': String(r.n) }, el('td', {}, el('div', { class: 'name' }, el('div', { class: 't trunc', title: r.name }, r.name))), el('td', { class: 'small muted' }, r.kind), el('td', {}, el('code', { class: 'exp', title: r.expected }, r.expected)),
      el('td', {}, el('div', { class: 'st ' + res[0] }, res[1], r.status === 'bad' && r.actual ? el('code', { class: 'exp', title: r.actual }, 'got ' + r.actual) : null)));
  }
  fe.onSumsRow((p) => {
    const r = V.rows.find((x) => x.n === p.n); if (!r) return;
    Object.assign(r, { status: p.status, actual: p.actual, error: p.error, okAlg: p.alg });
    const tr = $('vrows').querySelector(`tr[data-n="${p.n}"]`); if (tr) tr.replaceWith(vrow(r));
  });
  async function verify(file) {
    if (S.running) return;
    setRunning('verify'); S.phase = 'Checking';
    let res;
    try { res = await fe.verifySums(file || null); } catch (e) { setRunning(null); showResult(errText(e), 'err'); return; }
    setRunning(null);
    if (!res) { paint(); return; }
    if (!res.ok) { toast(res.error, true); paint(); return; }
    const bad = res.bad + res.missing + res.failed;
    $('verifySummary').textContent = `${res.ok} OK · ${res.bad} different · ${res.missing} missing${res.failed ? ` · ${res.failed} unreadable` : ''}`;
    showResult(bad ? `✗ ${res.name}: ${bad} of ${res.total} file${res.total === 1 ? '' : 's'} did not check out.` : `✓ ${res.name}: all ${res.total} file${res.total === 1 ? '' : 's'} match.`, bad ? 'err' : 'ok');
    $('status').textContent = '';
  }
  $('verifyFile').addEventListener('click', () => verify(null));
  $('verifyBack').addEventListener('click', () => { $('verify').hidden = true; showResult(''); paint(); });

  setMode('encrypt');
  window.__app = { S, setMode, V };
})();
