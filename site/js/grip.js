// The console's resize grip: a strip along the bottom edge of the
// console's frame that the reader drags to make the terminal taller or
// shorter. ghostty refits its rows to the new height (terminal.js), and
// GUI windows over the terminal stay reachable (frame.js).
//
// A focused grip takes the arrow keys too, Home and End go to the
// shortest and the tallest, and a double click gives the terminal back
// its own height. Once the reader has set a height, the frame no longer
// grows by itself for a new window (frame.js reads SIZED_BY_READER):
// the reader's size wins.
//
// There is no grip on a touch screen, where terminal.js sizes the
// terminal to what is on screen, nor in full screen (style.css), where
// the terminal fills the screen.

// The shortest terminal worth having, the room left on screen at the
// tallest, and a key's step, in rem.
const SHORTEST_REM = 12;
const SCREEN_GAP_REM = 2;
const STEP_REM = 2;

// What the terminal's dataset says once the reader has sized it.
export const SIZED_BY_READER = "reader";

// The keys a focused grip takes.
export const GripKey = Object.freeze({
  UP: "ArrowUp",
  DOWN: "ArrowDown",
  HOME: "Home",
  END: "End",
});

// A height held between `min` and `max`.
export const clampHeight = (height, { min, max }) =>
  Math.min(Math.max(height, min), max);

// The height a key asks for from `height`, or null for a key that is
// not the grip's.
export function keyedHeight(height, key, { min, max, step }) {
  switch (key) {
    case GripKey.UP:
      return clampHeight(height - step, { min, max });
    case GripKey.DOWN:
      return clampHeight(height + step, { min, max });
    case GripKey.HOME:
      return min;
    case GripKey.END:
      return max;
    default:
      return null;
  }
}

// Wire `grip` to resize `terminal`, the element whose height the
// console's frame takes.
export function resizeGrip({ grip, terminal }) {
  if (matchMedia("(pointer: coarse)").matches) {
    grip.hidden = true;
    return;
  }

  // The bounds and the step in pixels, from the root font size and the
  // viewport as they are now.
  const rem = () =>
    parseFloat(getComputedStyle(document.documentElement).fontSize);
  const bounds = () => {
    const min = SHORTEST_REM * rem();
    return {
      min,
      max: Math.max(min, window.innerHeight - SCREEN_GAP_REM * rem()),
      step: STEP_REM * rem(),
    };
  };
  const heightNow = () => terminal.getBoundingClientRect().height;

  function setHeight(height) {
    terminal.style.height = `${clampHeight(height, bounds())}px`;
    terminal.dataset.sized = SIZED_BY_READER;
  }

  // A drag: the pointer is captured, so the drag goes on outside the
  // strip, and the height follows the pointer from where it started.
  let drag = null;
  grip.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) {
      return;
    }
    event.preventDefault();
    grip.setPointerCapture(event.pointerId);
    drag = { y: event.clientY, height: heightNow() };
  });
  grip.addEventListener("pointermove", (event) => {
    if (drag === null) {
      return;
    }
    setHeight(drag.height + event.clientY - drag.y);
  });
  const endDrag = () => {
    drag = null;
  };
  grip.addEventListener("pointerup", endDrag);
  grip.addEventListener("pointercancel", endDrag);

  // The keys, on a focused grip.
  grip.addEventListener("keydown", (event) => {
    const height = keyedHeight(heightNow(), event.key, bounds());
    if (height === null) {
      return;
    }
    event.preventDefault();
    setHeight(height);
  });

  // A double click gives the terminal back its own height, and the frame
  // grows for windows again.
  grip.addEventListener("dblclick", () => {
    terminal.style.height = "";
    delete terminal.dataset.sized;
  });
}
