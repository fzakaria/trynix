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

// Tests the zstd path against the decoder the site ships: zstd's own
// decoder compiled to wasm (nix/unzstd-wasm.nix), fed in pieces the
// way unzstd.js feeds it. The build generates site/js/unzstd-wasm.js,
// which carries the wasm and sets the global unzstd.js reads, and
// store.js's import of unzstd.js has set globalThis.unzstd. Skipped,
// like the bzip2 tests, where the build has not put that file there.
/* global unzstd */

const unzstdWasm = new URL("../../site/js/unzstd-wasm.js", import.meta.url);
if (existsSync(unzstdWasm)) {
  await import(unzstdWasm.href);
}
const noUnzstd =
  globalThis.UNZSTD_WASM === undefined &&
  "site/js/unzstd-wasm.js is only generated by the nix build";

const zstdFrame = new URL("../fixtures/sample.nar.zst", import.meta.url);

// The fixture's header is 7 bytes: magic, a descriptor saying single
// segment, two-byte content size and no checksum, then its one block,
// which is marked as the last.
const ZSTD_FIXTURE_HEADER = 7;
const ZSTD_SINGLE_SEGMENT = 0x60;

async function zstdFixture() {
  const nar = new Uint8Array(await readFile(narFixture));
  const frame = new Uint8Array(await readFile(zstdFrame));
  assert.equal(frame[4], ZSTD_SINGLE_SEGMENT);
  return { nar, frame, block: frame.subarray(ZSTD_FIXTURE_HEADER) };
}

// zstd's frame magic, little-endian.
const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd];
// A frame descriptor with no content size, no checksum and a window
// descriptor after it.
const ZSTD_WINDOWED = 0x00;
// The smallest window a descriptor can name is 2^10 bytes; the
// exponent sits in the top five bits.
const ZSTD_WINDOW_LOG_BASE = 10;
const ZSTD_WINDOW_EXPONENT_SHIFT = 3;
// The biggest block zstd allows, and a block header's fields: bit 0
// marks the last block, bits 1-2 are the type (0 is raw, stored as
// is), the rest is the size.
const ZSTD_BLOCK_MAX = 128 * 1024;
const ZSTD_BLOCK_HEADER = 3;
const ZSTD_LAST_BLOCK = 1;
const ZSTD_BLOCK_SIZE_SHIFT = 3;

// The header of a frame with no content size and a window of
// 2^windowLog bytes: the magic, the descriptor and the window.
const ZSTD_WINDOWED_HEADER = ZSTD_MAGIC.length + 2;

function zstdHeader(windowLog) {
  const window =
    (windowLog - ZSTD_WINDOW_LOG_BASE) << ZSTD_WINDOW_EXPONENT_SHIFT;
  return [...ZSTD_MAGIC, ZSTD_WINDOWED, window];
}

function rawBlockHeader(size, last) {
  const value = (size << ZSTD_BLOCK_SIZE_SHIFT) | (last ? ZSTD_LAST_BLOCK : 0);
  return [value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff];
}

// A frame under a window of a block that holds `zeroes` zero bytes in
// raw blocks, then `lastBlock` (a whole block, header and all), or,
// with no `lastBlock`, ends at its last raw block. Raw blocks are
// stored rather than compressed, so the frame can be any size without
// carrying a big binary in the tree.
function rawFrame(zeroes, lastBlock) {
  const header = zstdHeader(Math.log2(ZSTD_BLOCK_MAX));
  const tail = lastBlock ?? [];
  const blocks = Math.ceil(zeroes / ZSTD_BLOCK_MAX);
  const frame = new Uint8Array(
    header.length + blocks * ZSTD_BLOCK_HEADER + zeroes + tail.length,
  );
  frame.set(header);
  let at = header.length;
  for (let left = zeroes; left > 0; left -= ZSTD_BLOCK_MAX) {
    const size = Math.min(left, ZSTD_BLOCK_MAX);
    const last = lastBlock === undefined && left <= ZSTD_BLOCK_MAX;
    frame.set(rawBlockHeader(size, last), at);
    at += ZSTD_BLOCK_HEADER + size;
  }
  frame.set(tail, at);
  return frame;
}

// The smallest archive the one-shot fzstd decoder failed on: one frame
// whose first 256 MiB are raw blocks of zeroes, then the fixture's
// compressed block. Raw blocks are copied without bit offsets; the
// compressed block's sequences are where the offsets wrapped.
const PAST_QUARTER_GIB = 2 ** 28;

async function pastQuarterGiB() {
  const { nar, block } = await zstdFixture();
  return {
    nar,
    archive: rawFrame(PAST_QUARTER_GIB, block),
    size: PAST_QUARTER_GIB + nar.byteLength,
  };
}

// 5,000 frames is 1.1 MB, which crosses one piece boundary mid-frame.
// zstd frames concatenate as bzip2 streams do, and what it asserts
// through is NarHash over every copy.
test(
  "a zstd archive longer than one piece unpacks whole",
  { skip: noUnzstd },
  async () => {
    const nar = new Uint8Array(await readFile(narFixture));
    const frame = new Uint8Array(await readFile(zstdFrame));
    const copies = 5000;
    const compressed = new Uint8Array(frame.byteLength * copies);
    const unpacked = new Uint8Array(nar.byteLength * copies);
    for (let i = 0; i < copies; i += 1) {
      compressed.set(frame, i * frame.byteLength);
      unpacked.set(nar, i * nar.byteLength);
    }
    globalThis.fetch = async () => new Response(compressed);

    const info = narinfo(unpacked, {
      compression: "zstd",
      narHash: `sha256:${createHash("sha256").update(unpacked).digest("hex")}`,
    });
    const entries = await fetchNar(info, () => {});
    assert.equal(entries.length > 0, true);
  },
);

// Tests the 256 MiB frame above: it unpacks to the zeroes and then the
// fixture.
test("a zstd frame past 256 MiB unpacks", { skip: noUnzstd }, async () => {
  const { nar, archive, size } = await pastQuarterGiB();

  const out = await unzstd(archive, size);
  assert.equal(out.byteLength, size);
  assert.deepEqual(out.subarray(PAST_QUARTER_GIB), nar);
});

// Tests that the decoder's wasm memory holds about a window and its
// buffers rather than the archive: the 256 MiB frame above has a
// 128 KiB window, and is decoded with WebAssembly.instantiate watched
// so that every instance the decode makes is seen. Each one's memory
// must stay under a sixteenth of what the frame unpacks to.
test(
  "the zstd decoder's wasm memory stays near the window, not the archive",
  { skip: noUnzstd },
  async () => {
    const { archive, size } = await pastQuarterGiB();
    const memories = [];
    const instantiate = WebAssembly.instantiate;
    WebAssembly.instantiate = async (...args) => {
      const made = await instantiate(...args);
      memories.push((made.instance ?? made).exports.memory);
      return made;
    };
    try {
      await unzstd(archive, size);
    } finally {
      WebAssembly.instantiate = instantiate;
    }

    assert.equal(memories.length > 0, true);
    for (const memory of memories) {
      assert.ok(
        memory.buffer.byteLength < size / 16,
        `${memory.buffer.byteLength} bytes of wasm memory for ${size} unpacked`,
      );
    }
  },
);

// Tests a frame header that falls across the boundary between two of
// the 1 MiB pieces unzstd.js hands the decoder. A frame of raw blocks
// is sized so that the fixture's frame after it starts at each offset
// from 8 bytes before a boundary to 1 byte after it, which puts its
// 7-byte header across the boundary in every way it can be; each
// archive must unpack to the zeroes and then the fixture.
test(
  "a zstd frame whose header crosses a piece boundary unpacks",
  { skip: noUnzstd },
  async () => {
    const { nar, frame } = await zstdFixture();
    const piece = 1024 * 1024;
    const overhead = (piece / ZSTD_BLOCK_MAX) * ZSTD_BLOCK_HEADER;
    for (let start = piece - 8; start <= piece + 1; start += 1) {
      const zeroes = start - ZSTD_WINDOWED_HEADER - overhead;
      const first = rawFrame(zeroes);
      assert.equal(first.byteLength, start);
      const archive = new Uint8Array(start + frame.byteLength);
      archive.set(first);
      archive.set(frame, start);

      const out = await unzstd(archive, zeroes + nar.byteLength);
      assert.equal(
        out.subarray(0, zeroes).every((byte) => byte === 0),
        true,
      );
      assert.deepEqual(out.subarray(zeroes), nar);
    }
  },
);

// Tests concatenated frames whose windows grow. The decoder's memory
// is sized from each frame's header, so a frame that needs a bigger
// window than the frames before it must get the room rather than
// fail. The fixture's frame, whose window is its own 904 bytes, is
// followed by its block again under a 1 MiB window.
test(
  "a zstd frame with a bigger window than the one before unpacks",
  { skip: noUnzstd },
  async () => {
    const { nar, frame, block } = await zstdFixture();
    const header = zstdHeader(20);
    const archive = new Uint8Array(
      frame.byteLength + header.length + block.byteLength,
    );
    archive.set(frame);
    archive.set(header, frame.byteLength);
    archive.set(block, frame.byteLength + header.length);

    const out = await unzstd(archive, 2 * nar.byteLength);
    assert.deepEqual(out.subarray(0, nar.byteLength), nar);
    assert.deepEqual(out.subarray(nar.byteLength), nar);
  },
);

// Tests zstd's default limit on a frame's window, 128 MiB, which is
// also what the zstd command enforces without --memory. A window of
// exactly 128 MiB unpacks; one of 256 MiB is refused, by a message
// that gives both sizes. Each frame is the fixture's block under a
// header naming that window.
test(
  "a zstd frame with a 128 MiB window unpacks",
  { skip: noUnzstd },
  async () => {
    const { nar, block } = await zstdFixture();
    const header = zstdHeader(27);
    const archive = new Uint8Array(header.length + block.byteLength);
    archive.set(header);
    archive.set(block, header.length);

    assert.deepEqual(await unzstd(archive, nar.byteLength), nar);
  },
);

test(
  "a zstd frame with a window past 128 MiB is refused",
  { skip: noUnzstd },
  async () => {
    const { nar, block } = await zstdFixture();
    const header = zstdHeader(28);
    const archive = new Uint8Array(header.length + block.byteLength);
    archive.set(header);
    archive.set(block, header.length);

    await assert.rejects(
      () => unzstd(archive, nar.byteLength),
      /frame needs a 268435456-byte window, past the 134217728-byte limit/,
    );
  },
);

// Tests an archive that ends partway through a frame, as a download
// cut short does. The decoder runs out of input with the frame
// unfinished, and says so, rather than leaving it to the size check
// to report a short archive. The fixture's frame is decoded without
// its last byte, against the fixture's full size.
test("a zstd archive cut short is refused", { skip: noUnzstd }, async () => {
  const { nar, frame } = await zstdFixture();

  await assert.rejects(
    () => unzstd(frame.subarray(0, frame.byteLength - 1), nar.byteLength),
    /archive ends partway through a frame/,
  );
});

// Tests that a zstd archive is held to the size its narinfo signed
// while it unpacks, as a bzip2 one is. unzstd writes each piece into a
// buffer of that size, so an archive that runs past it is stopped at
// the piece that would overflow the buffer, and one that stops short
// is reported as short rather than reaching the hash check as a wrong
// archive. Each test decodes the fixture's one frame against a size
// one byte off.
test(
  "a zstd archive that unpacks past its signed size is refused",
  { skip: noUnzstd },
  async () => {
    const nar = new Uint8Array(await readFile(narFixture));
    const frame = new Uint8Array(await readFile(zstdFrame));

    await assert.rejects(
      () => unzstd(frame, nar.byteLength - 1),
      new RegExp(`unpacks past the ${nar.byteLength - 1} bytes narinfo says`),
    );
  },
);

test(
  "a zstd archive that unpacks short of its signed size is refused",
  { skip: noUnzstd },
  async () => {
    const nar = new Uint8Array(await readFile(narFixture));
    const frame = new Uint8Array(await readFile(zstdFrame));

    await assert.rejects(
      () => unzstd(frame, nar.byteLength + 1),
      new RegExp(
        `unpacked to ${nar.byteLength} bytes, narinfo says ${nar.byteLength + 1}`,
      ),
    );
  },
);

// Tests an archive whose narinfo gives no NarSize, which unzstd cannot
// size a buffer for: it unpacks whole all the same, into a buffer
// sized once the last piece is out. The fixture's one frame is decoded
// with no size and compared with the unpacked fixture.
test(
  "a zstd archive with no signed size unpacks whole",
  { skip: noUnzstd },
  async () => {
    const nar = new Uint8Array(await readFile(narFixture));
    const frame = new Uint8Array(await readFile(zstdFrame));

    assert.deepEqual(await unzstd(frame, undefined), nar);
  },
);

// Tests the same with an archive that unpacks to more than one piece
// of output. The pieces come out of one buffer in the decoder's wasm
// memory, which the next piece overwrites, so each must be kept as a
// copy; kept as views, they would all show the last piece. 5,000
// copies of the fixture's frame unpack to 4.5 MB.
test(
  "a zstd archive with no signed size unpacks whole across pieces",
  { skip: noUnzstd },
  async () => {
    const { nar, frame } = await zstdFixture();
    const copies = 5000;
    const compressed = new Uint8Array(frame.byteLength * copies);
    const unpacked = new Uint8Array(nar.byteLength * copies);
    for (let i = 0; i < copies; i += 1) {
      compressed.set(frame, i * frame.byteLength);
      unpacked.set(nar, i * nar.byteLength);
    }

    assert.deepEqual(await unzstd(compressed, undefined), unpacked);
  },
);

// Checks a package whose bin is a symlink to a directory inside it, as
// openjdk's is (bin -> lib/openjdk/bin): its programs are what that
// directory holds, reached through bin. A bin that points out of the
// package, or at nothing in it, has no programs.
test("a bin that links to a directory inside the package has its programs", () => {
  const entries = [
    { path: "", type: "directory" },
    { path: "bin", type: "symlink", target: "lib/openjdk/bin" },
    { path: "lib", type: "directory" },
    { path: "lib/openjdk", type: "directory" },
    { path: "lib/openjdk/bin", type: "directory" },
    {
      path: "lib/openjdk/bin/java",
      type: "regular",
      executable: true,
      data: new Uint8Array(),
    },
    { path: "lib/openjdk/bin/jar", type: "symlink", target: "java" },
    {
      path: "lib/openjdk/bin/README",
      type: "regular",
      executable: false,
      data: new Uint8Array(),
    },
  ];
  assert.deepEqual(programsOf(entries), ["java", "jar"]);

  const outward = [
    { path: "", type: "directory" },
    { path: "bin", type: "symlink", target: "/nix/store/x-other/bin" },
  ];
  assert.deepEqual(programsOf(outward), []);
});
