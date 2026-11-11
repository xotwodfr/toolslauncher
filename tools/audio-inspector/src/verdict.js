'use strict';
// The verdict: from what the file says about itself and what was measured, the plain-words answer.
//
// The heart of it is the cutoff: lossy encoders (MP3, AAC, Vorbis) throw away the highest frequencies to save bits, with a
// steep low-pass (MP3 at 128 kbps stops at 16-17 kHz, 192 kbps at about 19 kHz, 320 kbps at about 20 kHz). Decoding such
// a file and saving it as FLAC or WAV keeps that hole forever. A real 44.1 kHz recording has sound up to about 21-22 kHz
// (where its own anti-aliasing filter sits). So the averaged spectrum of the whole song is searched for a "cliff": a fall of
// 25 dB or more within about a kilohertz, with nothing coming back above it. Where it sits says what happened:
//   - below ~20.2 kHz in a lossless file: made from a lossy file ("Fake lossless")
//   - 20.2-21 kHz: either a 320 kbps source or the recording's own filter ("Can't tell")
//   - a hi-res file (88.2 kHz and up) with a cliff at 21-26.5 kHz: upsampled from 44.1 / 48 kHz
// Natural spectra never fall like that: music loses a few dB per octave towards the top, not 25 dB in a kilohertz.
// Without a cliff, sound near the top means "Real lossless"; none means a quiet or naturally band-limited recording,
// which honestly cannot be told apart ("Can't tell").

/** The spectrum in bands of `width` Hz (power mean), as dB. */
function bands(db, binHz, width = 100) {
  const n = Math.floor(((db.length - 1) * binHz) / width);
  const out = new Float64Array(n);
  for (let b = 0; b < n; b++) {
    const k0 = Math.max(1, Math.round((b * width) / binHz)); const k1 = Math.max(k0 + 1, Math.round(((b + 1) * width) / binHz));
    let s = 0; let c = 0;
    for (let k = k0; k < k1 && k < db.length; k++) { s += Math.pow(10, db[k] / 10); c++; }
    out[b] = c ? 10 * Math.log10(s / c + 1e-30) : -300;
  }
  return out;
}

/** Mean of band levels (in dB, so a single loud tone does not dominate) between two frequencies. */
function meanDb(L, width, f0, f1) {
  const a = Math.max(0, Math.floor(f0 / width)); const b = Math.min(L.length, Math.ceil(f1 / width));
  let s = 0; let c = 0;
  for (let i = a; i < b; i++) { s += L[i]; c++; }
  return c ? s / c : -300;
}
function maxDb(L, width, f0, f1) {
  const a = Math.max(0, Math.floor(f0 / width)); const b = Math.min(L.length, Math.ceil(f1 / width));
  let m = -300;
  // 3-band median, so one stray tone (a mains hum harmonic, a pilot tone) does not count as "sound coming back"
  for (let i = a + 1; i < b - 1; i++) { const v = [L[i - 1], L[i], L[i + 1]].sort((x, y) => x - y)[1]; if (v > m) m = v; }
  return m;
}

/**
 * Find the cliff: the highest-confidence steep fall in the spectrum with nothing coming back above it.
 * @param {Float64Array} L band levels (dB)  @param {number} width band width (Hz)  @param {number} nyq
 * @returns {{ hz: number, drop: number } | null}
 */
function findCliff(L, width, nyq) {
  const top = nyq - 400;
  const qualifies = (f) => {
    const below = meanDb(L, width, f - 1500, f - 300);
    const above = meanDb(L, width, f + 300, Math.min(f + 1500, nyq - 100));
    const drop = below - above;
    if (drop < 25) return null;
    const rest = maxDb(L, width, f + 300, nyq * 0.985);
    if (rest > below - 18) return null;                   // sound comes back higher up: not a cut
    return { f, drop, below, above };
  };
  // the LOWEST place that qualifies: a resampler or the end of the band can make a second, deeper fall higher up
  let first = null;
  for (let f = 3000; f <= top && !first; f += width) first = qualifies(f);
  if (!first) return null;
  let best = first;
  for (let f = first.f + width; f <= Math.min(top, first.f + 1500); f += width) { const q = qualifies(f); if (q && q.drop > best.drop) best = q; }
  // the cutoff is where the sound falls 10 dB under the level just before the fall
  // (measured a little before the fall: a soft resampling filter starts falling a few kHz before the 25 dB point)
  const plateau = meanDb(L, width, first.f - 5000, first.f - 3000);
  let hz = best.f;
  for (let f = first.f - 3000; f <= best.f + 1500; f += width) { const i = Math.floor(f / width); if (i >= 0 && i < L.length && L[i] < plateau - 10) { hz = f; break; } }
  return { hz, drop: best.drop };
}

/** What a cutoff frequency usually means for an MP3/AAC's bitrate. */
function bitrateGuess(hz) {
  if (hz < 11500) return 'a very low bitrate, 64 kbps or less';
  if (hz < 15000) return '~96 kbps';
  if (hz < 16600) return '~128 kbps';
  if (hz < 17900) return '~128–160 kbps';
  if (hz < 19300) return '~192 kbps';
  return '~256–320 kbps';
}

const kHz = (hz) => (hz / 1000).toFixed(1).replace(/\.0$/, '.0') + ' kHz';
const rateName = (fs) => (fs % 1000 === 0 ? `${fs / 1000} kHz` : `${(fs / 1000).toFixed(1)} kHz`);
/** The theoretical noise floor of the FFT bins for `bits`-bit samples (undithered quantisation, white). */
const floorFor = (bits, N) => 10 * Math.log10((Math.pow(2, -(bits - 1)) ** 2 / 12) * (6 / N));

/**
 * @param {object} info  probe.js facts
 * @param {object} m     analyse.js measurements
 */
function verdict(info, m) {
  const nyq = m.sampleRate / 2;
  const width = 100;
  const L = bands(m.spectrum.db, m.spectrum.binHz, width);
  const N = Math.round(m.sampleRate / m.spectrum.binHz);
  const bits = info.lossless ? (m.effectiveBits || info.bitsDeclared || 24) : 24;
  const floor = info.lossless && !info.float ? floorFor(Math.min(bits, 24), N) : floorFor(24, N);
  const cliff = m.spectrum.frames >= 8 ? findCliff(L, width, nyq) : null;
  const sfb = m.sfb21 || { counted: 0, dead: 0, present: 0 };
  const sfbHoles = sfb.counted >= 40 && sfb.dead / sfb.counted >= 0.15 && sfb.present / sfb.counted >= 0.05;
  const quiet = m.spectrum.frames < 8 || !(m.samplePeakDb > -45) || m.silence.all;
  const flags = [];
  const fmtName = info.codecName;
  const v = { kind: 'unsure', chip: "Can't tell", title: '', explain: '', cutoffHz: cliff ? cliff.hz : null, cliffDb: cliff ? Math.round(cliff.drop) : null, sfb21: sfbHoles, flags };

  // ---- the bits really used -------------------------------------------------------------------------------------------------
  v.really16 = !!(info.lossless && !info.float && info.bitsDeclared >= 24 && m.effectiveBits && m.effectiveBits <= 16);
  if (v.really16) flags.push({ kind: 'warn', code: 'bits', text: `Really ${m.effectiveBits}-bit: stored as ${info.bitsDeclared}-bit, but the lowest ${info.bitsDeclared - m.effectiveBits} bits of every sample are zero (padded)` });
  else if (info.lossless && !info.float && info.bitsDeclared === 32 && m.effectiveBits && m.effectiveBits <= 24) flags.push({ kind: 'info', code: 'bits', text: `Really ${m.effectiveBits}-bit (stored as 32-bit)` });

  // ---- the frequencies -----------------------------------------------------------------------------------------------------------
  if (!info.lossless) {
    const kbps = info.streamBitrate || info.containerBitrate || 0;
    v.kind = 'lossy';
    v.chip = `Lossy (${fmtName}${kbps ? ' ' + kbps + ' kbps' : ''})`;
    v.title = `Lossy file: ${fmtName}${kbps ? ` at ${kbps} kbps` : ''}`;
    if (cliff && cliff.hz < 20200) {
      v.explain = `The sound stops at ${kHz(cliff.hz)}` + (/^(mp3|aac)$/.test(info.codec) ? `, as usual for ${bitrateGuess(cliff.hz)}.` : '.');
      if (kbps >= 256 && cliff.hz < 17000) { v.explain = `Probably re-encoded from a lower bitrate (${bitrateGuess(cliff.hz)}): the sound stops at ${kHz(cliff.hz)}, but ${kbps} kbps would keep it up to about 20 kHz.`; flags.push({ kind: 'warn', code: 'transcode', text: `Upconverted: ${kbps} kbps on the label, ${bitrateGuess(cliff.hz)} in sound` }); }
    } else v.explain = cliff ? `The sound reaches ${kHz(cliff.hz)}.` : 'No sharp cutoff in the sound.';
  } else if (quiet) {
    v.kind = 'unsure'; v.chip = "Can't tell"; v.title = "Can't tell (quiet or band-limited recording)";
    v.explain = m.silence.all ? 'The file is silent.' : 'There is too little sound in this file to judge it.';
  } else {
    const what = info.codec === 'flac' ? 'FLAC' : /^pcm_/.test(info.codec) ? (info.container === 'aiff' ? 'AIFF' : 'WAV') : info.codec === 'alac' ? 'ALAC file' : fmtName;
    const hiRes = m.sampleRate > 50000;
    if (cliff && cliff.hz < 20200) {
      v.kind = 'fake'; v.chip = 'Fake lossless'; v.title = 'Fake lossless file';
      v.explain = `This ${what} was probably made from a lossy file (MP3/AAC ${bitrateGuess(cliff.hz)}): the sound stops at ${kHz(cliff.hz)}.` + (hiRes ? ` It was also upsampled to ${rateName(m.sampleRate)}.` : '') + (sfbHoles ? ' It also has the on-and-off gaps above 16 kHz that the LAME MP3 encoder leaves.' : '');
    } else if (hiRes && cliff && cliff.hz <= 26500) {
      const from = cliff.hz < 23000 ? 44100 : 48000;
      v.kind = 'upsampled'; v.chip = 'Upsampled'; v.title = `Upsampled from ${rateName(from)}`;
      v.explain = `This ${rateName(m.sampleRate)} file has nothing above ${kHz(cliff.hz)}: it was made from a ${rateName(from)} recording, so the extra resolution is empty.`;
    } else if (!hiRes && cliff && cliff.hz < 21000) {
      v.kind = 'unsure'; v.chip = "Can't tell"; v.title = "Can't tell (high-bitrate lossy or a filtered recording)";
      v.explain = `The sound stops at ${kHz(cliff.hz)}: that fits a 320 kbps MP3/AAC source, but some real recordings are filtered there too.`;
    } else if (sfbHoles) {
      v.kind = 'fake'; v.chip = 'Fake lossless'; v.title = 'Fake lossless file';
      v.explain = `This ${what} was probably made from an MP3: the sound above 16 kHz switches off and on from moment to moment, the way the LAME encoder leaves it.`;
    } else {
      const probeHi = hiRes ? [Math.max(25000, nyq * 0.55), Math.min(nyq * 0.8, 40000)] : [nyq * 0.9, nyq * 0.95];
      const topLevel = meanDb(L, width, probeHi[0], probeHi[1]);
      const reach = (() => { for (let i = Math.min(L.length - 1, Math.floor((nyq * 0.985) / width)); i > 0; i--) if (L[i] > floor + 15) return (i + 1) * width; return 0; })();
      if (topLevel > floor + 15) {
        v.kind = 'real'; v.chip = 'Real lossless'; v.title = hiRes ? 'Real high resolution' : 'Real lossless';
        v.explain = hiRes ? `There is sound up to ${kHz(reach)}, beyond what a 44.1 / 48 kHz file can hold.` : `The sound reaches ${kHz(reach)}, as in a real ${rateName(m.sampleRate)} recording.`;
      } else {
        v.kind = 'unsure'; v.chip = "Can't tell"; v.title = "Can't tell (quiet or band-limited recording)";
        v.explain = hiRes ? `Nothing much above ${kHz(Math.max(reach, 1000))}, but no sharp edge either: a quiet top end or a naturally limited recording.` : `The sound fades out by ${kHz(Math.max(reach, 1000))} without a sharp edge: a dark or old recording, or heavy filtering. Lossy sources usually leave a sharp edge.`;
      }
      if (reach) v.reachHz = reach;
    }
  }

  // ---- other things worth knowing ------------------------------------------------------------------------------------------------
  const c = m.clipping;
  if (c.runs > 0) flags.push({ kind: 'err', code: 'clip', text: `Clipping: ${c.runs.toLocaleString('en-US')} place${c.runs === 1 ? '' : 's'} where the wave is flattened at full scale (${c.samples.toLocaleString('en-US')} samples)` });
  if (c.overs > 0) flags.push({ kind: 'warn', code: 'over', text: `${c.overs.toLocaleString('en-US')} samples above full scale (decoded over 0 dBFS)` });
  if (m.truePeakDb > 0.05) flags.push({ kind: 'warn', code: 'tp', text: `True peak +${m.truePeakDb.toFixed(1)} dBTP: over 0, may distort when played or converted` });
  const dc = m.dcOffset.reduce((a, x) => (Math.abs(x) > Math.abs(a) ? x : a), 0);
  if (Math.abs(dc) >= 0.002) flags.push({ kind: 'warn', code: 'dc', text: `DC offset ${(dc * 100 >= 0 ? '+' : '')}${(dc * 100).toFixed(2)}% (the wave is shifted off centre)` });
  if (m.mono && m.mono.identical) flags.push({ kind: 'info', code: 'mono', text: 'Mono in stereo: both channels are identical' });
  else if (m.mono && m.mono.sideDb < -50) flags.push({ kind: 'info', code: 'mono', text: 'Practically mono: the two channels are almost the same' });
  if (!m.silence.all && m.silence.start >= 2) flags.push({ kind: 'info', code: 'silence', text: `${m.silence.start.toFixed(1)} s of silence at the start` });
  if (!m.silence.all && m.silence.end >= 3) flags.push({ kind: 'info', code: 'silence', text: `${m.silence.end.toFixed(1)} s of silence at the end` });
  if (m.damaged) flags.push({ kind: 'err', code: 'damaged', text: `Damaged: decoding stopped early (${m.damaged})` });
  return v;
}

module.exports = { bands, findCliff, bitrateGuess, floorFor, verdict, meanDb };
