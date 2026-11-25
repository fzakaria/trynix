// Which of the site's GL drivers the guest links, and what the page
// says when the driver is too new for the selection.
//
// nixpkgs' GL programs link libglvnd, which loads the system's driver
// at run time from /run/opengl-driver. The guest has none of its own,
// so the page links the site's: Mesa with the virgl driver alone
// (nix/mesa-virgl.nix), which the site serves from its own binary cache
// beside cache.nixos.org (docs/gui.md). The link is there from the
// boot, in every guest, and the driver's closure is fetched only once a
// program looks inside it (lazy.js, capability), so a guest that draws
// no GL pays nothing for it. An X11 program draws through the driver's
// GLX on the page's X server.
//
// The driver is loaded into the program's process, so the program's
// glibc and libstdc++ are the ones it runs against. A Mesa built
// against a newer glibc asks for symbol versions the program's glibc
// does not have, and fails to load; one built with a newer gcc asks
// libstdc++ for versions an older one, already loaded by a C++
// program, lacks. Such a program fails as it would with no driver at
// all: libglvnd takes a vendor that does not load for no vendor. The
// program's closure says which glibc and gcc it has (its glibc and gcc
// runtime store paths), and the site's manifest says which each driver
// was built with, so the page links the newest driver that is no newer
// than the program on either count, and tells the reader when none is.
//
// A reader who selects a Mesa of their own gets that one instead
// (unkernel.js links a selected path that holds Mesa's EGL vendor file
// over the site's), and no note.

import { siteManifest } from "./substituters.js";
import { compareVersions as compare } from "./version.js";

// How the published drivers fit a selection.
export const DriverChoice = Object.freeze({
  // `driver` is the newest no newer than the selection's glibc and gcc.
  FITS: "fits",
  // Every published driver is newer than the selection's glibc or gcc;
  // `driver` is the newest, which an older program fails to load.
  NONE_FITS: "none-fits",
  // The site publishes no driver.
  NONE_PUBLISHED: "none-published",
});

// Store basenames, by the nixpkgs package each one is. Mesa covers
// nixpkgs' own in any output (mesa-26.3.1, mesa-22.3.7-drivers) and the
// site's (mesa-virgl-26.2.2).
const GLVND_PATH = /^[0-9a-z]{32}-libglvnd-\d/;
const MESA_PATH = /^[0-9a-z]{32}-mesa-(virgl-)?\d/;
const GLIBC_PATH = /^[0-9a-z]{32}-glibc-(\d+(?:\.\d+)*)/;
const GCC_LIB_PATH = /^[0-9a-z]{32}-gcc-(\d+(?:\.\d+)*)-lib$/;

// Whether a closure's basenames hold libglvnd, through which nixpkgs'
// programs load GL: a hint that the selection draws with GL, which
// turns glamor on for the X server (gui.js) and makes the driver's
// note worth giving.
export const drawsWithGl = (basenames) =>
  basenames.some((basename) => GLVND_PATH.test(basename));

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

// The newest of `drivers` by the glibc it was built against.
const newestOf = (drivers) =>
  drivers.reduce((best, driver) =>
    compare(driver.glibc, best.glibc) > 0 ? driver : best,
  );

// Which driver to link for a closure (`basenames`), given the drivers
// the site publishes, each { storePath, glibc, gcc }: glibc is the
// newest GLIBC_ version the driver's closure asks for, gcc the oldest
// gcc whose libstdc++ has every GLIBCXX_ version it asks for, or null
// when it links no libstdc++. Returns { choice, driver }, driver null
// for NONE_PUBLISHED, with the closure's `glibc` and `gcc` for
// NONE_FITS.
export function chooseDriver(basenames, drivers) {
  if (drivers.length === 0) {
    return { choice: DriverChoice.NONE_PUBLISHED, driver: null };
  }

  // A closure with no gcc runtime has loaded no libstdc++ before the
  // driver, which then brings its own, and a driver with no gcc floor
  // links none: either way glibc alone decides. A closure with no glibc
  // (static programs alone) fits any driver.
  const glibc = oldestIn(basenames, GLIBC_PATH);
  const gcc = oldestIn(basenames, GCC_LIB_PATH);
  const fits = drivers.filter(
    (driver) =>
      (glibc === null || compare(driver.glibc, glibc) <= 0) &&
      (driver.gcc === null || gcc === null || compare(driver.gcc, gcc) <= 0),
  );
  if (fits.length === 0) {
    return {
      choice: DriverChoice.NONE_FITS,
      driver: newestOf(drivers),
      glibc,
      gcc,
    };
  }
  return { choice: DriverChoice.FITS, driver: newestOf(fits) };
}

// What the page tells the reader about a choice for a closure
// (`basenames`) and the roots the reader selected, or null. Only a
// selection that draws with GL hears of the driver, and one that
// selected a Mesa of its own has opted out of the site's.
export function driverNote(result, basenames, roots) {
  if (!drawsWithGl(basenames)) {
    return null;
  }
  if (roots.some((basename) => MESA_PATH.test(basename))) {
    return null;
  }
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

// The drivers the site publishes (site/gl/drivers.json, read once by
// substituters.js's siteManifest), or none when the site has none or
// the file cannot be had: a page without a driver still boots
// everything else.
export async function publishedDrivers() {
  return (await siteManifest()).drivers;
}
