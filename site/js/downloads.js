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
// A link can name the choice (url.js, `fetch`), and a choice made in the
// Settings lane goes into the link.

import { Engine } from "./engine.js";

export const Downloads = Object.freeze({
  // A store path downloads the first time the guest opens it.
  LAZY: "lazy",
  // Every store path downloads before the shell starts.
  ALL: "all",
});

// The choice a page has when nothing says otherwise.
const DEFAULT_DOWNLOADS = Downloads.LAZY;

// A choice as a link or storage holds it, or null when the value is
// not one.
export function downloadsOf(value) {
  return Object.values(Downloads).includes(value) ? value : null;
}

// When this boot downloads: the link's choice, else the default, with
// why, for the log. The qemu engine downloads everything first
// whatever was asked.
export function pickDownloads({ linked, engine }) {
  if (engine === Engine.QEMU) {
    return {
      mode: Downloads.ALL,
      why: "the x86_64 guest reads its store synchronously",
    };
  }
  if (downloadsOf(linked) !== null) {
    return { mode: linked, why: "the link asks for it" };
  }
  return { mode: DEFAULT_DOWNLOADS, why: "the default" };
}
