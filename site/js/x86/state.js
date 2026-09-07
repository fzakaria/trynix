// The guest register file, as the wasm globals every translated module
// imports. This is the one list; helpers.js defines the globals in that
// order and translate.js imports them in it, so an index here is the
// same index in both.

export const REGISTER_NAMES = [
  "rax", "rcx", "rdx", "rbx", "rsp", "rbp", "rsi", "rdi",
  "r8", "r9", "r10", "r11", "r12", "r13", "r14", "r15",
];

// name -> wasm value type
export const GLOBALS = [
  ...REGISTER_NAMES.map((n) => [n, "i64"]),
  ["rip", "i64"],
  // Lazy flags: the last flag-setting operation and its operands.
  ["cc_op", "i32"],
  ["cc_dst", "i64"],
  ["cc_src", "i64"],
  ["cc_src2", "i64"],
  // Segment bases for fs: and gs: addressing (TLS).
  ["fs_base", "i64"],
  ["gs_base", "i64"],
  // Why the last block returned to the run loop.
  ["exit_reason", "i32"],
  // The direction flag, 0 or 1, for the string instructions.
  ["df", "i32"],
  ["mxcsr", "i32"],
  // The x87 stack: eight f64 registers, the top-of-stack index and the
  // control and status words.
  ...Array.from({ length: 8 }, (_, i) => [`st${i}`, "f64"]),
  ["fpu_top", "i32"],
  ["fpu_cw", "i32"],
  ["fpu_sw", "i32"],
  ...Array.from({ length: 16 }, (_, i) => [`xmm${i}`, "v128"]),
];

// name -> index into GLOBALS
export const G = Object.fromEntries(GLOBALS.map(([name], i) => [name, i]));

// Values of cc_op >> 2: which operation produced the flags.
export const CC = Object.freeze({
  // cc_src holds the EFLAGS bits themselves.
  EFLAGS: 0,
  ADD: 1,
  ADC: 2,
  SUB: 3,
  SBB: 4,
  LOGIC: 5,
  INC: 6,
  DEC: 7,
  SHL: 8,
  SAR: 9,
  SHR: 10,
  MUL: 11,
});

// cc_op packs the operation with log2 of the operand size in bytes.
export function ccOp(kind, size) {
  return (kind << 2) | Math.log2(size);
}

// EFLAGS bit positions.
export const FLAG = Object.freeze({ CF: 1, PF: 4, AF: 16, ZF: 64, SF: 128, DF: 1024, OF: 2048 });

// Why a block returned to the run loop.
export const EXIT = Object.freeze({
  NONE: 0,
  // The next block is not translated yet; rip holds its address.
  MISS: 1,
  HLT: 2,
  // ud2, int3 or an instruction the translator has no code for; rip
  // holds the instruction's address.
  TRAP: 3,
  UNSUPPORTED: 4,
});
