// The key bar: the keys a phone's keyboard does not have.
//
// A soft keyboard types letters and little else; a shell wants Esc,
// Tab, Ctrl-C and arrows. The bar under the console offers them the
// way termux does — a row of buttons, each of which writes the bytes
// the key would have produced into the same line discipline the
// terminal's own input goes through. Ctrl and Alt are sticky: tap one,
// then the key it should modify, from the bar or from the keyboard.
//
// The bar only shows on a coarse pointer (style.css); on a desktop the
// keyboard has all of these.

const ESC = "\x1b";
const CSI = `${ESC}[`;

// A key is either something to send, or a modifier to arm. An arrow
// or a navigation key carries its CSI final byte separately, because
// with a modifier armed it is sent in the modified form (ESC [ 1 ; m X).
const KEYS = [
  { label: "Esc", send: ESC },
  { label: "Tab", send: "\t" },
  { label: "Ctrl", modifier: "ctrl" },
  { label: "Alt", modifier: "alt" },
  { label: "←", cursor: "D" },
  { label: "↑", cursor: "A" },
  { label: "↓", cursor: "B" },
  { label: "→", cursor: "C" },
  { label: "Home", cursor: "H" },
  { label: "End", cursor: "F" },
  { label: "PgUp", send: `${CSI}5~` },
  { label: "PgDn", send: `${CSI}6~` },
  // The guest learns its terminal size once, at boot (boot.js), and
  // nothing tells it when a soft keyboard takes half the rows. Fit
  // tells the shell the size the terminal has now; it is a typed
  // command, so it is for the prompt.
  {
    label: "Fit",
    command: ({ rows, cols }) => `stty rows ${rows} cols ${cols}\n`,
  },
  // A smaller or larger face. Portrait at the default size is about
  // 50 columns, and a full-screen program wants 80; press Fit after,
  // so the guest hears the new grid.
  { label: "A−", zoom: -1 },
  { label: "A+", zoom: 1 },
];

// xterm's modifier parameter: 1 plus the modifier bits.
const MODIFIER_ALT = 2;
const MODIFIER_CTRL = 4;

// What Ctrl does to a character: the same as a real terminal, which
// masks the letter down to its control code. Space becomes NUL and
// the punctuation from @ to _ maps the same way.
function control(character) {
  const code = character.toUpperCase().charCodeAt(0);
  if (code >= 0x40 && code <= 0x5f) {
    return String.fromCharCode(code & 0x1f);
  }
  if (character === " ") {
    return "\x00";
  }
  return character;
}

export class KeyBar {
  // send: writes bytes to the guest. focus: gives the terminal the
  // keyboard back after a tap. size: the terminal's rows and columns
  // now, for the key that tells the guest. zoom: changes the face by
  // a step.
  constructor(element, { send, focus, size, zoom }) {
    this.send = send;
    this.focus = focus;
    this.size = size;
    this.zoom = zoom;
    this.armed = { ctrl: false, alt: false };
    this.buttons = new Map();

    for (const key of KEYS) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = key.label;
      // pointerdown rather than click, and prevented: a click would
      // take focus from the terminal, and with it the soft keyboard.
      button.addEventListener("pointerdown", (event) => {
        event.preventDefault();
        this.press(key);
      });
      element.append(button);
      if (key.modifier !== undefined) {
        this.buttons.set(key.modifier, button);
      }
    }
  }

  press(key) {
    if (key.modifier !== undefined) {
      this.armed[key.modifier] = !this.armed[key.modifier];
      this.render();
      this.focus();
      return;
    }

    if (key.cursor !== undefined) {
      const modifier =
        1 +
        (this.armed.alt ? MODIFIER_ALT : 0) +
        (this.armed.ctrl ? MODIFIER_CTRL : 0);
      this.send(
        modifier === 1
          ? `${CSI}${key.cursor}`
          : `${CSI}1;${modifier}${key.cursor}`,
      );
      this.disarm();
      this.focus();
      return;
    }

    if (key.command !== undefined) {
      this.send(key.command(this.size()));
      this.focus();
      return;
    }

    if (key.zoom !== undefined) {
      this.zoom(key.zoom);
      this.focus();
      return;
    }

    this.send(this.transform(key.send));
    this.focus();
  }

  // Apply the armed modifiers to what the keyboard typed, and use them
  // up. Only a single character takes a modifier; a paste goes through
  // untouched.
  transform(data) {
    if (!this.armed.ctrl && !this.armed.alt) {
      return data;
    }
    if (data.length !== 1) {
      return data;
    }
    let out = this.armed.ctrl ? control(data) : data;
    if (this.armed.alt) {
      out = `${ESC}${out}`;
    }
    this.disarm();
    return out;
  }

  disarm() {
    this.armed.ctrl = false;
    this.armed.alt = false;
    this.render();
  }

  render() {
    for (const [modifier, button] of this.buttons) {
      button.classList.toggle("armed", this.armed[modifier]);
    }
  }
}
