'use strict';
(() => {
  const P = window.Payload;
  const C = window.Codes;
  const qs = window.qs;
  const $ = (id) => document.getElementById(id);
  const el = (tag, attrs, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) { if (v === false || v == null) continue; if (k === 'class') n.className = v; else n.setAttribute(k, v === true ? '' : v); }
    for (const kid of kids) if (kid != null) n.append(kid);
    return n;
  };

  const LOOK_KEY = 'qrstudio.look';
  const loadLook = () => {
    const d = { tab: 'make', kind: 'url', level: 'M', style: 'square', fg: '#000000', bg: '#ffffff', transparent: false, margin: 4, logoScale: 15, size: 1024, sym: 'ean13', barText: true, barHeight: 22, barFg: '#000000', barBg: '#ffffff', barTransparent: false, barSize: 1200, batchKind: 'qr', fmt: 'png', batchSize: 800, hideWin: true };
    try { return { ...d, ...JSON.parse(localStorage.getItem(LOOK_KEY) || '{}') }; } catch { return d; }
  };
  const S = { look: loadLook(), fields: {}, logo: null, qr: null, bar: null, reading: false, batch: null };
  // what people type (Wi-Fi passwords, contacts) is never stored: only the look and the last tab are remembered
  const saveLook = () => { try { localStorage.setItem(LOOK_KEY, JSON.stringify(S.look)); } catch { /* fine */ } };

  let toastTimer = null;
  function toast(text, err = false) {
    const t = $('toast'); t.textContent = text; t.className = 'toast' + (err ? ' err' : ''); t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 4200);
  }
  const debounce = (fn, ms) => { let t = null; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
  const svgUrl = (svg) => 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);

  // ---- pictures: SVG -> canvas -> PNG / pixels -------------------------------------------------------------------------
  function loadImage(src) {
    return new Promise((resolve, reject) => { const img = new Image(); img.onload = () => resolve(img); img.onerror = () => reject(new Error('The picture could not be drawn')); img.src = src; });
  }
  async function svgCanvas(svg, width, height, white) {
    const img = await loadImage(svgUrl(svg));
    const c = document.createElement('canvas'); c.width = width; c.height = height;
    const g = c.getContext('2d');
    if (white) { g.fillStyle = '#ffffff'; g.fillRect(0, 0, width, height); }
    g.imageSmoothingEnabled = true;
    g.drawImage(img, 0, 0, width, height);
    return c;
  }
  const canvasPng = (c) => new Promise((resolve, reject) => c.toBlob(async (b) => { if (!b) return reject(new Error('Could not make the PNG')); resolve(new Uint8Array(await b.arrayBuffer())); }, 'image/png'));
  const pixelsOf = (c) => { const d = c.getContext('2d').getImageData(0, 0, c.width, c.height); return { width: c.width, height: c.height, data: d.data }; };
  const clampSize = (v, lo, hi, def) => { const n = Math.round(Number(v)); return Number.isFinite(n) && n >= lo && n <= hi ? n : def; };

  // ---- tabs --------------------------------------------------------------------------------------------------------------
  function setTab(t) {
    S.look.tab = t; saveLook();
    for (const b of document.querySelectorAll('.tabs button')) b.setAttribute('aria-selected', String(b.dataset.tab === t));
    for (const id of ['make', 'bar', 'read', 'batch']) $('p-' + id).hidden = id !== t;
    if (t === 'batch') updateBatch();
  }
  for (const b of document.querySelectorAll('.tabs button')) b.addEventListener('click', () => setTab(b.dataset.tab));

  // ====================================================================================================================
  // Make QR
  // ====================================================================================================================
  const KINDS = [
    ['text', 'Text'], ['url', 'Link'], ['wifi', 'Wi-Fi'], ['contact', 'Contact'], ['email', 'Email'], ['sms', 'SMS'], ['phone', 'Phone'], ['geo', 'Location'], ['event', 'Event'],
  ];
  // field: [name, label, type, extra]
  const FORMS = {
    text: [['text', 'Text', 'textarea']],
    url: [['url', 'Web address', 'url', { placeholder: 'example.org/page' }]],
    wifi: [['ssid', 'Network name', 'text'], ['password', 'Password', 'text'], ['security', 'Security', 'select', { options: [['WPA', 'WPA / WPA2 / WPA3'], ['WEP', 'WEP (old)'], ['nopass', 'No password']] }], ['hidden', 'Hidden network', 'checkbox']],
    contact: [['format', 'Format', 'select', { options: [['vcard', 'vCard 3.0 (most phones)'], ['mecard', 'MeCard (shorter code)']] }], ['first', 'First name', 'text', { pair: 1 }], ['last', 'Last name', 'text', { pair: 2 }], ['org', 'Company', 'text', { pair: 1 }], ['title', 'Job title', 'text', { pair: 2 }],
      ['phone', 'Mobile', 'tel', { pair: 1 }], ['workPhone', 'Work phone', 'tel', { pair: 2 }], ['email', 'Email', 'email', { pair: 1 }], ['website', 'Website', 'url', { pair: 2 }], ['street', 'Street', 'text'], ['city', 'City', 'text', { pair: 1 }], ['zip', 'Postcode', 'text', { pair: 2 }], ['country', 'Country', 'text'], ['note', 'Note', 'textarea']],
    email: [['to', 'To', 'email'], ['subject', 'Subject', 'text'], ['body', 'Message', 'textarea']],
    sms: [['number', 'Phone number', 'tel'], ['message', 'Message', 'textarea']],
    phone: [['number', 'Phone number', 'tel', { placeholder: '+1 555 0100' }]],
    geo: [['lat', 'Latitude', 'text', { pair: 1, placeholder: '59.3293' }], ['lng', 'Longitude', 'text', { pair: 2, placeholder: '18.0686' }], ['label', 'Name of the place (optional)', 'text']],
    event: [['title', 'Title', 'text'], ['allDay', 'All day', 'checkbox'], ['start', 'Starts', 'datetime-local', { pair: 1 }], ['end', 'Ends', 'datetime-local', { pair: 2 }], ['location', 'Place', 'text'], ['description', 'Details', 'textarea']],
  };
  function renderKinds() {
    const box = $('kinds'); box.textContent = '';
    for (const [k, label] of KINDS) {
      const b = el('button', { class: 'mode', role: 'radio', 'aria-checked': String(S.look.kind === k), 'data-kind': k }, label);
      b.addEventListener('click', () => { S.look.kind = k; saveLook(); renderKinds(); renderFields(); makeQr(); });
      box.append(b);
    }
  }
  function renderFields() {
    const kind = S.look.kind;
    const vals = S.fields[kind] || (S.fields[kind] = {});
    const box = $('fields'); box.textContent = '';
    let pairRow = null;
    for (const [name, label, type, extra = {}] of FORMS[kind]) {
      let input;
      const id = `f-${name}`;
      if (type === 'textarea') input = el('textarea', { id, rows: name === 'text' ? '6' : '3', spellcheck: 'false' });
      else if (type === 'select') { input = el('select', { id }); for (const [v, t] of extra.options) input.append(el('option', { value: v }, t)); }
      else if (type === 'checkbox') input = el('input', { type: 'checkbox', id });
      else input = el('input', { type: kind === 'event' && vals.allDay && type === 'datetime-local' ? 'date' : type, id, spellcheck: 'false', autocomplete: 'off', placeholder: extra.placeholder || null });
      if (type === 'checkbox') input.checked = !!vals[name];
      else if (vals[name] != null) input.value = vals[name];
      else if (type === 'select') vals[name] = input.value;
      input.addEventListener(type === 'checkbox' || type === 'select' ? 'change' : 'input', () => {
        vals[name] = type === 'checkbox' ? input.checked : input.value;
        if (kind === 'event' && name === 'allDay') { for (const k of ['start', 'end']) if (vals[k]) vals[k] = input.checked ? vals[k].slice(0, 10) : vals[k].slice(0, 10) + 'T09:00'; renderFields(); }
        if (kind === 'wifi' && name === 'security') renderFields();
        makeQrSoon();
      });
      const wrap = type === 'checkbox' ? el('label', { class: 'check' }, input, ' ' + label) : el('label', {}, label, input);
      if (kind === 'wifi' && name === 'password' && vals.security === 'nopass') continue;
      if (extra.pair === 1) { pairRow = el('div', { class: 'pair' }, wrap); box.append(pairRow); }
      else if (extra.pair === 2 && pairRow) { pairRow.append(wrap); pairRow = null; }
      else box.append(wrap);
    }
  }
  function payload() {
    const kind = S.look.kind; const f = S.fields[kind] || {};
    if (kind === 'contact') return P.build(f.format === 'mecard' ? 'mecard' : 'vcard', f);
    return P.build(kind, f);
  }
  function qrLook() {
    return { level: S.look.level, style: S.look.style, fg: S.look.fg, bg: S.look.bg, transparent: S.look.transparent, margin: S.look.margin, logo: !!S.logo, logoScale: S.look.logoScale / 100, size: 512 };
  }
  let qrSeq = 0;
  async function makeQr() {
    const seq = ++qrSeq;
    const b = payload();
    const warn = $('qrWarn'); warn.textContent = '';
    $('qrText').textContent = b.ok ? b.text : '';
    if (!b.ok) { showQr(null); $('qrInfo').textContent = ''; $('qrCheck').textContent = ''; $('qrCheck').className = 'check-line'; if (Object.values(S.fields[S.look.kind] || {}).some((v) => v)) warn.append(el('li', { class: 'err' }, b.error)); else $('qrEmpty').textContent = 'Fill in the form and the code appears here.'; return; }
    const r = await qs.makeQr(b.text, qrLook());
    if (seq !== qrSeq) return;
    if (!r.ok) { showQr(null); warn.append(el('li', { class: 'err' }, r.error)); return; }
    S.qr = { svg: r.svg, text: b.text, version: r.version };
    showQr(r.svg);
    $('qrInfo').textContent = `Version ${r.version} · ${r.modules} × ${r.modules} modules · error correction ${r.level} · ${b.text.length.toLocaleString('en-US')} characters`;
    for (const w of [b.warn, ...r.warnings].filter(Boolean)) warn.append(el('li', {}, w));
    checkQr(seq, r.svg, b.text);
  }
  const makeQrSoon = debounce(makeQr, 140);
  function showQr(svg) {
    $('qrImg').hidden = !svg; $('qrEmpty').hidden = !!svg;
    if (svg) $('qrImg').src = svgUrl(svg);
    for (const id of ['qrPng', 'qrSvg', 'qrCopy']) $(id).disabled = !svg;
    if (!svg) S.qr = null;
  }
  /** read the code back from its own pixels, so a code that does not scan is noticed before it is printed */
  async function checkQr(seq, svg, text) {
    const line = $('qrCheck'); line.className = 'check-line wait'; line.textContent = 'Checking that it scans…';
    try {
      const c = await svgCanvas(svg, 640, 640, true);
      const r = await qs.readPixels(pixelsOf(c));
      if (seq !== qrSeq) return;
      const ok = r.ok && r.results.some((x) => x.text === text);
      line.className = 'check-line ' + (ok ? 'ok' : 'bad');
      line.textContent = ok ? '✓ Checked: it scans and reads back exactly.' : (S.logo ? '✗ This code did not read back. Make the logo smaller or choose a higher error correction level.' : '✗ This code did not read back. Check the colours and the margin.');
      S.qr && (S.qr.checked = ok);
    } catch (e) { line.className = 'check-line bad'; line.textContent = 'Could not check it: ' + (e.message || e); }
  }
  function nameFor(text) {
    const kind = S.look.kind;
    const f = S.fields[kind] || {};
    const base = kind === 'wifi' ? `wifi-${f.ssid || ''}` : kind === 'url' ? String(f.url || '').replace(/^https?:\/\//, '').replace(/[/?#].*$/, '') : kind === 'contact' ? `contact-${[f.first, f.last].filter(Boolean).join(' ')}` : kind === 'event' ? `event-${f.title || ''}` : `qr-${kind}`;
    return (base || 'qr-code').slice(0, 50) || text.slice(0, 20);
  }
  $('qrPng').addEventListener('click', async () => {
    if (!S.qr) return;
    const size = clampSize($('qrSize').value, 64, 8000, 1024);
    try { const png = await canvasPng(await svgCanvas(S.qr.svg, size, size, false)); const r = await qs.save(png, 'png', nameFor(S.qr.text)); if (r.ok) toast('Saved ' + r.path); } catch (e) { toast('Could not save: ' + (e.message || e), true); }
  });
  $('qrSvg').addEventListener('click', async () => {
    if (!S.qr) return;
    try { const r = await qs.save(S.qr.svg, 'svg', nameFor(S.qr.text)); if (r.ok) toast('Saved ' + r.path); } catch (e) { toast('Could not save: ' + (e.message || e), true); }
  });
  $('qrCopy').addEventListener('click', async () => {
    if (!S.qr) return;
    const size = clampSize($('qrSize').value, 64, 8000, 1024);
    const png = await canvasPng(await svgCanvas(S.qr.svg, Math.min(size, 2048), Math.min(size, 2048), false));
    const r = await qs.copyPng(png); toast(r.ok ? 'Copied the picture' : r.error, !r.ok);
  });

  // look options
  const lvl = $('level'); lvl.value = S.look.level;
  lvl.addEventListener('change', () => { S.look.level = lvl.value; saveLook(); makeQr(); });
  const mg = $('margin'); mg.value = S.look.margin;
  mg.addEventListener('input', () => { S.look.margin = clampSize(mg.value, 0, 20, 4); saveLook(); makeQrSoon(); });
  for (const b of document.querySelectorAll('[data-style]')) {
    b.setAttribute('aria-checked', String(b.dataset.style === S.look.style));
    b.addEventListener('click', () => { S.look.style = b.dataset.style; saveLook(); for (const x of document.querySelectorAll('[data-style]')) x.setAttribute('aria-checked', String(x === b)); makeQr(); });
  }
  for (const [id, key] of [['fg', 'fg'], ['bg', 'bg']]) { const i = $(id); i.value = S.look[key]; i.addEventListener('input', () => { S.look[key] = i.value; saveLook(); makeQrSoon(); }); }
  const tr = $('transparent'); tr.checked = S.look.transparent; tr.addEventListener('change', () => { S.look.transparent = tr.checked; saveLook(); makeQr(); });
  const ls = $('logoScale'); ls.value = S.look.logoScale;
  const showLogoSize = () => { $('logoSizeVal').textContent = `${ls.value} % of the code`; };
  ls.addEventListener('input', () => { S.look.logoScale = clampSize(ls.value, 5, 20, 15); showLogoSize(); saveLook(); makeQrSoon(); });
  showLogoSize();
  const qsz = $('qrSize'); qsz.value = S.look.size; qsz.addEventListener('change', () => { S.look.size = clampSize(qsz.value, 64, 8000, 1024); qsz.value = S.look.size; saveLook(); });
  function renderLogo() {
    const on = !!S.logo;
    $('logoPrev').hidden = !on; $('logoClear').hidden = !on; $('logoSizeRow').hidden = !on;
    $('logoName').textContent = on ? S.logo.name : '';
    if (on) $('logoPrev').src = S.logo.preview;
    lvl.disabled = on; lvl.title = on ? 'A logo needs level H, so it is used automatically' : '';
    if (on) lvl.value = 'H'; else lvl.value = S.look.level;
  }
  $('logoPick').addEventListener('click', async () => {
    const r = await qs.pickLogo();
    if (!r.ok) { if (!r.cancelled) toast(r.error, true); return; }
    S.logo = { name: r.name, preview: r.preview }; renderLogo(); makeQr();
  });
  $('logoClear').addEventListener('click', async () => { await qs.clearLogo(); S.logo = null; renderLogo(); makeQr(); });

  // ====================================================================================================================
  // Barcodes
  // ====================================================================================================================
  const sym = $('sym'); sym.value = S.look.sym;
  let barSeq = 0;
  function barLook() { return { showText: S.look.barText, height: S.look.barHeight, fg: S.look.barFg, bg: S.look.barBg, transparent: S.look.barTransparent, check: $('barCheck').checked }; }
  async function makeBar() {
    const seq = ++barSeq;
    const kind = sym.value;
    $('barHint').textContent = C.SYMBOLOGIES[kind].hint;
    $('barCheckRow').hidden = !(kind === 'code39' || kind === 'itf');
    const st = $('barStatus'); const warn = $('barWarn'); warn.textContent = '';
    const r = await qs.makeBar(kind, $('barValue').value, barLook());
    if (seq !== barSeq) return;
    if (!r.ok) {
      st.textContent = r.error; st.className = 'small err';
      showBar(null); $('barCheckLine').textContent = ''; return;
    }
    st.textContent = (r.note ? r.note + ' ' : '') + `Encodes ${r.encoded}`; st.className = 'small ok';
    S.bar = { svg: r.svg, encoded: r.encoded, kind, w: r.width, h: r.height };
    showBar(r.svg);
    for (const w of r.warnings) warn.append(el('li', {}, w));
    const line = $('barCheckLine'); line.className = 'check-line wait'; line.textContent = 'Checking that it scans…';
    try {
      const W = 900; const H = Math.max(40, Math.round((W * r.height) / r.width));
      const c = await svgCanvas(r.svg, W, H, true);
      const res = await qs.readPixels(pixelsOf(c));
      if (seq !== barSeq) return;
      const ok = res.ok && res.results.some((x) => x.text === r.encoded);
      line.className = 'check-line ' + (ok ? 'ok' : 'bad');
      line.textContent = ok ? '✓ Checked: it scans and reads back exactly.' : '✗ This barcode did not read back. Check the colours.';
    } catch (e) { line.className = 'check-line bad'; line.textContent = 'Could not check it: ' + (e.message || e); }
  }
  const makeBarSoon = debounce(makeBar, 140);
  function showBar(svg) {
    $('barImg').hidden = !svg; $('barEmpty').hidden = !!svg;
    if (svg) $('barImg').src = svgUrl(svg);
    for (const id of ['barPng', 'barSvgBtn', 'barCopy']) $(id).disabled = !svg;
    if (!svg) S.bar = null;
  }
  const EXAMPLES = { ean13: '590123412345', ean8: '9638507', upca: '03600029145', code128: 'BOX-2026-0042', code39: 'PART-7731', itf: '12345678' };
  sym.addEventListener('change', () => { S.look.sym = sym.value; saveLook(); const v = $('barValue'); if (!v.value || Object.values(EXAMPLES).includes(v.value)) v.value = EXAMPLES[sym.value]; const h = $('barHeight'); if (['ean13', 'ean8', 'upca'].includes(sym.value) && S.look.barHeight === 15) { S.look.barHeight = 22; h.value = 22; } makeBar(); });
  $('barValue').addEventListener('input', makeBarSoon);
  $('barCheck').addEventListener('change', makeBar);
  const bt = $('barText'); bt.checked = S.look.barText; bt.addEventListener('change', () => { S.look.barText = bt.checked; saveLook(); makeBar(); });
  const bh = $('barHeight'); bh.value = S.look.barHeight; bh.addEventListener('input', () => { S.look.barHeight = clampSize(bh.value, 5, 60, 22); saveLook(); makeBarSoon(); });
  for (const [id, key] of [['barFg', 'barFg'], ['barBg', 'barBg']]) { const i = $(id); i.value = S.look[key]; i.addEventListener('input', () => { S.look[key] = i.value; saveLook(); makeBarSoon(); }); }
  const btr = $('barTransparent'); btr.checked = S.look.barTransparent; btr.addEventListener('change', () => { S.look.barTransparent = btr.checked; saveLook(); makeBar(); });
  const bsz = $('barSize'); bsz.value = S.look.barSize; bsz.addEventListener('change', () => { S.look.barSize = clampSize(bsz.value, 64, 8000, 1200); bsz.value = S.look.barSize; saveLook(); });
  const barPngData = async () => { const W = clampSize($('barSize').value, 64, 8000, 1200); const H = Math.max(16, Math.round((W * S.bar.h) / S.bar.w)); return canvasPng(await svgCanvas(S.bar.svg, W, H, false)); };
  const barName = () => `${S.bar.kind}-${S.bar.encoded}`;
  $('barPng').addEventListener('click', async () => { if (!S.bar) return; try { const r = await qs.save(await barPngData(), 'png', barName()); if (r.ok) toast('Saved ' + r.path); } catch (e) { toast('Could not save: ' + (e.message || e), true); } });
  $('barSvgBtn').addEventListener('click', async () => { if (!S.bar) return; try { const r = await qs.save(S.bar.svg, 'svg', barName()); if (r.ok) toast('Saved ' + r.path); } catch (e) { toast('Could not save: ' + (e.message || e), true); } });
  $('barCopy').addEventListener('click', async () => { if (!S.bar) return; const r = await qs.copyPng(await barPngData()); toast(r.ok ? 'Copied the picture' : r.error, !r.ok); });

  // ====================================================================================================================
  // Read
  // ====================================================================================================================
  const MAX_SIDE = 6000;
  /** any picture (a Blob) -> canvas with its pixels (big pictures are scaled down to 6000 px) */
  async function blobCanvas(blob) {
    let src;
    try { src = await createImageBitmap(blob); }
    catch {
      const url = URL.createObjectURL(blob);
      try { src = await loadImage(url); } catch { throw new Error('That file is not a picture this app can open.'); } finally { setTimeout(() => URL.revokeObjectURL(url), 1000); }
    }
    const w0 = src.width; const h0 = src.height;
    if (!(w0 > 0 && h0 > 0)) throw new Error('That picture is empty.');
    const k = Math.min(1, MAX_SIDE / Math.max(w0, h0));
    const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(w0 * k)); c.height = Math.max(1, Math.round(h0 * k));
    const g = c.getContext('2d'); g.fillStyle = '#ffffff'; g.fillRect(0, 0, c.width, c.height); g.drawImage(src, 0, 0, c.width, c.height);
    if (src.close) src.close();
    return c;
  }
  async function readBlob(blob, name) {
    if (S.reading) return;
    S.reading = true; setTab('read');
    $('readStatus').textContent = 'Reading…';
    try {
      const c = await blobCanvas(blob);
      const r = await qs.readPixels(pixelsOf(c));
      if (!r.ok) throw new Error(r.error);
      showRead(c, r.results, name);
    } catch (e) { $('readStatus').textContent = ''; toast(e.message || String(e), true); }
    finally { S.reading = false; }
  }
  const COLORS = ['#b8f2e6', '#ff9f6e', '#c58cff', '#f2d15c', '#5fc9f8', '#ff6f91'];
  function showRead(src, results, name) {
    S.read = { src, results };
    const cv = $('readCanvas'); cv.hidden = false; $('readEmpty').hidden = true;
    const stage = $('readDrop').getBoundingClientRect();
    const k = Math.min(1, (stage.width - 20) / src.width, (stage.height - 20) / src.height);
    cv.width = Math.max(1, Math.round(src.width * k)); cv.height = Math.max(1, Math.round(src.height * k));
    const g = cv.getContext('2d');
    g.drawImage(src, 0, 0, cv.width, cv.height);
    results.forEach((r, i) => {
      const p = r.position; const pts = [p.topLeft, p.topRight, p.bottomRight, p.bottomLeft].map((q) => [q.x * k, q.y * k]);
      const col = COLORS[i % COLORS.length];
      g.lineWidth = Math.max(3, Math.round(cv.width / 260)); g.strokeStyle = col; g.lineJoin = 'round';
      g.beginPath(); pts.forEach(([x, y], j) => (j ? g.lineTo(x, y) : g.moveTo(x, y))); g.closePath(); g.stroke();
      const [lx, ly] = pts.reduce((a, b) => (b[1] < a[1] || (b[1] === a[1] && b[0] < a[0]) ? b : a));
      g.fillStyle = col; g.fillRect(lx - 1, Math.max(0, ly - 22), 22, 22);
      g.fillStyle = '#06231d'; g.font = 'bold 13px ui-monospace, Consolas, monospace'; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(String(i + 1), lx + 10, Math.max(0, ly - 22) + 11);
    });
    cv.setAttribute('aria-label', `${name || 'The picture'}: ${results.length} code${results.length === 1 ? '' : 's'} found`);
    $('readStatus').textContent = results.length ? `${results.length} code${results.length === 1 ? '' : 's'} found${name ? ' in ' + name : ''}` : `No code found${name ? ' in ' + name : ''}`;
    renderResults(results);
  }
  function renderResults(results) {
    const list = $('readList'); list.textContent = '';
    if (!results.length) { list.append(el('div', { class: 'empty-res' }, 'No QR code or barcode was found. Try a sharper or closer picture, with the whole code in it and some white space around it.')); return; }
    results.forEach((r, i) => {
      const p = r.parsed;
      const num = el('span', { class: 'num' }, String(i + 1)); num.style.background = COLORS[i % COLORS.length];
      const dl = el('dl');
      for (const f of p.fields) {
        const copy = f.copy ? el('button', { class: 'btn small copy', 'aria-label': `Copy ${f.label}` }, 'Copy') : el('span');
        if (f.copy) copy.addEventListener('click', async () => { const res = await qs.copyText(f.value); toast(res.ok ? `${f.label} copied` : 'Nothing to copy', !res.ok); });
        dl.append(el('dt', {}, f.label), el('dd', { 'data-field': f.label }, f.value), copy);
      }
      const acts = el('div', { class: 'acts' });
      const all = el('button', { class: 'btn small' }, 'Copy all text');
      all.addEventListener('click', async () => { await qs.copyText(r.text); toast('Copied'); });
      acts.append(all);
      if (p.url) {
        const open = el('button', { class: 'btn small', title: 'Asks first; the link is not opened by itself' }, 'Open link…');
        open.addEventListener('click', async () => { const res = await qs.openLink(p.url); if (!res.ok && !res.cancelled) toast(res.error, true); });
        acts.append(open);
      }
      const card = el('div', { class: 'item code', 'data-kind': p.kind },
        el('div', { class: 'head' }, num, el('span', { class: 'kind' }, p.title), el('span', { class: 'fmt muted small' }, r.label)), dl, acts);
      if (p.insecure) card.insertBefore(el('div', { class: 'insecure' }, 'This link is not secure (http).'), acts);
      list.append(card);
    });
  }
  $('readOpen').addEventListener('click', async () => {
    const r = await qs.openPicture();
    if (!r.ok) { if (!r.cancelled) toast(r.error, true); return; }
    readBlob(new Blob([r.bytes], { type: /\.svg$/i.test(r.name) ? 'image/svg+xml' : '' }), r.name);
  });
  $('readDrop').addEventListener('click', (e) => { if (!S.read && e.target.closest('#readDrop')) $('readOpen').click(); });
  $('readDrop').addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('readOpen').click(); } });
  $('readPaste').addEventListener('click', async () => {
    const r = await qs.clipboardImage();
    if (!r.ok) { toast(r.error, true); return; }
    readBlob(new Blob([r.png], { type: 'image/png' }), 'the pasted picture');
  });
  const hw = $('hideWin'); hw.checked = S.look.hideWin; hw.addEventListener('change', () => { S.look.hideWin = hw.checked; saveLook(); });
  $('readScreen').addEventListener('click', async () => {
    if (S.reading) return;
    S.reading = true; $('readStatus').textContent = 'Capturing the screen…';
    try {
      const r = await qs.readScreen(hw.checked);
      if (!r.ok) throw new Error(r.error);
      // the screen with the most codes (the first one when none has any)
      const best = r.shots.reduce((a, b) => (b.results.length > a.results.length ? b : a));
      const c = await blobCanvas(new Blob([best.png], { type: 'image/png' }));
      const k = c.width / best.width;
      const results = best.results.map((x) => ({ ...x, position: Object.fromEntries(Object.entries(x.position).map(([key, v]) => [key, { x: v.x * k, y: v.y * k }])) }));
      showRead(c, results, r.shots.length > 1 ? `the screen "${best.name}"` : 'the screen');
    } catch (e) { $('readStatus').textContent = ''; toast(e.message || String(e), true); }
    finally { S.reading = false; }
  });
  document.addEventListener('paste', (e) => {
    if (e.target && /INPUT|TEXTAREA/.test(e.target.tagName)) return;
    const items = [...((e.clipboardData && e.clipboardData.items) || [])];
    const it = items.find((x) => x.kind === 'file' && /^image\//.test(x.type));
    if (!it) { if (S.look.tab === 'read') toast('There is no picture on the clipboard.', true); return; }
    e.preventDefault();
    readBlob(it.getAsFile(), 'the pasted picture');
  });
  let depth = 0;
  window.addEventListener('dragenter', (e) => { e.preventDefault(); depth++; document.body.classList.add('dragging'); });
  window.addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; document.body.classList.remove('dragging'); } });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    e.preventDefault(); depth = 0; document.body.classList.remove('dragging');
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (!f) return;
    if (S.look.tab === 'batch' && /\.(csv|txt|tsv)$/i.test(f.name)) { f.text().then((t) => { $('batchText').value = t.replace(/^﻿/, ''); updateBatch(); }); return; }
    readBlob(f, f.name);
  });
  new ResizeObserver(debounce(() => { if (S.read && !$('p-read').hidden) showRead(S.read.src, S.read.results, null); }, 150)).observe($('readDrop'));

  // ====================================================================================================================
  // Batch
  // ====================================================================================================================
  /** lines of a list or CSV -> [{ value, name }] (a CSV's first column is the content, the second the file name) */
  function parseList(text) {
    const rows = [];
    const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
    const csv = lines.some((l) => /^"|","|",|,"/.test(l)) || (lines.filter(Boolean).length > 1 && lines.filter(Boolean).every((l) => (l.match(/,/g) || []).length === 1 && !/^https?:/i.test(l)));
    for (const line of lines) {
      if (!line.trim()) continue;
      if (!csv) { rows.push({ value: line.trim(), name: '' }); continue; }
      const cells = []; let cur = ''; let q = false;
      for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (q) { if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; }
        else if (ch === '"') q = true; else if (ch === ',' || ch === '\t' || ch === ';') { cells.push(cur); cur = ''; } else cur += ch;
      }
      cells.push(cur);
      if (cells[0].trim()) rows.push({ value: cells[0].trim(), name: (cells[1] || '').trim() });
    }
    return rows;
  }
  function updateBatch() {
    const rows = parseList($('batchText').value);
    $('batchCount').textContent = rows.length ? `${rows.length} code${rows.length === 1 ? '' : 's'}` : '';
    $('batchGo').disabled = !rows.length || !S.batchDir || !!S.batch;
    $('batchGo').textContent = rows.length ? `Make ${rows.length} code${rows.length === 1 ? '' : 's'}` : 'Make codes';
  }
  $('batchText').addEventListener('input', debounce(updateBatch, 150));
  $('batchOpen').addEventListener('click', async () => { const r = await qs.batchList(); if (!r.ok) { if (!r.cancelled) toast(r.error, true); return; } $('batchText').value = r.text; updateBatch(); });
  $('batchDir').addEventListener('click', async () => { const d = await qs.batchDir(); if (d) { S.batchDir = d; $('batchDirName').textContent = d; $('batchDirName').title = d; } updateBatch(); });
  const bk = $('batchKind'); bk.value = S.look.batchKind; bk.addEventListener('change', () => { S.look.batchKind = bk.value; saveLook(); });
  for (const b of document.querySelectorAll('[data-fmt]')) {
    b.setAttribute('aria-checked', String(b.dataset.fmt === S.look.fmt));
    b.addEventListener('click', () => { S.look.fmt = b.dataset.fmt; saveLook(); for (const x of document.querySelectorAll('[data-fmt]')) x.setAttribute('aria-checked', String(x === b)); });
  }
  const bs = $('batchSize'); bs.value = S.look.batchSize; bs.addEventListener('change', () => { S.look.batchSize = clampSize(bs.value, 64, 8000, 800); bs.value = S.look.batchSize; saveLook(); });
  $('batchCancel').addEventListener('click', () => { if (S.batch) S.batch.cancel = true; });
  $('batchGo').addEventListener('click', async () => {
    const rows = parseList($('batchText').value);
    if (!rows.length || !S.batchDir || S.batch) return;
    const kind = bk.value; const fmt = S.look.fmt; const size = clampSize(bs.value, 64, 8000, 800);
    S.batch = { cancel: false };
    const errs = $('batchErrors'); errs.textContent = '';
    $('batchResult').hidden = true; $('batchCancel').hidden = false; $('batchProg').hidden = false; updateBatch();
    let made = 0; let failed = 0; let files = 0;
    for (let i = 0; i < rows.length; i++) {
      if (S.batch.cancel) break;
      const { value, name } = rows[i];
      try {
        let svg; let w; let h; let base;
        if (kind === 'qr') {
          const r = await qs.makeQr(value, { ...qrLook(), logo: !!S.logo });
          if (!r.ok) throw new Error(r.error);
          svg = r.svg; w = size; h = size; base = name || value.replace(/^https?:\/\//i, '').slice(0, 40);
        } else {
          const r = await qs.makeBar(kind, value, { ...barLook(), check: false });
          if (!r.ok) throw new Error(r.error);
          svg = r.svg; w = size; h = Math.max(16, Math.round((size * r.height) / r.width)); base = name || r.encoded;
        }
        base = `${String(i + 1).padStart(String(rows.length).length, '0')} ${base}`;
        if (fmt !== 'png') { const r = await qs.batchWrite({ name: base, ext: 'svg', data: svg }); if (!r.ok) throw new Error(r.error); files++; }
        if (fmt !== 'svg') { const png = await canvasPng(await svgCanvas(svg, w, h, false)); const r = await qs.batchWrite({ name: base, ext: 'png', data: png }); if (!r.ok) throw new Error(r.error); files++; }
        made++;
      } catch (e) {
        failed++;
        if (errs.children.length < 200) errs.append(el('li', { class: 'err' }, `Line ${i + 1} ("${value.slice(0, 40)}"): ${e.message || e}`));
      }
      const pct = ((i + 1) / rows.length) * 100;
      $('batchProg').firstElementChild.style.width = pct + '%'; $('batchProg').setAttribute('aria-valuenow', String(Math.round(pct)));
    }
    const cancelled = S.batch.cancel;
    S.batch = null;
    $('batchCancel').hidden = true; $('batchProg').hidden = true;
    const res = $('batchResult'); res.textContent = ''; res.hidden = false;
    res.className = 'result ' + (failed ? 'err' : 'ok');
    res.append(`${cancelled ? 'Stopped. ' : ''}Made ${made} code${made === 1 ? '' : 's'} (${files} file${files === 1 ? '' : 's'})${failed ? `, ${failed} could not be made (see below)` : ''}.`);
    const show = el('button', { class: 'btn small' }, 'Open the folder');
    show.addEventListener('click', () => qs.batchShow());
    if (files) res.append(show);
    updateBatch();
  });

  // ---- start ---------------------------------------------------------------------------------------------------------------
  if (!S.fields.url) S.fields.url = { url: '' };
  renderKinds(); renderFields(); renderLogo();
  setTab(S.look.tab || 'make');
  makeQr(); makeBar();
  window.__app = { S, makeQr, makeBar, setTab, parseList, readBlob, payload, renderFields, svgCanvas, pixelsOf };
})();
