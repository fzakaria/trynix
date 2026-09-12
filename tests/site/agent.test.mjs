// The driver an agent reaches the guest through. Everything here is the
// part that can be wrong without a browser saying so: a command whose
// own echo is mistaken for its completion, a status read off a line the
// guest has not finished printing, output that still carries the
// command that produced it. Each test drives the real driver against a
// fake pty whose transcript grows the way a line discipline makes it
// grow: the echo first, then what the guest said.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  completion,
  guestDriver,
  outputOf,
  wrapCommand,
} from "../../site/js/agent.js";

const MARKER = "TRYNIX_7f3a";

// A pty that behaves the way the guest's does. It echoes what was
// typed, wrapped at the terminal's width, which is what broke the first
// version of this. Then it prints the opening fence, `reply`, and the
// closing fence with `status`. A `reply` of null makes a guest that
// never answers, which is what a timeout has to survive.
const COLUMNS = 80;

function fakeGuest({ reply = "", status = 0 } = {}) {
  let transcript = "";
  const wrapped = (line) =>
    line.replace(new RegExp(`(.{${COLUMNS}})`, "g"), "$1\r\r\n");

  return {
    send(data) {
      transcript += wrapped(data.replace(/\n$/, "")) + "\r\r\n";
      if (reply === null) {
        return;
      }
      const [, prefix, id] = data.match(/'([A-Z_]+)' '(\w+)'/);
      const marker = `${prefix}${id}`;
      transcript +=
        `\r\r\n${marker}:go\r\r\n` +
        `${reply}\r\r\n` +
        `\r\r\n${marker}:${status}\r\r\n~ # `;
    },
    transcript: () => transcript,
  };
}

test("wrapCommand prints the marker in halves, so the echo cannot end the run", () => {
  const wrapped = wrapCommand("echo hi", MARKER);

  // The echoed line reaches the transcript as typed. If either fence
  // appeared in it whole, the run would look finished the instant it
  // was typed and the output would always be empty.
  assert.equal(wrapped.includes(`${MARKER}:`), false);
  assert.equal(wrapped.includes("echo hi"), true);
});

test("wrapCommand survives a command carrying single quotes", () => {
  const wrapped = wrapCommand("echo 'it worked'", MARKER);

  // sh has one way to put a quote inside a quoted string: close it,
  // escape one, reopen. Without this the command's own quote closes
  // the wrapper's and sh sees two commands.
  assert.equal(wrapped.includes(`'\\''it worked'\\''`), true);
});

test("completion reads the status only once the closing line is whole", () => {
  // Printed, but the newline has not arrived: a two-digit status could
  // still be on its way, and answering now reports the wrong one.
  assert.equal(completion(`hi\r\n${MARKER}:1`, MARKER), null);
  assert.equal(completion(`hi\r\n${MARKER}:1\r\n`, MARKER), 1);
  assert.equal(completion(`hi\n${MARKER}:0\n`, MARKER), 0);
  assert.equal(completion("hi\r\n", MARKER), null);
  // The opening fence is not a status and must not be read as one.
  assert.equal(completion(`${MARKER}:go\r\n`, MARKER), null);
});

test("completion ignores a marker that is not at the start of a line", () => {
  // The command's own output can name the marker; only the line the
  // wrapper printed counts.
  assert.equal(completion(`saw ${MARKER}:0\r\n`, MARKER), null);
});

test("outputOf keeps only what lies between the two fences", () => {
  const said =
    `${wrapCommand("echo hi", MARKER)}\r\r\n` +
    `\r\r\n${MARKER}:go\r\r\nhi\r\r\n\r\r\n${MARKER}:0\r\r\n~ # `;

  assert.equal(outputOf(said, MARKER), "hi");
});

test("outputOf normalises the console's line endings", () => {
  // A serial console carries CR LF and the pty adds a CR of its own, so
  // every line arrives ending "\r\r\n". A caller reading text wants none
  // of that.
  const said = `\r\r\n${MARKER}:go\r\r\none\r\r\ntwo\r\r\n\r\r\n${MARKER}:0\r\r\n`;

  assert.equal(outputOf(said, MARKER), "one\ntwo");
});

test("outputOf is not fooled by output that names the fences", () => {
  // The command printed something shaped exactly like a closing line.
  // The run's own fence is the last one, and everything before it is
  // the command's.
  const said =
    `\r\r\n${MARKER}:go\r\r\n${MARKER}:0\r\r\nreal\r\r\n` +
    `\r\r\n${MARKER}:0\r\r\n`;

  assert.equal(outputOf(said, MARKER), `${MARKER}:0\nreal`);
});

test("run types the command and answers with the guest's status and output", async () => {
  const guest = fakeGuest({ reply: "hello", status: 0 });
  const driver = guestDriver(guest);

  const result = await driver.run("echo hello");

  assert.equal(result.status, 0);
  assert.equal(result.output, "hello");
  assert.equal(result.timedOut, false);
});

test("run reports a failing command's status rather than throwing", async () => {
  const guest = fakeGuest({ reply: "sh: no such file", status: 127 });
  const driver = guestDriver(guest);

  const result = await driver.run("nope");

  assert.equal(result.status, 127);
  assert.equal(result.output, "sh: no such file");
});

test("run gives up on a guest that never answers, and says what it saw", async () => {
  const guest = fakeGuest({ reply: null });
  const driver = guestDriver(guest);

  const result = await driver.run("sleep 9999", { timeoutMs: 150 });

  assert.equal(result.timedOut, true);
  assert.equal(result.status, null);
  // The transcript so far is worth more than nothing: a guest that died
  // mid-command usually said why before it stopped.
  assert.equal(typeof result.output, "string");
});

test("a wrapped echo does not swallow the output", async () => {
  // The line discipline breaks the echoed command at the terminal's
  // width, so the text in the transcript is not the text that was sent.
  // Anchoring the output on the echo rather than on the guest's own
  // fence returned the whole transcript here.
  const guest = fakeGuest({ reply: "short" });
  const long = `echo ${"x".repeat(200)}`;

  const result = await guestDriver(guest).run(long);

  assert.equal(result.output, "short");
});

test("two runs do not see each other's marker", async () => {
  const guest = fakeGuest({ reply: "one" });
  const driver = guestDriver(guest);

  const first = await driver.run("echo one");
  const second = await driver.run("echo one");

  // A fixed marker would make the second run finish on the first run's
  // line, which is still sitting in the transcript.
  assert.equal(first.output, "one");
  assert.equal(second.output, "one");
});

test("run finds its marker after the transcript has dropped its oldest bytes", async () => {
  // The console transcript is capped and slides. An offset taken before
  // the command was typed stops meaning anything the moment it does, so
  // the run anchors on its own marker instead.
  const guest = fakeGuest({ reply: "late" });
  const capped = {
    send: guest.send,
    transcript: () => guest.transcript().slice(-32),
  };

  const result = await guestDriver(capped).run("echo late");

  assert.equal(result.status, 0);
  assert.equal(result.timedOut, false);
});

test("type reaches the pty verbatim, control characters included", () => {
  // Nothing is wrapped and nothing is fenced: an interrupt is one byte,
  // and a caller sending it wants exactly that byte to arrive.
  const sent = [];
  const driver = guestDriver({
    send: (d) => sent.push(d),
    transcript: () => "",
  });

  driver.type("\x03");

  assert.deepEqual(sent, ["\x03"]);
});
