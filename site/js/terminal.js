// The console the guest talks to.
//
// Two terminals can fill the role. Ghostty is the one to want: the
// same VT parser that powers the native app, compiled to wasm, so
// escape sequences, wide characters and RTL behave the way they do in
// a real terminal rather than the way a JavaScript reimplementation
// guesses. xterm.js is kept as the fallback for a browser where the
// ghostty module will not load.
//
// The pty is bridged by hand rather than through xterm-pty's addon.
// The addon subscribes to onData, onBinary and onResize; ghostty
// implements the first and third but not onBinary, so activating it
// throws. Everything the addon does is three lines, and doing them
// here is what lets one bridge serve both terminals.

/* global Terminal */

// The bridge, in both directions: what the guest writes is drawn, what
// is typed goes to the line discipline, and a resized terminal tells
// the guest its new size.
function bridge(terminal, master) {
  master.onWrite(([data, callback]) => terminal.write(data, callback));
  terminal.onData((data) => master.ldisc.writeFromLower(data));
  terminal.onResize(({ cols, rows }) => master.notifyResize(rows, cols));
}

async function openGhostty(element) {
  const {
    init,
    Terminal: GhosttyTerminal,
    FitAddon,
  } = await import("../vendor/ghostty-web.js");
  await init();
  const terminal = new GhosttyTerminal();
  terminal.open(element);

  // Without this the terminal keeps its default 80x24 and the rest of
  // the container is dead black space beside it. The addon also
  // watches the container, so a resized window refits.
  const fit = new FitAddon();
  terminal.loadAddon(fit);
  fit.fit();
  fit.observeResize();

  return { terminal, engine: "ghostty" };
}

function openXterm(element) {
  const terminal = new Terminal();
  terminal.open(element);
  return { terminal, engine: "xterm" };
}

// Ctrl-C over a selection is a copy, everywhere else in the browser.
// Passing it through as well sends an interrupt to the guest and
// leaves a stray prompt, so it is swallowed when there is something to
// copy — and passed through untouched when there is not, because that
// is how a shell is interrupted.
function handleCopyKey(terminal) {
  terminal.attachCustomKeyEventHandler?.((event) => {
    const isCopy =
      event.key === "c" && (event.ctrlKey || event.metaKey) && !event.altKey;
    if (event.type === "keydown" && isCopy && terminal.hasSelection?.()) {
      navigator.clipboard?.writeText(terminal.getSelection()).catch(() => {});
      terminal.clearSelection?.();
      return false;
    }
    return true;
  });
}

// Returns { terminal, engine, attach } — attach wires a pty master to
// it. A ghostty that fails to load is not an error worth showing a
// reader: the fallback renders the same bytes.
export async function openTerminal(element) {
  let opened;
  try {
    opened = await openGhostty(element);
  } catch {
    opened = openXterm(element);
  }

  handleCopyKey(opened.terminal);

  return {
    ...opened,
    attach: (master) => bridge(opened.terminal, master),
  };
}
