// An x86-64 instruction decoder.
//
// One instruction in, one description out: mnemonic, operand size and a
// list of operands, each a register, a memory reference, an immediate or
// a branch target. The translator switches on the mnemonic; this file
// knows nothing about what an instruction does, only what it is.
//
// The tables follow the opcode maps in the Intel manual's appendix A,
// with the same operand letters: E is the r/m operand, G the reg field,
// I an immediate, J a branch offset, V and W the xmm forms, and the size
// letters b, w, d, q, v (operand size), z (immediate at operand size,
// capped at 32 bits) and y (32 or 64 by REX.W). A map entry is a spec
// string, an object keyed by mandatory prefix, or a group indexed by the
// reg field of the ModRM byte.
//
// VEX and EVEX encodings are decoded to their length and an operand
// shape, so a translator can step over an AVX routine it has hidden
// from the guest by CPUID, but their mnemonics are not meant to be run.
//
// The decoder is checked against binutils by tests/x86/decode.test.mjs.

// Operand-size defaults, in bytes.
const SIZE = Object.freeze({ byte: 1, word: 2, dword: 4, qword: 8, xmm: 16 });

// Register numbers, as the hardware encodes them.
export const REG = Object.freeze({
  rax: 0, rcx: 1, rdx: 2, rbx: 3, rsp: 4, rbp: 5, rsi: 6, rdi: 7,
  r8: 8, r9: 9, r10: 10, r11: 11, r12: 12, r13: 13, r14: 14, r15: 15,
});

export const REG_NAMES = Object.freeze([
  "rax", "rcx", "rdx", "rbx", "rsp", "rbp", "rsi", "rdi",
  "r8", "r9", "r10", "r11", "r12", "r13", "r14", "r15",
]);

const SEGMENTS = Object.freeze(["es", "cs", "ss", "ds", "fs", "gs"]);

// Condition codes, in encoding order. Odd codes negate the even one
// below them.
export const COND_NAMES = Object.freeze([
  "o", "no", "b", "ae", "e", "ne", "be", "a",
  "s", "ns", "p", "np", "l", "ge", "le", "g",
]);

// Thrown when the bytes do not form an instruction the decoder knows.
// The translator turns that into a block that traps if it is reached.
export class DecodeError extends Error {}

// The single-byte opcode map. An entry is one of:
//   "mnemonic ops"    a plain instruction, ops comma-separated
//   null              invalid in 64-bit mode
//   {group: [...]}    indexed by ModRM.reg
//   {prefix: 1}       a prefix byte handled by the prefix loop
// The trailing "!64" marks an operand size that defaults to 64 bits in
// long mode; "!imm64" a mov with a full 64-bit immediate.
const ARITH = ["add", "or", "adc", "sbb", "and", "sub", "xor", "cmp"];
const SHIFTS = ["rol", "ror", "rcl", "rcr", "shl", "shr", "shl", "sar"];

const ONE_BYTE = new Array(256).fill(null);

for (let i = 0; i < 8; i++) {
  const m = ARITH[i];
  ONE_BYTE[i * 8 + 0] = `${m} Eb,Gb`;
  ONE_BYTE[i * 8 + 1] = `${m} Ev,Gv`;
  ONE_BYTE[i * 8 + 2] = `${m} Gb,Eb`;
  ONE_BYTE[i * 8 + 3] = `${m} Gv,Ev`;
  ONE_BYTE[i * 8 + 4] = `${m} AL,Ib`;
  ONE_BYTE[i * 8 + 5] = `${m} rAX,Iz`;
}
ONE_BYTE[0x0f] = { escape: "0f" };
for (const b of [0x26, 0x2e, 0x36, 0x3e, 0x64, 0x65, 0x66, 0x67, 0xf0, 0xf2, 0xf3]) {
  ONE_BYTE[b] = { prefix: 1 };
}
for (let b = 0x40; b <= 0x4f; b++) {
  ONE_BYTE[b] = { rex: 1 };
}
for (let i = 0; i < 8; i++) {
  ONE_BYTE[0x50 + i] = "push Zv !64";
  ONE_BYTE[0x58 + i] = "pop Zv !64";
}
ONE_BYTE[0x62] = { evex: 1 };
ONE_BYTE[0x63] = "movsxd Gv,Ed";
ONE_BYTE[0x68] = "push Iz !64";
ONE_BYTE[0x69] = "imul Gv,Ev,Iz";
ONE_BYTE[0x6a] = "push Ib !64";
ONE_BYTE[0x6b] = "imul Gv,Ev,Ib";
ONE_BYTE[0x6c] = "ins Yb,DX";
ONE_BYTE[0x6d] = "ins Yz,DX";
ONE_BYTE[0x6e] = "outs DX,Xb";
ONE_BYTE[0x6f] = "outs DX,Xz";
for (let i = 0; i < 16; i++) {
  ONE_BYTE[0x70 + i] = `j${COND_NAMES[i]} Jb`;
}
ONE_BYTE[0x80] = { group: ARITH.map((m) => `${m} Eb,Ib`) };
ONE_BYTE[0x81] = { group: ARITH.map((m) => `${m} Ev,Iz`) };
ONE_BYTE[0x83] = { group: ARITH.map((m) => `${m} Ev,Ib`) };
ONE_BYTE[0x84] = "test Eb,Gb";
ONE_BYTE[0x85] = "test Ev,Gv";
ONE_BYTE[0x86] = "xchg Eb,Gb";
ONE_BYTE[0x87] = "xchg Ev,Gv";
ONE_BYTE[0x88] = "mov Eb,Gb";
ONE_BYTE[0x89] = "mov Ev,Gv";
ONE_BYTE[0x8a] = "mov Gb,Eb";
ONE_BYTE[0x8b] = "mov Gv,Ev";
ONE_BYTE[0x8c] = "mov Ev,Sw";
ONE_BYTE[0x8d] = "lea Gv,M";
ONE_BYTE[0x8e] = "mov Sw,Ew";
ONE_BYTE[0x8f] = { group: ["pop Ev !64", null, null, null, null, null, null, null] };
ONE_BYTE[0x90] = "nop";
for (let i = 1; i < 8; i++) {
  ONE_BYTE[0x90 + i] = "xchg Zv,rAX";
}
ONE_BYTE[0x98] = "cwde";
ONE_BYTE[0x99] = "cdq";
ONE_BYTE[0x9b] = "fwait";
ONE_BYTE[0x9c] = "pushf !64";
ONE_BYTE[0x9d] = "popf !64";
ONE_BYTE[0x9e] = "sahf";
ONE_BYTE[0x9f] = "lahf";
ONE_BYTE[0xa0] = "mov AL,Ob";
ONE_BYTE[0xa1] = "mov rAX,Ov";
ONE_BYTE[0xa2] = "mov Ob,AL";
ONE_BYTE[0xa3] = "mov Ov,rAX";
ONE_BYTE[0xa4] = "movs Yb,Xb";
ONE_BYTE[0xa5] = "movs Yv,Xv";
ONE_BYTE[0xa6] = "cmps Xb,Yb";
ONE_BYTE[0xa7] = "cmps Xv,Yv";
ONE_BYTE[0xa8] = "test AL,Ib";
ONE_BYTE[0xa9] = "test rAX,Iz";
ONE_BYTE[0xaa] = "stos Yb,AL";
ONE_BYTE[0xab] = "stos Yv,rAX";
ONE_BYTE[0xac] = "lods AL,Xb";
ONE_BYTE[0xad] = "lods rAX,Xv";
ONE_BYTE[0xae] = "scas AL,Yb";
ONE_BYTE[0xaf] = "scas rAX,Yv";
for (let i = 0; i < 8; i++) {
  ONE_BYTE[0xb0 + i] = "mov Zb,Ib";
  ONE_BYTE[0xb8 + i] = "mov Zv,Iv !imm64";
}
ONE_BYTE[0xc0] = { group: SHIFTS.map((m) => `${m} Eb,Ub`) };
ONE_BYTE[0xc1] = { group: SHIFTS.map((m) => `${m} Ev,Ub`) };
ONE_BYTE[0xc2] = "ret Iw !64";
ONE_BYTE[0xc3] = "ret !64";
ONE_BYTE[0xc4] = { vex: 3 };
ONE_BYTE[0xc5] = { vex: 2 };
ONE_BYTE[0xc6] = { group: ["mov Eb,Ib", null, null, null, null, null, null, { reg: "xabort Ub" }] };
ONE_BYTE[0xc7] = { group: ["mov Ev,Iz", null, null, null, null, null, null, { reg: "xbegin Jz" }] };
ONE_BYTE[0xc8] = "enter Iw,Ub";
ONE_BYTE[0xc9] = "leave !64";
ONE_BYTE[0xca] = "retf Iw";
ONE_BYTE[0xcb] = "retf";
ONE_BYTE[0xcc] = "int3";
ONE_BYTE[0xcd] = "int Ub";
ONE_BYTE[0xcf] = "iret";
ONE_BYTE[0xd0] = { group: SHIFTS.map((m) => `${m} Eb,1`) };
ONE_BYTE[0xd1] = { group: SHIFTS.map((m) => `${m} Ev,1`) };
ONE_BYTE[0xd2] = { group: SHIFTS.map((m) => `${m} Eb,CL`) };
ONE_BYTE[0xd3] = { group: SHIFTS.map((m) => `${m} Ev,CL`) };
ONE_BYTE[0xd7] = "xlat";
for (let b = 0xd8; b <= 0xdf; b++) {
  ONE_BYTE[b] = { x87: b };
}
ONE_BYTE[0xe0] = "loopne Jb";
ONE_BYTE[0xe1] = "loope Jb";
ONE_BYTE[0xe2] = "loop Jb";
ONE_BYTE[0xe3] = "jrcxz Jb";
ONE_BYTE[0xe4] = "in AL,Ub";
ONE_BYTE[0xe5] = "in eAX,Ub";
ONE_BYTE[0xe6] = "out Ub,AL";
ONE_BYTE[0xe7] = "out Ub,eAX";
ONE_BYTE[0xe8] = "call Jz !64";
ONE_BYTE[0xe9] = "jmp Jz !64";
ONE_BYTE[0xeb] = "jmp Jb !64";
ONE_BYTE[0xec] = "in AL,DX";
ONE_BYTE[0xed] = "in eAX,DX";
ONE_BYTE[0xee] = "out DX,AL";
ONE_BYTE[0xef] = "out DX,eAX";
ONE_BYTE[0xf1] = "int1";
ONE_BYTE[0xf4] = "hlt";
ONE_BYTE[0xf5] = "cmc";
ONE_BYTE[0xf6] = { group: ["test Eb,Ib", "test Eb,Ib", "not Eb", "neg Eb", "mul Eb", "imul Eb", "div Eb", "idiv Eb"] };
ONE_BYTE[0xf7] = { group: ["test Ev,Iz", "test Ev,Iz", "not Ev", "neg Ev", "mul Ev", "imul Ev", "div Ev", "idiv Ev"] };
ONE_BYTE[0xf8] = "clc";
ONE_BYTE[0xf9] = "stc";
ONE_BYTE[0xfa] = "cli";
ONE_BYTE[0xfb] = "sti";
ONE_BYTE[0xfc] = "cld";
ONE_BYTE[0xfd] = "std";
ONE_BYTE[0xfe] = { group: ["inc Eb", "dec Eb", null, null, null, null, null, null] };
ONE_BYTE[0xff] = { group: ["inc Ev", "dec Ev", "call Ev !64", "callf Mp", "jmp Ev !64", "jmpf Mp", "push Ev !64", null] };

// The two-byte map (0F xx). Entries keyed by mandatory prefix are
// objects with np, 66, f3 and f2 members.
const TWO_BYTE = new Array(256).fill(null);

TWO_BYTE[0x00] = { group: ["sldt Ew", "str Ew", "lldt Ew", "ltr Ew", "verr Ew", "verw Ew", null, null] };
TWO_BYTE[0x01] = {
  group: [
    { mem: "sgdt M", reg: {} },
    { mem: "sidt M", reg: { 0xc8: "monitor", 0xc9: "mwait", 0xca: "clac", 0xcb: "stac" } },
    { mem: "lgdt M", reg: { 0xd0: "xgetbv", 0xd1: "xsetbv", 0xd5: "xend", 0xd6: "xtest" } },
    { mem: "lidt M", reg: {} },
    "smsw Ew",
    { mem: { f3: "rstorssp Mq" }, reg: { 0xea: "saveprevssp", 0xee: "rdpkru", 0xef: "wrpkru" } },
    "lmsw Ew",
    { mem: "invlpg M", reg: { 0xf8: "swapgs", 0xf9: "rdtscp" } },
  ],
};
TWO_BYTE[0x02] = "lar Gv,Ew";
TWO_BYTE[0x03] = "lsl Gv,Ew";
TWO_BYTE[0x05] = "syscall";
TWO_BYTE[0x06] = "clts";
TWO_BYTE[0x07] = "sysret";
TWO_BYTE[0x08] = "invd";
TWO_BYTE[0x09] = "wbinvd";
TWO_BYTE[0x0b] = "ud2";
TWO_BYTE[0x0d] = { group: ["prefetch M", "prefetchw M", "prefetchwt1 M", "prefetch M", "prefetch M", "prefetch M", "prefetch M", "prefetch M"] };
TWO_BYTE[0x10] = { np: "movups Vx,Wx", 66: "movupd Vx,Wx", f3: "movss Vx,Wss", f2: "movsd Vx,Wsd" };
TWO_BYTE[0x11] = { np: "movups Wx,Vx", 66: "movupd Wx,Vx", f3: "movss Wss,Vx", f2: "movsd Wsd,Vx" };
TWO_BYTE[0x12] = { np: { mem: "movlps Vx,Mq", reg: "movhlps Vx,Ux" }, 66: "movlpd Vx,Mq", f3: "movsldup Vx,Wx", f2: "movddup Vx,Wq" };
TWO_BYTE[0x13] = { np: "movlps Mq,Vx", 66: "movlpd Mq,Vx" };
TWO_BYTE[0x14] = { np: "unpcklps Vx,Wx", 66: "unpcklpd Vx,Wx" };
TWO_BYTE[0x15] = { np: "unpckhps Vx,Wx", 66: "unpckhpd Vx,Wx" };
TWO_BYTE[0x16] = { np: { mem: "movhps Vx,Mq", reg: "movlhps Vx,Ux" }, 66: "movhpd Vx,Mq", f3: "movshdup Vx,Wx" };
TWO_BYTE[0x17] = { np: "movhps Mq,Vx", 66: "movhpd Mq,Vx" };
TWO_BYTE[0x18] = { group: ["prefetchnta M", "prefetcht0 M", "prefetcht1 M", "prefetcht2 M", "nop Ev", "nop Ev", "nop Ev", "nop Ev"] };
for (let b = 0x19; b <= 0x1f; b++) {
  TWO_BYTE[b] = "nop Ev";
}
TWO_BYTE[0x1e] = {
  np: "nop Ev",
  66: "nop Ev",
  f2: "nop Ev",
  f3: { mem: "nop Ev", reg: { 0xfa: "endbr64", 0xfb: "endbr32" }, regGroup: [null, "rdsspq Ey", null, null, null, null, null, null], regDefault: "nop Ev" },
};
TWO_BYTE[0x20] = "mov Rq,Cq";
TWO_BYTE[0x21] = "mov Rq,Dq";
TWO_BYTE[0x22] = "mov Cq,Rq";
TWO_BYTE[0x23] = "mov Dq,Rq";
TWO_BYTE[0x28] = { np: "movaps Vx,Wx", 66: "movapd Vx,Wx" };
TWO_BYTE[0x29] = { np: "movaps Wx,Vx", 66: "movapd Wx,Vx" };
TWO_BYTE[0x2a] = { np: "cvtpi2ps Vx,Qq", 66: "cvtpi2pd Vx,Qq", f3: "cvtsi2ss Vx,Ey", f2: "cvtsi2sd Vx,Ey" };
TWO_BYTE[0x2b] = { np: "movntps Mx,Vx", 66: "movntpd Mx,Vx" };
TWO_BYTE[0x2c] = { np: "cvttps2pi Pq,Wq", 66: "cvttpd2pi Pq,Wx", f3: "cvttss2si Gy,Wss", f2: "cvttsd2si Gy,Wsd" };
TWO_BYTE[0x2d] = { np: "cvtps2pi Pq,Wq", 66: "cvtpd2pi Pq,Wx", f3: "cvtss2si Gy,Wss", f2: "cvtsd2si Gy,Wsd" };
TWO_BYTE[0x2e] = { np: "ucomiss Vx,Wss", 66: "ucomisd Vx,Wsd" };
TWO_BYTE[0x2f] = { np: "comiss Vx,Wss", 66: "comisd Vx,Wsd" };
TWO_BYTE[0x30] = "wrmsr";
TWO_BYTE[0x31] = "rdtsc";
TWO_BYTE[0x32] = "rdmsr";
TWO_BYTE[0x33] = "rdpmc";
TWO_BYTE[0x34] = "sysenter";
TWO_BYTE[0x35] = "sysexit";
TWO_BYTE[0x38] = { escape: "0f38" };
TWO_BYTE[0x3a] = { escape: "0f3a" };
for (let i = 0; i < 16; i++) {
  TWO_BYTE[0x40 + i] = `cmov${COND_NAMES[i]} Gv,Ev`;
}
TWO_BYTE[0x50] = { np: "movmskps Gd,Ux", 66: "movmskpd Gd,Ux" };
TWO_BYTE[0x51] = { np: "sqrtps Vx,Wx", 66: "sqrtpd Vx,Wx", f3: "sqrtss Vx,Wss", f2: "sqrtsd Vx,Wsd" };
TWO_BYTE[0x52] = { np: "rsqrtps Vx,Wx", f3: "rsqrtss Vx,Wss" };
TWO_BYTE[0x53] = { np: "rcpps Vx,Wx", f3: "rcpss Vx,Wss" };
TWO_BYTE[0x54] = { np: "andps Vx,Wx", 66: "andpd Vx,Wx" };
TWO_BYTE[0x55] = { np: "andnps Vx,Wx", 66: "andnpd Vx,Wx" };
TWO_BYTE[0x56] = { np: "orps Vx,Wx", 66: "orpd Vx,Wx" };
TWO_BYTE[0x57] = { np: "xorps Vx,Wx", 66: "xorpd Vx,Wx" };
TWO_BYTE[0x58] = { np: "addps Vx,Wx", 66: "addpd Vx,Wx", f3: "addss Vx,Wss", f2: "addsd Vx,Wsd" };
TWO_BYTE[0x59] = { np: "mulps Vx,Wx", 66: "mulpd Vx,Wx", f3: "mulss Vx,Wss", f2: "mulsd Vx,Wsd" };
TWO_BYTE[0x5a] = { np: "cvtps2pd Vx,Wq", 66: "cvtpd2ps Vx,Wx", f3: "cvtss2sd Vx,Wss", f2: "cvtsd2ss Vx,Wsd" };
TWO_BYTE[0x5b] = { np: "cvtdq2ps Vx,Wx", 66: "cvtps2dq Vx,Wx", f3: "cvttps2dq Vx,Wx" };
TWO_BYTE[0x5c] = { np: "subps Vx,Wx", 66: "subpd Vx,Wx", f3: "subss Vx,Wss", f2: "subsd Vx,Wsd" };
TWO_BYTE[0x5d] = { np: "minps Vx,Wx", 66: "minpd Vx,Wx", f3: "minss Vx,Wss", f2: "minsd Vx,Wsd" };
TWO_BYTE[0x5e] = { np: "divps Vx,Wx", 66: "divpd Vx,Wx", f3: "divss Vx,Wss", f2: "divsd Vx,Wsd" };
TWO_BYTE[0x5f] = { np: "maxps Vx,Wx", 66: "maxpd Vx,Wx", f3: "maxss Vx,Wss", f2: "maxsd Vx,Wsd" };

// The MMX/SSE2 integer block: the same mnemonic on mm registers with
// no prefix and on xmm registers with 66.
const MMX_SSE = {
  0x60: "punpcklbw", 0x61: "punpcklwd", 0x62: "punpckldq", 0x63: "packsswb",
  0x64: "pcmpgtb", 0x65: "pcmpgtw", 0x66: "pcmpgtd", 0x67: "packuswb",
  0x68: "punpckhbw", 0x69: "punpckhwd", 0x6a: "punpckhdq", 0x6b: "packssdw",
  0x74: "pcmpeqb", 0x75: "pcmpeqw", 0x76: "pcmpeqd",
  0xd1: "psrlw", 0xd2: "psrld", 0xd3: "psrlq", 0xd4: "paddq", 0xd5: "pmullw",
  0xd7: "pmovmskb", 0xd8: "psubusb", 0xd9: "psubusw", 0xda: "pminub", 0xdb: "pand",
  0xdc: "paddusb", 0xdd: "paddusw", 0xde: "pmaxub", 0xdf: "pandn",
  0xe0: "pavgb", 0xe1: "psraw", 0xe2: "psrad", 0xe3: "pavgw", 0xe4: "pmulhuw", 0xe5: "pmulhw",
  0xe8: "psubsb", 0xe9: "psubsw", 0xea: "pminsw", 0xeb: "por", 0xec: "paddsb", 0xed: "paddsw",
  0xee: "pmaxsw", 0xef: "pxor",
  0xf1: "psllw", 0xf2: "pslld", 0xf3: "psllq", 0xf4: "pmuludq", 0xf5: "pmaddwd", 0xf6: "psadbw",
  0xf8: "psubb", 0xf9: "psubw", 0xfa: "psubd", 0xfb: "psubq", 0xfc: "paddb", 0xfd: "paddw", 0xfe: "paddd",
};
for (const [op, m] of Object.entries(MMX_SSE)) {
  const b = Number(op);
  if (m === "pmovmskb") {
    TWO_BYTE[b] = { np: "pmovmskb Gd,Nq", 66: "pmovmskb Gd,Ux" };
  } else {
    TWO_BYTE[b] = { np: `${m} Pq,Qq`, 66: `${m} Vx,Wx` };
  }
}
TWO_BYTE[0x6c] = { 66: "punpcklqdq Vx,Wx" };
TWO_BYTE[0x6d] = { 66: "punpckhqdq Vx,Wx" };
TWO_BYTE[0x6e] = { np: "movd Pq,Ey", 66: "movd Vx,Ey" };
TWO_BYTE[0x6f] = { np: "movq Pq,Qq", 66: "movdqa Vx,Wx", f3: "movdqu Vx,Wx" };
TWO_BYTE[0x70] = { np: "pshufw Pq,Qq,Ub", 66: "pshufd Vx,Wx,Ub", f3: "pshufhw Vx,Wx,Ub", f2: "pshuflw Vx,Wx,Ub" };
TWO_BYTE[0x71] = { group: [null, null, { np: "psrlw Nq,Ub", 66: "psrlw Ux,Ub" }, null, { np: "psraw Nq,Ub", 66: "psraw Ux,Ub" }, null, { np: "psllw Nq,Ub", 66: "psllw Ux,Ub" }, null] };
TWO_BYTE[0x72] = { group: [null, null, { np: "psrld Nq,Ub", 66: "psrld Ux,Ub" }, null, { np: "psrad Nq,Ub", 66: "psrad Ux,Ub" }, null, { np: "pslld Nq,Ub", 66: "pslld Ux,Ub" }, null] };
TWO_BYTE[0x73] = { group: [null, null, { np: "psrlq Nq,Ub", 66: "psrlq Ux,Ub" }, { 66: "psrldq Ux,Ub" }, null, null, { np: "psllq Nq,Ub", 66: "psllq Ux,Ub" }, { 66: "pslldq Ux,Ub" }] };
TWO_BYTE[0x77] = "emms";
TWO_BYTE[0x7c] = { 66: "haddpd Vx,Wx", f2: "haddps Vx,Wx" };
TWO_BYTE[0x7d] = { 66: "hsubpd Vx,Wx", f2: "hsubps Vx,Wx" };
TWO_BYTE[0x7e] = { np: "movd Ey,Pq", 66: "movd Ey,Vx", f3: "movq Vx,Wq" };
TWO_BYTE[0x7f] = { np: "movq Qq,Pq", 66: "movdqa Wx,Vx", f3: "movdqu Wx,Vx" };
for (let i = 0; i < 16; i++) {
  TWO_BYTE[0x80 + i] = `j${COND_NAMES[i]} Jz !64`;
  TWO_BYTE[0x90 + i] = `set${COND_NAMES[i]} Eb`;
}
TWO_BYTE[0xa0] = "push FS !64";
TWO_BYTE[0xa1] = "pop FS !64";
TWO_BYTE[0xa2] = "cpuid";
TWO_BYTE[0xa3] = "bt Ev,Gv";
TWO_BYTE[0xa4] = "shld Ev,Gv,Ub";
TWO_BYTE[0xa5] = "shld Ev,Gv,CL";
TWO_BYTE[0xa8] = "push GS !64";
TWO_BYTE[0xa9] = "pop GS !64";
TWO_BYTE[0xaa] = "rsm";
TWO_BYTE[0xab] = "bts Ev,Gv";
TWO_BYTE[0xac] = "shrd Ev,Gv,Ub";
TWO_BYTE[0xad] = "shrd Ev,Gv,CL";
TWO_BYTE[0xae] = {
  np: {
    group: [
      { mem: "fxsave M", reg: null },
      { mem: "fxrstor M", reg: null },
      { mem: "ldmxcsr Md", reg: null },
      { mem: "stmxcsr Md", reg: null },
      { mem: "xsave M", reg: null },
      { mem: "xrstor M", reg: "lfence" },
      { mem: "xsaveopt M", reg: "mfence" },
      { mem: "clflush Mb", reg: "sfence" },
    ],
  },
  66: {
    group: [
      { mem: "fxsave64 M", reg: null },
      { mem: "fxrstor64 M", reg: null },
      null, null, null, null,
      { mem: "clwb Mb", reg: null },
      { mem: "clflushopt Mb", reg: null },
    ],
  },
  f3: {
    group: [
      { mem: null, reg: "rdfsbase Ry" },
      { mem: null, reg: "rdgsbase Ry" },
      { mem: null, reg: "wrfsbase Ry" },
      { mem: null, reg: "wrgsbase Ry" },
      { mem: "ptwrite Ey", reg: "ptwrite Ey" },
      { mem: "incssp M", reg: "incsspq Ry" },
      { mem: "clrssbsy Mq", reg: "umonitor Ry" },
      { mem: null, reg: null },
    ],
  },
  f2: { group: [null, null, null, null, null, null, { mem: null, reg: "umwait Ry" }, null] },
};
TWO_BYTE[0xaf] = "imul Gv,Ev";
TWO_BYTE[0xb0] = "cmpxchg Eb,Gb";
TWO_BYTE[0xb1] = "cmpxchg Ev,Gv";
TWO_BYTE[0xb2] = "lss Gv,Mp";
TWO_BYTE[0xb3] = "btr Ev,Gv";
TWO_BYTE[0xb4] = "lfs Gv,Mp";
TWO_BYTE[0xb5] = "lgs Gv,Mp";
TWO_BYTE[0xb6] = "movzx Gv,Eb";
TWO_BYTE[0xb7] = "movzx Gv,Ew";
TWO_BYTE[0xb8] = { f3: "popcnt Gv,Ev" };
TWO_BYTE[0xb9] = "ud1 Gv,Ev";
TWO_BYTE[0xba] = { group: [null, null, null, null, "bt Ev,Ub", "bts Ev,Ub", "btr Ev,Ub", "btc Ev,Ub"] };
TWO_BYTE[0xbb] = "btc Ev,Gv";
TWO_BYTE[0xbc] = { np: "bsf Gv,Ev", 66: "bsf Gv,Ev", f3: "tzcnt Gv,Ev" };
TWO_BYTE[0xbd] = { np: "bsr Gv,Ev", 66: "bsr Gv,Ev", f3: "lzcnt Gv,Ev" };
TWO_BYTE[0xbe] = "movsx Gv,Eb";
TWO_BYTE[0xbf] = "movsx Gv,Ew";
TWO_BYTE[0xc0] = "xadd Eb,Gb";
TWO_BYTE[0xc1] = "xadd Ev,Gv";
TWO_BYTE[0xc2] = { np: "cmpps Vx,Wx,Ub", 66: "cmppd Vx,Wx,Ub", f3: "cmpss Vx,Wss,Ub", f2: "cmpsd Vx,Wsd,Ub" };
TWO_BYTE[0xc3] = "movnti My,Gy";
TWO_BYTE[0xc4] = { np: "pinsrw Pq,Ew,Ub", 66: "pinsrw Vx,Ew,Ub" };
TWO_BYTE[0xc5] = { np: "pextrw Gd,Nq,Ub", 66: "pextrw Gd,Ux,Ub" };
TWO_BYTE[0xc6] = { np: "shufps Vx,Wx,Ub", 66: "shufpd Vx,Wx,Ub" };
TWO_BYTE[0xc7] = {
  group: [
    null,
    { mem: "cmpxchg8b Mq", reg: null },
    null,
    { mem: "xrstors M", reg: null },
    { mem: "xsavec M", reg: null },
    { mem: "xsaves M", reg: null },
    { mem: "vmptrld Mq", reg: "rdrand Rv" },
    { mem: "vmptrst Mq", reg: { f3: "rdpid Rq" }, regDefault: "rdseed Rv" },
  ],
};
for (let i = 0; i < 8; i++) {
  TWO_BYTE[0xc8 + i] = "bswap Zv";
}
TWO_BYTE[0xd0] = { 66: "addsubpd Vx,Wx", f2: "addsubps Vx,Wx" };
TWO_BYTE[0xd6] = { 66: "movq Wq,Vx", f3: "movq2dq Vx,Nq", f2: "movdq2q Pq,Ux" };
TWO_BYTE[0xe6] = { 66: "cvttpd2dq Vx,Wx", f3: "cvtdq2pd Vx,Wq", f2: "cvtpd2dq Vx,Wx" };
TWO_BYTE[0xe7] = { np: "movntq Mq,Pq", 66: "movntdq Mx,Vx" };
TWO_BYTE[0xf0] = { f2: "lddqu Vx,Mx" };
TWO_BYTE[0xf7] = { np: "maskmovq Pq,Nq", 66: "maskmovdqu Vx,Ux" };
TWO_BYTE[0xff] = "ud0 Gv,Ev";

// The 0F 38 map. Plain entries are 66-prefixed SSSE3/SSE4 forms unless
// keyed otherwise.
const THREE_BYTE_38 = new Array(256).fill(null);
const SSSE3 = {
  0x00: "pshufb", 0x01: "phaddw", 0x02: "phaddd", 0x03: "phaddsw", 0x04: "pmaddubsw",
  0x05: "phsubw", 0x06: "phsubd", 0x07: "phsubsw", 0x08: "psignb", 0x09: "psignw",
  0x0a: "psignd", 0x0b: "pmulhrsw", 0x1c: "pabsb", 0x1d: "pabsw", 0x1e: "pabsd",
};
for (const [op, m] of Object.entries(SSSE3)) {
  THREE_BYTE_38[Number(op)] = { np: `${m} Pq,Qq`, 66: `${m} Vx,Wx` };
}
const SSE4_38 = {
  0x10: "pblendvb Vx,Wx", 0x14: "blendvps Vx,Wx", 0x15: "blendvpd Vx,Wx", 0x17: "ptest Vx,Wx",
  0x20: "pmovsxbw Vx,Wq", 0x21: "pmovsxbd Vx,Wd", 0x22: "pmovsxbq Vx,Ww", 0x23: "pmovsxwd Vx,Wq",
  0x24: "pmovsxwq Vx,Wd", 0x25: "pmovsxdq Vx,Wq", 0x28: "pmuldq Vx,Wx", 0x29: "pcmpeqq Vx,Wx",
  0x2a: "movntdqa Vx,Mx", 0x2b: "packusdw Vx,Wx",
  0x30: "pmovzxbw Vx,Wq", 0x31: "pmovzxbd Vx,Wd", 0x32: "pmovzxbq Vx,Ww", 0x33: "pmovzxwd Vx,Wq",
  0x34: "pmovzxwq Vx,Wd", 0x35: "pmovzxdq Vx,Wq", 0x37: "pcmpgtq Vx,Wx",
  0x38: "pminsb Vx,Wx", 0x39: "pminsd Vx,Wx", 0x3a: "pminuw Vx,Wx", 0x3b: "pminud Vx,Wx",
  0x3c: "pmaxsb Vx,Wx", 0x3d: "pmaxsd Vx,Wx", 0x3e: "pmaxuw Vx,Wx", 0x3f: "pmaxud Vx,Wx",
  0x40: "pmulld Vx,Wx", 0x41: "phminposuw Vx,Wx",
  0xdb: "aesimc Vx,Wx", 0xdc: "aesenc Vx,Wx", 0xdd: "aesenclast Vx,Wx", 0xde: "aesdec Vx,Wx", 0xdf: "aesdeclast Vx,Wx",
};
for (const [op, spec] of Object.entries(SSE4_38)) {
  THREE_BYTE_38[Number(op)] = { 66: spec };
}
THREE_BYTE_38[0xc8] = { np: "sha1nexte Vx,Wx" };
THREE_BYTE_38[0xc9] = { np: "sha1msg1 Vx,Wx" };
THREE_BYTE_38[0xca] = { np: "sha1msg2 Vx,Wx" };
THREE_BYTE_38[0xcb] = { np: "sha256rnds2 Vx,Wx" };
THREE_BYTE_38[0xcc] = { np: "sha256msg1 Vx,Wx" };
THREE_BYTE_38[0xcd] = { np: "sha256msg2 Vx,Wx" };
THREE_BYTE_38[0xf0] = { np: "movbe Gy,My", 66: "movbe Gw,Mw", f2: "crc32 Gd,Eb" };
THREE_BYTE_38[0xf1] = { np: "movbe My,Gy", 66: "movbe Mw,Gw", f2: "crc32 Gd,Ey" };
THREE_BYTE_38[0xf6] = { 66: "adcx Gy,Ey", f3: "adox Gy,Ey" };
// VEX-only BMI entries on this map; the operand shape is all that
// matters to a length decode, and the mnemonics are exact.
THREE_BYTE_38[0xf2] = { vexOnly: 1, np: "andn Gy,By,Ey" };
THREE_BYTE_38[0xf3] = { vexOnly: 1, group: [null, "blsr By,Ey", "blsmsk By,Ey", "blsi By,Ey", null, null, null, null] };
THREE_BYTE_38[0xf5] = { vexOnly: 1, np: "bzhi Gy,Ey,By", f3: "pext Gy,By,Ey", f2: "pdep Gy,By,Ey" };
THREE_BYTE_38[0xf7] = { vexOnly: 1, np: "bextr Gy,Ey,By", 66: "shlx Gy,Ey,By", f3: "sarx Gy,Ey,By", f2: "shrx Gy,Ey,By" };
THREE_BYTE_38[0xf6] = { ...THREE_BYTE_38[0xf6], f2vex: "mulx Gy,By,Ey" };

// The 0F 3A map: SSE4 forms with an immediate.
const THREE_BYTE_3A = new Array(256).fill(null);
const SSE4_3A = {
  0x08: "roundps Vx,Wx,Ub", 0x09: "roundpd Vx,Wx,Ub", 0x0a: "roundss Vx,Wss,Ub", 0x0b: "roundsd Vx,Wsd,Ub",
  0x0c: "blendps Vx,Wx,Ub", 0x0d: "blendpd Vx,Wx,Ub", 0x0e: "pblendw Vx,Wx,Ub",
  0x14: "pextrb Ed,Vx,Ub", 0x15: "pextrw Ed,Vx,Ub", 0x16: "pextrd Ey,Vx,Ub", 0x17: "extractps Ed,Vx,Ub",
  0x20: "pinsrb Vx,Ed,Ub", 0x21: "insertps Vx,Wss,Ub", 0x22: "pinsrd Vx,Ey,Ub",
  0x40: "dpps Vx,Wx,Ub", 0x41: "dppd Vx,Wx,Ub", 0x42: "mpsadbw Vx,Wx,Ub", 0x44: "pclmulqdq Vx,Wx,Ub",
  0x60: "pcmpestrm Vx,Wx,Ub", 0x61: "pcmpestri Vx,Wx,Ub", 0x62: "pcmpistrm Vx,Wx,Ub", 0x63: "pcmpistri Vx,Wx,Ub",
  0xdf: "aeskeygenassist Vx,Wx,Ub",
};
for (const [op, spec] of Object.entries(SSE4_3A)) {
  THREE_BYTE_3A[Number(op)] = { 66: spec };
}
THREE_BYTE_3A[0x0f] = { np: "palignr Pq,Qq,Ub", 66: "palignr Vx,Wx,Ub" };
THREE_BYTE_3A[0xcc] = { np: "sha1rnds4 Vx,Wx,Ub" };
THREE_BYTE_3A[0xf0] = { vexOnly: 1, f2: "rorx Gy,Ey,Ub" };

// AVX forms that exist only under VEX, keyed by map then opcode. Only
// the operand shape is used; the mnemonic is "v" plus the SSE name from
// the tables above when the same opcode exists there.
const VEX_ONLY = {
  "0f": {
    0x77: "vzeroupper",
    // Mask-register moves and tests (AVX-512), ModRM only.
    0x90: "kmov Kq,Kq", 0x91: "kmov Mq,Kq", 0x92: "kmov Kq,Ey", 0x93: "kmov Gy,Kq",
    0x98: "kortest Kq,Kq", 0x99: "ktest Kq,Kq",
    0x41: "kand Kq,Kq", 0x42: "kandn Kq,Kq", 0x45: "kor Kq,Kq", 0x46: "kxnor Kq,Kq",
    0x47: "kxor Kq,Kq", 0x4a: "kadd Kq,Kq", 0x4b: "kunpck Kq,Kq",
  },
  "0f38": {
    0x18: { 66: "vbroadcastss Vx,Wd" },
    0x19: { 66: "vbroadcastsd Vx,Wq" },
    0x1a: { 66: "vbroadcastf128 Vx,Mx" },
    0x58: { 66: "vpbroadcastd Vx,Wd" },
    0x59: { 66: "vpbroadcastq Vx,Wq" },
    0x5a: { 66: "vbroadcasti128 Vx,Mx" },
    0x78: { 66: "vpbroadcastb Vx,Wb" },
    0x79: { 66: "vpbroadcastw Vx,Ww" },
    0x0c: { 66: "vpermilps Vx,Hx,Wx" },
    0x0d: { 66: "vpermilpd Vx,Hx,Wx" },
    0x0e: { 66: "vtestps Vx,Wx" },
    0x0f: { 66: "vtestpd Vx,Wx" },
    0x13: { 66: "vcvtph2ps Vx,Wq" },
    0x16: { 66: "vpermps Vx,Hx,Wx" },
    0x36: { 66: "vpermd Vx,Hx,Wx" },
    0x45: { 66: "vpsrlvd Vx,Hx,Wx" },
    0x46: { 66: "vpsravd Vx,Hx,Wx" },
    0x47: { 66: "vpsllvd Vx,Hx,Wx" },
    0x8c: { 66: "vpmaskmovd Vx,Hx,Mx" },
    0x8e: { 66: "vpmaskmovd Mx,Hx,Vx" },
    0x2c: { 66: "vmaskmovps Vx,Hx,Mx" },
    0x2d: { 66: "vmaskmovpd Vx,Hx,Mx" },
    0x2e: { 66: "vmaskmovps Mx,Hx,Vx" },
    0x2f: { 66: "vmaskmovpd Mx,Hx,Vx" },
    0x90: { 66: "vpgatherdd Vx,Mx,Hx" },
    0x91: { 66: "vpgatherqd Vx,Mx,Hx" },
    0x92: { 66: "vgatherdps Vx,Mx,Hx" },
    0x93: { 66: "vgatherqps Vx,Mx,Hx" },
  },
  "0f3a": {
    0x00: { 66: "vpermq Vx,Wx,Ub" },
    0x01: { 66: "vpermpd Vx,Wx,Ub" },
    0x02: { 66: "vpblendd Vx,Hx,Wx,Ub" },
    0x04: { 66: "vpermilps Vx,Wx,Ub" },
    0x05: { 66: "vpermilpd Vx,Wx,Ub" },
    0x06: { 66: "vperm2f128 Vx,Hx,Wx,Ub" },
    0x18: { 66: "vinsertf128 Vx,Hx,Wx,Ub" },
    0x19: { 66: "vextractf128 Wx,Vx,Ub" },
    0x1d: { 66: "vcvtps2ph Wq,Vx,Ub" },
    0x38: { 66: "vinserti128 Vx,Hx,Wx,Ub" },
    0x39: { 66: "vextracti128 Wx,Vx,Ub" },
    0x46: { 66: "vperm2i128 Vx,Hx,Wx,Ub" },
    0x4a: { 66: "vblendvps Vx,Hx,Wx,Lx" },
    0x4b: { 66: "vblendvpd Vx,Hx,Wx,Lx" },
    0x4c: { 66: "vpblendvb Vx,Hx,Wx,Lx" },
  },
};

// The FMA block's ten forms, low nibble 6 through f: name and whether
// the form is scalar.
const FMA_KINDS = [
  ["vfmaddsub", false], ["vfmsubadd", false], ["vfmadd", false], ["vfmadd", true], ["vfmsub", false],
  ["vfmsub", true], ["vfnmadd", false], ["vfnmadd", true], ["vfnmsub", false], ["vfnmsub", true],
];

// The x87 maps. For each escape byte: memory forms by ModRM.reg, and
// register forms by the whole ModRM byte (or by reg with STi as the
// operand when `regs` is set).
const X87 = {
  0xd8: {
    mem: ["fadd Md", "fmul Md", "fcom Md", "fcomp Md", "fsub Md", "fsubr Md", "fdiv Md", "fdivr Md"],
    regs: ["fadd ST0,STi", "fmul ST0,STi", "fcom STi", "fcomp STi", "fsub ST0,STi", "fsubr ST0,STi", "fdiv ST0,STi", "fdivr ST0,STi"],
  },
  0xd9: {
    mem: ["fld Md", null, "fst Md", "fstp Md", "fldenv M", "fldcw Mw", "fnstenv M", "fnstcw Mw"],
    regs: ["fld STi", "fxch STi", null, null, null, null, null, null],
    reg: {
      0xd0: "fnop", 0xe0: "fchs", 0xe1: "fabs", 0xe4: "ftst", 0xe5: "fxam", 0xe8: "fld1", 0xe9: "fldl2t",
      0xea: "fldl2e", 0xeb: "fldpi", 0xec: "fldlg2", 0xed: "fldln2", 0xee: "fldz", 0xf0: "f2xm1", 0xf1: "fyl2x",
      0xf2: "fptan", 0xf3: "fpatan", 0xf4: "fxtract", 0xf5: "fprem1", 0xf6: "fdecstp", 0xf7: "fincstp",
      0xf8: "fprem", 0xf9: "fyl2xp1", 0xfa: "fsqrt", 0xfb: "fsincos", 0xfc: "frndint", 0xfd: "fscale",
      0xfe: "fsin", 0xff: "fcos",
    },
  },
  0xda: {
    mem: ["fiadd Md", "fimul Md", "ficom Md", "ficomp Md", "fisub Md", "fisubr Md", "fidiv Md", "fidivr Md"],
    regs: ["fcmovb ST0,STi", "fcmove ST0,STi", "fcmovbe ST0,STi", "fcmovu ST0,STi", null, null, null, null],
    reg: { 0xe9: "fucompp" },
  },
  0xdb: {
    mem: ["fild Md", "fisttp Md", "fist Md", "fistp Md", null, "fld Mt", null, "fstp Mt"],
    regs: ["fcmovnb ST0,STi", "fcmovne ST0,STi", "fcmovnbe ST0,STi", "fcmovnu ST0,STi", null, "fucomi ST0,STi", "fcomi ST0,STi", null],
    reg: { 0xe2: "fnclex", 0xe3: "fninit" },
  },
  0xdc: {
    mem: ["fadd Mq", "fmul Mq", "fcom Mq", "fcomp Mq", "fsub Mq", "fsubr Mq", "fdiv Mq", "fdivr Mq"],
    regs: ["fadd STi,ST0", "fmul STi,ST0", null, null, "fsubr STi,ST0", "fsub STi,ST0", "fdivr STi,ST0", "fdiv STi,ST0"],
  },
  0xdd: {
    mem: ["fld Mq", "fisttp Mq", "fst Mq", "fstp Mq", "frstor M", null, "fnsave M", "fnstsw Mw"],
    regs: ["ffree STi", null, "fst STi", "fstp STi", "fucom STi", "fucomp STi", null, null],
  },
  0xde: {
    mem: ["fiadd Mw", "fimul Mw", "ficom Mw", "ficomp Mw", "fisub Mw", "fisubr Mw", "fidiv Mw", "fidivr Mw"],
    regs: ["faddp STi,ST0", "fmulp STi,ST0", null, null, "fsubrp STi,ST0", "fsubp STi,ST0", "fdivrp STi,ST0", "fdivp STi,ST0"],
    reg: { 0xd9: "fcompp" },
  },
  0xdf: {
    mem: ["fild Mw", "fisttp Mw", "fist Mw", "fistp Mw", "fbld Mt", "fild Mq", "fbstp Mt", "fistp Mq"],
    regs: ["ffreep STi", null, null, null, null, "fucomip ST0,STi", "fcomip ST0,STi", null],
    reg: { 0xe0: "fnstsw AX" },
  },
};

// objdump folds a leading fwait (9B) into the x87 instruction it
// precedes and renames the pair; the decoder does the same so the two
// agree on what one instruction is.
const FWAIT_FUSION = new Map([
  ["fnstcw", "fstcw"],
  ["fnstsw", "fstsw"],
  ["fnclex", "fclex"],
  ["fninit", "finit"],
  ["fnstenv", "fstenv"],
  ["fnsave", "fsave"],
]);

// A byte reader over the instruction stream that also builds the
// operand list. One instance per decode.
class Cursor {
  constructor(bytes, offset, addr) {
    this.bytes = bytes;
    this.start = offset;
    this.pos = offset;
    this.addr = addr;
    // Prefix state
    this.opsizePrefix = false;
    this.addrsizePrefix = false;
    this.rep = false;
    this.repne = false;
    this.lock = false;
    this.seg = null;
    this.rexW = false;
    this.rexR = 0;
    this.rexX = 0;
    this.rexB = 0;
    this.hasRex = false;
    this.vex = null;
    // ModRM, parsed once on first use
    this.modrm = null;
    this.memOperand = null;
    this.entry64 = false;
    this.imm64 = false;
  }

  u8() {
    if (this.pos >= this.bytes.length) {
      throw new DecodeError("instruction runs past the end of the buffer");
    }
    return this.bytes[this.pos++];
  }

  s8() {
    return (this.u8() << 24) >> 24;
  }

  u16() {
    const lo = this.u8();
    return lo | (this.u8() << 8);
  }

  s32() {
    const b0 = this.u8();
    const b1 = this.u8();
    const b2 = this.u8();
    const b3 = this.u8();
    return b0 | (b1 << 8) | (b2 << 16) | (b3 << 24);
  }

  u64() {
    let v = 0n;
    for (let i = 0; i < 8; i++) {
      v |= BigInt(this.u8()) << BigInt(8 * i);
    }
    return v;
  }

  // Operand size in bytes for a "v" operand.
  get opsize() {
    if (this.rexW) {
      return SIZE.qword;
    }
    if (this.opsizePrefix) {
      return SIZE.word;
    }
    return this.entry64 ? SIZE.qword : SIZE.dword;
  }

  // The size of a "y" operand: 32 or 64 by REX.W.
  get ysize() {
    return this.rexW ? SIZE.qword : SIZE.dword;
  }

  // The 3-bit mandatory prefix selection for SSE maps.
  get mandatory() {
    if (this.vex) {
      return ["np", "66", "f3", "f2"][this.vex.pp];
    }
    if (this.repne) {
      return "f2";
    }
    if (this.rep) {
      return "f3";
    }
    if (this.opsizePrefix) {
      return "66";
    }
    return "np";
  }

  readModrm() {
    if (this.modrm !== null) {
      return this.modrm;
    }
    const b = this.u8();
    this.modrm = { mod: b >> 6, reg: ((b >> 3) & 7) | (this.rexR << 3), rm: b & 7, byte: b };
    if (this.modrm.mod !== 3) {
      this.memOperand = this.readMemory(this.modrm);
    }
    return this.modrm;
  }

  // Decodes the SIB and displacement of a memory ModRM into an operand
  // without a size; callers fill the size in.
  readMemory(modrm) {
    let base = null;
    let index = null;
    let scale = 1;
    let disp = 0n;
    let ripRel = false;
    if (modrm.rm === 4) {
      const sib = this.u8();
      scale = 1 << (sib >> 6);
      const idx = ((sib >> 3) & 7) | (this.rexX << 3);
      const bse = sib & 7;
      if (idx !== 4) {
        index = idx;
      }
      if (bse === 5 && modrm.mod === 0) {
        disp = BigInt(this.s32());
      } else {
        base = bse | (this.rexB << 3);
      }
    } else if (modrm.rm === 5 && modrm.mod === 0) {
      ripRel = true;
      disp = BigInt(this.s32());
    } else {
      base = modrm.rm | (this.rexB << 3);
    }
    if (modrm.mod === 1) {
      disp = BigInt(this.s8());
    } else if (modrm.mod === 2) {
      disp = BigInt(this.s32());
    }
    return { kind: "mem", size: 0, base, index, scale, disp, seg: this.seg, ripRel };
  }

  // Finalises a memory operand: rip-relative displacements become the
  // absolute address once the instruction length is known, which is
  // why this runs after the immediates.
  finishMemory(insnEnd) {
    for (const op of this.operands) {
      if (op.kind === "mem" && op.ripRel) {
        op.disp = BigInt.asUintN(64, insnEnd + op.disp);
      }
    }
  }
}

function gpr(reg, size, cursor) {
  // Without REX, byte registers 4-7 are AH, CH, DH, BH.
  if (size === 1 && !cursor.hasRex && reg >= 4 && reg < 8) {
    return { kind: "reg", reg: reg - 4, size: 1, high: true };
  }
  return { kind: "reg", reg, size, high: false };
}

const IMM_SIGNED = new Set(["Ib", "Iw", "Iz", "Iv"]);

// Decodes one operand spec into an operand, reading bytes as needed.
function operand(spec, c, ops) {
  const fixed = FIXED_OPERANDS[spec];
  if (fixed) {
    return fixed(c);
  }
  const kind = spec[0];
  const size = sizeOf(spec.slice(1), c);
  switch (kind) {
    case "E": {
      const m = c.readModrm();
      if (m.mod === 3) {
        return gpr(m.rm | (c.rexB << 3), size, c);
      }
      return { ...c.memOperand, size };
    }
    case "G": {
      const m = c.readModrm();
      return gpr(m.reg, size, c);
    }
    case "R": {
      const m = c.readModrm();
      return gpr(m.rm | (c.rexB << 3), size, c);
    }
    case "M": {
      const m = c.readModrm();
      if (m.mod === 3) {
        throw new DecodeError("memory operand expected");
      }
      return { ...c.memOperand, size };
    }
    case "I": {
      return immediate(spec, c);
    }
    case "U": {
      if (spec === "Ub") {
        return immediate(spec, c);
      }
      // An xmm register in the r/m field, never memory.
      const m = c.readModrm();
      return { kind: "xmm", reg: m.rm | (c.rexB << 3), size };
    }
    case "J": {
      const rel = spec === "Jb" ? c.s8() : c.s32();
      return { kind: "rel", rel };
    }
    case "Z": {
      const reg = ((c.opcode & 7) | (c.rexB << 3));
      return gpr(reg, size, c);
    }
    case "O": {
      // A 64-bit absolute address (mov al, [moffs64]).
      const disp = c.u64();
      return { kind: "mem", size, base: null, index: null, scale: 1, disp, seg: c.seg, ripRel: false };
    }
    case "X":
      return { kind: "mem", size, base: REG.rsi, index: null, scale: 1, disp: 0n, seg: c.seg, ripRel: false, string: true };
    case "Y":
      return { kind: "mem", size, base: REG.rdi, index: null, scale: 1, disp: 0n, seg: "es", ripRel: false, string: true };
    case "V": {
      const m = c.readModrm();
      return { kind: "xmm", reg: m.reg, size };
    }
    case "W": {
      const m = c.readModrm();
      if (m.mod === 3) {
        return { kind: "xmm", reg: m.rm | (c.rexB << 3), size };
      }
      return { ...c.memOperand, size };
    }
    case "H": {
      // VEX.vvvv as an xmm register.
      return { kind: "xmm", reg: c.vex ? c.vex.vvvv : 0, size };
    }
    case "B": {
      // VEX.vvvv as a general register.
      return gpr(c.vex ? c.vex.vvvv : 0, size, c);
    }
    case "L": {
      // A register in the top bits of an immediate byte (vblendv).
      const b = c.u8();
      return { kind: "xmm", reg: b >> 4, size };
    }
    case "P": {
      const m = c.readModrm();
      return { kind: "mm", reg: m.reg & 7, size: 8 };
    }
    case "Q": {
      const m = c.readModrm();
      if (m.mod === 3) {
        return { kind: "mm", reg: m.rm, size: 8 };
      }
      return { ...c.memOperand, size: 8 };
    }
    case "N": {
      const m = c.readModrm();
      return { kind: "mm", reg: m.rm, size: 8 };
    }
    case "S": {
      const m = c.readModrm();
      return { kind: "sreg", reg: m.reg & 7 };
    }
    case "C": {
      const m = c.readModrm();
      return { kind: "creg", reg: m.reg };
    }
    case "K": {
      const m = c.readModrm();
      return { kind: "kreg", reg: m.rm & 7 };
    }
    case "D": {
      const m = c.readModrm();
      return { kind: "dreg", reg: m.reg };
    }
    default:
      throw new DecodeError(`unknown operand spec ${spec}`);
  }
}

function sizeOf(letters, c) {
  switch (letters) {
    case "b": return SIZE.byte;
    case "w": return SIZE.word;
    case "d": return SIZE.dword;
    case "q": return SIZE.qword;
    case "v": return c.opsize;
    case "y": return c.ysize;
    case "z": return Math.min(c.opsize, SIZE.dword);
    case "x": return c.vex && c.vex.L ? 32 : SIZE.xmm;
    case "ss": return SIZE.dword;
    case "sd": return SIZE.qword;
    case "p": return c.opsize + 2;
    case "t": return 10;
    case "": return 0;
    default:
      throw new DecodeError(`unknown size letter ${letters}`);
  }
}

// Immediates: signed forms sign-extend to the operand size and are
// presented as unsigned 64-bit values; "Ub" is an unsigned byte.
function immediate(spec, c) {
  let value;
  let size;
  switch (spec) {
    case "Ub":
      return { kind: "imm", value: BigInt(c.u8()), size: 1 };
    case "Ib":
      value = BigInt(c.s8());
      size = c.opsize;
      break;
    case "Iw":
      value = BigInt(c.u16());
      size = 2;
      break;
    case "Iz":
      value = c.opsize === 2 ? BigInt((c.u16() << 16) >> 16) : BigInt(c.s32());
      size = c.opsize;
      break;
    case "Iv":
      if (c.opsize === 8 && c.imm64) {
        value = c.u64();
      } else if (c.opsize === 2) {
        value = BigInt((c.u16() << 16) >> 16);
      } else {
        value = BigInt(c.s32());
      }
      size = c.opsize;
      break;
    default:
      throw new DecodeError(`unknown immediate spec ${spec}`);
  }
  return { kind: "imm", value: BigInt.asUintN(size * 8, value), size };
}

const FIXED_OPERANDS = {
  AL: (c) => ({ kind: "reg", reg: REG.rax, size: 1, high: false }),
  CL: (c) => ({ kind: "reg", reg: REG.rcx, size: 1, high: false }),
  AX: (c) => ({ kind: "reg", reg: REG.rax, size: 2, high: false }),
  DX: (c) => ({ kind: "reg", reg: REG.rdx, size: 2, high: false }),
  eAX: (c) => ({ kind: "reg", reg: REG.rax, size: 4, high: false }),
  rAX: (c) => ({ kind: "reg", reg: REG.rax, size: c.opsize, high: false }),
  1: (c) => ({ kind: "imm", value: 1n, size: 1 }),
  ST0: (c) => ({ kind: "st", reg: 0 }),
  STi: (c) => ({ kind: "st", reg: c.modrm.byte & 7 }),
  FS: (c) => ({ kind: "sreg", reg: 4 }),
  GS: (c) => ({ kind: "sreg", reg: 5 }),
};

// Resolves a table entry to a spec string, reading the ModRM byte when
// the entry is a group or splits on register versus memory forms.
function resolve(entry, c) {
  for (;;) {
    if (entry === null || entry === undefined) {
      throw new DecodeError(`invalid opcode at ${c.addr.toString(16)}`);
    }
    if (typeof entry === "string") {
      return entry;
    }
    if (entry.group) {
      const m = c.readModrm();
      entry = entry.group[m.reg & 7];
      continue;
    }
    if (entry.mem !== undefined || entry.reg !== undefined) {
      const m = c.readModrm();
      if (m.mod !== 3) {
        entry = entry.mem;
        continue;
      }
      if (typeof entry.reg === "string" || entry.reg === null) {
        entry = entry.reg;
        continue;
      }
      // A map from the whole ModRM byte, with an optional fallback by
      // reg field and then a default.
      const exact = entry.reg[m.byte];
      if (exact !== undefined) {
        entry = exact;
        continue;
      }
      if (entry.regGroup) {
        const byReg = entry.regGroup[m.reg & 7];
        if (byReg) {
          entry = byReg;
          continue;
        }
      }
      entry = entry.regDefault !== undefined ? entry.regDefault : null;
      continue;
    }
    // Keyed by mandatory prefix.
    const key = c.mandatory;
    if (c.vex && key === "f2" && entry.f2vex) {
      // A VEX-only form sharing a legacy opcode: named as is.
      c.vexNative = true;
      entry = entry.f2vex;
      continue;
    }
    let next = entry[key];
    if (next === undefined && key !== "np" && entry.np !== undefined && !entry.vexOnly) {
      // A 66/F2/F3 that is not a mandatory prefix here: it was an
      // operand-size or rep prefix on the unprefixed form.
      next = entry.np;
      c.prefixIsOperand = true;
    }
    if (next === undefined && c.vex && entry.np !== undefined) {
      next = entry.np;
    }
    entry = next;
    if (typeof entry === "string") {
      // A mandatory prefix consumed here is not a rep or operand-size
      // prefix on the instruction.
      if (!c.prefixIsOperand) {
        if (key === "f3") {
          c.rep = false;
        } else if (key === "f2") {
          c.repne = false;
        }
        c.prefixWasMandatory = key !== "np";
      }
      return entry;
    }
  }
}

function decodeX87(c) {
  const table = X87[c.opcode];
  const m = c.readModrm();
  if (m.mod !== 3) {
    return table.mem[m.reg & 7];
  }
  const exact = table.reg && table.reg[m.byte];
  if (exact !== undefined) {
    return exact;
  }
  return table.regs[m.reg & 7];
}

// Decodes the instruction at bytes[offset], which sits at guest address
// addr (a BigInt). Returns an instruction record; throws DecodeError
// for bytes that are not a known instruction.
export function decode(bytes, offset, addr) {
  const c = new Cursor(bytes, offset, addr);

  // Legacy prefixes, in any order and number.
  let b;
  for (;;) {
    b = c.u8();
    if (b === 0x66) {
      c.opsizePrefix = true;
    } else if (b === 0x67) {
      c.addrsizePrefix = true;
    } else if (b === 0xf3) {
      c.rep = true;
      c.repne = false;
    } else if (b === 0xf2) {
      c.repne = true;
      c.rep = false;
    } else if (b === 0xf0) {
      c.lock = true;
    } else if (b === 0x2e || b === 0x36 || b === 0x3e || b === 0x26) {
      // CS, SS, DS and ES are ignored in 64-bit mode and serve as
      // branch hints or the notrack prefix; fs and gs are real.
      c.seg = null;
    } else if (b === 0x64) {
      c.seg = "fs";
    } else if (b === 0x65) {
      c.seg = "gs";
    } else {
      break;
    }
    if (c.pos - c.start > 14) {
      throw new DecodeError("too many prefixes");
    }
  }

  // REX
  if (b >= 0x40 && b <= 0x4f) {
    c.hasRex = true;
    c.rexW = (b & 8) !== 0;
    c.rexR = (b >> 2) & 1;
    c.rexX = (b >> 1) & 1;
    c.rexB = b & 1;
    b = c.u8();
  }

  let map = "1";
  let spec;

  if (b === 0xc4 || b === 0xc5 || b === 0x62) {
    spec = decodeVex(c, b);
    map = c.vexMap;
  } else if (b === 0x9b) {
    // fwait, possibly fused with the x87 instruction that follows.
    spec = decodeFwait(c);
  } else {
    c.opcode = b;
    let entry = ONE_BYTE[b];
    if (entry && entry.escape) {
      b = c.u8();
      c.opcode = b;
      map = "0f";
      entry = TWO_BYTE[b];
      if (entry && entry.escape === "0f38") {
        b = c.u8();
        c.opcode = b;
        map = "0f38";
        entry = THREE_BYTE_38[b];
      } else if (entry && entry.escape === "0f3a") {
        b = c.u8();
        c.opcode = b;
        map = "0f3a";
        entry = THREE_BYTE_3A[b];
      }
      if (entry && entry.vexOnly) {
        throw new DecodeError(`VEX-only opcode without VEX at ${c.addr.toString(16)}`);
      }
    } else if (entry && entry.x87) {
      spec = decodeX87(c);
      entry = null;
    } else if (entry && (entry.prefix || entry.rex || entry.vex || entry.evex)) {
      throw new DecodeError(`stray prefix byte ${b.toString(16)} at ${c.addr.toString(16)}`);
    }
    if (spec === undefined) {
      spec = resolve(entry, c);
    }
  }

  if (spec === null || spec === undefined) {
    throw new DecodeError(`invalid opcode at ${c.addr.toString(16)}`);
  }

  // Parse the spec: "mnemonic op1,op2 !flags"
  const words = spec.split(" ");
  let mnemonic = words[0];
  const flags = words.filter((w) => w.startsWith("!"));
  c.entry64 = flags.includes("!64");
  c.imm64 = flags.includes("!imm64");
  const opSpecs = words.length > 1 && !words[1].startsWith("!") ? words[1].split(",") : [];

  c.operands = [];
  for (const s of opSpecs) {
    c.operands.push(operand(s, c, c.operands));
  }

  // Post-fixes for opcodes whose name depends on size or prefix.
  if (map === "1") {
    mnemonic = fixupOneByte(mnemonic, c);
  } else if (map === "0f" && c.opcode === 0x7e && c.mandatory === "66" && c.rexW) {
    mnemonic = "movq";
  } else if (map === "0f" && c.opcode === 0x6e && c.mandatory === "66" && c.rexW) {
    mnemonic = "movq";
  } else if (map === "0f" && c.opcode === 0x6e && c.mandatory === "np" && c.rexW) {
    mnemonic = "movq";
  } else if (map === "0f" && c.opcode === 0x7e && c.mandatory === "np" && c.rexW) {
    mnemonic = "movq";
  } else if (map === "0f3a" && (c.opcode === 0x16 || c.opcode === 0x22) && c.rexW) {
    mnemonic = c.opcode === 0x16 ? "pextrq" : "pinsrq";
  } else if (map === "0f" && c.opcode === 0xc7 && c.modrm && (c.modrm.reg & 7) === 1 && c.rexW) {
    mnemonic = "cmpxchg16b";
  }

  // A size fixup names the legacy instruction; a VEX form that had its
  // v before the fixup gets it back.
  if (c.vex !== null && words[0].startsWith("v") && !mnemonic.startsWith("v")) {
    mnemonic = "v" + mnemonic;
  }

  const len = c.pos - c.start;
  const end = BigInt.asUintN(64, addr + BigInt(len));
  c.finishMemory(end);
  for (const op of c.operands) {
    if (op.kind === "rel") {
      op.target = BigInt.asUintN(64, end + BigInt(op.rel));
    }
  }

  const insn = {
    addr,
    len,
    mnemonic,
    opsize: c.opsize,
    operands: c.operands,
    rep: c.rep,
    repne: c.repne,
    lock: c.lock,
    addr32: c.addrsizePrefix,
    vex: c.vex !== null,
  };
  const cond = conditionOf(mnemonic);
  if (cond !== null) {
    insn.cond = cond;
  }
  return insn;
}

// Names that change with operand size or a prefix on the one-byte map.
function fixupOneByte(mnemonic, c) {
  switch (c.opcode) {
    case 0x90:
      if (c.rexB) {
        c.operands = [gpr(8, c.opsize, c), gpr(0, c.opsize, c)];
        return "xchg";
      }
      if (c.rep) {
        c.rep = false;
        return "pause";
      }
      if (c.opsizePrefix) {
        c.operands = [gpr(0, 2, c), gpr(0, 2, c)];
        return "xchg";
      }
      return "nop";
    case 0x98:
      return c.opsize === 8 ? "cdqe" : c.opsize === 2 ? "cbw" : "cwde";
    case 0x99:
      return c.opsize === 8 ? "cqo" : c.opsize === 2 ? "cwd" : "cdq";
    case 0x63:
      // Without REX.W it is a plain 32-bit move that objdump still
      // calls movsxd.
      return "movsxd";
    default:
      return mnemonic;
  }
}

function decodeFwait(c) {
  // Peek at the next instruction: an x87 store or control form gets the
  // waiting name.
  const save = c.pos;
  try {
    const next = c.u8();
    if (next >= 0xd8 && next <= 0xdf) {
      c.opcode = next;
      const spec = decodeX87(c);
      if (spec) {
        const name = spec.split(" ")[0];
        const fused = FWAIT_FUSION.get(name);
        if (fused) {
          return fused + spec.slice(name.length);
        }
      }
    }
  } catch (e) {
    if (!(e instanceof DecodeError)) {
      throw e;
    }
  }
  c.pos = save;
  c.modrm = null;
  c.memOperand = null;
  c.opcode = 0x9b;
  return "fwait";
}

// VEX (C4/C5) and EVEX (62) prefixes. The fields that matter to the
// operand shape are read; the rest are kept on c.vex for the record.
function decodeVex(c, first) {
  let mapSel;
  let W = 0;
  let vvvv;
  let L;
  let pp;
  if (first === 0xc5) {
    const b1 = c.u8();
    c.rexR = ((~b1) >> 7) & 1;
    mapSel = 1;
    vvvv = (~b1 >> 3) & 15;
    L = (b1 >> 2) & 1;
    pp = b1 & 3;
  } else if (first === 0xc4) {
    const b1 = c.u8();
    const b2 = c.u8();
    c.rexR = ((~b1) >> 7) & 1;
    c.rexX = ((~b1) >> 6) & 1;
    c.rexB = ((~b1) >> 5) & 1;
    mapSel = b1 & 31;
    W = b2 >> 7;
    vvvv = (~b2 >> 3) & 15;
    L = (b2 >> 2) & 1;
    pp = b2 & 3;
  } else {
    // EVEX: P0 P1 P2
    const p0 = c.u8();
    const p1 = c.u8();
    const p2 = c.u8();
    c.rexR = ((~p0) >> 7) & 1;
    c.rexX = ((~p0) >> 6) & 1;
    c.rexB = ((~p0) >> 5) & 1;
    mapSel = p0 & 7;
    W = p1 >> 7;
    vvvv = (~p1 >> 3) & 15;
    pp = p1 & 3;
    L = (p2 >> 5) & 3;
    c.evex = { z: p2 >> 7, aaa: p2 & 7, b: (p2 >> 4) & 1 };
  }
  c.hasRex = true;
  c.rexW = W === 1;
  c.vex = { vvvv, L, pp, W, map: mapSel };

  const opcode = c.u8();
  c.opcode = opcode;
  let mapName;
  let table;
  c.vexMap = null;
  if (mapSel === 1) {
    mapName = "0f";
    table = TWO_BYTE;
  } else if (mapSel === 2) {
    mapName = "0f38";
    table = THREE_BYTE_38;
  } else if (mapSel === 3) {
    mapName = "0f3a";
    table = THREE_BYTE_3A;
  } else {
    throw new DecodeError(`VEX map ${mapSel} at ${c.addr.toString(16)}`);
  }
  c.vexMap = mapName;

  // 0F 77 is vzeroupper at 128 bits and vzeroall at 256.
  if (mapName === "0f" && opcode === 0x77) {
    return L ? "vzeroall" : "vzeroupper";
  }
  // The FMA block, 0F 38 96-BF: ten forms per operand order, W
  // choosing double over single.
  if (mapName === "0f38" && opcode >= 0x96 && opcode <= 0xbf) {
    const orders = { 0x90: "132", 0xa0: "213", 0xb0: "231" };
    const order = orders[opcode & 0xf0];
    const kind = FMA_KINDS[(opcode & 0x0f) - 6];
    if (order !== undefined && kind !== undefined) {
      const [name, scalar] = kind;
      const suffix = scalar ? (W ? "sd" : "ss") : W ? "pd" : "ps";
      return `${name}${order}${suffix} Vx,Hx,${scalar ? (W ? "Wsd" : "Wss") : "Wx"}`;
    }
  }

  // Prefer the VEX-only table, then the legacy table with a v prefix.
  // An opcode in neither is decoded by shape alone: every VEX and EVEX
  // instruction carries a ModRM, and the 0F 3A map adds an immediate
  // byte. That is enough to step over the AVX-512 forms in glibc.
  let entry = VEX_ONLY[mapName][opcode];
  let fromLegacy = false;
  if (entry === undefined) {
    entry = table[opcode];
    fromLegacy = true;
  }
  if (entry === null || entry === undefined) {
    entry = mapName === "0f3a" ? "vunknown Vx,Wx,Ub" : "vunknown Vx,Wx";
    fromLegacy = false;
  }
  let spec = resolve(entry, c);
  if (fromLegacy && !(entry && entry.vexOnly) && !c.vexNative && !spec.startsWith("v")) {
    spec = vexShape("v" + spec);
  }
  if (c.evex) {
    spec = evexRename(spec, c);
  }
  return spec;
}

// Instructions whose VEX form does not use vvvv: the destination and
// one source, as in the legacy form.
const VEX_TWO_OPERAND = new Set([
  "vmovdqu", "vmovdqa", "vmovups", "vmovaps", "vmovupd", "vmovapd", "vmovd", "vmovq", "vmovntdq",
  "vmovntps", "vmovntpd", "vpmovmskb", "vmovmskps", "vmovmskpd", "vpshufd", "vpshufhw", "vpshuflw",
  "vptest", "vcvtdq2ps", "vcvtps2dq", "vcvttps2dq", "vcvtdq2pd", "vcvtps2pd", "vcvtpd2ps", "vcvttpd2dq",
  "vcvtpd2dq", "vsqrtps", "vsqrtpd", "vrcpps", "vrsqrtps", "vpabsb", "vpabsw", "vpabsd", "vpmovzxbw",
  "vpmovzxbd", "vpmovzxbq", "vpmovzxwd", "vpmovzxwq", "vpmovzxdq", "vpmovsxbw", "vpmovsxbd", "vpmovsxbq",
  "vpmovsxwd", "vpmovsxwq", "vpmovsxdq", "vlddqu", "vmovddup", "vmovshdup", "vmovsldup", "vroundps",
  "vroundpd", "vcomiss", "vcomisd", "vucomiss", "vucomisd", "vpextrb", "vpextrw", "vpextrd", "vpextrq",
  "vcvtss2si", "vcvtsd2si", "vcvttss2si", "vcvttsd2si", "vstmxcsr", "vldmxcsr", "vextractps",
  "vpcmpestri", "vpcmpistri", "vpcmpestrm", "vpcmpistrm", "vphminposuw", "vaesimc", "vmovlps", "vmovhps",
  "vmovlpd", "vmovhpd",
]);

// The shift-by-immediate group writes vvvv and reads r/m.
const VEX_SHIFT_IMM = new Set(["vpsrlw", "vpsrld", "vpsrlq", "vpsraw", "vpsrad", "vpsllw", "vpslld", "vpsllq", "vpsrldq", "vpslldq"]);

// Rewrites a legacy two-operand spec into the VEX three-operand one:
// most take (Vx, Hx, Wx); the shift-immediate group (Hx, Ux, Ub).
function vexShape(spec) {
  const [name, ops = ""] = spec.split(" ");
  // vmovss/vmovsd merge from a second register but load from memory;
  // which it is shows only after ModRM, so both keep the W operand.
  if ((name === "vmovss" || name === "vmovsd") && ops.startsWith("W")) {
    return spec;
  }
  if (VEX_TWO_OPERAND.has(name) || ops === "") {
    return spec;
  }
  const parts = ops.split(",");
  if (VEX_SHIFT_IMM.has(name) && parts[0] === "Ux" && parts[1] === "Ub") {
    return `${name} Hx,Ux,Ub`;
  }
  if (parts[0].startsWith("V") && parts.length >= 2 && (parts[1].startsWith("W") || parts[1].startsWith("U") || parts[1].startsWith("E") || parts[1].startsWith("M"))) {
    // Memory-destination forms (vmovlps m64, xmm) keep two operands.
    return `${name} ${parts[0]},Hx,${parts.slice(1).join(",")}`;
  }
  if (parts[0].startsWith("W") || parts[0].startsWith("M")) {
    return spec;
  }
  return spec;
}

// EVEX forms objdump names differently from their VEX twins, enough
// for the fixture; the translator never runs any of them.
function evexRename(spec, c) {
  const words = spec.split(" ");
  const name = words[0];
  const rest = words.slice(1).join(" ");
  const RENAMES = {
    vmovdqa: c.rexW ? "vmovdqa64" : "vmovdqa32",
    vmovdqu: c.mandatory === "f2" ? (c.rexW ? "vmovdqu16" : "vmovdqu8") : c.rexW ? "vmovdqu64" : "vmovdqu32",
    vpxor: c.rexW ? "vpxorq" : "vpxord",
    vpand: c.rexW ? "vpandq" : "vpandd",
    vpandn: c.rexW ? "vpandnq" : "vpandnd",
    vpor: c.rexW ? "vporq" : "vpord",
  };
  const renamed = RENAMES[name];
  return renamed ? `${renamed} ${rest}`.trim() : spec;
}

function conditionOf(mnemonic) {
  for (const prefix of ["j", "set", "cmov"]) {
    if (mnemonic.startsWith(prefix)) {
      const idx = COND_NAMES.indexOf(mnemonic.slice(prefix.length));
      if (idx >= 0) {
        return idx;
      }
    }
  }
  return null;
}
