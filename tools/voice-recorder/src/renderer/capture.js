'use strict';
// AudioWorklet: takes the microphone's samples (first channel, or the mix of all), turns them into 16-bit PCM and hands
// them to the page in blocks of 2048, with the block's peak and RMS for the level meter. Nothing is lost while the page
// is busy: blocks queue up in the message port.
const BLOCK = 2048;
class Capture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Int16Array(BLOCK);
    this.n = 0; this.peak = 0; this.sum = 0;
  }
  process(inputs) {
    const input = inputs[0];
    if (!input || !input.length) return true;
    const ch = input.length;
    const len = input[0].length;
    for (let i = 0; i < len; i++) {
      let v = 0;
      for (let c = 0; c < ch; c++) v += input[c][i];
      v /= ch;
      const a = v < 0 ? -v : v;
      if (a > this.peak) this.peak = a;
      this.sum += v * v;
      const c = v > 1 ? 1 : v < -1 ? -1 : v;
      this.buf[this.n++] = c < 0 ? Math.round(c * 32768) : Math.round(c * 32767);
      if (this.n === BLOCK) {
        const out = this.buf;
        this.port.postMessage({ pcm: out.buffer, peak: this.peak, rms: Math.sqrt(this.sum / BLOCK) }, [out.buffer]);
        this.buf = new Int16Array(BLOCK); this.n = 0; this.peak = 0; this.sum = 0;
      }
    }
    return true;
  }
}
registerProcessor('vr-capture', Capture);
