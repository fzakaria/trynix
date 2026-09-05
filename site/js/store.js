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

    FS.symlink(entry.target, path);
  }
}
