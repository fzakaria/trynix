// Where keyframes go once the ones in memory pass their cap
// (keyframes.js): an IndexedDB database of their compressed pages.
//
// Each guest gets a database of its own, named with a random suffix,
// and deletes it when the page goes away. A page that closed without
// deleting its own (a crash, a killed tab) leaves one behind, so a new
// guest asks for every older one to be deleted too. A database another
// open tab still uses is not deleted under it: the deletion waits until
// that tab closes its connection.

const PREFIX = "trynix-keyframes-";
const STORE = "pages";
const VERSION = 1;

const request = (req) =>
  new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

// Ask for every keyframe database but `keep` to be deleted, without
// waiting for the deletions: some wait on other tabs.
async function sweep(keep) {
  if (typeof indexedDB.databases !== "function") {
    return;
  }
  for (const { name } of await indexedDB.databases()) {
    if (name?.startsWith(PREFIX) && name !== keep) {
      indexedDB.deleteDatabase(name);
    }
  }
}

// A spill target for KeyframeStore, or null where IndexedDB is missing
// or refuses (a private window in some browsers), in which case the
// keyframes stay in memory.
export async function indexedDbSpill() {
  if (typeof indexedDB === "undefined") {
    return null;
  }
  const name = `${PREFIX}${Date.now()}-${Math.random().toString(36).slice(2)}`;
  try {
    const open = indexedDB.open(name, VERSION);
    open.onupgradeneeded = () => open.result.createObjectStore(STORE);
    const db = await request(open);
    sweep(name).catch(() => {});

    const tx = (mode) => db.transaction(STORE, mode).objectStore(STORE);
    return {
      put: (key, bytes) => request(tx("readwrite").put(bytes, key)),
      get: (key) => request(tx("readonly").get(key)),
      delete: (key) => request(tx("readwrite").delete(key)),
      // Close the database and delete it, when the guest is gone.
      destroy() {
        db.close();
        indexedDB.deleteDatabase(name);
      },
    };
  } catch {
    return null;
  }
}
