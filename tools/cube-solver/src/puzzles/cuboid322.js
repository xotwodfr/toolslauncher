'use strict';
// The 3x2x2: 3 wide, 2 tall, 2 deep, i.e. the 2x2x3 "tower" lying on its side (it is the same physical puzzle; we hold it
// with the long axis left-right). The left and right ends are 2x2 squares and turn a quarter at a time (R, L). The top,
// bottom, front and back are 3x2 rectangles; turning one of them means turning that half of the puzzle (2 tall / 2 deep),
// which only fits after a half turn (U2, D2, F2, B2). The middle layer (between the two ends) is a 2x2 square too and can
// turn a quarter, but that is the same as R L' (or R' L) and turning the whole puzzle, so the solutions never use it.
// Standard colours: white top, yellow bottom, green front, blue back, red right, orange left.
//
// Pieces: 8 corners (in the two ends) and 4 middle edges (2 stickers each, no centres). With these turns a corner's red or
// orange sticker never leaves the left/right ends and a middle edge never changes which of its stickers is on the top or
// bottom, so pieces cannot be twisted or flipped; but turning the middle layer flips all four middle edges at once (and
// turns them relative to the ends), which is the same as holding the puzzle a quarter turn rotated: so a filling is
// accepted when it is a real position for at least one way of holding it. The corners can be arranged in all 8! ways and
// the edges in all 4! ways independently (R swaps an odd number of corners and no edges, U2 an even number of corners and
// one pair of edges), so 8! x 4! = 967,680 positions, and that is the whole table the solver walks down.
// Unsolvable fillings: impossible pieces (wrong colours, a corner whose red/orange sticker is not on an end, a mirror image),
// one or two middle edges flipped while the others are not, or the same piece twice.
//
// Notation: R, R', R2, L, L', L2 (quarter turns of the square ends, clockwise seen from outside that end), U2, D2, F2, B2.
// Sticker order (32): U (6), R (4), F (6), D (6), L (4), B (6), each row by row as seen from outside: U with the back edge
// at the top, D with the front edge at the top, the sides with the top at the top.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./cuboid-kit'));
  else { const def = factory(root.CuboidKit); (root.Puzzles = root.Puzzles || {})[def.id] = def; }
}(typeof self !== 'undefined' ? self : this, function (Kit) {
  return Kit.makeCuboid({
    id: 'cuboid322',
    name: '3x2x2',
    short: '3x2x2',
    dims: [3, 2, 2],
    scrambleLength: 20,
    notes: {
      centre: '',
      flip: 'On a 3x2x2 the four middle pieces can only flip all together (by turning the middle layer), never one or two on their own: check its colours.',
      twist: "On a 3x2x2 a corner's red or orange sticker always stays on one of the square ends, so a corner can't get twisted by turning: check its colours.",
    },
    scanSay: {
      F: 'Hold the puzzle lying down, 3 wide, with a square end on the left and on the right, and show a long side: that is the front.',
      R: 'Turn the puzzle a quarter to the left: the right end (a 2x2 square), same top.',
      B: 'Another quarter to the left: the back side, same top.',
      L: 'Another quarter: the left end, same top.',
      U: 'Turn back to the front, then tip the top towards you: the top, the back side at the top of the picture.',
      D: 'Now tip it the other way: the bottom, the front side at the top of the picture.',
    },
    holdHelp: 'Hold the 3x2x2 lying down, 3 wide, with a 2x2 square end on the left and on the right (it is the 2x2x3 "tower" '
      + 'on its side). In the standard colours: white top, yellow bottom, green front, blue back, red right end, orange left '
      + 'end. The two ends turn a quarter at a time; the top, bottom, front and back halves only turn half way round.',
    notationHelp: "R turns the right end (the 2x2 square) a quarter clockwise, looking at it from the right; R' anticlockwise, "
      + 'R2 half way round. L is the same for the left end (clockwise looking at it from the left). U2, D2, F2 and B2 turn the '
      + 'top, bottom, front or back half of the puzzle half way round (either direction, it is the same). The middle layer '
      + 'is never turned on its own.',
  });
}));
