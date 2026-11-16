// web/huddle/mic-worklet.js
// The huddle's microphone tap: batches the 128-sample render quanta into
// 512-sample frames (32 ms at 16 kHz) and posts them to the dock, which runs
// the speech detector and Whisper on the main thread.
class HuddleMic extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Float32Array(512);
    this.n = 0;
  }
  process(inputs) {
    const ch = inputs[0]?.[0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i += 1) {
      this.buf[this.n++] = ch[i];
      if (this.n === this.buf.length) {
        this.port.postMessage(this.buf);
        this.buf = new Float32Array(512);
        this.n = 0;
      }
    }
    return true;
  }
}
registerProcessor('huddle-mic', HuddleMic);
