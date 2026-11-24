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
  // Programs by basename, for every path written or offered.
  const programs = new Map();
  const written = new Set();

  // The farm's links by program name, each to the basename whose
  // program the link names.
  const farm = new Map();

  // The basenames the reader selected, from every batch linked: the
  // first to take a name a NAR gave back (reconcile).
  const selected = new Set();

  // Link the programs `names` of one path into the farm, and note which
  // links now name it.
  function linkNames(basename, names, precedence) {
    const linked = linkPrograms(
      FS,
      BIN_DIR,
      `${GUEST_STORE_DIR}/${basename}`,
      names,
      precedence,
    );
    for (const name of linked) {
      farm.set(name, basename);
    }
  }

  // Bring the farm's links to a path in line with its NAR, once the NAR
  // is in. A listing offered `offered` before the NAR came, and the farm
  // linked them; a link the NAR does not back goes, and another path
  // that has the program takes the name, a selected one first, as a
  // batch links the roots first.
  function reconcile(basename, offered) {
    const backed = new Set(programs.get(basename));
    for (const name of offered) {
      if (backed.has(name) || farm.get(name) !== basename) {
        continue;
      }
      FS.unlink(`${BIN_DIR}/${name}`);
      farm.delete(name);

      // The next path with the program, selected paths before the rest.
      const others = [...programs.keys()].filter(
        (other) => other !== basename && programs.get(other).includes(name),
      );
      const next = others.find((other) => selected.has(other)) ?? others.at(0);
      if (next !== undefined) {
        linkNames(next, [name], Precedence.KEEP);
      }
    }
  }

  return {
    // Materialise one parsed NAR. A path already there is left alone —
    // a store path is immutable, so there is nothing to update. The
    // NAR's programs replace any its listing offered, and the farm
    // gives up the links of offered programs the NAR lacks
    // (reconcile).
    write(basename, entries) {
      if (written.has(basename)) {
        return;
      }
      writeEntries(FS, `${STORE_DIR}/${basename}`, entries);
      written.add(basename);
      const offered = programs.get(basename);
      programs.set(basename, programsOf(entries));
      if (offered !== undefined) {
        reconcile(basename, offered);
      }
    },

    // A path's programs before it is written, from its NAR listing
    // (listing.js), so they can be linked while the path is still to
    // come. The guest runs one through the link, which fetches the path
    // (lazy.js).
    offer(basename, names) {
      if (!programs.has(basename)) {
        programs.set(basename, names);
      }
    },

    // Offer a written path's programs in the farm.
    link(basename, precedence) {
      linkNames(basename, programs.get(basename) ?? [], precedence);
    },

    // Link a batch: the roots — what the reader asked for — first, so
    // they win a collision, then the rest only where a name is still
    // free, so a dependency never shadows a selection. `precedence`
    // says whether a root may replace a link an earlier batch made.
    linkAll(basenames, roots, precedence) {
      for (const basename of roots) {
        selected.add(basename);
        this.link(basename, precedence);
      }
      for (const basename of basenames) {
        if (!roots.includes(basename)) {
          this.link(basename, Precedence.KEEP);
        }
      }
    },

    programsOf: (basename) => programs.get(basename) ?? [],

    // The programs of `basenames` as files the guest can read, each in
    // its own path's bin directory: a farm link of the same name may
    // name another package's.
    programFiles: (basenames) =>
      basenames.flatMap((basename) =>
        (programs.get(basename) ?? []).map(
          (name) => `${GUEST_STORE_DIR}/${basename}/bin/${name}`,
        ),
      ),
    written: () => [...written],
    // Every path whose programs are known: written or offered.
    known: () => [...programs.keys()],
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
