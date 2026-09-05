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
  if (info.compression === "zstd") {
    return parseNar(fzstd.decompress(compressed));
  }

  const stream = new xzwasm.XzReadableStream(new Response(compressed).body);
  return parseNar(new Uint8Array(await new Response(stream).arrayBuffer()));
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

// Write one parsed NAR under root. Entries arrive directories-first
// (archive order), so plain mkdir suffices below the root.
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
      FS.writeFile(path, entry.data);
      if (entry.executable) {
        FS.chmod(path, MODE_EXECUTABLE);
      }
      continue;
    }

    FS.symlink(absoluteTarget(path, entry.target), path);
  }
}
