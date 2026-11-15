'use strict';
// The puzzle registry: which puzzles the app offers, in picker order, and how they are grouped. Each puzzle is a module
// src/puzzles/<id>.js (geometry, colours, validation, scanning; see puzzle-core.js) with a solver src/solvers/<id>.js that
// runs in a worker thread. A puzzle whose files are missing or fail to load is simply left out, so the app runs whatever
// set of puzzles is present.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PuzzleRegistry = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  const ORDER = ['cube3', 'cube2', 'cube4', 'cube5', 'cuboid332', 'cuboid322', 'pyraminx', 'megaminx'];
  const GROUPS = [
    { name: 'Cubes', ids: ['cube3', 'cube2', 'cube4', 'cube5', 'cuboid332', 'cuboid322'] },
    { name: 'Other puzzles', ids: ['pyraminx', 'megaminx'] },
  ];
  const groupOf = (id) => (GROUPS.find((g) => g.ids.includes(id)) || GROUPS[1]).name;

  /**
   * Node only: loads every puzzle that is present. extra: more puzzles from elsewhere ({ id, puzzlePath, solverPath }, used by
   * the end-to-end test for its own test puzzles). Returns [{ id, def, group, puzzlePath, solverPath }] in picker order;
   * problems (a module that does not load) go to `warn`.
   */
  function loadAll({ extra = [], warn = () => {} } = {}) {
    const fs = require('fs');
    const path = require('path');
    const list = ORDER.map((id) => ({ id, puzzlePath: path.join(__dirname, id + '.js'), solverPath: path.join(__dirname, '..', 'solvers', id + '.js') }))
      .concat(extra.map((x) => ({ group: 'Other puzzles', ...x })));
    const out = [];
    for (const item of list) {
      if (!fs.existsSync(item.puzzlePath) || !fs.existsSync(item.solverPath)) continue;
      try {
        const def = require(item.puzzlePath);
        if (!def || def.id !== item.id || !def.puzzle || typeof def.validate !== 'function') throw new Error('not a puzzle module');
        out.push({ ...item, def, group: item.group || groupOf(item.id) });
      } catch (e) { warn(`${item.id}: ${(e && e.message) || e}`); }
    }
    return out;
  }
  return { ORDER, GROUPS, groupOf, loadAll };
}));
