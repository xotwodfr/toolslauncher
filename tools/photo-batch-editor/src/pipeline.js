'use strict';
// Applies a recipe to one photo with sharp. The steps run IN THE ORDER OF THE RECIPE: the photo is kept as raw RGBA
// pixels between steps (sharp on its own would reorder operations inside one pipeline). Electron-free.
let fs;
try { fs = require('original-fs'); } catch { fs = require('fs'); }
const path = require('path');
const sharp = require('./sharp-loader');
const exifReader = require('exif-reader');
const R = require('./recipe');

sharp.cache(false); // never keep files open or stale (matters on Windows, and for photos edited elsewhere meanwhile)

const INPUT_EXTS = ['.jpg', '.jpeg', '.jpe', '.jfif', '.png', '.webp', '.avif', '.tif', '.tiff', '.gif']; // no HEIC: sharp's prebuilt libvips has no HEVC decoder
const isPhoto = (f) => INPUT_EXTS.includes(path.extname(f).toLowerCase());
const MAX_PIXELS = 268e6;
const cancelledError = () => Object.assign(new Error('Cancelled'), { cancelled: true });

const open = (input, o = {}) => sharp(input, { failOn: 'none', limitInputPixels: MAX_PIXELS, ...o });
const fromRaw = (img) => sharp(img.data, { raw: { width: img.width, height: img.height, channels: 4 } });
async function toRaw(p) {
  const r = await p.toColourspace('srgb').ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  if (r.info.channels !== 4) throw new Error('Unexpected image layout');
  return { data: r.data, width: r.info.width, height: r.info.height };
}
const hexRgb = (hex) => ({ r: parseInt(hex.slice(1, 3), 16), g: parseInt(hex.slice(3, 5), 16), b: parseInt(hex.slice(5, 7), 16) });
const xml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c])).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');

/** Facts about a photo: size as it will appear (after the camera's orientation), format, date, the EXIF we may keep. */
async function inspect(input) {
  const m = await open(input).metadata();
  const turned = m.orientation >= 5 && m.orientation <= 8;
  let exif = null;
  if (m.exif) { try { exif = exifReader(m.exif); } catch { exif = null; } }
  // exif-reader reads the camera's local time as if it were UTC: take the fields back as local time
  const raw = exif && ((exif.Photo && exif.Photo.DateTimeOriginal) || (exif.Image && exif.Image.DateTime));
  const date = raw instanceof Date && !isNaN(raw) ? new Date(raw.getUTCFullYear(), raw.getUTCMonth(), raw.getUTCDate(), raw.getUTCHours(), raw.getUTCMinutes(), raw.getUTCSeconds()) : null;
  return {
    width: turned ? m.height : m.width, height: turned ? m.width : m.height, storedWidth: m.width, storedHeight: m.height,
    orientation: m.orientation || 1, format: m.format, hasAlpha: !!m.hasAlpha, date,
    copyright: exif && exif.Image && typeof exif.Image.Copyright === 'string' ? exif.Image.Copyright : '',
    artist: exif && exif.Image && typeof exif.Image.Artist === 'string' ? exif.Image.Artist : '',
  };
}

/** The output format for a photo: the chosen one, or (for "keep") the closest of ours to what it was. */
function outputFormat(output, inputFormat) {
  if (output.format !== 'keep') return output.format;
  return { jpeg: 'jpeg', jpg: 'jpeg', png: 'png', webp: 'webp', avif: 'avif', heif: 'avif', gif: 'png', tiff: 'png' }[inputFormat] || 'jpeg';
}
const keepsAlpha = (fmt) => fmt !== 'jpeg';

function gravityXY(position, W, H, w, h, margin) {
  const col = /left$/.test(position) ? 0 : /right$/.test(position) ? 2 : 1;
  const row = /^top/.test(position) ? 0 : /^bottom/.test(position) ? 2 : 1;
  const left = col === 0 ? margin : col === 2 ? W - w - margin : Math.round((W - w) / 2);
  const top = row === 0 ? margin : row === 2 ? H - h - margin : Math.round((H - h) / 2);
  return { left: Math.max(0, Math.min(W - w, Math.round(left))), top: Math.max(0, Math.min(H - h, Math.round(top))) };
}

/** Run one step on raw RGBA pixels. */
async function applyStep(img, s, ctx) {
  const W = img.width; const H = img.height;
  switch (s.type) {
    case 'resize': {
      const box = R.resizeBox(W, H, s);
      if (box.width === W && box.height === H) return img;
      const fit = s.mode === 'exact' && s.fit === 'cover' ? 'cover' : 'fill';
      return toRaw(fromRaw(img).resize(box.width, box.height, { fit, kernel: 'lanczos3' }));
    }
    case 'crop': {
      const box = R.cropBox(W, H, s);
      if (box.width === W && box.height === H) return img;
      const position = s.anchor === 'attention' ? sharp.strategy.attention : s.anchor === 'centre' ? 'centre' : s.anchor;
      return toRaw(fromRaw(img).resize(box.width, box.height, { fit: 'cover', position }));
    }
    case 'rotate': {
      let out = img;
      const a = ((s.angle % 360) + 360) % 360;
      if (a) { const bg = hexRgb(s.background); out = await toRaw(fromRaw(out).rotate(a, { background: { ...bg, alpha: 1 } })); }
      if (s.flipH) out = await toRaw(fromRaw(out).flop());
      if (s.flipV) out = await toRaw(fromRaw(out).flip());
      return out;
    }
    case 'levels': {
      const [lower, upper] = { gentle: [2, 98], normal: [1, 99], strong: [0.3, 99.7] }[s.strength];
      return toRaw(fromRaw(img).normalise({ lower, upper }));
    }
    case 'adjust': {
      let out = img;
      if (s.brightness || s.saturation) out = await toRaw(fromRaw(out).modulate({ brightness: 1 + s.brightness / 100, saturation: Math.max(0, 1 + s.saturation / 100) }));
      if (s.contrast || s.warmth) {
        const a = s.contrast >= 0 ? 1 + s.contrast / 50 : 1 + s.contrast / 125; // +100 -> x3, -100 -> x0.2
        const b = 128 * (1 - a);
        const k = (s.warmth / 100) * 0.18;
        const m = [1 + k, 1 + k / 4, 1 - k];
        out = await toRaw(fromRaw(out).linear([a * m[0], a * m[1], a * m[2], 1], [b * m[0], b * m[1], b * m[2], 0]));
      }
      return out;
    }
    case 'sharpen': return toRaw(fromRaw(img).sharpen({ sigma: { light: 0.6, medium: 1.0, strong: 1.6 }[s.amount] }));
    case 'tone': {
      // the same weights in every row: R = G = B exactly, and the result stays an RGB image like every other step's
      if (s.mode === 'grayscale') return toRaw(fromRaw(img).recomb([[0.299, 0.587, 0.114, 0], [0.299, 0.587, 0.114, 0], [0.299, 0.587, 0.114, 0], [0, 0, 0, 1]]));
      return toRaw(fromRaw(img).recomb([[0.393, 0.769, 0.189, 0], [0.349, 0.686, 0.168, 0], [0.272, 0.534, 0.131, 0], [0, 0, 0, 1]]));
    }
    case 'border': {
      const b = R.borderPx(W, H, s.size);
      if (!b) return img;
      return toRaw(fromRaw(img).extend({ top: b, bottom: b, left: b, right: b, background: { ...hexRgb(s.colour), alpha: 1 } }));
    }
    case 'text': {
      if (!s.text.trim()) return img;
      // the words come as a ready-drawn tile (see textTile), scaled to the size asked and placed like a logo
      const tile = await ctx.text(s);
      const fsPx = Math.max(6, (W * s.size) / 100);
      let k = fsPx / tile.ref;
      k = Math.min(k, W / tile.width, H / tile.height);
      const tw = Math.max(1, Math.round(tile.width * k)); const th = Math.max(1, Math.round(tile.height * k));
      const scaled = await sharp(tile.data, { raw: { width: tile.width, height: tile.height, channels: 4 } })
        .resize(tw, th, { fit: 'fill', kernel: 'lanczos3' }).linear([1, 1, 1, s.opacity / 100], [0, 0, 0, 0]).raw().toBuffer({ resolveWithObject: true });
      const margin = Math.round((Math.min(W, H) * s.margin) / 100);
      const { left, top } = gravityXY(s.position, W, H, scaled.info.width, scaled.info.height, margin);
      return toRaw(fromRaw(img).composite([{ input: scaled.data, raw: { width: scaled.info.width, height: scaled.info.height, channels: 4 }, left, top }]));
    }
    case 'logo': {
      if (!s.file) return img;
      const logo = await ctx.logo(s.file);
      const maxW = Math.max(1, Math.round((W * s.scale) / 100));
      let lw = maxW; let lh = Math.round((logo.height * lw) / logo.width);
      if (lh > H) { lh = H; lw = Math.max(1, Math.round((logo.width * lh) / logo.height)); }
      lw = Math.min(lw, W);
      const scaled = await sharp(logo.data, { raw: { width: logo.width, height: logo.height, channels: 4 } })
        .resize(lw, lh, { fit: 'fill' }).linear([1, 1, 1, s.opacity / 100], [0, 0, 0, 0]).raw().toBuffer({ resolveWithObject: true });
      const margin = Math.round((Math.min(W, H) * s.margin) / 100);
      const { left, top } = gravityXY(s.position, W, H, scaled.info.width, scaled.info.height, margin);
      return toRaw(fromRaw(img).composite([{ input: scaled.data, raw: { width: scaled.info.width, height: scaled.info.height, channels: 4 }, left, top }]));
    }
    case 'corners': {
      const r = Math.round((Math.min(W, H) * s.radius) / 100);
      if (!r) return img;
      // the corners' alpha is computed here (anti-aliased), not drawn with SVG: see the note at textTile
      const out = Buffer.from(img.data);
      for (let y = 0; y < r; y++) {
        for (let x = 0; x < r; x++) {
          const dx = r - x - 0.5; const dy = r - y - 0.5;
          const cover = Math.max(0, Math.min(1, r - Math.sqrt(dx * dx + dy * dy) + 0.5));
          if (cover >= 1) continue;
          for (const [px, py] of [[x, y], [W - 1 - x, y], [x, H - 1 - y], [W - 1 - x, H - 1 - y]]) {
            const i = (py * W + px) * 4 + 3;
            out[i] = Math.round(out[i] * cover);
          }
        }
      }
      return { data: out, width: W, height: H };
    }
    default: return img;
  }
}

/**
 * The watermark words drawn once at a reference size (TEXT_REF px), cropped to the ink, as raw RGBA. In plain Node the
 * drawing is an SVG rendered by sharp. Inside Electron on Linux, sharp must never render SVG or text: the Electron
 * binary links the system's GLib/cairo, and libvips' own copies of them clash with those (GObject errors, then a crash).
 * So the app passes a drawer that uses the window's canvas instead, and nothing else here uses SVG.
 */
const TEXT_REF = 160;
async function svgTextTile(s) {
  const ref = TEXT_REF;
  const w = Math.ceil([...s.text].length * ref * 0.9 + ref); const h = Math.ceil(ref * 2);
  const off = Math.max(1, Math.round(ref / 22));
  const font = `font-family="DejaVu Sans, Segoe UI, Arial, Helvetica, sans-serif" font-size="${ref}" font-weight="${s.bold ? 700 : 400}"`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">` +
    (s.shadow ? `<text x="${ref / 4 + off}" y="${ref * 1.3 + off}" ${font} fill="#000000" fill-opacity="0.45">${xml(s.text)}</text>` : '') +
    `<text x="${ref / 4}" y="${ref * 1.3}" ${font} fill="${s.colour}">${xml(s.text)}</text></svg>`;
  const r = await sharp(Buffer.from(svg)).trim({ threshold: 0 }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data: r.data, width: r.info.width, height: r.info.height, ref };
}
/** Wrap a text drawer with a cache (one drawing per text/colour/weight/shadow per batch). */
function textCache(draw = svgTextTile) {
  const cache = new Map();
  return (s) => {
    const key = JSON.stringify([s.text, s.colour, s.bold, s.shadow]);
    if (!cache.has(key)) { const p = draw(s); cache.set(key, p); p.catch(() => cache.delete(key)); }
    return cache.get(key);
  };
}

/** A cache of watermark logos (decoded once per batch). */
function logoLoader() {
  const cache = new Map();
  return async (file) => {
    if (!cache.has(file)) {
      cache.set(file, (async () => {
        if (!fs.existsSync(file)) throw new Error(`The logo file is missing: ${path.basename(file)}`);
        const r = await open(file).ensureAlpha().toColourspace('srgb').raw().toBuffer({ resolveWithObject: true });
        return { data: r.data, width: r.info.width, height: r.info.height };
      })());
    }
    return cache.get(file);
  };
}

/** Background for formats without transparency: the rounded-corner colour if there is such a step, else white. */
function flattenColour(recipe) {
  const c = recipe.find((s) => s.on && s.type === 'corners');
  return c ? c.background : '#ffffff';
}

/** Load a photo as raw RGBA, turned upright, optionally shrunk so its long side is at most maxSide. */
async function load(input, { autoOrient = true, maxSide = 0 } = {}) {
  let p = open(input);
  if (autoOrient) p = p.rotate();
  if (maxSide) p = p.resize(maxSide, maxSide, { fit: 'inside', withoutEnlargement: true });
  return toRaw(p);
}

async function run(img, recipe, ctx, signal) {
  for (const s of recipe) {
    if (signal && signal.aborted) throw cancelledError();
    if (s.on) img = await applyStep(img, s, ctx);
  }
  return img;
}

function encoder(p, fmt, quality) {
  switch (fmt) {
    case 'jpeg': return p.jpeg({ quality, mozjpeg: true, chromaSubsampling: quality >= 90 ? '4:4:4' : '4:2:0' });
    case 'png': return p.png({ compressionLevel: 9, effort: 7 });
    case 'webp': return p.webp({ quality, effort: 4 });
    case 'avif': return p.avif({ quality: Math.max(1, Math.round(quality * 0.8)), effort: 4 });
    default: throw new Error('Unknown format ' + fmt);
  }
}

const exifDate = (d) => {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}:${pad(d.getMonth() + 1)}:${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};

/**
 * Edit one photo and write it to `outPath` (written as `<outPath>.part`, renamed when complete; never over the input).
 * @returns {Promise<{path:string, width:number, height:number, format:string, bytes:number}>}
 */
async function processFile(input, rawRecipe, rawOutput, { outPath, signal, logo, text, info } = {}) {
  const recipe = R.cleanRecipe(rawRecipe);
  const output = R.cleanOutput(rawOutput);
  if (path.resolve(outPath) === path.resolve(input)) throw new Error('That would replace the original photo');
  const meta = info || await inspect(input);
  const fmt = outputFormat(output, meta.format);
  let img = await load(input, { autoOrient: output.autoOrient });
  img = await run(img, recipe, { logo: logo || logoLoader(), text: text || textCache() }, signal);
  if (!keepsAlpha(fmt)) img = await toRaw(fromRaw(img).flatten({ background: flattenColour(recipe) }));
  if (signal && signal.aborted) throw cancelledError();
  let p;
  if (output.metadata === 'keep') {
    // the original's EXIF/XMP travel along: our pixels are laid over the original (turned upright, so the orientation
    // tag is reset) and libvips copies its metadata - but not its colour profile, since our pixels are sRGB now
    let base = open(input);
    if (output.autoOrient) base = base.rotate();
    p = base.resize(img.width, img.height, { fit: 'fill' })
      .composite([{ input: img.data, raw: { width: img.width, height: img.height, channels: 4 }, blend: 'source' }])
      .toColourspace('srgb').keepExif().keepXmp();
    if (!keepsAlpha(fmt)) p = p.flatten({ background: flattenColour(recipe) });
  } else {
    p = fromRaw(img);
    if (!keepsAlpha(fmt)) p = p.removeAlpha();
    if (output.metadata === 'copyright') {
      const ifd0 = {}; const ifd2 = {};
      if (meta.copyright) ifd0.Copyright = meta.copyright;
      if (meta.artist) ifd0.Artist = meta.artist;
      if (meta.date) { ifd0.DateTime = exifDate(meta.date); ifd2.DateTimeOriginal = exifDate(meta.date); }
      if (Object.keys(ifd0).length) p = p.withExif({ IFD0: ifd0, ...(Object.keys(ifd2).length ? { IFD2: ifd2 } : {}) });
    }
  }
  const part = outPath + '.part';
  try {
    const res = await encoder(p, fmt, output.quality).toFile(part);
    if (signal && signal.aborted) throw cancelledError();
    fs.renameSync(part, outPath);
    return { path: outPath, width: res.width, height: res.height, format: fmt, bytes: res.size };
  } catch (e) {
    try { fs.rmSync(part, { force: true }); } catch { /* ignore */ }
    throw e;
  }
}

/**
 * The preview: the photo shrunk to `box` on its long side, before and after the recipe (pixel sizes in the recipe are
 * scaled with it, so the preview looks like the full-size result). Returns encoded images for the window.
 */
async function preview(input, rawRecipe, rawOutput, { box = 900, logo, text, info } = {}) {
  const recipe = R.cleanRecipe(rawRecipe);
  const output = R.cleanOutput(rawOutput);
  const meta = info || await inspect(input);
  const fmt = outputFormat(output, meta.format);
  const before = await load(input, { autoOrient: output.autoOrient, maxSide: box });
  const fullW = output.autoOrient ? meta.width : meta.storedWidth; const fullH = output.autoOrient ? meta.height : meta.storedHeight;
  const k = before.width / fullW;
  const scaled = recipe.map((s) => (s.type === 'resize' && s.mode !== 'percent' ? { ...s, long: Math.max(1, Math.round(s.long * k)), width: Math.max(1, Math.round(s.width * k)), height: Math.max(1, Math.round(s.height * k)) } : s));
  let after = await run(before, scaled, { logo: logo || logoLoader(), text: text || textCache() });
  if (!keepsAlpha(fmt)) after = await toRaw(fromRaw(after).flatten({ background: flattenColour(recipe) }));
  const enc = async (img, alpha) => {
    const p = fromRaw(img);
    const buf = alpha ? await p.png({ compressionLevel: 3 }).toBuffer() : await p.removeAlpha().jpeg({ quality: 88 }).toBuffer();
    return `data:image/${alpha ? 'png' : 'jpeg'};base64,${buf.toString('base64')}`;
  };
  const anyAlpha = (img) => { for (let i = 3; i < img.data.length; i += 4) if (img.data[i] < 255) return true; return false; };
  const full = R.predictSize(fullW, fullH, recipe);
  return {
    before: await enc(before, anyAlpha(before)), after: await enc(after, keepsAlpha(fmt) && anyAlpha(after)),
    width: full.width, height: full.height, format: fmt, previewWidth: after.width, previewHeight: after.height,
  };
}

/** A small thumbnail for the photo list. */
async function thumbnail(input, size = 96) {
  const buf = await open(input).rotate().resize(size, size, { fit: 'cover' }).flatten({ background: '#17171b' }).jpeg({ quality: 70 }).toBuffer();
  return `data:image/jpeg;base64,${buf.toString('base64')}`;
}

module.exports = { INPUT_EXTS, TEXT_REF, isPhoto, inspect, outputFormat, load, applyStep, run, processFile, preview, thumbnail, logoLoader, textCache, svgTextTile, gravityXY, exifDate };
