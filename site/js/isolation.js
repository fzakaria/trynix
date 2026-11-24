// Whether this page load is cross-origin isolated, and when it is not,
// whether it is about to be, and what a link's boot=1 does about it.
//
// trynix.dev is served by GitHub Pages, which cannot send COOP/COEP
// headers, so site/index.html loads coi-serviceworker.js, a service
// worker that adds them to every response it serves. A load no worker
// controls yet is not isolated: the shim registers the worker and then
// reloads the page, and the reloaded page is isolated. A load a worker
// already controls and that is still not isolated is never reloaded,
// since the browser ignored the headers and would ignore them again.

export const Isolation = Object.freeze({
  // SharedArrayBuffer is there: the qemu engine's threads and the
  // unkernel guest's CPU workers can run.
  ISOLATED: "isolated",
  // Not yet: the shim is registering its worker and will reload the
  // page. A worker that fails to register leaves the page here for
  // good, which the page cannot tell from a slow registration.
  RELOADING: "reloading",
  // Not, and no reload is coming.
  NEVER: "never",
});

// The isolation of a page load, from what the browser says about it,
// by the shim's own tests for whether it registers and reloads:
// `crossOriginIsolated` and `isSecureContext` as the window has them,
// and `serviceWorker`, navigator.serviceWorker or undefined. Read once
// per load, since a worker that takes control of the page later does
// not isolate it.
export function isolationOf({
  crossOriginIsolated,
  isSecureContext,
  serviceWorker,
}) {
  if (crossOriginIsolated === true) {
    return Isolation.ISOLATED;
  }

  // The shim gives up on a browser with no notion of isolation, on a
  // page that is not a secure context, and where no service worker can
  // register (a private window, in some browsers).
  if (
    crossOriginIsolated !== false ||
    !isSecureContext ||
    serviceWorker === undefined
  ) {
    return Isolation.NEVER;
  }

  // A worker controls the load and the browser still did not isolate
  // it: another load would come out the same.
  if (serviceWorker.controller) {
    return Isolation.NEVER;
  }
  return Isolation.RELOADING;
}

// What the page does with a link's boot=1 once the link is restored.
export const LinkBoot = Object.freeze({
  // Nothing: the link did not ask, or none of its packages could be
  // selected.
  NONE: "none",
  // Boot now. On a page that is never isolated the boot says what it
  // lacks (the qemu engine) or runs on one CPU (unkernel).
  NOW: "now",
  // Leave boot=1 in the address and boot on the page the shim's reload
  // opens. A boot started here would be cut short by that reload, and
  // the reload would open an address the boot had already taken boot=1
  // out of.
  AFTER_RELOAD: "after reload",
});

// The LinkBoot for a link that `asked` for a boot, with `selected`
// paths restored, on a load of `isolation`.
export function linkBootOf({ asked, selected, isolation }) {
  if (!asked || selected === 0) {
    return LinkBoot.NONE;
  }
  if (isolation === Isolation.RELOADING) {
    return LinkBoot.AFTER_RELOAD;
  }
  return LinkBoot.NOW;
}
