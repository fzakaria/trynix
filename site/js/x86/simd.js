// SSE through SSE4.1 on wasm SIMD.
//
// An xmm register is a v128 global. Most packed integer and float
// instructions are one wasm opcode; the rest are shuffles, lane
// replacements or a scalar computed on lane 0 and put back. The
// operand conventions: a "W" operand of 16 bytes is a full v128 load,
// of 8 or 4 bytes a zero-extended one, which is what the scalar
// instructions want.
//
// Where x86 and wasm disagree on the corner cases -- min and max with
// NaN or signed zero, shifts by a count wider than the lane -- the
// x86 result is produced by hand.
import { T } from "./wasm.js";
import { Unsupported } from "./translate.js";
import { REG } from "./decode.js";

// Packed ops that are one wasm opcode applied to (dst, src).
const BINARY = {
  paddb: "i8x16_add", paddw: "i16x8_add", paddd: "i32x4_add", paddq: "i64x2_add",
  psubb: "i8x16_sub", psubw: "i16x8_sub", psubd: "i32x4_sub", psubq: "i64x2_sub",
  paddsb: "i8x16_add_sat_s", paddsw: "i16x8_add_sat_s", paddusb: "i8x16_add_sat_u", paddusw: "i16x8_add_sat_u",
  psubsb: "i8x16_sub_sat_s", psubsw: "i16x8_sub_sat_s", psubusb: "i8x16_sub_sat_u", psubusw: "i16x8_sub_sat_u",
  pmullw: "i16x8_mul", pmulld: "i32x4_mul", pmaddwd: "i32x4_dot_i16x8_s",
  pavgb: "i8x16_avgr_u", pavgw: "i16x8_avgr_u",
  pminub: "i8x16_min_u", pmaxub: "i8x16_max_u", pminsw: "i16x8_min_s", pmaxsw: "i16x8_max_s",
  pminsb: "i8x16_min_s", pmaxsb: "i8x16_max_s", pminuw: "i16x8_min_u", pmaxuw: "i16x8_max_u",
  pminsd: "i32x4_min_s", pmaxsd: "i32x4_max_s", pminud: "i32x4_min_u", pmaxud: "i32x4_max_u",
  pcmpeqb: "i8x16_eq", pcmpeqw: "i16x8_eq", pcmpeqd: "i32x4_eq", pcmpeqq: "i64x2_eq",
  pcmpgtb: "i8x16_gt_s", pcmpgtw: "i16x8_gt_s", pcmpgtd: "i32x4_gt_s", pcmpgtq: "i64x2_gt_s",
  pand: "v128_and", por: "v128_or", pxor: "v128_xor",
  andps: "v128_and", andpd: "v128_and", orps: "v128_or", orpd: "v128_or", xorps: "v128_xor", xorpd: "v128_xor",
  packsswb: "i8x16_narrow_i16x8_s", packuswb: "i8x16_narrow_i16x8_u", packssdw: "i16x8_narrow_i32x4_s", packusdw: "i16x8_narrow_i32x4_u",
  addps: "f32x4_add", addpd: "f64x2_add", subps: "f32x4_sub", subpd: "f64x2_sub",
  mulps: "f32x4_mul", mulpd: "f64x2_mul", divps: "f32x4_div", divpd: "f64x2_div",
};

// Scalar float ops on lane 0 of dst with lane 0 of src.
const SCALAR = {
  addss: ["f32", "f32_add"], addsd: ["f64", "f64_add"],
  subss: ["f32", "f32_sub"], subsd: ["f64", "f64_sub"],
  mulss: ["f32", "f32_mul"], mulsd: ["f64", "f64_mul"],
  divss: ["f32", "f32_div"], divsd: ["f64", "f64_div"],
};

const UNARY = {
  pabsb: "i8x16_abs", pabsw: "i16x8_abs", pabsd: "i32x4_abs",
  sqrtps: "f32x4_sqrt", sqrtpd: "f64x2_sqrt",
  cvtdq2ps: "f32x4_convert_i32x4_s", cvtdq2pd: "f64x2_convert_low_i32x4_s",
  cvtps2pd: "f64x2_promote_low_f32x4", cvtpd2ps: "f32x4_demote_f64x2_zero",
};

// Lane shuffles: the byte index list for i8x16.shuffle(dst, src).
function interleave(width, high) {
  const lanes = [];
  const n = 16 / width;
  const start = high ? n / 2 : 0;
  for (let i = 0; i < n / 2; i++) {
    for (let b = 0; b < width; b++) {
      lanes.push((start + i) * width + b);
    }
    for (let b = 0; b < width; b++) {
      lanes.push(16 + (start + i) * width + b);
    }
  }
  return lanes;
}

const UNPACK = {
  punpcklbw: interleave(1, false), punpckhbw: interleave(1, true),
  punpcklwd: interleave(2, false), punpckhwd: interleave(2, true),
  punpckldq: interleave(4, false), punpckhdq: interleave(4, true),
  punpcklqdq: interleave(8, false), punpckhqdq: interleave(8, true),
  unpcklps: interleave(4, false), unpckhps: interleave(4, true),
  unpcklpd: interleave(8, false), unpckhpd: interleave(8, true),
};

function lanesOf(width, picks) {
  // picks: list of (operand, laneIndex) where operand 0 = first, 1 = second
  const out = [];
  for (const [op, lane] of picks) {
    for (let b = 0; b < width; b++) {
      out.push(op * 16 + lane * width + b);
    }
  }
  return out;
}

const ZERO16 = new Uint8Array(16);

export function emitSimd(e, insn, ops) {
  const c = e.c;
  const m = insn.mnemonic;

  const isXmm = (op) => op && op.kind === "xmm";
  const isMem = (op) => op && op.kind === "mem";

  // Pushes a v128 for an xmm or memory operand of the given size.
  const loadV = (op, size = 16) => {
    if (isXmm(op)) {
      c.global_get(e.g[`xmm${op.reg}`]);
      return;
    }
    if (!isMem(op)) {
      throw new Unsupported(`vector operand ${op.kind}`);
    }
    e.address32(op);
    switch (size) {
      case 16: c.v128_load(0, 0); break;
      case 8: c.v128_load64_zero(0); break;
      case 4: c.v128_load32_zero(0); break;
      case 2: c.i64_load16_u(0); c.i64x2_splat(); break;
      default: throw new Unsupported(`vector load of ${size}`);
    }
  };

  // Stores the v128 on the stack to an xmm or memory operand.
  const storeV = (op, size = 16) => {
    if (isXmm(op)) {
      c.global_set(e.g[`xmm${op.reg}`]);
      return;
    }
    const v = e.t128();
    c.local_set(v);
    e.address32(op);
    c.local_get(v);
    switch (size) {
      case 16: c.v128_store(0, 0); break;
      case 8: c.v128_store64_lane(0, 0); break;
      case 4: c.v128_store32_lane(0, 0); break;
      default: throw new Unsupported(`vector store of ${size}`);
    }
  };

  const dst = ops[0];
  const src = ops[1];
  const imm = ops.length > 2 && ops[2].kind === "imm" ? Number(ops[2].value) : ops.length > 1 && ops[1].kind === "imm" ? Number(ops[1].value) : null;

  // ---- moves ----
  switch (m) {
    case "movaps": case "movups": case "movapd": case "movupd": case "movdqa": case "movdqu":
    case "movntdq": case "movntps": case "movntpd": case "lddqu": case "movntdqa":
      loadV(src, 16);
      storeV(dst, 16);
      return true;
    case "movq":
      if (isXmm(dst) && src.kind === "reg") {
        // movq xmm, r64
        e.load(src, 8);
        c.i64x2_splat();
        c.v128_const(ZERO16);
        c.i8x16_shuffle(lanesOf(8, [[0, 0], [1, 0]]));
        storeV(dst);
        return true;
      }
      if (dst.kind === "reg" && isXmm(src)) {
        loadV(src);
        c.i64x2_extract_lane(0);
        e.setReg(dst.reg, 8);
        return true;
      }
      if (isXmm(dst)) {
        // movq xmm, xmm/m64: low qword, upper zeroed
        loadV(src, 8);
        if (isXmm(src)) {
          c.v128_const(ZERO16);
          c.i8x16_shuffle(lanesOf(8, [[0, 0], [1, 0]]));
        }
        storeV(dst);
        return true;
      }
      // movq m64, xmm
      loadV(src);
      storeV(dst, 8);
      return true;
    case "movd":
      if (isXmm(dst)) {
        c.v128_const(ZERO16);
        e.load(src, 4);
        c.i32_wrap_i64();
        c.i32x4_replace_lane(0);
        storeV(dst);
        return true;
      }
      loadV(src);
      c.i32x4_extract_lane(0);
      c.i64_extend_i32_u();
      if (dst.kind === "reg") {
        e.setReg(dst.reg, 4);
      } else {
        const a = e.prepareDest(dst);
        e.store(dst, 4, a);
      }
      return true;
    case "movss":
      if (isXmm(dst) && isXmm(src)) {
        loadV(dst);
        loadV(src);
        c.i8x16_shuffle(lanesOf(4, [[1, 0], [0, 1], [0, 2], [0, 3]]));
        storeV(dst);
      } else if (isXmm(dst)) {
        loadV(src, 4);
        storeV(dst);
      } else {
        loadV(src);
        storeV(dst, 4);
      }
      return true;
    case "movsd":
      if (isXmm(dst) && isXmm(src)) {
        loadV(dst);
        loadV(src);
        c.i8x16_shuffle(lanesOf(8, [[1, 0], [0, 1]]));
        storeV(dst);
      } else if (isXmm(dst)) {
        loadV(src, 8);
        storeV(dst);
      } else {
        loadV(src);
        storeV(dst, 8);
      }
      return true;
    case "movlps": case "movlpd":
      if (isXmm(dst)) {
        e.address32(src);
        loadV(dst);
        c.v128_load64_lane(0, 0);
        storeV(dst);
      } else {
        loadV(src);
        storeV(dst, 8);
      }
      return true;
    case "movhps": case "movhpd":
      if (isXmm(dst)) {
        e.address32(src);
        loadV(dst);
        c.v128_load64_lane(1, 0);
        storeV(dst);
      } else {
        const v = e.t128();
        loadV(src);
        c.local_set(v);
        e.address32(dst);
        c.local_get(v);
        c.v128_store64_lane(1, 0);
      }
      return true;
    case "movhlps":
      loadV(dst);
      loadV(src);
      c.i8x16_shuffle(lanesOf(8, [[1, 1], [0, 1]]));
      storeV(dst);
      return true;
    case "movlhps":
      loadV(dst);
      loadV(src);
      c.i8x16_shuffle(lanesOf(8, [[0, 0], [1, 0]]));
      storeV(dst);
      return true;
    case "movddup": {
      const v = e.t128();
      loadV(src, 8);
      c.local_tee(v).local_get(v);
      c.i8x16_shuffle(lanesOf(8, [[0, 0], [0, 0]]));
      storeV(dst);
      return true;
    }
    case "movsldup": {
      const v = e.t128();
      loadV(src);
      c.local_tee(v).local_get(v);
      c.i8x16_shuffle(lanesOf(4, [[0, 0], [0, 0], [0, 2], [0, 2]]));
      storeV(dst);
      return true;
    }
    case "movshdup": {
      const v = e.t128();
      loadV(src);
      c.local_tee(v).local_get(v);
      c.i8x16_shuffle(lanesOf(4, [[0, 1], [0, 1], [0, 3], [0, 3]]));
      storeV(dst);
      return true;
    }
    case "pmovmskb":
      loadV(src);
      c.i8x16_bitmask();
      c.i64_extend_i32_u();
      e.setReg(dst.reg, 4);
      return true;
    case "movmskps":
      loadV(src);
      c.i32x4_bitmask();
      c.i64_extend_i32_u();
      e.setReg(dst.reg, 4);
      return true;
    case "movmskpd":
      loadV(src);
      c.i64x2_bitmask();
      c.i64_extend_i32_u();
      e.setReg(dst.reg, 4);
      return true;
    case "stmxcsr": {
      const a = e.prepareDest(dst);
      c.global_get(e.g.mxcsr).i64_extend_i32_u();
      e.store(dst, 4, a);
      return true;
    }
    case "ldmxcsr":
      e.load(dst, 4);
      c.i32_wrap_i64().global_set(e.g.mxcsr);
      return true;
    case "fxsave":
    case "fxsave64": {
      // The SSE half of the 512-byte area: mxcsr at 24, xmm0-15 at 160.
      // Header: fcw, fsw, an empty tag word, zeros for the pointers,
      // mxcsr and its mask; the x87 registers as zeros; then xmm0-15.
      const a = e.t32();
      e.address32(dst);
      c.local_set(a);
      c.local_get(a).i32_const(0).i32_const(160).memory_fill();
      c.local_get(a).global_get(e.g.fpu_cw).i32_store16(0);
      c.local_get(a).global_get(e.g.fpu_sw).i32_store16(2);
      c.local_get(a).global_get(e.g.mxcsr).i32_store(24, 2);
      c.local_get(a).i32_const(0x2ffff).i32_store(28, 2);
      for (let i = 0; i < 16; i++) {
        c.local_get(a).global_get(e.g[`xmm${i}`]).v128_store(160 + 16 * i, 0);
      }
      return true;
    }
    case "fxrstor":
    case "fxrstor64": {
      const a = e.t32();
      e.address32(dst);
      c.local_set(a);
      c.local_get(a).i32_load16_u(0).global_set(e.g.fpu_cw);
      c.local_get(a).i32_load16_u(2).global_set(e.g.fpu_sw);
      c.local_get(a).i32_load(24, 2).global_set(e.g.mxcsr);
      for (let i = 0; i < 16; i++) {
        c.local_get(a).v128_load(160 + 16 * i, 0).global_set(e.g[`xmm${i}`]);
      }
      return true;
    }
    case "emms":
      return true;
    default:
      break;
  }

  // ---- one-opcode packed ops ----
  if (BINARY[m] !== undefined) {
    loadV(dst);
    loadV(src);
    c[BINARY[m]]();
    storeV(dst);
    return true;
  }
  if (UNARY[m] !== undefined) {
    loadV(src, m === "cvtdq2pd" || m === "cvtps2pd" ? 8 : 16);
    c[UNARY[m]]();
    storeV(dst);
    return true;
  }
  if (UNPACK[m] !== undefined) {
    loadV(dst);
    loadV(src, m.startsWith("unpck") || m.endsWith("qdq") || m.endsWith("hbw") || m.endsWith("hwd") || m.endsWith("hdq") ? 16 : 8);
    c.i8x16_shuffle(UNPACK[m]);
    storeV(dst);
    return true;
  }
  if (SCALAR[m] !== undefined) {
    const [ty, op] = SCALAR[m];
    const width = ty === "f32" ? 4 : 8;
    loadV(dst);
    loadV(dst);
    ty === "f32" ? c.f32x4_extract_lane(0) : c.f64x2_extract_lane(0);
    loadV(src, width);
    ty === "f32" ? c.f32x4_extract_lane(0) : c.f64x2_extract_lane(0);
    c[op]();
    ty === "f32" ? c.f32x4_replace_lane(0) : c.f64x2_replace_lane(0);
    storeV(dst);
    return true;
  }

  switch (m) {
    case "pandn":
    case "andnps":
    case "andnpd":
      // dst = ~dst & src
      loadV(src);
      loadV(dst);
      c.v128_andnot();
      storeV(dst);
      return true;

    case "pshufd": {
      loadV(src);
      loadV(src);
      const picks = [];
      for (let i = 0; i < 4; i++) {
        picks.push([0, (imm >> (2 * i)) & 3]);
      }
      c.i8x16_shuffle(lanesOf(4, picks));
      storeV(dst);
      return true;
    }
    case "pshuflw":
    case "pshufhw": {
      loadV(src);
      loadV(src);
      const picks = [];
      const base = m === "pshuflw" ? 0 : 4;
      for (let i = 0; i < 8; i++) {
        if (i >= base && i < base + 4) {
          picks.push([0, base + ((imm >> (2 * (i - base))) & 3)]);
        } else {
          picks.push([0, i]);
        }
      }
      c.i8x16_shuffle(lanesOf(2, picks));
      storeV(dst);
      return true;
    }
    case "shufps": {
      loadV(dst);
      loadV(src);
      c.i8x16_shuffle(lanesOf(4, [[0, imm & 3], [0, (imm >> 2) & 3], [1, (imm >> 4) & 3], [1, (imm >> 6) & 3]]));
      storeV(dst);
      return true;
    }
    case "shufpd": {
      loadV(dst);
      loadV(src);
      c.i8x16_shuffle(lanesOf(8, [[0, imm & 1], [1, (imm >> 1) & 1]]));
      storeV(dst);
      return true;
    }
    case "pslldq": {
      const lanes = [];
      for (let i = 0; i < 16; i++) {
        lanes.push(i >= imm ? i - imm : 16);
      }
      loadV(dst);
      c.v128_const(ZERO16);
      c.i8x16_shuffle(lanes);
      storeV(dst);
      return true;
    }
    case "psrldq": {
      const lanes = [];
      for (let i = 0; i < 16; i++) {
        lanes.push(i + imm < 16 ? i + imm : 16);
      }
      loadV(dst);
      c.v128_const(ZERO16);
      c.i8x16_shuffle(lanes);
      storeV(dst);
      return true;
    }
    case "palignr": {
      // Bytes imm.. of the 32-byte value dst:src (src low). Past 16 the
      // low half is gone and zeros shift in from above dst.
      const lanes = [];
      if (imm >= 32) {
        c.v128_const(ZERO16);
      } else if (imm >= 16) {
        for (let i = 0; i < 16; i++) {
          const k = i + imm - 16;
          lanes.push(k < 16 ? k : 16);
        }
        loadV(dst);
        c.v128_const(ZERO16);
        c.i8x16_shuffle(lanes);
      } else {
        for (let i = 0; i < 16; i++) {
          lanes.push(i + imm);
        }
        loadV(src);
        loadV(dst);
        c.i8x16_shuffle(lanes);
      }
      storeV(dst);
      return true;
    }
    case "pshufb": {
      // A set high bit selects zero; wasm's swizzle zeroes any index >= 16.
      const mask = new Uint8Array(16).fill(0x8f);
      loadV(dst);
      loadV(src);
      c.v128_const(mask);
      c.v128_and();
      c.i8x16_swizzle();
      storeV(dst);
      return true;
    }

    case "psllw": case "pslld": case "psllq":
    case "psrlw": case "psrld": case "psrlq":
    case "psraw": case "psrad": {
      const width = m.endsWith("w") ? 16 : m.endsWith("d") ? 32 : 64;
      const kind = m.startsWith("psll") ? "shl" : m.startsWith("psrl") ? "shr_u" : "shr_s";
      const lane = width === 16 ? "i16x8" : width === 32 ? "i32x4" : "i64x2";
      const count = e.t32();
      if (src.kind === "imm") {
        c.i32_const(Number(src.value)).local_set(count);
      } else {
        // The count is the low quadword; anything past the lane width
        // clamps to it.
        const cnt64 = e.t64();
        loadV(src, 8);
        c.i64x2_extract_lane(0);
        c.local_tee(cnt64).i64_const(BigInt(width)).i64_gt_u().if_(T.i32).i32_const(width).else_().local_get(cnt64).i32_wrap_i64().end().local_set(count);
      }
      // wasm masks the count to the lane width; x86 gives zero (or the
      // sign) for a count at or past it.
      const wide = e.t32();
      c.local_get(count).i32_const(width).i32_ge_u().local_set(wide);
      loadV(dst);
      c.local_get(wide).if_(T.i32).i32_const(kind === "shr_s" ? width - 1 : 0).else_().local_get(count).end();
      c[`${lane}_${kind}`]();
      if (kind !== "shr_s") {
        const shifted = e.t128();
        c.local_set(shifted);
        c.local_get(wide).if_(T.v128).v128_const(ZERO16).else_().local_get(shifted).end();
      }
      storeV(dst);
      return true;
    }

    case "pinsrw": {
      loadV(dst);
      e.load(src, 2);
      c.i32_wrap_i64();
      c.i16x8_replace_lane(imm & 7);
      storeV(dst);
      return true;
    }
    case "pextrw": {
      loadV(src);
      c.i16x8_extract_lane_u(imm & 7);
      c.i64_extend_i32_u();
      if (dst.kind === "reg") {
        e.setReg(dst.reg, 4);
      } else {
        const a = e.prepareDest(dst);
        e.store(dst, 2, a);
      }
      return true;
    }
    case "pinsrb": {
      loadV(dst);
      e.load(src, 1);
      c.i32_wrap_i64();
      c.i8x16_replace_lane(imm & 15);
      storeV(dst);
      return true;
    }
    case "pinsrd": {
      loadV(dst);
      e.load(src, 4);
      c.i32_wrap_i64();
      c.i32x4_replace_lane(imm & 3);
      storeV(dst);
      return true;
    }
    case "pinsrq": {
      loadV(dst);
      e.load(src, 8);
      c.i64x2_replace_lane(imm & 1);
      storeV(dst);
      return true;
    }
    case "pextrb": {
      loadV(src);
      c.i8x16_extract_lane_u(imm & 15);
      c.i64_extend_i32_u();
      if (dst.kind === "reg") {
        e.setReg(dst.reg, 4);
      } else {
        const a = e.prepareDest(dst);
        e.store(dst, 1, a);
      }
      return true;
    }
    case "pextrd": {
      loadV(src);
      c.i32x4_extract_lane(imm & 3);
      c.i64_extend_i32_u();
      if (dst.kind === "reg") {
        e.setReg(dst.reg, 4);
      } else {
        const a = e.prepareDest(dst);
        e.store(dst, 4, a);
      }
      return true;
    }
    case "pextrq": {
      loadV(src);
      c.i64x2_extract_lane(imm & 1);
      if (dst.kind === "reg") {
        e.setReg(dst.reg, 8);
      } else {
        const a = e.prepareDest(dst);
        e.store(dst, 8, a);
      }
      return true;
    }

    case "pmovzxbw": case "pmovsxbw": case "pmovzxbd": case "pmovsxbd": case "pmovzxbq": case "pmovsxbq":
    case "pmovzxwd": case "pmovsxwd": case "pmovzxwq": case "pmovsxwq": case "pmovzxdq": case "pmovsxdq": {
      const s = m[4] === "z" ? "u" : "s";
      const from = m[6];
      const to = m[7];
      const srcSize = { bw: 8, bd: 4, bq: 2, wd: 8, wq: 4, dq: 8 }[from + to];
      loadV(src, srcSize);
      const steps = { bw: ["i16x8_extend_low_i8x16"], bd: ["i16x8_extend_low_i8x16", "i32x4_extend_low_i16x8"],
        bq: ["i16x8_extend_low_i8x16", "i32x4_extend_low_i16x8", "i64x2_extend_low_i32x4"],
        wd: ["i32x4_extend_low_i16x8"], wq: ["i32x4_extend_low_i16x8", "i64x2_extend_low_i32x4"],
        dq: ["i64x2_extend_low_i32x4"] }[from + to];
      for (const step of steps) {
        c[`${step}_${s}`]();
      }
      storeV(dst);
      return true;
    }

    case "pmuludq":
    case "pmuldq": {
      // Even dword lanes to the low positions, then a widening multiply.
      const gather = lanesOf(4, [[0, 0], [0, 2], [0, 0], [0, 2]]);
      loadV(dst);
      loadV(dst);
      c.i8x16_shuffle(gather);
      loadV(src);
      loadV(src);
      c.i8x16_shuffle(gather);
      if (m === "pmuludq") {
        c.i64x2_extmul_low_i32x4_u();
      } else {
        c.i64x2_extmul_low_i32x4_s();
      }
      storeV(dst);
      return true;
    }
    case "pmulhw":
    case "pmulhuw": {
      const lo = e.t128();
      const hi = e.t128();
      const s = m === "pmulhw" ? "s" : "u";
      loadV(dst);
      loadV(src);
      c[`i32x4_extmul_low_i16x8_${s}`]();
      c.i32_const(16);
      c[`i32x4_shr_${s}`]();
      c.local_set(lo);
      loadV(dst);
      loadV(src);
      c[`i32x4_extmul_high_i16x8_${s}`]();
      c.i32_const(16);
      c[`i32x4_shr_${s}`]();
      c.local_set(hi);
      c.local_get(lo).local_get(hi);
      if (s === "s") {
        c.i16x8_narrow_i32x4_s();
      } else {
        c.i16x8_narrow_i32x4_u();
      }
      storeV(dst);
      return true;
    }
    case "psadbw": {
      const d = e.t128();
      loadV(dst);
      loadV(src);
      c.i8x16_max_u();
      loadV(dst);
      loadV(src);
      c.i8x16_min_u();
      c.i8x16_sub();
      c.i16x8_extadd_pairwise_i8x16_u();
      c.i32x4_extadd_pairwise_i16x8_u();
      c.local_tee(d);
      c.local_get(d).local_get(d);
      c.i8x16_shuffle(lanesOf(4, [[0, 1], [0, 0], [0, 3], [0, 2]]));
      c.i32x4_add();
      c.v128_const(ZERO16);
      c.i8x16_shuffle([0, 1, 2, 3, 16, 16, 16, 16, 8, 9, 10, 11, 16, 16, 16, 16]);
      storeV(dst);
      return true;
    }

    case "ptest": {
      const zf = e.t32();
      loadV(dst);
      loadV(src);
      c.v128_and().v128_any_true().i32_eqz().i32_const(6).i32_shl().local_set(zf);
      loadV(dst);
      loadV(src);
      c.v128_andnot().v128_any_true().i32_eqz();
      c.local_get(zf).i32_or();
      e.setEflags();
      e.lastFlags = null;
      return true;
    }

    case "pblendvb": case "blendvps": case "blendvpd": {
      const shift = m === "pblendvb" ? ["i8x16_shr_s", 7] : m === "blendvps" ? ["i32x4_shr_s", 31] : ["i64x2_shr_s", 63];
      loadV(src);
      loadV(dst);
      c.global_get(e.g.xmm0);
      c.i32_const(shift[1]);
      c[shift[0]]();
      c.v128_bitselect();
      storeV(dst);
      return true;
    }
    case "pblendw": case "blendps": case "blendpd": {
      const width = m === "pblendw" ? 2 : m === "blendps" ? 4 : 8;
      const mask = new Uint8Array(16);
      for (let i = 0; i < 16 / width; i++) {
        if (imm & (1 << i)) {
          mask.fill(0xff, i * width, (i + 1) * width);
        }
      }
      loadV(src);
      loadV(dst);
      c.v128_const(mask);
      c.v128_bitselect();
      storeV(dst);
      return true;
    }

    case "minps": case "maxps": case "minpd": case "maxpd": {
      // x86 returns the second operand when either is NaN or both are
      // zero, which is wasm's pmin/pmax with the operands swapped.
      loadV(src);
      loadV(dst);
      c[{ minps: "f32x4_pmin", maxps: "f32x4_pmax", minpd: "f64x2_pmin", maxpd: "f64x2_pmax" }[m]]();
      storeV(dst);
      return true;
    }
    case "minss": case "maxss": case "minsd": case "maxsd": {
      const f32 = m.endsWith("ss");
      const a = f32 ? e.tF32() : e.tF64();
      const b = f32 ? e.tF32() : e.tF64();
      loadV(dst);
      f32 ? c.f32x4_extract_lane(0) : c.f64x2_extract_lane(0);
      c.local_set(a);
      loadV(src, f32 ? 4 : 8);
      f32 ? c.f32x4_extract_lane(0) : c.f64x2_extract_lane(0);
      c.local_set(b);
      loadV(dst);
      // a < b ? a : b for min; a > b ? a : b for max
      c.local_get(a).local_get(b).local_get(a).local_get(b);
      if (m.startsWith("min")) {
        f32 ? c.f32_lt() : c.f64_lt();
      } else {
        f32 ? c.f32_gt() : c.f64_gt();
      }
      c.select();
      f32 ? c.f32x4_replace_lane(0) : c.f64x2_replace_lane(0);
      storeV(dst);
      return true;
    }
    case "sqrtss": case "sqrtsd": case "rcpss": case "rsqrtss": {
      const f32 = m.endsWith("ss");
      loadV(dst);
      loadV(src, f32 ? 4 : 8);
      f32 ? c.f32x4_extract_lane(0) : c.f64x2_extract_lane(0);
      if (m === "rcpss") {
        const t = e.tF32();
        c.local_set(t).f32_const(1).local_get(t).f32_div();
      } else if (m === "rsqrtss") {
        const t = e.tF32();
        c.f32_sqrt().local_set(t).f32_const(1).local_get(t).f32_div();
      } else {
        f32 ? c.f32_sqrt() : c.f64_sqrt();
      }
      f32 ? c.f32x4_replace_lane(0) : c.f64x2_replace_lane(0);
      storeV(dst);
      return true;
    }
    case "rcpps": {
      loadV(src);
      const t = e.t128();
      c.local_set(t);
      c.f32_const(1).f32x4_splat().local_get(t).f32x4_div();
      storeV(dst);
      return true;
    }
    case "rsqrtps": {
      loadV(src);
      const t = e.t128();
      c.f32x4_sqrt().local_set(t);
      c.f32_const(1).f32x4_splat().local_get(t).f32x4_div();
      storeV(dst);
      return true;
    }

    case "comiss": case "comisd": case "ucomiss": case "ucomisd": {
      const f32 = m.endsWith("ss");
      const a = f32 ? e.tF32() : e.tF64();
      const b = f32 ? e.tF32() : e.tF64();
      loadV(dst);
      f32 ? c.f32x4_extract_lane(0) : c.f64x2_extract_lane(0);
      c.local_set(a);
      loadV(src, f32 ? 4 : 8);
      f32 ? c.f32x4_extract_lane(0) : c.f64x2_extract_lane(0);
      c.local_set(b);
      const cmp = (op) => {
        c.local_get(a).local_get(b);
        c[`${f32 ? "f32" : "f64"}_${op}`]();
      };
      // unordered: ZF PF CF all set; less: CF; equal: ZF
      const un = e.t32();
      c.local_get(a).local_get(a);
      f32 ? c.f32_ne() : c.f64_ne();
      c.local_get(b).local_get(b);
      f32 ? c.f32_ne() : c.f64_ne();
      c.i32_or().local_set(un);
      c.local_get(un).i32_const(0x45).i32_mul();
      cmp("lt");
      c.i32_or();
      cmp("eq");
      c.i32_const(6).i32_shl().i32_or();
      e.setEflags();
      e.lastFlags = null;
      return true;
    }

    case "cmpss": case "cmpsd": case "cmpps": case "cmppd": {
      const f32 = m.endsWith("ss") || m.endsWith("ps");
      const packed = m.endsWith("ps") || m.endsWith("pd");
      const pred = imm & 7;
      if (packed) {
        const lane = f32 ? "f32x4" : "f64x2";
        const emitCmp = (p) => {
          switch (p) {
            case 0: c[`${lane}_eq`](); break;
            case 1: c[`${lane}_lt`](); break;
            case 2: c[`${lane}_le`](); break;
            case 4: c[`${lane}_ne`](); break;
            case 5: c[`${lane}_lt`](); c.v128_not(); break;
            case 6: c[`${lane}_le`](); c.v128_not(); break;
            default: throw new Unsupported(`cmp predicate ${p}`);
          }
        };
        if (pred === 3 || pred === 7) {
          // unord: a != a | b != b ; ord: the complement
          const t = e.t128();
          loadV(dst);
          loadV(dst);
          c[`${lane}_ne`]();
          loadV(src);
          loadV(src);
          c[`${lane}_ne`]();
          c.v128_or();
          if (pred === 7) {
            c.v128_not();
          }
          storeV(dst);
          return true;
        }
        loadV(dst);
        loadV(src);
        emitCmp(pred);
        storeV(dst);
        return true;
      }
      const a = f32 ? e.tF32() : e.tF64();
      const b = f32 ? e.tF32() : e.tF64();
      const ty = f32 ? "f32" : "f64";
      loadV(dst);
      f32 ? c.f32x4_extract_lane(0) : c.f64x2_extract_lane(0);
      c.local_set(a);
      loadV(src, f32 ? 4 : 8);
      f32 ? c.f32x4_extract_lane(0) : c.f64x2_extract_lane(0);
      c.local_set(b);
      loadV(dst);
      const unordered = () => {
        c.local_get(a).local_get(a);
        c[`${ty}_ne`]();
        c.local_get(b).local_get(b);
        c[`${ty}_ne`]();
        c.i32_or();
      };
      switch (pred) {
        case 0: c.local_get(a).local_get(b); c[`${ty}_eq`](); break;
        case 1: c.local_get(a).local_get(b); c[`${ty}_lt`](); break;
        case 2: c.local_get(a).local_get(b); c[`${ty}_le`](); break;
        case 3: unordered(); break;
        case 4: c.local_get(a).local_get(b); c[`${ty}_ne`](); break;
        case 5: c.local_get(a).local_get(b); c[`${ty}_lt`](); c.i32_eqz(); break;
        case 6: c.local_get(a).local_get(b); c[`${ty}_le`](); c.i32_eqz(); break;
        case 7: unordered(); c.i32_eqz(); break;
        default: throw new Unsupported(`cmp predicate ${pred}`);
      }
      // true -> all ones in the lane
      if (f32) {
        c.i32_const(-1).i32_mul().f32_reinterpret_i32().f32x4_replace_lane(0);
      } else {
        c.i64_extend_i32_u().i64_const(-1n).i64_mul().f64_reinterpret_i64().f64x2_replace_lane(0);
      }
      storeV(dst);
      return true;
    }

    case "cvtsi2ss": case "cvtsi2sd": {
      const f32 = m.endsWith("ss");
      loadV(dst);
      e.load(src, src.size);
      if (src.size === 4) {
        c.i32_wrap_i64();
        f32 ? c.f32_convert_i32_s() : c.f64_convert_i32_s();
      } else {
        f32 ? c.f32_convert_i64_s() : c.f64_convert_i64_s();
      }
      f32 ? c.f32x4_replace_lane(0) : c.f64x2_replace_lane(0);
      storeV(dst);
      return true;
    }
    case "cvttss2si": case "cvttsd2si": case "cvtss2si": case "cvtsd2si": {
      // Saturation matches the hardware below the range; above it, and
      // for NaN, the hardware returns the "integer indefinite", the
      // minimum value.
      const f32 = m.includes("ss");
      const truncate = m.startsWith("cvtt");
      const x = f32 ? e.tF32() : e.tF64();
      loadV(src, f32 ? 4 : 8);
      f32 ? c.f32x4_extract_lane(0) : c.f64x2_extract_lane(0);
      if (!truncate) {
        f32 ? c.f32_nearest() : c.f64_nearest();
      }
      c.local_set(x);
      const limit = dst.size === 4 ? 2147483648 : 9223372036854775808;
      const indefinite = dst.size === 4 ? 0x80000000n : 0x8000000000000000n;
      c.local_get(x);
      if (dst.size === 4) {
        f32 ? c.i32_trunc_sat_f32_s() : c.i32_trunc_sat_f64_s();
        c.i64_extend_i32_u();
      } else {
        f32 ? c.i64_trunc_sat_f32_s() : c.i64_trunc_sat_f64_s();
      }
      c.i64_const(indefinite);
      // select the indefinite when x != x or x >= limit
      c.local_get(x).local_get(x);
      f32 ? c.f32_ne() : c.f64_ne();
      c.local_get(x);
      f32 ? c.f32_const(limit).f32_ge() : c.f64_const(limit).f64_ge();
      c.i32_or();
      c.i32_eqz();
      c.select();
      e.setReg(dst.reg, dst.size);
      return true;
    }
    case "cvtss2sd":
      loadV(dst);
      loadV(src, 4);
      c.f32x4_extract_lane(0).f64_promote_f32().f64x2_replace_lane(0);
      storeV(dst);
      return true;
    case "cvtsd2ss":
      loadV(dst);
      loadV(src, 8);
      c.f64x2_extract_lane(0).f32_demote_f64().f32x4_replace_lane(0);
      storeV(dst);
      return true;
    case "cvtps2dq":
    case "cvttps2dq": {
      // Lanes that are NaN or at or above 2^31 get the integer
      // indefinite, as the scalar forms do.
      const x = e.t128();
      const limit = new Uint8Array(16);
      new DataView(limit.buffer).setFloat32(0, 2147483648, true);
      for (let i = 4; i < 16; i += 4) {
        limit.set(limit.subarray(0, 4), i);
      }
      const indefinite = new Uint8Array(16);
      for (let i = 0; i < 16; i += 4) {
        indefinite[i + 3] = 0x80;
      }
      loadV(src);
      if (m === "cvtps2dq") {
        c.f32x4_nearest();
      }
      c.local_set(x);
      c.v128_const(indefinite);
      c.local_get(x).i32x4_trunc_sat_f32x4_s();
      c.local_get(x).local_get(x).f32x4_ne();
      c.local_get(x).v128_const(limit).f32x4_ge();
      c.v128_or();
      c.v128_bitselect();
      storeV(dst);
      return true;
    }
    case "cvtpd2dq":
    case "cvttpd2dq": {
      const x = e.t128();
      const limit = new Uint8Array(16);
      new DataView(limit.buffer).setFloat64(0, 2147483648, true);
      limit.set(limit.subarray(0, 8), 8);
      const indefinite = new Uint8Array(16);
      indefinite[3] = 0x80;
      indefinite[7] = 0x80;
      loadV(src);
      if (m === "cvtpd2dq") {
        c.f64x2_nearest();
      }
      c.local_set(x);
      c.v128_const(indefinite);
      c.local_get(x).i32x4_trunc_sat_f64x2_s_zero();
      // The two-lane mask, narrowed to the low two i32 lanes.
      c.local_get(x).local_get(x).f64x2_ne();
      c.local_get(x).v128_const(limit).f64x2_ge();
      c.v128_or();
      c.v128_const(ZERO16);
      c.i8x16_shuffle([0, 1, 2, 3, 8, 9, 10, 11, 16, 16, 16, 16, 16, 16, 16, 16]);
      c.v128_bitselect();
      storeV(dst);
      return true;
    }

    case "roundss": case "roundsd": {
      const f32 = m.endsWith("ss");
      const mode = imm & 4 ? 0 : imm & 3;
      loadV(dst);
      loadV(src, f32 ? 4 : 8);
      f32 ? c.f32x4_extract_lane(0) : c.f64x2_extract_lane(0);
      const ops32 = ["f32_nearest", "f32_floor", "f32_ceil", "f32_trunc"];
      const ops64 = ["f64_nearest", "f64_floor", "f64_ceil", "f64_trunc"];
      c[(f32 ? ops32 : ops64)[mode]]();
      f32 ? c.f32x4_replace_lane(0) : c.f64x2_replace_lane(0);
      storeV(dst);
      return true;
    }
    case "roundps": case "roundpd": {
      const f32 = m.endsWith("ps");
      const mode = imm & 4 ? 0 : imm & 3;
      loadV(src);
      const ops32 = ["f32x4_nearest", "f32x4_floor", "f32x4_ceil", "f32x4_trunc"];
      const ops64 = ["f64x2_nearest", "f64x2_floor", "f64x2_ceil", "f64x2_trunc"];
      c[(f32 ? ops32 : ops64)[mode]]();
      storeV(dst);
      return true;
    }
    case "movnti": {
      const a = e.prepareDest(dst);
      e.load(src, src.size);
      e.store(dst, src.size, a);
      return true;
    }
    default:
      return false;
  }
}
