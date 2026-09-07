// The runtime module: the register file and the helpers translated code
// calls. Built once per Machine with the encoder and instantiated
// before any translated module, which then imports its exports.
//
// Helpers here are the operations that are awkward or long to emit
// inline at every site: evaluating the lazy flags, looking a guest
// address up in the block table, and the high halves of 64-bit
// multiplies.
import { Code, ModuleBuilder, T } from "./wasm.js";
import { CC, FLAG, G, GLOBALS } from "./state.js";

const VALTYPE = { i32: T.i32, i64: T.i64, f64: T.f64, v128: T.v128 };

// The block lookup is a two-level table in guest memory, in the region
// the Machine keeps for itself: one 32-bit word per 4 KiB page pointing
// at a 16 KiB second-level block, which holds one table index per byte
// of the page. Zero means untranslated. The directory's address is a
// constant of the helper module, so the Machine passes it in.
export const LOOKUP_L1_SIZE = 1 << 22;
export const LOOKUP_L2_SIZE = 1 << 14;

export function buildHelpersModule({ l1Base }) {
  const m = new ModuleBuilder();
  m.importMemory("env", "memory", { min: 1, max: 65536 });

  // Globals, in state.js order, all exported.
  for (const [name, type] of GLOBALS) {
    const init = new Code();
    if (type === "i32") {
      init.i32_const(0);
    } else if (type === "i64") {
      init.i64_const(0);
    } else if (type === "f64") {
      init.f64_const(0);
    } else {
      init.v128_const(new Uint8Array(16));
    }
    init.end();
    m.addGlobal(VALTYPE[type], true, init, { export: name });
  }

  // lookup(addr: i64) -> i32
  {
    const c = new Code(1);
    const l1 = c.declareLocal(T.i32);
    const a = c.declareLocal(T.i32);
    c.local_get(0).i32_wrap_i64().local_set(a);
    // l1 = load32(LOOKUP_L1_BASE + (a >> 12) * 4)
    c.local_get(a).i32_const(12).i32_shr_u().i32_const(2).i32_shl().i32_load(l1Base).local_tee(l1);
    c.i32_eqz().if_(T.empty).i32_const(0).return_().end();
    // load32(l1 + (a & 0xfff) * 4)
    c.local_get(l1).local_get(a).i32_const(0xfff).i32_and().i32_const(2).i32_shl().i32_add().i32_load(0);
    c.end();
    m.addFunc(m.addType([T.i64], [T.i32]), c.locals, c, { export: "lookup" });
  }

  // cc_eflags() -> i32: the six arithmetic flags in EFLAGS layout.
  {
    const c = new Code(0);
    const op = c.declareLocal(T.i32);
    const bits = c.declareLocal(T.i32);
    const dst = c.declareLocal(T.i64);
    const src = c.declareLocal(T.i64);
    const src2 = c.declareLocal(T.i64);
    const mask = c.declareLocal(T.i64);
    const src1 = c.declareLocal(T.i64);
    const flags = c.declareLocal(T.i32);
    const cf = c.declareLocal(T.i32);
    const of = c.declareLocal(T.i32);
    const af = c.declareLocal(T.i32);

    c.global_get(G.cc_op).local_set(op);
    c.global_get(G.cc_dst).local_set(dst);
    c.global_get(G.cc_src).local_set(src);
    c.global_get(G.cc_src2).local_set(src2);
    // bits = 8 << (op & 3); mask = ~0 >>> (64 - bits)
    c.i32_const(8).local_get(op).i32_const(3).i32_and().i32_shl().local_set(bits);
    c.i64_const(-1).i64_const(64).local_get(bits).i64_extend_i32_u().i64_sub().i64_shr_u().local_set(mask);

    // EFLAGS kind: the flags are stored as such in cc_src.
    c.local_get(op).i32_const(2).i32_shr_u().i32_eqz().if_(T.empty);
    c.local_get(src).i32_wrap_i64().return_();
    c.end();

    // ZF, SF, PF from dst
    c.local_get(dst).i64_eqz().i32_const(6).i32_shl();
    c.local_get(dst).local_get(bits).i32_const(1).i32_sub().i64_extend_i32_u().i64_shr_u().i32_wrap_i64().i32_const(1).i32_and().i32_const(7).i32_shl();
    c.i32_or();
    c.local_get(dst).i64_const(0xff).i64_and().i64_popcnt().i32_wrap_i64().i32_const(1).i32_and().i32_const(1).i32_xor().i32_const(2).i32_shl();
    c.i32_or().local_set(flags);

    // sign(x): (x >> (bits-1)) & 1 as i32
    const signBit = () => {
      c.local_get(bits).i32_const(1).i32_sub().i64_extend_i32_u().i64_shr_u().i32_wrap_i64().i32_const(1).i32_and();
    };

    // Dispatch on kind. Cases are laid out after their block's end.
    const KINDS = [CC.ADD, CC.ADC, CC.SUB, CC.SBB, CC.LOGIC, CC.INC, CC.DEC, CC.SHL, CC.SAR, CC.SHR, CC.MUL];
    // Twelve nested blocks: one per kind plus the outermost for the
    // default. A case's code follows its block's end and branches out
    // to the outermost block, which is depth 10 - i for the i-th case
    // (kind i + 1); the default lands after the outermost end.
    const nblocks = 12;
    for (let i = 0; i < nblocks; i++) {
      c.block(T.empty);
    }
    c.local_get(op).i32_const(2).i32_shr_u();
    // kind 0 handled above; map kind k to depth k-1, default outermost
    c.br_table([11, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 11);
    c.end(); // ADD
    c.local_get(dst).local_get(src).i64_sub().local_get(mask).i64_and().local_set(src1);
    c.local_get(dst).local_get(src).i64_lt_u().local_set(cf);
    c.local_get(src1).local_get(dst).i64_xor().local_get(src).local_get(dst).i64_xor().i64_and();
    signBit();
    c.local_set(of);
    c.local_get(src1).local_get(src).i64_xor().local_get(dst).i64_xor().i32_wrap_i64().i32_const(4).i32_shr_u().i32_const(1).i32_and().local_set(af);
    c.br(10);
    c.end(); // ADC
    c.local_get(dst).local_get(src).i64_sub().local_get(src2).i64_sub().local_get(mask).i64_and().local_set(src1);
    c.local_get(src2).i64_eqz().if_(T.i32).local_get(dst).local_get(src).i64_lt_u().else_().local_get(dst).local_get(src).i64_le_u().end().local_set(cf);
    c.local_get(src1).local_get(dst).i64_xor().local_get(src).local_get(dst).i64_xor().i64_and();
    signBit();
    c.local_set(of);
    c.local_get(src1).local_get(src).i64_xor().local_get(dst).i64_xor().i32_wrap_i64().i32_const(4).i32_shr_u().i32_const(1).i32_and().local_set(af);
    c.br(9);
    c.end(); // SUB
    c.local_get(dst).local_get(src).i64_add().local_get(mask).i64_and().local_set(src1);
    c.local_get(src1).local_get(src).i64_lt_u().local_set(cf);
    c.local_get(src1).local_get(src).i64_xor().local_get(src1).local_get(dst).i64_xor().i64_and();
    signBit();
    c.local_set(of);
    c.local_get(src1).local_get(src).i64_xor().local_get(dst).i64_xor().i32_wrap_i64().i32_const(4).i32_shr_u().i32_const(1).i32_and().local_set(af);
    c.br(8);
    c.end(); // SBB
    c.local_get(dst).local_get(src).i64_add().local_get(src2).i64_add().local_get(mask).i64_and().local_set(src1);
    c.local_get(src2).i64_eqz().if_(T.i32).local_get(src1).local_get(src).i64_lt_u().else_().local_get(src1).local_get(src).i64_le_u().end().local_set(cf);
    c.local_get(src1).local_get(src).i64_xor().local_get(src1).local_get(dst).i64_xor().i64_and();
    signBit();
    c.local_set(of);
    c.local_get(src1).local_get(src).i64_xor().local_get(dst).i64_xor().i32_wrap_i64().i32_const(4).i32_shr_u().i32_const(1).i32_and().local_set(af);
    c.br(7);
    c.end(); // LOGIC: cf = of = af = 0
    c.br(6);
    c.end(); // INC: cf kept in src; of = dst == sign bit; af = low nibble zero
    c.local_get(src).i32_wrap_i64().i32_const(1).i32_and().local_set(cf);
    c.local_get(dst).i64_const(1).local_get(bits).i32_const(1).i32_sub().i64_extend_i32_u().i64_shl().i64_eq().local_set(of);
    c.local_get(dst).i64_const(0xf).i64_and().i64_eqz().local_set(af);
    c.br(5);
    c.end(); // DEC: of = dst == sign bit - 1; af = low nibble all ones
    c.local_get(src).i32_wrap_i64().i32_const(1).i32_and().local_set(cf);
    c.local_get(dst).local_get(mask).i64_const(1).i64_shr_u().i64_eq().local_set(of);
    c.local_get(dst).i64_const(0xf).i64_and().i64_const(0xf).i64_eq().local_set(af);
    c.br(4);
    c.end(); // SHL: cf = src & 1; of = cf ^ sf
    c.local_get(src).i32_wrap_i64().i32_const(1).i32_and().local_set(cf);
    c.local_get(cf).local_get(flags).i32_const(7).i32_shr_u().i32_const(1).i32_and().i32_xor().local_set(of);
    c.br(3);
    c.end(); // SAR: cf = src & 1; of = 0
    c.local_get(src).i32_wrap_i64().i32_const(1).i32_and().local_set(cf);
    c.br(2);
    c.end(); // SHR: cf = src & 1; of = sign of the original operand (src2)
    c.local_get(src).i32_wrap_i64().i32_const(1).i32_and().local_set(cf);
    c.local_get(src2);
    signBit();
    c.local_set(of);
    c.br(1);
    c.end(); // MUL: cf = of = src != 0
    c.local_get(src).i64_eqz().i32_const(1).i32_xor().local_tee(cf).local_set(of);
    c.br(0);
    c.end(); // outermost; the default case lands here with cf/of/af zero
    // flags |= cf | af << 4 | of << 11
    c.local_get(flags).local_get(cf).i32_or().local_get(af).i32_const(4).i32_shl().i32_or().local_get(of).i32_const(11).i32_shl().i32_or();
    c.end();
    m.addFunc(m.addType([], [T.i32]), c.locals, c, { export: "cc_eflags" });
  }

  // cc_cond(cond: i32) -> i32: evaluates a condition code 0..15.
  {
    const c = new Code(1);
    const f = c.declareLocal(T.i32);
    const r = c.declareLocal(T.i32);
    c.call(1).local_set(f); // cc_eflags: the module imports no functions, so lookup is 0 and cc_eflags 1
    for (let i = 0; i < 9; i++) {
      c.block(T.empty);
    }
    c.local_get(0).i32_const(1).i32_shr_u().br_table([0, 1, 2, 3, 4, 5, 6, 7], 8);
    c.end(); // o
    c.local_get(f).i32_const(11).i32_shr_u().i32_const(1).i32_and().local_set(r).br(7);
    c.end(); // b
    c.local_get(f).i32_const(1).i32_and().local_set(r).br(6);
    c.end(); // e
    c.local_get(f).i32_const(6).i32_shr_u().i32_const(1).i32_and().local_set(r).br(5);
    c.end(); // be
    c.local_get(f).i32_const(1).i32_and().local_get(f).i32_const(6).i32_shr_u().i32_const(1).i32_and().i32_or().local_set(r).br(4);
    c.end(); // s
    c.local_get(f).i32_const(7).i32_shr_u().i32_const(1).i32_and().local_set(r).br(3);
    c.end(); // p
    c.local_get(f).i32_const(2).i32_shr_u().i32_const(1).i32_and().local_set(r).br(2);
    c.end(); // l: sf ^ of
    c.local_get(f).i32_const(7).i32_shr_u().local_get(f).i32_const(11).i32_shr_u().i32_xor().i32_const(1).i32_and().local_set(r).br(1);
    c.end(); // le: zf | (sf ^ of)
    c.local_get(f).i32_const(7).i32_shr_u().local_get(f).i32_const(11).i32_shr_u().i32_xor().local_get(f).i32_const(6).i32_shr_u().i32_or().i32_const(1).i32_and().local_set(r);
    c.end();
    c.local_get(r).local_get(0).i32_const(1).i32_and().i32_xor();
    c.end();
    m.addFunc(m.addType([T.i32], [T.i32]), c.locals, c, { export: "cc_cond" });
  }

  // mulhu(a, b) -> high 64 bits of the unsigned 128-bit product
  {
    const c = new Code(2);
    const a0 = c.declareLocal(T.i64);
    const a1 = c.declareLocal(T.i64);
    const b0 = c.declareLocal(T.i64);
    const b1 = c.declareLocal(T.i64);
    const t = c.declareLocal(T.i64);
    const u = c.declareLocal(T.i64);
    const M = 0xffffffffn;
    c.local_get(0).i64_const(M).i64_and().local_set(a0);
    c.local_get(0).i64_const(32).i64_shr_u().local_set(a1);
    c.local_get(1).i64_const(M).i64_and().local_set(b0);
    c.local_get(1).i64_const(32).i64_shr_u().local_set(b1);
    // t = (a0*b0 >> 32) + a1*b0 ; u = (t & M) + a0*b1
    c.local_get(a0).local_get(b0).i64_mul().i64_const(32).i64_shr_u().local_get(a1).local_get(b0).i64_mul().i64_add().local_set(t);
    c.local_get(t).i64_const(M).i64_and().local_get(a0).local_get(b1).i64_mul().i64_add().local_set(u);
    // high = a1*b1 + (t >> 32) + (u >> 32)
    c.local_get(a1).local_get(b1).i64_mul().local_get(t).i64_const(32).i64_shr_u().i64_add().local_get(u).i64_const(32).i64_shr_u().i64_add();
    c.end();
    m.addFunc(m.addType([T.i64, T.i64], [T.i64]), c.locals, c, { export: "mulhu" });
  }

  // mulhs(a, b) -> high 64 bits of the signed product:
  // mulhu(a,b) - (a<0 ? b : 0) - (b<0 ? a : 0)
  {
    const c = new Code(2);
    c.local_get(0).local_get(1).call(3); // mulhu
    c.local_get(0).i64_const(63).i64_shr_s().local_get(1).i64_and().i64_sub();
    c.local_get(1).i64_const(63).i64_shr_s().local_get(0).i64_and().i64_sub();
    c.end();
    m.addFunc(m.addType([T.i64, T.i64], [T.i64]), c.locals, c, { export: "mulhs" });
  }

  // save_xmm(addr: i32) / load_xmm(addr: i32): the sixteen xmm
  // registers through memory, 16 bytes each, for JavaScript callers.
  {
    const c = new Code(1);
    for (let i = 0; i < 16; i++) {
      c.local_get(0).global_get(G[`xmm${i}`]).v128_store(16 * i, 0);
    }
    c.end();
    m.addFunc(m.addType([T.i32], []), c.locals, c, { export: "save_xmm" });
  }
  {
    const c = new Code(1);
    for (let i = 0; i < 16; i++) {
      c.local_get(0).v128_load(16 * i, 0).global_set(G[`xmm${i}`]);
    }
    c.end();
    m.addFunc(m.addType([T.i32], []), c.locals, c, { export: "load_xmm" });
  }

  return m.toBytes();
}

export const HELPER_FUNCS = ["lookup", "cc_eflags", "cc_cond", "mulhu", "mulhs"];
