'use strict';
(() => {
  const $ = (s) => document.querySelector(s);
  // bitrate choices per lossy format (kept in sync with src/convert.js FORMATS)
  const BITRATES = { mp3: [96, 128, 192, 256, 320, 192], m4a: [96, 128, 192, 256, 320, 192], ogg: [96, 128, 192, 256, 320, 192], opus: [64, 96, 128, 160, 192, 128] };

  let files = [];            // {path, name, bytes, status, fraction, outBytes, error}
  let batch = [];            // indexes into `files` for the running conversion
  let outDir = null;
  let running = false;
  let lastOutputs = [];

  const fmtBytes = (n) => { if (n == null) return ''; const u = ['B', 'KB', 'MB', 'GB']; let i = 0; while (n >= 1024 && i < 3) { n /= 1024; i++; } return `${n.toFixed(n < 10 && i ? 1 : 0)} ${u[i]}`; };
  const errText = (e) => String(e && e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

  function fillBitrates() {
    const fmt = $('#format').value;
    const lossy = fmt in BITRATES;
    $('#bitrateRow').hidden = !lossy;
    if (!lossy) return;
    const list = BITRATES[fmt].slice(0, -1), dflt = BITRATES[fmt][BITRATES[fmt].length - 1];
    const prev = Number($('#bitrate').value);
    $('#bitrate').replaceChildren(...list.map((b) => { const o = document.createElement('option'); o.value = b; o.textContent = `${b} kbps`; return o; }));
    $('#bitrate').value = list.includes(prev) ? prev : dflt;
  }

  function addFiles(list) {
    const have = new Set(files.map((f) => f.path));
    for (const f of list) if (!have.has(f.path)) files.push({ ...f, status: 'ready' });
    render();
  }

  function render() {
    $('#list').replaceChildren(...files.map((f) => {
      const li = document.createElement('li'); li.className = 'item ' + f.status;
      const name = document.createElement('span'); name.className = 'name'; name.textContent = f.name; name.title = f.path;
      const size = document.createElement('span'); size.className = 'st'; size.textContent = fmtBytes(f.bytes);
      const st = document.createElement('span'); st.className = 'st';
      st.textContent = { ready: 'Ready', working: `${Math.round((f.fraction || 0) * 100)}%`, done: `→ ${fmtBytes(f.outBytes)}`, error: f.error || 'Failed', skipped: 'Skipped' }[f.status];
      if (f.status === 'error') st.title = f.error;
      const bar = document.createElement('i'); bar.className = 'bar'; bar.style.width = f.status === 'working' ? `${Math.round((f.fraction || 0) * 100)}%` : f.status === 'done' ? '100%' : '0';
      li.append(name, size, st, bar);
      return li;
    }));
    $('#count').textContent = files.length ? `${files.length} file${files.length > 1 ? 's' : ''}` : 'No files';
    $('#clear').hidden = !files.length || running;
    $('#go').disabled = !files.length || running;
    $('#go').hidden = running; $('#cancel').hidden = !running;
    $('#resetOut').hidden = !outDir;
    $('#outDir').value = outDir || 'Same folder as each file';
  }

  const options = () => ({
    format: $('#format').value, bitrate: Number($('#bitrate').value), sampleRate: Number($('#sampleRate').value),
    channels: Number($('#channels').value), keepTags: $('#keepTags').checked, outDir,
  });

  async function run() {
    if (running || !files.length) return;
    let todo = files.map((f, i) => i).filter((i) => files[i].status !== 'done');
    if (!todo.length) todo = files.map((f, i) => i); // everything already done: convert again with the new settings
    todo.forEach((i) => { files[i].status = 'ready'; files[i].fraction = 0; delete files[i].error; });
    batch = todo; running = true; lastOutputs = []; $('#summary').hidden = true; render();
    const s = $('#summary');
    try {
      const res = await window.ac.start(batch.map((i) => files[i].path), options());
      s.hidden = false; s.replaceChildren();
      const line = document.createElement('div');
      const saved = res.inBytes - res.outBytes;
      line.textContent = `${res.done} converted${res.failed ? `, ${res.failed} failed` : ''}${res.cancelled ? ' (cancelled)' : ''}.` +
        (res.done ? ` ${fmtBytes(res.inBytes)} → ${fmtBytes(res.outBytes)}${saved > 0 ? ` (saved ${fmtBytes(saved)})` : ''}` : '');
      s.append(line);
      if (lastOutputs.length) {
        const b = document.createElement('button'); b.className = 'btn small'; b.textContent = 'Show in folder';
        b.addEventListener('click', () => window.ac.reveal(lastOutputs[lastOutputs.length - 1]));
        s.append(b);
      }
    } catch (e) { s.hidden = false; s.textContent = errText(e); }
    finally { running = false; files.forEach((f) => { if (f.status === 'working') f.status = 'ready'; }); render(); }
  }

  window.ac.onProgress((p) => {
    const f = files[batch[p.index]];
    if (!f) return;
    f.status = p.status;
    if (p.fraction != null) f.fraction = p.fraction;
    if (p.status === 'done') { f.outBytes = p.outBytes; lastOutputs.push(p.output); }
    if (p.status === 'error') f.error = p.error;
    render();
  });

  $('#addFiles').addEventListener('click', async () => addFiles(await window.ac.pickFiles()));
  $('#addFolder').addEventListener('click', async () => addFiles(await window.ac.pickFolder()));
  $('#clear').addEventListener('click', () => { files = []; $('#summary').hidden = true; render(); });
  $('#go').addEventListener('click', run);
  $('#cancel').addEventListener('click', () => window.ac.cancel());
  $('#pickOut').addEventListener('click', async () => { const d = await window.ac.pickOutputDir(); if (d) { outDir = d; render(); } });
  $('#resetOut').addEventListener('click', () => { outDir = null; render(); });
  $('#format').addEventListener('change', fillBitrates);
  $('#drop').addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') $('#addFiles').click(); });

  const drop = $('#drop');
  ['dragenter', 'dragover'].forEach((ev) => document.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
  document.addEventListener('dragleave', (e) => { if (e.target === document.documentElement || !e.relatedTarget) drop.classList.remove('over'); });
  document.addEventListener('drop', async (e) => {
    e.preventDefault(); drop.classList.remove('over');
    if (!e.dataTransfer || !e.dataTransfer.files.length) return;
    const paths = [...e.dataTransfer.files].map((f) => window.ac.pathForFile(f)).filter(Boolean);
    addFiles(await window.ac.expandPaths(paths));
  });

  fillBitrates(); render();
  window.ac.ffmpegInfo().then((i) => { if (!i.ok) { $('#banner').hidden = false; $('#go').title = 'ffmpeg unavailable'; } });
})();
