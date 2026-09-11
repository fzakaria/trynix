// Tests symlink target resolution, which decides whether a package can
// find its own libraries in the guest. A relative NAR target has to
// become an absolute path before it reaches emscripten's filesystem:
// FS.readlink returns an absolute path but stat keeps the relative
// target's length, and the guest's 9p client trusts the length.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { absoluteTarget } from "../../site/js/store.js";

const LIB = "/share/nix/store/abc-zlib-1.3.2/lib";

test("a sibling target resolves against the link's own directory", () => {
  assert.equal(
    absoluteTarget(`${LIB}/libz.so.1`, "libz.so.1.3.2"),
    `${LIB}/libz.so.1.3.2`,
  );
});

test("a target that walks up resolves the .. segments", () => {
  assert.equal(
    absoluteTarget(`${LIB}/pkgconfig/z.pc`, "../libz.so"),
    `${LIB}/libz.so`,
  );
  assert.equal(absoluteTarget(`${LIB}/a/b/c`, "./d"), `${LIB}/a/b/d`);
});

test("an absolute target is left alone: it names a store path", () => {
  const target = "/nix/store/xyz-hello-2.12.2/bin/hello";
  assert.equal(absoluteTarget(`${LIB}/hello`, target), target);
});

// Tests which entries of a NAR count as programs: the files under bin/
// that a PATH lookup would run. They become the symlinks in the
// guest's /share/bin, so a data file or a nested directory must not
// be offered as a command.
import { programsOf } from "../../site/js/store.js";

test("executables and symlinks directly under bin/ are programs", () => {
  const entries = [
    { path: "", type: "directory" },
    { path: "bin", type: "directory" },
    {
      path: "bin/rg",
      type: "regular",
      executable: true,
      data: new Uint8Array(),
    },
    { path: "bin/python", type: "symlink", target: "python3.10" },
    {
      path: "bin/README",
      type: "regular",
      executable: false,
      data: new Uint8Array(),
    },
    { path: "bin/sub", type: "directory" },
    {
      path: "bin/sub/tool",
      type: "regular",
      executable: true,
      data: new Uint8Array(),
    },
    {
      path: "lib/libz.so",
      type: "regular",
      executable: true,
      data: new Uint8Array(),
    },
  ];
  assert.deepEqual(programsOf(entries), ["rg", "python"]);
});

test("a package without a bin directory has no programs", () => {
  assert.deepEqual(programsOf([{ path: "", type: "directory" }]), []);
});

// Tests which of a narinfo's promises may fail a boot.
//
// A narinfo describes the same path twice. FileSize and FileHash
// describe the compressed file the cache happens to be serving; NarSize
// and NarHash describe the archive inside it. Only the second pair is in
// the fingerprint a cache signs, and a cache that recompresses a NAR
// changes the first pair without touching the bytes anyone vouched for:
// cache.nixos.org did exactly that to glibc-2.40-224, whose narinfo
// still says 9096823 bytes for a file it serves 9099653 of, while its
// NarHash matches to the byte. Refusing that path rejects content that
// is provably genuine, on the one field no signature covers.
//
// These drive fetchNar against a stubbed fetch, serving the NAR fixture
// uncompressed, because the claim is about what does and does not abort
// a download rather than about either check in isolation.
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { fetchNar } from "../../site/js/store.js";

// No Cache API in node: every call in cache.js degrades to no caching.
globalThis.caches = {
  open: async () => {
    throw new Error("no storage here");
  },
};

const narFixture = new URL("../fixtures/sample.nar", import.meta.url);

async function servedNar() {
  const bytes = new Uint8Array(await readFile(narFixture));
  let served = 0;
  globalThis.fetch = async () => {
    served += 1;
    return new Response(bytes);
  };
  return {
    bytes,
    sha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    fetches: () => served,
  };
}

function narinfo(bytes, overrides) {
  return {
    storePath: "/nix/store/abc-sample",
    url: "nar/sample.nar",
    compression: "none",
    substituter: "https://cache.example.org",
    narSize: bytes.byteLength,
    ...overrides,
  };
}

test("a recompressed NAR still boots: FileSize and FileHash are unsigned", async () => {
  const nar = await servedNar();
  const info = narinfo(nar.bytes, {
    // What cache.nixos.org says about glibc: both compressed fields
    // stale, both signed fields exact.
    fileSize: nar.bytes.byteLength + 2830,
    fileHash: `sha256:${"a".repeat(64)}`,
    narHash: nar.sha256,
  });

  const entries = await fetchNar(info, () => {});
  assert.equal(entries.length > 0, true);
  assert.equal(nar.fetches(), 1);
});

test("a NAR whose signed hash is wrong is refused", async () => {
  const nar = await servedNar();
  const info = narinfo(nar.bytes, { narHash: `sha256:${"b".repeat(64)}` });

  await assert.rejects(() => fetchNar(info, () => {}), /sha256 does not match/);
});

test("a NAR whose signed size is wrong is refused", async () => {
  const nar = await servedNar();
  const info = narinfo(nar.bytes, {
    narSize: nar.bytes.byteLength + 1,
    narHash: nar.sha256,
  });

  await assert.rejects(() => fetchNar(info, () => {}), /narinfo says/);
});

test("a NAR compressed with something nothing here reads is refused", async () => {
  const nar = await servedNar();
  const info = narinfo(nar.bytes, {
    compression: "lzip",
    narHash: nar.sha256,
  });

  await assert.rejects(
    () => fetchNar(info, () => {}),
    /unsupported NAR compression "lzip"/,
  );
  // Refused before the download rather than after it: the bytes would
  // be unusable, and a boot that cannot finish should not spend the
  // reader's bandwidth finding out.
  assert.equal(nar.fetches(), 0);
});

// Tests the bzip2 path against the vendored decoder itself, because it
// is the one decoder the page does not load: it is imported the first
// time a boot meets a path the cache still stores that way (store.js),
// and an import path that goes wrong has nothing else to catch it.
// What it asserts through is NarHash, the field a cache signs — a
// decoder that hands back plausible nonsense fails here the same way it
// would fail a boot.
//
// site/vendor is assembled by the nix build (nix/vendor.nix), so a bare
// `node --test` in a checkout skips these rather than failing. The skip
// turns on the file being absent and nothing else: a decoder that is
// there and will not import is the failure these tests exist to catch,
// and catching it as a skip is how the whole bzip2 path ends up green
// and unexercised.
const vendored = new URL("../../site/vendor/crabz2.js", import.meta.url);
const crabz2 = existsSync(vendored) ? await import(vendored.href) : null;

// The unpacked fixture, and the sha256 the narinfo in these tests
// signs over whatever number of copies of it an archive holds.
async function bzip2Fixture(copies) {
  const nar = new Uint8Array(await readFile(narFixture));
  const stream = new Uint8Array(
    await readFile(new URL("../fixtures/sample.nar.bz2", import.meta.url)),
  );

  const compressed = new Uint8Array(stream.byteLength * copies);
  const unpacked = new Uint8Array(nar.byteLength * copies);
  for (let i = 0; i < copies; i += 1) {
    compressed.set(stream, i * stream.byteLength);
    unpacked.set(nar, i * nar.byteLength);
  }

  // node's fetch cannot read the file: URL the wasm-bindgen glue
  // builds from import.meta.url, so the decoder is initialised here
  // from bytes; store.js finds it already initialised.
  await crabz2.default({
    module_or_path: await readFile(
      new URL("../../site/vendor/crabz2_bg.wasm", import.meta.url),
    ),
  });
  globalThis.fetch = async () => new Response(compressed);

  return narinfo(unpacked, {
    compression: "bzip2",
    narHash: `sha256:${createHash("sha256").update(unpacked).digest("hex")}`,
  });
}

test(
  "a bzip2 NAR unpacks to what the narinfo signed",
  {
    skip: crabz2 === null && "site/vendor is only assembled by the nix build",
  },
  async () => {
    const entries = await fetchNar(await bzip2Fixture(1), () => {});
    assert.equal(entries.length > 0, true);
  },
);

// Tests the decoder being fed in pieces, which is the part of the
// bzip2 path with somewhere to go wrong. store.js hands the archive
// over BZIP2_CHUNK bytes at a time to bound how much of it sits in
// wasm memory at once, and the fixture above is 256 bytes: one piece,
// one block back, so the advance through the archive and the
// assembling of several blocks never run at all.
//
// An archive longer than a chunk is built by repeating the fixture
// rather than by carrying a big binary in the tree, since bzip2
// streams concatenate and the decoder reads them one after another.
// 1,400 copies is 350 KB, which crosses one 256 KB boundary. What it
// asserts through is NarHash over every copy, so a decode that loses
// or repeats a block between pieces fails here.
test(
  "a bzip2 archive longer than one chunk unpacks whole",
  {
    skip: crabz2 === null && "site/vendor is only assembled by the nix build",
  },
  async () => {
    const entries = await fetchNar(await bzip2Fixture(1400), () => {});
    assert.equal(entries.length > 0, true);
  },
);
