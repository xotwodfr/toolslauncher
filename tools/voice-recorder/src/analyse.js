'use strict';
// Reads a take once and works out what the cleaning needs: a short level curve (for the waveform), the noise floor and
// speech level, where the pauses are, and the quietest stretch to learn the noise from. Electron-free.
const W = require('./wav');

const WIN = 0.02; // seconds per level window

/**
 * @returns {{duration:number, sampleRate:number, win:number, db:Float32Array, peaks:Float32Array, floorDb:number,
 *   speechDb:number, peakDb:number, markers:Array}}
 */
function analyse(file) {
  const info = W.inspect(file);
  const sr = info.fmt.sampleRate;
  const size = Math.max(1, Math.round(sr * WIN));
  const windows = Math.ceil((info.dataBytes / info.fmt.blockAlign) / size);
  const db = new Float32Array(windows).fill(-120);
  const peaks = new Float32Array(windows);
  let acc = 0; let pk = 0; let count = 0; let w = 0; let peakAll = 0;
  W.readMono(file, (block) => {
    for (let i = 0; i < block.length; i++) {
      const v = block[i];
      acc += v * v;
      const a = v < 0 ? -v : v;
      if (a > pk) pk = a;
      if (++count === size) {
        db[w] = 10 * Math.log10(acc / count + 1e-12); peaks[w] = pk; if (pk > peakAll) peakAll = pk;
        w++; acc = 0; pk = 0; count = 0;
      }
    }
  });
  if (count && w < windows) { db[w] = 10 * Math.log10(acc / count + 1e-12); peaks[w] = pk; if (pk > peakAll) peakAll = pk; }
  const { floorDb, speechDb } = levels(db);
  return { duration: info.duration, sampleRate: sr, win: WIN, db, peaks, floorDb, speechDb, peakDb: 20 * Math.log10(peakAll + 1e-12), markers: info.markers };
}

function percentile(arr, p) {
  if (!arr.length) return -120;
  const s = Float32Array.from(arr).sort();
  return s[Math.min(s.length - 1, Math.max(0, Math.floor(p * (s.length - 1))))];
}

/** Noise floor = the quiet tenth of the take; speech level = the loud tenth. */
function levels(db) {
  const live = Array.from(db).filter((v) => v > -119);
  return { floorDb: percentile(live, 0.1), speechDb: percentile(live, 0.9) };
}

/** The level below which a window counts as a pause: a third of the way from the noise to the speech, at most 18 dB under it. */
function silenceThreshold(floorDb, speechDb) {
  if (!(speechDb > floorDb + 6)) return floorDb + 3; // no clear speech: only the very quietest counts
  return Math.min(floorDb + (speechDb - floorDb) * 0.33, speechDb - 18 > floorDb + 4 ? speechDb - 18 : floorDb + 4);
}

/**
 * Pauses: stretches where every window is under the threshold for at least `minPause` seconds.
 * @returns {Array<[number, number]>} [start, end] in seconds
 */
function findPauses(db, win, { minPause = 1, threshold, from = 0, to = Infinity } = {}) {
  const out = [];
  let start = -1;
  const a = Math.max(0, Math.floor(from / win)); const b = Math.min(db.length, Math.ceil(Math.min(to, db.length * win) / win));
  for (let i = a; i <= b; i++) {
    const quiet = i < b && db[i] < threshold;
    if (quiet && start < 0) start = i;
    else if (!quiet && start >= 0) {
      if ((i - start) * win >= minPause) out.push([start * win, i * win]);
      start = -1;
    }
  }
  return out;
}

/**
 * Turn pauses longer than `longer` seconds into `keep` seconds: half of the kept silence stays at each side.
 * @returns {Array<[number, number]>} the stretches to cut out
 */
function pauseCuts(pauses, { longer = 1, keep = 0.5 } = {}) {
  const k = Math.max(0, Math.min(keep, longer));
  return pauses.filter(([s, e]) => e - s > longer && e - s > k + 0.02).map(([s, e]) => [s + k / 2, e - k / 2]);
}

/** The quietest stretch of 0.5 to 3 seconds (inside a pause if there is one) - what the noise sounds like on its own. */
function quietestStretch(db, win, { threshold, from = 0, to = Infinity } = {}) {
  const pauses = findPauses(db, win, { minPause: 0.5, threshold, from, to });
  let best = null;
  for (const [s, e] of pauses) {
    const a = s + Math.min(0.1, (e - s) / 4); const b = Math.min(e - Math.min(0.1, (e - s) / 4), a + 3);
    if (b - a < 0.4) continue;
    let sum = 0; let n = 0;
    for (let i = Math.floor(a / win); i < Math.floor(b / win); i++) { sum += db[i]; n++; }
    const mean = sum / Math.max(1, n);
    // longer samples teach the noise better: favour them a little
    const score = mean - Math.min(3, b - a);
    if (!best || score < best.score) best = { start: a, end: b, score, db: mean };
  }
  return best && { start: best.start, end: best.end, db: best.db };
}

/** A small envelope for drawing: `points` max-abs values. */
function waveform(analysis, points = 1200) {
  const { peaks } = analysis;
  const n = Math.max(1, Math.min(points, peaks.length));
  const out = new Array(n).fill(0);
  for (let i = 0; i < peaks.length; i++) { const j = Math.min(n - 1, Math.floor((i * n) / peaks.length)); if (peaks[i] > out[j]) out[j] = peaks[i]; }
  return out.map((v) => Math.round(v * 1000) / 1000);
}

module.exports = { WIN, analyse, levels, percentile, silenceThreshold, findPauses, pauseCuts, quietestStretch, waveform };
