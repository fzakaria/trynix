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

// The last message, how many times in a row it came, and when it first
// did. A message the same as the one before it is counted on that
// one's line rather than given its own: a guest retrying a host its
// relay refuses logs the same line several times a second, and in a
// page nested inside another trynix guest that once filled all LIMIT
// lines and pushed out everything that said what had gone before.
let last = null;

// A line, with the seconds since the page loaded so the shape of a
// slow boot is visible in the transcript.
export function log(message) {
  const at = (performance.now() / 1000).toFixed(1).padStart(6);

  // The same message again: the last line counts it.
  if (last !== null && last.message === message) {
    last.count += 1;
    lines[lines.length - 1] =
      `${at}s  ${message} (${last.count} times since ${last.at}s)`;
    tell();
    return;
  }

  last = { message, count: 1, at: at.trim() };
  lines.push(`${at}s  ${message}`);
  if (lines.length > LIMIT) {
    lines.shift();
  }
  tell();
}

// Hand the lines to everyone listening.
function tell() {
  for (const listener of listeners) {
    listener(lines);
  }
}

export function onLog(listener) {
  listeners.add(listener);
  listener(lines);
}

export const logLines = () => lines.join("\n");

// Uncaught errors and rejected promises go in the log too. They were
// what the first field reports lacked: a reader saw a red row and a
// message, and the exception behind it went to a console nobody opened.
//
// The tests import this module under node, where there is no window.
if (typeof window !== "undefined") {
  window.addEventListener("error", (event) => {
    log(`uncaught: ${event.message} (${event.filename}:${event.lineno})`);
  });
  window.addEventListener("unhandledrejection", (event) => {
    const reason = event.reason;
    log(`unhandled: ${reason?.stack ?? reason?.message ?? String(reason)}`);
  });
}
