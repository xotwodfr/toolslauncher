'use strict';
// The languages that ship with the app (see scripts/fetch-langs.js) and their names.
const NAMES = {
  eng: 'English', swe: 'Swedish', deu: 'German', fra: 'French', spa: 'Spanish', ita: 'Italian',
  por: 'Portuguese', nld: 'Dutch', dan: 'Danish', nor: 'Norwegian', fin: 'Finnish', pol: 'Polish',
};
const CODES = Object.keys(NAMES);
/** Tesseract language code that goes with a browser language such as "sv-SE" (English when unknown). */
const FOR_LOCALE = { en: 'eng', sv: 'swe', de: 'deu', fr: 'fra', es: 'spa', it: 'ita', pt: 'por', nl: 'nld', da: 'dan', nb: 'nor', nn: 'nor', no: 'nor', fi: 'fin', pl: 'pol' };
const forLocale = (loc) => FOR_LOCALE[String(loc || '').toLowerCase().split(/[-_]/)[0]] || 'eng';
module.exports = { NAMES, CODES, forLocale };
