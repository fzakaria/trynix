// A WebAssembly binary encoder.
//
// The translator emits guest code as wasm bytes directly, so there is no
// toolchain between an x86 instruction and the function that runs it.
// ModuleBuilder assembles the sections; Code is a byte buffer with one
// method per opcode, plus the local declarations the function needs.
//
// The subset encoded here is what the translator uses: MVP plus tail
// calls, sign extension, bulk memory, SIMD and the saturating truncations.
// Anything else is a one-line addition.

// Value types, by their binary encoding.
export const T = Object.freeze({
  i32: 0x7f,
  i64: 0x7e,
  f32: 0x7d,
  f64: 0x7c,
  v128: 0x7b,
  funcref: 0x70,
  // The block type for "no result".
  empty: 0x40,
});

const SECTION = Object.freeze({
  type: 1,
  import: 2,
  function: 3,
  table: 4,
  memory: 5,
  global: 6,
  export: 7,
  start: 8,
  element: 9,
  code: 10,
  data: 11,
});

const EXTERNAL_KIND = Object.freeze({ func: 0, table: 1, memory: 2, global: 3 });

const MAGIC = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];

// A growable byte buffer with the LEB128 encoders every section needs.
export class Bytes {
  constructor(capacity = 1024) {
    this.buf = new Uint8Array(capacity);
    this.len = 0;
  }

  ensure(extra) {
    if (this.len + extra <= this.buf.length) {
      return;
    }
    let capacity = this.buf.length * 2;
    while (capacity < this.len + extra) {
      capacity *= 2;
    }
    const next = new Uint8Array(capacity);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
  }

  byte(b) {
    this.ensure(1);
    this.buf[this.len++] = b & 0xff;
    return this;
  }

  bytes(arr) {
    this.ensure(arr.length);
    this.buf.set(arr, this.len);
    this.len += arr.length;
    return this;
  }

  // Unsigned LEB128.
  u32(v) {
    v >>>= 0;
    do {
      let b = v & 0x7f;
      v >>>= 7;
      if (v !== 0) {
        b |= 0x80;
      }
      this.byte(b);
    } while (v !== 0);
    return this;
  }

  // Signed LEB128 for a 32-bit value.
  s32(v) {
    v |= 0;
    for (;;) {
      const b = v & 0x7f;
      v >>= 7;
      const done = (v === 0 && (b & 0x40) === 0) || (v === -1 && (b & 0x40) !== 0);
      this.byte(done ? b : b | 0x80);
      if (done) {
        return this;
      }
    }
  }

  // Signed LEB128 for a 64-bit value, given as a BigInt or a number.
  s64(v) {
    v = BigInt.asIntN(64, BigInt(v));
    for (;;) {
      const b = Number(v & 0x7fn);
      v >>= 7n;
      const done = (v === 0n && (b & 0x40) === 0) || (v === -1n && (b & 0x40) !== 0);
      this.byte(done ? b : b | 0x80);
      if (done) {
        return this;
      }
    }
  }

  f32(v) {
    this.ensure(4);
    new DataView(this.buf.buffer).setFloat32(this.len, v, true);
    this.len += 4;
    return this;
  }

  f64(v) {
    this.ensure(8);
    new DataView(this.buf.buffer).setFloat64(this.len, v, true);
    this.len += 8;
    return this;
  }

  name(str) {
    const enc = new TextEncoder().encode(str);
    this.u32(enc.length);
    return this.bytes(enc);
  }

  // A length-prefixed copy of another buffer, as sections and bodies are.
  sized(other) {
    this.u32(other.len);
    return this.bytes(other.subarray());
  }

  subarray() {
    return this.buf.subarray(0, this.len);
  }
}

// The body of one function: its extra locals and its instructions.
export class Code extends Bytes {
  constructor(params = 0) {
    super(256);
    this.locals = [];
    this.params = params;
  }

  // Declares a local of the given type and returns its index, counting
  // the parameters first as wasm does.
  declareLocal(type) {
    this.locals.push(type);
    return this.params + this.locals.length - 1;
  }

  // Control
  unreachable() { return this.byte(0x00); }
  nop() { return this.byte(0x01); }
  block(bt = T.empty) { return this.byte(0x02).byte(bt); }
  loop(bt = T.empty) { return this.byte(0x03).byte(bt); }
  if_(bt = T.empty) { return this.byte(0x04).byte(bt); }
  else_() { return this.byte(0x05); }
  end() { return this.byte(0x0b); }
  br(depth) { return this.byte(0x0c).u32(depth); }
  br_if(depth) { return this.byte(0x0d).u32(depth); }
  br_table(depths, def) {
    this.byte(0x0e).u32(depths.length);
    for (const d of depths) {
      this.u32(d);
    }
    return this.u32(def);
  }
  return_() { return this.byte(0x0f); }
  call(f) { return this.byte(0x10).u32(f); }
  call_indirect(type, table = 0) { return this.byte(0x11).u32(type).u32(table); }
  return_call(f) { return this.byte(0x12).u32(f); }
  return_call_indirect(type, table = 0) { return this.byte(0x13).u32(type).u32(table); }

  // Parametric
  drop() { return this.byte(0x1a); }
  select() { return this.byte(0x1b); }

  // Variables
  local_get(i) { return this.byte(0x20).u32(i); }
  local_set(i) { return this.byte(0x21).u32(i); }
  local_tee(i) { return this.byte(0x22).u32(i); }
  global_get(i) { return this.byte(0x23).u32(i); }
  global_set(i) { return this.byte(0x24).u32(i); }

  // Memory. Every access carries an alignment hint and an offset.
  mem(op, align, offset) { return this.byte(op).u32(align).u32(offset); }
  i32_load(off = 0, align = 2) { return this.mem(0x28, align, off); }
  i64_load(off = 0, align = 3) { return this.mem(0x29, align, off); }
  f32_load(off = 0, align = 2) { return this.mem(0x2a, align, off); }
  f64_load(off = 0, align = 3) { return this.mem(0x2b, align, off); }
  i32_load8_s(off = 0) { return this.mem(0x2c, 0, off); }
  i32_load8_u(off = 0) { return this.mem(0x2d, 0, off); }
  i32_load16_s(off = 0) { return this.mem(0x2e, 1, off); }
  i32_load16_u(off = 0) { return this.mem(0x2f, 1, off); }
  i64_load8_s(off = 0) { return this.mem(0x30, 0, off); }
  i64_load8_u(off = 0) { return this.mem(0x31, 0, off); }
  i64_load16_s(off = 0) { return this.mem(0x32, 1, off); }
  i64_load16_u(off = 0) { return this.mem(0x33, 1, off); }
  i64_load32_s(off = 0) { return this.mem(0x34, 2, off); }
  i64_load32_u(off = 0) { return this.mem(0x35, 2, off); }
  i32_store(off = 0, align = 2) { return this.mem(0x36, align, off); }
  i64_store(off = 0, align = 3) { return this.mem(0x37, align, off); }
  f32_store(off = 0, align = 2) { return this.mem(0x38, align, off); }
  f64_store(off = 0, align = 3) { return this.mem(0x39, align, off); }
  i32_store8(off = 0) { return this.mem(0x3a, 0, off); }
  i32_store16(off = 0) { return this.mem(0x3b, 1, off); }
  i64_store8(off = 0) { return this.mem(0x3c, 0, off); }
  i64_store16(off = 0) { return this.mem(0x3d, 1, off); }
  i64_store32(off = 0) { return this.mem(0x3e, 2, off); }
  memory_size() { return this.byte(0x3f).byte(0); }
  memory_grow() { return this.byte(0x40).byte(0); }
  memory_copy() { return this.byte(0xfc).u32(10).byte(0).byte(0); }
  memory_fill() { return this.byte(0xfc).u32(11).byte(0); }

  // Constants
  i32_const(v) { return this.byte(0x41).s32(v); }
  i64_const(v) { return this.byte(0x42).s64(v); }
  f32_const(v) { return this.byte(0x43).f32(v); }
  f64_const(v) { return this.byte(0x44).f64(v); }

  // i32 comparison
  i32_eqz() { return this.byte(0x45); }
  i32_eq() { return this.byte(0x46); }
  i32_ne() { return this.byte(0x47); }
  i32_lt_s() { return this.byte(0x48); }
  i32_lt_u() { return this.byte(0x49); }
  i32_gt_s() { return this.byte(0x4a); }
  i32_gt_u() { return this.byte(0x4b); }
  i32_le_s() { return this.byte(0x4c); }
  i32_le_u() { return this.byte(0x4d); }
  i32_ge_s() { return this.byte(0x4e); }
  i32_ge_u() { return this.byte(0x4f); }

  // i64 comparison
  i64_eqz() { return this.byte(0x50); }
  i64_eq() { return this.byte(0x51); }
  i64_ne() { return this.byte(0x52); }
  i64_lt_s() { return this.byte(0x53); }
  i64_lt_u() { return this.byte(0x54); }
  i64_gt_s() { return this.byte(0x55); }
  i64_gt_u() { return this.byte(0x56); }
  i64_le_s() { return this.byte(0x57); }
  i64_le_u() { return this.byte(0x58); }
  i64_ge_s() { return this.byte(0x59); }
  i64_ge_u() { return this.byte(0x5a); }

  // f32 comparison
  f32_eq() { return this.byte(0x5b); }
  f32_ne() { return this.byte(0x5c); }
  f32_lt() { return this.byte(0x5d); }
  f32_gt() { return this.byte(0x5e); }
  f32_le() { return this.byte(0x5f); }
  f32_ge() { return this.byte(0x60); }

  // f64 comparison
  f64_eq() { return this.byte(0x61); }
  f64_ne() { return this.byte(0x62); }
  f64_lt() { return this.byte(0x63); }
  f64_gt() { return this.byte(0x64); }
  f64_le() { return this.byte(0x65); }
  f64_ge() { return this.byte(0x66); }

  // i32 arithmetic
  i32_clz() { return this.byte(0x67); }
  i32_ctz() { return this.byte(0x68); }
  i32_popcnt() { return this.byte(0x69); }
  i32_add() { return this.byte(0x6a); }
  i32_sub() { return this.byte(0x6b); }
  i32_mul() { return this.byte(0x6c); }
  i32_div_s() { return this.byte(0x6d); }
  i32_div_u() { return this.byte(0x6e); }
  i32_rem_s() { return this.byte(0x6f); }
  i32_rem_u() { return this.byte(0x70); }
  i32_and() { return this.byte(0x71); }
  i32_or() { return this.byte(0x72); }
  i32_xor() { return this.byte(0x73); }
  i32_shl() { return this.byte(0x74); }
  i32_shr_s() { return this.byte(0x75); }
  i32_shr_u() { return this.byte(0x76); }
  i32_rotl() { return this.byte(0x77); }
  i32_rotr() { return this.byte(0x78); }

  // i64 arithmetic
  i64_clz() { return this.byte(0x79); }
  i64_ctz() { return this.byte(0x7a); }
  i64_popcnt() { return this.byte(0x7b); }
  i64_add() { return this.byte(0x7c); }
  i64_sub() { return this.byte(0x7d); }
  i64_mul() { return this.byte(0x7e); }
  i64_div_s() { return this.byte(0x7f); }
  i64_div_u() { return this.byte(0x80); }
  i64_rem_s() { return this.byte(0x81); }
  i64_rem_u() { return this.byte(0x82); }
  i64_and() { return this.byte(0x83); }
  i64_or() { return this.byte(0x84); }
  i64_xor() { return this.byte(0x85); }
  i64_shl() { return this.byte(0x86); }
  i64_shr_s() { return this.byte(0x87); }
  i64_shr_u() { return this.byte(0x88); }
  i64_rotl() { return this.byte(0x89); }
  i64_rotr() { return this.byte(0x8a); }

  // f32 arithmetic
  f32_abs() { return this.byte(0x8b); }
  f32_neg() { return this.byte(0x8c); }
  f32_ceil() { return this.byte(0x8d); }
  f32_floor() { return this.byte(0x8e); }
  f32_trunc() { return this.byte(0x8f); }
  f32_nearest() { return this.byte(0x90); }
  f32_sqrt() { return this.byte(0x91); }
  f32_add() { return this.byte(0x92); }
  f32_sub() { return this.byte(0x93); }
  f32_mul() { return this.byte(0x94); }
  f32_div() { return this.byte(0x95); }
  f32_min() { return this.byte(0x96); }
  f32_max() { return this.byte(0x97); }
  f32_copysign() { return this.byte(0x98); }

  // f64 arithmetic
  f64_abs() { return this.byte(0x99); }
  f64_neg() { return this.byte(0x9a); }
  f64_ceil() { return this.byte(0x9b); }
  f64_floor() { return this.byte(0x9c); }
  f64_trunc() { return this.byte(0x9d); }
  f64_nearest() { return this.byte(0x9e); }
  f64_sqrt() { return this.byte(0x9f); }
  f64_add() { return this.byte(0xa0); }
  f64_sub() { return this.byte(0xa1); }
  f64_mul() { return this.byte(0xa2); }
  f64_div() { return this.byte(0xa3); }
  f64_min() { return this.byte(0xa4); }
  f64_max() { return this.byte(0xa5); }
  f64_copysign() { return this.byte(0xa6); }

  // Conversions
  i32_wrap_i64() { return this.byte(0xa7); }
  i32_trunc_f32_s() { return this.byte(0xa8); }
  i32_trunc_f32_u() { return this.byte(0xa9); }
  i32_trunc_f64_s() { return this.byte(0xaa); }
  i32_trunc_f64_u() { return this.byte(0xab); }
  i64_extend_i32_s() { return this.byte(0xac); }
  i64_extend_i32_u() { return this.byte(0xad); }
  i64_trunc_f32_s() { return this.byte(0xae); }
  i64_trunc_f32_u() { return this.byte(0xaf); }
  i64_trunc_f64_s() { return this.byte(0xb0); }
  i64_trunc_f64_u() { return this.byte(0xb1); }
  f32_convert_i32_s() { return this.byte(0xb2); }
  f32_convert_i32_u() { return this.byte(0xb3); }
  f32_convert_i64_s() { return this.byte(0xb4); }
  f32_convert_i64_u() { return this.byte(0xb5); }
  f32_demote_f64() { return this.byte(0xb6); }
  f64_convert_i32_s() { return this.byte(0xb7); }
  f64_convert_i32_u() { return this.byte(0xb8); }
  f64_convert_i64_s() { return this.byte(0xb9); }
  f64_convert_i64_u() { return this.byte(0xba); }
  f64_promote_f32() { return this.byte(0xbb); }
  i32_reinterpret_f32() { return this.byte(0xbc); }
  i64_reinterpret_f64() { return this.byte(0xbd); }
  f32_reinterpret_i32() { return this.byte(0xbe); }
  f64_reinterpret_i64() { return this.byte(0xbf); }

  // Sign extension
  i32_extend8_s() { return this.byte(0xc0); }
  i32_extend16_s() { return this.byte(0xc1); }
  i64_extend8_s() { return this.byte(0xc2); }
  i64_extend16_s() { return this.byte(0xc3); }
  i64_extend32_s() { return this.byte(0xc4); }

  // Saturating truncation: x86's cvtt* return the "integer indefinite"
  // on overflow, which these approximate without trapping.
  i32_trunc_sat_f32_s() { return this.byte(0xfc).u32(0); }
  i32_trunc_sat_f32_u() { return this.byte(0xfc).u32(1); }
  i32_trunc_sat_f64_s() { return this.byte(0xfc).u32(2); }
  i32_trunc_sat_f64_u() { return this.byte(0xfc).u32(3); }
  i64_trunc_sat_f32_s() { return this.byte(0xfc).u32(4); }
  i64_trunc_sat_f32_u() { return this.byte(0xfc).u32(5); }
  i64_trunc_sat_f64_s() { return this.byte(0xfc).u32(6); }
  i64_trunc_sat_f64_u() { return this.byte(0xfc).u32(7); }

  // SIMD: every opcode is 0xfd followed by a LEB128 sub-opcode.
  simd(op) { return this.byte(0xfd).u32(op); }
  v128_load(off = 0, align = 4) { return this.simd(0).u32(align).u32(off); }
  v128_store(off = 0, align = 4) { return this.simd(11).u32(align).u32(off); }
  v128_load32_zero(off = 0) { return this.simd(92).u32(2).u32(off); }
  v128_load64_zero(off = 0) { return this.simd(93).u32(3).u32(off); }
  v128_load8_lane(lane, off = 0) { return this.simd(84).u32(0).u32(off).byte(lane); }
  v128_load16_lane(lane, off = 0) { return this.simd(85).u32(1).u32(off).byte(lane); }
  v128_load32_lane(lane, off = 0) { return this.simd(86).u32(2).u32(off).byte(lane); }
  v128_load64_lane(lane, off = 0) { return this.simd(87).u32(3).u32(off).byte(lane); }
  v128_store8_lane(lane, off = 0) { return this.simd(88).u32(0).u32(off).byte(lane); }
  v128_store16_lane(lane, off = 0) { return this.simd(89).u32(1).u32(off).byte(lane); }
  v128_store32_lane(lane, off = 0) { return this.simd(90).u32(2).u32(off).byte(lane); }
  v128_store64_lane(lane, off = 0) { return this.simd(91).u32(3).u32(off).byte(lane); }
  v128_const(bytes16) { return this.simd(12).bytes(bytes16); }
  i8x16_shuffle(lanes16) { return this.simd(13).bytes(lanes16); }
  i8x16_swizzle() { return this.simd(14); }
  i8x16_splat() { return this.simd(15); }
  i16x8_splat() { return this.simd(16); }
  i32x4_splat() { return this.simd(17); }
  i64x2_splat() { return this.simd(18); }
  f32x4_splat() { return this.simd(19); }
  f64x2_splat() { return this.simd(20); }
  i8x16_extract_lane_s(l) { return this.simd(21).byte(l); }
  i8x16_extract_lane_u(l) { return this.simd(22).byte(l); }
  i8x16_replace_lane(l) { return this.simd(23).byte(l); }
  i16x8_extract_lane_s(l) { return this.simd(24).byte(l); }
  i16x8_extract_lane_u(l) { return this.simd(25).byte(l); }
  i16x8_replace_lane(l) { return this.simd(26).byte(l); }
  i32x4_extract_lane(l) { return this.simd(27).byte(l); }
  i32x4_replace_lane(l) { return this.simd(28).byte(l); }
  i64x2_extract_lane(l) { return this.simd(29).byte(l); }
  i64x2_replace_lane(l) { return this.simd(30).byte(l); }
  f32x4_extract_lane(l) { return this.simd(31).byte(l); }
  f32x4_replace_lane(l) { return this.simd(32).byte(l); }
  f64x2_extract_lane(l) { return this.simd(33).byte(l); }
  f64x2_replace_lane(l) { return this.simd(34).byte(l); }
  i8x16_eq() { return this.simd(35); }
  i8x16_ne() { return this.simd(36); }
  i8x16_lt_s() { return this.simd(37); }
  i8x16_lt_u() { return this.simd(38); }
  i8x16_gt_s() { return this.simd(39); }
  i8x16_gt_u() { return this.simd(40); }
  i8x16_le_s() { return this.simd(41); }
  i8x16_le_u() { return this.simd(42); }
  i8x16_ge_s() { return this.simd(43); }
  i8x16_ge_u() { return this.simd(44); }
  i16x8_eq() { return this.simd(45); }
  i16x8_ne() { return this.simd(46); }
  i16x8_lt_s() { return this.simd(47); }
  i16x8_lt_u() { return this.simd(48); }
  i16x8_gt_s() { return this.simd(49); }
  i16x8_gt_u() { return this.simd(50); }
  i16x8_le_s() { return this.simd(51); }
  i16x8_le_u() { return this.simd(52); }
  i16x8_ge_s() { return this.simd(53); }
  i16x8_ge_u() { return this.simd(54); }
  i32x4_eq() { return this.simd(55); }
  i32x4_ne() { return this.simd(56); }
  i32x4_lt_s() { return this.simd(57); }
  i32x4_lt_u() { return this.simd(58); }
  i32x4_gt_s() { return this.simd(59); }
  i32x4_gt_u() { return this.simd(60); }
  i32x4_le_s() { return this.simd(61); }
  i32x4_le_u() { return this.simd(62); }
  i32x4_ge_s() { return this.simd(63); }
  i32x4_ge_u() { return this.simd(64); }
  f32x4_eq() { return this.simd(65); }
  f32x4_ne() { return this.simd(66); }
  f32x4_lt() { return this.simd(67); }
  f32x4_gt() { return this.simd(68); }
  f32x4_le() { return this.simd(69); }
  f32x4_ge() { return this.simd(70); }
  f64x2_eq() { return this.simd(71); }
  f64x2_ne() { return this.simd(72); }
  f64x2_lt() { return this.simd(73); }
  f64x2_gt() { return this.simd(74); }
  f64x2_le() { return this.simd(75); }
  f64x2_ge() { return this.simd(76); }
  v128_not() { return this.simd(77); }
  v128_and() { return this.simd(78); }
  v128_andnot() { return this.simd(79); }
  v128_or() { return this.simd(80); }
  v128_xor() { return this.simd(81); }
  v128_bitselect() { return this.simd(82); }
  v128_any_true() { return this.simd(83); }
  i8x16_abs() { return this.simd(96); }
  i8x16_neg() { return this.simd(97); }
  i8x16_popcnt() { return this.simd(98); }
  i8x16_all_true() { return this.simd(99); }
  i8x16_bitmask() { return this.simd(100); }
  i8x16_narrow_i16x8_s() { return this.simd(101); }
  i8x16_narrow_i16x8_u() { return this.simd(102); }
  i8x16_shl() { return this.simd(107); }
  i8x16_shr_s() { return this.simd(108); }
  i8x16_shr_u() { return this.simd(109); }
  i8x16_add() { return this.simd(110); }
  i8x16_add_sat_s() { return this.simd(111); }
  i8x16_add_sat_u() { return this.simd(112); }
  i8x16_sub() { return this.simd(113); }
  i8x16_sub_sat_s() { return this.simd(114); }
  i8x16_sub_sat_u() { return this.simd(115); }
  i8x16_min_s() { return this.simd(118); }
  i8x16_min_u() { return this.simd(119); }
  i8x16_max_s() { return this.simd(120); }
  i8x16_max_u() { return this.simd(121); }
  i8x16_avgr_u() { return this.simd(123); }
  i16x8_extadd_pairwise_i8x16_s() { return this.simd(124); }
  i16x8_extadd_pairwise_i8x16_u() { return this.simd(125); }
  i32x4_extadd_pairwise_i16x8_s() { return this.simd(126); }
  i32x4_extadd_pairwise_i16x8_u() { return this.simd(127); }
  i16x8_abs() { return this.simd(128); }
  i16x8_neg() { return this.simd(129); }
  i16x8_q15mulr_sat_s() { return this.simd(130); }
  i16x8_all_true() { return this.simd(131); }
  i16x8_bitmask() { return this.simd(132); }
  i16x8_narrow_i32x4_s() { return this.simd(133); }
  i16x8_narrow_i32x4_u() { return this.simd(134); }
  i16x8_extend_low_i8x16_s() { return this.simd(135); }
  i16x8_extend_high_i8x16_s() { return this.simd(136); }
  i16x8_extend_low_i8x16_u() { return this.simd(137); }
  i16x8_extend_high_i8x16_u() { return this.simd(138); }
  i16x8_shl() { return this.simd(139); }
  i16x8_shr_s() { return this.simd(140); }
  i16x8_shr_u() { return this.simd(141); }
  i16x8_add() { return this.simd(142); }
  i16x8_add_sat_s() { return this.simd(143); }
  i16x8_add_sat_u() { return this.simd(144); }
  i16x8_sub() { return this.simd(145); }
  i16x8_sub_sat_s() { return this.simd(146); }
  i16x8_sub_sat_u() { return this.simd(147); }
  i16x8_mul() { return this.simd(149); }
  i16x8_min_s() { return this.simd(150); }
  i16x8_min_u() { return this.simd(151); }
  i16x8_max_s() { return this.simd(152); }
  i16x8_max_u() { return this.simd(153); }
  i16x8_avgr_u() { return this.simd(155); }
  i16x8_extmul_low_i8x16_s() { return this.simd(156); }
  i16x8_extmul_high_i8x16_s() { return this.simd(157); }
  i16x8_extmul_low_i8x16_u() { return this.simd(158); }
  i16x8_extmul_high_i8x16_u() { return this.simd(159); }
  i32x4_abs() { return this.simd(160); }
  i32x4_neg() { return this.simd(161); }
  i32x4_all_true() { return this.simd(163); }
  i32x4_bitmask() { return this.simd(164); }
  i32x4_extend_low_i16x8_s() { return this.simd(167); }
  i32x4_extend_high_i16x8_s() { return this.simd(168); }
  i32x4_extend_low_i16x8_u() { return this.simd(169); }
  i32x4_extend_high_i16x8_u() { return this.simd(170); }
  i32x4_shl() { return this.simd(171); }
  i32x4_shr_s() { return this.simd(172); }
  i32x4_shr_u() { return this.simd(173); }
  i32x4_add() { return this.simd(174); }
  i32x4_sub() { return this.simd(177); }
  i32x4_mul() { return this.simd(181); }
  i32x4_min_s() { return this.simd(182); }
  i32x4_min_u() { return this.simd(183); }
  i32x4_max_s() { return this.simd(184); }
  i32x4_max_u() { return this.simd(185); }
  i32x4_dot_i16x8_s() { return this.simd(186); }
  i32x4_extmul_low_i16x8_s() { return this.simd(188); }
  i32x4_extmul_high_i16x8_s() { return this.simd(189); }
  i32x4_extmul_low_i16x8_u() { return this.simd(190); }
  i32x4_extmul_high_i16x8_u() { return this.simd(191); }
  i64x2_abs() { return this.simd(192); }
  i64x2_neg() { return this.simd(193); }
  i64x2_all_true() { return this.simd(195); }
  i64x2_bitmask() { return this.simd(196); }
  i64x2_extend_low_i32x4_s() { return this.simd(199); }
  i64x2_extend_high_i32x4_s() { return this.simd(200); }
  i64x2_extend_low_i32x4_u() { return this.simd(201); }
  i64x2_extend_high_i32x4_u() { return this.simd(202); }
  i64x2_shl() { return this.simd(203); }
  i64x2_shr_s() { return this.simd(204); }
  i64x2_shr_u() { return this.simd(205); }
  i64x2_add() { return this.simd(206); }
  i64x2_sub() { return this.simd(209); }
  i64x2_mul() { return this.simd(213); }
  i64x2_eq() { return this.simd(214); }
  i64x2_ne() { return this.simd(215); }
  i64x2_lt_s() { return this.simd(216); }
  i64x2_gt_s() { return this.simd(217); }
  i64x2_le_s() { return this.simd(218); }
  i64x2_ge_s() { return this.simd(219); }
  i64x2_extmul_low_i32x4_s() { return this.simd(220); }
  i64x2_extmul_high_i32x4_s() { return this.simd(221); }
  i64x2_extmul_low_i32x4_u() { return this.simd(222); }
  i64x2_extmul_high_i32x4_u() { return this.simd(223); }
  f32x4_ceil() { return this.simd(103); }
  f32x4_floor() { return this.simd(104); }
  f32x4_trunc() { return this.simd(105); }
  f32x4_nearest() { return this.simd(106); }
  f64x2_ceil() { return this.simd(116); }
  f64x2_floor() { return this.simd(117); }
  f64x2_trunc() { return this.simd(122); }
  f64x2_nearest() { return this.simd(148); }
  f32x4_abs() { return this.simd(224); }
  f32x4_neg() { return this.simd(225); }
  f32x4_sqrt() { return this.simd(227); }
  f32x4_add() { return this.simd(228); }
  f32x4_sub() { return this.simd(229); }
  f32x4_mul() { return this.simd(230); }
  f32x4_div() { return this.simd(231); }
  f32x4_min() { return this.simd(232); }
  f32x4_max() { return this.simd(233); }
  f32x4_pmin() { return this.simd(234); }
  f32x4_pmax() { return this.simd(235); }
  f64x2_abs() { return this.simd(236); }
  f64x2_neg() { return this.simd(237); }
  f64x2_sqrt() { return this.simd(239); }
  f64x2_add() { return this.simd(240); }
  f64x2_sub() { return this.simd(241); }
  f64x2_mul() { return this.simd(242); }
  f64x2_div() { return this.simd(243); }
  f64x2_min() { return this.simd(244); }
  f64x2_max() { return this.simd(245); }
  f64x2_pmin() { return this.simd(246); }
  f64x2_pmax() { return this.simd(247); }
  i32x4_trunc_sat_f32x4_s() { return this.simd(248); }
  i32x4_trunc_sat_f32x4_u() { return this.simd(249); }
  f32x4_convert_i32x4_s() { return this.simd(250); }
  f32x4_convert_i32x4_u() { return this.simd(251); }
  i32x4_trunc_sat_f64x2_s_zero() { return this.simd(252); }
  i32x4_trunc_sat_f64x2_u_zero() { return this.simd(253); }
  f64x2_convert_low_i32x4_s() { return this.simd(254); }
  f64x2_convert_low_i32x4_u() { return this.simd(255); }
  f32x4_demote_f64x2_zero() { return this.simd(94); }
  f64x2_promote_low_f32x4() { return this.simd(95); }

  // Atomics (threads proposal): 0xfe prefix, then a memarg.
  atomic(op, align, off) { return this.byte(0xfe).u32(op).u32(align).u32(off); }
  memory_atomic_notify(off = 0) { return this.atomic(0x00, 2, off); }
  memory_atomic_wait32(off = 0) { return this.atomic(0x01, 2, off); }
  memory_atomic_wait64(off = 0) { return this.atomic(0x02, 3, off); }
}

// Collects a module's sections and serialises them in the order the
// binary format requires.
export class ModuleBuilder {
  constructor() {
    this.types = [];
    this.typeKeys = new Map();
    this.imports = [];
    this.importCounts = { func: 0, table: 0, memory: 0, global: 0 };
    this.funcs = [];
    this.tables = [];
    this.memories = [];
    this.globals = [];
    this.exports = [];
    this.start = null;
    this.elems = [];
    this.datas = [];
  }

  // Function types are deduplicated, so the same signature always has
  // one index.
  addType(params, results) {
    const key = `${params.join(",")}->${results.join(",")}`;
    const known = this.typeKeys.get(key);
    if (known !== undefined) {
      return known;
    }
    const index = this.types.length;
    this.types.push({ params, results });
    this.typeKeys.set(key, index);
    return index;
  }

  // Imports must all precede definitions of the same kind, which the
  // index arithmetic below assumes: define nothing before importing.
  importFunc(module, name, type) {
    if (this.funcs.length > 0) {
      throw new Error("import functions before defining any");
    }
    this.imports.push({ module, name, kind: EXTERNAL_KIND.func, type });
    return this.importCounts.func++;
  }

  importGlobal(module, name, type, mutable) {
    if (this.globals.length > 0) {
      throw new Error("import globals before defining any");
    }
    this.imports.push({ module, name, kind: EXTERNAL_KIND.global, type, mutable });
    return this.importCounts.global++;
  }

  importMemory(module, name, limits) {
    this.imports.push({ module, name, kind: EXTERNAL_KIND.memory, limits });
    return this.importCounts.memory++;
  }

  importTable(module, name, limits) {
    this.imports.push({ module, name, kind: EXTERNAL_KIND.table, limits });
    return this.importCounts.table++;
  }

  addFunc(type, locals, code, opts = {}) {
    const index = this.importCounts.func + this.funcs.length;
    this.funcs.push({ type, locals, code });
    if (opts.export) {
      this.exports.push({ name: opts.export, kind: EXTERNAL_KIND.func, index });
    }
    return index;
  }

  addGlobal(type, mutable, init, opts = {}) {
    const index = this.importCounts.global + this.globals.length;
    this.globals.push({ type, mutable, init });
    if (opts.export) {
      this.exports.push({ name: opts.export, kind: EXTERNAL_KIND.global, index });
    }
    return index;
  }

  addMemory(limits, opts = {}) {
    const index = this.importCounts.memory + this.memories.length;
    this.memories.push(limits);
    if (opts.export) {
      this.exports.push({ name: opts.export, kind: EXTERNAL_KIND.memory, index });
    }
    return index;
  }

  addTable(limits, opts = {}) {
    const index = this.importCounts.table + this.tables.length;
    this.tables.push(limits);
    if (opts.export) {
      this.exports.push({ name: opts.export, kind: EXTERNAL_KIND.table, index });
    }
    return index;
  }

  // An active element segment: the functions land in `table` starting
  // at `offset` when the module is instantiated.
  addElem(table, offset, funcs) {
    this.elems.push({ table, offset, funcs });
  }

  addData(offset, bytes) {
    this.datas.push({ offset, bytes });
  }

  setStart(func) {
    this.start = func;
  }

  toBytes() {
    const out = new Bytes(4096);
    out.bytes(MAGIC);

    const section = (id, body) => {
      out.byte(id);
      out.sized(body);
    };

    const limits = (b, l) => {
      const flags = (l.max !== undefined ? 1 : 0) | (l.shared ? 2 : 0);
      b.byte(flags).u32(l.min);
      if (l.max !== undefined) {
        b.u32(l.max);
      }
    };

    // Type section
    if (this.types.length > 0) {
      const b = new Bytes();
      b.u32(this.types.length);
      for (const t of this.types) {
        b.byte(0x60).u32(t.params.length).bytes(t.params).u32(t.results.length).bytes(t.results);
      }
      section(SECTION.type, b);
    }

    // Import section
    if (this.imports.length > 0) {
      const b = new Bytes();
      b.u32(this.imports.length);
      for (const im of this.imports) {
        b.name(im.module).name(im.name).byte(im.kind);
        if (im.kind === EXTERNAL_KIND.func) {
          b.u32(im.type);
        } else if (im.kind === EXTERNAL_KIND.global) {
          b.byte(im.type).byte(im.mutable ? 1 : 0);
        } else if (im.kind === EXTERNAL_KIND.table) {
          b.byte(T.funcref);
          limits(b, im.limits);
        } else {
          limits(b, im.limits);
        }
      }
      section(SECTION.import, b);
    }

    // Function section
    if (this.funcs.length > 0) {
      const b = new Bytes();
      b.u32(this.funcs.length);
      for (const f of this.funcs) {
        b.u32(f.type);
      }
      section(SECTION.function, b);
    }

    // Table section
    if (this.tables.length > 0) {
      const b = new Bytes();
      b.u32(this.tables.length);
      for (const t of this.tables) {
        b.byte(T.funcref);
        limits(b, t);
      }
      section(SECTION.table, b);
    }

    // Memory section
    if (this.memories.length > 0) {
      const b = new Bytes();
      b.u32(this.memories.length);
      for (const m of this.memories) {
        limits(b, m);
      }
      section(SECTION.memory, b);
    }

    // Global section. The initialiser is a constant expression given
    // as an already-encoded Code (ending in `end`).
    if (this.globals.length > 0) {
      const b = new Bytes();
      b.u32(this.globals.length);
      for (const g of this.globals) {
        b.byte(g.type).byte(g.mutable ? 1 : 0).bytes(g.init.subarray());
      }
      section(SECTION.global, b);
    }

    // Export section
    if (this.exports.length > 0) {
      const b = new Bytes();
      b.u32(this.exports.length);
      for (const e of this.exports) {
        b.name(e.name).byte(e.kind).u32(e.index);
      }
      section(SECTION.export, b);
    }

    // Start section
    if (this.start !== null) {
      const b = new Bytes();
      b.u32(this.start);
      section(SECTION.start, b);
    }

    // Element section: active segments with an explicit table index.
    if (this.elems.length > 0) {
      const b = new Bytes();
      b.u32(this.elems.length);
      for (const e of this.elems) {
        b.byte(0x02).u32(e.table);
        b.byte(0x41).s32(e.offset).byte(0x0b);
        b.byte(0x00).u32(e.funcs.length);
        for (const f of e.funcs) {
          b.u32(f);
        }
      }
      section(SECTION.element, b);
    }

    // Code section: each body is its local declarations, run-length
    // grouped by type, then the instructions.
    if (this.funcs.length > 0) {
      const b = new Bytes();
      b.u32(this.funcs.length);
      for (const f of this.funcs) {
        const body = new Bytes();
        const groups = [];
        for (const l of f.locals) {
          const last = groups[groups.length - 1];
          if (last && last.type === l) {
            last.count++;
          } else {
            groups.push({ type: l, count: 1 });
          }
        }
        body.u32(groups.length);
        for (const g of groups) {
          body.u32(g.count).byte(g.type);
        }
        body.bytes(f.code.subarray());
        b.sized(body);
      }
      section(SECTION.code, b);
    }

    // Data section: active segments into memory 0.
    if (this.datas.length > 0) {
      const b = new Bytes();
      b.u32(this.datas.length);
      for (const d of this.datas) {
        b.byte(0x00).byte(0x41).s32(d.offset).byte(0x0b);
        b.u32(d.bytes.length).bytes(d.bytes);
      }
      section(SECTION.data, b);
    }

    return out.subarray().slice();
  }
}
