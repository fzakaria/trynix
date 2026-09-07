// Tests the translator's instruction semantics against the real CPU.
// The fixture (tests/fixtures/x86/semantics.json, or the path in
// X86_SEMANTICS) was produced by tools/x86-semantics/generate.py, which
// ran every case on this machine's processor. Each case is a snippet,
// a starting register, flag and memory state, and the state the
// hardware left; the translator has to leave the same one.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

import { Machine } from "../../site/js/x86/machine.js";
import { REGISTER_NAMES } from "../../site/js/x86/state.js";

const SNIPPET = 0x601000n;
const SCRATCH = 0x610000;
const SCRATCH_SIZE = 512;
const FLAG_MASK_DF = 1 << 10;

const fixturePath =
  process.env.X86_SEMANTICS ||
  new URL("../fixtures/x86/semantics.json", import.meta.url).pathname;

// The same xorshift as generate.py, so memory comes from the seed.
function scratchBytes(seed) {
  let s = BigInt.asUintN(64, seed);
  if (s === 0n) {
    s = 0x9e3779b97f4a7c15n;
  }
  const out = new Uint8Array(SCRATCH_SIZE);
  const v = new DataView(out.buffer);
  for (let i = 0; i < SCRATCH_SIZE; i += 8) {
    s = BigInt.asUintN(64, s ^ (s << 13n));
    s = s ^ (s >> 7n);
    s = BigInt.asUintN(64, s ^ (s << 17n));
    v.setBigUint64(i, s, true);
  }
  return out;
}

function hex(bytes) {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function runCase(c) {
  const m = new Machine({ pages: 2048 });
  const code = Uint8Array.from(c.code.match(/../g).map((b) => parseInt(b, 16)));
  m.write(SNIPPET, new Uint8Array([...code, 0xf4]));
  const data = c.data
    ? Uint8Array.from(c.data.match(/../g).map((b) => parseInt(b, 16)))
    : scratchBytes(BigInt(`0x${c.seed}`));
  m.write(BigInt(SCRATCH), data);
  m.helpers.load_ymm(SCRATCH);
  REGISTER_NAMES.forEach((r, i) => m.setReg(r, BigInt(`0x${c.regs[i]}`)));
  const flags = Number(BigInt(`0x${c.flags}`));
  m.setReg("cc_op", 0);
  m.setReg("cc_src", BigInt(flags & 0x8d5));
  m.setReg("df", (flags & FLAG_MASK_DF) !== 0 ? 1 : 0);
  m.setReg("fs_base", BigInt(SCRATCH));
  const exit = m.run(SNIPPET);
  assert.equal(exit.reason, "hlt", `${c.name}: stopped with ${exit.reason}`);

  const problems = [];
  REGISTER_NAMES.forEach((r, i) => {
    const got = m.reg(r);
    const want = BigInt(`0x${c.out.regs[i]}`);
    if (got !== want) {
      problems.push(
        `${r}: got ${got.toString(16)}, hardware ${want.toString(16)}`,
      );
    }
  });
  const mask = Number(BigInt(`0x${c.mask}`));
  const gotFlags = m.helpers.cc_eflags() & mask;
  const wantFlags = Number(BigInt(`0x${c.out.flags}`)) & mask;
  if (gotFlags !== wantFlags) {
    problems.push(
      `flags: got ${gotFlags.toString(16)}, hardware ${wantFlags.toString(16)} (mask ${mask.toString(16)})`,
    );
  }
  if (c.out.xmm !== undefined) {
    const at = SCRATCH + 4096;
    m.helpers.save_ymm(at);
    const got = hex(m.read(BigInt(at), 512));
    if (got !== c.out.xmm) {
      for (let i = 0; i < 16; i++) {
        const g = got.slice(64 * i, 64 * i + 64);
        const w = c.out.xmm.slice(64 * i, 64 * i + 64);
        if (g !== w) {
          problems.push(`ymm${i}: got ${g}, hardware ${w}`);
        }
      }
    }
  }
  const wantMem = c.out.mem !== undefined ? c.out.mem : hex(data);
  const gotMem = hex(m.read(BigInt(SCRATCH), SCRATCH_SIZE));
  if (gotMem !== wantMem) {
    for (let i = 0; i < SCRATCH_SIZE * 2; i += 16) {
      if (gotMem.slice(i, i + 16) !== wantMem.slice(i, i + 16)) {
        problems.push(
          `mem+0x${(i / 2).toString(16)}: got ${gotMem.slice(i, i + 16)}, hardware ${wantMem.slice(i, i + 16)}`,
        );
      }
    }
  }
  return problems;
}

if (!existsSync(fixturePath)) {
  test("semantics fixture is present", () => {
    assert.fail(
      `no fixture at ${fixturePath}; run nix run .#x86-semantics -- ${fixturePath}`,
    );
  });
} else {
  const { cases } = JSON.parse(readFileSync(fixturePath, "utf8"));
  const byName = new Map();
  for (const c of cases) {
    if (!byName.has(c.name)) {
      byName.set(c.name, []);
    }
    byName.get(c.name).push(c);
  }
  test(`every form agrees with the hardware (${cases.length} cases)`, () => {
    const failures = [];
    for (const [name, group] of byName) {
      for (const c of group) {
        let problems;
        try {
          problems = runCase(c);
        } catch (e) {
          problems = [`threw ${e.message}`];
        }
        if (problems.length > 0) {
          failures.push(
            `${name} [${c.code}] regs=${c.regs.join(",")} flags=${c.flags}\n    ${problems.join("\n    ")}`,
          );
          break;
        }
      }
    }
    assert.equal(
      failures.length,
      0,
      `${failures.length} of ${byName.size} forms disagree:\n${failures.slice(0, 60).join("\n")}`,
    );
  });
}
