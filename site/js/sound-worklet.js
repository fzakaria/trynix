// The AudioWorklet that plays the guest's sound (sound.js), on the
// browser's audio thread. The page posts chunks as they arrive from the
// kernel, from inside a busy main thread; a MessagePort message reaches
// this thread without waiting for that task to end, so playback does not
// depend on when the main thread gets back to its event loop.
//
// Messages in: { kind: "pcm", samples, channels, rate, overflow },
// { kind: "start" }, { kind: "end" }, { kind: "flush" }. Out, every
// REPORT_S: { seconds, underruns, dropped }. sampleRate,
// AudioWorkletProcessor and registerProcessor are this scope's globals.

import { PcmQueue } from "./sound-queue.js";

// How often the queue's level is reported to the page, which tells the
// kernel how much is still to play.
const REPORT_S = 0.1;

// The processor's name, as sound.js asks for it.
const PROCESSOR = "trynix-pcm";

class TrynixPcm extends AudioWorkletProcessor {
  constructor() {
    super();
    this.queue = new PcmQueue();
    this.sinceReport = 0;
    this.port.onmessage = ({ data: message }) => {
      switch (message.kind) {
        case "pcm":
          this.queue.push(
            message.samples,
            message.channels,
            message.rate,
            message.overflow,
          );
          break;
        case "start":
          this.queue.start();
          break;
        case "end":
          this.queue.end();
          break;
        case "flush":
          this.queue.flush();
          break;
      }
    };
  }

  process(_inputs, outputs) {
    const [left, right = left] = outputs[0];
    this.queue.render(left, right, sampleRate);

    // Report the level now and then, not every 128 frames.
    this.sinceReport += left.length;
    if (this.sinceReport >= sampleRate * REPORT_S) {
      this.sinceReport = 0;
      this.port.postMessage({
        seconds: this.queue.seconds,
        underruns: this.queue.underruns,
        dropped: this.queue.dropped,
      });
    }
    return true;
  }
}

registerProcessor(PROCESSOR, TrynixPcm);
