// Unpacks a zstd NAR, for store.js on the page and for the decode
// workers (decode-worker.js).
//
// The decoder is zstd's own, the reference C implementation compiled
// to wasm (wasm/unzstd/unzstd.c, built by nix/unzstd-wasm.nix). It
// replaced fzstd, a decoder written in JavaScript, which took four
// times as long: on firefox's NAR, 103 MB of zstd that unpacks to
// 402 MB, fzstd took 3.7 s in Chromium and 3.1 s in Firefox, and this
// takes 0.8 s and 0.9 s. Downloads are lazy, so the guest waits on each
// archive's decode as well as its download.
//
// A classic script rather than a module, so that both can load it:
// the decode workers are classic workers and load it with
// importScripts, and store.js imports it for what it sets. Either way
// the one function lands on globalThis as `unzstd`.
//
// The wasm arrives the same way, in unzstd-wasm.js, a classic script
// the build generates beside this one: it sets UNZSTD_WASM to the
// module's bytes in base64. A script rather than a .wasm file, because
// a .wasm file has to be fetched by URL, and this file cannot name its
// own: store.js imports it as a module, where a classic script has no
// import.meta, and in a worker every relative URL is the worker's. As
// a file under js/, it is part of the hash site.nix names js/ after,
// so a deploy never pairs this file with an older decoder.
//
// The archive goes to the decoder in pieces, and what it unpacks comes
// back in pieces, each copied straight into the buffer the archive
// ends up in. The decoder's wasm memory holds the pieces and one
// frame's window, never the archive: firefox's NAR, whose window is
// 8 MiB, takes about 10 MiB of it.

// The module, compiled once per thread on its first decode.
let decoderModule = null;

function compiledDecoder() {
  if (decoderModule !== null) {
    return decoderModule;
  }
  if (typeof globalThis.UNZSTD_WASM !== "string") {
    throw new Error("the zstd decoder is not loaded (unzstd-wasm.js)");
  }

  const bytes = Uint8Array.from(atob(globalThis.UNZSTD_WASM), (char) =>
    char.charCodeAt(0),
  );
  decoderModule = WebAssembly.compile(bytes);
  return decoderModule;
}

// The C string the decoder left at `address` in its memory.
function decoderString(memory, address) {
  const bytes = new Uint8Array(memory.buffer, address);
  return new TextDecoder().decode(bytes.subarray(0, bytes.indexOf(0)));
}

// `narSize` is the unpacked size the cache signed, so each piece goes
// straight into its place in a buffer of that size, as unbzip2 in
// store.js does. Gathering the pieces and joining them at the end
// would hold the archive twice at the peak, which for wesnoth is
// another 605 MB. A narinfo without the size gets the gathering.
globalThis.unzstd = async function unzstd(compressed, narSize) {
  // A fresh instance for each archive, so its memory, which grows to
  // the biggest window the archive's frames ask for, goes with it.
  const decoder = (await WebAssembly.instantiate(await compiledDecoder()))
    .exports;
  const { memory } = decoder;
  const input = decoder.unzstd_input();
  const output = decoder.unzstd_output();
  const capacity = decoder.unzstd_input_capacity();

  const nar = narSize > 0 ? new Uint8Array(narSize) : null;
  const parts = [];
  let filled = 0;

  // One piece of output, either into its place in the buffer or onto
  // the pile. The decoder overwrites its output buffer on the next
  // call, so the pile keeps copies. An archive that unpacks past the
  // size the narinfo signed is caught here rather than by writing past
  // the end of the buffer.
  const take = (length) => {
    const part = new Uint8Array(memory.buffer, output, length);
    if (nar === null) {
      parts.push(part.slice());
      filled += length;
      return;
    }
    if (filled + length > nar.byteLength) {
      throw new Error(`unpacks past the ${narSize} bytes narinfo says`);
    }
    nar.set(part, filled);
    filled += length;
  };

  // Where in the archive the decoder's current piece starts, and its
  // length. The first call finds no piece and asks for one.
  let start = 0;
  let length = 0;
  for (;;) {
    const unpacked = decoder.unzstd_decode();
    if (unpacked < 0) {
      throw new Error(decoderString(memory, decoder.unzstd_message()));
    }
    if (unpacked > 0) {
      take(unpacked);
    }
    if (!decoder.unzstd_wants_input()) {
      continue;
    }

    // The archive is used up once a piece has reached its end.
    if (start + length >= compressed.byteLength) {
      break;
    }

    // The next piece starts at the first byte the decoder has not
    // consumed. That is the end of the last piece, except where a
    // frame's header ran past it: the decoder reads a header whole.
    start += decoder.unzstd_consumed();
    length = Math.min(capacity, compressed.byteLength - start);
    new Uint8Array(memory.buffer, input, length).set(
      compressed.subarray(start, start + length),
    );
    decoder.unzstd_feed(length);
  }

  // A download cut short ends in the middle of a frame, and is said to
  // rather than left to look like a short archive.
  if (!decoder.unzstd_finished()) {
    throw new Error("the archive ends partway through a frame");
  }

  if (nar === null) {
    const whole = new Uint8Array(filled);
    let offset = 0;
    for (const part of parts) {
      whole.set(part, offset);
      offset += part.byteLength;
    }
    return whole;
  }
  // A stream that stopped early leaves the tail of the buffer as
  // zeroes, which would reach the hash check as a wrong archive rather
  // than as a short one. Said plainly here instead.
  if (filled !== nar.byteLength) {
    throw new Error(`unpacked to ${filled} bytes, narinfo says ${narSize}`);
  }
  return nar;
};
