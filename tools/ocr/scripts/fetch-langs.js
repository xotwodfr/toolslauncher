'use strict';
// Copies the OCR language data into ./langs so it ships inside the app (OCR then works with no internet).
// The data comes from the @tesseract.js-data/<code> packages (dev dependencies): the "best, integer" models, which are the
// accurate ones at a small size. Idempotent.
const fs = require('fs');
const path = require('path');

const LANGS = require('../src/languages').CODES;
const dest = path.join(__dirname, '..', 'langs');
fs.mkdirSync(dest, { recursive: true });
let copied = 0;
for (const code of LANGS) {
  const out = path.join(dest, `${code}.traineddata.gz`);
  if (fs.existsSync(out) && fs.statSync(out).size > 0) continue;
  const src = path.join(__dirname, '..', 'node_modules', '@tesseract.js-data', code, '4.0.0_best_int', `${code}.traineddata.gz`);
  if (!fs.existsSync(src)) { console.error(`Missing language data for "${code}". Run \`npm install\` first.`); process.exit(1); }
  fs.copyFileSync(src, out);
  copied++;
}
console.log(`language data ready in ${dest} (${LANGS.length} languages, ${copied} copied)`);
