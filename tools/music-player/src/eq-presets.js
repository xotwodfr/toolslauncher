'use strict';
// Equalizer band centres and presets. Shared by the settings validator (Node) and the page (<script> tag -> window.EQ).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.EQ = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  const BANDS = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
  const PRESETS = {
    Flat: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    'Bass boost': [6, 5, 4, 2, 0, 0, 0, 0, 0, 0],
    'Treble boost': [0, 0, 0, 0, 0, 1, 2, 4, 5, 6],
    Vocal: [-2, -2, -1, 1, 3, 3, 2, 1, 0, -1],
    Rock: [4, 3, 2, 0, -1, -1, 1, 3, 4, 4],
    Classical: [3, 2, 1, 0, 0, 0, -1, -1, 2, 3],
    Electronic: [5, 4, 1, 0, -2, 2, 1, 3, 4, 5],
    'Late night': [-3, -2, 0, 1, 2, 2, 1, 0, -1, -3],
  };
  return { BANDS, PRESETS };
}));
