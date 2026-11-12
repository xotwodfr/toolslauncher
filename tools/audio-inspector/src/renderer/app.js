'use strict';
(() => {
  const R = window.Report;
  const $ = (id) => document.getElementById(id);
  const el = (tag, attrs, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) { if (v === false || v == null) continue; if (k === 'class') n.className = v; else n.setAttribute(k, v === true ? '' : v); }
    for (const kid of kids) if (kid != null) n.append(kid);
    return n;
  };

  const S = {
    rows: [],              // { id, name, folder, ext, status: 'waiting'|'working'|'done'|'error'|'cancelled', verdict?, facts?, error?, el }
    sel: null,             // id of the file shown on the right
    detail: null,          // what file:detail returned for it
    running: 0,            // inspect calls in flight
  };
  const byId = (id) => S.rows.find((r) => r.id === id);

  // ---- messages ----------------------------------------------------------------------------------------------------------------
  let toastTimer = null;
  function toast(text, err = false, file = null) {
    const t = $('toast');
    t.textContent = ''; t.append(el('span', null, text));
    if (file) { const b = el('button', { class: 'btn small', type: 'button' }, 'Show in folder'); b.addEventListener('click', () => window.ai.reveal(file)); t.append(b); }
    t.className = 'toast' + (err ? ' err' : ''); t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, file ? 8000 : 4500);
  }

  // ---- the list ----------------------------------------------------------------------------------------------------------------------
  const KIND_ORDER = ['fake', 'upsampled', 'unsure', 'real', 'lossy'];
  const KIND_NAMES = { fake: 'fake lossless', upsampled: 'upsampled', unsure: "can't tell", real: 'real lossless', lossy: 'lossy' };
  function chipFor(r) {
    if (r.status === 'done') return el('span', { class: `chip ${r.verdict.kind}`, title: r.verdict.title }, r.verdict.chip);
    if (r.status === 'error') return el('span', { class: 'chip error', title: r.error }, 'Could not read');
    if (r.status === 'working') return el('span', { class: 'chip working' }, 'Inspecting…');
    if (r.status === 'cancelled') return el('span', { class: 'chip working' }, 'Stopped');
    return el('span', { class: 'chip working' }, 'Waiting');
  }
  function subFor(r) {
    if (r.status === 'error') return r.error;
    if (r.status !== 'done') return r.folder;
    const rate = r.rate ? (r.rate % 1000 ? (r.rate / 1000).toFixed(1) : r.rate / 1000) + ' kHz' : '';
    const bits = r.lossless ? (typeof r.bits === 'string' ? `${parseInt(r.bits, 10)}-bit float` : r.bits ? `${r.bits}-bit` : '') : r.kbps ? `${r.kbps} kbps` : '';
    return [r.format, rate, bits].filter(Boolean).join(' · ');
  }
  function renderRow(r) {
    const sub = el('span', { class: 'sub' }, subFor(r));
    if (r.status === 'done') {
      const marks = r.verdict.flags.filter((f) => f.kind === 'err' || f.code === 'bits').map((f) => ({ clip: 'clipping', damaged: 'damaged', bits: 'really 16-bit' })[f.code]).filter(Boolean);
      if (marks.length) sub.append(' · ', el('span', { class: 'mark' }, marks.join(' · ')));
    }
    const node = el('div', { class: 'item' + (S.sel === r.id ? ' sel' : ''), role: 'option', 'aria-selected': S.sel === r.id ? 'true' : 'false', 'data-id': String(r.id), title: r.folder },
      el('span', { class: 'nm' }, r.name), sub, chipFor(r));
    node.addEventListener('click', () => select(r.id));
    if (r.el) r.el.replaceWith(node);
    r.el = node;
    return node;
  }
  function renderList() {
    const box = $('list'); box.textContent = '';
    const frag = document.createDocumentFragment();
    for (const r of S.rows) frag.append(renderRow(r));
    box.append(frag);
  }
  function syncControls() {
    const has = S.rows.length > 0;
    $('empty').hidden = has; $('work').hidden = !has;
    const done = S.rows.filter((r) => r.status === 'done' || r.status === 'error');
    $('saveCsv').disabled = !done.length; $('saveTxt').disabled = !done.length;
    const pending = S.rows.filter((r) => r.status === 'waiting' || r.status === 'working').length;
    $('progressRow').hidden = !S.running;
    if (S.running) {
      const total = S.rows.length; const finished = total - pending;
      const pct = total ? Math.round((finished / total) * 100) : 0;
      $('fill').style.width = pct + '%'; $('bar').setAttribute('aria-valuenow', String(pct));
      $('progressText').textContent = `${finished} of ${total}`;
    }
    $('clear').disabled = !!S.running;
    // counts per verdict
    const c = $('counts'); c.textContent = '';
    c.append(el('span', { class: 'muted' }, `${S.rows.length} file${S.rows.length === 1 ? '' : 's'}`));
    for (const k of KIND_ORDER) {
      const n = S.rows.filter((r) => r.status === 'done' && r.verdict.kind === k).length;
      if (n) c.append(el('span', { class: `chip ${k}` }, `${n} ${KIND_NAMES[k]}`));
    }
    const bad = S.rows.filter((r) => r.status === 'error').length;
    if (bad) c.append(el('span', { class: 'chip error' }, `${bad} could not be read`));
    const really16 = S.rows.filter((r) => r.status === 'done' && r.verdict.really16).length;
    $('listNote').textContent = really16 ? `${really16} stored as 24-bit but really 16-bit` : '';
  }

  // ---- adding and inspecting ----------------------------------------------------------------------------------------------------------
  async function added(res) {
    if (!res) return;
    if (res.ignored) toast('No audio files were found there', true);
    if (res.capped) toast('The list is full (5000 files). Clear it to add more.', true);
    if (!res.rows || !res.rows.length) return;
    const fresh = res.rows.map((r) => ({ ...r, status: 'waiting' }));
    S.rows.push(...fresh);
    for (const r of fresh) $('list').append(renderRow(r));
    syncControls();
    if (S.sel == null) select(fresh[0].id);
    S.running++; syncControls();
    try { await window.ai.inspect(fresh.map((r) => r.id)); } catch (e) { toast((e && e.message) || String(e), true); }
    S.running--;
    syncControls();
  }
  function onRow(m) {
    const r = byId(m.id);
    if (!r) return;
    r.status = m.status;
    if (m.status === 'done') Object.assign(r, { verdict: m.verdict, facts: m.facts, format: m.format, rate: m.rate, bits: m.bits, kbps: m.kbps, lossless: m.lossless, error: null });
    if (m.status === 'error') r.error = m.error;
    renderRow(r);
    syncControls();
    if (S.sel === r.id && (m.status === 'done' || m.status === 'error')) showDetail(r.id);
  }

  // ---- the detail pane -----------------------------------------------------------------------------------------------------------------------
  function select(id) {
    if (S.sel === id) return;
    S.sel = id;
    for (const r of S.rows) if (r.el) { r.el.classList.toggle('sel', r.id === id); r.el.setAttribute('aria-selected', r.id === id ? 'true' : 'false'); }
    const r = byId(id);
    if (r && r.el) r.el.scrollIntoView({ block: 'nearest' });
    showDetail(id);
  }
  let detailSeq = 0;
  async function showDetail(id) {
    const r = byId(id);
    const seq = ++detailSeq;
    if (!r) { $('detailBody').hidden = true; $('pickNote').hidden = false; return; }
    $('pickNote').hidden = true; $('detailBody').hidden = false;
    $('dName').textContent = r.name; $('dFolder').textContent = r.folder; $('dFolder').title = r.folder;
    const v = $('dVerdict');
    if (r.status !== 'done') {
      v.className = 'verdict'; v.textContent = '';
      v.append(chipFor(r), el('span', { class: 'vt' }, r.status === 'error' ? 'This file could not be inspected' : 'Inspecting…'), el('span', { class: 've' }, r.status === 'error' ? r.error : 'The whole file is being listened to.'));
      $('dFlags').textContent = ''; $('dFacts').textContent = ''; S.detail = null; clearPlots();
      return;
    }
    const d = await window.ai.detail(id);
    if (seq !== detailSeq) return;                 // another file was picked meanwhile
    if (!d.ok) { toast(d.error, true); return; }
    S.detail = d;
    v.className = 'verdict ' + d.verdict.kind; v.textContent = '';
    v.append(el('span', { class: `chip ${d.verdict.kind}` }, d.verdict.chip), el('span', { class: 'vt' }, d.verdict.title), el('span', { class: 've' }, d.verdict.explain));
    const fl = $('dFlags'); fl.textContent = '';
    for (const f of d.verdict.flags) fl.append(el('li', { class: f.kind }, f.text));
    const facts = $('dFacts'); facts.textContent = '';
    for (const [k, val] of d.facts.slice(2)) facts.append(el('div', { class: 'f' }, el('dt', null, k), el('dd', null, val)));
    drawSpectrogram(d); drawSpectrum(d);
  }

  // ---- drawing ------------------------------------------------------------------------------------------------------------------------------
  // a perceptual dark-to-bright colour ramp (black, deep blue, magenta, orange, pale yellow)
  const STOPS = [[0, [5, 5, 9]], [0.18, [28, 16, 68]], [0.38, [107, 25, 112]], [0.58, [196, 52, 82]], [0.76, [246, 115, 38]], [0.9, [252, 191, 73]], [1, [252, 253, 191]]];
  const LUT = (() => {
    const out = new Uint8ClampedArray(256 * 3);
    for (let i = 0; i < 256; i++) {
      const t = i / 255; let k = 0; while (k < STOPS.length - 2 && t > STOPS[k + 1][0]) k++;
      const [t0, c0] = STOPS[k]; const [t1, c1] = STOPS[k + 1]; const u = (t - t0) / (t1 - t0);
      for (let j = 0; j < 3; j++) out[i * 3 + j] = c0[j] + (c1[j] - c0[j]) * u;
    }
    return out;
  })();
  function fitCanvas(c) {
    const ratio = window.devicePixelRatio || 1;
    const w = Math.max(200, Math.round(c.clientWidth * ratio)); const h = Math.max(60, Math.round(c.clientHeight * ratio));
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    const g = c.getContext('2d'); g.setTransform(ratio, 0, 0, ratio, 0, 0);
    return { g, w: c.clientWidth, h: c.clientHeight };
  }
  function clearPlots() { for (const id of ['spectrogram', 'spectrum']) { const { g, w, h } = fitCanvas($(id)); g.clearRect(0, 0, w, h); } }
  const kHzLabel = (hz) => `${(hz / 1000).toFixed(hz % 1000 ? 1 : 0)}k`;
  function freqTicks(nyq) { const step = nyq > 60000 ? 20000 : nyq > 30000 ? 10000 : 4000; const out = []; for (let f = step; f < nyq; f += step) out.push(f); return out; }
  const FONT = '11px ui-monospace, "Cascadia Mono", Consolas, monospace';

  function drawCutoff(g, y, x0, x1, label) {
    g.save(); g.strokeStyle = '#7aa8ff'; g.lineWidth = 1.5; g.setLineDash([6, 4]);
    g.beginPath(); g.moveTo(x0, y); g.lineTo(x1, y); g.stroke(); g.setLineDash([]);
    g.font = '600 ' + FONT; const tw = g.measureText(label).width;
    g.fillStyle = 'rgba(5,5,9,.85)'; g.fillRect(x1 - tw - 14, y - 19, tw + 10, 16);
    g.fillStyle = '#a9c6ff'; g.fillText(label, x1 - tw - 9, y - 7); g.restore();
  }

  function drawSpectrogram(d) {
    const { g, w, h } = fitCanvas($('spectrogram'));
    const sp = d.spectrogram; const left = 46; const bottom = 18; const pw = w - left - 4; const ph = h - bottom - 4;
    g.fillStyle = '#050507'; g.fillRect(0, 0, w, h);
    // the picture: 0..255 is -150..0 dB; shown over the 110 dB below its brightest part
    let top = 0; for (let i = 0; i < sp.data.length; i++) if (sp.data[i] > top) top = sp.data[i];
    const span = (110 / 150) * 255; const lo = top - span;
    const img = new ImageData(sp.cols, sp.rows);
    for (let c = 0; c < sp.cols; c++) {
      for (let r = 0; r < sp.rows; r++) {
        const v = sp.data[c * sp.rows + r];
        const t = Math.max(0, Math.min(255, Math.round(((v - lo) / span) * 255)));
        const o = ((sp.rows - 1 - r) * sp.cols + c) * 4;
        img.data[o] = LUT[t * 3]; img.data[o + 1] = LUT[t * 3 + 1]; img.data[o + 2] = LUT[t * 3 + 2]; img.data[o + 3] = 255;
      }
    }
    const off = document.createElement('canvas'); off.width = sp.cols; off.height = sp.rows; off.getContext('2d').putImageData(img, 0, 0);
    g.imageSmoothingEnabled = true; g.drawImage(off, left, 4, pw, ph);
    // axes
    g.font = FONT; g.fillStyle = '#8e8e98'; g.strokeStyle = 'rgba(255,255,255,.12)'; g.lineWidth = 1;
    const yOf = (f) => 4 + ph - (f / sp.nyquist) * ph;
    for (const f of freqTicks(sp.nyquist)) { const y = Math.round(yOf(f)) + 0.5; g.beginPath(); g.moveTo(left - 4, y); g.lineTo(left, y); g.stroke(); g.fillText(kHzLabel(f), 4, y + 4); }
    g.fillText('Hz', 4, 14);
    const secs = d.seconds || 0; const step = secs > 1200 ? 300 : secs > 400 ? 60 : secs > 120 ? 30 : secs > 40 ? 10 : secs > 10 ? 2 : 1;
    for (let t = step; t < secs; t += step) { const x = left + (t / secs) * pw; g.fillText(R.duration(t), x - 12, h - 4); }
    if (d.verdict.cutoffHz && d.verdict.cutoffHz < sp.nyquist * 0.97) drawCutoff(g, Math.round(yOf(d.verdict.cutoffHz)) + 0.5, left, left + pw, `cutoff ${kHzLabel(d.verdict.cutoffHz)}Hz`);
  }

  function drawSpectrum(d) {
    const { g, w, h } = fitCanvas($('spectrum'));
    const db = d.spectrum.db; const binHz = d.spectrum.binHz; const nyq = d.sampleRate / 2;
    const left = 46; const bottom = 18; const pw = w - left - 4; const ph = h - bottom - 6;
    g.fillStyle = '#050507'; g.fillRect(0, 0, w, h);
    let top = -300; for (let k = 2; k < db.length; k++) if (db[k] > top) top = db[k];
    const hi = Math.ceil(top / 10) * 10 + 5; const lo = hi - 130;
    const yOf = (v) => 6 + ph - ((Math.max(lo, Math.min(hi, v)) - lo) / (hi - lo)) * ph;
    const xOf = (f) => left + (f / nyq) * pw;
    g.font = FONT; g.fillStyle = '#8e8e98'; g.strokeStyle = 'rgba(255,255,255,.08)';
    for (let v = Math.ceil(lo / 30) * 30; v <= hi; v += 30) { const y = Math.round(yOf(v)) + 0.5; g.beginPath(); g.moveTo(left, y); g.lineTo(left + pw, y); g.stroke(); g.fillText(String(v), 6, y + 4); }
    for (const f of freqTicks(nyq)) { const x = Math.round(xOf(f)) + 0.5; g.beginPath(); g.moveTo(x, 6); g.lineTo(x, 6 + ph); g.stroke(); g.fillText(kHzLabel(f), x - 10, h - 4); }
    // one point per pixel column: the mean power of the bins under it
    g.strokeStyle = '#ff6f61'; g.lineWidth = 1.4; g.beginPath();
    const cols = Math.max(2, Math.floor(pw));
    for (let i = 0; i < cols; i++) {
      const k0 = Math.max(1, Math.floor(((i / cols) * nyq) / binHz)); const k1 = Math.max(k0 + 1, Math.floor((((i + 1) / cols) * nyq) / binHz));
      let s = 0; for (let k = k0; k < k1 && k < db.length; k++) s += Math.pow(10, db[k] / 10);
      const v = 10 * Math.log10(s / (k1 - k0) + 1e-30);
      const x = left + i + 0.5; const y = yOf(v);
      if (i) g.lineTo(x, y); else g.moveTo(x, y);
    }
    g.stroke();
    if (d.verdict.cutoffHz && d.verdict.cutoffHz < nyq * 0.97) {
      const x = Math.round(xOf(d.verdict.cutoffHz)) + 0.5;
      g.save(); g.strokeStyle = '#7aa8ff'; g.setLineDash([5, 4]); g.lineWidth = 1.5; g.beginPath(); g.moveTo(x, 6); g.lineTo(x, 6 + ph); g.stroke(); g.restore();
    }
  }

  // ---- wiring ------------------------------------------------------------------------------------------------------------------------------
  const run = (p) => p.then(added, (e) => toast((e && e.message) || String(e), true));
  async function saveReport(kind) {
    const r = await window.ai.saveReport(kind, S.rows.map((x) => x.id));
    if (r.dialogCancelled) return;
    if (!r.ok) { toast(r.error || 'Could not save', true); return; }
    toast(`Saved ${r.path.replace(/^.*[\\/]/, '')} (${r.count} file${r.count === 1 ? '' : 's'})` + (r.backup ? ', the old one kept as .bak' : ''), false, r.path);
  }
  function wire() {
    for (const id of ['addFiles', 'addFiles2']) $(id).addEventListener('click', () => run(window.ai.pickFiles()));
    for (const id of ['addFolder', 'addFolder2']) $(id).addEventListener('click', () => run(window.ai.pickFolder()));
    $('empty').addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); run(window.ai.pickFiles()); } });
    $('cancel').addEventListener('click', () => window.ai.cancel());
    $('clear').addEventListener('click', async () => {
      await window.ai.clear();
      S.rows = []; S.sel = null; S.detail = null; renderList(); syncControls(); showDetail(null);
    });
    $('saveCsv').addEventListener('click', () => saveReport('csv'));
    $('saveTxt').addEventListener('click', () => saveReport('txt'));
    $('list').addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      e.preventDefault();
      const i = S.rows.findIndex((r) => r.id === S.sel);
      const j = Math.max(0, Math.min(S.rows.length - 1, (i < 0 ? 0 : i) + (e.key === 'ArrowDown' ? 1 : -1)));
      if (S.rows[j]) select(S.rows[j].id);
    });
    window.addEventListener('keydown', (e) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 'o') { e.preventDefault(); run(window.ai.pickFiles()); }
      if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); if (!$('saveCsv').disabled) saveReport('csv'); }
    });
    let resizeTimer = null;
    window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { if (S.detail) { drawSpectrogram(S.detail); drawSpectrum(S.detail); } }, 120); });
    let depth = 0;
    window.addEventListener('dragenter', (e) => { e.preventDefault(); depth++; document.body.classList.add('dragging'); });
    window.addEventListener('dragleave', () => { depth = Math.max(0, depth - 1); if (!depth) document.body.classList.remove('dragging'); });
    window.addEventListener('dragover', (e) => e.preventDefault());
    window.addEventListener('drop', (e) => {
      e.preventDefault(); depth = 0; document.body.classList.remove('dragging');
      const paths = [...((e.dataTransfer && e.dataTransfer.files) || [])].map((f) => window.ai.pathForFile(f)).filter(Boolean);
      if (paths.length) run(window.ai.addPaths(paths));
    });
  }

  async function init() {
    wire();
    window.ai.onRow(onRow);
    window.ai.onOpened((r) => added(r));
    syncControls();
    try {
      const e = await window.ai.engine();
      if (!e.ok) { $('engineWarn').textContent = e.problem + '. Run "npm run setup" in the tool folder.'; $('engineWarn').hidden = false; }
    } catch { /* ignore */ }
  }

  window.__app = { S, select, added, showDetail };
  init();
})();
