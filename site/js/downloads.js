// When the page downloads a closure's store paths.
//
// On the unkernel engine the page can serve the guest's store before
// the store has arrived: every path of the closure is listed from its
// narinfo alone, and a path's NAR is fetched the first time the guest
// looks inside it (lazy.js). The shell is ready once the selected
// packages themselves are in. A GUI program's closure carries a lot it
// never opens (aisleriot's holds gcc through guile, and python through
// libcanberra), and none of that is downloaded until something asks.
//
// The other choice is what the page always did: every path downloaded
// and unpacked before the shell starts, after which nothing the guest
// does waits on the network. The qemu engine only has that one, since
// its share is read by QEMU's own 9p code inside the engine, which
// reads a file synchronously and has no way to wait for a download.
//
// A link can name the choice (url.js, `fetch`), and the Settings lane
// can choose one, which this browser then remembers.

import { Engine } from "./engine.js";

export const Downloads = Object.freeze({
  // A store path downloads the first time the guest opens it.
  LAZY: "lazy",
  // Every store path downloads before the shell starts.
  ALL: "all",
});

// The choice a page has when nothing says otherwise.
const DEFAULT_DOWNLOADS = Downloads.LAZY;

// Where this browser keeps the choice made in Settings.
const STORAGE_KEY = "trynix.downloads";

// A choice as a link or storage holds it, or null when the value is
// not one.
export function downloadsOf(value) {
  return Object.values(Downloads).includes(value) ? value : null;
}

// When this boot downloads: the link's choice, then the one this
// browser remembers, then the default; each with why, for the log. The
// qemu engine downloads everything first whatever was asked.
export function pickDownloads({ linked, remembered, engine }) {
  if (engine === Engine.QEMU) {
    return {
      mode: Downloads.ALL,
      why: "the x86_64 guest reads its store synchronously",
    };
  }
  if (downloadsOf(linked) !== null) {
    return { mode: linked, why: "the link asks for it" };
  }
  if (downloadsOf(remembered) !== null) {
    return { mode: remembered, why: "chosen in Settings" };
  }
  return { mode: DEFAULT_DOWNLOADS, why: "the default" };
}

// The choice this browser remembers, or null. Storage can be refused
// (a private window, blocked site data); the page then uses the default.
export function rememberedDownloads() {
  try {
    return downloadsOf(localStorage.getItem(STORAGE_KEY));
  } catch {
    return null;
  }
}

export function rememberDownloads(mode) {
  try {
    localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    // Not remembered; the choice still holds for this page.
  }
}
