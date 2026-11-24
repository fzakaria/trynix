// Tests the terminal's element in index.html, which ghostty-web makes
// contenteditable when it opens (site/js/terminal.js). ghostty-web turns
// off a phone keyboard's capitalization, autocorrection and spelling
// check on its hidden textarea alone, and a keyboard can open on the
// element instead (Firefox on Android), so the element turns them off
// itself, or that keyboard capitalizes the first letter of every line.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Each attribute, and the value that leaves a typed command as typed.
const EDITING_OFF = {
  autocapitalize: "off",
  autocorrect: "off",
  spellcheck: "false",
};

// Reads the opening tag of the element whose id is terminal from the
// page's markup and checks each attribute on it.
test("the terminal's element turns off the keyboard's editing", () => {
  const html = readFileSync(
    new URL("../../site/index.html", import.meta.url),
    "utf8",
  );
  const tag = html.match(/<div id="terminal"([^>]*)>/);
  assert.notEqual(tag, null);
  for (const [name, value] of Object.entries(EDITING_OFF)) {
    assert.match(tag[1], new RegExp(`\\b${name}="${value}"`));
  }
});
