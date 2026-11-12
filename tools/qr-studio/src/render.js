'use strict';
// Drawing codes as SVG (the one source for the preview, SVG files, PNG files and the clipboard). Electron-free.
//  QR codes: encoded by the `qrcode` package, drawn here (square, rounded or dot modules, colours, a logo in the middle).
//  Barcodes: bwip-js (offline; text is drawn as outlines, so no fonts are needed).
const QR = require('qrcode');
const bwip = require('bwip-js');
const Codes = require('./codes');

const LEVELS = ['L', 'M', 'Q', 'H'];
const MAX_LOGO_AREA = 0.2;          // the logo (with its clear border) covers at most 20 % of the code
const LOGO_MIN_VERSION = 5;         // small codes have no room between the corner squares for a logo

const hexOk = (c) => /^#[0-9a-f]{6}$/i.test(String(c));
const xmlEsc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const r3 = (n) => Math.round(n * 1000) / 1000;

/** relative luminance and WCAG contrast of two #rrggbb colours */
function luminance(hex) {
  const v = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
}
function contrast(a, b) { const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); }
/** plain-words warnings about colours that may not scan */
function colourWarnings(fg, bg, transparent) {
  const w = [];
  if (!hexOk(fg) || !hexOk(bg)) return ['Colours must be written as #rrggbb.'];
  if (transparent) { if (luminance(fg) > 0.4) w.push('A light code on a see-through background only scans when it is put on something dark, and many scanners cannot read light-on-dark codes.'); return w; }
  const c = contrast(fg, bg);
  if (luminance(fg) > luminance(bg)) w.push('The code is lighter than its background (inverted). Many phone scanners cannot read that; use a dark code on a light background.');
  if (c < 3) w.push(`The contrast is very low (${c.toFixed(1)} : 1). It will probably not scan; aim for at least 4 : 1.`);
  else if (c < 4) w.push(`The contrast is low (${c.toFixed(1)} : 1). Test that it scans before printing.`);
  return w;
}

/**
 * Encode text as a QR matrix.
 * @returns {{ size:number, version:number, level:string, get:(x:number,y:number)=>boolean }}
 */
function qrMatrix(text, { level = 'M', logo = false } = {}) {
  if (typeof text !== 'string' || !text) throw new Error('Nothing to encode');
  const lv = logo ? 'H' : (LEVELS.includes(level) ? level : 'M');
  let q;
  try { q = QR.create(text, { errorCorrectionLevel: lv }); }
  catch (e) { throw new Error(/too big|Too much|amount of data/i.test(e.message) ? 'Too much text for one QR code (about 2,900 letters at most, fewer with a higher error correction level).' : e.message); }
  if (logo && q.version < LOGO_MIN_VERSION) q = QR.create(text, { errorCorrectionLevel: lv, version: LOGO_MIN_VERSION });
  const size = q.modules.size; const data = q.modules.data;
  return { size, version: q.version, level: lv, get: (x, y) => x >= 0 && y >= 0 && x < size && y < size && !!data[y * size + x] };
}

const isFinder = (x, y, n) => (x < 7 && y < 7) || (x >= n - 7 && y < 7) || (x < 7 && y >= n - 7);

/** a rounded rectangle path (r clipped to the box) */
function rrect(x, y, w, h, r) {
  r = Math.max(0, Math.min(r, w / 2, h / 2));
  if (!r) return `M${r3(x)} ${r3(y)}h${r3(w)}v${r3(h)}h${r3(-w)}z`;
  return `M${r3(x + r)} ${r3(y)}h${r3(w - 2 * r)}a${r3(r)} ${r3(r)} 0 0 1 ${r3(r)} ${r3(r)}v${r3(h - 2 * r)}a${r3(r)} ${r3(r)} 0 0 1 ${r3(-r)} ${r3(r)}h${r3(-(w - 2 * r))}a${r3(r)} ${r3(r)} 0 0 1 ${r3(-r)} ${r3(-r)}v${r3(-(h - 2 * r))}a${r3(r)} ${r3(r)} 0 0 1 ${r3(r)} ${r3(-r)}z`;
}
const circle = (cx, cy, r) => `M${r3(cx - r)} ${r3(cy)}a${r3(r)} ${r3(r)} 0 1 0 ${r3(2 * r)} 0a${r3(r)} ${r3(r)} 0 1 0 ${r3(-2 * r)} 0z`;

/**
 * Draw a QR code as SVG.
 * @param {string} text
 * @param {object} o
 * @param {'L'|'M'|'Q'|'H'} [o.level]
 * @param {number} [o.size=512]      width and height in pixels (the SVG scales to anything)
 * @param {number} [o.margin=4]      quiet zone in modules (4 is the standard)
 * @param {string} [o.fg='#000000'] [o.bg='#ffffff'] [o.transparent=false]
 * @param {'square'|'rounded'|'dots'} [o.style='square']
 * @param {{dataUrl:string, width:number, height:number}} [o.logo]
 * @param {number} [o.logoScale=0.2]  share of the code's area the logo box takes (at most 0.2)
 * @returns {{ svg:string, version:number, level:string, modules:number, warnings:string[] }}
 */
function qrSvg(text, o = {}) {
  const logo = o.logo && typeof o.logo.dataUrl === 'string' && /^data:image\/(png|jpeg|webp|gif|svg\+xml);base64,/.test(o.logo.dataUrl) ? o.logo : null;
  const m = qrMatrix(text, { level: o.level, logo: !!logo });
  const n = m.size;
  const margin = Math.max(0, Math.min(20, Math.round(Number.isFinite(o.margin) ? o.margin : 4)));
  const px = Math.max(16, Math.min(20000, Math.round(o.size || 512)));
  const fg = hexOk(o.fg) ? o.fg : '#000000'; const bg = hexOk(o.bg) ? o.bg : '#ffffff';
  const style = ['rounded', 'dots'].includes(o.style) ? o.style : 'square';
  const total = n + 2 * margin;
  // the logo box, in module units, centred; modules under it are left out
  let box = null;
  if (logo) {
    const area = Math.max(0.04, Math.min(MAX_LOGO_AREA, Number(o.logoScale) || 0.2));
    const side = Math.floor(n * Math.sqrt(area));
    const s = side - ((n - side) % 2); // keep it centred on whole modules
    const a = (n - s) / 2;
    box = { x: a, y: a, s };
  }
  const covered = (x, y) => box && x + 1 > box.x && x < box.x + box.s && y + 1 > box.y && y < box.y + box.s;
  let d = '';
  for (let y = 0; y < n; y++) {
    if (style === 'square') {
      // merge runs of dark modules on a row into one rectangle
      let x = 0;
      while (x < n) {
        if (!m.get(x, y) || covered(x, y)) { x++; continue; }
        let e = x; while (e < n && m.get(e, y) && !covered(e, y)) e++;
        d += `M${x + margin} ${y + margin}h${e - x}v1h${x - e}z`;
        x = e;
      }
      continue;
    }
    for (let x = 0; x < n; x++) {
      if (!m.get(x, y) || covered(x, y) || isFinder(x, y, n)) continue;
      d += style === 'dots' ? circle(x + margin + 0.5, y + margin + 0.5, 0.46) : rrect(x + margin + 0.04, y + margin + 0.04, 0.92, 0.92, 0.32);
    }
  }
  let rings = '';
  if (style !== 'square') {
    // the three corner squares stay solid (scanners look for them first), just softened
    const r = style === 'dots' ? 2 : 1.4;
    for (const [fx, fy] of [[0, 0], [n - 7, 0], [0, n - 7]]) {
      const X = fx + margin; const Y = fy + margin;
      rings += rrect(X, Y, 7, 7, r) + rrect(X + 1, Y + 1, 5, 5, Math.max(0, r - 0.8));
      d += style === 'dots' ? circle(X + 3.5, Y + 3.5, 1.5) : rrect(X + 2, Y + 2, 3, 3, 0.8);
    }
  }
  const parts = [`<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" viewBox="0 0 ${total} ${total}" shape-rendering="${style === 'square' ? 'crispEdges' : 'geometricPrecision'}">`];
  if (!o.transparent) parts.push(`<rect width="${total}" height="${total}" fill="${bg}"/>`);
  parts.push(`<path fill="${fg}" d="${d}"/>`);
  if (rings) parts.push(`<path fill="${fg}" fill-rule="evenodd" d="${rings}"/>`); // the rings alone: evenodd makes the holes
  if (box) {
    const pad = 0.15; // a little space inside the cleared box
    const bx = box.x + margin; const by = box.y + margin;
    if (!o.transparent) parts.push(`<rect x="${r3(bx)}" y="${r3(by)}" width="${box.s}" height="${box.s}" rx="${r3(box.s * 0.12)}" fill="${bg}"/>`);
    parts.push(`<image x="${r3(bx + pad * 2)}" y="${r3(by + pad * 2)}" width="${r3(box.s - pad * 4)}" height="${r3(box.s - pad * 4)}" preserveAspectRatio="xMidYMid meet" href="${xmlEsc(logo.dataUrl)}"/>`);
  }
  parts.push('</svg>');
  const warnings = colourWarnings(fg, bg, !!o.transparent);
  if (margin < 2) warnings.push('A margin smaller than 2 modules can stop the code from scanning, especially on a busy background.');
  if (style === 'dots' && (m.level === 'L')) warnings.push('Dot modules scan better with error correction M or higher.');
  return { svg: parts.join(''), version: m.version, level: m.level, modules: n, warnings, logoBox: box };
}

/**
 * Draw a barcode as SVG with bwip-js.
 * @param {string} kind  a key of Codes.SYMBOLOGIES
 * @param {string} input what the user typed
 * @param {object} o  { showText=true, height (mm, default 15 / 22 for EAN/UPC), fg, bg, check (Code 39 / ITF), transparent }
 * @returns {{ svg:string, text:string, encoded:string, note?:string, warnings:string[] }}
 */
function barcodeSvg(kind, input, o = {}) {
  const prep = Codes.prepare(kind, input, { check: !!o.check });
  if (!prep.ok) throw Object.assign(new Error(prep.error), { userError: true });
  const sym = Codes.SYMBOLOGIES[kind];
  const fg = hexOk(o.fg) ? o.fg : '#000000'; const bg = hexOk(o.bg) ? o.bg : '#ffffff';
  const retail = ['ean13', 'ean8', 'upca'].includes(kind);
  const opts = {
    bcid: sym.bcid, text: prep.text, scale: 3, height: Number(o.height) > 4 && Number(o.height) < 80 ? Number(o.height) : (retail ? 22 : 15),
    includetext: o.showText !== false, textxalign: 'center', barcolor: fg.slice(1), textcolor: fg.slice(1),
    paddingwidth: retail ? 6 : 10, paddingheight: 4,
  };
  if (!o.transparent) opts.backgroundcolor = bg.slice(1);
  if (kind === 'code39' && o.check) { opts.includecheck = true; opts.includecheckintext = true; }
  if (kind === 'itf') { opts.paddingwidth = 14; }
  let svg;
  try { svg = bwip.toSVG(opts); } catch (e) { throw Object.assign(new Error('This cannot be made into a ' + sym.name + ' barcode: ' + String(e.message || e).replace(/^bwipp\.\w+#\d+: /, '')), { userError: true }); }
  // bwip-js gives a viewBox only: add a pixel size so it rasterises predictably
  const vb = /viewBox="0 0 ([\d.]+) ([\d.]+)"/.exec(svg);
  if (vb) svg = svg.replace('<svg ', `<svg width="${vb[1]}" height="${vb[2]}" `);
  const encoded = prep.text + (kind === 'code39' && prep.check ? prep.check : '');
  return { svg, text: prep.text, encoded, note: prep.note, warnings: colourWarnings(fg, bg, !!o.transparent), width: vb ? Number(vb[1]) : 0, height: vb ? Number(vb[2]) : 0 };
}

module.exports = { qrMatrix, qrSvg, barcodeSvg, colourWarnings, contrast, luminance, MAX_LOGO_AREA, LEVELS };
