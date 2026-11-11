'use strict';
(() => {
  const P = window.Plan;
  const $ = (id) => document.getElementById(id);
  const el = (tag, attrs, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) { if (v === false || v == null) continue; if (k === 'class') n.className = v; else n.setAttribute(k, v === true ? '' : v); }
    for (const kid of kids) if (kid != null) n.append(kid);
    return n;
  };
  const LANG_KEY = 'lyricsmaker.language';
  const round2 = (x) => Math.round(x * 100) / 100;

  const S = {
    song: null,                    // { id, name, duration, url, estimate, existingTtml, existingLrc }
    lines: [],                     // { uid, start, end?, text, words: [{ text, start, end, est? }] }  what the window shows and saves
    made: [],                      // the lines as they were made (or loaded), for "Undo all edits"
    sel: null,                     // the selected line object
    selWord: -1,                   // the selected word of that line, or -1
    tap: null,                     // "Tap words" mode: { line, word } is the next word a tap will time
    langCode: null,                // the language of the lyrics (as made, or from a loaded TTML), written into the TTML
    edited: false,
    working: false,
    language: 'auto',
    detected: null,
    uid: 1,
  };
  try { S.language = localStorage.getItem(LANG_KEY) || 'auto'; } catch { /* private mode: fine */ }

  // ---- messages ----------------------------------------------------------------------------------------------------------------
  let toastTimer = null;
  function toast(text, err = false) {
    const t = $('toast');
    t.textContent = text; t.className = 'toast' + (err ? ' err' : ''); t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 4200);
  }
  const banner = (text) => { const b = $('banner'); b.textContent = text || ''; b.hidden = !text; };
  function showResult(text, kind, file, extra) {
    const box = $('result');
    box.textContent = ''; box.hidden = !text; box.className = 'result' + (kind ? ' ' + kind : '');
    if (!text) return;
    box.append(el('span', null, text));
    if (extra) box.append(el('span', { class: 'muted small' }, extra));
    if (file) {
      box.append(el('span', { class: 'path', title: file }, file));
      const b = el('button', { class: 'btn small', type: 'button' }, 'Show in folder');
      b.addEventListener('click', () => window.lm.reveal(file));
      box.append(b);
    }
  }

  // ---- state -> controls ---------------------------------------------------------------------------------------------------------
  function syncControls() {
    const has = !!S.song;
    $('empty').hidden = has; $('work').hidden = !has;
    $('playSet').disabled = !has;
    $('makeSet').disabled = !has || S.working;
    const lines = S.lines.length > 0 && !S.working;
    $('timeSet').disabled = !lines; $('saveSet').disabled = !lines;
    $('revert').disabled = !S.edited || S.working;
    $('open').disabled = S.working;
    const pasted = P.pastedLines($('lyricsIn').value).length;
    $('make').textContent = pasted ? (S.lines.length ? 'Time my lyrics again' : 'Time my lyrics') : (S.lines.length ? 'Make lyrics again' : 'Make lyrics');
    $('lyricsCount').textContent = pasted ? `${pasted} line${pasted === 1 ? '' : 's'} to time` : '';
    $('lyricsIn').disabled = S.working;
    $('load').disabled = !has || S.working;
    $('tap').setAttribute('aria-pressed', S.tap ? 'true' : 'false');
    $('tap').textContent = S.tap ? 'Stop tapping (Esc)' : 'Tap words (W)';
    $('tapHint').hidden = !S.tap;
    $('progressBox').hidden = !S.working;
    const n = S.lines.length;
    $('status').textContent = S.working ? `${n} line${n === 1 ? '' : 's'} so far…` : n ? `${n} line${n === 1 ? '' : 's'}${S.detected ? ' · ' + S.detected : ''}${S.edited ? ' · edited' : ''}` : '';
  }

  // ---- the lines -----------------------------------------------------------------------------------------------------------------
  const sortLines = () => { S.lines = S.lines.map((l, i) => ({ l, i })).sort((a, b) => a.l.start - b.l.start || a.i - b.i).map((x) => x.l); };
  const spaced = (line) => (S.langCode ? !['zh', 'ja', 'th', 'lo', 'my', 'yue', 'km'].includes(S.langCode) : !P.looksUnspaced(line.text));
  const copyWords = (words) => (Array.isArray(words) ? words.map((w) => ({ text: w.text, start: w.start, end: w.end, ...(w.est ? { est: true } : {}) })) : undefined);
  /** Make sure a line has one timed word per word of its text. Words that had to be guessed are marked `est` (shown in italics). */
  function ensureWords(line) {
    const texts = P.splitWords(line.text, spaced(line));
    const old = Array.isArray(line.words) ? line.words : [];
    if (old.length === texts.length && old.every((w, i) => w.text === texts[i])) { line.words = old; return old; }
    const i = S.lines.indexOf(line);
    const end = P.lineEnd(S.lines, i < 0 ? 0 : i, S.song ? S.song.duration : undefined);
    const same = old.length === texts.length;
    line.words = P.timeWords(line, end, spaced(line)).map((w, k) => ({ text: w.text, start: round2(w.start), end: round2(w.end), ...((same ? old[k].est : true) ? { est: true } : {}) }));
    return line.words;
  }
  const newLine = (start, text, words, end) => {
    const l = { uid: S.uid++, start: round2(start), text, ...(Number.isFinite(end) ? { end } : {}) };
    if (Array.isArray(words) && words.length) l.words = copyWords(words);
    return l;
  };
  /** Move a line to start at `t`, taking its words along. */
  function moveLine(line, t) {
    const d = round2(t) - line.start;
    line.start = round2(t);
    if (Number.isFinite(line.end)) line.end = round2(Math.max(line.start, line.end + d));
    if (line.words) for (const w of line.words) { w.start = round2(Math.max(0, w.start + d)); w.end = round2(Math.max(0, w.end + d)); }
  }

  function renderWords(box, line) {
    box.textContent = '';
    const words = ensureWords(line);
    const isSel = S.sel === line;
    words.forEach((w, k) => {
      const chip = el('button', { type: 'button', class: 'w' + (w.est ? ' est' : '') + (isSel && S.selWord === k ? ' sel' : ''), 'data-k': String(k), title: `${P.formatTime(w.start)} – ${P.formatTime(w.end)}${w.est ? ' (estimated: stamp or tap it to time it exactly)' : ''}`, tabindex: '-1' }, w.text);
      if (isSel) chip.append(el('small', null, P.formatTime(w.start)));
      chip.addEventListener('mousedown', (e) => e.preventDefault());   // keep the keyboard where it was
      chip.addEventListener('click', () => { selectLine(line, k); seek(w.start); });
      box.append(chip);
    });
  }
  function selectLine(line, word = -1) {
    const before = S.sel;
    S.sel = line; S.selWord = word;
    for (const r of $('lines').children) {
      const uid = r.dataset.uid;
      r.classList.toggle('sel', uid === String(line.uid));
      if ((before && uid === String(before.uid)) || uid === String(line.uid)) renderWords(r.querySelector('.words'), S.lines.find((l) => String(l.uid) === uid));
    }
    lastWord = -2; highlight(true);
  }

  function rowFor(line) {
    const idx = S.lines.indexOf(line);
    const n = idx + 1;
    const time = el('input', { class: 'time', value: P.formatTime(line.start), 'aria-label': `Time of line ${n}`, spellcheck: 'false' });
    const text = el('input', { class: 'text', value: line.text, 'aria-label': `Text of line ${n}`, spellcheck: 'false' });
    const go = el('button', { type: 'button', class: 'go', 'aria-label': `Play from line ${n}`, title: 'Play from here' }, '▶');
    const del = el('button', { type: 'button', class: 'del', 'aria-label': `Delete line ${n}`, title: 'Delete this line' }, '×');
    const words = el('div', { class: 'words', 'aria-label': `Words of line ${n}, each with its own time` });
    const row = el('div', { class: 'line' + (S.sel === line ? ' sel' : ''), 'data-uid': String(line.uid) }, go, time, text, del, words);
    renderWords(words, line);
    if (S.working) { time.disabled = true; text.disabled = true; go.disabled = true; del.disabled = true; }
    const select = () => { if (S.sel !== line || S.selWord !== -1) selectLine(line); };   // working on the text or time of a line means the whole line
    time.addEventListener('focus', select); text.addEventListener('focus', select);
    row.addEventListener('mousedown', (e) => { if (!e.target.classList.contains('w')) select(); });
    text.addEventListener('input', () => { line.text = text.value; markEdited(); });
    text.addEventListener('change', () => { ensureWords(line); renderWords(words, line); });   // words that no longer match are timed again
    time.addEventListener('change', () => {
      const t = P.parseTime(time.value);
      if (t == null) { time.value = P.formatTime(line.start); toast('Type a time like 1:05.30 (minutes:seconds)', true); return; }
      moveLine(line, t); markEdited(); sortLines(); renderLines(line, 'time');
    });
    go.addEventListener('click', () => playFrom(line.start));
    del.addEventListener('click', () => {
      if (S.sel === line) { S.sel = null; S.selWord = -1; }
      if (S.tap && S.tap.line === line) S.tap = null;
      S.lines = S.lines.filter((l) => l !== line); markEdited(); renderLines();
    });
    return row;
  }

  /** Rebuild the list. `focusLine`/`focusField` put the keyboard cursor back where the user was working. */
  function renderLines(focusLine, focusField) {
    const box = $('lines');
    const scroll = box.scrollTop;
    box.textContent = '';
    const frag = document.createDocumentFragment();
    for (const l of S.lines) frag.append(rowFor(l));
    box.append(frag);
    box.scrollTop = scroll;
    if (focusLine) { const r = box.querySelector(`[data-uid="${focusLine.uid}"]`); if (r) { const f = focusField && r.querySelector(focusField === 'time' ? '.time' : '.text'); if (f) f.focus(); r.scrollIntoView({ block: 'nearest' }); } }
    syncControls(); highlight(true);
  }
  function appendLines(list) {
    const box = $('lines');
    for (const l of list) { const line = newLine(l.start, l.text, l.words, l.end); S.lines.push(line); box.append(rowFor(line)); }
    syncControls();
  }
  function markEdited() { if (!S.edited) { S.edited = true; syncControls(); } }

  // ---- playing -----------------------------------------------------------------------------------------------------------------------
  const player = () => $('player');
  let lastNow = -2; let lastWord = -2;
  function highlight(force) {
    const t = player().currentTime || 0;
    const i = P.currentLine(S.lines, t);
    const rows = $('lines').children;
    if (i !== lastNow || force) {
      if (lastNow >= 0 && rows[lastNow]) for (const c of rows[lastNow].querySelectorAll('.w')) c.classList.remove('sung', 'now');
      lastNow = i; lastWord = -2;
      for (let k = 0; k < rows.length; k++) rows[k].classList.toggle('now', k === i);
      if (i >= 0 && rows[i] && !player().paused) rows[i].scrollIntoView({ block: 'nearest' });
    }
    if (i < 0 || !rows[i]) return;
    // karaoke: the words already sung, and the one being sung now
    const words = S.lines[i].words || [];
    let w = P.currentWord(words, t);
    if (w >= 0 && t > words[w].end + 0.25 && w === words.length - 1) w = words.length;   // the line is over
    if (w === lastWord && !force) return;
    lastWord = w;
    const chips = rows[i].querySelectorAll('.w');
    chips.forEach((c, k) => { c.classList.toggle('sung', k < w); c.classList.toggle('now', k === w); });
  }
  function clock() {
    const p = player();
    const dur = isFinite(p.duration) && p.duration > 0 ? p.duration : (S.song ? S.song.duration : 0);
    $('pos').textContent = P.formatDuration(p.currentTime || 0);
    $('len').textContent = P.formatDuration(dur);
    if (document.activeElement !== $('seek')) $('seek').value = dur ? String(Math.round(((p.currentTime || 0) / dur) * 1000)) : '0';
  }
  function frame() { clock(); highlight(false); if (!player().paused) requestAnimationFrame(frame); }
  function playFrom(t) { const p = player(); p.currentTime = Math.max(0, t); p.play().catch(() => {}); }
  function seek(t) { const p = player(); p.currentTime = Math.max(0, t); clock(); highlight(false); }
  function togglePlay() { const p = player(); if (!S.song) return; if (p.paused) p.play().catch(() => {}); else p.pause(); }

  // ---- opening and making ----------------------------------------------------------------------------------------------------------------
  async function loadSong(r) {
    if (!r) return;
    if (!r.ok) { toast(r.error || 'Could not open that file', true); return; }
    if (S.working) return;
    if (S.edited && !window.confirm('Opening another song discards the changes you made to these lyrics. Continue?')) return;
    const old = S.song;
    S.song = r; S.lines = []; S.made = []; S.sel = null; S.selWord = -1; S.tap = null; S.edited = false; S.detected = null; S.langCode = null; lastNow = -2;
    banner('');
    if (old) { window.lm.forget(old.id); $('lyricsIn').value = ''; }   // a new song: its own lyrics
    const p = player();
    p.pause(); p.src = r.url; p.load();
    $('fileInfo').textContent = `${r.name} · ${P.formatDuration(r.duration)}`;
    const have = [r.existingTtml && '.ttml', r.existingLrc && '.lrc'].filter(Boolean);
    $('makeNote').textContent = `Takes about ${P.formatDuration(r.estimate)} on this computer.` + (have.length ? ` This song already has lyrics next to it (${have.join(' and ')}): load them to fix them, or make new ones. Saving over a file keeps the old one as .bak.` : '');
    showResult('', '');
    renderLines(); clock();
  }

  const etaText = (s) => (s == null ? '' : `about ${P.formatDuration(Math.max(1, s))} left`);
  async function make() {
    if (!S.song || S.working) return;
    if (S.edited && !window.confirm('Making the lyrics again replaces the edits you made. Continue?')) return;
    S.working = true; S.lines = []; S.made = []; S.sel = null; S.selWord = -1; S.tap = null; S.edited = false; S.detected = null; lastNow = -2;
    showResult('', '');
    $('phase').textContent = 'Starting…'; $('eta').textContent = ''; $('fill').style.width = '0%'; $('bar').classList.add('indeterminate'); $('bar').setAttribute('aria-valuenow', '0');
    $('cancel').disabled = false;
    renderLines();
    let res;
    const lyrics = $('lyricsIn').value;
    try { res = await window.lm.make(S.song.id, S.language, P.pastedLines(lyrics).length ? lyrics : null); } catch (e) { res = { ok: false, error: (e && e.message) || String(e) }; }
    S.working = false;
    if (res.ok) {
      S.lines = res.lines.map((l) => newLine(l.start, l.text, l.words, l.end));
      S.made = S.lines.map(snapshot);
      S.langCode = res.language || null;
      S.detected = res.languageName + (S.language === 'auto' ? ' (detected)' : '');
      renderLines();
      if (!S.lines.length) toast('No words were found in this song. If it has singing, try choosing its language instead of detecting it.', true);
      else if (res.fromLyrics) {
        const pct = Math.round((res.matched || 0) * 100);
        toast(pct >= 60 ? `Timed your ${S.lines.length} lines. ${pct}% of the words were clearly heard.` : `Timed your ${S.lines.length} lines, but only ${pct}% of the words were clearly heard: check the timing, or try "Isolate vocals".`, pct < 60);
      }
    } else {
      renderLines();
      if (!res.cancelled) banner(res.error || 'Something went wrong');
      else toast('Stopped. The lines found so far were dropped.');
    }
  }

  // ---- timing tools -------------------------------------------------------------------------------------------------------------------------
  const snapshot = (l) => ({ start: l.start, end: l.end, text: l.text, words: copyWords(l.words) });
  function shiftAll(delta) {
    const sel = S.sel ? S.lines.indexOf(S.sel) : -1;
    const tapAt = S.tap ? { line: S.lines.indexOf(S.tap.line), word: S.tap.word } : null;
    S.lines = P.shiftLines(S.lines, delta).map((l) => ({ ...l, start: round2(l.start), words: l.words && l.words.map((w) => ({ ...w, start: round2(w.start), end: round2(w.end) })) }));
    if (sel >= 0) S.sel = S.lines[sel];
    if (tapAt && tapAt.line >= 0) S.tap = { line: S.lines[tapAt.line], word: tapAt.word };
    markEdited(); renderLines();
  }
  const selected = () => (S.sel && S.lines.includes(S.sel) ? S.sel : null);
  /** Start word k of a line at `t`: the word before it ends there, and the first word moves the line's start too. */
  function timeWord(line, k, t) {
    const words = ensureWords(line);
    const w = words[k];
    if (!w) return;
    t = round2(Math.max(0, t));
    const len = Math.max(0.1, w.end - w.start);
    w.start = t; delete w.est;
    const next = words[k + 1];
    w.end = round2(next && !next.est && next.start > t ? Math.min(next.start, t + Math.max(len, 0.1)) : t + len);
    if (k > 0 && (words[k - 1].end > t || words[k - 1].est || t - words[k - 1].end < 0.6)) words[k - 1].end = t;   // the word before ends where this one begins (unless there is a real pause)
    for (let j = k + 1; j < words.length; j++) if (words[j].start < t) { words[j].start = t; if (words[j].end < t) words[j].end = t; }
    if (k === 0) { line.start = t; if (Number.isFinite(line.end) && line.end < t) line.end = t; }
    else if (t < line.start) line.start = t;
  }
  function stamp() {
    const line = selected();
    if (!line) { toast('Select a line first (click it), then press S at the moment it starts', true); return; }
    const now = player().currentTime || 0;
    if (S.selWord >= 0) timeWord(line, S.selWord, now);
    else moveLine(line, now);
    markEdited(); sortLines(); renderLines(S.selWord >= 0 ? null : line, S.selWord >= 0 ? null : 'text');
  }
  /** [ and ]: move the selected word (or the whole line, with its words) a little earlier or later. */
  function nudge(delta) {
    const line = selected();
    if (!line) return;
    if (S.selWord >= 0) {
      const words = ensureWords(line); const w = words[S.selWord];
      const lo = S.selWord > 0 ? words[S.selWord - 1].start : 0;
      const t = round2(Math.max(lo, w.start + delta));
      w.end = round2(Math.max(t, w.end + (t - w.start))); w.start = t; delete w.est;
      if (S.selWord > 0 && words[S.selWord - 1].end > t) words[S.selWord - 1].end = t;
      if (S.selWord === 0) line.start = t;
    } else moveLine(line, Math.max(0, line.start + delta));
    markEdited(); sortLines(); renderLines();
  }
  // "Tap words": play the song and press W the moment each word is sung; the next word is lined up after every tap.
  function startTap() {
    if (!S.lines.length) return;
    const line = selected() || S.lines[Math.max(0, P.currentLine(S.lines, player().currentTime || 0))] || S.lines[0];
    S.tap = { line, word: S.sel === line && S.selWord >= 0 ? S.selWord : 0 };
    selectLine(line, S.tap.word);
    syncControls();
    if (player().paused) playFrom(Math.max(0, line.start - 2));
  }
  function stopTap() { S.tap = null; syncControls(); }
  function tapWord() {
    if (!S.tap || !S.lines.includes(S.tap.line)) { startTap(); return; }
    const { line, word } = S.tap;
    timeWord(line, word, player().currentTime || 0);
    markEdited();
    const words = line.words;
    let next = { line, word: word + 1 };
    if (word + 1 >= words.length) {
      const i = S.lines.indexOf(line);
      next = i + 1 < S.lines.length ? { line: S.lines[i + 1], word: 0 } : null;
    }
    sortLines();
    S.tap = next;
    renderLines();
    if (next) { selectLine(next.line, next.word); const r = $('lines').querySelector(`[data-uid="${next.line.uid}"]`); if (r) r.scrollIntoView({ block: 'nearest' }); }
    else toast('That was the last word. Every word has a time now.');
    syncControls();
  }
  function addLine() {
    const line = newLine(player().currentTime || 0, '');
    S.lines.push(line); sortLines(); S.sel = line; S.selWord = -1; markEdited(); renderLines(line, 'text');
  }
  function revert() { S.lines = S.made.map((l) => newLine(l.start, l.text, l.words, l.end)); S.sel = null; S.selWord = -1; S.tap = null; S.edited = false; renderLines(); }

  async function loadLyrics() {
    if (!S.song || S.working) return;
    if (S.edited && !window.confirm('Loading lyrics replaces the edits you made. Continue?')) return;
    let r;
    try { r = await window.lm.load(S.song.id); } catch (e) { r = { ok: false, error: (e && e.message) || String(e) }; }
    if (r.dialogCancelled) return;
    if (!r.ok) { toast(r.error || 'Could not read that file', true); return; }
    S.tap = null; S.sel = null; S.selWord = -1; lastNow = -2;
    if (r.language) S.langCode = r.language;
    S.lines = r.lines.map((l) => newLine(l.start, l.text, l.words, l.end));
    sortLines();
    for (const l of S.lines) ensureWords(l);
    S.made = S.lines.map(snapshot); S.edited = false;
    const timed = r.lines.filter((l) => l.words && l.words.length).length;
    S.detected = `loaded from ${r.name}`;
    showResult('', '');
    renderLines();
    toast(r.kind === 'ttml' && timed ? `Loaded ${r.lines.length} lines with their word times.` : `Loaded ${r.lines.length} lines. They have no word times yet: the words are spread over each line (in italics) until you tap or stamp them.`);
  }

  async function save(kind) {
    const lines = S.lines.filter((l) => l.text.trim()).map((l) => ({ start: l.start, ...(Number.isFinite(l.end) ? { end: l.end } : {}), text: l.text.trim(), words: ensureWords(l).map((w) => ({ text: w.text, start: w.start, end: w.end })) }));
    if (!lines.length) { toast('There are no lyrics to save yet', true); return; }
    const r = await window.lm.save(S.song.id, kind, lines, S.langCode || (S.language !== 'auto' ? S.language : null));
    if (r.dialogCancelled) return;
    if (!r.ok) { showResult(r.error || 'Could not save', 'err'); return; }
    showResult(`Saved ${P.baseName(r.path)} (${r.lines} line${r.lines === 1 ? '' : 's'})`, 'ok', r.path, r.backup ? `The file it replaced was kept as ${P.baseName(r.backup)}.` : null);
  }

  // ---- wiring ------------------------------------------------------------------------------------------------------------------------------
  async function pickSong() { try { await loadSong(await window.lm.pickSong()); } catch (e) { toast((e && e.message) || String(e), true); } }

  function wire() {
    $('open').addEventListener('click', pickSong); $('open2').addEventListener('click', pickSong);
    $('empty').addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pickSong(); } });
    const lang = $('lang');
    for (const l of P.languageList()) lang.append(el('option', { value: l.code }, l.name));
    lang.value = S.language;
    lang.addEventListener('change', () => { S.language = lang.value; try { localStorage.setItem(LANG_KEY, S.language); } catch { /* fine */ } });
    $('lyricsIn').addEventListener('input', syncControls);
    $('make').addEventListener('click', make);
    $('cancel').addEventListener('click', () => { $('cancel').disabled = true; $('phase').textContent = 'Stopping…'; window.lm.cancel(); });
    $('play').addEventListener('click', togglePlay);
    $('seek').addEventListener('input', () => { const p = player(); const dur = isFinite(p.duration) && p.duration > 0 ? p.duration : S.song.duration; p.currentTime = (Number($('seek').value) / 1000) * dur; clock(); highlight(false); });
    const p = player();
    p.addEventListener('play', () => { $('play').textContent = '❚❚ Pause'; requestAnimationFrame(frame); });
    p.addEventListener('pause', () => { $('play').textContent = '▶ Play'; clock(); });
    p.addEventListener('ended', () => { $('play').textContent = '▶ Play'; clock(); });
    p.addEventListener('loadedmetadata', clock);
    p.addEventListener('seeked', () => { clock(); highlight(false); });
    p.addEventListener('error', () => { if (S.song) toast('This song cannot be played in the window (the lyrics can still be made).', true); });
    for (const b of document.querySelectorAll('[data-shift]')) b.addEventListener('click', () => shiftAll(Number(b.dataset.shift)));
    $('stamp').addEventListener('click', stamp); $('addLine').addEventListener('click', addLine); $('revert').addEventListener('click', revert);
    $('tap').addEventListener('click', () => (S.tap ? stopTap() : startTap()));
    $('load').addEventListener('click', loadLyrics);
    $('saveTtml').addEventListener('click', () => save('ttml'));
    $('saveLrc').addEventListener('click', () => save('lrc')); $('saveTxt').addEventListener('click', () => save('txt'));

    window.addEventListener('keydown', (e) => {
      const typing = /^(INPUT|SELECT|TEXTAREA)$/.test((e.target && e.target.tagName) || '') && e.target.type !== 'range' && e.target.type !== 'checkbox';
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 'o') { e.preventDefault(); if (!$('open').disabled) pickSong(); return; }
      if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); if (!$('saveSet').disabled) save('ttml'); return; }
      if (!S.song || mod) return;
      if (e.key === ' ' && !typing && e.target.tagName !== 'BUTTON') { e.preventDefault(); togglePlay(); return; }
      if (typing && e.key === 'Enter' && e.target.classList.contains('time')) { e.target.blur(); return; }
      if (typing || $('timeSet').disabled) return;
      const k = e.key.toLowerCase();
      if (k === 's') { e.preventDefault(); stamp(); }
      else if (k === 'w') { e.preventDefault(); tapWord(); }
      else if (e.key === 'Escape' && S.tap) { e.preventDefault(); stopTap(); }
      else if (e.key === '[' || e.key === ']') { e.preventDefault(); nudge(e.key === '[' ? -0.05 : 0.05); }
      else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && S.sel) {
        e.preventDefault();
        const n = ensureWords(S.sel).length;
        selectLine(S.sel, Math.max(-1, Math.min(n - 1, S.selWord + (e.key === 'ArrowLeft' ? -1 : 1))));
      }
    });

    let depth = 0;
    window.addEventListener('dragenter', (e) => { e.preventDefault(); depth++; document.body.classList.add('dragging'); });
    window.addEventListener('dragleave', () => { depth = Math.max(0, depth - 1); if (!depth) document.body.classList.remove('dragging'); });
    window.addEventListener('dragover', (e) => e.preventDefault());
    window.addEventListener('drop', async (e) => {
      e.preventDefault(); depth = 0; document.body.classList.remove('dragging');
      const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (!f) return;
      const path = window.lm.pathForFile(f);
      if (path) loadSong(await window.lm.openSong(path));
    });
  }

  async function init() {
    wire();
    window.lm.onPhase((p) => {
      if (!S.working) return;
      $('phase').textContent = p.phase === 'loading' ? 'Starting the speech model (the first song takes a few seconds longer)…' : p.phase === 'reading' ? 'Reading the song…' : 'Listening…';
    });
    window.lm.onProgress((p) => {
      if (!S.working) return;
      const pct = Math.round(p.fraction * 100);
      $('bar').classList.remove('indeterminate'); $('fill').style.width = pct + '%'; $('bar').setAttribute('aria-valuenow', String(pct));
      $('phase').textContent = p.phase === 'timing' ? `Timing your lyrics… ${pct}%` : `Listening… ${pct}%`;
      $('eta').textContent = etaText(p.eta);
    });
    window.lm.onLines((p) => { if (S.working) appendLines(p.lines); });
    window.lm.onOpened((r) => loadSong(r));
    syncControls();
    try {
      const e = await window.lm.engine();
      if (!e.ok) { $('engineWarn').textContent = e.problems.join(' '); $('engineWarn').hidden = false; $('open').disabled = true; $('open2').disabled = true; }
      else if (e.warnings && e.warnings.length) { $('engineWarn').textContent = e.warnings.join(' '); $('engineWarn').hidden = false; }
    } catch { /* ignore */ }
  }

  window.__app = { S, P, loadSong, make, ensureWords, currentLine: () => P.currentLine(S.lines, player().currentTime || 0) };
  init();
})();
