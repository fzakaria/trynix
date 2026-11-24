// The console frame: the terminal, with GUI programs' windows over it.
//
// wland (gui.js) composites the guest's windows into a container that
// covers the console's body, so a window opens where the reader is
// already looking, with the terminal drawn behind it as the backdrop.
// The container takes no pointer itself (style.css); wland's window
// canvases take their own. A press on a window reaches the window, and
// a press anywhere else in the frame reaches the terminal.
//
// The keyboard follows the page's focus, so it is never with both.
// wland keeps it on a hidden element of its own, which a press on a
// window focuses. A press on the terminal focuses ghostty's input, and
// the frame tells wland to take the keyboard from its windows. When
// the window holding the keyboard goes (closed or minimized), wland
// hands the keyboard to the next window, and with none left the frame
// gives it to the terminal.
//
// The console bar has a button that hides every window, bringing the
// terminal forward, and shows them again, and a full-screen button for
// the whole frame. A window larger than the frame, which on a phone is
// most of them, opens maximized, and a smaller one opens clear of the
// shell's prompt where it can. A window moved past the frame's edge,
// or left there when the frame shrank, is pulled back until a grip of
// it is inside.

import { log } from "./log.js";
import { SIZED_BY_READER } from "./grip.js";

// The class the console takes once a GUI program has connected.
const WINDOWED_CLASS = "windowed";

// The terminal's height before any window, and the room the frame
// leaves on screen when it grows, in rem: style.css's #terminal height,
// and what is left of the viewport for the bar and a margin.
const FRAME_BASE_REM = 30;
const FRAME_GAP_REM = 4;

// How much of a floating window stays inside the frame: wland's own
// Alt+drag keeps the same strip (wm.ts), wide enough to take hold of
// and as tall as a title bar, which is where the window is moved from.
export const WINDOW_GRIP = Object.freeze({ width: 40, height: 24 });

// The gap a window opened at the frame's bottom leaves under it: the
// same as wland's cascade leaves on the left (view.ts).
export const WINDOW_MARGIN = 24;

// What the windows button does next, which is also what it says.
export const WindowsAction = Object.freeze({
  NONE: "none",
  HIDE: "hide",
  SHOW: "show",
});

// What the full-screen button says, by whether the frame is full screen.
const FullScreenLabel = Object.freeze({
  ENTER: "full screen",
  EXIT: "exit full screen",
});

// Whether a window fills the frame: maximized or full screen, at its
// program's asking (firefox opens maximized) or the reader's, and not
// minimized. Such a window gets the frame at its tallest.
export const fillsFrame = (win) =>
  !win.minimized && (win.maximized || win.fullscreen);

// Whether a window's box is wider or taller than the frame's.
export const oversized = (box, frame) =>
  box.width > frame.width || box.height > frame.height;

// Where a new window at `box`, wland's cascade near the frame's top,
// opens, and how tall the frame is then. `prompt` is the shell's
// cursor line ({ top, bottom }) in the frame's pixels, `frame` the
// frame's size now, and `tallest` the most the frame may grow to.
//
// The window opens just under the prompt line, so the line the program
// was started from stays in view with the window right below it, and
// the frame grows only as far as the window needs. A window that fits
// above a low prompt without growing the frame stays where wland put
// it. One that fits in neither place opens as low as it fits whole.
// Wherever it opens, a window keeps wland's left edge unless its right
// edge would then be past the frame's, which a window nearly as wide as
// the frame is at wland's cascade: such a window moves left just enough
// to be inside.
export function opensAt(box, { frame, prompt, tallest }) {
  const under = prompt.bottom + WINDOW_MARGIN;
  const fitsUnder = (height) => under + box.height + WINDOW_MARGIN <= height;
  const left = Math.max(0, Math.min(box.left, frame.width - box.width));

  // Under the prompt, in the frame as it is.
  if (fitsUnder(frame.height)) {
    return { left, top: under, height: frame.height };
  }

  // Above a low prompt, where wland put it.
  if (box.top + box.height + WINDOW_MARGIN <= prompt.top) {
    return { left, top: box.top, height: frame.height };
  }

  // Under the prompt, in a frame grown to fit, up to the tallest.
  const height = Math.min(
    Math.max(frame.height, under + box.height + WINDOW_MARGIN),
    tallest,
  );
  if (fitsUnder(height)) {
    return { left, top: under, height };
  }
  return {
    left,
    top: Math.max(0, height - box.height - WINDOW_MARGIN),
    height,
  };
}

// Whether the frame grows for a new window. It is held at its height
// on a touch device, where terminal.js sizes the terminal to what is
// on screen, in full screen, where the frame fills the screen already,
// and once the reader has set the height with the grip (grip.js).
export const FrameGrowth = Object.freeze({
  GROWS: "grows",
  HELD: "held",
});

// How a new window at `box` is placed: `{ maximized: true, height }`
// when it is larger than the frame can be, the frame then made
// `height` tall, or `{ maximized: false, left, top, height }`, where
// it opens and how tall the frame is then (opensAt). `growth` says
// whether the frame grows (FrameGrowth): one that grows can be as tall
// as `tallest`, nearly the viewport, and one held at its height can be
// no taller than it is now.
export function placeWindow(box, { frame, prompt, tallest, growth }) {
  const most =
    growth === FrameGrowth.GROWS
      ? Math.max(frame.height, tallest)
      : frame.height;
  if (oversized(box, { width: frame.width, height: most })) {
    return { maximized: true, height: most };
  }
  return {
    maximized: false,
    ...opensAt(box, { frame, prompt, tallest: most }),
  };
}

// Where a window at `box` goes so that a grip of it is inside `frame`:
// its left or right strip within the sides, its top edge between the
// frame's top and a grip's height above the bottom.
export function keepReachable(box, frame) {
  const left = Math.min(
    Math.max(box.left, WINDOW_GRIP.width - box.width),
    frame.width - WINDOW_GRIP.width,
  );
  const top = Math.min(Math.max(box.top, 0), frame.height - WINDOW_GRIP.height);
  return { left, top };
}

// The windows button for wland's window entries: nothing to do with no
// windows, hide them while any shows, show them once all are hidden.
export function windowsButton(windows) {
  if (windows.length === 0) {
    return { action: WindowsAction.NONE, label: "" };
  }
  const hidden = windows.filter((entry) => entry.minimized).length;
  if (hidden < windows.length) {
    return { action: WindowsAction.HIDE, label: "hide windows" };
  }
  return { action: WindowsAction.SHOW, label: `show windows (${hidden})` };
}

// A press on a bar button leaves the keyboard where it was. A button
// takes focus on a press, and with it the keyboard from the terminal
// or from a window; the click still comes.
function keepFocus(button) {
  button.addEventListener("mousedown", (event) => event.preventDefault());
}

// The bar's full-screen button: the whole console frame, terminal and
// windows, in the browser's full screen and back. Left hidden where the
// Fullscreen API is missing, which is iPhone's Safari.
export function fullScreenButton({ consoleElement, button }) {
  if (
    !document.fullscreenEnabled ||
    typeof consoleElement.requestFullscreen !== "function"
  ) {
    return;
  }

  // The label follows the browser's state, which Esc changes too.
  const relabel = () => {
    button.textContent =
      document.fullscreenElement === consoleElement
        ? FullScreenLabel.EXIT
        : FullScreenLabel.ENTER;
  };
  document.addEventListener("fullscreenchange", relabel);
  relabel();

  // Toggle on a click, which carries the user gesture the request needs.
  keepFocus(button);
  button.addEventListener("click", () => {
    if (document.fullscreenElement === consoleElement) {
      document.exitFullscreen().catch(() => {});
      return;
    }
    consoleElement
      .requestFullscreen()
      .catch((err) => log(`full screen refused: ${err.message ?? err}`));
  });
  button.hidden = false;
}

// The frame around wland's desktop. `consoleElement` is the console,
// `container` the element wland draws windows in, `windowsButton` the
// bar's windows button, `terminal` the terminal behind the windows,
// and `focusTerminal` gives the terminal the keyboard.
//
// gui.js calls open() when the first program connects, passes changed()
// to wland as its window-list and focus callback, and hands the
// compositor to attach() once it runs.
export function consoleFrame({
  consoleElement,
  container,
  windowsButton: button,
  terminal,
  focusTerminal,
}) {
  let desktop = null;

  // Windows whose size has been compared with the frame's, by key.
  const placed = new Set();

  // Whether an update is queued for the end of the current task.
  let queued = false;

  const frameSize = () => ({
    width: container.clientWidth,
    height: container.clientHeight,
  });

  // The element whose height the frame takes: style.css's #terminal.
  const terminalBox = consoleElement.querySelector("#terminal");

  // The shell's cursor line in the frame's pixels: the terminal's rows
  // are its drawn height split evenly, from where it sits in the frame.
  function promptLine() {
    const drawn = terminal.element.getBoundingClientRect();
    const offset = drawn.top - container.getBoundingClientRect().top;
    const row = drawn.height / terminal.rows;
    const cursor = terminal.buffer.active.cursorY;
    return { top: offset + cursor * row, bottom: offset + (cursor + 1) * row };
  }

  // The most the frame may grow to: nearly the viewport's height, and
  // never less than the terminal's own.
  function tallestFrame() {
    const rem = parseFloat(getComputedStyle(document.documentElement).fontSize);
    return Math.max(
      FRAME_BASE_REM * rem,
      window.innerHeight - FRAME_GAP_REM * rem,
    );
  }

  // Whether the frame grows for its windows now (FrameGrowth): held on
  // a touch device, in full screen, and once the reader has sized the
  // terminal with the grip.
  function frameGrowth() {
    if (
      terminalBox.dataset.sized === SIZED_BY_READER ||
      matchMedia("(pointer: coarse)").matches ||
      document.fullscreenElement === consoleElement
    ) {
      return FrameGrowth.HELD;
    }
    return FrameGrowth.GROWS;
  }

  // Grow the frame to `height`, by the terminal's height, which the
  // frame takes; the terminal refits its rows. A frame held at its
  // height (frameGrowth) stays as it is.
  function growFrame(height) {
    const frame = frameSize();
    if (height <= frame.height || frameGrowth() === FrameGrowth.HELD) {
      return;
    }
    const grown =
      terminalBox.getBoundingClientRect().height + height - frame.height;
    terminalBox.style.height = `${grown}px`;
    consoleElement.scrollIntoView({ block: "nearest" });
  }

  // A window's box from the styles wland gives its element: the window
  // geometry's size, and its place in the container.
  const boxOf = (win) => ({
    left: parseFloat(win.element.style.left),
    top: parseFloat(win.element.style.top),
    width: parseFloat(win.element.style.width),
    height: parseFloat(win.element.style.height),
  });

  // Put a window's element at `at` unless it is there. wland tells the
  // compositor where each window is so that menus stay on screen, and
  // a window moved here is told the same way.
  function moveWindow(win, box, at) {
    if (at.left === box.left && at.top === box.top) {
      return;
    }
    win.element.style.left = `${at.left}px`;
    win.element.style.top = `${at.top}px`;
    desktop.engine.setWindowPosition(win.conn, win.surface, at.left, at.top);
  }

  // A new window larger than the frame at its tallest opens maximized
  // in a frame grown that far, which tells the program the frame's
  // size; any other opens under the terminal's prompt, the frame
  // growing as far as it needs (placeWindow). The tallest a frame held
  // at its height can be is its height now, so a window that does not
  // fit opens maximized or as low as it fits whole in the frame as it
  // is. A window is looked at once, as soon as its first commit has
  // given it a size.
  function placeNew() {
    const entries = new Map(
      desktop.windows().map((entry) => [entry.key, entry]),
    );

    // Forget windows that went. A relay that dials again starts its
    // programs' numbering over, and a key can come back as a new window.
    for (const key of placed) {
      if (!entries.has(key)) {
        placed.delete(key);
      }
    }

    for (const win of desktop.view.windows()) {
      if (placed.has(win.key)) {
        continue;
      }
      const box = boxOf(win);
      if (!(box.width > 0 && box.height > 0)) {
        continue;
      }
      placed.add(win.key);
      if (win.maximized || win.fullscreen) {
        continue;
      }
      const at = placeWindow(box, {
        frame: frameSize(),
        prompt: promptLine(),
        tallest: tallestFrame(),
        growth: frameGrowth(),
      });
      growFrame(at.height);
      if (at.maximized) {
        entries.get(win.key)?.setMaximized(true);
        continue;
      }
      moveWindow(win, box, at);
    }
  }

  // Every floating window keeps a grip inside the frame.
  function keepWindowsReachable() {
    const frame = frameSize();
    if (frame.width === 0 || frame.height === 0) {
      return;
    }
    for (const win of desktop.view.windows()) {
      if (win.minimized || win.maximized || win.fullscreen) {
        continue;
      }
      const box = boxOf(win);
      if (!Number.isFinite(box.left) || !Number.isFinite(box.top)) {
        continue;
      }
      moveWindow(win, box, keepReachable(box, frame));
    }
  }

  // The windows button says what a press does next, and is hidden
  // while there is no window.
  function relabel() {
    const state = windowsButton(desktop.windows());
    button.hidden = state.action === WindowsAction.NONE;
    button.textContent = state.label;
  }

  // With no window holding the keyboard while wland's hidden element
  // still has the page's focus, the window that had it went: the
  // terminal takes the keyboard. Focus that is anywhere else on the
  // page is the reader's doing and stays.
  function returnKeyboard() {
    if (desktop.windows().some((entry) => entry.focused)) {
      return;
    }
    if (!container.contains(document.activeElement)) {
      return;
    }
    focusTerminal();
  }

  // The windows button: hide every window and give the terminal the
  // keyboard, or show them again, bottom of the stack first, so the
  // stacking comes back as it was and the top window takes the keyboard.
  function pressWindows() {
    const entries = desktop.windows();
    const { action } = windowsButton(entries);
    if (action === WindowsAction.HIDE) {
      for (const entry of entries) {
        if (!entry.minimized) {
          entry.minimize();
        }
      }
      focusTerminal();
      return;
    }
    if (action !== WindowsAction.SHOW) {
      return;
    }
    const stacking = new Map(
      desktop.view
        .windows()
        .map((win) => [win.key, Number(win.element.style.zIndex) || 0]),
    );
    const bottomFirst = [...entries].sort(
      (a, b) => stacking.get(a.key) - stacking.get(b.key),
    );
    for (const entry of bottomFirst) {
      entry.restore();
    }
  }

  // Everything above, once the current task is done. wland calls
  // changed() while it dispatches the compositor's events, and a call
  // back into the compositor then could free a commit's pixels before
  // they are drawn.
  function update() {
    queued = false;
    if (desktop === null) {
      return;
    }
    placeNew();
    // A window that fills the frame gets the frame at its tallest,
    // whenever it came to fill it.
    if (desktop.view.windows().some(fillsFrame)) {
      growFrame(tallestFrame());
    }
    keepWindowsReachable();
    relabel();
    returnKeyboard();
  }
  function changed() {
    if (queued) {
      return;
    }
    queued = true;
    queueMicrotask(update);
  }

  return {
    container,
    changed,

    // The first program connected: show the container, then bring the
    // whole frame on screen, where the window will open. The frame
    // grows as windows need (placeNew).
    open() {
      container.hidden = false;
      consoleElement.classList.add(WINDOWED_CLASS);
      consoleElement.scrollIntoView({ block: "nearest" });
    },

    // The compositor is running: wire the windows button, and keep
    // windows reachable when the frame changes size (full screen, a
    // resized browser) and after every drag, which ends at a release.
    attach(handle) {
      desktop = handle;

      // A press on the terminal takes the keyboard from the windows.
      // wland lets go by itself when its hidden element loses the
      // page's focus, but a browser window without the system's focus
      // sends no blur, and wland would go on holding a window focused
      // whose bindings (Alt+F9 and the rest) still act on keys.
      terminal.element.addEventListener("pointerdown", () =>
        desktop.input.blur(),
      );

      keepFocus(button);
      button.addEventListener("click", pressWindows);
      new ResizeObserver(changed).observe(container);
      document.addEventListener("pointerup", changed);
      changed();
    },
  };
}
