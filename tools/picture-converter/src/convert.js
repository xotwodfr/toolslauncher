'use strict';
// Electron-free image conversion core (so it can be tested with plain Node).
let fs;
try { fs = require('original-fs'); } catch { fs = require('fs'); } // inside Electron plain `fs` treats *.asar as folders
const path = require('path');
const sharp = require('sharp');
const { FORMATS, OPTIONS, keepsAlpha } = require('./formats');
const qoi = require('./codecs/qoi');
const bmp = require('./codecs/bmp');
const tga = require('./codecs/tga');
const pnm = require('./codecs/pnm');
const ico = require('./codecs/ico');
const pdf = require('./codecs/pdf');
const jxl = require('./codecs/jxl');

sharp.cache(false); // don't keep input files locked (matters on Windows)

const MAX_PIXELS = 100e6;          // refuse to decode anything bigger than this with our own (JS) decoders
const MAX_INPUT_BYTES = 512 * 1024 * 1024;

// what sharp/libvips reads natively, and what our own decoders add
const SHARP_INPUT = new Set(['.jpg', '.jpeg', '.jpe', '.jfif', '.png', '.webp', '.avif', '.heic', '.heif', '.gif', '.tif', '.tiff', '.svg']);
const CUSTOM_INPUT = { '.bmp': bmp, '.dib': bmp, '.ico': ico, '.cur': ico, '.tga': tga, '.qoi': qoi, '.ppm': pnm, '.pgm': pnm, '.pbm': pnm, '.pnm': pnm, '.pam': pnm, '.jxl': jxl };
const INPUT_EXTS = [...SHARP_INPUT, ...Object.keys(CUSTOM_INPUT)];

const extOf = (f) => path.extname(f).toLowerCase();
const isSupportedInput = (file) => INPUT_EXTS.includes(extOf(file));

function clampInt(v, min, max, dflt) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt;
}
const bool = (v, dflt) => (typeof v === 'boolean' ? v : dflt);
const pick = (v, choices, dflt) => (choices.includes(v) ? v : dflt);

/** Validate/normalise options coming from the (untrusted) renderer. Unknown values fall back to defaults. */
function normalizeOptions(o = {}) {
  if (!FORMATS[o.format]) throw new Error(`Unsupported output format: ${o.format}`);
  // Empty / 0 / invalid means "unset" - must be checked before clamping (which would turn 0 into 1).
  const dim = (v) => (v === '' || v == null || !(Number(v) > 0) ? null : clampInt(v, 1, 20000, null));
  const resize = o.resize && o.resize.enabled ? { width: dim(o.resize.width), height: dim(o.resize.height) } : null;
  const sizes = Array.isArray(o.icoSizes) ? OPTIONS.icoSizes.choices.filter((s) => o.icoSizes.map(Number).includes(s)) : [];
  return {
    format: o.format,
    quality: clampInt(o.quality, 1, 100, OPTIONS.quality.default),
    lossless: bool(o.lossless, OPTIONS.lossless.default),
    progressive: bool(o.progressive, OPTIONS.progressive.default),
    palette: bool(o.palette, OPTIONS.palette.default),
    colors: pick(Number(o.colors), OPTIONS.colors.choices, OPTIONS.colors.default),
    tiffCompression: pick(o.tiffCompression, OPTIONS.tiffCompression.choices, OPTIONS.tiffCompression.default),
    pdfMode: pick(o.pdfMode, OPTIONS.pdfMode.choices, OPTIONS.pdfMode.default),
    icoSizes: sizes.length ? sizes : OPTIONS.icoSizes.default,
    rle: bool(o.rle, OPTIONS.rle.default),
    bmpAlpha: bool(o.bmpAlpha, OPTIONS.bmpAlpha.default),
    background: typeof o.background === 'string' && /^#[0-9a-f]{6}$/i.test(o.background) ? o.background.toLowerCase() : OPTIONS.background.default,
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

const hexToRgb = (h) => ({ r: parseInt(h.slice(1, 3), 16), g: parseInt(h.slice(3, 5), 16), b: parseInt(h.slice(5, 7), 16) });

/** Open any supported input as a sharp pipeline (our own decoders feed it raw RGBA). */
async function openImage(file) {
  const ext = extOf(file);
  if (SHARP_INPUT.has(ext)) return sharp(file, { failOn: 'error' });
  const codec = CUSTOM_INPUT[ext];
  if ((await fs.promises.stat(file)).size > MAX_INPUT_BYTES) throw new Error('File is too large');
  const buf = await fs.promises.readFile(file);
  let img;
  if (codec === jxl) img = await jxl.decode(buf, MAX_PIXELS);
  else if (codec === ico) { img = ico.decode(buf, MAX_PIXELS); if (img.png) return sharp(img.png); }
  else img = codec.decode(buf, MAX_PIXELS);
  return sharp(img.data, { raw: { width: img.width, height: img.height, channels: 4 } });
}

async function convertOne(input, rawOpts) {
  const opts = normalizeOptions(rawOpts);
  if (!isSupportedInput(input)) throw new Error('Unsupported file type');
  const fmt = FORMATS[opts.format];

  let img = (await openImage(input)).rotate(); // honour EXIF orientation
  if (opts.resize) {
    img = img.resize({ width: opts.resize.width || undefined, height: opts.resize.height || undefined, fit: 'inside', withoutEnlargement: true });
  }
  if (!keepsAlpha(opts)) img = img.flatten({ background: hexToRgb(opts.background) });

  const outDir = opts.outDir || path.dirname(input);
  await fs.promises.mkdir(outDir, { recursive: true });
  const output = uniquePath(outDir, path.basename(input, path.extname(input)), fmt.ext);

  let width, height, outBytes;
  const sharpFormat = { jpeg: 1, png: 1, webp: 1, gif: 1, avif: 1, tiff: 1 }[opts.format];
  if (sharpFormat) {
    if (opts.keepMetadata) img = img.withMetadata();
    switch (opts.format) {
      // the mozjpeg preset always writes progressive files, so it is only used when progressive output is wanted
      case 'jpeg': img = img.toColourspace('srgb').jpeg({ quality: opts.quality, mozjpeg: opts.progressive, progressive: opts.progressive }); break;
      case 'png': img = img.png({ compressionLevel: 9, palette: opts.palette, quality: opts.quality, colours: opts.colors }); break;
      case 'webp': img = img.webp({ quality: opts.quality, lossless: opts.lossless, effort: 4 }); break;
      case 'gif': img = img.gif({ colours: opts.colors, effort: 7 }); break;
      case 'avif': img = img.avif({ quality: opts.quality, lossless: opts.lossless, effort: 4 }); break;
      case 'tiff': img = img.tiff({ compression: opts.tiffCompression, quality: opts.quality, predictor: 'horizontal' }); break;
    }
    const info = await img.toFile(output);
    ({ width, height, size: outBytes } = info);
  } else {
    let bytes;
    if (opts.format === 'ico') {
      const entries = [];
      for (const size of opts.icoSizes) {
        const png = await img.clone().resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();
        entries.push({ size, png });
      }
      bytes = ico.encode(entries);
      width = height = Math.max(...opts.icoSizes);
    } else if (opts.format === 'pdf' && opts.pdfMode === 'jpeg') {
      const { data, info } = await img.toColourspace('srgb').removeAlpha().jpeg({ quality: opts.quality, mozjpeg: true }).toBuffer({ resolveWithObject: true });
      bytes = pdf.encode({ width: info.width, height: info.height, jpeg: data });
      ({ width, height } = info);
    } else {
      const { data, info } = await img.toColourspace('srgb').ensureAlpha().raw().toBuffer({ resolveWithObject: true }); // 8-bit RGBA
      ({ width, height } = info);
      switch (opts.format) {
        case 'bmp': bytes = bmp.encode(data, width, height, { alpha: opts.bmpAlpha }); break;
        case 'tga': bytes = tga.encode(data, width, height, { rle: opts.rle }); break;
        case 'qoi': bytes = qoi.encode(data, width, height); break;
        case 'ppm': bytes = pnm.encodePpm(data, width, height); break;
        case 'pgm': bytes = pnm.encodePgm(data, width, height); break;
        case 'jxl': bytes = await jxl.encode(data, width, height, { quality: opts.quality, lossless: opts.lossless, effort: 4 }); break;
        case 'pdf': { // lossless: RGB + (only if the image is actually transparent) a soft mask
          const rgb = Buffer.alloc(width * height * 3), alpha = Buffer.alloc(width * height);
          let translucent = false;
          for (let i = 0; i < width * height; i++) {
            rgb[i * 3] = data[i * 4]; rgb[i * 3 + 1] = data[i * 4 + 1]; rgb[i * 3 + 2] = data[i * 4 + 2];
            alpha[i] = data[i * 4 + 3]; if (alpha[i] !== 255) translucent = true;
          }
          bytes = pdf.encode({ width, height, rgb, alpha: translucent ? alpha : null });
          break;
        }
        default: throw new Error(`No encoder for ${opts.format}`);
      }
    }
    await fs.promises.writeFile(output, bytes, { flag: 'wx' }); // 'wx': never overwrite, even in a race
    outBytes = bytes.length;
  }
  const inBytes = (await fs.promises.stat(input)).size;
  return { input, output, width, height, inBytes, outBytes };
}

module.exports = { convertOne, normalizeOptions, uniquePath, isSupportedInput, INPUT_EXTS, FORMATS };
