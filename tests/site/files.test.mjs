// Tests the files a link names by URL and hash (site/js/files.js): how a
// link's value is read, the store path nix's fetchurl gives the file,
// and fetching it, checked against its hash, through stand-in fetches.
// The store paths were made offline with `nix store add-file` on files
// holding the bytes below, and match `nix-store --print-fixed-path`.
import { test } from "node:test";
import assert from "node:assert/strict";

import { fetchFile, fileInfo, fileOf, nameOf } from "../../site/js/files.js";
import { stubFetch, statusResponse } from "./stub-fetch.mjs";

// No Cache API in node: every call in cache.js degrades to no caching.
globalThis.caches = {
  open: async () => {
    throw new Error("no storage here");
  },
};

// Three files, each with its bytes, its SRI hash and the store path
// `nix store add-file` gave it. The third's hash holds a +, which a
// query string reads as a space.
const DATA = {
  url: "https://example.org/d/data.csv",
  bytes: "a,b\n1,2\n",
  hash: "sha256-SS1epJYFbxpqZZIkEDL6t2TDIVljF5MLT6Dh6Lw7dHA=",
  hex: "492d5ea496056f1a6a6592241032fab764c321596317930b4fa0e1e8bc3b7470",
  storePath: "/nix/store/bwpnrqxq0l114h1d97h9a3aqaf3r69gr-data.csv",
};
const HELLO = {
  url: "https://example.org/hello.txt",
  hash: "sha256-WJG1tSLV3whtD/CxEPvZ0hu0/HFjrzTQgoai6Eb2vgM=",
  storePath: "/nix/store/gy454w1cxaq731grqwylhzf4pp9r5izh-hello.txt",
};
const POINTS = {
  url: "https://example.org/points.csv",
  hash: "sha256-GJvquPfvZ1vtswSZ6voA+cC7hypBbCvUrrji7UdExV0=",
  storePath: "/nix/store/lrw7zql2qcvbmc9bkvywk2vqq7qrcs0m-points.csv",
};

// Checks that a link's value is the URL, a space, and the hash, in the
// SRI form `nix store prefetch-file` prints or nix's own sha256: form.
test("a file is a URL and a hash", () => {
  assert.deepEqual(fileOf(`${DATA.url} ${DATA.hash}`), {
    url: DATA.url,
    hash: DATA.hash,
  });
  assert.deepEqual(fileOf(`  ${DATA.url}   sha256:${DATA.hex} `), {
    url: DATA.url,
    hash: `sha256:${DATA.hex}`,
  });
});

// Checks that a hash typed into a link by hand, whose + the query string
// decoded as a space, is put back together.
test("a + the query string read as a space is put back", () => {
  const typed = `${POINTS.url} ${POINTS.hash.replace("+", " ")}`;
  assert.equal(fileOf(typed).hash, POINTS.hash);
});

// Checks that a value missing either half, or naming a URL fetchurl
// could not name a store path after, is no file.
test("a value that is not a URL and a hash is no file", () => {
  assert.equal(fileOf(DATA.url), null);
  assert.equal(fileOf(`${DATA.url} sha256-short`), null);
  assert.equal(fileOf(`${DATA.url} md5-${"a".repeat(24)}`), null);
  assert.equal(fileOf(`ftp://example.org/data.csv ${DATA.hash}`), null);
  assert.equal(fileOf(`https://example.org/ ${DATA.hash}`), null);
  assert.equal(fileOf(`https://example.org/a%20b.csv ${DATA.hash}`), null);
  assert.equal(fileOf(`https://example.org/.hidden ${DATA.hash}`), null);
});

// Checks that the name is the text after the URL's last slash, query
// string and all, as fetchurl's baseNameOf takes it.
test("the name is the URL's last segment", () => {
  assert.equal(nameOf(DATA.url), "data.csv");
  assert.equal(
    nameOf("https://huggingface.co/o/r/resolve/main/m.gguf?download=true"),
    "m.gguf?download=true",
  );
});

// Checks the store path against `nix store add-file`'s, for each file.
test("the store path is the one nix gives a flat file", async () => {
  for (const file of [DATA, HELLO, POINTS]) {
    const info = await fileInfo({ url: file.url, hash: file.hash });
    assert.equal(info.storePath, file.storePath);
    assert.deepEqual(info.references, []);
  }
  const hex = await fileInfo({ url: DATA.url, hash: `sha256:${DATA.hex}` });
  assert.equal(hex.storePath, DATA.storePath);
});

// Checks that a fetched file whose bytes match its hash is handed back
// as a store path holding one regular file that is not executable,
// with its size told once the bytes are in.
test("a file that matches its hash is one regular file", async (t) => {
  stubFetch(t, [new Response(DATA.bytes)]);
  const info = await fileInfo({ url: DATA.url, hash: DATA.hash });
  const sizes = [];
  const entries = await fetchFile(info, {
    onBytes: () => {},
    onSize: (size) => sizes.push(size),
  });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].path, "");
  assert.equal(entries[0].type, "regular");
  assert.equal(entries[0].executable, false);
  assert.equal(new TextDecoder().decode(entries[0].data), DATA.bytes);
  assert.equal(sizes.at(-1), DATA.bytes.length);
});

// Checks that bytes that do not match the hash never reach the guest,
// and that the message names the URL and the hash the bytes do have.
test("a file that does not match its hash is refused", async (t) => {
  stubFetch(t, [new Response("a,b\n1,3\n")]);
  const info = await fileInfo({ url: DATA.url, hash: DATA.hash });
  await assert.rejects(
    fetchFile(info, { onBytes: () => {} }),
    (err) =>
      err.message.includes(DATA.url) &&
      /sha256-[A-Za-z0-9+/]{43}=/.test(err.message) &&
      err.message.includes(DATA.hash),
  );
});

// Checks that a fetch the browser refuses, as it refuses a host that
// sends no CORS headers, names the URL and says what the host lacks,
// and that a 404 names the URL and the status. Each is tried as often
// as net.js tries any download.
test("a refused fetch and a 404 name the URL", async (t) => {
  const info = await fileInfo({ url: DATA.url, hash: DATA.hash });

  stubFetch(t, Array(4).fill(new TypeError("Failed to fetch")));
  await assert.rejects(
    fetchFile(info, { onBytes: () => {} }),
    (err) =>
      err.message.includes(DATA.url) && err.message.includes("cross-origin"),
  );

  stubFetch(t, Array(4).fill(statusResponse(404)));
  await assert.rejects(
    fetchFile(info, { onBytes: () => {} }),
    (err) =>
      err.message.includes(DATA.url) &&
      err.message.includes("HTTP 404") &&
      !err.message.includes("cross-origin"),
  );
});
