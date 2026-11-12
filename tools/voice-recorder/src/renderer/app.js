'use strict';
(() => {
  const vr = window.vr;
  const $ = (id) => document.getElementById(id);
  const el = (tag, attrs, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) { if (v === false || v == null) continue; if (k === 'class') n.className = v; else n.setAttribute(k, v === true ? '' : v); }
    for (const kid of kids) if (kid != null) n.append(kid);
    return n;
  };
  const store = {
    get(k, d) { try { const v = localStorage.getItem('vr.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem('vr.' + k, JSON.stringify(v)); } catch { /* private mode: fine */ } },
  };
  const fmtTime = (s, tenths = true) => {
    if (!Number.isFinite(s) || s < 0) s = 0;
    const h = Math.floor(s / 3600); const m = Math.floor((s % 3600) / 60); const sec = s % 60;
    const ss = tenths ? sec.toFixed(1).padStart(4, '0') : String(Math.floor(sec)).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
  };
  const fmtBytes = (b) => (b >= 1e9 ? (b / 1e9).toFixed(1) + ' GB' : b >= 1e6 ? (b / 1e6).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1e3)) + ' KB');
  const fmtDate = (iso) => { const d = new Date(iso); return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) + ' · ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }); };

  const DEFAULTS = { highpass: { on: true, freq: 80 }, declick: false, deess: false, denoise: { on: true, strength: 'medium' }, pauses: { on: false, longer: 1.5, keep: 0.6 }, loudness: { on: true, target: -16 } };
  const S = {
    folder: '', takes: [], current: null, info: null, sel: null, perTake: new Map(), base: { ...DEFAULTS, ...store.get('clean', {}) },
    preview: null, listen: 'A', rec: null, mic: { stream: null, ctx: null, node: null, sampleRate: 0, ok: false }, levels: [], clipUntil: 0, freeBytes: null,
    exporting: false,
  };

  // ---- messages ----------------------------------------------------------------------------------------------------------
  let toastTimer = null;
  function toast(text, err = false) {
    const t = $('toast'); t.textContent = text; t.className = 'toast' + (err ? ' err' : ''); t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 4200);
  }
  function banner(text, kind) { const b = $('banner'); b.textContent = text || ''; b.className = 'banner' + (kind ? ' ' + kind : ''); b.hidden = !text; }
  function result(text, kind, revealPath) {
    const r = $('result'); $('resultText').textContent = text || ''; r.className = 'result' + (kind ? ' ' + kind : ''); r.hidden = !text;
    $('resultReveal').hidden = !revealPath; $('resultReveal').dataset.path = revealPath || '';
  }
  const plain = (e) => String((e && e.message) || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

  // ---- the microphone ----------------------------------------------------------------------------------------------------
  async function listMics() {
    let devs = [];
    try { devs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput'); } catch { /* none */ }
    const sel = $('mic');
    const keep = sel.value || store.get('mic', '');
    sel.replaceChildren(...devs.map((d, i) => el('option', { value: d.deviceId }, d.label || (d.deviceId === 'default' ? 'Default microphone' : `Microphone ${i + 1}`))));
    if (!devs.length) sel.append(el('option', { value: '' }, 'No microphone found'));
    if (devs.some((d) => d.deviceId === keep)) sel.value = keep;
    return devs;
  }

  async function armMic(deviceId) {
    disarmMic();
    const constraints = { audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: { ideal: 1 } } };
    if (deviceId) constraints.audio.deviceId = { exact: deviceId };
    let stream;
    try { stream = await navigator.mediaDevices.getUserMedia(constraints); }
    catch (e) {
      S.mic.ok = false; paintRec();
      const why = e && e.name === 'NotAllowedError' ? 'The microphone was not allowed. Check your system\'s privacy settings for the microphone, then restart this tool.'
        : e && (e.name === 'NotFoundError' || e.name === 'OverconstrainedError') ? 'No microphone found. Plug one in - it will show up in the list.'
          : 'The microphone could not be opened: ' + ((e && e.message) || e);
      setHint(why, 'err');
      return false;
    }
    const ctx = new AudioContext({ latencyHint: 'interactive' });
    const src = ctx.createMediaStreamSource(stream);
    let node;
    try {
      await ctx.audioWorklet.addModule('capture.js');
      node = new AudioWorkletNode(ctx, 'vr-capture', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
      node.port.onmessage = (e) => onBlock(e.data);
    } catch {
      // older engines: the deprecated ScriptProcessor does the same job
      node = ctx.createScriptProcessor(2048, 1, 1);
      node.onaudioprocess = (e) => {
        const x = e.inputBuffer.getChannelData(0); const pcm = new Int16Array(x.length); let peak = 0; let sum = 0;
        for (let i = 0; i < x.length; i++) { const v = Math.max(-1, Math.min(1, x[i])); const a = Math.abs(v); if (a > peak) peak = a; sum += v * v; pcm[i] = v < 0 ? v * 32768 : v * 32767; }
        onBlock({ pcm: pcm.buffer, peak, rms: Math.sqrt(sum / x.length) });
      };
    }
    src.connect(node);
    node.connect(ctx.destination); // silent: the node writes nothing to its output
    if (ctx.state === 'suspended') { try { await ctx.resume(); } catch { /* resumes on the first click */ } }
    S.mic = { stream, ctx, node, sampleRate: ctx.sampleRate, ok: true, label: (stream.getAudioTracks()[0] || {}).label || '' };
    stream.getAudioTracks().forEach((t) => t.addEventListener('ended', () => { if (S.rec) { toast('The microphone was disconnected - the recording so far is saved.', true); stopRec(); } S.mic.ok = false; setHint('The microphone was disconnected.', 'err'); paintRec(); }));
    await listMics();
    setHint('Listening. Speak to check the level.', '');
    paintRec();
    return true;
  }
  function disarmMic() {
    const m = S.mic;
    try { if (m.node) { m.node.disconnect(); if (m.node.port) m.node.port.onmessage = null; } } catch { /* ignore */ }
    try { if (m.stream) m.stream.getTracks().forEach((t) => t.stop()); } catch { /* ignore */ }
    try { if (m.ctx) m.ctx.close(); } catch { /* ignore */ }
    S.mic = { stream: null, ctx: null, node: null, sampleRate: 0, ok: false };
  }

  // ---- level meter ------------------------------------------------------------------------------------------------------------
  const DB_MIN = -60;
  const toPct = (lin) => { const db = 20 * Math.log10(lin + 1e-9); return Math.max(0, Math.min(100, ((db - DB_MIN) / -DB_MIN) * 100)); };
  let meterPeak = 0; let meterRms = 0; let hintAt = 0;
  function setHint(text, kind) { const h = $('hint'); h.textContent = text; h.className = 'hint small ' + (kind || 'muted'); }
  function onBlock(b) {
    meterPeak = Math.max(b.peak, meterPeak * 0.92);
    meterRms = Math.max(b.rms, meterRms * 0.85);
    const now = performance.now();
    if (b.peak >= 0.985) S.clipUntil = now + 2000;
    S.levels.push(b.peak); if (S.levels.length > 120) S.levels.shift(); // about 5 seconds of block peaks
    if (S.rec && !S.rec.paused) {
      S.rec.pending.push(new Int16Array(b.pcm));
      S.rec.frames += b.pcm.byteLength / 2;
      if (S.rec.frames - S.rec.flushedAt >= S.mic.sampleRate / 4) flush();
    }
    if (now - hintAt > 500) { hintAt = now; levelHint(); }
  }
  function flush() {
    const r = S.rec; if (!r || !r.pending.length) return;
    const n = r.pending.reduce((s, p) => s + p.length, 0);
    const all = new Int16Array(n); let o = 0;
    for (const p of r.pending) { all.set(p, o); o += p.length; }
    r.pending = []; r.flushedAt = r.frames;
    vr.recChunk(all.buffer);
  }
  function levelHint() {
    if (!S.mic.ok || S.levels.length < 20) return;
    const max = Math.max(...S.levels);
    if (performance.now() < S.clipUntil) setHint('Too loud - it clips. Turn the microphone down in your system sound settings, or move back a little.', 'err');
    else if (max < 0.03) setHint('Very quiet. Move closer, or turn the microphone up in your system sound settings.', 'warn');
    else if (max < 0.12) setHint('A little quiet, but fine: "Even out loudness" will bring it up.', '');
    else setHint('The level looks good.', 'ok');
  }
  function drawMeter() {
    const w = $('meter').clientWidth;
    $('meter').style.setProperty('--meter-w', w + 'px');
    $('meterRms').style.width = toPct(meterRms) + '%';
    $('meterPeak').style.left = `calc(${toPct(meterPeak)}% - 2px)`;
    $('meter').setAttribute('aria-valuenow', String(Math.round(20 * Math.log10(meterPeak + 1e-9))));
    $('clip').hidden = performance.now() >= S.clipUntil;
    if (S.rec) $('timer').textContent = fmtTime(S.rec.frames / S.mic.sampleRate);
    requestAnimationFrame(drawMeter);
  }

  // ---- recording -----------------------------------------------------------------------------------------------------------
  async function startRec() {
    if (S.rec || !S.mic.ok) return;
    if (S.mic.ctx.state === 'suspended') await S.mic.ctx.resume();
    try {
      const r = await vr.recStart({ sampleRate: S.mic.sampleRate });
      S.rec = { name: r.name, frames: 0, flushedAt: 0, pending: [], paused: false, markers: [], bytesPerSecond: r.bytesPerSecond };
      if (r.freeBytes != null) S.freeBytes = r.freeBytes;
      $('timer').textContent = '0:00.0';
      $('markers').textContent = '';
      document.body.classList.add('recording');
      paintRec();
    } catch (e) { toast(plain(e), true); }
  }
  async function togglePause() {
    const r = S.rec; if (!r) return;
    if (!r.paused) { flush(); r.paused = true; await vr.recPause(); } else { r.paused = false; await vr.recResume(); }
    paintRec();
  }
  async function addMarker() {
    const r = S.rec; if (!r) return;
    const t = r.frames / S.mic.sampleRate;
    flush();
    try {
      const m = await vr.recMark(t);
      r.markers.push(m.t);
      $('markers').textContent = r.markers.map((x, i) => `M${i + 1} ${fmtTime(x, false)}`).join('  ');
      toast(`Marker ${m.n} at ${fmtTime(m.t)}`);
    } catch (e) { toast(plain(e), true); }
  }
  async function stopRec() {
    const r = S.rec; if (!r) return;
    flush();
    S.rec = null;
    document.body.classList.remove('recording');
    paintRec();
    try {
      const res = await vr.recStop();
      S.takes = res.takes;
      paintTakes();
      if (res.take) { toast(`Saved ${fmtTime(res.take.duration)} as "${res.take.name}"`); await openTake(res.take.name); }
      else toast('Nothing was recorded.');
    } catch (e) { toast(plain(e), true); }
  }
  async function discardRec() {
    if (!S.rec) return;
    if (!window.confirm('Throw this recording away? It cannot be brought back.')) return;
    S.rec = null;
    document.body.classList.remove('recording');
    await vr.recDiscard();
    $('timer').textContent = '0:00.0';
    paintRec();
    toast('The recording was thrown away.');
  }
  function paintRec() {
    const r = S.rec;
    $('rec').disabled = !S.mic.ok || !!r;
    $('pause').disabled = !r; $('mark').disabled = !r || r.paused; $('stop').disabled = !r; $('discard').disabled = !r;
    $('mic').disabled = !!r; $('chooseFolder').disabled = !!r;
    $('pause').textContent = r && r.paused ? 'Resume' : 'Pause';
    const st = $('recState');
    st.textContent = r ? (r.paused ? 'Paused' : 'Recording') : S.mic.ok ? 'Ready' : 'No microphone';
    st.className = 'chip' + (r ? (r.paused ? ' paused' : ' live') : '');
    paintSpace();
  }
  function paintSpace() {
    if (S.freeBytes == null) { $('space').textContent = ''; return; }
    const bps = (S.mic.sampleRate || 48000) * 2;
    const hours = S.freeBytes / bps / 3600;
    $('space').textContent = hours > 99 ? 'Plenty of space for recordings' : `Space for about ${hours >= 1 ? Math.floor(hours) + ' h ' : ''}${Math.floor((hours % 1) * 60)} min of recording`;
  }

  // ---- takes ------------------------------------------------------------------------------------------------------------------------
  const takeLabel = (t) => t.title || fmtDate(t.date);
  function paintTakes() {
    const list = $('takeList');
    list.replaceChildren(...S.takes.map((t) => {
      const b = el('button', { class: 'item' + (S.current === t.name ? ' sel' : ''), role: 'option', 'aria-selected': S.current === t.name ? 'true' : 'false', 'data-name': t.name },
        el('div', { class: 't trunc' }, takeLabel(t)),
        el('div', { class: 'd' }, el('span', null, fmtTime(t.duration, false)), el('span', null, t.title ? fmtDate(t.date) : fmtBytes(t.bytes)), t.markers.length ? el('span', null, `${t.markers.length} marker${t.markers.length > 1 ? 's' : ''}`) : null, t.recovered ? el('span', { class: 'tag' }, 'recovered') : null, t.problem ? el('span', { class: 'tag' }, 'unreadable') : null));
      b.addEventListener('click', () => openTake(t.name));
      return b;
    }));
    $('takeCount').textContent = S.takes.length ? String(S.takes.length) : '';
    $('noTakes').hidden = S.takes.length > 0;
  }
  const optsFor = (name) => {
    if (!S.perTake.has(name)) S.perTake.set(name, JSON.parse(JSON.stringify({ ...S.base, trim: null, denoise: { ...S.base.denoise, sample: null } })));
    return S.perTake.get(name);
  };
  async function openTake(name) {
    const t = S.takes.find((x) => x.name === name);
    if (!t) return;
    stopPlayer();
    S.current = name; S.info = null; S.sel = null; S.preview = null; setListen('A');
    paintTakes();
    $('noTake').hidden = true; $('editor').hidden = false;
    $('title').value = t.title;
    $('meta').textContent = `${fmtDate(t.date)} · ${fmtTime(t.duration, false)} · ${fmtBytes(t.bytes)}${t.sampleRate ? ' · ' + (t.sampleRate / 1000) + ' kHz' : ''}`;
    result('');
    $('waveLoading').hidden = false;
    paintOpts(); paintSel();
    try {
      const info = await vr.analyse(name);
      if (S.current !== name) return;
      S.info = info;
      $('player').src = `vr://take/${encodeURIComponent(name)}`;
    } catch (e) { result(plain(e), 'err'); }
    $('waveLoading').hidden = true;
    paintOpts(); drawWave();
  }

  async function renameCurrent() {
    const t = S.takes.find((x) => x.name === S.current);
    const title = $('title').value.trim();
    if (!t || title === t.title) return;
    try {
      const was = S.current;
      const r = await vr.rename(was, title);
      S.takes = r.takes;
      if (S.perTake.has(was)) { S.perTake.set(r.name, S.perTake.get(was)); S.perTake.delete(was); }
      S.current = r.name;
      const pos = $('player').currentTime;
      $('player').src = `vr://take/${encodeURIComponent(r.name)}`; $('player').currentTime = pos;
      paintTakes();
      toast('Renamed');
    } catch (e) { toast(plain(e), true); $('title').value = t.title; }
  }
  async function deleteCurrent() {
    const t = S.takes.find((x) => x.name === S.current);
    if (!t) return;
    if (!window.confirm(`Move "${takeLabel(t)}" to the Recycle Bin?`)) return;
    stopPlayer(); $('player').removeAttribute('src');
    try {
      const r = await vr.remove(t.name);
      S.takes = r.takes; S.current = null; S.info = null;
      $('editor').hidden = true; $('noTake').hidden = false;
      paintTakes();
      toast('Moved to the Recycle Bin');
    } catch (e) { toast(plain(e), true); }
  }

  // ---- waveform ----------------------------------------------------------------------------------------------------------------
  const cv = $('wave');
  const timeAt = (x) => { const r = cv.getBoundingClientRect(); return Math.max(0, Math.min(1, (x - r.left) / r.width)) * (S.info ? S.info.duration : 0); };
  function drawWave() {
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(cv.clientWidth * dpr)); const h = Math.max(1, Math.round(cv.clientHeight * dpr));
    if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
    const g = cv.getContext('2d');
    g.clearRect(0, 0, w, h);
    const info = S.info; if (!info) return;
    const dur = info.duration || 1; const X = (t) => (t / dur) * w;
    const o = S.current ? optsFor(S.current) : null;
    const css = getComputedStyle(document.documentElement);
    const accent = css.getPropertyValue('--accent').trim() || '#e879f9';
    // the noise sample
    const ns = o && o.denoise.on ? (o.denoise.sample || info.quiet) : null;
    if (ns) { g.fillStyle = 'rgba(242,177,60,0.16)'; g.fillRect(X(ns.start), 0, Math.max(1, X(ns.end) - X(ns.start)), h); }
    // the wave
    const wf = info.waveform; const mid = h / 2;
    g.fillStyle = accent;
    for (let i = 0; i < wf.length; i++) {
      const x0 = Math.floor((i / wf.length) * w); const x1 = Math.max(x0 + 1, Math.floor(((i + 1) / wf.length) * w));
      const a = Math.max(1, Math.min(1, wf[i] * 1.15) * (mid - 4));
      g.fillRect(x0, mid - a, x1 - x0, a * 2);
    }
    g.fillStyle = 'rgba(255,255,255,0.08)'; g.fillRect(0, mid, w, 1);
    // trimmed-away parts are dimmed
    if (o && o.trim) {
      g.fillStyle = 'rgba(11,11,13,0.72)';
      g.fillRect(0, 0, X(o.trim.start), h); g.fillRect(X(o.trim.end), 0, w - X(o.trim.end), h);
    }
    if (S.sel) { g.fillStyle = 'rgba(243,243,244,0.14)'; g.fillRect(X(S.sel.start), 0, Math.max(1, X(S.sel.end) - X(S.sel.start)), h); g.fillStyle = 'rgba(243,243,244,0.6)'; g.fillRect(X(S.sel.start), 0, dpr, h); g.fillRect(X(S.sel.end), 0, dpr, h); }
    // markers
    g.font = `${10 * dpr}px ui-monospace, Consolas, monospace`;
    (info.markers || []).forEach((m, i) => { g.fillStyle = '#4fdba0'; g.fillRect(X(m.t), 0, Math.max(1, dpr), h); g.fillText(`M${i + 1}`, X(m.t) + 3 * dpr, 11 * dpr); });
    // playhead (only while listening to the original)
    const p = $('player');
    if (S.listen === 'A' && p.src) { g.fillStyle = '#f3f3f4'; g.fillRect(X(p.currentTime || 0), 0, Math.max(1, dpr * 1.5), h); }
  }
  let drag = null;
  cv.addEventListener('pointerdown', (e) => { if (!S.info) return; cv.setPointerCapture(e.pointerId); drag = { t0: timeAt(e.clientX), moved: false }; });
  cv.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const t = timeAt(e.clientX);
    if (Math.abs(t - drag.t0) > S.info.duration / 400) drag.moved = true;
    if (drag.moved) { S.sel = { start: Math.min(t, drag.t0), end: Math.max(t, drag.t0) }; paintSel(); drawWave(); }
  });
  cv.addEventListener('pointerup', (e) => {
    if (!drag) return;
    const d = drag; drag = null;
    if (!d.moved) { seekOriginal(timeAt(e.clientX)); }
  });
  function paintSel() {
    const s = S.sel;
    $('selTrim').disabled = !s; $('selNoise').disabled = !s; $('selClear').disabled = !s;
    $('selInfo').textContent = s ? `Selected ${fmtTime(s.start)} – ${fmtTime(s.end)} (${(s.end - s.start).toFixed(1)} s)` : 'Drag to select a part · click to listen from there';
  }

  // ---- cleaning settings -----------------------------------------------------------------------------------------------------
  function paintOpts() {
    if (!S.current) return;
    const o = optsFor(S.current);
    const dur = S.info ? S.info.duration : 0;
    $('trimOn').checked = !!o.trim;
    $('trimStart').value = o.trim ? o.trim.start.toFixed(1) : '0.0';
    $('trimEnd').value = o.trim ? o.trim.end.toFixed(1) : dur.toFixed(1);
    $('trimStart').max = $('trimEnd').max = String(dur);
    $('hpOn').checked = o.highpass.on; $('hpFreq').value = String(o.highpass.freq);
    $('nrOn').checked = o.denoise.on; $('nrStrength').value = o.denoise.strength;
    const q = o.denoise.sample || (S.info && S.info.quiet);
    $('nrFrom').textContent = o.denoise.sample ? `learned from ${fmtTime(q.start)}–${fmtTime(q.end)} (your pick)` : q ? `learned from the quietest part (${fmtTime(q.start)})` : S.info ? 'no quiet part found: follows the noise' : '';
    $('psOn').checked = o.pauses.on; $('psLonger').value = String(o.pauses.longer); $('psKeep').value = String(o.pauses.keep);
    $('ldOn').checked = o.loudness.on; $('ldTarget').value = String(o.loudness.target);
    $('dcOn').checked = o.declick; $('deOn').checked = o.deess;
    for (const [box, card] of [['trimOn', 'trimOn'], ['hpOn', 'hpOn'], ['nrOn', 'nrOn'], ['psOn', 'psOn'], ['ldOn', 'ldOn']]) $(card).closest('.opt').classList.toggle('off', !$(box).checked);
  }
  function readOpts() {
    const o = optsFor(S.current);
    const dur = S.info ? S.info.duration : 0;
    const num = (id, d) => { const v = parseFloat($(id).value); return Number.isFinite(v) ? v : d; };
    if ($('trimOn').checked) {
      const a = Math.max(0, Math.min(dur, num('trimStart', 0))); const b = Math.max(0, Math.min(dur, num('trimEnd', dur)));
      o.trim = b - a >= 0.1 ? { start: Math.min(a, b), end: Math.max(a, b) } : null;
      if (!o.trim) toast('The trim must keep at least a tenth of a second', true);
    } else o.trim = null;
    o.highpass = { on: $('hpOn').checked, freq: Number($('hpFreq').value) };
    o.denoise = { on: $('nrOn').checked, strength: $('nrStrength').value, sample: o.denoise.sample };
    o.pauses = { on: $('psOn').checked, longer: Math.max(0.3, num('psLonger', 1.5)), keep: Math.max(0, num('psKeep', 0.6)) };
    if (o.pauses.keep > o.pauses.longer) o.pauses.keep = o.pauses.longer;
    o.loudness = { on: $('ldOn').checked, target: Number($('ldTarget').value) };
    o.declick = $('dcOn').checked; o.deess = $('deOn').checked;
    // the switches (not the take-specific trim and noise sample) become the defaults for the next take
    S.base = { highpass: o.highpass, declick: o.declick, deess: o.deess, denoise: { on: o.denoise.on, strength: o.denoise.strength }, pauses: o.pauses, loudness: o.loudness };
    store.set('clean', S.base);
    paintOpts(); drawWave(); stalePreview();
  }
  for (const id of ['trimOn', 'trimStart', 'trimEnd', 'hpOn', 'hpFreq', 'nrOn', 'nrStrength', 'psOn', 'psLonger', 'psKeep', 'ldOn', 'ldTarget', 'dcOn', 'deOn']) $(id).addEventListener('change', readOpts);

  // ---- listening: original (A) and the cleaned preview (B) ---------------------------------------------------------------------
  const player = $('player');
  function stopPlayer() { try { player.pause(); } catch { /* ignore */ } paintPlay(); }
  function paintPlay() { $('play').textContent = player.paused ? '▶ Play' : '❚❚ Pause'; $('play').setAttribute('aria-label', player.paused ? 'Play' : 'Pause'); }
  function setListen(which) {
    S.listen = which;
    $('abA').setAttribute('aria-checked', String(which === 'A')); $('abB').setAttribute('aria-checked', String(which === 'B'));
    $('abB').disabled = !S.preview;
  }
  function seekOriginal(t) {
    if (S.listen !== 'A') switchTo('A', false);
    player.currentTime = t; drawWave(); posText();
  }
  function posText() {
    const t = player.currentTime || 0;
    $('pos').textContent = S.listen === 'A' ? `${fmtTime(t)} / ${fmtTime(S.info ? S.info.duration : 0)}` : `B ${fmtTime(t)} / ${fmtTime(S.preview ? S.preview.duration : 0)}`;
  }
  // Switch between the original and the preview at the matching place (scaled, since shortened pauses make B shorter).
  function switchTo(which, keepPlaying = !player.paused) {
    if (which === S.listen || (which === 'B' && !S.preview)) return;
    const pv = S.preview; const t = player.currentTime || 0;
    let to;
    if (which === 'B') { const rel = Math.max(0, Math.min(1, (t - pv.start) / Math.max(0.01, pv.end - pv.start))); to = rel * pv.duration; player.src = pv.url; }
    else { const rel = Math.max(0, Math.min(1, t / Math.max(0.01, pv ? pv.duration : 1))); to = pv ? pv.start + rel * (pv.end - pv.start) : 0; player.src = `vr://take/${encodeURIComponent(S.current)}`; }
    setListen(which);
    const go = () => { player.currentTime = to; if (keepPlaying) player.play().catch(() => {}); };
    if (player.readyState >= 1) go(); else player.addEventListener('loadedmetadata', go, { once: true });
    drawWave();
  }
  player.addEventListener('play', paintPlay); player.addEventListener('pause', paintPlay); player.addEventListener('ended', paintPlay);
  player.addEventListener('timeupdate', () => { posText(); if (S.listen === 'A') drawWave(); });
  $('play').addEventListener('click', () => { if (!player.src) return; if (player.paused) player.play().catch((e) => toast('Could not play: ' + plain(e), true)); else player.pause(); });
  $('abA').addEventListener('click', () => switchTo('A'));
  $('abB').addEventListener('click', () => switchTo('B'));

  function previewRange() {
    if (S.sel) return { start: S.sel.start, end: Math.min(S.sel.end, S.sel.start + 60) };
    const o = optsFor(S.current); const dur = S.info.duration;
    const a = S.listen === 'A' && player.currentTime > 0.05 ? player.currentTime : (o.trim ? o.trim.start : 0);
    return { start: a, end: Math.min(o.trim ? o.trim.end : dur, a + 20) };
  }
  let previewSeq = 0;
  async function makePreview(autoplay = true) {
    if (!S.current || !S.info) return;
    const seq = ++previewSeq;
    const range = previewRange();
    if (range.end - range.start < 0.2) { toast('Pick a longer part to preview', true); return; }
    $('preview').disabled = true; $('pvInfo').textContent = 'Cleaning the preview…';
    try {
      const r = await vr.preview(S.current, optsFor(S.current), range);
      if (seq !== previewSeq || r.cancelled) return;
      S.preview = r;
      const bits = [];
      if (r.loudness && Number.isFinite(r.loudness.i)) bits.push(`${r.loudness.i.toFixed(1)} LUFS`);
      if (r.cuts) bits.push(`${r.cuts} pause${r.cuts > 1 ? 's' : ''} shortened`);
      $('pvInfo').textContent = ['Preview ready', ...bits].join(' · ');
      $('pvInfo').title = `The preview covers ${fmtTime(r.start)} – ${fmtTime(r.end)} of the take`;
      player.pause();
      setListen('A');
      player.currentTime = r.start;
      switchTo('B', autoplay);
    } catch (e) { if (seq === previewSeq) { $('pvInfo').textContent = ''; toast(plain(e), true); } }
    finally { if (seq === previewSeq) $('preview').disabled = false; }
  }
  let staleTimer = null;
  function stalePreview() {
    if (!S.preview) return;
    $('pvInfo').textContent = 'Settings changed - updating the preview…';
    clearTimeout(staleTimer);
    staleTimer = setTimeout(() => {
      const wasB = S.listen === 'B'; const playing = !player.paused;
      if (wasB) { switchTo('A', false); }
      makePreview(wasB && playing);
    }, 700);
  }
  $('preview').addEventListener('click', () => makePreview(true));

  // ---- export -------------------------------------------------------------------------------------------------------------------
  async function doExport() {
    if (!S.current || S.exporting) return;
    const format = $('format').value; store.set('format', format);
    S.exporting = true;
    $('export').disabled = true; $('xbar').hidden = false; $('xfill').style.width = '0%'; $('xtext').textContent = 'Exporting…';
    result('');
    try {
      const r = await vr.exportTake(S.current, optsFor(S.current), { format, title: $('title').value.trim() });
      if (r.cancelled) result('Export cancelled - nothing was written.', '');
      else {
        const bits = [`${fmtTime(r.duration)}`];
        if (r.loudness && Number.isFinite(r.loudness.i)) bits.push(`${r.loudness.i.toFixed(1)} LUFS`);
        if (r.cuts) bits.push(`${r.cuts} long pause${r.cuts > 1 ? 's' : ''} shortened`);
        result(`Saved "${r.name}" · ${bits.join(' · ')}`, 'ok', r.path);
      }
    } catch (e) { result(plain(e), 'err'); }
    finally { S.exporting = false; $('export').disabled = false; $('xbar').hidden = true; }
  }
  vr.onExportProgress(({ p }) => { const pct = Math.round(p * 100); $('xfill').style.width = pct + '%'; $('xprog').setAttribute('aria-valuenow', String(pct)); $('xtext').textContent = `Exporting… ${pct}%`; });
  $('export').addEventListener('click', doExport);
  $('xcancel').addEventListener('click', () => vr.cancelExport());
  $('resultReveal').addEventListener('click', () => vr.revealExport($('resultReveal').dataset.path));

  // ---- wiring -------------------------------------------------------------------------------------------------------------------
  $('rec').addEventListener('click', startRec);
  $('pause').addEventListener('click', togglePause);
  $('mark').addEventListener('click', addMarker);
  $('stop').addEventListener('click', stopRec);
  $('discard').addEventListener('click', discardRec);
  $('mic').addEventListener('change', async () => { store.set('mic', $('mic').value); await armMic($('mic').value); });
  navigator.mediaDevices.addEventListener('devicechange', () => { listMics(); if (!S.mic.ok && !S.rec) armMic($('mic').value); });
  $('title').addEventListener('change', renameCurrent);
  $('title').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('title').blur(); } if (e.key === 'Escape') { const t = S.takes.find((x) => x.name === S.current); $('title').value = t ? t.title : ''; $('title').blur(); } });
  $('reveal').addEventListener('click', () => vr.reveal(S.current));
  $('delete').addEventListener('click', deleteCurrent);
  $('selClear').addEventListener('click', () => { S.sel = null; paintSel(); drawWave(); });
  $('selTrim').addEventListener('click', () => { const o = optsFor(S.current); o.trim = { ...S.sel }; S.sel = null; paintOpts(); paintSel(); drawWave(); stalePreview(); });
  $('selNoise').addEventListener('click', () => {
    const o = optsFor(S.current);
    if (S.sel.end - S.sel.start < 0.3) { toast('Select at least a third of a second of quiet', true); return; }
    o.denoise.sample = { start: S.sel.start, end: Math.min(S.sel.end, S.sel.start + 10) }; o.denoise.on = true;
    S.sel = null; paintOpts(); paintSel(); drawWave(); stalePreview();
    toast('The noise will be learned from that part');
  });
  $('chooseFolder').addEventListener('click', async () => {
    try {
      const r = await vr.chooseFolder();
      if (!r) return;
      applyFolder(r);
    } catch (e) { toast(plain(e), true); }
  });
  $('openFolder').addEventListener('click', () => vr.openFolder());
  document.addEventListener('keydown', (e) => {
    const tag = (e.target && e.target.tagName) || '';
    if (/^(INPUT|SELECT|TEXTAREA)$/.test(tag) || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === 'm' || e.key === 'M') { if (S.rec) { e.preventDefault(); addMarker(); } }
    else if (e.key === 'r' || e.key === 'R') { e.preventDefault(); if (S.rec) stopRec(); else startRec(); }
    else if (e.key === ' ' && S.rec) { e.preventDefault(); togglePause(); }
  });
  vr.onRecError((m) => toast('Could not write the recording: ' + m, true));
  window.addEventListener('resize', drawWave);

  function applyFolder(r) {
    S.folder = r.folder; S.takes = r.takes; S.freeBytes = r.freeBytes;
    $('folderName').textContent = '\u200E' + r.folder + '\u200E'; $('folderName').title = r.folder;
    paintTakes(); paintSpace();
    if (r.recovered && r.recovered.length) {
      const ok = r.recovered.filter((x) => !x.error);
      const bad = r.recovered.filter((x) => x.error);
      const msgs = [];
      if (ok.length) msgs.push(`A recording was not finished last time. It is saved: ${ok.map((x) => `"${x.name}" (${fmtTime(x.seconds, false)})`).join(', ')}.`);
      if (bad.length) msgs.push(`Could not rescue: ${bad.map((x) => `${x.name} (${x.error})`).join(', ')}.`);
      banner(msgs.join(' '), bad.length ? '' : 'info');
    }
    if (S.current && !S.takes.some((t) => t.name === S.current)) { S.current = null; $('editor').hidden = true; $('noTake').hidden = false; }
  }

  async function init() {
    const r = await vr.init();
    $('format').replaceChildren(...r.formats.map((f) => el('option', { value: f.id }, f.label)));
    const f = store.get('format', 'mp3'); if (r.formats.some((x) => x.id === f)) $('format').value = f;
    applyFolder(r);
    const eng = await vr.engine();
    if (!eng.ok) banner(eng.problem);
    requestAnimationFrame(drawMeter);
    await armMic(store.get('mic', ''));
    paintRec();
  }

  window.__app = { S, openTake, makePreview, switchTo, fmtTime, optsFor, readOpts, paintOpts, paintSel, paintTakes, drawWave, ready: false };
  init().then(() => { window.__app.ready = true; }, (e) => { banner('The tool could not start: ' + plain(e)); window.__app.ready = true; });
})();
