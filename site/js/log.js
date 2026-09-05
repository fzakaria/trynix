// A log the page keeps about its own boot.
//
// Almost everything interesting here happens inside a fetch, a wasm
// module or a guest, and when one of them fails the reader is left
// with a red row and a browser message like "TypeError: Failed to
// fetch" — true, and useless on its own. These lines say which URL,
// which attempt, and what came before.

const LIMIT = 500;

const lines = [];
const listeners = new Set();

// A line, with the seconds since the page loaded so the shape of a
// slow boot is visible in the transcript.
export function log(message) {
  const at = (performance.now() / 1000).toFixed(1).padStart(6);
  lines.push(`${at}s  ${message}`);
  if (lines.length > LIMIT) {
    lines.shift();
  }
  for (const listener of listeners) {
    listener(lines);
  }
}

export function onLog(listener) {
  listeners.add(listener);
  listener(lines);
}

export const logLines = () => lines.join("\n");
