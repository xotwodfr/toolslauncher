'use strict';
(() => {
  const $ = (s) => document.querySelector(s);
  let files = [];         // {path, name, bytes, scan?, error?, status, ...}
  let selected = null;    // path of the photo whose details are shown
  let outDir = null;
  let running = false;
  let batch = [];
  let lastOutputs = [];

  const SHORT = { gps: 'Location', camera: 'Camera', serial: 'Serial no.', owner: 'Names', datetime: 'Date taken', software: 'Software',
    description: 'Notes', thumbnail: 'Thumbnail', makernote: 'Maker data', xmp: 'XMP', iptc: 'IPTC', comment: 'Comment', text: 'Text',
    time: 'Time', trailing: 'Hidden data', other: 'Other', credentials: 'Credentials', exif: 'EXIF' };
  const fmtBytes = (n) => {
    if (n == null) return '';
    const u = ['B', 'KB', 'MB', 'GB']; let i = 0;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return `${n.toFixed(n < 10 && i ? 1 : 0)} ${u[i]}`;
  };
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

  // ---- saved settings (a convenience only) -----------------------------------------------------------------------------
  const KEY = 'photo-privacy.settings.v1';
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify({ keepOrientation: $('#keepOrientation').checked, keepColor: $('#keepColor').checked })); } catch { /* blocked storage */ } };
  try { const s = JSON.parse(localStorage.getItem(KEY)) || {}; if (s.keepOrientation === false) $('#keepOrientation').checked = false; if (s.keepColor === false) $('#keepColor').checked = false; } catch { /* ignore */ }

  // ---- list --------------------------------------------------------------------------------------------------------------
  const needsCleaning = (f) => f.scan && !f.error && f.scan.findings.some((x) => x.level !== 'info');
  const risky = (f) => (f.scan ? f.scan.findings.filter((x) => x.level !== 'info') : []);

  function addFiles(list) {
    const have = new Set(files.map((f) => f.path));
    const fresh = list.filter((f) => !have.has(f.path)).map((f) => ({ ...f, status: 'ready' }));
    files.push(...fresh);
    if (!selected && fresh.length) selected = fresh[0].path;
    render();
    // scan a few at a time so a big folder doesn't flood the main process
    let next = 0;
    const worker = async () => {
      while (next < fresh.length) {
        const f = fresh[next++];
        const r = await window.pp.scan(f.path);
        if (r.ok) f.scan = r; else f.error = r.error;
        render();
      }
    };
    Promise.all([worker(), worker(), worker()]);
  }

  function chipsFor(f) {
    const row = el('span', 'chips-row');
    if (f.error) return row;
    if (!f.scan) return row;
    const seen = new Map();
    for (const x of risky(f)) { const cur = seen.get(x.key); if (!cur || (x.level === 'high')) seen.set(x.key, x.level); }
    if (!seen.size) { row.append(el('span', 'chip ok', 'Nothing hidden')); return row; }
    for (const [key, level] of seen) row.append(el('span', `chip ${level}`, SHORT[key] || key));
    return row;
  }

  function render() {
    const ul = $('#list');
    ul.replaceChildren(...files.map((f) => {
      const li = el('li', `item ${f.status}`);
      li.tabIndex = 0; li.setAttribute('role', 'option'); li.setAttribute('aria-selected', String(f.path === selected)); li.dataset.path = f.path;
      const main = el('span', 'main');
      const name = el('span', 'name', f.name); name.title = f.path;
      main.append(name, chipsFor(f));
      const st = el('span', 'st');
      if (f.error) { st.textContent = f.error; st.classList.add('err-text'); st.title = f.error; }
      else if (f.status === 'working') st.textContent = 'Cleaning…';
      else if (f.status === 'done') st.textContent = `Cleaned (${fmtBytes(f.inBytes)} → ${fmtBytes(f.outBytes)})`;
      else if (f.status === 'skipped') st.textContent = 'Skipped';
      else if (!f.scan) st.textContent = 'Checking…';
      const size = el('span', 'st', fmtBytes(f.bytes));
      li.append(main, st, size);
      const pick = () => { selected = f.path; render(); const again = [...document.querySelectorAll('#list .item')].find((n) => n.dataset.path === f.path); if (again) again.focus(); };
      li.addEventListener('click', pick);
      li.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); }
        else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          const i = files.indexOf(f) + (e.key === 'ArrowDown' ? 1 : -1);
          if (files[i]) { selected = files[i].path; render(); const n = document.querySelectorAll('#list .item')[i]; if (n) n.focus(); }
        }
      });
      return li;
    }));
    const todo = files.filter(needsCleaning).length;
    $('#count').textContent = files.length ? `${files.length} photo${files.length > 1 ? 's' : ''}${files.every((f) => f.scan || f.error) ? ` · ${todo} with hidden data` : ''}` : 'No photos';
    $('#clear').hidden = !files.length || running;
    const go = $('#go');
    go.textContent = todo ? `Clean ${todo} photo${todo > 1 ? 's' : ''}` : 'Clean photos';
    go.disabled = !todo || running;
    go.title = todo ? '' : (files.length ? 'None of these photos has hidden data to remove' : 'Add photos first');
    go.hidden = running;
    $('#cancel').hidden = !running;
    $('#resetOut').hidden = !outDir;
    $('#outDir').value = outDir || 'Next to each photo, as name-clean';
    renderDetails();
  }

  function renderDetails() {
    const box = $('#details');
    const f = files.find((x) => x.path === selected);
    if (!f || (!f.scan && !f.error)) { box.hidden = true; return; }
    box.hidden = false;
    box.replaceChildren();
    box.append(el('h3', '', f.name));
    if (f.error) { box.append(el('p', 'err-text', f.error)); return; }
    const items = f.scan.findings.filter((x) => x.level !== 'info' || x.key === 'credentials');
    if (!items.length) { box.append(el('p', 'muted', 'No hidden data found. This photo is safe to share as it is.')); return; }
    const ul = el('ul');
    for (const x of items) {
      const li = el('li');
      li.append(el('span', `dot ${x.level}`));
      const body = el('span');
      body.append(el('span', 'lab', x.label), el('br'), el('span', 'det', x.detail));
      li.append(body); ul.append(li);
    }
    box.append(ul);
  }

  // ---- running -------------------------------------------------------------------------------------------------------------
  const clean = (m) => String(m || '').replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

  async function run() {
    if (running) return;
    batch = files.filter(needsCleaning);
    if (!batch.length) return;
    batch.forEach((f) => { f.status = 'ready'; });
    running = true; lastOutputs = []; $('#summary').hidden = true; render();
    const s = $('#summary');
    try {
      const res = await window.pp.clean(batch.map((f) => f.path), { outDir, keepColor: $('#keepColor').checked, keepOrientation: $('#keepOrientation').checked });
      lastOutputs = res.outputs;
      s.replaceChildren();
      const saved = res.inBytes - res.outBytes;
      s.append(el('div', '', `${res.done} cleaned${res.failed ? `, ${res.failed} failed` : ''}${res.cancelled ? ' (cancelled)' : ''}.${res.done && saved > 0 ? ` ${fmtBytes(saved)} of hidden data removed.` : ''}`));
      if (res.outputs.length) {
        const b = el('button', 'btn small', 'Show in folder');
        b.addEventListener('click', () => window.pp.reveal(lastOutputs[lastOutputs.length - 1]));
        s.append(b);
      }
      s.hidden = false;
    } catch (e) {
      s.textContent = clean(e.message); s.hidden = false;
    } finally {
      running = false; render();
    }
  }

  window.pp.onProgress((p) => {
    const f = batch[p.index];
    if (!f) return;
    f.status = p.status;
    if (p.status === 'done') { f.inBytes = p.inBytes; f.outBytes = p.outBytes; }
    if (p.status === 'error') f.error = p.error;
    render();
  });

  // ---- wiring -----------------------------------------------------------------------------------------------------------------
  $('#addFiles').addEventListener('click', async () => addFiles(await window.pp.pickFiles()));
  $('#addFolder').addEventListener('click', async () => addFiles(await window.pp.pickFolder()));
  $('#clear').addEventListener('click', () => { files = []; selected = null; $('#summary').hidden = true; render(); });
  $('#go').addEventListener('click', run);
  $('#cancel').addEventListener('click', () => window.pp.cancel());
  $('#pickOut').addEventListener('click', async () => { const d = await window.pp.pickOutputDir(); if (d) { outDir = d; render(); } });
  $('#resetOut').addEventListener('click', () => { outDir = null; render(); });
  $('#keepOrientation').addEventListener('change', save);
  $('#keepColor').addEventListener('change', save);
  $('#drop').addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('#addFiles').click(); } });

  const drop = $('#drop');
  ['dragenter', 'dragover'].forEach((ev) => document.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((ev) => document.addEventListener(ev, (e) => { e.preventDefault(); if (ev === 'drop' || e.target === document.documentElement) drop.classList.remove('over'); }));
  document.addEventListener('drop', async (e) => {
    if (!e.dataTransfer || !e.dataTransfer.files.length) return;
    const paths = [...e.dataTransfer.files].map((f) => window.pp.pathForFile(f)).filter(Boolean);
    addFiles(await window.pp.expandPaths(paths));
  });

  render();
})();
