'use strict';
// Whisper speech recognition on onnxruntime: log-mel -> encoder -> greedy decoding with the model's own timestamp tokens,
// window by window over the whole song. The decoding rules follow OpenAI's reference implementation (whisper/decoding.py and
// transcribe.py): the language is found from the first window, timestamps must come in pairs and never go backwards, a window
// that sounds silent is skipped, and a window that looks like a loop or a guess (a repeated text, a low average probability)
// is decoded again with a little randomness. Electron-free: the caller passes in the onnxruntime module.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const Mel = require('./mel');

const TIME_PRECISION = 0.02;          // seconds per timestamp token
const FRAMES_PER_TIMESTAMP = 2;       // 10 ms mel frames per timestamp step
const MAX_TOKENS = 224;               // per 30 second window (half of the decoder's context)
// Retry rules. The reference's values (repetition 2.4, probability -1.0, three retries) are tuned for speech; music trips them
// constantly (a repeated hook is not a loop, a sung line is never as certain as a spoken one) and every retry costs a full decode,
// so for songs they are loosened: only real loops and real guesses are decoded again, once, with a little randomness.
const TEMPERATURES = [0, 0.5];
const COMPRESSION_THRESHOLD = 3.5;
const LOGPROB_THRESHOLD = -1.5;
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
  // special tokens by name (their numbers differ between model sizes: large-v3 has one more language)
  const added = new Map((tok.added_tokens || []).map((t) => [t.content, t.id]));
  const noSpeech = added.get('<|nospeech|>') ?? added.get('<|nocaptions|>') ?? 50362;
  return {
    eot, sot: gen.decoder_start_token_id,
    transcribe: gen.task_to_id.transcribe,
    noTimestamps: gen.no_timestamps_token_id,
    timestampBegin: gen.no_timestamps_token_id + 1,
    noSpeech,                                      // <|nocaptions|> / <|nospeech|>, the "no speech" token
    maxInitialTimestamp: gen.max_initial_timestamp_index == null ? 50 : gen.max_initial_timestamp_index,
    suppress: Int32Array.from(gen.suppress_tokens || []),
    beginSuppress: Int32Array.from(gen.begin_suppress_tokens || []),
    alignmentHeads: gen.alignment_heads || [],
    langs, langIds: Object.values(langs),
    vocab: cfg.vocab_size, layers: cfg.decoder_layers, heads: cfg.decoder_attention_heads, dModel: cfg.d_model,
    nMels: cfg.num_mel_bins || 80,
    pieces,
    bpe: { vocab: tok.model.vocab, merges: tok.model.merges },
  };
}

// ---- text -> tokens (byte-level BPE, as GPT-2 and Whisper's tokenizer) -------------------------------------------------------------
const PRE_TOKENIZE = /'s|'t|'re|'ve|'m|'ll|'d| ?\p{L}+| ?\p{N}+| ?[^\s\p{L}\p{N}]+|\s+(?!\S)|\s+/gu;
/**
 * The token ids of `text` (no special tokens), exactly as Whisper's own tokenizer makes them: split into pieces with GPT-2's
 * pattern, each piece written as bytes in GPT-2's printable form, then merged by the merge list in rank order.
 */
function encodeText(T, text) {
  if (!T.bpeTables) {
    const dec = byteDecoder();
    const enc = new Array(256); for (const [ch, b] of dec) enc[b] = ch;
    const ranks = new Map();
    T.bpe.merges.forEach((m, i) => ranks.set(Array.isArray(m) ? m.join(' ') : m, i));
    T.bpeTables = { enc, ranks, cache: new Map() };
  }
  const { enc, ranks, cache } = T.bpeTables;
  const ids = [];
  for (const m of String(text).matchAll(PRE_TOKENIZE)) {
    const word = Array.from(Buffer.from(m[0], 'utf8'), (b) => enc[b]).join('');
    let pieces = cache.get(word);
    if (!pieces) {
      let parts = Array.from(word);
      for (;;) {
        let best = -1; let bestRank = Infinity;
        for (let i = 0; i < parts.length - 1; i++) { const r = ranks.get(parts[i] + ' ' + parts[i + 1]); if (r !== undefined && r < bestRank) { bestRank = r; best = i; } }
        if (best < 0) break;
        const a = parts[best]; const b = parts[best + 1]; const merged = [];
        for (let i = 0; i < parts.length; i++) {
          if (i < parts.length - 1 && parts[i] === a && parts[i + 1] === b) { merged.push(a + b); i++; } else merged.push(parts[i]);
        }
        parts = merged;
      }
      pieces = parts.map((p) => T.bpe.vocab[p]);
      if (cache.size < 50000) cache.set(word, pieces);
    }
    for (const id of pieces) if (id !== undefined) ids.push(id);
  }
  return ids;
}

// ---- matching pasted lyrics to what was heard ---------------------------------------------------------------------------------
/** A word reduced to what matters when comparing: lower case, no accents, no punctuation. */
const normWord = (w) => String(w).normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
function editSimilarity(a, b) {
  if (a === b) return 1;
  if (!a.length || !b.length) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return 1 - prev[b.length] / Math.max(a.length, b.length);
}
/**
 * Line up the pasted words with the words the model heard (both in order; either may have extra or missing words, a chorus the
 * model skipped, a word it misheard): global alignment that rewards words that are the same or nearly the same. Returns, for
 * every pasted word, the index of the heard word it matches, or -1.
 */
function matchWords(pasted, heard) {
  const n = pasted.length; const m = heard.length;
  const GAP = -0.4;
  const score = new Float32Array((n + 1) * (m + 1)); const move = new Uint8Array((n + 1) * (m + 1)); // 1 diag, 2 up (skip pasted), 3 left (skip heard)
  for (let i = 1; i <= n; i++) { score[i * (m + 1)] = i * GAP; move[i * (m + 1)] = 2; }
  for (let j = 1; j <= m; j++) { score[j] = j * GAP; move[j] = 3; }
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const sim = editSimilarity(pasted[i - 1], heard[j - 1]);
      const d = score[(i - 1) * (m + 1) + j - 1] + (sim >= 0.67 ? 1 + sim : -1);
      const u = score[(i - 1) * (m + 1) + j] + GAP; const l = score[i * (m + 1) + j - 1] + GAP;
      const k = i * (m + 1) + j;
      if (d >= u && d >= l) { score[k] = d; move[k] = 1; } else if (u >= l) { score[k] = u; move[k] = 2; } else { score[k] = l; move[k] = 3; }
    }
  }
  const out = new Int32Array(n).fill(-1);
  for (let i = n, j = m; i > 0 || j > 0;) {
    const mv = move[i * (m + 1) + j];
    if (mv === 1) { if (editSimilarity(pasted[i - 1], heard[j - 1]) >= 0.67) out[i - 1] = j - 1; i--; j--; } else if (mv === 2) i--; else j--;
  }
  return out;
}
/**
 * A first guess of when each pasted word is sung: the time of the heard word it matched, and for the others a straight line
 * between the matched words around them (or about 0.35 s per word before the first and after the last match).
 */
function estimateTimes(match, heardTimes, total) {
  const n = match.length; const est = new Float64Array(n); const known = [];
  for (let i = 0; i < n; i++) if (match[i] >= 0) known.push(i);
  if (!known.length) { for (let i = 0; i < n; i++) est[i] = Math.min(total, (i * total) / Math.max(1, n)); return est; }
  for (const i of known) est[i] = heardTimes[match[i]];
  for (let i = 0; i < known[0]; i++) est[i] = Math.max(0, est[known[0]] - (known[0] - i) * 0.35);
  for (let k = 0; k + 1 < known.length; k++) {
    const a = known[k]; const b = known[k + 1];
    for (let i = a + 1; i < b; i++) est[i] = est[a] + ((est[b] - est[a]) * (i - a)) / (b - a);
  }
  const last = known[known.length - 1];
  for (let i = last + 1; i < n; i++) est[i] = Math.min(total, est[last] + (i - last) * 0.35);
  for (let i = 1; i < n; i++) if (est[i] < est[i - 1]) est[i] = est[i - 1];   // never backwards
  return est;
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
 * Under music nothing is ever quiet, but a voice coming in still makes the sound clearly louder. If [t0, t1) starts with a steady
 * stretch and then (smoothed over 100 ms, so single drum hits do not count) gets at least 2.5 times louder and stays there,
 * the time of that rise; else null.
 * @returns {number|null}
 */
function riseOnset(samples, sampleRate, t0, t1) {
  const lv = frameLevels(samples, sampleRate, t0, t1);
  if (lv.length < 20) return null;
  const sm = new Float32Array(lv.length);
  for (let i = 0; i < lv.length; i++) { let s = 0; let n = 0; for (let k = Math.max(0, i - 2); k <= Math.min(lv.length - 1, i + 2); k++) { s += lv[k]; n++; } sm[i] = s / n; }
  const head = Array.from(sm.subarray(0, 10)).sort((a, b) => a - b);
  const base = head[5];
  if (!(base > 1e-4)) return null;
  for (let i = 10; i < sm.length - 4; i++) {
    if (sm[i] >= base * 2.5 && sm[i + 2] >= base * 2.5 && sm[i + 4] >= base * 2.5) return t0 + Math.max(0, i - 2) * 0.02;
  }
  return null;
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
    const rise = onset == null ? riseOnset(samples, sampleRate, first.start, first.end) : null;
    if (onset != null && onset > first.start) first.start = Math.min(onset, first.end - 0.05);
    else if (rise != null && rise > first.start && first.end - rise >= 0.08) first.start = rise;
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
    const out = await encoder.run({ input_features: new ort.Tensor('float32', mel, [1, T.nMels, Mel.N_FRAMES]) });
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
  async function alignWords(enc, lang, textTokens, frames) {
    if (!textTokens.length || !T.alignmentHeads.length) return [];
    const ids = [T.sot, T.langs[lang], T.transcribe, T.noTimestamps, ...textTokens, T.eot];
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
  async function decodeWindow(enc, lang, temperature, rng, shouldStop, tick = null) {
    const first = await step([T.sot], enc, null);
    const noSpeech = softmaxAt(first.logits, T.noSpeech);
    if (!lang) {
      let best = -Infinity; let bestCode = 'en';
      for (const [code, id] of Object.entries(T.langs)) if (first.logits[id] > best) { best = first.logits[id]; bestCode = code; }
      lang = bestCode;
    }
    let st = await step([T.langs[lang], T.transcribe], enc, first.past);
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

  async function decodeWithFallback(enc, lang, rng, shouldStop, tick) {
    let best = null;
    for (const temperature of TEMPERATURES) {
      stats.attempts++;
      const r = await decodeWindow(enc, lang, temperature, rng, shouldStop, tick);
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
  async function transcribe(samples, { language = 'auto', shouldStop = () => false, onSegments = () => {}, onProgress = () => {} } = {}) {
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
      const melInput = Mel.logMel(samples, seek * Mel.HOP, T.nMels);
      stats.melMs += Date.now() - tm; stats.windows++;
      const report = (within) => onProgress({ seek, contentFrames, seconds: total, fraction: Math.min(0.995, (seek + segFrames * within) / contentFrames), elapsed: (Date.now() - started) / 1000, language: lang });
      report(0.05);
      const enc = await encode(melInput);
      if (shouldStop()) throw cancelled();
      report(0.15);
      const r = await decodeWithFallback(enc, lang, rng, shouldStop, (n) => report(0.15 + 0.75 * Math.min(1, n / 150)));
      if (!lang) lang = r.lang;
      if (r.noSpeech > NO_SPEECH_THRESHOLD && r.avgLogprob < LOGPROB_THRESHOLD) { seek += segFrames; continue; } // judged to be silence or music only
      const { segments, advance } = parseSegments(r.tokens, timeOffset, segFrames / 100, segFrames, T);
      // word times for the whole window, then each segment takes the words that belong to it
      const textTokens = []; const ranges = [];
      for (const s of segments) { const from = textTokens.length; for (const t of s.tokens) if (t < T.eot) textTokens.push(t); ranges.push([from, textTokens.length]); }
      let words = [];
      try { words = await alignWords(enc, lang || r.lang, textTokens, segFrames); } catch (e) { words = []; }   // without word times the segment times of the model are used
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

  /**
   * Time the user's own lyrics: `lines` are the pasted lines (their words and line breaks are kept exactly), `heard` the words the
   * model wrote down for the same audio (from transcribe). The pasted words are lined up with the heard ones to know roughly where
   * every line is sung (also lines the model missed), then the lines are timed precisely, a stretch of audio at a time, by running
   * the decoder over the PASTED text and warping its attention onto the audio (as for the model's own words).
   * @param {Float32Array} samples 16 kHz mono
   * @param {string[]} lines
   * @param {{ language: string, heard: {text:string,start:number,end:number}[], shouldStop?: Function, onProgress?: Function }} o
   * @returns {Promise<{ lines: {start:number,end:number,text:string,words:{text:string,start:number,end:number}[]}[], matched: number }>}
   */
  async function alignLyrics(samples, lines, { language, heard = [], shouldStop = () => false, onProgress = () => {} }) {
    const total = samples.length / Mel.SAMPLE_RATE;
    const lang = T.langs[language] ? language : 'en';
    const spaced = !NO_SPACE_LANGUAGES.has(lang);
    // the pasted words, each knowing its line
    const pw = []; const lineWords = []; const lineFirst = [];
    lines.forEach((text, li) => {
      const words = spaced ? text.split(/\s+/).filter(Boolean) : Array.from(text.replace(/\s+/g, ''));
      lineFirst.push(pw.length); lineWords.push(words.length);
      for (const w of words) pw.push({ li, norm: normWord(w) });
    });
    const heardNorm = heard.map((w) => normWord(w.text));
    const match = matchWords(pw.map((w) => w.norm), heardNorm);
    const matched = pw.length ? Array.from(match).filter((x) => x >= 0).length / pw.length : 0;
    const est = estimateTimes(match, heard.map((w) => w.start), total);
    const lineEst = lines.map(() => ({ start: Infinity, end: 0 }));
    pw.forEach((w, i) => { const e = lineEst[w.li]; e.start = Math.min(e.start, est[i]); e.end = Math.max(e.end, est[i] + 0.4); });
    // group the lines into stretches of audio of up to ~25 s (and a decoder-sized amount of text), then time each stretch
    const toks = lines.map((t) => encodeText(T, (spaced ? ' ' : '') + t.trim()));
    const out = []; const round = (x) => Math.round(x * 100) / 100;
    let prevEnd = 0; let li = 0; let done = 0;
    while (li < lines.length) {
      if (shouldStop()) throw cancelled();
      const first = li;
      // the first word of the stretch: where the model heard it, if it did (then a short lead-in is enough)
      const g0 = lineFirst[li]; const heardAt = lineWords[li] && match[g0] >= 0 ? heard[match[g0]].start : null;
      let ws = Math.max(0, Math.min(lineEst[li].start - (heardAt != null ? 0.4 : 1.5), total - 1), prevEnd - 0.3);
      if (!Number.isFinite(ws)) ws = prevEnd;
      let count = 0; let lastEnd = lineEst[li].end;
      while (li < lines.length && (li === first || (Math.max(lineEst[li].end, lastEnd) - ws <= 25 && count + toks[li].length <= 200))) {
        count += toks[li].length; lastEnd = Math.max(lastEnd, lineEst[li].end); li++;
      }
      const we = Math.min(total, ws + 30, Math.max(lastEnd + 2, ws + 3));
      const frames = Math.max(50, Math.round((we - ws) * 100));
      const melInput = Mel.logMel(samples, Math.round(ws * Mel.SAMPLE_RATE), T.nMels);
      const enc = await encode(melInput);
      if (shouldStop()) throw cancelled();
      const textTokens = []; const ranges = [];
      for (let k = first; k < li; k++) { ranges.push([textTokens.length, textTokens.length + toks[k].length]); textTokens.push(...toks[k]); }
      let words = [];
      try { words = await alignWords(enc, lang, textTokens, frames); } catch { words = []; }
      const lengths = words.map((w) => w.end - w.start).filter((d) => d > 0).sort((a, b) => a - b);
      const median = Math.min(0.7, lengths.length ? lengths[lengths.length >> 1] : 0.3);
      for (let k = first; k < li; k++) {
        const [a, b] = ranges[k - first];
        let mine = words.filter((w) => w.first >= a && w.first < b).map((w) => ({ text: w.text, start: Math.min(total, ws + w.start), end: Math.min(total, ws + w.end) }));
        mine = trimEdges(mine, samples, Mel.SAMPLE_RATE, median);
        // warping stretches the stretch's first word back over the lead-in; where the model heard that word later, believe the model
        if (k === first && heardAt != null && mine.length && mine[0].start < heardAt - 0.2) {
          mine[0].start = Math.min(heardAt, mine[0].end > heardAt ? heardAt : mine[0].end);
          if (mine[0].end < mine[0].start) mine[0].end = mine[0].start;
        }
        for (let q = 0; q < mine.length; q++) {                 // in order, never before the previous line, never overlapping
          const lo = q ? mine[q - 1].end : prevEnd;
          mine[q].start = Math.max(mine[q].start, lo); mine[q].end = Math.max(mine[q].end, mine[q].start);
        }
        const start = mine.length ? mine[0].start : Math.max(prevEnd, lineEst[k].start);
        const end = mine.length ? Math.max(mine[mine.length - 1].end, start + 0.1) : Math.max(start + 1, lineEst[k].end);
        out.push({ start: round(start), end: round(end), text: lines[k].trim(), words: mine.map((w) => ({ text: w.text, start: round(w.start), end: round(Math.max(w.end, w.start)) })) });
        prevEnd = Math.max(prevEnd, mine.length ? mine[mine.length - 1].end : start);
      }
      done = li;
      onProgress({ fraction: done / lines.length });
    }
    return { lines: out, matched };
  }

  return {
    tokens: T, stats, encode, step, decodeWindow, alignWords, transcribe, alignLyrics,
    async release() { try { await encoder.release(); } catch { /* ignore */ } try { await decoder.release(); } catch { /* ignore */ } },
  };
}

module.exports = {
  TIME_PRECISION, MAX_TOKENS, TEMPERATURES, cancelled,
  loadAssets, detokenize, applyRules, parseSegments, compressionRatio, isSilent, dropLoops, createWhisper, logSumExp,
  medianFilter, dtw, jumpTimes, splitWords, quietOnset, quietOffset, riseOnset, trimEdges,
  encodeText, normWord, editSimilarity, matchWords, estimateTimes,
};
