// Tests which of the site's GL drivers the page links into the guest
// (site/js/gldriver.js), and when it tells the reader that the driver
// is too new for the selection. Every guest gets a driver; it is loaded
// into a program's process, so it works only for a program whose glibc
// and libstdc++ are no older than the driver's. These tests hand the
// chooser closures as lists of store basenames, the way the closure
// walk produces them, and the drivers the site publishes as the records
// its manifest holds. Reading the manifest runs against a fake fetch.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  chooseDriver,
  DriverChoice,
  driverNote,
  drawsWithGl,
  publishedDrivers,
} from "../../site/js/gldriver.js";
import {
  holdsPath,
  readSubstituters,
  SITE_CACHE_URL,
} from "../../site/js/substituters.js";

const DIGEST = "0123456789abcdfghijklmnpqrsvwxyz";
const path = (name) => `${DIGEST}-${name}`;

// A GL program's closure: a Wayland client linking libglvnd, with the
// glibc and gcc runtime of the nixpkgs it came from.
const glProgram = (glibc, gcc) => [
  path("es2gears-9.0.0"),
  path("wayland-1.24.0"),
  path("libglvnd-1.7.0"),
  path(`glibc-${glibc}`),
  path(`gcc-${gcc}-lib`),
];

// The selected root of glProgram's closure.
const GL_ROOTS = [path("es2gears-9.0.0")];

// Two published drivers: one built on an older nixpkgs, one on a newer.
const OLD = {
  storePath: `/nix/store/${path("mesa-virgl-24.2.8")}`,
  glibc: "2.39",
  gcc: "13.3.0",
};
const NEW = {
  storePath: `/nix/store/${path("mesa-virgl-26.2.2")}`,
  glibc: "2.42",
  gcc: "15.3.0",
};
const DRIVERS = [OLD, NEW];

// Checks that a program as new as the newest driver gets that driver,
// with nothing to say.
test("a program from the driver's own nixpkgs gets it", () => {
  const result = chooseDriver(glProgram("2.42-84", "15.3.0"), DRIVERS);
  assert.equal(result.choice, DriverChoice.FITS);
  assert.equal(result.driver, NEW);
  assert.equal(
    driverNote(result, glProgram("2.42-84", "15.3.0"), GL_ROOTS),
    null,
  );
});

// Checks that a selection with no GL program gets the driver all the
// same, since the guest links one at every boot, and that no note is
// given for it even when the driver is newer than its glibc: xterm
// draws no GL.
test("a selection that draws no GL gets the driver and no note", () => {
  const xterm = [path("xterm-412"), path("libx11-1.8.14"), path("glibc-2.42")];
  const result = chooseDriver(xterm, DRIVERS);
  assert.equal(result.choice, DriverChoice.FITS);
  assert.equal(result.driver, NEW);

  const oldXterm = [path("xterm-330"), path("glibc-2.27")];
  const old = chooseDriver(oldXterm, DRIVERS);
  assert.equal(old.choice, DriverChoice.NONE_FITS);
  assert.equal(driverNote(old, oldXterm, [path("xterm-330")]), null);
});

// Checks that a program older than the newest driver's glibc gets the
// newest driver it can load, and that version 2.40 sorts above 2.39 and
// below 2.42 (a string comparison would not).
test("a program older than a driver's glibc gets an older driver", () => {
  const result = chooseDriver(glProgram("2.40-66", "14.2.1"), DRIVERS);
  assert.equal(result.choice, DriverChoice.FITS);
  assert.equal(result.driver, OLD);
});

// Checks that a program older than every driver still gets the newest,
// which it fails to load the way it would fail with none, and that the
// page says why.
test("a program older than every driver gets the newest, and a note", () => {
  const closure = glProgram("2.37-45", "12.3.0");
  const result = chooseDriver(closure, DRIVERS);
  assert.equal(result.choice, DriverChoice.NONE_FITS);
  assert.equal(result.driver, NEW);
  assert.match(driverNote(result, closure, GL_ROOTS), /glibc 2\.37/);
});

// Checks the libstdc++ side: a program whose closure carries an older
// gcc runtime than the driver was built with may have loaded that older
// libstdc++ first, so the driver does not fit even when glibc does.
test("a program with an older gcc runtime does not fit a newer driver", () => {
  const result = chooseDriver(glProgram("2.42-84", "14.2.1"), [NEW]);
  assert.equal(result.choice, DriverChoice.NONE_FITS);
});

// Checks that a program with no gcc runtime in its closure is judged by
// glibc alone: the driver then brings its own libstdc++.
test("a program with no gcc runtime is judged by glibc alone", () => {
  const closure = glProgram("2.42-84", "15.3.0").filter(
    (b) => !b.includes("gcc"),
  );
  assert.equal(chooseDriver(closure, [NEW]).choice, DriverChoice.FITS);
});

// Checks that a Mesa in a program's closure is not a Mesa the reader
// selected. mesa-demos 8.5.0's closure holds mesa-22.3.7-drivers and
// mesa-22.3.7-osmesa; taking them for a selected Mesa silenced the
// note, and the page downloaded 148.7 MB of them with the selection. A
// Mesa among the selected roots is the reader's opt-out and silences
// the note.
test("a Mesa only in a program's closure is not a selected Mesa", () => {
  const demos = [
    path("mesa-demos-8.5.0"),
    path("wayland-1.21.0"),
    path("libglvnd-1.6.0"),
    path("mesa-22.3.7-drivers"),
    path("mesa-22.3.7-osmesa"),
    path("glibc-2.35-224"),
    path("gcc-12.2.0-lib"),
  ];
  const result = chooseDriver(demos, DRIVERS);
  assert.equal(result.choice, DriverChoice.NONE_FITS);
  assert.equal(result.driver, NEW);
  assert.match(
    driverNote(result, demos, [path("mesa-demos-8.5.0")]),
    /glibc 2\.35/,
  );

  const selected = [path("mesa-demos-8.5.0"), path("mesa-22.3.7-drivers")];
  assert.equal(driverNote(result, demos, selected), null);
});

// Checks a site that publishes no driver: nothing is linked, and a
// selection that draws with GL is told to select a Mesa.
test("a site with no driver links none, and says so", () => {
  const closure = glProgram("2.42-84", "15.3.0");
  const unpublished = chooseDriver(closure, []);
  assert.equal(unpublished.choice, DriverChoice.NONE_PUBLISHED);
  assert.equal(unpublished.driver, null);
  assert.match(driverNote(unpublished, closure, GL_ROOTS), /mesa/);
});

// Checks a GL program added to a guest that already has the site's
// driver: the driver is held to the program's glibc and gcc as at a
// fresh boot. An added program older than the driver gets the note a
// fresh boot gives, and a closure the driver fits gets none.
test("the site's driver in a running guest is checked against added programs", () => {
  const booted = glProgram("2.42-84", "15.3.0");
  const withOld = [...booted, path("glibc-2.37-45")];

  const added = chooseDriver(withOld, [NEW]);
  assert.equal(added.choice, DriverChoice.NONE_FITS);
  assert.match(driverNote(added, withOld, GL_ROOTS), /glibc 2\.37/);

  const kept = chooseDriver(booted, [NEW]);
  assert.equal(kept.choice, DriverChoice.FITS);
  assert.equal(kept.driver, NEW);
});

// Checks a selection that mixes nixpkgs revisions: the closure then
// holds two glibcs, and a driver must fit the older one, since any of
// the programs may be the one that loads it.
test("a closure with two glibcs is judged by the older", () => {
  const mixed = [...glProgram("2.42-84", "15.3.0"), path("glibc-2.40-66")];
  const result = chooseDriver(mixed, DRIVERS);
  assert.equal(result.choice, DriverChoice.FITS);
  assert.equal(result.driver, OLD);
});

// Checks a driver that links no libstdc++, whose manifest names no gcc:
// any gcc runtime the program has is fine.
test("a driver with no gcc floor is judged by glibc alone", () => {
  const plain = { ...NEW, gcc: null };
  const result = chooseDriver(glProgram("2.42-84", "9.3.0"), [plain]);
  assert.equal(result.choice, DriverChoice.FITS);
});

// Checks the hint that turns glamor on for the X server: a selection
// that links libglvnd may draw with GLX, which needs it, and xterm,
// which links no libglvnd, starts the X server without it.
test("a selection draws with GL when it links libglvnd", () => {
  assert.equal(drawsWithGl(glProgram("2.42-84", "15.3.0")), true);
  assert.equal(drawsWithGl([path("xterm-412"), path("libx11-1.8.14")]), false);
});

// Checks that reading the manifest tells the substituters which paths
// the site serves: afterwards a listed path is asked of the site and
// of nothing else.
test("the manifest's paths are asked of the site alone", async () => {
  const served = "y3ihj0ilpkn4ib3rh7y021l3nrvjii97";
  const driver = {
    storePath: `/nix/store/${served}-mesa-virgl-26.2.2`,
    glibc: "2.38",
    gcc: "11.1",
  };
  const asked = [];
  globalThis.caches = { open: () => Promise.resolve(null) };
  globalThis.fetch = async (url) => {
    asked.push(String(url));
    if (String(url).endsWith("drivers.json")) {
      return Response.json({ paths: [driver.storePath], drivers: [driver] });
    }
    return new Response("StorePath: x\n");
  };

  assert.deepEqual(await publishedDrivers(), [driver]);
  assert.equal(await holdsPath(served, readSubstituters()), true);

  assert.deepEqual(asked.slice(1), [`${SITE_CACHE_URL}/${served}.narinfo`]);
});
