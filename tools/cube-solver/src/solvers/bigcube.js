'use strict';
// Human-method ("reduction") solver for the 4x4 and 5x5, shared by solvers/cube4.js and solvers/cube5.js. Node only.
//
// Stages, as a person solves a big cube:
//   1. Centres. "<top> and <bottom> centres", then "Last four centres". The 4x4 has no fixed centres: which colour goes
//      where comes from the corners (see bigcube-kit.js), on the 5x5 from the middle stickers. Each stage is done in two
//      small steps, each by an exact table (a breadth-first search done once in init) over where the centre stickers of
//      the colours that step is about are:
//        a. both top/bottom colours onto the top and bottom (any mix)          all turns
//        b. split them: top colour on top, bottom colour on the bottom         U D u d R L F B, r2 l2 f2 b2
//        c. front/back colours onto the front and back (the rest is then on the sides)   U D u d R L F B
//        d. split those pairs                                                   U D u2 d2 R L F B
//      Each table is for one kind of centre piece ("orbit": the 4x4's centres; the 5x5's diagonal x-centres and its
//      straight t-centres). The 4x4 has one orbit, so a step is a walk down its table. The 5x5 has two, and a step is an
//      IDA* search with the larger of the two table distances as the estimate.
//   2. "Pair the edges": the slice-flip-slice method. A step is: set up with outer turns (they never break a centre or a
//      finished edge), turn an inner slice (u or d) so edge pieces meet, take the new pair out of that slice with a few
//      outer turns that leave the side faces as they were ("R U R'", "R U R' F R' F' R" ...), and turn the slice back,
//      which restores the centres. Every step is chosen by trying all short setups with all such "slice, store, slice
//      back" blocks and taking the one that pairs the most per turn. 4x4: an edge is paired when its two pieces show the
//      same colours. 5x5: each wing is matched to the middle piece of its edge; if at the end one edge has both wings
//      the wrong way round ("Fix the flipped edge"), a standard parity algorithm swaps them.
//   3. "Solve it like a 3x3": the corners, the paired edges and the centres are read as a 3x3 and solved with the app's
//      3x3 solver (Kociemba two-phase, ../solver3.js), outer turns only. On a 4x4 the reduced cube can be an impossible
//      3x3 ("parity"): one edge flipped -> "Fix the edge parity" (r2 B2 U2 l U2 r' U2 r U2 F2 r F2 l' B2 r2), or two edges
//      swapped -> "Fix the swapped edges" (r2 U2 r2 Uw2 r2 Uw2), then the 3x3 solve.
const C = require('../cube');
const S3 = require('../solver3');
const Kit = require('../puzzles/bigcube-kit');

const { FACES } = Kit;
const AXIS_OF = { U: 1, D: 1, R: 0, L: 0, F: 2, B: 2 };

function makeSolver(n) {
  const def = require('../puzzles/cube' + n);
  const kit = def.kit;
  const P = def.puzzle;
  const size = P.size;

  // ---- moves ----
  // A move is { turn, amount }, with a precomputed sticker permutation.
  const moveList = []; // all outer + inner-slice moves (no wide turns, no middle slices)
  const turnNames = [...FACES, ...FACES.map((f) => f.toLowerCase())];
  for (const t of turnNames) {
    for (const k of [1, 2, 3]) {
      const info = kit.turnInfo[t];
      // canonical order on one axis: layer index counted from the U / R / F side
      const face = info.face;
      const pos = ['U', 'R', 'F'].includes(face) ? info.layers[0] : n - 1 - info.layers[0];
      moveList.push({ turn: t, amount: k, perm: P.turns[t].powers[k], axis: AXIS_OF[face], layer: pos, name: P.formatMove({ turn: t, amount: k }) });
    }
  }
  const moveByName = new Map(moveList.map((mv) => [mv.name, mv]));
  const mv = (name) => { const x = moveByName.get(name); if (!x) throw new Error('no move ' + name); return x; };
  const movesOf = (names) => names.split(' ').map(mv);
  const applyPerm = (state, p) => { const out = new Array(size); for (let i = 0; i < size; i++) out[i] = state[p[i]]; return out; };
  const applyAll = (state, moves) => { let s = state; for (const m of moves) s = applyPerm(s, m.perm); return s; };

  // ---- centre orbits and tables ----
  const orbits = n === 4 ? [kit.xCentres] : [kit.xCentres, kit.tCentres];
  // per orbit: for every move, byte tables that move a 24-bit mask of orbit positions
  const orbitData = orbits.map((O) => {
    const posIn = new Map(O.map((s, j) => [s, j]));
    const faceOfPos = O.map((s) => kit.stickers[s].face);
    const moveTabs = moveList.map((m) => {
      const dst = new Array(24);
      for (let j = 0; j < 24; j++) { const q = posIn.get(m.perm[O[j]]); dst[q] = j; } // bit q moves to bit j
      const tabs = [new Int32Array(256), new Int32Array(256), new Int32Array(256)];
      for (let b = 0; b < 3; b++) for (let v = 0; v < 256; v++) { let r = 0; for (let k = 0; k < 8; k++) if (v & (1 << k)) r |= 1 << dst[8 * b + k]; tabs[b][v] = r; }
      return tabs;
    });
    const flat = new Int32Array(moveList.length * 768);
    moveTabs.forEach((tabs, mi) => tabs.forEach((t, b) => flat.set(t, mi * 768 + b * 256)));
    return { O, faceOfPos, moveTabs, flat };
  });
  const moveMask = (od, mi, mask) => { const t = od.flat; const o = mi * 768; return t[o + (mask & 255)] | t[o + 256 + ((mask >>> 8) & 255)] | t[o + 512 + (mask >>> 16)]; };
  const maskOf = (od, faces) => { let r = 0; for (let j = 0; j < 24; j++) if (faces.includes(od.faceOfPos[j])) r |= 1 << j; return r; };
  // extractor: the bits of a mask at the given positions, packed
  function extractor(positions) {
    if (positions.length === 24 && positions.every((p, k) => p === k)) return (mask) => mask;
    const tabs = [new Int32Array(256), new Int32Array(256), new Int32Array(256)];
    for (let b = 0; b < 3; b++) for (let v = 0; v < 256; v++) { let r = 0; positions.forEach((p, k) => { if (p >> 3 === b && v & (1 << (p & 7))) r |= 1 << k; }); tabs[b][v] = r; }
    return (mask) => tabs[0][mask & 255] | tabs[1][(mask >>> 8) & 255] | tabs[2][mask >>> 16];
  }
  const posOfFaces = (od, faces) => { const r = []; for (let j = 0; j < 24; j++) if (faces.includes(od.faceOfPos[j])) r.push(j); return r; };

  // A centre step: groups = [{ faces (colours tracked), region (faces where they can be during the step) }], goal: each
  // group's stickers exactly on groups[g].target faces. Moves: names.
  const ALL = moveList.map((m) => m.name);
  const outerAndYSlices = moveList.filter((m) => ['U', 'D', 'u', 'd', 'R', 'L', 'F', 'B'].includes(m.turn)).map((m) => m.name);
  const STEPS = [
    { groups: [{ track: ['U', 'D'], region: FACES, target: ['U', 'D'] }], moves: ALL },
    { groups: [{ track: ['U'], region: ['U', 'D'], target: ['U'] }], moves: [...outerAndYSlices, 'r2', 'l2', 'f2', 'b2'] },
    { groups: [{ track: ['F', 'B'], region: ['F', 'B', 'R', 'L'], target: ['F', 'B'] }], moves: outerAndYSlices },
    { groups: [{ track: ['F'], region: ['F', 'B'], target: ['F'] }, { track: ['R'], region: ['R', 'L'], target: ['R'] }],
      moves: [...moveList.filter((m) => FACES.includes(m.turn)).map((m) => m.name), 'u2', 'd2'] },
  ];
  // Components of a step's state: one 24-bit mask per (orbit, group): where that group's colours are in that orbit.
  // Pattern tables: each covers some components, indexed by the packed bits of their masks inside their regions; built
  // by a breadth-first search from the goal with the step's moves. Their distances are exact for what they cover.
  function buildTable(step, comps) {
    const mis = step.moves.map((name) => moveList.indexOf(mv(name)));
    const G = step.groups.length;
    const parts = comps.map((c) => { const od = orbitData[Math.floor(c / G)]; const g = step.groups[c % G]; const pos = posOfFaces(od, g.region); return { c, od, ext: extractor(pos), width: pos.length, goal: maskOf(od, g.target) }; });
    const total = parts.reduce((s2, x) => s2 + x.width, 0);
    const index = (masks) => { let r = 0; for (const pt of parts) r = r * (2 ** pt.width) + pt.ext(masks[pt.c]); return r; };
    const dist = new Uint8Array(2 ** total).fill(255);
    const K = orbitData.length * G;
    // breadth-first search over the covered masks only, kept in flat typed arrays (fast, little garbage)
    const np = parts.length;
    const local = (lm) => { let r = 0; for (let q = 0; q < np; q++) r = r * (2 ** parts[q].width) + parts[q].ext(lm[q]); return r; };
    let frontier = Int32Array.from(parts.map((pt) => pt.goal));
    dist[local(frontier)] = 0;
    let reached = 1;
    const lm = new Int32Array(np);
    if (np === 1 && parts[0].width === 24) {
      // the big one (all 24 positions, no packing): a tight loop
      const t = parts[0].od.flat; const offs = mis.map((mi) => mi * 768);
      let cur = new Int32Array(1); cur[0] = parts[0].goal;
      for (let d = 0; cur.length; d++) {
        let next = new Int32Array(Math.max(1024, cur.length * 6)); let nn = 0;
        for (let i = 0; i < cur.length; i++) {
          const mk = cur[i]; const a0 = mk & 255; const a1 = 256 + ((mk >>> 8) & 255); const a2 = 512 + (mk >>> 16);
          for (let q = 0; q < offs.length; q++) {
            const o = offs[q]; const ix = t[o + a0] | t[o + a1] | t[o + a2];
            if (dist[ix] !== 255) continue;
            dist[ix] = d + 1; reached++;
            if (nn === next.length) { const bigger = new Int32Array(next.length * 2); bigger.set(next); next = bigger; }
            next[nn++] = ix;
          }
        }
        cur = next.subarray(0, nn);
      }
      frontier = new Int32Array(0);
    }
    for (let d = 0; frontier.length; d++) {
      const cnt = frontier.length / np;
      let next = new Int32Array(Math.max(1024, cnt * 4 * np)); let nn = 0;
      for (let i = 0; i < cnt; i++) {
        for (const mi of mis) {
          for (let q = 0; q < np; q++) lm[q] = moveMask(parts[q].od, mi, frontier[i * np + q]);
          const ix = local(lm);
          if (dist[ix] !== 255) continue;
          dist[ix] = d + 1; reached++;
          if (nn + np > next.length) { const bigger = new Int32Array(next.length * 2); bigger.set(next); next = bigger; }
          for (let q = 0; q < np; q++) next[nn++] = lm[q];
        }
      }
      frontier = next.subarray(0, nn);
    }
    return { comps, index, dist, reached, covers: comps.length === K };
  }
  // which tables each step gets: one per orbit (all its groups), and per group one joining the orbits when that is small
  function tablesFor(step) {
    const G = step.groups.length; const nO = orbitData.length;
    const list = [];
    for (let o = 0; o < nO; o++) list.push(Array.from({ length: G }, (_, g) => o * G + g));
    if (nO > 1) {
      for (let g = 0; g < G; g++) {
        const bits = orbitData.reduce((s2, od) => s2 + posOfFaces(od, step.groups[g].region).length, 0);
        if (bits <= 20) list.push(Array.from({ length: nO }, (_, o) => o * G + g));
      }
    }
    // a table that covers everything makes the others unnecessary
    const all = list.find((c) => c.length === nO * G);
    return all ? [all] : list;
  }
  let tables = null;
  function init(onProgress) {
    if (tables) return;
    tables = [];
    const plan = STEPS.map(tablesFor);
    const total = plan.reduce((s2, x) => s2 + x.length, 0) + 1;
    let done = 0;
    STEPS.forEach((step, k) => {
      tables.push(plan[k].map((comps) => { const t = buildTable(step, comps); done++; if (onProgress) onProgress(0.6 * done / total); return t; }));
    });
    S3.init((f) => onProgress && onProgress(0.6 + 0.4 * f));
  }

  /** Runs centre step k on the face-letter state; returns the moves. */
  function centreStep(k, state) {
    const step = STEPS[k]; const tabs = tables[k];
    const G = step.groups.length; const K = orbitData.length * G;
    const mis = step.moves.map((name) => moveList.indexOf(mv(name)));
    const cur = [];
    orbitData.forEach((od) => step.groups.forEach((g) => { let r = 0; for (let j = 0; j < 24; j++) if (g.track.includes(state[od.O[j]])) r |= 1 << j; cur.push(r); }));
    const odOf = Array.from({ length: K }, (_, c) => orbitData[Math.floor(c / G)]);
    const apply = (masks, mi) => { const nm = new Array(K); for (let c = 0; c < K; c++) nm[c] = moveMask(odOf[c], mi, masks[c]); return nm; };
    for (const t of tabs) if (t.dist[t.index(cur)] === 255) throw new Error('internal: centre step ' + k + ' cannot be reached');
    if (tabs.length === 1 && tabs[0].covers) {
      // the table is exact for the whole step: walk down it
      const t = tabs[0]; let ms = cur; const out = [];
      while (t.dist[t.index(ms)] > 0) {
        const d = t.dist[t.index(ms)];
        const mi = mis.find((x) => t.dist[t.index(apply(ms, x))] === d - 1);
        out.push(moveList[mi]);
        ms = apply(ms, mi);
      }
      return out;
    }
    try { return beam(cur, tabs, mis, apply, beamWidth); } catch { return beam(cur, tabs, mis, apply, beamWidth * 4); }
  }
  let beamWidth = 1500;
  // Otherwise a beam search: at every depth keep the `width` most promising positions (by the largest table distance,
  // then their sum). Not always the shortest, but close and fast.
  function beam(start, tabs, mis, apply, width) {
    const score = (ms) => { let sum = 0; let mx = 0; for (const t of tabs) { const d = t.dist[t.index(ms)]; sum += d; if (d > mx) mx = d; } return mx * 64 + sum; };
    const keyOf = (ms) => { let k2 = 0; for (const x of ms) k2 = k2 * 16777216 + x; return k2; }; // up to 2 masks exact; more: hashed
    const keyStr = (ms) => ms.join(',');
    const useStr = start.length > 2;
    let layer = [{ ms: start, h: score(start), parent: null, move: null }];
    const seen = new Set([useStr ? keyStr(start) : keyOf(start)]);
    for (let depth = 0; depth < 40; depth++) {
      const done = layer.find((x) => x.h === 0);
      if (done) { const out = []; for (let x = done; x.parent; x = x.parent) out.push(x.move); return out.reverse(); }
      const next = [];
      for (const node of layer) {
        const last = node.move;
        for (const mi of mis) {
          const m = moveList[mi];
          if (last && last.axis === m.axis && m.layer <= last.layer) continue;
          const nm = apply(node.ms, mi);
          const key = useStr ? keyStr(nm) : keyOf(nm);
          if (seen.has(key)) continue;
          seen.add(key);
          next.push({ ms: nm, h: score(nm), parent: node, move: m });
        }
      }
      next.sort((a2, b2) => a2.h - b2.h);
      layer = next.length > width ? next.slice(0, width) : next;
    }
    throw new Error('internal: the centre search did not finish');
  }

  // ---- edge pairing ----
  // The edge stickers (wings, and the 5x5's middle edges), and every move as a permutation of just those.
  const E = [...kit.wings.flatMap((w) => w.stickers), ...kit.midges.flat()];
  const posInE = new Map(E.map((st, j) => [st, j]));
  const NE = E.length;
  const ePermOf = (p) => { const r = new Int16Array(NE); for (let j = 0; j < NE; j++) r[j] = posInE.get(p[E[j]]); return r; };
  for (const m of moveList) m.eperm = ePermOf(m.perm);
  const composeE = (a, b2) => { const r = new Int16Array(NE); for (let j = 0; j < NE; j++) r[j] = a[b2[j]]; return r; }; // a then b2
  const seqPerm = (moves) => { let r = Int16Array.from({ length: NE }, (_, j) => j); for (const m of moves) r = composeE(r, m.eperm); return r; };
  // scoring positions: wing j = E[2j], E[2j+1]; midge e = E[48 + 2e], E[48 + 2e + 1]
  const wingSlot = kit.wings.map((w, j) => [2 * j, 2 * j + 1]);
  const wingsOfEdge = Array.from({ length: 12 }, () => []);
  kit.wings.forEach((w, j) => wingsOfEdge[w.edge].push(j));
  const midgeSlot = kit.midges.map((_, e) => [48 + 2 * e, 48 + 2 * e + 1]);
  /** 4x4: how many edges are paired (both pieces show the same colours). 5x5: how many wings match their middle piece. */
  let oddWings = false; // 5x5: the wings need an odd number of swaps (then the goal is 22 matched + one edge flipped)
  function edgeScore(X) {
    let s2 = 0;
    if (n === 4) {
      for (let e = 0; e < 12; e++) { const [a1, b1] = wingSlot[wingsOfEdge[e][0]]; const [a2, b2] = wingSlot[wingsOfEdge[e][1]]; if (X[a1] === X[a2] && X[b1] === X[b2]) s2++; }
      return s2;
    }
    let bad1 = -1; let bad2 = -1;
    for (let j = 0; j < 24; j++) {
      const [a1, b1] = wingSlot[j]; const [ma, mb] = midgeSlot[kit.wings[j].edge];
      if (X[a1] === X[ma] && X[b1] === X[mb]) s2++; else if (bad1 < 0) bad1 = j; else bad2 = j;
    }
    if (oddWings && s2 === 22 && kit.wings[bad1].edge === kit.wings[bad2].edge) s2 = 24;
    return s2;
  }
  function wingParity(state) {
    const target = []; const cur = [];
    kit.wings.forEach((w, j) => {
      const [ma, mb] = kit.midges[w.edge];
      target.push(kit.wingPiece(j, state[ma], state[mb]));
      cur.push(kit.wingPiece(j, state[w.stickers[0]], state[w.stickers[1]]));
    });
    const slotOf = []; target.forEach((pc, j) => { slotOf[pc] = j; });
    return Kit.parity(cur.map((pc) => slotOf[pc]));
  }
  const edgeGoal = n === 4 ? 12 : 24;

  // the "store" blocks: outer turns that leave every side face (R L F B) turned back to where it was
  const ROT_Y = { F: 'R', R: 'B', B: 'L', L: 'F', U: 'U', D: 'D' };
  const MIRROR = { R: 'L', L: 'R', U: 'U', D: 'D', F: 'F', B: 'B' };
  const FLIP = { U: 'D', D: 'U', R: 'L', L: 'R', F: 'F', B: 'B' };
  const parseOuter = (text) => text.split(' ').map((t) => ({ f: t[0], k: t.endsWith('2') ? 2 : t.endsWith("'") ? 3 : 1 }));
  const fmtOuter = (seq) => seq.map(({ f, k }) => f + (k === 2 ? '2' : k === 3 ? "'" : '')).join(' ');
  function images(text) {
    const out = new Set();
    for (let r = 0; r < 4; r++) for (const mir of [0, 1]) for (const flp of [0, 1]) for (const inv of [0, 1]) {
      let seq = parseOuter(text);
      for (let q = 0; q < r; q++) seq = seq.map(({ f, k }) => ({ f: ROT_Y[f], k }));
      if (mir) seq = seq.map(({ f, k }) => ({ f: MIRROR[f], k: (4 - k) % 4 }));
      if (flp) seq = seq.map(({ f, k }) => ({ f: FLIP[f], k }));
      if (inv) seq = seq.slice().reverse().map(({ f, k }) => ({ f, k: (4 - k) % 4 }));
      out.add(fmtOuter(seq));
    }
    return [...out];
  }
  const STORES = new Set();
  for (const x of ['R', 'R2', "R'"]) for (const y of ['U', 'U2', "U'"]) for (const t of images(`${x} ${y} ${x.length === 1 ? x + "'" : x.endsWith('2') ? x : x[0]}`)) STORES.add(t);
  for (const t of images("R U R' F R' F' R")) STORES.add(t);
  for (const t of images("R F' U R' F")) STORES.add(t);
  const SLICES = [];
  for (let a = 0; a < 4; a++) for (let b2 = 0; b2 < 4; b2++) {
    if (!a && !b2) continue;
    // both slices at once: never needed on the 4x4 (no shorter answers, three times slower); on the 5x5 only together the
    // same or opposite way (a few turns shorter on average)
    if (a && b2 && (n === 4 || !(a === b2 || (a + b2) % 4 === 0))) continue;
    const there = []; const back = [];
    if (a) { there.push(mv(P.formatMove({ turn: 'u', amount: a }))); back.push(mv(P.formatMove({ turn: 'u', amount: 4 - a }))); }
    if (b2) { there.push(mv(P.formatMove({ turn: 'd', amount: b2 }))); back.push(mv(P.formatMove({ turn: 'd', amount: 4 - b2 }))); }
    SLICES.push({ there, back });
  }
  const CORES = [];
  for (const sl of SLICES) for (const st of STORES) {
    const moves = [...sl.there, ...movesOf(st), ...sl.back];
    const perm = seqPerm(moves);
    // the scoring units (4x4: edges; 5x5: wings) whose stickers this block moves: only those can change
    const moved = new Set(); for (let j = 0; j < NE; j++) if (perm[j] !== j) moved.add(j);
    const units = [];
    if (n === 4) { for (let e = 0; e < 12; e++) if (wingsOfEdge[e].some((w) => wingSlot[w].some((j) => moved.has(j)))) units.push(e); }
    else { for (let w = 0; w < 24; w++) if (wingSlot[w].some((j) => moved.has(j)) || midgeSlot[kit.wings[w].edge].some((j) => moved.has(j))) units.push(w); }
    CORES.push({ moves, perm, units: Int8Array.from(units) });
  }
  const OUTER = moveList.filter((m) => FACES.includes(m.turn));
  function setups(maxDepth) {
    const out = [[]];
    let layer = [[]];
    for (let d = 0; d < maxDepth; d++) {
      const next = [];
      for (const seq of layer) {
        const last = seq[seq.length - 1];
        for (const m of OUTER) {
          if (last && last.axis === m.axis && m.layer <= last.layer) continue;
          next.push([...seq, m]);
        }
      }
      out.push(...next); layer = next;
    }
    return out.map((seq) => ({ moves: seq, perm: seqPerm(seq) }));
  }
  const SETUPS2 = setups(2);
  let SETUPS3 = null;
  const PARITY_FLIP = movesOf("r2 B2 U2 l U2 r' U2 r U2 F2 r F2 l' B2 r2"); // swaps the two wings of the top-front edge
  const PARITY_SWAP = movesOf('r2 U2 r2 U2 u2 r2 U2 u2'); // r2 U2 r2 Uw2 r2 Uw2: swaps two edges (4x4)

  /** One pairing step: the best setup + core. Returns the moves, or null when no step pairs anything more. */
  // is scoring unit u (4x4: edge, 5x5: wing) right after the block c, starting from X? (Y[j] = X[c[j]], read lazily)
  const unitOk = n === 4
    ? (X, c, e) => { const [a1, b1] = wingSlot[wingsOfEdge[e][0]]; const [a2, b2] = wingSlot[wingsOfEdge[e][1]]; return X[c[a1]] === X[c[a2]] && X[c[b1]] === X[c[b2]]; }
    : (X, c, w) => { const [a1, b1] = wingSlot[w]; const [ma, mb] = midgeSlot[kit.wings[w].edge]; return X[c[a1]] === X[c[ma]] && X[c[b1]] === X[c[mb]]; };
  function realScore(X) { const was = oddWings; oddWings = false; try { return edgeScore(X); } finally { oddWings = was; } }
  /** One pairing step: the best setup + core. Returns the moves, or null when no step pairs anything more. */
  function pairStep(state, setupList) {
    const X0 = Int16Array.from(E, (st) => state[st].charCodeAt(0));
    const base = edgeScore(X0); const real = realScore(X0);
    const id = Int16Array.from({ length: NE }, (_, j) => j);
    const nUnits = n === 4 ? 12 : 24;
    const okBefore = new Uint8Array(nUnits);
    let best = null;
    const Y = new Int16Array(NE); const X = new Int16Array(NE);
    for (const su of setupList) {
      for (let j = 0; j < NE; j++) X[j] = X0[su.perm[j]];
      for (let u = 0; u < nUnits; u++) okBefore[u] = unitOk(X, id, u) ? 1 : 0;
      for (const core of CORES) {
        const c = core.perm; const us = core.units;
        let after = real;
        for (let q = 0; q < us.length; q++) after += (unitOk(X, c, us[q]) ? 1 : 0) - okBefore[us[q]];
        if (oddWings && after === edgeGoal - 2) { for (let j = 0; j < NE; j++) Y[j] = X[c[j]]; after = edgeScore(Y); }
        const gain = after - base;
        if (gain <= 0) continue;
        const len = su.moves.length + core.moves.length;
        const value = gain / len;
        if (!best || value > best.value || (value === best.value && len < best.len)) best = { value, len, moves: [...su.moves, ...core.moves] };
      }
    }
    return best && best.moves;
  }
  function pairEdges(state) {
    const out = []; const parity = [];
    let s2 = state;
    oddWings = n === 5 && wingParity(state) === 1;
    const score = (st) => edgeScore(Int16Array.from(E, (x) => st[x].charCodeAt(0)));
    for (let guard = 0; guard < 60; guard++) {
      const sc = score(s2);
      if (sc === edgeGoal) {
        if (oddWings) {
          // one edge with both wings the wrong way round: bring it to the top front and swap them
          const fix = findParitySetup(s2);
          s2 = applyAll(s2, fix); parity.push(...fix); oddWings = false;
          if (score(s2) !== edgeGoal) throw new Error('internal: the flipped edge was not fixed');
        }
        return { pair: out, parity };
      }
      let step = pairStep(s2, SETUPS2);
      if (!step) { SETUPS3 = SETUPS3 || setups(3); step = pairStep(s2, SETUPS3); }
      if (!step) throw new Error(`internal: edge pairing is stuck (${sc} of ${edgeGoal})`);
      out.push(...step);
      s2 = applyAll(s2, step);
    }
    throw new Error('internal: edge pairing took too many steps');
  }
  // 5x5: the wings can only be fixed by an odd number of swaps. Prefer an edge with both wings the wrong way round (then
  // the swap finishes it); otherwise swap where it costs the least and go on pairing.
  const PARITY_FLIP_E = seqPerm(PARITY_FLIP);
  function findParitySetup(state) {
    SETUPS3 = SETUPS3 || setups(3);
    const X0 = Int16Array.from(E, (st) => state[st].charCodeAt(0));
    const X = new Int16Array(NE); const Y = new Int16Array(NE);
    const was = oddWings; oddWings = false;
    try {
      for (const su of SETUPS3) {
        for (let j = 0; j < NE; j++) X[j] = X0[su.perm[j]];
        for (let j = 0; j < NE; j++) Y[j] = X[PARITY_FLIP_E[j]];
        if (edgeScore(Y) === edgeGoal) return [...su.moves, ...PARITY_FLIP];
      }
    } finally { oddWings = was; }
    throw new Error('internal: no setup for the flipped edge');
  }

  // ---- the 3x3 stage ----
  // a 3x3 sticker (face f, row r, column c) is read from the big cube's sticker in the same corner / edge / centre place
  const big = (k) => (k === 0 ? 0 : k === 2 ? n - 1 : Math.floor(n / 2));
  const to3 = (state) => {
    const out = [];
    for (let f = 0; f < 6; f++) for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) {
      out.push(r === 1 && c === 1 ? FACES[f] : state[f * n * n + big(r) * n + big(c)]);
    }
    return out;
  };
  const PARITY_SWAP_TEXT = 'r2 U2 r2 Uw2 r2 Uw2';

  /**
   * colours: one colour key per sticker (any way of holding the cube). Returns { moves, stages: [{ title, moves }] } (texts
   * in the puzzle's notation; the stages put together are the moves). Throws in plain words if the cube cannot be solved.
   */
  function solve(colours, { polishMs = 500 } = {}) {
    init();
    const v = def.validate(colours);
    if (!v.ok) throw new Error(v.summary);
    if (v.solved) return { moves: '', stages: [] };
    const name = (f) => Kit.COLOURS[v.colourOf[f]].name;
    const stages = [];
    let state = v.faces.slice();
    const add = (title, moves) => {
      const simple = P.simplify(moves.map((m) => ({ turn: m.turn, amount: m.amount })));
      state = P.applyMoves(state, simple);
      if (simple.length) stages.push({ title, moves: P.formatMoves(simple), count: simple.length });
    };
    // 1. centres
    const first = []; for (const k of [0, 1]) { const m = centreStep(k, state); first.push(...m); state = applyAll(state, m); }
    state = v.faces.slice(); add(`${name('U').replace(/^./, (x) => x.toUpperCase())} and ${name('D')} centres`, first);
    const rest = []; for (const k of [2, 3]) { const m = centreStep(k, state); rest.push(...m); state = applyAll(state, m); }
    state = P.applyMoves(v.faces, P.parseMoves(stages.map((x) => x.moves).join(' ')));
    add('Last four centres', rest);
    // 2. edges
    const ed = pairEdges(state);
    add('Pair the edges', ed.pair);
    if (ed.parity.length) add('Fix the flipped edge', ed.parity);
    // 3. as a 3x3 (4x4: fix the parity first if the reduced cube is not a real 3x3)
    if (n === 4) {
      let cub = C.toCubies(3, to3(state));
      if (!cub) throw new Error('internal: the reduced cube is not a 3x3');
      if (cub.eo.reduce((a, x) => a + x, 0) % 2) { add('Fix the edge parity', PARITY_FLIP); cub = C.toCubies(3, to3(state)); }
      if (C.parity(cub.cp) !== C.parity(cub.ep)) add('Fix the swapped edges', P.parseMoves(PARITY_SWAP_TEXT));
    }
    const f3 = to3(state);
    if (!C.isSolved(3, f3)) {
      const v3 = C.validate(3, f3.map((f) => C.STANDARD_SCHEME[f]));
      if (!v3.ok) throw new Error('internal: the reduced cube is not a solvable 3x3: ' + v3.summary);
      add('Solve it like a 3x3', P.parseMoves(S3.solve(f3, { polishMs }).join(' ')));
    }
    if (!P.isSolved(state)) throw new Error('internal: the solution does not solve the cube');
    const out = stages.map(({ title, moves }) => ({ title, moves }));
    return { moves: out.map((x) => x.moves).join(' '), stages: out };
  }

  return { n, def, kit, P, moveList, mv, movesOf, applyAll, init, solve, to3, centreStep, pairEdges, edgeScore, wingParity, E, STEPS, PARITY_FLIP, PARITY_SWAP, CORES, STORES, setBeam: (w) => { beamWidth = w; }, tablesInfo: () => tables };
}

module.exports = { makeSolver };
