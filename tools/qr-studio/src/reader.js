'use strict';
// Reading codes from pixels with ZXing-C++ compiled to WebAssembly (zxing-wasm). The .wasm file is read from the app's own
// files (never fetched: by default the library would download it from a CDN, so `wasmBinary` is always given).
const fs = require('fs');
const path = require('path');
const Z = require('zxing-wasm/reader');
const Codes = require('./codes');
const Payload = require('./payload');

let ready = null;
function wasmPath() {
  const p = require.resolve('zxing-wasm/reader/zxing_reader.wasm');
  return p.replace(/app\.asar([\\/])/, (m) => (fs.existsSync(p) ? m : 'app.asar.unpacked$1'));
}
function init() {
  if (!ready) {
    const bin = fs.readFileSync(wasmPath());
    ready = Z.prepareZXingModule({
      overrides: {
        wasmBinary: bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength),
        locateFile: (p) => path.join(path.dirname(wasmPath()), p), // never a URL
      },
      fireImmediately: true,
    });
  }
  return ready;
}

const LABEL = { QRCode: 'QR code', MicroQRCode: 'Micro QR code', rMQRCode: 'rMQR code', EAN13: 'EAN-13', EAN8: 'EAN-8', UPCA: 'UPC-A', UPCE: 'UPC-E', Code128: 'Code 128', Code39: 'Code 39', Code93: 'Code 93', ITF: 'ITF', Codabar: 'Codabar', DataMatrix: 'Data Matrix', PDF417: 'PDF417', Aztec: 'Aztec', DataBar: 'GS1 DataBar', DataBarExpanded: 'GS1 DataBar Expanded', DataBarLimited: 'GS1 DataBar Limited', DXFilmEdge: 'DX film edge', MaxiCode: 'MaxiCode' };

/**
 * @param {{data:Uint8ClampedArray|Uint8Array, width:number, height:number}} img  RGBA pixels
 * @returns {Promise<{format:string,label:string,text:string,position:object,parsed:object}[]>}
 */
async function decode(img) {
  const { width, height } = img;
  if (!(width > 0 && height > 0) || !img.data || img.data.length < width * height * 4) throw new Error('That picture could not be read.');
  await init();
  const data = img.data instanceof Uint8ClampedArray ? img.data : new Uint8ClampedArray(img.data.buffer, img.data.byteOffset, img.data.byteLength);
  const res = await Z.readBarcodes({ data, width, height, colorSpace: 'srgb' }, {
    formats: [], tryHarder: true, tryRotate: true, tryInvert: true, tryDownscale: true, maxNumberOfSymbols: 32, textMode: 'Plain',
  });
  const out = [];
  const seen = new Set();
  for (const r of res) {
    if (!r.isValid) continue;
    const key = r.format + '\u0000' + r.text + '\u0000' + Math.round(r.position.topLeft.x / 8) + ',' + Math.round(r.position.topLeft.y / 8);
    if (seen.has(key)) continue;
    seen.add(key);
    let format = r.format; let text = r.text;
    // an EAN-13 that starts with 0 is a UPC-A (the reader reports both as EAN-13)
    if (format === 'EAN13' && /^0\d{12}$/.test(text)) { format = 'UPCA'; text = text.slice(1); }
    const ours = Codes.READER_FORMATS[format] || format;
    out.push({ format, label: LABEL[format] || format, text, position: r.position, parsed: Payload.parse(text, ours) });
  }
  // a bar pattern "found" inside a QR code is a false reading of the QR's squares: drop it
  const TWO_D = new Set(['QRCode', 'MicroQRCode', 'rMQRCode', 'DataMatrix', 'Aztec', 'PDF417', 'MaxiCode']);
  const quads = out.filter((r) => TWO_D.has(r.format)).map((r) => r.position);
  return out.filter((r) => TWO_D.has(r.format) || !quads.some((q) => inside(centre(r.position), q)));
}

const CORNERS = ['topLeft', 'topRight', 'bottomRight', 'bottomLeft'];
const centre = (p) => ({ x: CORNERS.reduce((t, k) => t + p[k].x, 0) / 4, y: CORNERS.reduce((t, k) => t + p[k].y, 0) / 4 });
function inside(pt, q) {
  const v = CORNERS.map((k) => q[k]);
  let c = false;
  for (let i = 0, j = v.length - 1; i < v.length; j = i++) {
    if ((v[i].y > pt.y) !== (v[j].y > pt.y) && pt.x < ((v[j].x - v[i].x) * (pt.y - v[i].y)) / (v[j].y - v[i].y) + v[i].x) c = !c;
  }
  return c;
}

module.exports = { decode, init, LABEL };
