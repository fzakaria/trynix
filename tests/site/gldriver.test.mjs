// Tests which GL driver the page adds to a selection (site/js/gldriver.js).
// A driver is loaded into the program's process, so it may only be one
// built against a glibc and a libstdc++ no newer than the program's own;
// these tests hand the chooser closures as lists of store basenames,
// the way the closure walk produces them, and the drivers the site
// publishes as the records its manifest holds.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  chooseDriver,
  DriverChoice,
  driverNote,
} from "../../site/js/gldriver.js";

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

// Checks that a program as new as the newest driver gets that driver.
test("a program from the driver's own nixpkgs gets it", () => {
  const result = chooseDriver(glProgram("2.42-84", "15.3.0"), DRIVERS);
  assert.equal(result.choice, DriverChoice.ADD);
  assert.equal(result.driver, NEW);
});

// Checks that a program older than the newest driver's glibc gets the
// newest driver it can load, and that version 2.40 sorts above 2.39 and
// below 2.42 (a string comparison would not).
test("a program older than a driver's glibc gets an older driver", () => {
  const result = chooseDriver(glProgram("2.40-66", "14.2.1"), DRIVERS);
  assert.equal(result.choice, DriverChoice.ADD);
  assert.equal(result.driver, OLD);
});

// Checks that a driver built against a newer glibc than the program's
// is never chosen, and that the page says why.
test("a program older than every driver gets none, and a note", () => {
  const result = chooseDriver(glProgram("2.37-45", "12.3.0"), DRIVERS);
  assert.equal(result.choice, DriverChoice.NONE_FITS);
  assert.match(driverNote(result), /glibc 2\.37/);
});

// Checks the libstdc++ side: a program whose closure carries an older
// gcc runtime than the driver was built with may have loaded that older
// libstdc++ first, so the driver is not chosen even when glibc fits.
test("a program with an older gcc runtime does not get a newer driver", () => {
  const result = chooseDriver(glProgram("2.42-84", "14.2.1"), [NEW]);
  assert.equal(result.choice, DriverChoice.NONE_FITS);
});

// Checks that a program with no gcc runtime in its closure is judged by
// glibc alone: the driver then brings its own libstdc++.
test("a program with no gcc runtime is judged by glibc alone", () => {
  const closure = glProgram("2.42-84", "15.3.0").filter(
    (b) => !b.includes("gcc"),
  );
  assert.equal(chooseDriver(closure, [NEW]).choice, DriverChoice.ADD);
});

// Checks the cases where nothing is added: no GL program, a Mesa the
// reader selected (which is how a reader opts out of the page's), and a
// site that publishes no driver.
test("nothing is added where nothing is needed or a Mesa is selected", () => {
  const noGl = [
    path("foot-1.28.0"),
    path("wayland-1.24.0"),
    path("glibc-2.42-84"),
  ];
  assert.equal(chooseDriver(noGl, DRIVERS).choice, DriverChoice.NOT_NEEDED);
  assert.equal(driverNote(chooseDriver(noGl, DRIVERS)), null);

  const withMesa = [...glProgram("2.42-84", "15.3.0"), path("mesa-26.3.1")];
  assert.equal(chooseDriver(withMesa, DRIVERS).choice, DriverChoice.PRESENT);

  const unpublished = chooseDriver(glProgram("2.42-84", "15.3.0"), []);
  assert.equal(unpublished.choice, DriverChoice.NONE_PUBLISHED);
  assert.match(driverNote(unpublished), /mesa/);
});

// Checks a selection that mixes nixpkgs revisions: the closure then
// holds two glibcs, and a driver must fit the older one, since any of
// the programs may be the one that loads it.
test("a closure with two glibcs is judged by the older", () => {
  const mixed = [...glProgram("2.42-84", "15.3.0"), path("glibc-2.40-66")];
  const result = chooseDriver(mixed, DRIVERS);
  assert.equal(result.choice, DriverChoice.ADD);
  assert.equal(result.driver, OLD);
});

// Checks a driver that links no libstdc++, whose manifest names no gcc:
// any gcc runtime the program has is fine.
test("a driver with no gcc floor is judged by glibc alone", () => {
  const plain = { ...NEW, gcc: null };
  const result = chooseDriver(glProgram("2.42-84", "9.3.0"), [plain]);
  assert.equal(result.choice, DriverChoice.ADD);
});
