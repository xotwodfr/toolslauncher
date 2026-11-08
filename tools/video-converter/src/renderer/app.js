'use strict';
(() => {
  const $ = (s) => document.querySelector(s);
  let files = [];          // {path, name, bytes, status, fraction?, speed?, meta?, error?, ...}
  let outDir = null;
  let running = false;
  let batch = [];
  let lastOutputs = [];

  const FORMATS = [['mp4', 'MP4 (H.264 + AAC)  .mp4'], ['webm', 'WebM (VP9 + Opus)  .webm'], ['gif', 'Animated GIF  .gif']];
  const FIELDS = ['#format', '#quality', '#maxHeight', '#fps', '#targetMb', '#audio', '#gifWidth', '#gifFps', '#start', '#end'];

  const fmtBytes = (n) => {
    if (n == null) return '';
    const u = ['B', 'KB', 'MB', 'GB']; let i = 0;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return `${n.toFixed(n < 10 && i ? 1 : 0)} ${u[i]}`;
  };
  const fmtTime = (s) => {
    s = Math.round(s);
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
  };
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

  // ---- saved settings (a convenience only: everything works without storage) ----------------------------------------
  const KEY = 'video-converter.settings.v1';
  function save() {
    try { localStorage.setItem(KEY, JSON.stringify({ fields: Object.fromEntries(FIELDS.map((f) => [f, $(f).value])), stripMeta: $('#stripMeta').checked })); } catch { /* blocked storage */ }
  }
  function restore() {
    let s = {};
    try { s = JSON.parse(localStorage.getItem(KEY)) || {}; } catch { /* ignore */ }
    for (const [sel, v] of Object.entries(s.fields || {})) { if (FIELDS.includes(sel) && typeof v === 'string' && sel !== '#start' && sel !== '#end') $(sel).value = v; }
    $('#stripMeta').checked = !!s.stripMeta;
  }

  // ---- list ------------------------------------------------------------------------------------------------------------
  function addFiles(list) {
    const have = new Set(files.map((f) => f.path));
    const fresh = list.filter((f) => !have.has(f.path)).map((f) => ({ ...f, status: 'ready' }));
    files.push(...fresh);
    render();
    for (const f of fresh) window.vc.probe(f.path).then((r) => { if (r.ok) f.meta = r; else f.error = r.error; render(); });
  }

  function render() {
    const ul = $('#list');
    ul.replaceChildren(...files.map((f, i) => {
      const li = el('li', `item ${f.status}`);
      const main = el('span', 'main');
      const name = el('span', 'name', f.name); name.title = f.path;
      main.append(name);
      if (f.meta) main.append(el('span', 'meta', `${f.meta.width}×${f.meta.height} · ${fmtTime(f.meta.durationSec)}${f.meta.fps ? ` · ${Math.round(f.meta.fps * 10) / 10} fps` : ''} · ${f.meta.codec}${f.meta.hasAudio ? '' : ' · no sound'}`));
      if (f.status === 'working') {
        const p = document.createElement('progress'); p.max = 100; p.value = Math.round((f.fraction || 0) * 100);
        p.setAttribute('aria-label', `Progress for ${f.name}`);
        main.append(p);
      }
      const st = el('span', 'st');
      if (f.error) { st.textContent = f.error; st.classList.add('err-text'); st.title = f.error; }
      else if (f.status === 'working') st.textContent = `${Math.round((f.fraction || 0) * 100)}%${f.speed ? ` · ${f.speed.toFixed(1)}×` : ''}`;
      else if (f.status === 'done') st.textContent = `→ ${fmtBytes(f.outBytes)}`;
      else if (f.status === 'skipped') st.textContent = 'Skipped';
      else if (!f.meta) st.textContent = 'Reading…';
      else st.textContent = 'Ready';
      const size = el('span', 'st', fmtBytes(f.bytes));
      li.append(main, st, size);
      return li;
    }));
    $('#count').textContent = files.length ? `${files.length} file${files.length > 1 ? 's' : ''}` : 'No files';
    $('#clear').hidden = !files.length || running;
    const ready = files.filter((f) => !f.error);
    $('#go').disabled = !ready.length || running;
    $('#go').hidden = running;
    $('#cancel').hidden = !running;
    $('#resetOut').hidden = !outDir;
    $('#outDir').value = outDir || 'Same folder as each video';
    const gif = $('#format').value === 'gif';
    $('#vidOpts').hidden = gif; $('#gifOpts').hidden = !gif;
    const target = $('#targetMb').value.trim() !== '';
    $('#targetNote').hidden = !target; $('#quality').disabled = target;
  }

  function options() {
    return {
      format: $('#format').value, quality: $('#quality').value, maxHeight: Number($('#maxHeight').value), fps: Number($('#fps').value),
      targetMb: $('#targetMb').value.trim(), audio: $('#audio').value, stripMeta: $('#stripMeta').checked,
      gifWidth: Number($('#gifWidth').value), gifFps: Number($('#gifFps').value), start: $('#start').value, end: $('#end').value, outDir,
    };
  }

  // ---- running ---------------------------------------------------------------------------------------------------------------
  const clean = (m) => String(m || '').replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

  async function run() {
    if (running) return;
    batch = files.filter((f) => !f.error);
    if (!batch.length) return;
    batch.forEach((f) => { f.status = 'ready'; f.fraction = 0; });
    running = true; lastOutputs = []; $('#summary').hidden = true; render();
    const s = $('#summary');
    try {
      const res = await window.vc.start(batch.map((f) => f.path), options());
      lastOutputs = res.outputs;
      s.replaceChildren();
      const saved = res.inBytes - res.outBytes;
      s.append(el('div', '', `${res.done} converted${res.failed ? `, ${res.failed} failed` : ''}${res.cancelled ? ' (cancelled)' : ''}.` +
        (res.done ? ` ${fmtBytes(res.inBytes)} → ${fmtBytes(res.outBytes)}${saved > 0 ? ` (saved ${fmtBytes(saved)})` : ''}` : '')));
      if (res.outputs.length) {
        const b = el('button', 'btn small', 'Show in folder');
        b.addEventListener('click', () => window.vc.reveal(lastOutputs[lastOutputs.length - 1]));
        s.append(b);
      }
      s.hidden = false;
    } catch (e) {
      batch.forEach((f) => { if (f.status === 'working') f.status = 'ready'; });
      s.textContent = clean(e.message); s.hidden = false;
    } finally {
      running = false; render();
    }
  }

  window.vc.onProgress((p) => {
    const f = batch[p.index];
    if (!f) return;
    f.status = p.status;
    if (p.fraction != null) f.fraction = p.fraction;
    if (p.speed != null) f.speed = p.speed;
    if (p.status === 'done') f.outBytes = p.outBytes;
    if (p.status === 'error') f.error = p.error;
    render();
  });

  // ---- wiring -----------------------------------------------------------------------------------------------------------------
  const fmt = $('#format');
  for (const [v, label] of FORMATS) { const o = document.createElement('option'); o.value = v; o.textContent = label; fmt.append(o); }
  restore();
  FIELDS.forEach((s) => { $(s).addEventListener('change', () => { render(); save(); }); $(s).addEventListener('input', () => { if (s === '#targetMb') render(); }); });
  $('#stripMeta').addEventListener('change', save);
  $('#addFiles').addEventListener('click', async () => addFiles(await window.vc.pickFiles()));
  $('#addFolder').addEventListener('click', async () => addFiles(await window.vc.pickFolder()));
  $('#clear').addEventListener('click', () => { files = []; $('#summary').hidden = true; render(); });
  $('#go').addEventListener('click', run);
  $('#cancel').addEventListener('click', () => window.vc.cancel());
  $('#pickOut').addEventListener('click', async () => { const d = await window.vc.pickOutputDir(); if (d) { outDir = d; render(); } });
  $('#resetOut').addEventListener('click', () => { outDir = null; render(); });
  $('#drop').addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('#addFiles').click(); } });

  const drop = $('#drop');
  ['dragenter', 'dragover'].forEach((ev) => document.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((ev) => document.addEventListener(ev, (e) => { e.preventDefault(); if (ev === 'drop' || e.target === document.documentElement) drop.classList.remove('over'); }));
  document.addEventListener('drop', async (e) => {
    if (!e.dataTransfer || !e.dataTransfer.files.length) return;
    const paths = [...e.dataTransfer.files].map((f) => window.vc.pathForFile(f)).filter(Boolean);
    addFiles(await window.vc.expandPaths(paths));
  });

  window.vc.encoders().then((r) => {
    if (r.ok) return;
    const w = $('#engineWarn'); w.hidden = false;
    w.textContent = `The video engine (ffmpeg) is missing something it needs (${r.missing.join(', ')}). Conversions may fail. Try reinstalling this tool from the launcher.`;
  });
  render();
})();
