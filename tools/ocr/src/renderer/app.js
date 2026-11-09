'use strict';
(function () {
  const $ = (id) => document.getElementById(id);
  const Prep = window.Prep;
  const Tidy = window.Tidy;
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

  const S = {
    items: [], cur: -1, nextUid: 1,
    opts: { lang: 'eng', lang2: '', psm: 'auto', enlarge: true, enhance: true, boxes: true },
    languages: [],
    busy: false, cancelled: false,
    zoom: 1, fit: true, sel: null,           // sel = { x, y, w, h } in picture pixels
    bitmap: null, bitmapOf: null,
  };
  const cur = () => S.items[S.cur] || null;

  // ---- helpers ------------------------------------------------------------------------------------------------------------
  let toastTimer = null;
  function toast(message, isErr) {
    const t = $('toast');
    t.textContent = message; t.className = 'toast' + (isErr ? ' err' : ''); t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, isErr ? 6000 : 3000);
  }
  const num = (n) => Number(n).toLocaleString();
  const typing = (t) => t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT');

  let saveTimer = null;
  function saveSoon() { clearTimeout(saveTimer); saveTimer = setTimeout(() => { window.ocr.setSettings(S.opts).catch(() => {}); }, 300); }

  // ---- pictures: loading, thumbnails -----------------------------------------------------------------------------------------------
  async function blobOf(item) {
    if (item.blob) return item.blob;
    const resp = await fetch(`ocr://f/${item.id}`);
    if (!resp.ok) throw new Error('The picture cannot be read any more');
    return resp.blob();
  }
  /** Decode a picture (the browser applies the camera's rotation, and reads WebP, AVIF, GIF, BMP...). */
  async function decode(item) {
    const bmp = await createImageBitmap(await blobOf(item));
    item.w = bmp.width; item.h = bmp.height;
    return bmp;
  }
  async function thumbOf(bmp) {
    const c = document.createElement('canvas');
    const f = Math.min(96 / bmp.width, 72 / bmp.height, 1);
    c.width = Math.max(1, Math.round(bmp.width * f)); c.height = Math.max(1, Math.round(bmp.height * f));
    const g = c.getContext('2d');
    g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
    g.drawImage(bmp, 0, 0, c.width, c.height);
    return c.toDataURL('image/png');
  }

  async function addItems(list) {
    const bad = list.filter((f) => f.ok === false);
    if (bad.length) toast(bad.length === 1 ? `${bad[0].name}: ${bad[0].error}` : `${bad.length} pictures could not be added`, true);
    const good = list.filter((f) => f.ok !== false);
    let added = 0;
    for (const f of good) {
      const item = { uid: S.nextUid++, kind: f.blob ? 'pasted' : 'file', id: f.id, blob: f.blob || null, name: f.name, path: f.path || '', size: f.size || (f.blob ? f.blob.size : 0), status: 'new', text: '', raw: '', words: [], conf: 0, region: null, thumb: '' };
      try {
        const bmp = await decode(item);
        item.thumb = await thumbOf(bmp);
        if (S.cur < 0 && !added) { S.bitmap = bmp; S.bitmapOf = item; } else bmp.close();
      } catch (e) { toast(`${f.name}: this picture cannot be opened (${e.message || e})`, true); continue; }
      S.items.push(item); added++;
    }
    if (!added) return;
    if (S.cur < 0) { S.cur = 0; S.fit = true; }
    refresh();
    if (cur() && S.bitmapOf !== cur()) await showCurrent();
    else { draw(); }
  }

  async function pasteImage() {
    const bytes = await window.ocr.clipboardImage();
    if (!bytes) { toast('There is no picture on the clipboard. Copy a picture or take a screenshot first.', true); return; }
    const n = S.items.filter((i) => i.kind === 'pasted').length + 1;
    const blob = new Blob([bytes], { type: 'image/png' });
    await addItems([{ blob, name: `Pasted picture ${n}` }]);
    S.cur = S.items.length - 1;
    await showCurrent();
    refresh();
  }

  async function addFiles() { const list = await window.ocr.pickFiles(); if (list.length) await addItems(list); }

  function removeItem(i) {
    if (S.busy) return;
    const [it] = S.items.splice(i, 1);
    if (it && it.id) window.ocr.forget(it.id);
    if (S.cur === i) { S.cur = Math.min(i, S.items.length - 1); S.sel = null; showCurrent(); }
    else if (S.cur > i) S.cur--;
    refresh();
  }
  function removeAll() { if (S.busy) return; for (const it of S.items) if (it.id) window.ocr.forget(it.id); S.items = []; S.cur = -1; S.sel = null; showCurrent(); refresh(); }

  async function selectItem(i, byKeyboard) {
    if (i === S.cur || i < 0 || i >= S.items.length || S.busy) return;
    S.cur = i; S.sel = null; S.fit = true;
    await showCurrent();
    refresh();
    if (!byKeyboard && document.activeElement && document.activeElement.blur) document.activeElement.blur();
  }

  async function showCurrent() {
    const it = cur();
    if (S.bitmap && S.bitmapOf !== it) { S.bitmap.close(); S.bitmap = null; S.bitmapOf = null; }
    if (it && !S.bitmap) {
      try { S.bitmap = await decode(it); S.bitmapOf = it; } catch (e) { toast(`This picture cannot be shown: ${e.message || e}`, true); }
    }
    fillText();
    draw();
  }

  // ---- the picture view ------------------------------------------------------------------------------------------------------------------
  const canvas = $('canvas');
  function fitZoom() {
    const v = $('view');
    const it = cur();
    if (!it || !S.bitmap) return 1;
    return Math.min(4, Math.max(0.02, Math.min((v.clientWidth - 4) / it.w, (v.clientHeight - 4) / it.h)));
  }
  function draw() {
    const it = cur();
    const g = canvas.getContext('2d');
    if (!it || !S.bitmap || S.bitmapOf !== it) { canvas.width = 1; canvas.height = 1; return; }
    if (S.fit) S.zoom = fitZoom();
    S.zoom = Math.max(0.02, Math.min(8, S.zoom));
    const z = Math.min(S.zoom, 8000 / Math.max(it.w, it.h));
    canvas.width = Math.max(1, Math.round(it.w * z)); canvas.height = Math.max(1, Math.round(it.h * z));
    canvas.style.width = `${canvas.width}px`; canvas.style.height = `${canvas.height}px`;
    g.fillStyle = '#fff'; g.fillRect(0, 0, canvas.width, canvas.height);
    g.imageSmoothingQuality = 'high';
    g.drawImage(S.bitmap, 0, 0, canvas.width, canvas.height);
    const k = canvas.width / it.w;
    if (S.opts.boxes && it.status === 'done') drawWords(g, it, k);
    if (S.sel) {
      g.fillStyle = 'rgba(157,134,245,.18)'; g.fillRect(S.sel.x * k, S.sel.y * k, S.sel.w * k, S.sel.h * k);
      g.setLineDash([6, 4]); g.lineWidth = 2; g.strokeStyle = '#9d86f5'; g.strokeRect(S.sel.x * k, S.sel.y * k, S.sel.w * k, S.sel.h * k); g.setLineDash([]);
    }
  }
  function drawWords(g, it, k) {
    g.lineWidth = 1.5;
    for (const w of it.words) {
      g.strokeStyle = w.c >= 80 ? '#4cc37f' : w.c >= 60 ? '#f0b429' : '#ff6b6b';
      g.strokeRect(w.x * k, w.y * k, w.w * k, w.h * k);
    }
  }

  let drag = null;
  const toImage = (e) => { const r = canvas.getBoundingClientRect(); const it = cur(); return { x: ((e.clientX - r.left) / r.width) * it.w, y: ((e.clientY - r.top) / r.height) * it.h }; };
  canvas.addEventListener('pointerdown', (e) => { if (!cur() || e.button !== 0 || S.busy) return; canvas.setPointerCapture(e.pointerId); drag = { start: toImage(e), moved: false }; });
  canvas.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const p = toImage(e);
    if (!drag.moved && Math.hypot(p.x - drag.start.x, p.y - drag.start.y) * (canvas.width / cur().w) < 4) return;
    drag.moved = true;
    S.sel = { x: drag.start.x, y: drag.start.y, w: p.x - drag.start.x, h: p.y - drag.start.y };
    draw();
  });
  canvas.addEventListener('pointerup', (e) => {
    if (!drag) return;
    const d = drag; drag = null;
    try { canvas.releasePointerCapture(e.pointerId); } catch { /* not captured */ }
    const it = cur();
    S.sel = d.moved ? Prep.clampRegion(S.sel, it.w, it.h) : null;
    draw(); refresh(false);
  });
  $('zoomIn').addEventListener('click', () => { S.fit = false; S.zoom *= 1.5; draw(); });
  $('zoomOut').addEventListener('click', () => { S.fit = false; S.zoom /= 1.5; draw(); });
  $('zoomFit').addEventListener('click', () => { S.fit = true; draw(); });
  $('view').addEventListener('wheel', (e) => { if (!e.ctrlKey || !cur()) return; e.preventDefault(); S.fit = false; S.zoom *= e.deltaY < 0 ? 1.15 : 1 / 1.15; draw(); }, { passive: false });
  new ResizeObserver(() => { if (S.fit) draw(); }).observe($('view'));
  $('boxes').addEventListener('change', (e) => { S.opts.boxes = e.target.checked; saveSoon(); draw(); });
  $('clearSel').addEventListener('click', () => { S.sel = null; draw(); refresh(false); });

  // ---- reading ---------------------------------------------------------------------------------------------------------------------------
  /** Make the PNG that is sent to the reader: the chosen part, enlarged if small, evened out. */
  async function makePng(item, bmp, region) {
    const reg = Prep.clampRegion(region, item.w, item.h) || { x: 0, y: 0, w: item.w, h: item.h };
    const scale = Prep.scaleFor(reg.w, reg.h, S.opts.enlarge);
    const cv = document.createElement('canvas');
    cv.width = Math.max(1, Math.round(reg.w * scale)); cv.height = Math.max(1, Math.round(reg.h * scale));
    const g = cv.getContext('2d', { willReadFrequently: true });
    g.fillStyle = '#fff'; g.fillRect(0, 0, cv.width, cv.height);
    g.imageSmoothingQuality = 'high';
    g.drawImage(bmp, reg.x, reg.y, reg.w, reg.h, 0, 0, cv.width, cv.height);
    if (S.opts.enhance) { const id = g.getImageData(0, 0, cv.width, cv.height); Prep.enhance(id.data, { invert: 'auto' }); g.putImageData(id, 0, 0); }
    const blob = await new Promise((r) => cv.toBlob(r, 'image/png'));
    return { bytes: await blob.arrayBuffer(), scale: cv.width / reg.w, ox: reg.x, oy: reg.y, region: Prep.clampRegion(region, item.w, item.h) };
  }

  async function readItem(item, region) {
    item.status = 'reading'; item.error = '';
    refresh(false);
    let bmp = S.bitmapOf === item ? S.bitmap : null;
    const temp = !bmp;
    try {
      if (!bmp) bmp = await decode(item);
      const png = await makePng(item, bmp, region);
      const r = await window.ocr.run(png.bytes, { lang: S.opts.lang, lang2: S.opts.lang2, psm: S.opts.psm, scale: png.scale, ox: png.ox, oy: png.oy });
      if (r.cancelled) { item.status = item.raw ? 'done' : 'new'; return false; }
      if (!r.ok) { item.status = 'error'; item.error = r.error || 'The text could not be read'; return false; }
      item.raw = Tidy.clean(r.text); item.text = item.raw; item.words = r.words; item.lines = r.lines; item.conf = r.confidence; item.region = png.region; item.status = 'done';
      return true;
    } catch (e) {
      item.status = 'error'; item.error = e.message || String(e);
      return false;
    } finally { if (temp && bmp) bmp.close(); }
  }

  function setBusy(on) {
    S.busy = on;
    $('progress').hidden = !on; $('bar').style.width = '0%';
    $('cancel').hidden = !on; $('read').hidden = on;
    refresh();
  }
  window.ocr.onProgress((p) => { if (S.busy) $('bar').style.width = `${Math.round(p.fraction * 100)}%`; });

  async function readCurrent(region) {
    const it = cur();
    if (!it || S.busy) return;
    S.cancelled = false; setBusy(true);
    const ok = await readItem(it, region);
    setBusy(false);
    if (ok) { if (region) { S.sel = null; } fillText(); draw(); announce(it); }
    else if (it.status === 'error') toast(it.error, true);
    refresh();
  }

  async function readAll() {
    if (S.busy) return;
    S.cancelled = false; setBusy(true);
    let done = 0;
    for (const it of S.items) {
      if (S.cancelled) break;
      if (it.status === 'done') continue;
      if (await readItem(it)) done++;
      if (it === cur()) { fillText(); draw(); }
      refresh(false);
    }
    setBusy(false);
    toast(S.cancelled ? 'Stopped.' : `Read ${done} picture${done === 1 ? '' : 's'}.`);
    refresh();
  }

  function announce(it) {
    const hint = $('hint');
    const low = it.words.filter((w) => w.c < 60).length;
    hint.hidden = !(it.status === 'done' && (!it.words.length || it.conf < 70 || low > 0));
    if (!it.words.length) hint.textContent = 'No text was found. Try the right language, a sharper picture, or draw a box around just the text.';
    else if (it.conf < 70) hint.textContent = 'The reading is not very sure. A larger or sharper picture, the right language, or a box around just the text can help.';
    else if (low > 0) hint.textContent = `${num(low)} word${low === 1 ? '' : 's'} in red on the picture may be misread.`;
  }

  $('read').addEventListener('click', () => readCurrent(null));
  $('readSel').addEventListener('click', () => { if (S.sel) readCurrent(S.sel); });
  $('readAll').addEventListener('click', readAll);
  $('cancel').addEventListener('click', () => { S.cancelled = true; window.ocr.cancel(); });

  // ---- the text ----------------------------------------------------------------------------------------------------------------------------
  function fillText() {
    const it = cur();
    const ta = $('text');
    ta.value = it ? it.text : '';
    $('hint').hidden = true;
    if (it && it.status === 'done') announce(it);
    updateStats();
  }
  function updateStats() {
    const it = cur();
    const s = Tidy.stats($('text').value);
    $('stats').textContent = it && it.status === 'done' ? `${num(s.words)} words · ${num(s.lines)} lines${it.conf ? ` · ${it.conf}% sure` : ''}${it.region ? ' · part of the picture' : ''}` : '';
    $('copy').disabled = !$('text').value.trim();
    $('save').disabled = !$('text').value.trim();
    $('join').disabled = !$('text').value.trim();
    $('reset').disabled = !it || it.status !== 'done' || it.text === it.raw;
  }
  $('text').addEventListener('input', () => { const it = cur(); if (it) { it.text = $('text').value; } updateStats(); refresh(false); });

  async function copyText(text, what) {
    await window.ocr.copyText(text);
    toast(what);
  }
  $('copy').addEventListener('click', () => copyText($('text').value, 'Copied.'));
  $('join').addEventListener('click', () => { const it = cur(); if (!it) return; it.text = Tidy.joinLines($('text').value); $('text').value = it.text; updateStats(); });
  $('reset').addEventListener('click', () => { const it = cur(); if (!it) return; it.text = it.raw; fillText(); });

  function showResult(kind, lines, file) {
    const box = $('result');
    box.hidden = false; box.className = `result ${kind}`; box.textContent = '';
    box.append(el('strong', null, lines[0]));
    if (lines[1]) box.append(el('span', 'path', lines[1]));
    if (file) { const b = el('button', 'btn small', 'Show in folder'); b.type = 'button'; b.addEventListener('click', () => window.ocr.reveal(file)); box.append(b); }
  }

  $('save').addEventListener('click', async () => {
    const it = cur();
    if (!it) return;
    const r = await window.ocr.saveText(it.name, $('text').value, it.path ? it.path.replace(/[\\/][^\\/]*$/, '') : '');
    if (r) showResult('ok', ['Saved', r.path], r.path);
  });

  function readyItems() { return S.items.filter((i) => i.status === 'done' && i.text.trim()); }
  $('copyAll').addEventListener('click', () => {
    const list = readyItems();
    if (!list.length) return;
    const text = list.length === 1 ? list[0].text : list.map((i) => `--- ${i.name} ---\n${i.text}`).join('\n\n');
    copyText(text, `Copied the text of ${list.length} picture${list.length === 1 ? '' : 's'}.`);
  });
  $('saveAll').addEventListener('click', async () => {
    const list = readyItems();
    if (!list.length) return;
    const r = await window.ocr.saveAll(list.map((i) => ({ name: i.name, text: i.text })));
    if (r) showResult('ok', [`Saved ${r.files.length} text file${r.files.length === 1 ? '' : 's'}`, r.dir], r.files[0]);
  });

  // ---- the page ----------------------------------------------------------------------------------------------------------------------------------
  function renderList() {
    const ol = $('list');
    ol.textContent = '';
    S.items.forEach((it, i) => {
      const li = el('li', 'item' + (i === S.cur ? ' current' : ''));
      const pick = el('button', 'pick'); pick.type = 'button'; pick.title = it.path || it.name;
      if (i === S.cur) pick.setAttribute('aria-current', 'true');
      const img = document.createElement('img'); img.alt = ''; img.src = it.thumb;
      const txt = el('span');
      txt.style.minWidth = '0'; txt.style.display = 'flex'; txt.style.flexDirection = 'column';
      txt.append(el('span', 'name', it.name));
      const meta = el('span', 'meta');
      if (it.status === 'reading') { meta.className = 'meta work'; meta.textContent = 'Reading…'; }
      else if (it.status === 'done') { meta.className = 'meta ok'; meta.textContent = `${num(Tidy.stats(it.text).words)} words${it.conf ? ` · ${it.conf}%` : ''}`; }
      else if (it.status === 'error') { meta.className = 'meta err'; meta.textContent = it.error || 'Could not be read'; }
      else meta.textContent = `${num(it.w)} × ${num(it.h)}`;
      txt.append(meta);
      pick.append(img, txt);
      pick.addEventListener('click', (e) => selectItem(i, e.detail === 0));
      const x = el('button', 'x', '✕'); x.type = 'button'; x.setAttribute('aria-label', `Remove ${it.name}`); x.disabled = S.busy; x.addEventListener('click', () => removeItem(i));
      li.append(pick, x); ol.append(li);
    });
    $('count').textContent = S.items.length ? `${S.items.length} picture${S.items.length === 1 ? '' : 's'}` : 'No pictures';
  }

  function refresh(full = true) {
    const it = cur();
    const has = S.items.length > 0;
    $('empty').hidden = has; $('viewer').hidden = !has;
    if (full) renderList();
    if (it) {
      $('fname').textContent = it.name; $('fname').title = it.path || it.name;
      $('finfo').textContent = `${num(it.w)} × ${num(it.h)} px${it.size ? ` · ${it.size >= 1048576 ? (it.size / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(it.size / 1024)) + ' KB'}` : ''}`;
    }
    $('read').disabled = !it || S.busy;
    $('readSel').disabled = !it || !S.sel || S.busy;
    $('clearSel').disabled = !S.sel;
    $('clear').hidden = S.items.length < 2; $('clear').disabled = S.busy;
    const unread = S.items.filter((i) => i.status !== 'done').length;
    $('readAll').hidden = S.items.length < 2; $('readAll').disabled = S.busy || !unread;
    $('copyAll').hidden = !readyItems().length || S.items.length < 2;
    $('saveAll').hidden = !readyItems().length;
    $('addFiles').disabled = S.busy; $('paste').disabled = S.busy;
    for (const id of ['lang', 'lang2', 'psm', 'enlarge', 'enhance']) $(id).disabled = S.busy;
    updateStats();
  }

  // ---- settings controls ---------------------------------------------------------------------------------------------------------------------------
  function fillLanguages(selectedLang) {
    const a = $('lang'); const b = $('lang2');
    a.textContent = ''; b.textContent = '';
    for (const l of S.languages) a.append(new Option(l.name, l.code));
    b.append(new Option('(nothing else)', ''));
    for (const l of S.languages) if (l.code !== S.opts.lang) b.append(new Option(l.name, l.code));
    a.value = S.opts.lang; b.value = S.opts.lang2;
    void selectedLang;
  }
  $('lang').addEventListener('change', () => { S.opts.lang = $('lang').value; if (S.opts.lang2 === S.opts.lang) S.opts.lang2 = ''; fillLanguages(); saveSoon(); });
  $('lang2').addEventListener('change', () => { S.opts.lang2 = $('lang2').value; saveSoon(); });
  $('psm').addEventListener('change', () => { S.opts.psm = $('psm').value; saveSoon(); });
  $('enlarge').addEventListener('change', () => { S.opts.enlarge = $('enlarge').checked; saveSoon(); });
  $('enhance').addEventListener('change', () => { S.opts.enhance = $('enhance').checked; saveSoon(); });

  $('addFiles').addEventListener('click', addFiles);
  $('addFiles2').addEventListener('click', addFiles);
  $('paste').addEventListener('click', pasteImage);
  $('paste2').addEventListener('click', pasteImage);
  $('clear').addEventListener('click', removeAll);

  // drag and drop (files with a path go through the main process, pictures dragged from a web page are used as they are)
  const drop = $('drop');
  const dragging = (e) => e.dataTransfer && [...e.dataTransfer.types].includes('Files');
  window.addEventListener('dragover', (e) => { if (dragging(e)) { e.preventDefault(); drop.classList.add('over'); } });
  window.addEventListener('dragleave', (e) => { if (!e.relatedTarget) drop.classList.remove('over'); });
  window.addEventListener('drop', async (e) => {
    if (!dragging(e)) return;
    e.preventDefault(); drop.classList.remove('over');
    if (S.busy) return;
    const withPath = []; const blobs = [];
    for (const f of e.dataTransfer.files) { const p = window.ocr.pathForFile(f); if (p) withPath.push(p); else if (/^image\//.test(f.type)) blobs.push({ blob: f, name: f.name || 'Dropped picture' }); }
    const list = withPath.length ? await window.ocr.openPaths(withPath) : [];
    if (!list.length && !blobs.length) { toast('No pictures found in what you dropped', true); return; }
    await addItems([...list, ...blobs]);
  });
  drop.addEventListener('keydown', (e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target === drop) { e.preventDefault(); addFiles(); } });
  drop.addEventListener('click', (e) => { if (e.target === drop || e.target.tagName === 'STRONG' || e.target.tagName === 'SPAN') addFiles(); });
  window.ocr.onOpened((list) => addItems(list));

  // paste a picture with Ctrl+V (but leave text pasting in the text box alone)
  window.addEventListener('paste', (e) => {
    if (typing(e.target) && e.clipboardData && e.clipboardData.getData('text')) return;
    e.preventDefault();
    if (!S.busy) pasteImage();
  });
  window.addEventListener('keydown', (e) => {
    const ctrl = e.ctrlKey || e.metaKey;
    if (ctrl && e.key.toLowerCase() === 'o') { e.preventDefault(); addFiles(); return; }
    if (ctrl && e.key === 'Enter') { e.preventDefault(); if (S.sel) readCurrent(S.sel); else readCurrent(null); return; }
    if (typing(e.target) || ctrl) return;
    if (e.key === '+' || e.key === '=') { S.fit = false; S.zoom *= 1.5; draw(); }
    else if (e.key === '-' || e.key === '_') { S.fit = false; S.zoom /= 1.5; draw(); }
    else if (e.key === 'Escape' && S.sel) { S.sel = null; draw(); refresh(false); }
  });

  // ---- start ---------------------------------------------------------------------------------------------------------------------------------------------
  window.ocr.getSettings().then(({ settings, languages, locale }) => {
    S.languages = languages;
    S.opts = { ...S.opts, ...settings };
    if (!S.opts.lang) {
      const map = { en: 'eng', sv: 'swe', de: 'deu', fr: 'fra', es: 'spa', it: 'ita', pt: 'por', nl: 'nld', da: 'dan', nb: 'nor', nn: 'nor', no: 'nor', fi: 'fin', pl: 'pol' };
      const guess = map[String(locale || navigator.language || 'en').toLowerCase().split(/[-_]/)[0]] || 'eng';
      S.opts.lang = languages.some((l) => l.code === guess) ? guess : (languages[0] ? languages[0].code : 'eng');
    }
    fillLanguages();
    $('psm').value = S.opts.psm; $('enlarge').checked = S.opts.enlarge; $('enhance').checked = S.opts.enhance; $('boxes').checked = S.opts.boxes;
    refresh();
  }).catch(() => refresh());
  refresh();

  if (location.hash === '#e2e') window.__app = { S, addItems, readCurrent, readAll, readItem, draw, selectItem, fillText, refresh, pasteImage, makePng };
}());
