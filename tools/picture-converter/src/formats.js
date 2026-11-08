'use strict';
// Single source of truth for the output formats: names, behaviour, and which options apply to each.
// The UI builds itself from describe(), and convert.js validates untrusted input against the same tables.

/** Every option a format can use. `type` drives both validation and the control the UI shows. */
const OPTIONS = {
  quality:         { type: 'range',  label: 'Quality', min: 1, max: 100, default: 85 },
  lossless:        { type: 'bool',   label: 'Lossless', default: false },
  progressive:     { type: 'bool',   label: 'Progressive (loads in passes)', default: true },
  palette:         { type: 'bool',   label: 'Reduce colours (much smaller files)', default: false },
  // libvips quantises palettes in whole bit depths (8, 4, 2, 1 bits), so only these sizes are real choices
  colors:          { type: 'select', label: 'Colours', choices: [256, 16, 4, 2], labels: { 256: '256', 16: '16', 4: '4', 2: '2 (black and white)' }, default: 256 },
  tiffCompression: { type: 'select', label: 'Compression', choices: ['lzw', 'deflate', 'jpeg', 'none'], labels: { lzw: 'LZW (lossless)', deflate: 'Deflate (lossless)', jpeg: 'JPEG (smaller, lossy)', none: 'None (large)' }, default: 'lzw' },
  pdfMode:         { type: 'select', label: 'Image storage', choices: ['jpeg', 'lossless'], labels: { jpeg: 'JPEG (small)', lossless: 'Lossless (keeps transparency)' }, default: 'jpeg' },
  icoSizes:        { type: 'multi',  label: 'Icon sizes (px)', choices: [16, 24, 32, 48, 64, 128, 256], default: [16, 32, 48, 256] },
  rle:             { type: 'bool',   label: 'Compress (RLE)', default: true },
  bmpAlpha:        { type: 'bool',   label: 'Keep transparency (32-bit)', default: false },
  background:      { type: 'color',  label: 'Background for transparent areas', default: '#ffffff' },
};

// options: a name, or { name, when: { otherOption: value } } to show it only in that state (e.g. quality is
// meaningless for lossless WebP). meta: can carry the original EXIF/ICC metadata over.
const FORMATS = {
  jpeg: { label: 'JPEG',     ext: '.jpg',  group: 'Common',          meta: true,  hint: 'Photos. Small files, no transparency.',
          options: ['quality', 'progressive', 'background'] },
  png:  { label: 'PNG',      ext: '.png',  group: 'Common',          meta: true,  hint: 'Lossless, with transparency.',
          options: ['palette', { name: 'colors', when: { palette: true } }, { name: 'quality', when: { palette: true } }] },
  webp: { label: 'WebP',     ext: '.webp', group: 'Common',          meta: true,  hint: 'Small files, with transparency. Lossy or lossless.',
          options: ['lossless', { name: 'quality', when: { lossless: false } }] },
  gif:  { label: 'GIF',      ext: '.gif',  group: 'Common',          meta: false, hint: 'Up to 256 colours; transparency is on or off. First frame only.',
          options: ['colors'] },
  avif: { label: 'AVIF',     ext: '.avif', group: 'Modern',          meta: true,  hint: 'Very small files. Slower to convert.',
          options: ['lossless', { name: 'quality', when: { lossless: false } }] },
  jxl:  { label: 'JPEG XL',  ext: '.jxl',  group: 'Modern',          meta: false, hint: 'Small, with a lossless mode. Not every app can open it yet.',
          options: ['lossless', { name: 'quality', when: { lossless: false } }] },
  tiff: { label: 'TIFF',     ext: '.tiff', group: 'Print & archive', meta: true,  hint: 'For print and archives. Lossless with LZW or Deflate.',
          options: ['tiffCompression', { name: 'quality', when: { tiffCompression: 'jpeg' } }] },
  pdf:  { label: 'PDF',      ext: '.pdf',  group: 'Print & archive', meta: false, hint: 'One page the size of the image.',
          options: ['pdfMode', { name: 'quality', when: { pdfMode: 'jpeg' } }, { name: 'background', when: { pdfMode: 'jpeg' } }] },
  bmp:  { label: 'BMP',      ext: '.bmp',  group: 'Legacy & other',  meta: false, hint: 'Old Windows bitmap. Large files.',
          options: ['bmpAlpha', { name: 'background', when: { bmpAlpha: false } }] },
  ico:  { label: 'ICO',      ext: '.ico',  group: 'Legacy & other',  meta: false, hint: 'Windows icon with several sizes in one file.',
          options: ['icoSizes'] },
  tga:  { label: 'TGA',      ext: '.tga',  group: 'Legacy & other',  meta: false, hint: 'Game and 3D textures. Keeps transparency.',
          options: ['rle'] },
  qoi:  { label: 'QOI',      ext: '.qoi',  group: 'Legacy & other',  meta: false, hint: 'Simple lossless format with transparency.',
          options: [] },
  ppm:  { label: 'PPM',      ext: '.ppm',  group: 'Legacy & other',  meta: false, hint: 'Plain colour bitmap (Netpbm). No transparency.',
          options: ['background'] },
  pgm:  { label: 'PGM',      ext: '.pgm',  group: 'Legacy & other',  meta: false, hint: 'Black-and-white (greyscale) Netpbm. No transparency.',
          options: ['background'] },
};

/** Whether the output keeps transparency for these (validated) options; otherwise it is flattened onto the background. */
function keepsAlpha(o) {
  switch (o.format) {
    case 'jpeg': case 'ppm': case 'pgm': return false;
    case 'bmp': return !!o.bmpAlpha;
    case 'pdf': return o.pdfMode === 'lossless';
    default: return true;
  }
}

/** Plain-JSON description for the renderer. */
function describe() {
  return {
    formats: Object.entries(FORMATS).map(([id, f]) => ({
      id, ...f, options: f.options.map((o) => (typeof o === 'string' ? { name: o } : o)),
    })),
    options: OPTIONS,
  };
}

module.exports = { FORMATS, OPTIONS, keepsAlpha, describe };
