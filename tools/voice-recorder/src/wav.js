'use strict';
// WAV files for takes: written while recording (so a crash keeps the audio), fixed up on stop, and recovered on the next
// start if the app never got to stop. Electron-free so it can be tested with plain Node.
//
// Layout we write:  RIFF <size> WAVE | fmt (16 bytes, PCM 16-bit) | data <size> <samples...> | [cue ] [LIST adtl labels]
// While recording, the RIFF and data sizes are refreshed every few seconds, so even a file nobody fixed plays up to then.
let fs;
try { fs = require('original-fs'); } catch { fs = require('fs'); }

const HEADER_BYTES = 44;

function header({ sampleRate, channels = 1, bitsPerSample = 16, dataBytes = 0 }) {
  const b = Buffer.alloc(HEADER_BYTES);
  const blockAlign = channels * (bitsPerSample / 8);
  b.write('RIFF', 0, 'ascii');
  b.writeUInt32LE(Math.min(0xffffffff, 36 + dataBytes), 4);
  b.write('WAVE', 8, 'ascii');
  b.write('fmt ', 12, 'ascii');
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(bitsPerSample === 32 ? 3 : 1, 20); // 1 = integer PCM, 3 = float
  b.writeUInt16LE(channels, 22);
  b.writeUInt32LE(sampleRate, 24);
  b.writeUInt32LE(sampleRate * blockAlign, 28);
  b.writeUInt16LE(blockAlign, 32);
  b.writeUInt16LE(bitsPerSample, 34);
  b.write('data', 36, 'ascii');
  b.writeUInt32LE(Math.min(0xffffffff, dataBytes), 40);
  return b;
}

/** Markers as a `cue ` chunk plus LIST/adtl labels (Audacity, Reaper, Adobe Audition and others read these). */
function cueChunks(markers, sampleRate) {
  const list = (markers || []).filter((m) => m && Number.isFinite(m.t) && m.t >= 0);
  if (!list.length) return Buffer.alloc(0);
  const cue = Buffer.alloc(12 + 24 * list.length);
  cue.write('cue ', 0, 'ascii');
  cue.writeUInt32LE(4 + 24 * list.length, 4);
  cue.writeUInt32LE(list.length, 8);
  list.forEach((m, i) => {
    const o = 12 + 24 * i;
    const pos = Math.round(m.t * sampleRate);
    cue.writeUInt32LE(i + 1, o); cue.writeUInt32LE(pos, o + 4); cue.write('data', o + 8, 'ascii');
    cue.writeUInt32LE(0, o + 12); cue.writeUInt32LE(0, o + 16); cue.writeUInt32LE(pos, o + 20);
  });
  const labels = list.map((m, i) => {
    const text = Buffer.from(String(m.label || `Marker ${i + 1}`).slice(0, 200) + '\0', 'utf8');
    const pad = text.length % 2;
    const c = Buffer.alloc(12 + text.length + pad);
    c.write('labl', 0, 'ascii'); c.writeUInt32LE(4 + text.length, 4); c.writeUInt32LE(i + 1, 8); text.copy(c, 12);
    return c;
  });
  const body = Buffer.concat(labels);
  const head = Buffer.alloc(12);
  head.write('LIST', 0, 'ascii'); head.writeUInt32LE(4 + body.length, 4); head.write('adtl', 8, 'ascii');
  return Buffer.concat([cue, head, body]);
}

/** Read the chunks of a WAV file (only the headers, never the audio). */
function inspect(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const read = (pos, n) => { const b = Buffer.alloc(n); const got = fs.readSync(fd, b, 0, n, pos); return b.subarray(0, got); };
    const top = read(0, 12);
    if (top.length < 12 || top.toString('ascii', 0, 4) !== 'RIFF' || top.toString('ascii', 8, 12) !== 'WAVE') throw new Error('This is not a WAV file');
    const out = { size, riffSize: top.readUInt32LE(4), fmt: null, dataOffset: -1, dataBytes: 0, declaredDataBytes: 0, markers: [] };
    const cues = new Map(); const labels = new Map();
    let pos = 12;
    while (pos + 8 <= size) {
      const h = read(pos, 8);
      const id = h.toString('ascii', 0, 4);
      let len = h.readUInt32LE(4);
      if (id === 'data') {
        out.dataOffset = pos + 8;
        out.declaredDataBytes = len;
        // A take that was never fixed says 0 (or more than there is): the audio runs to the end of the file then.
        if (len === 0 || len === 0xffffffff || pos + 8 + len > size) len = size - pos - 8;
        out.dataBytes = len;
      } else if (id === 'fmt ') {
        const f = read(pos + 8, Math.min(len, 40));
        out.fmt = { format: f.readUInt16LE(0), channels: f.readUInt16LE(2), sampleRate: f.readUInt32LE(4), blockAlign: f.readUInt16LE(12), bitsPerSample: f.readUInt16LE(14) };
      } else if (id === 'cue ') {
        const c = read(pos + 8, Math.min(len, 4 + 24 * 10000));
        const n = c.readUInt32LE(0);
        for (let i = 0; i < n && 4 + 24 * (i + 1) <= c.length; i++) cues.set(c.readUInt32LE(4 + 24 * i), c.readUInt32LE(4 + 24 * i + 20));
      } else if (id === 'LIST') {
        const c = read(pos + 8, Math.min(len, 1 << 20));
        if (c.toString('ascii', 0, 4) === 'adtl') {
          let p = 4;
          while (p + 8 <= c.length) {
            const sid = c.toString('ascii', p, p + 4); const sl = c.readUInt32LE(p + 4);
            if (sid === 'labl' && sl >= 4) labels.set(c.readUInt32LE(p + 8), c.toString('utf8', p + 12, p + 8 + sl).replace(/\0+$/, ''));
            p += 8 + sl + (sl % 2);
          }
        }
      }
      pos += 8 + len + (len % 2);
    }
    if (!out.fmt || out.dataOffset < 0) throw new Error('The WAV file has no audio in it');
    out.dataBytes -= out.dataBytes % out.fmt.blockAlign;
    out.duration = out.dataBytes / (out.fmt.sampleRate * out.fmt.blockAlign);
    if (out.fmt.sampleRate) out.markers = [...cues.entries()].sort((a, b) => a[1] - b[1]).map(([id, s]) => ({ t: s / out.fmt.sampleRate, label: labels.get(id) || '' }));
    return out;
  } finally { fs.closeSync(fd); }
}

/**
 * A take being recorded. Samples arrive as Int16 PCM buffers; the file is valid (with honest sizes) every `syncEvery` ms.
 * finish() writes the final sizes and the markers, then renames `<final>.part` to the final name.
 */
class WavWriter {
  constructor(partPath, { sampleRate, channels = 1, syncEvery = 2000 } = {}) {
    if (!(sampleRate >= 8000 && sampleRate <= 384000)) throw new Error('Unsupported sample rate');
    this.path = partPath;
    this.sampleRate = sampleRate;
    this.channels = channels;
    this.blockAlign = 2 * channels;
    this.dataBytes = 0;
    this.syncEvery = syncEvery;
    this.lastSync = Date.now();
    this.fd = fs.openSync(partPath, 'wx'); // never overwrite anything
    fs.writeSync(this.fd, header({ sampleRate, channels, dataBytes: 0 }), 0, HEADER_BYTES, 0);
    this.closed = false;
  }

  get seconds() { return this.dataBytes / (this.sampleRate * this.blockAlign); }

  append(buf) {
    if (this.closed) throw new Error('The recording is already finished');
    const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf.buffer || buf, buf.byteOffset || 0, buf.byteLength);
    const n = b.length - (b.length % this.blockAlign);
    if (!n) return;
    fs.writeSync(this.fd, b, 0, n, HEADER_BYTES + this.dataBytes);
    this.dataBytes += n;
    if (Date.now() - this.lastSync >= this.syncEvery) this.sync();
  }

  /** Refresh the sizes in the header and push everything to the disk. */
  sync() {
    if (this.closed) return;
    fs.writeSync(this.fd, header({ sampleRate: this.sampleRate, channels: this.channels, dataBytes: this.dataBytes }), 0, HEADER_BYTES, 0);
    try { fs.fdatasyncSync(this.fd); } catch { /* not every file system can */ }
    this.lastSync = Date.now();
  }

  /** @returns {string} the final path */
  finish(finalPath, markers) {
    if (this.closed) throw new Error('The recording is already finished');
    let tailBytes = 0;
    if (this.dataBytes % 2) { fs.writeSync(this.fd, Buffer.alloc(1), 0, 1, HEADER_BYTES + this.dataBytes); tailBytes = 1; }
    const extra = cueChunks(markers, this.sampleRate);
    if (extra.length) fs.writeSync(this.fd, extra, 0, extra.length, HEADER_BYTES + this.dataBytes + tailBytes);
    const h = header({ sampleRate: this.sampleRate, channels: this.channels, dataBytes: this.dataBytes });
    h.writeUInt32LE(36 + this.dataBytes + tailBytes + extra.length, 4);
    fs.writeSync(this.fd, h, 0, HEADER_BYTES, 0);
    try { fs.fdatasyncSync(this.fd); } catch { /* ignore */ }
    fs.closeSync(this.fd);
    this.closed = true;
    if (finalPath) { fs.renameSync(this.path, finalPath); this.path = finalPath; }
    return this.path;
  }

  /** Stop without keeping anything (the part file is removed). */
  discard() {
    if (!this.closed) { try { fs.closeSync(this.fd); } catch { /* ignore */ } this.closed = true; }
    try { fs.rmSync(this.path, { force: true }); } catch { /* ignore */ }
  }
}

/**
 * Make an unfinished take playable: set the sizes from what is actually in the file (cutting a half sample off the end).
 * Returns the duration in seconds, or throws if there is no audio in it.
 */
function repair(file) {
  const info = inspect(file);
  const { fmt } = info;
  const dataBytes = info.dataBytes;
  const fd = fs.openSync(file, 'r+');
  try {
    // only audio we wrote follows the data chunk while recording, so drop any half-written trailing bytes
    if (info.declaredDataBytes !== dataBytes) fs.ftruncateSync(fd, info.dataOffset + dataBytes);
    const h = Buffer.alloc(4);
    h.writeUInt32LE(Math.min(0xffffffff, info.dataOffset - 8 + dataBytes), 0);
    fs.writeSync(fd, h, 0, 4, 4);
    h.writeUInt32LE(dataBytes, 0);
    fs.writeSync(fd, h, 0, 4, info.dataOffset - 4);
    try { fs.fdatasyncSync(fd); } catch { /* ignore */ }
  } finally { fs.closeSync(fd); }
  return dataBytes / (fmt.sampleRate * fmt.blockAlign);
}

/**
 * Stream a WAV file's samples as Float32 mono blocks (channels are averaged). Calls onBlock(samples, startFrame).
 * Reads a block at a time, so an hour-long take does not need an hour of memory.
 */
function readMono(file, onBlock, { blockFrames = 65536, start = 0, end = Infinity } = {}) {
  const info = inspect(file);
  const { fmt } = info;
  const bps = fmt.bitsPerSample / 8;
  const totalFrames = Math.floor(info.dataBytes / fmt.blockAlign);
  const first = Math.max(0, Math.min(totalFrames, Math.floor(start * fmt.sampleRate)));
  const last = Math.max(first, Math.min(totalFrames, Number.isFinite(end) ? Math.ceil(end * fmt.sampleRate) : totalFrames));
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(blockFrames * fmt.blockAlign);
    for (let f = first; f < last; f += blockFrames) {
      const frames = Math.min(blockFrames, last - f);
      const got = fs.readSync(fd, buf, 0, frames * fmt.blockAlign, info.dataOffset + f * fmt.blockAlign);
      const n = Math.floor(got / fmt.blockAlign);
      const out = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        let s = 0;
        for (let c = 0; c < fmt.channels; c++) {
          const o = i * fmt.blockAlign + c * bps;
          if (fmt.format === 3 && bps === 4) s += buf.readFloatLE(o);
          else if (bps === 2) s += buf.readInt16LE(o) / 32768;
          else if (bps === 3) s += buf.readIntLE(o, 3) / 8388608;
          else if (bps === 4) s += buf.readInt32LE(o) / 2147483648;
          else s += (buf[o] - 128) / 128;
        }
        out[i] = s / fmt.channels;
      }
      onBlock(out, f);
      if (n < frames) break;
    }
  } finally { fs.closeSync(fd); }
  return info;
}

/** Float samples (-1..1) to 16-bit PCM, clipping. */
function floatToInt16(f32) {
  const out = Buffer.alloc(f32.length * 2);
  for (let i = 0; i < f32.length; i++) {
    const v = Math.max(-1, Math.min(1, f32[i]));
    out.writeInt16LE(Math.round(v < 0 ? v * 32768 : v * 32767), i * 2);
  }
  return out;
}

/** Write a whole mono float signal as a 16-bit WAV (used by tests, the self-test and the e2e fixtures). */
function writeFloatWav(file, samples, sampleRate) {
  const data = floatToInt16(samples);
  fs.writeFileSync(file, Buffer.concat([header({ sampleRate, channels: 1, dataBytes: data.length }), data]));
  return file;
}

module.exports = { HEADER_BYTES, header, cueChunks, inspect, WavWriter, repair, readMono, floatToInt16, writeFloatWav };
