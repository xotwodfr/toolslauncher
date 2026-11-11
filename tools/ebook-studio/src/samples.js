'use strict';
// Invented sample books for the self-test, the tests and the screenshots: an EPUB 2 made by hand (NCX table of contents,
// an svg-wrapped cover page, a script and an onerror handler that must never run), a text book, and a small PNG writer.
const zlib = require('zlib');
const { zipSync, strToU8 } = require('fflate');

const CRC = new Int32Array(256).map((_v, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
const crc32 = (buf) => { let c = -1; for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ -1) >>> 0; };
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
/** makePng(w, h, (x, y) => [r, g, b]) -> PNG bytes. */
function makePng(w, h, color = () => [120, 80, 200]) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const [r, g, b] = color(x, y); const o = y * (w * 3 + 1) + 1 + x * 3; raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return new Uint8Array(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
}
/** An invented cover: a title band over a gradient. */
const coverPng = (w = 300, h = 450, hue = [60, 40, 110]) => makePng(w, h, (x, y) => {
  if (y > h * 0.62 && y < h * 0.78) return [235, 225, 210];
  const t = y / h; return [Math.round(hue[0] + t * 120), Math.round(hue[1] + t * 60), Math.round(hue[2] + t * 70)];
});

const xhtml = (title, body) => `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.1//EN" "http://www.w3.org/TR/xhtml11/DTD/xhtml11.dtd">
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>${title}</title><link rel="stylesheet" type="text/css" href="../css/book.css"/><style>p{color:red}</style><script type="text/javascript">window.parent.__pwned = 1;</script></head>
<body>${body}</body></html>`;

/** A hand-made EPUB 2 (OPF 2.0 + NCX, no nav document). Files under "OPS/", with a space and accents in a picture name. */
function makeEpub2({ chapters = 3, title = 'The Lighthouse Keeper’s Almanac', author = 'Mara Invented' } = {}) {
  const files = {};
  files.mimetype = [strToU8('application/epub+zip'), { level: 0 }];
  files['META-INF/container.xml'] = strToU8('<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OPS/package.opf" media-type="application/oebps-package+xml"/></rootfiles></container>');
  files['OPS/css/book.css'] = strToU8('body { font-family: serif; } @import url("https://example.com/x.css");');
  files['OPS/images/cover.png'] = coverPng();
  files['OPS/images/map é 1.png'] = makePng(60, 40, (x) => [40 + x * 3, 120, 90]);
  files['OPS/text/cover.xhtml'] = strToU8(xhtml('Cover', '<div><svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 300 450"><image width="300" height="450" xlink:href="../images/cover.png"/></svg></div>'));
  const items = []; const refs = []; const nav = [];
  for (let i = 1; i <= chapters; i++) {
    const paras = Array.from({ length: 30 }, (_v, k) => `<p>Paragraph ${k + 1} of chapter ${i}. The lamp turned all night while the keeper wrote about tides, gulls and the slow ships passing the point${k === 3 ? ' — see <a href="ch' + (i % chapters + 1) + '.xhtml#note">the next note</a>' : ''}.</p>`).join('\n');
    const extra = i === 1 ? '<p><img src="../images/map%20%C3%A9%201.png" alt="Map of the point"/></p><p><img src="nope.png" onerror="window.parent.__pwned=2" alt="broken"/><a href="javascript:window.parent.__pwned=3">bad</a> <a href="https://example.org/tides">tide tables</a></p><form action="https://evil.example"><input name="x"/></form><iframe src="https://evil.example"></iframe>' : '';
    files[`OPS/text/ch${i}.xhtml`] = strToU8(xhtml(`Chapter ${i}`, `<h1 id="c${i}">Chapter ${i}: ${['Winter Light', 'The Fog Bell', 'Spring Tides', 'Gulls', 'The Long Night'][(i - 1) % 5]}</h1>${extra}<p id="note" onclick="alert(1)">A note in chapter ${i}: the beacon is lit at dusk.</p>\n${paras}`));
    items.push(`<item id="ch${i}" href="text/ch${i}.xhtml" media-type="application/xhtml+xml"/>`);
    refs.push(`<itemref idref="ch${i}"/>`);
    nav.push(`<navPoint id="n${i}" playOrder="${i + 1}"><navLabel><text>Chapter ${i}: ${['Winter Light', 'The Fog Bell', 'Spring Tides', 'Gulls', 'The Long Night'][(i - 1) % 5]}</text></navLabel><content src="text/ch${i}.xhtml#c${i}"/></navPoint>`);
  }
  files['OPS/package.opf'] = strToU8(`<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="BookId" version="2.0">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf">
<dc:title>${title.replace(/&/g, '&amp;')}</dc:title>
<dc:creator opf:role="aut" opf:file-as="Invented, Mara">${author}</dc:creator>
<dc:creator opf:role="ill">Someone Drawing</dc:creator>
<dc:language>en-GB</dc:language>
<dc:publisher>Imaginary Press</dc:publisher>
<dc:description>An invented book for testing.</dc:description>
<dc:identifier id="BookId" opf:scheme="UUID">urn:uuid:0b6b1c1e-3d1f-4c39-9a9e-2a3b4c5d6e7f</dc:identifier>
<meta name="cover" content="cover-img"/>
</metadata>
<manifest>
<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
<item id="css" href="css/book.css" media-type="text/css"/>
<item id="cover-img" href="images/cover.png" media-type="image/png"/>
<item id="map" href="images/map%20%C3%A9%201.png" media-type="image/png"/>
<item id="coverpage" href="text/cover.xhtml" media-type="application/xhtml+xml"/>
${items.join('\n')}
</manifest>
<spine toc="ncx">
<itemref idref="coverpage" linear="no"/>
${refs.join('\n')}
</spine>
<guide><reference type="cover" title="Cover" href="text/cover.xhtml"/></guide>
</package>`);
  files['OPS/toc.ncx'] = strToU8(`<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><head><meta name="dtb:uid" content="urn:uuid:0b6b1c1e-3d1f-4c39-9a9e-2a3b4c5d6e7f"/></head>
<docTitle><text>${title}</text></docTitle><navMap>
<navPoint id="n0" playOrder="1"><navLabel><text>Cover</text></navLabel><content src="text/cover.xhtml"/></navPoint>
${nav.join('\n')}
</navMap></ncx>`);
  return zipSync(files);
}

/** An invented plain-text book in the style of old free ebooks (hard-wrapped lines, "CHAPTER I" headings, a contents list). */
function sampleText() {
  const wrap = (s) => s.match(/.{1,68}(\s|$)/g).map((l) => l.trim()).join('\n');
  const para = (n) => wrap(`This is paragraph ${n}. The harbour was quiet in the early morning, and the boats rocked gently at their moorings while the gulls argued over the fish market roofs and the baker opened her shutters.`);
  const ch = (num, name) => `CHAPTER ${num}\n${name}\n\n${[1, 2, 3, 4].map(para).join('\n\n')}\n\nA short verse:\nThe tide goes out,\nthe tide comes in.\n\n`;
  return `Title: The Small Harbour\nAuthor: Ada Invented\nLanguage: English\n\nCONTENTS\n\nCHAPTER I\nCHAPTER II\nCHAPTER III\n\n\n${ch('I', 'The Arrival')}${ch('II', 'Market Day')}${ch('III', 'The Storm')}THE END\n`;
}

module.exports = { makePng, coverPng, makeEpub2, sampleText };
