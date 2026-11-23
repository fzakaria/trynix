// Tests reading which store paths a program's dynamic loading will
// open (site/js/elf.js): its loader, and the directories its RUNPATH or
// RPATH names. The files are small ELF files built by hand
// (elf-builder.mjs), since the suite runs where no real binary is at
// hand.
import { test } from "node:test";
import assert from "node:assert/strict";

import { loaderStorePaths } from "../../site/js/elf.js";
import { DT_RPATH, elf } from "./elf-builder.mjs";

const GLIBC = "0123456789abcdfghijklmnpqrsvwxyz-glibc-2.42";
const GTK = "1123456789abcdfghijklmnpqrsvwxyz-gtk+3-3.24.52";
const GLIB = "2123456789abcdfghijklmnpqrsvwxyz-glib-2.90.0";

// Checks a program: its loader's store path, and every store path its
// RUNPATH names, once each; $ORIGIN, which is the program's own path,
// names nothing new.
test("a program's loader and RUNPATH name the store paths it loads from", () => {
  const program = elf({
    interp: `/nix/store/${GLIBC}/lib/ld-linux-aarch64.so.1`,
    needed: ["libgtk-3.so.0", "libc.so.6"],
    searchPath: `/nix/store/${GTK}/lib:/nix/store/${GLIB}/lib:$ORIGIN/../lib:/nix/store/${GLIBC}/lib`,
  });
  assert.deepEqual(loaderStorePaths(program), [GLIBC, GTK, GLIB]);
});

// Checks a library: no interpreter, and an RPATH, which older linkers
// write where newer ones write RUNPATH.
test("a library's RPATH names the store paths it loads from", () => {
  const library = elf({
    needed: ["libglib-2.0.so.0"],
    searchPath: `/nix/store/${GLIB}/lib`,
    pathTag: DT_RPATH,
  });
  assert.deepEqual(loaderStorePaths(library), [GLIB]);
});

// Checks that what is not a dynamically linked ELF file names nothing:
// a script, a file too short to be anything, and an ELF file with no
// search path.
test("a script, a short file and a bare ELF file name nothing", () => {
  const script = new TextEncoder().encode(`#!/nix/store/${GLIBC}/bin/sh\n`);
  assert.deepEqual(loaderStorePaths(script), []);
  assert.deepEqual(loaderStorePaths(new Uint8Array([0x7f, 0x45])), []);
  assert.deepEqual(loaderStorePaths(elf({ needed: ["libc.so.6"] })), []);
});

// Checks that a file whose headers point past its end names nothing
// rather than throwing: the guest may open anything.
test("a truncated ELF file names nothing", () => {
  const program = elf({
    interp: `/nix/store/${GLIBC}/lib/ld-linux-aarch64.so.1`,
    searchPath: `/nix/store/${GTK}/lib`,
  });
  assert.deepEqual(loaderStorePaths(program.subarray(0, 200)), []);
});
