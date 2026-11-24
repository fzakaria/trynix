// The guest's sound, as queued for Web Audio. Adapted from unkernel's
// web/src/audio.ts, Copyright (C) 2026 Pooya Parsa, MIT licensed
// (vendor/unkernel/LICENSE-MIT).
//
// unkernel's sound driver, kwsnd, is an ALSA card in the guest. While a
// program plays, a kernel timer hands the page the frames its clock says
// are due, every 5 to 10 ms (sound.js). This module holds what both
// sides of the page's player need and nothing that needs a browser, so
// the tests drive it directly:
//
//   toFloat32 turns a chunk's PCM into the floats Web Audio plays;
//
//   PcmQueue is what the AudioWorklet (sound-worklet.js) plays from. It
//   starts once TARGET_S is queued, so chunks have room to be late,
//   resamples linearly from the stream's rate to the context's, and
//   steers its ratio by up to 1% from the smoothed queue level, which
//   absorbs the drift between the guest's clock and the audio device's.
//   More than MAX_S queued drops the oldest chunks down to TARGET_S, so
//   the sound does not stay late after a stall;
//
//   HeldClip keeps the latest audio a program played before the reader's
//   first click or key press, when a browser does not let a page start
//   sound. A program that spoke at boot is then heard after the click.
//   Silence before the first sound is not held (isSilent): a sound
//   server in the guest opens the card as it starts and plays zeros
//   until it lets go of it.

// What a chunk's samples are: kwsnd's ALSA formats (SNDRV_PCM_FORMAT_*).
export const SoundFormat = Object.freeze({ U8: 1, S16_LE: 2 });

// Queued before playing starts, and the level the steering aims for.
export const TARGET_S = 0.06;

// Most queued before the oldest live chunks are dropped.
export const MAX_S = 0.3;

// Most audio held before the first click, newest kept.
export const HOLD_S = 10;

// How far the playback ratio may be steered from the stream's rate, and
// how hard the queue level's distance from TARGET_S steers it.
const STEER_LIMIT = 0.01;
const STEER_GAIN = 0.1;

// What a push does when the queue is over MAX_S: a live chunk drops the
// oldest audio, and a held clip is kept whole until live audio follows.
export const Overflow = Object.freeze({
  DROP_OLDEST: "drop-oldest",
  KEEP: "keep",
});

// The scale from each format's integer samples to -1..1.
const U8_MIDDLE = 128;
const S16_SCALE = 32768;
const S16_BYTES = 2;

// A chunk's PCM as interleaved floats in -1..1.
export function toFloat32(data, { format }) {
  if (format === SoundFormat.U8) {
    return Float32Array.from(data, (byte) => (byte - U8_MIDDLE) / U8_MIDDLE);
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const samples = new Float32Array(data.byteLength / S16_BYTES);
  for (let i = 0; i < samples.length; i++) {
    samples[i] = view.getInt16(i * S16_BYTES, true) / S16_SCALE;
  }
  return samples;
}

// Whether a chunk's samples are all zero, which is what a sound server
// plays while none of its clients does.
export const isSilent = (samples) => samples.every((sample) => sample === 0);

// The queue the AudioWorklet plays from. Chunks are interleaved floats
// with their channel count and rate; render fills one render quantum of
// a stereo output.
export class PcmQueue {
  constructor() {
    this.chunks = [];
    // The read position in the first chunk, in its frames, fractional
    // while resampling.
    this.offset = 0;
    this.seconds = 0;
    this.average = TARGET_S;
    this.playing = false;
    this.ending = false;
    this.underruns = 0;
    this.dropped = 0;
  }

  // Queue one chunk. A live chunk over MAX_S drops the oldest chunks
  // down to TARGET_S, keeping the newest one.
  push(samples, channels, rate, overflow = Overflow.DROP_OLDEST) {
    const frames = samples.length / channels;
    this.chunks.push({ samples, channels, rate, frames });
    this.seconds += frames / rate;
    this.ending = false;
    if (overflow === Overflow.KEEP || this.seconds <= MAX_S) {
      return;
    }
    while (this.seconds > TARGET_S && this.chunks.length > 1) {
      const oldest = this.chunks.shift();
      this.seconds -= (oldest.frames - this.offset) / oldest.rate;
      this.offset = 0;
      this.dropped++;
    }
  }

  // A stream started again: wait for TARGET_S as at any start.
  start() {
    this.ending = false;
  }

  // The stream stopped or drained: play out what is queued without
  // waiting for TARGET_S, and do not count running dry as an underrun.
  end() {
    this.ending = true;
  }

  flush() {
    this.chunks = [];
    this.offset = 0;
    this.seconds = 0;
    this.playing = false;
  }

  // Fill `left` and `right` (one render quantum) at `sampleRate`, the
  // context's rate. A mono stream plays the same samples on both.
  render(left, right, sampleRate) {
    const length = left.length;
    let i = 0;

    // Start once enough is queued, or at once for the end of a stream.
    if (
      !this.playing &&
      this.chunks.length > 0 &&
      (this.seconds >= TARGET_S || this.ending)
    ) {
      this.playing = true;
    }

    if (this.playing) {
      // Steer by the smoothed queue level: a queue running above target
      // plays a little fast, one below it a little slow.
      this.average += (this.seconds - this.average) * (length / sampleRate);
      const steer =
        1 +
        Math.max(
          -STEER_LIMIT,
          Math.min(STEER_LIMIT, (this.average - TARGET_S) * STEER_GAIN),
        );

      for (; i < length; i++) {
        const chunk = this.chunks[0];
        if (chunk === undefined) {
          this.playing = false;
          if (!this.ending) {
            this.underruns++;
          }
          break;
        }

        // Interpolate between this frame and the next, which may be the
        // first frame of the next chunk.
        const frame = Math.floor(this.offset);
        const fraction = this.offset - frame;
        const inChunk = frame + 1 < chunk.frames;
        const next = inChunk ? chunk : this.chunks[1];
        const nextFrame = inChunk ? frame + 1 : 0;
        const lastChannel = chunk.channels - 1;
        const left0 = chunk.samples[frame * chunk.channels];
        const right0 = chunk.samples[frame * chunk.channels + lastChannel];
        const left1 =
          next === undefined ? left0 : next.samples[nextFrame * next.channels];
        const right1 =
          next === undefined
            ? right0
            : next.samples[nextFrame * next.channels + next.channels - 1];
        left[i] = left0 + (left1 - left0) * fraction;
        right[i] = right0 + (right1 - right0) * fraction;

        // Advance by the stream's rate against the context's.
        const step = (chunk.rate / sampleRate) * steer;
        this.offset += step;
        this.seconds -= step / chunk.rate;
        while (this.chunks.length > 0 && this.offset >= this.chunks[0].frames) {
          this.offset -= this.chunks[0].frames;
          this.chunks.shift();
        }
      }
      if (this.chunks.length === 0) {
        this.seconds = 0;
      }
    }

    // Silence for the rest: before the start, or after running dry.
    for (; i < length; i++) {
      left[i] = 0;
      right[i] = 0;
    }
  }
}

// The latest audio played before sound may start, up to a limit in
// seconds, oldest dropped first.
export class HeldClip {
  constructor(limitSeconds = HOLD_S) {
    this.limitSeconds = limitSeconds;
    this.chunks = [];
    this.seconds = 0;
  }

  push(samples, channels, rate) {
    // Nothing held yet and nothing to hear: the clip starts at the
    // first sound.
    if (this.chunks.length === 0 && isSilent(samples)) {
      return;
    }

    this.chunks.push({ d: samples, ch: channels, rate });
    this.seconds += samples.length / channels / rate;
    while (this.seconds > this.limitSeconds && this.chunks.length > 1) {
      const oldest = this.chunks.shift();
      this.seconds -= oldest.d.length / oldest.ch / oldest.rate;
    }
  }

  // Everything held, oldest first, and nothing held after.
  take() {
    const chunks = this.chunks;
    this.chunks = [];
    this.seconds = 0;
    return chunks;
  }
}
