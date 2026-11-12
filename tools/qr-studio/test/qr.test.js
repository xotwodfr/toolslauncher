'use strict';
// QR & Barcode Studio core tests. Round trips: every kind of QR code and every barcode type is drawn (the same SVG the
// app shows and saves), turned into pixels by an independent SVG renderer (resvg, test-only), and read back by the app's
// reader (ZXing). Also: a QR with a logo, a rotated and shrunk one, several codes in one picture, escaping of special
// characters, check digit maths against published numbers, and reading decoded text back into fields.
const assert = require('assert');
const { Resvg } = require('@resvg/resvg-js');
const R = require('../src/render');
const P = require('../src/payload');
const C = require('../src/codes');

// the reader must never go online: any fetch fails the test
globalThis.fetch = () => { throw new Error('the reader tried to use the network'); };
const D = require('../src/reader');

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

/** SVG -> RGBA pixels, on white */
function raster(svg, width = 600) {
  const r = new Resvg(svg, { fitTo: { mode: 'width', value: width }, background: '#ffffff' }).render();
  return { data: new Uint8ClampedArray(r.pixels), width: r.width, height: r.height };
}
/** rotate by `deg` and scale by `k` onto a light grey page (bilinear) */
function transform(img, deg, k, pageW, pageH) {
  const out = new Uint8ClampedArray(pageW * pageH * 4).fill(235);
  const a = (deg * Math.PI) / 180; const cos = Math.cos(a); const sin = Math.sin(a);
  const cx = img.width / 2; const cy = img.height / 2; const px = pageW / 2; const py = pageH / 2;
  for (let y = 0; y < pageH; y++) for (let x = 0; x < pageW; x++) {
    const dx = (x - px) / k; const dy = (y - py) / k;
    const sx = cos * dx + sin * dy + cx; const sy = -sin * dx + cos * dy + cy;
    const x0 = Math.floor(sx); const y0 = Math.floor(sy);
    if (x0 < 0 || y0 < 0 || x0 + 1 >= img.width || y0 + 1 >= img.height) continue;
    const fx = sx - x0; const fy = sy - y0;
    for (let c = 0; c < 4; c++) {
      const g = (xx, yy) => img.data[(yy * img.width + xx) * 4 + c];
      out[(y * pageW + x) * 4 + c] = (g(x0, y0) * (1 - fx) + g(x0 + 1, y0) * fx) * (1 - fy) + (g(x0, y0 + 1) * (1 - fx) + g(x0 + 1, y0 + 1) * fx) * fy;
    }
  }
  return { data: out, width: pageW, height: pageH };
}
/** paste several pictures side by side on one white page */
function collage(imgs, gap = 40) {
  const W = imgs.reduce((t, i) => t + i.width + gap, gap); const H = Math.max(...imgs.map((i) => i.height)) + 2 * gap;
  const out = new Uint8ClampedArray(W * H * 4).fill(255);
  let ox = gap;
  for (const img of imgs) {
    for (let y = 0; y < img.height; y++) out.set(img.data.subarray(y * img.width * 4, (y + 1) * img.width * 4), ((y + gap) * W + ox) * 4);
    ox += img.width + gap;
  }
  return { data: out, width: W, height: H };
}
const one = async (img) => { const r = await D.decode(img); assert.strictEqual(r.length, 1, 'expected one code, got ' + JSON.stringify(r.map((x) => x.text))); return r[0]; };
const field = (parsed, label) => { const f = parsed.fields.find((x) => x.label === label); return f ? f.value : undefined; };

// ---- QR kinds: build -> draw -> pixels -> read -> parse ---------------------------------------------------------------
const KINDS = [
  ['text', { text: 'Plain text with Ünïcödé, 名前 and an emoji 🎉\nsecond line' }, 'text', (p) => assert.strictEqual(field(p, 'Text'), 'Plain text with Ünïcödé, 名前 and an emoji 🎉\nsecond line')],
  ['url', { url: 'example.org/path?q=1&r=two' }, 'url', (p) => { assert.strictEqual(p.url, 'https://example.org/path?q=1&r=two'); assert.strictEqual(field(p, 'Website'), 'example.org'); }],
  ['wifi', { ssid: 'Café;Net,"5G":\\x', password: 'p@ss;w,rd:"\\end', security: 'WPA', hidden: true }, 'wifi', (p) => { assert.strictEqual(field(p, 'Network'), 'Café;Net,"5G":\\x'); assert.strictEqual(field(p, 'Password'), 'p@ss;w,rd:"\\end'); assert.strictEqual(field(p, 'Security'), 'WPA'); assert.strictEqual(field(p, 'Hidden'), 'yes'); }],
  ['wifi', { ssid: 'Guest', security: 'nopass' }, 'wifi', (p) => { assert.strictEqual(field(p, 'Network'), 'Guest'); assert.strictEqual(field(p, 'Password'), undefined); assert.strictEqual(field(p, 'Security'), 'None (open network)'); }],
  ['vcard', { first: 'Ada', last: 'Lovelace-Byron; Jr.', org: 'Analytical, Engines Ltd', title: 'Mathematician', phone: '+44 20 7946 0000', email: 'ada@example.org', website: 'https://example.org', street: '12 Example Street', city: 'London', zip: 'NW1 1AA', country: 'United Kingdom', note: 'Line one\nLine two; with \\ backslash' }, 'vcard',
    (p) => { assert.strictEqual(field(p, 'Name'), 'Ada Lovelace-Byron; Jr.'); assert.strictEqual(field(p, 'Company'), 'Analytical, Engines Ltd'); assert.strictEqual(field(p, 'Phone'), '+44 20 7946 0000'); assert.strictEqual(field(p, 'Note'), 'Line one\nLine two; with \\ backslash'); assert.strictEqual(field(p, 'Address'), '12 Example Street, London, NW1 1AA, United Kingdom'); }],
  ['mecard', { first: 'Grace', last: 'Hopper', phone: '+1 555 0100', email: 'grace@example.org', note: 'Bugs; moths: "first"' }, 'mecard', (p) => { assert.strictEqual(field(p, 'Name'), 'Grace Hopper'); assert.strictEqual(field(p, 'Note'), 'Bugs; moths: "first"'); assert.strictEqual(field(p, 'Email'), 'grace@example.org'); }],
  ['email', { to: 'someone@example.org', subject: 'Hello & welcome', body: 'Two words?\nYes.' }, 'email', (p) => { assert.strictEqual(field(p, 'To'), 'someone@example.org'); assert.strictEqual(field(p, 'Subject'), 'Hello & welcome'); assert.strictEqual(field(p, 'Message'), 'Two words?\nYes.'); }],
  ['sms', { number: '+1 (555) 010-0199', message: 'Running late: 10 min' }, 'sms', (p) => { assert.strictEqual(field(p, 'To'), '+15550100199'); assert.strictEqual(field(p, 'Message'), 'Running late: 10 min'); }],
  ['phone', { number: '+46 8 123 456' }, 'phone', (p) => assert.strictEqual(field(p, 'Number'), '+468123456')],
  ['geo', { lat: '59.329323', lng: '18.068581', label: 'Old Town' }, 'geo', (p) => { assert.strictEqual(field(p, 'Latitude'), '59.329323'); assert.strictEqual(field(p, 'Longitude'), '18.068581'); assert.strictEqual(field(p, 'Label'), 'Old Town'); }],
  ['event', { title: 'Team lunch, Friday; bring snacks', start: '2026-11-13T12:00', end: '2026-11-13T13:30', location: 'Room 4', description: 'Menu:\nsoup' }, 'event', (p) => { assert.strictEqual(field(p, 'Title'), 'Team lunch, Friday; bring snacks'); assert.strictEqual(field(p, 'Starts'), '2026-11-13 12:00'); assert.strictEqual(field(p, 'Ends'), '2026-11-13 13:30'); assert.strictEqual(field(p, 'Details'), 'Menu:\nsoup'); }],
  ['event', { title: 'Holiday', start: '2026-12-24', end: '2026-12-27', allDay: true }, 'event', (p) => { assert.strictEqual(field(p, 'Starts'), '2026-12-24'); }],
];

test('every kind of QR code survives drawing, pixels and reading, and is understood again (all three module styles)', async () => {
  let i = 0;
  for (const [kind, fields, want, check] of KINDS) {
    const b = P.build(kind, fields);
    assert(b.ok, kind + ': ' + b.error);
    const style = ['square', 'rounded', 'dots'][i++ % 3];
    const q = R.qrSvg(b.text, { style, level: 'M' });
    const r = await one(raster(q.svg, 520));
    assert.strictEqual(r.format, 'QRCode');
    assert.strictEqual(r.text, b.text, kind + ' text');
    assert.strictEqual(r.parsed.kind, want, kind + ' kind');
    check(r.parsed);
  }
});

test('every error correction level and style reads back; a higher level makes a bigger code', async () => {
  let last = 0;
  for (const level of ['L', 'M', 'Q', 'H']) {
    for (const style of ['square', 'rounded', 'dots']) {
      const q = R.qrSvg('https://example.org/a/fairly/long/address/to/fill/the/code?x=123456', { level, style, fg: '#1b2a49', bg: '#fffbe8' });
      assert.strictEqual(q.level, level);
      const r = await one(raster(q.svg, 500));
      assert.strictEqual(r.text, 'https://example.org/a/fairly/long/address/to/fill/the/code?x=123456', level + '/' + style);
    }
    const n = R.qrSvg('https://example.org/a/fairly/long/address/to/fill/the/code?x=123456', { level }).modules;
    assert(n >= last); last = n;
  }
});

test('a QR code with a logo in the middle: level H is forced, the logo stays under 20 % of the area, and it still reads', async () => {
  const logoPng = new Resvg('<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80"><rect width="80" height="80" rx="16" fill="#e5484d"/><circle cx="40" cy="40" r="22" fill="#ffffff"/><rect x="30" y="30" width="20" height="20" fill="#111"/></svg>').render().asPng();
  const logo = { dataUrl: 'data:image/png;base64,' + logoPng.toString('base64') };
  for (const [text, style, scale] of [['Hi', 'square', 0.2], ['https://example.org/menu', 'rounded', 0.2], ['WIFI:T:WPA;S:Home;P:correct horse battery staple;;', 'dots', 0.15], ['x'.repeat(120), 'square', 0.2], ['x'.repeat(300), 'square', 0.15], ['x'.repeat(1000), 'dots', 0.2]]) {
    const q = R.qrSvg(text, { level: 'L', style, logo, logoScale: scale });
    assert.strictEqual(q.level, 'H', 'level H forced');
    assert(q.version >= 5, 'big enough for a logo');
    assert(q.logoBox && (q.logoBox.s * q.logoBox.s) / (q.modules * q.modules) <= 0.2 + 1e-9, 'logo area ' + (q.logoBox.s ** 2 / q.modules ** 2));
    assert(q.svg.includes('<image'), 'logo drawn');
    const r = await one(raster(q.svg, 600));
    assert.strictEqual(r.text, text, `logo ${style} ${scale}`);
  }
  const big = R.qrSvg('x'.repeat(300), { logo, logoScale: 0.5 });
  assert(big.logoBox.s ** 2 / big.modules ** 2 <= 0.2, 'a bigger logo is limited to 20 %');
});

test('a rotated, shrunk QR code on a grey page reads (and an inverted, light-on-dark one too)', async () => {
  const q = R.qrSvg('ROTATED and scaled 12345', { level: 'M' });
  const img = raster(q.svg, 400);
  for (const [deg, k] of [[30, 0.6], [90, 0.5], [-17, 1.3], [180, 0.8]]) {
    const r = await one(transform(img, deg, k, 700, 640));
    assert.strictEqual(r.text, 'ROTATED and scaled 12345', `${deg} degrees x${k}`);
  }
  const inv = R.qrSvg('inverted', { fg: '#ffffff', bg: '#101010' });
  assert(inv.warnings.some((w) => /inverted/.test(w)), 'warns about inverted colours');
  assert.strictEqual((await one(raster(inv.svg, 400))).text, 'inverted');
});

// ---- barcodes ---------------------------------------------------------------------------------------------------------------
const BARS = [
  ['ean13', '590123412345', '5901234123457', 'EAN13'],
  ['ean13', '4006381333931', '4006381333931', 'EAN13'],
  ['ean8', '9638507', '96385074', 'EAN8'],
  ['upca', '03600029145', '036000291452', 'UPCA'],
  ['code128', 'Order #A-1029/b (x)', 'Order #A-1029/b (x)', 'Code128'],
  ['code39', 'part 42-x', 'PART 42-X', 'Code39'],
  ['itf', '1234567890', '1234567890', 'ITF'],
  ['itf', '123', '0123', 'ITF'],
];
test('every barcode type survives drawing, pixels and reading, with the human-readable text', async () => {
  for (const [kind, input, want, format] of BARS) {
    const b = R.barcodeSvg(kind, input, { showText: true });
    assert.strictEqual(b.encoded, want, kind + ' encoded');
    const r = await one(raster(b.svg, 700));
    assert.strictEqual(r.format, format, kind);
    assert.strictEqual(r.text, want, kind + ' read back');
    assert(b.svg.split('<path').length > 2, kind + ': the digits under the bars are drawn');
  }
  const r = await one(raster(R.barcodeSvg('ean13', '590123412345').svg, 700));
  assert.strictEqual(r.parsed.kind, 'product');
  assert.strictEqual(field(r.parsed, 'Check digit'), 'correct');
});

test('Code 39 with its check character, ITF with a check digit, and coloured barcodes read back', async () => {
  const c = R.barcodeSvg('code39', 'ABC123', { check: true });
  assert.strictEqual(c.encoded, 'ABC123' + C.code39Check('ABC123'));
  assert.strictEqual((await one(raster(c.svg, 700))).text, c.encoded);
  const i = R.barcodeSvg('itf', '1234567', { check: true });
  assert.strictEqual(i.encoded, '12345670');
  assert.strictEqual((await one(raster(i.svg, 700))).text, '12345670');
  const col = R.barcodeSvg('code128', 'COLOUR', { fg: '#003366', bg: '#fff4d6' });
  assert.strictEqual((await one(raster(col.svg, 700))).text, 'COLOUR');
});

test('several codes in one picture are all found, each with its outline', async () => {
  const imgs = [raster(R.qrSvg('first code').svg, 300), raster(R.barcodeSvg('ean13', '590123412345').svg, 420), raster(R.qrSvg('WIFI:T:WPA;S:Lab;P:12345678;;', { style: 'dots' }).svg, 260)];
  const page = collage(imgs);
  const res = await D.decode(page);
  assert.deepStrictEqual(res.map((r) => r.text).sort(), ['590123412345' + '7', 'WIFI:T:WPA;S:Lab;P:12345678;;', 'first code'].sort());
  for (const r of res) for (const k of ['topLeft', 'topRight', 'bottomRight', 'bottomLeft']) assert(r.position[k].x >= 0 && r.position[k].x <= page.width && r.position[k].y >= 0 && r.position[k].y <= page.height, 'outline inside the picture');
  const wifi = res.find((r) => r.parsed.kind === 'wifi');
  assert(wifi.position.topLeft.x > imgs[0].width + imgs[1].width, 'the outline is where the code is');
  assert.deepStrictEqual(await D.decode({ data: new Uint8ClampedArray(200 * 100 * 4).fill(255), width: 200, height: 100 }), [], 'a blank picture has no codes');
  await assert.rejects(() => D.decode({ data: new Uint8ClampedArray(10), width: 100, height: 100 }), /could not be read/);
});

// ---- check digits --------------------------------------------------------------------------------------------------------
test('check digit maths matches published numbers (EAN-13, EAN-8, UPC-A, GTIN-14)', () => {
  const known = { '400638133393': '1', '590123412345': '7', '978030640615': '7', '9638507': '4', '7351353': '7', '03600029145': '2', '01234567890': '5', '1540014128876': '3', '0001234567890': '5' };
  for (const [body, digit] of Object.entries(known)) assert.strictEqual(C.gtinCheckDigit(body), digit, body);
  assert(C.gtinValid('9780306406157')); assert(!C.gtinValid('9780306406158'));
  assert.strictEqual(C.code39Check('CODE39'), 'W');
  assert.throws(() => C.gtinCheckDigit('12a'), /digits/);
});

test('what the user types is checked and completed in plain words', () => {
  assert.deepStrictEqual(C.prepare('ean13', '590123412345').text, '5901234123457');
  assert.strictEqual(C.prepare('ean13', '590-1234-12345 7').text, '5901234123457', 'spaces and dashes are fine');
  const wrong = C.prepare('ean13', '5901234123458');
  assert(!wrong.ok && /should be 7/.test(wrong.error), wrong.error);
  assert(!C.prepare('ean8', '12345').ok && /7 or 8 digits/.test(C.prepare('ean8', '12345').error));
  assert(/digits only/.test(C.prepare('upca', '12345abc901').error));
  assert.strictEqual(C.prepare('code39', 'abc').text, 'ABC');
  assert(/capitals/.test(C.prepare('code39', 'abc').note));
  assert(/cannot hold "@"/.test(C.prepare('code39', 'A@B').error));
  assert(/plain letters/.test(C.prepare('code128', 'Café').error));
  assert.strictEqual(C.prepare('itf', '12345').text, '012345');
  assert(!C.prepare('qr', 'x').ok);
  assert(/Type what/.test(C.prepare('code128', '  ').error));
  assert.throws(() => R.barcodeSvg('ean13', '5901234123458'), /should be 7/);
});

// ---- building and parsing --------------------------------------------------------------------------------------------------
test('Wi-Fi and MeCard escaping: backslash before \\ ; , : " and nothing else', () => {
  const b = P.build('wifi', { ssid: 'a;b,c:d"e\\f', password: 'x', security: 'WEP' });
  assert.strictEqual(b.text, 'WIFI:T:WEP;S:a\\;b\\,c\\:d\\"e\\\\f;P:x;;');
  assert.strictEqual(P.parse(b.text).fields[0].value, 'a;b,c:d"e\\f');
  assert.strictEqual(P.build('wifi', { ssid: 'Ünï 名', password: 'Ünï 名 pass' }).text, 'WIFI:T:WPA;S:Ünï 名;P:Ünï 名 pass;;');
  assert(/password/.test(P.build('wifi', { ssid: 'x' }).error));
  assert(/8 characters/.test(P.build('wifi', { ssid: 'x', password: 'short' }).warn));
  // a hand-written code in a different field order with an escaped semicolon
  const p = P.parse('WIFI:S:My\\;Net;T:WPA2;P:pa\\:ss;;');
  assert.strictEqual(field(p, 'Network'), 'My;Net'); assert.strictEqual(field(p, 'Password'), 'pa:ss'); assert.strictEqual(field(p, 'Security'), 'WPA2');
  assert.strictEqual(P.build('mecard', { first: 'A,B', last: 'C;D' }).text, 'MECARD:N:C\\;D,A\\,B;;');
});

test('vCard 3.0 escaping: \\\\ \\; \\, and new lines, with CRLF line ends; folded lines are read', () => {
  const b = P.build('vcard', { first: 'Jo', last: 'Doe', note: 'a,b;c\\d\ne' });
  assert(b.text.startsWith('BEGIN:VCARD\r\nVERSION:3.0\r\nN:Doe;Jo;;;\r\nFN:Jo Doe\r\n'), b.text);
  assert(b.text.includes('NOTE:a\\,b\\;c\\\\d\\ne\r\n'), b.text);
  assert(b.text.endsWith('END:VCARD'));
  const folded = 'BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Very Long\r\n  Name\r\nitem1.EMAIL;type=INTERNET:x@example.org\r\nTEL;TYPE=WORK,VOICE:123\r\nEND:VCARD';
  const p = P.parse(folded);
  assert.strictEqual(field(p, 'Name'), 'Very Long Name');
  assert.strictEqual(field(p, 'Email'), 'x@example.org');
  assert.strictEqual(field(p, 'Work phone'), '123');
  assert(/name or a company/.test(P.build('vcard', {}).error));
});

test('decoded text of every common kind is understood: links, mail, SMS, phone, places, events, products and plain text', () => {
  assert.deepStrictEqual(P.parse('http://example.org/x').insecure, true);
  assert.strictEqual(P.parse('https://example.org/x y').kind, 'text', 'not a single link');
  const mm = P.parse('MATMSG:TO:a@example.org;SUB:Hi;BODY:Hello;;');
  assert.strictEqual(field(mm, 'To'), 'a@example.org'); assert.strictEqual(field(mm, 'Message'), 'Hello');
  const sms = P.parse('sms:+15550100?body=See%20you');
  assert.strictEqual(field(sms, 'To'), '+15550100'); assert.strictEqual(field(sms, 'Message'), 'See you');
  assert.strictEqual(field(P.parse('SMSTO:123:a:b'), 'Message'), 'a:b', 'a colon in the message is kept');
  assert.strictEqual(field(P.parse('TEL:+1-555'), 'Number'), '+1-555');
  const g = P.parse('geo:-33.8688,151.2093,40');
  assert.strictEqual(field(g, 'Latitude'), '-33.8688');
  const ev = P.parse('BEGIN:VCALENDAR\nVERSION:2.0\nBEGIN:VEVENT\nSUMMARY:Launch\nDTSTART:20261201T090000Z\nEND:VEVENT\nEND:VCALENDAR');
  assert.strictEqual(field(ev, 'Title'), 'Launch'); assert.strictEqual(field(ev, 'Starts'), '2026-12-01 09:00 UTC');
  const prod = P.parse('4006381333932', 'ean13');
  assert.strictEqual(field(prod, 'Check digit'), 'wrong (this number may be misread)');
  assert.strictEqual(P.parse('PART-77', 'code39').kind, 'text');
  assert.strictEqual(P.parse('just words').kind, 'text');
  assert(/before it starts/.test(P.build('event', { title: 'x', start: '2026-11-10T10:00', end: '2026-11-10T09:00' }).error));
  assert(/-90 to 90/.test(P.build('geo', { lat: '91', lng: '0' }).error));
  assert(/email address/.test(P.build('email', { to: 'nope' }).error));
  assert.strictEqual(P.build('url', { url: 'ftp://files.example.org' }).text, 'ftp://files.example.org');
});

test('colour checks warn about low contrast, inverted colours and see-through backgrounds, and not about black on white', () => {
  assert.deepStrictEqual(R.colourWarnings('#000000', '#ffffff', false), []);
  assert(R.colourWarnings('#777777', '#888888', false).some((w) => /very low/.test(w)));
  assert(R.colourWarnings('#ffffff', '#000000', false).some((w) => /inverted/.test(w)));
  assert(R.colourWarnings('#eeeeee', '#000000', true).some((w) => /see-through/.test(w)));
  assert(R.colourWarnings('#606060', '#c0c0c0', false).some((w) => /contrast is low/.test(w)), 'about 3.5 : 1');
  assert(R.qrSvg('x', { margin: 1 }).warnings.some((w) => /margin/.test(w)));
});

test('too much text for a QR code gives a plain message; the SVG has the requested size and no scripts', () => {
  assert.throws(() => R.qrSvg('x'.repeat(8000)), /Too much text/);
  const q = R.qrSvg('size test', { size: 1234, margin: 2, transparent: true });
  assert(q.svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg" width="1234" height="1234"'));
  assert(!/<rect width/.test(q.svg), 'no background when transparent');
  assert(!/script|onload|href="http/i.test(q.svg));
  assert(!/<image/.test(R.qrSvg('x', { logo: { dataUrl: 'javascript:alert(1)' } }).svg), 'only image data URLs are used as a logo');
});

(async () => {
  let failed = 0;
  for (const [name, fn] of tests) {
    const t0 = Date.now();
    try { await fn(); console.log(`ok   ${name} (${Date.now() - t0} ms)`); }
    catch (e) { failed++; console.log(`FAIL ${name}\n     ${String((e && e.stack) || e).split('\n').slice(0, 6).join('\n     ')}`); }
  }
  console.log(failed ? `\n${failed} of ${tests.length} failed` : `\nall ${tests.length} passed`);
  process.exit(failed ? 1 : 0);
})();
