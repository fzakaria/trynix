// Tests the guest's sound on the page (site/js/sound-queue.js): the
// conversion of the PCM unkernel hands over to Web Audio's floats, the
// queue the AudioWorklet plays from (it waits for a little audio before
// it starts, plays the samples in order, runs dry and waits again,
// plays out the end of a stream, and drops the oldest audio when too
// much is queued), and the clip the page holds until the reader's first
// click lets it play, which leaves out the silence before the first
// sound. Each is driven directly, with plain arrays for the worklet's
// output channels.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  HeldClip,
  isSilent,
  MAX_S,
  Overflow,
  PcmQueue,
  SoundFormat,
  TARGET_S,
  toFloat32,
} from "../../site/js/sound-queue.js";

// The rate every queue test plays at, so one frame in is one frame out.
const RATE = 48000;

// One Web Audio render quantum.
const QUANTUM = 128;

// A stereo chunk of `seconds` at RATE, every sample `value`.
const chunk = (seconds, value = 0.5) =>
  new Float32Array(Math.round(seconds * RATE) * 2).fill(value);

// Render one quantum and hand back the left channel.
function render(queue) {
  const left = new Float32Array(QUANTUM);
  const right = new Float32Array(QUANTUM);
  queue.render(left, right, RATE);
  return left;
}

// Checks both formats kwsnd offers: signed 16-bit little-endian and
// unsigned 8-bit, each scaled to -1..1.
test("PCM converts to Web Audio's floats", () => {
  const s16 = toFloat32(new Uint8Array([0x00, 0x80, 0x00, 0x00, 0xff, 0x7f]), {
    format: SoundFormat.S16_LE,
  });
  assert.deepEqual([...s16], [-1, 0, 32767 / 32768]);

  const u8 = toFloat32(new Uint8Array([0, 128, 255]), {
    format: SoundFormat.U8,
  });
  assert.deepEqual([...u8], [-1, 0, 127 / 128]);
});

// Checks that the queue plays nothing until TARGET_S is queued, so the
// chunks that arrive every 5 to 10 ms have room to be late.
test("the queue waits for its target before it plays", () => {
  const queue = new PcmQueue();
  queue.push(chunk(TARGET_S / 2), 2, RATE);
  assert.ok(render(queue).every((sample) => sample === 0));

  queue.push(chunk(TARGET_S), 2, RATE);
  assert.ok(render(queue).every((sample) => sample === 0.5));
});

// Checks that a queue that runs dry mid-stream counts an underrun,
// plays silence, and waits for its target again.
test("the queue runs dry, counts it, and waits again", () => {
  const queue = new PcmQueue();
  queue.push(chunk(TARGET_S), 2, RATE);
  while (queue.seconds > 0) {
    render(queue);
  }
  assert.ok(render(queue).every((sample) => sample === 0));
  assert.equal(queue.underruns, 1);

  queue.push(chunk(TARGET_S / 2), 2, RATE);
  assert.ok(render(queue).every((sample) => sample === 0));
});

// Checks that the end of a stream plays out though less than the target
// is queued, and that running dry after it is not an underrun.
test("the end of a stream plays out", () => {
  const queue = new PcmQueue();
  queue.push(chunk(TARGET_S / 4), 2, RATE);
  queue.end();
  assert.ok(render(queue).every((sample) => sample === 0.5));
  while (queue.seconds > 0) {
    render(queue);
  }
  render(queue);
  assert.equal(queue.underruns, 0);
});

// Checks that more than MAX_S queued drops the oldest chunks down to
// the target, so a stall does not leave the sound late for good.
test("too much queued drops the oldest audio", () => {
  const queue = new PcmQueue();
  for (let i = 0; i < 10; i++) {
    queue.push(chunk(MAX_S / 4), 2, RATE);
  }
  assert.ok(queue.seconds <= MAX_S);
  assert.ok(queue.dropped > 0);
});

// Checks that a held clip goes in whole, longer than MAX_S, and that the
// next live chunk trims it: a clip that ended before the click plays in
// full, and one still going joins the live stream instead.
test("a held clip is kept until live audio follows it", () => {
  const queue = new PcmQueue();
  queue.push(chunk(MAX_S * 3), 2, RATE, Overflow.KEEP);
  assert.ok(queue.seconds > MAX_S);
  assert.equal(queue.dropped, 0);

  queue.push(chunk(TARGET_S), 2, RATE);
  assert.ok(queue.seconds <= MAX_S);
});

// Checks that the clip held before the first click keeps only the
// latest HeldClip limit, and hands everything over once.
test("the held clip keeps the latest audio", () => {
  const held = new HeldClip(1);
  for (let i = 0; i < 5; i++) {
    held.push(chunk(0.5, i), 2, RATE);
  }
  assert.ok(held.seconds <= 1);
  const taken = held.take();
  assert.equal(taken.at(-1).d[0], 4);
  assert.equal(held.seconds, 0);
  assert.equal(held.take().length, 0);
});

// Checks which chunks count as silence: all zeros, as a sound server
// plays while no client does, and nothing else, however quiet.
test("silence is a chunk of zeros", () => {
  assert.equal(isSilent(chunk(0.01, 0)), true);
  const quiet = chunk(0.01, 0);
  quiet[quiet.length - 1] = 1 / 32768;
  assert.equal(isSilent(quiet), false);
});

// Checks that the clip held before the first click does not start with
// silence: a sound server opens the card as it starts and plays zeros
// until it lets go of it, and that is nothing to hold or to click for.
// Silence after the first sound is kept, as the pauses in a voice are.
test("the held clip drops the silence before the first sound", () => {
  const held = new HeldClip();
  held.push(chunk(0.5, 0), 2, RATE);
  assert.equal(held.seconds, 0);
  assert.equal(held.take().length, 0);

  held.push(chunk(0.5, 0), 2, RATE);
  held.push(chunk(0.5, 0.5), 2, RATE);
  held.push(chunk(0.5, 0), 2, RATE);
  const taken = held.take();
  assert.deepEqual(
    taken.map((piece) => piece.d[0]),
    [0.5, 0],
  );
});
