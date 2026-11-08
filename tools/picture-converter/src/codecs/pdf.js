'use strict';
// Minimal PDF 1.4 writer: one page the size of the image (at 96 dpi), holding one image.
//   - mode 'jpeg':     embed a ready JPEG as-is (DCTDecode) - small files
//   - mode 'lossless': raw RGB compressed with Flate, plus a soft mask when the image has transparency
const zlib = require('zlib');

const DPI = 96;
const fmt = (n) => (Math.round(n * 100) / 100).toString();

/**
 * @param {{width:number,height:number,jpeg?:Buffer,rgb?:Buffer,alpha?:Buffer}} img
 *   jpeg: a baseline/progressive 3-channel JPEG (mode 'jpeg'); or rgb: width*height*3 bytes (+ optional alpha: width*height bytes)
 */
function encode(img) {
  const { width, height } = img;
  const W = (width * 72) / DPI, H = (height * 72) / DPI;
  const objs = []; // objs[i] = Buffer for object number i+1
  const add = (buf) => { objs.push(buf); return objs.length; };
  const stream = (dict, data) => Buffer.concat([Buffer.from(`<< ${dict} /Length ${data.length} >>\nstream\n`, 'latin1'), data, Buffer.from('\nendstream', 'latin1')]);

  // object numbers are fixed up front so references can be written before the objects exist
  const catalogN = 1, pagesN = 2, pageN = 3, imageN = 4, contentN = 5, maskN = 6;
  objs.length = 5;
  objs[catalogN - 1] = Buffer.from(`<< /Type /Catalog /Pages ${pagesN} 0 R >>`, 'latin1');
  objs[pagesN - 1] = Buffer.from(`<< /Type /Pages /Kids [${pageN} 0 R] /Count 1 >>`, 'latin1');
  objs[pageN - 1] = Buffer.from(`<< /Type /Page /Parent ${pagesN} 0 R /MediaBox [0 0 ${fmt(W)} ${fmt(H)}] /Resources << /XObject << /Im0 ${imageN} 0 R >> >> /Contents ${contentN} 0 R >>`, 'latin1');
  const hasMask = !!img.alpha;
  const base = `/Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8`;
  if (img.jpeg) objs[imageN - 1] = stream(`${base} /Filter /DCTDecode`, img.jpeg);
  else objs[imageN - 1] = stream(`${base} /Filter /FlateDecode${hasMask ? ` /SMask ${maskN} 0 R` : ''}`, zlib.deflateSync(img.rgb, { level: 9 }));
  objs[contentN - 1] = stream('', Buffer.from(`q ${fmt(W)} 0 0 ${fmt(H)} 0 0 cm /Im0 Do Q`, 'latin1'));
  if (hasMask && !img.jpeg) {
    // becomes object number 6 (= maskN), appended right after the five fixed objects
    add(stream(`/Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode`, zlib.deflateSync(img.alpha, { level: 9 })));
  }

  const parts = [Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
  const offsets = [];
  let pos = parts[0].length;
  objs.forEach((body, i) => {
    offsets.push(pos);
    const chunk = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`, 'latin1'), body, Buffer.from('\nendobj\n', 'latin1')]);
    parts.push(chunk); pos += chunk.length;
  });
  const xrefPos = pos;
  let xref = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) xref += `${String(o).padStart(10, '0')} 00000 n \n`;
  xref += `trailer\n<< /Size ${objs.length + 1} /Root ${catalogN} 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`;
  parts.push(Buffer.from(xref, 'latin1'));
  return Buffer.concat(parts);
}

module.exports = { encode };
