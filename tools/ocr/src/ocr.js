'use strict';
// The recognition engine: a thin, safe wrapper around tesseract.js (which runs the Tesseract OCR engine compiled to
// WebAssembly, in a worker thread, entirely offline). No Electron in here, so the tests run it with plain Node.
let fs;
try { fs = require('original-fs'); } catch { fs = require('fs'); }
const path = require('path');
const { CODES } = require('./languages');

const PSM = { auto: '3', block: '6', line: '7', sparse: '11' };   // how Tesseract should expect the text to be laid out
const MAX_BYTES = 80 * 1024 * 1024;
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

class UserError extends Error {}

/** The folder with the language files (unpacked from asar when packaged). */
function defaultLangPath() {
  const dir = path.join(__dirname, '..', 'langs');
  return dir.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
}

/** Which of the shipped languages are actually present. */
function installedLanguages(langPath = defaultLangPath()) {
  return CODES.filter((c) => { try { return fs.statSync(path.join(langPath, `${c}.traineddata.gz`)).size > 0; } catch { return false; } });
}

/** "eng", "eng+swe" -> ["eng", "swe"], or throws. Only shipped codes are accepted (the value ends up in a file path). */
function parseLangs(spec) {
  const list = String(spec || 'eng').split('+').map((s) => s.trim());
  if (!list.length || list.length > 3 || !list.every((c) => CODES.includes(c))) throw new UserError(`Unknown language: ${spec}`);
  return [...new Set(list)];
}

/**
 * Turn Tesseract's result into plain, easy data in the coordinates of the ORIGINAL picture.
 * `geo` = how the picture that was read relates to the original: { scale, ox, oy } (it was enlarged by `scale` and is
 * the part of the original that starts at (ox, oy)).
 */
function shape(data, geo = {}) {
  const scale = geo.scale > 0 ? geo.scale : 1;
  const ox = geo.ox || 0; const oy = geo.oy || 0;
  const box = (b) => ({ x: Math.round(b.x0 / scale + ox), y: Math.round(b.y0 / scale + oy), w: Math.max(1, Math.round((b.x1 - b.x0) / scale)), h: Math.max(1, Math.round((b.y1 - b.y0) / scale)) });
  const words = [];
  const lines = [];
  for (const block of data.blocks || []) {
    for (const para of block.paragraphs || []) {
      for (const line of para.lines || []) {
        const lt = (line.text || '').replace(/\s+$/, '');
        if (lt) lines.push({ t: lt, c: Math.round(line.confidence || 0), ...box(line.bbox) });
        for (const w of line.words || []) {
          const wt = (w.text || '').trim();
          if (wt) words.push({ t: wt, c: Math.round(w.confidence || 0), ...box(w.bbox) });
        }
      }
    }
  }
  return { text: String(data.text || ''), confidence: Math.round(data.confidence || 0), words, lines };
}

class Engine {
  /** @param opts { langPath, workerPath?, corePath? } */
  constructor(opts = {}) {
    this.langPath = opts.langPath || defaultLangPath();
    this.extra = {};
    if (opts.workerPath) this.extra.workerPath = opts.workerPath;
    if (opts.corePath) this.extra.corePath = opts.corePath;
    this.worker = null;
    this.key = '';
    this.psm = '';
    this.onProgress = null;
    this.chain = Promise.resolve();
  }

  async workerFor(langs) {
    const key = langs.join('+');
    if (this.worker && this.key === key) return this.worker;
    await this.kill();
    const { createWorker } = require('tesseract.js');
    const w = await createWorker(langs, 1, {
      langPath: this.langPath, gzip: true, cacheMethod: 'none', ...this.extra,
      logger: (m) => { if (this.onProgress && m && typeof m.progress === 'number' && /recogni/i.test(m.status || '')) this.onProgress(m.progress); },
      errorHandler: () => { /* surfaced through the rejected promise */ },
    });
    this.worker = w; this.key = key; this.psm = '';
    return w;
  }

  async kill() {
    const w = this.worker;
    this.worker = null; this.key = ''; this.psm = '';
    if (w) { try { await w.terminate(); } catch { /* already gone */ } }
  }

  /**
   * Read the text in a PNG.
   * @param png    Buffer (a PNG: the window makes it from whatever picture was opened)
   * @param opts   { langs: 'eng' | 'eng+swe', psm: 'auto'|'block'|'line'|'sparse', scale, ox, oy, signal, onProgress(0..1) }
   * @returns {{ text, confidence, words, lines, ms }}
   */
  recognize(png, opts = {}) {
    const run = async () => {
      if (!Buffer.isBuffer(png) || png.length < 100 || png.length > MAX_BYTES || !png.subarray(0, 8).equals(PNG_MAGIC)) throw new UserError('That is not a picture the reader can use');
      const langs = parseLangs(opts.langs);
      const mode = PSM[opts.psm] || PSM.auto;
      const { signal } = opts;
      if (signal && signal.aborted) throw Object.assign(new Error('Cancelled'), { cancelled: true });
      const t0 = Date.now();
      const worker = await this.workerFor(langs);
      if (this.psm !== mode) { await worker.setParameters({ tessedit_pageseg_mode: mode }); this.psm = mode; }
      this.onProgress = opts.onProgress || null;
      let onAbort;
      const aborted = new Promise((_, reject) => {
        if (!signal) return;
        onAbort = () => { this.kill(); reject(Object.assign(new Error('Cancelled'), { cancelled: true })); };
        signal.addEventListener('abort', onAbort, { once: true });
      });
      try {
        const result = await Promise.race([worker.recognize(png, {}, { text: true, blocks: true }), aborted]);
        return { ...shape(result.data, opts), ms: Date.now() - t0 };
      } finally {
        this.onProgress = null;
        if (signal && onAbort) signal.removeEventListener('abort', onAbort);
      }
    };
    const p = this.chain.then(run, run);
    this.chain = p.catch(() => {});       // one picture at a time
    return p;
  }

  async terminate() { await this.chain.catch(() => {}); await this.kill(); }
}

module.exports = { Engine, shape, parseLangs, installedLanguages, defaultLangPath, PSM, UserError, MAX_BYTES };
