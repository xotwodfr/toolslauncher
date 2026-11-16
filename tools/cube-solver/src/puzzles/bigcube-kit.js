'use strict';
// Shared building blocks for the big cubes (4x4 and 5x5): the geometry of an n x n x n cube, its turns and notation, the
// pieces (which stickers belong to one corner, edge wing, middle edge or centre piece), and the reading of a filled-in
// colour array into pieces with plain-words validation. cube4.js and cube5.js call makeBigCube(n).
//
// Loaded with require() in Node and a <script> tag in the window (window.BigCubeKit), after puzzle-core.js and BEFORE
// cube4.js / cube5.js.
//
// Coordinates: x to the right, y up, z towards you (the front); cubies are 1 unit, the centre of the cube is the origin.
// Sticker order (like cube.js for the 3x3, so a 3x3 state maps naturally): the faces U, R, F, D, L, B, each read row by row
// as you see it from outside (U with the back edge at the top, D with the front edge at the top, the side faces with the
// top at the top), left to right. n*n stickers per face: 96 on a 4x4, 150 on a 5x5.
//
// Turns (WCA style): R = the right outer layer, Rw = the two right layers together, r = only the second layer from the
// right (inner slice), and on the 5x5 also M (the middle layer between L and R, turning like L), E (between U and D,
// turning like D) and S (between F and B, turning like F). Each with ' (anticlockwise) and 2 (half turn).
//
// Pieces:
//   corners  8, three stickers each, like any cube
//   wings    24 (two per edge): the edge pieces that are not in the middle of an edge. A wing can never be flipped in its
//            place: which way round its two colours sit tells exactly which of the two wings of that edge it is.
//   midges   12 on the 5x5 only: the middle edge pieces. They behave exactly like the edges of a 3x3.
//   centres  x-centres (the diagonal ones, 4 per face; all 4 of the 4x4's centre stickers), t-centres (5x5: the ones
//            directly above, below, left and right of the middle) and fixed centres (5x5: the middle sticker).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('../puzzle-core'));
  else root.BigCubeKit = factory(root.PuzzleCore);
}(typeof self !== 'undefined' ? self : this, function (PC) {
  const { dot, cross } = PC;

  const COLOURS = {
    w: { name: 'white', hex: '#f4f4f2' },
    y: { name: 'yellow', hex: '#ffd500' },
    g: { name: 'green', hex: '#009b48' },
    b: { name: 'blue', hex: '#0046ad' },
    r: { name: 'red', hex: '#c41e3a' },
    o: { name: 'orange', hex: '#ff5800' },
  };
  const COLOUR_KEYS = Object.keys(COLOURS);
  const FACES = ['U', 'R', 'F', 'D', 'L', 'B'];
  const AXIS = { U: [0, 1, 0], R: [1, 0, 0], F: [0, 0, 1], D: [0, -1, 0], L: [-1, 0, 0], B: [0, 0, -1] };
  const OPPOSITE = { U: 'D', D: 'U', R: 'L', L: 'R', F: 'B', B: 'F' };
  const FACE_NAME = { U: 'Top', R: 'Right', F: 'Front', D: 'Bottom', L: 'Left', B: 'Back' };
  const FACE_WORD = { U: 'top', D: 'bottom', F: 'front', B: 'back', L: 'left', R: 'right' };
  const FACE_UP = { U: [0, 0, -1], D: [0, 0, 1], R: [0, 1, 0], F: [0, 1, 0], L: [0, 1, 0], B: [0, 1, 0] };
  const STANDARD_SCHEME = { U: 'w', D: 'y', F: 'g', B: 'b', R: 'r', L: 'o' };
  // Kociemba piece order (as cube.js). The first face of a corner is its U/D sticker, the rest follow clockwise.
  const CORNER_FACES = [['U', 'R', 'F'], ['U', 'F', 'L'], ['U', 'L', 'B'], ['U', 'B', 'R'], ['D', 'F', 'R'], ['D', 'L', 'F'], ['D', 'B', 'L'], ['D', 'R', 'B']];
  const EDGE_FACES = [['U', 'R'], ['U', 'F'], ['U', 'L'], ['U', 'B'], ['D', 'R'], ['D', 'F'], ['D', 'L'], ['D', 'B'], ['F', 'R'], ['F', 'L'], ['B', 'L'], ['B', 'R']];
  const placeName = (faces) => {
    const order = ['U', 'D', 'F', 'B', 'L', 'R'];
    return faces.slice().sort((a, b) => order.indexOf(a) - order.indexOf(b)).map((f) => FACE_WORD[f]).join('-');
  };
  const CORNER_PLACE = CORNER_FACES.map(placeName);
  const EDGE_PLACE = EDGE_FACES.map(placeName);

  const colourWord = (c) => (COLOURS[c] ? COLOURS[c].name : 'empty');
  const list = (words) => (words.length <= 1 ? words.join('') : words.slice(0, -1).join(', ') + ' and ' + words[words.length - 1]);
  const plural = (k, one, many) => `${k} ${k === 1 ? one : many}`;
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
  const det = (a, b, c) => dot(a, cross(b, c));
  function permutations(arr) {
    if (arr.length <= 1) return [arr.slice()];
    const out = [];
    arr.forEach((x, i) => { for (const p of permutations([...arr.slice(0, i), ...arr.slice(i + 1)])) out.push([x, ...p]); });
    return out;
  }
  const FACE_PERMS = permutations(FACES);
  function parity(p) {
    let s = 0;
    const seen = new Array(p.length).fill(false);
    for (let i = 0; i < p.length; i++) {
      if (seen[i]) continue;
      let len = 0;
      for (let j = i; !seen[j]; j = p[j]) { seen[j] = true; len++; }
      s += len - 1;
    }
    return s % 2;
  }

  const cache = {};
  function makeBigCube(n) {
    if (cache[n]) return cache[n];
    const m = (n - 1) / 2;
    const key = (p, nrm) => p.map((v) => Math.round(v * 2)).join(',') + '|' + nrm.join(',');
    // ---- stickers ----
    const stickers = [];
    const index = new Map();
    for (let f = 0; f < 6; f++) {
      for (let r = 0; r < n; r++) {
        for (let c = 0; c < n; c++) {
          let p;
          switch (FACES[f]) {
            case 'U': p = [c - m, m, r - m]; break;
            case 'R': p = [m, m - r, m - c]; break;
            case 'F': p = [c - m, m - r, m]; break;
            case 'D': p = [c - m, -m, m - r]; break;
            case 'L': p = [-m, m - r, c - m]; break;
            default: p = [m - c, m - r, -m]; break; // B
          }
          const normal = AXIS[FACES[f]];
          const i = stickers.length;
          stickers.push({ i, face: FACES[f], r, c, pos: p, normal });
          index.set(key(p, normal), i);
        }
      }
    }
    const at = (pos, face) => index.get(key(pos, AXIS[face]));

    // ---- turns ----
    // layer of a sticker for a face: 0 = the outer layer of that face, 1 = the next one in, ...
    const layerOf = (s, a) => Math.round(m - dot(s.pos, a));
    const turns = {};
    const turnInfo = {}; // name -> { face, layers: [..] }
    const addTurn = (name, face, layers) => {
      const a = AXIS[face];
      turns[name] = { axis: a, order: 4, select: (centre, s) => layers.includes(layerOf(stickers[s.i], a)) };
      turnInfo[name] = { face, layers };
    };
    for (const f of FACES) addTurn(f, f, [0]);
    for (const f of FACES) addTurn(f + 'w', f, [0, 1]);
    for (const f of FACES) addTurn(f.toLowerCase(), f, [1]);
    if (n === 5) { addTurn('M', 'L', [2]); addTurn('E', 'D', [2]); addTurn('S', 'F', [2]); }

    const specStickers = stickers.map((s) => {
      const nrm = s.normal;
      const centre = s.pos.map((v, k) => v + 0.5 * nrm[k]);
      const t = [0, 1, 2].filter((k) => nrm[k] === 0);
      const corner = (a, b) => { const p = centre.slice(); p[t[0]] += a * 0.5; p[t[1]] += b * 0.5; return p; };
      return { face: s.face, centre, poly: [corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)] };
    });
    const step = n + 0.25; const row = n + 0.7;
    const BLOCK = { U: [1, 0], L: [0, 1], F: [1, 1], R: [2, 1], B: [3, 1], D: [1, 2] };
    const outerAndWide = [...FACES, ...FACES.map((f) => f + 'w')];
    const puzzle = PC.definePuzzle({
      id: 'cube' + n,
      name: `${n}x${n} cube`,
      colours: COLOURS,
      faces: FACES.map((f) => ({ id: f, name: FACE_NAME[f], normal: AXIS[f], up: FACE_UP[f], colour: STANDARD_SCHEME[f] })),
      stickers: specStickers,
      turns,
      net: FACES.map((f) => ({ face: f, x: BLOCK[f][0] * step, y: BLOCK[f][1] * row })),
      scrambleTurns: outerAndWide,
      parse: (tok) => {
        // also accept "2R" (SiGN / WCA for the second layer only) as r, and "3R" on a 5x5 as the middle layer
        const s = String(tok).trim().replace(/’/g, "'");
        const mm = /^([23])([URFDLB])(.*)$/.exec(s);
        if (mm) {
          if (mm[1] === '2') return baseParse(mm[2].toLowerCase() + mm[3]);
          if (n === 5) {
            const map = { L: ['M', false], R: ['M', true], D: ['E', false], U: ['E', true], F: ['S', false], B: ['S', true] }[mm[2]];
            const mv = baseParse(map[0] + mm[3]);
            return mv && map[1] ? { turn: mv.turn, amount: 4 - mv.amount } : mv;
          }
        }
        return baseParse(s);
      },
    });
    // the default parser of puzzle-core, built here the same way (so "2R" can fall back to it)
    const byLength = Object.keys(turns).sort((a, b) => b.length - a.length);
    function baseParse(s) {
      for (const name of byLength) {
        if (!s.startsWith(name)) continue;
        const rest = s.slice(name.length);
        const mt = /^(\d*)('?)$/.exec(rest);
        if (!mt) continue;
        let k = mt[1] ? Number(mt[1]) : 1;
        if (mt[2]) k = -k;
        k = ((k % 4) + 4) % 4;
        return k ? { turn: name, amount: k } : null;
      }
      throw new Error(`"${s}" is not a move on the ${n}x${n}: use U, D, L, R, F, B (outer layer), Uw, Rw, ... (two layers), u, r, ... (only the second layer)${n === 5 ? ', M, E, S (middle layer)' : ''}, with ' or 2`);
    }

    // ---- pieces ----
    const cornerFacelets = CORNER_FACES.map((fs) => {
      const pos = [0, 1, 2].map((k) => fs.reduce((s, f) => s + AXIS[f][k], 0) * m);
      return fs.map((f) => at(pos, f));
    });
    const wings = []; // { edge, stickers: [sa, sb], pos, sign, side }
    const midges = []; // n = 5: [sa, sb] per edge
    const ALONG = { 0: ['left', 'right'], 1: ['lower', 'upper'], 2: ['back', 'front'] };
    EDGE_FACES.forEach((fs, e) => {
      const A = AXIS[fs[0]]; const B = AXIS[fs[1]];
      const k = [0, 1, 2].find((q) => A[q] === 0 && B[q] === 0);
      for (let j = 1; j < n - 1; j++) {
        const pos = [0, 1, 2].map((q) => (A[q] + B[q]) * m);
        pos[k] = j - m;
        const st = [at(pos, fs[0]), at(pos, fs[1])];
        if (pos[k] === 0) { midges[e] = st; continue; }
        wings.push({ edge: e, stickers: st, pos, sign: Math.sign(det(A, B, pos)), side: ALONG[k][pos[k] < 0 ? 0 : 1] });
      }
    });
    const xCentres = []; const tCentres = []; const fixedCentres = [];
    for (const s of stickers) {
      const inFace = [0, 1, 2].filter((q) => s.normal[q] === 0).map((q) => Math.abs(s.pos[q]));
      if (inFace.some((v) => v === m)) continue; // not a centre
      if (inFace[0] === 0 && inFace[1] === 0) fixedCentres.push(s.i);
      else if (inFace[0] === 0 || inFace[1] === 0) tCentres.push(s.i);
      else if (inFace[0] === inFace[1]) xCentres.push(s.i);
      else throw new Error('unexpected centre');
    }
    // wing slot lookup: edge e, sign -> wing index
    const wingOf = {};
    wings.forEach((w, i) => { wingOf[w.edge + ':' + w.sign] = i; });
    const edgeIndex = (a, b) => EDGE_FACES.findIndex((e) => (e[0] === a && e[1] === b) || (e[0] === b && e[1] === a));
    /** Which wing piece (its home wing slot) shows face letters (x on the slot's first face, y on its second). */
    function wingPiece(slot, x, y) {
      const w = wings[slot];
      const fs = EDGE_FACES[w.edge];
      const sigma = Math.sign(det(AXIS[fs[0]], AXIS[fs[1]], w.pos));
      const e = edgeIndex(x, y);
      if (e < 0) return -1;
      // home slot h on edge e with det(N_x, N_y, P_h) of sign sigma
      for (const s of [1, -1]) {
        const h = wingOf[e + ':' + s];
        const hs = EDGE_FACES[e];
        let d = Math.sign(det(AXIS[hs[0]], AXIS[hs[1]], wings[h].pos));
        if (hs[0] !== x) d = -d;
        if (d === sigma) return h;
      }
      return -1;
    }
    const wingPlace = (i) => `the ${EDGE_PLACE[wings[i].edge]} edge (${wings[i].side} piece)`;

    // ---- which colour is which face ----
    const isStandardPairing = (colourOf) => ['U', 'R', 'F'].every((f) => {
      const a = colourOf[f]; const b = colourOf[OPPOSITE[f]];
      return [a, b].sort().join('') === 'wy' || [a, b].sort().join('') === 'bg' || [a, b].sort().join('') === 'or';
    });
    function cornerAt(faces, i) {
      const fl = cornerFacelets[i].map((k) => faces[k]);
      if (fl.some((x) => x == null)) return { piece: -1, why: 'empty' };
      if (new Set(fl).size < 3) return { piece: -1, why: 'repeat' };
      for (let a = 0; a < 3; a++) for (let b = a + 1; b < 3; b++) if (OPPOSITE[fl[a]] === fl[b]) return { piece: -1, why: 'opposite', pair: [a, b] };
      const ori = fl.findIndex((x) => x === 'U' || x === 'D');
      const c1 = fl[(ori + 1) % 3]; const c2 = fl[(ori + 2) % 3];
      const j = CORNER_FACES.findIndex((cf) => cf[0] === fl[ori] && cf[1] === c1 && cf[2] === c2);
      if (j < 0) return { piece: -1, why: 'mirror' };
      return { piece: j, ori };
    }
    function edgeAt(faces, st) {
      const [a, b] = st.map((k) => faces[k]);
      if (a == null || b == null) return { piece: -1, why: 'empty' };
      if (a === b) return { piece: -1, why: 'repeat' };
      if (OPPOSITE[a] === b) return { piece: -1, why: 'opposite' };
      let j = EDGE_FACES.findIndex((e) => e[0] === a && e[1] === b);
      if (j >= 0) return { piece: j, ori: 0 };
      j = EDGE_FACES.findIndex((e) => e[0] === b && e[1] === a);
      return { piece: j, ori: 1 };
    }
    /** 4x4 (no fixed centres): the colour -> face map that makes the most corners real pieces, with the bottom-back-left
     *  corner in place (so the solution builds every centre where that corner says it belongs). */
    function schemeFromCorners(colours) {
      let best = null;
      for (const perm of FACE_PERMS) {
        const faceOf = {}; COLOUR_KEYS.forEach((c, i) => { faceOf[c] = perm[i]; });
        const faces = colours.map((c) => faceOf[c]);
        let valid = 0;
        for (let i = 0; i < 8; i++) if (cornerAt(faces, i).piece >= 0) valid++;
        const dbl = cornerFacelets[6].map((k) => faces[k]).join('') === 'DBL';
        const colourOf = {}; for (const c of COLOUR_KEYS) colourOf[faceOf[c]] = c;
        const score = valid * 4 + (dbl ? 2 : 0) + (isStandardPairing(colourOf) ? 1 : 0);
        if (!best || score > best.score) best = { score, faceOf, colourOf };
      }
      return best;
    }

    // ---- validation ----
    const perFace = n * n;
    function validate(colours) {
      const errors = [];
      const res = { ok: false, solved: false, faces: null, colourOf: null, errors };
      const size = 6 * perFace;
      if (!colours || colours.length !== size) {
        errors.push({ kind: 'empty', text: `A ${n}x${n} cube has ${size} stickers.`, stickers: [] });
        return finish(res);
      }
      const empty = [];
      colours.forEach((c, i) => { if (!COLOURS[c]) empty.push(i); });
      if (empty.length) {
        errors.push({ kind: 'empty', text: `${plural(empty.length, 'sticker is', 'stickers are')} not filled in yet.`, stickers: empty });
        return finish(res);
      }
      const count = Object.fromEntries(COLOUR_KEYS.map((c) => [c, 0]));
      for (const c of colours) count[c]++;
      const over = COLOUR_KEYS.filter((c) => count[c] > perFace); const under = COLOUR_KEYS.filter((c) => count[c] < perFace);
      if (over.length || under.length) {
        const words = [...over, ...under].map((c) => `${count[c]} ${colourWord(c)}`);
        const one = count[over[0] || under[0]] === 1;
        errors.push({
          kind: 'count',
          text: `Every colour must appear exactly ${perFace} times, but there ${one ? 'is' : 'are'} ${list(words)} ${words.length === 1 && one ? 'sticker' : 'stickers'}.`,
          stickers: [], over, under,
        });
      }
      let faceOf;
      if (n === 5) {
        const cc = fixedCentres.map((i) => colours[i]);
        const dup = COLOUR_KEYS.filter((c) => cc.filter((x) => x === c).length > 1);
        if (dup.length) {
          errors.push({ kind: 'centres', text: `Two middle centre stickers are ${list(dup.map(colourWord))}: every face of a 5x5 has its own middle colour (the sticker right in the middle of the face).`, stickers: fixedCentres.filter((i) => dup.includes(colours[i])) });
          return finish(res);
        }
        faceOf = {}; cc.forEach((c, f) => { faceOf[c] = FACES[f]; });
      } else {
        faceOf = schemeFromCorners(colours).faceOf;
      }
      const colourOf = {}; for (const c of COLOUR_KEYS) colourOf[faceOf[c]] = c;
      res.colourOf = colourOf;
      const faces = colours.map((c) => faceOf[c]);
      const cornerName = (j) => CORNER_FACES[j].map((f) => colourWord(colourOf[f])).join('-');
      const edgeName = (j) => EDGE_FACES[j].map((f) => colourWord(colourOf[f])).join('-');
      let pieceTrouble = false;

      // corners
      const corners = [];
      for (let i = 0; i < 8; i++) {
        const c = cornerAt(faces, i);
        corners.push(c);
        if (c.piece >= 0) continue;
        pieceTrouble = true;
        const cols = cornerFacelets[i].map((k) => colours[k]);
        const has = list(cols.map(colourWord));
        let text;
        if (c.why === 'repeat') {
          const twice = cols.find((x, k) => cols.indexOf(x) !== k);
          text = `The ${CORNER_PLACE[i]} corner has two ${colourWord(twice)} stickers (${has}). No corner piece has that.`;
        } else if (c.why === 'opposite') {
          text = `The ${CORNER_PLACE[i]} corner has ${colourWord(cols[c.pair[0]])} and ${colourWord(cols[c.pair[1]])} together (${has}), but those are opposite colours: no corner piece has both.`;
        } else {
          text = `The ${CORNER_PLACE[i]} corner (${has}) has its colours the wrong way round, like a mirror image: two of its stickers are probably swapped.`;
        }
        errors.push({ kind: 'piece', text, stickers: cornerFacelets[i].slice() });
      }
      // wings
      const wingAt = [];
      wings.forEach((w, i) => {
        const [a, b] = w.stickers.map((k) => faces[k]);
        const cols = w.stickers.map((k) => colours[k]);
        let text = null;
        if (a === b) text = `The edge piece at ${wingPlace(i)} has two ${colourWord(cols[0])} stickers. No edge piece has that.`;
        else if (OPPOSITE[a] === b) text = `The edge piece at ${wingPlace(i)} has ${colourWord(cols[0])} and ${colourWord(cols[1])}, but those are opposite colours: no edge piece has both.`;
        if (text) { pieceTrouble = true; errors.push({ kind: 'piece', text, stickers: w.stickers.slice() }); wingAt.push(-1); return; }
        wingAt.push(wingPiece(i, a, b));
      });
      // midges (5x5)
      const midgeAt = [];
      midges.forEach((st, e) => {
        const c = edgeAt(faces, st);
        midgeAt.push(c);
        if (c.piece >= 0) return;
        pieceTrouble = true;
        const cols = st.map((k) => colours[k]);
        const text = c.why === 'repeat'
          ? `The middle piece of the ${EDGE_PLACE[e]} edge has two ${colourWord(cols[0])} stickers. No edge piece has that.`
          : `The middle piece of the ${EDGE_PLACE[e]} edge has ${colourWord(cols[0])} and ${colourWord(cols[1])}, but those are opposite colours: no edge piece has both.`;
        errors.push({ kind: 'piece', text, stickers: st.slice() });
      });
      // the same piece twice
      const dupCheck = (pieceOfSlot, stickersOf, placeOf, nameOf, word, total, textOf) => {
        const where = new Map();
        pieceOfSlot.forEach((p, i) => { if (p >= 0) { if (!where.has(p)) where.set(p, []); where.get(p).push(i); } });
        let any = false;
        for (const [piece, slots] of where) {
          if (slots.length < 2) continue;
          any = true; pieceTrouble = true;
          const places = list(slots.map(placeOf));
          const text = textOf ? textOf(piece, places, slots.length)
            : `The ${nameOf(piece)} ${word} is there ${slots.length === 2 ? 'twice' : slots.length + ' times'}: at ${places}.`;
          errors.push({ kind: 'duplicate', text, stickers: slots.flatMap(stickersOf) });
        }
        if (any && word) {
          const missing = [];
          for (let j = 0; j < total; j++) if (!where.has(j)) missing.push(j);
          if (missing.length) errors.push({ kind: 'missing', text: `So ${missing.length === 1 ? 'this ' + word + ' is' : 'these ' + word + 's are'} missing: ${list(missing.map(nameOf))}.`, stickers: [] });
        }
      };
      dupCheck(corners.map((c) => c.piece), (i) => cornerFacelets[i], (i) => 'the ' + CORNER_PLACE[i], cornerName, 'corner', 8);
      dupCheck(wingAt, (i) => wings[i].stickers, wingPlace, null, '', 24, (h, places, k) => {
        const fs = EDGE_FACES[wings[h].edge];
        return `The same ${colourWord(colourOf[fs[0]])}-${colourWord(colourOf[fs[1]])} edge piece is there ${k === 2 ? 'twice' : k + ' times'}: at ${places}. `
          + 'Each edge has two such pieces, and they are mirror images of each other (the colours sit the other way round), so one of these is probably filled in the wrong way round: its two colours swapped.';
      });
      if (n === 5) dupCheck(midgeAt.map((c) => c.piece), (e) => midges[e], (e) => `the middle of the ${EDGE_PLACE[e]} edge`, edgeName, 'middle edge piece', 12);
      // centre counts per kind of centre piece (5x5); on the 4x4 they follow from the counts above
      const orbitCheck = (orbit, what) => {
        const cnt = Object.fromEntries(COLOUR_KEYS.map((c) => [c, 0]));
        for (const i of orbit) cnt[colours[i]]++;
        const bad = COLOUR_KEYS.filter((c) => cnt[c] !== orbit.length / 6);
        if (!bad.length) return;
        const words = bad.map((c) => `${cnt[c]} ${colourWord(c)}`);
        errors.push({
          kind: 'centres',
          text: `${cap(what)}: each colour must be there exactly ${orbit.length / 6} times, but there ${cnt[bad[0]] === 1 ? 'is' : 'are'} ${list(words)}.`,
          stickers: orbit.filter((i) => cnt[colours[i]] > orbit.length / 6),
        });
      };
      if (n === 5) {
        orbitCheck(xCentres, 'the centre stickers diagonally next to the middle of each face (four per face)');
        orbitCheck(tCentres, 'the centre stickers directly above, below, left and right of the middle of each face (four per face)');
      } else if (!errors.length) {
        orbitCheck(xCentres, 'the centre stickers (the four in the middle of each face)');
      }
      if (errors.length) return finish(res);

      // every piece is real and there once: now what only a physically changed cube can have
      const co = corners.map((c) => c.ori);
      const twist = co.reduce((s, x) => s + x, 0) % 3;
      if (twist) {
        errors.push({
          kind: 'twist',
          text: 'One corner is twisted in place (it has been turned on its own, or two of its stickers were filled in the wrong way round). '
            + `A real cube can't get like this by turning. Check each corner's colours; turning one corner ${twist === 1 ? 'anticlockwise' : 'clockwise'} would fix it.`,
          stickers: [],
        });
      }
      if (n === 5) {
        if (midgeAt.reduce((s, c) => s + c.ori, 0) % 2) {
          errors.push({ kind: 'flip', text: "One middle edge piece is flipped (its two colours are swapped). The middle edge pieces of a 5x5 follow the same rules as the edges of a 3x3, so a real cube can't get like this by turning: check the colours of the middle edge pieces.", stickers: midges.flat() });
        }
        if (parity(corners.map((c) => c.piece)) !== parity(midgeAt.map((c) => c.piece))) {
          errors.push({ kind: 'parity', text: "Two pieces are swapped (two corners, or two middle edge pieces, have traded places). The corners and middle edges of a 5x5 follow the rules of a 3x3, so a real cube can't get like this by turning: check where each corner and middle edge piece is.", stickers: [] });
        }
      }
      if (errors.length) return finish(res);
      res.ok = true;
      res.faces = faces;
      res.solved = puzzle.isSolved(faces);
      return finish(res);
    }
    function finish(res) {
      if (res.ok) res.summary = res.solved ? 'This cube is already solved.' : 'This cube can be solved.';
      else res.summary = res.errors.length === 1 ? res.errors[0].text : `${res.errors.length} problems: ${res.errors[0].text}`;
      return res;
    }

    const kit = {
      n, m, puzzle, stickers, turnInfo, cornerFacelets, wings, midges, xCentres, tCentres, fixedCentres,
      wingPiece, cornerAt, edgeAt, schemeFromCorners, validate, at,
    };
    cache[n] = kit;
    return kit;
  }

  /** The puzzle module (the `def` every puzzle file exports) for an n x n big cube. */
  function makeDef(n) {
    const kit = makeBigCube(n);
    const { puzzle } = kit;
    const SAY = {
      F: 'Show the face you want as the front, with your chosen top face on top.',
      R: 'Turn the cube a quarter to the left: the right face, same top.',
      B: 'Another quarter to the left: the back face, same top.',
      L: 'Another quarter: the left face, same top.',
      U: 'Turn back to the front, then tip the top towards you: the top face, the back on top.',
      D: 'Now tip it the other way: the bottom face, the front on top.',
    };
    const SAY5 = {
      F: 'Show the face you want as the front (for example the one with the green middle sticker), with your chosen top face (for example white) on top.',
      ...Object.fromEntries(['R', 'B', 'L', 'U', 'D'].map((f) => [f, SAY[f]])),
    };
    const describeLayer = (info) => {
      const face = FACE_NAME[info.face].toLowerCase();
      if (info.layers.length === 2) return `the two ${face} layers`;
      if (info.layers[0] === 0) return `the ${face} face`;
      if (info.layers[0] === 1) return `the second layer from the ${face}`;
      return `the middle layer (turned like the ${face} face)`;
    };
    return {
      id: 'cube' + n,
      name: `Rubik's Cube ${n}x${n}`,
      short: `${n}x${n}`,
      puzzle,
      kit,
      scrambleLength: n === 4 ? 40 : 60,
      optimal: false,
      fixedStickers: [],
      validate(colours) {
        const v = kit.validate(colours);
        return { ok: v.ok, solved: v.solved, errors: v.errors, summary: v.summary, faces: v.faces, colourOf: v.colourOf };
      },
      randomMoves: (len, seed) => puzzle.randomMoves(len, seed),
      describeMove(mv) {
        const what = describeLayer(kit.turnInfo[mv.turn]);
        return mv.amount === 2 ? `${what} half a turn` : mv.amount === 3 ? `${what} a quarter anticlockwise` : `${what} a quarter clockwise`;
      },
      scan: { experimental: false, faces: ['F', 'R', 'B', 'L', 'U', 'D'].map((f) => ({ face: f, say: (n === 5 ? SAY5 : SAY)[f] })) },
      holdHelp: n === 4
        ? 'A 4x4 has no fixed centres, so hold it any way you like and keep it that way: the face looking at you is the front, the one on top is the top. Fill in the front, then turn the whole cube a quarter to the left for the right face, again for the back and the left face. For the top face, tip the cube towards you; for the bottom, tip it away from you. The corners tell which colour belongs on which face (the bottom-back-left corner decides it), and the solution builds each centre where it belongs.'
        : 'Hold the cube with the colour you like on top (white, usually) and another facing you (green, usually), and keep it that way. The middle sticker of each face says which colour that face will be when it is solved.',
      notationHelp: n === 4
        ? "Capital letters turn an outer layer: R = the right face, L = left, U = top (up), D = bottom (down), F = front, B = back, a quarter turn clockwise as you look at that face. A small letter turns only the second layer behind that face: r = the layer just inside the right face (turn it the same way as R). Rw (w for wide) turns the two right layers together. ' means anticlockwise, 2 means half a turn. Example: r' = the second layer from the right, a quarter turn away from you."
        : "Capital letters turn an outer layer: R = the right face, L = left, U = top (up), D = bottom (down), F = front, B = back, a quarter turn clockwise as you look at that face. A small letter turns only the second layer behind that face: r = the layer just inside the right face (turn it the same way as R). Rw (w for wide) turns the two right layers together. M is the middle layer between left and right (turned like L), E the middle layer between top and bottom (turned like D), S the middle layer between front and back (turned like F). ' means anticlockwise, 2 means half a turn.",
    };
  }

  return { makeBigCube, makeDef, COLOURS, COLOUR_KEYS, FACES, AXIS, OPPOSITE, FACE_NAME, FACE_WORD, STANDARD_SCHEME, CORNER_FACES, EDGE_FACES, CORNER_PLACE, EDGE_PLACE, parity };
}));
