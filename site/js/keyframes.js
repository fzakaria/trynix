// The keyframes of one unkernel guest: what the scrubber goes back to.
//
// A keyframe is the guest's memory at one moment, plus the few
// hundred bytes of device state the SDK's snapshot carries beside the
// memory (its `meta` here). The memory is kept as page diffs
// (pages.js): each keyframe holds the pages that differ from its
// parent's, compressed, and the store holds one full copy, the shadow,
// which is the memory of the keyframe the guest last left (`current`).
//
// Keyframes form a tree. Going back to a keyframe and carrying on from
// there gives the next keyframe that one as its parent, beside the
// keyframes that came after it the first time, so the old future is a
// branch that can still be gone to.
//
// Going to a keyframe moves the shadow there. Only the pages some
// keyframe between the two changed can differ, so those are the pages
// rewritten, each taken from the nearest keyframe on the way up from
// the target that holds it. Going back three commands decompresses
// three commands' worth of pages, whatever the session's length.
//
// A keyframe's pages are compressed in chunks of CHUNK_PAGES, so that
// going back for a few pages of a big keyframe (the one after a 200 MiB
// download, say) inflates the chunks holding them and not the whole
// keyframe.
//
// Compressed pages are held in memory up to `memoryCap` bytes. Past
// the cap the oldest keyframes' pages go to `spill` (IndexedDB on the
// page, spill.js) and are read back when a move needs them.

import { capturePages, PAGE_SIZE, writePage } from "./pages.js";

// What the compressed pages of all keyframes may take in memory before
// the oldest move to the spill target.
export const DEFAULT_MEMORY_CAP = 128 * 1024 * 1024;

// Pages per compressed chunk: 1 MiB of them, big enough that deflate
// has something to work with and small enough that one page costs
// little to get back.
export const CHUNK_PAGES = 256;
const CHUNK_BYTES = CHUNK_PAGES * PAGE_SIZE;

// The compression the pages are stored with, as the browser (and
// Node) provide it: no library, and the work happens off the
// JavaScript heap.
const FORMAT = "deflate-raw";

async function transform(stream, bytes) {
  const piped = new Blob([bytes]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(piped).arrayBuffer());
}

export const deflateCodec = Object.freeze({
  compress: (bytes) => transform(new CompressionStream(FORMAT), bytes),
  decompress: (bytes) => transform(new DecompressionStream(FORMAT), bytes),
});

export class KeyframeStore {
  // `bytes` is the size of the guest's memory.
  constructor({
    bytes,
    memoryCap = DEFAULT_MEMORY_CAP,
    spill = null,
    codec = deflateCodec,
    log = () => {},
  }) {
    this.shadow = new Uint8Array(bytes);
    this.written = new Uint8Array(bytes / PAGE_SIZE);
    this.memoryCap = memoryCap;
    this.spill = spill;
    this.codec = codec;
    this.log = log;

    this.current = null;
    this.byId = new Map();
    this.nextId = 1;
    this.pending = new Set();
    this.inMemoryBytes = 0;
    this.spilling = false;
  }

  // Take a keyframe of `live`, the guest's memory, as a child of the
  // current one, and make it current. Called at the snapshot point
  // (scrub.js), so this is the guest's pause: the diff, and a copy of
  // the pages that changed. Compression happens afterwards.
  //
  // `free` and `freePages` are the kernel's free-page bitmap, as
  // capturePages takes them. Returns the keyframe's id; describe() is
  // called once the snapshot it belongs to completes.
  capture({ live, free = null, freePages = 0 }) {
    const diff = capturePages({
      live,
      shadow: this.shadow,
      written: this.written,
      free,
      freePages,
    });

    const frame = {
      id: this.nextId++,
      parent: this.current,
      meta: null,
      changed: diff.changed,
      zeroed: diff.zeroed,
      freeBytes: diff.freeBytes,
      // The pages' bytes until they are compressed, then null.
      raw: diff.data,
      // The compressed chunks, once compressed: { blob, spilled,
      // storedBytes }, blob null once spilled.
      chunks: null,
      pageCount: diff.changed.length + diff.zeroed.length,
      rawBytes: diff.data.byteLength,
      storedBytes: 0,
    };
    this.byId.set(frame.id, frame);
    this.current = frame.id;
    this.track(this.compress(frame));
    return frame.id;
  }

  // Attach the rest of a keyframe's snapshot: everything the SDK's
  // KernelSnapshot carries but the memory. A keyframe whose snapshot
  // failed after the capture is never described, and cannot be gone
  // to, but its pages stay part of the history.
  describe(id, meta) {
    const frame = this.byId.get(id);
    if (frame !== undefined) {
      frame.meta = meta;
    }
  }

  frame(id) {
    return this.byId.get(id);
  }

  frames() {
    return [...this.byId.values()];
  }

  // Move the shadow to keyframe `id` and make it current. Resolves to
  // the memory (the shadow itself, which createKernel copies) and the
  // keyframe's meta, which together are the snapshot to restore.
  async moveTo(id) {
    const target = this.byId.get(id);
    if (target === undefined) {
      throw new Error(`keyframe ${id}: no such keyframe`);
    }
    if (target.meta === null) {
      throw new Error(`keyframe ${id}: no snapshot was completed there`);
    }
    if (id === this.current) {
      return { memory: this.shadow, meta: target.meta };
    }

    // The pages any keyframe between the two changed: those above
    // their common ancestor on either side.
    const targetChain = this.chain(id);
    const onTargetChain = new Set(targetChain.map((frame) => frame.id));
    const need = new Set();
    for (const frame of this.chain(this.current)) {
      if (onTargetChain.has(frame.id)) {
        break;
      }
      addPages(need, frame);
    }
    const common = this.chain(this.current).find((frame) =>
      onTargetChain.has(frame.id),
    );
    for (const frame of targetChain) {
      if (frame === common) {
        break;
      }
      addPages(need, frame);
    }

    // Each needed page as of the target: the nearest keyframe at or
    // above the target that wrote it. A page none of them wrote was
    // never anything but zero.
    const sources = new Map();
    let unresolved = need.size;
    for (const frame of targetChain) {
      if (unresolved === 0) {
        break;
      }
      frame.zeroed.forEach((page) => {
        if (need.has(page) && !sources.has(page)) {
          sources.set(page, { frame, index: -1 });
          unresolved--;
        }
      });
      frame.changed.forEach((page, index) => {
        if (need.has(page) && !sources.has(page)) {
          sources.set(page, { frame, index });
          unresolved--;
        }
      });
    }

    // Read each chunk the pages come from once, then write them.
    const chunksRead = new Map();
    for (const { frame, index } of sources.values()) {
      const key = chunkKey(frame.id, Math.floor(index / CHUNK_PAGES));
      if (index >= 0 && !chunksRead.has(key)) {
        chunksRead.set(key, await this.chunk(frame, index));
      }
    }
    for (const page of need) {
      const source = sources.get(page);
      if (source === undefined || source.index < 0) {
        writePage(this.shadow, this.written, page, null);
        continue;
      }
      const { frame, index } = source;
      const data = chunksRead.get(
        chunkKey(frame.id, Math.floor(index / CHUNK_PAGES)),
      );
      const start = (index % CHUNK_PAGES) * PAGE_SIZE;
      writePage(
        this.shadow,
        this.written,
        page,
        data.subarray(start, start + PAGE_SIZE),
      );
    }

    this.current = id;
    return { memory: this.shadow, meta: target.meta };
  }

  // The keyframe and its ancestors, nearest first.
  chain(id) {
    const frames = [];
    for (let at = id; at !== null; at = this.byId.get(at).parent) {
      frames.push(this.byId.get(at));
    }
    return frames;
  }

  // The chunk of a keyframe's changed pages that holds page `index`
  // of them, back to back, from wherever it is.
  async chunk(frame, index) {
    const number = Math.floor(index / CHUNK_PAGES);
    if (frame.raw !== null) {
      return frame.raw.subarray(
        number * CHUNK_BYTES,
        (number + 1) * CHUNK_BYTES,
      );
    }
    const chunk = frame.chunks[number];
    const blob = chunk.spilled
      ? await this.spill.get(chunkKey(frame.id, number))
      : chunk.blob;
    return this.codec.decompress(blob);
  }

  async compress(frame) {
    const chunks = [];
    for (let start = 0; start < frame.rawBytes; start += CHUNK_BYTES) {
      const blob = await this.codec.compress(
        frame.raw.subarray(start, start + CHUNK_BYTES),
      );
      chunks.push({ blob, spilled: false, storedBytes: blob.byteLength });
    }
    frame.chunks = chunks;
    frame.storedBytes = chunks.reduce((sum, c) => sum + c.storedBytes, 0);
    frame.raw = null;
    this.inMemoryBytes += frame.storedBytes;
    await this.enforceCap();
  }

  // Move the oldest keyframes' pages to the spill target until what is
  // left in memory fits the cap. A spill target that fails is given
  // up on, and the pages stay in memory: going back still works, the
  // tab just holds more.
  async enforceCap() {
    if (this.spill === null || this.spilling) {
      return;
    }
    this.spilling = true;
    try {
      for (const frame of this.byId.values()) {
        for (const [number, chunk] of (frame.chunks ?? []).entries()) {
          if (this.inMemoryBytes <= this.memoryCap) {
            return;
          }
          if (chunk.spilled) {
            continue;
          }
          await this.spill.put(chunkKey(frame.id, number), chunk.blob);
          chunk.spilled = true;
          chunk.blob = null;
          this.inMemoryBytes -= chunk.storedBytes;
        }
      }
    } catch (err) {
      this.log(`keyframes stay in memory: spilling failed (${err.message})`);
      this.spill = null;
    } finally {
      this.spilling = false;
    }
  }

  track(promise) {
    this.pending.add(promise);
    promise
      .catch((err) => this.log(`keyframe compression failed: ${err.message}`))
      .finally(() => this.pending.delete(promise));
  }

  // Resolves once every keyframe taken so far is compressed and the
  // cap is enforced.
  async settled() {
    while (this.pending.size > 0) {
      await Promise.allSettled([...this.pending]);
    }
  }

  stats() {
    let rawBytes = 0;
    let storedBytes = 0;
    let spilledBytes = 0;
    for (const frame of this.byId.values()) {
      rawBytes += frame.rawBytes;
      storedBytes += frame.storedBytes;
      for (const chunk of frame.chunks ?? []) {
        if (chunk.spilled) {
          spilledBytes += chunk.storedBytes;
        }
      }
    }
    return {
      frames: this.byId.size,
      rawBytes,
      storedBytes,
      inMemoryBytes: this.inMemoryBytes,
      spilledBytes,
    };
  }

  // Forget every keyframe, spilled ones included.
  async clear() {
    await this.settled();
    const spilled = this.frames().flatMap((frame) =>
      (frame.chunks ?? [])
        .map((chunk, number) =>
          chunk.spilled ? chunkKey(frame.id, number) : null,
        )
        .filter((key) => key !== null),
    );
    this.byId.clear();
    this.current = null;
    this.inMemoryBytes = 0;
    this.shadow.fill(0);
    this.written.fill(0);
    await Promise.all(
      spilled.map((key) => this.spill?.delete(key).catch(() => {})),
    );
  }
}

const chunkKey = (id, number) => `keyframe-${id}-${number}`;

function addPages(set, frame) {
  frame.changed.forEach((page) => set.add(page));
  frame.zeroed.forEach((page) => set.add(page));
}
