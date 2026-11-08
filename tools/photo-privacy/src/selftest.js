'use strict';
// Cleans generated pictures and checks the results. Used by `--self-test=` to prove a packaged build works.
// The pictures are structurally valid but tiny/synthetic (no image library is bundled); pixel-level checks against a
// real decoder live in the CI test suite.
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const M = require('./meta');

const seg = (m, payload) => { const h = Buffer.alloc(4); h[0] = 0xff; h[1] = m; h.writeUInt16BE(payload.length + 2, 2); return Buffer.concat([h, payload]); };
function tiffWithGps() {
  // big-endian: IFD0 { Make, GPS pointer } -> GPS { N 10deg, E 20deg }
  const b = Buffer.alloc(200);
  b.write('MM', 0); b.writeUInt16BE(42, 2); b.writeUInt32BE(8, 4);
  b.writeUInt16BE(2, 8);
  b.writeUInt16BE(0x010f, 10); b.writeUInt16BE(2, 12); b.writeUInt32BE(4, 14); b.write('ACM\0', 18, 'latin1'); // 4 bytes: stored inline
  b.writeUInt16BE(0x8825, 22); b.writeUInt16BE(4, 24); b.writeUInt32BE(1, 26); b.writeUInt32BE(38, 30);
  b.writeUInt32BE(0, 34);
  b.writeUInt16BE(4, 38);
  b.writeUInt16BE(1, 40); b.writeUInt16BE(2, 42); b.writeUInt32BE(2, 44); b.write('N\0', 48, 'latin1');
  b.writeUInt16BE(2, 52); b.writeUInt16BE(5, 54); b.writeUInt32BE(3, 56); b.writeUInt32BE(98, 60);
  b.writeUInt16BE(3, 64); b.writeUInt16BE(2, 66); b.writeUInt32BE(2, 68); b.write('E\0', 72, 'latin1');
  b.writeUInt16BE(4, 76); b.writeUInt16BE(5, 78); b.writeUInt32BE(3, 80); b.writeUInt32BE(122, 84);
  b.writeUInt32BE(0, 88);
  [[10, 1], [0, 1], [0, 1], [20, 1], [0, 1], [0, 1]].forEach(([n, d], i) => { b.writeUInt32BE(n, 98 + i * 8); b.writeUInt32BE(d, 98 + i * 8 + 4); });
  return b.subarray(0, 146);
}
function fakeJpeg() {
  const sof = seg(0xc0, Buffer.from([8, 0, 1, 0, 1, 1, 1, 0x11, 0]));
  const dqt = seg(0xdb, Buffer.concat([Buffer.from([0]), Buffer.alloc(64, 1)]));
  const sos = Buffer.concat([seg(0xda, Buffer.from([1, 1, 0, 0, 63, 0])), Buffer.from([0x12, 0x34, 0x56])]);
  const app1 = seg(0xe1, Buffer.concat([Buffer.from('Exif\0\0'), tiffWithGps()]));
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app1, seg(0xfe, Buffer.from('secret comment')), dqt, sof, sos, Buffer.from([0xff, 0xd9]), Buffer.from('TRAILING')]);
}
function png() {
  const T = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b) => { let c = 0xffffffff; for (const x of b) c = T[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (t, d) => { const a = Buffer.from(t), l = Buffer.alloc(4), c = Buffer.alloc(4); l.writeUInt32BE(d.length); c.writeUInt32BE(crc(Buffer.concat([a, d]))); return Buffer.concat([l, a, d, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(2, 0); ihdr.writeUInt32BE(2, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc(2 * (2 * 3 + 1), 0x40);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('tEXt', Buffer.from('parameters\0secret prompt')), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

async function run() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ppc-selftest-'));
  const results = [];
  const step = async (name, fn) => { try { results.push({ name, ok: true, detail: await fn() }); } catch (e) { results.push({ name, ok: false, error: String((e && e.message) || e) }); } };
  try {
    const j = path.join(dir, 'a.jpg'), p = path.join(dir, 'b.png');
    fs.writeFileSync(j, fakeJpeg()); fs.writeFileSync(p, png());
    await step('scan JPEG finds GPS, camera, comment, trailing data', async () => {
      const r = await M.scanFile(j);
      const keys = new Set(r.findings.map((f) => f.key));
      for (const k of ['gps', 'camera', 'comment', 'trailing']) if (!keys.has(k)) throw new Error(`missing ${k}`);
      if (!/10\.00000° N, 20\.00000° E/.test(r.findings.find((f) => f.key === 'gps').detail)) throw new Error('wrong coordinates');
      return [...keys].join(', ');
    });
    await step('clean JPEG', async () => {
      const r = await M.cleanFile(j, { outDir: dir });
      const out = fs.readFileSync(r.output);
      for (const s of ['ACM', 'secret comment', 'TRAILING']) if (out.includes(s)) throw new Error(`${s} still present`);
      if ((await M.scanFile(r.output)).findings.some((f) => f.level !== 'info')) throw new Error('findings remain');
      return `${r.inBytes} -> ${r.outBytes} bytes`;
    });
    await step('clean PNG', async () => {
      const r = await M.cleanFile(p, { outDir: dir });
      if (fs.readFileSync(r.output).includes('secret prompt')) throw new Error('prompt still present');
      return `${r.inBytes} -> ${r.outBytes} bytes`;
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return results;
}

module.exports = { run };
