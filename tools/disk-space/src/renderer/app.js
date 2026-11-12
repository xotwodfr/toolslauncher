'use strict';
(() => {
  const DT = window.DiskTypes;
  const TM = window.Treemap;
  const ds = window.ds;
  const $ = (id) => document.getElementById(id);
  const el = (tag, attrs, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) { if (v === false || v == null) continue; if (k === 'class') n.className = v; else n.setAttribute(k, v === true ? '' : v); }
    for (const kid of kids) if (kid != null) n.append(kid);
    return n;
  };
  const SEP = ds.sep;
  const OTHER = DT.OTHER;
  const APPS = DT.GROUPS.indexOf('apps');

  const OPTS_KEY = 'diskspace.options';
  const loadOpts = () => { const d = { oneDrive: true, view: 'map' }; try { return { ...d, ...JSON.parse(localStorage.getItem(OPTS_KEY) || '{}') }; } catch { return d; } };
  const saveOpts = () => { try { localStorage.setItem(OPTS_KEY, JSON.stringify(S.opts)); } catch { /* fine */ } };

  const S = {
    opts: loadOpts(), scanning: false, subScanning: false, result: null, root: null, view: null, sel: null, largest: [], exts: [],
    extsStale: false, stats: null, live: null, rects: [], hover: null, sort: { by: 'size', dir: -1 }, expanded: new Set(), drives: [],
  };

  // ---- formatting ----------------------------------------------------------------------------------------------------
  const fmt = (b) => {
    if (!(b > 0)) return '0 bytes';
    const u = ['bytes', 'KB', 'MB', 'GB', 'TB', 'PB']; let i = 0; let v = b;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    return i === 0 ? `${v} bytes` : `${v.toFixed(v < 10 ? 2 : v < 100 ? 1 : 0)} ${u[i]}`;
  };
  const num = (n) => Number(n || 0).toLocaleString('en-US');
  const pct = (a, b) => (b > 0 ? (a / b) * 100 : 0);
  const pctText = (p) => (p >= 10 ? p.toFixed(0) : p >= 0.1 ? p.toFixed(1) : p > 0 ? '<0.1' : '0') + ' %';
  const plural = (n, w) => `${num(n)} ${w}${n === 1 ? '' : 's'}`;

  let toastTimer = null;
  function toast(text, err = false) {
    const t = $('toast'); t.textContent = text; t.className = 'toast' + (err ? ' err' : ''); t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 4500);
  }
  function banner(text) { const b = $('banner'); b.textContent = text || ''; b.hidden = !text; }

  // ---- the tree --------------------------------------------------------------------------------------------------------
  const isDir = (n) => !!(n && n.c);
  function link(node, parent) {
    // parents for every node (iterative: trees can be deep)
    node.parent = parent || null;
    const stack = [node];
    while (stack.length) { const n = stack.pop(); if (n.c) for (const c of n.c) { c.parent = n; if (c.c) stack.push(c); } }
  }
  function pathOf(n) {
    if (n.path) return n.path; // items from the largest-files list
    const names = [];
    for (let x = n; x; x = x.parent) names.push(x.n);
    names.reverse();
    let p = names[0];
    for (const name of names.slice(1)) p = p.endsWith(SEP) ? p + name : p + SEP + name;
    return p;
  }
  /** the node for an absolute path, or null when it is not in the tree (a small file folded into "smaller files") */
  function nodeAt(p) {
    const root = S.root; if (!root) return null;
    const rp = root.n;
    if (p === rp) return root;
    const pre = rp.endsWith(SEP) ? rp : rp + SEP;
    if (!p.startsWith(pre)) return null;
    let n = root;
    for (const name of p.slice(pre.length).split(SEP)) { if (!n.c) return null; n = n.c.find((c) => c.n === name); if (!n) return null; }
    return n;
  }
  const inside = (p, dirPath) => { const pre = dirPath.endsWith(SEP) ? dirPath : dirPath + SEP; return p === dirPath || p.startsWith(pre); };
  function addUp(from, ds_, df, dd, dg) {
    for (let a = from; a; a = a.parent) { a.s += ds_; a.f += df; a.d += dd; if (dg) for (let g = 0; g < dg.length; g++) a.g[g] += dg[g]; }
  }
  function resortParent(p) { if (p && p.c) p.c.sort((a, b) => b.s - a.s); }

  // ---- start page ------------------------------------------------------------------------------------------------------
  async function loadDrives() {
    const box = $('drives');
    let list = [];
    try { list = await ds.drives(); } catch { list = []; }
    S.drives = list;
    box.textContent = '';
    if (!list.length) { box.append(el('span', { class: 'muted' }, 'No drives could be listed. Choose a folder instead.')); return; }
    for (const d of list) {
      const used = d.total - d.free;
      const p = pct(used, d.total);
      const fill = el('i'); fill.style.width = p.toFixed(1) + '%';
      const btn = el('button', { class: 'btn small primary', 'aria-label': `Scan ${d.label}` }, 'Scan');
      btn.addEventListener('click', () => startScan(d.path));
      box.append(el('div', { class: 'item drive', 'data-path': d.path },
        el('span', { class: 'name trunc' }, d.label), btn,
        el('span', { class: 'where trunc' }, d.path + (d.fs ? ` · ${d.fs}` : '')),
        el('div', { class: 'bar' + (p > 90 ? ' full' : ''), role: 'img', 'aria-label': `${pctText(p)} used` }, fill),
        el('span', { class: 'free' }, `${fmt(d.free)} free of ${fmt(d.total)} · ${pctText(p)} used`)));
    }
  }
  async function pickAndScan() { const p = await ds.pickFolder(); if (p) startScan(p); }

  // ---- scanning --------------------------------------------------------------------------------------------------------
  function showResults(on) { $('start').hidden = on; $('results').hidden = !on; $('newScan').hidden = !on || S.scanning; }
  function setBusy(on) {
    S.scanning = on;
    $('prog').hidden = !on; $('cancel').hidden = !on; $('csv').hidden = on || !S.root;
    $('pick').disabled = on; $('newScan').hidden = on || !S.root;
    $('current').hidden = !on;
    renderSelection();
  }
  async function startScan(p) {
    if (S.scanning) return;
    banner('');
    S.root = null; S.view = null; S.sel = null; S.live = null; S.largest = []; S.exts = []; S.extsStale = false; S.stats = null; S.expanded.clear();
    showResults(true);
    setBusy(true);
    $('status').textContent = 'Starting…';
    $('skipped').hidden = true;
    S.scanPath = p;
    renderCrumbs(); draw(); renderTables();
    let r;
    try { r = await ds.scan({ path: p, oneDrive: S.opts.oneDrive }); } catch (e) { r = { ok: false, error: String((e && e.message) || e) }; }
    setBusy(false);
    if (!r.ok) {
      $('status').textContent = '';
      banner('The scan could not run: ' + r.error);
      showResults(false);
      return;
    }
    const res = JSON.parse(r.json);
    link(res.tree, null);
    S.result = res; S.root = res.tree; S.view = res.tree; S.live = null;
    S.hard = new Map(res.hard || []);
    S.largest = res.largest; S.exts = res.exts; S.stats = res.stats; S.ms = res.ms; S.partial = res.partial;
    setBusy(false);
    renderStatus();
    renderAll();
  }
  ds.onProgress((p) => {
    if (p.subtree) { $('status').textContent = `Rescanning… ${plural(p.files, 'file')} · ${fmt(p.bytes)}`; return; }
    if (!S.scanning) return;
    $('status').textContent = `Scanning… ${plural(p.files, 'file')} in ${plural(p.dirs, 'folder')} · ${fmt(p.bytes)}${p.skipped ? ` · ${num(p.skipped)} could not be read` : ''}`;
    $('current').textContent = p.current || '';
  });
  ds.onSnapshot((s) => {
    if (!S.scanning) return;
    try { const t = JSON.parse(s.tree); link(t, null); S.live = t; draw(); renderCrumbs(); } catch { /* skip a bad frame */ }
  });
  function renderStatus() {
    const st = S.stats; const root = S.root;
    if (!st || !root) return;
    const head = S.partial ? 'Stopped early: ' : 'Scanned ';
    $('status').textContent = `${head}${plural(root.f, 'file')} in ${plural(root.d, 'folder')} · ${fmt(root.s)} on disk${S.ms != null ? ` · ${S.ms < 1000 ? 'under a second' : (S.ms / 1000).toFixed(1) + ' s'}` : ''}`
      + (st.hardlinks ? ` · ${plural(st.hardlinks, 'extra hard link')} counted once` : '') + (st.links ? ` · ${plural(st.links, 'link')} not followed` : '')
      + (st.otherDrives ? ` · ${plural(st.otherDrives, 'other drive')} skipped` : '');
    const sk = $('skipped');
    sk.hidden = !st.skipped;
    sk.textContent = st.skipped ? `${plural(st.skipped, 'item')} could not be read` : '';
    $('csv').hidden = false;
  }

  // ---- views -------------------------------------------------------------------------------------------------------------
  function setTab(v) {
    S.opts.view = v; saveOpts();
    for (const b of document.querySelectorAll('.tabs button')) b.setAttribute('aria-selected', String(b.dataset.view === v));
    for (const id of ['map', 'tree', 'big', 'types']) $('v-' + id).hidden = id !== v;
    if (v === 'map') draw(); else renderTables();
  }
  function setView(n) {
    if (!isDir(n)) n = n.parent || S.root;
    if (!n || n.l === 'drive') return;
    S.view = n;
    renderAll();
  }
  function renderAll() { renderCrumbs(); draw(); renderTables(); renderLegend(); renderSelection(); }

  function renderCrumbs() {
    const nav = $('crumbs'); nav.textContent = '';
    const v = S.view || S.live;
    if (!v) { if (S.scanPath) nav.append(el('button', { 'aria-current': 'page' }, S.scanPath)); return; }
    const chain = []; for (let x = v; x; x = x.parent) chain.unshift(x);
    chain.forEach((n, i) => {
      if (i) nav.append(el('span', { class: 'sep', 'aria-hidden': 'true' }, '›'));
      const b = el('button', { title: pathOf(n), 'aria-current': i === chain.length - 1 ? 'page' : null }, i === 0 ? '\u200e' + n.n + '\u200e' : n.n);
      b.addEventListener('click', () => { if (S.root) setView(n); });
      nav.append(b);
    });
  }

  // ---- the map -----------------------------------------------------------------------------------------------------------
  const canvas = $('map');
  const ctx = canvas.getContext('2d');
  const HEADER = 16;
  const shade = (hex, f) => {
    const n = parseInt(hex.slice(1), 16); let r = (n >> 16) & 255; let g = (n >> 8) & 255; let b = n & 255;
    if (f < 0) { r *= 1 + f; g *= 1 + f; b *= 1 + f; } else { r += (255 - r) * f; g += (255 - g) * f; b += (255 - b) * f; }
    return `rgb(${r | 0},${g | 0},${b | 0})`;
  };
  const dominant = (n) => { if (!n.g) return n.k == null ? OTHER : n.k; let best = OTHER; let max = -1; n.g.forEach((v, i) => { if (v > max) { max = v; best = i; } }); return best; };
  function childrenOf(n) {
    const kids = n.c ? n.c.filter((c) => c.s > 0) : [];
    if (n.o && n.o.s > 0) kids.push({ n: `${num(n.o.n)} smaller files`, s: n.o.s, k: OTHER, agg: true, parent: n, count: n.o.n });
    return kids;
  }
  function layout(rootNode, W, H) {
    const rects = [];
    let budget = 60000;
    // breadth first, so when there is too much to draw it is the deepest, smallest boxes that are left out
    const queue = [[rootNode, { x: 0, y: 0, w: W, h: H }, 0]];
    for (let qi = 0; qi < queue.length && budget > 0; qi++) {
      const [n, r, depth] = queue[qi];
      if (depth > 0) { rects.push({ ...r, node: n, depth, header: false }); budget--; }
      if (!isDir(n) || n.l === 'drive' || n.u) continue;
      let inner = r;
      if (depth > 0) {
        if (r.w > 50 && r.h > 34) { rects[rects.length - 1].header = true; inner = { x: r.x + 2, y: r.y + HEADER, w: r.w - 4, h: r.h - HEADER - 2 }; }
        else inner = { x: r.x + 1, y: r.y + 1, w: r.w - 2, h: r.h - 2 };
      }
      if (inner.w < 3 || inner.h < 3) continue;
      const kids = childrenOf(n);
      const boxes = TM.squarify(kids.map((k) => k.s), inner);
      for (let i = 0; i < kids.length; i++) {
        const b = boxes[i];
        if (b.w * b.h < 3) continue;
        queue.push([kids[i], b, depth + 1]);
      }
    }
    return rects;
  }
  function draw() {
    if ($('v-map').hidden) return;
    const wrap = $('v-map');
    const dpr = window.devicePixelRatio || 1;
    const W = Math.max(10, wrap.clientWidth); const H = Math.max(10, wrap.clientHeight);
    if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) { canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr); }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#101013'; ctx.fillRect(0, 0, W, H);
    const v = S.view || S.live;
    if (!v || !(v.s > 0)) {
      S.rects = [];
      ctx.fillStyle = '#8e8e98'; ctx.font = '13px system-ui, sans-serif'; ctx.textAlign = 'center';
      ctx.fillText(S.scanning ? 'The map appears as soon as the first files are found…' : 'Nothing takes up space here.', W / 2, H / 2);
      ctx.textAlign = 'left';
      return;
    }
    S.rects = layout(v, W, H);
    ctx.font = '11px system-ui, "Segoe UI", sans-serif';
    ctx.textBaseline = 'middle';
    for (const r of S.rects) {
      const n = r.node;
      if (isDir(n) && !r.header && (r.w < 6 || r.h < 6 || n.u || n.l === 'drive' || !(n.c && n.c.length))) {
        // a folder too small to open up: its main colour
        ctx.fillStyle = n.l === 'drive' || n.u ? '#2a2a31' : shade(DT.COLORS[dominant(n)], -0.35);
        ctx.fillRect(r.x, r.y, r.w, r.h);
        continue;
      }
      if (isDir(n)) {
        ctx.fillStyle = r.depth % 2 ? '#1b1b20' : '#15151a';
        ctx.fillRect(r.x, r.y, r.w, r.h);
        ctx.strokeStyle = '#3a3a42'; ctx.lineWidth = 1;
        ctx.strokeRect(r.x + 0.5, r.y + 0.5, r.w - 1, r.h - 1);
        if (r.header) {
          ctx.fillStyle = S.hover === n ? '#2e2e36' : '#212127';
          ctx.fillRect(r.x + 1, r.y + 1, r.w - 2, HEADER - 2);
          ctx.save(); ctx.beginPath(); ctx.rect(r.x + 4, r.y, r.w - 8, HEADER); ctx.clip();
          ctx.fillStyle = '#f3f3f4';
          ctx.fillText(`${n.n}  ·  ${fmt(n.s)}`, r.x + 5, r.y + HEADER / 2);
          ctx.restore();
        }
        continue;
      }
      const base = DT.COLORS[n.k == null ? OTHER : n.k];
      const g = ctx.createLinearGradient(r.x, r.y, r.x + r.w, r.y + r.h);
      g.addColorStop(0, shade(base, n.agg ? -0.45 : 0.12)); g.addColorStop(1, shade(base, n.agg ? -0.6 : -0.28));
      ctx.fillStyle = g;
      ctx.fillRect(r.x, r.y, r.w, r.h);
      if (r.w > 3 && r.h > 3) { ctx.strokeStyle = 'rgba(11,11,13,.85)'; ctx.lineWidth = 1; ctx.strokeRect(r.x + 0.5, r.y + 0.5, r.w - 1, r.h - 1); }
      if (r.w > 70 && r.h > 22) {
        ctx.save(); ctx.beginPath(); ctx.rect(r.x + 3, r.y, r.w - 6, r.h); ctx.clip();
        ctx.fillStyle = 'rgba(11,11,13,.92)';
        ctx.fillText(n.n, r.x + 5, r.y + 10);
        if (r.h > 36) ctx.fillText(fmt(n.s), r.x + 5, r.y + 24);
        ctx.restore();
      }
    }
    // the selection on top
    const sel = S.sel && S.rects.find((r) => r.node === S.sel);
    if (sel) { ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 2; ctx.strokeRect(sel.x + 1, sel.y + 1, sel.w - 2, sel.h - 2); }
  }
  function hit(x, y) {
    for (let i = S.rects.length - 1; i >= 0; i--) { const r = S.rects[i]; if (x >= r.x && y >= r.y && x < r.x + r.w && y < r.y + r.h) return r; }
    return null;
  }
  const posIn = (e) => { const b = canvas.getBoundingClientRect(); return { x: e.clientX - b.left, y: e.clientY - b.top }; };
  canvas.addEventListener('mousemove', (e) => {
    const { x, y } = posIn(e);
    const r = hit(x, y);
    const tip = $('tip');
    if (!r) { tip.hidden = true; if (S.hover) { S.hover = null; draw(); } return; }
    const n = r.node;
    const onHeader = r.header && y < r.y + HEADER;
    const v = S.view || S.live;
    tip.textContent = '';
    tip.append(el('div', {}, el('span', { class: 's' }, fmt(n.s)), ` · ${pctText(pct(n.s, v.s))} of ${v.n}`),
      el('div', {}, n.agg ? `${n.n} (each too small to show)` : n.n + (isDir(n) ? ` (${plural(n.f, 'file')})` : '')),
      el('div', { class: 'p' }, n.agg ? pathOf(n.parent) : pathOf(n)));
    if (isDir(n) && onHeader && S.root) tip.append(el('div', { class: 'p' }, 'Click to go into this folder'));
    if (n.u) tip.append(el('div', { class: 'p' }, 'Not scanned (the scan was stopped)'));
    if (n.l === 'drive') tip.append(el('div', { class: 'p' }, 'Another drive mounted here (not scanned)'));
    if (n.e) tip.append(el('div', { class: 'p' }, 'Could not be read'));
    tip.hidden = false;
    const wrap = $('v-map').getBoundingClientRect();
    const tw = tip.offsetWidth; const th = tip.offsetHeight;
    tip.style.left = Math.min(x + 14, wrap.width - tw - 6) + 'px';
    tip.style.top = (y + 18 + th > wrap.height ? y - th - 10 : y + 18) + 'px';
    const hv = isDir(n) && onHeader ? n : null;
    if (hv !== S.hover) { S.hover = hv; draw(); }
  });
  canvas.addEventListener('mouseleave', () => { $('tip').hidden = true; if (S.hover) { S.hover = null; draw(); } });
  canvas.addEventListener('click', (e) => {
    if (!S.root) return;
    const { x, y } = posIn(e);
    const r = hit(x, y); if (!r) return;
    if (isDir(r.node) && r.header && y < r.y + HEADER) { setView(r.node); return; }
    select(r.node.agg ? r.node.parent : r.node);
  });
  canvas.addEventListener('dblclick', (e) => {
    if (!S.root) return;
    const { x, y } = posIn(e);
    const r = hit(x, y); if (!r) return;
    let n = r.node.agg ? r.node.parent : r.node;
    if (!isDir(n)) n = n.parent;
    // go one level at a time: into the child of the current view that holds the clicked item
    while (n && n.parent && n.parent !== S.view) n = n.parent;
    if (n && n !== S.view) setView(n);
  });
  new ResizeObserver(() => draw()).observe($('v-map'));

  // ---- selection and actions ---------------------------------------------------------------------------------------------
  function select(n) { S.sel = n; renderSelection(); draw(); markRows(); }
  function renderSelection() {
    const n = S.sel;
    $('selEmpty').hidden = !!n; $('selInfo').hidden = !n;
    if (!n) return;
    const p = pathOf(n);
    $('selName').textContent = n.parent || n.path ? n.n : p;
    $('selPath').textContent = p;
    $('selSize').textContent = fmt(n.s);
    const v = S.view || S.root;
    const bits = [];
    if (isDir(n)) bits.push(plural(n.f, 'file'), plural(n.d, 'folder'));
    else bits.push(DT.LABELS[n.k == null ? OTHER : n.k]);
    if (v && v.s && inside(p, pathOf(v))) bits.push(`${pctText(pct(n.s, v.s))} of ${v.n}`);
    if (S.root && S.root.s && S.root !== v) bits.push(`${pctText(pct(n.s, S.root.s))} of the scan`);
    if (n.e) bits.push('could not be read');
    if (n.u) bits.push('not scanned');
    $('selMeta').textContent = bits.join(' · ');
    const busy = S.scanning || S.subScanning;
    const dir = isDir(n);
    $('aZoom').hidden = !dir; $('aZoom').disabled = busy || n === S.view || n.l === 'drive';
    $('aRescan').hidden = !dir; $('aRescan').disabled = busy || n.l === 'drive';
    $('aOpen').disabled = busy || (!dir && n.k === APPS);
    $('aOpen').title = !dir && n.k === APPS ? 'Programs are not started from here, to be safe' : '';
    for (const id of ['aShow', 'aCopy']) $(id).disabled = false;
    $('aTrash').disabled = busy || n === S.root;
  }
  async function act(fn, okText) {
    const n = S.sel; if (!n) return;
    const r = await fn(pathOf(n), n);
    if (r && r.ok && okText) toast(okText);
    else if (r && !r.ok && !r.cancelled) toast(r.error, true);
    return r;
  }
  $('aShow').addEventListener('click', () => act((p) => ds.show(p)));
  $('aOpen').addEventListener('click', () => act((p) => ds.open(p)));
  $('aCopy').addEventListener('click', () => act((p) => ds.copy(p), 'Path copied'));
  $('aZoom').addEventListener('click', () => { if (S.sel && isDir(S.sel)) setView(S.sel); });
  $('aTrash').addEventListener('click', async () => {
    const n = S.sel; if (!n) return;
    const r = await ds.trash(pathOf(n), n.s, isDir(n) ? n.f : 0);
    if (!r.ok) { if (!r.cancelled) toast(r.error, true); return; }
    removeNode(n);
    toast(`Moved to the Recycle Bin: ${n.n} (${fmt(n.s)}).`);
  });
  $('aRescan').addEventListener('click', async () => {
    const n = S.sel; if (!n || !isDir(n) || S.subScanning) return;
    S.subScanning = true; renderSelection();
    $('prog').hidden = false;
    let r;
    const sub = pathOf(n);
    // hard-linked files already counted outside this folder must not be counted again
    const seen = []; if (S.hard) for (const [k, p] of S.hard) if (!inside(p, sub)) seen.push(k);
    try { r = await ds.scan({ path: sub, subtree: true, oneDrive: S.opts.oneDrive, seen }); } catch (e) { r = { ok: false, error: String(e.message || e) }; }
    S.subScanning = false; $('prog').hidden = true;
    if (!r.ok) { toast('The folder could not be rescanned: ' + r.error, true); renderStatus(); renderSelection(); return; }
    replaceNode(n, JSON.parse(r.json));
    renderStatus();
    toast(`Rescanned ${n.n}: ${fmt(S.sel ? S.sel.s : 0)}.`);
  });

  /** take a node out after it went to the Recycle Bin */
  function removeNode(n) {
    const p = pathOf(n);
    const parent = n.parent;
    const real = parent && parent.c && parent.c.includes(n) ? n : nodeAt(p);
    if (real && real.parent) {
      const par = real.parent;
      par.c.splice(par.c.indexOf(real), 1);
      const dg = new Array(DT.GROUPS.length).fill(0);
      if (isDir(real)) real.g.forEach((v, i) => { dg[i] = -v; }); else dg[real.k == null ? OTHER : real.k] = -real.s;
      addUp(par, -real.s, isDir(real) ? -real.f : -1, isDir(real) ? -(real.d + 1) : 0, dg);
      if (!isDir(real)) { const ext = S.exts.find((x) => x.e === DT.extOf(real.n)); if (ext) { ext.s -= real.s; ext.n--; } } else S.extsStale = true;
      if (S.view === real || (S.view && inside(pathOf(S.view), p))) S.view = par;
    } else if (n.path) {
      // a small file that was only in the largest-files list: fix the totals of its folder
      const par = nodeAt(n.path.slice(0, n.path.lastIndexOf(SEP)) || SEP);
      if (par) {
        const dg = new Array(DT.GROUPS.length).fill(0); dg[n.k] = -n.s;
        if (par.o) { par.o.n--; par.o.s -= n.s; }
        addUp(par, -n.s, -1, 0, dg);
      }
      const ext = S.exts.find((x) => x.e === DT.extOf(n.n)); if (ext) { ext.s -= n.s; ext.n--; }
    }
    S.largest = S.largest.filter((f) => !inside(f.p, p));
    S.sel = null;
    renderStatus();
    renderAll();
  }
  /** put a rescanned folder in place of the old one */
  function replaceNode(old, res) {
    const fresh = res.tree;
    fresh.n = old.n;
    const p = pathOf(old);
    const par = old.parent;
    if (par) {
      const dg = fresh.g.map((v, i) => v - old.g[i]);
      par.c[par.c.indexOf(old)] = fresh;
      link(fresh, par);
      addUp(par, fresh.s - old.s, fresh.f - old.f, fresh.d - old.d, dg);
      resortParent(par);
    } else {
      link(fresh, null); fresh.n = old.n; S.root = fresh;
    }
    if (S.hard) { for (const [k, hp] of [...S.hard]) if (inside(hp, p)) S.hard.delete(k); for (const [k, hp] of res.hard || []) S.hard.set(k, hp); }
    S.largest = S.largest.filter((f) => !inside(f.p, p)).concat(res.largest).sort((a, b) => b.s - a.s).slice(0, 200);
    S.extsStale = true;
    if (S.view === old) S.view = fresh;
    else if (S.view && inside(pathOf(S.view), p)) S.view = nodeAt(pathOf(S.view)) || fresh;
    if (S.sel === old) S.sel = fresh;
    S.stats.skipped += res.stats.skipped;
    renderAll();
  }

  // ---- lists -------------------------------------------------------------------------------------------------------------
  function renderTables() {
    if (!$('v-tree').hidden) renderTree();
    if (!$('v-big').hidden) renderBig();
    if (!$('v-types').hidden) renderTypes();
  }
  const cmp = {
    name: (a, b) => a.n.localeCompare(b.n, undefined, { numeric: true, sensitivity: 'base' }),
    size: (a, b) => a.s - b.s,
    files: (a, b) => (a.f || (a.c ? 0 : 1)) - (b.f || (b.c ? 0 : 1)) || a.s - b.s,
    dirs: (a, b) => (a.d || 0) - (b.d || 0) || a.s - b.s,
  };
  const pbar = (p, color) => { const i = el('i'); i.style.width = Math.min(100, p).toFixed(2) + '%'; if (color) i.style.background = color; return el('div', { class: 'pbar' }, el('div', { class: 'b' }, i), el('span', { class: 'v' }, pctText(p))); };
  const swatch = (k) => { const s = el('span', { class: 'sw' }); s.style.background = DT.COLORS[k]; return s; };
  function renderTree() {
    const body = $('treeRows'); body.textContent = '';
    const v = S.view; if (!v) return;
    for (const th of document.querySelectorAll('#v-tree th')) { const b = th.querySelector('button.sort'); if (b) th.setAttribute('aria-sort', b.dataset.sort === S.sort.by ? (S.sort.dir > 0 ? 'ascending' : 'descending') : 'none'); }
    const rows = [];
    const LIMIT = 400;
    const visit = (n, depth) => {
      const kids = childrenOf(n).filter((k) => !k.agg).concat(n.o ? [{ n: `${num(n.o.n)} smaller files`, s: n.o.s, k: OTHER, agg: true, parent: n }] : []);
      const list = kids.filter((k) => !k.agg).sort((a, b) => S.sort.dir * cmp[S.sort.by](a, b) || cmp.name(a, b));
      const agg = kids.find((k) => k.agg);
      if (agg) list.push(agg);
      for (const k of list.slice(0, LIMIT)) {
        rows.push([k, depth, n]);
        if (isDir(k) && S.expanded.has(k) && rows.length < 5000) visit(k, depth + 1);
      }
      if (list.length > LIMIT) rows.push([{ n: `${num(list.length - LIMIT)} more items (open the folder to see them)`, s: 0, more: true }, depth, n]);
    };
    visit(v, 0);
    // empty folders and zero-byte files too (the map leaves them out)
    for (const [k, depth, par] of rows) {
      const dir = isDir(k);
      const tog = el('button', { class: 'tog' + (dir && k.c && k.c.length && !k.u && k.l !== 'drive' ? '' : ' none'), 'aria-label': (S.expanded.has(k) ? 'Close ' : 'Open ') + k.n, 'aria-expanded': dir ? String(S.expanded.has(k)) : null, tabindex: dir ? '0' : '-1' }, S.expanded.has(k) ? '▾' : '▸');
      const icon = dir ? el('span', { class: 'dirsw' }) : swatch(k.k == null ? OTHER : k.k);
      const name = el('div', { class: 'nm' }, tog, icon, el('span', { class: 't' + (k.agg || k.more ? ' dim' : '') }, k.n + (k.e ? ' (could not be read)' : '') + (k.u ? ' (not scanned)' : '') + (k.l === 'drive' ? ' (another drive)' : '')));
      name.style.paddingLeft = depth * 18 + 'px';
      const tr = el('tr', { 'data-path': k.agg || k.more ? '' : pathOf(k) },
        el('td', {}, name),
        el('td', { class: 'c-size' }, k.more ? '' : fmt(k.s)),
        el('td', { class: 'c-pct' }, k.more ? '' : pbar(pct(k.s, par.s))),
        el('td', { class: 'c-num' }, dir ? num(k.f) : k.agg ? num(k.count || (par.o && par.o.n)) : k.more ? '' : '1'),
        el('td', { class: 'c-num' }, dir ? num(k.d) : ''));
      tr.node = k;
      if (k === S.sel) tr.classList.add('sel');
      tog.addEventListener('click', (e) => { e.stopPropagation(); if (!dir) return; if (S.expanded.has(k)) S.expanded.delete(k); else S.expanded.add(k); renderTree(); });
      if (!k.more) {
        tr.addEventListener('click', () => select(k.agg ? par : k));
        tr.addEventListener('dblclick', () => { if (dir) setView(k); });
      }
      body.append(tr);
    }
    if (!rows.length) body.append(el('tr', {}, el('td', { colspan: '5', class: 'dim' }, 'This folder is empty.')));
  }
  function markRows() { for (const tr of document.querySelectorAll('#treeRows tr, #bigRows tr')) tr.classList.toggle('sel', !!S.sel && (tr.node === S.sel || (S.sel.path && tr.node && tr.node.path === S.sel.path) || (tr.node && tr.node.path && !S.sel.path && tr.node.path === pathOf(S.sel)))); }
  function bigInView() {
    const v = S.view; if (!v) return [];
    const vp = pathOf(v);
    return S.largest.filter((f) => inside(f.p, vp));
  }
  function renderBig() {
    const body = $('bigRows'); body.textContent = '';
    const list = bigInView();
    list.forEach((f, i) => {
      const cut = f.p.lastIndexOf(SEP);
      const item = nodeAt(f.p) || { n: f.p.slice(cut + 1), s: f.s, k: f.k, path: f.p };
      if (!item.path) item.path = f.p;
      const tr = el('tr', { 'data-path': f.p },
        el('td', { class: 'muted' }, String(i + 1)),
        el('td', { title: f.p }, el('div', { class: 'nm' }, swatch(f.k), el('span', { class: 't' }, f.p.slice(cut + 1)))),
        el('td', { class: 'muted', title: f.p.slice(0, cut) }, f.p.slice(0, cut) || SEP),
        el('td', {}, DT.LABELS[f.k]),
        el('td', { class: 'c-size' }, fmt(f.s)));
      tr.node = item;
      tr.addEventListener('click', () => select(item));
      body.append(tr);
    });
    if (!list.length) body.append(el('tr', {}, el('td', { colspan: '5', class: 'dim' }, 'No files here.')));
    markRows();
  }
  function renderTypes() {
    const v = S.view; const body = $('groupRows'); body.textContent = '';
    if (!v) return;
    $('typesTitle').textContent = `In ${v.n}`;
    const order = v.g.map((s, k) => ({ s, k })).sort((a, b) => b.s - a.s);
    for (const { s, k } of order) {
      body.append(el('tr', { 'data-group': DT.GROUPS[k] },
        el('td', {}, el('div', { class: 'nm' }, swatch(k), el('span', { class: 't' }, DT.LABELS[k]))),
        el('td', { class: 'c-size' }, fmt(s)),
        el('td', { class: 'c-pct' }, pbar(pct(s, v.s), DT.COLORS[k]))));
    }
    const eb = $('extRows'); eb.textContent = '';
    $('extNote').textContent = S.extsStale ? '(whole scan, before the latest change; scan again to refresh)' : '(whole scan)';
    for (const x of S.exts.slice(0, 60)) {
      eb.append(el('tr', {}, el('td', {}, x.e ? '.' + x.e : '(none)'), el('td', {}, el('div', { class: 'nm' }, swatch(x.k), el('span', { class: 't' }, DT.LABELS[x.k]))), el('td', { class: 'c-num' }, num(x.n)), el('td', { class: 'c-size' }, fmt(x.s))));
    }
  }
  function renderLegend() {
    const ul = $('legend'); ul.textContent = '';
    const v = S.view;
    DT.GROUPS.forEach((g, k) => ul.append(el('li', {}, swatch(k), DT.LABELS[k], el('span', { class: 'v' }, v ? fmt(v.g[k]) : ''))));
  }
  for (const b of document.querySelectorAll('#v-tree button.sort')) {
    b.addEventListener('click', () => {
      const by = b.dataset.sort;
      if (S.sort.by === by) S.sort.dir = -S.sort.dir; else { S.sort.by = by; S.sort.dir = by === 'name' ? 1 : -1; }
      renderTree();
    });
  }

  // ---- CSV ---------------------------------------------------------------------------------------------------------------
  const csvCell = (v) => { const s = String(v == null ? '' : v); return /[",\r\n]/.test(s) || /^[=+\-@\t]/.test(s) ? `"${(/^[=+\-@\t]/.test(s) ? "'" : '') + s.replace(/"/g, '""')}"` : s; };
  const csvLine = (a) => a.map(csvCell).join(',');
  function buildCsv() {
    const v = S.view; if (!v) return null;
    const tab = S.opts.view;
    const lines = [];
    if (tab === 'big') {
      lines.push(csvLine(['Path', 'Size on disk (bytes)', 'Size', 'Type']));
      for (const f of bigInView()) lines.push(csvLine([f.p, f.s, fmt(f.s), DT.LABELS[f.k]]));
      return { text: lines.join('\r\n') + '\r\n', name: 'largest-files.csv' };
    }
    if (tab === 'types') {
      lines.push(csvLine(['Kind', 'Name', 'Type', 'Files', 'Size on disk (bytes)', 'Size', '% of folder']));
      v.g.forEach((s, k) => lines.push(csvLine(['type', DT.LABELS[k], DT.LABELS[k], '', s, fmt(s), pct(s, v.s).toFixed(2)])));
      for (const x of S.exts) lines.push(csvLine(['extension', x.e ? '.' + x.e : '(none)', DT.LABELS[x.k], x.n, x.s, fmt(x.s), '']));
      return { text: lines.join('\r\n') + '\r\n', name: 'file-types.csv' };
    }
    lines.push(csvLine(['Path', 'Kind', 'Size on disk (bytes)', 'Size', '% of folder', 'Files', 'Folders']));
    lines.push(csvLine([pathOf(v), 'scanned folder', v.s, fmt(v.s), '100.00', v.f, v.d]));
    for (const k of v.c) lines.push(csvLine([pathOf(k), isDir(k) ? 'folder' : DT.LABELS[k.k], k.s, fmt(k.s), pct(k.s, v.s).toFixed(2), isDir(k) ? k.f : 1, isDir(k) ? k.d : '']));
    if (v.o) lines.push(csvLine([pathOf(v) + SEP + '…', `${v.o.n} smaller files`, v.o.s, fmt(v.o.s), pct(v.o.s, v.s).toFixed(2), v.o.n, '']));
    return { text: lines.join('\r\n') + '\r\n', name: 'disk-space.csv' };
  }
  $('csv').addEventListener('click', async () => {
    const c = buildCsv(); if (!c) return;
    try { const r = await ds.saveCsv(c.text, c.name); if (r.ok) toast('Saved ' + r.path); } catch (e) { toast('Could not save: ' + (e.message || e), true); }
  });

  // ---- skipped list ------------------------------------------------------------------------------------------------------
  $('skipped').addEventListener('click', () => {
    const ul = $('skipList'); ul.textContent = '';
    for (const e of (S.stats && S.stats.errors) || []) ul.append(el('li', {}, e.path, el('span', { class: 'why' }, e.message)));
    if (S.stats && S.stats.skipped > S.stats.errors.length) ul.append(el('li', { class: 'muted' }, `…and ${num(S.stats.skipped - S.stats.errors.length)} more`));
    $('skipDlg').showModal();
  });
  $('skipClose').addEventListener('click', () => $('skipDlg').close());

  // ---- wiring ------------------------------------------------------------------------------------------------------------
  $('pick').addEventListener('click', pickAndScan);
  $('pick2').addEventListener('click', (e) => { e.stopPropagation(); pickAndScan(); });
  $('drop').addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pickAndScan(); } });
  $('cancel').addEventListener('click', () => { ds.cancel(); $('status').textContent = 'Stopping…'; });
  $('newScan').addEventListener('click', () => { if (S.scanning) return; S.root = null; S.view = null; S.sel = null; showResults(false); loadDrives(); });
  const od = $('oneDrive'); od.checked = S.opts.oneDrive; od.addEventListener('change', () => { S.opts.oneDrive = od.checked; saveOpts(); });
  for (const b of document.querySelectorAll('.tabs button')) b.addEventListener('click', () => setTab(b.dataset.view));
  document.addEventListener('keydown', (e) => {
    if (e.target && /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
    if ((e.key === 'Backspace' || (e.altKey && e.key === 'ArrowUp')) && S.view && S.view.parent) { e.preventDefault(); setView(S.view.parent); }
  });
  let depth = 0;
  window.addEventListener('dragenter', (e) => { e.preventDefault(); depth++; document.body.classList.add('dragging'); });
  window.addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; document.body.classList.remove('dragging'); } });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', async (e) => {
    e.preventDefault(); depth = 0; document.body.classList.remove('dragging');
    if (S.scanning) return;
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (!f) return;
    const r = await ds.checkFolder(ds.pathForFile(f));
    if (r.ok) startScan(r.path); else toast(r.error, true);
  });

  setTab(S.opts.view || 'map');
  showResults(false);
  loadDrives();
  window.__app = { S, startScan, setView, select, nodeAt, pathOf, layout, fmt, buildCsv, setTab, loadDrives };
})();
