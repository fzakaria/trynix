// Tests the translator end to end: a few hand-assembled x86-64 programs
// are placed in a Machine's memory, run through translation into wasm,
// and the register state afterwards is compared with what the hardware
// would leave. The bytes come from `as` on the assembly in each comment
// (Intel syntax), so a disagreement is traceable to one instruction.
import { test } from "node:test";
import assert from "node:assert/strict";

import { Machine, ProcessExit } from "../../site/js/x86/machine.js";

const CODE = 0x400000n;

function hex(s) {
  return Uint8Array.from(s.match(/../g).map((b) => parseInt(b, 16)));
}

function boot(program) {
  const m = new Machine({ pages: 2048 });
  m.write(CODE, hex(program));
  return m;
}

test("straight-line arithmetic reaches hlt", () => {
  // mov rax, 1; add rax, 2; hlt
  const m = boot("48c7c0010000004883c002f4");
  const exit = m.run(CODE);
  assert.equal(exit.reason, "hlt");
  assert.equal(m.reg("rax"), 3n);
});

test("a counted loop with a conditional branch", () => {
  // mov ecx, 10; xor eax, eax; 1: add eax, ecx; dec ecx; jnz 1b; hlt
  const m = boot("b90a00000031c001c8ffc975faf4");
  m.run(CODE);
  assert.equal(m.reg("rax"), 55n);
  assert.equal(m.reg("rcx"), 0n);
});

test("subtraction, comparison and setcc through the lazy flags", () => {
  // mov rax, -1; mov ebx, 5; sub rbx, rax; cmp rbx, 6; sete al; movzx eax, al; hlt
  const m = boot("48c7c0ffffffffbb050000004829c34883fb060f94c00fb6c0f4");
  m.run(CODE);
  assert.equal(m.reg("rbx"), 6n);
  assert.equal(m.reg("rax"), 1n);
});

test("call and ret through the guest stack", () => {
  // lea rsp, [rip+0x100000]; mov rdi, 7; call 1f; hlt
  // 1: lea rax, [rdi*2+1]; ret
  const m = boot("488d250000100048c7c707000000e801000000f4488d047d01000000c3");
  const exit = m.run(CODE);
  assert.equal(exit.reason, "hlt");
  assert.equal(m.reg("rax"), 15n);
  assert.equal(m.reg("rsp"), CODE + 7n + 0x100000n);
});

test("push, pop and imul inside a callee", () => {
  // lea rsp, [rip+0x100000]; mov rdi, 3; mov rsi, 4; call 1f; hlt
  // 1: push rbx; mov rbx, rdi; imul rbx, rsi; mov rax, rbx; pop rbx; ret
  const m = boot("488d250000100048c7c70300000048c7c604000000e801000000f4534889fb480fafde4889d85bc3");
  m.setReg("rbx", 0x1111n);
  m.run(CODE);
  assert.equal(m.reg("rax"), 12n);
  assert.equal(m.reg("rbx"), 0x1111n);
});

test("an indirect jump goes through the block lookup", () => {
  // mov rcx, 0x400000; jmp rcx   -- at 0x400100, jumping to a hlt at 0x400000
  const m = boot("f4");
  m.write(CODE + 0x100n, hex("48c7c100004000ffe1"));
  const exit = m.run(CODE + 0x100n);
  assert.equal(exit.reason, "hlt");
  assert.equal(exit.rip, CODE);
});

test("loads and stores of every width", () => {
  // mov rax, 0x123456789abcdef0; mov [0x501000], rax; mov ebx, [0x501004]
  // mov cx, [0x501000]; mov dl, [0x501007]; movsx rsi, byte ptr [0x501002]; hlt
  const m = boot(
    "48b8f0debc9a7856341248890425001050008b1c2504105000668b0c25001050008a142507105000480fbe342502105000f4",
  );
  m.setReg("rcx", 0xffffffffffff0000n);
  m.setReg("rdx", 0xffffffffffffff00n);
  m.run(CODE);
  assert.equal(m.reg("rbx"), 0x12345678n);
  assert.equal(m.reg("rcx"), 0xffffffffffffdef0n);
  assert.equal(m.reg("rdx"), 0xffffffffffffff12n);
  assert.equal(m.reg("rsi"), 0xffffffffffffffbcn);
  assert.equal(m.read64(0x501000n), 0x123456789abcdef0n);
});

test("a syscall reaches the handler with the registers it was given", () => {
  // mov rax, 60; mov rdi, 7; syscall
  const m = boot("48c7c03c00000048c7c7070000000f05");
  const seen = [];
  m.syscall = (machine) => {
    seen.push([machine.reg("rax"), machine.reg("rdi")]);
    throw new ProcessExit(Number(machine.reg("rdi")));
  };
  const exit = m.run(CODE);
  assert.equal(exit.reason, "exit");
  assert.equal(exit.code, 7);
  assert.deepEqual(seen, [[60n, 7n]]);
});
