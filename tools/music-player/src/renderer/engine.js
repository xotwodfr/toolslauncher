'use strict';
// The audio engine. Two <audio> elements ("decks") feed one Web Audio graph:
//   deck gain (ReplayGain) -> preamp -> 10 EQ bands -> limiter -> volume -> fade -> speakers   (the analyser listens after the limiter)
// While one deck plays, the next song is loaded in the other and started a few milliseconds before the first one ends,
// so songs follow each other without the pause an ordinary "ended -> load next" player has.
(function () {
  const LEAD = 0.025; // seconds before the end at which the next deck starts. Measured in the e2e test (MP_CAL=1): 0-12 ms left a 2-3 ms gap about half the time, 25 ms none

  class Engine {
    constructor() {
      const ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'playback' });
      this.ctx = ctx;
      this.handlers = {};
      this.lead = LEAD;
      this.input = ctx.createGain();
      this.preamp = ctx.createGain();
      this.filters = window.EQ.BANDS.map((f, i) => {
        const b = ctx.createBiquadFilter();
        b.type = i === 0 ? 'lowshelf' : i === window.EQ.BANDS.length - 1 ? 'highshelf' : 'peaking';
        b.frequency.value = f; b.Q.value = 1.3; b.gain.value = 0;
        return b;
      });
      this.limiter = ctx.createDynamicsCompressor();
      this.limiter.threshold.value = -1; this.limiter.knee.value = 0; this.limiter.ratio.value = 20;
      this.limiter.attack.value = 0.002; this.limiter.release.value = 0.12;
      this.volumeNode = ctx.createGain();
      this.fadeNode = ctx.createGain();
      this.analyser = ctx.createAnalyser();
      this.analyser.fftSize = 2048; this.analyser.smoothingTimeConstant = 0.78;
      let node = this.input;
      for (const n of [this.preamp, ...this.filters, this.limiter, this.volumeNode, this.fadeNode]) { node.connect(n); node = n; }
      node.connect(ctx.destination);
      this.limiter.connect(this.analyser); // a side tap before the volume control: the spectrum keeps moving at low volume

      this.decks = [this._makeDeck(0), this._makeDeck(1)];
      this.active = 0;
      this._userPaused = true;
      this._timer = setInterval(() => this._tick(), 8);
    }

    on(name, fn) { (this.handlers[name] = this.handlers[name] || []).push(fn); }
    _emit(name, payload) { for (const fn of this.handlers[name] || []) { try { fn(payload); } catch (e) { console.error(e); } } }

    _makeDeck(id) {
      const a = new Audio();
      a.crossOrigin = 'anonymous'; // required: otherwise Web Audio outputs silence for media from another origin (mpm://)
      a.preload = 'auto';
      const src = this.ctx.createMediaElementSource(a);
      const gain = this.ctx.createGain();
      src.connect(gain); gain.connect(this.input);
      const d = { id, audio: a, gain, url: '', rel: '', rg: 1, ready: false, started: false, gen: 0 };
      a.addEventListener('canplaythrough', () => { d.ready = true; });
      a.addEventListener('ended', () => this._onEnded(d));
      a.addEventListener('error', () => this._onError(d));
      a.addEventListener('playing', () => { if (d === this.deck) this._emit('state', { playing: true }); });
      a.addEventListener('pause', () => { if (d === this.deck && !a.ended) this._emit('state', { playing: false }); });
      return d;
    }

    get deck() { return this.decks[this.active]; }
    get idle() { return this.decks[1 - this.active]; }
    get position() { return this.deck.audio.currentTime || 0; }
    get duration() { const d = this.deck.audio.duration; return Number.isFinite(d) ? d : 0; }
    get playing() { const a = this.deck.audio; return !!this.deck.url && !a.paused && !a.ended; }
    get currentRel() { return this.deck.rel; }

    _load(d, url, rel, rg) {
      d.audio.pause();
      d.gen++; // lets a delayed clean-up notice that the deck has been given a new song since
      d.url = url; d.rel = rel; d.rg = rg; d.ready = false; d.started = false;
      d.gain.gain.setValueAtTime(rg, this.ctx.currentTime);
      if (url) { d.audio.src = url; d.audio.load(); } else { d.audio.removeAttribute('src'); d.audio.load(); }
    }

    /** Start a song now. `rg` is the linear ReplayGain factor, `startAt` seconds. Resolves once playback has begun. */
    async play(url, rel, rg = 1, startAt = 0, paused = false) {
      await this.ctx.resume();
      this.resetFade();
      this._load(this.idle, '', '', 1);                 // a stale preload belongs to the old queue position
      const d = this.deck;
      this._load(d, url, rel, rg);
      this._userPaused = paused;
      if (startAt > 0) {
        await new Promise((res) => { d.audio.addEventListener('loadedmetadata', res, { once: true }); d.audio.addEventListener('error', res, { once: true }); });
        try { d.audio.currentTime = startAt; } catch { /* seeking not possible: start from 0 */ }
      }
      if (paused) { this._emit('state', { playing: false }); return; }
      try { await d.audio.play(); } catch (e) { if (e && e.name !== 'AbortError') this._onError(d); }
    }

    /** Load the song that follows, in the idle deck. */
    preload(url, rel, rg = 1) {
      const n = this.idle;
      if (n.url === url && n.rel === rel) { n.gain.gain.setValueAtTime(rg, this.ctx.currentTime); n.rg = rg; return; }
      this._load(n, url, rel, rg);
    }
    clearPreload() { if (this.idle.url) this._load(this.idle, '', '', 1); }
    get preloaded() { return this.idle.rel; }

    async resume() { await this.ctx.resume(); this.resetFade(); this._userPaused = false; if (this.deck.url) { try { await this.deck.audio.play(); } catch { /* ignore */ } } }
    pause() { this._userPaused = true; this.deck.audio.pause(); }
    async toggle() { if (this.playing) this.pause(); else await this.resume(); }
    stop() { this._userPaused = true; this._load(this.deck, '', '', 1); this._load(this.idle, '', '', 1); this._emit('state', { playing: false }); }
    seek(sec) { const a = this.deck.audio; if (!a.src) return; try { a.currentTime = Math.max(0, Math.min(sec, (this.duration || sec))); } catch { /* ignore */ } if (this.idle.started) { /* handover already happened: nothing to undo */ } }

    _tick() {
      const d = this.deck;
      if (this._userPaused || !d.url || d.audio.paused) return;
      const n = this.idle;
      if (!n.url || !(n.ready || n.audio.readyState >= 3) || n.started) return;
      const dur = d.audio.duration;
      if (!Number.isFinite(dur) || dur <= 0) return;
      if (dur - d.audio.currentTime <= this.lead) this._handover();
    }

    _handover() {
      const old = this.deck;
      const n = this.idle;
      n.started = true; // (no currentTime = 0 here: a loaded deck is already at 0, and a seek would flush the decoder and cause a gap)
      const p = n.audio.play();
      if (p && p.catch) p.catch(() => this._onError(n));
      this.active = 1 - this.active;
      this._emit('advance', { rel: n.rel });
      const gen = old.gen;
      setTimeout(() => { if (old !== this.deck && old.gen === gen) this._load(old, '', '', 1); }, 600); // let the old tail finish, then free it (unless it was reused meanwhile)
    }

    _onEnded(d) {
      if (d !== this.deck) return; // the old deck after a gapless hand-over
      const n = this.idle;
      if (n.url && !n.started && !this._userPaused) { this._handover(); return; } // fallback when the timer missed the end
      this._emit('ended', { rel: d.rel });
    }

    _onError(d) {
      if (!d.url) return;
      if (d === this.deck) this._emit('error', { rel: d.rel });
      else if (!d.started) { this._load(d, '', '', 1); this._emit('preload-error', { rel: d.rel }); }
    }

    // ---- sound ----
    setVolume(volume, muted) {
      const v = muted ? 0 : Math.max(0, Math.min(1, volume));
      this.volumeNode.gain.setTargetAtTime(v * v, this.ctx.currentTime, 0.015); // squared: the slider feels even to the ear
    }
    /** @param {{on:boolean, preamp:number, bands:number[]}} eq */
    setEq(eq) {
      const t = this.ctx.currentTime;
      this.preamp.gain.setTargetAtTime(eq.on ? 10 ** (eq.preamp / 20) : 1, t, 0.02);
      this.filters.forEach((f, i) => f.gain.setTargetAtTime(eq.on ? eq.bands[i] : 0, t, 0.02));
    }
    /** ReplayGain for the song that is playing now (linear factor). */
    setTrackGain(factor) { this.deck.rg = factor; this.deck.gain.gain.setTargetAtTime(factor, this.ctx.currentTime, 0.02); }
    setPreloadGain(factor) { this.idle.rg = factor; this.idle.gain.gain.setTargetAtTime(factor, this.ctx.currentTime, 0.02); }
    fadeOut(seconds) { const t = this.ctx.currentTime; this.fadeNode.gain.cancelScheduledValues(t); this.fadeNode.gain.setValueAtTime(this.fadeNode.gain.value, t); this.fadeNode.gain.linearRampToValueAtTime(0.0001, t + seconds); }
    resetFade() { const t = this.ctx.currentTime; this.fadeNode.gain.cancelScheduledValues(t); this.fadeNode.gain.setValueAtTime(1, t); }

    /** `n` spectrum bars (0..1), log-spaced from 40 Hz to 14 kHz. */
    bars(n, out) {
      const a = this.analyser;
      if (!this._freq) this._freq = new Uint8Array(a.frequencyBinCount);
      a.getByteFrequencyData(this._freq);
      const nyq = this.ctx.sampleRate / 2;
      const lo = Math.log(40); const hi = Math.log(14000);
      for (let i = 0; i < n; i++) {
        const f0 = Math.exp(lo + ((hi - lo) * i) / n); const f1 = Math.exp(lo + ((hi - lo) * (i + 1)) / n);
        const b0 = Math.max(0, Math.floor((f0 / nyq) * this._freq.length)); const b1 = Math.max(b0 + 1, Math.ceil((f1 / nyq) * this._freq.length));
        let m = 0; for (let b = b0; b < b1 && b < this._freq.length; b++) m = Math.max(m, this._freq[b]);
        out[i] = m / 255;
      }
      return out;
    }
  }

  window.Engine = Engine;
}());
