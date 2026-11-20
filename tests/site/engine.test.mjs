// Tests which engine a page load runs on, and how a store path built
// for the other engine's machine is recognised. Both are pure functions
// of what the link says and what the bytes say, so they are called
// directly with made-up links and hand-built ELF headers.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  chooseEngine,
  elfSystem,
  Engine,
  foreignSystem,
  systemOf,
} from "../../site/js/engine.js";

// Checks that a link naming an engine gets that engine, whatever else
// the link holds and whatever the browser can do.
test("an engine named in the link is the engine", () => {
  assert.equal(
    chooseEngine({ requested: "qemu", hasStorePath: false, jspi: true }),
    Engine.QEMU,
  );
  assert.equal(
    chooseEngine({ requested: "unkernel", hasStorePath: true, jspi: false }),
    Engine.UNKERNEL,
  );
});

// Checks the default: unkernel wherever the browser can suspend wasm,
// qemu where it cannot.
test("a link naming no engine gets unkernel where the browser has JSPI", () => {
  assert.equal(
    chooseEngine({ requested: null, hasStorePath: false, jspi: true }),
    Engine.UNKERNEL,
  );
  assert.equal(
    chooseEngine({ requested: null, hasStorePath: false, jspi: false }),
    Engine.QEMU,
  );
});

// Checks that a name that is not an engine is treated as no name.
test("an unknown engine name is ignored", () => {
  assert.equal(
    chooseEngine({ requested: "bochs", hasStorePath: false, jspi: true }),
    Engine.UNKERNEL,
  );
});

// Checks the rule that keeps old links working: a store path with no
// engine beside it was written when qemu was the only engine.
test("a store path with no engine beside it runs on qemu", () => {
  assert.equal(
    chooseEngine({ requested: null, hasStorePath: true, jspi: true }),
    Engine.QEMU,
  );
});

// Checks each engine's system, the name the multiverse files its data
// under.
test("each engine boots one system", () => {
  assert.equal(systemOf(Engine.UNKERNEL), "aarch64-linux");
  assert.equal(systemOf(Engine.QEMU), "x86_64-linux");
});

// An ELF header with e_machine set, little-endian, and nothing else a
// reader here looks at.
function elfHeader(machine) {
  const bytes = new Uint8Array(64);
  bytes.set([0x7f, 0x45, 0x4c, 0x46]);
  bytes[18] = machine & 0xff;
  bytes[19] = machine >> 8;
  return bytes;
}

const EM_X86_64 = 62;
const EM_AARCH64 = 183;
const EM_RISCV = 243;

// Checks that the machine field of an ELF header is read as a system,
// and that anything else reads as no answer.
test("an ELF header names the system the file was built for", () => {
  assert.equal(elfSystem(elfHeader(EM_X86_64)), "x86_64-linux");
  assert.equal(elfSystem(elfHeader(EM_AARCH64)), "aarch64-linux");
  assert.equal(elfSystem(elfHeader(EM_RISCV)), null);
  assert.equal(elfSystem(new TextEncoder().encode("#!/bin/sh\n")), null);
  assert.equal(elfSystem(new Uint8Array(4)), null);
});

const program = (path, data) => ({
  path,
  type: "regular",
  executable: true,
  data,
});

// Checks that a package's programs are compared with the system the
// engine runs, and that scripts and data files do not vote.
test("a package built for another system is named", () => {
  const entries = [
    { path: "", type: "directory" },
    { path: "bin", type: "directory" },
    program("bin/wrapper", new TextEncoder().encode("#!/bin/sh\n")),
    program("bin/tool", elfHeader(EM_X86_64)),
    {
      path: "share/data",
      type: "regular",
      executable: false,
      data: elfHeader(EM_RISCV),
    },
  ];
  assert.equal(foreignSystem(entries, "aarch64-linux"), "x86_64-linux");
  assert.equal(foreignSystem(entries, "x86_64-linux"), null);
});

// Checks that a package with no ELF program at all is not refused.
test("a package with no ELF program is nobody's foreigner", () => {
  const entries = [
    program("bin/script", new TextEncoder().encode("#!/usr/bin/env python3\n")),
  ];
  assert.equal(foreignSystem(entries, "aarch64-linux"), null);
});
