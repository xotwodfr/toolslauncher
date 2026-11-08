'use strict';
// JPEG XL through @jsquash/jxl (libjxl compiled to WebAssembly). The package is an ES module written for browsers,
// so it is loaded with import() from its real on-disk location (unpacked from the asar when packaged) and its
// .wasm files are compiled here and handed to init() - no fetch(), no network, no native code.
let fs;
try { fs = require('original-fs'); } catch { fs = require('fs'); }
const path = require('path');
const { pathToFileURL } = require('url');

const pkgDir = () => path.join(__dirname, '..', '..', 'node_modules', '@jsquash', 'jxl').replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');

let loading = null;
function load() {
  if (!loading) {
    loading = (async () => {
      // the codecs expect the browser's ImageData class
      if (!globalThis.ImageData) globalThis.ImageData = class ImageData { constructor(data, width, height) { this.data = data; this.width = width; this.height = height; } };
      const dir = pkgDir();
      const enc = await import(pathToFileURL(path.join(dir, 'encode.js')).href);
      const dec = await import(pathToFileURL(path.join(dir, 'decode.js')).href);
      await enc.init(await WebAssembly.compile(fs.readFileSync(path.join(dir, 'codec', 'enc', 'jxl_enc.wasm'))));
      await dec.init(await WebAssembly.compile(fs.readFileSync(path.join(dir, 'codec', 'dec', 'jxl_dec.wasm'))));
      return { encode: enc.default, decode: dec.default };
    })();
    loading.catch(() => { loading = null; }); // allow a retry after a failed load
  }
  return loading;
}

/** @param {Buffer} rgba width*height*4 */
async function encode(rgba, width, height, { quality = 75, lossless = false, effort = 4 } = {}) {
  const { encode: enc } = await load();
  const pixels = new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, width * height * 4);
  // libjxl only honours lossless mode when quality is exactly 100 (otherwise it silently encodes lossy)
  const out = await enc(new ImageData(pixels, width, height), { quality: lossless ? 100 : quality, lossless, effort });
  return Buffer.from(out);
}

/** @returns {Promise<{width:number,height:number,data:Buffer}>} RGBA */
async function decode(buf, maxPixels = 100e6) {
  const { decode: dec } = await load();
  const img = await dec(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  if (!img || !img.width || !img.height || img.width * img.height > maxPixels) throw new Error('JPEG XL image has invalid or too large dimensions');
  return { width: img.width, height: img.height, data: Buffer.from(img.data.buffer, img.data.byteOffset, img.data.byteLength) };
}

module.exports = { encode, decode };
