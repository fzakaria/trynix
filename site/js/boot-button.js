// The boot button's rule (app.js): what the button under the selection
// says, and whether it can be pressed, from where the page's boot is.
//
// A page holds its engine for its life, and a second boot in the same
// page started a second engine beside the first. So the button stays
// disabled while a boot is under way, and a boot that failed once its
// engine started is retried in a fresh page.

// Where the page's boot is.
export const BootState = Object.freeze({
  // No boot is under way, and none has started an engine. A boot that
  // failed before its engine started comes back here, and the next
  // boot runs in this page.
  IDLE: "idle",
  // A boot is under way and its guest is not running yet.
  BOOTING: "booting",
  // The guest is running, or on its way to its prompt: the button adds
  // the selection to it.
  RUNNING: "running",
  // A boot failed once its engine started. Nothing runs, and the button
  // starts over in a fresh page.
  FAILED: "failed",
});

// What the button reads.
export const BootLabel = Object.freeze({
  BOOT: "Boot",
  ADD: "Add to the running VM",
  START_OVER: "Start over",
});

// The button for a boot at `state`, with `selected` paths selected and
// `unheld` of them held by no configured cache: its label, and whether
// it is disabled.
export function bootButtonOf({ state, selected, unheld }) {
  // A boot under way keeps the button disabled through every redraw.
  if (state === BootState.BOOTING) {
    return { label: BootLabel.BOOT, disabled: true };
  }

  // After a boot that failed once its engine started, starting over is
  // the one thing left, whatever is selected.
  if (state === BootState.FAILED) {
    return { label: BootLabel.START_OVER, disabled: false };
  }

  // A boot or an addition needs something selected, and one path no
  // cache holds fails the whole closure walk.
  return {
    label: state === BootState.RUNNING ? BootLabel.ADD : BootLabel.BOOT,
    disabled: selected === 0 || unheld > 0,
  };
}
