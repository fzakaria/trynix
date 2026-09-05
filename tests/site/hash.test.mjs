// Tests nix's base32 hash encoding, which narinfos use for FileHash and
// NarHash: nix's own alphabet, and the digits taken from the end of the
// string upwards, five bits each. The vector is sha256("hello"), with
// the base32 form produced by `nix hash convert`.
import { test } from "node:test";
import assert from "node:assert/strict";

import { decodeNixBase32, parseHash } from "../../site/js/hash.js";

const HELLO_HEX =
  "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";
const HELLO_NIX32 = "094qif9n4cq4fdg459qzbhg1c6wywawwaaivx0k0x8xhbyx4vwic";

const hex = (bytes) =>
  [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");

test("nix base32 decodes to the bytes nix hashed", () => {
  assert.equal(hex(decodeNixBase32(HELLO_NIX32, 32)), HELLO_HEX);
});

test("a narinfo hash field names its algorithm", () => {
  const parsed = parseHash(`sha256:${HELLO_NIX32}`);
  assert.equal(parsed.algorithm, "sha256");
  assert.equal(hex(parsed.bytes), HELLO_HEX);
});

test("a character outside nix's alphabet is rejected", () => {
  assert.throws(() => decodeNixBase32("e".repeat(52), 32));
});
