// The packages selected into the running guest: at its boot, and by
// the additions since that succeeded (app.js, addToRunningVM).
//
// An addition links the programs of the packages it brings with
// replacement on, so the most recently added package wins a name (the
// page's add note), and a package the guest already had keeps its
// links as they were. So a package is the guest's only once its
// addition is in: an addition whose download failed linked nothing,
// and its retry has to bring the same packages again. Recording them
// as the first try started left the retry bringing none, and the
// version the guest had kept the name.

// The record of one guest's roots, by digest, in the order they came.
export function rootRecord() {
  const digests = [];

  // Record the roots in `rootDigests` not recorded yet.
  function record(rootDigests) {
    for (const digest of rootDigests) {
      if (digests.includes(digest)) {
        continue;
      }
      digests.push(digest);
    }
  }

  return {
    // Record the roots a boot starts the guest with.
    booted: record,

    // Start an addition of `rootDigests`. `roots` are those the guest
    // does not have yet, whose programs take their names. done()
    // records them once the addition is in the guest; an addition that
    // fails is never done, and its roots stay new to the next try.
    adding(rootDigests) {
      const roots = rootDigests.filter((digest) => !digests.includes(digest));
      return {
        roots,
        done: () => record(roots),
      };
    },

    // Every root, in the order the guest got them.
    all: () => [...digests],
  };
}
