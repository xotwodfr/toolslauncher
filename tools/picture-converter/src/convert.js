'use strict';
// Electron-free image conversion core (so it can be tested with plain Node).
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

sharp.cache(false); // don't keep input files locked (matters on Windows)

const INPUT_EXTS = ['.jpg', '.jpeg', '.png', '.webp', '.avif', '.gif', '.tif', '.tiff', '.svg'];
const FORMATS = {
  png: { ext: '.png' },
  jpeg: { ext: '.jpg' },
  webp: { ext: '.webp' },
  avif: { ext: '.avif' },
};

const isSupportedInput = (file) => INPUT_EXTS.includes(path.extname(file).toLowerCase());

function clampInt(v, min, max, dflt) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt;
}

/** Validate/normalise options coming from the (untrusted) renderer. */
function normalizeOptions(o = {}) {
  if (!FORMATS[o.format]) throw new Error(`Unsupported output format: ${o.format}`);
  // Empty / 0 / invalid means "unset" - must be checked before clamping (which would turn 0 into 1).
  const dim = (v) => (v === '' || v == null || !(Number(v) > 0) ? null : clampInt(v, 1, 20000, null));
  const resize = o.resize && o.resize.enabled ? { width: dim(o.resize.width), height: dim(o.resize.height) } : null;
  return {
    format: o.format,
    quality: clampInt(o.quality, 1, 100, 85),
    resize: resize && (resize.width || resize.height) ? resize : null,
    keepMetadata: !!o.keepMetadata,
    outDir: typeof o.outDir === 'string' && o.outDir ? o.outDir : null, // null = next to the source file
  };
}

/** Pick a path that doesn't exist yet: name.ext, name (1).ext, ... Never overwrites. */
function uniquePath(dir, base, ext) {
  let candidate = path.join(dir, base + ext);
  for (let i = 1; fs.existsSync(candidate); i++) candidate = path.join(dir, `${base} (${i})${ext}`);
  return candidate;
}

async function convertOne(input, rawOpts) {
  const opts = normalizeOptions(rawOpts);
  if (!isSupportedInput(input)) throw new Error('Unsupported file type');
  const outDir = opts.outDir || path.dirname(input);
  await fs.promises.mkdir(outDir, { recursive: true });
  const base = path.basename(input, path.extname(input));
  const output = uniquePath(outDir, base, FORMATS[opts.format].ext);

  let img = sharp(input, { failOn: 'error' }).rotate(); // honour EXIF orientation
  if (opts.resize) {
    img = img.resize({ width: opts.resize.width || undefined, height: opts.resize.height || undefined, fit: 'inside', withoutEnlargement: true });
  }
  if (opts.format === 'jpeg') img = img.flatten({ background: '#ffffff' }); // JPEG has no alpha
  if (opts.keepMetadata) img = img.withMetadata();

  switch (opts.format) {
    case 'png': img = img.png({ compressionLevel: 9 }); break;
    case 'jpeg': img = img.jpeg({ quality: opts.quality, mozjpeg: true }); break;
    case 'webp': img = img.webp({ quality: opts.quality }); break;
    case 'avif': img = img.avif({ quality: opts.quality, effort: 4 }); break;
  }
  const info = await img.toFile(output);
  const inSize = (await fs.promises.stat(input)).size;
  return { input, output, width: info.width, height: info.height, inBytes: inSize, outBytes: info.size };
}

module.exports = { convertOne, normalizeOptions, uniquePath, isSupportedInput, INPUT_EXTS, FORMATS };
