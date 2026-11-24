// Tests when the page adds an X server to a selection (site/js/x11.js).
// A program that speaks only X11 needs one, and nixpkgs' GTK 3 and Qt
// programs carry libX11 beside libwayland without needing one, so
// the rule looks at each selected program's own closure. These tests
// hand the chooser closures the way the closure walk produces them: a
// map of digest to narinfo, each naming its store path and references.
import { test } from "node:test";
import assert from "node:assert/strict";

import { reachable } from "../../site/js/closure.js";
import {
  chooseX11Server,
  isX11Server,
  ShellStart,
  X11_SERVER_ATTR,
  X11Choice,
  x11Note,
} from "../../site/js/x11.js";

// A digest per name, from a hash of the name, so two packages in one
// closure do not share one.
const ALPHABET = "0123456789abcdfghijklmnpqrsvwxyz";
const DIGEST_LENGTH = 32;
function digestFor(name) {
  let hash = 0;
  let digest = "";
  for (let i = 0; i < DIGEST_LENGTH; i += 1) {
    hash = (hash * 31 + name.charCodeAt(i % name.length) + i) >>> 0;
    digest += ALPHABET[hash % ALPHABET.length];
  }
  return digest;
}
const basename = (name) => `${digestFor(name)}-${name}`;

// A closure as the walk returns it, from { name: [references] }.
function closureOf(graph) {
  return new Map(
    Object.entries(graph).map(([name, refs]) => [
      digestFor(name),
      {
        storePath: `/nix/store/${basename(name)}`,
        references: refs.map(basename),
      },
    ]),
  );
}

// An X11 program, a Wayland program that also carries libX11 (as
// nixpkgs' GTK 3 programs do), and what they share.
const GRAPH = {
  "xeyes-1.3.1": ["libx11-1.8.14", "glibc-2.44"],
  "galculator-2.1.4": ["gtk+3-3.24.52", "glibc-2.44"],
  "gtk+3-3.24.52": ["libx11-1.8.14", "wayland-1.26.0", "glibc-2.44"],
  "libx11-1.8.14": ["libxcb-1.17.0", "glibc-2.44"],
  "libxcb-1.17.0": ["glibc-2.44"],
  "wayland-1.26.0": ["glibc-2.44"],
  "glibc-2.44": [],
};

// Checks that the walk's reachability follows references from the
// given roots only: a Wayland program's closure holds GTK and libX11,
// and an X11 program's holds no libwayland.
test("reachable follows references from the roots alone", () => {
  const closure = closureOf(GRAPH);
  const names = (digests) =>
    [...reachable(closure, digests).values()].map((info) =>
      info.storePath.slice("/nix/store/".length + 33),
    );
  assert.deepEqual(names([digestFor("xeyes-1.3.1")]).sort(), [
    "glibc-2.44",
    "libx11-1.8.14",
    "libxcb-1.17.0",
    "xeyes-1.3.1",
  ]);
  assert.ok(names([digestFor("galculator-2.1.4")]).includes("wayland-1.26.0"));
});

// Checks that a selected program whose closure holds libX11 and no
// libwayland gets an X server, and names the program that needs it.
test("a program that speaks only X11 gets an X server", () => {
  const closure = closureOf(GRAPH);
  const result = chooseX11Server(closure, [digestFor("xeyes-1.3.1")]);
  assert.equal(result.choice, X11Choice.ADD);
  assert.deepEqual(result.programs, [basename("xeyes-1.3.1")]);
});

// Checks that a Wayland program carrying libX11 through its toolkit
// gets none, alone or beside a program with neither library.
test("a Wayland program with libX11 in its closure gets no X server", () => {
  const closure = closureOf({
    ...GRAPH,
    "hello-2.12.2": ["glibc-2.44"],
  });
  const result = chooseX11Server(closure, [
    digestFor("galculator-2.1.4"),
    digestFor("hello-2.12.2"),
  ]);
  assert.equal(result.choice, X11Choice.NOT_NEEDED);
});

// Checks that a selection mixing the two is judged per program: the
// X11 program's closure is its own, whatever its neighbour brings.
test("an X11 program beside a Wayland program still gets an X server", () => {
  const closure = closureOf(GRAPH);
  const result = chooseX11Server(closure, [
    digestFor("galculator-2.1.4"),
    digestFor("xeyes-1.3.1"),
  ]);
  assert.equal(result.choice, X11Choice.ADD);
  assert.deepEqual(result.programs, [basename("xeyes-1.3.1")]);
});

// Checks that a program that speaks X11 through XCB alone, with no
// libX11 in its closure, gets an X server: xlsatoms and xlsclients are
// two, and booted alone they found no display. A Wayland program whose
// closure holds libxcb, as Mesa's brings it, still gets none.
test("an XCB program without libX11 gets an X server", () => {
  const closure = closureOf({
    ...GRAPH,
    "xlsatoms-1.1.4": ["libxcb-1.17.0", "glibc-2.44"],
    "foot-1.25.0": ["wayland-1.26.0", "libxcb-1.17.0", "glibc-2.44"],
  });
  const result = chooseX11Server(closure, [
    digestFor("xlsatoms-1.1.4"),
    digestFor("foot-1.25.0"),
  ]);
  assert.equal(result.choice, X11Choice.ADD);
  assert.deepEqual(result.programs, [basename("xlsatoms-1.1.4")]);
});

// Checks that older nixpkgs' spelling of the library, xorg.libX11's
// libX11-1.6.x, counts as libX11.
test("libX11 is recognised under its older name", () => {
  const closure = closureOf({
    "xterm-327": ["libX11-1.6.5", "glibc-2.26"],
    "libX11-1.6.5": ["glibc-2.26"],
    "glibc-2.26": [],
  });
  const result = chooseX11Server(closure, [digestFor("xterm-327")]);
  assert.equal(result.choice, X11Choice.ADD);
});

// Checks that a closure already holding an X server, selected by the
// reader or added before, gets no second one, and that the chooser
// names the one there.
test("a closure with an X server gets no second one", () => {
  const closure = closureOf({
    ...GRAPH,
    "xwayland-satellite-0.8.3": ["wayland-1.26.0", "glibc-2.44"],
  });
  const result = chooseX11Server(closure, [digestFor("xeyes-1.3.1")]);
  assert.equal(result.choice, X11Choice.PRESENT);
  assert.equal(result.server, basename("xwayland-satellite-0.8.3"));
});

// Checks which store basenames are taken for the X server: the
// satellite, and not Xwayland itself, which needs a window manager the
// satellite provides.
test("xwayland-satellite is the X server, xwayland alone is not", () => {
  assert.equal(isX11Server(basename("xwayland-satellite-0.8.2")), true);
  assert.equal(isX11Server(basename("xwayland-24.1.13")), false);
  assert.equal(isX11Server(basename("xeyes-1.3.1")), false);
});

// Checks what the reader is told: nothing on a boot, whose shells all
// start with DISPLAY set, and how to reach the X server from the
// shell already running when an addition brought it.
test("only an X server added to a running guest gets a note", () => {
  const before = ShellStart.BEFORE_SERVER;
  const after = ShellStart.AFTER_SERVER;
  assert.equal(x11Note({ choice: X11Choice.NOT_NEEDED }, before), null);
  assert.equal(x11Note({ choice: X11Choice.ADD }, after), null);
  assert.equal(x11Note({ choice: X11Choice.PRESENT }, after), null);
  assert.match(x11Note({ choice: X11Choice.ADD }, before), /export DISPLAY=:0/);
  assert.match(
    x11Note({ choice: X11Choice.PRESENT }, before),
    /export DISPLAY=:0/,
  );
});

// Checks that the X server is looked up by the attribute the index
// knows it by, the one a reader would select.
test("the X server is the index's xwayland-satellite", () => {
  assert.equal(X11_SERVER_ATTR, "xwayland-satellite");
});

// Checks that a selection whose X server could not be found says so
// whenever the shell started, and names what to select instead.
test("an X server the index could not give is reported", () => {
  for (const shellStart of Object.values(ShellStart)) {
    assert.match(
      x11Note({ choice: X11Choice.UNAVAILABLE }, shellStart),
      /select xwayland-satellite/,
    );
  }
});
