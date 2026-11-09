'use strict';
(function () {
  const $ = (id) => document.getElementById(id);
  const Rules = window.Rules;
  const Similar = window.Similar;
  const ImgSize = window.ImgSize;
  const WIN = /Windows/i.test(navigator.userAgent);
  const BIN = WIN ? 'Recycle Bin' : 'Trash';
  const PAGE = 40;

  const S = {
    mode: 'files',
    roots: [],
    options: { type: 'all', minSize: 1, skipHidden: true, threshold: 8 },
    groups: [], sel: new Set(), byFile: new Map(), shown: PAGE,
    busy: null, cancelled: false, scanned: false,
  };

  const INTRO = {
    files: ['Find files that are there more than once', 'Finds files whose contents are exactly the same, even when the names differ or they sit in different folders. Works for any type of file.'],
    photos: ['Find pictures that look the same', 'Finds the same photo saved twice, resized, re-compressed or lightly edited, and shows them side by side so you can keep the best one.'],
    music: ['Find songs you have more than once', 'Finds songs whose sound is identical, and songs with the same artist and title and about the same length, so you can keep the best-quality copy.'],
  };
  const KIND = {
    exact: 'Identical files', 'look-alike': 'Look-alike pictures', identical: 'Identical audio', 'same-song': 'Same song (artist, title and length match)',
  };

  // ---- helpers -----------------------------------------------------------------------------------------------------------
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  let toastTimer = null;
  function toast(message, isErr) {
    const t = $('toast');
    t.textContent = message; t.className = 'toast' + (isErr ? ' err' : ''); t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, isErr ? 6000 : 3500);
  }
  const fmtSize = (b) => {
    if (b >= 1073741824) return `${(b / 1073741824).toFixed(1)} GB`;
    if (b >= 1048576) return `${(b / 1048576).toFixed(b >= 10485760 ? 0 : 1)} MB`;
    if (b >= 1024) return `${Math.round(b / 1024)} KB`;
    return `${b} B`;
  };
  const fmtDate = (ms) => new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  const fmtDur = (ms) => { const s = Math.round(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
  const num = (n) => Number(n).toLocaleString();
  const plural = (n, one, many) => `${num(n)} ${n === 1 ? one : many}`;
  const sameKey = (p) => (WIN ? p.toLowerCase() : p);

  for (const e of document.querySelectorAll('.binName')) e.textContent = BIN;
  $('trash').textContent = `Move to ${BIN}…`;
  $('confirmYes').textContent = `Move to ${BIN}`;

  // ---- settings -----------------------------------------------------------------------------------------------------------
  let saveTimer = null;
  function saveSoon() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { window.df.setSettings({ roots: S.roots, mode: S.mode, options: S.options }).catch(() => {}); }, 300);
  }

  // ---- folders -------------------------------------------------------------------------------------------------------------------
  function renderRoots() {
    const ul = $('roots');
    ul.textContent = '';
    S.roots.forEach((r, i) => {
      const li = el('li', 'root' + (r.keep ? ' prot' : ''));
      const p = el('span', 'path'); const b = document.createElement('bdi'); b.textContent = r.path; p.append(b); p.title = r.path;
      const prot = el('button', null, r.keep ? '🔒 Protected' : 'Protect');
      prot.type = 'button'; prot.setAttribute('aria-pressed', String(r.keep)); prot.disabled = !!S.busy;
      prot.title = r.keep ? 'Copies in this folder are always kept. Click to unprotect.' : 'Never move files out of this folder';
      prot.addEventListener('click', () => { r.keep = !r.keep; renderRoots(); saveSoon(); });
      const rm = el('button', null, '✕'); rm.type = 'button'; rm.setAttribute('aria-label', `Remove folder ${r.path}`); rm.disabled = !!S.busy;
      rm.addEventListener('click', () => { S.roots.splice(i, 1); renderRoots(); saveSoon(); });
      li.append(p, prot, rm);
      ul.append(li);
    });
    $('rootsHint').hidden = !S.roots.length;
  }

  function addRoots(paths) {
    let added = 0;
    for (const p of paths) {
      if (!S.roots.some((r) => sameKey(r.path) === sameKey(p))) { S.roots.push({ path: p, keep: false }); added++; }
    }
    if (added) { renderRoots(); saveSoon(); }
    return added;
  }

  async function pickFolders() {
    const list = await window.df.pickFolders();
    if (list.length) addRoots(list);
  }

  // ---- modes ---------------------------------------------------------------------------------------------------------------------
  function fillRules() {
    const sel = $('rule');
    const keep = sel.value;
    sel.textContent = '';
    for (const [k, r] of Object.entries(Rules.RULES)) {
      if (k === 'best' && S.mode === 'files') continue;
      sel.append(new Option(r.label, k));
    }
    const dflt = S.mode === 'files' ? 'oldest' : 'best';
    sel.value = [...sel.options].some((o) => o.value === keep) ? keep : dflt;
  }

  function setMode(m, fromSettings) {
    if (S.busy && !fromSettings) return;
    S.mode = m;
    for (const b of document.querySelectorAll('.mode')) b.setAttribute('aria-selected', String(b.dataset.mode === m));
    $('opt-files').hidden = m !== 'files'; $('opt-photos').hidden = m !== 'photos'; $('opt-music').hidden = m !== 'music';
    $('hiddenRow').hidden = m === 'music';
    $('introTitle').textContent = INTRO[m][0]; $('introText').textContent = INTRO[m][1];
    fillRules();
    clearResults();
    if (!fromSettings) saveSoon();
  }

  function clearResults() {
    S.groups = []; S.sel = new Set(); S.byFile = new Map(); S.scanned = false; S.shown = PAGE;
    $('results').hidden = true; $('actionbar').hidden = true; $('intro').hidden = false; $('notice').hidden = true;
    $('groups').textContent = '';
    stopAudio();
    $('status').textContent = '';
  }

  // ---- scanning --------------------------------------------------------------------------------------------------------------------
  function setBusy(kind) {
    S.busy = kind;
    $('scan').hidden = kind === 'scan' || kind === 'trash';
    $('stop').hidden = kind !== 'scan';
    $('progress').hidden = !kind;
    $('bar').style.width = '0%';
    for (const b of document.querySelectorAll('.mode')) b.disabled = !!kind;
    for (const id of ['type', 'minSize', 'threshold', 'skipHidden', 'addFolders']) $(id).disabled = !!kind;
    renderRoots();
    updatePicked();
  }

  function readOptions() {
    S.options = { type: $('type').value, minSize: Number($('minSize').value), skipHidden: $('skipHidden').checked, threshold: Number($('threshold').value) };
  }

  window.df.onScanProgress((p) => {
    if (!S.busy) return;
    const status = $('status'); const bar = $('bar');
    const pct = (f) => { bar.style.width = `${Math.round(Math.max(0, Math.min(1, f)) * 100)}%`; };
    switch (p.phase) {
      case 'list': status.textContent = `Looking through folders… ${num(p.done)} files`; pct(0.02); break;
      case 'size': status.textContent = `${num(p.done)} files listed. ${num(p.candidates)} have the same size as another.`; pct(0.05); break;
      case 'quick': status.textContent = `Comparing the start and end of ${num(p.total)} files… ${num(p.done)}`; pct(0.05 + 0.15 * (p.done / Math.max(1, p.total))); break;
      case 'full': status.textContent = `Reading ${num(p.total)} files in full… ${num(p.done)} (${fmtSize(p.bytesDone)} of ${fmtSize(p.bytesTotal)})`; pct(0.2 + 0.8 * (p.bytesDone / Math.max(1, p.bytesTotal))); break;
      case 'tags': status.textContent = `Reading song details… ${num(p.done)} of ${num(p.total)}`; pct(0.6 * (p.done / Math.max(1, p.total))); break;
      case 'audio': status.textContent = `Comparing the sound of ${num(p.total)} songs… ${num(p.done)}`; pct(0.6 + 0.4 * (p.done / Math.max(1, p.total))); break;
      case 'compare': status.textContent = 'Comparing pictures…'; pct(0.9 + 0.1 * p.fraction); break;
      default: break;
    }
  });

  async function hashPicture(id) {
    const resp = await fetch(`dfx://f/${id}`);
    if (!resp.ok) throw new Error('cannot read');
    const blob = await resp.blob();
    const head = new Uint8Array(await blob.slice(0, 65536).arrayBuffer());
    const dim = ImgSize.imageSize(head) || { w: 0, h: 0 };
    const bmp = await createImageBitmap(blob, { resizeWidth: Similar.SIZE, resizeHeight: Similar.SIZE, resizeQuality: 'medium' });
    try {
      const cv = document.createElement('canvas');
      cv.width = Similar.SIZE; cv.height = Similar.SIZE;
      const ctx = cv.getContext('2d', { willReadFrequently: true });
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, cv.width, cv.height);   // see-through pictures are judged on white
      ctx.drawImage(bmp, 0, 0, cv.width, cv.height);
      const px = ctx.getImageData(0, 0, cv.width, cv.height).data;
      const gray = new Float64Array(cv.width * cv.height);
      for (let i = 0; i < gray.length; i++) gray[i] = 0.299 * px[i * 4] + 0.587 * px[i * 4 + 1] + 0.114 * px[i * 4 + 2];
      const h = Similar.dhash(gray, cv.width, cv.height);
      return { hex: Similar.toHex(h), w: dim.w || bmp.width, h: dim.h || bmp.height, flat: h.flat };
    } finally { bmp.close(); }
  }

  async function scanPhotos() {
    $('status').textContent = 'Looking through folders…';
    const listed = await window.df.listPhotos(S.roots, S.options);
    if (listed.cancelled) return null;
    const todo = listed.files.filter((f) => !f.hex);
    let done = 0; let bad = 0;
    let batch = [];
    const flush = async () => { if (batch.length) { const b = batch; batch = []; await window.df.storePhotoHashes(b); } };
    let next = 0;
    const worker = async () => {
      for (;;) {
        if (S.cancelled) return;
        const i = next++;
        if (i >= todo.length) return;
        try { batch.push({ id: todo[i].id, ...(await hashPicture(todo[i].id)) }); } catch { bad++; }
        done++;
        if (batch.length >= 40) await flush();
        if (done % 5 === 0 || done === todo.length) {
          $('status').textContent = `Looking at pictures… ${num(done)} of ${num(todo.length)}`;
          $('bar').style.width = `${Math.round(88 * (done / Math.max(1, todo.length)))}%`;
        }
      }
    };
    await Promise.all(Array.from({ length: 4 }, worker));
    await flush();
    if (S.cancelled) return null;
    $('status').textContent = 'Comparing pictures…';
    const g = await window.df.groupPhotos(S.options.threshold);
    if (g.cancelled) return null;
    return { groups: g.groups, stats: { files: listed.files.length, undecodable: g.stats ? g.stats.undecodable : bad } };
  }

  async function startScan() {
    if (S.busy) return;
    if (!S.roots.length) { toast('Add a folder to scan first', true); return; }
    readOptions(); saveSoon();
    clearResults();
    S.cancelled = false;
    setBusy('scan');
    $('status').textContent = 'Starting…';
    let r = null;
    try {
      r = S.mode === 'photos' ? await scanPhotos() : await window.df.scan(S.mode, S.roots, S.options);
    } catch (e) {
      setBusy(null);
      $('status').textContent = '';
      showNotice('warn', `The scan stopped: ${e.message || e}`);
      $('intro').hidden = true; $('results').hidden = false; $('summary').textContent = ''; $('groups').textContent = '';
      return;
    }
    setBusy(null);
    if (!r || r.cancelled) { $('status').textContent = 'Scan stopped.'; return; }
    S.scanned = true;
    showResults(r.groups, r.stats);
  }

  // ---- results ------------------------------------------------------------------------------------------------------------------------
  function showNotice(kind, text, items) {
    const n = $('notice');
    n.hidden = false; n.className = `notice ${kind}`; n.textContent = text;
    if (items && items.length) { const ul = el('ul'); for (const i of items) ul.append(el('li', null, i)); n.append(ul); }
  }

  function showResults(groups, stats) {
    S.groups = groups;
    S.byFile = new Map();
    for (const g of groups) for (const f of g.files) S.byFile.set(f.id, g);
    S.sel = new Set(); S.shown = PAGE;
    $('intro').hidden = true; $('results').hidden = false; $('actionbar').hidden = false;
    const notes = [];
    if (stats) {
      if (stats.skippedLinks) notes.push(`${plural(stats.skippedLinks, 'shortcut/link was', 'shortcuts/links were')} not followed.`);
      if (stats.unreadable) notes.push(`${plural(stats.unreadable, 'file or folder', 'files or folders')} could not be read and ${stats.unreadable === 1 ? 'was' : 'were'} skipped.`);
      if (stats.undecodable) notes.push(`${plural(stats.undecodable, 'picture', 'pictures')} could not be opened and ${stats.undecodable === 1 ? 'was' : 'were'} skipped.`);
      if (stats.truncated) notes.push('There were more than 400,000 files, so the scan stopped early.');
    }
    if (!groups.length) {
      showNotice('ok', `No duplicates found${stats && stats.files ? ` in ${plural(stats.files, 'file', 'files')}` : ''}.`, notes);
      $('status').textContent = 'Done.';
    } else {
      if (notes.length) showNotice('warn', 'Note:', notes); else $('notice').hidden = true;
      $('status').textContent = `Done. ${stats && stats.files ? plural(stats.files, 'file', 'files') + ' checked.' : ''}`;
    }
    renderSummary();
    renderGroups();
    updatePicked();
  }

  function freeable(g) { const total = g.files.reduce((n, f) => n + f.size, 0); return total - Math.max(...g.files.map((f) => f.size)); }

  function renderSummary() {
    const files = S.groups.reduce((n, g) => n + g.files.length, 0);
    const free = S.groups.reduce((n, g) => n + freeable(g), 0);
    const box = $('summary');
    box.textContent = '';
    if (!S.groups.length) { box.textContent = 'Nothing to review.'; return; }
    box.append(document.createTextNode(`${plural(S.groups.length, 'group', 'groups')} · ${plural(files, 'file', 'files')} · about `));
    box.append(el('b', null, fmtSize(free)));
    box.append(document.createTextNode(' could be freed'));
    $('rule').disabled = !S.groups.length; $('select').disabled = !S.groups.length;
  }

  function kindLabel(g) {
    if (g.kind === 'look-alike') return g.maxDistance <= 2 ? 'Nearly identical pictures' : g.maxDistance <= 5 ? 'Very similar pictures' : 'Similar pictures';
    return KIND[g.kind] || g.kind;
  }

  function fileRow(g, f, index) {
    const row = el('div', 'frow'); row.dataset.id = String(f.id);
    const box = el('div', 'box');
    if (f.keep) { box.append(el('span', 'tag', '🔒')); box.title = 'In a protected folder: always kept'; }
    else {
      const cb = document.createElement('input'); cb.type = 'checkbox'; cb.setAttribute('aria-label', `Move ${f.name} to the ${BIN}`);
      box.append(cb);
    }
    box.append(el('span', 'tag keepit', 'Keep'));
    // preview
    let prev;
    if (g.kind === 'look-alike') {
      prev = document.createElement('img'); prev.className = 'thumb'; prev.loading = 'lazy'; prev.decoding = 'async'; prev.alt = ''; prev.src = `dfx://f/${f.id}`;
      prev.title = 'Click to enlarge'; prev.addEventListener('click', () => openLightbox(f));
    } else if (g.kind === 'identical' || g.kind === 'same-song') {
      prev = el('button', 'playbtn', '▶'); prev.type = 'button'; prev.setAttribute('aria-label', `Play ${f.name}`); prev.setAttribute('aria-pressed', 'false');
      prev.addEventListener('click', () => toggleAudio(f.id, prev));
    } else {
      const m = /\.([^.\\/]{1,5})$/.exec(f.name);
      prev = el('div', 'ext', m ? m[1] : 'file');
    }
    // info
    const info = el('div', 'info');
    const name = el('div', 'name', f.name);
    if (index === 0 && (g.kind === 'look-alike' || g.kind === 'same-song')) { name.append(el('span', 'chip', g.kind === 'look-alike' ? 'Largest' : 'Best quality')); }
    if (f.keep) name.append(el('span', 'chip lock', 'Protected folder'));
    const dir = el('div', 'dir'); const b = document.createElement('bdi'); b.textContent = f.dir; dir.append(b); dir.title = f.path;
    info.append(name, dir);
    const bits = [];
    if (g.kind === 'look-alike' && f.w && f.h) bits.push(`${num(f.w)} × ${num(f.h)}`);
    bits.push(fmtSize(f.size));
    if (f.tags && f.tags.durationMs) bits.push(fmtDur(f.tags.durationMs));
    if (f.tags && f.tags.bitrate) bits.push(`${f.tags.bitrate} kbps`);
    bits.push(`changed ${fmtDate(f.mtimeMs)}`);
    if (f.tags) {
      const t = [f.tags.title || '(no title)', f.tags.artist || '(no artist)'].join(' — ') + (f.tags.album ? ` · ${f.tags.album}` : '');
      info.append(el('div', 'meta', t));
    }
    info.append(el('div', 'meta', bits.join(' · ')));
    const btns = el('div', 'rowbtns');
    const show = el('button', null, 'Show'); show.type = 'button'; show.title = 'Show in its folder'; show.setAttribute('aria-label', `Show ${f.name} in its folder`);
    show.addEventListener('click', () => window.df.reveal(f.id));
    btns.append(show);
    row.append(box, prev, info, btns);
    return row;
  }

  function groupCard(g) {
    const card = el('section', 'group'); card.dataset.gid = String(g.id);
    const head = el('div', 'ghead');
    head.append(el('span', 'kind', kindLabel(g)), el('span', 'free', `${plural(g.files.length, 'file', 'files')} · about ${fmtSize(freeable(g))} to free`));
    card.append(head);
    g.files.forEach((f, i) => card.append(fileRow(g, f, i)));
    return card;
  }

  function renderGroups() {
    const box = $('groups');
    box.textContent = '';
    const frag = document.createDocumentFragment();
    for (const g of S.groups.slice(0, S.shown)) frag.append(groupCard(g));
    box.append(frag);
    const left = S.groups.length - S.shown;
    $('more').hidden = left <= 0;
    $('more').textContent = `Show ${Math.min(PAGE, left)} more of ${plural(left, 'group', 'groups')} left`;
    syncRows();
  }

  /** Make every visible row show its current state (selected = will be moved, otherwise kept). */
  function syncRows() {
    for (const row of document.querySelectorAll('#groups .frow')) {
      const id = Number(row.dataset.id);
      const on = S.sel.has(id);
      row.classList.toggle('sel', on);
      const cb = row.querySelector('input[type="checkbox"]');
      if (cb) cb.checked = on;
      const tag = row.querySelector('.tag.keepit');
      if (tag) tag.textContent = on ? 'Move' : 'Keep';
    }
  }

  function updatePicked() {
    const ids = [...S.sel];
    let bytes = 0;
    const byId = new Map();
    for (const g of S.groups) for (const f of g.files) byId.set(f.id, f);
    for (const id of ids) bytes += (byId.get(id) || { size: 0 }).size;
    const box = $('picked');
    box.textContent = ids.length ? `${plural(ids.length, 'file', 'files')} selected (${fmtSize(bytes)})` : 'Nothing selected. Pick the copies to remove, or use "Select the others".';
    $('trash').disabled = !ids.length || !!S.busy;
    $('select').disabled = !S.groups.length || !!S.busy;
    $('clear').disabled = !ids.length || !!S.busy;
  }

  function toggleFile(id, on) {
    const g = S.byFile.get(id);
    if (!g) return false;
    if (on) {
      const wouldAll = g.files.every((f) => f.id === id || S.sel.has(f.id));
      if (wouldAll) { toast('At least one copy of each group has to stay.', true); return false; }
      S.sel.add(id);
    } else S.sel.delete(id);
    return true;
  }

  $('groups').addEventListener('change', (e) => {
    const cb = e.target;
    if (!(cb instanceof HTMLInputElement) || cb.type !== 'checkbox') return;
    const id = Number(cb.closest('.frow').dataset.id);
    if (!toggleFile(id, cb.checked)) cb.checked = false;
    syncRows(); updatePicked();
  });

  $('select').addEventListener('click', () => {
    S.sel = Rules.suggestAll(S.groups, $('rule').value);
    syncRows(); updatePicked();
    if (!S.sel.size) toast('Nothing to select: every group already has its copies in protected folders.');
  });
  $('clear').addEventListener('click', () => { S.sel = new Set(); syncRows(); updatePicked(); });
  $('more').addEventListener('click', () => { S.shown += PAGE; renderGroups(); });

  // ---- previews ---------------------------------------------------------------------------------------------------------------------------
  const player = $('player');
  let playing = null;
  function stopAudio() {
    player.pause();
    if (playing) { playing.btn.textContent = '▶'; playing.btn.setAttribute('aria-pressed', 'false'); }
    playing = null;
  }
  function toggleAudio(id, btn) {
    if (playing && playing.id === id) { stopAudio(); return; }
    stopAudio();
    player.src = `dfx://f/${id}`;
    const p = player.play();
    if (p && p.catch) p.catch(() => toast('This song cannot be played here.', true));
    btn.textContent = '❚❚'; btn.setAttribute('aria-pressed', 'true');
    playing = { id, btn };
  }
  player.addEventListener('ended', stopAudio);

  function openLightbox(f) {
    $('lightImg').src = `dfx://f/${f.id}`;
    $('lightCaption').textContent = `${f.name} · ${f.w && f.h ? `${num(f.w)} × ${num(f.h)} · ` : ''}${fmtSize(f.size)}`;
    $('lightbox').showModal();
  }
  $('lightbox').addEventListener('close', () => { $('lightImg').removeAttribute('src'); });

  // ---- moving to the Recycle Bin ----------------------------------------------------------------------------------------------------------
  async function askTrash() {
    if (S.busy || !S.sel.size) return;
    const ids = [...S.sel];
    let plan;
    try { plan = await window.df.planTrash(ids); } catch (e) { toast(e.message || String(e), true); return; }
    if (!plan.count) { showNotice('warn', 'Nothing can be moved:', plan.problems); toast('Nothing can be moved', true); return; }
    $('confirmText').textContent = `${plural(plan.count, 'file', 'files')} (${fmtSize(plan.bytes)}) will be moved to the ${BIN}.`;
    const ul = $('confirmList'); ul.textContent = '';
    for (const p of plan.sample) ul.append(el('li', null, p));
    if (plan.count > plan.sample.length) ul.append(el('li', null, `…and ${plural(plan.count - plan.sample.length, 'more', 'more')}`));
    const prob = $('confirmProblems');
    prob.hidden = !plan.problemCount;
    prob.textContent = plan.problemCount ? `${plural(plan.problemCount, 'selected file cannot be moved', 'selected files cannot be moved')} and will be left alone.` : '';
    const dlg = $('confirm');
    dlg.returnValue = 'no';
    dlg.showModal();
    dlg.addEventListener('close', async function onClose() {
      dlg.removeEventListener('close', onClose);
      if (dlg.returnValue === 'yes') await doTrash(ids);
    });
  }

  window.df.onTrashProgress((p) => { if (S.busy === 'trash') { $('bar').style.width = `${Math.round((p.done / Math.max(1, p.total)) * 100)}%`; $('status').textContent = `Moving files… ${num(p.done)} of ${num(p.total)}`; } });

  async function doTrash(ids) {
    setBusy('trash');
    $('status').textContent = 'Moving files…';
    let r;
    try { r = await window.df.runTrash(ids); } catch (e) { setBusy(null); showNotice('warn', `Could not move the files: ${e.message || e}`); return; }
    setBusy(null);
    const gone = new Set(r.moved.map((m) => m.id));
    for (const g of S.groups) g.files = g.files.filter((f) => !gone.has(f.id));
    S.groups = S.groups.filter((g) => g.files.length > 1);
    S.byFile = new Map();
    for (const g of S.groups) for (const f of g.files) S.byFile.set(f.id, g);
    for (const id of gone) S.sel.delete(id);
    for (const s of r.skipped) S.sel.delete(s.id);
    const freed = r.bytes || 0;
    if (r.moved.length && !r.skipped.length) showNotice('ok', `Moved ${plural(r.moved.length, 'file', 'files')} (${fmtSize(freed)}) to the ${BIN}. You can restore them from there.`);
    else if (r.moved.length) showNotice('warn', `Moved ${plural(r.moved.length, 'file', 'files')} (${fmtSize(freed)}) to the ${BIN}. ${plural(r.skipped.length, 'file was', 'files were')} left alone:`, r.skipped.slice(0, 12).map((s) => `${s.name || ''}: ${s.reason}`));
    else showNotice('warn', 'Nothing was moved:', r.skipped.slice(0, 12).map((s) => `${s.name || ''}: ${s.reason}`));
    $('status').textContent = '';
    renderSummary(); renderGroups(); updatePicked();
    if (!S.groups.length) $('summary').textContent = 'No duplicates left.';
  }
  $('trash').addEventListener('click', askTrash);

  // ---- wiring ---------------------------------------------------------------------------------------------------------------------------------
  for (const b of document.querySelectorAll('.mode')) b.addEventListener('click', () => setMode(b.dataset.mode));
  $('scan').addEventListener('click', startScan);
  $('stop').addEventListener('click', () => { S.cancelled = true; window.df.cancel(); });
  $('addFolders').addEventListener('click', pickFolders);
  for (const id of ['type', 'minSize', 'threshold', 'skipHidden']) $(id).addEventListener('change', () => { readOptions(); saveSoon(); });

  const drop = $('drop');
  const dragging = (e) => e.dataTransfer && [...e.dataTransfer.types].includes('Files');
  window.addEventListener('dragover', (e) => { if (dragging(e)) { e.preventDefault(); drop.classList.add('over'); } });
  window.addEventListener('dragleave', (e) => { if (!e.relatedTarget) drop.classList.remove('over'); });
  window.addEventListener('drop', async (e) => {
    if (!dragging(e)) return;
    e.preventDefault(); drop.classList.remove('over');
    if (S.busy) return;
    const paths = [...e.dataTransfer.files].map((f) => window.df.pathForFile(f)).filter(Boolean);
    const dirs = await window.df.checkFolders(paths);
    if (!dirs.length) { toast('Drop folders, not single files.', true); return; }
    addRoots(dirs);
  });
  drop.addEventListener('keydown', (e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target === drop) { e.preventDefault(); pickFolders(); } });
  window.df.onAddRoots((list) => { if (!S.busy) addRoots(list); });

  // ---- start ---------------------------------------------------------------------------------------------------------------------------------------
  window.df.getSettings().then((s) => {
    S.roots = s.roots || [];
    S.options = { ...S.options, ...(s.options || {}) };
    $('type').value = S.options.type; $('minSize').value = String(S.options.minSize); $('threshold').value = String(S.options.threshold); $('skipHidden').checked = S.options.skipHidden;
    renderRoots();
    setMode(s.mode || 'files', true);
  }).catch(() => { renderRoots(); setMode('files', true); });
  fillRules();

  if (location.hash === '#e2e') window.__app = { S, startScan, setMode, addRoots, renderRoots, readOptions, toggleFile, syncRows, updatePicked, showResults, hashPicture };
}());
