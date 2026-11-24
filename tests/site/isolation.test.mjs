// Tests what the page makes of its cross-origin isolation, and what it
// does with a link's boot=1 because of it. Both are pure functions of
// what the browser reports, so each test hands them the facts a
// browser would.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  Isolation,
  isolationOf,
  LinkBoot,
  linkBootOf,
} from "../../site/js/isolation.js";

// A page no worker controls yet, on a secure page in a browser that has
// service workers: the shim's first-visit case.
const FIRST_VISIT = {
  crossOriginIsolated: false,
  isSecureContext: true,
  serviceWorker: { controller: null },
};

// Checks that an isolated page is isolated, whatever else is true.
test("an isolated page is isolated", () => {
  assert.equal(
    isolationOf({ ...FIRST_VISIT, crossOriginIsolated: true }),
    Isolation.ISOLATED,
  );
});

// Checks that a page no worker controls yet is about to be reloaded by
// the shim, which is what a first visit to trynix.dev is.
test("a first visit is about to reload", () => {
  assert.equal(isolationOf(FIRST_VISIT), Isolation.RELOADING);
});

// Checks the pages the shim never reloads, as its own checks decide:
// a worker already controls the page and the browser still did not
// isolate it, the page is not a secure context, the browser has no
// service workers (a private window, in some), or the browser has no
// notion of isolation at all.
test("a page the shim cannot isolate is never isolated", () => {
  const never = [
    { ...FIRST_VISIT, serviceWorker: { controller: {} } },
    { ...FIRST_VISIT, isSecureContext: false },
    { ...FIRST_VISIT, serviceWorker: undefined },
    { ...FIRST_VISIT, crossOriginIsolated: undefined },
  ];
  for (const page of never) {
    assert.equal(isolationOf(page), Isolation.NEVER);
  }
});

// Checks that a link's boot=1 starts the boot at once on a page that is
// isolated, or never will be (where the boot says what it lacks), and
// waits for the shim's reload on a page about to be reloaded, which
// would cut a boot short.
test("a link's boot waits only for a reload that is coming", () => {
  const asked = { asked: true, selected: 1 };
  assert.equal(
    linkBootOf({ ...asked, isolation: Isolation.ISOLATED }),
    LinkBoot.NOW,
  );
  assert.equal(
    linkBootOf({ ...asked, isolation: Isolation.NEVER }),
    LinkBoot.NOW,
  );
  assert.equal(
    linkBootOf({ ...asked, isolation: Isolation.RELOADING }),
    LinkBoot.AFTER_RELOAD,
  );
});

// Checks that there is no boot to start for a link without boot=1, or
// for one whose packages the page could not select.
test("a link's boot needs boot=1 and something selected", () => {
  for (const isolation of Object.values(Isolation)) {
    assert.equal(
      linkBootOf({ asked: false, selected: 1, isolation }),
      LinkBoot.NONE,
    );
    assert.equal(
      linkBootOf({ asked: true, selected: 0, isolation }),
      LinkBoot.NONE,
    );
  }
});
