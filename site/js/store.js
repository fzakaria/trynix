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

// One NAR: fetch, count, decompress, parse. onBytes hears compressed
// chunk sizes as they arrive.
export async function fetchNar(info, onBytes) {
  const res = await fetch(`${CACHE_URL}/${info.url}`);
  if (!res.ok) {
    throw new Error(`${info.url}: HTTP ${res.status}`);
  }

  const counter = new TransformStream({
    transform(chunk, controller) {
      onBytes(chunk.byteLength);
      controller.enqueue(chunk);
    },
  });

  let stream = res.body.pipeThrough(counter);
  if (info.compression === "xz") {
    stream = new xzwasm.XzReadableStream(stream);
  } else if (info.compression !== "zstd" && info.compression !== "none") {
    throw new Error(`unsupported NAR compression "${info.compression}"`);
  }

  let bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  if (info.compression === "zstd") {
    bytes = fzstd.decompress(bytes);
  }
  return parseNar(bytes);
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
