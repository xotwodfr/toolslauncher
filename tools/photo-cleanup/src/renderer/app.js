'use strict';
(() => {
  const C = window.Core;
  const $ = (id) => document.getElementById(id);
  const canvas = (w, h) => { const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(w)); c.height = Math.max(1, Math.round(h)); return c; };
  const frame = () => new Promise((r) => requestAnimationFrame(() => r()));
  const SMALL = 2048;                      // longest side of the preview copies used when zoomed out
  const HISTORY_BYTES = 1.5 * 1024 ** 3;   // undo memory budget; the oldest steps are forgotten beyond it

  // ---- state -------------------------------------------------------------------------------------------------------------
  const S = {
    phase: 'empty',                        // empty | ready | busy
    img: null,                             // { id, name, size, format, details }
    doc: null,                             // { w, h, rgba, ox, oy }  current picture; (ox, oy) = where the original sits in it
    hasAlpha: false,
    version: 0,                            // bumps whenever the pixels change (the selection model must look again)
    mask: null,                            // Uint8Array(w*h): what is selected
    taps: null,                            // current run of taps: { base, points, labels, mode, lowRes, version }
    tool: 'tap', brush: 48, grow: 6,
    undo: [], redo: [], historyBytes: 0,
    mode: 'edit',                          // edit | extend
    ext: { preset: '16:9', amount: 0, m: { l: 0, t: 0, r: 0, b: 0 } },
    zoom: { s: 1, ox: 0, oy: 0 }, fit: true,
    showOrig: false, compare: false, split: 0.5,
    space: false, pointer: null,
    sam: { key: -1, pending: null, pendingKey: -1 },
    busyJob: null,                         // { cancelled }
    modelSeconds: [],                      // time the fill model took per part, for the last edit
    lastSave: null, lastEdit: null,
  };
  const cv = { doc: null, docData: null, small: null, ks: 1, orig: null, origSmall: null, overlay: null, ko: 1 };

  // ---- messages ------------------------------------------------------------------------------------------------------------
  let toastTimer = null;
  function toast(text, err = false) {
    const t = $('toast'); t.textContent = text; t.className = 'toast' + (err ? ' err' : ''); t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 4200);
  }
  function busy(text, sub = '', progress = null) {
    $('busy').hidden = false; $('busyText').textContent = text; $('busySub').textContent = sub;
    const bar = $('busyBar');
    if (progress == null) { bar.classList.add('indeterminate'); bar.firstElementChild.style.width = ''; } else { bar.classList.remove('indeterminate'); bar.firstElementChild.style.width = Math.round(progress * 100) + '%'; }
  }
  const unbusy = () => { $('busy').hidden = true; };

  // ---- canvases ---------------------------------------------------------------------------------------------------------------
  function buildDocCanvases() {
    const { w, h } = S.doc;
    cv.doc = canvas(w, h);
    cv.docData = new ImageData(S.doc.rgba, w, h);
    cv.doc.getContext('2d').putImageData(cv.docData, 0, 0);
    cv.ks = Math.min(1, SMALL / Math.max(w, h));
    cv.small = canvas(w * cv.ks, h * cv.ks);
    cv.ko = Math.min(1, SMALL / Math.max(w, h));
    cv.overlay = canvas(Math.round(w * cv.ko), Math.round(h * cv.ko));
    redrawSmall();
    refreshOverlay(null);
  }
  function redrawSmall() {
    const c = cv.small.getContext('2d'); c.imageSmoothingQuality = 'high';
    c.clearRect(0, 0, cv.small.width, cv.small.height);
    c.drawImage(cv.doc, 0, 0, cv.small.width, cv.small.height);
  }
  /** Copy changed pixels (box in doc pixels, or everything) from S.doc.rgba to the canvases. */
  function refreshDoc(box) {
    const { w, h } = S.doc;
    const b = box ? C.clipBox(box, w, h) : { x0: 0, y0: 0, x1: w, y1: h };
    if (b) cv.doc.getContext('2d').putImageData(cv.docData, 0, 0, b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0);
    redrawSmall();
    scheduleDraw();
  }
  /** Redraw the selection overlay (tinted fill + bright outline) for a box of doc pixels, or all of it. */
  function refreshOverlay(box) {
    const { w, h } = S.doc; const ko = cv.ko; const ow = cv.overlay.width; const oh = cv.overlay.height;
    let b = box ? { x0: Math.floor(box.x0 * ko) - 2, y0: Math.floor(box.y0 * ko) - 2, x1: Math.ceil(box.x1 * ko) + 2, y1: Math.ceil(box.y1 * ko) + 2 } : { x0: 0, y0: 0, x1: ow, y1: oh };
    b = C.clipBox(b, ow, oh); if (!b) return;
    const bw = b.x1 - b.x0; const bh = b.y1 - b.y0;
    // sample the mask one pixel beyond the box, so edges at the box border are right
    const sw = bw + 2; const sh = bh + 2; const smp = new Uint8Array(sw * sh);
    for (let y = 0; y < sh; y++) {
      const oy = b.y0 - 1 + y; if (oy < 0 || oy >= oh) continue;
      const my = Math.min(h - 1, Math.floor((oy + 0.5) / ko));
      for (let x = 0; x < sw; x++) { const ox = b.x0 - 1 + x; if (ox < 0 || ox >= ow) continue; smp[y * sw + x] = S.mask[my * w + Math.min(w - 1, Math.floor((ox + 0.5) / ko))]; }
    }
    const id = new ImageData(bw, bh); const d = id.data;
    for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
      const i = (y + 1) * sw + x + 1; if (!smp[i]) continue;
      const edge = !smp[i - 1] || !smp[i + 1] || !smp[i - sw] || !smp[i + sw];
      const o = (y * bw + x) * 4;
      if (edge) { d[o] = 255; d[o + 1] = 255; d[o + 2] = 255; d[o + 3] = 255; } else { d[o] = 255; d[o + 1] = 60; d[o + 2] = 150; d[o + 3] = 120; }
    }
    cv.overlay.getContext('2d').putImageData(id, b.x0, b.y0);
    scheduleDraw();
  }
  let maskCountCache = 0;
  function maskChanged(box) { maskCountCache = C.maskCount(S.mask); refreshOverlay(box); updateButtons(); }

  // ---- the view ---------------------------------------------------------------------------------------------------------------
  function sizeView() {
    const c = $('view'); const dpr = window.devicePixelRatio || 1;
    c.width = Math.round(c.clientWidth * dpr); c.height = Math.round(c.clientHeight * dpr);
    if (S.fit && S.doc) fitZoom();
  }
  /** The area the view has to show: the picture, or the new frame while extending. */
  function viewArea() {
    const { w, h } = S.doc;
    if (S.mode === 'extend') { const m = S.ext.m; return { x: -m.l, y: -m.t, w: w + m.l + m.r, h: h + m.t + m.b }; }
    return { x: 0, y: 0, w, h };
  }
  function fitScaleFor(a) { const wrap = $('viewwrap'); const pad = 28; return Math.min((wrap.clientWidth - pad * 2) / a.w, (wrap.clientHeight - pad * 2 - 40) / a.h, 4); }
  function fitZoom() {
    const wrap = $('viewwrap'); const a = viewArea(); const s = fitScaleFor(a);
    S.zoom = { s, ox: Math.round((wrap.clientWidth - a.w * s) / 2 - a.x * s), oy: Math.round((wrap.clientHeight - 40 - a.h * s) / 2 - a.y * s) };
    S.fit = true;
  }
  const toDoc = (x, y) => ({ x: (x - S.zoom.ox) / S.zoom.s, y: (y - S.zoom.oy) / S.zoom.s });
  const fromDoc = (x, y) => ({ x: S.zoom.ox + x * S.zoom.s, y: S.zoom.oy + y * S.zoom.s });

  let drawQueued = false;
  function scheduleDraw() { if (drawQueued) return; drawQueued = true; requestAnimationFrame(() => { drawQueued = false; drawView(); }); }

  function drawPicture(ctx, src, small, ks, x, y, w, h, s) {
    const useSmall = small && s * (window.devicePixelRatio || 1) <= ks * 1.01;
    ctx.imageSmoothingEnabled = s * (window.devicePixelRatio || 1) < 2.5; ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(useSmall ? small : src, x, y, w, h);
  }
  function drawView() {
    const c = $('view'); const ctx = c.getContext('2d'); const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, c.width, c.height);
    if (!S.doc) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const { s, ox, oy } = S.zoom; const { w, h } = S.doc;
    const iw = w * s; const ih = h * s;
    if (S.mode === 'extend') {
      const m = S.ext.m; const fx = ox - m.l * s; const fy = oy - m.t * s; const fw = (w + m.l + m.r) * s; const fh = (h + m.t + m.b) * s;
      ctx.fillStyle = '#1d1d23'; ctx.fillRect(fx, fy, fw, fh);
      ctx.save(); ctx.beginPath(); ctx.rect(fx, fy, fw, fh); ctx.clip();
      ctx.strokeStyle = 'rgba(154,208,255,.16)'; ctx.lineWidth = 1;
      for (let k = -fh; k < fw; k += 14) { ctx.beginPath(); ctx.moveTo(fx + k, fy); ctx.lineTo(fx + k + fh, fy + fh); ctx.stroke(); }
      ctx.restore();
      drawPicture(ctx, cv.doc, cv.small, cv.ks, ox, oy, iw, ih, s);
      ctx.setLineDash([6, 4]); ctx.strokeStyle = '#9ad0ff'; ctx.lineWidth = 1.5; ctx.strokeRect(fx + 0.5, fy + 0.5, fw - 1, fh - 1); ctx.setLineDash([]);
      ctx.fillStyle = '#9ad0ff';
      for (const [hx, hy] of [[fx, fy + fh / 2], [fx + fw, fy + fh / 2], [fx + fw / 2, fy], [fx + fw / 2, fy + fh]]) ctx.fillRect(hx - 5, hy - 5, 10, 10);
    } else {
      const showOrig = S.showOrig && cv.orig;
      if (showOrig) drawOriginal(ctx, s, ox, oy);
      else drawPicture(ctx, cv.doc, cv.small, cv.ks, ox, oy, iw, ih, s);
      if (!showOrig && !S.compare && maskCountCache) { ctx.imageSmoothingEnabled = false; ctx.drawImage(cv.overlay, ox, oy, iw, ih); }
      if (S.compare && cv.orig && !showOrig) {
        const sx = ox + iw * S.split;
        ctx.save(); ctx.beginPath(); ctx.rect(ox - 1, oy - 1, sx - ox + 1, ih + 2); ctx.clip();
        ctx.fillStyle = '#141418'; ctx.fillRect(ox, oy, iw, ih);
        drawOriginal(ctx, s, ox, oy);
        ctx.restore();
        ctx.fillStyle = '#ffffff'; ctx.fillRect(Math.round(sx) - 1, oy, 2, ih);
        ctx.beginPath(); ctx.arc(sx, oy + ih / 2, 9, 0, Math.PI * 2); ctx.fill();
        ctx.font = '600 10.5px ui-monospace, Consolas, monospace'; ctx.textBaseline = 'top';
        const tag = (t, x) => { const tw = ctx.measureText(t).width + 12; ctx.fillStyle = 'rgba(11,11,13,.78)'; ctx.fillRect(x, oy + 8, tw, 18); ctx.fillStyle = '#f3f3f4'; ctx.fillText(t, x + 6, oy + 12); return tw; };
        tag('BEFORE', ox + 8); const aw = ctx.measureText('AFTER').width + 12; tag('AFTER', ox + iw - aw - 8);
      }
      ctx.strokeStyle = 'rgba(255,255,255,.16)'; ctx.lineWidth = 1; ctx.strokeRect(ox - 0.5, oy - 0.5, iw + 1, ih + 1);
      if ((S.tool === 'brush' || S.tool === 'erase') && S.pointer && !S.showOrig && !S.compare) {
        const r = S.brush / 2;
        ctx.beginPath(); ctx.arc(S.pointer.x, S.pointer.y, r, 0, Math.PI * 2);
        ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(0,0,0,.55)'; ctx.stroke();
        ctx.lineWidth = 1.5; ctx.strokeStyle = S.tool === 'erase' ? '#9ad0ff' : '#ff6fb0'; ctx.stroke();
      }
    }
    $('zoomInfo').textContent = `${Math.round(S.zoom.s * 100)}%`;
  }
  function drawOriginal(ctx, s, ox, oy) {
    const o = cv.orig;
    drawPicture(ctx, o, cv.origSmall, Math.min(1, SMALL / Math.max(o.width, o.height)), ox + S.doc.ox * s, oy + S.doc.oy * s, o.width * s, o.height * s, s);
  }
  function zoomAt(mx, my, factor) {
    const fs = Math.min(fitScaleFor(viewArea()), 1);
    const ns = Math.min(Math.max(S.zoom.s * factor, fs * 0.5), 32);
    const k = ns / S.zoom.s;
    S.zoom = { s: ns, ox: mx - (mx - S.zoom.ox) * k, oy: my - (my - S.zoom.oy) * k };
    S.fit = false; scheduleDraw();
  }

  // ---- history -------------------------------------------------------------------------------------------------------------------
  // entries: { kind: 'mask', label, rect, before, after }
  //          { kind: 'pixels', label, patches: [{ rect, before, after }], mask: { rect, before, after } | null, seconds }
  //          { kind: 'frame', label, before: { doc, mask }, after: { doc, mask }, seconds }
  const entryBytes = (e) => {
    if (e.kind === 'mask') return e.before.length * 2;
    if (e.kind === 'pixels') return e.patches.reduce((n, p) => n + p.before.length * 2, 0) + (e.mask ? e.mask.before.length * 2 : 0);
    return e.before.doc.rgba.length + e.after.doc.rgba.length;
  };
  function pushHistory(e) {
    e.bytes = entryBytes(e);
    S.undo.push(e); S.historyBytes += e.bytes;
    for (const r of S.redo) S.historyBytes -= r.bytes;
    S.redo = [];
    while (S.historyBytes > HISTORY_BYTES && S.undo.length > 1) S.historyBytes -= S.undo.shift().bytes;
    renderHistory(); updateButtons();
  }
  function applyEntry(e, dir) {
    const side = dir === 'undo' ? 'before' : 'after';
    S.taps = null;
    if (e.kind === 'mask') { C.putRect(S.mask, S.doc.w, 1, e.rect, e[side]); maskChanged(C.rectToBox(e.rect)); return; }
    if (e.kind === 'pixels') {
      let box = null;
      for (const p of (dir === 'undo' ? e.patches.slice().reverse() : e.patches)) { C.putRect(S.doc.rgba, S.doc.w, 4, p.rect, p[side]); box = C.unionBox(box, C.rectToBox(p.rect)); }
      S.version++; refreshDoc(box);
      if (e.mask) { C.putRect(S.mask, S.doc.w, 1, e.mask.rect, e.mask[side]); maskChanged(C.rectToBox(e.mask.rect)); }
      scheduleEncode();
      return;
    }
    S.doc = e[side].doc; S.mask = e[side].mask; S.version++;
    buildDocCanvases(); maskChanged(null); fitZoom(); updateFileInfo(); scheduleEncode();
  }
  function undo() { if (S.phase !== 'ready' || !S.undo.length) return; if (S.mode === 'extend') leaveExtend(); const e = S.undo.pop(); applyEntry(e, 'undo'); S.redo.push(e); renderHistory(); updateButtons(); }
  function redo() { if (S.phase !== 'ready' || !S.redo.length) return; if (S.mode === 'extend') leaveExtend(); const e = S.redo.pop(); applyEntry(e, 'redo'); S.undo.push(e); renderHistory(); updateButtons(); }
  function renderHistory() {
    const ol = $('history'); ol.textContent = '';
    const items = [...S.undo.map((e) => ({ e, done: true })), ...S.redo.slice().reverse().map((e) => ({ e, done: false }))].filter((x) => x.e.kind !== 'mask');
    if (!items.length) { const li = document.createElement('li'); li.className = 'empty'; li.textContent = 'No edits yet'; ol.append(li); return; }
    const lastDone = items.filter((x) => x.done).length - 1;
    items.forEach((x, i) => {
      const li = document.createElement('li');
      li.className = x.done ? (i === lastDone ? 'current' : '') : 'undone';
      const a = document.createElement('span'); a.textContent = x.e.label;
      const t = document.createElement('span'); t.className = 't'; t.textContent = x.e.seconds ? x.e.seconds.toFixed(1) + ' s' : '';
      li.append(a, t); ol.append(li);
    });
    ol.scrollTop = ol.scrollHeight;
  }

  // ---- selection: brush ------------------------------------------------------------------------------------------------------------
  let stroke = null; // { value, before (full mask copy), box, last: {x, y}, r }
  function strokeStart(p, value) {
    S.taps = null;
    const q = toDoc(p.x, p.y); const r = S.brush / 2 / S.zoom.s;
    stroke = { value, before: S.mask.slice(), box: null, last: q, r };
    strokeTo(p);
  }
  function strokeTo(p) {
    const q = toDoc(p.x, p.y);
    const b = C.paintLine(S.mask, S.doc.w, S.doc.h, stroke.last.x, stroke.last.y, q.x, q.y, stroke.r, stroke.value);
    stroke.last = q;
    if (b) { stroke.box = C.unionBox(stroke.box, b); refreshOverlay(b); }
  }
  function strokeEnd() {
    const st = stroke; stroke = null;
    if (!st || !st.box) return;
    const rect = C.boxToRect(st.box);
    const before = C.getRect(st.before, S.doc.w, 1, rect); const after = C.getRect(S.mask, S.doc.w, 1, rect);
    maskChanged(st.box);
    if (C.hash(before) === C.hash(after) && before.every((v, i) => v === after[i])) return;
    pushHistory({ kind: 'mask', label: st.value ? 'Brush' : 'Erase', rect, before, after });
  }

  // ---- selection: tap (Segment Anything) -------------------------------------------------------------------------------------------
  let encodeTimer = null;
  function scheduleEncode() { clearTimeout(encodeTimer); encodeTimer = setTimeout(() => { if (S.phase === 'ready') ensureEmbedding().catch(() => {}); }, 400); }
  /** Make sure the selection model has looked at the current pixels. Resolves true when ready. */
  function ensureEmbedding() {
    if (S.sam.key === S.version) return Promise.resolve(true);
    if (S.sam.pending && S.sam.pendingKey === S.version) return S.sam.pending;
    const key = S.version; const ss = C.samSize(S.doc.w, S.doc.h);
    const c = canvas(ss.w, ss.h); const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingQuality = 'high'; ctx.drawImage(cv.doc, 0, 0, ss.w, ss.h);
    const d = ctx.getImageData(0, 0, ss.w, ss.h).data; const rgb = new Uint8Array(ss.w * ss.h * 3);
    for (let i = 0, j = 0; i < d.length; i += 4) { rgb[j++] = d[i]; rgb[j++] = d[i + 1]; rgb[j++] = d[i + 2]; }
    const p = window.pc.samEncode({ key, rgb, w: ss.w, h: ss.h }).then((r) => {
      if (S.sam.pendingKey === key) S.sam.pending = null;
      if (r.ok) { if (r.key === S.version) S.sam.key = r.key; return r.key === S.version; }
      throw new Error(r.error);
    }, (e) => { if (S.sam.pendingKey === key) S.sam.pending = null; throw e; });
    S.sam.pending = p; S.sam.pendingKey = key;
    return p;
  }
  let tapping = false;
  async function tap(ix, iy, add) {
    if (tapping || ix < 0 || iy < 0 || ix >= S.doc.w || iy >= S.doc.h) return;
    tapping = true;
    $('selInfo').textContent = 'Outlining…';
    try {
      for (let tries = 0; tries < 3; tries++) {
        if (S.sam.key !== S.version) {
          $('selInfo').textContent = S.sam.key < 0 ? 'Getting the selection model ready…' : 'Looking at the photo…';
          if (!(await ensureEmbedding())) continue;
          $('selInfo').textContent = 'Outlining…';
        }
        let seq = S.taps;
        if (!seq || seq.version !== S.version) seq = { base: S.mask.slice(), points: [], labels: [], mode: add ? 'add' : 'sub', lowRes: null, version: S.version };
        const ss = C.samSize(S.doc.w, S.doc.h);
        const points = [...seq.points, [ix * ss.s, iy * ss.s]];
        // in an "add" run a plain tap is positive; in a "take away" run the region being taken away is the positive one
        const positive = seq.mode === 'add' ? add : !add || !seq.points.length;
        const labels = [...seq.labels, positive ? 1 : 0];
        if (!labels.includes(1)) { toast('Tap on the object first, then take parts away', true); return; }
        const r = await window.pc.samDecode({ key: S.version, points, labels, maskInput: seq.lowRes });
        if (!r.ok && r.stale) { S.sam.key = -1; continue; }
        if (!r.ok) throw new Error(r.error);
        const sel = C.logitsToMask(r.logits, r.w, r.h, S.doc.w, S.doc.h);
        const next = new Uint8Array(S.mask.length);
        if (seq.mode === 'add') for (let i = 0; i < next.length; i++) next[i] = seq.base[i] | sel[i];
        else for (let i = 0; i < next.length; i++) next[i] = seq.base[i] & (sel[i] ^ 1);
        const box = C.diffBox(S.mask, next, S.doc.w, S.doc.h, 1);
        seq.points = points; seq.labels = labels; seq.lowRes = r.lowRes;
        if (box) {
          const rect = C.boxToRect(box);
          const before = C.getRect(S.mask, S.doc.w, 1, rect); const after = C.getRect(next, S.doc.w, 1, rect);
          C.putRect(S.mask, S.doc.w, 1, rect, after);
          pushHistory({ kind: 'mask', label: 'Tap', rect, before, after });
          maskChanged(box);
        }
        S.taps = seq;
        return;
      }
      throw new Error('the photo kept changing');
    } catch (e) { toast('Could not outline that: ' + ((e && e.message) || e), true); }
    finally { tapping = false; $('selInfo').textContent = ''; updateButtons(); }
  }
  function clearSelection() {
    if (!maskCountCache) return;
    const box = C.maskBox(S.mask, S.doc.w, S.doc.h); const rect = C.boxToRect(box);
    const before = C.getRect(S.mask, S.doc.w, 1, rect);
    S.mask.fill(0); S.taps = null;
    pushHistory({ kind: 'mask', label: 'Clear selection', rect, before, after: new Uint8Array(before.length) });
    maskChanged(box);
  }

  // ---- removing -------------------------------------------------------------------------------------------------------------------
  async function runFill(rgba, w, h, unknown, feather, pads, match) {
    const r = await window.pc.fill({ rgba, w, h, unknown, feather, pads: pads || null, match: match || 0 });
    if (S.busyJob && S.busyJob.cancelled) return null;
    if (!r.ok) { if (r.cancelled) return null; throw new Error(r.error); }
    S.modelSeconds.push(r.seconds);
    return r.rgba;
  }
  async function removeSelection() {
    if (S.phase !== 'ready' || !maskCountCache) return;
    const t0 = performance.now();
    const { w: W, h: H } = S.doc; const grow = S.grow;
    const box = C.maskBox(S.mask, W, H);
    const region = C.clipBox(C.growBox(box, grow + 2), W, H); const rr = C.boxToRect(region);
    const grown = C.dilate(C.getRect(S.mask, W, 1, rr), rr.w, rr.h, grow);
    const unknown = new Uint8Array(W * H); C.putRect(unknown, W, 1, rr, grown);
    const parts = C.components(grown, rr.w, rr.h).map((p) => ({ x0: p.x0 + rr.x, y0: p.y0 + rr.y, x1: p.x1 + rr.x, y1: p.y1 + rr.y }));
    const jobs = C.removalJobs(parts, W, H);
    setPhase('busy'); S.busyJob = { cancelled: false }; S.modelSeconds = [];
    const patches = [];
    try {
      for (let i = 0; i < jobs.length; i++) {
        const win = jobs[i].win;
        const unk = C.getRect(unknown, W, 1, win);
        if (!C.maskCount(unk)) continue;
        busy('Removing…', jobs.length > 1 ? `Area ${i + 1} of ${jobs.length}` : `${win.w} × ${win.h} px around the selection`, jobs.length > 1 ? i / jobs.length : null);
        const before = C.getRect(S.doc.rgba, W, 4, win);
        const out = await runFill(before.slice(), win.w, win.h, unk, C.featherFor(win), null);
        if (!out) { for (const p of patches.reverse()) C.putRect(S.doc.rgba, W, 4, p.rect, p.before); refreshDoc(null); toast('Cancelled'); return; }
        C.putRect(S.doc.rgba, W, 4, win, out);
        C.putRect(unknown, W, 1, win, new Uint8Array(win.w * win.h));
        // keep only the part that really changed
        const d = C.diffBox(before, out, win.w, win.h, 4);
        if (d) { const rect = { x: win.x + d.x0, y: win.y + d.y0, w: d.x1 - d.x0, h: d.y1 - d.y0 }; patches.push({ rect, before: C.getRect(before, win.w, 4, { x: d.x0, y: d.y0, w: rect.w, h: rect.h }), after: C.getRect(S.doc.rgba, W, 4, rect) }); }
        refreshDoc(C.rectToBox(win));
        await frame();
      }
      const mrect = C.boxToRect(box);
      const maskBefore = C.getRect(S.mask, W, 1, mrect);
      S.mask.fill(0); S.taps = null; S.version++;
      const seconds = (performance.now() - t0) / 1000;
      S.lastEdit = { kind: 'remove', patches: patches.map((p) => p.rect), seconds, grow };
      pushHistory({ kind: 'pixels', label: 'Removed', patches, mask: { rect: mrect, before: maskBefore, after: new Uint8Array(maskBefore.length) }, seconds });
      maskChanged(box);
      scheduleEncode();
    } catch (e) {
      for (const p of patches.reverse()) C.putRect(S.doc.rgba, W, 4, p.rect, p.before);
      refreshDoc(null);
      toast('Could not remove it: ' + ((e && e.message) || e), true);
    } finally { S.busyJob = null; unbusy(); setPhase('ready'); }
  }

  // ---- extending ------------------------------------------------------------------------------------------------------------------
  function setPreset(preset, keepAmount = true) {
    S.ext.preset = preset;
    if (!keepAmount) S.ext.amount = 0;
    $('preset-' + preset.replace(':', '-')).checked = true;
    S.ext.m = C.presetMargins(S.doc.w, S.doc.h, preset, S.ext.amount / 100);
    enterExtend();
  }
  function enterExtend() {
    if (S.mode !== 'extend') { S.mode = 'extend'; S.compare = false; $('compare').setAttribute('aria-pressed', 'false'); }
    fitZoom(); updateExtInfo(); updateButtons(); scheduleDraw();
  }
  function leaveExtend() {
    S.mode = 'edit';
    for (const r of document.querySelectorAll('input[name="preset"]')) r.checked = false;
    fitZoom(); updateExtInfo(); updateButtons(); scheduleDraw();
  }
  function updateExtInfo() {
    const el = $('extInfo');
    if (S.mode !== 'extend' || !S.doc) { el.textContent = 'Pick a shape, or drag the edges of the frame in the picture.'; return; }
    const m = S.ext.m; const FW = S.doc.w + m.l + m.r; const FH = S.doc.h + m.t + m.b;
    const pct = Math.round(((FW * FH) / (S.doc.w * S.doc.h) - 1) * 100);
    el.textContent = FW === S.doc.w && FH === S.doc.h ? 'Already this shape: raise Amount or drag an edge.' : `New size ${FW} × ${FH} (+${pct}% area). Drag the frame's edges to adjust.`;
  }
  async function runExtend() {
    if (S.phase !== 'ready' || S.mode !== 'extend') return;
    const old = S.doc; const W = old.w; const H = old.h;
    const plan = C.extendPlan(W, H, S.ext.m);
    if (plan.FW === W && plan.FH === H) return;
    const t0 = performance.now();
    const { FW, FH } = plan;
    const rgba = new Uint8ClampedArray(FW * FH * 4); const pending = new Uint8Array(FW * FH).fill(1);
    // the new area starts as the nearest edge colour (only seen while the fill is running)
    for (let y = 0; y < FH; y++) {
      const sy = Math.min(H - 1, Math.max(0, y - plan.oy));
      for (let x = 0; x < FW; x++) {
        const sx = Math.min(W - 1, Math.max(0, x - plan.ox)); const s = (sy * W + sx) * 4; const o = (y * FW + x) * 4;
        rgba[o] = old.rgba[s]; rgba[o + 1] = old.rgba[s + 1]; rgba[o + 2] = old.rgba[s + 2]; rgba[o + 3] = old.rgba[s + 3];
      }
    }
    for (let y = 0; y < H; y++) pending.fill(0, (y + plan.oy) * FW + plan.ox, (y + plan.oy) * FW + plan.ox + W);
    const next = { w: FW, h: FH, rgba, ox: old.ox + plan.ox, oy: old.oy + plan.oy };
    const oldMask = S.mask;
    S.mode = 'edit';
    S.doc = next; S.mask = new Uint8Array(FW * FH);
    buildDocCanvases(); maskCountCache = 0; fitZoom();
    setPhase('busy'); S.busyJob = { cancelled: false }; S.modelSeconds = [];
    const restore = () => { S.doc = old; S.mask = oldMask; buildDocCanvases(); maskChanged(null); S.mode = 'extend'; fitZoom(); updateFileInfo(); };
    try {
      let k = 0;
      for (const step of plan.steps) {
        for (const t of step.tiles) {
          busy('Extending…', `Part ${k + 1} of ${plan.count}`, k / plan.count); k++;
          const unk = C.getRect(pending, FW, 1, t);
          if (!C.maskCount(unk)) continue;
          const out = await runFill(C.getRect(rgba, FW, 4, t), t.w, t.h, unk, plan.feather, t.pads, plan.match);
          if (!out) { restore(); toast('Cancelled'); return; }
          C.putRect(rgba, FW, 4, t, out); C.putRect(pending, FW, 1, t, new Uint8Array(t.w * t.h));
          refreshDoc(C.rectToBox(t));
          await frame();
        }
      }
      const seconds = (performance.now() - t0) / 1000;
      S.version++; S.taps = null;
      const label = S.ext.preset === 'free' ? `Extended to ${FW} × ${FH}` : `Extended to ${S.ext.preset}`;
      S.lastEdit = { kind: 'extend', plan: { FW, FH, ox: plan.ox, oy: plan.oy, count: plan.count, tile: plan.tile }, seconds };
      pushHistory({ kind: 'frame', label, before: { doc: old, mask: oldMask }, after: { doc: next, mask: S.mask }, seconds });
      leaveExtend(); updateFileInfo(); scheduleEncode();
    } catch (e) {
      restore();
      toast('Could not extend: ' + ((e && e.message) || e), true);
    } finally { S.busyJob = null; unbusy(); setPhase('ready'); }
  }
  /** Which frame edge (if any) is under a view point while extending. */
  function edgeAt(p) {
    if (S.mode !== 'extend') return null;
    const m = S.ext.m; const s = S.zoom.s;
    const a = fromDoc(-m.l, -m.t); const b = fromDoc(S.doc.w + m.r, S.doc.h + m.b); const tol = 9;
    const inY = p.y > a.y - tol && p.y < b.y + tol; const inX = p.x > a.x - tol && p.x < b.x + tol;
    if (inY && Math.abs(p.x - a.x) < tol) return 'l';
    if (inY && Math.abs(p.x - b.x) < tol) return 'r';
    if (inX && Math.abs(p.y - a.y) < tol) return 't';
    if (inX && Math.abs(p.y - b.y) < tol) return 'b';
    void s; return null;
  }

  // ---- pointer --------------------------------------------------------------------------------------------------------------------------
  let drag = null; // { kind: 'pan'|'stroke'|'tap'|'edge'|'split', ... }
  function wireView() {
    const c = $('view');
    const pos = (e) => { const r = c.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    c.addEventListener('pointerdown', (e) => {
      if (!S.doc || S.phase !== 'ready') return;
      const p = pos(e);
      c.setPointerCapture(e.pointerId);
      e.preventDefault();
      const pan = () => { drag = { kind: 'pan', x: p.x, y: p.y }; c.classList.add('panning'); };
      if (e.button === 1 || S.space) return pan();
      if (S.mode === 'extend') {
        const edge = edgeAt(p);
        if (edge && e.button === 0) { drag = { kind: 'edge', edge, start: p, m0: { ...S.ext.m } }; return; }
        return pan();
      }
      if (S.compare) {
        const sx = S.zoom.ox + S.doc.w * S.zoom.s * S.split;
        if (Math.abs(p.x - sx) < 14 || e.button === 0) { drag = { kind: 'split' }; S.split = Math.min(1, Math.max(0, (p.x - S.zoom.ox) / (S.doc.w * S.zoom.s))); scheduleDraw(); return; }
      }
      if (S.showOrig) return pan();
      if (S.tool === 'move') return pan();
      if (S.tool === 'tap') { drag = { kind: 'tap', start: p, x: p.x, y: p.y, add: e.button === 0 && !e.altKey, moved: false }; return; }
      if (S.tool === 'brush' || S.tool === 'erase') {
        if (e.button !== 0 && e.button !== 2) return;
        const value = (S.tool === 'brush') !== (e.button === 2 || e.altKey) ? 1 : 0;
        strokeStart(p, value); drag = { kind: 'stroke' };
      }
    });
    c.addEventListener('pointermove', (e) => {
      const p = pos(e);
      S.pointer = p;
      if (!drag) {
        const edge = edgeAt(p);
        c.classList.toggle('ew', edge === 'l' || edge === 'r'); c.classList.toggle('ns', edge === 't' || edge === 'b');
        if (S.tool === 'brush' || S.tool === 'erase') scheduleDraw();
        return;
      }
      if (drag.kind === 'stroke') strokeTo(p);
      else if (drag.kind === 'pan' || (drag.kind === 'tap' && (drag.moved || Math.hypot(p.x - drag.start.x, p.y - drag.start.y) > 5))) {
        if (drag.kind === 'tap') { drag.moved = true; c.classList.add('panning'); }
        S.zoom = { ...S.zoom, ox: S.zoom.ox + (p.x - drag.x), oy: S.zoom.oy + (p.y - drag.y) }; S.fit = false;
        drag.x = p.x; drag.y = p.y;
      } else if (drag.kind === 'edge') {
        const d = Math.round(((drag.edge === 'l' || drag.edge === 'r') ? p.x - drag.start.x : p.y - drag.start.y) / S.zoom.s);
        const m = { ...drag.m0 };
        if (drag.edge === 'l') m.l = drag.m0.l - d; if (drag.edge === 'r') m.r = drag.m0.r + d;
        if (drag.edge === 't') m.t = drag.m0.t - d; if (drag.edge === 'b') m.b = drag.m0.b + d;
        S.ext.m = C.clampMargins(S.doc.w, S.doc.h, m);
        if (S.ext.preset !== 'free') { S.ext.preset = 'free'; $('preset-free').checked = true; }
        updateExtInfo(); updateButtons();
      } else if (drag.kind === 'split') S.split = Math.min(1, Math.max(0, (p.x - S.zoom.ox) / (S.doc.w * S.zoom.s)));
      scheduleDraw();
    });
    const end = (e) => {
      if (!drag) return;
      const d = drag; drag = null;
      c.classList.remove('panning');
      try { c.releasePointerCapture(e.pointerId); } catch { /* already released */ }
      if (d.kind === 'stroke') strokeEnd();
      if (d.kind === 'tap' && !d.moved && e.type === 'pointerup') { const q = toDoc(d.start.x, d.start.y); tap(Math.floor(q.x), Math.floor(q.y), d.add); }
      if (d.kind === 'edge') { fitZoom(); }
      scheduleDraw();
    };
    c.addEventListener('pointerup', end); c.addEventListener('pointercancel', end);
    c.addEventListener('pointerleave', () => { if (!drag) { S.pointer = null; scheduleDraw(); } });
    c.addEventListener('wheel', (e) => { if (!S.doc) return; e.preventDefault(); const p = pos(e); zoomAt(p.x, p.y, Math.exp(-e.deltaY * 0.0016)); }, { passive: false });
    new ResizeObserver(() => { sizeView(); scheduleDraw(); }).observe($('viewwrap'));
  }

  // ---- controls -------------------------------------------------------------------------------------------------------------------------
  const HELP = {
    tap: 'Tap an object to outline it. Tap more to add; Alt-click or right-click to take a part away.',
    brush: 'Paint over what should go. Right-drag or Alt-drag erases. [ and ] change the size.',
    erase: 'Paint to take parts out of the selection.',
    move: 'Drag to move around the photo. Scroll to zoom.',
  };
  function setTool(t) {
    S.tool = t; S.taps = null;
    $('tool-' + t).checked = true;
    $('toolHelp').textContent = HELP[t];
    const c = $('view'); c.classList.toggle('brush', t === 'brush' || t === 'erase'); c.classList.toggle('move', t === 'move');
    scheduleDraw();
  }
  function setPhase(phase) {
    S.phase = phase;
    $('empty').hidden = phase !== 'empty' || !!S.doc;
    $('work').hidden = !S.doc;
    for (const id of ['removeSet', 'extendSet', 'historySet', 'saveSet']) $(id).disabled = phase !== 'ready';
    $('open').disabled = phase === 'busy';
    updateButtons();
  }
  function updateButtons() {
    const ready = S.phase === 'ready';
    $('undo').disabled = !ready || !S.undo.length; $('redo').disabled = !ready || !S.redo.length;
    $('remove').disabled = !ready || !maskCountCache || S.mode === 'extend';
    $('clearSel').disabled = !ready || !maskCountCache;
    const m = S.ext.m;
    $('extend').disabled = !ready || S.mode !== 'extend' || !(m.l || m.r || m.t || m.b);
    $('extCancel').disabled = !ready || S.mode !== 'extend';
    $('qualityRow').hidden = !C.FORMATS[$('format').value].quality;
  }
  function updateFileInfo() {
    if (!S.img) { $('fileInfo').textContent = ''; return; }
    $('fileInfo').textContent = `${S.img.name} · ${S.doc.w} × ${S.doc.h} · ${C.formatBytes(S.img.size)}`;
  }
  function updateDetailsInfo() {
    const d = S.img && S.img.details;
    const el = $('detailsInfo');
    if (!d || (!d.exif && !d.xmp)) { el.textContent = 'This photo has no camera details stored in it.' + (d && d.icc ? ' Its colour profile is kept.' : ''); $('keepDetails').disabled = true; return; }
    $('keepDetails').disabled = false;
    const bits = [d.camera, d.date, d.gps ? 'location (GPS)' : ''].filter(Boolean);
    el.textContent = (bits.length ? `Stored in this photo: ${bits.join(', ')}. ` : 'This photo has camera details stored in it. ') + 'Untick to save without them. The colour profile is always kept; the old preview image is always removed.';
  }

  async function save() {
    if (S.phase !== 'ready') return;
    const format = $('format').value; const fmt = C.FORMATS[format]; const q = Number($('quality').value) / 100;
    const res = $('result'); res.hidden = true;
    const { w, h } = S.doc;
    const req = { id: S.img.id, format, keepDetails: $('keepDetails').checked && !$('keepDetails').disabled, w, h };
    try {
      if (format === 'png') req.rgba = S.doc.rgba;
      else {
        let src = cv.doc;
        if (format === 'jpeg' && S.hasAlpha) { src = canvas(w, h); const x = src.getContext('2d'); x.fillStyle = '#ffffff'; x.fillRect(0, 0, w, h); x.drawImage(cv.doc, 0, 0); }
        const blob = await new Promise((r) => src.toBlob(r, fmt.mime, q));
        if (!blob) throw new Error('The picture could not be encoded');
        req.bytes = new Uint8Array(await blob.arrayBuffer());
      }
      const r = await window.pc.save(req);
      if (r.dialogCancelled) return;
      res.hidden = false; res.textContent = '';
      if (!r.ok) { res.className = 'result err'; res.textContent = r.error; return; }
      S.lastSave = r;
      res.className = 'result ok';
      const a = document.createElement('div'); a.textContent = `Saved ${fmt.label}, ${C.formatBytes(r.bytes)}${r.details ? ', with photo details' : ''}`;
      const p = document.createElement('div'); p.className = 'path'; p.textContent = r.path; p.title = r.path;
      const b = document.createElement('button'); b.className = 'btn small'; b.textContent = 'Show in folder'; b.addEventListener('click', () => window.pc.reveal(r.path));
      res.append(a, p, b);
    } catch (e) { res.hidden = false; res.className = 'result err'; res.textContent = String((e && e.message) || e); }
  }
  async function copy() {
    if (S.phase !== 'ready') return;
    const r = await window.pc.copy({ rgba: S.doc.rgba, w: S.doc.w, h: S.doc.h });
    toast(r.ok ? 'Copied the picture' : 'Could not copy: ' + r.error, !r.ok);
  }

  // ---- opening ---------------------------------------------------------------------------------------------------------------------------
  async function handleOpened(r) {
    if (!r) return;
    if (!r.ok) { toast(`${r.name ? r.name + ': ' : ''}${r.error}`, true); return; }
    if (S.phase === 'busy') return;
    if (S.undo.some((e) => e.kind !== 'mask') && !window.confirm('Open another photo? Edits that are not saved will be lost.')) return;
    let bmp;
    try { bmp = await createImageBitmap(new Blob([r.bytes]), { imageOrientation: 'from-image', colorSpaceConversion: 'none', premultiplyAlpha: 'none' }); }
    catch { toast(`${r.name}: this file could not be decoded (it may be damaged)`, true); return; }
    const w = bmp.width; const h = bmp.height;
    if (w * h > C.MAX_PIXELS || Math.max(w, h) > C.MAX_SIDE) { bmp.close(); toast(`${r.name} is ${w} × ${h}; the limit is ${C.MAX_PIXELS / 1e6} megapixels`, true); return; }
    const oc = canvas(w, h); const octx = oc.getContext('2d', { willReadFrequently: true });
    octx.drawImage(bmp, 0, 0); bmp.close();
    const rgba = new Uint8ClampedArray(octx.getImageData(0, 0, w, h).data.buffer);
    let alpha = false; for (let i = 3; i < rgba.length; i += 4) if (rgba[i] !== 255) { alpha = true; break; }
    S.img = { id: r.id, name: r.name, size: r.size, format: r.format, details: r.details };
    S.doc = { w, h, rgba: new Uint8ClampedArray(rgba), ox: 0, oy: 0 };
    S.hasAlpha = alpha; S.mask = new Uint8Array(w * h); maskCountCache = 0;
    S.undo = []; S.redo = []; S.historyBytes = 0; S.taps = null; S.version++; S.sam = { key: -1, pending: null, pendingKey: -1 };
    S.mode = 'edit'; S.compare = false; S.showOrig = false; $('compare').setAttribute('aria-pressed', 'false');
    for (const x of document.querySelectorAll('input[name="preset"]')) x.checked = false;
    S.ext = { preset: '16:9', amount: 0, m: { l: 0, t: 0, r: 0, b: 0 } }; $('amount').value = 0; $('amountVal').textContent = '0';
    S.lastEdit = null; S.lastSave = null; $('result').hidden = true;
    cv.orig = oc;
    const ko = Math.min(1, SMALL / Math.max(w, h)); cv.origSmall = canvas(w * ko, h * ko);
    { const c = cv.origSmall.getContext('2d'); c.imageSmoothingQuality = 'high'; c.drawImage(oc, 0, 0, cv.origSmall.width, cv.origSmall.height); }
    buildDocCanvases();
    S.grow = C.defaultGrow(w, h); $('grow').value = S.grow; $('growVal').textContent = S.grow;
    $('format').value = C.defaultFormat(r.format);
    $('keepDetails').checked = true;
    updateDetailsInfo(); updateFileInfo(); renderHistory();
    setPhase('ready');
    sizeView(); fitZoom(); scheduleDraw();
    window.pc.warm();
    scheduleEncode();
  }
  async function pickAndOpen() { if (S.phase === 'busy') return; handleOpened(await window.pc.pickImage()); }

  // ---- wiring ---------------------------------------------------------------------------------------------------------------------------
  function wire() {
    $('open').addEventListener('click', pickAndOpen);
    $('open2').addEventListener('click', pickAndOpen);
    $('empty').addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pickAndOpen(); } });
    $('undo').addEventListener('click', undo); $('redo').addEventListener('click', redo);
    for (const t of ['tap', 'brush', 'erase', 'move']) $('tool-' + t).addEventListener('change', () => setTool(t));
    $('brush').addEventListener('input', () => { S.brush = Number($('brush').value); $('brushVal').textContent = S.brush; scheduleDraw(); });
    $('grow').addEventListener('input', () => { S.grow = Number($('grow').value); $('growVal').textContent = S.grow; });
    $('remove').addEventListener('click', removeSelection);
    $('clearSel').addEventListener('click', clearSelection);
    for (const r of document.querySelectorAll('input[name="preset"]')) r.addEventListener('change', () => setPreset(r.value));
    $('amount').addEventListener('input', () => { S.ext.amount = Number($('amount').value); $('amountVal').textContent = S.ext.amount; setPreset(S.ext.preset); });
    $('extend').addEventListener('click', runExtend);
    $('extCancel').addEventListener('click', leaveExtend);
    $('format').addEventListener('change', updateButtons);
    $('quality').addEventListener('input', () => { $('qualityVal').textContent = $('quality').value; });
    $('save').addEventListener('click', save);
    $('copy').addEventListener('click', copy);
    $('cancel').addEventListener('click', () => { if (S.busyJob) { S.busyJob.cancelled = true; busy('Cancelling…', 'Finishing the part in progress'); window.pc.cancelFill(); } });
    $('fit').addEventListener('click', () => { if (S.doc) { fitZoom(); scheduleDraw(); } });
    $('actual').addEventListener('click', () => { if (!S.doc) return; const v = $('view'); zoomAt(v.clientWidth / 2, v.clientHeight / 2, 1 / S.zoom.s); });
    const holdOn = () => { if (S.doc && S.mode === 'edit') { S.showOrig = true; scheduleDraw(); } };
    const holdOff = () => { S.showOrig = false; scheduleDraw(); };
    $('hold').addEventListener('pointerdown', holdOn); $('hold').addEventListener('pointerup', holdOff); $('hold').addEventListener('pointerleave', holdOff);
    const toggleCompare = () => { if (!S.doc || S.mode !== 'edit') return; S.compare = !S.compare; $('compare').setAttribute('aria-pressed', String(S.compare)); scheduleDraw(); };
    $('compare').addEventListener('click', toggleCompare);

    let heldKey = false;
    window.addEventListener('keydown', (e) => {
      const tag = (e.target && e.target.tagName) || '';
      if (tag === 'INPUT' && e.target.type !== 'range' && e.target.type !== 'radio' && e.target.type !== 'checkbox') return;
      if (tag === 'SELECT') return;
      const k = e.key.toLowerCase(); const mod = e.ctrlKey || e.metaKey;
      if (mod && k === 'z' && !e.shiftKey) { e.preventDefault(); undo(); return; }
      if (mod && (k === 'y' || (k === 'z' && e.shiftKey))) { e.preventDefault(); redo(); return; }
      if (mod && k === 'o') { e.preventDefault(); pickAndOpen(); return; }
      if (mod && k === 's') { e.preventDefault(); save(); return; }
      if (mod && k === 'c') { e.preventDefault(); copy(); return; }
      if (mod || !S.doc || S.phase !== 'ready') return;
      if (e.key === ' ') { S.space = true; e.preventDefault(); return; }
      if (e.key === 'Enter') { e.preventDefault(); if (S.mode === 'extend') runExtend(); else removeSelection(); return; }
      if (e.key === 'Escape') { if (S.mode === 'extend') leaveExtend(); else clearSelection(); return; }
      if (k === 't') setTool('tap'); else if (k === 'b') setTool('brush'); else if (k === 'e') setTool('erase'); else if (k === 'm') setTool('move');
      else if (k === 'f') { fitZoom(); scheduleDraw(); } else if (k === '1') $('actual').click();
      else if (k === 'c') toggleCompare();
      else if (k === 'o' && !heldKey) { heldKey = true; holdOn(); }
      else if (e.key === '[' || e.key === ']') { const v = Math.max(4, Math.min(300, Math.round(S.brush * (e.key === ']' ? 1.2 : 1 / 1.2)))); $('brush').value = v; $('brush').dispatchEvent(new Event('input')); }
    });
    window.addEventListener('keyup', (e) => {
      if (e.key === ' ') S.space = false;
      if (e.key.toLowerCase() === 'o' && heldKey) { heldKey = false; holdOff(); }
    });
    window.addEventListener('blur', () => { S.space = false; heldKey = false; if (S.showOrig) holdOff(); });

    // drag and drop a photo anywhere on the window
    let depth = 0;
    window.addEventListener('dragenter', (e) => { e.preventDefault(); depth++; document.body.classList.add('dragging'); });
    window.addEventListener('dragleave', () => { depth = Math.max(0, depth - 1); if (!depth) document.body.classList.remove('dragging'); });
    window.addEventListener('dragover', (e) => e.preventDefault());
    window.addEventListener('drop', async (e) => {
      e.preventDefault(); depth = 0; document.body.classList.remove('dragging');
      const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (!f || S.phase === 'busy') return;
      const p = window.pc.pathForFile(f);
      if (p) handleOpened(await window.pc.openImage(p));
    });
  }

  async function init() {
    wire(); wireView();
    window.pc.onPhase((p) => {
      if (S.phase !== 'busy') return;
      if (p.phase === 'loading') $('busySub').textContent = 'Starting the fill model (the first edit takes about 10 seconds longer)…';
    });
    window.pc.onOpened((r) => handleOpened(r));
    setTool('tap');
    renderHistory();
    setPhase('empty');
    try {
      const e = await window.pc.engine();
      if (!e.ok) { $('engineWarn').textContent = e.problems.join(' '); $('engineWarn').hidden = false; }
    } catch { /* ignore */ }
  }

  // test hooks (the window tests drive the real controls; these only read state or convert coordinates)
  window.__app = {
    S, C, cv, handleOpened, drawView, ensureEmbedding,
    toWindow: (ix, iy) => { const r = $('view').getBoundingClientRect(); const p = fromDoc(ix, iy); return { x: Math.round(r.left + p.x), y: Math.round(r.top + p.y) }; },
    viewPixel: (ix, iy) => {
      const c = $('view'); const dpr = window.devicePixelRatio || 1; const p = fromDoc(ix, iy);
      const d = c.getContext('2d').getImageData(Math.round(p.x * dpr), Math.round(p.y * dpr), 1, 1).data;
      return [d[0], d[1], d[2], d[3]];
    },
    docPixel: (x, y) => { const o = (y * S.doc.w + x) * 4; return Array.from(S.doc.rgba.subarray(o, o + 4)); },
    docHash: () => C.hash(S.doc.rgba),
    docBase64: () => { let s = ''; const b = S.doc.rgba; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000)); return btoa(s); },
    maskCount: () => C.maskCount(S.mask),
    maskAt: (x, y) => S.mask[y * S.doc.w + x],
    edgeHandle: (side) => { const m = S.ext.m; const r = $('view').getBoundingClientRect(); const a = fromDoc(-m.l, -m.t); const b = fromDoc(S.doc.w + m.r, S.doc.h + m.b); const mx = (a.x + b.x) / 2; const my = (a.y + b.y) / 2; const p = { l: [a.x, my], r: [b.x, my], t: [mx, a.y], b: [mx, b.y] }[side]; return { x: Math.round(r.left + p[0]), y: Math.round(r.top + p[1]) }; },
  };
  init();
})();
