// A log the page keeps about its own boot.
//
// Almost everything interesting here happens inside a fetch, a wasm
// module or a guest, and when one of them fails the reader is left
// with a red row and a browser message like "TypeError: Failed to
// fetch" — true, and useless on its own. These lines say which URL,
// which attempt, and what came before.

const LIMIT = 500;

// How many of the last lines a message may repeat to be counted
// instead of taking a line, and so the most different messages one run
// counts. A guest GL context the renderer has given up on logs the
// renderer's refusal and the kernel's failed submit in turn, several
// times a second, and a third message once a second among them.
// Counting only a message the same as the one before it never merged
// them: they filled all LIMIT lines in seconds and pushed out the first
// lines of the burst, which say why. Counting only a pair that
// alternates still gave the three of them three new lines a second.
const RUN_LIMIT = 4;

const lines = [];
const listeners = new Set();

// The messages of the last RUN_LIMIT lines, newest last, each with the
// time its line was given. A message the same as one of them starts a
// run of that message and those after it.
let recent = [];

// The run being counted, or null: its messages, how many times any of
// them has come since the run began, when it began, and the log's last
// line as it was then, which the count is put after.
//
// A run is counted rather than given lines: a guest retrying a host
// its relay refuses logs the same line several times a second, and in
// a page nested inside another trynix guest that once filled all
// LIMIT lines and pushed out everything that said what had gone
// before. Its messages are counted in whatever order they come, so a
// message that joins a flood now and then is counted with it once it
// has had one line.
let run = null;

// A line, with the seconds since the page loaded so the shape of a
// slow boot is visible in the transcript.
export function log(message) {
  const at = (performance.now() / 1000).toFixed(1).padStart(6);

  // A message of the run: counted on the run's last line.
  if (run !== null && run.messages.has(message)) {
    count();
    return;
  }

  // Any other message ends the run. The run's messages stay in
  // `recent`, so when the run's messages come back after this one, it
  // and they start one run together.
  run = null;

  // The same as the message of one of the last RUN_LIMIT lines: that
  // line and those after it start a run, and this message is the
  // run's first.
  const index = recent.findIndex((entry) => entry.message === message);
  if (index >= 0) {
    const start = recent.slice(index);
    run = {
      messages: new Set(start.map((entry) => entry.message)),
      count: 0,
      at: index === recent.length - 1 ? start[0].at : at.trim(),
      line: lines[lines.length - 1],
    };
    count();
    return;
  }

  // Any other message takes a line of its own.
  add(message, at);
}

// Count one more message of the run, and say on the log's last line,
// which is the run's last, how many have come and since when. One
// message repeated says how many times it came in all, its first line
// included.
function count() {
  run.count += 1;

  const said =
    run.messages.size === 1
      ? `${run.count + 1} times since ${run.at}s`
      : `${run.count} more of these ${run.messages.size} lines since ${run.at}s`;
  lines[lines.length - 1] = `${run.line} (${said})`;
  tell();
}

// Give `message`, which came at `at`, a line of its own.
function add(message, at) {
  recent.push({ message, at: at.trim() });
  if (recent.length > RUN_LIMIT) {
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
