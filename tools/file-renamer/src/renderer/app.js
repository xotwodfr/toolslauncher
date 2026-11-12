'use strict';
(() => {
  const $ = (id) => document.getElementById(id);
  const el = (tag, attrs, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) { if (v === false || v == null) continue; if (k === 'class') n.className = v; else n.setAttribute(k, v === true ? '' : v); }
    for (const kid of kids) if (kid != null) n.append(kid);
    return n;
  };
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const plural = (n, w) => `${n.toLocaleString('en')} ${w}${n === 1 ? '' : 's'}`;
  const errText = (e) => String((e && e.message) || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
  const RH = 36;

  const TITLES = { replace: 'Find & replace', insert: 'Insert text', remove: 'Remove characters', case: 'Change case', number: 'Numbering', date: 'Date', tags: 'Audio tags', extension: 'Extension', trim: 'Trim spaces', translit: 'Remove accents' };
  const WHERE = [['start', 'Before the name'], ['end', 'After the name'], ['replace', 'Instead of the name']];
  const FIELDS = {
    replace: [['find', 'text', 'Find', { wide: true }], ['replace', 'text', 'Replace with', { wide: true }], ['regex', 'check', 'Regular expression ($1, $2… for groups)'], ['matchCase', 'check', 'Match case'], ['all', 'check', 'Every match (not just the first)'], ['includeExt', 'check', 'Include the extension']],
    insert: [['text', 'text', 'Text', { wide: true }], ['where', 'select', 'Where', { opts: [['start', 'At the start'], ['beforeExt', 'At the end (before the extension)'], ['afterExt', 'After the extension'], ['index', 'At a position']] }], ['index', 'number', 'Position', { min: 0, show: (r) => r.where === 'index' }], ['fromEnd', 'check', 'Count the position from the end', { show: (r) => r.where === 'index' }]],
    remove: [['mode', 'select', 'Remove', { opts: [['range', 'Characters from a position'], ['first', 'The first characters'], ['last', 'The last characters'], ['digits', 'All digits'], ['symbols', 'Symbols and punctuation'], ['text', 'This text everywhere']] }], ['from', 'number', 'From position', { min: 1, show: (r) => r.mode === 'range' }], ['count', 'number', 'How many', { min: 0, show: (r) => ['range', 'first', 'last'].includes(r.mode) }], ['fromEnd', 'check', 'Count from the end', { show: (r) => r.mode === 'range' }], ['text', 'text', 'Text', { show: (r) => r.mode === 'text' }]],
    case: [['mode', 'select', 'Case', { opts: [['lower', 'lower case'], ['upper', 'UPPER CASE'], ['title', 'Title Case'], ['sentence', 'Sentence case'], ['camel', 'camelCase'], ['kebab', 'kebab-case'], ['snake', 'snake_case']] }], ['ext', 'check', 'Also the extension']],
    number: [['start', 'number', 'Start at'], ['step', 'number', 'Step'], ['pad', 'number', 'Digits', { min: 0, max: 12 }], ['where', 'select', 'Where', { opts: [...WHERE, ['index', 'At a position']] }], ['index', 'number', 'Position', { min: 0, show: (r) => r.where === 'index' }], ['separator', 'text', 'Separator', { show: (r) => r.where === 'start' || r.where === 'end' }], ['perFolder', 'check', 'Start again in each folder']],
    date: [['source', 'select', 'Date', { opts: [['modified', 'Date modified'], ['created', 'Date created'], ['exif', 'Photo taken (EXIF)']] }], ['format', 'text', 'Format'], ['where', 'select', 'Where', { opts: WHERE }], ['separator', 'text', 'Separator', { show: (r) => r.where !== 'replace' }], ['_', 'hint', 'YYYY year, MM month, DD day, HH hour, mm minutes, ss seconds, MMM = Jan. Text in [brackets] is kept.']],
    tags: [['pattern', 'text', 'Pattern', { wide: true }], ['where', 'select', 'Where', { opts: WHERE }], ['separator', 'text', 'Separator', { show: (r) => r.where !== 'replace' }], ['_', 'hint', 'Use {artist} {title} {track} {album} {year} {albumartist} {disc}. For MP3, FLAC, M4A, Ogg, Opus, WAV and more.']],
    extension: [['mode', 'select', 'Extension', { opts: [['lower', 'lower case'], ['upper', 'UPPER CASE'], ['change', 'Change to'], ['remove', 'Remove']] }], ['value', 'text', 'New extension', { show: (r) => r.mode === 'change' }]],
    trim: [['trim', 'check', 'Remove spaces at both ends'], ['collapse', 'check', 'Turn repeated spaces into one'], ['separators', 'check', 'Turn _ and . into spaces']],
    translit: [['_', 'hint', 'é → e, ß → ss, Æ → AE, Ł → L, “quotes” → "quotes". Letters of other scripts are kept.']],
  };

  const OPTS_KEY = 'renamer.options';
  const RULES_KEY = 'renamer.rules';
  const load = (k, d) => { try { const v = JSON.parse(localStorage.getItem(k) || 'null'); return v == null ? d : v; } catch { return d; } };
  const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode: fine */ } };

  const S = {
    defaults: {}, rules: [], opts: { sort: 'name', reverse: false, show: 'all', recursive: false, folders: 'contents', autoSuffix: false, windowsSafe: true, ...load(OPTS_KEY, {}) },
    rows: [], visible: [], summary: null, total: 0, busy: false, lastBatch: null, presets: [],
  };
  const saveOpts = () => save(OPTS_KEY, S.opts);
  const saveRules = () => save(RULES_KEY, S.rules);

  // ---- messages ----------------------------------------------------------------------------------------------------------
  let toastTimer = null;
  function toast(text, err = false) {
    const t = $('toast'); t.textContent = text; t.className = 'toast' + (err ? ' err' : ''); t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 4200);
  }
  function banner(text, action) {
    const b = $('banner'); b.replaceChildren(); b.hidden = !text;
    if (!text) return;
    b.append(el('span', { class: 'grow' }, text));
    if (action) { const btn = el('button', { class: 'btn small' }, action.label); btn.addEventListener('click', action.run); b.append(btn); }
  }
  function showResult(text, kind, actions = []) {
    const r = $('result'); r.replaceChildren(); r.className = 'result' + (kind ? ' ' + kind : ''); r.hidden = !text;
    if (!text) return;
    r.append(el('span', { class: 'grow' }, text));
    for (const a of actions) { const b = el('button', { class: 'btn small', id: a.id || null }, a.label); b.addEventListener('click', a.run); r.append(b); }
    const x = el('button', { class: 'btn small ghost' }, 'Close'); x.addEventListener('click', () => { r.hidden = true; }); r.append(x);
  }

  // ---- rules ---------------------------------------------------------------------------------------------------------------
  function addRule(type, settings) {
    S.rules.push({ type, enabled: true, ...JSON.parse(JSON.stringify(S.defaults[type] || {})), ...(settings || {}) });
    renderRules(); changed();
    const cards = $('ruleList').querySelectorAll('.rule');
    const last = cards[cards.length - 1];
    if (last) { last.scrollIntoView({ block: 'nearest' }); const f = last.querySelector('.rbody input, .rbody select'); if (f) f.focus(); }
  }
  function moveRule(i, to) {
    if (to < 0 || to >= S.rules.length || i === to) return;
    const [r] = S.rules.splice(i, 1); S.rules.splice(to, 0, r);
    renderRules(); changed();
  }
  function ruleErrors() {
    const count = new Map();
    for (const row of S.rows) for (const e of row.errors) { const m = /^Rule (\d+):/.exec(e); if (m) count.set(+m[1] - 1, (count.get(+m[1] - 1) || 0) + 1); }
    return count;
  }

  function renderRules() {
    const list = $('ruleList');
    list.replaceChildren();
    $('noRules').hidden = S.rules.length > 0;
    const errs = ruleErrors();
    S.rules.forEach((r, i) => {
      const card = el('div', { class: 'rule' + (r.enabled ? '' : ' off') + (errs.get(i) ? ' bad' : ''), 'data-i': String(i) });
      const grip = el('span', { class: 'grip', draggable: 'true', title: 'Drag to change the order', 'aria-hidden': 'true' }, '⋮⋮');
      const on = el('input', { type: 'checkbox', 'aria-label': `Use rule ${i + 1}: ${TITLES[r.type]}` }); on.checked = r.enabled;
      on.addEventListener('change', () => { r.enabled = on.checked; card.classList.toggle('off', !r.enabled); changed(); });
      const up = el('button', { class: 'icon', type: 'button', title: 'Move up', 'aria-label': `Move rule ${i + 1} up`, 'data-act': 'up' }, '▲'); up.disabled = i === 0;
      const down = el('button', { class: 'icon', type: 'button', title: 'Move down', 'aria-label': `Move rule ${i + 1} down`, 'data-act': 'down' }, '▼'); down.disabled = i === S.rules.length - 1;
      const del = el('button', { class: 'icon', type: 'button', title: 'Remove this rule', 'aria-label': `Remove rule ${i + 1}`, 'data-act': 'del' }, '✕');
      up.addEventListener('click', () => moveRule(i, i - 1));
      down.addEventListener('click', () => moveRule(i, i + 1));
      del.addEventListener('click', () => { S.rules.splice(i, 1); renderRules(); changed(); });
      card.append(el('div', { class: 'rtitle' }, grip, on, el('span', { class: 'rnum' }, String(i + 1)), el('span', { class: 'rname' }, TITLES[r.type]), up, down, del));
      const body = el('div', { class: 'rbody' });
      buildFields(body, r);
      if (errs.get(i)) body.append(el('div', { class: 'rerr' }, `${plural(errs.get(i), 'file')}: this rule cannot be applied (see the list).`));
      card.append(body);
      // dragging to reorder
      grip.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/x-rule', String(i)); e.dataTransfer.effectAllowed = 'move'; card.classList.add('dragging'); S.draggingRule = true; });
      grip.addEventListener('dragend', () => { card.classList.remove('dragging'); S.draggingRule = false; list.querySelectorAll('.dropbefore').forEach((c) => c.classList.remove('dropbefore')); });
      card.addEventListener('dragover', (e) => { if (!S.draggingRule) return; e.preventDefault(); e.stopPropagation(); list.querySelectorAll('.dropbefore').forEach((c) => c.classList.remove('dropbefore')); card.classList.add('dropbefore'); });
      card.addEventListener('drop', (e) => {
        if (!S.draggingRule) return;
        e.preventDefault(); e.stopPropagation();
        const from = +e.dataTransfer.getData('text/x-rule');
        moveRule(from, from < i ? i - 1 : i);
      });
      list.append(card);
    });
  }

  /** Mark rules that cannot be applied to some files, in place (rebuilding the cards would lose the typing focus). */
  function paintRuleErrors() {
    const errs = ruleErrors();
    $('ruleList').querySelectorAll('.rule').forEach((card) => {
      const i = +card.dataset.i; const n = errs.get(i) || 0;
      card.classList.toggle('bad', n > 0);
      let line = card.querySelector('.rerr');
      if (!n) { if (line) line.remove(); return; }
      if (!line) { line = el('div', { class: 'rerr' }); card.querySelector('.rbody').append(line); }
      line.textContent = `${plural(n, 'file')}: this rule cannot be applied (see the list).`;
    });
  }

  function buildFields(body, r) {
    const refresh = () => { body.replaceChildren(); buildFields(body, r); paintRuleErrors(); };
    for (const [key, kind, label, o = {}] of FIELDS[r.type]) {
      if (o.show && !o.show(r)) continue;
      if (kind === 'hint') { body.append(el('div', { class: 'rhint' }, label)); continue; }
      const id = `r${S.rules.indexOf(r)}-${key}`;
      if (kind === 'check') {
        const c = el('input', { type: 'checkbox', id, 'data-key': key }); c.checked = !!r[key];
        c.addEventListener('change', () => { r[key] = c.checked; changed(); });
        body.append(el('label', { class: 'check' }, c, ' ' + label));
        continue;
      }
      let input;
      if (kind === 'select') {
        input = el('select', { id, 'data-key': key });
        for (const [v, t] of o.opts) input.append(el('option', { value: v }, t));
        input.value = r[key];
        input.addEventListener('change', () => { r[key] = input.value; refresh(); changed(); });
      } else {
        input = el('input', { type: kind === 'number' ? 'number' : 'text', id, 'data-key': key, spellcheck: 'false', min: o.min != null ? String(o.min) : null, max: o.max != null ? String(o.max) : null });
        input.value = r[key] == null ? '' : String(r[key]);
        input.addEventListener('input', () => { r[key] = kind === 'number' ? (input.value === '' ? 0 : Number(input.value)) : input.value; changed(); });
      }
      body.append(el('div', { class: 'field' + (o.wide ? ' wide' : '') }, el('label', { for: id }, label), input));
    }
  }

  // ---- preview -------------------------------------------------------------------------------------------------------------
  let previewTimer = null;
  function changed() { saveRules(); clearTimeout(previewTimer); previewTimer = setTimeout(runPreview, 90); }
  const viewOpts = () => ({ sort: S.opts.sort, reverse: S.opts.reverse, autoSuffix: S.opts.autoSuffix, windowsSafe: S.opts.windowsSafe });
  let previewing = 0;
  async function runPreview() {
    previewing++;
    try {
      const p = await window.rn.preview(S.rules, viewOpts());
      if (p.stale) return;
      S.rows = p.rows; S.summary = p.summary; S.total = p.rows.length;
      paintRuleErrors();
      rebuildVisible();
    } catch (e) { banner('Could not work out the new names: ' + errText(e)); }
    finally { previewing--; updateBar(); }
  }
  function rebuildVisible() {
    const show = S.opts.show;
    S.visible = S.rows.filter((r) => show === 'all' || (show === 'changed' ? r.status !== 'same' : r.status === 'error' || r.warnings.length));
    $('scroll').querySelector('.spacer').style.height = S.visible.length * RH + 'px';
    $('empty').hidden = S.total > 0; $('table').hidden = S.total === 0; $('clear').hidden = S.total === 0;
    renderRows();
  }
  /** Mark the part of the new name that differs from the old one. */
  function markChange(oldName, newName) {
    if (oldName === newName) return esc(newName);
    let a = 0; while (a < oldName.length && a < newName.length && oldName[a] === newName[a]) a++;
    let b = 0; while (b < oldName.length - a && b < newName.length - a && oldName[oldName.length - 1 - b] === newName[newName.length - 1 - b]) b++;
    const mid = newName.slice(a, newName.length - b);
    return esc(newName.slice(0, a)) + (mid ? `<mark class="ch">${esc(mid)}</mark>` : '') + esc(newName.slice(newName.length - b));
  }
  function noteOf(r) {
    if (r.errors.length) return r.errors.join(' · ');
    if (r.warnings.length) return r.warnings.join(' · ');
    if (r.status === 'same') return 'No change';
    if (r.caseOnly) return 'Only the letter case changes (done in two steps)';
    if (r.swap) return 'Takes the name of another file in the list';
    return '';
  }
  let raf = false;
  const scheduleRows = () => { if (raf) return; raf = true; requestAnimationFrame(() => { raf = false; renderRows(); }); };
  function renderRows() {
    const sc = $('scroll');
    const first = Math.max(0, Math.floor(sc.scrollTop / RH) - 8);
    const last = Math.min(S.visible.length, Math.ceil((sc.scrollTop + sc.clientHeight) / RH) + 8);
    let html = '';
    for (let n = first; n < last; n++) {
      const r = S.visible[n];
      const cls = r.status === 'error' ? 'error' : r.warnings.length ? 'warn' : r.status;
      const folder = r.dir.split(/[\\/]/).filter(Boolean).pop() || r.dir;
      const note = noteOf(r);
      html += `<div class="trow ${cls}" data-id="${r.id}" role="row">` +
        `<span class="old"><span class="nm" title="${esc(r.dir)}">${r.isDir ? '▣ ' : ''}${esc(r.name)}</span><span class="fold">${esc(folder)}</span></span>` +
        '<span class="arrow" aria-hidden="true">→</span>' +
        `<span class="new"><span class="nm">${markChange(r.name, r.newName)}</span></span>` +
        `<span class="note" title="${esc(note)}">${esc(note)}</span>` +
        `<span><button class="x" data-rm="${r.id}" title="Take this file out of the list (it stays on disk)" aria-label="Remove ${esc(r.name)} from the list">✕</button></span></div>`;
    }
    const rows = $('rows');
    rows.style.transform = `translateY(${first * RH}px)`;
    rows.innerHTML = html;
  }
  function updateBar() {
    const s = S.summary;
    if (!s || !S.total) { $('summary').textContent = S.total ? '' : 'No files yet.'; $('rename').disabled = true; $('rename').textContent = 'Rename'; $('dropBad').hidden = true; return; }
    const parts = [plural(s.total, 'file'), `${s.rename.toLocaleString('en')} will be renamed`];
    if (s.same) parts.push(`${s.same.toLocaleString('en')} unchanged`);
    if (s.errors) parts.push(`${plural(s.errors, 'problem')} to fix first`);
    if (s.warnings) parts.push(plural(s.warnings, 'warning'));
    $('summary').textContent = parts.join(' · ');
    $('rename').disabled = S.busy || !!s.errors || !s.rename || previewing > 0;
    $('rename').textContent = s.rename ? `Rename ${plural(s.rename, 'file')}` : 'Rename';
    $('dropBad').hidden = !s.errors;
  }

  // ---- adding files --------------------------------------------------------------------------------------------------------------
  const addOpts = () => ({ recursive: S.opts.recursive, folders: S.opts.folders });
  async function added(p) {
    const r = await p;
    if (!r) return;
    if (r.capped) toast('The list is full (20,000 files). Rename these first, then add more.', true);
    else if (r.added === 0 && r.skipped) toast('Those files are already in the list');
    else if (r.added === 0 && r.total === 0) toast('No files found there. To rename folders themselves, choose "rename the folder itself".');
    changed();
  }
  function wireAdd() {
    for (const id of ['addFiles', 'addFiles2']) $(id).addEventListener('click', () => added(window.rn.pickFiles(addOpts())).catch((e) => toast(errText(e), true)));
    for (const id of ['addFolder', 'addFolder2']) $(id).addEventListener('click', () => added(window.rn.pickFolder(addOpts())).catch((e) => toast(errText(e), true)));
    $('empty').addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); added(window.rn.pickFiles(addOpts())); } });
    $('clear').addEventListener('click', async () => { await window.rn.clear(); showResult(''); changed(); });
    let depth = 0;
    const isFiles = (e) => e.dataTransfer && [...e.dataTransfer.types].includes('Files');
    window.addEventListener('dragenter', (e) => { if (!isFiles(e)) return; e.preventDefault(); depth++; document.body.classList.add('dragging'); });
    window.addEventListener('dragleave', (e) => { if (!isFiles(e)) return; depth = Math.max(0, depth - 1); if (!depth) document.body.classList.remove('dragging'); });
    window.addEventListener('dragover', (e) => { if (isFiles(e)) e.preventDefault(); });
    window.addEventListener('drop', (e) => {
      if (!isFiles(e)) return;
      e.preventDefault(); depth = 0; document.body.classList.remove('dragging');
      const paths = [...e.dataTransfer.files].map((f) => window.rn.pathForFile(f)).filter(Boolean);
      if (paths.length) added(window.rn.addPaths(paths, addOpts())).catch((err) => toast(errText(err), true));
    });
    $('rows').addEventListener('click', async (e) => {
      const b = e.target.closest('[data-rm]'); if (!b) return;
      await window.rn.remove([+b.dataset.rm]); changed();
    });
    $('scroll').addEventListener('scroll', scheduleRows, { passive: true });
    window.addEventListener('resize', scheduleRows);
  }

  // ---- options ---------------------------------------------------------------------------------------------------------------
  function wireOptions() {
    $('sort').value = S.opts.sort; $('reverse').checked = S.opts.reverse; $('recursive').checked = S.opts.recursive; $('folders').value = S.opts.folders;
    $('autoSuffix').checked = S.opts.autoSuffix; $('windowsSafe').checked = S.opts.windowsSafe;
    if (/Windows/i.test(navigator.userAgent)) $('winSafeWrap').hidden = true; // always on there
    $('sort').addEventListener('change', () => { S.opts.sort = $('sort').value; saveOpts(); changed(); });
    $('reverse').addEventListener('change', () => { S.opts.reverse = $('reverse').checked; saveOpts(); changed(); });
    $('recursive').addEventListener('change', () => { S.opts.recursive = $('recursive').checked; saveOpts(); });
    $('folders').addEventListener('change', () => { S.opts.folders = $('folders').value; saveOpts(); });
    $('autoSuffix').addEventListener('change', () => { S.opts.autoSuffix = $('autoSuffix').checked; saveOpts(); changed(); });
    $('windowsSafe').addEventListener('change', () => { S.opts.windowsSafe = $('windowsSafe').checked; saveOpts(); changed(); });
    const segs = document.querySelectorAll('.seg .mode');
    const paint = () => segs.forEach((b) => b.setAttribute('aria-checked', String(b.dataset.show === S.opts.show)));
    segs.forEach((b) => b.addEventListener('click', () => { S.opts.show = b.dataset.show; saveOpts(); paint(); rebuildVisible(); }));
    paint();
    $('addRule').addEventListener('change', () => { const t = $('addRule').value; $('addRule').value = ''; if (t) addRule(t); });
    $('dropBad').addEventListener('click', async () => { await window.rn.remove(S.rows.filter((r) => r.status === 'error').map((r) => r.id)); changed(); });
  }

  // ---- renaming and undo ---------------------------------------------------------------------------------------------------------
  async function rename() {
    if (S.busy) return;
    S.busy = true; updateBar(); showResult('');
    $('summary').textContent = 'Renaming…';
    try {
      const r = await window.rn.rename(S.rules, viewOpts());
      if (r.ok) {
        S.lastBatch = r.batch;
        showResult(`Renamed ${plural(r.done, 'file')}.`, 'ok', [
          { label: 'Undo', id: 'undoLast', run: () => undo(r.batch) },
          { label: 'Show in folder', run: () => window.rn.show(r.first) },
        ]);
      } else if (r.nothing) toast('Nothing to rename: every new name is the same as the old one');
      else if (r.problems) toast(`${plural(r.problems, 'file')} still ${r.problems === 1 ? 'has a problem' : 'have problems'}. Fix them first.`, true);
      else showResult(r.error || 'Renaming failed', 'err');
    } catch (e) { showResult(errText(e), 'err'); }
    finally { S.busy = false; await runPreview(); }
  }
  async function undo(id, partial = false) {
    const r = await window.rn.undo(id, partial);
    if (r.ok) {
      const msg = `Undone: ${plural(r.undone, 'file')} got ${r.undone === 1 ? 'its' : 'their'} old name back.` + (r.skipped && r.skipped.length ? ` ${r.skipped.length} could not be: ${r.skipped.slice(0, 2).join('; ')}` : '');
      showResult(msg, r.skipped && r.skipped.length ? 'err' : 'ok');
    } else if (r.problems && r.okCount) {
      showResult(r.error, 'err', [{ label: `Undo the other ${r.okCount}`, id: 'undoPartial', run: () => undo(id, true) }]);
    } else showResult(r.error || 'Undo failed', 'err');
    await runPreview();
    if ($('histDlg').open) await renderHistory();
  }

  const STATE = { done: 'Done', undone: 'Undone', 'partly-undone': 'Partly undone', 'rolled-back': 'Stopped, put back', broken: 'Stopped, some files not put back', running: 'Interrupted' };
  const when = (ms) => { const d = new Date(ms); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`; };
  async function renderHistory() {
    const items = await window.rn.history();
    const box = $('histList'); box.replaceChildren();
    if (!items.length) { box.append(el('p', { class: 'muted' }, 'No batches yet.')); return; }
    for (const h of items) {
      const acts = el('div', { class: 'acts' });
      if (h.state === 'done' || h.state === 'partly-undone') { const b = el('button', { class: 'btn small', 'data-undo': h.id }, 'Undo'); b.addEventListener('click', () => undo(h.id)); acts.append(b); }
      if (h.state === 'running') { const b = el('button', { class: 'btn small' }, 'Put back'); b.addEventListener('click', () => recover(h.id)); acts.append(b); }
      box.append(el('div', { class: 'hitem', 'data-id': h.id },
        el('span', { class: 'when' }, `${when(h.time)} · ${plural(h.count, 'file')}`),
        acts,
        el('span', { class: 'meta' }, el('span', { class: 'st' + (h.state === 'done' ? ' done' : '') }, STATE[h.state] || h.state), el('span', { class: 'hfold' }, ' · ' + h.folder)),
        el('span', { class: 'sample' }, h.sample.map((s) => `${s.from} → ${s.to}`).join('   ·   ') + (h.count > h.sample.length ? '   …' : ''))));
    }
  }
  async function recover(id) {
    try {
      const r = await window.rn.recover(id);
      banner('');
      showResult(`Put back ${plural(r.restored, 'file')} from the interrupted batch.` + (r.lost.length ? ` Not found: ${r.lost.slice(0, 3).join(', ')}` : ''), r.lost.length ? 'err' : 'ok');
      await runPreview();
      if ($('histDlg').open) await renderHistory();
    } catch (e) { toast(errText(e), true); }
  }

  // ---- presets ---------------------------------------------------------------------------------------------------------------------
  function paintPresets(sel) {
    const s = $('preset'); s.replaceChildren(el('option', { value: '' }, S.presets.length ? 'Presets…' : 'No presets'));
    for (const p of S.presets) s.append(el('option', { value: p.name }, p.name));
    s.value = sel || ''; $('delPreset').disabled = !s.value;
  }
  function wirePresets() {
    $('preset').addEventListener('change', () => {
      const p = S.presets.find((x) => x.name === $('preset').value);
      $('delPreset').disabled = !p;
      if (!p) return;
      S.rules = JSON.parse(JSON.stringify(p.rules)); $('presetName').value = p.name;
      renderRules(); changed();
      toast(`Loaded "${p.name}"`);
    });
    $('savePreset').addEventListener('click', async () => {
      const name = $('presetName').value.trim();
      if (!name) { $('presetName').focus(); toast('Type a name for the preset first', true); return; }
      if (!S.rules.length) { toast('Add some rules first', true); return; }
      try { S.presets = await window.rn.savePreset(name, S.rules); paintPresets(name); toast(`Saved "${name}"`); } catch (e) { toast(errText(e), true); }
    });
    $('presetName').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('savePreset').click(); });
    $('delPreset').addEventListener('click', async () => {
      const name = $('preset').value; if (!name) return;
      S.presets = await window.rn.removePreset(name); paintPresets(); toast(`Deleted "${name}"`);
    });
  }

  // ---- start ----------------------------------------------------------------------------------------------------------------------------
  async function init() {
    S.defaults = await window.rn.defaults();
    const saved = load(RULES_KEY, []);
    S.rules = Array.isArray(saved) ? saved.filter((r) => r && TITLES[r.type]).map((r) => ({ ...S.defaults[r.type], ...r })) : [];
    if (location.hash === '#e2e') S.rules = [];
    wireAdd(); wireOptions(); wirePresets();
    $('rename').addEventListener('click', rename);
    $('histBtn').addEventListener('click', async () => { await renderHistory(); $('histDlg').showModal(); });
    $('histClose').addEventListener('click', () => $('histDlg').close());
    window.rn.onProgress((p) => { $('summary').textContent = `Renaming ${p.done.toLocaleString('en')} of ${p.total.toLocaleString('en')}…`; });
    window.rn.onOpened(() => changed());
    renderRules();
    S.presets = await window.rn.presets(); paintPresets();
    await runPreview();
    const stuck = await window.rn.interrupted();
    if (stuck.length) banner(`A batch of ${plural(stuck[0].count, 'file')} was interrupted on ${when(stuck[0].time)} (the app or the computer stopped). Some files may have temporary names.`, { label: 'Put the files back', run: () => recover(stuck[0].id) });
    S.ready = true;
  }
  window.__app = { S, clearRules: () => { S.rules = []; renderRules(); changed(); }, addRule, moveRule, runPreview, rename, undo, renderHistory, rows: () => S.rows };
  init();
})();
