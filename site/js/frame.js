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
// A new window opens clear of the shell's prompt where it can. The
// console bar has a button that hides every window, bringing the
// terminal forward, and shows them again, and a full-screen button for
// the whole frame.

import { log } from "./log.js";

// The class the console takes once a GUI program has connected:
// style.css grows the terminal so windows fit.
const WINDOWED_CLASS = "windowed";

// The gap a window opened at the frame's bottom leaves under it: the
// same as wland's cascade leaves on the left (view.ts).
export const WINDOW_MARGIN = 24;

// How far down the terminal its cursor may be, as a share of its rows,
// for a new window to open at the bottom rather than where wland put
// it, at the top.
const CURSOR_UPPER_HALF = 0.5;

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

// Where a new window at `box`, wland's cascade near the frame's top,
// opens. wland's place covers the top of the terminal, which is where
// the shell's prompt is until the screen has filled, so while the
// cursor (`cursorDepth`, 0 at the top row, 1 below the last) is in the
// upper half the window opens at the bottom instead and the prompt the
// program was started from stays in view. It is never moved up.
export function opensAt(box, frame, cursorDepth) {
  const bottom = frame.height - box.height - WINDOW_MARGIN;
  if (cursorDepth > CURSOR_UPPER_HALF || bottom <= box.top) {
    return { left: box.left, top: box.top };
  }
  return { left: box.left, top: bottom };
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

  // How far down the terminal its cursor is: 0 at the top row, 1 below
  // the last.
  const cursorDepth = () =>
    (terminal.buffer.active.cursorY + 1) / terminal.rows;

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

  // A new window opens clear of the terminal's prompt (opensAt). A
  // window is looked at once, as soon as its first commit has given it
  // a size.
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
      moveWindow(win, box, opensAt(box, frameSize(), cursorDepth()));
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

    // The first program connected: show the container and grow the
    // frame, then bring the whole frame on screen, where the window
    // will open. The output wland tells programs about is the
    // container's size, so this comes before the compositor starts.
    open() {
      container.hidden = false;
      consoleElement.classList.add(WINDOWED_CLASS);
      consoleElement.scrollIntoView({ block: "nearest" });
    },

    // The compositor is running: wire the windows button.
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
      changed();
    },
  };
}
