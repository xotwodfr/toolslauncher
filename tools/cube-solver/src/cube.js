'use strict';
// The cube model, shared by the main process, the solver worker, the tests and the window (loaded with <script> there).
//
// A cube is a list of stickers ("facelets") in the usual Kociemba order: the U face, then R, F, D, L, B, each read row by
// row as you see it from outside the cube (U with the back edge at the top, D with the front edge at the top, the side
// faces with U at the top). 3x3 = 54 stickers, 2x2 = 24. A state is either face letters ("UUUU...") or colour keys
// ('w','y','g','b','r','o', or null for a sticker that is not filled in).
//
// Turns are computed from the 3D geometry (every sticker has a position and a normal; a turn rotates the stickers of one
// layer), so 2x2 and 3x3 share one implementation and the tables can never disagree with the picture. On top of that sits
// the piece ("cubie") level: which corner / edge is where and how it is twisted, used for validation and the 2x2 solver.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CubeModel = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  const FACES = ['U', 'R', 'F', 'D', 'L', 'B'];
  const AXIS = { U: [0, 1, 0], R: [1, 0, 0], F: [0, 0, 1], D: [0, -1, 0], L: [-1, 0, 0], B: [0, 0, -1] };
  const OPPOSITE = { U: 'D', D: 'U', R: 'L', L: 'R', F: 'B', B: 'F' };
  const FACE_WORD = { U: 'top', D: 'bottom', F: 'front', B: 'back', L: 'left', R: 'right' };

  const COLOURS = ['w', 'y', 'g', 'b', 'r', 'o'];
  const COLOUR_NAME = { w: 'white', y: 'yellow', g: 'green', b: 'blue', r: 'red', o: 'orange' };
  const COLOUR_HEX = { w: '#f4f4f2', y: '#ffd500', g: '#009b48', b: '#0046ad', r: '#c41e3a', o: '#ff5800' };
  // The usual ("Western") colour scheme, held white up and green in front.
  const STANDARD_SCHEME = { U: 'w', D: 'y', F: 'g', B: 'b', R: 'r', L: 'o' };

  // Kociemba piece order. The first face of a corner is its U/D sticker, the rest follow clockwise.
  const CORNER_FACES = [['U', 'R', 'F'], ['U', 'F', 'L'], ['U', 'L', 'B'], ['U', 'B', 'R'], ['D', 'F', 'R'], ['D', 'L', 'F'], ['D', 'B', 'L'], ['D', 'R', 'B']];
  const EDGE_FACES = [['U', 'R'], ['U', 'F'], ['U', 'L'], ['U', 'B'], ['D', 'R'], ['D', 'F'], ['D', 'L'], ['D', 'B'], ['F', 'R'], ['F', 'L'], ['B', 'L'], ['B', 'R']];
  const placeName = (faces) => {
    const order = ['U', 'D', 'F', 'B', 'L', 'R'];
    return faces.slice().sort((a, b) => order.indexOf(a) - order.indexOf(b)).map((f) => FACE_WORD[f]).join('-');
  };
  const CORNER_PLACE = CORNER_FACES.map(placeName);
  const EDGE_PLACE = EDGE_FACES.map(placeName);

  // ---- geometry --------------------------------------------------------------------------------------------------------
  const geoCache = {};
  function geometry(n) {
    if (geoCache[n]) return geoCache[n];
    if (n !== 2 && n !== 3) throw new Error('Only 2x2 and 3x3 cubes are supported');
    const m = (n - 1) / 2;
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
          stickers.push({ i, face: FACES[f], f, r, c, pos: p, normal });
          index.set(key(p, normal), i);
        }
      }
    }
    const g = { n, m, size: 6 * n * n, perFace: n * n, stickers, index };
    g.moves = buildMoves(g);
    g.cornerFacelets = CORNER_FACES.map((fs) => {
      const sign = [0, 1, 2].map((k) => fs.reduce((s, f) => s + AXIS[f][k], 0));
      const pos = sign.map((v) => v * m);
      return fs.map((f) => index.get(key(pos, AXIS[f])));
    });
    g.edgeFacelets = n === 3 ? EDGE_FACES.map((fs) => {
      const pos = [0, 1, 2].map((k) => fs.reduce((s, f) => s + AXIS[f][k], 0) * m);
      return fs.map((f) => index.get(key(pos, AXIS[f])));
    }) : [];
    g.centres = n === 3 ? FACES.map((_, f) => f * 9 + 4) : [];
    geoCache[n] = g;
    return g;
  }
  function key(p, nrm) { return p.map((v) => Math.round(v * 2)).join(',') + '|' + nrm.join(','); }
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  // A quarter turn clockwise as seen looking at the face from outside = -90 degrees about its outward axis.
  const quarter = (a, v) => { const c = cross(a, v); const d = dot(a, v); return [0, 1, 2].map((k) => -c[k] + a[k] * d); };

  function buildMoves(g) {
    const moves = {};
    for (const face of FACES) {
      const a = AXIS[face];
      const perm1 = new Array(g.size);
      for (let i = 0; i < g.size; i++) perm1[i] = i;
      for (const s of g.stickers) {
        if (Math.abs(dot(s.pos, a) - g.m) > 1e-9) continue; // not in the outer layer of this face
        const target = g.index.get(key(quarter(a, s.pos), quarter(a, s.normal)));
        perm1[target] = s.i; // after the turn, sticker `target` shows what sticker s showed
      }
      const compose = (p, q) => p.map((x) => q[x]); // apply q then p: out[i] = in[q[p[i]]]... see applyPerm
      const perm2 = compose(perm1, perm1);
      const perm3 = compose(perm2, perm1);
      moves[face] = perm1; moves[face + '2'] = perm2; moves[face + "'"] = perm3;
    }
    return moves;
  }

  // ---- moves and notation -----------------------------------------------------------------------------------------------
  const MOVE_NAMES = [];
  for (const f of FACES) MOVE_NAMES.push(f, f + '2', f + "'");
  const MOVE_RE = /^([URFDLB])(2'?|'|’|2’)?$/;

  /** "R U R' U'" -> ['R','U',"R'","U'"]. Throws a plain-words error on anything else. */
  function parseMoves(text) {
    if (Array.isArray(text)) return text.map((m) => normMove(m));
    const tokens = String(text || '').replace(/[()[\],]/g, ' ').trim().split(/\s+/).filter(Boolean);
    return tokens.map(normMove);
  }
  function normMove(tok) {
    const m = MOVE_RE.exec(String(tok).trim());
    if (!m) throw new Error(`"${tok}" is not a move: use U, D, L, R, F or B, optionally followed by ' or 2`);
    const suffix = (m[2] || '').replace(/’/g, "'");
    return m[1] + (suffix.startsWith('2') ? '2' : suffix);
  }
  const inverseMove = (m) => (m.endsWith('2') ? m : m.endsWith("'") ? m[0] : m + "'");
  const invertMoves = (moves) => moves.slice().reverse().map(inverseMove);
  const formatMoves = (moves) => moves.join(' ');
  /** Merges neighbouring turns of the same face ("R R" -> "R2", "R R'" -> nothing). */
  function simplify(moves) {
    const out = [];
    for (const mv of moves) {
      const amt = (x) => (x.endsWith('2') ? 2 : x.endsWith("'") ? 3 : 1);
      if (out.length && out[out.length - 1][0] === mv[0]) {
        const t = (amt(out.pop()) + amt(mv)) % 4;
        if (t) out.push(mv[0] + (t === 2 ? '2' : t === 3 ? "'" : ''));
      } else out.push(mv);
    }
    return out;
  }

  /** Applies moves to a state (an array or string of any sticker values) and returns a new array. */
  function applyMoves(n, state, moves) {
    const g = geometry(n);
    let cur = Array.from(state);
    if (cur.length !== g.size) throw new Error(`A ${n}x${n} cube has ${g.size} stickers, not ${cur.length}`);
    for (const mv of typeof moves === 'string' ? parseMoves(moves) : moves) {
      const p = g.moves[mv];
      if (!p) throw new Error('Unknown move ' + mv);
      const next = new Array(g.size);
      for (let i = 0; i < g.size; i++) next[i] = cur[p[i]];
      cur = next;
    }
    return cur;
  }

  const solvedFaces = (n) => { const g = geometry(n); return g.stickers.map((s) => s.face); };
  const solvedColours = (n, scheme = STANDARD_SCHEME) => solvedFaces(n).map((f) => scheme[f]);
  /** Every face shows one value (whatever it is). */
  function isSolved(n, state) {
    const g = geometry(n);
    for (let f = 0; f < 6; f++) {
      const first = state[f * g.perFace];
      if (first == null) return false;
      for (let k = 1; k < g.perFace; k++) if (state[f * g.perFace + k] !== first) return false;
    }
    return true;
  }

  // ---- pieces -------------------------------------------------------------------------------------------------------------
  /** Face letters -> pieces: cp[i]/co[i] = which corner sits at position i and how it is twisted; same for edges. Null when a
   *  position holds something that is not a real piece. */
  function toCubies(n, faces) {
    const g = geometry(n);
    const cp = []; const co = []; const ep = []; const eo = [];
    for (let i = 0; i < 8; i++) {
      const fl = g.cornerFacelets[i].map((k) => faces[k]);
      const ori = fl.findIndex((x) => x === 'U' || x === 'D');
      if (ori < 0) return null;
      const c1 = fl[(ori + 1) % 3]; const c2 = fl[(ori + 2) % 3];
      const j = CORNER_FACES.findIndex((cf) => cf[0] === fl[ori] && cf[1] === c1 && cf[2] === c2);
      if (j < 0) return null;
      cp.push(j); co.push(ori);
    }
    for (let i = 0; i < g.edgeFacelets.length; i++) {
      const [a, b] = g.edgeFacelets[i].map((k) => faces[k]);
      let j = EDGE_FACES.findIndex((e) => e[0] === a && e[1] === b);
      if (j >= 0) { ep.push(j); eo.push(0); continue; }
      j = EDGE_FACES.findIndex((e) => e[0] === b && e[1] === a);
      if (j < 0) return null;
      ep.push(j); eo.push(1);
    }
    return { cp, co, ep, eo };
  }
  /** Pieces -> face letters (centres solved). */
  function fromCubies(n, { cp, co, ep = [], eo = [] }) {
    const g = geometry(n);
    const out = solvedFaces(n);
    for (let i = 0; i < 8; i++) {
      for (let k = 0; k < 3; k++) out[g.cornerFacelets[i][(k + co[i]) % 3]] = CORNER_FACES[cp[i]][k];
    }
    for (let i = 0; i < ep.length; i++) {
      for (let k = 0; k < 2; k++) out[g.edgeFacelets[i][(k + eo[i]) % 2]] = EDGE_FACES[ep[i]][k];
    }
    return out;
  }
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

  // ---- random states --------------------------------------------------------------------------------------------------------
  function rngFrom(seed) {
    if (typeof seed === 'function') return seed;
    if (seed == null) return Math.random;
    let s = seed >>> 0 || 1;
    return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
  }
  function shuffle(a, rnd) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
  /** A uniformly random solvable 3x3 state (face letters). */
  function randomState3(seed) {
    const rnd = rngFrom(seed);
    const cp = shuffle([0, 1, 2, 3, 4, 5, 6, 7], rnd);
    const ep = shuffle([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], rnd);
    if (parity(cp) !== parity(ep)) [ep[0], ep[1]] = [ep[1], ep[0]];
    const co = []; let cs = 0;
    for (let i = 0; i < 7; i++) { co.push(Math.floor(rnd() * 3)); cs += co[i]; }
    co.push((3 - (cs % 3)) % 3);
    const eo = []; let es = 0;
    for (let i = 0; i < 11; i++) { eo.push(Math.floor(rnd() * 2)); es += eo[i]; }
    eo.push(es % 2);
    return fromCubies(3, { cp, co, ep, eo });
  }
  /** A uniformly random 2x2 state with the bottom-back-left corner in place. */
  function randomState2(seed) {
    const rnd = rngFrom(seed);
    const rest = shuffle([0, 1, 2, 3, 4, 5, 7], rnd);
    const cp = [...rest.slice(0, 6), 6, rest[6]];
    const co = []; let cs = 0;
    for (let i = 0; i < 8; i++) { if (i === 6) { co.push(0); continue; } if (i === 7) break; co.push(Math.floor(rnd() * 3)); cs += co[co.length - 1]; }
    co.push((3 - (cs % 3)) % 3);
    return fromCubies(2, { cp, co });
  }
  /** A random turn sequence (no face twice in a row, no A B A on opposite faces). 2x2 uses U, R and F only. */
  function randomMoves(n, length, seed) {
    const rnd = rngFrom(seed);
    const faces = n === 2 ? ['U', 'R', 'F'] : FACES;
    const out = [];
    while (out.length < length) {
      const f = faces[Math.floor(rnd() * faces.length)];
      const last = out[out.length - 1]; const prev = out[out.length - 2];
      if (last && last[0] === f) continue;
      if (last && prev && OPPOSITE[last[0]] === f && prev[0] === f) continue;
      out.push(f + ['', '2', "'"][Math.floor(rnd() * 3)]);
    }
    return out;
  }

  // ---- validation ---------------------------------------------------------------------------------------------------------------
  const colourWord = (c) => COLOUR_NAME[c] || 'empty';
  const list = (words) => (words.length <= 1 ? words.join('') : words.slice(0, -1).join(', ') + ' and ' + words[words.length - 1]);
  const plural = (k, one, many) => `${k} ${k === 1 ? one : many}`;

  function permutations(arr) {
    if (arr.length <= 1) return [arr.slice()];
    const out = [];
    arr.forEach((x, i) => { for (const p of permutations([...arr.slice(0, i), ...arr.slice(i + 1)])) out.push([x, ...p]); });
    return out;
  }
  const FACE_PERMS = permutations(FACES);
  const isStandardPairing = (map) => ['U', 'R', 'F'].every((f) => { const a = map[f]; const b = map[OPPOSITE[f]]; return (a === 'w' && b === 'y') || (a === 'y' && b === 'w') || (a === 'g' && b === 'b') || (a === 'b' && b === 'g') || (a === 'r' && b === 'o') || (a === 'o' && b === 'r'); });

  /** For a 2x2 (no centres): which colour belongs to which face, chosen so the most corners are real pieces and the
   *  bottom-back-left corner is in place. Returns { faceOf: colour -> face, colourOf: face -> colour }. */
  function schemeFor2(colours) {
    const g = geometry(2);
    let best = null;
    for (const perm of FACE_PERMS) {
      const faceOf = {}; COLOURS.forEach((c, i) => { faceOf[c] = perm[i]; });
      const faces = colours.map((c) => faceOf[c]);
      let valid = 0;
      for (let i = 0; i < 8; i++) if (cornerAt(g, faces, i).piece >= 0) valid++;
      const dbl = g.cornerFacelets[6].map((k) => faces[k]).join('') === 'DBL';
      const colourOf = {}; for (const c of COLOURS) colourOf[faceOf[c]] = c;
      const score = valid * 4 + (dbl ? 2 : 0) + (isStandardPairing(colourOf) ? 1 : 0);
      if (!best || score > best.score) best = { score, faceOf, colourOf };
    }
    return best;
  }
  // What is at corner position i: piece index and twist, or a reason it cannot be a piece.
  function cornerAt(g, faces, i) {
    const fl = g.cornerFacelets[i].map((k) => faces[k]);
    if (fl.some((x) => x == null)) return { piece: -1, why: 'empty' };
    if (new Set(fl).size < 3) return { piece: -1, why: 'repeat' };
    for (let a = 0; a < 3; a++) for (let b = a + 1; b < 3; b++) if (OPPOSITE[fl[a]] === fl[b]) return { piece: -1, why: 'opposite', pair: [a, b] };
    const ori = fl.findIndex((x) => x === 'U' || x === 'D');
    const c1 = fl[(ori + 1) % 3]; const c2 = fl[(ori + 2) % 3];
    const j = CORNER_FACES.findIndex((cf) => cf[0] === fl[ori] && cf[1] === c1 && cf[2] === c2);
    if (j < 0) return { piece: -1, why: 'mirror' };
    return { piece: j, ori };
  }
  function edgeAt(g, faces, i) {
    const [a, b] = g.edgeFacelets[i].map((k) => faces[k]);
    if (a == null || b == null) return { piece: -1, why: 'empty' };
    if (a === b) return { piece: -1, why: 'repeat' };
    if (OPPOSITE[a] === b) return { piece: -1, why: 'opposite' };
    let j = EDGE_FACES.findIndex((e) => e[0] === a && e[1] === b);
    if (j >= 0) return { piece: j, ori: 0 };
    j = EDGE_FACES.findIndex((e) => e[0] === b && e[1] === a);
    return { piece: j, ori: 1 };
  }

  /**
   * Checks a cube that was filled in or scanned. `colours` is an array of colour keys (or null). Returns
   *   { ok, solved, faces, colourOf, errors: [{ kind, text, stickers }], summary }
   * where faces is the face-letter state to solve (when ok), colourOf maps face letters to colours, and every error says in
   * plain words what is wrong and which stickers to look at. Kinds: empty, count, centres, piece, duplicate, missing, twist,
   * flip, parity.
   */
  function validate(n, colours) {
    const g = geometry(n);
    const errors = [];
    const res = { ok: false, solved: false, faces: null, colourOf: null, errors };
    if (!colours || colours.length !== g.size) {
      errors.push({ kind: 'empty', text: `A ${n}x${n} cube has ${g.size} stickers.`, stickers: [] });
      return finish(res);
    }
    const empty = [];
    colours.forEach((c, i) => { if (!COLOURS.includes(c)) empty.push(i); });
    if (empty.length) {
      errors.push({ kind: 'empty', text: `${plural(empty.length, 'sticker is', 'stickers are')} not filled in yet.`, stickers: empty });
      return finish(res);
    }
    // colour counts
    const count = Object.fromEntries(COLOURS.map((c) => [c, 0]));
    for (const c of colours) count[c]++;
    const want = g.perFace;
    const over = COLOURS.filter((c) => count[c] > want); const under = COLOURS.filter((c) => count[c] < want);
    if (over.length || under.length) {
      const words = [...over, ...under].map((c) => `${count[c]} ${colourWord(c)}`);
      errors.push({
        kind: 'count',
        text: `Every colour must appear exactly ${want} times, but there ${count[over[0] || under[0]] === 1 ? 'is' : 'are'} ${list(words)} ${words.length === 1 && count[over[0] || under[0]] === 1 ? 'sticker' : 'stickers'}.`,
        stickers: [], // which of the stickers is wrong cannot be told from the counts alone
        over, under,
      });
    }
    // which colour is which face
    let faceOf;
    if (n === 3) {
      const cc = g.centres.map((i) => colours[i]);
      const dup = COLOURS.filter((c) => cc.filter((x) => x === c).length > 1);
      if (dup.length) {
        errors.push({ kind: 'centres', text: `Two centres are ${list(dup.map(colourWord))}: every face of a 3x3 has its own centre colour.`, stickers: g.centres.filter((i) => dup.includes(colours[i])) });
        return finish(res);
      }
      faceOf = {}; cc.forEach((c, f) => { faceOf[c] = FACES[f]; });
    } else {
      faceOf = schemeFor2(colours).faceOf;
    }
    const colourOf = {}; for (const c of COLOURS) colourOf[faceOf[c]] = c;
    res.colourOf = colourOf;
    const faces = colours.map((c) => faceOf[c]);
    const cornerName = (j) => CORNER_FACES[j].map((f) => colourWord(colourOf[f])).join('-');
    const edgeName = (j) => EDGE_FACES[j].map((f) => colourWord(colourOf[f])).join('-');

    // pieces that cannot exist
    const corners = []; const edges = [];
    let pieceTrouble = false;
    for (let i = 0; i < 8; i++) {
      const at = cornerAt(g, faces, i);
      corners.push(at);
      if (at.piece >= 0) continue;
      pieceTrouble = true;
      const cols = g.cornerFacelets[i].map((k) => colours[k]);
      const stickers = g.cornerFacelets[i].slice();
      const has = list(cols.map(colourWord));
      let text;
      if (at.why === 'repeat') {
        const twice = cols.find((c, k) => cols.indexOf(c) !== k);
        text = `The ${CORNER_PLACE[i]} corner has two ${colourWord(twice)} stickers (${has}). No corner piece has that.`;
      } else if (at.why === 'opposite') {
        text = `The ${CORNER_PLACE[i]} corner has ${colourWord(cols[at.pair[0]])} and ${colourWord(cols[at.pair[1]])} together (${has}), but those are opposite colours: no corner piece has both.`;
      } else {
        text = `The ${CORNER_PLACE[i]} corner (${has}) has its colours the wrong way round, like a mirror image: two of its stickers are probably swapped.`;
      }
      errors.push({ kind: 'piece', text, stickers });
    }
    for (let i = 0; i < g.edgeFacelets.length; i++) {
      const at = edgeAt(g, faces, i);
      edges.push(at);
      if (at.piece >= 0) continue;
      pieceTrouble = true;
      const cols = g.edgeFacelets[i].map((k) => colours[k]);
      const text = at.why === 'repeat'
        ? `The ${EDGE_PLACE[i]} edge has two ${colourWord(cols[0])} stickers. No edge piece has that.`
        : `The ${EDGE_PLACE[i]} edge has ${colourWord(cols[0])} and ${colourWord(cols[1])}, but those are opposite colours: no edge piece has both.`;
      errors.push({ kind: 'piece', text, stickers: g.edgeFacelets[i].slice() });
    }
    // the same piece twice (so another one is missing)
    const dupCheck = (items, facelets, places, name, word, total) => {
      const where = new Map();
      items.forEach((at, i) => { if (at.piece >= 0) { if (!where.has(at.piece)) where.set(at.piece, []); where.get(at.piece).push(i); } });
      for (const [piece, at] of where) {
        if (at.length < 2) continue;
        pieceTrouble = true;
        errors.push({ kind: 'duplicate', text: `The ${name(piece)} ${word} is there ${at.length === 2 ? 'twice' : at.length + ' times'}: at ${list(at.map((i) => 'the ' + places[i]))}.`, stickers: at.flatMap((i) => facelets[i]) });
      }
      if (!pieceTrouble) return;
      const missing = [];
      for (let j = 0; j < total; j++) if (!where.has(j)) missing.push(j);
      if (missing.length && errors.some((e) => e.kind === 'duplicate')) {
        errors.push({ kind: 'missing', text: `So ${missing.length === 1 ? 'this ' + word + ' is' : 'these ' + word + 's are'} missing: ${list(missing.map(name))}.`, stickers: [] });
      }
    };
    dupCheck(corners, g.cornerFacelets, CORNER_PLACE, cornerName, 'corner', 8);
    if (n === 3) dupCheck(edges, g.edgeFacelets, EDGE_PLACE, edgeName, 'edge', 12);
    if (errors.length) return finish(res);

    // every piece is real and there once: now the things only a physically changed cube can have
    const cub = toCubies(n, faces);
    const twist = cub.co.reduce((s, x) => s + x, 0) % 3;
    if (twist) {
      errors.push({
        kind: 'twist',
        text: 'One corner is twisted in place (it has been turned on its own, or two of its stickers were filled in the wrong way round). '
          + `A real cube can't get like this by turning. Check each corner's colours; turning one corner ${twist === 1 ? 'anticlockwise' : 'clockwise'} would fix it.`,
        stickers: [],
      });
    }
    if (n === 3) {
      if (cub.eo.reduce((s, x) => s + x, 0) % 2) {
        errors.push({ kind: 'flip', text: "One edge is flipped (its two colours are swapped). A real cube can't get like this by turning: check the edges' colours.", stickers: [] });
      }
      if (parity(cub.cp) !== parity(cub.ep)) {
        errors.push({ kind: 'parity', text: "Two pieces are swapped (for example two edges or two corners have traded places). A real cube can't get like this by turning: check where each piece is.", stickers: [] });
      }
    }
    if (errors.length) return finish(res);
    res.ok = true;
    res.faces = faces;
    res.solved = isSolved(n, faces);
    return finish(res);
  }
  function finish(res) {
    if (res.ok) res.summary = res.solved ? 'This cube is already solved.' : 'This cube can be solved.';
    else res.summary = res.errors.length === 1 ? res.errors[0].text : `${res.errors.length} problems: ${res.errors[0].text}`;
    return res;
  }

  /** Centres of a 3x3 for a way of holding it: top colour + front colour, with the standard colour scheme. */
  function orientationScheme(top, front) {
    // rotate the standard scheme until `top` is up and `front` is in front
    const ROT = {
      x: { U: 'F', F: 'D', D: 'B', B: 'U', L: 'L', R: 'R' }, // what moves into each position: new[U] = old[F]
      y: { F: 'R', R: 'B', B: 'L', L: 'F', U: 'U', D: 'D' },
      z: { U: 'L', L: 'D', D: 'R', R: 'U', F: 'F', B: 'B' },
    };
    const seen = new Set();
    let frontier = [STANDARD_SCHEME];
    while (frontier.length) {
      const next = [];
      for (const s of frontier) {
        const k = FACES.map((f) => s[f]).join('');
        if (seen.has(k)) continue;
        seen.add(k);
        if (s.U === top && s.F === front) return s;
        for (const r of Object.values(ROT)) { const t = {}; for (const f of FACES) t[f] = s[r[f]]; next.push(t); }
      }
      frontier = next;
    }
    return null; // top and front are opposite colours or the same
  }

  return {
    FACES, AXIS, OPPOSITE, FACE_WORD, COLOURS, COLOUR_NAME, COLOUR_HEX, STANDARD_SCHEME, CORNER_FACES, EDGE_FACES, CORNER_PLACE, EDGE_PLACE, MOVE_NAMES,
    geometry, parseMoves, normMove, inverseMove, invertMoves, formatMoves, simplify, applyMoves, solvedFaces, solvedColours, isSolved,
    toCubies, fromCubies, parity, rngFrom, randomState3, randomState2, randomMoves, validate, schemeFor2, orientationScheme,
  };
}));
