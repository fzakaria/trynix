// Tests how the engine travels in the page's link. readUrl and writeUrl
// read the global `location`, so each test stands one up with the query
// string under test.
import { test } from "node:test";
import assert from "node:assert/strict";

import { readUrl, writeUrl } from "../../site/js/url.js";

function at(search) {
  globalThis.location = { search, pathname: "/" };
}

const STORE_PATH = "/nix/store/00000000000000000000000000000000-hello-2.12.3";

// Checks that the engine a link names is handed back as written, and
// that a link naming none says so.
test("the engine is read from the link", () => {
  at("?pkg=hello&engine=qemu");
  assert.equal(readUrl().engine, "qemu");

  at("?pkg=hello");
  assert.equal(readUrl().engine, null);
});

// Checks that a link carries the engine only when the caller passes
// one, so a link for the default engine stays as short as it was.
test("the engine is written only when one is given", () => {
  at("");
  const state = { pkgs: [{ attr: "hello", version: null }], paths: [] };
  assert.equal(writeUrl(state), "/?pkg=hello");
  assert.equal(writeUrl(state, { engine: "qemu" }), "/?pkg=hello&engine=qemu");
});

// Checks that the engine sits beside a store path and ahead of boot=1.
test("the engine is written beside a store path", () => {
  at("");
  const state = { pkgs: [], paths: [STORE_PATH] };
  assert.equal(
    writeUrl(state, { engine: "unkernel", boot: true }),
    `/?path=${encodeURIComponent(STORE_PATH)}&engine=unkernel&boot=1`,
  );
});

// Checks that a link can ask for the guest's memory, in MiB, and that
// a link that does not, or asks for something that is not a number,
// says so.
test("the guest's memory is read from the link", () => {
  at("?pkg=firefox&mem=2048");
  assert.equal(readUrl().memory, 2048);

  at("?pkg=hello");
  assert.equal(readUrl().memory, null);

  at("?pkg=hello&mem=lots");
  assert.equal(readUrl().memory, null);
});

// Checks that the memory is written only when the caller passes it,
// after the engine and ahead of boot=1.
test("the guest's memory is written only when one is given", () => {
  at("");
  const state = { pkgs: [{ attr: "firefox", version: null }], paths: [] };
  assert.equal(writeUrl(state), "/?pkg=firefox");
  assert.equal(
    writeUrl(state, { engine: "unkernel", memory: 2048, boot: true }),
    "/?pkg=firefox&engine=unkernel&mem=2048&boot=1",
  );
});
