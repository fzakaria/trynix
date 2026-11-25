// Tests the Try links in index.html. A link that fetches files (file=;
// site/js/files.js) has a command that names each file by the store
// path fetchurl gives it, a path the link's author works out by hand from
// the file's name and hash, so a hash or a path copied wrong leaves a
// command that names a file the guest does not have. And the Try line's
// "more" says how many links it holds, a number written by hand too.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { fileInfo, fileOf } from "../../site/js/files.js";

// The page's markup, as the tests below read it.
function pageHtml() {
  return readFileSync(
    new URL("../../site/index.html", import.meta.url),
    "utf8",
  );
}

// The query string of every link on the page that starts with one.
function pageLinks() {
  return [...pageHtml().matchAll(/href="\?([^"]*)"/g)].map(
    (match) => new URLSearchParams(match[1].replaceAll("&amp;", "&")),
  );
}

// The Try line's markup: what the <div> the examples sit in holds. The
// line holds no <div> of its own, so the first </div> closes it.
function tryLine() {
  const line = pageHtml().match(/<div class="examples[^"]*">([\s\S]*?)<\/div>/);
  assert.notEqual(line, null, "no Try line in index.html");
  return line[1];
}

// Reads the Try line's <details> from the page's markup and checks that
// the number its summary names is the number of links inside it, so a
// link added behind "more" cannot leave the summary short.
test("the Try line's summary counts the links behind it", () => {
  const details = tryLine().match(
    /<details>\s*<summary>([^<]*)<\/summary>([\s\S]*?)<\/details>/,
  );
  assert.notEqual(details, null, "no <details> in the Try line");

  const [, summary, hidden] = details;
  const named = summary.match(/^(\d+) more$/);
  assert.notEqual(named, null, `the summary names no count: ${summary}`);
  const links = [...hidden.matchAll(/<a\b/g)].length;
  assert.equal(Number(named[1]), links);
});

// Reads each link's files and command from the page's markup and checks
// that every file= is a URL and a hash, and that the command names the
// store path the file arrives at.
test("a Try link's command names the store path of each file it fetches", async () => {
  const withFiles = pageLinks().filter((params) => params.has("file"));
  assert.notEqual(withFiles.length, 0);

  for (const params of withFiles) {
    const run = params.get("run") ?? "";
    for (const value of params.getAll("file")) {
      const file = fileOf(value);
      assert.notEqual(file, null, `not a URL and a hash: ${value}`);
      const { storePath } = await fileInfo(file);
      assert.ok(
        run.includes(storePath),
        `${file.url}: the command does not name ${storePath}: ${run}`,
      );
    }
  }
});
