'use strict';
// The 3x3x2 "Domino": 3 wide, 2 tall, 3 deep. The top and bottom are 3x3 faces and turn a quarter at a time (U, D); the
// four sides are 3x2 and can only turn half way round (R2, L2, F2, B2). Standard colours: white top, yellow bottom, green
// front, blue back, red right, orange left.
//
// Pieces: 8 corners, 8 edges (4 on top, 4 on the bottom) and the two centres of the 3x3 faces. Because the sides only turn
// half way, a white or yellow sticker never leaves the top or bottom, so no piece can be twisted or flipped; every corner
// and edge can reach every corner / edge place, and every arrangement of them can be reached (U alone swaps an odd number
// of corners AND of edges, R2 an even number of corners but an odd number of edges, so the two parities are independent;
// with both groups being all of S8 that makes the whole group S8 x S8 = 1,625,702,400 positions, up to turning the whole
// puzzle about the vertical axis). So the only unsolvable fillings are impossible pieces (a corner or edge with a white or
// yellow sticker on a side, wrong colours, mirror images), the same piece twice, or wrong centres. The centres turn in place
// with U and D but they are plain colours, so their turn cannot be seen and is ignored. Turning a middle slice (M2 or S2 on a
// real Domino) is the same as R2 L2 (or F2 B2) plus turning the whole puzzle over, so it never makes anything unsolvable.
//
// Notation: U, U', U2, D, D', D2 (quarter turns of the 3x3 faces, clockwise seen from outside that face), R2, L2, F2, B2.
// Sticker order (42): U (9), R (6), F (6), D (9), L (6), B (6), each row by row as seen from outside: U with the back edge
// at the top, D with the front edge at the top, the sides with the top at the top.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./cuboid-kit'));
  else { const def = factory(root.CuboidKit); (root.Puzzles = root.Puzzles || {})[def.id] = def; }
}(typeof self !== 'undefined' ? self : this, function (Kit) {
  const stay = 'On a 3x3x2 the white and yellow stickers always stay on the top and bottom faces';
  return Kit.makeCuboid({
    id: 'cuboid332',
    name: '3x3x2',
    short: '3x3x2',
    dims: [3, 2, 3],
    scrambleLength: 25,
    notes: {
      centre: 'The centres of the two 3x3 faces are white and yellow, one each (they never leave their face).',
      flip: `${stay}, so an edge can't get flipped by turning: check its colours.`,
      twist: `${stay}, so a corner can't get twisted by turning: check its colours.`,
    },
    scanSay: {
      F: 'Hold the puzzle with a 3x3 face on top and show one of the sides: that is the front.',
      R: 'Turn the puzzle a quarter to the left: the right side, the same face still on top.',
      B: 'Another quarter to the left: the back side, same top.',
      L: 'Another quarter: the left side, same top.',
      U: 'Turn back to the front, then tip the top towards you: the top 3x3 face, the back side at the top of the picture.',
      D: 'Now tip it the other way: the bottom 3x3 face, the front side at the top of the picture.',
    },
    holdHelp: 'Hold the 3x3x2 with a 3x3 face on top. In the standard colours the 3x3 faces are white (top) and yellow (bottom), '
      + 'and the sides are green (front), red (right), blue (back) and orange (left). The top and bottom turn a quarter at a '
      + 'time; the four sides only turn half way round.',
    notationHelp: "U turns the top face a quarter clockwise (looking down at it), U' anticlockwise, U2 half way round. D is the "
      + 'same for the bottom face (clockwise as seen from below). R2, L2, F2 and B2 turn the right, left, front or back side '
      + 'half way round (either direction, it is the same). Keep the same face towards you the whole time.',
  });
}));
