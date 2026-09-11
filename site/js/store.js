// Fetching a closure's NARs from the binary cache and materialising
// them into the emscripten filesystem the VM's 9p share reads from.
// Each NAR streams through a byte counter (progress is measured in
// compressed bytes, the number the narinfo priced) into the xzwasm
// decompressor, then through the NAR parser into entry lists.
//
// The cache compresses NARs per path — bzip2 for what it served in
// nixpkgs's first years, xz for most of what came after, zstd for the
// newest — so three decoders are on hand. xzwasm and fzstd arrive as
// vendored UMD scripts the page loads, so globals are used for those
// rather than imports; the bzip2 decoder is wasm and is imported the
// first time a boot meets a bzip2 path, which for most boots is never.
/* global xzwasm, fzstd */

import { CACHE_URL } from "./config.js";
import { parseNar } from "./nar.js";
import { fetchWithProgress } from "./net.js";
import { evictFromCache } from "./cache.js";
import { verifyHash } from "./hash.js";
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

// What the narinfo claims about the compressed file, against what
// arrived. Null when they agree, otherwise a description.
//
// Never a reason to refuse the bytes, which is the whole point of
// keeping it separate from the checks below. FileSize and FileHash
// describe whichever compression the cache happens to be serving, and
// they sit outside the fingerprint it signs (substituters.js), so a
// cache that recompresses a path leaves them stale while the archive
// inside is the same content someone vouched for. cache.nixos.org has
// done exactly that: glibc-2.40-224's narinfo says 9096823 bytes for a
// file it serves 9099653 of, and its NarHash matches to the byte.
// Refusing that rejects provably genuine content over the one field no
// signature covers.
//
// It still goes in the log, because the same drift is what a download
// that ended short looks like, and the difference between the two shows
// up in NarSize and NarHash a moment later.
function compressedDrift(info, bytes) {
  if (info.fileSize > 0 && bytes.byteLength !== info.fileSize) {
    return `${bytes.byteLength} compressed bytes, narinfo says ${info.fileSize}`;
  }
  return null;
}

// The unpacked archive against what the narinfo promised: NarSize,
// then NarHash. Null means good; otherwise the reason.
//
// These two decide whether a boot proceeds, because these two are what
// a cache signs. Both have caught real failures. A download that ended
// short decoded as far as it went and the parser ran off its end (the
// size). And the xz decoder handed out views into its own memory that
// the next chunk overwrote, so the archive had the right length and
// wrong bytes, and the parser found machine code where a NAR token
// should be (the hash; patches/xzwasm/ fixes the decoder, and the hash
// is what says so if it ever comes back).
async function verifyUnpacked(info, nar) {
  if (info.narSize > 0 && nar.byteLength !== info.narSize) {
    return `unpacked to ${nar.byteLength} bytes, narinfo says ${info.narSize}`;
  }
  if (info.narHash !== undefined) {
    const ok = await verifyHash(nar, info.narHash);
    if (ok === false) {
      return "unpacked archive's sha256 does not match the narinfo";
    }
  }
  return null;
}

// One NAR: fetch, verify, decompress, verify again, parse. onBytes
// hears compressed chunk sizes as they arrive.
//
// An archive that unpacks wrong is decoded once more from a fresh
// download — the compressed copy is dropped from the cache first —
// before the boot gives up with a message that names the path and
// the reason.
export async function fetchNar(info, onBytes) {
  if (!["bzip2", "xz", "zstd", "none"].includes(info.compression)) {
    // Named, like every other refusal here, because the message is
    // the whole of what a reader can report: the one that brought
    // bzip2 to light said only that some path in some closure was
    // compressed with it.
    throw new Error(
      `${info.storePath}: unsupported NAR compression "${info.compression}"`,
    );
  }

  // The NAR comes from whichever cache served the narinfo: a narinfo's
  // URL is relative to its own cache. The compressed bytes are what get
  // cached, so a second visit skips the network but still decompresses.
  const url = `${info.substituter ?? CACHE_URL}/${info.url}`;

  for (let attempt = 1; ; attempt += 1) {
    const compressed = await fetchWithProgress(url, { onBytes });

    const drift = compressedDrift(info, compressed);
    if (drift !== null) {
      log(`${info.storePath}: ${drift}`);
    }

    // A decode that throws and an archive that verifies wrong are the
    // same event as far as this loop is concerned: bytes that cannot be
    // used, and must not stay in the cache for every later visit to
    // fail on. Truncated compressed streams arrive as the first and
    // used to escape without the eviction below.
    let nar = null;
    let problem = null;
    try {
      nar = await decompress(info, compressed);
      problem = await verifyUnpacked(info, nar);
    } catch (err) {
      // A decoder that never loaded says nothing about these bytes, so
      // they stay in the cache and the boot gives up here. Evicting and
      // downloading the closure again would only reach the same missing
      // decoder, and would report it as bad bytes on the way.
      if (err instanceof DecoderUnavailable) {
        throw new Error(`${info.storePath}: ${err.message}`);
      }
      problem = err.message;
    }
    if (problem === null) {
      return parse(info, nar);
    }

    await evictFromCache(url);
    if (attempt >= NAR_ATTEMPTS) {
      throw new Error(`${info.storePath}: ${problem}`);
    }
    log(`${info.storePath}: ${problem}; fetching again`);
    onBytes(-compressed.byteLength);
  }
}

// Parse, naming the path when the archive is malformed: the parser's
// own message says where in the bytes, not which package.
function parse(info, nar) {
  try {
    return parseNar(nar);
  } catch (err) {
    throw new Error(`${info.storePath}: ${err.message}`);
  }
}

// How many times a NAR that unpacks to the wrong size is fetched.
const NAR_ATTEMPTS = 2;

// Raised when a decoder cannot be brought in at all, as opposed to
// bytes it refused. The difference decides what fetchNar does next: a
// decoder that never loaded says nothing about the archive, so there is
// nothing to evict and nothing a second download would fix.
class DecoderUnavailable extends Error {}

// The archive's bytes, whatever it was compressed with.
async function decompress(info, compressed) {
  if (info.compression === "none") {
    return compressed;
  }

  return serialize(async () => {
    try {
      if (info.compression === "zstd") {
        return fzstd.decompress(compressed);
      }
      if (info.compression === "bzip2") {
        return await unbzip2(compressed, info.narSize);
      }
      const stream = new xzwasm.XzReadableStream(new Response(compressed).body);
      return new Uint8Array(await new Response(stream).arrayBuffer());
    } catch (err) {
      // Say which archive, since the underlying message names nothing.
      log(
        `failed to decompress ${info.url} (${info.compression}): ${err.message}`,
      );
      if (err instanceof DecoderUnavailable) {
        throw err;
      }
      throw new Error(`${info.compression} decode failed: ${err.message}`);
    }
  });
}

// The bzip2 decoder — crabz2, a Rust one compiled to wasm — fetched
// the first time a boot meets a path the cache still stores that way.
// Nothing else waits on it, and a boot that never meets one never pays
// for it.
//
// Clearing the promise buys a real second attempt at the wasm: the
// glue leaves its instance unset when that fetch fails, so calling
// `default()` again re-fetches. It buys nothing for the module itself,
// since a failed module fetch is recorded in the browser's module map
// and every later `import()` of the same URL rejects from that record
// without going back to the network. Which is another reason the two
// are told apart below rather than retried blindly.
let bzip2Promise;

function bzip2() {
  bzip2Promise ??= import("../vendor/crabz2.js")
    .then(async (module) => {
      await module.default();
      return module;
    })
    .catch((err) => {
      bzip2Promise = undefined;
      throw err;
    });
  return bzip2Promise;
}

// How much of a bzip2 archive is handed to the decoder at a time.
//
// Not a detail: the decoder returns the blocks that finished within a
// push and drops what it has read, so the piece size is what bounds
// how much of the unpacked archive exists inside wasm at once. gcc
// 4.6.3 unpacks to 78 MB, and pushed in 256 KiB pieces it costs the
// decoder 16 MB of wasm memory — pushed whole, 319 MB, which is the
// kind of appetite that already broke the xz path (the note on
// serialising decodes above).
const BZIP2_CHUNK = 256 * 1024;

// Back to the event loop. A decode measured in seconds that never
// returns freezes everything around it: the progress rows stop moving,
// and so does the terminal of a VM that is already up.
const yieldToPage = () => new Promise((resolve) => setTimeout(resolve, 0));

// `narSize` is the unpacked size the cache signed, so the archive is
// written into one buffer allocated before the first block arrives.
// Keeping the blocks and joining them afterwards would hold the whole
// archive twice at the moment of the join, which for gcc's 143 MB NAR
// is 286 MB of JS heap on top of everything already in MEMFS, and
// running out of it is what the note on serialising decodes above is
// about. A narinfo with no NarSize (nix calls that one corrupt) leaves
// the size unknown, and only then are the blocks kept.
async function unbzip2(compressed, narSize) {
  let module;
  try {
    module = await bzip2();
  } catch (err) {
    throw new DecoderUnavailable(
      `the bzip2 decoder could not be loaded: ${err.message}`,
    );
  }

  const decoder = new module.Bz2Decoder();
  const nar = narSize > 0 ? new Uint8Array(narSize) : null;
  const parts = [];
  let filled = 0;

  // One block, either into its place in the buffer or onto the pile.
  // An archive that unpacks past the size the narinfo signed is caught
  // here rather than by writing past the end of the buffer.
  const take = (part) => {
    if (nar === null) {
      parts.push(part);
      filled += part.byteLength;
      return;
    }
    if (filled + part.byteLength > nar.byteLength) {
      throw new Error(`unpacks past the ${narSize} bytes narinfo says`);
    }
    nar.set(part, filled);
    filled += part.byteLength;
  };

  try {
    for (let at = 0; at < compressed.byteLength; at += BZIP2_CHUNK) {
      const part = decoder.push(compressed.subarray(at, at + BZIP2_CHUNK));
      // Nearly every push is bytes going in and nothing coming out.
      // The ones that hand a block back are where the work happened,
      // and the only ones worth yielding after.
      if (part.byteLength > 0) {
        take(part);
        await yieldToPage();
      }
    }
    // Also where a stream that ended early is reported, rather than
    // quietly unpacking to less than it should.
    take(decoder.finish());
  } finally {
    // The decoder holds its wasm buffers until it is dropped. The
    // finalizer gets there eventually; a decode that is about to be
    // followed by another one cannot wait for eventually.
    decoder.free();
  }

  if (nar === null) {
    return concat(parts, filled);
  }
  // A stream that stopped early leaves the tail of the buffer as
  // zeroes, which would reach the hash check as a wrong archive rather
  // than as a short one. Said plainly here instead.
  if (filled !== nar.byteLength) {
    throw new Error(`unpacked to ${filled} bytes, narinfo says ${narSize}`);
  }
  return nar;
}

function concat(parts, total) {
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  return bytes;
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
