'use strict';
// Electron-free PDF operations (testable with plain Node). Built on pdf-lib (pure JavaScript).
// Rules every operation follows: inputs are never modified, outputs never overwrite an existing file (a numbered name
// is chosen instead), and a file only appears at its final name once it has been completely written.
let fs;
try { fs = require('original-fs'); } catch { fs = require('fs'); }
const path = require('path');
const { PDFDocument, degrees } = require('pdf-lib');

const MAX_INPUT_BYTES = 400 * 1024 * 1024;
const MAX_SPLIT_FILES = 2000;
const PDF_EXTS = ['.pdf'];
const IMAGE_EXTS = ['.jpg', '.jpeg', '.png'];
const PAGE_SIZES = { a4: [595.28, 841.89], letter: [612, 792] }; // PDF points (1/72 inch)

const extOf = (f) => path.extname(f).toLowerCase();
const isPdf = (f) => PDF_EXTS.includes(extOf(f));
const isImage = (f) => IMAGE_EXTS.includes(extOf(f));

class UserError extends Error {}
const fail = (msg) => { throw new UserError(msg); };

// ---- page ranges ----------------------------------------------------------------------------------------------------
/**
 * Parse "1-3, 5, 8-" / "end" / "all" into [{from, to}] (1-based, inclusive, each validated against `count`).
 * `reverse` is allowed ("5-3" = 5,4,3) only when asked, because for delete/rotate it would be meaningless.
 */
function parseSpec(spec, count, { allowReverse = false } = {}) {
  if (!Number.isInteger(count) || count < 1) fail('The document has no pages');
  const text = String(spec == null ? '' : spec).trim().toLowerCase();
  if (!text) fail('Enter which pages, for example 1-3, 5, 8-');
  if (text === 'all') return [{ from: 1, to: count }];
  const num = (s, ctx) => {
    s = s.trim();
    if (s === 'end' || s === 'last') return count;
    if (!/^\d+$/.test(s)) fail(`"${ctx}" is not a page number or range`);
    const n = Number(s);
    if (n < 1 || n > count) fail(`Page ${n} does not exist (this document has ${count} page${count === 1 ? '' : 's'})`);
    return n;
  };
  const items = [];
  for (const part of text.split(',')) {
    const p = part.trim();
    if (!p) continue;
    const m = /^([^-]*)-([^-]*)$/.exec(p);
    if (m) {
      const from = m[1].trim() === '' ? 1 : num(m[1], p);
      const to = m[2].trim() === '' ? count : num(m[2], p);
      if (from > to && !allowReverse) fail(`"${p}" goes backwards; write it as ${to}-${from}`);
      items.push({ from, to });
    } else {
      const n = num(p, p);
      items.push({ from: n, to: n });
    }
  }
  if (!items.length) fail('Enter which pages, for example 1-3, 5, 8-');
  return items;
}

/** [{from,to}] -> 0-based page indexes in the order written (duplicates kept: "1,1,2" repeats page 1). */
function indexesOf(items) {
  const out = [];
  for (const { from, to } of items) {
    if (from <= to) for (let i = from; i <= to; i++) out.push(i - 1);
    else for (let i = from; i >= to; i--) out.push(i - 1);
  }
  return out;
}
const labelOf = ({ from, to }) => (from === to ? `${from}` : `${from}-${to}`);

// ---- files ----------------------------------------------------------------------------------------------------------
function uniquePath(dir, base, ext) {
  const safe = base.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 120) || 'output';
  let c = path.join(dir, safe + ext);
  for (let i = 1; fs.existsSync(c); i++) c = path.join(dir, `${safe} (${i})${ext}`);
  return c;
}

async function writeOut(dir, base, bytes) {
  await fs.promises.mkdir(dir, { recursive: true });
  const final = uniquePath(dir, base, '.pdf');
  const part = `${final}.${process.pid}.part`;
  try {
    await fs.promises.writeFile(part, bytes);
    fs.renameSync(part, final);
  } catch (e) {
    fs.rmSync(part, { force: true });
    throw e;
  }
  return final;
}

async function readBounded(file) {
  if (!path.isAbsolute(file)) fail('Input path must be absolute');
  let st;
  try { st = await fs.promises.stat(file); } catch { fail(`Cannot read ${path.basename(file)}`); }
  if (!st.isFile()) fail(`${path.basename(file)} is not a file`);
  if (st.size > MAX_INPUT_BYTES) fail(`${path.basename(file)} is larger than ${MAX_INPUT_BYTES / 1048576} MB, which is too big to process here`);
  return fs.promises.readFile(file);
}

async function loadPdf(file) {
  if (!isPdf(file)) fail(`${path.basename(file)} is not a PDF file`);
  const bytes = await readBounded(file);
  try {
    return await PDFDocument.load(bytes, { updateMetadata: false });
  } catch (e) {
    const msg = String((e && e.message) || e);
    if (/encrypt/i.test(msg) || (e && e.constructor && /Encrypted/.test(e.constructor.name))) {
      fail(`${path.basename(file)} is password-protected. Remove the password in a PDF viewer first`);
    }
    fail(`${path.basename(file)} is not a valid PDF (${msg.slice(0, 120)})`);
  }
}

function newDoc() {
  const doc = PDFDocument.create();
  return doc.then((d) => { d.setProducer('PDF Toolkit'); d.setCreator('PDF Toolkit'); return d; });
}

const checkCancel = (signal) => { if (signal && signal.aborted) throw Object.assign(new Error('Cancelled'), { cancelled: true }); };
const stem = (f) => path.basename(f, path.extname(f));
const dirFor = (opts, input) => (opts && opts.outDir) || path.dirname(input);

// ---- operations -----------------------------------------------------------------------------------------------------
/** How many pages does this PDF have? (used to show the list) */
async function inspect(file) {
  const doc = await loadPdf(file);
  const first = doc.getPageCount() ? doc.getPage(0).getSize() : { width: 0, height: 0 };
  return { pages: doc.getPageCount(), width: Math.round(first.width), height: Math.round(first.height) };
}

/** Merge several PDFs, in the order given, into one. */
async function merge(inputs, opts = {}, hooks = {}) {
  if (!Array.isArray(inputs) || inputs.length < 2) fail('Add at least two PDFs to merge');
  const out = await newDoc();
  let pages = 0;
  for (let i = 0; i < inputs.length; i++) {
    checkCancel(hooks.signal);
    if (hooks.onStep) hooks.onStep(i);
    const src = await loadPdf(inputs[i]);
    const copied = await out.copyPages(src, src.getPageIndices());
    copied.forEach((p) => out.addPage(p));
    pages += copied.length;
  }
  checkCancel(hooks.signal);
  const bytes = await out.save();
  const output = await writeOut(dirFor(opts, inputs[0]), `${stem(inputs[0])}-merged`, bytes);
  return { outputs: [output], pages };
}

/**
 * Split one PDF.   mode "each"   : one file per page
 *                  mode "ranges" : one file per comma-separated range in `spec` ("1-3, 5, 8-")
 *                  mode "every"  : a new file every `every` pages
 */
async function split(input, opts = {}, hooks = {}) {
  const src = await loadPdf(input);
  const n = src.getPageCount();
  let groups; // [{label, indexes}]
  if (opts.mode === 'each') {
    groups = Array.from({ length: n }, (_, i) => ({ label: `page-${i + 1}`, indexes: [i] }));
  } else if (opts.mode === 'every') {
    const k = Math.floor(Number(opts.every));
    if (!(k >= 1)) fail('"Every" must be a number of pages, 1 or more');
    groups = [];
    for (let s = 0; s < n; s += k) {
      const idx = Array.from({ length: Math.min(k, n - s) }, (_, j) => s + j);
      groups.push({ label: idx.length === 1 ? `page-${idx[0] + 1}` : `pages-${idx[0] + 1}-${idx[idx.length - 1] + 1}`, indexes: idx });
    }
  } else if (opts.mode === 'ranges') {
    groups = parseSpec(opts.spec, n).map((it) => ({ label: it.from === it.to ? `page-${it.from}` : `pages-${labelOf(it)}`, indexes: indexesOf([it]) }));
  } else fail(`Unknown split mode: ${opts.mode}`);
  if (groups.length > MAX_SPLIT_FILES) fail(`That would make ${groups.length} files (the limit is ${MAX_SPLIT_FILES}). Use bigger groups`);
  if (groups.length === 1 && groups[0].indexes.length === n) fail('That keeps every page in one file, so there is nothing to split');
  const outputs = [];
  for (let g = 0; g < groups.length; g++) {
    checkCancel(hooks.signal);
    const doc = await newDoc();
    (await doc.copyPages(src, groups[g].indexes)).forEach((p) => doc.addPage(p));
    outputs.push(await writeOut(dirFor(opts, input), `${stem(input)}-${groups[g].label}`, await doc.save()));
    if (hooks.onStep) hooks.onStep(g, groups.length);
  }
  return { outputs, pages: n };
}

/**
 * Page edits on one PDF.  action "extract": keep only the pages in `spec`, in the order written (so "3,1,2" reorders)
 *                         action "delete" : remove the pages in `spec`
 *                         action "rotate" : turn the pages in `spec` by `angle` (90, 180 or 270 clockwise)
 */
async function editPages(input, opts = {}) {
  const src = await loadPdf(input);
  const n = src.getPageCount();
  const action = opts.action;
  if (!['extract', 'delete', 'rotate'].includes(action)) fail(`Unknown page action: ${action}`);
  const items = parseSpec(opts.spec, n, { allowReverse: action === 'extract' });
  const chosen = indexesOf(items);
  let doc;
  let suffix;
  if (action === 'rotate') {
    const angle = Number(opts.angle);
    if (![90, 180, 270].includes(angle)) fail('Choose a rotation of 90, 180 or 270 degrees');
    doc = src; // edited in place so bookmarks, forms and everything else survive
    for (const i of new Set(chosen)) {
      const page = doc.getPage(i);
      page.setRotation(degrees((((page.getRotation().angle + angle) % 360) + 360) % 360));
    }
    doc.setProducer('PDF Toolkit');
    suffix = 'rotated';
  } else if (action === 'extract') {
    doc = await newDoc();
    (await doc.copyPages(src, chosen)).forEach((p) => doc.addPage(p));
    suffix = 'extracted';
  } else {
    const drop = new Set(chosen);
    const keep = src.getPageIndices().filter((i) => !drop.has(i));
    if (!keep.length) fail('That would delete every page');
    doc = await newDoc();
    (await doc.copyPages(src, keep)).forEach((p) => doc.addPage(p));
    suffix = 'pages-deleted';
  }
  const output = await writeOut(dirFor(opts, input), `${stem(input)}-${suffix}`, await doc.save());
  return { outputs: [output], pages: doc.getPageCount() };
}

// ---- images -> PDF --------------------------------------------------------------------------------------------------
/** EXIF orientation (1-8) of a JPEG, 1 when absent or unreadable. Phones store sideways pixels plus this flag. */
function jpegOrientation(buf) {
  try {
    if (buf[0] !== 0xff || buf[1] !== 0xd8) return 1;
    let p = 2;
    while (p + 4 <= buf.length) {
      if (buf[p] !== 0xff) return 1;
      const marker = buf[p + 1];
      if (marker === 0xff) { p++; continue; }
      if (marker === 0xda || marker === 0xd9) return 1;
      const len = buf.readUInt16BE(p + 2);
      if (marker === 0xe1 && buf.toString('latin1', p + 4, p + 10) === 'Exif\0\0') {
        const t = p + 10;
        const little = buf.toString('latin1', t, t + 2) === 'II';
        const u16 = (o) => (little ? buf.readUInt16LE(o) : buf.readUInt16BE(o));
        const u32 = (o) => (little ? buf.readUInt32LE(o) : buf.readUInt32BE(o));
        const ifd = t + u32(t + 4);
        if (ifd + 2 > p + 2 + len) return 1;
        const count = u16(ifd);
        for (let i = 0; i < count; i++) {
          const e = ifd + 2 + i * 12;
          if (e + 12 > buf.length) return 1;
          if (u16(e) === 0x0112) { const v = u16(e + 8); return v >= 1 && v <= 8 ? v : 1; }
        }
        return 1;
      }
      p += 2 + len;
    }
  } catch { /* unreadable EXIF: treat as upright */ }
  return 1;
}
// How far (counter-clockwise, degrees) the pixels must be turned to look upright. Mirrored cases (2,4,5,7) are rare
// and are shown unflipped.
const ORIENT_TO_CCW = { 1: 0, 2: 0, 3: 180, 4: 180, 5: 90, 6: 270, 7: 270, 8: 90 };

/**
 * Put images on pages. pageSize "fit" makes each page exactly the image's size; "a4"/"letter" centres the image on
 * a page (landscape or portrait to suit it) with `margin` points around it. perImage: one PDF per image.
 */
async function imagesToPdf(inputs, opts = {}, hooks = {}) {
  if (!Array.isArray(inputs) || !inputs.length) fail('Add at least one image');
  const pageSize = ['fit', 'a4', 'letter'].includes(opts.pageSize) ? opts.pageSize : 'a4';
  const margin = Math.max(0, Math.min(150, Number.isFinite(Number(opts.margin)) ? Number(opts.margin) : 24));
  const outputs = [];
  let doc = null;
  let pages = 0;
  const flush = async (firstInput) => {
    if (!doc) return;
    const base = opts.perImage ? stem(firstInput) : `${stem(inputs[0])}-images`;
    outputs.push(await writeOut(dirFor(opts, inputs[0]), base, await doc.save()));
    doc = null;
  };
  for (let i = 0; i < inputs.length; i++) {
    checkCancel(hooks.signal);
    if (hooks.onStep) hooks.onStep(i);
    const file = inputs[i];
    if (!isImage(file)) fail(`${path.basename(file)} is not a JPEG or PNG image`);
    const bytes = await readBounded(file);
    if (!doc) { doc = await newDoc(); }
    let img;
    try {
      img = extOf(file) === '.png' ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
    } catch (e) {
      fail(`${path.basename(file)} could not be read as ${extOf(file) === '.png' ? 'a PNG' : 'a JPEG'} image (${String(e.message || e).slice(0, 100)})`);
    }
    const ccw = extOf(file) === '.png' ? 0 : ORIENT_TO_CCW[jpegOrientation(bytes)] || 0;
    const iw = img.width, ih = img.height;
    const dw = ccw === 90 || ccw === 270 ? ih : iw; // size as displayed, after turning
    const dh = ccw === 90 || ccw === 270 ? iw : ih;
    let pw, ph, scale;
    if (pageSize === 'fit') { scale = 0.75; pw = dw * scale; ph = dh * scale; } // 96 dpi pixels -> points
    else {
      const [a, b] = PAGE_SIZES[pageSize];
      [pw, ph] = dw > dh ? [b, a] : [a, b];
      scale = Math.min((pw - 2 * margin) / dw, (ph - 2 * margin) / dh);
      if (!(scale > 0)) fail('The margin is too big for this page size');
    }
    const x0 = (pw - dw * scale) / 2, y0 = (ph - dh * scale) / 2; // lower-left corner of the displayed picture
    const w = iw * scale, h = ih * scale;
    const anchor = { 0: [x0, y0], 90: [x0 + h, y0], 180: [x0 + w, y0 + h], 270: [x0, y0 + w] }[ccw];
    const page = doc.addPage([pw, ph]);
    page.drawImage(img, { x: anchor[0], y: anchor[1], width: w, height: h, rotate: degrees(ccw) });
    pages++;
    if (opts.perImage) await flush(file);
  }
  await flush(inputs[0]);
  return { outputs, pages };
}

module.exports = {
  parseSpec, indexesOf, inspect, merge, split, editPages, imagesToPdf, jpegOrientation, uniquePath,
  isPdf, isImage, PDF_EXTS, IMAGE_EXTS, UserError, MAX_INPUT_BYTES,
};
