// The store share: the directory tree the guest reads its packages
// from, and the farm of links it keeps on PATH.
//
// Both engines hand the guest the same tree over 9p. qemu serves the
// tree out of emscripten's in-memory file system through virtio; unkernel
// serves the tree out of its own in-memory file system over a vsock.
// The layout is the same either way, so the code that builds the tree
// is written once, against the few emscripten FS calls store.js makes,
// and the unkernel engine wraps its file system in those calls
// (memoryFsCalls, below).

import { linkPrograms, Precedence, programsOf, writeEntries } from "./store.js";

// Where the guest mounts the share, and the store inside the share.
// The guest's /nix is a symlink to the share's nix directory.
export const SHARE_DIR = "/share";
export const STORE_DIR = `${SHARE_DIR}/nix/store`;

// The farm: one directory of symlinks, one per program in the closure,
// that the guest keeps on PATH for the life of the VM. Adding a package
// later means adding links here, which the guest sees through 9p the
// moment they exist — nothing has to be typed at its shell, and PATH
// never grows past two entries.
const BIN_DIR = `${SHARE_DIR}/bin`;
export const GUEST_BIN_DIR = BIN_DIR;
export const GUEST_STORE_DIR = "/nix/store";

// The store share, as the page maintains it: which paths have been
// written, what programs each one offers, and the farm of links.
export function storeShare(FS) {
  const programs = new Map();

  return {
    // Materialise one parsed NAR. A path already there is left alone —
    // a store path is immutable, so there is nothing to update.
    write(basename, entries) {
      if (programs.has(basename)) {
        return;
      }
      writeEntries(FS, `${STORE_DIR}/${basename}`, entries);
      programs.set(basename, programsOf(entries));
    },

    // Offer a written path's programs in the farm.
    link(basename, precedence) {
      linkPrograms(
        FS,
        BIN_DIR,
        `${GUEST_STORE_DIR}/${basename}`,
        programs.get(basename) ?? [],
        precedence,
      );
    },

    // Link a batch: the roots — what the reader asked for — first, so
    // they win a collision, then the rest only where a name is still
    // free, so a dependency never shadows a selection. `precedence`
    // says whether a root may replace a link an earlier batch made.
    linkAll(basenames, roots, precedence) {
      for (const basename of roots) {
        this.link(basename, precedence);
      }
      for (const basename of basenames) {
        if (!roots.includes(basename)) {
          this.link(basename, Precedence.KEEP);
        }
      }
    },

    programsOf: (basename) => programs.get(basename) ?? [],
    written: () => [...programs.keys()],
  };
}

// What a regular file is created as before store.js marks the
// executables.
const MODE_FILE = 0o644;

// The modification time nix gives every file in a store, one second
// past the epoch, in milliseconds. Programs compare mtimes inside the
// store: guile takes a compiled .go only when it is no older than its
// .scm source, and files stamped with the moment the page wrote them
// make some sources look newer, so guile ignores the compiled files and
// interprets everything (aisleriot did not open a window in 90 s).
const STORE_MTIME_MS = 1000;

// unkernel's MemoryFs behind the emscripten FS calls the share makes.
//
// The MemoryFs is the share itself: the guest mounts its root at
// SHARE_DIR. So a path the share's code writes as /share/nix/store/...
// is /nix/store/... inside the MemoryFs, and the prefix comes off here.
// Link targets are left as written, because a target is read by the
// guest, where the share does sit at SHARE_DIR.
export function memoryFsCalls(fs) {
  const inside = (path) => path.slice(SHARE_DIR.length) || "/";

  return {
    // emscripten's mkdir throws on a directory that exists and the
    // callers swallow that; mkdirp has nothing to throw.
    mkdir: (path) => fs.mkdirp(inside(path)),

    writeFile(path, data) {
      fs.writeFile(inside(path), data, { mode: MODE_FILE });
      fs.setattr(inside(path), { mtimeMs: STORE_MTIME_MS });
    },

    chmod: (path, mode) => fs.setattr(inside(path), { mode }),

    symlink: (target, path) => fs.writeLink(inside(path), target),

    unlink: (path) => fs.rm(inside(path)),

    // The share only asks whether a path exists, and emscripten says
    // no by throwing.
    lstat(path) {
      const attr = fs.stat(inside(path));
      if (attr === undefined) {
        throw new Error(`${path}: no such file or directory`);
      }
      return attr;
    },
  };
}
