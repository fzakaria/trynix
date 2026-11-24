// Unpacks a zstd NAR, for store.js on the page and for the decode
// workers (decode-worker.js).
//
// A classic script rather than a module, so that both can load it:
// the decode workers are classic workers and load it with
// importScripts, and store.js imports it for what it sets. Either way
// the one function lands on globalThis as `unzstd`, next to the fzstd
// global it calls, which the page and the workers load first.
//
// The archive goes to fzstd's streaming decoder in pieces, and not to
// its one-shot decompress(). That one works out bit offsets into its
// whole input with 32-bit arithmetic, so past 256 MiB of compressed
// archive they wrap and a sound archive fails as "invalid zstd data":
// wesnoth 1.18.8's is 405 MiB. The streaming decoder only offsets into
// the piece it was handed plus at most one unfinished block, so fed in
// pieces it reads an archive of any size.
/* global fzstd */

// How much of a zstd archive is handed to the decoder at a time.
const ZSTD_CHUNK = 1024 * 1024;

// `narSize` is the unpacked size the cache signed, so each block goes
// straight into its place in a buffer of that size, as unbzip2 in
// store.js does. Gathering the blocks and joining them at the end would
// hold the archive twice at the peak, which for wesnoth is another
// 605 MB. A narinfo without the size gets the gathering.
globalThis.unzstd = function unzstd(compressed, narSize) {
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

  const decoder = new fzstd.Decompress(take);
  for (let at = 0; at < compressed.byteLength; at += ZSTD_CHUNK) {
    const end = at + ZSTD_CHUNK;
    decoder.push(compressed.subarray(at, end), end >= compressed.byteLength);
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
