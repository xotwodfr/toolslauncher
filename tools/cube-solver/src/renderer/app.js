import { createView } from './view3d.js';

// The window works the same way for every puzzle module (src/puzzles/<id>.js, see puzzle-core.js): the fill-in map is drawn
// from puzzle.netLayout(), the palette from puzzle.colours, problems come from def.validate, the scanner lays
// puzzle.templates[face] over the picture, and the 3D view and the player use the sticker polygons and the turns.
const K = window.CubeColour;
const REG = window.PuzzleRegistry;
const api = window.cube;
const $ = (id) => document.getElementById(id);
const SVGNS = 'http://www.w3.org/2000/svg';
const el = (tag, attrs, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) { if (v === false || v == null) continue; if (k === 'class') n.className = v; else n.setAttribute(k, v === true ? '' : v); }
  for (const kid of kids) if (kid != null) n.append(kid);
  return n;
};
const svg = (tag, attrs, ...kids) => {
  const n = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs || {})) if (v != null && v !== false) n.setAttribute(k, v);
  for (const kid of kids) if (kid != null) n.append(kid);
  return n;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cap = (s) => String(s).charAt(0).toUpperCase() + String(s).slice(1);
const low = (s) => String(s).toLowerCase();
const pts = (poly) => poly.map(([x, y]) => `${+x.toFixed(4)},${+y.toFixed(4)}`).join(' ');

// ---- the puzzle modules -----------------------------------------------------------------------------------------------------
// The main process says which puzzles are present; each module is loaded with a <script> tag (it registers itself in
// window.Puzzles). One that does not load is left out.
function loadScript(src) {
  return new Promise((resolve) => {
    const s = document.createElement('script');
    s.src = src; s.onload = () => resolve(true); s.onerror = () => resolve(false);
    document.head.append(s);
  });
}
const AVAILABLE = [];
const loaded = new Set();
for (const p of await api.puzzles()) {
  for (const h of p.helpers || []) if (!loaded.has(h)) { loaded.add(h); await loadScript(h); }
  if (!(window.Puzzles && window.Puzzles[p.id])) await loadScript(p.src);
  const def = window.Puzzles && window.Puzzles[p.id];
  if (def && def.puzzle) AVAILABLE.push({ id: p.id, group: p.group, def });
}
const DEFS = Object.fromEntries(AVAILABLE.map((a) => [a.id, a.def]));
const OPTIMAL = new Set(['cube2', 'cuboid332', 'cuboid322', 'pyraminx']);

// ---- small conveniences kept between runs -------------------------------------------------------------------------------
const OPTS_KEY = 'cubesolver.options';
const loadOpts = () => {
  const d = { puzzle: 'cube3', speed: 1, view: 'front', top: 'w', front: 'g', mirror: false, grid: 62 };
  try {
    const o = { ...d, ...JSON.parse(localStorage.getItem(OPTS_KEY) || '{}') };
    if (o.size === 2 && !localStorage.getItem(OPTS_KEY).includes('"puzzle"')) o.puzzle = 'cube2'; // from version 0.1
    delete o.size;
    return o;
  } catch { return d; }
};
const saveOpts = () => { try { localStorage.setItem(OPTS_KEY, JSON.stringify(S.opts)); } catch { /* fine */ } };

const S = {
  opts: loadOpts(),
  id: null,
  colours: {},          // puzzle id -> one colour key (or null) per sticker
  marks: new Set(),     // stickers named by a problem
  unsure: new Set(),    // stickers the scanner was not sure about
  paint: null,
  cursor: 0,
  tab: 'fill',
  solution: null,       // { id, start, moves, stages: [{ title, from, to }] }
  pos: 0,
  playing: false,
  busy: false,
  engine: null,
};
if (!DEFS[S.opts.puzzle]) S.opts.puzzle = AVAILABLE.length ? AVAILABLE[0].id : null;
const def = () => DEFS[S.id];
const P = () => def().puzzle;
const cols = () => S.colours[S.id];
const fixed = () => new Set(def().fixedStickers || []);
const colourName = (k) => (k && P().colours[k] ? low(P().colours[k].name) : 'empty');
/** The colours of the solved puzzle as the user holds it (only the 3x3 has a choice: its centres never move). */
function scheme(d = def()) {
  if (!d.orientation) return undefined;
  const sc = d.orientation.scheme(S.opts.top, S.opts.front);
  return sc || d.orientation.scheme(d.orientation.default.top, d.orientation.default.front);
}
const solvedOf = (d = def()) => d.puzzle.solvedColours(scheme(d));
if (DEFS.cube3 && !DEFS.cube3.orientation.scheme(S.opts.top, S.opts.front)) { S.opts.top = 'w'; S.opts.front = 'g'; }
for (const a of AVAILABLE) S.colours[a.id] = solvedOf(a.def);
/** Stickers that no turn moves (a 3x3's or Megaminx's centres): their colour tells the scanner which colour is which. */
function neverMoving(d) {
  const p = d.puzzle; const moved = new Uint8Array(p.size);
  for (const t of Object.values(p.turns)) { if (t.moving.length >= p.size) continue; for (const i of t.moving) moved[i] = 1; }
  return p.stickers.filter((s) => !moved[s.i]).map((s) => s.i);
}

// ---- messages -------------------------------------------------------------------------------------------------------------
let toastTimer = null;
function toast(text, err = false) {
  const t = $('toast');
  t.textContent = text; t.className = 'toast' + (err ? ' err' : ''); t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 4200);
}
function verdict(text, kind) { const v = $('verdict'); v.textContent = text || ''; v.className = 'verdict' + (kind ? ' ' + kind : ''); }
function showProblems(errors) {
  const box = $('problems'); const ul = $('problemList');
  ul.textContent = '';
  S.marks = new Set();
  for (const e of errors || []) {
    const li = el('li', { class: e.stickers && e.stickers.length ? 'has-marks' : '' }, e.text);
    if (e.stickers && e.stickers.length) {
      for (const i of e.stickers) S.marks.add(i);
      li.title = 'The stickers concerned are outlined on the map';
      li.addEventListener('mouseenter', () => flash(e.stickers, true));
      li.addEventListener('mouseleave', () => flash(e.stickers, false));
    }
    ul.append(li);
  }
  box.hidden = !errors || !errors.length;
  refreshNet();
}
function flash(list, on) { for (const i of list) { const b = netCells[i]; if (b) b.classList.toggle('flash', on); } }

// ---- the 3D view --------------------------------------------------------------------------------------------------------------
const view = createView($('view3d'), $('gl'));
if (!view) { $('gl').hidden = true; $('noGl').hidden = false; }
const view3d = {
  set: (colours) => { if (view && S.id) view.setPuzzle(def(), colours); },
  move: (m, ms, after) => (view ? view.animateMove(m, ms, after) : sleep(Math.min(ms, 30))),
};
if (view) view.onModeChange = (m) => setViewMode(m, false);
function setViewMode(m, apply = true) {
  S.opts.view = m; saveOpts();
  for (const b of document.querySelectorAll('[data-view]')) b.setAttribute('aria-checked', String(b.dataset.view === m));
  if (apply && view) view.setMode(m);
}
for (const b of document.querySelectorAll('[data-view]')) b.addEventListener('click', () => setViewMode(b.dataset.view));
let liveTimer = null;
function showEntered() {
  if (S.solution) return;
  clearTimeout(liveTimer);
  liveTimer = setTimeout(() => view3d.set(cols()), 30);
}

// ---- the puzzle picker -----------------------------------------------------------------------------------------------------------
/** A small picture of a puzzle: one face template in its standard colours. */
function puzzleIcon(d, size = 18) {
  const p = d.puzzle;
  const face = (d.scan && d.scan.faces && d.scan.faces[0] && d.scan.faces[0].face) || p.faces[0].id;
  const t = p.templates[face];
  const sc = solvedOf(d);
  const b = t.box; const pad = Math.max(b.w, b.h) * 0.06;
  const s = svg('svg', { viewBox: `${b.minX - pad} ${b.minY - pad} ${b.w + 2 * pad} ${b.h + 2 * pad}`, width: size, height: size, class: 'pzicon', 'aria-hidden': 'true' });
  s.append(svg('polygon', { points: pts(t.outline), fill: '#000', stroke: '#000', 'stroke-width': pad * 1.6, 'stroke-linejoin': 'round' }));
  for (const st of t.stickers) s.append(svg('polygon', { points: pts(K.shrink(st.poly, 0.8)), fill: p.colours[sc[st.i]] ? p.colours[sc[st.i]].hex : '#333' }));
  return s;
}
function buildPicker() {
  const list = $('pickList'); list.textContent = '';
  const groups = [];
  for (const a of AVAILABLE) { let g = groups.find((x) => x.name === a.group); if (!g) { g = { name: a.group, items: [] }; groups.push(g); } g.items.push(a); }
  for (const g of groups) {
    const box = el('div', { class: 'pickgroup', role: 'group', 'aria-label': g.name }, el('div', { class: 'pickhead' }, g.name));
    for (const a of g.items) {
      const o = el('div', { class: 'pickopt', role: 'option', id: 'opt-' + a.id, 'data-puzzle': a.id, 'aria-selected': 'false', title: a.def.name });
      o.append(puzzleIcon(a.def, 20), el('span', { class: 'pshort' }, a.def.short), el('span', { class: 'pname muted' }, a.def.name));
      o.addEventListener('click', () => { closePicker(); setPuzzle(a.id); $('picker').focus(); });
      box.append(o);
    }
    list.append(box);
  }
}
function openPicker() {
  $('pickList').hidden = false; $('picker').setAttribute('aria-expanded', 'true');
  pickFocus = Math.max(0, AVAILABLE.findIndex((a) => a.id === S.id));
  markPickFocus();
  $('pickList').focus({ preventScroll: true });
}
function closePicker() { $('pickList').hidden = true; $('picker').setAttribute('aria-expanded', 'false'); }
let pickFocus = 0;
function markPickFocus() {
  AVAILABLE.forEach((a, k) => $('opt-' + a.id).classList.toggle('focus', k === pickFocus));
  $('pickList').setAttribute('aria-activedescendant', 'opt-' + AVAILABLE[pickFocus].id);
}
$('picker').addEventListener('click', () => { if ($('pickList').hidden) openPicker(); else closePicker(); });
$('picker').addEventListener('keydown', (e) => { if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); openPicker(); } });
$('pickList').addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown') { pickFocus = Math.min(AVAILABLE.length - 1, pickFocus + 1); markPickFocus(); e.preventDefault(); }
  else if (e.key === 'ArrowUp') { pickFocus = Math.max(0, pickFocus - 1); markPickFocus(); e.preventDefault(); }
  else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); closePicker(); setPuzzle(AVAILABLE[pickFocus].id); $('picker').focus(); }
  else if (e.key === 'Escape' || e.key === 'Tab') { closePicker(); if (e.key === 'Escape') $('picker').focus(); }
});
document.addEventListener('pointerdown', (e) => { if (!$('pickList').hidden && !e.target.closest('#pickerWrap')) closePicker(); });

function setPuzzle(id) {
  if (!DEFS[id] || (id === S.id && netFor === id)) return;
  stopPlaying();
  stopCamera();
  S.id = id; S.opts.puzzle = id; saveOpts();
  api.want(id);
  const d = def();
  $('pickName').textContent = d.short;
  const ic = $('pickIcon'); ic.textContent = ''; ic.append(puzzleIcon(d, 18));
  $('picker').title = d.name;
  for (const a of AVAILABLE) { const o = $('opt-' + a.id); if (o) o.setAttribute('aria-selected', String(a.id === id)); }
  S.marks.clear(); S.unsure.clear();
  clearSolution();
  showProblems([]);
  verdict('');
  buildPalette();
  buildHold();
  buildNet();
  view3d.set(cols());
  resetScan();
  buildPhotos();
  $('camExp').hidden = $('photosExp').hidden = !(d.scan && d.scan.experimental);
  const nf = scanFaces().length;
  $('photosPick').textContent = `Choose ${NUMBER[nf] || nf} photos…`;
  engineText(S.engineStatus);
}
const NUMBER = { 4: 'four', 5: 'five', 6: 'six', 8: 'eight', 12: 'twelve' };

function setTab(t) {
  S.tab = t;
  for (const b of document.querySelectorAll('[role="tab"]')) b.setAttribute('aria-selected', String(b.dataset.tab === t));
  for (const id of ['fill', 'camera', 'photos']) $('tab-' + id).hidden = id !== t;
  if (t !== 'camera') stopCamera();
  if (t === 'camera') resetScan(false);
}
for (const b of document.querySelectorAll('[role="tab"]')) b.addEventListener('click', () => setTab(b.dataset.tab));

// ---- palette ---------------------------------------------------------------------------------------------------------------------
// Number keys pick a colour: 1-9 (and 0, -, = for the Megaminx's twelve colours). 0 erases when there are at most 9 colours.
let swatches = {}; let keyFor = {}; let eraseKey = '0';
function buildPalette() {
  const p = $('palette'); p.textContent = '';
  swatches = {}; keyFor = {};
  const keys = P().colourKeys;
  const KEYS = keys.length <= 9 ? keys.map((_, k) => String(k + 1)) : ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0', '-', '='];
  eraseKey = keys.length <= 9 ? '0' : 'x';
  keys.forEach((c, k) => {
    keyFor[KEYS[k]] = c;
    const chip = el('span', { class: 'chip' }); chip.style.background = P().colours[c].hex;
    const b = el('button', { class: 'swatch', role: 'radio', 'aria-checked': 'false', 'data-colour': c, title: `${cap(colourName(c))} (key ${KEYS[k]})` },
      chip, el('span', { class: 'sw-name' }, cap(colourName(c))), el('span', { class: 'sw-count' }, ''), el('kbd', {}, KEYS[k]));
    b.addEventListener('click', () => setPaint(c));
    p.append(b); swatches[c] = b;
  });
  keyFor[eraseKey] = null;
  const e = el('button', { class: 'swatch erase', role: 'radio', 'aria-checked': 'false', 'data-colour': '', title: `Erase (key ${eraseKey.toUpperCase()})` }, el('span', { class: 'chip c-none' }), el('span', { class: 'sw-name' }, 'Erase'), el('kbd', {}, eraseKey.toUpperCase()));
  e.addEventListener('click', () => setPaint(null));
  p.append(e); swatches.none = e;
  p.classList.toggle('many', keys.length > 6);
  setPaint(keys.includes(S.paint) ? S.paint : keys[0]);
}
function setPaint(c) {
  S.paint = c;
  for (const [k, b] of Object.entries(swatches)) b.setAttribute('aria-checked', String((k === 'none' ? null : k) === c));
}
function wantCounts() { const want = {}; for (const c of solvedOf()) want[c] = (want[c] || 0) + 1; return want; }
function refreshCounts() {
  const count = Object.fromEntries(P().colourKeys.map((c) => [c, 0]));
  let empty = 0;
  for (const c of cols()) { if (c && count[c] != null) count[c]++; else empty++; }
  const want = wantCounts();
  for (const c of P().colourKeys) {
    const s = swatches[c].querySelector('.sw-count');
    s.textContent = `${count[c]}/${want[c] || 0}`;
    s.classList.toggle('off', count[c] !== (want[c] || 0));
  }
  $('netInfo').textContent = empty ? `${empty} to fill in` : '';
}

// ---- the fill-in map (SVG, from puzzle.netLayout()) ------------------------------------------------------------------------------
let netCells = []; let netRings = []; let layout = null; let cellSize = 1; let netFor = null;
function offsetPoly(poly, d) { // moves the edges of a convex polygon inwards by d (outwards for d < 0)
  let a = 0; for (let i = 0; i < poly.length; i++) { const p = poly[i]; const q = poly[(i + 1) % poly.length]; a += p[0] * q[1] - q[0] * p[1]; }
  const sgn = a > 0 ? 1 : -1; const n = poly.length;
  const lines = poly.map((p, i) => {
    const q = poly[(i + 1) % n]; const ex = q[0] - p[0]; const ey = q[1] - p[1]; const len = Math.hypot(ex, ey) || 1;
    const nx = -ey / len * sgn; const ny = ex / len * sgn;
    return { p: [p[0] + nx * d, p[1] + ny * d], dir: [ex / len, ey / len] };
  });
  return lines.map((l, i) => {
    const m = lines[(i + n - 1) % n]; const den = m.dir[0] * l.dir[1] - m.dir[1] * l.dir[0];
    if (Math.abs(den) < 1e-9) return l.p;
    const t = ((l.p[0] - m.p[0]) * l.dir[1] - (l.p[1] - m.p[1]) * l.dir[0]) / den;
    return [m.p[0] + m.dir[0] * t, m.p[1] + m.dir[1] * t];
  });
}
function polyArea(poly) { let a = 0; for (let i = 0; i < poly.length; i++) { const p = poly[i]; const q = poly[(i + 1) % poly.length]; a += p[0] * q[1] - q[0] * p[1]; } return Math.abs(a) / 2; }
function buildNet() {
  const host = $('net'); host.textContent = '';
  layout = P().netLayout();
  const areas = layout.cells.map((c) => polyArea(c.poly)).sort((a, b) => a - b);
  cellSize = Math.sqrt(areas[areas.length >> 1]);
  const s = cellSize; const gap = 0.045 * s; const pad = 0.07 * s;
  const b = layout.box;
  const fontSize = Math.max(0.27 * s, Math.max(b.w, b.h * 1.3) * 0.022); // about 10 px however small the stickers are
  const labelH = fontSize * 1.85;
  const vb = [b.minX - pad - 0.05 * s, b.minY - pad - labelH, b.w + 2 * pad + 0.1 * s, b.h + 2 * pad + labelH + 0.05 * s];
  const root = svg('svg', { id: 'netSvg', viewBox: vb.join(' '), role: 'presentation' });
  root.append(svg('defs', {}, svg('pattern', { id: 'hatch', width: 0.25 * s, height: 0.25 * s, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' },
    svg('rect', { width: 0.25 * s, height: 0.25 * s, fill: '#1b1b20' }), svg('rect', { width: 0.125 * s, height: 0.25 * s, fill: '#24242a' }))));
  // the faces: black plastic behind the stickers, and the face's name above it
  const byFace = new Map();
  for (const c of layout.cells) { if (!byFace.has(c.face)) byFace.set(c.face, []); byFace.get(c.face).push(c); }
  const faceName = (id) => (P().faceById.get(id).name || id);
  const outlines = [...byFace].map(([face, cells]) => ({ face, outline: offsetPoly(window.PuzzleCore.hull(cells.flatMap((c) => c.poly)), -pad) }));
  const collides = (rect, own) => outlines.some((o) => {
    if (o.face === own) return false;
    const [x0, y0, x1, y1] = rect;
    const probe = [[x0, y0], [x1, y0], [x0, y1], [x1, y1], [(x0 + x1) / 2, (y0 + y1) / 2], [(x0 + x1) / 2, y0], [(x0 + x1) / 2, y1]];
    return probe.some(([x, y]) => K.insidePoly(o.outline, x, y)) || o.outline.some(([x, y]) => x > x0 && x < x1 && y > y0 && y < y1);
  });
  for (const { face, outline } of outlines) {
    const facePoly = svg('polygon', { class: 'netface', points: pts(outline), 'stroke-width': pad, 'stroke-linejoin': 'round' });
    facePoly.append(svg('title', {}, faceName(face) + ' face'));
    root.append(facePoly);
    // the face's name above it, or below it, wherever it does not run into another face (else only as a tooltip)
    const xs = outline.map((p) => p[0]); const ys = outline.map((p) => p[1]);
    const square = outline.length === 4;
    const text = faceName(face).toUpperCase();
    const w = text.length * fontSize * 0.68;
    const tx = square ? Math.min(...xs) : (Math.min(...xs) + Math.max(...xs)) / 2;
    const rx0 = square ? tx : tx - w / 2;
    for (const y of [Math.min(...ys) - 0.45 * fontSize, Math.max(...ys) + 1.35 * fontSize]) {
      const rect = [rx0, y - fontSize, rx0 + w, y + 0.2 * fontSize];
      if (collides(rect, face) || rect[1] < vb[1] - 0.01) continue;
      vb[3] = Math.max(vb[3], rect[3] + 0.1 * fontSize - vb[1]);
      const label = svg('text', { class: 'netlabel', x: tx, y, 'font-size': fontSize, 'text-anchor': square ? 'start' : 'middle' });
      label.textContent = text;
      root.append(label);
      break;
    }
  }
  root.setAttribute('viewBox', vb.join(' '));
  netCells = []; netRings = [];
  const fx = fixed();
  const r = 0.1 * s;
  for (const c of layout.cells) {
    const tri = c.poly.length === 3;
    const rr = tri ? r * 0.5 : r;
    const poly = svg('polygon', { class: 'sticker', 'data-i': c.i, points: pts(offsetPoly(c.poly, gap + rr)), 'stroke-width': 2 * rr, 'stroke-linejoin': 'round', tabindex: '-1', role: 'gridcell' });
    const ring = svg('polygon', { class: 'ring', points: pts(offsetPoly(c.poly, gap * 0.4)), 'stroke-linejoin': 'round' });
    root.append(poly, ring);
    if (fx.has(c.i)) root.append(svg('circle', { class: 'fixdot', cx: c.centre[0], cy: c.centre[1], r: 0.08 * s }));
    netCells[c.i] = poly; netRings[c.i] = ring;
  }
  host.append(root);
  netFor = S.id;
  sizeNet();
  if (!netCells[S.cursor] || fx.has(S.cursor)) S.cursor = layout.cells.find((c) => !fx.has(c.i)).i;
  refreshNet();
}
function sizeNet() {
  const root = $('netSvg'); if (!root || !layout) return;
  const vb = root.viewBox.baseVal;
  const avail = Math.max(300, $('net').clientWidth - 4);
  const maxH = Math.max(280, Math.min(470, window.innerHeight - 360));
  const unit = Math.min(avail / vb.width, maxH / vb.height, 52 / cellSize);
  root.setAttribute('width', Math.round(vb.width * unit)); root.setAttribute('height', Math.round(vb.height * unit));
}
let sizeQueued = false;
new ResizeObserver(() => { if (sizeQueued) return; sizeQueued = true; requestAnimationFrame(() => { sizeQueued = false; sizeNet(); }); }).observe(document.querySelector('.left'));
function stickerLabel(i) {
  const s = P().stickers[i];
  const c = cols()[i];
  const t = P().templates[s.face]; const k = t.stickers.findIndex((x) => x.i === i);
  return `${P().faceById.get(s.face).name} face, sticker ${k + 1} of ${t.stickers.length}: ${colourName(c)}${fixed().has(i) ? ' (centre)' : ''}`;
}
function refreshNet() {
  if (netFor !== S.id || netCells.length !== P().size) return; // the map for this puzzle is about to be built
  const c = cols(); const fx = fixed();
  netCells.forEach((b, i) => {
    const col = c[i] && P().colours[c[i]];
    b.setAttribute('fill', col ? col.hex : 'url(#hatch)');
    b.setAttribute('stroke', col ? col.hex : '#202026');
    b.setAttribute('class', 'sticker' + (fx.has(i) ? ' centre' : '') + ' c-' + (c[i] || 'none') + (S.marks.has(i) ? ' bad' : '') + (S.unsure.has(i) ? ' unsure' : '') + (i === S.cursor ? ' cursor' : ''));
    b.setAttribute('tabindex', i === S.cursor ? '0' : '-1');
    b.setAttribute('aria-label', stickerLabel(i));
    netRings[i].setAttribute('class', 'ring' + (S.marks.has(i) ? ' bad' : '') + (S.unsure.has(i) ? ' unsure' : '') + (i === S.cursor ? ' cursor' : ''));
  });
  refreshCounts();
}
function setSticker(i, colour) {
  if (fixed().has(i)) { toast(def().orientation ? 'Centres never move on a 3x3: to change them, choose the top and front colours under "How to hold the cube".' : 'This sticker never moves, so its colour is fixed.'); return false; }
  if (cols()[i] === colour) return false;
  cols()[i] = colour;
  S.unsure.delete(i);
  afterEdit();
  return true;
}
function afterEdit() {
  if (S.solution) clearSolution();
  if (S.marks.size || !$('problems').hidden) showProblems([]);
  verdict('');
  refreshNet();
  showEntered();
}
function setAll(colours, { scanned = false } = {}) {
  S.colours[S.id] = Array.from(colours);
  if (!scanned) S.unsure.clear();
  clearSolution();
  showProblems([]);
  verdict('');
  refreshNet();
  showEntered();
}

let painting = false;
$('net').addEventListener('pointerdown', (e) => {
  const b = e.target.closest && e.target.closest('.sticker'); if (!b) return;
  e.preventDefault();
  const i = Number(b.dataset.i);
  S.cursor = i;
  const colour = e.button === 2 ? null : S.paint;
  setSticker(i, colour);
  if (!fixed().has(i)) painting = { colour };
  refreshNet();
  b.focus({ preventScroll: true });
});
$('net').addEventListener('pointermove', (e) => {
  if (!painting) return;
  const b = document.elementFromPoint(e.clientX, e.clientY);
  const s = b && b.closest && b.closest('.sticker');
  if (!s) return;
  const i = Number(s.dataset.i);
  if (!fixed().has(i)) { S.cursor = i; setSticker(i, painting.colour); refreshNet(); }
});
window.addEventListener('pointerup', () => { painting = false; });
window.addEventListener('pointercancel', () => { painting = false; });
$('net').addEventListener('contextmenu', (e) => e.preventDefault());
/** The nearest sticker in a direction on the map: first in the same row / column, then a little to the side. */
function neighbour(from, dx, dy) {
  const c0 = layout.cells.find((c) => c.i === from).centre;
  let best = null; let bestScore = Infinity;
  for (const c of layout.cells) {
    if (c.i === from) continue;
    const vx = c.centre[0] - c0[0]; const vy = c.centre[1] - c0[1];
    const fwd = vx * dx + vy * dy; const side = Math.abs(vx * dy - vy * dx);
    if (fwd < 0.1 * cellSize) continue;
    let score;
    if (side < 0.55 * cellSize) score = fwd;
    else if (side < fwd * 0.6 && fwd < 1.6 * cellSize) score = 1000 + fwd + side;
    else continue;
    if (score < bestScore) { bestScore = score; best = c.i; }
  }
  return best;
}
$('net').addEventListener('keydown', (e) => {
  const dirs = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
  if (dirs[e.key]) {
    e.preventDefault();
    const n = neighbour(S.cursor, ...dirs[e.key]);
    if (n != null) S.cursor = n;
    refreshNet();
    netCells[S.cursor].focus({ preventScroll: true });
  } else if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    setSticker(S.cursor, S.paint);
    refreshNet();
  } else if (e.key === 'Delete' || e.key === 'Backspace') {
    e.preventDefault();
    setSticker(S.cursor, null);
    refreshNet();
  }
});
document.addEventListener('keydown', (e) => {
  const t = e.target;
  const typing = t && (t.tagName === 'INPUT' && t.type === 'text' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA');
  if (typing || e.ctrlKey || e.altKey || e.metaKey || !$('pickList').hidden) return;
  const k = low(e.key);
  if (S.tab === 'fill' && Object.prototype.hasOwnProperty.call(keyFor, k)) { setPaint(keyFor[k]); e.preventDefault(); }
  if (S.tab === 'camera' && e.key === ' ' && !(t && (t.tagName === 'BUTTON' || t.tagName === 'INPUT'))) { e.preventDefault(); capture(); }
});

$('reset').addEventListener('click', () => setAll(solvedOf()));
$('clear').addEventListener('click', () => {
  const fx = fixed();
  setAll(cols().map((c, i) => (fx.has(i) ? c : null)));
  S.cursor = layout.cells.find((c) => !fx.has(c.i)).i;
  refreshNet();
});
$('random').addEventListener('click', () => {
  const d = def();
  const moves = d.randomMoves ? d.randomMoves(d.scrambleLength || 25) : P().randomMoves(d.scrambleLength || 25);
  setAll(P().applyMoves(solvedOf(), moves));
  $('turnsText').value = P().formatMoves(moves);
  toast('Scrambled with the turns shown under the map. Do them on a solved puzzle to follow along.');
});
function applyTurns() {
  let moves;
  try { moves = P().parseMoves($('turnsText').value); } catch (e) { toast(e.message, true); return; }
  if (!moves.length) { toast(`Type some turns first, for example ${P().formatMoves(P().randomMoves(3, 1))}`, true); return; }
  setAll(P().applyMoves(solvedOf(), moves));
  toast(`Applied ${moves.length} ${moves.length === 1 ? 'turn' : 'turns'} to a solved puzzle.`);
}
$('applyTurns').addEventListener('click', applyTurns);
$('turnsText').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); applyTurns(); } });

// ---- how to hold it (the 3x3 also chooses its top and front colours) ---------------------------------------------------------------
function buildHold() {
  const d = def();
  $('holdTitle').textContent = d.id.startsWith('cube') ? 'How to hold the cube' : `How to hold the ${d.short}`;
  $('holdOrient').hidden = !d.orientation;
  $('holdText').hidden = !!d.orientation;
  $('holdText').textContent = d.holdHelp || '';
  $('notation').textContent = d.notationHelp ? 'The turns: ' + d.notationHelp : '';
  if (d.orientation) fillOrient();
}
function fillOrient() {
  const d = def(); const o = d.orientation;
  const top = $('oTop'); const front = $('oFront');
  top.textContent = '';
  for (const c of o.colours) top.append(el('option', { value: c }, cap(colourName(c))));
  top.value = S.opts.top;
  front.textContent = '';
  for (const c of o.colours) if (o.scheme(top.value, c)) front.append(el('option', { value: c }, cap(colourName(c))));
  front.value = o.scheme(top.value, S.opts.front) ? S.opts.front : front.options[0].value;
  $('hTop').textContent = colourName(top.value); $('hFront').textContent = colourName(front.value);
}
function orientChanged() {
  const d = def();
  S.opts.top = $('oTop').value; S.opts.front = $('oFront').value; saveOpts();
  fillOrient();
  S.opts.front = $('oFront').value; saveOpts();
  const sc = solvedOf(d); const c = cols().slice();
  for (const i of fixed()) c[i] = sc[i];
  S.colours[S.id] = c;
  afterEdit(); resetScan(); buildPhotos();
}
$('oTop').addEventListener('change', orientChanged);
$('oFront').addEventListener('change', orientChanged);

// ---- solving ----------------------------------------------------------------------------------------------------------------------------
function engineText(s) {
  if (!s) return;
  S.engineStatus = s;
  const st = s.puzzles && S.id && s.puzzles[S.id];
  if (!st) return;
  const p = Math.round((st.progress || 0) * 100);
  const name = def().short;
  $('engine').textContent = st.error ? `The ${name} solver could not start: ${st.error}` : st.ready ? 'Solver ready' : `Getting the ${name} solver ready… ${p}%`;
  $('engineProg').hidden = st.ready || !!st.error;
  $('engineFill').style.width = p + '%';
  $('engineProg').setAttribute('aria-valuenow', String(p));
}
api.onStatus(engineText);
api.status().then(engineText);

const cleanErr = (e) => String((e && e.message) || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
async function solve() {
  if (S.busy) return;
  stopPlaying();
  const id = S.id; const d = def(); const p = P();
  const start = cols().slice();
  let v;
  try { v = d.validate(start); } catch (e) { v = { ok: false, errors: [{ text: 'This could not be checked: ' + cleanErr(e), stickers: [] }] }; }
  if (!v.ok) {
    const errs = v.errors && v.errors.length ? v.errors : [{ text: v.summary || 'This puzzle cannot be solved as filled in.', stickers: [] }];
    showProblems(errs);
    verdict(errs.length === 1 ? "This can't be solved as filled in:" : `This can't be solved as filled in (${errs.length} problems):`, 'err');
    if (S.marks.size && S.tab !== 'fill') setTab('fill');
    return;
  }
  showProblems([]);
  if (p.isSolved(start)) { verdict(`This ${d.id.startsWith('cube') ? 'cube' : 'puzzle'} is already solved.`, 'ok'); return; }
  S.busy = true;
  $('solve').disabled = true;
  const st = S.engineStatus && S.engineStatus.puzzles && S.engineStatus.puzzles[id];
  verdict(st && st.ready ? 'Solving…' : 'Waiting for the solver to get ready…');
  try {
    const r = await api.solve(id, start);
    const moves = p.parseMoves(r.moves);
    // check it again here: what is shown must solve exactly the puzzle on screen
    if (!p.isSolved(p.applyMoves(start, moves))) throw new Error('The answer did not solve this puzzle, so it is not shown.');
    if (S.id !== id || cols().join() !== start.join()) return; // the puzzle changed while solving
    let from = 0;
    const stages = (r.stages || []).map((sg) => { const n = p.parseMoves(sg.moves).length; const x = { title: sg.title, from, to: from + n }; from += n; return x; });
    S.solution = { id, start, moves, stages: from === moves.length && stages.length ? stages : [{ title: 'Solve', from: 0, to: moves.length }] };
    S.pos = 0;
    const optimal = d.optimal != null ? d.optimal : OPTIMAL.has(id);
    verdict(`Solved in ${moves.length} ${moves.length === 1 ? 'turn' : 'turns'}${optimal ? ' (the fewest possible)' : ''}.`, 'ok');
    const how = id === 'cube3' ? 'two-phase search' : optimal ? 'optimal' : `${S.solution.stages.length} stages`;
    $('moveInfo').textContent = `${moves.length} turns · found in ${r.ms < 1000 ? r.ms + ' ms' : (r.ms / 1000).toFixed(1) + ' s'} · ${how}`;
    buildChips();
    $('solution').hidden = false;
    $('viewTitle').textContent = 'Solution';
    goTo(0);
  } catch (e) {
    verdict(cleanErr(e), 'err');
  } finally {
    S.busy = false;
    $('solve').disabled = false;
  }
}
$('solve').addEventListener('click', solve);

// ---- the player ------------------------------------------------------------------------------------------------------------------------
let chips = [];
const multiStage = () => S.solution && S.solution.stages.length > 1;
function buildChips() {
  const box = $('chips'); box.textContent = ''; chips = [];
  const sol = S.solution;
  const many = multiStage();
  box.classList.toggle('staged', many);
  sol.stages.forEach((sg, si) => {
    const group = el('div', { class: 'stagegroup', role: 'group', 'aria-label': `Stage ${si + 1}: ${sg.title}` });
    if (many) group.append(el('div', { class: 'stagehead' }, el('span', { class: 'sn' }, String(si + 1)), sg.title, el('span', { class: 'sc muted' }, `${sg.to - sg.from} ${sg.to - sg.from === 1 ? 'turn' : 'turns'}`)));
    const row = el('div', { class: 'stagechips' });
    for (let k = sg.from; k < sg.to; k++) {
      const m = sol.moves[k];
      const b = el('button', { class: 'mchip', 'data-k': k, title: `Turn ${k + 1}: ${describe(m)}` }, el('span', { class: 'mi' }, String(k + 1)), P().formatMove(m));
      b.addEventListener('click', () => { stopPlaying(); goTo(k + 1); });
      row.append(b); chips.push(b);
    }
    group.append(row);
    box.append(group);
  });
}
const FRACTION = { 2: ['half a turn'], 3: ['a third of a turn'], 4: ['a quarter', 'half a turn'], 5: ['a fifth of a turn', 'two fifths of a turn'], 6: ['a sixth of a turn', 'a third of a turn', 'half a turn'] };
function describe(m) {
  const d = def();
  if (d.describeMove) { try { return d.describeMove(m); } catch { /* fall back */ } }
  const t = P().turns[m.turn]; const n = t.order;
  let k = m.amount; let dir = 'clockwise';
  if (k > n / 2) { k = n - k; dir = 'anticlockwise'; }
  const half = 2 * k === n;
  const words = (FRACTION[n] || [])[k - 1] || `${k}/${n} of a turn`;
  const face = P().faceById.get(m.turn);
  const what = face ? `the ${low(face.name)} face` : `layer ${m.turn}`;
  return half ? `${what} half a turn` : `${what} ${words} ${dir}`;
}
const stateAt = (pos) => P().applyMoves(S.solution.start, S.solution.moves.slice(0, pos));
function stageAt(pos) {
  const st = S.solution.stages;
  const k = st.findIndex((sg) => pos < sg.to);
  return k < 0 ? st.length - 1 : k;
}
function refreshPlayer() {
  const N = S.solution ? S.solution.moves.length : 0;
  chips.forEach((b, k) => {
    b.classList.toggle('done', k < S.pos - 1);
    b.classList.toggle('now', k === S.pos - 1);
    b.classList.toggle('next', k === S.pos);
    b.setAttribute('aria-current', k === S.pos - 1 ? 'step' : 'false');
  });
  $('pCount').textContent = S.pos === N ? `Turn ${N} of ${N} · solved` : `Turn ${S.pos} of ${N}`;
  if (multiStage()) {
    const si = stageAt(S.pos); const sg = S.solution.stages[si];
    $('pStage').hidden = false;
    $('pStage').textContent = S.pos === N ? `Done: all ${S.solution.stages.length} stages` : `Stage ${si + 1} of ${S.solution.stages.length}: ${sg.title}`;
    document.querySelectorAll('#chips .stagegroup').forEach((g, k) => g.classList.toggle('current', k === si && S.pos < N));
  } else $('pStage').hidden = true;
  $('pNext').textContent = S.pos < N ? `Next: ${P().formatMove(S.solution.moves[S.pos])}, ${describe(S.solution.moves[S.pos])}.` : 'Done: every face is one colour again.';
  $('pBack').disabled = $('pStart').disabled = S.pos === 0;
  $('pFwd').disabled = $('pEnd').disabled = S.pos === N;
  $('icPlay').hidden = S.playing; $('icPause').hidden = !S.playing;
  $('pPlay').setAttribute('aria-label', S.playing ? 'Pause' : 'Play');
  const cur = chips[Math.max(0, S.pos - 1)];
  if (cur && typeof cur.scrollIntoView === 'function') cur.scrollIntoView({ block: 'nearest' });
}
let queue = Promise.resolve();
const speedMs = () => 520 / Number($('speed').value || 1);
function goTo(pos) {
  queue = queue.then(() => {
    if (!S.solution) return;
    S.pos = Math.max(0, Math.min(S.solution.moves.length, pos));
    view3d.set(stateAt(S.pos));
    refreshPlayer();
  });
  return queue;
}
function step(dir) {
  queue = queue.then(async () => {
    if (!S.solution) return;
    const N = S.solution.moves.length;
    if (dir > 0 && S.pos < N) {
      const m = S.solution.moves[S.pos];
      S.pos++;
      refreshPlayer();
      await view3d.move(m, speedMs(), stateAt(S.pos));
    } else if (dir < 0 && S.pos > 0) {
      const m = P().inverse([S.solution.moves[S.pos - 1]])[0];
      S.pos--;
      refreshPlayer();
      await view3d.move(m, speedMs(), stateAt(S.pos));
    }
  });
  return queue;
}
async function play() {
  if (!S.solution) return;
  if (S.pos >= S.solution.moves.length) await goTo(0);
  S.playing = true; refreshPlayer();
  while (S.playing && S.solution && S.pos < S.solution.moves.length) {
    await step(1);
    if (S.playing) await sleep(Math.min(250, speedMs() * 0.25));
  }
  S.playing = false;
  if (S.solution) refreshPlayer();
}
function stopPlaying() { S.playing = false; }
$('pPlay').addEventListener('click', () => { if (S.playing) { stopPlaying(); refreshPlayer(); } else play(); });
$('pFwd').addEventListener('click', () => { stopPlaying(); step(1); });
$('pBack').addEventListener('click', () => { stopPlaying(); step(-1); });
$('pStart').addEventListener('click', () => { stopPlaying(); goTo(0); });
$('pEnd').addEventListener('click', () => { stopPlaying(); if (S.solution) goTo(S.solution.moves.length); });
$('speed').value = String(S.opts.speed);
$('speed').addEventListener('input', () => { S.opts.speed = Number($('speed').value); saveOpts(); });
function clearSolution() {
  stopPlaying();
  S.solution = null; S.pos = 0; chips = [];
  $('solution').hidden = true;
  $('pStage').hidden = true;
  $('viewTitle').textContent = 'Your puzzle';
  if (netFor === S.id) view3d.set(cols());
}
function solutionText() {
  const s = S.solution; const p = P();
  const keys = s.start.map((c) => c || '-');
  const stickerText = keys.every((k) => k.length === 1) ? keys.join('') : keys.join(' ');
  const lines = [`Cube Solver - ${def().name}`, '', `Stickers (one colour per sticker, in the app's order): ${stickerText}`, '', `Solution (${s.moves.length} turns):`, p.formatMoves(s.moves), ''];
  if (s.stages.length > 1) {
    lines.push('Stage by stage:');
    s.stages.forEach((sg, k) => lines.push(`${k + 1}. ${sg.title} (${sg.to - sg.from} ${sg.to - sg.from === 1 ? 'turn' : 'turns'}): ${p.formatMoves(s.moves.slice(sg.from, sg.to))}`));
    lines.push('');
  }
  if (def().notationHelp) lines.push('The turns: ' + def().notationHelp, '');
  return lines.join('\n');
}
$('copy').addEventListener('click', async () => { try { await api.copy(P().formatMoves(S.solution.moves)); toast('The solution is on the clipboard.'); } catch (e) { toast(cleanErr(e), true); } });
$('save').addEventListener('click', async () => {
  try { const r = await api.saveSolution(solutionText()); if (r && r.ok) toast('Saved to ' + r.path); } catch (e) { toast(cleanErr(e), true); }
});

// ---- scanning: shared ----------------------------------------------------------------------------------------------------------------------
const scanFaces = () => def().scan.faces.map((f) => f.face);
const faceLabel = (face) => P().faceById.get(face).name || face;
function scanSay(face) {
  const d = def();
  if (d.scanSay) return d.scanSay(face, scheme());
  const f = d.scan.faces.find((x) => x.face === face);
  return (f && f.say) || `Show the ${faceLabel(face).toLowerCase()} face.`;
}
/** The colour a face's fixed centre has (3x3: from how it is held), shown next to the face's name. */
function centreWord(face) {
  const fx = neverMoving(def()); const sc = solvedOf();
  const i = P().stickersOf(face).find((k) => fx.includes(k));
  return i == null ? '' : colourName(sc[i]);
}
/** samples per face (scan order, each sample carries its sticker index .i) -> colours into the map. */
function finishScan(byFace, how) {
  const d = def(); const p = P();
  const faces = scanFaces().map((f) => byFace[f]);
  const flat = faces.flat();
  const sc = solvedOf();
  const fx = new Set(neverMoving(d));
  const fixedMap = {}; flat.forEach((s, k) => { if (fx.has(s.i)) fixedMap[k] = sc[s.i]; });
  const want = wantCounts();
  const keys = p.colourKeys;
  let res;
  try {
    res = K.classifyCounts(faces, { keys, counts: keys.map((k) => want[k] || 0), typical: K.typicalFor(p.colours), fixed: fixedMap, white: keys.find((k) => low(p.colours[k].name) === 'white') || null });
  } catch (e) { toast(cleanErr(e), true); return; }
  const out = cols().slice();
  flat.forEach((s, k) => { out[s.i] = res.colours[k]; });
  S.unsure = new Set(res.unsure.map((k) => flat[k].i));
  setAll(out, { scanned: true });
  setTab('fill');
  const unsure = S.unsure.size;
  verdict(`Read from ${how}. ${unsure ? `Check the ${unsure} ${unsure === 1 ? 'sticker' : 'stickers'} with a dotted outline, then press Solve.` : 'Check the map against your puzzle, then press Solve.'}`);
}
/** A small drawing of one face with the colours read (or empty). */
function miniFace(face, colours, big = false) {
  const t = P().templates[face]; const b = t.box; const pad = Math.max(b.w, b.h) * 0.05;
  const box = el('div', { class: 'miniface' + (big ? ' big' : '') });
  const s = svg('svg', { viewBox: `${b.minX - pad} ${b.minY - pad} ${b.w + 2 * pad} ${b.h + 2 * pad}`, 'aria-hidden': 'true' });
  s.append(svg('polygon', { points: pts(t.outline), fill: '#000', stroke: '#000', 'stroke-width': pad * 2, 'stroke-linejoin': 'round' }));
  t.stickers.forEach((st, k) => {
    const c = colours && colours[k]; const col = c && P().colours[c];
    s.append(svg('polygon', { points: pts(K.shrink(st.poly, 0.84)), fill: col ? col.hex : '#2a2a31', 'data-k': k }));
  });
  box.append(s);
  return box;
}

// ---- webcam ---------------------------------------------------------------------------------------------------------------------------------
const cam = { stream: null, step: 0, captured: {}, live: null, timer: null };
const work = document.createElement('canvas');
const workCtx = work.getContext('2d', { willReadFrequently: true });
function resetScan(clearCaptured = true) {
  if (clearCaptured) { cam.captured = {}; cam.step = 0; cam.live = null; }
  renderCamFaces();
  renderLive(null);
  if (S.tab === 'camera' || clearCaptured) $('camSay').textContent = cam.stream ? scanSay(scanFaces()[cam.step]) : 'Press Start camera. The picture stays on this computer: nothing is recorded or saved.';
}
function renderCamFaces() {
  const box = $('camFaces'); box.textContent = '';
  scanFaces().forEach((f, k) => {
    const got = cam.captured[f];
    const cw = centreWord(f);
    const b = el('button', { class: 'facebtn' + (k === cam.step && cam.stream ? ' current' : '') + (got ? ' got' : ''), 'data-face': f, title: got ? 'Scan this face again' : 'Not scanned yet' },
      miniFace(f, got ? got.guess : null), el('span', { class: 'fl' }, faceLabel(f) + (cw ? ' · ' + cw : '')));
    b.addEventListener('click', () => { cam.step = k; $('camSay').textContent = scanSay(f); renderCamFaces(); });
    box.append(b);
  });
}
async function listCameras() {
  try {
    const devs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
    const sel = $('camSel'); const was = sel.value;
    sel.textContent = '';
    sel.append(el('option', { value: '' }, 'Default camera'));
    devs.forEach((d, k) => sel.append(el('option', { value: d.deviceId }, d.label || `Camera ${k + 1}`)));
    if ([...sel.options].some((o) => o.value === was)) sel.value = was;
  } catch { /* no cameras listed: the default one may still work */ }
}
async function startCamera() {
  stopCamera();
  const id = $('camSel').value;
  try {
    const video = id ? { deviceId: { exact: id }, width: { ideal: 1280 }, height: { ideal: 720 } } : { width: { ideal: 1280 }, height: { ideal: 720 } };
    cam.stream = await navigator.mediaDevices.getUserMedia({ video, audio: false });
  } catch (e) {
    cam.stream = null;
    const why = e && e.name === 'NotAllowedError' ? 'The camera was not allowed.' : e && e.name === 'NotFoundError' ? 'No camera was found.' : e && e.name === 'NotReadableError' ? 'The camera is busy (another program may be using it).' : 'The camera could not start' + (e && e.message ? ': ' + e.message : '.');
    $('camSay').textContent = why + ' You can also use Photos or fill the puzzle in by hand.';
    return;
  }
  const v = $('video');
  v.srcObject = cam.stream;
  try { await v.play(); } catch { /* autoplay of a muted stream is allowed */ }
  $('camStart').hidden = true; $('camStop').hidden = false; $('capture').disabled = false;
  await listCameras();
  $('camSay').textContent = scanSay(scanFaces()[cam.step]);
  renderCamFaces();
  cam.timer = setInterval(readFrame, 120);
}
function stopCamera() {
  if (cam.timer) clearInterval(cam.timer);
  cam.timer = null;
  if (cam.stream) { for (const t of cam.stream.getTracks()) t.stop(); }
  cam.stream = null; cam.live = null;
  const v = $('video'); if (v) v.srcObject = null;
  $('camStart').hidden = false; $('camStop').hidden = true; $('capture').disabled = true;
  const o = $('overlay'); o.getContext('2d').clearRect(0, 0, o.width, o.height);
  renderLive(null);
}
function camCorners(face, w, h) { return K.placeOutline(P().templates[face], w / 2, h / 2, Math.min(w, h) * (Number($('gridSize').value) / 100)); }
function readFrame() {
  const v = $('video');
  if (!cam.stream || v.readyState < 2 || !v.videoWidth) return;
  const scale = Math.min(1, 480 / Math.max(v.videoWidth, v.videoHeight));
  const w = Math.round(v.videoWidth * scale); const h = Math.round(v.videoHeight * scale);
  if (work.width !== w || work.height !== h) { work.width = w; work.height = h; $('camView').style.aspectRatio = `${w} / ${h}`; }
  workCtx.drawImage(v, 0, 0, w, h);
  const img = workCtx.getImageData(0, 0, w, h);
  const face = scanFaces()[cam.step];
  const t = P().templates[face];
  const corners = camCorners(face, w, h);
  const samples = K.sampleTemplate(img, t, corners);
  // the fixed centres captured so far are the best references for their colours
  const refs = {}; const fx = new Set(neverMoving(def())); const sc = solvedOf();
  for (const f of scanFaces()) if (cam.captured[f]) for (const s of cam.captured[f].samples) if (fx.has(s.i)) refs[sc[s.i]] = s.lab;
  const guess = K.liveGuessKeys(samples, P().colourKeys, K.typicalFor(P().colours), refs);
  cam.live = { samples, guess, face };
  drawOverlay(t, corners, w, h, guess);
  renderLive(guess);
}
function drawOverlay(t, corners, w, h, guess) {
  const o = $('overlay');
  if (o.width !== w || o.height !== h) { o.width = w; o.height = h; }
  const ctx = o.getContext('2d');
  ctx.clearRect(0, 0, w, h);
  const cells = K.templateCells(t, corners);
  ctx.lineWidth = 2; ctx.strokeStyle = 'rgba(255,255,255,0.9)'; ctx.lineJoin = 'round';
  for (const c of cells) { ctx.beginPath(); c.poly.forEach(([x, y], k) => (k ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); ctx.closePath(); ctx.stroke(); }
  cells.forEach((c, k) => {
    const r = Math.sqrt(polyArea(c.poly)) * 0.14;
    ctx.fillStyle = P().colours[guess[k]].hex;
    ctx.strokeStyle = '#000'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(c.centre[0], c.centre[1], r, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  });
}
function renderLive(guess) {
  if (!S.id) return;
  const box = $('liveFace');
  const mf = miniFace(cam.live ? cam.live.face : scanFaces()[cam.step], guess, true);
  box.replaceWith(mf); mf.id = 'liveFace';
}
function capture() {
  if (!cam.stream || !cam.live) return;
  const order = scanFaces();
  const face = order[cam.step];
  if (cam.live.face !== face) return;
  cam.captured[face] = { samples: cam.live.samples, guess: cam.live.guess };
  const next = order.findIndex((f, k) => k > cam.step && !cam.captured[f]);
  const anyLeft = order.findIndex((f) => !cam.captured[f]);
  if (anyLeft < 0) {
    const byFace = Object.fromEntries(order.map((f) => [f, cam.captured[f].samples]));
    stopCamera();
    finishScan(byFace, 'the camera');
    resetScan();
    return;
  }
  cam.step = next >= 0 ? next : anyLeft;
  cam.live = null;
  $('camSay').textContent = scanSay(order[cam.step]);
  renderCamFaces();
}
$('camStart').addEventListener('click', startCamera);
$('camStop').addEventListener('click', stopCamera);
$('capture').addEventListener('click', capture);
$('camSel').addEventListener('change', () => { if (cam.stream) startCamera(); });
$('camMirror').checked = !!S.opts.mirror;
const applyMirror = () => { $('camView').classList.toggle('mirror', $('camMirror').checked); S.opts.mirror = $('camMirror').checked; saveOpts(); };
$('camMirror').addEventListener('change', applyMirror);
$('gridSize').value = String(S.opts.grid);
$('gridSize').addEventListener('input', () => { S.opts.grid = Number($('gridSize').value); saveOpts(); });

// ---- photos ---------------------------------------------------------------------------------------------------------------------------------
// One photo per face; the face's outline (3, 4 or 5 corners) is dragged onto the face in the photo.
let photos = {}; // face -> { full canvas, img: ImageData, corners, name, canvas }
let photosFor = null;
const MAX_PHOTO = 1600;
function buildPhotos() {
  if (photosFor !== S.id) { photos = {}; photosFor = S.id; window.__app && (window.__app.photos = photos); }
  const box = $('photos'); box.textContent = '';
  const order = scanFaces();
  box.classList.toggle('three', order.length > 6);
  const t0 = P().templates[order[0]];
  const nCorners = K.outlineCorners(t0).length;
  $('photosHint').textContent = `One photo per face, in this order. Drag the outline's ${NUMBER[nCorners] || nCorners} corners onto the face's corners.`;
  order.forEach((f, k) => {
    const p = photos[f];
    const canvas = el('canvas', { class: 'pcanvas', width: '240', height: '180', 'aria-label': `Photo of the ${faceLabel(f).toLowerCase()} face` });
    const pick = el('button', { class: 'btn small ghost' }, p ? 'Replace…' : 'Choose…');
    const turn = el('button', { class: 'btn small ghost', title: 'Turn the outline one corner on: use it when the photo was taken with the puzzle turned' }, 'Turn grid');
    turn.disabled = !p;
    const cw = centreWord(f);
    const slot = el('div', { class: 'pslot' + (p ? ' has' : ''), 'data-face': f },
      el('div', { class: 'phead' }, el('b', {}, `${k + 1}. ${faceLabel(f)}`), el('span', { class: 'muted small' }, cw ? cw + ' centre' : '')),
      canvas,
      el('div', { class: 'prow' }, pick, turn, el('span', { class: 'muted small trunc' }, p ? p.name : 'No photo yet')));
    slot.title = scanSay(f);
    pick.addEventListener('click', async () => { const files = await api.pickPhotos(false); if (files[0]) await loadPhoto(f, files[0]); });
    turn.addEventListener('click', () => { if (photos[f]) { photos[f].corners = K.rotateCorners(photos[f].corners); drawPhoto(f); } });
    slot.addEventListener('dragover', (e) => { e.preventDefault(); slot.classList.add('over'); });
    slot.addEventListener('dragleave', () => slot.classList.remove('over'));
    slot.addEventListener('drop', async (e) => {
      e.preventDefault(); slot.classList.remove('over');
      const file = e.dataTransfer.files[0];
      if (file) await loadPhoto(f, { name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) });
    });
    if (p) p.canvas = canvas;
    attachCornerDrag(f, canvas);
    box.append(slot);
    if (p) drawPhoto(f);
  });
  $('photosRead').disabled = !order.every((f) => photos[f]);
}
async function loadPhoto(face, file) {
  if (file.error) { toast(`${file.name}: ${file.error}`, true); return; }
  let bmp;
  try { bmp = await createImageBitmap(new Blob([file.bytes])); } catch { toast(`${file.name}: this picture could not be read.`, true); return; }
  const scale = Math.min(1, MAX_PHOTO / Math.max(bmp.width, bmp.height));
  const w = Math.max(1, Math.round(bmp.width * scale)); const h = Math.max(1, Math.round(bmp.height * scale));
  const full = document.createElement('canvas'); full.width = w; full.height = h;
  const ctx = full.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0, w, h);
  if (bmp.close) bmp.close();
  photos[face] = { full, img: ctx.getImageData(0, 0, w, h), corners: K.placeOutline(P().templates[face], w / 2, h / 2, Math.min(w, h) * 0.6), name: file.name };
  buildPhotos();
}
async function pickAll() {
  const order = scanFaces();
  const files = await api.pickPhotos(true);
  for (let k = 0; k < files.length && k < order.length; k++) await loadPhoto(order[k], files[k]);
  if (files.length && files.length < order.length) toast(`${files.length} of ${order.length} photos chosen: add the rest one by one.`);
}
$('photosPick').addEventListener('click', pickAll);
function photoFit(p, canvas) {
  const s = Math.min(canvas.width / p.full.width, canvas.height / p.full.height);
  return { s, ox: (canvas.width - p.full.width * s) / 2, oy: (canvas.height - p.full.height * s) / 2 };
}
function drawPhoto(face) {
  const p = photos[face]; if (!p || !p.canvas) return;
  const cv = p.canvas; const ctx = cv.getContext('2d');
  const { s, ox, oy } = photoFit(p, cv);
  ctx.fillStyle = '#0b0b0d'; ctx.fillRect(0, 0, cv.width, cv.height);
  ctx.drawImage(p.full, ox, oy, p.full.width * s, p.full.height * s);
  const q = p.corners.map(([x, y]) => [ox + x * s, oy + y * s]);
  ctx.strokeStyle = 'rgba(255,255,255,0.95)'; ctx.lineWidth = 1.5; ctx.lineJoin = 'round';
  for (const c of K.templateCells(P().templates[face], q)) { ctx.beginPath(); c.poly.forEach(([x, y], k) => (k ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); ctx.closePath(); ctx.stroke(); }
  // the first corner is marked, so a turned outline is visible
  q.forEach(([x, y], k) => { ctx.fillStyle = k === 0 ? '#ff5d8f' : '#ffffff'; ctx.fillRect(x - 4, y - 4, 8, 8); ctx.strokeStyle = '#000'; ctx.strokeRect(x - 4, y - 4, 8, 8); });
}
function attachCornerDrag(face, canvas) {
  let drag = null;
  const toImg = (e) => {
    const p = photos[face]; const r = canvas.getBoundingClientRect();
    const cx = (e.clientX - r.left) * (canvas.width / r.width); const cy = (e.clientY - r.top) * (canvas.height / r.height);
    const { s, ox, oy } = photoFit(p, canvas);
    return [(cx - ox) / s, (cy - oy) / s, s];
  };
  canvas.addEventListener('pointerdown', (e) => {
    const p = photos[face]; if (!p) return;
    const [x, y, s] = toImg(e);
    const near = p.corners.map(([qx, qy], k) => [Math.hypot(qx - x, qy - y) * s, k]).sort((a, b) => a[0] - b[0])[0];
    if (near[0] < 12) drag = { corner: near[1] };
    else if (K.insidePoly(p.corners, x, y)) drag = { move: [x, y] };
    else return;
    canvas.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  canvas.addEventListener('pointermove', (e) => {
    const p = photos[face]; if (!p || !drag) return;
    const [x, y] = toImg(e);
    const W = p.full.width; const H = p.full.height;
    const cl = (v, m) => Math.max(0, Math.min(m, v));
    if (drag.corner != null) p.corners[drag.corner] = [cl(x, W), cl(y, H)];
    else { const dx = x - drag.move[0]; const dy = y - drag.move[1]; p.corners = p.corners.map(([qx, qy]) => [cl(qx + dx, W), cl(qy + dy, H)]); drag.move = [x, y]; }
    drawPhoto(face);
  });
  const end = () => { drag = null; };
  canvas.addEventListener('pointerup', end); canvas.addEventListener('pointercancel', end);
}
$('photosRead').addEventListener('click', () => {
  const byFace = {};
  for (const f of scanFaces()) { const p = photos[f]; byFace[f] = K.sampleTemplate(p.img, P().templates[f], p.corners); }
  finishScan(byFace, 'the photos');
});

// ---- start ---------------------------------------------------------------------------------------------------------------------------------
if (!AVAILABLE.length) {
  verdict('No puzzle could be loaded. Please reinstall the app.', 'err');
} else {
  buildPicker();
  setViewMode(S.opts.view);
  setPuzzle(S.opts.puzzle);
  applyMirror();
  listCameras();
}

// for the end-to-end test and the readme screenshots (read-only views plus a few helpers)
window.__app = {
  S, K, cam, photos, DEFS, ids: AVAILABLE.map((a) => a.id),
  def: () => def(),
  colours: () => cols().slice(),
  readBack: () => (view ? view.readBack() : null),
  viewAngles: () => (view ? view.angles() : null),
  player: () => ({
    pos: S.pos, total: S.solution ? S.solution.moves.length : 0, playing: S.playing,
    moves: S.solution ? S.solution.moves.map((m) => P().formatMove(m)) : [],
    stages: S.solution ? S.solution.stages.map((s) => ({ ...s })) : [],
    animating: view ? view.isAnimating() : false,
  }),
  shown: () => (S.solution ? stateAt(S.pos) : cols()),
  photoPoint: (face, x, y) => {
    const p = photos[face]; const cv = p.canvas; const r = cv.getBoundingClientRect(); const { s, ox, oy } = photoFit(p, cv);
    return { x: Math.round(r.left + (ox + x * s) * (r.width / cv.width)), y: Math.round(r.top + (oy + y * s) * (r.height / cv.height)) };
  },
  /** Where sticker i is on the screen (the middle of its cell on the map). */
  cellPoint: (i) => {
    const cell = netCells[i]; if (!cell) return null;
    cell.scrollIntoView({ block: 'nearest' });
    const root = $('netSvg'); const m = root.getScreenCTM(); const c = layout.cells.find((x) => x.i === i).centre;
    const pt = root.createSVGPoint(); pt.x = c[0]; pt.y = c[1];
    const q = pt.matrixTransform(m);
    return { x: Math.round(q.x), y: Math.round(q.y) };
  },
  ready: true,
};
