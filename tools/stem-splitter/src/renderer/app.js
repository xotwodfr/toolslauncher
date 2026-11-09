'use strict';
(() => {
  const P = window.Plan;
  const $ = (id) => document.getElementById(id);
  const CONFIRM_OVER = 15 * 60;      // songs longer than this wait for a click before the long split starts
  const PEAK_BUCKETS = 2400;

  const S = {
    song: null,            // { id, name, duration, cached, previewOk, estimate }
    stems: null,           // stem id -> stems:// url
    buffers: {},           // stem id -> AudioBuffer (live preview)
    peaks: {},             // stem id -> Float32Array [min0, max0, min1, max1, ...]
    mix: P.newMix(),
    format: 'mp3',
    view: 'empty',         // empty | confirm | working | ready
    busy: false,           // a split or a save is running
    playing: false, offset: 0, startedAt: 0,
    result: null,
  };

  let ac = null;           // AudioContext
  let nodes = {};          // stem id -> GainNode
  let master = null;
  let sources = [];
  let raf = 0;

  // ---- small helpers ----------------------------------------------------------------------------------------------------
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* private window */ } },
  };
  const fmtBytes = (n) => (n >= 1073741824 ? (n / 1073741824).toFixed(2) + ' GB' : n >= 1048576 ? (n / 1048576).toFixed(n >= 104857600 ? 0 : 1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB');
  const fmtSpan = (s) => (s >= 90 ? `${Math.round(s / 60)} min` : `${Math.max(1, Math.round(s))} s`);
  let toastTimer = 0;
  function toast(msg, kind) {
    const t = $('toast');
    t.textContent = msg; t.className = 'toast' + (kind ? ' ' + kind : ''); t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 3500);
  }
  function banner(msg) { const b = $('banner'); b.textContent = msg || ''; b.hidden = !msg; }

  function showView(v) {
    S.view = v;
    for (const id of ['empty', 'confirm', 'working', 'ready']) $(id).hidden = id !== v;
    refreshButtons();
  }
  function refreshButtons() {
    $('open').disabled = S.busy;
    $('open2').disabled = S.busy;
    $('exportBtn').disabled = S.busy || !activeIds().length;
    $('play').disabled = !previewReady();
  }
  const previewReady = () => S.view === 'ready' && S.song && S.song.previewOk && P.STEM_IDS.every((id) => S.buffers[id]);
  function activeIds() { try { return P.activeStems(S.mix).map((a) => a.id); } catch { return []; } }

  // ---- the lanes ----------------------------------------------------------------------------------------------------------
  const lanes = {};
  function buildLanes() {
    const host = $('lanes');
    for (const st of P.STEMS) {
      const lane = document.createElement('div');
      lane.className = 'lane';
      lane.style.setProperty('--stem', st.color);
      lane.dataset.stem = st.id;

      const ctl = document.createElement('div');
      ctl.className = 'ctl';
      const top = document.createElement('div');
      top.className = 'top2';
      const name = document.createElement('label');
      name.className = 'name inline check';
      const cb = document.createElement('input');
      cb.type = 'checkbox'; cb.checked = true; cb.dataset.stem = st.id;
      cb.setAttribute('aria-label', `Include ${st.label.toLowerCase()}`);
      const txt = document.createElement('span');
      txt.textContent = st.label;
      name.append(cb, txt);
      const only = document.createElement('button');
      only.type = 'button'; only.className = 'only'; only.textContent = 'only';
      only.title = `Hear only ${st.label.toLowerCase()}`;
      only.setAttribute('aria-label', `Only ${st.label.toLowerCase()}`);
      top.append(name, only);

      const vol = document.createElement('div');
      vol.className = 'vol';
      const range = document.createElement('input');
      range.type = 'range'; range.min = '0'; range.max = String(P.MAX_GAIN * 100); range.step = '1'; range.value = '100';
      range.setAttribute('aria-label', `${st.label} volume`);
      const out = document.createElement('output');
      out.textContent = '100%';
      vol.append(range, out);
      ctl.append(top, vol);

      const canvas = document.createElement('canvas');
      canvas.setAttribute('role', 'img');
      canvas.setAttribute('aria-label', `${st.label} waveform`);
      lane.append(ctl, canvas);
      host.insertBefore(lane, host.querySelector('.phwrap'));
      lanes[st.id] = { lane, cb, only, range, out, canvas };

      cb.addEventListener('change', () => { S.mix[st.id].on = cb.checked; applyMix(); });
      only.addEventListener('click', () => { P.selectOnly(S.mix, [st.id]); applyMix(); });
      range.addEventListener('input', () => { S.mix[st.id].gain = Number(range.value) / 100; out.textContent = range.value + '%'; applyMix(); });
      range.addEventListener('dblclick', () => { range.value = '100'; range.dispatchEvent(new Event('input')); });
      canvas.addEventListener('pointerdown', (e) => beginSeek(e, canvas));
    }
    new ResizeObserver(() => drawAll()).observe(host);
  }

  function buildPresets() {
    const host = $('presets');
    for (const p of P.PRESETS) {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'chip'; b.textContent = p.label; b.dataset.preset = p.id;
      b.setAttribute('aria-pressed', 'false');
      b.addEventListener('click', () => { P.selectOnly(S.mix, p.stems); applyMix(); });
      host.append(b);
    }
    const sel = $('format');
    for (const [k, f] of Object.entries(P.FORMATS)) { const o = document.createElement('option'); o.value = k; o.textContent = f.label; sel.append(o); }
    const saved = store.get('ss.format');
    S.format = saved && P.FORMATS[saved] ? saved : 'mp3';
    sel.value = S.format;
    sel.addEventListener('change', () => { S.format = sel.value; store.set('ss.format', S.format); applyMix(); });
  }

  /** Make everything on screen match S.mix: ticks, dimming, preset chips, the sound, the summary. */
  function applyMix() {
    for (const id of P.STEM_IDS) {
      const l = lanes[id]; const m = S.mix[id];
      l.cb.checked = m.on;
      l.lane.classList.toggle('off', !m.on);
      l.range.value = String(Math.round(m.gain * 100));
      l.out.textContent = Math.round(m.gain * 100) + '%';
    }
    const hit = P.matchingPreset(S.mix);
    for (const b of $('presets').children) b.setAttribute('aria-pressed', String(b.dataset.preset === hit));
    applyGains();
    const ids = activeIds();
    const sum = $('summary');
    sum.textContent = '';
    if (ids.length) {
      const b = document.createElement('b'); b.textContent = P.describe(ids);
      sum.append('Saves: ', b, S.song ? ' · ' + P.formatTime(S.song.duration) : '');
    } else sum.textContent = 'Tick at least one stem to save a mix.';
    refreshButtons();
  }

  // ---- waveforms ------------------------------------------------------------------------------------------------------------
  function computePeaks(buf) {
    const len = buf.length;
    const out = new Float32Array(PEAK_BUCKETS * 2);
    const chans = [buf.getChannelData(0), buf.numberOfChannels > 1 ? buf.getChannelData(1) : buf.getChannelData(0)];
    for (let b = 0; b < PEAK_BUCKETS; b++) {
      const a = Math.floor((b * len) / PEAK_BUCKETS);
      const z = Math.max(a + 1, Math.floor(((b + 1) * len) / PEAK_BUCKETS));
      let lo = 0, hi = 0;
      for (const ch of chans) for (let i = a; i < z; i++) { const v = ch[i]; if (v < lo) lo = v; else if (v > hi) hi = v; }
      out[b * 2] = lo; out[b * 2 + 1] = hi;
    }
    return out;
  }
  function drawLane(id) {
    const { canvas } = lanes[id];
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
    const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    const g = canvas.getContext('2d');
    g.clearRect(0, 0, w, h);
    const pk = S.peaks[id];
    const mid = h / 2;
    g.fillStyle = P.STEMS.find((s) => s.id === id).color;
    if (!pk) { g.globalAlpha = 0.35; g.fillRect(0, mid - 0.5, w, 1); g.globalAlpha = 1; return; }
    // a common scale for all six lanes would make quiet stems invisible; each lane is scaled to its own loudest part
    let top = 0.001;
    for (let i = 0; i < pk.length; i++) top = Math.max(top, Math.abs(pk[i]));
    const k = (mid - 2) / top;
    for (let x = 0; x < w; x++) {
      const b0 = Math.floor((x * PEAK_BUCKETS) / w);
      const b1 = Math.max(b0 + 1, Math.floor(((x + 1) * PEAK_BUCKETS) / w));
      let lo = 0, hi = 0;
      for (let b = b0; b < b1 && b < PEAK_BUCKETS; b++) { if (pk[b * 2] < lo) lo = pk[b * 2]; if (pk[b * 2 + 1] > hi) hi = pk[b * 2 + 1]; }
      const y0 = mid - hi * k;
      const y1 = mid - lo * k;
      g.fillRect(x, y0, 1, Math.max(1, y1 - y0));
    }
  }
  const drawAll = () => { if (S.view === 'ready') for (const id of P.STEM_IDS) drawLane(id); };

  // ---- sound ---------------------------------------------------------------------------------------------------------------------
  function ensureAudio() {
    if (ac) return;
    ac = new AudioContext({ sampleRate: P.SAMPLE_RATE, latencyHint: 'interactive' });
    // a gentle safety limiter so boosting a stem cannot distort the speakers (the saved file has a real limiter)
    master = ac.createDynamicsCompressor();
    master.threshold.value = -1; master.knee.value = 0; master.ratio.value = 20; master.attack.value = 0.003; master.release.value = 0.1;
    master.connect(ac.destination);
    for (const id of P.STEM_IDS) { nodes[id] = ac.createGain(); nodes[id].gain.value = S.mix[id].on ? S.mix[id].gain : 0; nodes[id].connect(master); }
  }
  function applyGains() {
    if (!ac) return;
    for (const id of P.STEM_IDS) nodes[id].gain.setTargetAtTime(S.mix[id].on ? S.mix[id].gain : 0, ac.currentTime, 0.015);
  }
  const duration = () => (S.song ? S.song.duration : 0);
  const position = () => Math.min(duration(), S.playing ? S.offset + (ac.currentTime - S.startedAt) : S.offset);

  function stopSources() {
    for (const s of sources) { s.onended = null; try { s.stop(); } catch { /* not started */ } try { s.disconnect(); } catch { /* ignore */ } }
    sources = [];
  }
  function startSources() {
    stopSources();
    for (const id of P.STEM_IDS) {
      const s = ac.createBufferSource();
      s.buffer = S.buffers[id];
      s.connect(nodes[id]);
      s.start(0, Math.min(S.offset, S.buffers[id].duration - 0.001));
      sources.push(s);
    }
    S.startedAt = ac.currentTime;
  }
  async function play() {
    if (!previewReady()) return;
    ensureAudio();
    if (ac.state === 'suspended') await ac.resume();
    if (S.offset >= duration() - 0.05) S.offset = 0;
    applyGains();
    startSources();
    S.playing = true;
    $('play').textContent = '❚❚ Pause';
    tick();
  }
  function pause() {
    if (S.playing) S.offset = position();
    S.playing = false;
    stopSources();
    $('play').textContent = '▶ Play';
    cancelAnimationFrame(raf);
    paintClock();
  }
  const togglePlay = () => (S.playing ? pause() : play());
  function paintClock() {
    const t = position();
    $('pos').textContent = P.formatTime(t);
    $('playhead').style.left = (duration() ? (t / duration()) * 100 : 0) + '%';
  }
  function tick() {
    paintClock();
    if (!S.playing) return;
    if (position() >= duration() - 0.02) { S.offset = 0; pause(); return; }
    raf = requestAnimationFrame(tick);
  }
  function seekTo(frac) {
    S.offset = Math.max(0, Math.min(1, frac)) * duration();
    if (S.playing) startSources();
    paintClock();
  }
  function beginSeek(e, canvas) {
    if (!previewReady()) return;
    const move = (ev) => { const r = canvas.getBoundingClientRect(); seekTo((ev.clientX - r.left) / r.width); };
    canvas.setPointerCapture(e.pointerId);
    move(e);
    const up = () => { canvas.removeEventListener('pointermove', move); canvas.removeEventListener('pointerup', up); canvas.removeEventListener('pointercancel', up); };
    canvas.addEventListener('pointermove', move); canvas.addEventListener('pointerup', up); canvas.addEventListener('pointercancel', up);
  }

  // ---- opening and splitting ---------------------------------------------------------------------------------------------------------
  function resetSong() {
    pause();
    S.offset = 0;
    S.buffers = {}; S.peaks = {}; S.stems = null; S.result = null;
    S.mix = P.newMix();
    $('result').hidden = true; $('exportProgress').hidden = true;
    if (S.song) window.ss.forget(S.song.id);
    S.song = null;
  }

  async function handleOpened(r) {
    if (S.busy) return;
    if (!r) return;
    if (!r.ok) { banner(`${r.name ? r.name + ': ' : ''}${r.error || 'Could not open this file'}`); return; }
    banner('');
    resetSong();
    S.song = r;
    if (r.note) toast(r.note);
    $('cName').textContent = $('wName').textContent = $('rName').textContent = r.name;
    if (r.cached || r.duration <= CONFIRM_OVER) await startSplit();
    else {
      $('cInfo').textContent = `${P.formatTime(r.duration)} long. Splitting will take about ${fmtSpan(r.estimate)} on this computer.`;
      showView('confirm');
    }
  }

  async function startSplit() {
    const song = S.song;
    if (!song || S.busy) return;
    S.busy = true;
    setProgress(0, true);
    $('wPhase').textContent = song.cached ? 'Opening saved stems…' : 'Reading the song…';
    $('wEta').innerHTML = '&nbsp;';
    showView('working');
    const res = await window.ss.split(song.id);
    if (S.song !== song) { S.busy = false; return; }
    if (!res.ok) {
      S.busy = false;
      if (res.cancelled) { toast('Cancelled'); $('cInfo').textContent = 'Splitting was cancelled.'; showView('confirm'); return; }
      banner(res.error || 'Splitting failed');
      $('cInfo').textContent = 'Splitting did not finish.';
      showView('confirm');
      return;
    }
    S.stems = res.stems;
    song.fromCache = res.fromCache; song.splitSeconds = res.seconds; song.duration = res.duration;
    if (song.previewOk) {
      $('wPhase').textContent = 'Preparing the preview…';
      setProgress(0, false);
      try { await loadBuffers(); } catch (e) { banner('The preview could not be prepared: ' + (e && e.message ? e.message : e)); song.previewOk = false; S.buffers = {}; S.peaks = {}; }
    }
    S.busy = false;
    $('len').textContent = P.formatTime(song.duration);
    $('rInfo').textContent = `${P.formatTime(song.duration)} · ${res.fromCache ? 'opened from saved stems' : `split in ${fmtSpan(res.seconds)}`}`;
    $('noPreview').hidden = song.previewOk;
    $('lanes').classList.toggle('nopreview', !song.previewOk);
    showView('ready');
    applyMix();
    paintClock();
    // draw now (reading clientWidth forces the layout), not in a frame callback: a window that is minimised or hidden while
    // the split runs gets no frames, and the lanes would stay blank until it is shown again
    drawAll();
    requestAnimationFrame(drawAll);
    refreshCache();
  }

  async function loadBuffers() {
    ensureAudio();
    let n = 0;
    for (const id of P.STEM_IDS) {
      const r = await fetch(S.stems[id]);
      if (!r.ok) throw new Error(`${id}: ${r.status}`);
      S.buffers[id] = await ac.decodeAudioData(await r.arrayBuffer());
      S.peaks[id] = computePeaks(S.buffers[id]);
      n++;
      setProgress(n / P.STEM_IDS.length, false);
    }
  }

  function setProgress(f, indeterminate) {
    const bar = $('wBar');
    bar.classList.toggle('indeterminate', !!indeterminate);
    const pct = Math.round(Math.max(0, Math.min(1, f)) * 100);
    $('wFill').style.width = indeterminate ? '' : pct + '%';
    bar.setAttribute('aria-valuenow', String(pct));
  }

  window.ss.onProgress((p) => {
    if (p.kind === 'split' && S.view === 'working') {
      if (p.phase === 'read') { $('wPhase').textContent = 'Reading the song…'; setProgress(p.fraction, true); }
      else if (p.phase === 'load') { $('wPhase').textContent = 'Loading the separation model…'; setProgress(0, true); }
      else {
        $('wPhase').textContent = `Separating… ${Math.round(p.fraction * 100)}%`;
        setProgress(p.fraction, false);
        $('wEta').textContent = p.etaSeconds > 0 ? `About ${P.formatTime(Math.ceil(p.etaSeconds))} left` : 'Finishing…';
      }
    } else if (p.kind === 'export') {
      $('exportFill').style.width = Math.round(p.fraction * 100) + '%';
    }
  });
  window.ss.onOpened(handleOpened);

  // ---- saving -------------------------------------------------------------------------------------------------------------------------
  async function doExport() {
    if (S.busy || !S.song) return;
    let mix;
    try { P.activeStems(S.mix); mix = JSON.parse(JSON.stringify(S.mix)); } catch (e) { toast(e.message, 'err'); return; }
    const wasPlaying = S.playing;
    if (wasPlaying) pause();
    S.busy = true;
    $('result').hidden = true;
    $('exportFill').style.width = '0%'; $('exportProgress').hidden = false;
    $('exportCancel').hidden = false; $('exportBtn').hidden = true;
    refreshButtons();
    const res = await window.ss.exportMix(S.song.id, mix, S.format);
    S.busy = false;
    $('exportProgress').hidden = true; $('exportCancel').hidden = true; $('exportBtn').hidden = false;
    refreshButtons();
    if (res.dialogCancelled) return;
    if (res.cancelled) { toast('Cancelled'); return; }
    showResult(res);
  }
  function showResult(res) {
    const box = $('result');
    box.textContent = '';
    if (res.ok) {
      box.className = 'result ok';
      const msg = document.createElement('span');
      msg.textContent = `Saved ${res.what} · ${fmtBytes(res.bytes)}`;
      const path = document.createElement('span');
      path.className = 'path'; path.textContent = res.output; path.title = res.output;
      const show = document.createElement('button');
      show.className = 'btn small'; show.textContent = 'Show in folder';
      show.addEventListener('click', () => window.ss.reveal(res.output));
      box.append(msg, show, path);
    } else {
      box.className = 'result err';
      box.textContent = res.error || 'Saving failed';
    }
    box.hidden = false;
    S.result = res;
  }

  async function refreshCache() {
    const c = await window.ss.cacheInfo();
    $('cacheInfo').textContent = c.count ? `${c.count} saved ${c.count === 1 ? 'song' : 'songs'} · ${fmtBytes(c.bytes)}` : '';
    $('clearCache').hidden = !c.count;
  }

  // ---- wiring ---------------------------------------------------------------------------------------------------------------------------
  async function pick() { if (S.busy) return; const r = await window.ss.pickSong(); if (r) handleOpened(r); }
  $('open').addEventListener('click', pick);
  $('open2').addEventListener('click', (e) => { e.stopPropagation(); pick(); });
  $('empty').addEventListener('click', pick);
  $('empty').addEventListener('keydown', (e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target === $('empty')) { e.preventDefault(); pick(); } });
  $('splitBtn').addEventListener('click', startSplit);
  $('cancelBtn').addEventListener('click', () => { window.ss.cancel(); $('wPhase').textContent = 'Cancelling…'; });
  $('exportCancel').addEventListener('click', () => window.ss.cancel());
  $('exportBtn').addEventListener('click', doExport);
  $('play').addEventListener('click', togglePlay);
  $('clearCache').addEventListener('click', async () => {
    const r = await window.ss.cacheClear();
    toast(r.removed ? `Deleted ${r.removed} saved ${r.removed === 1 ? 'song' : 'songs'}` : 'Nothing to delete');
    refreshCache();
  });

  let dragDepth = 0;
  const hasFiles = (e) => e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
  window.addEventListener('dragenter', (e) => { if (hasFiles(e)) { dragDepth++; document.body.classList.add('dragging'); } });
  window.addEventListener('dragleave', (e) => { if (hasFiles(e) && --dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('dragging'); } });
  window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
  window.addEventListener('drop', async (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault(); dragDepth = 0; document.body.classList.remove('dragging');
    if (S.busy) { toast('Wait for the current job to finish', 'err'); return; }
    const paths = Array.from(e.dataTransfer.files).map((f) => window.ss.pathForFile(f)).filter(Boolean);
    if (paths.length) handleOpened(await window.ss.openPaths(paths));
  });

  window.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target;
    const typing = t && (t.tagName === 'INPUT' && t.type !== 'checkbox' && t.type !== 'range' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA');
    if (typing || S.view !== 'ready') return;
    if (e.key === ' ' && !(t && t.tagName === 'BUTTON')) { e.preventDefault(); togglePlay(); return; }
    if (/^[1-6]$/.test(e.key)) { const id = P.STEM_IDS[Number(e.key) - 1]; S.mix[id].on = !S.mix[id].on; applyMix(); }
  });

  // ---- start ------------------------------------------------------------------------------------------------------------------------------
  buildLanes();
  buildPresets();
  applyMix();
  showView('empty');
  refreshCache();
  window.ss.engine().then((r) => {
    const w = $('engineWarn');
    if (!r.ok) { w.textContent = r.problems.join(' '); w.hidden = false; $('open').disabled = true; $('open2').disabled = true; S.busy = true; }
    else if (r.warnings && r.warnings.length) { w.textContent = r.warnings.join(' '); w.hidden = false; }
  });

  if (location.hash === '#e2e') window.__app = { S, P, lanes, applyMix, play, pause, seekTo, position, handleOpened, startSplit, doExport, drawLane, showView, audio: () => ({ ac, nodes }) };
})();
