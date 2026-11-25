// Tests the Try links in index.html that fetch files (file=;
// site/js/files.js). Such a link's command names each file by the store
// path fetchurl gives it, a path the link's author works out by hand from
// the file's name and hash, so a hash or a path copied wrong leaves a
// command that names a file the guest does not have.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { fileInfo, fileOf } from "../../site/js/files.js";

// The query string of every link on the page that starts with one.
function pageLinks() {
  const html = readFileSync(
    new URL("../../site/index.html", import.meta.url),
    "utf8",
  );
  return [...html.matchAll(/href="\?([^"]*)"/g)].map(
    (match) => new URLSearchParams(match[1].replaceAll("&amp;", "&")),
  );
}

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
