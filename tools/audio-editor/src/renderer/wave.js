'use strict';
// The waveform: a canvas that draws one file, lets you zoom and scroll, drag out a selection, and click to move the
// playhead. Parts that are cut out are shown dimmed. It draws the (slow) waveform once into a cache and only repaints the
// thin playhead while a song plays.
(function () {
  const HANDLE = 7;     // pixels either side of a selection edge that grab it
  const RULER = 22;     // height of the time ruler
  const STEPS = [0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800, 3600];

  class Wave {
    constructor(canvas, on) {
      this.cv = canvas;
      this.ctx = canvas.getContext('2d');
      this.on = on || {};
      this.base = document.createElement('canvas');
      this.peaks = null; this.perSec = 200; this.duration = 0;
      this.cuts = []; this.sel = null; this.head = 0;
      this.t0 = 0; this.pps = 50;
      this.boost = false; this.loading = false; this.peak = 1;
      this.colors = {};
      this.dirty = true;
      this.drag = null;
      this.dpr = 1;
      canvas.addEventListener('pointerdown', (e) => this.down(e));
      canvas.addEventListener('pointermove', (e) => this.move(e));
      canvas.addEventListener('pointerup', (e) => this.up(e));
      canvas.addEventListener('pointercancel', (e) => this.up(e));
      canvas.addEventListener('wheel', (e) => this.wheel(e), { passive: false });
      new ResizeObserver(() => this.resize()).observe(canvas);
      this.resize();
    }

    // ---- data ---------------------------------------------------------------------------------------------------------
    setData(peaks, perSec, duration) {
      this.peaks = peaks; this.perSec = perSec || 200; this.duration = duration || 0;
      this.peak = 1;
      if (peaks) { let m = 1; for (let i = 0; i < peaks.length; i++) { const v = Math.abs(peaks[i]); if (v > m) m = v; } this.peak = m; }
      this.loading = false;
      this.fit();
    }
    clear() { this.peaks = null; this.duration = 0; this.sel = null; this.cuts = []; this.head = 0; this.dirty = true; this.paint(); this.changed(); }
    setCuts(cuts) { this.cuts = cuts; this.dirty = true; this.paint(); }
    setSelection(a, b) { this.sel = a == null ? null : [Math.min(a, b), Math.max(a, b)]; this.dirty = true; this.paint(); }
    setPlayhead(t) { this.head = t; this.paint(); }
    setBoost(on) { this.boost = !!on; this.dirty = true; this.paint(); }
    setLoading(on) { this.loading = on; this.dirty = true; this.paint(); }

    // ---- view ---------------------------------------------------------------------------------------------------------
    get width() { return this.cv.clientWidth; }
    get height() { return this.cv.clientHeight; }
    get visible() { return this.width / this.pps; }
    get minPps() { return this.duration > 0 ? this.width / this.duration : 1; }
    get maxPps() { return 4000; }
    clampView() {
      this.pps = Math.max(this.minPps, Math.min(this.maxPps, this.pps));
      const maxT0 = Math.max(0, this.duration - this.visible);
      this.t0 = Math.max(0, Math.min(maxT0, this.t0));
    }
    fit() { this.pps = this.minPps; this.t0 = 0; this.dirty = true; this.clampView(); this.paint(); this.changed(); }
    zoom(factor, anchorT) {
      const a = anchorT == null ? this.t0 + this.visible / 2 : anchorT;
      const rel = (a - this.t0) / this.visible;
      this.pps *= factor;
      this.clampView();
      this.t0 = a - rel * this.visible;
      this.clampView();
      this.dirty = true; this.paint(); this.changed();
    }
    scrollTo(t0) { this.t0 = t0; this.clampView(); this.dirty = true; this.paint(); this.changed(); }
    /** Bring time t into view (used while playing so the playhead is never off screen). */
    reveal(t, page = true) {
      if (t >= this.t0 && t <= this.t0 + this.visible) return;
      this.t0 = page ? t - this.visible * 0.1 : t - this.visible / 2;
      this.clampView(); this.dirty = true; this.paint(); this.changed();
    }
    timeAt(x) { return Math.max(0, Math.min(this.duration, this.t0 + x / this.pps)); }
    xAt(t) { return (t - this.t0) * this.pps; }
    changed() { if (this.on.view) this.on.view(this); }

    resize() {
      const dpr = window.devicePixelRatio || 1;
      const w = Math.max(1, Math.round(this.cv.clientWidth * dpr));
      const h = Math.max(1, Math.round(this.cv.clientHeight * dpr));
      if (this.cv.width !== w || this.cv.height !== h) {
        this.cv.width = w; this.cv.height = h;
        this.base.width = w; this.base.height = h;
        this.dpr = dpr;
        this.dirty = true;
        if (this.duration) { this.clampView(); this.changed(); }
      }
      this.paint();
    }

    // ---- drawing ------------------------------------------------------------------------------------------------------
    css() {
      const s = getComputedStyle(this.cv);
      const v = (n, d) => (s.getPropertyValue(n).trim() || d);
      this.colors = { bg: v('--wave-bg', '#12151d'), wave: v('--wave', '#6ea8ff'), dim: v('--wave-dim', '#3a3f4f'), sel: v('--sel', 'rgba(224,165,38,.28)'), selEdge: v('--accent', '#e0a526'), head: v('--head', '#ffffff'), grid: v('--line', '#2a2f3d'), text: v('--muted', '#8b92a5'), cut: v('--cut', 'rgba(239,91,91,.16)') };
    }

    ticks() {
      const want = 80 / this.pps;
      return STEPS.find((s) => s >= want) || STEPS[STEPS.length - 1];
    }

    render() {
      this.css();
      const c = this.base.getContext('2d');
      const d = this.dpr;
      const W = this.base.width;
      const H = this.base.height;
      const col = this.colors;
      c.setTransform(1, 0, 0, 1, 0, 0);
      c.fillStyle = col.bg; c.fillRect(0, 0, W, H);
      if (!this.peaks || !this.duration) {
        c.fillStyle = col.text; c.font = `${13 * d}px "Segoe UI", system-ui, sans-serif`; c.textAlign = 'center';
        c.fillText(this.loading ? 'Reading the waveform…' : 'No file', W / 2, H / 2);
        return;
      }
      const top = RULER * d;
      const mid = top + (H - top) / 2;
      const amp = (H - top) / 2 - 4 * d;
      const scale = (this.boost ? 1 / Math.max(this.peak, 1500) : 1 / 32768) * amp;
      // ruler and grid
      const step = this.ticks();
      c.font = `${11 * d}px "Segoe UI", system-ui, sans-serif`; c.textAlign = 'left'; c.textBaseline = 'alphabetic';
      c.fillStyle = col.text; c.strokeStyle = col.grid; c.lineWidth = 1;
      const first = Math.floor(this.t0 / step) * step;
      c.beginPath();
      for (let t = first; t <= this.t0 + this.visible + step; t += step) {
        const x = Math.round(this.xAt(t) * d) + 0.5;
        c.moveTo(x, top - 6 * d); c.lineTo(x, H);
        c.fillText(window.Plan.formatTime(t, step < 1), x + 4 * d, 14 * d);
      }
      c.stroke();
      c.beginPath(); c.moveTo(0, mid + 0.5); c.lineTo(W, mid + 0.5); c.stroke();
      // waveform: one column of pixels at a time, the tallest and lowest sample that falls in it
      const cuts = this.cuts;
      const per = this.perSec;
      const n = this.peaks.length / 2;
      let ci = 0;
      for (let px = 0; px < W; px++) {
        const t = this.t0 + px / d / this.pps;
        if (t > this.duration) break;
        const i0 = Math.max(0, Math.floor(t * per));
        const i1 = Math.min(n - 1, Math.max(i0, Math.floor((t + 1 / (this.pps * d)) * per - 1e-9)));
        let lo = 32767; let hi = -32768;
        for (let i = i0; i <= i1; i++) {
          const a = this.peaks[i * 2]; const b = this.peaks[i * 2 + 1];
          if (a < lo) lo = a;
          if (b > hi) hi = b;
        }
        if (lo > hi) continue;
        while (ci < cuts.length && cuts[ci][1] <= t) ci++;
        const cut = ci < cuts.length && t >= cuts[ci][0];
        c.fillStyle = cut ? col.dim : col.wave;
        const y1 = mid - hi * scale;
        const y2 = mid - lo * scale;
        c.fillRect(px, Math.min(y1, y2), 1, Math.max(1, Math.abs(y2 - y1)));
      }
      // cut parts get a tint (and are labelled when wide enough)
      for (const [a, b] of cuts) {
        const x1 = this.xAt(a) * d; const x2 = this.xAt(b) * d;
        if (x2 < 0 || x1 > W) continue;
        c.fillStyle = col.cut; c.fillRect(x1, top, x2 - x1, H - top);
        if (x2 - x1 > 60 * d) { c.fillStyle = col.text; c.textAlign = 'center'; c.fillText('removed', (x1 + x2) / 2, H - 8 * d); }
      }
      // selection
      if (this.sel) {
        const x1 = this.xAt(this.sel[0]) * d; const x2 = this.xAt(this.sel[1]) * d;
        c.fillStyle = col.sel; c.fillRect(x1, top, Math.max(1, x2 - x1), H - top);
        c.fillStyle = col.selEdge;
        c.fillRect(Math.round(x1) - 1, top, 2, H - top);
        c.fillRect(Math.round(x2) - 1, top, 2, H - top);
      }
    }

    paint() {
      if (this.dirty) { this.render(); this.dirty = false; }
      const c = this.ctx;
      c.setTransform(1, 0, 0, 1, 0, 0);
      c.drawImage(this.base, 0, 0);
      if (this.peaks && this.duration && this.head >= this.t0 - 0.01 && this.head <= this.t0 + this.visible + 0.01) {
        const x = Math.round(this.xAt(this.head) * this.dpr) + 0.5;
        c.strokeStyle = this.colors.head || '#fff'; c.lineWidth = Math.max(1, this.dpr);
        c.beginPath(); c.moveTo(x, RULER * this.dpr - 6 * this.dpr); c.lineTo(x, this.cv.height); c.stroke();
        c.fillStyle = this.colors.head || '#fff';
        c.beginPath(); c.moveTo(x - 5 * this.dpr, RULER * this.dpr - 8 * this.dpr); c.lineTo(x + 5 * this.dpr, RULER * this.dpr - 8 * this.dpr); c.lineTo(x, RULER * this.dpr - 1); c.fill();
      }
    }

    // ---- mouse --------------------------------------------------------------------------------------------------------
    localX(e) { return e.clientX - this.cv.getBoundingClientRect().left; }
    edgeAt(x) {
      if (!this.sel) return null;
      const dA = Math.abs(x - this.xAt(this.sel[0]));
      const dB = Math.abs(x - this.xAt(this.sel[1]));
      if (Math.min(dA, dB) > HANDLE) return null;
      return dA <= dB ? 0 : 1;
    }
    down(e) {
      if (!this.peaks || e.button !== 0) return;
      this.cv.setPointerCapture(e.pointerId);
      const x = this.localX(e);
      const edge = this.edgeAt(x);
      if (edge !== null) {
        this.drag = { mode: 'edge', fixed: this.sel[edge === 0 ? 1 : 0], moved: true };
      } else if (e.shiftKey && this.sel) {
        const t = this.timeAt(x);
        this.drag = { mode: 'edge', fixed: t < this.sel[0] ? this.sel[1] : this.sel[0], moved: true };
        this.updateDrag(x);
      } else {
        this.drag = { mode: 'new', x0: x, t0: this.timeAt(x), moved: false };
      }
    }
    updateDrag(x) {
      const t = this.timeAt(x);
      if (this.drag.mode === 'new') this.setSelection(this.drag.t0, t);
      else this.setSelection(this.drag.fixed, t);
      if (this.on.select) this.on.select(this.sel);
    }
    move(e) {
      const x = this.localX(e);
      if (!this.drag) { this.cv.style.cursor = this.peaks ? (this.edgeAt(x) !== null ? 'ew-resize' : 'text') : 'default'; return; }
      if (this.drag.mode === 'new' && !this.drag.moved && Math.abs(x - this.drag.x0) < 3) return;
      this.drag.moved = true;
      // dragging past the edge scrolls
      if (x < 12) this.scrollTo(this.t0 - 60 / this.pps); else if (x > this.width - 12) this.scrollTo(this.t0 + 60 / this.pps);
      this.updateDrag(x);
    }
    up(e) {
      if (!this.drag) return;
      const d = this.drag; this.drag = null;
      try { this.cv.releasePointerCapture(e.pointerId); } catch { /* not captured */ }
      if (d.mode === 'new' && !d.moved) { // a plain click: move the playhead and drop the selection
        this.setSelection(null);
        if (this.on.select) this.on.select(null);
        if (this.on.seek) this.on.seek(d.t0);
      } else if (this.sel && this.sel[1] - this.sel[0] < 0.005) {
        this.setSelection(null);
        if (this.on.select) this.on.select(null);
      }
    }
    wheel(e) {
      if (!this.peaks) return;
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) this.zoom(e.deltaY < 0 ? 1.25 : 0.8, this.timeAt(this.localX(e)));
      else this.scrollTo(this.t0 + ((Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY) * 0.6) / this.pps);
    }
  }
  window.Wave = Wave;
}());
