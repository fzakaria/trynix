/*
 * Executes instruction snippets on the real CPU and reports the
 * register state they leave, so the translator can be checked against
 * hardware rather than against a reading of the manual.
 *
 * Protocol, on stdin, one case per line:
 *     <code hex> <rax> <rcx> ... <r15> <rflags> <mem hex>
 * where the sixteen registers are hex, rflags is the arithmetic flags
 * to start with, and mem is the initial contents of the scratch page.
 * For each case one line is written:
 *     <rax> ... <r15> <rflags> <xmm0..15 hex> <mem hex>
 *
 * The snippet runs at SNIPPET, a fixed address the translator uses too
 * so rip-relative operands agree, with rsp wherever the case put it
 * (inside the scratch page, so push, pop and call work). It must not
 * fault. The epilogue follows it directly and saves every register
 * through absolute addressing, so it needs none of them free.
 *
 * Built by tools/x86-semantics/generate.py, which is the only caller.
 */
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>

#define CODE ((uint8_t *)0x600000)
#define SNIPPET ((uint8_t *)0x601000)
#define SCRATCH ((uint8_t *)0x610000)
#define OUT ((uint64_t *)0x620000)
#define SCRATCH_SIZE 4096
#define MAX_CODE 256

/* Where the epilogue leaves things, as offsets into OUT. */
#define OUT_GPR 0 /* 16 x 8 bytes */
#define OUT_FLAGS 128
#define OUT_YMM 256 /* 16 x 32 bytes: low half then high */
#define OUT_HARNESS_RSP 1024

static uint64_t in_regs[16];
static uint64_t in_flags;

/* The epilogue: store every register to OUT through absolute
 * addressing, then restore the harness's stack and return into
 * run_case. Written as bytes rather than asm so nothing is clobbered
 * between the snippet and the stores. */
static uint8_t *emit_store_gpr(uint8_t *p, int reg, uint32_t addr)
{
    /* REX.W (+ REX.R for r8-r15), 0x89, ModRM(mod=00, reg, rm=100), SIB(no index, no base=101) disp32 */
    *p++ = 0x48 | ((reg >> 3) << 2);
    *p++ = 0x89;
    *p++ = 0x04 | ((reg & 7) << 3);
    *p++ = 0x25;
    memcpy(p, &addr, 4);
    return p + 4;
}

static uint8_t *emit_store_ymm(uint8_t *p, int reg, uint32_t addr)
{
    /* vmovdqu [abs32], ymm: C4 [R=~reg8 X=1 B=1 mmmmm=00001] [W=0 vvvv=1111 L=1 pp=10] 7F ModRM SIB disp32 */
    *p++ = 0xc4;
    *p++ = 0x61 | (reg >= 8 ? 0 : 0x80);
    *p++ = 0x7e;
    *p++ = 0x7f;
    *p++ = 0x04 | ((reg & 7) << 3);
    *p++ = 0x25;
    memcpy(p, &addr, 4);
    return p + 4;
}

static uint8_t *emit_load_gpr(uint8_t *p, int reg, uint32_t addr)
{
    /* mov reg, [abs32]: REX.W 8B ModRM SIB disp32 */
    *p++ = 0x48 | ((reg >> 3) << 2);
    *p++ = 0x8b;
    *p++ = 0x04 | ((reg & 7) << 3);
    *p++ = 0x25;
    memcpy(p, &addr, 4);
    return p + 4;
}

static uint8_t *emit_load_ymm(uint8_t *p, int reg, uint32_t addr)
{
    /* vmovdqu ymm, [abs32]: C4 [R X B 00001] [0 1111 1 10] 6F ModRM SIB disp32 */
    *p++ = 0xc4;
    *p++ = 0x61 | (reg >= 8 ? 0 : 0x80);
    *p++ = 0x7e;
    *p++ = 0x6f;
    *p++ = 0x04 | ((reg & 7) << 3);
    *p++ = 0x25;
    memcpy(p, &addr, 4);
    return p + 4;
}

/* Calls the built program. The snippet may clobber any register, so
 * every callee-saved one is declared clobbered and rbp is saved by
 * hand, which the compiler will not let a clobber list do. */
static void *const entry = CODE;

static void run(void)
{
    asm volatile(
        "push %%rbp\n\t"
        "call *%0\n\t"
        "pop %%rbp\n\t"
        :
        : "m"(entry)
        : "rax", "rcx", "rdx", "rbx", "rsi", "rdi", "r8", "r9", "r10", "r11", "r12", "r13", "r14", "r15",
          "xmm0", "xmm1", "xmm2", "xmm3", "xmm4", "xmm5", "xmm6", "xmm7", "xmm8", "xmm9", "xmm10", "xmm11",
          "xmm12", "xmm13", "xmm14", "xmm15", "memory", "cc");
}

static int hexval(int c)
{
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
}

static int parse_hex(const char *s, uint8_t *out, int max)
{
    int n = 0;
    while (s[0] && s[1] && n < max) {
        int hi = hexval(s[0]);
        int lo = hexval(s[1]);
        if (hi < 0 || lo < 0) break;
        out[n++] = (hi << 4) | lo;
        s += 2;
    }
    return n;
}

/* Builds the whole program at CODE: prologue that loads the input
 * state, the snippet, the epilogue. Returns the entry point. */
static void build(const uint8_t *snippet, int len)
{
    uint8_t *p = CODE;
    uint32_t in_addr = (uint32_t)(uintptr_t)OUT + 2048; /* input block lives after the outputs */
    uint64_t *in = (uint64_t *)(uintptr_t)in_addr;

    /* Input block: regs, flags, a reset mxcsr, xmm */
    for (int i = 0; i < 16; i++) in[i] = in_regs[i];
    in[16] = in_flags;
    in[17] = 0x1f80;

    /* Save harness rsp: mov [OUT_HARNESS_RSP], rsp */
    p = emit_store_gpr(p, 4, (uint32_t)(uintptr_t)OUT + OUT_HARNESS_RSP);
    /* Load ymm0-15 from input block + 1024 */
    for (int i = 0; i < 16; i++) p = emit_load_ymm(p, i, in_addr + 1024 + 32 * i);
    /* fninit (DB E3): the x87 stack and control word of one case must
     * not reach the next */
    *p++ = 0xdb; *p++ = 0xe3;
    /* mxcsr: ldmxcsr [in+136] -> 0F AE 14 25 disp32, so the sticky
     * exception flags of earlier cases do not leak into this one */
    *p++ = 0x0f; *p++ = 0xae; *p++ = 0x14; *p++ = 0x25; memcpy(p, &(uint32_t){in_addr + 136}, 4); p += 4;
    /* Flags: push [in+128]; popf  -> FF 34 25 disp32 ; 9D */
    *p++ = 0xff; *p++ = 0x34; *p++ = 0x25; memcpy(p, &(uint32_t){in_addr + 128}, 4); p += 4;
    *p++ = 0x9d;
    /* GPRs, rsp last */
    for (int i = 0; i < 16; i++) {
        if (i == 4) continue;
        p = emit_load_gpr(p, i, in_addr + 8 * i);
    }
    p = emit_load_gpr(p, 4, in_addr + 8 * 4);

    /* jmp SNIPPET: E9 rel32 */
    *p++ = 0xe9;
    {
        int32_t rel = (int32_t)(SNIPPET - (p + 4));
        memcpy(p, &rel, 4);
        p += 4;
    }
    p = SNIPPET;
    memcpy(p, snippet, len);
    p += len;

    /* Epilogue: store every general register, then leave the test's
     * stack alone: switch back to the harness's before pushf touches
     * memory, so the scratch page holds only what the snippet wrote. */
    for (int i = 0; i < 16; i++) p = emit_store_gpr(p, i, (uint32_t)(uintptr_t)OUT + OUT_GPR + 8 * i);
    p = emit_load_gpr(p, 4, (uint32_t)(uintptr_t)OUT + OUT_HARNESS_RSP);
    /* pushf; pop [OUT_FLAGS]: 9C ; 8F 04 25 disp32 */
    *p++ = 0x9c;
    *p++ = 0x8f; *p++ = 0x04; *p++ = 0x25; memcpy(p, &(uint32_t){(uint32_t)(uintptr_t)OUT + OUT_FLAGS}, 4); p += 4;
    for (int i = 0; i < 16; i++) p = emit_store_ymm(p, i, (uint32_t)(uintptr_t)OUT + OUT_YMM + 32 * i);
    *p++ = 0xc3;
}

int main(void)
{
    if (mmap(CODE, 65536, PROT_READ | PROT_WRITE | PROT_EXEC, MAP_PRIVATE | MAP_ANONYMOUS | MAP_FIXED, -1, 0) == MAP_FAILED ||
        mmap(SCRATCH, 65536, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS | MAP_FIXED, -1, 0) == MAP_FAILED ||
        mmap(OUT, 65536, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS | MAP_FIXED, -1, 0) == MAP_FAILED) {
        perror("mmap");
        return 1;
    }
    static char line[65536];
    static uint8_t snippet[MAX_CODE];
    while (fgets(line, sizeof line, stdin)) {
        char *save = NULL;
        char *tok = strtok_r(line, " \n", &save);
        if (!tok) continue;
        int len = parse_hex(tok, snippet, MAX_CODE);
        for (int i = 0; i < 16; i++) {
            tok = strtok_r(NULL, " \n", &save);
            in_regs[i] = strtoull(tok, NULL, 16);
        }
        tok = strtok_r(NULL, " \n", &save);
        in_flags = strtoull(tok, NULL, 16) | 0x202;
        tok = strtok_r(NULL, " \n", &save);
        memset(SCRATCH, 0, SCRATCH_SIZE);
        if (tok) parse_hex(tok, SCRATCH, SCRATCH_SIZE);
        /* ymm inputs: the scratch page's first 512 bytes, so they are
         * random too */
        memcpy((uint8_t *)OUT + 2048 + 1024, SCRATCH, 512);

        build(snippet, len);
        run();

        uint64_t *out = OUT;
        for (int i = 0; i < 16; i++) printf("%llx ", (unsigned long long)out[i]);
        printf("%llx ", (unsigned long long)(out[OUT_FLAGS / 8] & 0x8d5));
        uint8_t *ymm = (uint8_t *)OUT + OUT_YMM;
        for (int i = 0; i < 512; i++) printf("%02x", ymm[i]);
        printf(" ");
        for (int i = 0; i < SCRATCH_SIZE; i++) printf("%02x", SCRATCH[i]);
        printf("\n");
        fflush(stdout);
    }
    return 0;
}
