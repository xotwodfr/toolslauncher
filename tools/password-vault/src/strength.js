'use strict';
// Password strength, estimated by zxcvbn-ts (dictionaries, keyboard patterns, dates, repeats, l33t). Runs offline.
let z = null;
function engine() {
  if (!z) {
    const { zxcvbn, zxcvbnOptions } = require('@zxcvbn-ts/core');
    const common = require('@zxcvbn-ts/language-common');
    const en = require('@zxcvbn-ts/language-en');
    zxcvbnOptions.setOptions({ dictionary: { ...common.dictionary, ...en.dictionary }, graphs: common.adjacencyGraphs, translations: en.translations });
    z = zxcvbn;
  }
  return z;
}

const WORDS = ['Very weak', 'Weak', 'Fair', 'Strong', 'Very strong'];

/** { score 0-4, label, bits (log2 of the estimated guesses), crack (offline fast attack), warning, suggestions } */
function check(pw, userInputs = []) {
  if (typeof pw !== 'string' || !pw) return { score: 0, label: 'Empty', bits: 0, crack: '', warning: '', suggestions: [] };
  const r = engine()(pw.slice(0, 256), userInputs.filter((s) => typeof s === 'string' && s).slice(0, 10));
  return {
    score: r.score, label: WORDS[r.score], bits: Math.round(r.guessesLog10 * Math.log2(10)),
    crack: r.crackTimesDisplay.offlineSlowHashing1e4PerSecond,
    warning: r.feedback.warning || '', suggestions: r.feedback.suggestions || [],
  };
}

module.exports = { check, WORDS };
