// Tests the intro's hint phrases (site/js/hints.js) from the keyboard.
// A phrase is a span, so it wraps across lines as the words around it
// do, and a span has none of a button's keys: hints.js gives it Enter
// and Space. The page is stood in for by elements that keep their
// attributes and listeners, which is all hints.js touches.
import { test } from "node:test";
import assert from "node:assert/strict";

import { wireHints } from "../../site/js/hints.js";

// An element as hints.js uses one: attributes, listeners, and events
// handed to the listeners in order.
class StandIn {
  constructor(attributes = {}) {
    this.attributes = { ...attributes };
    this.listeners = new Map();
  }

  getAttribute(name) {
    return this.attributes[name] ?? null;
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  // Hands each listener for `type` an event with `fields`, and returns
  // the event so a test can see whether its default was prevented.
  dispatch(type, fields = {}) {
    const event = {
      type,
      ...fields,
      defaultPrevented: false,
      preventDefault() {
        this.defaultPrevented = true;
      },
      stopPropagation() {},
    };
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
    return event;
  }
}

// Two closed phrases wired on a page of stand-ins.
function wired() {
  const phrases = [
    new StandIn({ "aria-expanded": "false" }),
    new StandIn({ "aria-expanded": "false" }),
  ];
  const root = {
    querySelectorAll: (selector) =>
      selector === ".hint-phrase" ? phrases : [],
  };
  globalThis.document = new StandIn();
  wireHints(root);
  return phrases;
}

// Presses Enter, then Space, on a focused phrase, and checks that each
// press opens or closes its note as a click does, without the key's
// own default (Space scrolls the page), and that opening one note
// closes the other.
test("Enter and Space open and close a focused phrase's note", () => {
  const [gui, sound] = wired();

  const enter = gui.dispatch("keydown", { key: "Enter" });
  assert.equal(gui.getAttribute("aria-expanded"), "true");
  assert.equal(enter.defaultPrevented, true);

  const space = sound.dispatch("keydown", { key: " " });
  assert.equal(sound.getAttribute("aria-expanded"), "true");
  assert.equal(gui.getAttribute("aria-expanded"), "false");
  assert.equal(space.defaultPrevented, true);

  sound.dispatch("keydown", { key: " " });
  assert.equal(sound.getAttribute("aria-expanded"), "false");
});

// Presses a key that is not Enter or Space on a focused phrase, and
// checks that its note stays closed and the key keeps its default, so
// Tab still moves focus on.
test("other keys leave a phrase's note alone", () => {
  const [gui] = wired();

  const tab = gui.dispatch("keydown", { key: "Tab" });
  assert.equal(gui.getAttribute("aria-expanded"), "false");
  assert.equal(tab.defaultPrevented, false);
});
