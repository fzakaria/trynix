// Page diffs, the unit a keyframe of the unkernel guest is stored in.
//
// A keyframe is the guest's whole memory at one moment (scrub.js says
// when those moments are). Stored whole, a 512 MiB guest would cost
// tens of megabytes a keyframe even compressed. Between two shell
// prompts only a few hundred 4 KiB pages change (docs/scrub.md has the
// counts), so a keyframe is stored as the pages that differ from the
// one before it.
//
// The page keeps a shadow: a copy of the memory as of the latest
// keyframe. Taking the next keyframe compares the live memory against
// the shadow, copies each page that differs out, and writes it into
// the shadow, so the shadow is the new keyframe once the diff is done.
// The comparison runs while the kernel is parked, so its cost is the
// guest's pause; it reads only the pages the kernel has in use.

export const PAGE_SIZE = 4096;
const WORDS_PER_PAGE = PAGE_SIZE / Int32Array.BYTES_PER_ELEMENT;
const BITS_PER_BYTE = 8;

// The memory as 32-bit words. Words rather than bytes for speed, and
// integers rather than floats because a float comparison calls +0 and
// -0 equal and every NaN unequal.
const wordsOf = (memory) =>
  new Int32Array(
    memory.buffer,
    memory.byteOffset,
    memory.byteLength / Int32Array.BYTES_PER_ELEMENT,
  );

// Whether page `page` is set in a free-page bitmap: bit i of byte
// i / 8, as the kernel reports it at the snapshot point.
const isFree = (free, page) =>
  (free[page >> 3] & (1 << (page & (BITS_PER_BYTE - 1)))) !== 0;

// Whether two pages of the two word views differ.
function differs(a, b, page) {
  const end = (page + 1) * WORDS_PER_PAGE;
  for (let word = page * WORDS_PER_PAGE; word < end; word++) {
    if (a[word] !== b[word]) {
      return true;
    }
  }
  return false;
}

// Compare `live` against `shadow` page by page and bring the shadow up
// to date.
//
// `written` has a byte per page, set where the shadow page may hold
// something other than zeros; it is how a page that stays free costs
// nothing. `free` is the kernel's bitmap of free pages over the first
// `freePages` pages, or absent: a free page counts as zero whatever it
// still holds, which is what the SDK's own snapshot does too.
//
// Returns the pages that now hold new bytes (`changed`, ascending,
// with their bytes back to back in `data`), the pages that went back
// to zero (`zeroed`), and how many bytes of free pages were left out.
export function capturePages({
  live,
  shadow,
  written,
  free = null,
  freePages = 0,
}) {
  const pageCount = live.byteLength / PAGE_SIZE;
  const liveWords = wordsOf(live);
  const shadowWords = wordsOf(shadow);
  const covered = free === null ? 0 : Math.min(freePages, pageCount);

  const changed = [];
  const zeroed = [];
  let freeCount = 0;

  for (let page = 0; page < pageCount; page++) {
    // A free page is zero in the keyframe. It costs a write only when
    // the shadow had something there.
    if (page < covered && isFree(free, page)) {
      freeCount++;
      if (written[page] === 0) {
        continue;
      }
      shadow.fill(0, page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
      written[page] = 0;
      zeroed.push(page);
      continue;
    }

    // A page in use is compared; one that differs is copied into the
    // shadow at once, so the shadow is the new keyframe afterwards.
    if (!differs(liveWords, shadowWords, page)) {
      continue;
    }
    const start = page * PAGE_SIZE;
    shadow.set(live.subarray(start, start + PAGE_SIZE), start);
    written[page] = 1;
    changed.push(page);
  }

  // The changed pages' bytes, copied out of the shadow so the next
  // diff can move the shadow on while these are compressed.
  const data = new Uint8Array(changed.length * PAGE_SIZE);
  changed.forEach((page, index) => {
    const start = page * PAGE_SIZE;
    data.set(shadow.subarray(start, start + PAGE_SIZE), index * PAGE_SIZE);
  });

  return {
    changed: Uint32Array.from(changed),
    zeroed: Uint32Array.from(zeroed),
    data,
    freeBytes: freeCount * PAGE_SIZE,
  };
}

// Put one page into the shadow: `bytes` (PAGE_SIZE of them), or zeros
// when `bytes` is null. A restore moves the shadow to an older keyframe
// this way, one page at a time.
export function writePage(shadow, written, page, bytes) {
  const start = page * PAGE_SIZE;
  if (bytes === null) {
    shadow.fill(0, start, start + PAGE_SIZE);
    written[page] = 0;
    return;
  }
  shadow.set(bytes, start);
  written[page] = 1;
}
