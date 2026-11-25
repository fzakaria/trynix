// Tests the site's own GL cache among the substituters
// (site/js/substituters.js): how a narinfo's signature is judged by
// where it came from, and which cache a narinfo is asked of. The site's
// cache is served from the page's origin, as the page's JavaScript is,
// so its narinfos need no key; every other cache's must carry a
// signature from a configured key. The narinfos here carry no signature
// at all, which is what tells the two apart. Lookups run against a fake
// fetch that records every URL asked.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  fetchNarinfo,
  holdsPath,
  readSubstituters,
  setSitePaths,
  SITE_CACHE_URL,
  Trust,
  verify,
} from "../../site/js/substituters.js";
import { CACHE_URL, GL_DRIVERS } from "../../site/js/config.js";

// No Cache API under node: every narinfo lookup goes to fetch.
globalThis.caches = { open: () => Promise.resolve(null) };

const SITE_DIGEST = "y3ihj0ilpkn4ib3rh7y021l3nrvjii97";
const UPSTREAM_DIGEST = "0123456789abcdfghijklmnpqrsvwxyz";

// A narinfo for a digest, as a cache would serve it.
const narinfoText = (digest) =>
  [
    `StorePath: /nix/store/${digest}-example-1.0`,
    `URL: nar/${digest}.nar.xz`,
    "Compression: xz",
    "NarHash: sha256:0000000000000000000000000000000000000000000000000000",
    "NarSize: 1",
    "References: ",
    "",
  ].join("\n");

// Replaces fetch with one that answers the `held` URLs and 404s the
// rest, and returns the URLs asked, in order. With a `manifest` it
// serves that as the site's drivers.json.
function fakeFetch(held, manifest = null) {
  const asked = [];
  globalThis.fetch = async (url) => {
    asked.push(String(url));
    if (manifest !== null && String(url) === GL_DRIVERS) {
      return Response.json(manifest);
    }
    if (!held.has(String(url))) {
      return new Response("", { status: 404 });
    }
    const digest = String(url).split("/").pop().replace(".narinfo", "");
    return new Response(narinfoText(digest));
  };
  return asked;
}

const unsigned = (substituter) => ({
  storePath: "/nix/store/0123456789abcdfghijklmnpqrsvwxyz-mesa-virgl-26.2.2",
  narHash: "sha256:0000000000000000000000000000000000000000000000000000",
  narSize: 1,
  references: [],
  sigs: [],
  substituter,
});

// Checks that the site's cache is among the defaults, after
// cache.nixos.org, and trusted by origin rather than by key.
test("the site's GL cache is a default substituter, trusted as the site", () => {
  const [first, second] = readSubstituters();
  assert.equal(first.url, CACHE_URL);
  assert.equal(second.url, SITE_CACHE_URL);
  assert.equal(second.trust, Trust.SITE);
});

// Checks that an unsigned narinfo from the site's cache passes and one
// from cache.nixos.org does not.
test("an unsigned narinfo passes only when the site served it", async () => {
  const substituters = readSubstituters();
  assert.equal(await verify(unsigned(SITE_CACHE_URL), substituters), true);
  assert.equal(await verify(unsigned(CACHE_URL), substituters), false);
});

// Checks that a page reads the site's manifest before its first lookup,
// so the first lookup of a path only the site holds asks the site and
// finds it: a store path pasted into a page that has just opened. Two
// lookups at once share one read, and a manifest that could not be
// fetched is fetched again by the next lookup rather than kept. Runs
// before any test names the site's paths by hand, as a page that has
// just opened has not.
test("the first lookup reads the site's manifest, once, and again after a failure", async () => {
  const siteUrl = `${SITE_CACHE_URL}/${SITE_DIGEST}.narinfo`;

  // No manifest to be had: the lookup goes on without it, upstream.
  globalThis.fetch = async (url) => {
    if (String(url) === GL_DRIVERS) {
      throw new TypeError("Failed to fetch");
    }
    return new Response("", { status: 404 });
  };
  assert.equal(await holdsPath(SITE_DIGEST, readSubstituters()), false);

  // The next two lookups read it once between them, and ask the site.
  const asked = fakeFetch(new Set([siteUrl]), {
    paths: [`/nix/store/${SITE_DIGEST}-mesa-virgl-26.2.2`],
    drivers: [],
  });
  const [held, found] = await Promise.all([
    holdsPath(SITE_DIGEST, readSubstituters()),
    fetchNarinfo(SITE_DIGEST, readSubstituters()),
  ]);
  assert.equal(held, true);
  assert.equal(found.info.substituter, SITE_CACHE_URL);
  assert.deepEqual(asked, [GL_DRIVERS, siteUrl, siteUrl]);
});

// Checks that a path the site lists is asked of the site alone: no
// request goes to cache.nixos.org, which has never held it and would
// answer with a 404 the reader sees in the console.
test("a path the site lists is fetched from the site without asking upstream", async () => {
  setSitePaths([`/nix/store/${SITE_DIGEST}-mesa-virgl-26.2.2`]);
  const siteUrl = `${SITE_CACHE_URL}/${SITE_DIGEST}.narinfo`;
  const asked = fakeFetch(new Set([siteUrl]));

  const { info } = await fetchNarinfo(SITE_DIGEST, readSubstituters());

  assert.equal(info.substituter, SITE_CACHE_URL);
  assert.deepEqual(asked, [siteUrl]);
});

// Checks that a path the site does not list never costs a request to
// the site, so a path no cache holds 404s once, upstream, not twice.
test("a path the site does not list is never asked of the site", async () => {
  setSitePaths([`/nix/store/${SITE_DIGEST}-mesa-virgl-26.2.2`]);
  const asked = fakeFetch(new Set());

  assert.equal(await holdsPath(UPSTREAM_DIGEST, readSubstituters()), false);

  assert.deepEqual(asked, [`${CACHE_URL}/${UPSTREAM_DIGEST}.narinfo`]);
});

// Checks how a manifest that did not arrive is remembered. A server
// error is passing, so the next call asks again and gets the drivers:
// a 503 once used to leave the page without the site's GL driver until
// a reload. A 404 says the site publishes none, so it is kept and asked
// for once. Each case loads a copy of the module of its own, since a
// page reads its manifest once.
test("a manifest the server failed to send is asked for again, a missing one is not", async () => {
  const drivers = [{ name: "mesa-virgl" }];
  const cases = [
    { first: 503, asked: 2, second: drivers },
    { first: 404, asked: 1, second: [] },
  ];
  for (const { first, asked, second } of cases) {
    const { siteManifest } = await import(
      `../../site/js/substituters.js?first=${first}`
    );
    let requests = 0;
    globalThis.fetch = async (url) => {
      assert.equal(String(url), GL_DRIVERS);
      requests += 1;
      if (requests === 1) {
        return new Response("", { status: first });
      }
      return Response.json({ paths: [], drivers });
    };

    assert.deepEqual((await siteManifest()).drivers, [], `after a ${first}`);
    assert.deepEqual(
      (await siteManifest()).drivers,
      second,
      `the call after a ${first}`,
    );
    assert.equal(requests, asked, `requests after a ${first}`);
  }
});

// Checks that the manifest names the site's Vulkan driver, kwvk with
// trynix's patches, which nix/site.nix adds to the site's cache and to
// the manifest at build time, and that a manifest without one, as the
// file committed under site/gl/ is, names none. Each case loads a copy
// of the module of its own, since a page reads its manifest once.
test("the manifest names the site's Vulkan driver, or none", async () => {
  const driver = `/nix/store/${SITE_DIGEST}-kwvk-0.2.0-261124-75694e2`;
  const cases = [
    {
      name: "built",
      served: { paths: [driver], drivers: [], vulkan: { storePath: driver } },
      want: driver,
    },
    { name: "committed", served: { paths: [], drivers: [] }, want: null },
  ];
  for (const { name, served, want } of cases) {
    const { siteManifest } = await import(
      `../../site/js/substituters.js?vulkan=${name}`
    );
    globalThis.fetch = async (url) => {
      assert.equal(String(url), GL_DRIVERS);
      return Response.json(served);
    };

    assert.equal((await siteManifest()).vulkan, want, name);
  }
});
