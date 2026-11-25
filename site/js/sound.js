// The guest's sound on the page: the console bar's switch over the
// SoundSink unkernel's SDK plays the guest's PCM with (createAudioOut in
// unkernel/web, js/web/audio.ts upstream).
//
// unkernel's kwsnd driver is ALSA card 0 in the guest. The SDK's sink
// posts each chunk to an AudioWorklet that plays from its own queue
// whatever the main thread is doing. Browsers do not let a page start
// sound before the reader has clicked or pressed a key on it, and a Try
// link boots and runs its command with no click on the new page, so the
// sink makes no AudioContext before that gesture: it holds the latest
// 10 s of what plays, and a clip that ended by then plays whole after
// the click while a stream still playing joins live. This module only
// shows that: the control says a click will play the sound, and after
// that it is the switch, sound on or off.
//
// A link can start the sound off (url.js, `sound`), and the switch puts
// its position in the link (`onSwitch`, app.js).

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
  // No program has played anything but silence, or the browser has no
  // Web Audio: no control.
  HIDDEN: "hidden",
  // Sound is held until the reader clicks.
  WAITING: "waiting",
  ON: "on",
  OFF: "off",
});

// The SDK's AudioOut states (AudioOutState in unkernel/web).
export const AudioState = Object.freeze({
  IDLE: "idle",
  WAITING: "waiting",
  RUNNING: "running",
  UNAVAILABLE: "unavailable",
  CLOSED: "closed",
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

// What the control shows for the sink's state and the switch.
export function controlState(audioState, muted) {
  if (audioState === AudioState.WAITING) {
    return SoundControl.WAITING;
  }
  if (audioState !== AudioState.RUNNING) {
    return SoundControl.HIDDEN;
  }
  return muted ? SoundControl.OFF : SoundControl.ON;
}

// The sink for createKernel's `sound` option. `createAudioOut` is the
// SDK's, `control` the console bar's button, `position` where the
// switch starts (Sound), and `onSwitch` hears each new position.
export function createSoundOut({
  createAudioOut,
  log,
  control,
  position = Sound.ON,
  onSwitch = () => {},
}) {
  // Redraw the control. The sink calls onChange from a microtask, never
  // from inside the kernel's call that handed it the chunk.
  function show() {
    const state = controlState(audio.state, audio.muted);
    control.hidden = state === SoundControl.HIDDEN;
    control.dataset.state = state;
    if (state === SoundControl.HIDDEN) {
      return;
    }
    control.textContent = LABELS[state];
    control.title = TITLES[state];
  }

  const audio = createAudioOut({
    log,
    muted: position === Sound.OFF,
    onChange: show,
  });

  // The control: a click while sound waits starts it, and after that
  // switches it on and off.
  control.addEventListener("click", () => {
    if (audio.state !== AudioState.RUNNING) {
      audio.resume();
      return;
    }
    audio.muted = !audio.muted;
    onSwitch(audio.muted ? Sound.OFF : Sound.ON);
    show();
  });

  show();
  return audio;
}
