// The guest's sound on the page: the SoundSink unkernel's SDK hands the
// PCM to (unkernel.js), played with Web Audio. Adapted from unkernel's
// web/src/audio.ts, Copyright (C) 2026 Pooya Parsa, MIT licensed
// (vendor/unkernel/LICENSE-MIT).
//
// unkernel's kwsnd driver is ALSA card 0 in the guest. While a program
// plays, a kernel timer hands over the frames its clock says are due,
// every 5 to 10 ms, from inside a synchronous call on a busy thread.
// Each chunk is posted at once to an AudioWorklet (sound-worklet.js),
// which plays from its own queue (sound-queue.js) whatever the main
// thread is doing. What a chunk returns is how much is still queued,
// which programs see as part of their delay.
//
// Browsers do not let a page start sound before the reader has clicked
// or pressed a key on it, and a Try link boots and runs its command with
// no click on the new page. So the AudioContext is made only once the
// page has had one: before that, what a program plays is held, up to
// HOLD_S of it (sound-queue.js), and the console bar's sound control
// says a click will play it. A clip that ended by then, a voice that
// spoke at boot, plays whole after the click; a stream still playing
// joins live. Making the context early would only get it refused, with
// a warning in the browser's console.
//
// The control is also the switch: sound on, or off. A link can start
// the sound off (url.js, `sound`), and the switch puts its position in
// the link (`onSwitch`, app.js).

import { HeldClip, isSilent, Overflow, toFloat32 } from "./sound-queue.js";

// The events that count as the reader's activation in Chrome, Firefox
// and Safari, iOS included (which needs touchend or click).
const GESTURES = ["keydown", "mousedown", "pointerup", "touchend", "click"];

// The worklet, and the processor it registers.
const WORKLET_URL = new URL("./sound-worklet.js", import.meta.url);
const PROCESSOR = "trynix-pcm";

// Most audio devices run at 48 kHz. The kernel shows the rate in the
// card's name; programs still choose any rate from 8 to 48 kHz.
const PREFERRED_RATE = 48000;

// The switch's positions, as a link names them.
export const Sound = Object.freeze({
  ON: "on",
  OFF: "off",
});

// A switch position as a link holds it, or null when the value is not
// one.
export function soundOf(value) {
  return Object.values(Sound).includes(value) ? value : null;
}

// What the console bar's control shows.
export const SoundControl = Object.freeze({
  // No program has played anything but silence: no control.
  HIDDEN: "hidden",
  // Sound is held until the reader clicks.
  WAITING: "waiting",
  ON: "on",
  OFF: "off",
});

const LABELS = {
  [SoundControl.WAITING]: "sound: click to play",
  [SoundControl.ON]: "sound on",
  [SoundControl.OFF]: "sound off",
};

const TITLES = {
  [SoundControl.WAITING]:
    "A program in the guest is playing sound. The browser starts it at your first click or key press on the page.",
  [SoundControl.ON]: "The guest's sound plays here. Click to turn it off.",
  [SoundControl.OFF]: "The guest's sound is off. Click to turn it on.",
};

// The gain for each switch position.
const GAIN_ON = 1;
const GAIN_OFF = 0;

// Whether the page has had the reader's click or key press, which lets
// an AudioContext start. A browser without the UserActivation API is
// taken not to have had one, and the next gesture starts the sound.
const activated = () =>
  globalThis.navigator?.userActivation?.hasBeenActive === true;

// The sink for createKernel's `sound` option, with `stats` for tests.
// `control` is the console bar's button, `position` where the switch
// starts (Sound), and `onSwitch` hears each new position.
export function createSoundOut({
  log,
  control,
  position = Sound.ON,
  onSwitch = () => {},
}) {
  let context = null;
  let node = null;
  let gain = null;
  let unsupported = false;
  let off = position === Sound.OFF;

  // Whether a program has played anything but silence, which shows the
  // control. Opening the card is not enough: a sound server in the guest
  // opens it as it starts and plays zeros until it lets go of it.
  let heard = false;
  // Whether a stream is running in the guest now.
  let streamPlaying = false;

  const held = new HeldClip();
  let queuedSeconds = 0;
  let chunks = 0;
  let underruns = 0;
  let dropped = 0;

  // Live chunks go to the worklet only once it is loaded and the
  // context runs; until then they are held.
  const ready = () => node !== null && context?.state === "running";

  // The control's state, from the context and the switch.
  function controlState() {
    if (!heard || unsupported) {
      return SoundControl.HIDDEN;
    }
    if (!ready()) {
      return SoundControl.WAITING;
    }
    return off ? SoundControl.OFF : SoundControl.ON;
  }

  function show() {
    const state = controlState();
    control.hidden = state === SoundControl.HIDDEN;
    control.dataset.state = state;
    if (state === SoundControl.HIDDEN) {
      return;
    }
    control.textContent = LABELS[state];
    control.title = TITLES[state];
  }

  // Post one chunk to the worklet.
  function post(samples, channels, rate, overflow) {
    node.port.postMessage({ kind: "pcm", samples, channels, rate, overflow }, [
      samples.buffer,
    ]);
    queuedSeconds += samples.length / channels / rate;
  }

  // Hand the worklet what was held, whole. A stream that is over by
  // now plays out; one still going is trimmed by its next live chunk.
  function playHeld() {
    for (const chunk of held.take()) {
      post(chunk.d, chunk.ch, chunk.rate, Overflow.KEEP);
    }
    if (!streamPlaying) {
      node.port.postMessage({ kind: "end" });
    }
  }

  // Make the context and load the worklet. Called inside a gesture, or
  // once the page has had one, so the context is let start.
  function createContext() {
    const AudioContextClass =
      globalThis.AudioContext ?? globalThis.webkitAudioContext;
    if (AudioContextClass === undefined) {
      unsupported = true;
      log("sound: this browser has no Web Audio, so the guest has no sound");
      return;
    }
    try {
      context = new AudioContextClass({ latencyHint: "interactive" });
    } catch (err) {
      unsupported = true;
      log(`sound: no AudioContext (${err.message ?? err})`);
      return;
    }
    if (context.audioWorklet === undefined) {
      unsupported = true;
      log("sound: no AudioWorklet in this page, so the guest has no sound");
      return;
    }

    const made = context;
    made.addEventListener("statechange", onContextState);
    gain = made.createGain();
    gain.gain.value = off ? GAIN_OFF : GAIN_ON;
    gain.connect(made.destination);
    log(`sound: AudioContext at ${made.sampleRate} Hz`);

    made.audioWorklet
      .addModule(WORKLET_URL)
      .then(() => {
        node = new AudioWorkletNode(made, PROCESSOR, {
          numberOfInputs: 0,
          numberOfOutputs: 1,
          outputChannelCount: [2],
        });
        node.port.onmessage = ({ data }) => {
          queuedSeconds = data.seconds;
          underruns = data.underruns;
          dropped = data.dropped;
        };
        node.connect(gain);
        onContextState();
      })
      .catch((err) => {
        unsupported = true;
        log(`sound: the AudioWorklet did not load (${err.message ?? err})`);
        show();
      });
  }

  // Start the sound: make the context if there is none, and resume one
  // the browser suspended. Called from a gesture.
  function startSound() {
    if (context === null && !unsupported) {
      createContext();
    }
    if (context === null || context.state !== "suspended") {
      return;
    }
    context.resume().catch(() => {});
    // iOS starts a context only with something started inside the
    // gesture itself: one silent frame.
    try {
      const source = context.createBufferSource();
      source.buffer = context.createBuffer(1, 1, context.sampleRate);
      source.connect(context.destination);
      source.start();
    } catch {
      // Not iOS, or not needed.
    }
  }

  // Listen for the reader's next gesture while sound is waiting on one.
  // A click on the control itself is the control's own (below).
  let armed = false;
  const onGesture = (event) => {
    if (event.target === control) {
      return;
    }
    startSound();
  };
  function arm(on) {
    if (on === armed) {
      return;
    }
    armed = on;
    for (const type of GESTURES) {
      if (on) {
        document.addEventListener(type, onGesture, {
          capture: true,
          passive: true,
        });
      } else {
        document.removeEventListener(type, onGesture, { capture: true });
      }
    }
  }

  // The context started, or was suspended (iOS does that during a call
  // or with the page in the background).
  function onContextState() {
    if (context === null) {
      return;
    }
    arm(context.state === "suspended");
    if (ready()) {
      playHeld();
    }
    show();
  }

  // The control: a click while sound waits starts it, and after that
  // switches it on and off.
  control.addEventListener("click", () => {
    if (!ready()) {
      startSound();
      return;
    }
    off = !off;
    gain.gain.value = off ? GAIN_OFF : GAIN_ON;
    onSwitch(off ? Sound.OFF : Sound.ON);
    show();
  });

  return {
    rate: PREFERRED_RATE,

    onState(state, event) {
      streamPlaying = state.playing;
      if (event === "start") {
        node?.port.postMessage({ kind: "start" });
      }
      if (event === "stop" || event === "drain") {
        node?.port.postMessage({ kind: "end" });
      }

      // A program is about to play: start the context now if the page
      // allows it, so the worklet is loaded by the first chunk.
      if (event === "prepare" || event === "start") {
        if (context === null && activated()) {
          startSound();
        } else if (!ready()) {
          arm(true);
        }
      }
      show();
    },

    onChunk(chunk) {
      chunks++;
      const samples = toFloat32(chunk.data, chunk.format);
      heard = heard || !isSilent(samples);
      const { channels, rate } = chunk.format;
      if (!ready()) {
        held.push(samples, channels, rate);
        if (context === null && activated()) {
          startSound();
        } else {
          arm(true);
        }
        show();
        return 0;
      }
      post(samples, channels, rate, Overflow.DROP_OLDEST);
      return Math.round(queuedSeconds * rate);
    },

    // What the sound is doing, for tests and the browser console.
    stats: () => ({
      control: controlState(),
      context: context?.state ?? null,
      sampleRate: context?.sampleRate ?? 0,
      chunks,
      heldSeconds: held.seconds,
      queuedSeconds,
      underruns,
      dropped,
    }),
  };
}
