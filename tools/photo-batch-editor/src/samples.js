'use strict';
// Invented photos (simple landscapes: a sky, a sun, two rows of hills, sometimes water) for the self-test, the e2e test
// and the README screenshot - nobody's real pictures. Drawn pixel by pixel (no SVG: see the note in pipeline.js).
const sharp = require('./sharp-loader');

const SCENES = [
  { sky: ['#f7b267', '#f4845f'], sun: '#fff1c1', hills: ['#5b3a6e', '#2f2346'], water: false },
  { sky: ['#8ecae6', '#d8f3ff'], sun: '#ffffff', hills: ['#52b788', '#2d6a4f'], water: true },
  { sky: ['#1b263b', '#415a77'], sun: '#e0e1dd', hills: ['#0d1b2a', '#000814'], water: true },
  { sky: ['#ffd6a5', '#fdffb6'], sun: '#ff9f1c', hills: ['#bc6c25', '#7f4f24'], water: false },
  { sky: ['#cdb4db', '#ffc8dd'], sun: '#ffffff', hills: ['#6d597a', '#355070'], water: true },
  { sky: ['#a8dadc', '#f1faee'], sun: '#ffd166', hills: ['#457b9d', '#1d3557'], water: false },
];
const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);

/** Raw RGB pixels of an invented landscape. */
function scene(w, h, index = 0) {
  const s = SCENES[index % SCENES.length];
  const sky0 = rgb(s.sky[0]); const sky1 = rgb(s.sky[1]); const sun = rgb(s.sun); const h0 = rgb(s.hills[0]); const h1 = rgb(s.hills[1]);
  const hz = h * (0.55 + 0.08 * ((index * 7) % 3));
  const sx = w * (0.25 + 0.1 * (index % 5)); const sy = hz * 0.45; const sr = Math.min(w, h) * 0.09;
  const ridge = (x, y0, amp, ph) => y0 - amp * Math.sin((x / w) * Math.PI * 2 + ph) - amp * 0.4 * Math.sin((x / w) * Math.PI * 5 + ph * 2);
  const out = Buffer.alloc(w * h * 3);
  for (let x = 0; x < w; x++) {
    const r1 = ridge(x, hz, h * 0.06, index); const r2 = ridge(x, hz + h * 0.12, h * 0.05, index + 2);
    for (let y = 0; y < h; y++) {
      let c = mix(sky0, sky1, y / h);
      const d = Math.hypot(x - sx, y - sy);
      if (d < sr + 1) c = mix(c, sun, Math.min(1, sr + 1 - d) * 0.95);
      if (y > r1) c = mix(h0, c, Math.max(0, 1 - (y - r1)));
      if (y > r2) c = mix(h1, c, Math.max(0, 1 - (y - r2)));
      if (s.water && y > h * 0.86) c = mix(c, sky0, 0.55);
      const grain = ((x * 7919 + y * 104729) % 13) - 6; // a little texture, like a real photo
      const i = (y * w + x) * 3;
      out[i] = Math.max(0, Math.min(255, c[0] + grain)); out[i + 1] = Math.max(0, Math.min(255, c[1] + grain)); out[i + 2] = Math.max(0, Math.min(255, c[2] + grain));
    }
  }
  return out;
}

/** Write an invented photo. o.orientation stores it sideways with that EXIF orientation; o.exif adds EXIF fields. */
async function makePhoto(file, w, h, { index = 0, format = 'jpeg', orientation, exif, quality = 90 } = {}) {
  let p = sharp(scene(w, h, index), { raw: { width: w, height: h, channels: 3 } });
  if (orientation === 6 || orientation === 8) {
    // store it turned, as a phone would: render to a buffer first so the turn happens before the EXIF tag is set
    const turned = await p.rotate(orientation === 6 ? -90 : 90).raw().toBuffer({ resolveWithObject: true });
    p = sharp(turned.data, { raw: { width: turned.info.width, height: turned.info.height, channels: turned.info.channels } });
  }
  if (format === 'png') p = p.png(); else if (format === 'webp') p = p.webp({ quality }); else p = p.jpeg({ quality });
  if (exif) p = p.withExif(exif);
  if (orientation) p = p.withMetadata({ orientation });
  await p.toFile(file);
  return file;
}

module.exports = { makePhoto, scene };
