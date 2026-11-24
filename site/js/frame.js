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

// The class the console takes once a GUI program has connected:
// style.css grows the terminal so windows fit.
const WINDOWED_CLASS = "windowed";

// The frame around wland's desktop. `consoleElement` is the console,
// `container` the element wland draws windows in, `terminal` the
// terminal behind the windows, and `focusTerminal` gives the terminal
// the keyboard.
//
// gui.js calls open() when the first program connects, passes changed()
// to wland as its window-list and focus callback, and hands the
// compositor to attach() once it runs.
export function consoleFrame({
  consoleElement,
  container,
  terminal,
  focusTerminal,
}) {
  let desktop = null;

  // Whether an update is queued for the end of the current task.
  let queued = false;

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

  // Everything above, once the current task is done. wland calls
  // changed() while it dispatches the compositor's events, and a call
  // back into the compositor then could free a commit's pixels before
  // they are drawn.
  function update() {
    queued = false;
    if (desktop === null) {
      return;
    }
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

    // The compositor is running.
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

      changed();
    },
  };
}
