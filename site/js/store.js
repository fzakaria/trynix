// Fetching a closure's NARs from the binary cache and materialising
// them into the emscripten filesystem the VM's 9p share reads from.
// Each NAR streams through a byte counter (progress is measured in
// compressed bytes, the number the narinfo priced) into the xzwasm
// decompressor, then through the NAR parser into entry lists.
//
// The cache compresses NARs per path — xz for older builds, zstd for
// newer ones — so both decoders are on hand. xzwasm and fzstd arrive as
// vendored UMD scripts, so globals are used here rather than imports.
/* global xzwasm, fzstd */

import { CACHE_URL } from "./config.js";
import { parseNar } from "./nar.js";
import { fetchWithProgress } from "./net.js";
import { log } from "./log.js";

// Downloads run several at a time, but decompression does not.
//
// Each xz stream instantiates its own decoder, and a NAR can be
// enormous — gcc unpacks to 143 MB. Several of those decoding at once
// exhaust the decoder's wasm memory, and the failure arrives as a
// stream error, which reading a Response reports as the same bare
// "TypeError: Failed to fetch" a dead network gives. Serialising the
// decode keeps the peak to one archive.
let decoding = Promise.resolve();

function serialize(work) {
  const result = decoding.then(work, work);
  // A failed decode must not poison the queue for everything after it.
  decoding = result.then(
    () => {},
    () => {},
  );
  return result;
}

// One NAR: fetch, count, decompress, parse. onBytes hears compressed
// chunk sizes as they arrive.
export async function fetchNar(info, onBytes) {
  if (!["xz", "zstd", "none"].includes(info.compression)) {
    throw new Error(`unsupported NAR compression "${info.compression}"`);
  }

  // The NAR comes from whichever cache served the narinfo: a narinfo's
  // URL is relative to its own cache. The compressed bytes are what get
  // cached, so a second visit skips the network but still decompresses.
  const compressed = await fetchWithProgress(
    `${info.substituter ?? CACHE_URL}/${info.url}`,
    {
      onBytes,
    },
  );

  if (info.compression === "none") {
    return parseNar(compressed);
  }

  return serialize(async () => {
    try {
      if (info.compression === "zstd") {
        return parseNar(fzstd.decompress(compressed));
      }
      const stream = new xzwasm.XzReadableStream(new Response(compressed).body);
      return parseNar(new Uint8Array(await new Response(stream).arrayBuffer()));
    } catch (err) {
      // Say which archive, since the underlying message names nothing.
      log(
        `failed to decompress ${info.url} (${info.compression}): ${err.message}`,
      );
      throw new Error(
        `${info.storePath}: ${info.compression} decode failed: ${err.message}`,
      );
    }
  });
}

// mkdir -p against the emscripten FS: existing components are fine.
export function ensureDir(FS, path) {
  let current = "";
  for (const part of path.split("/").filter(Boolean)) {
    current += `/${part}`;
    try {
      FS.mkdir(current);
    } catch {
      // exists
    }
  }
}

// Where a symlink should point, written the way the guest can use it.
//
// A relative target is resolved here, against the link's own directory,
// into an absolute path. That is not tidying: emscripten's FS.readlink
// resolves the target itself and returns an absolute path, while the
// stat it reports keeps the *relative* target's length. The 9p client
// in the guest sees a link whose declared size is shorter than the
// string it reads back, and a lookup through it fails — the dynamic
// loader reports the library as missing even though `ls` shows it and
// `cat` reads it. Storing the absolute target makes size and content
// agree, and the guest resolves it because the share is mounted at the
// same path the page built it at.
//
// A target that is already absolute is left alone: it names a store
// path, which the guest reaches through its own /nix symlink.
export function absoluteTarget(linkPath, target) {
  if (target.startsWith("/")) {
    return target;
  }

  const parts = linkPath.split("/").slice(0, -1);
  for (const part of target.split("/")) {
    if (part === "" || part === ".") {
      continue;
    }
    if (part === "..") {
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return parts.join("/");
}

// The programs a store path offers: the names directly under bin/ that
// a PATH lookup would run — executables and symlinks, not data files
// and not nested directories.
const PROGRAM_PATH = /^bin\/[^/]+$/;
const BIN_PREFIX = "bin/";

export function programsOf(entries) {
  return entries
    .filter(
      (entry) =>
        PROGRAM_PATH.test(entry.path) &&
        (entry.type === "symlink" ||
          (entry.type === "regular" && entry.executable)),
    )
    .map((entry) => entry.path.slice(BIN_PREFIX.length));
}

// What a program link does when the farm already has one by that name:
// replace it (the package the reader just asked for wins) or leave it
// (a dependency never shadows what is already there).
export const Precedence = Object.freeze({
  REPLACE: "replace",
  KEEP: "keep",
});

// Link a store path's programs into the farm directory the guest keeps
// on PATH. `storePath` is the guest's view of the package
// (/nix/store/...), which is what the link has to name: the guest
// reaches it through its own /nix symlink.
export function linkPrograms(FS, binDir, storePath, programs, precedence) {
  ensureDir(FS, binDir);
  for (const name of programs) {
    const link = `${binDir}/${name}`;
    if (exists(FS, link)) {
      if (precedence === Precedence.KEEP) {
        continue;
      }
      FS.unlink(link);
    }
    FS.symlink(`${storePath}/${BIN_PREFIX}${name}`, link);
  }
}

// Whether a path exists in the emscripten FS, the link itself rather
// than what it points at: a farm link names a guest path that does not
// exist on this side.
function exists(FS, path) {
  try {
    FS.lstat(path);
    return true;
  } catch {
    return false;
  }
}

// Write one parsed NAR under root. Entries arrive directories-first
// (archive order), so plain mkdir suffices below the root.
//
// File contents are views into the decompressed archive, and MEMFS is
// told to keep those views rather than copy them (canOwn). The
// archive then lives on exactly once, as the filesystem's storage for
// its files, instead of once there and once as the buffer it was
// parsed from — for a closure of any size, that is the difference
// between fitting in the tab and not.
const OWN = { canOwn: true };

export function writeEntries(FS, root, entries) {
  const MODE_EXECUTABLE = 0o755;

  for (const entry of entries) {
    const path = entry.path === "" ? root : `${root}/${entry.path}`;

    if (entry.type === "directory") {
      if (entry.path === "") {
        ensureDir(FS, path);
      } else {
        FS.mkdir(path);
      }
      continue;
    }

    if (entry.type === "regular") {
      FS.writeFile(path, entry.data, OWN);
      if (entry.executable) {
        FS.chmod(path, MODE_EXECUTABLE);
      }
      continue;
    }

    FS.symlink(absoluteTarget(path, entry.target), path);
  }
}
