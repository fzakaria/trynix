// Tests the scanner that finds the guest shell's prompt marks in its
// console output (site/js/prompt.js). Each test feeds bytes the way
// the console delivers them, sometimes split at awkward places, and
// checks what is passed on to the terminal and which marks were read.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  lineCounter,
  promptMark,
  promptScanner,
} from "../../site/js/prompt.js";

const encode = (text) => new TextEncoder().encode(text);
const decode = (bytes) => new TextDecoder().decode(bytes);

// Feed pieces in order and collect the clean text and the marks.
function scan(...pieces) {
  const scanner = promptScanner();
  let text = "";
  const marks = [];
  for (const piece of pieces) {
    const out = scanner.feed(encode(piece));
    text += decode(out.bytes);
    marks.push(...out.marks);
  }
  return { text, marks };
}

// Checks that a mark in the middle of output is removed from what the
// terminal gets and read into its status, history number and command.
test("a mark is removed and read", () => {
  const { text, marks } = scan(
    `ls\r\nfile\r\n${promptMark(0, "   12  ls")}base ~ # `,
  );
  assert.equal(text, "ls\r\nfile\r\nbase ~ # ");
  assert.deepEqual(marks, [
    { status: 0, number: 12, command: "ls", at: text.length - 9 },
  ]);
});

// Checks that a mark split across two console reads, even inside its
// opening sequence, is still found whole.
test("a mark split across reads is found", () => {
  const mark = promptMark(1, "    3  false");
  for (let cut = 1; cut < mark.length; cut++) {
    const { text, marks } = scan(
      `x${mark.slice(0, cut)}`,
      `${mark.slice(cut)}$ `,
    );
    assert.equal(text, "x$ ", `cut at ${cut}`);
    assert.equal(marks.length, 1, `cut at ${cut}`);
    assert.equal(marks[0].command, "false");
  }
});

// Checks that an escape sequence that only starts like a mark is
// passed through untouched, including one that ends a read.
test("other escape sequences pass through", () => {
  const title = "\x1b]0;title\x07";
  assert.equal(scan(`a${title}b`).text, `a${title}b`);
  assert.equal(scan("a\x1b]", "0;t\x07").text, "a\x1b]0;t\x07");
  assert.equal(scan("a\x1b[6n").text, "a\x1b[6n");
});

// Checks the first prompt, before any command is in the history, and
// a command line with spaces and UTF-8 in it.
test("an empty history and a long command are read", () => {
  assert.deepEqual(scan(promptMark(0, "")).marks[0], {
    status: 0,
    number: null,
    command: "",
    at: 0,
  });
  const { marks } = scan(promptMark(127, "  200  echo 'héllo  wörld' | wc"));
  assert.equal(marks[0].command, "echo 'héllo  wörld' | wc");
  assert.equal(marks[0].status, 127);
  assert.equal(marks[0].number, 200);
});

// Checks that a mark that never ends does not swallow the session:
// past a limit the held bytes are passed on as they are.
test("an unterminated mark is given up on", () => {
  const scanner = promptScanner();
  const start = decode(scanner.feed(encode("\x1b]7701;0;")).bytes);
  const rest = decode(scanner.feed(encode("y".repeat(10000))).bytes);
  assert.equal(start + rest, `\x1b]7701;0;${"y".repeat(10000)}`);
});

// Checks how lines typed at the shell are counted, which is how a
// command run twice is told from an empty line: busybox leaves a repeat
// out of the history. Keys then Enter is a line; Enter alone, the
// terminal's cursor report, and a line cancelled with Ctrl-C are not.
test("typed lines are counted, empty and cancelled ones are not", () => {
  const lines = lineCounter();
  lines.typed("ls /\r");
  assert.equal(lines.take(), 1);
  assert.equal(lines.take(), 0);

  lines.typed("\r");
  lines.typed("\x1b[24;9R");
  lines.typed("\r");
  lines.typed("echo no\x03");
  lines.typed("\r");
  assert.equal(lines.take(), 0);

  // The up arrow recalls a line; Enter runs it.
  lines.typed("\x1b[A");
  lines.typed("\r");
  assert.equal(lines.take(), 1);

  lines.typed("half");
  lines.reset();
  lines.typed("\r");
  assert.equal(lines.take(), 0);
});
