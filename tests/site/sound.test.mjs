// Tests the console bar's sound control (site/js/sound.js) over the
// SDK's AudioOut: what the control shows for each sink state and switch
// position, and what a click on it does. The AudioOut is a fake that
// records resume() calls and lets a test move its state the way the
// SDK does, through onChange.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  AudioState,
  controlState,
  createSoundOut,
  Sound,
  SoundControl,
} from "../../site/js/sound.js";

// The console bar's button, as far as sound.js touches it, with a way
// to click it.
function fakeControl() {
  const listeners = [];
  return {
    hidden: true,
    dataset: {},
    textContent: "",
    title: "",
    addEventListener(type, listener) {
      assert.equal(type, "click");
      listeners.push(listener);
    },
    click() {
      for (const listener of listeners) {
        listener();
      }
    },
  };
}

// The SDK's createAudioOut, faked: the sink starts idle with the
// options' mute, `resumes` counts resume() calls, and `move` changes
// the state and tells onChange, as the SDK does from a microtask.
function fakeAudioOut() {
  const made = {};
  made.create = (options) => {
    const audio = {
      state: AudioState.IDLE,
      muted: options.muted ?? false,
      resumes: 0,
      resume() {
        audio.resumes++;
      },
      stats: () => ({}),
      move(state) {
        audio.state = state;
        options.onChange(state);
      },
    };
    made.audio = audio;
    return audio;
  };
  return made;
}

// Checks the mapping from the sink's state and the switch to what the
// control shows, for every state the SDK names.
test("the control follows the sink's state and the switch", () => {
  assert.equal(controlState(AudioState.IDLE, false), SoundControl.HIDDEN);
  assert.equal(controlState(AudioState.WAITING, false), SoundControl.WAITING);
  assert.equal(controlState(AudioState.WAITING, true), SoundControl.WAITING);
  assert.equal(controlState(AudioState.RUNNING, false), SoundControl.ON);
  assert.equal(controlState(AudioState.RUNNING, true), SoundControl.OFF);
  assert.equal(
    controlState(AudioState.UNAVAILABLE, false),
    SoundControl.HIDDEN,
  );
  assert.equal(controlState(AudioState.CLOSED, false), SoundControl.HIDDEN);
});

// Checks a page whose sound waits for the reader: the control is hidden
// until the guest plays, says a click will play it, and a click on it
// asks the sink to start rather than switching it off.
test("a click while sound waits starts it", () => {
  const fake = fakeAudioOut();
  const control = fakeControl();
  const switched = [];
  createSoundOut({
    createAudioOut: fake.create,
    log: () => {},
    control,
    onSwitch: (position) => switched.push(position),
  });
  assert.equal(control.hidden, true);

  fake.audio.move(AudioState.WAITING);
  assert.equal(control.hidden, false);
  assert.equal(control.dataset.state, SoundControl.WAITING);

  control.click();
  assert.equal(fake.audio.resumes, 1);
  assert.equal(fake.audio.muted, false);
  assert.deepEqual(switched, []);
});

// Checks the switch once sound runs: each click mutes or unmutes the
// sink and tells onSwitch the new position, which the page puts in the
// link.
test("a click while sound runs switches it off and on", () => {
  const fake = fakeAudioOut();
  const control = fakeControl();
  const switched = [];
  createSoundOut({
    createAudioOut: fake.create,
    log: () => {},
    control,
    onSwitch: (position) => switched.push(position),
  });
  fake.audio.move(AudioState.RUNNING);
  assert.equal(control.dataset.state, SoundControl.ON);

  control.click();
  assert.equal(fake.audio.muted, true);
  assert.equal(control.dataset.state, SoundControl.OFF);

  control.click();
  assert.equal(fake.audio.muted, false);
  assert.equal(control.dataset.state, SoundControl.ON);
  assert.deepEqual(switched, [Sound.OFF, Sound.ON]);
  assert.equal(fake.audio.resumes, 0);
});

// Checks a link with sound=off: the sink starts muted, so the first
// sound the reader starts plays silently and the control says off.
test("a link's sound=off starts the sink muted", () => {
  const fake = fakeAudioOut();
  const control = fakeControl();
  createSoundOut({
    createAudioOut: fake.create,
    log: () => {},
    control,
    position: Sound.OFF,
  });
  assert.equal(fake.audio.muted, true);

  fake.audio.move(AudioState.RUNNING);
  assert.equal(control.dataset.state, SoundControl.OFF);
});
