'use strict';
// Electron-free scanner and cleaner for JPEG, PNG and WebP (testable with plain Node).
//
// Cleaning never decodes or re-encodes the picture. It copies the file's own segments/chunks byte for byte and simply
// leaves the metadata ones out, so the pixels cannot change. Every clean is then checked: the picture-carrying data
// of the output must be identical to the input's, and a fresh scan of the output must find nothing left to remove.
let fs;
try { fs = require('original-fs'); } catch { fs = require('fs'); }
const path = require('path');
const crypto = require('crypto');

const MAX_BYTES = 300 * 1024 * 1024;
class UserError extends Error {}
const fail = (m) => { throw new UserError(m); };

const LEVEL_ORDER = { info: 0, low: 1, medium: 2, high: 3 };

// ---- format detection ----------------------------------------------------------------------------------------------
function detect(buf) {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'png';
  if (buf.length >= 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  return null;
}
const EXT = { jpeg: '.jpg', png: '.png', webp: '.webp' };
const isSupportedName = (f) => ['.jpg', '.jpeg', '.jpe', '.png', '.webp'].includes(path.extname(f).toLowerCase());

// ---- TIFF/EXIF reader (bounds-checked: a damaged or hostile file can only make it return less) ------------------------
const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8 };

function readIfd(t, little, offset, seen, out) {
  if (offset < 8 || offset + 2 > t.length || seen.has(offset)) return null;
  seen.add(offset);
  const u16 = (o) => (little ? t.readUInt16LE(o) : t.readUInt16BE(o));
  const u32 = (o) => (little ? t.readUInt32LE(o) : t.readUInt32BE(o));
  const n = Math.min(u16(offset), 512);
  const entries = new Map();
  for (let i = 0; i < n; i++) {
    const e = offset + 2 + i * 12;
    if (e + 12 > t.length) break;
    const tag = u16(e), type = u16(e + 2), count = u32(e + 4);
    const unit = TYPE_SIZE[type];
    if (!unit) continue;
    const total = unit * count;
    let at = e + 8;
    if (total > 4) { at = u32(e + 8); }
    if (!Number.isFinite(total) || total < 0 || at + total > t.length) { entries.set(tag, { type, count, bad: true }); continue; }
    entries.set(tag, { type, count, at, total, unit });
  }
  const next = offset + 2 + n * 12 + 4 <= t.length ? u32(offset + 2 + n * 12) : 0;
  out.value = (tag) => decode(t, little, entries.get(tag));
  out.has = (tag) => entries.has(tag);
  out.entry = (tag) => entries.get(tag);
  out.tags = [...entries.keys()];
  return next;
}

function decode(t, little, e) {
  if (!e || e.bad) return undefined;
  const u16 = (o) => (little ? t.readUInt16LE(o) : t.readUInt16BE(o));
  const u32 = (o) => (little ? t.readUInt32LE(o) : t.readUInt32BE(o));
  const s32 = (o) => (little ? t.readInt32LE(o) : t.readInt32BE(o));
  if (e.type === 2) return t.toString('utf8', e.at, e.at + Math.min(e.total, 2000)).replace(/\0.*$/s, '').trim();
  if (e.type === 7 || e.type === 1) return t.subarray(e.at, e.at + Math.min(e.total, 4096));
  const vals = [];
  for (let i = 0; i < Math.min(e.count, 16); i++) {
    const o = e.at + i * e.unit;
    if (e.type === 3) vals.push(u16(o));
    else if (e.type === 4) vals.push(u32(o));
    else if (e.type === 5) { const d = u32(o + 4); vals.push(d ? u32(o) / d : NaN); }
    else if (e.type === 10) { const d = s32(o + 4); vals.push(d ? s32(o) / d : NaN); }
    else if (e.type === 8) vals.push(little ? t.readInt16LE(o) : t.readInt16BE(o));
    else if (e.type === 9) vals.push(s32(o));
  }
  return vals;
}

/** Reads what it can; a damaged block yields whatever was readable before the damage, never an exception. */
function parseExif(tiff) {
  const res = blankExif();
  try { readExif(tiff, res); } catch { /* out-of-range read inside a damaged block: keep what we have */ }
  return res;
}
function blankExif() {
  return { orientation: 1, make: '', model: '', software: '', description: '', artist: '', copyright: '', date: '', owner: '', serials: [],
    lens: '', userComment: '', xp: [], gps: null, hasGpsIfd: false, thumbnail: 0, makerNote: 0, uniqueId: '' };
}
function readExif(tiff, res) {
  if (tiff.length < 12) return res;
  const bom = tiff.toString('latin1', 0, 2);
  if (bom !== 'II' && bom !== 'MM') return res;
  const little = bom === 'II';
  if ((little ? tiff.readUInt16LE(2) : tiff.readUInt16BE(2)) !== 42) return res;
  const u32 = (o) => (little ? tiff.readUInt32LE(o) : tiff.readUInt32BE(o));
  const seen = new Set();
  const ifd0 = {};
  const next0 = readIfd(tiff, little, u32(4), seen, ifd0);
  if (!ifd0.value) return res;
  const str = (ifd, tag) => { const v = ifd.value(tag); return typeof v === 'string' ? v : ''; };
  const o = ifd0.value(0x0112);
  if (Array.isArray(o) && o[0] >= 1 && o[0] <= 8) res.orientation = o[0];
  Object.assign(res, { make: str(ifd0, 0x010f), model: str(ifd0, 0x0110), software: str(ifd0, 0x0131), description: str(ifd0, 0x010e),
    artist: str(ifd0, 0x013b), copyright: str(ifd0, 0x8298), date: str(ifd0, 0x0132) });
  for (const [tag, name] of [[0x9c9d, 'Author'], [0x9c9c, 'Comment'], [0x9c9f, 'Subject'], [0x9c9b, 'Title'], [0x9c9e, 'Keywords']]) {
    const v = ifd0.value(tag);
    if (Buffer.isBuffer(v) && v.length >= 2) { const s = v.toString('utf16le').replace(/\0.*$/s, '').trim(); if (s) res.xp.push(`${name}: ${s}`); }
  }
  const sub = (ptrTag) => {
    const v = ifd0.value(ptrTag);
    return Array.isArray(v) && v[0] ? v[0] : 0;
  };
  const exifOff = sub(0x8769);
  if (exifOff) {
    const ex = {};
    readIfd(tiff, little, exifOff, seen, ex);
    if (ex.value) {
      const d = str(ex, 0x9003) || str(ex, 0x9004);
      if (d) res.date = d;
      res.owner = str(ex, 0xa430);
      for (const [tag, label] of [[0xa431, 'Camera body'], [0xa435, 'Lens']]) { const s = str(ex, tag); if (s) res.serials.push(`${label} serial ${s}`); }
      res.lens = [str(ex, 0xa433), str(ex, 0xa434)].filter(Boolean).join(' ');
      res.uniqueId = str(ex, 0xa420);
      const uc = ex.value(0x9286);
      if (Buffer.isBuffer(uc) && uc.length > 8) {
        const kind = uc.toString('latin1', 0, 8);
        res.userComment = (kind.startsWith('UNICODE') ? uc.subarray(8).toString('utf16le') : uc.subarray(8).toString('utf8')).replace(/\0.*$/s, '').trim();
      }
      const mn = ex.entry(0x927c);
      if (mn && !mn.bad) res.makerNote = mn.total;
    }
  }
  const gpsOff = sub(0x8825);
  if (gpsOff) {
    const g = {};
    readIfd(tiff, little, gpsOff, seen, g);
    if (g.value) {
      res.hasGpsIfd = g.tags.length > 0;
      const dms = (tag, refTag, neg) => {
        const v = g.value(tag), ref = str(g, refTag).toUpperCase();
        if (!Array.isArray(v) || v.length < 3 || v.some((x) => !Number.isFinite(x))) return null;
        const deg = v[0] + v[1] / 60 + v[2] / 3600;
        return ref === neg ? -deg : deg;
      };
      const lat = dms(0x0002, 0x0001, 'S'), lon = dms(0x0004, 0x0003, 'W');
      const alt = g.value(0x0006);
      if (lat != null && lon != null && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) {
        res.gps = { lat, lon, altitude: Array.isArray(alt) && Number.isFinite(alt[0]) ? alt[0] : null };
      }
    }
  }
  if (next0 && next0 + 2 < tiff.length) {
    const th = {};
    readIfd(tiff, little, next0, seen, th);
    if (th.value) {
      const len = th.value(0x0202);
      if (Array.isArray(len) && len[0] > 0) res.thumbnail = len[0];
      else if (th.has(0x0111)) res.thumbnail = 1; // uncompressed strips: size unknown, but a picture is there
    }
  }
  return res;
}

/** Turn parsed EXIF into findings. */
function exifFindings(x, where) {
  const f = [];
  const add = (key, label, detail, level) => f.push({ key, label, detail, level });
  if (x.gps) add('gps', 'Location (GPS)', `${Math.abs(x.gps.lat).toFixed(5)}° ${x.gps.lat >= 0 ? 'N' : 'S'}, ${Math.abs(x.gps.lon).toFixed(5)}° ${x.gps.lon >= 0 ? 'E' : 'W'}${x.gps.altitude != null ? `, altitude ${Math.round(x.gps.altitude)} m` : ''}`, 'high');
  else if (x.hasGpsIfd) add('gps', 'Location block (GPS)', 'A GPS section is present (no usable coordinates)', 'medium');
  const cam = [x.make, x.model].filter(Boolean).join(' ');
  if (cam) add('camera', 'Camera', cam + (x.lens ? `, ${x.lens}` : ''), 'medium');
  if (x.serials.length) add('serial', 'Serial numbers', x.serials.join('; '), 'high');
  const who = [x.artist && `Artist: ${x.artist}`, x.owner && `Owner: ${x.owner}`, x.copyright && `Copyright: ${x.copyright}`, ...x.xp.filter((s) => /^(Author|Comment|Subject|Title|Keywords):/.test(s))].filter(Boolean);
  if (who.length) add('owner', 'Names and notes', who.join('; '), 'high');
  if (x.date) add('datetime', 'Date and time taken', x.date, 'medium');
  if (x.software) add('software', 'Software', x.software, 'low');
  if (x.description || x.userComment) add('description', 'Description / comment', [x.description, x.userComment].filter(Boolean).join(' | ').slice(0, 200), 'medium');
  if (x.uniqueId) add('serial', 'Unique image ID', x.uniqueId, 'medium');
  if (x.thumbnail) add('thumbnail', 'Embedded thumbnail', x.thumbnail > 1 ? `${x.thumbnail} bytes (can show an uncropped version of the photo)` : 'present', 'medium');
  if (x.makerNote) add('makernote', 'Maker notes', `${x.makerNote} bytes of manufacturer data (may contain serial numbers)`, 'medium');
  if (!f.length) add('exif', 'EXIF block', `present (${where})`, 'info');
  return f;
}

// ---- JPEG ----------------------------------------------------------------------------------------------------------
/** Split a JPEG into segments. The entropy-coded data after a Start-of-Scan belongs to that scan's segment. */
function jpegWalk(buf) {
  const segs = [];
  let p = 2;
  for (;;) {
    if (p + 1 >= buf.length) fail('This JPEG is cut off (no end marker)');
    if (buf[p] !== 0xff) fail(`This JPEG is damaged (unexpected data at byte ${p})`);
    while (buf[p + 1] === 0xff) p++; // fill bytes
    const m = buf[p + 1];
    if (m === 0xd9) { segs.push({ m, start: p, end: p + 2 }); return { segs, end: p + 2 }; }
    if (m === 0x01 || (m >= 0xd0 && m <= 0xd8)) { segs.push({ m, start: p, end: p + 2 }); p += 2; continue; }
    if (p + 4 > buf.length) fail('This JPEG is cut off');
    const len = buf.readUInt16BE(p + 2);
    if (len < 2 || p + 2 + len > buf.length) fail('This JPEG is damaged (a segment runs past the end of the file)');
    const seg = { m, start: p, end: p + 2 + len, data: p + 4 };
    segs.push(seg);
    p = seg.end;
    if (m === 0xda) {
      let q = p;
      for (;;) {
        q = buf.indexOf(0xff, q);
        if (q < 0 || q + 1 >= buf.length) fail('This JPEG is cut off (the picture data has no end)');
        const n = buf[q + 1];
        if (n === 0x00 || (n >= 0xd0 && n <= 0xd7)) { q += 2; continue; }
        if (n === 0xff) { q += 1; continue; }
        break;
      }
      seg.end = q;
      p = q;
    }
  }
}
const isIcc = (buf, s) => s.m === 0xe2 && buf.toString('latin1', s.data, s.data + 12) === 'ICC_PROFILE\0';
const XMP_ID = 'http://ns.adobe.com/xap/1.0/\0';
const XMP_EXT_ID = 'http://ns.adobe.com/xmp/extension/\0';
const isExifSeg = (buf, s) => s.m === 0xe1 && buf.toString('latin1', s.data, s.data + 6) === 'Exif\0\0';
const isXmpSeg = (buf, s) => s.m === 0xe1 && (buf.toString('latin1', s.data, s.data + XMP_ID.length) === XMP_ID || buf.toString('latin1', s.data, s.data + XMP_EXT_ID.length) === XMP_EXT_ID);
const isAdobe = (buf, s) => s.m === 0xee && buf.toString('latin1', s.data, s.data + 5) === 'Adobe';
const isJfif = (buf, s) => s.m === 0xe0 && buf.toString('latin1', s.data, s.data + 5) === 'JFIF\0';
/** Segments that carry the picture itself (everything that decides what the pixels are). */
const isPictureSeg = (buf, s) => (s.m >= 0xc0 && s.m <= 0xcf) || s.m === 0xdb || s.m === 0xdd || s.m === 0xda || s.m === 0xdc || s.m === 0xde || s.m === 0xdf || isAdobe(buf, s);

function xmpFindings(text, size) {
  const f = [{ key: 'xmp', label: 'XMP metadata', detail: `${size} bytes (editing history, creator tools, sometimes names or places)`, level: 'medium' }];
  const grab = (name) => { const m = new RegExp(`${name}(?:="([^"]*)"|>([^<]*)<)`).exec(text); return m ? (m[1] || m[2] || '').trim() : ''; };
  const lat = grab('exif:GPSLatitude'), lon = grab('exif:GPSLongitude');
  if (lat && lon) f.push({ key: 'gps', label: 'Location (in XMP)', detail: `${lat}, ${lon}`, level: 'high' });
  return f;
}

function scanJpeg(buf) {
  const { segs, end } = jpegWalk(buf);
  const findings = [];
  let exif = null;
  const other = (s) => findings.push({ key: 'other', label: 'Other embedded data', detail: `APP${s.m - 0xe0} segment, ${s.end - s.start} bytes`, level: 'low' });
  for (const s of segs) {
    if (s.m < 0xe0 || s.m > 0xef) {
      if (s.m === 0xfe) findings.push({ key: 'comment', label: 'Comment', detail: buf.toString('utf8', s.data, Math.min(s.end, s.data + 160)).replace(/\0.*$/s, '').trim() || `${s.end - s.start} bytes`, level: 'low' });
      continue;
    }
    if (s.m === 0xe0) {
      if (!isJfif(buf, s)) findings.push({ key: 'thumbnail', label: 'Extra thumbnail (JFXX)', detail: `${s.end - s.start} bytes`, level: 'low' });
      else if (buf[s.data + 12] * buf[s.data + 13] > 0) findings.push({ key: 'thumbnail', label: 'JFIF thumbnail', detail: `${buf[s.data + 12]}x${buf[s.data + 13]} preview`, level: 'low' });
    } else if (s.m === 0xe1) {
      if (isExifSeg(buf, s)) { if (!exif) exif = parseExif(buf.subarray(s.data + 6, s.end)); else other(s); }
      else if (isXmpSeg(buf, s)) findings.push(...xmpFindings(buf.toString('utf8', s.data + XMP_ID.length, s.end), s.end - s.start));
      else other(s);
    } else if (s.m === 0xe2) {
      if (isIcc(buf, s)) continue;
      if (buf.toString('latin1', s.data, s.data + 4) === 'MPF\0') findings.push({ key: 'trailing', label: 'Extra embedded pictures', detail: 'Multi-picture data (previews or depth maps stored inside the file)', level: 'medium' });
      else other(s);
    } else if (s.m === 0xed) findings.push({ key: 'iptc', label: 'Photoshop / IPTC data', detail: `${s.end - s.start} bytes (captions, credits, keywords, places)`, level: 'medium' });
    else if (s.m === 0xeb && buf.toString('latin1', s.data, s.data + 2) === 'JP') findings.push({ key: 'credentials', label: 'Content credentials (C2PA)', detail: 'Provenance data; removing it means the photo can no longer prove where it came from', level: 'info' });
    else if (s.m === 0xee && isAdobe(buf, s)) continue;
    else other(s);
  }
  if (exif) findings.unshift(...exifFindings(exif, 'EXIF'));
  const trailing = buf.length - end;
  if (trailing > 0) findings.push({ key: 'trailing', label: 'Hidden data after the picture', detail: `${trailing} bytes follow the end of the image (some phones append video or previews here)`, level: 'medium' });
  const picture = crypto.createHash('sha256');
  for (const s of segs) if (isPictureSeg(buf, s)) picture.update(buf.subarray(s.start, s.end));
  return { findings, orientation: exif ? exif.orientation : 1, picture: picture.digest('hex'), _segs: segs, _end: end };
}

/** The tiny EXIF block we write back to keep a photo the right way up: one tag, Orientation. */
function orientationSegment(o) {
  const t = Buffer.alloc(26);
  t.write('MM', 0, 'latin1'); t.writeUInt16BE(42, 2); t.writeUInt32BE(8, 4);
  t.writeUInt16BE(1, 8); t.writeUInt16BE(0x0112, 10); t.writeUInt16BE(3, 12); t.writeUInt32BE(1, 14); t.writeUInt16BE(o, 18);
  const head = Buffer.alloc(10); head[0] = 0xff; head[1] = 0xe1; head.writeUInt16BE(2 + 6 + t.length, 2); head.write('Exif\0\0', 4, 'latin1');
  return Buffer.concat([head, t]);
}

function cleanJpeg(buf, opts, scan) {
  const parts = [Buffer.from([0xff, 0xd8])];
  const extra = []; // what we kept that is not the picture: for the report
  let placed = false;
  const placeOrientation = () => {
    if (placed) return; placed = true;
    if (opts.keepOrientation && scan.orientation > 1) { parts.push(orientationSegment(scan.orientation)); extra.push('orientation'); }
  };
  for (const s of scan._segs) {
    if (s.m === 0xd8) continue;
    if (s.m === 0xd9) continue; // we write our own end marker
    if (isJfif(buf, s)) {
      let seg = buf.subarray(s.start, s.end);
      if (buf[s.data + 12] * buf[s.data + 13] > 0) { // a thumbnail hidden in the JFIF header: keep the 14-byte header, drop the rest
        seg = Buffer.from(buf.subarray(s.start, s.start + 18));
        seg.writeUInt16BE(16, 2); seg[16] = 0; seg[17] = 0; // length 16; thumbnail width and height 0
      }
      parts.push(seg); continue;
    }
    placeOrientation();
    if (isPictureSeg(buf, s) || (s.m >= 0xc0 && s.m <= 0xdf)) { parts.push(buf.subarray(s.start, s.end)); continue; } // tables, SOF, scans: untouched
    if (isIcc(buf, s) && opts.keepColor) { parts.push(buf.subarray(s.start, s.end)); extra.push('colour profile'); continue; }
    // every other APPn / COM segment is metadata and is left out
  }
  placeOrientation();
  parts.push(Buffer.from([0xff, 0xd9]));
  return { data: Buffer.concat(parts), kept: extra };
}

// ---- PNG -----------------------------------------------------------------------------------------------------------
function pngWalk(buf) {
  const chunks = [];
  let p = 8;
  for (;;) {
    if (p + 12 > buf.length) fail('This PNG is cut off (no end chunk)');
    const len = buf.readUInt32BE(p);
    const type = buf.toString('latin1', p + 4, p + 8);
    if (!/^[A-Za-z]{4}$/.test(type) || p + 12 + len > buf.length) fail('This PNG is damaged (a chunk runs past the end of the file)');
    chunks.push({ type, start: p, data: p + 8, len, end: p + 12 + len });
    p += 12 + len;
    if (type === 'IEND') return { chunks, end: p };
  }
}
const PNG_KEEP = new Set(['IHDR', 'PLTE', 'IDAT', 'IEND', 'tRNS', 'gAMA', 'cHRM', 'sRGB', 'sBIT', 'bKGD', 'hIST', 'pHYs', 'sPLT', 'acTL', 'fcTL', 'fdAT']);
const PNG_COLOUR = new Set(['iCCP', 'cICP', 'mDCV', 'cLLI']);
const PNG_PICTURE = new Set(['IHDR', 'PLTE', 'IDAT', 'tRNS', 'acTL', 'fcTL', 'fdAT']);
const isCritical = (type) => type[0] >= 'A' && type[0] <= 'Z';

function scanPng(buf) {
  const { chunks, end } = pngWalk(buf);
  const findings = [];
  const textKeys = [];
  let exif = null, xmpSeen = false;
  for (const c of chunks) {
    if (c.type === 'eXIf' && !exif) exif = parseExif(buf.subarray(c.data, c.data + c.len));
    else if (c.type === 'tEXt' || c.type === 'zTXt' || c.type === 'iTXt') {
      const nul = buf.indexOf(0, c.data);
      const key = nul > c.data && nul < c.data + c.len ? buf.toString('latin1', c.data, nul) : '(unnamed)';
      if (c.type === 'iTXt' && key === 'XML:com.adobe.xmp') {
        xmpSeen = true;
        findings.push(...xmpFindings(buf.toString('utf8', Math.min(nul + 1, c.data + c.len), c.data + c.len), c.len));
      } else {
        let preview = '';
        if (c.type === 'tEXt') preview = buf.toString('latin1', nul + 1, Math.min(c.data + c.len, nul + 1 + 140)).replace(/\0/g, ' ').trim();
        textKeys.push({ key, preview, size: c.len });
      }
    } else if (c.type === 'tIME') findings.push({ key: 'time', label: 'Last-modified time', detail: c.len === 7 ? `${buf.readUInt16BE(c.data)}-${String(buf[c.data + 2]).padStart(2, '0')}-${String(buf[c.data + 3]).padStart(2, '0')}` : 'present', level: 'low' });
    else if (c.type === 'caBX') findings.push({ key: 'credentials', label: 'Content credentials (C2PA)', detail: 'Provenance data; removing it means the image can no longer prove where it came from', level: 'info' });
    else if (!isCritical(c.type) && !PNG_KEEP.has(c.type) && !PNG_COLOUR.has(c.type) && !['eXIf', 'tIME', 'tEXt', 'zTXt', 'iTXt', 'caBX'].includes(c.type)) {
      findings.push({ key: 'other', label: 'Other embedded data', detail: `"${c.type}" chunk, ${c.len} bytes`, level: 'low' });
    }
  }
  if (exif) findings.unshift(...exifFindings(exif, 'eXIf'));
  if (textKeys.length) {
    const ai = textKeys.find((t) => /^(parameters|prompt|workflow|Comment|Dream|sd-metadata|invokeai_metadata)$/i.test(t.key));
    findings.push({ key: 'text', label: ai ? 'Text notes (may include an AI prompt)' : 'Text notes', detail: textKeys.map((t) => (t.preview ? `${t.key}: ${t.preview}` : `${t.key} (${t.size} bytes)`)).join(' | ').slice(0, 300), level: 'medium' });
  }
  const trailing = buf.length - end;
  if (trailing > 0) findings.push({ key: 'trailing', label: 'Hidden data after the picture', detail: `${trailing} bytes follow the end of the image`, level: 'medium' });
  const picture = crypto.createHash('sha256');
  for (const c of chunks) if (PNG_PICTURE.has(c.type) || (isCritical(c.type) && !PNG_KEEP.has(c.type))) picture.update(buf.subarray(c.start, c.end));
  void xmpSeen;
  return { findings, orientation: 1, picture: picture.digest('hex'), _chunks: chunks, _end: end };
}

function cleanPng(buf, opts, scan) {
  const parts = [buf.subarray(0, 8)];
  const kept = [];
  for (const c of scan._chunks) {
    if (PNG_KEEP.has(c.type) || isCritical(c.type)) parts.push(buf.subarray(c.start, c.end));
    else if (PNG_COLOUR.has(c.type) && opts.keepColor) { parts.push(buf.subarray(c.start, c.end)); if (!kept.includes('colour profile')) kept.push('colour profile'); }
  }
  return { data: Buffer.concat(parts), kept };
}

// ---- WebP ----------------------------------------------------------------------------------------------------------
function webpWalk(buf) {
  const riffSize = buf.readUInt32LE(4);
  const end = Math.min(buf.length, 8 + riffSize);
  if (riffSize < 4 || 8 + riffSize > buf.length + 1) fail('This WebP is cut off or damaged');
  const chunks = [];
  let p = 12;
  while (p + 8 <= end) {
    const id = buf.toString('latin1', p, p + 4);
    const len = buf.readUInt32LE(p + 4);
    const stop = p + 8 + len + (len & 1);
    if (p + 8 + len > end) fail('This WebP is damaged (a chunk runs past the end of the file)');
    chunks.push({ id, start: p, data: p + 8, len, end: Math.min(stop, end) });
    p = stop;
  }
  if (!chunks.some((c) => c.id === 'VP8 ' || c.id === 'VP8L' || c.id === 'ANMF')) fail('This WebP has no picture data');
  return { chunks, end };
}
const WEBP_PICTURE = new Set(['VP8 ', 'VP8L', 'ALPH', 'ANIM', 'ANMF']);

function scanWebp(buf) {
  const { chunks, end } = webpWalk(buf);
  const findings = [];
  let exif = null;
  for (const c of chunks) {
    if (c.id === 'EXIF' && !exif) {
      let d = buf.subarray(c.data, c.data + c.len);
      if (d.toString('latin1', 0, 6) === 'Exif\0\0') d = d.subarray(6);
      exif = parseExif(d);
    } else if (c.id === 'XMP ') findings.push(...xmpFindings(buf.toString('utf8', c.data, c.data + c.len), c.len));
    else if (!['VP8X', 'ICCP', 'VP8 ', 'VP8L', 'ALPH', 'ANIM', 'ANMF', 'EXIF'].includes(c.id)) findings.push({ key: 'other', label: 'Other embedded data', detail: `"${c.id}" chunk, ${c.len} bytes`, level: 'low' });
  }
  if (exif) findings.unshift(...exifFindings(exif, 'EXIF'));
  const trailing = buf.length - end;
  if (trailing > 0) findings.push({ key: 'trailing', label: 'Hidden data after the picture', detail: `${trailing} bytes follow the end of the image`, level: 'medium' });
  const picture = crypto.createHash('sha256');
  for (const c of chunks) if (WEBP_PICTURE.has(c.id)) picture.update(buf.subarray(c.start, c.end));
  return { findings, orientation: 1, picture: picture.digest('hex'), _chunks: chunks, _end: end };
}

function cleanWebp(buf, opts, scan) {
  const body = [];
  const kept = [];
  let keepsIcc = false;
  for (const c of scan._chunks) {
    if (c.id === 'VP8X') {
      const h = Buffer.from(buf.subarray(c.start, c.end));
      body.push(h);
    } else if (c.id === 'ICCP') {
      if (opts.keepColor) { keepsIcc = true; body.push(buf.subarray(c.start, c.end)); kept.push('colour profile'); }
    } else if (WEBP_PICTURE.has(c.id)) body.push(buf.subarray(c.start, c.end));
    // EXIF, XMP and anything unknown are left out
  }
  const vp8x = body.find((b) => b.toString('latin1', 0, 4) === 'VP8X');
  if (vp8x) { vp8x[8] &= ~0x08; vp8x[8] &= ~0x04; if (!keepsIcc) vp8x[8] &= ~0x20; }
  const inner = Buffer.concat([Buffer.from('WEBP', 'latin1'), ...body]);
  const head = Buffer.alloc(8); head.write('RIFF', 0, 'latin1'); head.writeUInt32LE(inner.length, 4);
  return { data: Buffer.concat([head, inner]), kept };
}

// ---- public API ----------------------------------------------------------------------------------------------------
function scanBuffer(buf) {
  const format = detect(buf);
  if (!format) fail('Not a JPEG, PNG or WebP picture');
  const r = format === 'jpeg' ? scanJpeg(buf) : format === 'png' ? scanPng(buf) : scanWebp(buf);
  const findings = r.findings.sort((a, b) => LEVEL_ORDER[b.level] - LEVEL_ORDER[a.level]);
  const privacy = findings.filter((f) => f.level !== 'info');
  return {
    format, bytes: buf.length, findings, orientation: r.orientation, picture: r.picture,
    risk: findings.reduce((m, f) => (LEVEL_ORDER[f.level] > LEVEL_ORDER[m] ? f.level : m), 'info'),
    clean: privacy.length === 0, // nothing to remove (content credentials alone do not count)
    _scan: r,
  };
}

function cleanBuffer(buf, opts = {}) {
  const o = { keepColor: opts.keepColor !== false, keepOrientation: opts.keepOrientation !== false };
  const before = scanBuffer(buf);
  const r = before.format === 'jpeg' ? cleanJpeg(buf, o, before._scan) : before.format === 'png' ? cleanPng(buf, o, before._scan) : cleanWebp(buf, o, before._scan);
  // Verify: same picture data, nothing sensitive left
  const after = scanBuffer(r.data);
  if (after.picture !== before.picture) throw new Error('Safety check failed: the picture data would have changed. Nothing was written.');
  const left = after.findings.filter((f) => f.level !== 'info' && !(f.key === 'exif'));
  if (left.length) throw new Error(`Safety check failed: ${left[0].label} would remain. Nothing was written.`);
  if (before.format === 'jpeg' && o.keepOrientation && before.orientation !== after.orientation) throw new Error('Safety check failed: the rotation would have changed. Nothing was written.');
  const strip = ({ _scan, ...rest }) => rest;
  return { data: r.data, kept: r.kept, before: strip(before), after: strip(after), removed: before.findings.filter((f) => f.level !== 'info' || f.key === 'credentials') };
}

function uniquePath(dir, base, ext) {
  const safe = base.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 120) || 'photo';
  let c = path.join(dir, safe + ext);
  for (let i = 1; fs.existsSync(c); i++) c = path.join(dir, `${safe} (${i})${ext}`);
  return c;
}

async function readFileChecked(file) {
  if (!path.isAbsolute(file)) fail('Input path must be absolute');
  let st;
  try { st = await fs.promises.stat(file); } catch { fail(`Cannot read ${path.basename(file)}`); }
  if (!st.isFile()) fail(`${path.basename(file)} is not a file`);
  if (st.size > MAX_BYTES) fail(`${path.basename(file)} is larger than ${MAX_BYTES / 1048576} MB`);
  return fs.promises.readFile(file);
}

async function scanFile(file) {
  const buf = await readFileChecked(file);
  try {
    const { _scan, picture, ...r } = scanBuffer(buf);
    return r;
  } catch (e) {
    if (e instanceof UserError) throw new UserError(`${path.basename(file)}: ${e.message}`);
    throw e;
  }
}

/** Write "<name>-clean.<ext>" next to the original (or into outDir). The original is never touched. */
async function cleanFile(file, opts = {}) {
  const buf = await readFileChecked(file);
  let r;
  try { r = cleanBuffer(buf, opts); } catch (e) { if (e instanceof UserError) throw new UserError(`${path.basename(file)}: ${e.message}`); throw e; }
  const dir = opts.outDir || path.dirname(file);
  await fs.promises.mkdir(dir, { recursive: true });
  const ext = EXT[r.before.format];
  const final = uniquePath(dir, `${path.basename(file, path.extname(file))}-clean`, ext);
  const part = `${final}.${process.pid}.part`;
  try {
    await fs.promises.writeFile(part, r.data);
    fs.renameSync(part, final);
  } catch (e) { fs.rmSync(part, { force: true }); throw e; }
  return { output: final, inBytes: buf.length, outBytes: r.data.length, removed: r.removed, kept: r.kept };
}

module.exports = { scanBuffer, cleanBuffer, scanFile, cleanFile, parseExif, detect, isSupportedName, orientationSegment, uniquePath, UserError, EXT };
