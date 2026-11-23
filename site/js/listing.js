// A store path's NAR listing: every file in it, with its type, size and
// executable bit, without the file's bytes.
//
// A binary cache publishes one beside each narinfo, as `<digest>.ls`
// (nix writes it with write-nar-listing=1, and cache.nixos.org has it
// for every path the page has met). It is what lets a lazily served
// store (lazy.js) answer the guest's lookups before a path's NAR is in:
// a stat, a directory listing, a symlink's target, and, the reason it
// exists here, a name that is not there. A dynamic loader looks for
// each library in every directory of its search path in turn, and
// without the listing the page could only answer "not here" for a path
// it had downloaded whole. Only reading a regular file's bytes needs
// the NAR.
//
// cache.nixos.org stores the listings zstd-compressed and serves them
// with `Content-Encoding: zstd` whatever the request accepts, so the
// browser decodes them (Chrome 123 and Firefox 126 do). One the browser
// cannot decode fails like any other: a path without a listing is
// downloaded whole the first time the guest touches it.

import { cachedResponse, storeInCache } from "./cache.js";
import { CACHE_URL, DIGEST_LENGTH } from "./config.js";

// A listing's node types, as the cache writes them.
const Node = Object.freeze({
  DIRECTORY: "directory",
  REGULAR: "regular",
  SYMLINK: "symlink",
});

// The 9p server's names for the same types (unkernel's FsFileType).
const FILE_TYPES = Object.freeze({
  [Node.DIRECTORY]: "dir",
  [Node.REGULAR]: "file",
  [Node.SYMLINK]: "symlink",
});

// What the share's files are once a NAR is written: regular files 0644
// and executables 0755 (share.js and store.js), directories 0755 and
// symlinks 0777 (unkernel's MemoryFs), and a directory 4096 bytes long
// (the MemoryFs again). The listing has to give the same, or the guest
// would see a file change under it when the NAR arrives.
const MODE_FILE = 0o644;
const MODE_EXECUTABLE = 0o755;
const MODE_DIRECTORY = 0o755;
const MODE_SYMLINK = 0o777;
const DIRECTORY_SIZE = 4096;

// How long a listing may take before the page gives up on it and treats
// the path as having none. A listing is a few kilobytes; one that has
// not come in this long is stuck, and the path's NAR is the way on.
const LISTING_TIMEOUT_MS = 10000;

const BIN_DIRECTORY = "bin";

// An error the 9p server answers the guest with as that errno.
function errno(code, message) {
  return Object.assign(new Error(message), { code });
}

// The listing's root node, from the cache's JSON. Throws on anything
// that is not a listing.
export function parseListing(text) {
  const root = JSON.parse(text)?.root;
  if (root === undefined || !Object.hasOwn(FILE_TYPES, root.type)) {
    throw new Error("not a NAR listing");
  }
  return root;
}

// The node at `rest`, a path inside the store path ("" for the path
// itself). A missing name is ENOENT and a name under a file ENOTDIR, as
// the MemoryFs answers once the path is written.
export function nodeAt(root, rest) {
  let node = root;
  for (const name of rest.split("/").filter(Boolean)) {
    if (node.type !== Node.DIRECTORY) {
      throw errno("ENOTDIR", `${rest}: not a directory`);
    }
    const next = node.entries?.[name];
    if (next === undefined || !Object.hasOwn(node.entries, name)) {
      throw errno("ENOENT", `${rest}: no such file or directory`);
    }
    node = next;
  }
  return node;
}

// A node's type, mode and size as the guest's getattr has them. `path`
// is the node's path in the share's file system, and targetOf(path,
// target) is how the share writes a symlink's target there, whose
// length is the link's size.
export function listingAttr(node, path, targetOf) {
  const type = FILE_TYPES[node.type];
  if (node.type === Node.DIRECTORY) {
    return { type, mode: MODE_DIRECTORY, size: DIRECTORY_SIZE };
  }
  if (node.type === Node.SYMLINK) {
    const target = targetOf(path, node.target);
    return {
      type,
      mode: MODE_SYMLINK,
      size: new TextEncoder().encode(target).length,
    };
  }
  return {
    type,
    mode: node.executable === true ? MODE_EXECUTABLE : MODE_FILE,
    size: node.size ?? 0,
  };
}

// A directory node's entries, named and typed for the 9p server.
export function listingEntries(node) {
  if (node.type !== Node.DIRECTORY) {
    throw errno("ENOTDIR", "not a directory");
  }
  return Object.entries(node.entries ?? {}).map(([name, entry]) => ({
    name,
    type: FILE_TYPES[entry.type],
  }));
}

// The guest's type for a store path from its listing's root.
export const rootType = (root) => FILE_TYPES[root.type];

// The programs a listing offers: what a PATH lookup would run under
// bin/, executables and symlinks, the same names store.js's programsOf
// takes from a written NAR.
export function programsOfListing(root) {
  const bin =
    root.type === Node.DIRECTORY ? root.entries?.[BIN_DIRECTORY] : null;
  if (bin === undefined || bin === null || bin.type !== Node.DIRECTORY) {
    return [];
  }
  return Object.entries(bin.entries ?? {})
    .filter(
      ([, entry]) =>
        entry.type === Node.SYMLINK ||
        (entry.type === Node.REGULAR && entry.executable === true),
    )
    .map(([name]) => name);
}

// Where a path's listing is: beside its narinfo, in whichever cache
// served the narinfo.
const listingUrl = (info) =>
  `${info.substituter ?? CACHE_URL}/${info.storePath
    .split("/")
    .at(-1)
    .slice(0, DIGEST_LENGTH)}.ls`;

// Fetch a path's listing, through the persistent cache. Resolves to
// { root, bytes }, bytes being what came over the network (compressed,
// as the cache sent it; none for a copy the browser kept), or to null
// when the cache has no listing; rejects when one cannot be had (the
// network, a body the browser could not decode, a timeout). One
// attempt: the NAR is the fallback, so a retry buys little.
export async function fetchListing(info) {
  const url = listingUrl(info);
  const hit = await cachedResponse(url);
  if (hit !== null) {
    return { root: parseListing(await hit.text()), bytes: 0 };
  }

  const res = await fetch(url, {
    signal: AbortSignal.timeout(LISTING_TIMEOUT_MS),
  });
  if (!res.ok) {
    return null;
  }
  const text = await res.text();
  const root = parseListing(text);
  await storeInCache(url, new TextEncoder().encode(text));
  return { root, bytes: Number(res.headers.get("Content-Length") ?? 0) };
}

// Listings by store path, each fetched once and at most `concurrency` at
// a time, with fetchOne(info) doing the fetch (fetchListing's answer).
// of(info) resolves to the root node, or to null for a path with no
// listing to be had, whatever the reason; the caller's fallback is the
// same either way. count() and bytes() say how many listings arrived
// and what they cost.
export function listingFetcher({ fetchOne, concurrency }) {
  const listings = new Map();
  const waiting = [];
  let running = 0;
  let arrived = 0;
  let bytes = 0;

  // Start queued fetches while there is room.
  function pump() {
    while (running < concurrency && waiting.length > 0) {
      const { info, resolve } = waiting.shift();
      running += 1;

      // Started before this returns, as lazy.js starts a download, so a
      // fetch that throws rather than rejecting fails the same way.
      let fetched;
      try {
        fetched = Promise.resolve(fetchOne(info));
      } catch (err) {
        fetched = Promise.reject(err);
      }
      fetched
        .then(
          (fetchedListing) => {
            if (fetchedListing === null || fetchedListing === undefined) {
              return null;
            }
            arrived += 1;
            bytes += fetchedListing.bytes;
            return fetchedListing.root;
          },
          () => null,
        )
        .then((root) => {
          running -= 1;
          pump();
          resolve(root);
        });
    }
  }

  return {
    of(info) {
      const known = listings.get(info.storePath);
      if (known !== undefined) {
        return known;
      }
      const listing = new Promise((resolve) => {
        waiting.push({ info, resolve });
      });
      listings.set(info.storePath, listing);
      pump();
      return listing;
    },
    count: () => arrived,
    bytes: () => bytes,
  };
}
