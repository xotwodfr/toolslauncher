'use strict';
(() => {
  const $ = (s) => document.querySelector(s);
  let files = [];            // {path, name, bytes, status, ...}
  let outDir = null;
  let running = false;
  let lastOutputs = [];
  let batch = [];            // indexes into `files` for the running conversion

  const fmtBytes = (n) => {
    if (n == null) return '';
    const u = ['B', 'KB', 'MB', 'GB']; let i = 0;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return `${n.toFixed(n < 10 && i ? 1 : 0)} ${u[i]}`;
  };

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
    $('#qualityRow').hidden = $('#format').value === 'png';
    $('#resizeRow').hidden = !$('#resizeOn').checked;
    $('#resetOut').hidden = !outDir;
    $('#outDir').value = outDir || 'Same folder as each image';
  }

  function options() {
    return {
      format: $('#format').value,
      quality: Number($('#quality').value),
      resize: { enabled: $('#resizeOn').checked, width: $('#rw').value, height: $('#rh').value },
      keepMetadata: $('#keepMeta').checked,
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
  // --- wiring ---
  $('#addFiles').addEventListener('click', async () => addFiles(await window.pc.pickFiles()));
  $('#addFolder').addEventListener('click', async () => addFiles(await window.pc.pickFolder()));
  $('#clear').addEventListener('click', () => { files = []; $('#summary').hidden = true; render(); });
  $('#go').addEventListener('click', run);
  $('#cancel').addEventListener('click', () => window.pc.cancel());
  $('#pickOut').addEventListener('click', async () => { const d = await window.pc.pickOutputDir(); if (d) { outDir = d; render(); } });
  $('#resetOut').addEventListener('click', () => { outDir = null; render(); });
  $('#quality').addEventListener('input', (e) => { $('#qualityOut').textContent = e.target.value; });
  ['#format', '#resizeOn'].forEach((s) => $(s).addEventListener('change', render));
  $('#drop').addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') $('#addFiles').click(); });

  const drop = $('#drop');
  ['dragenter', 'dragover'].forEach((ev) => document.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((ev) => document.addEventListener(ev, (e) => { e.preventDefault(); if (ev === 'drop' || e.target === document.documentElement) drop.classList.remove('over'); }));
  document.addEventListener('drop', async (e) => {
    if (!e.dataTransfer || !e.dataTransfer.files.length) return;
    const paths = [...e.dataTransfer.files].map((f) => window.pc.pathForFile(f)).filter(Boolean);
    addFiles(await window.pc.expandPaths(paths));
  });

  render();
})();
