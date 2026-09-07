/*
 * Check the scalar instructions a Haswell guest executes that a baseline
 * one cannot, each against a plain-C implementation of the same
 * operation. Run in the guest, this says whether the emulator's JIT
 * computes what the hardware would.
 *
 * The engine is a JIT, and a JIT can be wrong about an instruction
 * rather than merely slow at it. POPCNT was: the wasm backend read the
 * operands of `ctpop` one slot along, so the instruction answered with
 * whatever its destination register already held. Nothing in the guest
 * image emits these instructions, so the VM booted to a shell either
 * way and every other check in the tree passed.
 *
 * Scope is x86-64-v2 and v3 scalar, which is what raising the CPU model
 * in nix/guest/machine.json newly reached. The vector half is left out:
 * TCG lowers most of it through helpers shared with every backend,
 * rather than through the per-op code that was wrong here.
 */
#include <stdint.h>
#include <stdio.h>

static int failures = 0;

/* Report one disagreement. The input is printed because which inputs
 * fail is the first clue about what the emulator got wrong -- a single
 * bad answer for every input reads very differently from one that only
 * fails on zero. */
static void check(const char *what, uint64_t input, uint64_t got, uint64_t want)
{
    if (got == want) {
        return;
    }
    printf("FAIL %-12s in=0x%016llx got=0x%llx want=0x%llx\n", what,
           (unsigned long long)input, (unsigned long long)got,
           (unsigned long long)want);
    failures++;
}

/* Reference implementations: plain C, no instruction newer than the
 * baseline the compiler is told to target for this file. */

static uint64_t ref_ctz(uint64_t x)
{
    if (x == 0) {
        return 64;
    }
    uint64_t n = 0;
    while ((x & 1) == 0) {
        x >>= 1;
        n++;
    }
    return n;
}

static uint64_t ref_clz(uint64_t x)
{
    if (x == 0) {
        return 64;
    }
    uint64_t n = 0;
    while ((x & (1ULL << 63)) == 0) {
        x <<= 1;
        n++;
    }
    return n;
}

static uint64_t ref_popcount(uint64_t x)
{
    uint64_t n = 0;
    for (; x != 0; x >>= 1) {
        n += (x & 1);
    }
    return n;
}

/* Deposit the low bits of `x` into the set bit positions of `mask`. */
static uint64_t ref_pdep(uint64_t x, uint64_t mask)
{
    uint64_t result = 0;
    for (int bit = 0; bit < 64; bit++) {
        if ((mask & (1ULL << bit)) == 0) {
            continue;
        }
        if (x & 1) {
            result |= (1ULL << bit);
        }
        x >>= 1;
    }
    return result;
}

/* Gather the bits of `x` at the set positions of `mask` into the low
 * bits of the result: the inverse of ref_pdep. */
static uint64_t ref_pext(uint64_t x, uint64_t mask)
{
    uint64_t result = 0;
    int out = 0;
    for (int bit = 0; bit < 64; bit++) {
        if ((mask & (1ULL << bit)) == 0) {
            continue;
        }
        if (x & (1ULL << bit)) {
            result |= (1ULL << out);
        }
        out++;
    }
    return result;
}

/*
 * The instructions themselves. Written as inline asm rather than as
 * builtins so that the file tests the instruction the name promises,
 * whatever the compiler would have chosen on its own.
 */

#define UNARY(name, mnemonic)                                                 \
    static uint64_t name(uint64_t x)                                          \
    {                                                                         \
        uint64_t r;                                                           \
        __asm__(mnemonic "\t%1, %0" : "=r"(r) : "r"(x) : "cc");                \
        return r;                                                             \
    }

#define BINARY(name, mnemonic)                                                \
    static uint64_t name(uint64_t a, uint64_t b)                              \
    {                                                                         \
        uint64_t r;                                                           \
        __asm__(mnemonic "\t%2, %1, %0" : "=r"(r) : "r"(a), "r"(b) : "cc");     \
        return r;                                                             \
    }

UNARY(asm_popcnt, "popcnt")
UNARY(asm_tzcnt, "tzcnt")
UNARY(asm_lzcnt, "lzcnt")
UNARY(asm_blsi, "blsi")
UNARY(asm_blsr, "blsr")
UNARY(asm_blsmsk, "blsmsk")

BINARY(asm_andn, "andn")
BINARY(asm_bextr, "bextr")
BINARY(asm_bzhi, "bzhi")
BINARY(asm_shlx, "shlx")
BINARY(asm_shrx, "shrx")
BINARY(asm_sarx, "sarx")

/*
 * tzcnt and lzcnt set the carry flag when the source is zero, and that
 * flag is a separate result from the count. mimalloc reads exactly this
 * to answer "did this word have any bit set at all", so a backend that
 * gets the count right and the flag wrong still breaks an allocator.
 */
static uint64_t asm_tzcnt_carry(uint64_t x, uint64_t *idx)
{
    uint64_t is_zero;
    __asm__("tzcnt\t%2, %1" : "=@ccc"(is_zero), "=r"(*idx) : "r"(x) : "cc");
    return is_zero;
}

static uint64_t asm_lzcnt_carry(uint64_t x, uint64_t *idx)
{
    uint64_t is_zero;
    __asm__("lzcnt\t%2, %1" : "=@ccc"(is_zero), "=r"(*idx) : "r"(x) : "cc");
    return is_zero;
}

/* popcnt sets the zero flag when the source is zero, and clears every
 * other flag. */
static uint64_t asm_popcnt_zero(uint64_t x, uint64_t *count)
{
    uint64_t is_zero;
    __asm__("popcnt\t%2, %1" : "=@ccz"(is_zero), "=r"(*count) : "r"(x) : "cc");
    return is_zero;
}

static uint64_t asm_rorx(uint64_t x)
{
    uint64_t r;
    __asm__("rorx\t$13, %1, %0" : "=r"(r) : "r"(x));
    return r;
}

/* mulx returns the full 128-bit product in two registers and touches no
 * flags. */
static uint64_t asm_mulx(uint64_t a, uint64_t b, uint64_t *high)
{
    uint64_t low;
    __asm__("mulx\t%3, %0, %1" : "=r"(low), "=r"(*high) : "d"(a), "r"(b));
    return low;
}

static uint64_t asm_pdep(uint64_t x, uint64_t mask)
{
    uint64_t r;
    __asm__("pdep\t%2, %1, %0" : "=r"(r) : "r"(x), "r"(mask));
    return r;
}

static uint64_t asm_pext(uint64_t x, uint64_t mask)
{
    uint64_t r;
    __asm__("pext\t%2, %1, %0" : "=r"(r) : "r"(x), "r"(mask));
    return r;
}

/* movbe loads and stores byte-reversed, and only between a register and
 * memory, so it needs a real address rather than a register. */
static uint64_t asm_movbe_load(const uint64_t *from)
{
    uint64_t r;
    __asm__("movbe\t%1, %0" : "=r"(r) : "m"(*from));
    return r;
}

static uint64_t ref_bswap(uint64_t x)
{
    uint64_t r = 0;
    for (int byte = 0; byte < 8; byte++) {
        r = (r << 8) | ((x >> (byte * 8)) & 0xFF);
    }
    return r;
}

int main(void)
{
    /* Zero, every single-bit value, all ones, and a few values this
     * emulator has reason to compute on: a page size, an allocator's
     * reservation sizes, and a pattern with no symmetry to hide a
     * byte-order or shift mistake. */
    uint64_t inputs[72];
    size_t count = 0;
    inputs[count++] = 0;
    for (int bit = 0; bit < 64; bit++) {
        inputs[count++] = 1ULL << bit;
    }
    inputs[count++] = 0xFFFFFFFFFFFFFFFFULL;
    inputs[count++] = 0x0000000000001000ULL;
    inputs[count++] = 0x0000000000210000ULL;
    inputs[count++] = 0x0000000040000000ULL;
    inputs[count++] = 0x123456789ABCDEF0ULL;
    inputs[count++] = 0x8000000000000001ULL;
    inputs[count++] = 0xF0F0F0F0F0F0F0F0ULL;

    const uint64_t other = 0xF0F0F0F0F0F0F0F0ULL;

    for (size_t i = 0; i < count; i++) {
        uint64_t x = inputs[i];

        /* Counts. tzcnt and lzcnt are defined at zero on x86-64: both
         * answer 64, unlike the bsf/bsr they replace. */
        check("popcnt", x, asm_popcnt(x), ref_popcount(x));
        check("tzcnt", x, asm_tzcnt(x), ref_ctz(x));
        check("lzcnt", x, asm_lzcnt(x), ref_clz(x));

        /* The flags those three set, which are results in their own
         * right and are set from a different part of a backend. */
        uint64_t idx = 0;
        check("tzcnt.cf", x, asm_tzcnt_carry(x, &idx), (x == 0) ? 1 : 0);
        check("tzcnt.cf.idx", x, idx, ref_ctz(x));
        check("lzcnt.cf", x, asm_lzcnt_carry(x, &idx), (x == 0) ? 1 : 0);
        check("lzcnt.cf.idx", x, idx, ref_clz(x));
        check("popcnt.zf", x, asm_popcnt_zero(x, &idx), (x == 0) ? 1 : 0);
        check("popcnt.zf.n", x, idx, ref_popcount(x));

        /* BMI1's single-bit manipulations. */
        check("andn", x, asm_andn(x, other), (~x) & other);
        check("blsi", x, asm_blsi(x), x & (~x + 1));
        check("blsr", x, asm_blsr(x), x & (x - 1));
        check("blsmsk", x, asm_blsmsk(x), x ^ (x - 1));

        /* bextr takes start in the low byte of its control operand and
         * length in the next: here bits 8..39 of the source. */
        check("bextr", x, asm_bextr(x, 0x2008), (x >> 8) & 0xFFFFFFFFULL);

        /* BMI2's shifts, which unlike the classic ones do not touch
         * flags and take the count from any register. */
        check("shlx", x, asm_shlx(x, 5), x << 5);
        check("shrx", x, asm_shrx(x, 5), x >> 5);
        check("sarx", x, asm_sarx(x, 5), (uint64_t)(((int64_t)x) >> 5));
        check("rorx", x, asm_rorx(x), (x >> 13) | (x << 51));

        /* The full-width multiply, both halves. */
        uint64_t high = 0;
        uint64_t low = asm_mulx(x, other, &high);
        __uint128_t product = (__uint128_t)x * (__uint128_t)other;
        check("mulx.lo", x, low, (uint64_t)product);
        check("mulx.hi", x, high, (uint64_t)(product >> 64));

        /* The bit scatter/gather pair, the two most intricate things a
         * backend has to get right here. */
        check("pdep", x, asm_pdep(x, other), ref_pdep(x, other));
        check("pext", x, asm_pext(x, other), ref_pext(x, other));

        /* And the byte-reversing load. */
        check("movbe", x, asm_movbe_load(&x), ref_bswap(x));
    }

    /* bzhi clears the bits from index n upward, and leaves the value
     * alone once n reaches the register width. */
    for (uint64_t n = 0; n <= 70; n++) {
        const uint64_t all = 0xFFFFFFFFFFFFFFFFULL;
        const uint64_t want = (n >= 64) ? all : (all & ((1ULL << n) - 1));
        check("bzhi", n, asm_bzhi(all, n), want);
    }

    if (failures == 0) {
        printf("cputest: ok\n");
        return 0;
    }
    printf("cputest: %d mismatches\n", failures);
    return 1;
}
