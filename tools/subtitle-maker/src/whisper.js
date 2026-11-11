'use strict';
// Whisper speech recognition on onnxruntime: log-mel -> encoder -> greedy decoding with the model's own timestamp tokens,
// window by window over the whole song. The decoding rules follow OpenAI's reference implementation (whisper/decoding.py and
// transcribe.py): the language is found from the first window, timestamps must come in pairs and never go backwards, a window
// that sounds silent is skipped, and a window that looks like a loop or a guess (a repeated text, a low average probability)
// is decoded again with a little randomness. Electron-free: the caller passes in the onnxruntime module.
// Subtitle Maker's copy (from Lyrics Maker): the retry rules are the reference's values for speech, and the task can be
// "translate" (Whisper's own translation into English: the <|translate|> task token instead of <|transcribe|>).
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const Mel = require('./mel');

const TIME_PRECISION = 0.02;          // seconds per timestamp token
const FRAMES_PER_TIMESTAMP = 2;       // 10 ms mel frames per timestamp step
const MAX_TOKENS = 224;               // per 30 second window (half of the decoder's context)
// Retry rules: the reference's values for speech (repetition 2.4, probability -1.0). Every retry costs a full decode, so a
// window is tried at most three times, with more randomness each time.
const TEMPERATURES = [0, 0.4, 0.8];
const COMPRESSION_THRESHOLD = 2.4;
const LOGPROB_THRESHOLD = -1.0;
const NO_SPEECH_THRESHOLD = 0.6;
const MIN_ADVANCE_FRAMES = 50;        // always move forward at least half a second

const cancelled = () => Object.assign(new Error('Cancelled'), { cancelled: true });

// ---- the model's files ---------------------------------------------------------------------------------------------------------
/** GPT-2's byte <-> printable character table, to turn token strings back into bytes. */
function byteDecoder() {
  const bs = []; for (let b = 33; b <= 126; b++) bs.push(b); for (let b = 161; b <= 172; b++) bs.push(b); for (let b = 174; b <= 255; b++) bs.push(b);
  const cs = bs.slice(); let n = 0;
  for (let b = 0; b < 256; b++) if (!bs.includes(b)) { bs.push(b); cs.push(256 + n); n++; }
  const map = new Map();
  for (let i = 0; i < bs.length; i++) map.set(String.fromCharCode(cs[i]), bs[i]);
  return map;
}

/** Read the files in `dir` and work out everything the decoder needs: special token ids, suppressed tokens, text pieces. */
function loadAssets(dir) {
  const gen = JSON.parse(fs.readFileSync(path.join(dir, 'generation_config.json'), 'utf8'));
  const cfg = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
  const tok = JSON.parse(fs.readFileSync(path.join(dir, 'tokenizer.json'), 'utf8'));
  const eot = gen.eos_token_id;                    // 50257
  const dec = byteDecoder();
  const pieces = new Array(eot);                   // id -> bytes of that piece of text
  for (const [str, id] of Object.entries(tok.model.vocab)) {
    if (id >= eot) continue;
    const bytes = []; for (const ch of str) bytes.push(dec.get(ch));
    pieces[id] = Buffer.from(bytes);
  }
  const langs = {};
  for (const [token, id] of Object.entries(gen.lang_to_id)) langs[token.replace(/[<>|]/g, '')] = id;
  return {
    eot, sot: gen.decoder_start_token_id,
    transcribe: gen.task_to_id.transcribe,
    translate: gen.task_to_id.translate,
    noTimestamps: gen.no_timestamps_token_id,
    timestampBegin: gen.no_timestamps_token_id + 1,
    noSpeech: 50362,                               // <|nocaptions|>, the multilingual models' "no speech" token
    maxInitialTimestamp: gen.max_initial_timestamp_index == null ? 50 : gen.max_initial_timestamp_index,
    suppress: Int32Array.from(gen.suppress_tokens || []),
    beginSuppress: Int32Array.from(gen.begin_suppress_tokens || []),
    alignmentHeads: gen.alignment_heads || [],
    langs, langIds: Object.values(langs),
    vocab: cfg.vocab_size, layers: cfg.decoder_layers, heads: cfg.decoder_attention_heads, dModel: cfg.d_model,
    pieces,
  };
}

/** Text of the tokens (special tokens and timestamps are skipped). */
function detokenize(T, ids) {
  const parts = [];
  for (const id of ids) if (id < T.eot && T.pieces[id]) parts.push(T.pieces[id]);
  return Buffer.concat(parts).toString('utf8').replace(/�/g, '').trim();
}

// ---- decoding rules ------------------------------------------------------------------------------------------------------------------
function logSumExp(a, from, to) {
  let m = -Infinity;
  for (let i = from; i < to; i++) if (a[i] > m) m = a[i];
  if (m === -Infinity) return -Infinity;
  let s = 0;
  for (let i = from; i < to; i++) s += Math.exp(a[i] - m);
  return m + Math.log(s);
}

/**
 * Apply the reference implementation's token rules to the next-token scores, in place.
 * @param {Float32Array} logits  scores for every token
 * @param {number[]} seq         tokens chosen so far in this window (after the prompt)
 */
function applyRules(logits, seq, T) {
  const V = logits.length;
  for (let i = 0; i < T.suppress.length; i++) logits[T.suppress[i]] = -Infinity;
  logits[T.noTimestamps] = -Infinity;
  if (seq.length === 0) for (let i = 0; i < T.beginSuppress.length; i++) logits[T.beginSuppress[i]] = -Infinity; // no blank, no instant end
  const tb = T.timestampBegin;
  const lastWasTs = seq.length >= 1 && seq[seq.length - 1] >= tb;
  const penultimateWasTs = seq.length < 2 || seq[seq.length - 2] >= tb;
  if (lastWasTs) {
    if (penultimateWasTs) for (let i = tb; i < V; i++) logits[i] = -Infinity;      // a pair is complete: now it must be text (or the end)
    else for (let i = 0; i < T.eot; i++) logits[i] = -Infinity;                    // one timestamp is open: the next must be a timestamp (or the end)
  }
  let lastTs = -1;
  for (let i = 0; i < seq.length; i++) if (seq[i] >= tb) lastTs = seq[i];
  if (lastTs >= 0) { const from = lastWasTs && !penultimateWasTs ? lastTs : lastTs + 1; for (let i = tb; i < from; i++) logits[i] = -Infinity; } // time never goes backwards
  if (seq.length === 0) {
    for (let i = 0; i < tb; i++) logits[i] = -Infinity;                              // the window must start with a timestamp
    for (let i = tb + T.maxInitialTimestamp + 1; i < V; i++) logits[i] = -Infinity;  // and not too late in it
  }
  // when the timestamps together are likelier than any single piece of text, a timestamp it is
  const total = logSumExp(logits, 0, V);
  const tsLog = logSumExp(logits, tb, V) - total;
  let maxText = -Infinity;
  for (let i = 0; i < tb; i++) if (logits[i] > maxText) maxText = logits[i];
  if (tsLog > maxText - total) for (let i = 0; i < tb; i++) logits[i] = -Infinity;
}

/**
 * Turn the tokens of one window into timed segments, as the reference does: a segment is the text between two timestamps.
 * @returns {{ segments: {start:number,end:number,tokens:number[]}[], advance: number }}  advance = mel frames to move on by
 */
function parseSegments(tokens, timeOffset, segmentDuration, segmentFrames, T) {
  const tb = T.timestampBegin;
  const isTs = tokens.map((t) => t >= tb);
  const singleEnding = isTs.length >= 2 && !isTs[isTs.length - 2] && isTs[isTs.length - 1];
  const consecutive = [];
  for (let i = 0; i + 1 < isTs.length; i++) if (isTs[i] && isTs[i + 1]) consecutive.push(i + 1);
  const segments = [];
  let advance;
  if (consecutive.length > 0) {
    const slices = consecutive.slice();
    if (singleEnding) slices.push(tokens.length);
    let last = 0;
    for (const cur of slices) {
      const part = tokens.slice(last, cur);
      segments.push({ start: timeOffset + (part[0] - tb) * TIME_PRECISION, end: timeOffset + (part[part.length - 1] - tb) * TIME_PRECISION, tokens: part });
      last = cur;
    }
    advance = singleEnding ? segmentFrames : (tokens[last - 1] - tb) * FRAMES_PER_TIMESTAMP;
  } else {
    let duration = segmentDuration;
    const stamps = tokens.filter((t) => t >= tb);
    if (stamps.length > 0 && stamps[stamps.length - 1] !== tb) duration = (stamps[stamps.length - 1] - tb) * TIME_PRECISION;
    segments.push({ start: timeOffset, end: timeOffset + duration, tokens });
    advance = segmentFrames;
  }
  if (!(advance >= MIN_ADVANCE_FRAMES)) advance = segmentFrames;
  return { segments, advance: Math.min(advance, segmentFrames) };
}

const compressionRatio = (text) => { const b = Buffer.from(text, 'utf8'); return b.length ? b.length / zlib.deflateSync(b).length : 0; };

/** Is this stretch of audio silent enough to skip without asking the model (which would only invent words)? */
function isSilent(win) {
  let peak = 0; let sum = 0;
  for (let i = 0; i < win.length; i++) { const v = Math.abs(win[i]); if (v > peak) peak = v; sum += v * v; }
  return peak < 0.002 || Math.sqrt(sum / Math.max(1, win.length)) < 0.0003;
}

/** Repeating the same line again and again is how Whisper fails on music: keep at most two in a row. */
function dropLoops(segments) {
  const out = []; let run = 0;
  for (const s of segments) {
    const prev = out[out.length - 1];
    const norm = s.text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
    if (prev && prev.norm === norm) run++; else run = 1;
    if (run <= 2) out.push({ ...s, norm });
  }
  return out.map(({ norm, ...rest }) => rest);
}

// ---- word timing (cross-attention + dynamic time warping, as in the reference implementation's find_alignment) ----------------------------
/** Median of every 7 neighbours along a row (the ends are mirrored), the way the reference smooths the attention. */
function medianFilter(row, width = 7) {
  const n = row.length; const half = width >> 1;
  const out = new Float32Array(n); const win = new Float32Array(width);
  for (let i = 0; i < n; i++) {
    for (let k = -half; k <= half; k++) { let j = i + k; if (j < 0) j = -j; if (j >= n) j = 2 * (n - 1) - j; win[k + half] = row[Math.max(0, Math.min(n - 1, j))]; }
    win.sort(); out[i] = win[half];
  }
  return out;
}

/**
 * Dynamic time warping: the cheapest monotone path through cost[rows][cols], moving diagonally, down or across.
 * @returns {{ text: number[], time: number[] }} the path, from the first row/column to the last
 */
function dtw(cost, rows, cols) {
  const W = cols + 1;
  const D = new Float64Array((rows + 1) * W).fill(Infinity);
  const trace = new Int8Array((rows + 1) * W).fill(-1);
  D[0] = 0;
  for (let j = 1; j <= cols; j++) {
    for (let i = 1; i <= rows; i++) {
      const c0 = D[(i - 1) * W + (j - 1)]; const c1 = D[(i - 1) * W + j]; const c2 = D[i * W + (j - 1)];
      let best; let t;
      if (c0 <= c1 && c0 <= c2) { best = c0; t = 0; } else if (c1 <= c0 && c1 <= c2) { best = c1; t = 1; } else { best = c2; t = 2; }
      D[i * W + j] = cost[(i - 1) * cols + (j - 1)] + best; trace[i * W + j] = t;
    }
  }
  for (let j = 0; j <= cols; j++) trace[j] = 2;       // along the top edge the only way is across
  for (let i = 0; i <= rows; i++) trace[i * W] = 1;    // along the left edge the only way is down
  const text = []; const time = [];
  let i = rows; let j = cols;
  while (i > 0 || j > 0) {
    text.push(i - 1); time.push(j - 1);
    const t = trace[i * W + j];
    if (t === 0) { i--; j--; } else if (t === 1) i--; else j--;
  }
  return { text: text.reverse(), time: time.reverse() };
}

/** The moment each row (token) begins, from a DTW path: the first time column reached on that row. */
function jumpTimes(path, seconds = TIME_PRECISION) {
  const out = [];
  for (let k = 0; k < path.text.length; k++) if (k === 0 || path.text[k] !== path.text[k - 1]) out.push(path.time[k] * seconds);
  return out;
}

/**
 * Dynamic time warping has to cover every time column, so a word next to a pause is stretched over it: the first word of a window
 * "begins" at the start of the window however long the silence before it, and a word before an instrumental break runs on into it.
 * These two helpers pull such words back, from the audio when it is really quiet there, otherwise by plain plausibility.
 */
/** Level of each 20 ms frame of samples[from, to) (seconds), as RMS. */
function frameLevels(samples, sampleRate, t0, t1, frame = 0.02) {
  const n = Math.max(0, Math.floor((t1 - t0) / frame));
  const out = new Float32Array(n); const size = Math.round(frame * sampleRate);
  const base = Math.round(t0 * sampleRate);
  for (let i = 0; i < n; i++) {
    let sum = 0; const from = base + i * size;
    for (let k = 0; k < size; k++) { const v = samples[from + k] || 0; sum += v * v; }
    out[i] = Math.sqrt(sum / size);
  }
  return out;
}

/**
 * If the first part of [t0, t1) is really quiet (well under the level of the rest), the time where sound begins; else null.
 * @returns {number|null}
 */
function quietOnset(samples, sampleRate, t0, t1) {
  const lv = frameLevels(samples, sampleRate, t0, t1);
  if (lv.length < 8) return null;
  let peak = 0; for (const v of lv) if (v > peak) peak = v;
  if (peak < 0.002) return null;
  const loud = peak * 0.12;
  let i = 0; while (i < lv.length && lv[i] < loud) i++;
  if (i < 10 || i >= lv.length) return null;                       // less than 0.2 s of quiet: nothing to correct
  let prefix = 0; for (let k = 0; k < i; k++) prefix += lv[k]; prefix /= i;
  if (prefix > peak * 0.06) return null;                           // not really quiet (music playing under the voice)
  return t0 + Math.max(0, i - 2) * 0.02;
}
/** The mirror image: the time where sound ends if the last part of [t0, t1) is really quiet, else null. */
function quietOffset(samples, sampleRate, t0, t1) {
  const lv = frameLevels(samples, sampleRate, t0, t1);
  if (lv.length < 8) return null;
  let peak = 0; for (const v of lv) if (v > peak) peak = v;
  if (peak < 0.002) return null;
  const loud = peak * 0.12;
  let i = lv.length - 1; while (i >= 0 && lv[i] < loud) i--;
  const quiet = lv.length - 1 - i;
  if (quiet < 10 || i < 0) return null;
  let tail = 0; for (let k = i + 1; k < lv.length; k++) tail += lv[k]; tail /= quiet;
  if (tail > peak * 0.06) return null;
  return t0 + (i + 3) * 0.02;
}

/**
 * Pull the first and last word of a segment back when dynamic time warping stretched them over a pause.
 * @param {{text:string,start:number,end:number}[]} words  absolute times, in order
 */
function trimEdges(words, samples, sampleRate, median) {
  if (!words.length) return words;
  const trigger = Math.max(1.2, 4 * median);
  const cap = Math.max(0.8, 3 * median);
  const first = words[0]; const last = words[words.length - 1];
  if (first.end - first.start > 0.4) {
    const onset = quietOnset(samples, sampleRate, first.start, first.end);
    if (onset != null && onset > first.start) first.start = Math.min(onset, first.end - 0.05);
    else if (first.end - first.start > trigger) first.start = first.end - cap;
  }
  if (last.end - last.start > 0.4) {
    const offset = quietOffset(samples, sampleRate, last.start, last.end);
    if (offset != null && offset < last.end) last.end = Math.max(offset, last.start + 0.05);
    else if (last.end - last.start > trigger && last !== first) last.end = last.start + cap;
  }
  return words;
}

const NO_SPACE_LANGUAGES = new Set(['zh', 'ja', 'th', 'lo', 'my', 'yue', 'km']);
/** Group a window's text tokens into words: a new word starts at a token that begins with a space (or, for languages written without spaces, at every complete character). */
function splitWords(T, tokens, lang) {
  const words = [];
  if (NO_SPACE_LANGUAGES.has(lang)) {
    let bytes = []; let first = 0;
    tokens.forEach((id, i) => {
      bytes.push(T.pieces[id] || Buffer.alloc(0));
      const text = Buffer.concat(bytes).toString('utf8');
      if (!text.includes('\uFFFD')) { words.push({ first, last: i, text: text.trim() }); bytes = []; first = i + 1; }
    });
    return words.filter((w) => w.text);
  }
  tokens.forEach((id, i) => {
    const piece = T.pieces[id] || Buffer.alloc(0);
    if (i === 0 || piece[0] === 0x20 || !words.length) words.push({ first: i, last: i, parts: [piece] });
    else { const w = words[words.length - 1]; w.last = i; w.parts.push(piece); }
  });
  return words.map((w) => ({ first: w.first, last: w.last, text: Buffer.concat(w.parts).toString('utf8').replace(/\uFFFD/g, '').trim() })).filter((w) => w.text);
}

function rngFrom(seed) { let s = seed >>> 0 || 1; return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }

// ---- the engine --------------------------------------------------------------------------------------------------------------------------
/**
 * @param {object} o
 * @param {object} o.ort     the onnxruntime-node module
 * @param {string} o.dir     folder with the model files (see scripts/fetch-model.js)
 * @param {object} [o.options] onnxruntime session options
 */
async function createWhisper({ ort, dir, options = {}, decoderOptions }) {
  const T = loadAssets(dir);
  const encoder = await ort.InferenceSession.create(path.join(dir, 'encoder_model_int8.onnx'), options);
  const decoder = await ort.InferenceSession.create(path.join(dir, 'decoder_model_merged_int8.onnx'), decoderOptions || options);
  const headDim = T.dModel / T.heads;
  const stats = { windows: 0, encodeMs: 0, stepMs: 0, steps: 0, alignMs: 0, melMs: 0, attempts: 0 };
  const empty = () => new ort.Tensor('float32', new Float32Array(0), [1, T.heads, 0, headDim]);

  async function encode(mel) {
    const t0 = Date.now();
    const out = await encoder.run({ input_features: new ort.Tensor('float32', mel, [1, Mel.N_MELS, Mel.N_FRAMES]) });
    stats.encodeMs += Date.now() - t0;
    return out.last_hidden_state;
  }

  /** One decoder pass over `ids`, continuing from `past`. Returns the scores for the next token and the new cache. */
  async function step(ids, enc, past) {
    const feeds = {
      input_ids: new ort.Tensor('int64', BigInt64Array.from(ids, (x) => BigInt(x)), [1, ids.length]),
      encoder_hidden_states: enc,
      use_cache_branch: new ort.Tensor('bool', [!!past], [1]),
    };
    for (let l = 0; l < T.layers; l++) for (const kind of ['decoder', 'encoder']) for (const kv of ['key', 'value']) {
      const name = `${kind}.${kv}`;
      feeds[`past_key_values.${l}.${name}`] = past ? past[`${l}.${name}`] : empty();
    }
    const t0 = Date.now();
    const out = await decoder.run(feeds);
    stats.stepMs += Date.now() - t0; stats.steps++;
    const V = T.vocab;
    const rows = out.logits.dims[1];
    const logits = Float32Array.from(out.logits.data.subarray((rows - 1) * V, rows * V));
    const next = {};
    for (let l = 0; l < T.layers; l++) for (const kind of ['decoder', 'encoder']) for (const kv of ['key', 'value']) {
      const name = `${l}.${kind}.${kv}`;
      next[name] = kind === 'encoder' && past ? past[name] : out[`present.${name}`]; // the encoder's keys and values never change
    }
    return { logits, past: next };
  }

  /**
   * Time every word of `textTokens` (one window's text, no timestamp tokens): run the decoder once over the whole text, take the
   * cross-attention of the alignment heads, smooth it and warp it onto the audio. Returns word times in seconds from the window start.
   */
  async function alignWords(enc, lang, textTokens, frames, task = 'transcribe') {
    if (!textTokens.length || !T.alignmentHeads.length) return [];
    const ids = [T.sot, T.langs[lang], task === 'translate' ? T.translate : T.transcribe, T.noTimestamps, ...textTokens, T.eot];
    const L = ids.length;
    const feeds = {
      input_ids: new ort.Tensor('int64', BigInt64Array.from(ids, (x) => BigInt(x)), [1, L]),
      encoder_hidden_states: enc,
      use_cache_branch: new ort.Tensor('bool', [false], [1]),
    };
    for (let l = 0; l < T.layers; l++) for (const kind of ['decoder', 'encoder']) for (const kv of ['key', 'value']) feeds[`past_key_values.${l}.${kind}.${kv}`] = empty();
    const t0 = Date.now();
    const out = await decoder.run(feeds);
    stats.alignMs += Date.now() - t0;
    const SRC = out['cross_attentions.0'].dims[3];                    // 1500 encoder positions, 20 ms each
    const F = Math.max(8, Math.min(SRC, Math.ceil(frames / 2)));      // only the part that is real audio
    const rowsFrom = 3;                                               // after the 3 prompt tokens: <|notimestamps|> is the first row
    const nRows = L - 1 - rowsFrom;                                   // up to, not including, the final end-of-text row
    const acc = new Float32Array(nRows * F);
    for (const [layer, head] of T.alignmentHeads) {
      const data = out[`cross_attentions.${layer}`].data;
      const base = head * L * SRC;
      // normalise each time column over all tokens, then smooth along time
      const mean = new Float64Array(F); const sd = new Float64Array(F);
      for (let f = 0; f < F; f++) {
        let m = 0; for (let r = 0; r < L; r++) m += data[base + r * SRC + f]; m /= L;
        let v = 0; for (let r = 0; r < L; r++) { const d = data[base + r * SRC + f] - m; v += d * d; }
        mean[f] = m; sd[f] = Math.sqrt(v / L) || 1;
      }
      const row = new Float32Array(F);
      for (let r = 0; r < nRows; r++) {
        for (let f = 0; f < F; f++) row[f] = (data[base + (r + rowsFrom) * SRC + f] - mean[f]) / sd[f];
        const sm = medianFilter(row, 7);
        for (let f = 0; f < F; f++) acc[r * F + f] += sm[f] / T.alignmentHeads.length;
      }
    }
    const cost = new Float32Array(acc.length);
    for (let i = 0; i < acc.length; i++) cost[i] = -acc[i];            // DTW looks for the cheapest path, attention is "strongest"
    const jt = jumpTimes(dtw(cost, nRows, F));
    const words = splitWords(T, textTokens, lang).map((w) => ({ text: w.text, first: w.first, last: w.last, start: jt[w.first], end: jt[Math.min(jt.length - 1, w.last + 1)] }))
      .filter((w) => Number.isFinite(w.start) && Number.isFinite(w.end));
    return words;
  }

  const softmaxAt = (logits, id) => Math.exp(logits[id] - logSumExp(logits, 0, logits.length));

  /** Decode one window with one temperature. */
  async function decodeWindow(enc, lang, temperature, rng, shouldStop, tick = null, task = 'transcribe') {
    const first = await step([T.sot], enc, null);
    const noSpeech = softmaxAt(first.logits, T.noSpeech);
    if (!lang) {
      let best = -Infinity; let bestCode = 'en';
      for (const [code, id] of Object.entries(T.langs)) if (first.logits[id] > best) { best = first.logits[id]; bestCode = code; }
      lang = bestCode;
    }
    let st = await step([T.langs[lang], task === 'translate' ? T.translate : T.transcribe], enc, first.past);
    const tokens = []; let sumLogprob = 0;
    for (let n = 0; n < MAX_TOKENS; n++) {
      if (shouldStop()) throw cancelled();
      if (tick && n % 6 === 0) tick(n);
      const logits = st.logits;
      applyRules(logits, tokens, T);
      const lse = logSumExp(logits, 0, logits.length);
      let pick = -1;
      if (temperature > 0) {
        // sample from softmax(scores / temperature) among the tokens the rules still allow
        let top = -Infinity;
        for (let i = 0; i < logits.length; i++) if (logits[i] > top) top = logits[i];
        let z = 0;
        for (let i = 0; i < logits.length; i++) if (logits[i] > -Infinity) z += Math.exp((logits[i] - top) / temperature);
        const target = rng() * z;
        let acc = 0;
        for (let i = 0; i < logits.length; i++) {
          if (logits[i] === -Infinity) continue;
          pick = i; acc += Math.exp((logits[i] - top) / temperature);
          if (acc >= target) break;
        }
      } else {
        let best = -Infinity;
        for (let i = 0; i < logits.length; i++) if (logits[i] > best) { best = logits[i]; pick = i; }
      }
      sumLogprob += logits[pick] - lse;
      if (pick === T.eot) break;
      tokens.push(pick);
      st = await step([pick], enc, st.past);
    }
    const text = detokenize(T, tokens);
    return { tokens, lang, noSpeech, avgLogprob: sumLogprob / (tokens.length + 1), compression: compressionRatio(text), temperature };
  }

  async function decodeWithFallback(enc, lang, rng, shouldStop, tick, task) {
    let best = null;
    for (const temperature of TEMPERATURES) {
      stats.attempts++;
      const r = await decodeWindow(enc, lang, temperature, rng, shouldStop, tick, task);
      if (!lang) lang = r.lang;                       // the language is settled by the first window and kept
      let needs = r.compression > COMPRESSION_THRESHOLD || r.avgLogprob < LOGPROB_THRESHOLD;
      if (r.noSpeech > NO_SPEECH_THRESHOLD) needs = false;   // silence: more randomness will not help
      if (!best || r.avgLogprob > best.avgLogprob) best = r;
      if (!needs) { best = r; break; }
    }
    return best;
  }

  /**
   * @param {Float32Array} samples 16 kHz mono
   * @param {{ language?: string, shouldStop?: () => boolean, onSegments?: (segs: object[]) => void, onProgress?: (p: object) => void }} [opts]
   * @returns {Promise<{ language: string, segments: {start:number,end:number,text:string}[] }>}
   */
  async function transcribe(samples, { language = 'auto', task = 'transcribe', shouldStop = () => false, onSegments = () => {}, onProgress = () => {} } = {}) {
    if (task !== 'transcribe' && task !== 'translate') throw Object.assign(new Error('Unknown task: ' + task), { userError: true });
    const contentFrames = Math.floor(samples.length / Mel.HOP);
    const total = samples.length / Mel.SAMPLE_RATE;
    const rng = rngFrom(12345);
    let lang = language === 'auto' ? null : language;
    if (lang && !T.langs[lang]) throw Object.assign(new Error('Unknown language: ' + lang), { userError: true });
    let seek = 0; const all = [];
    const windows = Math.max(1, Math.ceil(contentFrames / Mel.N_FRAMES));
    let started = Date.now();
    while (seek < contentFrames) {
      if (shouldStop()) throw cancelled();
      const timeOffset = seek / 100;
      const segFrames = Math.min(Mel.N_FRAMES, contentFrames - seek);
      onProgress({ seek, contentFrames, seconds: total, fraction: seek / contentFrames, elapsed: (Date.now() - started) / 1000, language: lang });
      const win = samples.subarray(seek * Mel.HOP, Math.min(samples.length, (seek + Mel.N_FRAMES) * Mel.HOP));
      if (isSilent(win)) { seek += segFrames; continue; }
      const tm = Date.now();
      const melInput = Mel.logMel(samples, seek * Mel.HOP);
      stats.melMs += Date.now() - tm; stats.windows++;
      const report = (within) => onProgress({ seek, contentFrames, seconds: total, fraction: Math.min(0.995, (seek + segFrames * within) / contentFrames), elapsed: (Date.now() - started) / 1000, language: lang });
      report(0.05);
      const enc = await encode(melInput);
      if (shouldStop()) throw cancelled();
      report(0.15);
      const r = await decodeWithFallback(enc, lang, rng, shouldStop, (n) => report(0.15 + 0.75 * Math.min(1, n / 150)), task);
      if (!lang) lang = r.lang;
      if (r.noSpeech > NO_SPEECH_THRESHOLD && r.avgLogprob < LOGPROB_THRESHOLD) { seek += segFrames; continue; } // judged to be silence or music only
      const { segments, advance } = parseSegments(r.tokens, timeOffset, segFrames / 100, segFrames, T);
      // word times for the whole window, then each segment takes the words that belong to it
      const textTokens = []; const ranges = [];
      for (const s of segments) { const from = textTokens.length; for (const t of s.tokens) if (t < T.eot) textTokens.push(t); ranges.push([from, textTokens.length]); }
      let words = [];
      try { words = await alignWords(enc, lang || r.lang, textTokens, segFrames, task); } catch (e) { words = []; }   // without word times the segment times of the model are used
      const lengths = words.map((w) => w.end - w.start).filter((d) => d > 0).sort((a, b) => a - b);
      const median = Math.min(0.7, lengths.length ? lengths[lengths.length >> 1] : 0.3);
      const round = (x) => Math.round(x * 100) / 100;
      const fresh = [];
      segments.forEach((s, si) => {
        const text = detokenize(T, s.tokens);
        if (!text) return;
        const mine = trimEdges(words.filter((w) => w.first >= ranges[si][0] && w.first < ranges[si][1]).map((w) => ({ text: w.text, start: Math.min(total, timeOffset + w.start), end: Math.min(total, timeOffset + w.end) })), samples, Mel.SAMPLE_RATE, median);
        let start = s.start; let end = Math.min(total, s.end);
        if (mine.length) { start = mine[0].start; end = Math.max(mine[mine.length - 1].end, start + 0.1); }
        if (end <= start - 1e-6) return;
        fresh.push({ start: round(start), end: round(Math.max(end, start)), text, words: mine.map((w) => ({ text: w.text, start: round(w.start), end: round(Math.max(w.end, w.start)) })) });
      });
      all.push(...fresh);
      onSegments(fresh);
      seek += advance;
    }
    onProgress({ seek: contentFrames, contentFrames, seconds: total, fraction: 1, elapsed: (Date.now() - started) / 1000, windows });
    return { language: lang || 'en', segments: dropLoops(all) };
  }

  return {
    tokens: T, stats, encode, step, decodeWindow, alignWords, transcribe,
    async release() { try { await encoder.release(); } catch { /* ignore */ } try { await decoder.release(); } catch { /* ignore */ } },
  };
}

module.exports = {
  TIME_PRECISION, MAX_TOKENS, TEMPERATURES, cancelled,
  loadAssets, detokenize, applyRules, parseSegments, compressionRatio, isSilent, dropLoops, createWhisper, logSumExp,
  medianFilter, dtw, jumpTimes, splitWords, quietOnset, quietOffset, trimEdges,
};
