'use strict';
(() => {
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => [...document.querySelectorAll(s)];
  let files = [];          // {path, name, bytes, kind: 'pdf'|'image', pages?, error?, status}
  let mode = 'merge';
  let outDir = null;
  let running = false;
  let batch = [];          // the files of the running job; progress events index into this
  let lastOutputs = [];

  const MODES = {
    merge: { go: 'Merge', hint: 'Joins the PDFs in the list into one, in list order. Use ▲ ▼ to reorder.', needs: 2, kind: 'pdf' },
    split: { go: 'Split', hint: 'Cuts each PDF in the list into several smaller PDFs.', needs: 1, kind: 'pdf' },
    pages: { go: 'Apply', hint: 'Extract, delete or rotate chosen pages of each PDF in the list.', needs: 1, kind: 'pdf' },
    images: { go: 'Create PDF', hint: 'Puts the JPEG and PNG images in the list, in list order, onto PDF pages.', needs: 1, kind: 'image' },
  };

  const fmtBytes = (n) => {
    if (n == null) return '';
    const u = ['B', 'KB', 'MB', 'GB']; let i = 0;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return `${n.toFixed(n < 10 && i ? 1 : 0)} ${u[i]}`;
  };

  // ---- saved settings (a convenience only: everything works without storage) ----------------------------------------
  const KEY = 'pdf-toolkit.settings.v1';
  const FIELDS = ['#splitSpec', '#splitEvery', '#pagesAction', '#pagesSpec', '#pagesAngle', '#imgSize', '#imgMargin'];
  function save() {
    try {
      localStorage.setItem(KEY, JSON.stringify({
        mode, splitMode: ($('input[name=splitMode]:checked') || {}).value, imgEach: $('#imgEach').checked,
        fields: Object.fromEntries(FIELDS.map((f) => [f, $(f).value])),
      }));
    } catch { /* private mode / blocked storage */ }
  }
  function restore() {
    let s = {};
    try { s = JSON.parse(localStorage.getItem(KEY)) || {}; } catch { /* ignore */ }
    for (const [sel, v] of Object.entries(s.fields || {})) { if (FIELDS.includes(sel) && typeof v === 'string') $(sel).value = v; }
    const r = $(`input[name=splitMode][value="${s.splitMode}"]`); if (r) r.checked = true;
    $('#imgEach').checked = !!s.imgEach;
    if (MODES[s.mode]) mode = s.mode;
  }

  // ---- list ------------------------------------------------------------------------------------------------------------
  const compatible = (f) => f.kind === MODES[mode].kind;
  const eligible = () => files.filter((f) => compatible(f) && !f.error);

  function addFiles(list) {
    const have = new Set(files.map((f) => f.path));
    const fresh = list.filter((f) => !have.has(f.path)).map((f) => ({ ...f, status: 'ready' }));
    files.push(...fresh);
    render();
    for (const f of fresh) {
      if (f.kind !== 'pdf') continue;
      window.tk.inspect(f.path).then((r) => { if (r.ok) f.pages = r.pages; else f.error = r.error; render(); });
    }
  }

  function move(i, dir) {
    let j = i + dir;
    while (j >= 0 && j < files.length && !compatible(files[j])) j += dir; // swap with the next file of the same kind
    if (j < 0 || j >= files.length) return;
    [files[i], files[j]] = [files[j], files[i]];
    render();
    // keep keyboard focus on the moved row; at the very top/bottom the pressed button is disabled, so use the other one
    const row = $$('#list .item')[j];
    if (row) { const same = row.querySelector(dir < 0 ? '[data-act=up]' : '[data-act=down]'); (same && !same.disabled ? same : row.querySelector(dir < 0 ? '[data-act=down]' : '[data-act=up]')).focus(); }
  }

  const button = (text, label, act, onClick, disabled) => {
    const b = document.createElement('button'); b.className = 'btn ghost small'; b.textContent = text;
    b.setAttribute('aria-label', label); b.dataset.act = act; b.disabled = !!disabled; b.addEventListener('click', onClick);
    return b;
  };

  function render() {
    const ul = $('#list');
    ul.replaceChildren(...files.map((f, i) => {
      const li = document.createElement('li');
      const dim = !compatible(f);
      li.className = `item ${f.status}${dim ? ' dim' : ''}`;
      const name = document.createElement('span'); name.className = 'name'; name.textContent = f.name; name.title = f.path;
      const info = document.createElement('span'); info.className = 'st';
      if (f.error) { info.textContent = f.error; info.classList.add('err-text'); info.title = f.error; }
      else if (dim) info.textContent = 'Not used in this mode';
      else if (f.status === 'working') info.textContent = 'Working…';
      else if (f.status === 'done') info.textContent = f.outputs ? `Done (${f.outputs} file${f.outputs > 1 ? 's' : ''})` : 'Done';
      else if (f.status === 'skipped') info.textContent = 'Skipped';
      else info.textContent = f.kind === 'pdf' ? (f.pages ? `${f.pages} page${f.pages > 1 ? 's' : ''}` : 'Reading…') : 'Image';
      const size = document.createElement('span'); size.className = 'st'; size.textContent = fmtBytes(f.bytes);
      const acts = document.createElement('span'); acts.className = 'acts';
      acts.append(
        button('▲', `Move ${f.name} up`, 'up', () => move(i, -1), running || i === 0),
        button('▼', `Move ${f.name} down`, 'down', () => move(i, 1), running || i === files.length - 1),
        button('✕', `Remove ${f.name}`, 'remove', () => { files.splice(i, 1); render(); }, running),
      );
      li.append(name, info, size, acts);
      return li;
    }));
    const use = eligible().length;
    $('#count').textContent = files.length ? `${files.length} file${files.length > 1 ? 's' : ''} · ${use} used` : 'No files';
    $('#clear').hidden = !files.length || running;
    const m = MODES[mode];
    $('#go').textContent = m.go;
    $('#go').disabled = use < m.needs || running;
    $('#go').title = use < m.needs ? (m.needs > 1 ? `Add at least ${m.needs} ${m.kind === 'pdf' ? 'PDFs' : 'images'}` : `Add ${m.kind === 'pdf' ? 'a PDF' : 'an image'} first`) : '';
    $('#go').hidden = running;
    $('#cancel').hidden = !running;
    $('#resetOut').hidden = !outDir;
    $('#outDir').value = outDir || 'Same folder as the first file';
  }

  // ---- modes and options ----------------------------------------------------------------------------------------------------
  function showMode() {
    $$('#modes .mode').forEach((b) => { const on = b.dataset.mode === mode; b.setAttribute('aria-checked', String(on)); b.tabIndex = on ? 0 : -1; });
    for (const k of Object.keys(MODES)) $(`#opts-${k}`).hidden = k !== mode;
    $('#modeHint').textContent = MODES[mode].hint;
    const sm = ($('input[name=splitMode]:checked') || {}).value;
    $('#splitSpecRow').hidden = sm !== 'ranges';
    $('#splitEveryRow').hidden = sm !== 'every';
    $('#angleRow').hidden = $('#pagesAction').value !== 'rotate';
    $('#marginRow').hidden = $('#imgSize').value === 'fit';
    render();
  }
  function setMode(m) { if (running || !MODES[m]) return; mode = m; $('#summary').hidden = true; showMode(); save(); }

  function options() {
    const base = { outDir };
    if (mode === 'split') {
      const sm = $('input[name=splitMode]:checked').value;
      return { ...base, mode: sm, spec: $('#splitSpec').value, every: Number($('#splitEvery').value) };
    }
    if (mode === 'pages') return { ...base, action: $('#pagesAction').value, spec: $('#pagesSpec').value, angle: Number($('#pagesAngle').value) };
    if (mode === 'images') return { ...base, pageSize: $('#imgSize').value, margin: Number($('#imgMargin').value), perImage: $('#imgEach').checked };
    return base;
  }

  // ---- running ---------------------------------------------------------------------------------------------------------------
  const clean = (m) => String(m || '').replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

  async function run() {
    if (running) return;
    batch = eligible();
    if (batch.length < MODES[mode].needs) return;
    batch.forEach((f) => { f.status = 'ready'; delete f.outputs; });
    running = true; lastOutputs = []; $('#summary').hidden = true; render();
    const s = $('#summary');
    try {
      const res = await window.tk.run(mode, batch.map((f) => f.path), options());
      lastOutputs = res.outputs;
      s.replaceChildren();
      const line = document.createElement('div');
      const n = res.outputs.length;
      line.textContent = `${n} file${n === 1 ? '' : 's'} created${res.failed ? `, ${res.failed} failed` : ''}${res.cancelled ? ' (cancelled)' : ''}.`;
      s.append(line);
      if (n) {
        const b = document.createElement('button'); b.className = 'btn small'; b.textContent = 'Show in folder';
        b.addEventListener('click', () => window.tk.reveal(lastOutputs[lastOutputs.length - 1]));
        s.append(b);
      }
      s.hidden = false;
    } catch (e) {
      batch.forEach((f) => { f.status = 'ready'; });
      s.textContent = clean(e.message); s.hidden = false;
    } finally {
      running = false; render();
    }
  }

  window.tk.onProgress((p) => {
    const f = batch[p.index];
    if (!f) return;
    f.status = p.status;
    if (p.outputs) f.outputs = p.outputs;
    if (p.status === 'error') f.error = p.error;
    render();
  });

  // ---- wiring ---------------------------------------------------------------------------------------------------------------
  $('#addFiles').addEventListener('click', async () => addFiles(await window.tk.pickFiles()));
  $('#addFolder').addEventListener('click', async () => addFiles(await window.tk.pickFolder()));
  $('#clear').addEventListener('click', () => { files = []; $('#summary').hidden = true; render(); });
  $('#go').addEventListener('click', run);
  $('#cancel').addEventListener('click', () => window.tk.cancel());
  $('#pickOut').addEventListener('click', async () => { const d = await window.tk.pickOutputDir(); if (d) { outDir = d; render(); } });
  $('#resetOut').addEventListener('click', () => { outDir = null; render(); });
  $('#drop').addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('#addFiles').click(); } });

  $$('#modes .mode').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));
  $('#modes').addEventListener('keydown', (e) => {
    const keys = Object.keys(MODES); const i = keys.indexOf(mode);
    const next = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
    if (!next) return;
    e.preventDefault();
    setMode(keys[(i + next + keys.length) % keys.length]);
    $(`#modes [data-mode=${mode}]`).focus();
  });
  $$('input[name=splitMode], #pagesAction, #imgSize').forEach((n) => n.addEventListener('change', () => { showMode(); save(); }));
  [...FIELDS, '#imgEach'].forEach((s) => $(s).addEventListener('change', save));

  const drop = $('#drop');
  ['dragenter', 'dragover'].forEach((ev) => document.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((ev) => document.addEventListener(ev, (e) => { e.preventDefault(); if (ev === 'drop' || e.target === document.documentElement) drop.classList.remove('over'); }));
  document.addEventListener('drop', async (e) => {
    if (!e.dataTransfer || !e.dataTransfer.files.length) return;
    const paths = [...e.dataTransfer.files].map((f) => window.tk.pathForFile(f)).filter(Boolean);
    addFiles(await window.tk.expandPaths(paths));
  });

  restore();
  showMode();
})();
