// Which GL driver the page adds to a selection with a GL program.
//
// nixpkgs' GL programs link libglvnd, which loads the system's driver
// at run time from /run/opengl-driver. The guest has none of its own,
// so when a selection holds a Wayland program that links libglvnd and
// no Mesa, the page adds one: Mesa with the virgl driver alone
// (nix/mesa-virgl.nix), which the site serves from its own binary cache
// beside cache.nixos.org (docs/gui.md).
//
// The driver is loaded into the program's process, so the program's
// glibc and libstdc++ are the ones it runs against. A Mesa built
// against a newer glibc asks for symbol versions the program's glibc
// does not have, and fails to load; one built with a newer gcc asks
// libstdc++ for versions an older one, already loaded by a C++
// program, lacks. The program's closure says which of each it has (its
// glibc and gcc runtime store paths), and the site's manifest says
// which each driver was built with, so the page picks the newest driver
// that is no newer than the program on either count.
//
// A reader who selects a Mesa of their own gets that one instead: the
// page adds nothing where the selection already holds a Mesa.

import { GL_DRIVERS } from "./config.js";
import { speaksWayland } from "./gui.js";
import { setSitePaths } from "./substituters.js";

// What the chooser decided.
export const DriverChoice = Object.freeze({
  // No Wayland program in the selection loads GL through libglvnd.
  NOT_NEEDED: "not-needed",
  // The selection already holds a Mesa.
  PRESENT: "present",
  // Add `driver`.
  ADD: "add",
  // Every published driver is newer than the program's glibc or gcc.
  NONE_FITS: "none-fits",
  // The site publishes no driver.
  NONE_PUBLISHED: "none-published",
});

// Store basenames, by the nixpkgs package each one is. Mesa covers
// nixpkgs' own (mesa-26.3.1) and the site's (mesa-virgl-26.2.2).
const GLVND_PATH = /^[0-9a-z]{32}-libglvnd-\d/;
const MESA_PATH = /^[0-9a-z]{32}-mesa-(virgl-)?\d/;
const GLIBC_PATH = /^[0-9a-z]{32}-glibc-(\d+(?:\.\d+)*)/;
const GCC_LIB_PATH = /^[0-9a-z]{32}-gcc-(\d+(?:\.\d+)*)-lib$/;

// Whether a store basename is a Mesa, which the guest may take as its
// GL driver. A lazily served boot fetches these with the selection
// (app.js), since the guest links a driver only once it has seen the
// driver's files.
export const isGlDriverPath = (basename) => MESA_PATH.test(basename);

// A dotted version as numbers, for comparing: "2.42" -> [2, 42].
const numbers = (version) => version.split(".").map(Number);

// a - b, componentwise, a missing component counting as 0.
function compare(a, b) {
  const x = numbers(a);
  const y = numbers(b);
  for (let i = 0; i < Math.max(x.length, y.length); i += 1) {
    const difference = (x[i] ?? 0) - (y[i] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }
  return 0;
}

// The oldest version among a closure's paths of one package, or null.
// A selection can mix nixpkgs revisions, so a closure can hold two
// glibcs, and any of its programs may be the one that loads the
// driver: the oldest is the one the driver has to fit.
function oldestIn(basenames, pattern) {
  let oldest = null;
  for (const basename of basenames) {
    const match = pattern.exec(basename);
    if (match !== null && (oldest === null || compare(match[1], oldest) < 0)) {
      oldest = match[1];
    }
  }
  return oldest;
}

// What to do about a GL driver for a closure (`basenames`), given the
// drivers the site publishes, each { storePath, glibc, gcc }: glibc is
// the newest GLIBC_ version the driver's closure asks for, gcc the
// oldest gcc whose libstdc++ has every GLIBCXX_ version it asks for,
// or null when it links no libstdc++. Returns
// { choice }, with `driver` for ADD and the program's `glibc` and `gcc`
// for NONE_FITS.
export function chooseDriver(basenames, drivers) {
  if (
    !speaksWayland(basenames) ||
    !basenames.some((basename) => GLVND_PATH.test(basename))
  ) {
    return { choice: DriverChoice.NOT_NEEDED };
  }
  if (basenames.some((basename) => MESA_PATH.test(basename))) {
    return { choice: DriverChoice.PRESENT };
  }
  if (drivers.length === 0) {
    return { choice: DriverChoice.NONE_PUBLISHED };
  }

  // A closure with no gcc runtime has loaded no libstdc++ before the
  // driver, which then brings its own, and a driver with no gcc floor
  // links none: either way glibc alone decides.
  const glibc = oldestIn(basenames, GLIBC_PATH);
  const gcc = oldestIn(basenames, GCC_LIB_PATH);
  const fits = drivers.filter(
    (driver) =>
      glibc !== null &&
      compare(driver.glibc, glibc) <= 0 &&
      (driver.gcc === null || gcc === null || compare(driver.gcc, gcc) <= 0),
  );
  if (fits.length === 0) {
    return { choice: DriverChoice.NONE_FITS, glibc, gcc };
  }

  const newest = fits.reduce((best, driver) =>
    compare(driver.glibc, best.glibc) > 0 ? driver : best,
  );
  return { choice: DriverChoice.ADD, driver: newest };
}

// What the page tells the reader about a choice, or null.
export function driverNote(result) {
  if (result.choice === DriverChoice.NONE_PUBLISHED) {
    return "these programs can draw with GL, and nothing selected provides a driver: add mesa for one";
  }
  if (result.choice === DriverChoice.NONE_FITS) {
    return (
      `these programs can draw with GL, and the site's GL driver is built against a newer ` +
      `glibc or gcc than theirs (glibc ${result.glibc ?? "unknown"}, gcc ${result.gcc ?? "none"}): ` +
      `add a mesa from the same nixpkgs as the program`
    );
  }
  return null;
}

// The drivers the site publishes (site/gl/drivers.json, served as
// GL_DRIVERS), or none when the site has none or the file cannot be
// had: a page without a driver still boots everything else. The store
// paths the site's cache serves come with them, and the substituters
// learn them here, before any of them is looked up.
export async function publishedDrivers() {
  try {
    const res = await fetch(GL_DRIVERS);
    if (!res.ok) {
      return [];
    }
    const manifest = await res.json();
    setSitePaths(manifest.paths ?? []);
    return manifest.drivers ?? [];
  } catch {
    return [];
  }
}
