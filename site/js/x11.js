// Whether the page adds an X server to a selection with X11 programs.
//
// The guest has no X server of its own. wland's relay can start one
// for the first X client (wlandr --xwayland, gui.js): xwayland-satellite,
// which runs Xwayland rootless and is its window manager, and is an
// ordinary Wayland client of the relay, so each X11 window opens as a
// window of its own on the page. The page adds the index's newest
// xwayland-satellite to a selection whose programs need it, resolved as
// a selected name is, and its closure comes from cache.nixos.org like
// any other. The newest build is the one most likely to share glibc and
// the X libraries with programs selected by name, which resolve to
// their newest builds too: for xeyes, xterm and wish in November 2026,
// 12 to 23 of the satellite's 129 paths were in the program's closure
// already, glibc among them, where the build from the nixpkgs this
// flake locks shared none. The satellite and Xwayland run as processes
// of their own, so unlike the GL driver they need not match the
// program's glibc.
//
// Which programs need it is decided per selected program, from its own
// closure: an X client library and no libwayland means the program can
// speak X11 alone. The client library is libX11, or libxcb, which
// libX11 is built on and which xlsatoms and xlsclients use alone.
// nixpkgs' GTK 3 and Qt programs carry the X client libraries through
// their toolkit beside libwayland, and run on the relay without an X
// server. A program whose closure holds libwayland and speaks only X11
// anyway (Java's AWT, whose closure holds GTK) is not recognised;
// selecting xwayland-satellite with it is the way in.

import { reachable } from "./closure.js";
import { speaksWayland } from "./gui.js";

// What the chooser decided.
export const X11Choice = Object.freeze({
  // No selected program speaks only X11, and the closure holds no X
  // server.
  NOT_NEEDED: "not-needed",
  // The closure holds an X server already: the reader selected one, or
  // an earlier addition brought it.
  PRESENT: "present",
  // Add the index's X server (X11_SERVER_ATTR).
  ADD: "add",
  // A program needs one and the index gave none: unreachable, or no
  // build for the guest's system.
  UNAVAILABLE: "unavailable",
});

// The X server's attribute in the index.
export const X11_SERVER_ATTR = "xwayland-satellite";

// Store basenames, by the nixpkgs package each one is. libX11 is
// xorg.libX11 (libX11-1.6.5) in older nixpkgs and libx11 in newer;
// libxcb is libxcb in both.
const LIBX11_PATH = /^[0-9a-z]{32}-lib[xX]11-\d/;
const LIBXCB_PATH = /^[0-9a-z]{32}-libxcb-\d/;
const X11_SERVER_PATH = /^[0-9a-z]{32}-xwayland-satellite-\d/;

// Whether a store basename is a library an X11 client speaks through.
const isX11Client = (basename) =>
  LIBX11_PATH.test(basename) || LIBXCB_PATH.test(basename);

// Whether a closure's basenames hold a library an X11 client speaks
// through, so that a program in it can draw on the page's X server.
export const speaksX11 = (basenames) => basenames.some(isX11Client);

// Whether a store basename is an X server the relay can start.
// Xwayland alone is not one: rootless, it needs a window manager to
// give its windows to a compositor, which the satellite is.
export const isX11Server = (basename) => X11_SERVER_PATH.test(basename);

// The first X server among store basenames, or null.
export const x11ServerIn = (basenames) => basenames.find(isX11Server) ?? null;

// The basenames of a walked closure's narinfos.
const basenamesOf = (infos) =>
  [...infos.values()].map((info) =>
    info.storePath.slice(info.storePath.lastIndexOf("/") + 1),
  );

// What to do about an X server for a closure (digest -> narinfo, as
// the walk returns it) and the digests of the selected programs.
// Returns { choice }, with `server` for PRESENT, the basename already
// there, and `programs` for ADD, the selected programs that speak only
// X11.
export function chooseX11Server(closure, rootDigests) {
  const server = x11ServerIn(basenamesOf(closure));
  if (server !== null) {
    return { choice: X11Choice.PRESENT, server };
  }

  // Each selected program by its own closure, since a neighbour's
  // libwayland says nothing about what this one speaks.
  const programs = [];
  for (const digest of rootDigests) {
    const own = basenamesOf(reachable(closure, [digest]));
    if (!own.some(isX11Client)) {
      continue;
    }
    if (speaksWayland(own)) {
      continue;
    }
    programs.push(own.find((basename) => basename.startsWith(digest)));
  }
  if (programs.length === 0) {
    return { choice: X11Choice.NOT_NEEDED };
  }
  return { choice: X11Choice.ADD, programs };
}

// What the page tells the reader about a choice, or null: only that
// programs need a server the index could not give. How the shell
// already running when an addition brought the server reaches it is
// the engine's to say (gui.js, shellNote), with whatever else the
// addition changed in the shells' environment.
export function x11Note(result) {
  if (result.choice !== X11Choice.UNAVAILABLE) {
    return null;
  }
  return (
    `these programs speak only X11, and the index gave no X server for them: ` +
    `select ${X11_SERVER_ATTR} with them`
  );
}
