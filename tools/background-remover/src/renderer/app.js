'use strict';
(() => {
  const P = window.Plan;
  const $ = (id) => document.getElementById(id);
  const el = (tag, attrs, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) { if (v === false || v == null) continue; if (k === 'class') n.className = v; else n.setAttribute(k, v === true ? '' : v); }
    for (const kid of kids) if (kid != null) n.append(kid);
    return n;
  };
  const canvas = (w, h) => { const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(w)); c.height = Math.max(1, Math.round(h)); return c; };
  const sleepFrame = () => new Promise((r) => requestAnimationFrame(() => r()));

  // ---- state -----------------------------------------------------------------------------------------------------------
  const S = {
    phase: 'empty',               // empty | working | ready | failed
    img: null,                    // { id, name, size, bitmap, w, h }
    work: null,                   // { w, h, k }  size of the live preview canvases
    raw: null,                    // Float32Array(SIZE*SIZE)  the model's mask, 0..1
    edge: 0,
    strokes: [], redo: [],        // { mode: 'erase'|'restore', size (picture px), pts: [[x, y], ...] in picture px }
    bg: { mode: 'transparent', colour: '#ffffff', blur: 40, pic: null },
    tool: 'off', brush: P.BRUSH.def,
    zoom: { s: 1, ox: 0, oy: 0 }, fit: true,
    showOrig: false, space: false,
    pointer: null,                // css px inside the view, for the brush ring
    lastSave: null,
  };
  const cv = { orig: null, base: null, mask: null, subj: null, blur: null, blurKey: '' };
  const SWATCHES = ['#ffffff', '#f2f2f2', '#111111', '#e5484d', '#f0883e', '#e0a526', '#2f9e6f', '#3b82f6', '#7c5cff'];

  // ---- messages -----------------------------------------------------------------------------------------------------------
  let toastTimer = null;
  function toast(text, err = false) {
    const t = $('toast');
    t.textContent = text; t.className = 'toast' + (err ? ' err' : ''); t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 4200);
  }
  const banner = (text) => { const b = $('banner'); b.textContent = text || ''; b.hidden = !text; };

  // ---- the picture on canvases ----------------------------------------------------------------------------------------------
  function prepareCanvases() {
    S.work = P.workSize(S.img.w, S.img.h);
    cv.orig = canvas(S.work.w, S.work.h);
    const o = cv.orig.getContext('2d');
    o.imageSmoothingQuality = 'high';
    o.drawImage(S.img.bitmap, 0, 0, S.work.w, S.work.h);
    cv.mask = canvas(S.work.w, S.work.h);
    cv.subj = canvas(S.work.w, S.work.h);
    cv.base = canvas(P.SIZE, P.SIZE);
    cv.blur = null; cv.blurKey = '';
  }

  /** The model's mask with the edge control applied, as the alpha of a SIZE x SIZE canvas. */
  function buildBase() {
    const g = P.edgeGamma(S.edge);
    const id = new ImageData(P.SIZE, P.SIZE);
    const a = id.data; const m = S.raw;
    if (g === 1) for (let i = 0, p = 3; i < m.length; i++, p += 4) a[p] = Math.round(m[i] * 255);
    else for (let i = 0, p = 3; i < m.length; i++, p += 4) a[p] = Math.round(Math.pow(m[i], g) * 255);
    cv.base.getContext('2d').putImageData(id, 0, 0);
  }

  function dab(ctx, x, y, r) {
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, 'rgba(0,0,0,1)'); g.addColorStop(0.6, 'rgba(0,0,0,1)'); g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
  }
  /** Paint a stroke (or its newest part, from point index `from`) onto a mask canvas; kc = canvas pixels per picture pixel. */
  function strokePath(ctx, st, kc, from) {
    ctx.save();
    ctx.globalCompositeOperation = st.mode === 'erase' ? 'destination-out' : 'source-over';
    const r = Math.max(0.6, (st.size / 2) * kc);
    const step = Math.max(0.75, r * 0.25);
    const pts = st.pts;
    if (from === 0) dab(ctx, pts[0][0] * kc, pts[0][1] * kc, r);
    for (let i = Math.max(1, from); i < pts.length; i++) {
      const dx = (pts[i][0] - pts[i - 1][0]) * kc; const dy = (pts[i][1] - pts[i - 1][1]) * kc;
      const n = Math.max(1, Math.ceil(Math.hypot(dx, dy) / step));
      for (let j = 1; j <= n; j++) dab(ctx, pts[i - 1][0] * kc + (dx * j) / n, pts[i - 1][1] * kc + (dy * j) / n, r);
    }
    ctx.restore();
  }
  /** The whole mask at canvas size w x h: the model's mask scaled up, then every stroke replayed on top. */
  function buildMask(target, w, h, kc) {
    const ctx = target.getContext('2d');
    ctx.save();
    ctx.globalCompositeOperation = 'source-over';
    ctx.clearRect(0, 0, w, h);
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(cv.base, 0, 0, w, h);
    ctx.restore();
    for (const st of S.strokes) strokePath(ctx, st, kc, 0);
  }
  function composeSubject() {
    const ctx = cv.subj.getContext('2d');
    ctx.save();
    ctx.globalCompositeOperation = 'source-over';
    ctx.clearRect(0, 0, S.work.w, S.work.h);
    ctx.drawImage(cv.orig, 0, 0);
    ctx.globalCompositeOperation = 'destination-in';
    ctx.drawImage(cv.mask, 0, 0);
    ctx.restore();
  }
  function rebuildAll() {
    if (!S.raw) return;
    buildBase();
    buildMask(cv.mask, S.work.w, S.work.h, S.work.k);
    composeSubject();
  }

  /** A blurred copy of a picture (done small and scaled back up: a strong blur on a large canvas would be slow). */
  function blurred(source, w, h) {
    const long = Math.max(w, h);
    const px = P.blurPixels(S.bg.blur, long);
    const f = Math.max(1, Math.floor(long / 700));
    const sw = Math.max(1, Math.round(w / f)); const sh = Math.max(1, Math.round(h / f));
    const small = canvas(sw, sh);
    const sctx = small.getContext('2d');
    const r = px / f;
    const pad = Math.ceil(r * 2);
    sctx.filter = `blur(${r}px)`;
    sctx.drawImage(source, -pad, -pad, sw + 2 * pad, sh + 2 * pad); // drawn a little larger so the edges do not fade out
    sctx.filter = 'none';
    const out = canvas(w, h);
    const octx = out.getContext('2d');
    octx.imageSmoothingQuality = 'high';
    octx.drawImage(small, 0, 0, w, h);
    small.width = 0;
    return out;
  }

  let checker = null;
  function checkerPattern(ctx) {
    if (!checker) {
      const t = canvas(24, 24); const c = t.getContext('2d');
      c.fillStyle = '#d9d9de'; c.fillRect(0, 0, 24, 24);
      c.fillStyle = '#b4b4bb'; c.fillRect(0, 0, 12, 12); c.fillRect(12, 12, 12, 12);
      checker = t;
    }
    return ctx.createPattern(checker, 'repeat');
  }

  /** Paint the chosen background into the box (x, y, w, h) of `ctx`. `source` is the picture at any resolution. */
  function paintBackground(ctx, x, y, w, h, source, srcIsWork) {
    const bg = S.bg;
    if (bg.mode === 'colour') { ctx.fillStyle = bg.colour; ctx.fillRect(x, y, w, h); return; }
    if (bg.mode === 'blur') {
      if (srcIsWork) {
        const key = `${bg.blur}|${S.work.w}x${S.work.h}`;
        if (!cv.blur || cv.blurKey !== key) { cv.blur = blurred(cv.orig, S.work.w, S.work.h); cv.blurKey = key; }
        ctx.drawImage(cv.blur, x, y, w, h);
      } else {
        const b = blurred(source, S.img.w, S.img.h);
        ctx.drawImage(b, x, y, w, h);
        b.width = 0;
      }
      return;
    }
    if (bg.mode === 'picture' && bg.pic) {
      const r = P.coverRect(bg.pic.w, bg.pic.h, w, h);
      ctx.drawImage(bg.pic.bitmap, r.sx, r.sy, r.sw, r.sh, x, y, w, h);
      return;
    }
    ctx.fillStyle = checkerPattern(ctx); ctx.fillRect(x, y, w, h); // transparent (or no picture chosen yet): show the chequerboard
  }

  // ---- the view ---------------------------------------------------------------------------------------------------------------
  let drawQueued = false;
  function scheduleDraw() { if (drawQueued) return; drawQueued = true; requestAnimationFrame(() => { drawQueued = false; drawView(); }); }

  function sizeView() {
    const c = $('view'); const wrap = $('viewwrap');
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(wrap.clientWidth * dpr)); const h = Math.max(1, Math.round(wrap.clientHeight * dpr));
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    if (S.img && S.fit) fitZoom();
  }
  function fitZoom() {
    const wrap = $('viewwrap');
    const f = P.fitView(S.work.w, S.work.h, wrap.clientWidth, wrap.clientHeight, 24);
    S.zoom = f; S.fit = true;
  }
  const fitScale = () => P.fitView(S.work.w, S.work.h, $('viewwrap').clientWidth, $('viewwrap').clientHeight, 24).s;

  function drawView() {
    const c = $('view');
    const ctx = c.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, c.width, c.height);
    if (!S.img) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const { s, ox, oy } = S.zoom;
    const iw = S.work.w * s; const ih = S.work.h * s;
    ctx.save();
    ctx.beginPath(); ctx.rect(ox, oy, iw, ih); ctx.clip();
    ctx.imageSmoothingEnabled = s * dpr < 2.5;            // look at real pixels when zoomed right in
    ctx.imageSmoothingQuality = 'high';
    if (S.showOrig || !S.raw) ctx.drawImage(cv.orig, ox, oy, iw, ih);
    else { paintBackground(ctx, ox, oy, iw, ih, cv.orig, true); ctx.drawImage(cv.subj, ox, oy, iw, ih); }
    ctx.restore();
    ctx.strokeStyle = 'rgba(255,255,255,.18)'; ctx.lineWidth = 1; ctx.strokeRect(ox - 0.5, oy - 0.5, iw + 1, ih + 1);
    if (S.tool !== 'off' && S.pointer && S.raw && !S.showOrig) {
      const r = S.brush / 2;
      ctx.beginPath(); ctx.arc(S.pointer.x, S.pointer.y, r, 0, Math.PI * 2);
      ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(0,0,0,.55)'; ctx.stroke();
      ctx.lineWidth = 1.5; ctx.strokeStyle = S.tool === 'erase' ? '#ff9d9d' : '#9dffcb'; ctx.stroke();
    }
    $('zoomInfo').textContent = S.raw ? `${Math.round(S.zoom.s * S.work.k * 100)}%` : '';
  }

  // picture pixel <-> css pixel in the view
  const toPicture = (x, y) => ({ x: (x - S.zoom.ox) / S.zoom.s / S.work.k, y: (y - S.zoom.oy) / S.zoom.s / S.work.k });
  const fromPicture = (x, y) => ({ x: S.zoom.ox + x * S.work.k * S.zoom.s, y: S.zoom.oy + y * S.work.k * S.zoom.s });

  function zoomAt(mx, my, factor) {
    const fs = fitScale();
    const ns = Math.min(Math.max(S.zoom.s * factor, fs), 16);
    const k = ns / S.zoom.s;
    S.zoom = { s: ns, ox: mx - (mx - S.zoom.ox) * k, oy: my - (my - S.zoom.oy) * k };
    S.fit = Math.abs(ns - fs) < 1e-6;
    if (S.fit) fitZoom();
    scheduleDraw();
  }

  // ---- pointer: brush, pan, zoom ----------------------------------------------------------------------------------------------------
  let drag = null; // { kind: 'stroke', st } | { kind: 'pan', x, y }
  function wireView() {
    const c = $('view');
    const pos = (e) => { const r = c.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
    c.addEventListener('pointerdown', (e) => {
      if (!S.img || !S.raw) return;
      const p = pos(e);
      const wantsBrush = S.tool !== 'off' && e.button === 0 && !S.space && !S.showOrig;
      c.setPointerCapture(e.pointerId);
      if (wantsBrush) {
        const q = toPicture(p.x, p.y);
        const st = { mode: S.tool, size: S.brush / (S.zoom.s * S.work.k), pts: [[q.x, q.y]] };
        S.strokes.push(st); S.redo = [];
        drag = { kind: 'stroke', st };
        strokePath(cv.mask.getContext('2d'), st, S.work.k, 0);
        composeSubject(); updateEditButtons(); scheduleDraw();
      } else if (e.button === 0 || e.button === 1) {
        drag = { kind: 'pan', x: p.x, y: p.y };
        c.classList.add('panning');
      }
      e.preventDefault();
    });
    c.addEventListener('pointermove', (e) => {
      const p = pos(e);
      S.pointer = p;
      if (drag && drag.kind === 'stroke') {
        const q = toPicture(p.x, p.y);
        const last = drag.st.pts[drag.st.pts.length - 1];
        if (Math.hypot(q.x - last[0], q.y - last[1]) * S.work.k * S.zoom.s >= 1) {
          drag.st.pts.push([q.x, q.y]);
          strokePath(cv.mask.getContext('2d'), drag.st, S.work.k, drag.st.pts.length - 1);
          composeSubject();
        }
      } else if (drag && drag.kind === 'pan') {
        S.zoom = { ...S.zoom, ox: S.zoom.ox + (p.x - drag.x), oy: S.zoom.oy + (p.y - drag.y) };
        S.fit = false;
        drag.x = p.x; drag.y = p.y;
      }
      scheduleDraw();
    });
    const end = (e) => {
      if (!drag) return;
      if (drag.kind === 'pan') c.classList.remove('panning');
      drag = null;
      try { c.releasePointerCapture(e.pointerId); } catch { /* already released */ }
      updateEditButtons(); scheduleDraw();
    };
    c.addEventListener('pointerup', end); c.addEventListener('pointercancel', end);
    c.addEventListener('pointerleave', () => { if (!drag) { S.pointer = null; scheduleDraw(); } });
    c.addEventListener('wheel', (e) => {
      if (!S.img) return;
      e.preventDefault();
      const p = pos(e);
      zoomAt(p.x, p.y, Math.exp(-e.deltaY * 0.0016));
    }, { passive: false });
    c.addEventListener('dblclick', () => { if (S.img && S.tool === 'off') { fitZoom(); scheduleDraw(); } });
    new ResizeObserver(() => { sizeView(); scheduleDraw(); }).observe($('viewwrap'));
  }

  // ---- edits -------------------------------------------------------------------------------------------------------------------------
  function updateEditButtons() {
    $('undo').disabled = S.strokes.length === 0;
    $('redo').disabled = S.redo.length === 0;
    $('resetEdits').disabled = S.strokes.length === 0;
  }
  function undo() { if (!S.strokes.length) return; S.redo.push(S.strokes.pop()); rebuildAll(); updateEditButtons(); scheduleDraw(); }
  function redo() {
    if (!S.redo.length) return;
    const st = S.redo.pop(); S.strokes.push(st);
    strokePath(cv.mask.getContext('2d'), st, S.work.k, 0); composeSubject(); updateEditButtons(); scheduleDraw();
  }
  function resetEdits() { S.strokes = []; S.redo = []; rebuildAll(); updateEditButtons(); scheduleDraw(); }

  function setTool(t) {
    S.tool = t;
    $('view').classList.toggle('brush', t !== 'off');
    document.getElementById('tool-' + t).checked = true;
    scheduleDraw();
  }

  function syncFormat() {
    const sel = $('format');
    const transparent = S.bg.mode === 'transparent' || (S.bg.mode === 'picture' && !S.bg.pic);
    for (const o of sel.options) if (o.value === 'jpeg') o.disabled = transparent;
    if (transparent && sel.value === 'jpeg') sel.value = 'png';
  }
  function setBackground(mode) {
    S.bg.mode = mode;
    $('optColour').hidden = mode !== 'colour'; $('optBlur').hidden = mode !== 'blur'; $('optPicture').hidden = mode !== 'picture';
    document.getElementById('bg-' + mode).checked = true;
    syncFormat(); scheduleDraw();
  }

  // ---- the work: open, cut out, save ---------------------------------------------------------------------------------------------------
  function showPhase(phase) {
    S.phase = phase;
    $('empty').hidden = phase !== 'empty';
    $('work').hidden = phase === 'empty';
    const ready = phase === 'ready';
    for (const id of ['bgSet', 'edgeSet', 'toolSet', 'saveSet']) $(id).disabled = !ready;
    $('open').disabled = phase === 'working';
    $('busy').hidden = ready;
    if (ready) $('busy').hidden = true;
  }
  function busyMessage(text, { cancel = true, retry = false, indeterminate = true } = {}) {
    $('busy').hidden = false;
    $('busyText').textContent = text;
    $('busyBar').hidden = !indeterminate;
    $('cancel').hidden = !cancel; $('retry').hidden = !retry;
  }

  async function decode(bytes, name) {
    const blob = new Blob([bytes]);
    try { return await createImageBitmap(blob); }
    catch { throw new Error(`"${name}" could not be opened as a picture. It may be damaged or in a format this window cannot read.`); }
  }

  async function handleOpened(r) {
    if (!r) return;
    if (!r.ok) { toast(r.error || 'Could not open that file', true); return; }
    if (S.strokes.length && !window.confirm('Opening another picture discards the touch-ups you made on this one. Continue?')) return;
    let bitmap;
    try { bitmap = await decode(r.bytes, r.name); } catch (e) { toast(e.message, true); return; }
    if (bitmap.width * bitmap.height > P.MAX_PIXELS) {
      toast(`This picture is ${(bitmap.width * bitmap.height / 1e6).toFixed(0)} megapixels; the limit is ${P.MAX_PIXELS / 1e6}.`, true);
      bitmap.close(); return;
    }
    banner('');
    if (S.img && S.img.bitmap) S.img.bitmap.close();
    S.img = { id: r.id, name: r.name, size: r.size, bitmap, w: bitmap.width, h: bitmap.height };
    S.raw = null; S.strokes = []; S.redo = []; S.edge = 0; S.lastSave = null;
    $('edge').value = '0'; $('edgeVal').textContent = '0';
    $('result').hidden = true;
    updateEditButtons();
    $('fileInfo').textContent = `${r.name} · ${bitmap.width} × ${bitmap.height} · ${P.formatBytes(r.size)}`;
    prepareCanvases();
    showPhase('working');
    await sleepFrame();
    sizeView(); fitZoom(); drawView();
    await runCutout();
  }

  async function runCutout() {
    if (!S.img) return;
    showPhase('working');
    busyMessage('Preparing the picture…');
    await sleepFrame();
    let tensor;
    try {
      const c = canvas(P.SIZE, P.SIZE);
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(S.img.bitmap, 0, 0, P.SIZE, P.SIZE);
      tensor = P.toTensor(ctx.getImageData(0, 0, P.SIZE, P.SIZE).data);
    } catch (e) { fail('The picture could not be prepared: ' + e.message); return; }
    busyMessage('Starting the model…');
    let res;
    try { res = await window.br.cutout(tensor.buffer); } catch (e) { fail('The cutout failed: ' + ((e && e.message) || e)); return; }
    if (res.cancelled) { showPhase('failed'); busyMessage('Cancelled.', { cancel: false, retry: true, indeterminate: false }); return; }
    if (!res.ok) { fail(res.error); return; }
    S.raw = res.mask;
    rebuildAll();
    showPhase('ready');
    syncFormat();
    sizeView(); if (S.fit) fitZoom();
    drawView();
    if (res.flat) toast('No clear subject was found in this picture. Use the Restore brush to bring parts back.', true);
  }
  function fail(message) { showPhase('failed'); busyMessage(message, { cancel: false, retry: true, indeterminate: false }); }

  async function saveCutout() {
    if (!S.img || !S.raw) return;
    const fmtId = $('format').value;
    const fmt = P.FORMATS[fmtId];
    $('save').disabled = true;
    showResult('Building the picture…', '');
    await sleepFrame();
    let bytes;
    try {
      const out = renderFull();
      const blob = await new Promise((resolve) => out.toBlob(resolve, fmt.mime, fmt.quality));
      out.width = 0;
      if (!blob) throw new Error('The picture could not be encoded as ' + fmtId.toUpperCase());
      bytes = new Uint8Array(await blob.arrayBuffer());
    } catch (e) { showResult(e.message || String(e), 'err'); $('save').disabled = false; return; }
    const r = await window.br.save({ id: S.img.id, format: fmtId, bytes });
    $('save').disabled = false;
    if (r.dialogCancelled) { showResult('', ''); return; }
    if (!r.ok) { showResult(r.error || 'Could not save', 'err'); return; }
    S.lastSave = r;
    showResult(`Saved ${P.baseName(r.path)} (${P.formatBytes(r.bytes)})`, 'ok', r.path);
  }

  function showResult(text, kind, file) {
    const box = $('result');
    box.textContent = '';
    box.hidden = !text;
    box.className = 'result' + (kind ? ' ' + kind : '');
    if (!text) return;
    box.append(el('span', null, text));
    if (file) {
      box.append(el('span', { class: 'path', title: file }, file));
      const b = el('button', { class: 'btn small', type: 'button' }, 'Show in folder');
      b.addEventListener('click', () => window.br.reveal(file));
      box.append(b);
    }
  }

  /** The finished picture at the original size: background, then the subject through the full-size mask. */
  function renderFull() {
    const w = S.img.w; const h = S.img.h;
    const out = canvas(w, h);
    const ctx = out.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    if (S.bg.mode !== 'transparent') paintBackground(ctx, 0, 0, w, h, S.img.bitmap, false);
    const subject = canvas(w, h);
    const sctx = subject.getContext('2d');
    sctx.drawImage(S.img.bitmap, 0, 0);
    const mask = canvas(w, h);
    buildMask(mask, w, h, 1);
    sctx.globalCompositeOperation = 'destination-in';
    sctx.drawImage(mask, 0, 0);
    mask.width = 0;
    ctx.drawImage(subject, 0, 0);
    subject.width = 0;
    return out;
  }

  // ---- wiring ---------------------------------------------------------------------------------------------------------------------------
  async function pickImage() { try { await handleOpened(await window.br.pickImage()); } catch (e) { toast((e && e.message) || String(e), true); } }

  function wire() {
    $('open').addEventListener('click', pickImage); $('open2').addEventListener('click', pickImage);
    $('empty').addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pickImage(); } });
    $('cancel').addEventListener('click', () => { window.br.cancel(); });
    $('retry').addEventListener('click', () => runCutout());
    $('fit').addEventListener('click', () => { if (S.img) { fitZoom(); scheduleDraw(); } });
    const holdOn = () => { S.showOrig = true; $('show').setAttribute('aria-pressed', 'true'); scheduleDraw(); };
    const holdOff = () => { S.showOrig = false; $('show').setAttribute('aria-pressed', 'false'); scheduleDraw(); };
    $('show').addEventListener('pointerdown', holdOn);
    window.addEventListener('pointerup', () => { if (S.showOrig && !heldKey) holdOff(); });
    let heldKey = false;

    for (const r of document.querySelectorAll('input[name="bg"]')) r.addEventListener('change', () => { if (r.checked) setBackground(r.value); });
    $('colour').addEventListener('input', (e) => { S.bg.colour = e.target.value; scheduleDraw(); });
    const sw = $('swatches');
    for (const c of SWATCHES) { const b = el('button', { class: 'sw', type: 'button', 'aria-label': `Colour ${c}`, title: c }); b.style.background = c; b.addEventListener('click', () => { S.bg.colour = c; $('colour').value = c; scheduleDraw(); }); sw.append(b); }
    $('blur').addEventListener('input', (e) => { S.bg.blur = Number(e.target.value); $('blurVal').textContent = e.target.value; scheduleDraw(); });
    $('pickBg').addEventListener('click', async () => {
      const r = await window.br.pickBackground();
      if (!r) return;
      if (!r.ok) { toast(r.error, true); return; }
      try {
        const bitmap = await decode(r.bytes, r.name);
        if (S.bg.pic) S.bg.pic.bitmap.close();
        S.bg.pic = { bitmap, w: bitmap.width, h: bitmap.height, name: r.name };
        $('bgName').textContent = r.name; $('bgName').title = r.name;
        syncFormat(); scheduleDraw();
      } catch (e) { toast(e.message, true); }
    });

    let edgeQueued = false;
    $('edge').addEventListener('input', (e) => {
      S.edge = Number(e.target.value); $('edgeVal').textContent = e.target.value;
      if (edgeQueued) return;
      edgeQueued = true;
      requestAnimationFrame(() => { edgeQueued = false; rebuildAll(); drawView(); });
    });
    $('edgeReset').addEventListener('click', () => { $('edge').value = '0'; $('edge').dispatchEvent(new Event('input')); });

    for (const r of document.querySelectorAll('input[name="tool"]')) r.addEventListener('change', () => { if (r.checked) setTool(r.value); });
    $('brush').addEventListener('input', (e) => { S.brush = P.clampBrush(e.target.value); $('brushVal').textContent = String(S.brush); scheduleDraw(); });
    $('undo').addEventListener('click', undo); $('redo').addEventListener('click', redo); $('resetEdits').addEventListener('click', resetEdits);

    const sel = $('format');
    for (const [id, f] of Object.entries(P.FORMATS)) sel.append(el('option', { value: id }, f.label));
    $('save').addEventListener('click', saveCutout);

    window.addEventListener('keydown', (e) => {
      const typing = /^(INPUT|SELECT|TEXTAREA)$/.test((e.target && e.target.tagName) || '') && e.target.type !== 'radio' && e.target.type !== 'checkbox' && e.target.type !== 'range';
      const mod = e.ctrlKey || e.metaKey;
      if (e.key === ' ' && S.img && !typing) { S.space = true; if (e.target === document.body || e.target === $('view')) e.preventDefault(); return; }
      if (mod && !e.shiftKey && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(); return; }
      if (mod && (e.key.toLowerCase() === 'y' || (e.shiftKey && e.key.toLowerCase() === 'z'))) { e.preventDefault(); redo(); return; }
      if (mod && e.key.toLowerCase() === 'o') { e.preventDefault(); if (!$('open').disabled) pickImage(); return; }
      if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); if (S.phase === 'ready') saveCutout(); return; }
      if (mod || typing || !S.img) return;
      const k = e.key.toLowerCase();
      if (k === 'o' && S.phase === 'ready' && !e.repeat) { heldKey = true; holdOn(); }
      else if (k === 'f') { fitZoom(); scheduleDraw(); }
      else if (S.phase === 'ready' && k === 'e') setTool(S.tool === 'erase' ? 'off' : 'erase');
      else if (S.phase === 'ready' && k === 'r') setTool(S.tool === 'restore' ? 'off' : 'restore');
      else if (S.phase === 'ready' && (e.key === '[' || e.key === ']')) { S.brush = P.clampBrush(S.brush * (e.key === ']' ? 1.25 : 0.8) + (e.key === ']' ? 1 : -1)); $('brush').value = String(S.brush); $('brushVal').textContent = String(S.brush); scheduleDraw(); }
      else if (e.key === 'Escape' && S.tool !== 'off') setTool('off');
    });
    window.addEventListener('keyup', (e) => {
      if (e.key === ' ') S.space = false;
      if (e.key.toLowerCase() === 'o' && heldKey) { heldKey = false; holdOff(); }
    });
    window.addEventListener('blur', () => { S.space = false; heldKey = false; if (S.showOrig) holdOff(); });

    // drag and drop a picture anywhere on the window
    let depth = 0;
    window.addEventListener('dragenter', (e) => { e.preventDefault(); depth++; document.body.classList.add('dragging'); });
    window.addEventListener('dragleave', () => { depth = Math.max(0, depth - 1); if (!depth) document.body.classList.remove('dragging'); });
    window.addEventListener('dragover', (e) => e.preventDefault());
    window.addEventListener('drop', async (e) => {
      e.preventDefault(); depth = 0; document.body.classList.remove('dragging');
      const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (!f) return;
      const p = window.br.pathForFile(f);
      if (p) handleOpened(await window.br.openImage(p));
    });
  }

  async function init() {
    wire(); wireView();
    window.br.onPhase((p) => {
      if (S.phase !== 'working') return;
      busyMessage(p.phase === 'loading' ? 'Starting the model (the first picture takes a few seconds longer)…' : 'Finding the subject…');
    });
    window.br.onOpened((r) => handleOpened(r));
    showPhase('empty');
    try {
      const e = await window.br.engine();
      if (!e.ok) { $('engineWarn').textContent = e.problems.join(' '); $('engineWarn').hidden = false; $('open').disabled = true; $('open2').disabled = true; }
    } catch { /* ignore */ }
  }

  // test hooks (the window test drives the real controls; these only read state or convert coordinates)
  window.__app = {
    S, P, cv, handleOpened, renderFull, drawView, sizeView,
    toWindow: (ix, iy) => { const r = $('view').getBoundingClientRect(); const p = fromPicture(ix, iy); return { x: Math.round(r.left + p.x), y: Math.round(r.top + p.y) }; },
    viewPixel: (ix, iy) => {
      const c = $('view'); const dpr = window.devicePixelRatio || 1; const p = fromPicture(ix, iy);
      const d = c.getContext('2d').getImageData(Math.round(p.x * dpr), Math.round(p.y * dpr), 1, 1).data;
      return [d[0], d[1], d[2], d[3]];
    },
    maskAlpha: (ix, iy) => cv.mask.getContext('2d').getImageData(Math.min(S.work.w - 1, Math.round(ix * S.work.k)), Math.min(S.work.h - 1, Math.round(iy * S.work.k)), 1, 1).data[3],
  };
  init();
})();
