// Tests how the engine travels in the page's link. readUrl and writeUrl
// read the global `location`, so each test stands one up with the query
// string under test.
import { test } from "node:test";
import assert from "node:assert/strict";

import { readUrl, whileRestoring, writeUrl } from "../../site/js/url.js";

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

// Checks that a link can ask for a CPU count, written after the memory
// and only when given.
test("the guest's CPU count travels in the link", () => {
  at("?pkg=firefox&mem=2048&cpus=4");
  assert.equal(readUrl().cpus, 4);

  at("?pkg=hello");
  assert.equal(readUrl().cpus, null);

  at("");
  const state = { pkgs: [{ attr: "firefox", version: null }], paths: [] };
  assert.equal(
    writeUrl(state, { memory: 2048, cpus: 4 }),
    "/?pkg=firefox&mem=2048&cpus=4",
  );
});

// Checks that a link can say when the closure downloads, and that a
// link that does not, or names something else, says so.
test("when the closure downloads is read from the link", () => {
  at("?pkg=aisleriot&fetch=all");
  assert.equal(readUrl().downloads, "all");

  at("?pkg=aisleriot&fetch=lazy");
  assert.equal(readUrl().downloads, "lazy");

  at("?pkg=aisleriot");
  assert.equal(readUrl().downloads, null);

  at("?pkg=aisleriot&fetch=some");
  assert.equal(readUrl().downloads, null);
});

// Checks that the choice is written only when the caller passes it,
// after the memory and the CPUs and ahead of boot=1.
test("when the closure downloads is written only when given", () => {
  at("");
  const state = { pkgs: [{ attr: "aisleriot", version: null }], paths: [] };
  assert.equal(writeUrl(state), "/?pkg=aisleriot");
  assert.equal(
    writeUrl(state, { memory: 2048, cpus: 4, downloads: "all", boot: true }),
    "/?pkg=aisleriot&mem=2048&cpus=4&fetch=all&boot=1",
  );
});

// Checks that a link's command to type at the shell is read decoded, as
// the reader would type it, and that a link naming none, or an empty
// one, says so.
test("the command to run is read from the link", () => {
  at("?pkg=aisleriot&engine=unkernel&run=sol+%26&boot=1");
  assert.equal(readUrl().run, "sol &");

  at("?pkg=hello&run=hello%0Ahello+--version");
  assert.equal(readUrl().run, "hello\nhello --version");

  at("?pkg=hello");
  assert.equal(readUrl().run, null);

  at("?pkg=hello&run=");
  assert.equal(readUrl().run, null);
});

// Checks that the command is written only when the caller passes one,
// encoded, after the other choices and ahead of boot=1.
test("the command to run is written only when given", () => {
  at("");
  const state = { pkgs: [{ attr: "aisleriot", version: null }], paths: [] };
  assert.equal(writeUrl(state), "/?pkg=aisleriot");
  assert.equal(
    writeUrl(state, { engine: "unkernel", run: "sol &", boot: true }),
    "/?pkg=aisleriot&engine=unkernel&run=sol+%26&boot=1",
  );
});

// Checks that a link can turn the guest's network on or off, that an
// unknown value is no choice, and that the choice is written only when
// given, after the downloads choice and ahead of the command.
test("the network choice travels in the link", () => {
  at("?pkg=curl&net=off");
  assert.equal(readUrl().network, "off");

  at("?pkg=curl&net=maybe");
  assert.equal(readUrl().network, null);

  at("");
  const state = { pkgs: [{ attr: "curl", version: null }], paths: [] };
  assert.equal(writeUrl(state), "/?pkg=curl");
  assert.equal(
    writeUrl(state, { downloads: "all", network: "off", run: "curl -I x" }),
    "/?pkg=curl&fetch=all&net=off&run=curl+-I+x",
  );
});

// Checks that a link can name the guest's Wisp relay and turn its sound
// off, that a relay that is not a ws: or wss: URL and a sound value
// that is not on or off are no choice, and that both are written only
// when given.
test("the relay and the sound travel in the link", () => {
  at("?pkg=curl&wisp=wss%3A%2F%2Frelay.example.org%2F&sound=off");
  assert.equal(readUrl().relay, "wss://relay.example.org/");
  assert.equal(readUrl().sound, "off");

  at("?pkg=curl&wisp=https%3A%2F%2Fexample.org%2F&sound=loud");
  assert.equal(readUrl().relay, null);
  assert.equal(readUrl().sound, null);

  at("");
  const state = { pkgs: [{ attr: "curl", version: null }], paths: [] };
  assert.equal(writeUrl(state), "/?pkg=curl");
  assert.equal(
    writeUrl(state, {
      network: "on",
      relay: "wss://relay.example.org/",
      sound: "off",
    }),
    "/?pkg=curl&net=on&wisp=wss%3A%2F%2Frelay.example.org%2F&sound=off",
  );
});

// The page's Try link for firefox, which a first visit lost to the
// service-worker shim's reload (tools/link-test.py), less the engine:
// the link names the default engine, which the address leaves out
// (app.js, linkEngine).
const TRY_LINK = "?pkg=firefox&mem=2048&run=firefox+%26&boot=1";

// Checks that the address keeps the link the page opened with while
// the selection is still empty: an empty selection, written through
// whileRestoring and writeUrl with the link's settings, gives back the
// link's packages, paths and boot flag.
test("the address keeps the opening link during the restore", () => {
  at(TRY_LINK);
  const opening = readUrl();
  const empty = { pkgs: [], paths: [], caches: [] };

  const shown = whileRestoring(empty, { boot: false, opening });
  assert.equal(
    writeUrl(shown.state, {
      boot: shown.boot,
      memory: opening.memory,
      run: opening.run,
    }),
    `/${TRY_LINK}`,
  );

  at(`?path=${encodeURIComponent(STORE_PATH)}`);
  const paths = whileRestoring(empty, { boot: false, opening: readUrl() });
  assert.deepEqual(paths.state.paths, [STORE_PATH]);
  assert.equal(paths.boot, false);
});

// Checks that the caches and a boot the caller asks for still come
// from the page while the link is restored: a reboot's boot=1 stands
// whatever the link said, and a cache added meanwhile stays in.
test("the page's caches and boot stand while the link is restored", () => {
  at("?pkg=hello");
  const opening = readUrl();
  const cache = { url: "https://x.cachix.org", key: "x-1:key=" };
  const state = { pkgs: [], paths: [], caches: [cache] };

  const shown = whileRestoring(state, { boot: true, opening });
  assert.deepEqual(shown.state.caches, [cache]);
  assert.deepEqual(shown.state.pkgs, [{ attr: "hello", version: null }]);
  assert.equal(shown.boot, true);
});

// Checks that once the restore is done (no opening link) the address
// describes the selection alone, with the boot flag the caller asked
// for and nothing from the link.
test("the address describes the selection once the link is restored", () => {
  const state = {
    pkgs: [{ attr: "firefox", version: "130.0" }],
    paths: [],
    caches: [],
  };
  assert.deepEqual(whileRestoring(state, { boot: false, opening: null }), {
    state,
    boot: false,
  });
});
