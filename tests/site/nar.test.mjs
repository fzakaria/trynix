// Tests the NAR parser against a fixture produced by `nix nar pack` on
// a tree holding every node type: a regular file, an executable, a
// symlink and a nested directory. The fixture is bytes nix itself wrote,
// so the parser is held to the real format, not to a re-implementation.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { parseNar } from "../../site/js/nar.js";

const fixture = new URL("../fixtures/sample.nar", import.meta.url);

test("parseNar walks every node type in archive order", async () => {
  const bytes = new Uint8Array(await readFile(fixture));
  const entries = parseNar(bytes);

  const byPath = new Map(entries.map((e) => [e.path, e]));

  assert.equal(byPath.get("").type, "directory");
  assert.equal(byPath.get("sub").type, "directory");

  const file = byPath.get("file.txt");
  assert.equal(file.type, "regular");
  assert.equal(file.executable, false);
  assert.equal(new TextDecoder().decode(file.data), "hello world\n");

  const script = byPath.get("sub/run.sh");
  assert.equal(script.type, "regular");
  assert.equal(script.executable, true);

  const link = byPath.get("sub/link");
  assert.equal(link.type, "symlink");
  assert.equal(link.target, "../file.txt");

  // Directories come before their children, so MEMFS mkdir works in
  // entry order.
  const dirIndex = entries.findIndex((e) => e.path === "sub");
  const childIndex = entries.findIndex((e) => e.path === "sub/run.sh");
  assert.ok(dirIndex < childIndex);
});

test("parseNar rejects a corrupt magic", () => {
  const bogus = new Uint8Array(32);
  assert.throws(() => parseNar(bogus), /bad NAR/);
});
