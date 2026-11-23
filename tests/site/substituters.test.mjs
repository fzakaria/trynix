// Tests how a narinfo's signature is judged by where it came from
// (site/js/substituters.js). The site's own GL cache is served from the
// page's origin, as the page's JavaScript is, so its narinfos need no
// key; every other cache's must carry a signature from a configured
// key. The narinfos here carry no signature at all, which is what
// tells the two apart.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  readSubstituters,
  SITE_CACHE_URL,
  Trust,
  verify,
} from "../../site/js/substituters.js";
import { CACHE_URL } from "../../site/js/config.js";

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
