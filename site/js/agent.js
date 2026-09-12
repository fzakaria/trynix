// Driving the guest from code rather than from a keyboard.
//
// The terminal is drawn on a canvas by ghostty, so nothing the guest
// prints reaches the DOM. Neither the benchmark harnesses in tools/,
// which drive the page over CDP, nor an agent calling the WebMCP tools
// (webmcp.js) can read the console by looking at the page. This module
// is what they call instead. It owns the thing all of them want and
// none of them should write twice: type a command, know when it
// finished, and hand back what it said.
//
// Framing the output is the whole difficulty. A serial console is a
// stream with nothing in it that says where anything begins: the
// prompt is whatever the shell decided to print, the output can
// contain anything at all, and the line discipline echoes the command
// itself back into the stream before the guest has run a byte of it.
//
// So each run has the guest print a line before the command and
// another after it, and the output is what lies between them. Both
// lines come from the guest rather than from the echo, which matters
// for two reasons the first attempt at this got wrong:
//
//   the echo wraps. The line discipline breaks the echoed command at
//   the terminal's width, so the text that arrives is not the text
//   that was sent and cannot be searched for;
//
//   the guest's own output can name the marker. Anchoring on a line
//   the command itself could print ends the run early, which is why
//   the marker carries a random suffix and the terminal never sees it
//   whole. printf assembles it from two arguments, so the echoed line
//   carries the halves with a quote between them.

// Every run's marker starts here and ends in an id of its own, so no
// two runs and nothing a command prints can be mistaken for each
// other. The split for printf is at the last underscore, so the id
// must not contain one.
const MARKER_PREFIX = "TRYNIX_";

// Enough of a random tail that a command cannot name the marker by
// accident, short enough to leave the line well inside 80 columns.
const ID_LENGTH = 8;

// How often the transcript is re-read while a command runs, and how
// long a command is given before the caller is told it is still going.
const POLL_MS = 50;
export const RUN_TIMEOUT_MS = 120000;

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// What the guest prints before the command runs, and after it. The
// closing line carries the status and is matched only once it is
// finished: reading a line that is still arriving turns a status of
// "127" into "1".
const startLine = (marker) =>
  new RegExp(`(?:^|\\n)${escapeRegExp(marker)}:go\\r*\\n`);
const endLine = (marker) =>
  new RegExp(`(?:^|\\n)${escapeRegExp(marker)}:(\\d+)\\r*\\n`, "g");

// The last match, or null. The guest can print anything, so the run's
// own line is the final one rather than the first.
function lastMatch(said, pattern) {
  let last = null;
  for (const match of said.matchAll(pattern)) {
    last = match;
  }
  return last;
}

// One command, fenced so both its edges are unambiguous.
//
// The command goes to `sh -c` as a single quoted argument, so a
// pipeline or a quote of its own reaches the guest intact. The two
// printfs assemble the marker from separate arguments rather than
// writing it out, so the echo of this line carries `'TRYNIX_' 'a3f9'`,
// a quote and a space between the halves, and matches neither fence.
export function wrapCommand(command, marker) {
  const at = marker.lastIndexOf("_");
  const prefix = marker.slice(0, at + 1);
  const suffix = marker.slice(at + 1);
  const quoted = `'${command.replace(/'/g, `'\\''`)}'`;
  return [
    `printf '\\n%s%s:go\\n' '${prefix}' '${suffix}'`,
    `sh -c ${quoted}`,
    `printf '\\n%s%s:%s\\n' '${prefix}' '${suffix}' $?`,
  ].join("; ");
}

// The exit status, once the guest has printed the whole closing line;
// null while it has not.
export function completion(said, marker) {
  const match = lastMatch(said, endLine(marker));
  return match === null ? null : Number(match[1]);
}

// What the command actually said: everything between the two fences.
//
// Both are the guest's own output, so neither is subject to the wrap
// the line discipline puts in the echo, and nothing the page sent can
// land inside them. The Ctrl-L that redraws the prompt after a resume
// is the one that used to.
//
// Line endings are normalised. A serial console carries CR LF, and the
// pty adds a CR of its own, so every line arrives ending "\r\r\n"; a
// caller reading this as text wants none of that. A lone CR is left
// alone, since a program drawing a progress line in place means it.
export function outputOf(said, marker) {
  const end = lastMatch(said, endLine(marker));
  const body = end === null ? said : said.slice(0, end.index);

  const start = startLine(marker).exec(body);
  const after =
    start === null ? body : body.slice(start.index + start[0].length);

  return after.replace(/\r+\n/g, "\n").trim();
}

// A handle on one running guest.
//
// `send` writes to the pty the way a keystroke arrives; `transcript`
// returns everything the guest has said that the console still holds.
// boot.js supplies both.
export function guestDriver({ send, transcript }) {
  let runs = 0;

  // A counter so two runs in one page can never collide, and a random
  // tail so nothing a command prints can pass for either fence.
  const nextMarker = () => {
    runs += 1;
    const tail = Math.random()
      .toString(36)
      .slice(2, 2 + ID_LENGTH);
    return `${MARKER_PREFIX}${runs}${tail}`;
  };

  return {
    // Straight to the line discipline, nothing wrapped and nothing
    // waited for: this is how a control character or a partial line is
    // delivered.
    type(text) {
      send(text);
    },

    // Everything the guest has said, or the tail of it from `at`.
    transcript(at = 0) {
      return transcript().slice(at);
    },

    // Type a command and wait for it to finish.
    //
    // Resolves either way. A command that failed is an answer with a
    // non-zero status, and a command still running when the timeout
    // expires is an answer with whatever it had printed by then.
    // Neither is an exception, because both are things the caller
    // wants to read rather than catch.
    async run(command, { timeoutMs = RUN_TIMEOUT_MS } = {}) {
      const marker = nextMarker();
      send(`${wrapCommand(command, marker)}\n`);

      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const said = transcript();
        const status = completion(said, marker);
        if (status !== null) {
          return { status, output: outputOf(said, marker), timedOut: false };
        }
        if (Date.now() >= deadline) {
          return {
            status: null,
            output: outputOf(said, marker),
            timedOut: true,
          };
        }
        await pause(POLL_MS);
      }
    },
  };
}
