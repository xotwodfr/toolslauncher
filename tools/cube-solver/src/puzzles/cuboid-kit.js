'use strict';
// Shared building blocks for the two cuboids (3x3x2 "Domino" and 3x2x2): the geometry of an a x b x c box of cubies, its
// face turns, the pieces (which stickers belong to one cubie), and the reading of a filled-in colour array into pieces with
// plain-words validation. Each cuboid file (cuboid332.js, cuboid322.js) calls makeCuboid() with its size and wording.
//
// Loaded with require() in Node and a <script> tag in the window (window.CuboidKit), after puzzle-core.js and BEFORE
// cuboid332.js / cuboid322.js.
//
// Coordinates: x to the right, y up, z towards you (the front). The box is X wide, Y tall, Z deep, cubies are 1 unit, the
// centre of the box is the origin. Faces U (top), R, F (front), D (bottom), L, B, like cube.js. Sticker order: the faces in
// that order (U, R, F, D, L, B), each read row by row as you see it from outside (U with the back edge at the top, D with
// the front edge at the top, the side faces with the top at the top), left to right.
//
// How a state is read: every cubie position ("slot") has 1, 2 or 3 stickers. For each piece we work out (once, by moving
// it around with the turns) every way it can sit in every slot. A filled-in puzzle is then tried against each way the user
// could be holding it (each whole-puzzle rotation that keeps the shape): if every slot holds a real piece, in a way it can
// actually sit there, and no piece is there twice, it is solvable (on both cuboids every arrangement of the pieces can be
// reached: see the files of the two puzzles). Otherwise the way of holding it that explains most pieces is used to say,
// in plain words, what is wrong.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('../puzzle-core'));
  else root.CuboidKit = factory(root.PuzzleCore);
}(typeof self !== 'undefined' ? self : this, function (PC) {
  const { dot, cross, add, sub, scale } = PC;

  const COLOURS = {
    w: { name: 'white', hex: '#f4f4f2' },
    y: { name: 'yellow', hex: '#ffd500' },
    g: { name: 'green', hex: '#009b48' },
    b: { name: 'blue', hex: '#0046ad' },
    r: { name: 'red', hex: '#c41e3a' },
    o: { name: 'orange', hex: '#ff5800' },
  };
  const COLOUR_KEYS = Object.keys(COLOURS);
  const FACE_DEF = [
    { id: 'U', name: 'Top', normal: [0, 1, 0], up: [0, 0, -1], colour: 'w' },
    { id: 'R', name: 'Right', normal: [1, 0, 0], up: [0, 1, 0], colour: 'r' },
    { id: 'F', name: 'Front', normal: [0, 0, 1], up: [0, 1, 0], colour: 'g' },
    { id: 'D', name: 'Bottom', normal: [0, -1, 0], up: [0, 0, 1], colour: 'y' },
    { id: 'L', name: 'Left', normal: [-1, 0, 0], up: [0, 1, 0], colour: 'o' },
    { id: 'B', name: 'Back', normal: [0, 0, -1], up: [0, 1, 0], colour: 'b' },
  ];
  const FACE_WORD = { U: 'top', D: 'bottom', F: 'front', B: 'back', L: 'left', R: 'right' };
  const OPPOSITE = { U: 'D', D: 'U', R: 'L', L: 'R', F: 'B', B: 'F' };
  const STANDARD = Object.fromEntries(FACE_DEF.map((f) => [f.id, f.colour]));
  const STANDARD_FACE_OF = Object.fromEntries(FACE_DEF.map((f) => [f.colour, f.id]));
  const WORD_ORDER = ['U', 'D', 'F', 'B', 'L', 'R'];

  const axisOf = (v) => [0, 1, 2].find((k) => Math.abs(v[k]) > 0.5);
  const colourWord = (c) => (COLOURS[c] ? COLOURS[c].name : 'empty');
  const list = (words) => (words.length <= 1 ? words.join('') : words.slice(0, -1).join(', ') + ' and ' + words[words.length - 1]);
  const plural = (k, one, many) => `${k} ${k === 1 ? one : many}`;
  const permParityOdd = (a, b) => { // a, b: the same items in two orders; true if it takes an odd number of swaps
    const p = a.map((x) => b.indexOf(x)); let odd = false; const seen = new Array(p.length).fill(false);
    for (let i = 0; i < p.length; i++) { if (seen[i]) continue; let len = 0; for (let j = i; !seen[j]; j = p[j]) { seen[j] = true; len++; } if (len % 2 === 0) odd = !odd; }
    return odd;
  };

  /**
   * opts: { id, name, short, dims: [X, Y, Z], scrambleLength, holdHelp, notationHelp, scanSay: { U, R, F, D, L, B },
   *         notes: { flip, twist, centre } (puzzle-specific sentences for the validation messages), netGap }
   */
  function makeCuboid(opts) {
    const dims = opts.dims;
    const half = dims.map((d) => d / 2);

    // ---- geometry ----
    const faces = FACE_DEF.map((f) => ({ ...f }));
    const stickers = [];
    const faceSize = {}; // face id -> [columns, rows]
    for (const f of faces) {
      const a = axisOf(f.normal);
      const right = cross(f.up, f.normal);
      const cols = dims[axisOf(right)]; const rows = dims[axisOf(f.up)];
      faceSize[f.id] = [cols, rows];
      const base = scale(f.normal, half[a]);
      for (let j = 0; j < rows; j++) {
        for (let k = 0; k < cols; k++) {
          const centre = add(base, add(scale(right, -cols / 2 + k + 0.5), scale(f.up, rows / 2 - j - 0.5)));
          const corner = (dr, du) => add(centre, add(scale(right, dr), scale(f.up, du)));
          stickers.push({ face: f.id, centre, poly: [corner(-0.5, 0.5), corner(0.5, 0.5), corner(0.5, -0.5), corner(-0.5, -0.5)] });
        }
      }
    }
    const turns = {};
    for (const f of faces) {
      const a = axisOf(f.normal);
      const [cols, rows] = faceSize[f.id];
      const limit = half[a] - 1 + 1e-6;
      turns[f.id] = { axis: f.normal, order: cols === rows ? 4 : 2, select: (c) => dot(c, f.normal) > limit };
    }
    // fill-in map: the paper unfolding with F in the middle, U above, D below, L left, R right, B right of R
    const gap = opts.netGap == null ? 0.25 : opts.netGap;
    const [fw, fh] = faceSize.F; const [, uh] = faceSize.U; const [, dh] = faceSize.D;
    const [lw] = faceSize.L; const [rw] = faceSize.R; const [bw] = faceSize.B;
    const net = [
      { face: 'U', x: 0, y: -(fh / 2 + uh / 2 + gap) },
      { face: 'L', x: -(fw / 2 + lw / 2 + gap), y: 0 },
      { face: 'F', x: 0, y: 0 },
      { face: 'R', x: fw / 2 + rw / 2 + gap, y: 0 },
      { face: 'B', x: fw / 2 + rw + gap + bw / 2 + gap, y: 0 },
      { face: 'D', x: 0, y: fh / 2 + dh / 2 + gap },
    ];
    // Notation. Our own parse, because "R2" on a half-turn-only face must mean that half turn (amount 1 of order 2).
    const orderOf = (n) => turns[n].order;
    const format = (mv) => {
      if (orderOf(mv.turn) === 2) return mv.turn + '2';
      return mv.turn + (mv.amount === 1 ? '' : mv.amount === 2 ? '2' : "'");
    };
    const parse = (tok) => {
      const s = String(tok).trim().replace(/[’`´]/g, "'");
      const m = /^([URFDLB])(\d*)('?)$/.exec(s);
      const bad = () => new Error(`"${tok}" is not a move on the ${opts.name}: use ${FACE_DEF.map((f) => format({ turn: f.id, amount: 1 })).join(', ')} (and ' for the quarter turns backwards)`);
      if (!m) throw bad();
      const order = orderOf(m[1]);
      const n = m[2] ? Number(m[2]) : 1;
      let k;
      if (order === 2) { // a half-turn-only face: "R2", "R2'" and a bare "R" all mean the half turn
        if (!m[2]) k = 1; else if (n % 2) throw bad(); else k = (n / 2) % 2;
      } else {
        k = (((m[3] ? -n : n) % 4) + 4) % 4;
      }
      return k ? { turn: m[1], amount: k } : null;
    };
    const puzzle = PC.definePuzzle({ id: opts.id, name: opts.name, colours: COLOURS, faces, stickers, turns, net, format, parse });
    const N = puzzle.size;

    // ---- slots (cubie positions) and pieces ----
    const slotKey = (c) => c.map((v) => Math.round(v * 2)).join(',');
    const slotIndex = new Map(); const slots = [];
    const slotOfSticker = new Array(N);
    for (const s of puzzle.stickers) {
      const c = sub(s.centre, scale(s.normal, 0.5));
      const k = slotKey(c);
      if (!slotIndex.has(k)) { slotIndex.set(k, slots.length); slots.push({ index: slots.length, centre: c, stickers: [] }); }
      const si = slotIndex.get(k);
      slots[si].stickers.push(s.i);
      slotOfSticker[s.i] = si;
    }
    for (const sl of slots) {
      sl.faces = sl.stickers.map((i) => puzzle.stickers[i].face);
      sl.kind = ['', 'centre', 'edge', 'corner'][sl.stickers.length];
      sl.place = WORD_ORDER.filter((f) => sl.faces.includes(f)).map((f) => FACE_WORD[f]).join('-');
    }
    // the turns as moves, and what each does to the slots: after the move, slot a holds what slot slotPerm[a] held
    const moves = [];
    for (const name of puzzle.turnNames) {
      const t = puzzle.turns[name];
      for (let k = 1; k < t.order; k++) {
        const p = t.powers[k];
        const slotPerm = slots.map((sl) => slotOfSticker[p[sl.stickers[0]]]);
        moves.push({ turn: name, amount: k, text: puzzle.formatMove({ turn: name, amount: k }), slotPerm, sticker: p });
      }
    }
    // every way each piece can sit in each slot: move the piece alone around (breadth first) with the turns
    const solvedLetters = puzzle.solvedFaces();
    const arrangement = new Map(); // `${slot}|${letters in the slot's sticker order}` -> piece (= its home slot)
    const pieceLetters = slots.map((sl) => sl.stickers.map((i) => solvedLetters[i]));
    const pieceSet = new Map(slots.map((sl, k) => [pieceLetters[k].slice().sort().join(''), k]));
    const inverses = puzzle.turnNames.map((n) => { const p = puzzle.turns[n].powers[1]; const q = new Array(N); for (let i = 0; i < N; i++) q[p[i]] = i; return q; });
    const reach = slots.map(() => new Set()); // piece -> slots it can get to
    for (const sl of slots) {
      const start = sl.stickers.slice(); // where each of the piece's stickers is now
      const seen = new Set([start.join(',')]); const queue = [start];
      while (queue.length) {
        const pos = queue.shift();
        const at = slotOfSticker[pos[0]];
        const letters = new Map(pos.map((i, j) => [i, pieceLetters[sl.index][j]]));
        arrangement.set(at + '|' + slots[at].stickers.map((i) => letters.get(i)).join(''), sl.index);
        reach[sl.index].add(at);
        for (const q of inverses) {
          const nxt = pos.map((i) => q[i]);
          const k = nxt.join(',');
          if (!seen.has(k)) { seen.add(k); queue.push(nxt); }
        }
      }
    }
    /** Which piece is in each slot of a face-letter state: { piece, why } with piece -1 and a reason if none. */
    function pieceAt(letters, si) {
      const sl = slots[si];
      const l = sl.stickers.map((i) => letters[i]);
      if (l.some((x) => x == null)) return { piece: -1, why: 'empty' };
      const p = arrangement.get(si + '|' + l.join(''));
      if (p !== undefined) return { piece: p };
      if (new Set(l).size < l.length) return { piece: -1, why: 'repeat' };
      const real = pieceSet.get(l.slice().sort().join(''));
      if (real === undefined) {
        for (let a = 0; a < l.length; a++) for (let b = a + 1; b < l.length; b++) if (OPPOSITE[l[a]] === l[b]) return { piece: -1, why: 'opposite', pair: [a, b] };
        return { piece: -1, why: 'nopiece' };
      }
      if (!reach[real].has(si)) return { piece: -1, why: 'cannot-reach', real };
      if (l.length === 1) return { piece: -1, why: 'cannot-reach', real };
      if (l.length === 2) return { piece: -1, why: 'flip', real };
      // a corner: the way it should sit there, compared with how it is
      const ok = [...arrangement.keys()].find((k) => k.startsWith(si + '|') && arrangement.get(k) === real).split('|')[1].split('');
      return { piece: -1, why: permParityOdd(l, ok) ? 'mirror' : 'twist', real };
    }

    // ---- the ways of holding it: whole-puzzle rotations that keep the shape (as a map of face letters) ----
    const holds = [];
    {
      const normals = Object.fromEntries(faces.map((f) => [f.id, f.normal]));
      const letterOf = (v) => faces.find((f) => dot(f.normal, v) > 0.5).id;
      const signedPerms = [];
      for (const pr of [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]]) {
        for (let sg = 0; sg < 8; sg++) {
          const s = [sg & 1 ? -1 : 1, sg & 2 ? -1 : 1, sg & 4 ? -1 : 1];
          // the matrix with column k = s[k] * e_{pr[k]}: takes axis k to axis pr[k]
          const M = [[0, 0, 0], [0, 0, 0], [0, 0, 0]]; for (let k = 0; k < 3; k++) M[pr[k]][k] = s[k];
          const det = M[0][0] * (M[1][1] * M[2][2] - M[1][2] * M[2][1]) - M[0][1] * (M[1][0] * M[2][2] - M[1][2] * M[2][0]) + M[0][2] * (M[1][0] * M[2][1] - M[1][1] * M[2][0]);
          if (det !== 1) continue;
          if (![0, 1, 2].every((k) => dims[pr[k]] === dims[k])) continue;
          const apply = (v) => [0, 1, 2].map((r) => M[r][0] * v[0] + M[r][1] * v[1] + M[r][2] * v[2]);
          signedPerms.push(Object.fromEntries(faces.map((f) => [f.id, letterOf(apply(normals[f.id]))])));
        }
      }
      // the identity first
      signedPerms.sort((a, b) => Object.keys(b).filter((k) => b[k] === k).length - Object.keys(a).filter((k) => a[k] === k).length);
      for (const rho of signedPerms) {
        const faceOf = {}; for (const c of COLOUR_KEYS) faceOf[c] = rho[STANDARD_FACE_OF[c]];
        const colourOf = {}; for (const c of COLOUR_KEYS) colourOf[faceOf[c]] = c;
        holds.push({ faceOf, colourOf });
      }
    }

    /**
     * The colours of a position given piece by piece (for the tests): pieceOf[slot] = the piece there (= its home slot),
     * each sitting the way it can; null if some piece can't sit in its slot. `scheme` maps faces to colours (default standard).
     */
    function build(pieceOf, scheme) {
      const sc = scheme || STANDARD;
      const out = new Array(N);
      for (const sl of slots) {
        const key = [...arrangement.keys()].find((k) => k.startsWith(sl.index + '|') && arrangement.get(k) === pieceOf[sl.index]);
        if (!key) return null;
        const letters = key.split('|')[1].split('');
        sl.stickers.forEach((i, j) => { out[i] = sc[letters[j]]; });
      }
      return out;
    }

    const expected = {}; for (const f of faces) expected[f.colour] = faceSize[f.id][0] * faceSize[f.id][1];

    /** Reads a colour array: every way of holding it that makes it a real position, and the best explanation if none. */
    function read(colours) {
      const out = [];
      let best = null;
      for (const h of holds) {
        const letters = colours.map((c) => h.faceOf[c]);
        const at = slots.map((sl) => pieceAt(letters, sl.index));
        const used = new Map();
        at.forEach((a, si) => { if (a.piece >= 0) used.set(a.piece, (used.get(a.piece) || 0) + 1); });
        const good = at.filter((a) => a.piece >= 0).length;
        const dup = [...used.values()].some((v) => v > 1);
        const entry = { ...h, letters, at, good, dup };
        if (good === slots.length && !dup) out.push(entry);
        // the explanation: most pieces right; then the centres right; then the standard way of holding it
        const centresOk = at.filter((a, si) => a.piece >= 0 && slots[si].kind === 'centre').length;
        const score = good * 10 + centresOk * 3 - (dup ? 1 : 0);
        if (!best || score > best.score) best = { ...entry, score };
      }
      return { valid: out, best };
    }

    /** { ok, solved, errors: [{ kind, text, stickers }], summary } */
    function validate(colours) {
      const errors = [];
      const res = { ok: false, solved: false, errors };
      const done = () => {
        if (res.ok) res.summary = res.solved ? `This ${opts.name} is already solved.` : `This ${opts.name} can be solved.`;
        else res.summary = errors.length === 1 ? errors[0].text : `${errors.length} problems: ${errors[0].text}`;
        return res;
      };
      if (!colours || colours.length !== N) {
        errors.push({ kind: 'empty', text: `A ${opts.name} has ${N} stickers.`, stickers: [] });
        return done();
      }
      const empty = [];
      colours.forEach((c, i) => { if (!COLOURS[c]) empty.push(i); });
      if (empty.length) {
        errors.push({ kind: 'empty', text: `${plural(empty.length, 'sticker is', 'stickers are')} not filled in yet.`, stickers: empty });
        return done();
      }
      // colour counts
      const count = Object.fromEntries(COLOUR_KEYS.map((c) => [c, 0]));
      for (const c of colours) count[c]++;
      const wrong = COLOUR_KEYS.filter((c) => count[c] !== expected[c]);
      if (wrong.length) {
        const byWant = new Map();
        for (const c of COLOUR_KEYS) { if (!byWant.has(expected[c])) byWant.set(expected[c], []); byWant.get(expected[c]).push(c); }
        const groups = [...byWant].sort((a, b) => a[1].length - b[1].length);
        const want = groups.length === 1 ? [`${groups[0][0]} of each colour`]
          : groups.slice(0, -1).flatMap(([n, cs]) => cs.map((c) => `${n} ${colourWord(c)}`)).concat(`${groups[groups.length - 1][0]} of each other colour`);
        const have = wrong.map((c) => `${count[c]} ${colourWord(c)}`);
        errors.push({
          kind: 'count',
          text: `There ${count[wrong[0]] === 1 ? 'is' : 'are'} ${list(have)} ${have.length === 1 && count[wrong[0]] === 1 ? 'sticker' : 'stickers'}, but a ${opts.name} has ${list(want)} (one face's worth).`,
          stickers: colours.map((c, i) => (count[c] > expected[c] ? i : -1)).filter((i) => i >= 0),
          over: wrong.filter((c) => count[c] > expected[c]), under: wrong.filter((c) => count[c] < expected[c]),
        });
      }
      const r = read(colours);
      if (r.valid.length && !wrong.length) {
        res.ok = true;
        res.solved = puzzle.isSolved(colours);
        return done();
      }
      // explain with the best way of holding it
      const h = r.best;
      const name = (piece) => slots[piece].faces.map((f) => colourWord(h.colourOf[f])).join('-');
      for (const sl of slots) {
        const a = h.at[sl.index];
        if (a.piece >= 0) continue;
        const cols = sl.stickers.map((i) => colours[i]);
        const has = list(cols.map(colourWord));
        const where = sl.kind === 'centre' ? `The ${FACE_WORD[sl.faces[0]]} centre` : `The ${sl.place} ${sl.kind}`;
        let text;
        if (sl.kind === 'centre') {
          text = `${where} is ${colourWord(cols[0])}. ${opts.notes.centre}`;
        } else if (a.why === 'repeat') {
          const twice = cols.find((c, k) => cols.indexOf(c) !== k);
          text = `${where} has two ${colourWord(twice)} stickers (${has}). No piece has that.`;
        } else if (a.why === 'opposite') {
          text = `${where} has ${colourWord(cols[a.pair[0]])} and ${colourWord(cols[a.pair[1]])} together${cols.length > 2 ? ` (${has})` : ''}, but those are opposite colours: no piece has both.`;
        } else if (a.why === 'nopiece') {
          text = `${where} has ${has}: no piece of the ${opts.name} has those colours together.`;
        } else if (a.why === 'flip') {
          text = `${where} (${has}) is flipped: its two colours are the wrong way round. ${opts.notes.flip}`;
        } else if (a.why === 'twist') {
          text = `${where} (${has}) is twisted in place. ${opts.notes.twist}`;
        } else if (a.why === 'mirror') {
          text = `${where} (${has}) has its colours the wrong way round, like a mirror image: two of its stickers are probably swapped.`;
        } else {
          text = `The ${name(a.real)} ${slots[a.real].kind} can never get to the ${sl.place} place: check its colours.`;
        }
        errors.push({ kind: 'piece', text, stickers: sl.stickers.slice() });
      }
      // the same piece twice (so another one is missing)
      const where = new Map();
      h.at.forEach((a, si) => { if (a.piece >= 0) { if (!where.has(a.piece)) where.set(a.piece, []); where.get(a.piece).push(si); } });
      let dups = false;
      for (const [piece, at] of where) {
        if (at.length < 2) continue;
        dups = true;
        const sl = slots[piece];
        const pname = sl.kind === 'centre' ? `${colourWord(h.colourOf[sl.faces[0]])} centre` : `${name(piece)} ${sl.kind}`;
        const places = at.map((si) => (slots[si].kind === 'centre' ? `the ${FACE_WORD[slots[si].faces[0]]}` : `the ${slots[si].place}`));
        errors.push({ kind: 'duplicate', text: `The ${pname} is there ${at.length === 2 ? 'twice' : at.length + ' times'}: at ${list(places)}.`, stickers: at.flatMap((si) => slots[si].stickers) });
      }
      if (dups) {
        const missing = slots.filter((sl) => !where.has(sl.index));
        if (missing.length) {
          const words = missing.map((sl) => (sl.kind === 'centre' ? `the ${colourWord(h.colourOf[sl.faces[0]])} centre` : `the ${name(sl.index)} ${sl.kind}`));
          errors.push({ kind: 'missing', text: `So ${missing.length === 1 ? 'this piece is' : 'these pieces are'} missing: ${list(words)}.`, stickers: [] });
        }
      }
      if (!errors.length) {
        // cannot happen on these puzzles (every arrangement of the pieces can be reached), but never pass it on unchecked
        errors.push({ kind: 'parity', text: `This ${opts.name} can't get like this by turning: check where each piece is.`, stickers: [] });
      }
      return done();
    }

    const def = {
      id: opts.id, name: opts.name, short: opts.short, puzzle, validate,
      scrambleLength: opts.scrambleLength,
      scan: { experimental: false, faces: ['F', 'R', 'B', 'L', 'U', 'D'].map((f) => ({ face: f, say: opts.scanSay[f] })) },
      holdHelp: opts.holdHelp,
      notationHelp: opts.notationHelp,
      // for the solvers and the tests
      kit: { slots, moves, read, holds, expected, faceSize, standardScheme: STANDARD, build },
    };
    return def;
  }

  return { makeCuboid, COLOURS, STANDARD };
}));
