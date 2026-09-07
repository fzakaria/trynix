// Tests the x86-64 decoder against binutils. tests/fixtures/x86/oracle.txt
// holds one line per distinct instruction encoding objdump found in real
// store binaries (musl's static hello, glibc's ld.so, libc and libm, and
// libruby), as bytes, Intel mnemonic and operand text. The decoder must
// consume exactly the bytes objdump did and name the instruction as
// objdump does, for every line.
//
// VEX and EVEX encodings, the AVX variants glibc selects by ifunc, are
// checked for length only: the translator presents a CPU without AVX, so
// they are decoded to be stepped over, never run.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { decode } from "../../site/js/x86/decode.js";

const FIXTURE = new URL("../fixtures/x86/oracle.txt", import.meta.url);

// objdump spells a few instructions differently from the Intel manual
// the decoder follows, or folds an operand into the name.
const OBJDUMP_ALIASES = new Map([
  ["movabs", "mov"],
  ["repz", "ret"],
  ["xchg", "xchg"],
  ["sal", "shl"],
  ["fwait", "wait"],
  ["cdqe", "cdqe"],
  ["cqo", "cqo"],
]);

// objdump folds the predicate immediate of cmpps/cmppd/cmpss/cmpsd into
// the name (cmpltsd, cmpnlesd); the decoder keeps it as an operand.
const CMP_PREDICATE = /^cmp(eq|lt|le|unord|neq|nlt|nle|ord)(ps|pd|ss|sd)$/;

function canonical(m) {
  const alias = OBJDUMP_ALIASES.get(m);
  if (alias !== undefined) {
    return alias;
  }
  const predicate = CMP_PREDICATE.exec(m);
  if (predicate) {
    return `cmp${predicate[2]}`;
  }
  return m;
}

function* oracle() {
  const text = readFileSync(FIXTURE, "utf8");
  for (const line of text.split("\n")) {
    if (line === "" || line.startsWith("#")) {
      continue;
    }
    const [hex, mnemonic, ...rest] = line.split(" ");
    const bytes = Uint8Array.from(hex.match(/../g).map((b) => parseInt(b, 16)));
    yield { hex, mnemonic, bytes, text: rest.join(" ") };
  }
}

test("every encoding in the oracle decodes to objdump's length and mnemonic", () => {
  const failures = [];
  let count = 0;
  for (const { hex, mnemonic, bytes, text } of oracle()) {
    count++;
    let insn;
    try {
      insn = decode(bytes, 0, 0x1000n);
    } catch (e) {
      failures.push(`${hex}  ${text}: threw ${e.message}`);
      continue;
    }
    if (insn.len !== bytes.length) {
      failures.push(
        `${hex}  ${text}: length ${insn.len}, objdump ${bytes.length}`,
      );
      continue;
    }
    const lengthOnly =
      (mnemonic.startsWith("v") &&
        mnemonic !== "verr" &&
        mnemonic !== "verw") ||
      mnemonic.startsWith("k");
    if (lengthOnly) {
      continue;
    }
    if (canonical(insn.mnemonic) !== canonical(mnemonic)) {
      failures.push(
        `${hex}  ${text}: mnemonic ${insn.mnemonic}, objdump ${mnemonic}`,
      );
    }
  }
  assert.ok(count > 1000, `oracle has only ${count} lines`);
  assert.equal(
    failures.length,
    0,
    `${failures.length} of ${count} disagree:\n${failures.slice(0, 40).join("\n")}`,
  );
});

test("an operand form: base, index, scale, displacement and rip-relative", () => {
  // mov rax, QWORD PTR [rbx+rcx*8+0x10]
  let insn = decode(Uint8Array.from([0x48, 0x8b, 0x44, 0xcb, 0x10]), 0, 0n);
  assert.equal(insn.mnemonic, "mov");
  assert.equal(insn.operands[0].kind, "reg");
  assert.equal(insn.operands[0].reg, 0);
  assert.equal(insn.operands[0].size, 8);
  assert.deepEqual(
    { ...insn.operands[1], disp: Number(insn.operands[1].disp) },
    {
      kind: "mem",
      size: 8,
      base: 3,
      index: 1,
      scale: 8,
      disp: 16,
      seg: null,
      ripRel: false,
    },
  );
  // lea rdi, [rip+0x1234] at address 0x400000: target is next rip + disp
  insn = decode(
    Uint8Array.from([0x48, 0x8d, 0x3d, 0x34, 0x12, 0x00, 0x00]),
    0,
    0x400000n,
  );
  assert.equal(insn.mnemonic, "lea");
  assert.equal(insn.operands[1].ripRel, true);
  assert.equal(insn.operands[1].disp, 0x400007n + 0x1234n);
  // mov rax, fs:0x28
  insn = decode(
    Uint8Array.from([0x64, 0x48, 0x8b, 0x04, 0x25, 0x28, 0x00, 0x00, 0x00]),
    0,
    0n,
  );
  assert.equal(insn.operands[1].seg, "fs");
  assert.equal(insn.operands[1].base, null);
  assert.equal(insn.operands[1].disp, 0x28n);
});

test("legacy 8-bit high registers and REX low bytes are told apart", () => {
  // mov ah, 1 (b4 01) versus mov spl, 1 (40 b4 01)
  let insn = decode(Uint8Array.from([0xb4, 0x01]), 0, 0n);
  assert.deepEqual(insn.operands[0], {
    kind: "reg",
    reg: 0,
    size: 1,
    high: true,
  });
  insn = decode(Uint8Array.from([0x40, 0xb4, 0x01]), 0, 0n);
  assert.deepEqual(insn.operands[0], {
    kind: "reg",
    reg: 4,
    size: 1,
    high: false,
  });
});

test("immediates are sign-extended to the operand size", () => {
  // add rsp, -8 (48 83 c4 f8)
  let insn = decode(Uint8Array.from([0x48, 0x83, 0xc4, 0xf8]), 0, 0n);
  assert.equal(insn.operands[1].kind, "imm");
  assert.equal(insn.operands[1].value, BigInt.asUintN(64, -8n));
  // mov eax, 0xffffffff
  insn = decode(Uint8Array.from([0xb8, 0xff, 0xff, 0xff, 0xff]), 0, 0n);
  assert.equal(insn.operands[1].value, 0xffffffffn);
  // movabs rax, imm64
  insn = decode(Uint8Array.from([0x48, 0xb8, 1, 2, 3, 4, 5, 6, 7, 8]), 0, 0n);
  assert.equal(insn.operands[1].value, 0x0807060504030201n);
});

test("relative branches carry their absolute target", () => {
  // jmp +5 at 0x1000 -> 0x1007
  let insn = decode(Uint8Array.from([0xeb, 0x05]), 0, 0x1000n);
  assert.equal(insn.mnemonic, "jmp");
  assert.equal(insn.operands[0].kind, "rel");
  assert.equal(insn.operands[0].target, 0x1007n);
  // call -0x10 at 0x1000: e8 eb ff ff ff -> 0x1005 - 0x15 = 0xff0
  insn = decode(Uint8Array.from([0xe8, 0xeb, 0xff, 0xff, 0xff]), 0, 0x1000n);
  assert.equal(insn.operands[0].target, 0xff0n);
  // jne
  insn = decode(
    Uint8Array.from([0x0f, 0x85, 0x00, 0x01, 0x00, 0x00]),
    0,
    0x1000n,
  );
  assert.equal(insn.mnemonic, "jne");
  assert.equal(insn.cond, 5);
});
