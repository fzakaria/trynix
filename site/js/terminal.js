// The console the guest talks to: ghostty.
//
// libghostty-vt — the same VT parser the native app uses — compiled to
// wasm, with xterm.js-shaped bindings (ghostty-web). Escape sequences,
// wide characters and RTL behave the way they do in a real terminal
// rather than the way a JavaScript reimplementation guesses. There is
// no fallback engine: one renderer means one set of key semantics and
// one set of quirks to know about.
//
// The pty is bridged by hand rather than through xterm-pty's addon.
// The addon subscribes to onData, onBinary and onResize; ghostty
// implements the first and third but not onBinary, so activating it
// throws. Everything the addon does is three lines, below — and doing
// it here is what lets the key bar's sticky modifiers apply to what
// the keyboard types.

import { KeyBar } from "./keybar.js";

// The palette the terminal draws with. The container is painted with
// the same background (openTerminal sets it), so the strip the grid
// leaves at the edges — cells do not divide a container evenly — is
// invisible rather than a bar of a different black.
export const THEME = {
  background: "#16181d",
  foreground: "#e6e6e6",
  cursor: "#e6e6e6",
  selectionBackground: "#3b4252",
};
// A phone gets a smaller face: 14px is 43 columns on a portrait
// screen, which full-screen programs refuse; 12px is a little over 50.
// (80 columns wants the phone turned sideways.)
const FONT_SIZE = 14;
const FONT_SIZE_TOUCH = 12;
const FONT_SIZE_MIN = 6;
const FONT_SIZE_MAX = 24;
const SCROLLBACK_LINES = 5000;
const touch = matchMedia("(pointer: coarse)");

// On a touch device the terminal is sized from the visual viewport —
// what is actually on screen above the soft keyboard — rather than
// from CSS. The viewport meta asks the browser to shrink the layout
// when the keyboard opens, but a phone that ignores it shrinks only
// the visual viewport, and then a terminal laid out for the whole
// screen keeps its key bar under the keyboard and every tap scrolls
// the page back to the terminal's top. Measuring what is visible and
// keeping the console at the top of it works either way.
const TERMINAL_MIN_HEIGHT = 120;
const VIEWPORT_MARGIN = 8;

function fitToViewport(element) {
  const viewport = window.visualViewport;
  const console_ = element.closest("#console");
  if (viewport === undefined || console_ === null) {
    return;
  }

  const apply = () => {
    const chrome = console_.offsetHeight - element.offsetHeight;
    const height = Math.max(
      TERMINAL_MIN_HEIGHT,
      Math.floor(viewport.height - chrome - VIEWPORT_MARGIN),
    );
    element.style.height = `${height}px`;
    console_.scrollIntoView({ block: "start" });
  };

  viewport.addEventListener("resize", apply);
  apply();
}
const BACKGROUND_PROPERTY = "--console-bg";

// The bridge, in both directions: what the guest writes is drawn, what
// is typed goes through the key bar's modifiers to the line
// discipline, and a resized terminal tells the guest its new size.
function bridge(terminal, master, keyBar) {
  master.onWrite(([data, callback]) => terminal.write(data, callback));
  terminal.onData((data) =>
    master.ldisc.writeFromLower(keyBar.transform(data)),
  );
  terminal.onResize(({ cols, rows }) => master.notifyResize(rows, cols));
}

// Ctrl-C over a selection is a copy, everywhere else in the browser.
// Passing it through as well sends an interrupt to the guest and
// leaves a stray prompt, so it is swallowed when there is something to
// copy — and passed through untouched when there is not, because that
// is how a shell is interrupted.
//
// ghostty reads the handler's return value as "handled": true means
// stop here, false means go on and send the key to the guest. (xterm.js
// reads it the other way round, which is worth remembering if the
// engine ever changes.)
const HANDLED = true;
const PASS_THROUGH = false;

function handleCopyKey(terminal) {
  terminal.attachCustomKeyEventHandler((event) => {
    const isCopy =
      event.key === "c" && (event.ctrlKey || event.metaKey) && !event.altKey;
    if (event.type === "keydown" && isCopy && terminal.hasSelection()) {
      navigator.clipboard?.writeText(terminal.getSelection()).catch(() => {});
      terminal.clearSelection();
      return HANDLED;
    }
    return PASS_THROUGH;
  });
}

// Returns { terminal, attach } — attach wires a pty master to it.
// keyBarElement holds the touch key bar (keybar.js).
export async function openTerminal(element, keyBarElement) {
  const {
    init,
    Terminal: GhosttyTerminal,
    FitAddon,
  } = await import("../vendor/ghostty-web.js");
  await init();

  // The variable is site-wide: the frame around the terminal and the
  // veil over it are painted with it too.
  document.documentElement.style.setProperty(
    BACKGROUND_PROPERTY,
    THEME.background,
  );
  const terminal = new GhosttyTerminal({
    theme: THEME,
    fontSize: touch.matches ? FONT_SIZE_TOUCH : FONT_SIZE,
    scrollback: SCROLLBACK_LINES,
    cursorBlink: true,
  });
  terminal.open(element);

  // Without this the terminal keeps its default 80x24 and the rest of
  // the container is dead space beside it. The addon also watches the
  // container, so a resized window refits.
  const fit = new FitAddon();
  terminal.loadAddon(fit);
  fit.fit();
  fit.observeResize();

  if (touch.matches) {
    fitToViewport(element);
  }

  // A smaller face on a phone is how a full-screen program gets its
  // 80 columns in portrait; ghostty takes the new size at runtime and
  // the grid is refitted to it.
  const zoom = (delta) => {
    const size = Math.min(
      FONT_SIZE_MAX,
      Math.max(FONT_SIZE_MIN, terminal.options.fontSize + delta),
    );
    terminal.options.fontSize = size;
    fit.fit();
  };

  handleCopyKey(terminal);

  // Focus without scrolling: ghostty's own focus() lets the browser
  // scroll the input into view, and on a phone with the keyboard up
  // that drags the page away from the key bar on every tap.
  const focus = () => {
    const input = element.querySelector("textarea");
    (input ?? element).focus({ preventScroll: true });
  };

  return {
    terminal,
    attach: (master) => {
      const keyBar = new KeyBar(keyBarElement, {
        send: (data) => master.ldisc.writeFromLower(data),
        focus,
        size: () => ({ rows: terminal.rows, cols: terminal.cols }),
        zoom,
      });
      bridge(terminal, master, keyBar);
    },
  };
}
