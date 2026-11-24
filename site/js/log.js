// A log the page keeps about its own boot.
//
// Almost everything interesting here happens inside a fetch, a wasm
// module or a guest, and when one of them fails the reader is left
// with a red row and a browser message like "TypeError: Failed to
// fetch" — true, and useless on its own. These lines say which URL,
// which attempt, and what came before.

const LIMIT = 500;

// The most messages that repeat in turn and are counted as one run: a
// pair. A guest GL context the renderer has given up on logs the
// renderer's refusal and the kernel's failed submit in turn, several
// times a second, and counting only a message the same as the one
// before it never merged them: the pair filled all LIMIT lines in
// seconds and pushed out the first lines of the burst, which say why.
const PERIOD_LIMIT = 2;

const lines = [];
const listeners = new Set();

// The last messages that took a line of their own since the last run
// ended, newest last and at most PERIOD_LIMIT of them, each with the
// time it came. A message the same as one of them starts a run of
// that message and those after it.
let recent = [];

// The run being counted, or null: its messages in the order they
// repeat, the index of the one the next message has to be to go on
// with it, the times of the messages of the round under way (not yet
// on any line), how many times the whole run has come, and when its
// first message first came.
//
// A run is counted rather than given lines: a guest retrying a host
// its relay refuses logs the same line several times a second, and in
// a page nested inside another trynix guest that once filled all
// LIMIT lines and pushed out everything that said what had gone
// before.
let run = null;

// A line, with the seconds since the page loaded so the shape of a
// slow boot is visible in the transcript.
export function log(message) {
  const at = (performance.now() / 1000).toFixed(1).padStart(6);

  // The next message of the run: counted, and said on the run's last
  // line each time the whole run has come round again.
  if (run !== null && run.messages[run.next] === message) {
    advance(at);
    return;
  }

  // Any other message ends the run. The messages of the round under
  // way take the lines of their own they would have had.
  if (run !== null) {
    const { messages, pending } = run;
    run = null;
    recent = [];
    pending.forEach((time, index) => add(messages[index], time));
  }

  // The same as a message of the last PERIOD_LIMIT lines: those lines
  // start a run, and this message is its first repeat.
  const index = recent.findLastIndex((entry) => entry.message === message);
  if (index >= 0) {
    const start = recent.slice(index);
    run = {
      messages: start.map((entry) => entry.message),
      next: 0,
      pending: [],
      count: 1,
      at: start[0].at,
    };
    advance(at);
    return;
  }

  // Any other message takes a line of its own.
  add(message, at);
}

// Count one more message of the run, which came at `at`.
function advance(at) {
  run.pending.push(at);
  run.next = (run.next + 1) % run.messages.length;

  // A round is not over: nothing to say yet.
  if (run.next !== 0) {
    return;
  }

  // The round is over: the run's last line says how many times.
  run.count += 1;
  run.pending = [];
  const what =
    run.messages.length === 1 ? "" : `these ${run.messages.length} lines `;
  const last = run.messages[run.messages.length - 1];
  lines[lines.length - 1] =
    `${at}s  ${last} (${what}${run.count} times since ${run.at}s)`;
  tell();
}

// Give `message`, which came at `at`, a line of its own.
function add(message, at) {
  recent.push({ message, at: at.trim() });
  if (recent.length > PERIOD_LIMIT) {
    recent.shift();
  }

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
