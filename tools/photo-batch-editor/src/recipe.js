'use strict';
// The recipe (an ordered list of editing steps) and the output settings: defaults, validation of what the window sends,
// the size a photo will come out at, and the rename pattern. Electron-free, no sharp - so the window can use it too.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Recipe = factory();
}(typeof self !== 'undefined' ? self : this, () => {
  const POSITIONS = ['top-left', 'top', 'top-right', 'left', 'centre', 'right', 'bottom-left', 'bottom', 'bottom-right'];
  const ASPECTS = { '1:1': [1, 1], '4:5': [4, 5], '5:4': [5, 4], '3:2': [3, 2], '2:3': [2, 3], '16:9': [16, 9], '9:16': [9, 16], '4:3': [4, 3] };

  /** Every kind of step, its label and its default settings. */
  const STEPS = {
    resize: { label: 'Resize', defaults: { mode: 'long', long: 2048, width: 1600, height: 1200, fit: 'inside', percent: 50, noUpscale: true } },
    crop: { label: 'Crop to aspect', defaults: { aspect: '4:5', customW: 7, customH: 5, anchor: 'centre', matchOrientation: false } },
    rotate: { label: 'Rotate / flip', defaults: { angle: 0, flipH: false, flipV: false, background: '#ffffff' } },
    levels: { label: 'Auto levels', defaults: { strength: 'normal' } },
    adjust: { label: 'Brightness & colour', defaults: { brightness: 0, contrast: 0, saturation: 0, warmth: 0 } },
    sharpen: { label: 'Sharpen', defaults: { amount: 'medium' } },
    tone: { label: 'Black & white / sepia', defaults: { mode: 'grayscale' } },
    border: { label: 'Border', defaults: { size: 3, colour: '#ffffff' } },
    text: { label: 'Text watermark', defaults: { text: '© Your Name', size: 4, colour: '#ffffff', opacity: 70, position: 'bottom-right', margin: 3, bold: true, shadow: true } },
    logo: { label: 'Logo watermark', defaults: { file: '', scale: 18, opacity: 80, position: 'bottom-right', margin: 3 } },
    corners: { label: 'Rounded corners', defaults: { radius: 6, background: '#ffffff' } },
  };
  const FORMATS = { keep: 'Same as the original', jpeg: 'JPEG', png: 'PNG', webp: 'WebP', avif: 'AVIF' };
  const EXT = { jpeg: 'jpg', png: 'png', webp: 'webp', avif: 'avif' };
  const DEFAULT_OUTPUT = { format: 'keep', quality: 85, metadata: 'copyright', folder: '', pattern: '{name}-edited', autoOrient: true, jobs: 0 };

  const num = (v, min, max, dflt) => { const n = Number(v); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt; };
  const int = (v, min, max, dflt) => Math.round(num(v, min, max, dflt));
  const pick = (v, list, dflt) => (list.includes(v) ? v : dflt);
  const colour = (v, dflt) => (typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v) ? v.toLowerCase() : dflt);
  const bool = (v, dflt) => (typeof v === 'boolean' ? v : dflt);

  /** One step from the (untrusted) window -> a clean step, or null if it is not a step we know. */
  function cleanStep(s) {
    if (!s || typeof s !== 'object' || !STEPS[s.type]) return null;
    const d = STEPS[s.type].defaults;
    const o = { type: s.type, on: bool(s.on, true) };
    switch (s.type) {
      case 'resize': Object.assign(o, { mode: pick(s.mode, ['long', 'exact', 'percent'], d.mode), long: int(s.long, 1, 30000, d.long), width: int(s.width, 1, 30000, d.width), height: int(s.height, 1, 30000, d.height), fit: pick(s.fit, ['inside', 'cover', 'fill'], d.fit), percent: num(s.percent, 1, 400, d.percent), noUpscale: bool(s.noUpscale, d.noUpscale) }); break;
      case 'crop': Object.assign(o, { aspect: pick(s.aspect, [...Object.keys(ASPECTS), 'custom'], d.aspect), customW: num(s.customW, 0.01, 1000, d.customW), customH: num(s.customH, 0.01, 1000, d.customH), anchor: pick(s.anchor, ['centre', 'attention', 'top', 'bottom', 'left', 'right'], d.anchor), matchOrientation: bool(s.matchOrientation, d.matchOrientation) }); break;
      case 'rotate': Object.assign(o, { angle: num(s.angle, -360, 360, d.angle), flipH: bool(s.flipH, false), flipV: bool(s.flipV, false), background: colour(s.background, d.background) }); break;
      case 'levels': Object.assign(o, { strength: pick(s.strength, ['gentle', 'normal', 'strong'], d.strength) }); break;
      case 'adjust': Object.assign(o, { brightness: num(s.brightness, -100, 100, 0), contrast: num(s.contrast, -100, 100, 0), saturation: num(s.saturation, -100, 100, 0), warmth: num(s.warmth, -100, 100, 0) }); break;
      case 'sharpen': Object.assign(o, { amount: pick(s.amount, ['light', 'medium', 'strong'], d.amount) }); break;
      case 'tone': Object.assign(o, { mode: pick(s.mode, ['grayscale', 'sepia'], d.mode) }); break;
      case 'border': Object.assign(o, { size: num(s.size, 0, 50, d.size), colour: colour(s.colour, d.colour) }); break;
      case 'text': Object.assign(o, { text: typeof s.text === 'string' ? s.text.slice(0, 200) : d.text, size: num(s.size, 0.5, 40, d.size), colour: colour(s.colour, d.colour), opacity: num(s.opacity, 0, 100, d.opacity), position: pick(s.position, POSITIONS, d.position), margin: num(s.margin, 0, 40, d.margin), bold: bool(s.bold, d.bold), shadow: bool(s.shadow, d.shadow) }); break;
      case 'logo': Object.assign(o, { file: typeof s.file === 'string' ? s.file.slice(0, 4096) : '', scale: num(s.scale, 1, 100, d.scale), opacity: num(s.opacity, 0, 100, d.opacity), position: pick(s.position, POSITIONS, d.position), margin: num(s.margin, 0, 40, d.margin) }); break;
      case 'corners': Object.assign(o, { radius: num(s.radius, 0, 50, d.radius), background: colour(s.background, d.background) }); break;
      default: return null;
    }
    return o;
  }
  const cleanRecipe = (r) => (Array.isArray(r) ? r.slice(0, 50).map(cleanStep).filter(Boolean) : []);

  function cleanOutput(o) {
    o = o && typeof o === 'object' ? o : {};
    return {
      format: pick(o.format, Object.keys(FORMATS), DEFAULT_OUTPUT.format),
      quality: int(o.quality, 1, 100, DEFAULT_OUTPUT.quality),
      metadata: pick(o.metadata, ['strip', 'copyright', 'keep'], DEFAULT_OUTPUT.metadata),
      folder: typeof o.folder === 'string' ? o.folder.slice(0, 4096) : '',
      pattern: typeof o.pattern === 'string' && o.pattern.trim() ? o.pattern.slice(0, 200) : DEFAULT_OUTPUT.pattern,
      autoOrient: bool(o.autoOrient, true),
      jobs: int(o.jobs, 0, 16, 0),
    };
  }

  /** Width / height of the crop box for an aspect on a w x h photo (as big as fits). */
  function cropBox(w, h, step) {
    let [aw, ah] = step.aspect === 'custom' ? [step.customW, step.customH] : ASPECTS[step.aspect];
    if (step.matchOrientation && (h > w) !== (ah > aw) && aw !== ah) [aw, ah] = [ah, aw];
    let cw = w; let ch = Math.round((w * ah) / aw);
    if (ch > h) { ch = h; cw = Math.round((h * aw) / ah); }
    return { width: Math.max(1, Math.min(w, cw)), height: Math.max(1, Math.min(h, ch)) };
  }

  /** The size after a resize step. */
  function resizeBox(w, h, s) {
    let tw; let th;
    if (s.mode === 'percent') { tw = Math.round((w * s.percent) / 100); th = Math.round((h * s.percent) / 100); }
    else if (s.mode === 'long') { const k = s.long / Math.max(w, h); tw = Math.round(w * k); th = Math.round(h * k); }
    else if (s.fit === 'inside') { const k = Math.min(s.width / w, s.height / h); tw = Math.round(w * k); th = Math.round(h * k); }
    else { tw = s.width; th = s.height; }
    if (s.noUpscale && (tw > w || th > h)) {
      if (s.mode === 'exact' && s.fit !== 'inside') { const k = Math.min(1, w / tw, h / th); tw = Math.round(tw * k); th = Math.round(th * k); }
      else { tw = w; th = h; }
    }
    return { width: Math.max(1, tw), height: Math.max(1, th) };
  }

  function rotatedBox(w, h, angle) {
    const a = ((angle % 360) + 360) % 360;
    if (a === 0 || a === 180) return { width: w, height: h };
    if (a === 90 || a === 270) return { width: h, height: w };
    const r = (a * Math.PI) / 180; const c = Math.abs(Math.cos(r)); const s = Math.abs(Math.sin(r));
    return { width: Math.round(w * c + h * s), height: Math.round(w * s + h * c) };
  }
  const borderPx = (w, h, size) => Math.round((Math.min(w, h) * size) / 100);

  /** What size a w x h photo comes out at after the recipe (without decoding anything). */
  function predictSize(w, h, recipe) {
    for (const s of recipe) {
      if (!s.on) continue;
      if (s.type === 'resize') ({ width: w, height: h } = resizeBox(w, h, s));
      else if (s.type === 'crop') ({ width: w, height: h } = cropBox(w, h, s));
      else if (s.type === 'rotate') ({ width: w, height: h } = rotatedBox(w, h, s.angle));
      else if (s.type === 'border') { const b = borderPx(w, h, s.size); w += 2 * b; h += 2 * b; }
    }
    return { width: w, height: h };
  }

  const pad = (n, w) => String(n).padStart(w, '0');
  const BAD = /[<>:"/\\|?*\u0000-\u001f]/g;
  /**
   * Expand a rename pattern. {name} original name without extension, {n} / {n:3} running number (padded), {date} the
   * photo's date (YYYY-MM-DD), {time} (HH-MM-SS), {w} and {h} the output size. Anything unsafe in a file name is replaced.
   */
  function expandPattern(pattern, { name = 'photo', n = 1, date = null, width = 0, height = 0 } = {}) {
    const d = date instanceof Date && !isNaN(date) ? date : null;
    let out = String(pattern || '{name}').replace(/\{(name|n|date|time|w|h)(?::(\d{1,2}))?\}/g, (_m, key, width_) => {
      switch (key) {
        case 'name': return name;
        case 'n': return pad(n, Math.min(12, Number(width_ || 1)));
        case 'date': return d ? `${d.getFullYear()}-${pad(d.getMonth() + 1, 2)}-${pad(d.getDate(), 2)}` : 'undated';
        case 'time': return d ? `${pad(d.getHours(), 2)}-${pad(d.getMinutes(), 2)}-${pad(d.getSeconds(), 2)}` : '';
        case 'w': return String(width);
        case 'h': return String(height);
        default: return '';
      }
    });
    out = out.replace(BAD, '_').replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '').slice(0, 180);
    if (/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(out)) out = '_' + out;
    return out || name || 'photo';
  }

  const freshStep = (type) => ({ type, on: true, ...JSON.parse(JSON.stringify(STEPS[type].defaults)) });
  const DEFAULT_RECIPE = () => [freshStep('resize'), freshStep('levels'), freshStep('text')];

  return { POSITIONS, ASPECTS, STEPS, FORMATS, EXT, DEFAULT_OUTPUT, cleanStep, cleanRecipe, cleanOutput, cropBox, resizeBox, rotatedBox, borderPx, predictSize, expandPattern, freshStep, DEFAULT_RECIPE };
}));
