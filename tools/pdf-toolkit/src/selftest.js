'use strict';
// Runs every operation on generated files and checks the results by reading them back. Used by `--self-test=` to prove
// that a packaged build works.
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { PDFDocument } = require('pdf-lib');
const P = require('./pdf');

function png(w, h) {
  const T = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b) => { let c = 0xffffffff; for (const x of b) c = T[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (t, d) => { const a = Buffer.from(t), l = Buffer.alloc(4), c = Buffer.alloc(4); l.writeUInt32BE(d.length); c.writeUInt32BE(crc(Buffer.concat([a, d]))); return Buffer.concat([l, a, d, c]); };
  const raw = Buffer.alloc((w * 3 + 1) * h, 0x80);
  for (let y = 0; y < h; y++) raw[y * (w * 3 + 1)] = 0;
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

async function run() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdftk-selftest-'));
  const results = [];
  const step = async (name, fn) => {
    try { const detail = await fn(); results.push({ name, ok: true, detail }); } catch (e) { results.push({ name, ok: false, error: String((e && e.message) || e) }); }
  };
  const pageCount = async (f) => (await PDFDocument.load(fs.readFileSync(f))).getPageCount();
  const make = async (name, n) => { const d = await PDFDocument.create(); for (let i = 0; i < n; i++) d.addPage([200 + i, 300]); const f = path.join(dir, name); fs.writeFileSync(f, await d.save()); return f; };
  try {
    const a = await make('a.pdf', 4), b = await make('b.pdf', 2);
    await step('merge', async () => { const r = await P.merge([a, b], { outDir: dir }); if ((await pageCount(r.outputs[0])) !== 6) throw new Error('expected 6 pages'); return '6 pages'; });
    await step('split by ranges', async () => { const r = await P.split(a, { mode: 'ranges', spec: '1-2, 4', outDir: dir }); if (r.outputs.length !== 2) throw new Error('expected 2 files'); return '2 files'; });
    await step('extract + reorder', async () => { const r = await P.editPages(a, { action: 'extract', spec: '4,1', outDir: dir }); const d = await PDFDocument.load(fs.readFileSync(r.outputs[0])); if (d.getPage(0).getWidth() !== 203) throw new Error('wrong first page'); return 'ok'; });
    await step('delete', async () => { const r = await P.editPages(a, { action: 'delete', spec: '1', outDir: dir }); if ((await pageCount(r.outputs[0])) !== 3) throw new Error('expected 3 pages'); return '3 pages'; });
    await step('rotate', async () => { const r = await P.editPages(a, { action: 'rotate', spec: 'all', angle: 90, outDir: dir }); const d = await PDFDocument.load(fs.readFileSync(r.outputs[0])); if (d.getPage(0).getRotation().angle !== 90) throw new Error('not rotated'); return 'ok'; });
    await step('images to PDF', async () => { const f = path.join(dir, 'i.png'); fs.writeFileSync(f, png(6, 3)); const r = await P.imagesToPdf([f], { pageSize: 'a4', outDir: dir }); if ((await pageCount(r.outputs[0])) !== 1) throw new Error('expected 1 page'); return 'ok'; });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return results;
}

module.exports = { run };
