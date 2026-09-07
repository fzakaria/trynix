// The x87 floating-point unit, on f64.
//
// The eight registers are f64 globals addressed through the top-of-
// stack index, with push, pop, get and set as helper functions in the
// helpers module (a br_table over the physical register), so the
// translation of an x87 instruction is a few calls and an f64
// operation. Precision is 53 bits, not the 64 the hardware carries;
// docs/translate.md lists that as a known deviation. The 80-bit memory
// forms convert through the `fpu` import, as do the transcendentals,
// which JavaScript's Math has and wasm does not.
//
// The status word keeps C0-C3 (bits 8, 9, 10 and 14) from the compare
// and examine instructions; fnstsw folds the top index into bits 11-13
// on the way out.
import { T } from "./wasm.js";
import { Unsupported } from "./translate.js";
import { REG } from "./decode.js";

// Operation numbers for the `fpu` import.
export const FPU = Object.freeze({
  LOAD80: 1, // push the 80-bit value at arg
  STORE80: 2, // store ST0 as 80 bits at arg
  F2XM1: 10,
  FYL2X: 11,
  FPTAN: 12,
  FPATAN: 13,
  FYL2XP1: 14,
  FSIN: 15,
  FCOS: 16,
  FSINCOS: 17,
  FSCALE: 18,
  FPREM: 19,
  FPREM1: 20,
  FXTRACT: 21,
});

const C0 = 0x100;
const C1 = 0x200;
const C2 = 0x400;
const C3 = 0x4000;
const CONDITION_BITS = C0 | C1 | C2 | C3;

// The JavaScript side of the fpu import.
export function fpuOp(machine, op, arg) {
  const h = machine.helpers;
  const get = (i) => h.fpu_get(i);
  const set = (i, v) => h.fpu_set(i, v);
  switch (op) {
    case FPU.LOAD80:
      h.fpu_push(read80(machine, Number(arg)));
      return;
    case FPU.STORE80:
      write80(machine, Number(arg), get(0));
      return;
    case FPU.F2XM1:
      set(0, Math.pow(2, get(0)) - 1);
      return;
    case FPU.FYL2X:
      set(1, get(1) * Math.log2(get(0)));
      h.fpu_pop();
      return;
    case FPU.FYL2XP1:
      set(1, get(1) * Math.log2(get(0) + 1));
      h.fpu_pop();
      return;
    case FPU.FPTAN:
      set(0, Math.tan(get(0)));
      h.fpu_push(1);
      return;
    case FPU.FPATAN:
      set(1, Math.atan2(get(1), get(0)));
      h.fpu_pop();
      return;
    case FPU.FSIN:
      set(0, Math.sin(get(0)));
      return;
    case FPU.FCOS:
      set(0, Math.cos(get(0)));
      return;
    case FPU.FSINCOS: {
      const x = get(0);
      set(0, Math.sin(x));
      h.fpu_push(Math.cos(x));
      return;
    }
    case FPU.FSCALE:
      set(0, get(0) * Math.pow(2, Math.trunc(get(1))));
      return;
    case FPU.FPREM:
    case FPU.FPREM1: {
      const a = get(0);
      const b = get(1);
      const q = op === FPU.FPREM ? Math.trunc(a / b) : Math.round(a / b);
      set(0, a - q * b);
      // C2 clear: the reduction is complete. C0, C3, C1 hold the low
      // quotient bits.
      const qi = Math.abs(q);
      let sw = h.fpu_sw.value & ~CONDITION_BITS;
      sw |= (qi & 1) ? C1 : 0;
      sw |= (qi & 2) ? C3 : 0;
      sw |= (qi & 4) ? C0 : 0;
      h.fpu_sw.value = sw;
      return;
    }
    case FPU.FXTRACT: {
      const x = get(0);
      if (x === 0) {
        set(0, -Infinity);
        h.fpu_push(x);
        return;
      }
      const e = Math.floor(Math.log2(Math.abs(x)));
      set(0, e);
      h.fpu_push(x / Math.pow(2, e));
      return;
    }
    default:
      throw new Error(`fpu op ${op}`);
  }
}

// 80-bit extended <-> f64. The mantissa's top 11 bits become the
// double's 52 with rounding to nearest; anything beyond double's range
// becomes an infinity or zero.
function read80(m, addr) {
  const mant = m.view.getBigUint64(addr, true);
  const se = m.view.getUint16(addr + 8, true);
  const sign = se & 0x8000 ? -1 : 1;
  const exp = se & 0x7fff;
  if (exp === 0 && mant === 0n) {
    return sign * 0;
  }
  if (exp === 0x7fff) {
    return (mant << 1n) === 0n ? sign * Infinity : NaN;
  }
  // value = mant * 2^(exp - 16383 - 63)
  const hi = Number(mant >> 11n);
  const lo = Number(mant & 0x7ffn);
  let f = hi + lo / 2048;
  return sign * f * Math.pow(2, exp - 16383 - 63 + 11) ;
}

function write80(m, addr, v) {
  let sign = 0;
  if (v < 0 || Object.is(v, -0)) {
    sign = 0x8000;
    v = -v;
  }
  let mant = 0n;
  let exp = 0;
  if (Number.isNaN(v)) {
    mant = 0xc000000000000000n;
    exp = 0x7fff;
  } else if (v === Infinity) {
    mant = 0x8000000000000000n;
    exp = 0x7fff;
  } else if (v !== 0) {
    const bits = new DataView(new ArrayBuffer(8));
    bits.setFloat64(0, v);
    const raw = bits.getBigUint64(0);
    let e = Number((raw >> 52n) & 0x7ffn);
    let frac = raw & 0xfffffffffffffn;
    if (e === 0) {
      // Subnormal double: normalise.
      while ((frac & 0x10000000000000n) === 0n) {
        frac <<= 1n;
        e--;
      }
      frac &= 0xfffffffffffffn;
      e += 1;
    }
    mant = (0x10000000000000n | frac) << 11n;
    exp = e - 1023 + 16383;
  }
  m.view.setBigUint64(addr, mant, true);
  m.view.setUint16(addr + 8, sign | exp, true);
}

// Register forms: "st(i)" operands from the decoder.
const isSt = (op) => op && op.kind === "st";

export function emitX87(e, insn, ops) {
  const c = e.c;
  const h = e.ctx.helpers;
  const m = insn.mnemonic;
  if (!m.startsWith("f")) {
    return false;
  }
  const dst = ops[0];
  const src = ops[1];

  // f64 of an operand: st(i) or a memory float of the given width. The
  // hardware quiets a signalling NaN as it loads it; wasm loads bits.
  const loadF = (op) => {
    if (isSt(op)) {
      c.i32_const(op.reg).call(h.fpu_get);
      return;
    }
    e.address32(op);
    if (op.size === 4) {
      c.f32_load(0, 0).f64_promote_f32();
    } else if (op.size === 8) {
      c.f64_load(0, 0);
    } else {
      throw new Unsupported(`x87 float of ${op.size} bytes`);
    }
    const v = e.tF64();
    c.local_tee(v).local_get(v).f64_ne().if_(T.empty);
    c.local_get(v).i64_reinterpret_f64().i64_const(0x0008000000000000n).i64_or().f64_reinterpret_i64().local_set(v);
    c.end();
    c.local_get(v);
  };
  // f64 of an integer memory operand.
  const loadI = (op) => {
    e.address32(op);
    if (op.size === 2) {
      c.i64_load16_s(0);
    } else if (op.size === 4) {
      c.i64_load32_s(0, 0);
    } else {
      c.i64_load(0, 0);
    }
    c.f64_convert_i64_s();
  };
  const push = () => c.call(h.fpu_push);
  const pop = () => c.call(h.fpu_pop).drop();
  const st0 = () => c.i32_const(0).call(h.fpu_get);
  const setSt = (i) => {
    // value on stack
    const v = e.tF64();
    c.local_set(v).i32_const(i).local_get(v).call(h.fpu_set);
  };
  // Rounds the f64 on the stack by the control word's RC field.
  const roundByCw = () => {
    const v = e.tF64();
    c.local_set(v);
    c.global_get(e.g.fpu_cw).i32_const(10).i32_shr_u().i32_const(3).i32_and();
    const rc = e.t32();
    c.local_set(rc);
    c.local_get(rc).i32_eqz().if_(T.f64).local_get(v).f64_nearest();
    c.else_().local_get(rc).i32_const(1).i32_eq().if_(T.f64).local_get(v).f64_floor();
    c.else_().local_get(rc).i32_const(2).i32_eq().if_(T.f64).local_get(v).f64_ceil();
    c.else_().local_get(v).f64_trunc().end().end().end();
  };
  // Stores the f64 on the stack as an integer of `size` at the address
  // in local a. Out of range or NaN gives the integer indefinite, the
  // most negative value of the width, as the hardware does.
  const storeI = (aLocal, size) => {
    const v = e.tF64();
    c.local_set(v);
    const limit = size === 8 ? 9223372036854775808 : size === 4 ? 2147483648 : 32768;
    const indefinite = size === 8 ? 0x8000000000000000n : size === 4 ? 0x80000000n : 0x8000n;
    c.local_get(aLocal);
    c.local_get(v).i64_trunc_sat_f64_s();
    c.i64_const(indefinite);
    c.local_get(v).local_get(v).f64_ne();
    c.local_get(v).f64_const(limit).f64_ge().i32_or();
    c.local_get(v).f64_const(-limit).f64_lt().i32_or();
    c.i32_eqz();
    c.select();
    if (size === 8) {
      c.i64_store(0, 0);
    } else if (size === 4) {
      c.i64_store32(0, 0);
    } else {
      c.i64_store16(0);
    }
  };
  // Compare ST0 with the f64 on the stack: pushes C3|C2|C0 bits.
  const compareBits = () => {
    const b = e.tF64();
    const a = e.tF64();
    c.local_set(b);
    st0();
    c.local_set(a);
    // unordered -> C3|C2|C0; less -> C0; equal -> C3
    c.local_get(a).local_get(a).f64_ne().local_get(b).local_get(b).f64_ne().i32_or();
    c.i32_const(C3 | C2 | C0).i32_mul();
    c.local_get(a).local_get(b).f64_lt().i32_const(C0).i32_mul().i32_or();
    c.local_get(a).local_get(b).f64_eq().i32_const(C3).i32_mul().i32_or();
  };
  const setConditions = () => {
    // bits on stack
    const bits = e.t32();
    c.local_set(bits);
    c.global_get(e.g.fpu_sw).i32_const(~CONDITION_BITS).i32_and().local_get(bits).i32_or().global_set(e.g.fpu_sw);
  };
  // Compare ST0 with the f64 on the stack into EFLAGS (ZF, PF, CF).
  const compareEflags = () => {
    const b = e.tF64();
    const a = e.tF64();
    c.local_set(b);
    st0();
    c.local_set(a);
    c.local_get(a).local_get(a).f64_ne().local_get(b).local_get(b).f64_ne().i32_or();
    c.i32_const(0x45).i32_mul();
    c.local_get(a).local_get(b).f64_lt().i32_or();
    c.local_get(a).local_get(b).f64_eq().i32_const(6).i32_shl().i32_or();
    e.setEflags();
    e.lastFlags = null;
  };
  const arith = (name, a, b) => {
    // a, b are emit thunks pushing f64
    a();
    b();
    switch (name) {
      case "add": c.f64_add(); break;
      case "sub": c.f64_sub(); break;
      case "mul": c.f64_mul(); break;
      case "div": c.f64_div(); break;
      default: throw new Unsupported(name);
    }
  };

  switch (m) {
    case "fld":
      if (isSt(dst)) {
        loadF(dst);
        push();
        return true;
      }
      if (dst.size === 10) {
        e.address(dst);
        const a = e.t64();
        c.local_set(a);
        c.i32_const(FPU.LOAD80).local_get(a).call(e.ctx.imports.fpu);
        return true;
      }
      loadF(dst);
      push();
      return true;
    case "fild":
      loadI(dst);
      push();
      return true;
    case "fld1": c.f64_const(1); push(); return true;
    case "fldz": c.f64_const(0); push(); return true;
    case "fldpi": c.f64_const(Math.PI); push(); return true;
    case "fldl2e": c.f64_const(Math.LOG2E); push(); return true;
    case "fldln2": c.f64_const(Math.LN2); push(); return true;
    case "fldlg2": c.f64_const(Math.log10(2)); push(); return true;
    case "fldl2t": c.f64_const(Math.log2(10)); push(); return true;

    case "fst":
    case "fstp": {
      if (isSt(dst)) {
        st0();
        setSt(dst.reg);
      } else if (dst.size === 10) {
        e.address(dst);
        const a = e.t64();
        c.local_set(a);
        c.i32_const(FPU.STORE80).local_get(a).call(e.ctx.imports.fpu);
      } else {
        const a = e.t32();
        e.address32(dst);
        c.local_set(a);
        c.local_get(a);
        st0();
        if (dst.size === 4) {
          c.f32_demote_f64().f32_store(0, 0);
        } else {
          c.f64_store(0, 0);
        }
      }
      if (m === "fstp") {
        pop();
      }
      return true;
    }
    case "fist":
    case "fistp":
    case "fisttp": {
      const a = e.t32();
      e.address32(dst);
      c.local_set(a);
      st0();
      if (m === "fisttp") {
        c.f64_trunc();
      } else {
        roundByCw();
      }
      storeI(a, dst.size);
      if (m !== "fist") {
        pop();
      }
      return true;
    }

    case "fadd": case "fsub": case "fsubr": case "fmul": case "fdiv": case "fdivr":
    case "faddp": case "fsubp": case "fsubrp": case "fmulp": case "fdivp": case "fdivrp":
    case "fiadd": case "fisub": case "fisubr": case "fimul": case "fidiv": case "fidivr": {
      const popAfter = m.endsWith("p") && !m.startsWith("fi");
      const integer = m.startsWith("fi");
      let base = m.replace(/^fi?/, "").replace(/p$/, "");
      const reversed = base.endsWith("r");
      if (reversed) {
        base = base.slice(0, -1);
      }
      // Operands: (st(i), st(0)) for the register-destination forms,
      // (st(0), st(i)) or (st(0), mem) otherwise.
      let target = 0;
      let other;
      if (ops.length === 2 && isSt(dst) && dst.reg !== 0) {
        target = dst.reg;
        other = () => c.i32_const(0).call(h.fpu_get);
      } else if (ops.length === 2) {
        other = () => loadF(src);
      } else if (isSt(dst)) {
        other = () => loadF(dst);
      } else {
        other = integer ? () => loadI(dst) : () => loadF(dst);
      }
      const self = () => c.i32_const(target).call(h.fpu_get);
      if (reversed) {
        arith(base, other, self);
      } else {
        arith(base, self, other);
      }
      setSt(target);
      if (popAfter) {
        pop();
      }
      return true;
    }
    case "fchs":
      st0();
      c.f64_neg();
      setSt(0);
      return true;
    case "fabs":
      st0();
      c.f64_abs();
      setSt(0);
      return true;
    case "fsqrt":
      st0();
      c.f64_sqrt();
      setSt(0);
      return true;
    case "frndint":
      st0();
      roundByCw();
      setSt(0);
      return true;
    case "fxch": {
      const i = isSt(dst) ? dst.reg : 1;
      const a = e.tF64();
      const b = e.tF64();
      st0();
      c.local_set(a);
      c.i32_const(i).call(h.fpu_get).local_set(b);
      c.i32_const(0).local_get(b).call(h.fpu_set);
      c.i32_const(i).local_get(a).call(h.fpu_set);
      return true;
    }
    case "ffree":
    case "ffreep":
      if (m === "ffreep") {
        pop();
      }
      return true;
    case "fincstp":
      c.global_get(e.g.fpu_top).i32_const(1).i32_add().i32_const(7).i32_and().global_set(e.g.fpu_top);
      return true;
    case "fdecstp":
      c.global_get(e.g.fpu_top).i32_const(1).i32_sub().i32_const(7).i32_and().global_set(e.g.fpu_top);
      return true;
    case "fnop":
      return true;

    case "fcom": case "fcomp": case "fcompp": case "fucom": case "fucomp": case "fucompp":
    case "ficom": case "ficomp": {
      if (m === "fcompp" || m === "fucompp") {
        c.i32_const(1).call(h.fpu_get);
      } else if (ops.length === 0) {
        c.i32_const(1).call(h.fpu_get);
      } else if (m.startsWith("fi")) {
        loadI(dst);
      } else {
        loadF(dst);
      }
      compareBits();
      setConditions();
      if (m.endsWith("pp")) {
        pop();
        pop();
      } else if (m.endsWith("p")) {
        pop();
      }
      return true;
    }
    case "fucomi": case "fucomip": case "fcomi": case "fcomip":
      loadF(src);
      compareEflags();
      if (m.endsWith("p")) {
        pop();
      }
      return true;
    case "ftst":
      c.f64_const(0);
      compareBits();
      setConditions();
      return true;
    case "fxam": {
      // C3 C2 C0: 000 unsupported, 001 NaN, 010 normal, 011 infinity,
      // 100 zero, 101 empty, 110 denormal. C1 is the sign.
      const v = e.tF64();
      const bits = e.t32();
      st0();
      c.local_set(v);
      c.i32_const(0).local_set(bits);
      c.local_get(v).local_get(v).f64_ne().if_(T.empty).i32_const(C0).local_set(bits);
      c.else_().local_get(v).f64_abs().f64_const(Infinity).f64_eq().if_(T.empty).i32_const(C2 | C0).local_set(bits);
      c.else_().local_get(v).f64_const(0).f64_eq().if_(T.empty).i32_const(C3).local_set(bits);
      c.else_().i32_const(C2).local_set(bits).end().end().end();
      c.local_get(v).i64_reinterpret_f64().i64_const(63).i64_shr_u().i32_wrap_i64().i32_const(C1).i32_mul();
      c.local_get(bits).i32_or();
      setConditions();
      return true;
    }
    case "fcmovb": case "fcmove": case "fcmovbe": case "fcmovu":
    case "fcmovnb": case "fcmovne": case "fcmovnbe": case "fcmovnu": {
      // Condition from EFLAGS: b=CF, e=ZF, be=CF|ZF, u=PF
      const cond = { b: 2, e: 4, be: 6, u: 10, nb: 3, ne: 5, nbe: 7, nu: 11 }[m.slice(5)];
      e.condition(cond);
      c.if_(T.empty);
      loadF(src);
      setSt(0);
      c.end();
      return true;
    }

    case "fldcw":
      e.address32(dst);
      c.i32_load16_u(0).global_set(e.g.fpu_cw);
      return true;
    case "fnstcw":
    case "fstcw":
      e.address32(dst);
      c.global_get(e.g.fpu_cw).i32_store16(0);
      return true;
    case "fnstsw":
    case "fstsw": {
      // Status word with TOP folded into bits 11-13.
      const sw = e.t32();
      c.global_get(e.g.fpu_sw).i32_const(~0x3800).i32_and();
      c.global_get(e.g.fpu_top).i32_const(11).i32_shl().i32_or().local_set(sw);
      if (dst.kind === "reg") {
        c.local_get(sw).i64_extend_i32_u();
        e.setReg(REG.rax, 2);
      } else {
        e.address32(dst);
        c.local_get(sw).i32_store16(0);
      }
      return true;
    }
    case "fnclex":
    case "fclex":
      c.global_get(e.g.fpu_sw).i32_const(~0xff).i32_and().global_set(e.g.fpu_sw);
      return true;
    case "fninit":
    case "finit":
      c.i32_const(0x37f).global_set(e.g.fpu_cw);
      c.i32_const(0).global_set(e.g.fpu_sw);
      c.i32_const(0).global_set(e.g.fpu_top);
      return true;
    case "fnstenv":
    case "fstenv": {
      // 28 bytes: cw, sw, tw, fip, fcs/fop, fdp, fds; the fields a
      // program reads back are the control and status words.
      const a = e.t32();
      e.address32(dst);
      c.local_set(a);
      c.local_get(a).i32_const(0).i32_const(28).memory_fill();
      c.local_get(a).global_get(e.g.fpu_cw).i32_store(0, 2);
      c.local_get(a).global_get(e.g.fpu_sw).i32_const(~0x3800).i32_and().global_get(e.g.fpu_top).i32_const(11).i32_shl().i32_or().i32_store(4, 2);
      c.local_get(a).i32_const(0xffff).i32_store(8, 2);
      if (m === "fnstenv") {
        // fnstenv also masks all exceptions.
        c.i32_const(0x3f).global_get(e.g.fpu_cw).i32_or().global_set(e.g.fpu_cw);
      }
      return true;
    }
    case "fldenv": {
      const a = e.t32();
      e.address32(dst);
      c.local_set(a);
      c.local_get(a).i32_load16_u(0).global_set(e.g.fpu_cw);
      c.local_get(a).i32_load16_u(4).i32_const(0x3800).i32_and().i32_const(11).i32_shr_u().global_set(e.g.fpu_top);
      c.local_get(a).i32_load16_u(4).i32_const(~0x3800).i32_and().global_set(e.g.fpu_sw);
      return true;
    }

    case "f2xm1": c.i32_const(FPU.F2XM1).i64_const(0).call(e.ctx.imports.fpu); return true;
    case "fyl2x": c.i32_const(FPU.FYL2X).i64_const(0).call(e.ctx.imports.fpu); return true;
    case "fyl2xp1": c.i32_const(FPU.FYL2XP1).i64_const(0).call(e.ctx.imports.fpu); return true;
    case "fptan": c.i32_const(FPU.FPTAN).i64_const(0).call(e.ctx.imports.fpu); return true;
    case "fpatan": c.i32_const(FPU.FPATAN).i64_const(0).call(e.ctx.imports.fpu); return true;
    case "fsin": c.i32_const(FPU.FSIN).i64_const(0).call(e.ctx.imports.fpu); return true;
    case "fcos": c.i32_const(FPU.FCOS).i64_const(0).call(e.ctx.imports.fpu); return true;
    case "fsincos": c.i32_const(FPU.FSINCOS).i64_const(0).call(e.ctx.imports.fpu); return true;
    case "fscale": c.i32_const(FPU.FSCALE).i64_const(0).call(e.ctx.imports.fpu); return true;
    case "fprem": c.i32_const(FPU.FPREM).i64_const(0).call(e.ctx.imports.fpu); return true;
    case "fprem1": c.i32_const(FPU.FPREM1).i64_const(0).call(e.ctx.imports.fpu); return true;
    case "fxtract": c.i32_const(FPU.FXTRACT).i64_const(0).call(e.ctx.imports.fpu); return true;
    default:
      return false;
  }
}
