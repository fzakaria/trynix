// Files a link names by URL and hash (url.js, `file`), which the guest
// sees at the store path nix's fetchurl gives them.
//
// `pkgs.fetchurl { url; hash; }` with a sha256 makes a flat
// fixed-output path: one regular file, not executable, whose store path
// follows from the hash and the name alone. `nix store prefetch-file
// <url>` prints that path and the SRI hash a link carries. The page
// fetches the file itself with the browser's fetch, so the host has to
// allow cross-origin reads, and checks the bytes against the hash before
// the guest sees any of them. The file then joins the lazy store like
// any path of the closure (lazy.js): listed in /nix/store from the boot
// and fetched on first use, or before the shell with downloads set to
// all.
//
// The trust is an extra binary cache's (url.js, `cache`): the link
// already makes the browser fetch from hosts it names, and the hash pins
// the content.

import { evictFromCache } from "./cache.js";
import { encodeNixBase32, parseHash } from "./hash.js";
import { fetchWithProgress } from "./net.js";

const STORE_DIR = "/nix/store";

// The schemes a file is fetched by.
const FILE_PROTOCOLS = ["http:", "https:"];

// A sha256 as SRI writes it, the form `nix store prefetch-file` prints,
// and as nix writes it, in hex, nix base32 or base64 after the colon.
const SRI_PREFIX = "sha256-";
const NIX_PREFIX = "sha256:";

// What a store path's name may hold (nix's checkName): letters, digits
// and +-._?=, at most 211 of them, not starting with a dot.
const NAME_PATTERN = /^[A-Za-z0-9+\-._?=]+$/;
const NAME_MAX_LENGTH = 211;
const HIDDEN_PREFIX = ".";

// How many bytes of a sha256 a store path's digest keeps, folded.
const DIGEST_BYTES = 20;

// The guest's type for a file's store path before it is fetched
// (lazy.js, typeHint).
const FILE_TYPE = "file";

const HEX_RADIX = 16;
const HEX_DIGITS_PER_BYTE = 2;

// The name fetchurl gives a URL's file: the text after its last slash,
// query string and all, as nix's baseNameOf takes it.
export const nameOf = (url) => url.slice(url.lastIndexOf("/") + 1);

// Whether nix takes `name` as a store path's name.
const isStoreName = (name) =>
  NAME_PATTERN.test(name) &&
  name.length <= NAME_MAX_LENGTH &&
  !name.startsWith(HIDDEN_PREFIX);

// The sha256 a hash names, as bytes, or null when it names none.
function sha256Of(hash) {
  const field = hash.startsWith(SRI_PREFIX)
    ? `${NIX_PREFIX}${hash.slice(SRI_PREFIX.length)}`
    : hash;
  if (!field.startsWith(NIX_PREFIX)) {
    return null;
  }
  try {
    return parseHash(field).bytes;
  } catch {
    return null;
  }
}

// A file as a link writes it, "<url> <hash>", as { url, hash }, or null
// when the value is not one: no http or https URL, no sha256, or a URL
// whose last segment nix would not take as a store path's name.
//
// A URL holds no space, so everything after the first space is the
// hash. A hash typed into a link by hand keeps its + raw, and the query
// string reads that as a space, so the spaces go back to +.
export function fileOf(value) {
  const [url, ...rest] = String(value ?? "")
    .trim()
    .split(/\s+/);
  const hash = rest.join("+");
  if (sha256Of(hash) === null || !isStoreName(nameOf(url))) {
    return null;
  }

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (!FILE_PROTOCOLS.includes(parsed.protocol)) {
    return null;
  }
  return { url, hash };
}

const hexOf = (bytes) =>
  [...bytes]
    .map((byte) => byte.toString(HEX_RADIX).padStart(HEX_DIGITS_PER_BYTE, "0"))
    .join("");

const sriOf = (bytes) => `${SRI_PREFIX}${btoa(String.fromCharCode(...bytes))}`;

// The sha256 of `data`, a string or bytes.
async function sha256(data) {
  const bytes =
    typeof data === "string" ? new TextEncoder().encode(data) : data;
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
}

// `bytes` XOR-folded down to `size` bytes, as nix's compressHash does.
function fold(bytes, size) {
  const folded = new Uint8Array(size);
  bytes.forEach((byte, i) => {
    folded[i % size] ^= byte;
  });
  return folded;
}

// The store path nix gives a flat file whose sha256 is `digest`, named
// `name` (makeFixedOutputPath): the sha256 of "fixed:out:sha256:<hex>:",
// then makeStorePath("output:out", that, name), which is the sha256 of
// "output:out:sha256:<its hex>:/nix/store:<name>", folded to 20 bytes
// and written in nix base32.
async function storePathOf(digest, name) {
  const inner = await sha256(`fixed:out:sha256:${hexOf(digest)}:`);
  const outer = await sha256(
    `output:out:sha256:${hexOf(inner)}:${STORE_DIR}:${name}`,
  );
  return `${STORE_DIR}/${encodeNixBase32(fold(outer, DIGEST_BYTES))}-${name}`;
}

// The store path a file joins the guest's store at, in the shape the
// lazy store takes a narinfo (lazy.js): no references, and a size of 0
// until its download says (fetchFile, onSize). `file` is what fetchFile
// fetches and checks, and `typeHint` lists the path as a file before it
// is fetched.
export async function fileInfo({ url, hash }) {
  return {
    storePath: await storePathOf(sha256Of(hash), nameOf(url)),
    references: [],
    fileSize: 0,
    narSize: 0,
    typeHint: FILE_TYPE,
    file: { url, hash },
  };
}

// Fetch a file through the persistent cache (net.js), check it against
// its hash, and hand it back as a store path's entries (nar.js's shape):
// one regular file that is not executable. onBytes hears chunk sizes as
// they arrive, onCacheRead what net.js reports, and onSize the file's
// size, from the response's Content-Length when it has one and again
// once the bytes are in.
//
// A refused fetch, an HTTP error and bytes that do not match each
// reject with a message that names the URL. Bytes that do not match are
// dropped from the cache first.
export async function fetchFile(
  info,
  { onBytes, onCacheRead, onSize = () => {} },
) {
  const { url, hash } = info.file;

  // A fetch with no response at all is what a host that sends no CORS
  // headers gets, so the message says what the host has to allow.
  let bytes;
  try {
    bytes = await fetchWithProgress(url, {
      onBytes,
      onCacheRead,
      onTotal: (total) => {
        if (total !== null) {
          onSize(total);
        }
      },
    });
  } catch (err) {
    if (err.cause instanceof TypeError) {
      throw new Error(
        `${err.message}; a file's host has to allow cross-origin reads`,
      );
    }
    throw err;
  }
  onSize(bytes.byteLength);

  // The bytes against the hash the link pins them to.
  const digest = await sha256(bytes);
  const expected = sha256Of(hash);
  if (!digest.every((byte, i) => byte === expected[i])) {
    await evictFromCache(url);
    throw new Error(`${url}: its sha256 is ${sriOf(digest)}, not ${hash}`);
  }
  return [{ path: "", type: "regular", executable: false, data: bytes }];
}
