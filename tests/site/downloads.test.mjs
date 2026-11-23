// Tests when the page downloads a closure (site/js/downloads.js): on
// first use or all before the shell starts, from the link, this
// browser's remembered choice, or the default, and always all on the
// qemu engine. pickDownloads is a pure function of what it is handed,
// so the tests pass in each source rather than a browser.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  Downloads,
  downloadsOf,
  pickDownloads,
} from "../../site/js/downloads.js";
import { Engine } from "../../site/js/engine.js";

// Checks the default: on first use, on the engine that can serve it.
test("the default is on first use", () => {
  const picked = pickDownloads({
    linked: null,
    remembered: null,
    engine: Engine.UNKERNEL,
  });
  assert.equal(picked.mode, Downloads.LAZY);
});

// Checks the precedence: the link wins, then this browser's choice,
// then the default.
test("the link wins, then the remembered choice, then the default", () => {
  const engine = Engine.UNKERNEL;
  assert.equal(
    pickDownloads({ linked: Downloads.ALL, remembered: Downloads.LAZY, engine })
      .mode,
    Downloads.ALL,
  );
  assert.equal(
    pickDownloads({ linked: Downloads.LAZY, remembered: Downloads.ALL, engine })
      .mode,
    Downloads.LAZY,
  );
  assert.equal(
    pickDownloads({ linked: null, remembered: Downloads.ALL, engine }).mode,
    Downloads.ALL,
  );
});

// Checks that the qemu engine downloads everything first whatever was
// asked: its share is read by QEMU's own 9p code, which cannot wait.
test("the qemu engine downloads everything first", () => {
  const picked = pickDownloads({
    linked: Downloads.LAZY,
    remembered: Downloads.LAZY,
    engine: Engine.QEMU,
  });
  assert.equal(picked.mode, Downloads.ALL);
  assert.match(picked.why, /x86_64/);
});

// Checks that only the two names a link writes are read as a choice.
test("a value that is not a choice is no choice", () => {
  assert.equal(downloadsOf("lazy"), Downloads.LAZY);
  assert.equal(downloadsOf("all"), Downloads.ALL);
  assert.equal(downloadsOf("some"), null);
  assert.equal(downloadsOf(null), null);
});
