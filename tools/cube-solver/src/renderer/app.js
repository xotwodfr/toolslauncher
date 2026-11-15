import { createView } from './view3d.js';

const C = window.CubeModel;
const K = window.CubeColour;
const api = window.cube;
const $ = (id) => document.getElementById(id);
const el = (tag, attrs, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) { if (v === false || v == null) continue; if (k === 'class') n.className = v; else n.setAttribute(k, v === true ? '' : v); }
  for (const kid of kids) if (kid != null) n.append(kid);
  return n;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const NAME = C.COLOUR_NAME;
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

// ---- small conveniences kept between runs -------------------------------------------------------------------------------
const OPTS_KEY = 'cubesolver.options';
const loadOpts = () => {
  const d = { size: 3, speed: 1, view: 'front', top: 'w', front: 'g', mirror: false, grid: 62 };
  try { return { ...d, ...JSON.parse(localStorage.getItem(OPTS_KEY) || '{}') }; } catch { return d; }
};
const saveOpts = () => { try { localStorage.setItem(OPTS_KEY, JSON.stringify(S.opts)); } catch { /* fine */ } };

const S = {
  opts: loadOpts(),
  size: 3,
  colours: { 3: null, 2: null },
  marks: new Set(),     // stickers named by a problem
  unsure: new Set(),    // stickers the scanner was not sure about
  paint: 'w',
  cursor: 0,
  tab: 'fill',
  solution: null,       // { size, start, moves }
  pos: 0,
  playing: false,
  busy: false,
  engine: null,
};
S.size = S.opts.size === 2 ? 2 : 3;
if (!C.orientationScheme(S.opts.top, S.opts.front)) { S.opts.top = 'w'; S.opts.front = 'g'; }
const scheme = () => (S.size === 3 ? C.orientationScheme(S.opts.top, S.opts.front) : C.STANDARD_SCHEME);
const geo = () => C.geometry(S.size);
const cols = () => S.colours[S.size];
for (const n of [3, 2]) S.colours[n] = C.solvedColours(n, n === 3 ? C.orientationScheme(S.opts.top, S.opts.front) : C.STANDARD_SCHEME);

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
      li.title = 'The stickers concerned are outlined on the net';
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
  set: (n, c) => { if (view) view.setCube(n, c); },
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
  liveTimer = setTimeout(() => view3d.set(S.size, cols()), 30);
}

// ---- size and tabs -------------------------------------------------------------------------------------------------------------
function setSize(n) {
  if (n === S.size && netCells.length) return;
  stopPlaying();
  stopCamera();
  S.size = n; S.opts.size = n; saveOpts();
  for (const b of document.querySelectorAll('[data-size]')) b.setAttribute('aria-checked', String(Number(b.dataset.size) === n));
  S.marks.clear(); S.unsure.clear();
  clearSolution();
  showProblems([]);
  verdict('');
  $('hold3').hidden = n !== 3; $('hold2').hidden = n !== 2;
  buildNet();
  view3d.set(n, cols());
  resetScan();
  buildPhotos();
}
for (const b of document.querySelectorAll('[data-size]')) b.addEventListener('click', () => setSize(Number(b.dataset.size)));

function setTab(t) {
  S.tab = t;
  for (const b of document.querySelectorAll('[role="tab"]')) b.setAttribute('aria-selected', String(b.dataset.tab === t));
  for (const id of ['fill', 'camera', 'photos']) $('tab-' + id).hidden = id !== t;
  if (t !== 'camera') stopCamera();
}
for (const b of document.querySelectorAll('[role="tab"]')) b.addEventListener('click', () => setTab(b.dataset.tab));

// ---- palette ---------------------------------------------------------------------------------------------------------------------
const swatches = {};
function buildPalette() {
  const p = $('palette');
  C.COLOURS.forEach((c, k) => {
    const b = el('button', { class: 'swatch', role: 'radio', 'aria-checked': 'false', 'data-colour': c, title: `${cap(NAME[c])} (key ${k + 1})` },
      el('span', { class: 'chip c-' + c }), el('span', { class: 'sw-name' }, cap(NAME[c])), el('span', { class: 'sw-count' }, ''), el('kbd', {}, String(k + 1)));
    b.addEventListener('click', () => setPaint(c));
    p.append(b); swatches[c] = b;
  });
  const e = el('button', { class: 'swatch erase', role: 'radio', 'aria-checked': 'false', 'data-colour': '', title: 'Erase (key 0)' }, el('span', { class: 'chip c-none' }), el('span', { class: 'sw-name' }, 'Erase'), el('kbd', {}, '0'));
  e.addEventListener('click', () => setPaint(null));
  p.append(e); swatches.none = e;
  setPaint('w');
}
function setPaint(c) {
  S.paint = c;
  for (const [k, b] of Object.entries(swatches)) b.setAttribute('aria-checked', String((k === 'none' ? null : k) === c));
}
function refreshCounts() {
  const count = Object.fromEntries(C.COLOURS.map((c) => [c, 0]));
  let empty = 0;
  for (const c of cols()) { if (c) count[c]++; else empty++; }
  const want = S.size * S.size;
  for (const c of C.COLOURS) {
    const s = swatches[c].querySelector('.sw-count');
    s.textContent = `${count[c]}/${want}`;
    s.classList.toggle('off', count[c] !== want);
  }
  $('netInfo').textContent = empty ? `${empty} to fill in` : '';
}

// ---- the net ------------------------------------------------------------------------------------------------------------------------
const BLOCK = { U: [1, 0], L: [0, 1], F: [1, 1], R: [2, 1], B: [3, 1], D: [1, 2] };
const FACE_LABEL = { U: 'Top', L: 'Left', F: 'Front', R: 'Right', B: 'Back', D: 'Bottom' };
let netCells = []; let cellAt = new Map(); let coordOf = [];
function buildNet() {
  const net = $('net'); net.textContent = '';
  const n = S.size; const g = geo();
  net.style.setProperty('--n', n);
  net.classList.toggle('two', n === 2);
  netCells = []; cellAt = new Map(); coordOf = [];
  for (const f of C.FACES) {
    const face = el('div', { class: 'face', 'data-label': FACE_LABEL[f], role: 'rowgroup', 'aria-label': FACE_LABEL[f] + ' face' });
    face.style.gridColumn = String(BLOCK[f][0] + 1); face.style.gridRow = String(BLOCK[f][1] + 1);
    for (const s of g.stickers.filter((x) => x.face === f)) {
      const centre = g.centres.includes(s.i);
      const b = el('button', { class: 'sticker' + (centre ? ' centre' : ''), 'data-i': s.i, tabindex: '-1', role: 'gridcell' });
      face.append(b);
      netCells[s.i] = b;
      const x = BLOCK[f][0] * n + s.c; const y = BLOCK[f][1] * n + s.r;
      coordOf[s.i] = [x, y]; cellAt.set(x + ',' + y, s.i);
    }
    net.append(face);
  }
  if (!netCells[S.cursor]) S.cursor = 0;
  refreshNet();
}
function stickerLabel(i) {
  const s = geo().stickers[i];
  const c = cols()[i];
  return `${FACE_LABEL[s.face]} face, row ${s.r + 1}, column ${s.c + 1}: ${c ? NAME[c] : 'empty'}${geo().centres.includes(i) ? ' (centre)' : ''}`;
}
function refreshNet() {
  if (netCells.length !== geo().size) return; // the net for the other size is about to be rebuilt
  const c = cols();
  netCells.forEach((b, i) => {
    b.className = 'sticker' + (geo().centres.includes(i) ? ' centre' : '') + ' c-' + (c[i] || 'none') + (S.marks.has(i) ? ' bad' : '') + (S.unsure.has(i) ? ' unsure' : '') + (i === S.cursor ? ' cursor' : '');
    b.tabIndex = i === S.cursor ? 0 : -1;
    b.setAttribute('aria-label', stickerLabel(i));
  });
  refreshCounts();
}
function setSticker(i, colour) {
  const g = geo();
  if (g.centres.includes(i)) { toast('Centres never move on a 3x3: to change them, choose the top and front colours under "How to hold the cube".'); return false; }
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
  S.colours[S.size] = Array.from(colours);
  if (!scanned) S.unsure.clear();
  clearSolution();
  showProblems([]);
  verdict('');
  refreshNet();
  showEntered();
}

let painting = false;
$('net').addEventListener('pointerdown', (e) => {
  const b = e.target.closest('.sticker'); if (!b) return;
  e.preventDefault();
  const i = Number(b.dataset.i);
  S.cursor = i;
  const colour = e.button === 2 ? null : S.paint;
  setSticker(i, colour);
  if (!geo().centres.includes(i)) painting = { colour };
  refreshNet();
  b.focus({ preventScroll: true });
});
$('net').addEventListener('pointermove', (e) => {
  if (!painting) return;
  const b = document.elementFromPoint(e.clientX, e.clientY);
  const s = b && b.closest && b.closest('.sticker');
  if (!s) return;
  const i = Number(s.dataset.i);
  if (!geo().centres.includes(i)) { S.cursor = i; setSticker(i, painting.colour); refreshNet(); }
});
window.addEventListener('pointerup', () => { painting = false; });
window.addEventListener('pointercancel', () => { painting = false; });
$('net').addEventListener('contextmenu', (e) => e.preventDefault());
$('net').addEventListener('keydown', (e) => {
  const dirs = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
  if (dirs[e.key]) {
    e.preventDefault();
    const [dx, dy] = dirs[e.key];
    let [x, y] = coordOf[S.cursor];
    const n = S.size;
    for (let k = 0; k < 4 * n; k++) {
      x += dx; y += dy;
      if (x < 0 || y < 0 || x >= 4 * n || y >= 3 * n) break;
      const i = cellAt.get(x + ',' + y);
      if (i != null) { S.cursor = i; break; }
    }
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
  if (typing || e.ctrlKey || e.altKey || e.metaKey) return;
  if (S.tab === 'fill' && /^[0-6]$/.test(e.key)) { setPaint(e.key === '0' ? null : C.COLOURS[Number(e.key) - 1]); e.preventDefault(); }
  if (S.tab === 'camera' && e.key === ' ' && !(t && (t.tagName === 'BUTTON' || t.tagName === 'INPUT'))) { e.preventDefault(); capture(); }
});

$('reset').addEventListener('click', () => setAll(C.solvedColours(S.size, scheme())));
$('clear').addEventListener('click', () => {
  const g = geo();
  setAll(cols().map((c, i) => (g.centres.includes(i) ? c : null)));
  S.cursor = g.stickers.find((s) => !g.centres.includes(s.i)).i;
  refreshNet();
});
$('random').addEventListener('click', () => {
  const moves = C.randomMoves(S.size, S.size === 3 ? 25 : 11);
  setAll(C.applyMoves(S.size, C.solvedColours(S.size, scheme()), moves));
  $('turnsText').value = C.formatMoves(moves);
  toast('Scrambled with the turns shown under the net. Do them on a solved cube to follow along.');
});
function applyTurns() {
  let moves;
  try { moves = C.parseMoves($('turnsText').value); } catch (e) { toast(e.message, true); return; }
  if (!moves.length) { toast('Type some turns first, for example R U R\' U\'', true); return; }
  setAll(C.applyMoves(S.size, C.solvedColours(S.size, scheme()), moves));
  toast(`Applied ${moves.length} ${moves.length === 1 ? 'turn' : 'turns'} to a solved cube.`);
}
$('applyTurns').addEventListener('click', applyTurns);
$('turnsText').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); applyTurns(); } });

// holding the cube (3x3 centres)
function buildOrient() {
  const top = $('oTop'); const front = $('oFront');
  top.textContent = '';
  for (const c of C.COLOURS) top.append(el('option', { value: c }, cap(NAME[c])));
  top.value = S.opts.top;
  fillFront();
  function fillFront() {
    front.textContent = '';
    for (const c of C.COLOURS) if (C.orientationScheme(top.value, c)) front.append(el('option', { value: c }, cap(NAME[c])));
    front.value = C.orientationScheme(top.value, S.opts.front) ? S.opts.front : front.options[0].value;
  }
  const changed = () => {
    S.opts.top = top.value; S.opts.front = front.value; saveOpts();
    $('hTop').textContent = NAME[top.value]; $('hFront').textContent = NAME[front.value];
    const sc = C.orientationScheme(top.value, front.value);
    const g = C.geometry(3);
    const c3 = S.colours[3].slice();
    g.centres.forEach((i, f) => { c3[i] = sc[C.FACES[f]]; });
    S.colours[3] = c3;
    if (S.size === 3) { afterEdit(); resetScan(); buildPhotos(); }
  };
  top.addEventListener('change', () => { fillFront(); changed(); });
  front.addEventListener('change', changed);
  $('hTop').textContent = NAME[top.value]; $('hFront').textContent = NAME[front.value];
}

// ---- solving ----------------------------------------------------------------------------------------------------------------------------
function engineText(s) {
  if (!s) return;
  S.engine = s;
  const p = Math.round(((s.progress2 || 0) * 0.25 + (s.progress3 || 0) * 0.75) * 100);
  const ready = s.ready2 && s.ready3;
  $('engine').textContent = s.error ? 'The solver could not start: ' + s.error : ready ? 'Solver ready' : `Getting the solver ready… ${p}%`;
  $('engineProg').hidden = ready || !!s.error;
  $('engineFill').style.width = p + '%';
  $('engineProg').setAttribute('aria-valuenow', String(p));
}
api.onStatus(engineText);
api.status().then(engineText);

async function solve() {
  if (S.busy) return;
  stopPlaying();
  const n = S.size;
  const v = C.validate(n, cols());
  if (!v.ok) {
    showProblems(v.errors);
    verdict(v.errors.length === 1 ? "This cube can't be solved as filled in:" : `This cube can't be solved as filled in (${v.errors.length} problems):`, 'err');
    if (S.marks.size && S.tab !== 'fill') setTab('fill');
    return;
  }
  showProblems([]);
  if (v.solved) { verdict('This cube is already solved.', 'ok'); return; }
  S.busy = true;
  $('solve').disabled = true;
  const ready = S.engine && S.engine[`ready${n}`];
  verdict(ready ? 'Solving…' : 'Waiting for the solver to get ready…');
  try {
    const start = cols().slice();
    const r = await api.solve(n, v.faces.join(''));
    const moves = C.parseMoves(r.moves);
    // check it again here: what is shown must solve exactly the cube on screen
    if (!C.isSolved(n, C.applyMoves(n, start, moves))) throw new Error('The answer did not solve this cube, so it is not shown.');
    if (S.size !== n || cols().join() !== start.join()) return; // the cube changed while solving
    S.solution = { size: n, start, moves };
    S.pos = 0;
    verdict(`Solved in ${moves.length} ${moves.length === 1 ? 'turn' : 'turns'}${n === 2 ? ' (the fewest possible)' : ''}.`, 'ok');
    $('moveInfo').textContent = `${moves.length} face turns · found in ${r.ms < 1000 ? r.ms + ' ms' : (r.ms / 1000).toFixed(1) + ' s'} · ${n === 3 ? 'two-phase search' : 'optimal'}`;
    buildChips();
    $('solution').hidden = false;
    $('viewTitle').textContent = 'Solution';
    goTo(0);
  } catch (e) {
    verdict(String(e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), 'err');
  } finally {
    S.busy = false;
    $('solve').disabled = false;
  }
}
$('solve').addEventListener('click', solve);

// ---- the player ------------------------------------------------------------------------------------------------------------------------
let chips = [];
function buildChips() {
  const box = $('chips'); box.textContent = ''; chips = [];
  S.solution.moves.forEach((m, k) => {
    const b = el('button', { class: 'mchip', 'data-k': k, title: `Turn ${k + 1}: ${describe(m)}` }, el('span', { class: 'mi' }, String(k + 1)), m);
    b.addEventListener('click', () => { stopPlaying(); goTo(k + 1); });
    box.append(b); chips.push(b);
  });
}
function describe(m) {
  const face = { U: 'top', D: 'bottom', L: 'left', R: 'right', F: 'front', B: 'back' }[m[0]];
  return m.endsWith('2') ? `the ${face} face half a turn` : m.endsWith("'") ? `the ${face} face a quarter anticlockwise` : `the ${face} face a quarter clockwise`;
}
const stateAt = (pos) => C.applyMoves(S.solution.size, S.solution.start, S.solution.moves.slice(0, pos));
function refreshPlayer() {
  const N = S.solution ? S.solution.moves.length : 0;
  chips.forEach((b, k) => {
    b.classList.toggle('done', k < S.pos - 1);
    b.classList.toggle('now', k === S.pos - 1);
    b.classList.toggle('next', k === S.pos);
    b.setAttribute('aria-current', k === S.pos - 1 ? 'step' : 'false');
  });
  $('pCount').textContent = S.pos === N ? `Turn ${N} of ${N} · solved` : `Turn ${S.pos} of ${N}`;
  $('pNext').textContent = S.pos < N ? `Next: ${S.solution.moves[S.pos]}, ${describe(S.solution.moves[S.pos])}.` : 'Done: every face is one colour again.';
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
    S.pos = Math.max(0, Math.min(S.solution.moves.length, pos));
    view3d.set(S.solution.size, stateAt(S.pos));
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
      const m = C.inverseMove(S.solution.moves[S.pos - 1]);
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
$('pEnd').addEventListener('click', () => { stopPlaying(); goTo(S.solution.moves.length); });
$('speed').value = String(S.opts.speed);
$('speed').addEventListener('input', () => { S.opts.speed = Number($('speed').value); saveOpts(); });
function clearSolution() {
  stopPlaying();
  S.solution = null; S.pos = 0; chips = [];
  $('solution').hidden = true;
  $('viewTitle').textContent = 'Your cube';
  if (netCells.length) view3d.set(S.size, cols());
}
function solutionText() {
  const s = S.solution;
  return [`Rubik's Cube Solver - ${s.size}x${s.size}`, '', `Cube (stickers U R F D L B): ${s.start.join('')}`, '', `Solution (${s.moves.length} turns):`, C.formatMoves(s.moves), ''].join('\n');
}
$('copy').addEventListener('click', async () => { try { await api.copy(C.formatMoves(S.solution.moves)); toast('The solution is on the clipboard.'); } catch (e) { toast(String(e.message || e), true); } });
$('save').addEventListener('click', async () => {
  try { const r = await api.saveSolution(solutionText()); if (r && r.ok) toast('Saved to ' + r.path); } catch (e) { toast(String(e.message || e), true); }
});

// ---- scanning: shared ----------------------------------------------------------------------------------------------------------------------
const SCAN_ORDER = ['F', 'R', 'B', 'L', 'U', 'D'];
function scanSay(face) {
  const n = S.size;
  if (n === 3) {
    const sc = scheme(); const w = (f) => NAME[sc[f]];
    switch (face) {
      case 'F': return `Show the ${w('F')}-centred face, ${w('U')} on top.`;
      case 'R': return `Turn the cube a quarter to the left: the ${w('R')}-centred face, ${w('U')} still on top.`;
      case 'B': return `Another quarter to the left: the ${w('B')}-centred face, ${w('U')} on top.`;
      case 'L': return `Another quarter: the ${w('L')}-centred face, ${w('U')} on top.`;
      case 'U': return `Turn back to ${w('F')} facing you, then tip the top towards you: the ${w('U')}-centred face, ${w('B')} on top.`;
      default: return `Now tip it the other way: the ${w('D')}-centred face, ${w('F')} on top.`;
    }
  }
  switch (face) {
    case 'F': return 'Show the face you want as the front, with your chosen top face on top.';
    case 'R': return 'Turn the cube a quarter to the left: the right face, same top.';
    case 'B': return 'Another quarter to the left: the back face, same top.';
    case 'L': return 'Another quarter: the left face, same top.';
    case 'U': return 'Turn back to the front, then tip the top towards you: the top face, the back on top.';
    default: return 'Now tip it the other way: the bottom face, the front on top.';
  }
}
/** samples per face (URFDLB) -> colours into the net. */
function finishScan(byFace, how) {
  const n = S.size;
  const faces = C.FACES.map((f) => byFace[f]);
  let res;
  try {
    res = n === 3 ? K.classify3(faces, C.FACES.map((f) => scheme()[f])) : K.classify2(faces);
  } catch (e) { toast(String(e.message || e), true); return; }
  S.colours[n] = res.colours.slice();
  S.unsure = new Set(res.unsure);
  setAll(res.colours, { scanned: true });
  setTab('fill');
  const unsure = res.unsure.length;
  verdict(`Read from ${how}. ${unsure ? `Check the ${unsure} ${unsure === 1 ? 'sticker' : 'stickers'} with a dotted outline, then press Solve.` : 'Check the net against your cube, then press Solve.'}`);
}
function miniFace(colours, n, big = false) {
  const box = el('div', { class: 'miniface' + (big ? ' big' : '') });
  box.style.setProperty('--n', n);
  for (let k = 0; k < n * n; k++) box.append(el('span', { class: 'c-' + ((colours && colours[k]) || 'none') }));
  return box;
}

// ---- webcam ---------------------------------------------------------------------------------------------------------------------------------
const cam = { stream: null, step: 0, captured: {}, live: null, timer: null };
const work = document.createElement('canvas');
const workCtx = work.getContext('2d', { willReadFrequently: true });
function resetScan() {
  cam.captured = {}; cam.step = 0; cam.live = null;
  renderCamFaces();
  if (S.tab === 'camera') $('camSay').textContent = cam.stream ? scanSay(SCAN_ORDER[0]) : 'Press Start camera. The picture stays on this computer: nothing is recorded or saved.';
}
function renderCamFaces() {
  const box = $('camFaces'); box.textContent = '';
  SCAN_ORDER.forEach((f, k) => {
    const got = cam.captured[f];
    const b = el('button', { class: 'facebtn' + (k === cam.step && cam.stream ? ' current' : '') + (got ? ' got' : ''), 'data-face': f, title: got ? 'Scan this face again' : 'Not scanned yet' },
      miniFace(got ? got.guess : null, S.size), el('span', { class: 'fl' }, FACE_LABEL[f] + (S.size === 3 ? ' · ' + NAME[scheme()[f]] : '')));
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
    $('camSay').textContent = why + ' You can also use Photos or fill the cube in by hand.';
    return;
  }
  const v = $('video');
  v.srcObject = cam.stream;
  try { await v.play(); } catch { /* autoplay of a muted stream is allowed */ }
  $('camStart').hidden = true; $('camStop').hidden = false; $('capture').disabled = false;
  await listCameras();
  $('camSay').textContent = scanSay(SCAN_ORDER[cam.step]);
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
  renderLive(null);
}
function camQuad(w, h) { return K.squareQuad(w / 2, h / 2, Math.min(w, h) * (Number($('gridSize').value) / 100)); }
function readFrame() {
  const v = $('video');
  if (!cam.stream || v.readyState < 2 || !v.videoWidth) return;
  const scale = Math.min(1, 480 / Math.max(v.videoWidth, v.videoHeight));
  const w = Math.round(v.videoWidth * scale); const h = Math.round(v.videoHeight * scale);
  if (work.width !== w || work.height !== h) { work.width = w; work.height = h; $('camView').style.aspectRatio = `${w} / ${h}`; }
  workCtx.drawImage(v, 0, 0, w, h);
  const img = workCtx.getImageData(0, 0, w, h);
  const quad = camQuad(w, h);
  const samples = K.sampleFace(img, quad, S.size);
  const refs = {};
  if (S.size === 3) for (const f of C.FACES) if (cam.captured[f]) refs[scheme()[f]] = cam.captured[f].samples[4].lab;
  const guess = K.liveGuess(samples, refs);
  cam.live = { samples, guess, face: SCAN_ORDER[cam.step] };
  drawOverlay(quad, w, h, guess);
  renderLive(guess);
}
function drawOverlay(quad, w, h, guess) {
  const o = $('overlay');
  if (o.width !== w || o.height !== h) { o.width = w; o.height = h; }
  const ctx = o.getContext('2d');
  ctx.clearRect(0, 0, w, h);
  const n = S.size;
  ctx.lineWidth = 2; ctx.strokeStyle = 'rgba(255,255,255,0.9)';
  for (let k = 0; k <= n; k++) {
    const a = K.quadPoint(quad, k / n, 0); const b = K.quadPoint(quad, k / n, 1);
    const c = K.quadPoint(quad, 0, k / n); const d = K.quadPoint(quad, 1, k / n);
    ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.moveTo(c[0], c[1]); ctx.lineTo(d[0], d[1]); ctx.stroke();
  }
  const cells = K.gridCells(quad, n);
  cells.forEach((cell, k) => {
    const r = (quad[1][0] - quad[0][0]) / n * 0.14;
    ctx.fillStyle = C.COLOUR_HEX[guess[k]];
    ctx.strokeStyle = '#000'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(cell.centre[0], cell.centre[1], r, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  });
}
function renderLive(guess) {
  const box = $('liveFace');
  const mf = miniFace(guess, S.size, true);
  box.replaceWith(mf); mf.id = 'liveFace';
}
function capture() {
  if (!cam.stream || !cam.live) return;
  const face = SCAN_ORDER[cam.step];
  cam.captured[face] = { samples: cam.live.samples, guess: cam.live.guess };
  const next = SCAN_ORDER.findIndex((f, k) => k > cam.step && !cam.captured[f]);
  const anyLeft = SCAN_ORDER.findIndex((f) => !cam.captured[f]);
  if (anyLeft < 0) {
    const byFace = Object.fromEntries(C.FACES.map((f) => [f, cam.captured[f].samples]));
    stopCamera();
    finishScan(byFace, 'the camera');
    resetScan();
    return;
  }
  cam.step = next >= 0 ? next : anyLeft;
  $('camSay').textContent = scanSay(SCAN_ORDER[cam.step]);
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
const photos = {}; // face -> { img: ImageData, bitmap canvas, quad, name, canvas, scale }
const MAX_PHOTO = 1600;
function buildPhotos() {
  const box = $('photos'); box.textContent = '';
  SCAN_ORDER.forEach((f, k) => {
    const p = photos[f];
    const canvas = el('canvas', { class: 'pcanvas', width: '240', height: '180', 'aria-label': `Photo of the ${FACE_LABEL[f].toLowerCase()} face` });
    const pick = el('button', { class: 'btn small ghost' }, p ? 'Replace…' : 'Choose…');
    const turn = el('button', { class: 'btn small ghost', title: 'Turn the grid a quarter: use it when the photo was taken with the cube on its side' }, 'Turn grid');
    turn.disabled = !p;
    const slot = el('div', { class: 'pslot' + (p ? ' has' : ''), 'data-face': f },
      el('div', { class: 'phead' }, el('b', {}, `${k + 1}. ${FACE_LABEL[f]}`), el('span', { class: 'muted small' }, S.size === 3 ? NAME[scheme()[f]] + ' centre' : '')),
      canvas,
      el('div', { class: 'prow' }, pick, turn, el('span', { class: 'muted small trunc' }, p ? p.name : 'No photo yet')));
    slot.title = scanSay(f);
    pick.addEventListener('click', async () => { const files = await api.pickPhotos(false); if (files[0]) await loadPhoto(f, files[0]); });
    turn.addEventListener('click', () => { if (photos[f]) { photos[f].quad = K.rotateQuad(photos[f].quad); drawPhoto(f); } });
    slot.addEventListener('dragover', (e) => { e.preventDefault(); slot.classList.add('over'); });
    slot.addEventListener('dragleave', () => slot.classList.remove('over'));
    slot.addEventListener('drop', async (e) => {
      e.preventDefault(); slot.classList.remove('over');
      const file = e.dataTransfer.files[0];
      if (file) await loadPhoto(f, { name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) });
    });
    if (p) p.canvas = canvas;
    attachQuadDrag(f, canvas);
    box.append(slot);
    if (p) drawPhoto(f);
  });
  $('photosRead').disabled = !SCAN_ORDER.every((f) => photos[f]);
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
  photos[face] = { full, img: ctx.getImageData(0, 0, w, h), quad: K.squareQuad(w / 2, h / 2, Math.min(w, h) * 0.6), name: file.name };
  buildPhotos();
}
async function pickSix() {
  const files = await api.pickPhotos(true);
  for (let k = 0; k < files.length && k < 6; k++) await loadPhoto(SCAN_ORDER[k], files[k]);
  if (files.length && files.length < 6) toast(`${files.length} of 6 photos chosen: add the rest one by one.`);
}
$('photosPick').addEventListener('click', pickSix);
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
  const q = p.quad.map(([x, y]) => [ox + x * s, oy + y * s]);
  const n = S.size;
  ctx.strokeStyle = 'rgba(255,255,255,0.95)'; ctx.lineWidth = 1.5;
  for (let k = 0; k <= n; k++) {
    const a = K.quadPoint(q, k / n, 0); const b = K.quadPoint(q, k / n, 1); const c = K.quadPoint(q, 0, k / n); const d = K.quadPoint(q, 1, k / n);
    ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.moveTo(c[0], c[1]); ctx.lineTo(d[0], d[1]); ctx.stroke();
  }
  // the top-left corner is marked, so a turned grid is visible
  q.forEach(([x, y], k) => { ctx.fillStyle = k === 0 ? '#ff5d8f' : '#ffffff'; ctx.fillRect(x - 4, y - 4, 8, 8); ctx.strokeStyle = '#000'; ctx.strokeRect(x - 4, y - 4, 8, 8); });
}
function attachQuadDrag(face, canvas) {
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
    const near = p.quad.map(([qx, qy], k) => [Math.hypot(qx - x, qy - y) * s, k]).sort((a, b) => a[0] - b[0])[0];
    if (near[0] < 12) drag = { corner: near[1] };
    else if (inside(p.quad, x, y)) drag = { move: [x, y] };
    else return;
    canvas.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  canvas.addEventListener('pointermove', (e) => {
    const p = photos[face]; if (!p || !drag) return;
    const [x, y] = toImg(e);
    const W = p.full.width; const H = p.full.height;
    const cl = (v, m) => Math.max(0, Math.min(m, v));
    if (drag.corner != null) p.quad[drag.corner] = [cl(x, W), cl(y, H)];
    else { const dx = x - drag.move[0]; const dy = y - drag.move[1]; p.quad = p.quad.map(([qx, qy]) => [cl(qx + dx, W), cl(qy + dy, H)]); drag.move = [x, y]; }
    drawPhoto(face);
  });
  const end = () => { drag = null; };
  canvas.addEventListener('pointerup', end); canvas.addEventListener('pointercancel', end);
}
function inside(q, x, y) {
  let ins = false;
  for (let i = 0, j = q.length - 1; i < q.length; j = i++) {
    const [xi, yi] = q[i]; const [xj, yj] = q[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) ins = !ins;
  }
  return ins;
}
$('photosRead').addEventListener('click', () => {
  const byFace = {};
  for (const f of C.FACES) { const p = photos[f]; byFace[f] = K.sampleFace(p.img, p.quad, S.size); }
  finishScan(byFace, 'the photos');
});

// ---- start ---------------------------------------------------------------------------------------------------------------------------------
buildPalette();
buildOrient();
setViewMode(S.opts.view);
setSize(S.size);
applyMirror();
listCameras();

// for the end-to-end test and the readme screenshot (read-only views plus a few helpers)
window.__app = {
  S, C, K, cam, photos,
  colours: () => cols().slice(),
  readBack: () => (view ? view.readBack() : null),
  player: () => ({ pos: S.pos, total: S.solution ? S.solution.moves.length : 0, playing: S.playing, moves: S.solution ? S.solution.moves.slice() : [], animating: view ? view.isAnimating() : false }),
  shown: () => (S.solution ? stateAt(S.pos) : cols()),
  photoPoint: (face, x, y) => {
    const p = photos[face]; const cv = p.canvas; const r = cv.getBoundingClientRect(); const { s, ox, oy } = photoFit(p, cv);
    return { x: Math.round(r.left + (ox + x * s) * (r.width / cv.width)), y: Math.round(r.top + (oy + y * s) * (r.height / cv.height)) };
  },
  ready: true,
};
