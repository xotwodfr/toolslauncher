'use strict';
(() => {
  const $ = (s) => document.querySelector(s);
  let files = [];            // {path, name, bytes, status, ...}
  let outDir = null;
  let running = false;
  let lastOutputs = [];
  let batch = [];            // indexes into `files` for the running conversion
  let info = null;           // { formats, options } from the main process (single source of truth)
  let values = {};           // current value of every option; options of other formats are remembered too

  const fmtBytes = (n) => {
    if (n == null) return '';
    const u = ['B', 'KB', 'MB', 'GB']; let i = 0;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return `${n.toFixed(n < 10 && i ? 1 : 0)} ${u[i]}`;
  };
  const currentFormat = () => info.formats.find((f) => f.id === $('#format').value);

  // ---- saved settings (a convenience only: everything works without storage) -----------------------------
  const KEY = 'picture-converter.settings.v1';
  function loadSaved() { try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch { return {}; } }
  function save() {
    try {
      localStorage.setItem(KEY, JSON.stringify({
        format: $('#format').value, values, keepMeta: $('#keepMeta').checked,
        resize: { enabled: $('#resizeOn').checked, width: $('#rw').value, height: $('#rh').value },
      }));
    } catch { /* private mode / blocked storage */ }
  }

  // ---- format-specific option controls ------------------------------------------------------------------------
  const el = (tag, props = {}, ...kids) => {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) { if (k === 'class') e.className = v; else if (k in e) e[k] = v; else e.setAttribute(k, v); }
    for (const kid of kids) if (kid != null) e.append(kid);
    return e;
  };

  function control(name, spec) {
    const set = (v) => { values[name] = v; applyVisibility(); save(); };
    if (spec.type === 'range') {
      const out = el('span', { class: 'val', textContent: String(values[name]) });
      const input = el('input', { type: 'range', min: spec.min, max: spec.max, value: values[name] });
      input.addEventListener('input', () => { out.textContent = input.value; set(Number(input.value)); });
      return el('label', {}, el('span', {}, spec.label, out), input);
    }
    if (spec.type === 'bool') {
      const input = el('input', { type: 'checkbox', checked: !!values[name] });
      input.addEventListener('change', () => set(input.checked));
      return el('label', { class: 'check' }, input, spec.label);
    }
    if (spec.type === 'select') {
      const sel = el('select');
      for (const c of spec.choices) sel.append(el('option', { value: String(c), textContent: (spec.labels && spec.labels[c]) || String(c) }));
      sel.value = String(values[name]);
      sel.addEventListener('change', () => set(typeof spec.choices[0] === 'number' ? Number(sel.value) : sel.value));
      return el('label', {}, spec.label, sel);
    }
    if (spec.type === 'multi') {
      const chips = el('div', { class: 'chips' });
      for (const c of spec.choices) {
        const input = el('input', { type: 'checkbox', checked: values[name].includes(c) });
        input.addEventListener('change', () => {
          const next = spec.choices.filter((x) => (x === c ? input.checked : values[name].includes(x)));
          if (!next.length) { input.checked = true; return; } // at least one size
          set(next);
        });
        chips.append(el('label', {}, input, String(c)));
      }
      return el('fieldset', {}, el('legend', {}, spec.label), chips);
    }
    if (spec.type === 'color') {
      const input = el('input', { type: 'color', value: values[name] });
      input.addEventListener('input', () => set(input.value));
      return el('label', {}, spec.label, input);
    }
    return el('span');
  }

  function buildOptions() {
    const f = currentFormat();
    $('#fmtHint').textContent = f.hint;
    $('#metaRow').hidden = !f.meta;
    $('#fmtOptions').replaceChildren(...f.options.map((o) => {
      const wrap = el('div', { class: 'opt' }, control(o.name, info.options[o.name]));
      wrap.dataset.when = JSON.stringify(o.when || {});
      return wrap;
    }));
    applyVisibility();
  }

  function applyVisibility() {
    document.querySelectorAll('#fmtOptions .opt').forEach((w) => {
      const when = JSON.parse(w.dataset.when);
      w.hidden = !Object.entries(when).every(([k, v]) => values[k] === v);
    });
  }

  // ---- file list --------------------------------------------------------------------------------------------------
  function addFiles(list) {
    const have = new Set(files.map((f) => f.path));
    for (const f of list) if (!have.has(f.path)) files.push({ ...f, status: 'ready' });
    render();
  }

  function render() {
    const ul = $('#list');
    ul.replaceChildren(...files.map((f) => {
      const li = document.createElement('li');
      li.className = 'item ' + f.status;
      const name = document.createElement('span'); name.className = 'name'; name.textContent = f.name; name.title = f.path;
      const size = document.createElement('span'); size.className = 'st'; size.textContent = fmtBytes(f.bytes);
      const st = document.createElement('span'); st.className = 'st';
      st.textContent = { ready: 'Ready', working: 'Converting…', done: `→ ${fmtBytes(f.outBytes)} (${f.width}×${f.height})`, error: f.error || 'Failed', skipped: 'Skipped' }[f.status];
      if (f.status === 'error') st.title = f.error;
      li.append(name, size, st);
      return li;
    }));
    $('#count').textContent = files.length ? `${files.length} file${files.length > 1 ? 's' : ''}` : 'No files';
    $('#clear').hidden = !files.length || running;
    const go = $('#go');
    go.setAttribute('aria-disabled', String(!files.length || running));
    go.disabled = !files.length || running;
    go.hidden = running;
    $('#cancel').hidden = !running;
    $('#resizeRow').hidden = !$('#resizeOn').checked;
    $('#resetOut').hidden = !outDir;
    $('#outDir').value = outDir || 'Same folder as each image';
  }

  function options() {
    return {
      ...values,
      format: $('#format').value,
      resize: { enabled: $('#resizeOn').checked, width: $('#rw').value, height: $('#rh').value },
      keepMetadata: $('#keepMeta').checked && currentFormat().meta,
      outDir,
    };
  }

  async function run() {
    if (running || !files.length) return;
    // Only (re)convert files that haven't been done yet
    const todo = files.map((f, i) => ({ f, i })).filter(({ f }) => f.status !== 'done');
    if (!todo.length) { files.forEach((f) => (f.status = 'ready')); todo.push(...files.map((f, i) => ({ f, i }))); }
    todo.forEach(({ f }) => { f.status = 'ready'; delete f.error; });
    running = true; lastOutputs = []; $('#summary').hidden = true; render();
    batch = todo.map((t) => t.i); // progress events index into this batch
    try {
      const res = await window.pc.start(batch.map((i) => files[i].path), options());
      const saved = res.inBytes - res.outBytes;
      const s = $('#summary');
      s.hidden = false;
      s.replaceChildren();
      const line = document.createElement('div');
      line.textContent = `${res.done} converted${res.failed ? `, ${res.failed} failed` : ''}${res.cancelled ? ' (cancelled)' : ''}. ` +
        (res.done ? `${fmtBytes(res.inBytes)} → ${fmtBytes(res.outBytes)}${saved > 0 ? ` (saved ${fmtBytes(saved)})` : ''}` : '');
      s.append(line);
      if (lastOutputs.length) {
        const b = document.createElement('button'); b.className = 'btn small'; b.textContent = 'Show in folder';
        b.addEventListener('click', () => window.pc.reveal(lastOutputs[lastOutputs.length - 1]));
        s.append(b);
      }
    } catch (e) {
      const s = $('#summary'); s.hidden = false; s.textContent = e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
    } finally {
      running = false; render();
    }
  }

  window.pc.onProgress((p) => {
    const f = files[batch[p.index]];
    if (!f) return;
    f.status = p.status;
    if (p.status === 'done') { Object.assign(f, { width: p.width, height: p.height, outBytes: p.outBytes }); lastOutputs.push(p.output); }
    if (p.status === 'error') f.error = p.error;
    render();
  });

  // ---- wiring ----------------------------------------------------------------------------------------------------
  $('#addFiles').addEventListener('click', async () => addFiles(await window.pc.pickFiles()));
  $('#addFolder').addEventListener('click', async () => addFiles(await window.pc.pickFolder()));
  $('#clear').addEventListener('click', () => { files = []; $('#summary').hidden = true; render(); });
  $('#go').addEventListener('click', run);
  $('#cancel').addEventListener('click', () => window.pc.cancel());
  $('#pickOut').addEventListener('click', async () => { const d = await window.pc.pickOutputDir(); if (d) { outDir = d; render(); } });
  $('#resetOut').addEventListener('click', () => { outDir = null; render(); });
  $('#format').addEventListener('change', () => { buildOptions(); save(); });
  ['#resizeOn', '#keepMeta', '#rw', '#rh'].forEach((s) => $(s).addEventListener('change', () => { render(); save(); }));
  $('#drop').addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') $('#addFiles').click(); });

  const drop = $('#drop');
  ['dragenter', 'dragover'].forEach((ev) => document.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((ev) => document.addEventListener(ev, (e) => { e.preventDefault(); if (ev === 'drop' || e.target === document.documentElement) drop.classList.remove('over'); }));
  document.addEventListener('drop', async (e) => {
    if (!e.dataTransfer || !e.dataTransfer.files.length) return;
    const paths = [...e.dataTransfer.files].map((f) => window.pc.pathForFile(f)).filter(Boolean);
    addFiles(await window.pc.expandPaths(paths));
  });

  // ---- start: ask the main process what formats exist, then build the UI from that ------------------------------
  (async () => {
    info = await window.pc.describeFormats();
    const select = $('#format');
    const groups = [...new Set(info.formats.map((f) => f.group))];
    for (const g of groups) {
      const og = document.createElement('optgroup'); og.label = g;
      for (const f of info.formats.filter((x) => x.group === g)) og.append(el('option', { value: f.id, textContent: `${f.label}  (${f.ext})` }));
      select.append(og);
    }
    const saved = loadSaved();
    values = Object.fromEntries(Object.entries(info.options).map(([k, v]) => [k, v.default]));
    for (const [k, v] of Object.entries(saved.values || {})) if (k in values && typeof v === typeof values[k]) values[k] = v;
    select.value = info.formats.some((f) => f.id === saved.format) ? saved.format : 'webp';
    if (saved.keepMeta) $('#keepMeta').checked = true;
    if (saved.resize) { $('#resizeOn').checked = !!saved.resize.enabled; $('#rw').value = saved.resize.width || ''; $('#rh').value = saved.resize.height || ''; }
    buildOptions();
    render();
  })();
})();
