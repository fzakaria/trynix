#!/usr/bin/env python3
"""Generate the translator's semantics fixture from the real CPU.

Every instruction form the translator claims to implement is assembled
into a snippet, given a few random register and memory states, and run
on this machine through harness.c. The register, flag, xmm and memory
state the hardware leaves is written to a JSON fixture that
tests/x86/semantics.test.mjs replays through the translator.

    nix run .#x86-semantics -- <fixture.json>

Inputs are derived from a per-case seed with the xorshift generator in
this file, which the test reimplements, so the fixture carries seeds
rather than the 256 bytes of scratch memory each case starts from.

Flags an instruction leaves undefined are masked per form; the manual
says which. Everything else is compared bit for bit.
"""

import json
import os
import random
import subprocess
import sys
import tempfile

SNIPPET = 0x601000
SCRATCH = 0x610000
SCRATCH_SIZE = 256
STACK = SCRATCH + 0xC0

ALL_FLAGS = 0x8D5
CF, PF, AF, ZF, SF, OF = 1, 4, 16, 64, 128, 2048

R64 = ["rax", "rcx", "rdx", "rbx", "rbp", "rsi", "rdi", "r8", "r9", "r10", "r11", "r12", "r13", "r14", "r15"]
R32 = ["eax", "ecx", "edx", "ebx", "ebp", "esi", "edi", "r8d", "r9d", "r10d", "r11d", "r12d", "r13d", "r14d", "r15d"]
R16 = ["ax", "cx", "dx", "bx", "bp", "si", "di", "r8w", "r9w", "r10w", "r11w", "r12w", "r13w", "r14w", "r15w"]
R8 = ["al", "cl", "dl", "bl", "ah", "ch", "dh", "bh", "sil", "dil", "r8b", "r9b", "r12b", "r15b"]
REGS_BY_SIZE = {8: R8, 16: R16, 32: R32, 64: R64}
PTR = {"b": "BYTE", "w": "WORD", "d": "DWORD", "q": "QWORD", "x": "XMMWORD"}
SIZE_LETTER = {8: "b", 16: "w", 32: "d", 64: "q"}

# The registers a case uses as pointers into the scratch page; the
# generator gives them scratch addresses.
POINTER_REGS = ["rbx", "rsi", "r12", "r13"]

SPECIAL_INTS = [0, 1, 2, 3, 0x7F, 0x80, 0xFF, 0x100, 0x7FFF, 0x8000, 0xFFFF, 0x7FFFFFFF, 0x80000000,
                0xFFFFFFFF, 0x100000000, 0x7FFFFFFFFFFFFFFF, 0x8000000000000000, 0xFFFFFFFFFFFFFFFF,
                0xFFFFFFFFFFFFFFFE, 0x0123456789ABCDEF, 63, 64, 65, 31, 32, 33]

# Floating-point bit patterns worth having in registers and memory.
SPECIAL_F64 = [0.0, -0.0, 1.0, -1.0, 0.5, 1.5, 2.5, -2.5, 1e300, -1e300, 3.141592653589793,
               float("inf"), float("-inf"), float("nan"), 5e-324, 2147483647.0, 2147483648.0,
               -2147483648.0, -2147483649.0, 9.2233720368547758e18, -9.2233720368547758e18, 123456789.987]


def xorshift(seed):
    s = seed & 0xFFFFFFFFFFFFFFFF
    if s == 0:
        s = 0x9E3779B97F4A7C15
    while True:
        s ^= (s << 13) & 0xFFFFFFFFFFFFFFFF
        s ^= s >> 7
        s ^= (s << 17) & 0xFFFFFFFFFFFFFFFF
        yield s


def scratch_bytes(seed):
    gen = xorshift(seed)
    out = bytearray()
    while len(out) < SCRATCH_SIZE:
        out += next(gen).to_bytes(8, "little")
    return bytes(out[:SCRATCH_SIZE])


def rand_int(rng):
    r = rng.random()
    if r < 0.35:
        return rng.choice(SPECIAL_INTS)
    if r < 0.6:
        return rng.getrandbits(64)
    if r < 0.8:
        return rng.getrandbits(32)
    return rng.getrandbits(8)


class Case:
    def __init__(self, name, asm, mask=ALL_FLAGS, sse=False, mem=False, setup=None, floats=False):
        self.name = name
        self.asm = asm
        self.mask = mask
        self.sse = sse
        self.mem = mem
        self.setup = setup or {}
        self.floats = floats


FORMS = []


def form(name, asm, **kw):
    FORMS.append(Case(name, asm, **kw))


def mem(size, base="rbx", disp=0x20):
    return f"{PTR[SIZE_LETTER[size]]} PTR [{base}+{disp:#x}]"


# ---- integer forms -------------------------------------------------

for op in ["add", "sub", "and", "or", "xor", "cmp", "test", "adc", "sbb"]:
    for size in [8, 16, 32, 64]:
        regs = REGS_BY_SIZE[size]
        a, b = regs[0], regs[1]
        form(f"{op} {a},{b}", f"{op} {a},{b}")
        a, b = regs[-1], regs[3]
        form(f"{op} {a},{b}", f"{op} {a},{b}")
        form(f"{op} {a},imm8", f"{op} {a},-7")
        if size > 8:
            form(f"{op} {a},imm", f"{op} {a},0x7654" if size == 16 else f"{op} {a},0x12345678")
            form(f"{op} {a},imm neg", f"{op} {a},-0x1234")
        form(f"{op} {a},[m]", f"{op} {a},{mem(size)}", mem=True)
        if op != "test":
            form(f"{op} [m],{a}", f"{op} {mem(size)},{a}", mem=True)
        form(f"{op} [m],imm", f"{op} {mem(size)},0x35", mem=True)
    # accumulator forms
    form(f"{op} al,imm", f"{op} al,0x9a")
    form(f"{op} rax,imm", f"{op} rax,-0x100")
    form(f"{op} ah,dh", f"{op} ah,dh")
    form(f"{op} ah,imm", f"{op} ah,0x80")

for op in ["inc", "dec", "neg", "not"]:
    for size in [8, 16, 32, 64]:
        regs = REGS_BY_SIZE[size]
        form(f"{op} {regs[2]}", f"{op} {regs[2]}")
        form(f"{op} [m]{size}", f"{op} {mem(size)}", mem=True)
    form(f"{op} ah", f"{op} ah")

# Shifts: OF is defined only for a count of 1, AF never.
for op in ["shl", "shr", "sar"]:
    for size in [8, 16, 32, 64]:
        regs = REGS_BY_SIZE[size]
        r = regs[2]
        form(f"{op} {r},1", f"{op} {r},1", mask=ALL_FLAGS & ~AF)
        for cnt in [3, 7, 15, 31, 33, 63]:
            form(f"{op} {r},{cnt}", f"{op} {r},{cnt}", mask=ALL_FLAGS & ~(AF | OF))
        form(f"{op} {r},cl", f"{op} {r},cl", mask=ALL_FLAGS & ~(AF | OF), setup={"rcx": "shiftcount"})
        form(f"{op} [m]{size},cl", f"{op} {mem(size)},cl", mem=True, mask=ALL_FLAGS & ~(AF | OF), setup={"rcx": "shiftcount"})
        form(f"{op} [m]{size},5", f"{op} {mem(size)},5", mem=True, mask=ALL_FLAGS & ~(AF | OF))
for op in ["rol", "ror"]:
    for size in [8, 16, 32, 64]:
        regs = REGS_BY_SIZE[size]
        r = regs[6]
        form(f"{op} {r},1", f"{op} {r},1")
        form(f"{op} {r},5", f"{op} {r},5", mask=ALL_FLAGS & ~OF)
        form(f"{op} {r},cl", f"{op} {r},cl", mask=ALL_FLAGS & ~OF, setup={"rcx": "shiftcount"})
for op in ["shld", "shrd"]:
    for size in [16, 32, 64]:
        regs = REGS_BY_SIZE[size]
        form(f"{op} {regs[0]},{regs[2]},1", f"{op} {regs[0]},{regs[2]},1", mask=ALL_FLAGS & ~AF)
        form(f"{op} {regs[0]},{regs[2]},9", f"{op} {regs[0]},{regs[2]},9", mask=ALL_FLAGS & ~(AF | OF))
        count_kind = "shiftcount16" if size == 16 else "shiftcount"
        form(f"{op} {regs[0]},{regs[2]},cl", f"{op} {regs[0]},{regs[2]},cl", mask=ALL_FLAGS & ~(AF | OF), setup={"rcx": count_kind})
        form(f"{op} [m],{regs[2]},cl", f"{op} {mem(size)},{regs[2]},cl", mem=True, mask=ALL_FLAGS & ~(AF | OF), setup={"rcx": count_kind})

MUL_MASK = CF | OF
for size in [8, 16, 32, 64]:
    regs = REGS_BY_SIZE[size]
    form(f"mul {regs[2]}", f"mul {regs[2]}", mask=MUL_MASK)
    form(f"imul {regs[2]}", f"imul {regs[2]}", mask=MUL_MASK)
    form(f"mul [m]{size}", f"mul {mem(size)}", mem=True, mask=MUL_MASK)
    form(f"imul [m]{size}", f"imul {mem(size)}", mem=True, mask=MUL_MASK)
    if size > 8:
        form(f"imul {regs[0]},{regs[2]}", f"imul {regs[0]},{regs[2]}", mask=MUL_MASK)
        form(f"imul {regs[0]},{regs[2]},imm8", f"imul {regs[0]},{regs[2]},-3", mask=MUL_MASK)
        form(f"imul {regs[0]},{regs[2]},imm", f"imul {regs[0]},{regs[2]},0x1234", mask=MUL_MASK)
        form(f"imul {regs[0]},[m]", f"imul {regs[0]},{mem(size)}", mem=True, mask=MUL_MASK)
    form(f"div {regs[1]}", f"div {regs[1]}", mask=0, setup={"div": size})
    form(f"idiv {regs[1]}", f"idiv {regs[1]}", mask=0, setup={"idiv": size})

for size in [16, 32, 64]:
    regs = REGS_BY_SIZE[size]
    form(f"movzx {regs[0]},r8", f"movzx {regs[0]},dl")
    if size < 64:
        form(f"movzx {regs[0]},ah", f"movzx {regs[0]},ah")
    form(f"movsx {regs[0]},r8", f"movsx {regs[0]},dl")
    form(f"movzx {regs[0]},[m]8", f"movzx {regs[0]},{mem(8)}", mem=True)
    form(f"movsx {regs[0]},[m]8", f"movsx {regs[0]},{mem(8)}", mem=True)
    if size > 16:
        form(f"movzx {regs[0]},r16", f"movzx {regs[0]},dx")
        form(f"movsx {regs[0]},r16", f"movsx {regs[0]},dx")
        form(f"movsx {regs[0]},[m]16", f"movsx {regs[0]},{mem(16)}", mem=True)
form("movsxd rax,edx", "movsxd rax,edx")
form("movsxd rax,[m]", f"movsxd rax,{mem(32)}", mem=True)
for op in ["cbw", "cwde", "cdqe", "cwd", "cdq", "cqo"]:
    form(op, op)

form("lea r64 base+index*8+disp", "lea rax,[rbx+rcx*8+0x1234]")
form("lea r64 index*4+disp", "lea rax,[rcx*4+0x10]")
form("lea r64 base+disp32", "lea rax,[rdx-0x12345]")
form("lea r32", "lea eax,[rbx+rcx*2+0x10]")
form("lea r16", "lea ax,[rbx+rcx*2+0x10]")
form("lea rip-relative", "lea rax,[rip+0x100]")

for size in [8, 16, 32, 64]:
    regs = REGS_BY_SIZE[size]
    form(f"mov {regs[0]},{regs[1]}", f"mov {regs[0]},{regs[1]}")
    form(f"mov {regs[3]},{regs[-1]}", f"mov {regs[3]},{regs[-1]}")
    form(f"mov {regs[0]},[m]", f"mov {regs[0]},{mem(size)}", mem=True)
    form(f"mov [m],{regs[0]}", f"mov {mem(size)},{regs[0]}", mem=True)
    form(f"mov [m],imm{size}", f"mov {mem(size)},-0x12" if size > 8 else f"mov {mem(size)},0xab", mem=True)
    form(f"mov {regs[2]},imm", f"mov {regs[2]},0x7f" if size == 8 else f"mov {regs[2]},-0x1234")
    form(f"xchg {regs[0]},{regs[1]}", f"xchg {regs[0]},{regs[1]}")
    form(f"xchg {regs[2]},[m]", f"xchg {regs[2]},{mem(size)}", mem=True)
    form(f"xadd [m],{regs[2]}", f"xadd {mem(size)},{regs[2]}", mem=True)
    form(f"xadd {regs[0]},{regs[2]}", f"xadd {regs[0]},{regs[2]}")
    form(f"cmpxchg [m],{regs[2]}", f"cmpxchg {mem(size)},{regs[2]}", mem=True)
    form(f"cmpxchg {regs[1]},{regs[2]}", f"cmpxchg {regs[1]},{regs[2]}")
    form(f"cmpxchg eq [m],{regs[2]}", f"mov {regs[0]},{mem(size)}; cmpxchg {mem(size)},{regs[2]}", mem=True)
form("mov rax,imm64", "movabs rax,0x123456789abcdef0")
form("mov r9,imm64", "movabs r9,-0x123456789abcdef")
form("mov ah,imm", "mov ah,0x5a")
form("mov ch,al", "mov ch,al")
form("mov [m],ah", f"mov {mem(8)},ah", mem=True)
form("mov eax,[m] zero-extends", f"mov eax,{mem(32)}", mem=True)
form("xchg rax,r8", "xchg rax,r8")
form("xchg eax,ecx", "xchg eax,ecx")

BT_MASK = CF
for size in [16, 32, 64]:
    regs = REGS_BY_SIZE[size]
    for op in ["bt", "bts", "btr", "btc"]:
        form(f"{op} {regs[0]},{regs[2]}", f"{op} {regs[0]},{regs[2]}", mask=BT_MASK)
        form(f"{op} {regs[0]},imm", f"{op} {regs[0]},{size - 3}", mask=BT_MASK)
        form(f"{op} [m],imm", f"{op} {mem(size)},5", mem=True, mask=BT_MASK)
        form(f"{op} [m],{regs[2]}", f"{op} {mem(size)},{regs[2]}", mem=True, mask=BT_MASK, setup={regs[2]: "bitoffset"})
    form(f"bsf {regs[0]},{regs[2]}", f"bsf {regs[0]},{regs[2]}", mask=ZF, setup={"nonzero-or-zero": regs[2]})
    form(f"bsr {regs[0]},{regs[2]}", f"bsr {regs[0]},{regs[2]}", mask=ZF, setup={"nonzero-or-zero": regs[2]})
    form(f"tzcnt {regs[0]},{regs[2]}", f"tzcnt {regs[0]},{regs[2]}", mask=CF | ZF)
    form(f"lzcnt {regs[0]},{regs[2]}", f"lzcnt {regs[0]},{regs[2]}", mask=CF | ZF)
    form(f"popcnt {regs[0]},{regs[2]}", f"popcnt {regs[0]},{regs[2]}")
    form(f"popcnt {regs[0]},[m]", f"popcnt {regs[0]},{mem(size)}", mem=True)
form("bswap eax", "bswap eax")
form("bswap r10", "bswap r10")
form("movbe eax,[m]", f"movbe eax,{mem(32)}", mem=True)
form("movbe [m],rax", f"movbe {mem(64)},rax", mem=True)
form("movbe [m],ax", f"movbe {mem(16)},ax", mem=True)

CONDS = ["o", "no", "b", "ae", "e", "ne", "be", "a", "s", "ns", "p", "np", "l", "ge", "le", "g"]
for cc in CONDS:
    form(f"set{cc} from flags", f"set{cc} al")
    form(f"cmp;set{cc}", f"cmp rax,rcx; set{cc} dl")
    form(f"cmp32;set{cc}", f"cmp eax,ecx; set{cc} dl")
    form(f"cmp8;set{cc}", f"cmp al,cl; set{cc} dl")
    form(f"test;set{cc}", f"test rax,rcx; set{cc} dl")
    form(f"sub;set{cc}", f"sub rax,rcx; set{cc} dl")
    form(f"add;set{cc}", f"add eax,ecx; set{cc} dl")
    form(f"and;set{cc}", f"and rax,rcx; set{cc} dl")
    form(f"inc;set{cc}", f"inc eax; set{cc} dl")
    form(f"dec;set{cc}", f"dec ax; set{cc} dl")
    form(f"neg;set{cc}", f"neg eax; set{cc} dl")
    form(f"cmov{cc} from flags", f"cmov{cc} rax,rcx")
    form(f"cmov{cc} 32 from flags", f"cmov{cc} eax,ecx")
    form(f"cmp;cmov{cc} 16", f"cmp rdx,rsi; cmov{cc} ax,cx")
    form(f"cmp;j{cc}", f"cmp rax,rcx; j{cc} 1f; mov edx,1; 1: mov esi,2")
    form(f"cmp16;j{cc}", f"cmp ax,cx; j{cc} 1f; mov edx,1; 1: mov esi,2")
    form(f"test8;j{cc}", f"test al,cl; j{cc} 1f; mov edx,1; 1: mov esi,2")
    if cc not in ("o", "no", "l", "ge", "le", "g"):
        form(f"shr;j{cc}", f"shr rax,3; j{cc} 1f; mov edx,1; 1: mov esi,2", mask=ALL_FLAGS & ~(AF | OF))
    form(f"flags;j{cc}", f"j{cc} 1f; mov edx,1; 1: mov esi,2")
    form(f"cmp;set{cc};flags after", f"cmp rax,rcx; set{cc} dl; pushf; pop rsi")

form("push/pop", "push rax; push rcx; pop rdx; pop rsi")
form("push imm8/imm32", "push -5; push 0x12345678; pop rdx; pop rsi")
form("push [m]", f"push {mem(64)}; pop rsi", mem=True)
form("pop [m]", f"push rax; pop {mem(64)}", mem=True)
form("push r16", "push ax; pop dx")
form("call/ret", "call 1f; jmp 2f; 1: mov edx,7; ret; 2: mov esi,9")
form("call indirect", "lea rax,[rip+1f]; call rax; jmp 2f; 1: mov edx,7; ret; 2: mov esi,9")
form("jmp indirect", "lea rax,[rip+1f]; jmp rax; mov edx,1; 1: mov esi,9")
form("jmp [m]", f"lea rax,[rip+1f]; mov {mem(64)},rax; jmp {mem(64)}; mov edx,1; 1: mov esi,9", mem=True)
form("ret imm", "call 1f; jmp 2f; 1: ret 8; 2: mov esi,9", setup={"stack-slack": True})
form("leave", "push rbp; mov rbp,rsp; sub rsp,32; leave")
form("enter", "enter 32,0; leave")
form("pushf/popf", "pushf; pop rax; xor rax,0x8d5; push rax; popf; pushf; pop rdx")
form("lahf/sahf", "lahf; xor ah,0xd5; sahf; lahf")
form("clc/stc/cmc", "cmc; setc al; stc; setc cl; clc; setc dl; cmc")
form("stc; adc", "stc; adc eax,ecx")
form("clc; sbb", "clc; sbb rax,rcx")
form("stc; sbb 8", "stc; sbb al,cl")
form("stc; rcl", "stc; rcl eax,1", mask=CF | OF)
form("stc; rcr", "stc; rcr rax,1", mask=CF | OF)
form("rcl imm", "rcl eax,5", mask=CF)
form("rcr imm", "rcr rax,9", mask=CF)

# String instructions: rcx small, rsi and rdi into scratch, both directions.
for suffix, size in [("b", 8), ("w", 16), ("d", 32), ("q", 64)]:
    form(f"rep movs{suffix}", f"rep movs{suffix}", mem=True, setup={"rcx": "count", "rsi": "src", "rdi": "dst"})
    form(f"rep stos{suffix}", f"rep stos{suffix}", mem=True, setup={"rcx": "count", "rdi": "dst"})
    form(f"movs{suffix}", f"movs{suffix}", mem=True, setup={"rsi": "src", "rdi": "dst"})
    form(f"lods{suffix}", f"lods{suffix}", mem=True, setup={"rsi": "src"})
    form(f"std; rep movs{suffix}; cld", f"std; rep movs{suffix}; cld", mem=True, setup={"rcx": "count", "rsi": "srcend", "rdi": "dstend"})
form("repe cmpsb", "repe cmpsb", mem=True, setup={"rcx": "count", "rsi": "src", "rdi": "src2"})
form("repne scasb", "repne scasb", mem=True, setup={"rcx": "count", "rdi": "src", "rax": "byte"})
form("repe cmpsb equal", "repe cmpsb", mem=True, setup={"rcx": "count", "rsi": "src", "rdi": "src"})
form("cmpsq", "cmpsq", mem=True, setup={"rsi": "src", "rdi": "src2"})
form("scasd", "scasd", mem=True, setup={"rdi": "src"})

# BMI
for size in [32, 64]:
    regs = REGS_BY_SIZE[size]
    a, b, c = regs[0], regs[2], regs[5]
    form(f"andn {a},{b},{c}", f"andn {a},{b},{c}", mask=ALL_FLAGS & ~(AF | PF))
    form(f"bzhi {a},{b},{c}", f"bzhi {a},{b},{c}", mask=ALL_FLAGS & ~(AF | PF), setup={c: "shiftcount"})
    form(f"shlx {a},{b},{c}", f"shlx {a},{b},{c}", setup={c: "shiftcount"})
    form(f"shrx {a},{b},{c}", f"shrx {a},{b},{c}", setup={c: "shiftcount"})
    form(f"sarx {a},{b},{c}", f"sarx {a},{b},{c}", setup={c: "shiftcount"})
    form(f"rorx {a},{b},7", f"rorx {a},{b},7")
    form(f"blsr {a},{b}", f"blsr {a},{b}", mask=ALL_FLAGS & ~(AF | PF))
    form(f"blsmsk {a},{b}", f"blsmsk {a},{b}", mask=ALL_FLAGS & ~(AF | PF))
    form(f"blsi {a},{b}", f"blsi {a},{b}", mask=ALL_FLAGS & ~(AF | PF))
    form(f"bextr {a},{b},{c}", f"bextr {a},{b},{c}", mask=ALL_FLAGS & ~(AF | PF | SF))
    form(f"pext {a},{b},{c}", f"pext {a},{b},{c}")
    form(f"pdep {a},{b},{c}", f"pdep {a},{b},{c}")
    form(f"mulx {a},{b},{c}", f"mulx {a},{b},{c}")
    form(f"andn {a},{b},[m]", f"andn {a},{b},{mem(size)}", mem=True, mask=ALL_FLAGS & ~(AF | PF))

# ---- x87 forms -----------------------------------------------------
# The x87 stack is not in the harness's output, so every form ends by
# storing what it computed to scratch memory (or to eflags, or to ax).
# Results are compared as doubles: the translator's registers hold
# f64, so forms whose 64-bit mantissa would show are kept out (long
# double arithmetic on values that need it).

def x87(name, asm, mask=ALL_FLAGS):
    form(name, "finit; " + asm, mask=mask, mem=True, floats=True)


for width, ptr in [("QWORD", "q"), ("DWORD", "d")]:
    x87(f"fld/fstp {width}", f"fld {width} PTR [rbx+0x40]; fstp {width} PTR [rbx+0x60]")
    x87(f"fld {width}/fst", f"fld {width} PTR [rbx+0x40]; fst {width} PTR [rbx+0x60]; fstp QWORD PTR [rbx+0x68]")
    for op in ["fadd", "fsub", "fsubr", "fmul", "fdiv", "fdivr"]:
        x87(f"{op} {width} mem", f"fld QWORD PTR [rbx+0x40]; {op} {width} PTR [rbx+0x48]; fstp QWORD PTR [rbx+0x60]")
for op in ["fadd", "fsub", "fsubr", "fmul", "fdiv", "fdivr"]:
    x87(f"{op} st,st(1)", f"fld QWORD PTR [rbx+0x40]; fld QWORD PTR [rbx+0x48]; {op} st,st(1); fstp QWORD PTR [rbx+0x60]; fstp QWORD PTR [rbx+0x68]")
    x87(f"{op} st(1),st", f"fld QWORD PTR [rbx+0x40]; fld QWORD PTR [rbx+0x48]; {op} st(1),st; fstp QWORD PTR [rbx+0x60]; fstp QWORD PTR [rbx+0x68]")
    x87(f"{op}p", f"fld QWORD PTR [rbx+0x40]; fld QWORD PTR [rbx+0x48]; {op}p st(1),st; fstp QWORD PTR [rbx+0x60]")
for op in ["fiadd", "fisub", "fisubr", "fimul", "fidiv", "fidivr"]:
    x87(f"{op} dword", f"fld QWORD PTR [rbx+0x40]; {op} DWORD PTR [rbx+0x48]; fstp QWORD PTR [rbx+0x60]")
    x87(f"{op} word", f"fld QWORD PTR [rbx+0x40]; {op} WORD PTR [rbx+0x48]; fstp QWORD PTR [rbx+0x60]")
for width in ["WORD", "DWORD", "QWORD"]:
    x87(f"fild {width}", f"fild {width} PTR [rbx+0x40]; fstp QWORD PTR [rbx+0x60]")
    x87(f"fistp {width}", f"fld QWORD PTR [rbx+0x40]; fistp {width} PTR [rbx+0x60]")
    x87(f"fisttp {width}", f"fld QWORD PTR [rbx+0x40]; fisttp {width} PTR [rbx+0x60]")
x87("fist dword", "fld QWORD PTR [rbx+0x40]; fist DWORD PTR [rbx+0x60]; fstp QWORD PTR [rbx+0x68]")
for op in ["fchs", "fabs", "fsqrt", "frndint"]:
    x87(op, f"fld QWORD PTR [rbx+0x40]; {op}; fstp QWORD PTR [rbx+0x60]")
for rc in [0, 1, 2, 3]:
    cw = 0x37F | (rc << 10)
    x87(f"frndint rc={rc}", f"mov WORD PTR [rbx+0x70],{cw:#x}; fldcw WORD PTR [rbx+0x70]; fld QWORD PTR [rbx+0x40]; frndint; fstp QWORD PTR [rbx+0x60]")
    x87(f"fistp rc={rc}", f"mov WORD PTR [rbx+0x70],{cw:#x}; fldcw WORD PTR [rbx+0x70]; fld QWORD PTR [rbx+0x40]; fistp QWORD PTR [rbx+0x60]")
for const in ["fld1", "fldz", "fldpi", "fldl2e", "fldln2", "fldlg2", "fldl2t"]:
    x87(const, f"{const}; fstp QWORD PTR [rbx+0x60]")
x87("fxch", "fld QWORD PTR [rbx+0x40]; fld QWORD PTR [rbx+0x48]; fxch st(1); fstp QWORD PTR [rbx+0x60]; fstp QWORD PTR [rbx+0x68]")
x87("fld st(0)", "fld QWORD PTR [rbx+0x40]; fld st(0); fstp QWORD PTR [rbx+0x60]; fstp QWORD PTR [rbx+0x68]")
x87("fstp st(1)", "fld QWORD PTR [rbx+0x40]; fld QWORD PTR [rbx+0x48]; fstp st(1); fstp QWORD PTR [rbx+0x60]")
x87("fnstcw", "fnstcw WORD PTR [rbx+0x60]")
x87("fldcw/fnstcw", "mov WORD PTR [rbx+0x70],0x27f; fldcw WORD PTR [rbx+0x70]; fnstcw WORD PTR [rbx+0x60]")
for op in ["fucomi", "fcomi"]:
    x87(f"{op}", f"fld QWORD PTR [rbx+0x40]; fld QWORD PTR [rbx+0x48]; {op} st,st(1); fstp QWORD PTR [rbx+0x60]; fstp QWORD PTR [rbx+0x68]", mask=CF | ZF | PF)
    x87(f"{op}p", f"fld QWORD PTR [rbx+0x40]; fld QWORD PTR [rbx+0x48]; {op}p st,st(1); fstp QWORD PTR [rbx+0x60]", mask=CF | ZF | PF)
for op in ["fucom", "fcom"]:
    x87(f"{op};fnstsw", f"fld QWORD PTR [rbx+0x40]; fld QWORD PTR [rbx+0x48]; {op} st(1); fnstsw ax; and eax,0x4500; fstp QWORD PTR [rbx+0x60]; fstp QWORD PTR [rbx+0x68]")
    x87(f"{op}pp;fnstsw", f"fld QWORD PTR [rbx+0x40]; fld QWORD PTR [rbx+0x48]; {op}pp; fnstsw ax; and eax,0x4500")
x87("fcomp mem;fnstsw", "fld QWORD PTR [rbx+0x40]; fcomp QWORD PTR [rbx+0x48]; fnstsw ax; and eax,0x4500")
x87("ftst;fnstsw", "fld QWORD PTR [rbx+0x40]; ftst; fnstsw ax; and eax,0x4500; fstp QWORD PTR [rbx+0x60]")
x87("fxam;fnstsw", "fld QWORD PTR [rbx+0x40]; fxam; fnstsw ax; and eax,0x4700; fstp QWORD PTR [rbx+0x60]")
x87("fnstsw top", "fld1; fld1; fld1; fnstsw ax; and eax,0x3800; fstp st(0); fstp st(0); fstp st(0)")
for cc in ["b", "e", "be", "u", "nb", "ne", "nbe", "nu"]:
    x87(f"fcmov{cc}", f"fld QWORD PTR [rbx+0x40]; fld QWORD PTR [rbx+0x48]; fcmov{cc} st,st(1); fstp QWORD PTR [rbx+0x60]; fstp QWORD PTR [rbx+0x68]")
x87("fld tbyte", "fld QWORD PTR [rbx+0x40]; fstp TBYTE PTR [rbx+0x50]; fld TBYTE PTR [rbx+0x50]; fstp QWORD PTR [rbx+0x60]")
x87("fstp tbyte of int", "fild DWORD PTR [rbx+0x40]; fstp TBYTE PTR [rbx+0x60]")
x87("fscale", "fld QWORD PTR [rbx+0x40]; fld QWORD PTR [rbx+0x48]; fscale; fstp QWORD PTR [rbx+0x60]; fstp QWORD PTR [rbx+0x68]")
x87("fprem;fnstsw", "fld QWORD PTR [rbx+0x40]; fld QWORD PTR [rbx+0x48]; fprem; fnstsw ax; and eax,0x400; fstp QWORD PTR [rbx+0x60]; fstp QWORD PTR [rbx+0x68]")
x87("fnstenv/fldenv cw", "mov WORD PTR [rbx+0x70],0x27f; fldcw WORD PTR [rbx+0x70]; fnstenv [rbx+0x80]; finit; fldenv [rbx+0x80]; fnstcw WORD PTR [rbx+0x60]; mov QWORD PTR [rbx+0x80],0; mov QWORD PTR [rbx+0x88],0; mov QWORD PTR [rbx+0x90],0; mov DWORD PTR [rbx+0x98],0")


# ---- SSE forms -----------------------------------------------------

def sse(name, asm, mask=ALL_FLAGS, mem_=False, floats=False):
    form(name, asm, mask=mask, sse=True, mem=mem_, floats=floats)


for op in ["movaps", "movups", "movapd", "movupd", "movdqa", "movdqu"]:
    sse(f"{op} xmm,xmm", f"{op} xmm1,xmm5")
    sse(f"{op} xmm,[m]", f"{op} xmm9,XMMWORD PTR [rbx+0x30]", mem_=True)
    sse(f"{op} [m],xmm", f"{op} XMMWORD PTR [rbx+0x30],xmm12", mem_=True)
sse("movq xmm,xmm", "movq xmm1,xmm5")
sse("movq xmm,[m]", "movq xmm1,QWORD PTR [rbx+0x30]", mem_=True)
sse("movq [m],xmm", "movq QWORD PTR [rbx+0x30],xmm1", mem_=True)
sse("movq xmm,r64", "movq xmm3,rax")
sse("movq r64,xmm", "movq rax,xmm3")
sse("movd xmm,r32", "movd xmm3,eax")
sse("movd r32,xmm", "movd eax,xmm3")
sse("movd xmm,[m]", "movd xmm3,DWORD PTR [rbx+0x30]", mem_=True)
sse("movd [m],xmm", "movd DWORD PTR [rbx+0x30],xmm3", mem_=True)
sse("movss xmm,xmm", "movss xmm1,xmm5")
sse("movss xmm,[m]", "movss xmm1,DWORD PTR [rbx+0x30]", mem_=True)
sse("movss [m],xmm", "movss DWORD PTR [rbx+0x30],xmm1", mem_=True)
sse("movsd xmm,xmm", "movsd xmm1,xmm5")
sse("movsd xmm,[m]", "movsd xmm1,QWORD PTR [rbx+0x30]", mem_=True)
sse("movsd [m],xmm", "movsd QWORD PTR [rbx+0x30],xmm1", mem_=True)
for op in ["movlps", "movhps", "movlpd", "movhpd"]:
    sse(f"{op} xmm,[m]", f"{op} xmm1,QWORD PTR [rbx+0x30]", mem_=True)
    sse(f"{op} [m],xmm", f"{op} QWORD PTR [rbx+0x30],xmm1", mem_=True)
sse("movhlps", "movhlps xmm1,xmm5")
sse("movlhps", "movlhps xmm1,xmm5")
sse("movddup", "movddup xmm1,xmm5")
sse("movsldup", "movsldup xmm1,xmm5")
sse("movshdup", "movshdup xmm1,xmm5")
sse("pmovmskb", "pmovmskb eax,xmm5")
sse("movmskps", "movmskps eax,xmm5")
sse("movmskpd", "movmskpd eax,xmm5")

PACKED = ["paddb", "paddw", "paddd", "paddq", "psubb", "psubw", "psubd", "psubq", "paddsb", "paddsw", "paddusb",
          "paddusw", "psubsb", "psubsw", "psubusb", "psubusw", "pmullw", "pmulld", "pmaddwd", "pavgb", "pavgw",
          "pminub", "pmaxub", "pminsw", "pmaxsw", "pminsb", "pmaxsb", "pminuw", "pmaxuw", "pminsd", "pmaxsd",
          "pminud", "pmaxud", "pcmpeqb", "pcmpeqw", "pcmpeqd", "pcmpeqq", "pcmpgtb", "pcmpgtw", "pcmpgtd",
          "pcmpgtq", "pand", "por", "pxor", "pandn", "andps", "andpd", "orps", "orpd", "xorps", "xorpd", "andnps",
          "andnpd", "packsswb", "packuswb", "packssdw", "packusdw", "punpcklbw", "punpckhbw", "punpcklwd",
          "punpckhwd", "punpckldq", "punpckhdq", "punpcklqdq", "punpckhqdq", "unpcklps", "unpckhps", "unpcklpd",
          "unpckhpd", "pmuludq", "pmuldq", "pmulhw", "pmulhuw", "psadbw", "pshufb", "pabsb", "pabsw", "pabsd",
          "pmovzxbw", "pmovzxbd", "pmovzxbq", "pmovzxwd", "pmovzxwq", "pmovzxdq", "pmovsxbw", "pmovsxbd",
          "pmovsxbq", "pmovsxwd", "pmovsxwq", "pmovsxdq"]
PMOV_WIDTH = {"bw": "QWORD", "bd": "DWORD", "bq": "WORD", "wd": "QWORD", "wq": "DWORD", "dq": "QWORD"}
for op in PACKED:
    sse(f"{op} xmm,xmm", f"{op} xmm2,xmm6")
    width = PMOV_WIDTH[op[6:8]] if op.startswith("pmov") else "XMMWORD"
    sse(f"{op} xmm,[m]", f"{op} xmm2,{width} PTR [rbx+0x40]", mem_=True)
sse("pcmpeqb same", "pcmpeqb xmm2,xmm2")
sse("pxor same", "pxor xmm2,xmm2")

FLOAT_PACKED = ["addps", "addpd", "subps", "subpd", "mulps", "mulpd", "divps", "divpd", "minps", "maxps", "minpd",
                "maxpd", "sqrtps", "sqrtpd", "cvtdq2ps", "cvtdq2pd", "cvtps2pd", "cvtpd2ps", "cvttps2dq",
                "cvtps2dq", "cvttpd2dq", "cvtpd2dq"]
for op in FLOAT_PACKED:
    sse(f"{op} xmm,xmm", f"{op} xmm2,xmm6", floats=True)
FLOAT_SCALAR = ["addss", "addsd", "subss", "subsd", "mulss", "mulsd", "divss", "divsd", "minss", "maxss", "minsd",
                "maxsd", "sqrtss", "sqrtsd", "cvtss2sd", "cvtsd2ss"]
for op in FLOAT_SCALAR:
    sse(f"{op} xmm,xmm", f"{op} xmm2,xmm6", floats=True)
    width = "DWORD" if (op.endswith("ss") and op != "cvtsd2ss") or op == "cvtss2sd" else "QWORD"
    sse(f"{op} xmm,[m]", f"{op} xmm2,{width} PTR [rbx+0x40]", mem_=True, floats=True)
for op in ["comiss", "comisd", "ucomiss", "ucomisd"]:
    sse(f"{op}", f"{op} xmm2,xmm6", mask=CF | PF | ZF | SF | OF | AF, floats=True)
for pred in range(8):
    sse(f"cmpss {pred}", f"cmpss xmm2,xmm6,{pred}", floats=True)
    sse(f"cmpsd {pred}", f"cmpsd xmm2,xmm6,{pred}", floats=True)
    sse(f"cmpps {pred}", f"cmpps xmm2,xmm6,{pred}", floats=True)
    sse(f"cmppd {pred}", f"cmppd xmm2,xmm6,{pred}", floats=True)
for op in ["cvtsi2ss", "cvtsi2sd"]:
    sse(f"{op} xmm,r32", f"{op} xmm2,eax")
    sse(f"{op} xmm,r64", f"{op} xmm2,rax")
    sse(f"{op} xmm,[m]32", f"{op} xmm2,DWORD PTR [rbx+0x40]", mem_=True)
for op in ["cvttss2si", "cvttsd2si", "cvtss2si", "cvtsd2si"]:
    sse(f"{op} r32,xmm", f"{op} eax,xmm6", floats=True)
    sse(f"{op} r64,xmm", f"{op} rax,xmm6", floats=True)
for imm in [0x00, 0x1b, 0x4e, 0xff, 0x93]:
    sse(f"pshufd {imm:#x}", f"pshufd xmm2,xmm6,{imm:#x}")
    sse(f"pshuflw {imm:#x}", f"pshuflw xmm2,xmm6,{imm:#x}")
    sse(f"pshufhw {imm:#x}", f"pshufhw xmm2,xmm6,{imm:#x}")
    sse(f"shufps {imm:#x}", f"shufps xmm2,xmm6,{imm:#x}")
for imm in [0, 1, 2, 3]:
    sse(f"shufpd {imm}", f"shufpd xmm2,xmm6,{imm}")
for imm in [0, 1, 4, 7, 8, 15, 16, 17]:
    sse(f"pslldq {imm}", f"pslldq xmm2,{imm}")
    sse(f"psrldq {imm}", f"psrldq xmm2,{imm}")
    sse(f"palignr {imm}", f"palignr xmm2,xmm6,{imm}")
for op in ["psllw", "pslld", "psllq", "psrlw", "psrld", "psrlq", "psraw", "psrad"]:
    for imm in [0, 1, 7, 15, 16, 31, 32, 63, 64, 0xff]:
        sse(f"{op} {imm}", f"{op} xmm2,{imm}")
    sse(f"{op} xmm,xmm", f"{op} xmm2,xmm6", )
    sse(f"{op} xmm,xmm small", f"{op} xmm2,xmm6", )
    sse(f"{op} xmm,[m]", f"{op} xmm2,XMMWORD PTR [rbx+0x40]", mem_=True)
for imm in [0, 3, 7]:
    sse(f"pinsrw {imm}", f"pinsrw xmm2,eax,{imm}")
    sse(f"pextrw {imm}", f"pextrw eax,xmm2,{imm}")
sse("pinsrb", "pinsrb xmm2,eax,9")
sse("pinsrd", "pinsrd xmm2,eax,2")
sse("pinsrq", "pinsrq xmm2,rax,1")
sse("pextrb", "pextrb eax,xmm2,13")
sse("pextrd", "pextrd eax,xmm2,3")
sse("pextrq", "pextrq rax,xmm2,1")
sse("pextrd [m]", "pextrd DWORD PTR [rbx+0x40],xmm2,1", mem_=True)
sse("pinsrw [m]", "pinsrw xmm2,WORD PTR [rbx+0x40],5", mem_=True)
sse("ptest", "ptest xmm2,xmm6", mask=CF | ZF | PF | AF | SF | OF)
sse("ptest same", "ptest xmm2,xmm2", mask=CF | ZF | PF | AF | SF | OF)
sse("pblendvb", "pblendvb xmm2,xmm6,xmm0")
sse("blendvps", "blendvps xmm2,xmm6,xmm0")
sse("blendvpd", "blendvpd xmm2,xmm6,xmm0")
for imm in [0x00, 0x5a, 0xff, 0x81]:
    sse(f"pblendw {imm:#x}", f"pblendw xmm2,xmm6,{imm:#x}")
sse("blendps 5", "blendps xmm2,xmm6,5")
sse("blendpd 2", "blendpd xmm2,xmm6,2")
for imm in [0, 1, 2, 3, 4, 8, 9, 10, 11]:
    sse(f"roundsd {imm}", f"roundsd xmm2,xmm6,{imm}", floats=True)
    sse(f"roundss {imm}", f"roundss xmm2,xmm6,{imm}", floats=True)
    sse(f"roundpd {imm}", f"roundpd xmm2,xmm6,{imm}", floats=True)
    sse(f"roundps {imm}", f"roundps xmm2,xmm6,{imm}", floats=True)
sse("stmxcsr", "stmxcsr DWORD PTR [rbx+0x40]", mem_=True)
sse("ldmxcsr/stmxcsr", "ldmxcsr DWORD PTR [rip+1f]; stmxcsr DWORD PTR [rbx+0x40]; jmp 2f; 1: .long 0x1f80; 2:", mem_=True)
sse("movnti", "movnti QWORD PTR [rbx+0x40],rax", mem_=True)
sse("movntdq", "movntdq XMMWORD PTR [rbx+0x40],xmm2", mem_=True)
sse("lddqu", "lddqu xmm2,XMMWORD PTR [rbx+0x40]", mem_=True)
# fxsave writes the physical x87 registers whatever their tags say, so
# the area's register bytes hold whatever earlier cases left; the form
# clears them before the comparison.
sse("fxsave/fxrstor", "fxsave [rbx]; pxor xmm2,xmm2; fxrstor [rbx]; " + "; ".join(f"mov QWORD PTR [rbx+{o:#x}],0" for o in range(32, 160, 8)), mem_=False)


# ---- assembling and running ----------------------------------------

def assemble(forms):
    """Assembles every form in one file; returns the bytes per form."""
    lines = [".intel_syntax noprefix", ".text"]
    for i, f in enumerate(forms):
        lines.append(f"case_{i}:")
        for insn in f.asm.split(";"):
            lines.append("    " + insn.strip())
        lines.append(f"case_end_{i}:")
    with tempfile.TemporaryDirectory() as d:
        src = os.path.join(d, "cases.s")
        obj = os.path.join(d, "cases.o")
        with open(src, "w") as fh:
            fh.write("\n".join(lines) + "\n")
        subprocess.run(["as", "-o", obj, src], check=True)
        text = subprocess.run(["objcopy", "-O", "binary", "--only-section=.text", obj, os.path.join(d, "text.bin")], check=True)
        with open(os.path.join(d, "text.bin"), "rb") as fh:
            blob = fh.read()
        nm = subprocess.run(["nm", obj], capture_output=True, text=True, check=True).stdout
    addrs = {}
    for line in nm.splitlines():
        parts = line.split()
        if len(parts) == 3:
            addrs[parts[2]] = int(parts[0], 16)
    out = []
    for i in range(len(forms)):
        out.append(blob[addrs[f"case_{i}"]:addrs[f"case_end_{i}"]])
    return out


def float_bits(rng):
    import struct
    if rng.random() < 0.5:
        return struct.unpack("<Q", struct.pack("<d", rng.choice(SPECIAL_F64)))[0]
    v = rng.choice(SPECIAL_F64) if rng.random() < 0.3 else rng.uniform(-1e6, 1e6)
    return struct.unpack("<Q", struct.pack("<d", v))[0]


def float32_bits(rng):
    import struct
    v = rng.choice(SPECIAL_F64) if rng.random() < 0.5 else rng.uniform(-1e6, 1e6)
    try:
        return struct.unpack("<I", struct.pack("<f", v))[0]
    except OverflowError:
        return struct.unpack("<I", struct.pack("<f", float("inf") if v > 0 else float("-inf")))[0]


# Any register name to the 64-bit register that holds it.
PARENT = {}
for _regs in (R64, R32, R16):
    for _i, _r in enumerate(_regs):
        PARENT[_r] = R64[_i]
for _r, _p in [("al", "rax"), ("cl", "rcx"), ("dl", "rdx"), ("bl", "rbx"), ("ah", "rax"), ("ch", "rcx"),
               ("dh", "rdx"), ("bh", "rbx"), ("sil", "rsi"), ("dil", "rdi"), ("r8b", "r8"), ("r9b", "r9"),
               ("r12b", "r12"), ("r15b", "r15")]:
    PARENT[_r] = _p


def make_inputs(f, rng, seed):
    regs = {r: rand_int(rng) for r in R64}
    regs["rsp"] = STACK
    for r in POINTER_REGS:
        regs[r] = SCRATCH + rng.choice([0x00, 0x10, 0x20, 0x30])
    if "fs" in f.setup:
        regs["rbx"] = 0x40  # fs_base + rbx + 0x20 lands in scratch
    for r, kind in f.setup.items():
        r = PARENT.get(r, r)
        if kind == "shiftcount":
            regs[r] = rng.choice([0, 1, 2, 5, 8, 15, 16, 31, 32, 33, 63, 64, 65, 100, 0xFF, 0x1FF])
        elif kind == "shiftcount16":
            regs[r] = rng.choice([0, 1, 2, 5, 8, 15, 16])
        elif kind == "count":
            regs[r] = rng.choice([0, 1, 2, 3, 5, 8])
        elif kind == "src":
            regs[r] = SCRATCH + 0x10
        elif kind == "src2":
            regs[r] = SCRATCH + rng.choice([0x10, 0x18])
        elif kind == "dst":
            regs[r] = SCRATCH + 0x60
        elif kind == "srcend":
            regs[r] = SCRATCH + 0x50
        elif kind == "dstend":
            regs[r] = SCRATCH + 0xA0
        elif kind == "byte":
            regs[r] = rng.choice([0, 0x41, 0xFF, regs[r] & 0xFF])
        elif kind == "bitoffset":
            regs[r] = rng.choice([0, 5, 31, 63, 64, 100, -1 & 0xFFFFFFFFFFFFFFFF, -70 & 0xFFFFFFFFFFFFFFFF, 0x1234])
        elif r == "nonzero-or-zero":
            if rng.random() < 0.3:
                regs[PARENT[kind]] = 0
        elif r in ("div", "idiv"):
            size = kind
            bits = size
            # Keep the quotient in range: high part is an extension of the low.
            lo = regs["rax"] & ((1 << bits) - 1) if bits < 64 else regs["rax"]
            divisor = regs["rcx"] & ((1 << bits) - 1) if bits < 64 else regs["rcx"]
            if divisor == 0:
                divisor = 7
            if r == "idiv" and bits < 64:
                # avoid INT_MIN / -1
                if divisor == (1 << bits) - 1 and lo == 1 << (bits - 1):
                    divisor = 3
            if r == "idiv" and bits == 64 and divisor == 0xFFFFFFFFFFFFFFFF and lo == 0x8000000000000000:
                divisor = 3
            regs["rcx"] = (regs["rcx"] & ~((1 << bits) - 1) if bits < 64 else 0) | divisor
            if bits == 8:
                regs["rax"] = (regs["rax"] & ~0xFFFF) | (lo if r == "div" else (lo | (0xFF00 if lo & 0x80 else 0)))
            else:
                mask = (1 << bits) - 1
                regs["rax"] = (regs["rax"] & ~mask) | lo if bits < 64 else lo
                if r == "div":
                    regs["rdx"] = regs["rdx"] & ~mask if bits < 64 else 0
                else:
                    sign = mask if lo & (1 << (bits - 1)) else 0
                    regs["rdx"] = (regs["rdx"] & ~mask) | sign if bits < 64 else (0xFFFFFFFFFFFFFFFF if lo >> 63 else 0)
    flags = rng.getrandbits(12) & ALL_FLAGS
    if "cpuid" in f.setup:
        flags = 0
    return regs, flags


def scratch_for(f, rng, seed):
    data = bytearray(scratch_bytes(seed))
    if f.floats:
        import struct
        # xmm registers come from the first 256 bytes: fill the two the
        # forms use (xmm2 at 32, xmm6 at 96) with float patterns, and the
        # memory operand at 0x40.. with more.
        for off in [32, 40, 96, 104, 0x40, 0x48]:
            data[off:off + 8] = struct.pack("<Q", float_bits(rng))
        for off in [32, 36, 96, 100, 0x40, 0x44]:
            if rng.random() < 0.5:
                data[off:off + 4] = struct.pack("<I", float32_bits(rng))
    return bytes(data)


REG_ORDER = ["rax", "rcx", "rdx", "rbx", "rsp", "rbp", "rsi", "rdi", "r8", "r9", "r10", "r11", "r12", "r13", "r14", "r15"]


def build_cases(per_form=5):
    """Assembles every form and draws its inputs; returns the cases and
    the harness's input lines, one per case."""
    codes = assemble(FORMS)
    rng = random.Random(20260907)
    cases = []
    lines = []
    for f, code in zip(FORMS, codes):
        for _ in range(per_form):
            seed = rng.getrandbits(64) or 1
            regs, flags = make_inputs(f, rng, seed)
            data = scratch_for(f, rng, seed)
            cases.append({"form": f, "code": code, "regs": regs, "flags": flags, "seed": seed, "data": data})
            reg_list = [regs[r] for r in REG_ORDER]
            lines.append(" ".join([code.hex()] + [f"{v:x}" for v in reg_list] + [f"{flags:x}", data.hex()]))
    return cases, lines


def build_harness(d):
    here = os.path.dirname(os.path.abspath(__file__))
    harness = os.path.join(d, "harness")
    subprocess.run(["cc", "-O1", "-w", "-o", harness, os.path.join(here, "harness.c")], check=True)
    return harness


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    out_path = sys.argv[1]
    with tempfile.TemporaryDirectory() as d:
        harness = build_harness(d)
        cases, lines = build_cases()
        if "--one-by-one" in sys.argv:
            # Find the case that kills the harness.
            for case, line in zip(cases, lines):
                proc = subprocess.run([harness], input=line + "\n", capture_output=True, text=True)
                if proc.returncode != 0:
                    print(f"harness died with {proc.returncode} on {case['form'].name}: {line[:120]}")
            return
        proc = subprocess.run([harness], input="\n".join(lines) + "\n", capture_output=True, text=True)
        if proc.returncode != 0:
            sys.exit(f"harness failed with {proc.returncode}; rerun with --one-by-one to find the case")
        results = proc.stdout.splitlines()
        if len(results) != len(cases):
            sys.exit(f"harness answered {len(results)} of {len(cases)} cases")
    fixture = []
    for case, line in zip(cases, results):
        parts = line.split()
        out_regs = [int(v, 16) for v in parts[:16]]
        out_flags = int(parts[16], 16)
        xmm = parts[17]
        memory = bytes.fromhex(parts[18])[:SCRATCH_SIZE]
        f = case["form"]
        entry = {
            "name": f.name,
            "code": case["code"].hex(),
            "seed": f"{case['seed']:x}",
            "regs": [f"{case['regs'][r]:x}" for r in REG_ORDER],
            "flags": f"{case['flags']:x}",
            "mask": f"{f.mask:x}",
            "out": {"regs": [f"{v:x}" for v in out_regs], "flags": f"{out_flags:x}"},
        }
        if case["data"] != scratch_bytes(case["seed"]):
            entry["data"] = case["data"].hex()
        if f.sse:
            entry["out"]["xmm"] = xmm
        if memory != case["data"]:
            entry["out"]["mem"] = memory.hex()
        fixture.append(entry)
    with open(out_path, "w") as fh:
        json.dump({"cases": fixture}, fh, separators=(",", ":"))
    print(f"{len(fixture)} cases from {len(FORMS)} forms")


if __name__ == "__main__":
    main()
