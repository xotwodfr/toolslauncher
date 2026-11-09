'use strict';
// Pure helpers shared by the main process, the tests and the window (loaded with <script> there): how a picture is turned into
// the model's input, how its answer becomes an alpha mask, the edge control, sizes, file names and file-type checks.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Plan = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  const SIZE = 1024;                       // the model looks at the whole picture squeezed to 1024 x 1024
  const MAX_PIXELS = 50e6;                 // larger pictures are refused (the cutout is built at full size in memory)
  const WORK_MAX = 3000;                   // the live preview works on at most this many pixels along the long side
  const MAX_FILE_BYTES = 120 * 1024 * 1024;
  const IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.gif', '.avif'];

  class UserError extends Error {}

  const extOf = (f) => { const m = /\.[^.\\/]+$/.exec(String(f)); return m ? m[0].toLowerCase() : ''; };
  const isImage = (f) => IMAGE_EXTS.includes(extOf(f));
  const baseName = (f) => String(f).replace(/^.*[\\/]/, '');

  const FORMATS = {
    png: { label: 'PNG (keeps transparency)', ext: '.png', mime: 'image/png', alpha: true },
    webp: { label: 'WebP (keeps transparency, smaller)', ext: '.webp', mime: 'image/webp', alpha: true, quality: 0.92 },
    jpeg: { label: 'JPEG (needs a background)', ext: '.jpg', mime: 'image/jpeg', alpha: false, quality: 0.92 },
  };

  /** Which kind of image these bytes really are, whatever the file is called. */
  function sniff(bytes) {
    const b = bytes;
    if (!b || b.length < 12) return null;
    if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'png';
    if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
    if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'webp';
    return null;
  }

  /** "holiday photo.jpg" -> "holiday photo-cutout.png" */
  function defaultName(name, format) {
    const f = FORMATS[format] || FORMATS.png;
    const stem = baseName(name).replace(/\.[^.]*$/, '') || 'picture';
    return `${stem}-cutout${f.ext}`;
  }

  /**
   * The model's input from a SIZE x SIZE RGBA picture: channels first, scaled to 0..1 then shifted by the mean of 0.5 (the
   * preprocessing of the DIS / ISNet code: (x / 255 - 0.5) / 1).
   * @param {Uint8ClampedArray|Uint8Array} rgba length SIZE*SIZE*4
   * @returns {Float32Array} length 3*SIZE*SIZE
   */
  function toTensor(rgba) {
    const n = SIZE * SIZE;
    if (rgba.length !== n * 4) throw new UserError('Unexpected picture size for the model');
    const out = new Float32Array(3 * n);
    for (let i = 0, p = 0; i < n; i++, p += 4) {
      out[i] = rgba[p] / 255 - 0.5;
      out[n + i] = rgba[p + 1] / 255 - 0.5;
      out[2 * n + i] = rgba[p + 2] / 255 - 0.5;
    }
    return out;
  }

  /** Stretch the model's answer so its weakest point is 0 and its strongest is 1 (as the DIS code does). */
  function normaliseMask(raw) {
    let lo = Infinity; let hi = -Infinity;
    for (let i = 0; i < raw.length; i++) { const v = raw[i]; if (v < lo) lo = v; if (v > hi) hi = v; }
    const out = new Float32Array(raw.length);
    const span = hi - lo;
    if (!(span > 1e-4)) return { mask: out, flat: true }; // the model saw no difference between subject and background
    for (let i = 0; i < raw.length; i++) out[i] = (raw[i] - lo) / span;
    return { mask: out, flat: false };
  }

  /** The edge slider (-100 tighter .. +100 looser) as a power curve: 0 changes nothing; the mask's 0 and 1 stay put. */
  const edgeGamma = (v) => 2 ** (-Number(v) / 50);

  /** The working size of the live preview for a picture of w x h. */
  function workSize(w, h) {
    const k = Math.min(1, WORK_MAX / Math.max(w, h));
    return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)), k };
  }

  /** Scale and offset that fit a w x h picture inside a vw x vh window with `pad` pixels around it. */
  function fitView(w, h, vw, vh, pad = 20) {
    const s = Math.max(0.01, Math.min((vw - 2 * pad) / w, (vh - 2 * pad) / h));
    return { s, ox: (vw - w * s) / 2, oy: (vh - h * s) / 2 };
  }

  /** The part of a sw x sh picture that fills a dw x dh box when scaled to cover it (a "fill" fit). */
  function coverRect(sw, sh, dw, dh) {
    const k = Math.max(dw / sw, dh / sh);
    const cw = dw / k; const ch = dh / k;
    return { sx: (sw - cw) / 2, sy: (sh - ch) / 2, sw: cw, sh: ch };
  }

  /** Blur radius in pixels for the blurred-background option: the slider is 0..100, the radius scales with the picture. */
  const blurPixels = (value, longSide) => (Number(value) / 100) * 0.06 * longSide;

  const BRUSH = { min: 2, max: 200, def: 36 };
  const clampBrush = (px) => Math.max(BRUSH.min, Math.min(BRUSH.max, Math.round(px)));

  const formatBytes = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

  return {
    SIZE, MAX_PIXELS, WORK_MAX, MAX_FILE_BYTES, IMAGE_EXTS, UserError, extOf, isImage, baseName, FORMATS, sniff, defaultName,
    toTensor, normaliseMask, edgeGamma, workSize, fitView, coverRect, blurPixels, BRUSH, clampBrush, formatBytes,
  };
}));
