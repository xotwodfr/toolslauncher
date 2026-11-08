'use strict';
// WCAG 2.x contrast check for the launcher's colour tokens. Reads the real values from src/renderer/styles.css, so a
// colour change that makes text or controls hard to read fails `npm test`.
//   normal text: 4.5:1    large text / UI components: 3:1
const fs = require('fs');
const path = require('path');

const css = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'styles.css'), 'utf8');
const root = /:root\s*\{([\s\S]*?)\n\}/.exec(css)[1];
const tok = {};
for (const m of root.matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{6})\b/g)) tok[m[1]] = m[2];
const need = (name) => { if (!tok[name]) throw new Error(`token --${name} not found in styles.css`); return tok[name]; };

const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const over = (fg, a, bg) => fg.map((c, i) => Math.round(c * a + bg[i] * (1 - a)));     // fg at alpha a, over bg
const mix = (a, pa, b) => a.map((c, i) => Math.round(c * pa + b[i] * (1 - pa)));       // color-mix(a pa%, b)
const lin = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const lum = (c) => 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

const C = (n) => rgb(need(n));
const black = [0, 0, 0], white = [255, 255, 255];
const cardPill = over(rgb('#0a0c13'), 0.6, C('surface'));          // translucent pill background over a card
const pairs = [
  ['body text on page', C('text'), C('bg'), 4.5],
  ['body text on card', C('text'), C('surface'), 4.5],
  ['secondary text on card', C('text-2'), C('surface'), 4.5],
  ['muted text on card', C('muted'), C('surface'), 4.5],
  ['muted text on page', C('muted'), C('bg'), 4.5],
  ['muted text on input background', C('muted'), C('bg-raised'), 4.5],
  ['muted text on hovered surface', C('muted'), C('surface-2'), 4.5],
  ['inactive nav text on sidebar', C('text-2'), C('bg-raised'), 4.5],
  ['white on primary button (start)', white, C('btn-a'), 4.5],
  ['white on primary button (end)', white, C('btn-b'), 4.5],
  ['Launch text on green button', rgb('#04271a'), mix(C('ok'), 0.88, black), 4.5],
  ['Remove text on red button', rgb('#2a0707'), mix(C('err'), 0.85, black), 4.5],
  ['"Installed" pill', C('ok'), mix(C('ok'), 0.1, cardPill), 4.5],
  ['"Update available" pill', C('warn'), mix(C('warn'), 0.12, cardPill), 4.5],
  ['update version text on card', C('warn'), C('surface'), 4.5],
  ['hero text on its glow', C('text-2'), over(C('accent'), 0.28, C('surface')), 4.5],
  ['offline notice text', rgb('#f6d9a3'), mix(C('warn'), 0.11, C('surface')), 4.5],
  ['link on card', C('info'), C('surface'), 4.5],
  ['toast text', C('text'), C('surface-3'), 4.5],
  ['success message on card', C('ok'), C('surface'), 4.5],
  ['error message on card', C('err'), C('surface'), 4.5],
  ['focus ring on card', rgb('#b8a6ff'), C('surface'), 3],
  ['control outline (inputs, switch) on card', C('control-edge'), C('surface'), 3],
];

let failed = 0;
for (const [name, fg, bg, min] of pairs) {
  const r = ratio(fg, bg);
  const ok = r >= min;
  if (!ok) failed++;
  if (!ok || process.argv.includes('--verbose')) console.log(`${ok ? '  ok ' : 'FAIL'} ${r.toFixed(2).padStart(5)}:1 (needs ${min})  ${name}`);
}
if (failed) { console.error(`\n${failed} colour pair(s) are below WCAG AA`); process.exit(1); }
console.log(`  ok  ${pairs.length} colour pairs meet WCAG AA`);
