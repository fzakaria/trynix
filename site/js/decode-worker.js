// A worker that decompresses one NAR at a time for the page (store.js
// says why this is not done on the page's own thread; pool.js hands out
// the work).
//
// A classic worker rather than a module, because the two decoders are
// the same vendored UMD scripts the page loads, and importScripts is
// how a worker loads those. The bzip2 decoder is not here: the page
// keeps that one path, which the cache serves only for the oldest
// packages, on its own thread.
/* global importScripts, xzwasm, fzstd */

importScripts("../vendor/xzwasm.js", "../vendor/fzstd.js");

// A copy of store.js's unzstd, which says why the archive goes to the
// decoder in pieces: a module's export is out of reach of a classic
// worker.
const ZSTD_CHUNK = 1024 * 1024;

function unzstd(compressed) {
  const parts = [];
  let total = 0;
  const decoder = new fzstd.Decompress((part) => {
    parts.push(part);
    total += part.byteLength;
  });
  for (let at = 0; at < compressed.byteLength; at += ZSTD_CHUNK) {
    const end = at + ZSTD_CHUNK;
    decoder.push(compressed.subarray(at, end), end >= compressed.byteLength);
  }
  const nar = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    nar.set(part, offset);
    offset += part.byteLength;
  }
  return nar;
}

async function decode(compression, bytes) {
  if (compression === "zstd") {
    return unzstd(bytes);
  }
  const stream = new xzwasm.XzReadableStream(new Response(bytes).body);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

self.onmessage = async ({ data: { id, compression, bytes } }) => {
  try {
    let nar = await decode(compression, bytes);

    // The archive is handed back by giving up its buffer, which only
    // works for an array that is the whole of its buffer; a decoder
    // may return a view into something larger.
    if (nar.byteOffset !== 0 || nar.byteLength !== nar.buffer.byteLength) {
      nar = nar.slice();
    }
    self.postMessage({ id, nar }, [nar.buffer]);
  } catch (err) {
    self.postMessage({ id, error: String(err?.message ?? err) });
  }
};
