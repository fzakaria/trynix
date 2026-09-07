// The translator: guest basic blocks become wasm functions.
//
// A region is translated at a time. From an entry address the
// translator follows every direct control transfer it can see, both
// arms of a conditional, the target of a call and the instruction after
// it, until it has the reachable blocks or hits the size cap, and emits
// them as one module: one function per block, all of type () -> (),
// chained by tail calls so the wasm stack never grows with guest calls.
// Jumps whose target is in an earlier module go through the shared
// table by constant index; indirect jumps look their target up in the
// block table (helpers.js) and tail-call what they find, or set rip and
// return to the run loop when there is nothing yet.
//
// Values on the wasm stack are i64, zero-extended to the operand's
// size. A register write of 32 bits clears the upper half as the
// hardware does; 8 and 16 bit writes merge. Flags are lazy: the
// operation and its operands are recorded in the cc_* globals and only
// evaluated by the instruction that reads them. A compare or test
// directly followed by the branch that uses it is folded into one wasm
// comparison instead.
import { Code, ModuleBuilder, T } from "./wasm.js";
import { decode, DecodeError, REG } from "./decode.js";
import { CC, EXIT, G, GLOBALS, ccOp } from "./state.js";
import { HELPER_FUNCS } from "./helpers.js";
import { emitSimd } from "./simd.js";
import { emitX87 } from "./x87.js";

// Blocks per region and instructions per block. A region is one module,
// validated eagerly by V8, so it is kept to a size that compiles in a
// few milliseconds.
const MAX_BLOCKS_PER_REGION = 512;
const MAX_INSNS_PER_BLOCK = 256;

// Bumped whenever generated code changes shape, so a cached module from
// an older translator is never instantiated against a newer runtime.
export const TRANSLATION_VERSION = 1;

// Imported functions, in the order the translated module imports them.
// The JavaScript side of these lives on the Machine.
const JS_IMPORTS = [
  // syscall(): registers hold the arguments; rax gets the result.
  ["syscall", [], []],
  // cpuid(): eax and ecx in, eax..edx out.
  ["cpuid", [], []],
  // rdtsc(): edx:eax out.
  ["rdtsc", [], []],
  // div128(signed): rdx:rax / divisor in cc_src2 -> rax quotient, rdx remainder.
  ["div128", [T.i32], []],
  // fpu(op): x87 operations that are easier in JavaScript, by number.
  ["fpu", [T.i32, T.i64], []],
  // trace(rip): called at every block entry when block tracing is on.
  ["trace", [T.i64], []],
];

const VALTYPE = { i32: T.i32, i64: T.i64, f64: T.f64, v128: T.v128 };

const MASK = [0n, 0xffn, 0xffffn, 0n, 0xffffffffn, 0n, 0n, 0n, 0xffffffffffffffffn];
const BITS = [0, 8, 16, 0, 32, 0, 0, 0, 64];

const CONTROL = new Set([
  "jmp", "call", "ret", "syscall", "hlt", "ud2", "int3", "int", "int1", "iret", "sysret",
  "loop", "loope", "loopne", "jrcxz", "retf", "jmpf", "callf", "ud0", "ud1", "xbegin",
]);

// One translated block: its address, instructions and how it ends.
class Block {
  constructor(addr) {
    this.addr = addr;
    this.insns = [];
    this.end = addr;
    // Direct successors worth translating in the same region.
    this.targets = [];
    this.index = 0; // table slot, assigned at emission
    this.func = 0; // function index within the module
    this.decodeError = null;
  }
}

export class Translator {
  constructor(machine) {
    this.machine = machine;
    // Instructions the translator has no code for, by address, for the
    // error the run loop raises if one is reached.
    this.unsupported = new Map();
    this.regions = 0;
    this.blocks = 0;
    this.cachedRegions = 0;
    this.cachedBlocks = 0;
    this.bytesEmitted = 0;
    this.translateMs = 0;
    // When set, every block reports its address to the trace import.
    this.traceBlocks = false;
    // When set, called with (entry, blocks, ms) after every region.
    this.onRegion = null;
  }

  // Translates the region reachable from entry and returns the table
  // slot of entry's block.
  //
  // Every address a block needs is emitted as an offset from the load
  // base of the file mapping the entry lies in, read from an immutable
  // global each instance is given, so the module is the same bytes
  // wherever the file is mapped and can be cached by (file, offset).
  // A region never crosses out of its mapping for the same reason.
  translateRegion(entry) {
    const t0 = performance.now();
    const machine = this.machine;
    const mapping = machine.locate(entry);
    const base = mapping !== null ? mapping.base : 0n;
    const key = mapping !== null && mapping.file !== null
      ? `${mapping.file}@${(entry - base).toString(16)}#${TRANSLATION_VERSION}`
      : null;

    const cached = key !== null && machine.cache !== null ? machine.cache.get(key) : undefined;
    if (cached !== undefined) {
      const slot = this.instantiate(cached, base, key);
      this.cachedRegions++;
      this.cachedBlocks += cached.offsets.length;
      this.translateMs += performance.now() - t0;
      return slot;
    }

    const blocks = new Map();
    const order = [];
    const worklist = [entry];
    const inMapping = (addr) => mapping === null || (addr >= mapping.lo && addr < mapping.hi);
    while (worklist.length > 0 && order.length < MAX_BLOCKS_PER_REGION) {
      const addr = worklist.pop();
      if (blocks.has(addr) || machine.lookup(addr) !== 0 || !inMapping(addr)) {
        continue;
      }
      const block = this.decodeBlock(addr);
      blocks.set(addr, block);
      order.push(block);
      for (const t of block.targets) {
        worklist.push(t);
      }
    }

    const unsupported = new Map();
    const bytes = this.emitModule(order, blocks, base, unsupported);
    const entryBlock = {
      bytes,
      offsets: order.map((b) => b.addr - base),
      unsupported: [...unsupported].map(([addr, why]) => [addr - base, why]),
    };
    const slot = this.instantiate(entryBlock, base, key);
    if (key !== null && machine.cache !== null) {
      machine.cache.put(key, entryBlock);
    }
    this.regions++;
    this.blocks += order.length;
    this.bytesEmitted += bytes.length;
    const ms = performance.now() - t0;
    this.translateMs += ms;
    if (this.onRegion) {
      this.onRegion(entry, order.length, ms, bytes.length);
    }
    return slot;
  }

  // Instantiates a region's module at a load base and registers its
  // blocks. Returns the slot of the first block, which is the entry.
  instantiate({ bytes, offsets, unsupported }, base, key) {
    const machine = this.machine;
    const first = machine.reserveSlots(offsets.length);
    let module;
    try {
      module = new WebAssembly.Module(bytes);
    } catch (e) {
      throw new Error(`${key ?? "region"}: ${e.message}`);
    }
    const instance = new WebAssembly.Instance(module, machine.importObject(base));
    offsets.forEach((off, i) => {
      machine.register(base + off, first + i, instance.exports[i]);
    });
    for (const [off, why] of unsupported) {
      this.unsupported.set(base + off, why);
    }
    return first;
  }

  decodeBlock(addr) {
    const block = new Block(addr);
    const mem = this.machine.bytes();
    let pc = addr;
    for (let n = 0; n < MAX_INSNS_PER_BLOCK; n++) {
      let insn;
      try {
        insn = decode(mem, Number(pc), pc);
      } catch (e) {
        if (!(e instanceof DecodeError)) {
          throw e;
        }
        block.decodeError = e.message;
        block.end = pc;
        return block;
      }
      block.insns.push(insn);
      pc = BigInt.asUintN(64, pc + BigInt(insn.len));
      if (CONTROL.has(insn.mnemonic) || (insn.cond !== undefined && insn.mnemonic.startsWith("j"))) {
        break;
      }
    }
    block.end = pc;
    const last = block.insns[block.insns.length - 1];
    const m = last.mnemonic;
    if (m === "jmp" && last.operands[0].kind === "rel") {
      block.targets.push(last.operands[0].target);
    } else if (m === "call" && last.operands[0].kind === "rel") {
      block.targets.push(last.operands[0].target, pc);
    } else if (last.cond !== undefined && m.startsWith("j")) {
      block.targets.push(last.operands[0].target, pc);
    } else if (m === "loop" || m === "loope" || m === "loopne" || m === "jrcxz") {
      block.targets.push(last.operands[0].target, pc);
    } else if (m === "syscall" || !CONTROL.has(m)) {
      // A syscall re-dispatches on rip; a block cut by the size cap
      // falls through. Either way the next address is worth having.
      block.targets.push(pc);
    }
    return block;
  }

  // Emits one module holding every block of the region, with every
  // address relative to `base`.
  emitModule(order, blocks, base, unsupported) {
    const m = new ModuleBuilder();
    const ctx = { m, blocks, order, imports: {}, globals: {}, helpers: {}, base, unsupported };

    // Imports, in a fixed order the Machine's import object matches.
    // The block table is not among them: indirect jumps go through the
    // helpers' `jump`, which is the one place the table is imported.
    m.importMemory("env", "memory", { min: 1, max: 65536, shared: this.machine.shared });
    for (const [name, params, results] of JS_IMPORTS) {
      ctx.imports[name] = m.importFunc("env", name, m.addType(params, results));
    }
    const HELPER_TYPES = {
      lookup: [[T.i64], [T.i32]],
      cc_eflags: [[], [T.i32]],
      cc_cond: [[T.i32], [T.i32]],
      mulhu: [[T.i64, T.i64], [T.i64]],
      mulhs: [[T.i64, T.i64], [T.i64]],
      jump: [[T.i32], []],
      fpu_get: [[T.i32], [T.f64]],
      fpu_set: [[T.i32, T.f64], []],
      fpu_push: [[T.f64], []],
      fpu_pop: [[], [T.f64]],
    };
    for (const name of HELPER_FUNCS) {
      const [p, r] = HELPER_TYPES[name];
      ctx.helpers[name] = m.importFunc("env", name, m.addType(p, r));
    }
    for (const [name, type] of GLOBALS) {
      ctx.globals[name] = m.importGlobal("env", name, VALTYPE[type], true);
    }
    // The load base of the file this region came from.
    ctx.baseGlobal = m.importGlobal("env", "base", T.i64, false);
    ctx.blockType = m.addType([], []);

    // Function indices are assigned in order after the imports: every
    // block first, then the trampolines created while emitting them.
    // Bodies are collected and only added to the module once all are
    // emitted, so a trampoline's index is known before it is defined.
    const firstFunc = JS_IMPORTS.length + HELPER_FUNCS.length;
    order.forEach((b, i) => {
      b.func = firstFunc + i;
    });
    ctx.trampolines = new Map();
    ctx.nextTrampoline = firstFunc + order.length;

    const bodies = [];
    for (const b of order) {
      const c = new Code(0);
      const e = new Emitter(this, ctx, c, b);
      e.emitBlock();
      bodies.push(c);
    }
    // Blocks are exported by position; the Machine puts them in the
    // table by hand, since a module without the table cannot have an
    // element segment for it.
    bodies.forEach((c, i) => {
      m.addFunc(ctx.blockType, c.locals, c, { export: String(i) });
    });
    for (const [, t] of ctx.trampolines) {
      const index = m.addFunc(ctx.blockType, t.code.locals, t.code);
      if (index !== t.index) {
        throw new Error("trampoline index mismatch");
      }
    }
    return m.toBytes();
  }
}

// Emits the code of one block.
class Emitter {
  constructor(translator, ctx, c, block) {
    this.translator = translator;
    this.ctx = ctx;
    this.c = c;
    this.block = block;
    this.g = ctx.globals;
    // Scratch locals, allocated on demand and reused per instruction.
    this.tmpI64 = [];
    this.tmpI32 = [];
    this.tmpV128 = [];
    this.tmpF32 = [];
    this.tmpF64 = [];
    this.usedI64 = 0;
    this.usedI32 = 0;
    this.usedV128 = 0;
    this.usedF32 = 0;
    this.usedF64 = 0;
    // The last flag-setting instruction, for branch folding.
    this.lastFlags = null;
    this.flagsA = null;
    this.flagsB = null;
    this.flagsRes = null;
    // The address after the instruction being emitted.
    this.next = 0n;
  }

  t64() {
    if (this.usedI64 === this.tmpI64.length) {
      this.tmpI64.push(this.c.declareLocal(T.i64));
    }
    return this.tmpI64[this.usedI64++];
  }

  t32() {
    if (this.usedI32 === this.tmpI32.length) {
      this.tmpI32.push(this.c.declareLocal(T.i32));
    }
    return this.tmpI32[this.usedI32++];
  }

  t128() {
    if (this.usedV128 === this.tmpV128.length) {
      this.tmpV128.push(this.c.declareLocal(T.v128));
    }
    return this.tmpV128[this.usedV128++];
  }

  tF32() {
    if (this.usedF32 === this.tmpF32.length) {
      this.tmpF32.push(this.c.declareLocal(T.f32));
    }
    return this.tmpF32[this.usedF32++];
  }

  tF64() {
    if (this.usedF64 === this.tmpF64.length) {
      this.tmpF64.push(this.c.declareLocal(T.f64));
    }
    return this.tmpF64[this.usedF64++];
  }

  // Locals that must survive to the next instruction (branch folding).
  persistent64() {
    return this.c.declareLocal(T.i64);
  }

  emitBlock() {
    const b = this.block;
    if (this.translator.traceBlocks) {
      this.addrConst(b.addr);
      this.c.call(this.ctx.imports.trace);
    }
    for (let i = 0; i < b.insns.length; i++) {
      const insn = b.insns[i];
      this.usedI64 = 0;
      this.usedI32 = 0;
      this.usedV128 = 0;
      this.usedF32 = 0;
      this.usedF64 = 0;
      this.next = BigInt.asUintN(64, insn.addr + BigInt(insn.len));
      const foldable = this.lastFlags !== null && this.lastFlags.index === i - 1;
      if (!foldable) {
        this.lastFlags = null;
      }
      try {
        this.emitInsn(insn, i);
      } catch (e) {
        if (e instanceof Unsupported) {
          this.ctx.unsupported.set(insn.addr, `${insn.mnemonic}: ${e.message}`);
          this.exit(EXIT.UNSUPPORTED, insn.addr);
          this.c.end();
          return;
        }
        throw e;
      }
    }
    if (b.decodeError !== null) {
      this.ctx.unsupported.set(b.end, `undecodable: ${b.decodeError}`);
      this.exit(EXIT.UNSUPPORTED, b.end);
    } else {
      const last = b.insns[b.insns.length - 1];
      if (!CONTROL.has(last.mnemonic) && !(last.cond !== undefined && last.mnemonic.startsWith("j"))) {
        // Cut by the size cap: continue at the next address.
        this.jumpTo(b.end);
      }
    }
    this.c.end();
  }

  // ---- addresses ----------------------------------------------------

  // Pushes a guest address as base + offset, so the code does not
  // depend on where the file was mapped.
  addrConst(addr) {
    const c = this.c;
    c.global_get(this.ctx.baseGlobal).i64_const(BigInt.asIntN(64, addr - this.ctx.base)).i64_add();
  }

  // ---- state access -------------------------------------------------

  getReg(reg, size, high = false) {
    const c = this.c;
    c.global_get(this.g[REGNAME[reg]]);
    if (high) {
      c.i64_const(8).i64_shr_u().i64_const(0xff).i64_and();
    } else if (size !== 8) {
      c.i64_const(MASK[size]).i64_and();
    }
  }

  // Stores the i64 on the stack, masked to size, into a register.
  setReg(reg, size, high = false) {
    const c = this.c;
    const gi = this.g[REGNAME[reg]];
    if (size === 8) {
      c.global_set(gi);
      return;
    }
    if (size === 4) {
      c.i64_const(MASK[4]).i64_and().global_set(gi);
      return;
    }
    const v = this.t64();
    c.local_set(v);
    if (high) {
      c.global_get(gi).i64_const(~0xff00n).i64_and();
      c.local_get(v).i64_const(0xff).i64_and().i64_const(8).i64_shl().i64_or();
    } else {
      c.global_get(gi).i64_const(~MASK[size]).i64_and();
      c.local_get(v).i64_const(MASK[size]).i64_and().i64_or();
    }
    c.global_set(gi);
  }

  // Pushes the effective address of a memory operand as i64.
  address(op) {
    const c = this.c;
    let pushed = false;
    if (op.ripRel) {
      // The decoder made the displacement absolute; it is relative to
      // the file again here.
      this.addrConst(op.disp);
      pushed = true;
    } else if (op.disp !== 0n || (op.base === null && op.index === null)) {
      c.i64_const(op.disp);
      pushed = true;
    }
    if (op.base !== null) {
      c.global_get(this.g[REGNAME[op.base]]);
      if (pushed) {
        c.i64_add();
      }
      pushed = true;
    }
    if (op.index !== null) {
      c.global_get(this.g[REGNAME[op.index]]);
      if (op.scale > 1) {
        c.i64_const(Math.log2(op.scale)).i64_shl();
      }
      if (pushed) {
        c.i64_add();
      }
      pushed = true;
    }
    if (op.seg === "fs") {
      c.global_get(this.g.fs_base).i64_add();
    } else if (op.seg === "gs") {
      c.global_get(this.g.gs_base).i64_add();
    }
  }

  // Pushes the address as i32 for a memory access.
  address32(op) {
    this.address(op);
    this.c.i32_wrap_i64();
  }

  loadMem(size) {
    const c = this.c;
    switch (size) {
      case 1: c.i64_load8_u(); break;
      case 2: c.i64_load16_u(0, 0); break;
      case 4: c.i64_load32_u(0, 0); break;
      case 8: c.i64_load(0, 0); break;
      default: throw new Unsupported(`load of ${size} bytes`);
    }
  }

  storeMem(size) {
    const c = this.c;
    switch (size) {
      case 1: c.i64_store8(); break;
      case 2: c.i64_store16(0, 0); break;
      case 4: c.i64_store32(0, 0); break;
      case 8: c.i64_store(0, 0); break;
      default: throw new Unsupported(`store of ${size} bytes`);
    }
  }

  // Pushes an operand's value as i64 zero-extended to its size.
  load(op, size = op.size) {
    const c = this.c;
    switch (op.kind) {
      case "reg":
        this.getReg(op.reg, size, op.high);
        return;
      case "imm":
        c.i64_const(BigInt.asUintN(size * 8, BigInt.asIntN(op.size * 8, op.value)));
        return;
      case "mem":
        this.address32(op);
        this.loadMem(size);
        return;
      default:
        throw new Unsupported(`operand kind ${op.kind}`);
    }
  }

  // Stores the i64 on the stack to an operand. For memory, the address
  // must already be in `addrLocal` (an i32 local), computed before the
  // value so the operand order matches wasm's store.
  store(op, size, addrLocal = null) {
    const c = this.c;
    if (op.kind === "reg") {
      this.setReg(op.reg, size, op.high);
      return;
    }
    if (op.kind === "mem") {
      const v = this.t64();
      c.local_set(v);
      c.local_get(addrLocal).local_get(v);
      this.storeMem(size);
      return;
    }
    throw new Unsupported(`store to ${op.kind}`);
  }

  // For read-modify-write on memory: evaluates the address once.
  prepareDest(op) {
    if (op.kind !== "mem") {
      return null;
    }
    const a = this.t32();
    this.address32(op);
    this.c.local_set(a);
    return a;
  }

  loadDest(op, size, addrLocal) {
    if (op.kind === "mem") {
      this.c.local_get(addrLocal);
      this.loadMem(size);
      return;
    }
    this.load(op, size);
  }

  mask(size) {
    if (size !== 8) {
      this.c.i64_const(MASK[size]).i64_and();
    }
  }

  signExtend(size) {
    const c = this.c;
    switch (size) {
      case 1: c.i64_extend8_s(); break;
      case 2: c.i64_extend16_s(); break;
      case 4: c.i64_extend32_s(); break;
      default: break;
    }
  }

  setFlags(kind, size, resLocal, srcLocal, src2Local = null) {
    const c = this.c;
    c.local_get(resLocal).global_set(this.g.cc_dst);
    if (srcLocal !== null) {
      c.local_get(srcLocal).global_set(this.g.cc_src);
    }
    if (src2Local !== null) {
      c.local_get(src2Local).global_set(this.g.cc_src2);
    }
    c.i32_const(ccOp(kind, size)).global_set(this.g.cc_op);
  }

  // Pushes ZF, SF and PF computed from a result local, as i32.
  zspFlags(res, size) {
    const c = this.c;
    c.local_get(res).i64_eqz().i32_const(6).i32_shl();
    c.local_get(res).i64_const(BigInt(BITS[size] - 1)).i64_shr_u().i32_wrap_i64().i32_const(1).i32_and().i32_const(7).i32_shl();
    c.i32_or();
    c.local_get(res).i64_const(0xff).i64_and().i64_popcnt().i32_wrap_i64().i32_const(1).i32_and().i32_const(1).i32_xor().i32_const(2).i32_shl();
    c.i32_or();
  }

  // Pushes the current EFLAGS (arithmetic bits) as i32.
  eflags() {
    this.c.call(this.ctx.helpers.cc_eflags);
  }

  // Stores an explicit EFLAGS value from the i32 on the stack.
  setEflags() {
    const c = this.c;
    c.i64_extend_i32_u().global_set(this.g.cc_src);
    c.i32_const(ccOp(CC.EFLAGS, 1)).global_set(this.g.cc_op);
  }

  // ---- control ------------------------------------------------------

  exit(reason, rip) {
    const c = this.c;
    this.addrConst(rip);
    c.global_set(this.g.rip);
    c.i32_const(reason).global_set(this.g.exit_reason);
    c.return_();
  }

  // Tail-calls the block at a constant address: directly when it is in
  // this region, else through the lookup at run time, so the module
  // holds no table slot and once the target is translated the edge
  // costs two loads rather than a trip through the run loop.
  jumpTo(target) {
    const c = this.c;
    const local = this.ctx.blocks.get(target);
    if (local !== undefined) {
      c.return_call(local.func);
      return;
    }
    this.addrConst(target);
    this.jumpIndirect();
  }

  // Tail-calls the block whose address is the i64 on the stack.
  jumpIndirect() {
    const c = this.c;
    const target = this.t64();
    const idx = this.t32();
    c.local_tee(target).call(this.ctx.helpers.lookup).local_tee(idx);
    c.i32_eqz().if_(T.empty);
    c.local_get(target).global_set(this.g.rip);
    c.i32_const(EXIT.MISS).global_set(this.g.exit_reason);
    c.return_();
    c.end();
    c.local_get(idx).return_call(this.ctx.helpers.jump);
  }

  // Pushes the i64 on the stack as `width` bytes (8, or 2 with an
  // operand-size prefix).
  push(width) {
    const c = this.c;
    const v = this.t64();
    c.local_set(v);
    c.global_get(this.g.rsp).i64_const(width).i64_sub().global_set(this.g.rsp);
    c.global_get(this.g.rsp).i32_wrap_i64().local_get(v);
    this.storeMem(width);
  }

  push64() {
    this.push(8);
  }

  pop(width) {
    const c = this.c;
    c.global_get(this.g.rsp).i32_wrap_i64();
    this.loadMem(width);
    c.global_get(this.g.rsp).i64_const(width).i64_add().global_set(this.g.rsp);
  }

  pop64() {
    this.pop(8);
  }

  // Pushes the condition's truth as i32, folding a preceding compare.
  condition(cond) {
    const c = this.c;
    const f = this.lastFlags;
    if (f !== null && this.foldCondition(cond, f)) {
      return;
    }
    c.i32_const(cond).call(this.ctx.helpers.cc_cond);
  }

  // Emits a direct comparison for the common shapes, or returns false.
  foldCondition(cond, f) {
    const c = this.c;
    const neg = cond & 1;
    const base = cond & ~1;
    const { size } = f;
    const a = f.a;
    const b = f.b;
    const res = f.res;
    const sext = (local) => {
      c.local_get(local);
      this.signExtend(size);
    };
    let done = false;
    if (f.kind === "cmp") {
      switch (base) {
        case 4: c.local_get(a).local_get(b).i64_eq(); done = true; break; // e
        case 2: c.local_get(a).local_get(b).i64_lt_u(); done = true; break; // b
        case 6: c.local_get(a).local_get(b).i64_le_u(); done = true; break; // be
        case 12: sext(a); sext(b); c.i64_lt_s(); done = true; break; // l
        case 14: sext(a); sext(b); c.i64_le_s(); done = true; break; // le
        case 8: c.local_get(res); this.signExtend(size); c.i64_const(0).i64_lt_s(); done = true; break; // s
        default: break;
      }
    } else if (f.kind === "test") {
      switch (base) {
        case 4: c.local_get(res).i64_eqz(); done = true; break; // e
        case 8: c.local_get(res); this.signExtend(size); c.i64_const(0).i64_lt_s(); done = true; break; // s
        case 12: c.local_get(res); this.signExtend(size); c.i64_const(0).i64_lt_s(); done = true; break; // l: sf^of, of=0
        case 14: c.local_get(res); this.signExtend(size); c.i64_const(0).i64_le_s(); done = true; break; // le
        case 2: c.i32_const(0); done = true; break; // b: cf = 0
        case 6: c.local_get(res).i64_eqz(); done = true; break; // be: zf
        default: break;
      }
    } else if (f.kind === "arith") {
      switch (base) {
        case 4: c.local_get(res).i64_eqz(); done = true; break;
        case 8: c.local_get(res); this.signExtend(size); c.i64_const(0).i64_lt_s(); done = true; break;
        default: break;
      }
    }
    if (!done) {
      return false;
    }
    if (neg) {
      c.i32_eqz();
    }
    return true;
  }

  // ---- instructions -------------------------------------------------

  emitInsn(insn, index) {
    const c = this.c;
    const m = insn.mnemonic;
    const ops = insn.operands;
    const size = ops.length > 0 && ops[0].size ? ops[0].size : insn.opsize;

    switch (m) {
      case "nop":
      case "endbr64":
      case "endbr32":
      case "pause":
      case "lfence":
      case "mfence":
      case "sfence":
      case "prefetch":
      case "prefetchw":
      case "prefetchnta":
      case "prefetcht0":
      case "prefetcht1":
      case "prefetcht2":
      case "fwait":
      // The CET shadow-stack instructions are no-ops on a CPU without
      // CET, which is the CPU the guest is told it has.
      case "rdsspq":
      case "incsspq":
      case "saveprevssp":
      case "rstorssp":
        return;

      case "hlt":
        this.exit(EXIT.HLT, insn.addr);
        return;
      case "ud2":
      case "int3":
      case "int":
      case "ud0":
      case "ud1":
        this.exit(EXIT.TRAP, insn.addr);
        return;

      case "mov":
        return this.emitMov(insn, ops, size);
      case "movzx":
        this.load(ops[1]);
        this.setReg(ops[0].reg, ops[0].size);
        return;
      case "movsx":
      case "movsxd":
        this.load(ops[1]);
        this.signExtend(ops[1].size);
        this.mask(ops[0].size);
        this.setReg(ops[0].reg, ops[0].size);
        return;
      case "lea":
        this.address(ops[1]);
        this.mask(ops[0].size);
        this.setReg(ops[0].reg, ops[0].size);
        return;
      case "xchg":
        return this.emitXchg(ops, size);

      case "add":
      case "sub":
      case "and":
      case "or":
      case "xor":
      case "cmp":
      case "test":
      case "adc":
      case "sbb":
        return this.emitAlu(m, ops, size, index);

      case "inc":
      case "dec":
        return this.emitIncDec(m, ops, size, index);
      case "neg":
        return this.emitNeg(ops, size, index);
      case "not": {
        const a = this.prepareDest(ops[0]);
        this.loadDest(ops[0], size, a);
        c.i64_const(-1n).i64_xor();
        this.mask(size);
        this.store(ops[0], size, a);
        return;
      }

      case "shl":
      case "shr":
      case "sar":
        return this.emitShift(m, ops, size);
      case "rol":
      case "ror":
        return this.emitRotate(m, ops, size);
      case "rcl":
      case "rcr":
        return this.emitRotateCarry(m, ops, size);
      case "shld":
      case "shrd":
        return this.emitDoubleShift(m, ops, size);

      case "imul":
        return this.emitImul(ops, size, insn);
      case "mul":
        return this.emitMul(ops, size);
      case "div":
      case "idiv":
        return this.emitDiv(m, ops, size);

      case "cbw":
        this.getReg(REG.rax, 1);
        c.i64_extend8_s();
        this.setReg(REG.rax, 2);
        return;
      case "cwde":
        this.getReg(REG.rax, 2);
        c.i64_extend16_s();
        this.setReg(REG.rax, 4);
        return;
      case "cdqe":
        this.getReg(REG.rax, 4);
        c.i64_extend32_s();
        this.setReg(REG.rax, 8);
        return;
      case "cwd":
        this.getReg(REG.rax, 2);
        c.i64_extend16_s().i64_const(16).i64_shr_s();
        this.setReg(REG.rdx, 2);
        return;
      case "cdq":
        this.getReg(REG.rax, 4);
        c.i64_extend32_s().i64_const(32).i64_shr_s();
        this.setReg(REG.rdx, 4);
        return;
      case "cqo":
        this.getReg(REG.rax, 8);
        c.i64_const(63).i64_shr_s();
        this.setReg(REG.rdx, 8);
        return;

      case "push": {
        const width = insn.opsize === 2 ? 2 : 8;
        if (ops[0].kind === "imm") {
          c.i64_const(BigInt.asUintN(64, BigInt.asIntN(ops[0].size * 8, ops[0].value)));
        } else {
          this.load(ops[0], width);
        }
        this.push(width);
        return;
      }
      case "pop": {
        const width = insn.opsize === 2 ? 2 : 8;
        const a = this.prepareDest(ops[0]);
        this.pop(width);
        this.store(ops[0], width, a);
        return;
      }
      case "leave":
        c.global_get(this.g.rbp).global_set(this.g.rsp);
        this.pop64();
        c.global_set(this.g.rbp);
        return;
      case "pushf":
        this.eflags();
        c.i64_extend_i32_u();
        c.i64_const(0x202n).i64_or(); // IF and the reserved bit 1
        c.global_get(this.g.df).i64_extend_i32_u().i64_const(10).i64_shl().i64_or();
        this.push64();
        return;
      case "popf": {
        const v = this.t64();
        this.pop64();
        c.local_tee(v).i64_const(10).i64_shr_u().i32_wrap_i64().i32_const(1).i32_and().global_set(this.g.df);
        c.local_get(v).i32_wrap_i64().i32_const(0x8d5).i32_and();
        this.setEflags();
        return;
      }
      case "sahf": {
        // AH -> SF ZF AF PF CF; keep OF.
        const f = this.t32();
        this.eflags();
        c.i32_const(0x800).i32_and().local_set(f);
        this.getReg(REG.rax, 1, true);
        c.i32_wrap_i64().i32_const(0xd5).i32_and().local_get(f).i32_or();
        this.setEflags();
        return;
      }
      case "lahf":
        this.eflags();
        c.i32_const(0xd5).i32_and().i32_const(2).i32_or().i64_extend_i32_u();
        this.setReg(REG.rax, 1, true);
        return;
      case "clc":
      case "stc":
      case "cmc": {
        this.eflags();
        if (m === "clc") {
          c.i32_const(~1).i32_and();
        } else if (m === "stc") {
          c.i32_const(1).i32_or();
        } else {
          c.i32_const(1).i32_xor();
        }
        this.setEflags();
        return;
      }
      case "cld":
        c.i32_const(0).global_set(this.g.df);
        return;
      case "std":
        c.i32_const(1).global_set(this.g.df);
        return;

      case "jmp":
        if (ops[0].kind === "rel") {
          this.jumpTo(ops[0].target);
        } else {
          this.load(ops[0], 8);
          this.jumpIndirect();
        }
        return;
      case "call":
        if (ops[0].kind === "rel") {
          this.addrConst(this.next);
          this.push64();
          this.jumpTo(ops[0].target);
        } else {
          const t = this.t64();
          this.load(ops[0], 8);
          c.local_set(t);
          this.addrConst(this.next);
          this.push64();
          c.local_get(t);
          this.jumpIndirect();
        }
        return;
      case "ret":
        this.pop64();
        if (ops.length > 0) {
          const t = this.t64();
          c.local_set(t);
          c.global_get(this.g.rsp).i64_const(ops[0].value).i64_add().global_set(this.g.rsp);
          c.local_get(t);
        }
        this.jumpIndirect();
        return;
      case "syscall":
        this.addrConst(this.next);
        c.global_set(this.g.rip);
        c.call(this.ctx.imports.syscall);
        c.global_get(this.g.rip);
        this.jumpIndirect();
        return;
      case "cpuid":
        c.call(this.ctx.imports.cpuid);
        return;
      case "rdtsc":
        c.call(this.ctx.imports.rdtsc);
        return;
      case "xgetbv":
        // XCR0: x87 and SSE state enabled.
        c.i64_const(3).global_set(this.g.rax);
        c.i64_const(0).global_set(this.g.rdx);
        return;

      case "jrcxz":
        c.global_get(this.g.rcx).i64_eqz().if_(T.empty).return_call(this.blockFunc(ops[0].target)).end();
        this.jumpTo(this.next);
        return;
      case "loop":
        c.global_get(this.g.rcx).i64_const(1).i64_sub().global_set(this.g.rcx);
        c.global_get(this.g.rcx).i64_eqz().i32_eqz().if_(T.empty).return_call(this.blockFunc(ops[0].target)).end();
        this.jumpTo(this.next);
        return;

      case "movs":
      case "stos":
      case "lods":
      case "scas":
      case "cmps":
        return this.emitString(m, insn, ops);

      case "bt":
      case "bts":
      case "btr":
      case "btc":
        return this.emitBitTest(m, ops, size);
      case "bsf":
      case "bsr":
      case "tzcnt":
      case "lzcnt":
      case "popcnt":
        return this.emitBitScan(m, ops, size);
      case "bswap":
        return this.emitBswap(ops);
      case "cmpxchg":
        return this.emitCmpxchg(ops, size, index);
      case "xadd":
        return this.emitXadd(ops, size, index);
      case "cmovo": case "cmovno": case "cmovb": case "cmovae": case "cmove": case "cmovne":
      case "cmovbe": case "cmova": case "cmovs": case "cmovns": case "cmovp": case "cmovnp":
      case "cmovl": case "cmovge": case "cmovle": case "cmovg": {
        const v = this.t64();
        const cond = this.t32();
        this.condition(insn.cond);
        c.local_set(cond);
        // The source is read either way, as the hardware does.
        this.load(ops[1]);
        c.local_set(v);
        c.local_get(cond).if_(T.empty);
        c.local_get(v);
        this.setReg(ops[0].reg, size);
        c.else_();
        if (size === 4) {
          // A 32-bit cmov clears the upper half even when not taken.
          this.getReg(ops[0].reg, 4);
          this.setReg(ops[0].reg, 4);
        }
        c.end();
        return;
      }
      case "seto": case "setno": case "setb": case "setae": case "sete": case "setne":
      case "setbe": case "seta": case "sets": case "setns": case "setp": case "setnp":
      case "setl": case "setge": case "setle": case "setg": {
        const a = this.prepareDest(ops[0]);
        this.condition(insn.cond);
        c.i64_extend_i32_u();
        this.store(ops[0], 1, a);
        return;
      }
      case "andn":
      case "bzhi":
      case "shlx":
      case "shrx":
      case "sarx":
      case "rorx":
      case "blsr":
      case "blsmsk":
      case "blsi":
      case "bextr":
      case "pext":
      case "pdep":
      case "mulx":
        return this.emitBmi(m, ops, size);
      case "movbe": {
        if (ops[0].kind === "reg") {
          this.load(ops[1]);
          this.bswapStack(ops[1].size);
          this.setReg(ops[0].reg, ops[0].size);
        } else {
          const a = this.prepareDest(ops[0]);
          this.load(ops[1]);
          this.bswapStack(ops[1].size);
          this.store(ops[0], ops[0].size, a);
        }
        return;
      }
      case "enter": {
        // enter imm16, 0: push rbp; mov rbp, rsp; sub rsp, imm16
        c.global_get(this.g.rbp);
        this.push64();
        c.global_get(this.g.rsp).global_set(this.g.rbp);
        c.global_get(this.g.rsp).i64_const(ops[0].value).i64_sub().global_set(this.g.rsp);
        return;
      }
      default:
        break;
    }

    if (insn.cond !== undefined && m.startsWith("j")) {
      this.condition(insn.cond);
      c.if_(T.empty).return_call(this.blockFunc(ops[0].target)).end();
      this.jumpTo(this.next);
      return;
    }

    const simd = this.emitSimd(insn, ops);
    if (simd) {
      return;
    }
    const fpu = this.emitX87(insn, ops);
    if (fpu) {
      return;
    }
    throw new Unsupported("no translation");
  }

  // A direct jump target for use in `if` arms: returns a function index
  // in this module, or emits the fallback and returns a trampoline.
  blockFunc(target) {
    const local = this.ctx.blocks.get(target);
    if (local !== undefined) {
      return local.func;
    }
    // Emit a helper-less path: look up at run time inside the if arm.
    // Simplest is a small local function per target; instead the
    // caller's `if` is restructured here by emitting the jump inline.
    return this.trampoline(target);
  }

  // A function in this module that jumps to `target` through the table,
  // so conditional branches to blocks outside the region can still use
  // return_call. Its index is reserved now and the body added after
  // every block's.
  trampoline(target) {
    const ctx = this.ctx;
    let t = ctx.trampolines.get(target);
    if (t !== undefined) {
      return t.index;
    }
    const c = new Code(0);
    const e = new Emitter(this.translator, ctx, c, this.block);
    e.jumpTo(target);
    c.end();
    t = { index: ctx.nextTrampoline++, code: c };
    ctx.trampolines.set(target, t);
    return t.index;
  }

  emitMov(insn, ops, size) {
    const c = this.c;
    const [dst, src] = ops;
    if (dst.kind === "sreg" || src.kind === "sreg" || dst.kind === "creg" || src.kind === "creg") {
      throw new Unsupported("segment or control register move");
    }
    if (dst.kind === "reg") {
      this.load(src, size);
      this.setReg(dst.reg, size, dst.high);
      return;
    }
    const a = this.prepareDest(dst);
    this.load(src, size);
    this.store(dst, size, a);
  }

  emitXchg(ops, size) {
    const c = this.c;
    const [x, y] = ops;
    const vx = this.t64();
    const vy = this.t64();
    const a = this.prepareDest(x);
    this.loadDest(x, size, a);
    c.local_set(vx);
    this.load(y, size);
    c.local_set(vy);
    c.local_get(vy);
    this.store(x, size, a);
    c.local_get(vx);
    this.store(y, size, null);
  }

  emitAlu(m, ops, size, index) {
    const c = this.c;
    const [dst, src] = ops;
    const a = this.prepareDest(dst);
    const va = this.persistent64();
    const vb = this.persistent64();
    const res = this.persistent64();
    this.loadDest(dst, size, a);
    c.local_set(va);
    this.load(src, size);
    c.local_set(vb);
    let kind;
    let carry = null;
    switch (m) {
      case "add":
        c.local_get(va).local_get(vb).i64_add();
        kind = CC.ADD;
        break;
      case "sub":
      case "cmp":
        c.local_get(va).local_get(vb).i64_sub();
        kind = CC.SUB;
        break;
      case "and":
      case "test":
        c.local_get(va).local_get(vb).i64_and();
        kind = CC.LOGIC;
        break;
      case "or":
        c.local_get(va).local_get(vb).i64_or();
        kind = CC.LOGIC;
        break;
      case "xor":
        c.local_get(va).local_get(vb).i64_xor();
        kind = CC.LOGIC;
        break;
      case "adc":
      case "sbb":
        carry = this.persistent64();
        this.eflags();
        c.i32_const(1).i32_and().i64_extend_i32_u().local_set(carry);
        c.local_get(va).local_get(vb);
        if (m === "adc") {
          c.i64_add().local_get(carry).i64_add();
          kind = CC.ADC;
        } else {
          c.i64_sub().local_get(carry).i64_sub();
          kind = CC.SBB;
        }
        break;
      default:
        throw new Unsupported(m);
    }
    this.mask(size);
    c.local_set(res);
    if (m !== "cmp" && m !== "test") {
      c.local_get(res);
      this.store(dst, size, a);
    }
    this.setFlags(kind, size, res, vb, carry);
    const foldKind = m === "cmp" || m === "sub" ? "cmp" : m === "test" || m === "and" ? "test" : kind === CC.LOGIC || kind === CC.ADD ? "arith" : null;
    if (foldKind !== null) {
      this.lastFlags = { index, kind: foldKind, size, a: va, b: vb, res };
    }
  }

  emitIncDec(m, ops, size, index) {
    const c = this.c;
    const a = this.prepareDest(ops[0]);
    const res = this.persistent64();
    const cf = this.t64();
    this.eflags();
    c.i32_const(1).i32_and().i64_extend_i32_u().local_set(cf);
    this.loadDest(ops[0], size, a);
    c.i64_const(1);
    if (m === "inc") {
      c.i64_add();
    } else {
      c.i64_sub();
    }
    this.mask(size);
    c.local_tee(res);
    this.store(ops[0], size, a);
    this.setFlags(m === "inc" ? CC.INC : CC.DEC, size, res, cf);
    this.lastFlags = { index, kind: "arith", size, res };
  }

  emitNeg(ops, size, index) {
    const c = this.c;
    const a = this.prepareDest(ops[0]);
    const vb = this.persistent64();
    const res = this.persistent64();
    const zero = this.t64();
    c.i64_const(0).local_set(zero);
    this.loadDest(ops[0], size, a);
    c.local_set(vb);
    c.i64_const(0).local_get(vb).i64_sub();
    this.mask(size);
    c.local_tee(res);
    this.store(ops[0], size, a);
    this.setFlags(CC.SUB, size, res, vb);
    this.lastFlags = { index, kind: "cmp", size, a: zero, b: vb, res };
  }

  emitShift(m, ops, size) {
    const c = this.c;
    const [dst, cnt] = ops;
    const a = this.prepareDest(dst);
    const count = this.t64();
    const val = this.t64();
    const res = this.t64();
    const cf = this.t64();
    this.load(cnt, 1);
    c.i64_const(size === 8 ? 63n : 31n).i64_and().local_set(count);
    this.loadDest(dst, size, a);
    c.local_set(val);
    // A zero count changes nothing, flags included.
    c.local_get(count).i64_eqz().i32_eqz().if_(T.empty);
    if (m === "shl") {
      c.local_get(val).local_get(count).i64_shl();
      this.mask(size);
      c.local_set(res);
      // cf = bit (bits - count) of val
      c.local_get(val).i64_const(BITS[size]).local_get(count).i64_sub().i64_shr_u().i64_const(1).i64_and().local_set(cf);
    } else if (m === "shr") {
      c.local_get(val).local_get(count).i64_shr_u().local_set(res);
      c.local_get(val).local_get(count).i64_const(1).i64_sub().i64_shr_u().i64_const(1).i64_and().local_set(cf);
    } else {
      c.local_get(val);
      this.signExtend(size);
      c.local_get(count).i64_shr_s();
      this.mask(size);
      c.local_set(res);
      c.local_get(val);
      this.signExtend(size);
      c.local_get(count).i64_const(1).i64_sub().i64_shr_s().i64_const(1).i64_and().local_set(cf);
    }
    c.local_get(res);
    this.store(dst, size, a);
    this.setFlags(m === "shl" ? CC.SHL : m === "shr" ? CC.SHR : CC.SAR, size, res, cf, val);
    c.end();
    this.lastFlags = null;
  }

  emitRotate(m, ops, size) {
    const c = this.c;
    const [dst, cnt] = ops;
    const a = this.prepareDest(dst);
    const count = this.t64();
    const val = this.t64();
    const res = this.t64();
    const f = this.t32();
    this.load(cnt, 1);
    c.i64_const(size === 8 ? 63n : 31n).i64_and();
    if (size < 4) {
      c.i64_const(BigInt(BITS[size] - 1)).i64_and();
    }
    c.local_set(count);
    this.loadDest(dst, size, a);
    c.local_set(val);
    c.local_get(count).i64_eqz().i32_eqz().if_(T.empty);
    if (size === 8) {
      c.local_get(val).local_get(count);
      if (m === "rol") {
        c.i64_rotl();
      } else {
        c.i64_rotr();
      }
      c.local_set(res);
    } else {
      // (val << c | val >> (bits - c)) masked, or the mirror for ror.
      const bits = BigInt(BITS[size]);
      if (m === "rol") {
        c.local_get(val).local_get(count).i64_shl();
        c.local_get(val).i64_const(bits).local_get(count).i64_sub().i64_shr_u().i64_or();
      } else {
        c.local_get(val).local_get(count).i64_shr_u();
        c.local_get(val).i64_const(bits).local_get(count).i64_sub().i64_shl().i64_or();
      }
      this.mask(size);
      c.local_set(res);
    }
    c.local_get(res);
    this.store(dst, size, a);
    // CF is the bit rotated across; OF, defined for a count of 1, is
    // msb ^ CF for rol and msb ^ (msb - 1) for ror. Other flags keep
    // their values.
    const cf = this.t32();
    const msb = this.t32();
    this.eflags();
    c.i32_const(~0x801).i32_and().local_set(f);
    c.local_get(res).i64_const(BigInt(BITS[size] - 1)).i64_shr_u().i32_wrap_i64().i32_const(1).i32_and().local_set(msb);
    if (m === "rol") {
      c.local_get(res).i32_wrap_i64().i32_const(1).i32_and().local_set(cf);
      c.local_get(msb).local_get(cf).i32_xor();
    } else {
      c.local_get(msb).local_set(cf);
      c.local_get(res).i64_const(BigInt(BITS[size] - 2)).i64_shr_u().i32_wrap_i64().i32_const(1).i32_and().local_get(msb).i32_xor();
    }
    c.i32_const(11).i32_shl().local_get(cf).i32_or().local_get(f).i32_or();
    this.setEflags();
    c.end();
    this.lastFlags = null;
  }

  // Rotate through carry: the value and CF form a (bits + 1)-bit ring.
  emitRotateCarry(m, ops, size) {
    const c = this.c;
    const [dst, cnt] = ops;
    const a = this.prepareDest(dst);
    const count = this.t64();
    const val = this.t64();
    const res = this.t64();
    const cfIn = this.t64();
    const cf = this.t32();
    const f = this.t32();
    const bits = BigInt(BITS[size]);
    this.load(cnt, 1);
    c.i64_const(size === 8 ? 63n : 31n).i64_and();
    if (size < 4) {
      c.i64_const(bits + 1n).i64_rem_u();
    }
    c.local_set(count);
    this.eflags();
    c.i32_const(1).i32_and().i64_extend_i32_u().local_set(cfIn);
    this.loadDest(dst, size, a);
    c.local_set(val);
    c.local_get(count).i64_eqz().i32_eqz().if_(T.empty);
    if (m === "rcl") {
      // res = val << c | cf << (c-1) | val >> (bits + 1 - c); CF = bit (bits - c) of val
      c.local_get(val).local_get(count).i64_shl();
      c.local_get(cfIn).local_get(count).i64_const(1).i64_sub().i64_shl().i64_or();
      // The wrapped-around part exists only for counts of 2 and up; at
      // 1 its shift would be the full width, which wasm reads as none.
      c.local_get(count).i64_const(1).i64_gt_u().if_(T.i64);
      c.local_get(val).i64_const(bits + 1n).local_get(count).i64_sub().i64_shr_u();
      c.else_().i64_const(0).end();
      c.i64_or();
      this.mask(size);
      c.local_set(res);
      c.local_get(val).i64_const(bits).local_get(count).i64_sub().i64_shr_u().i32_wrap_i64().i32_const(1).i32_and().local_set(cf);
    } else {
      // res = val >> c | cf << (bits - c) | val << (bits + 1 - c); CF = bit (c-1) of val
      c.local_get(val).local_get(count).i64_shr_u();
      c.local_get(cfIn).i64_const(bits).local_get(count).i64_sub().i64_shl().i64_or();
      c.local_get(count).i64_const(1).i64_gt_u().if_(T.i64);
      c.local_get(val).i64_const(bits + 1n).local_get(count).i64_sub().i64_shl();
      c.else_().i64_const(0).end();
      c.i64_or();
      this.mask(size);
      c.local_set(res);
      c.local_get(val).local_get(count).i64_const(1).i64_sub().i64_shr_u().i32_wrap_i64().i32_const(1).i32_and().local_set(cf);
    }
    c.local_get(res);
    this.store(dst, size, a);
    // OF (count 1): rcl msb ^ CF; rcr msb ^ (msb - 1). Other flags kept.
    const msb = this.t32();
    this.eflags();
    c.i32_const(~0x801).i32_and().local_set(f);
    c.local_get(res).i64_const(bits - 1n).i64_shr_u().i32_wrap_i64().i32_const(1).i32_and().local_set(msb);
    if (m === "rcl") {
      c.local_get(msb).local_get(cf).i32_xor();
    } else {
      c.local_get(res).i64_const(bits - 2n).i64_shr_u().i32_wrap_i64().i32_const(1).i32_and().local_get(msb).i32_xor();
    }
    c.i32_const(11).i32_shl().local_get(cf).i32_or().local_get(f).i32_or();
    this.setEflags();
    c.end();
    this.lastFlags = null;
  }

  emitDoubleShift(m, ops, size) {
    const c = this.c;
    const [dst, src, cnt] = ops;
    const a = this.prepareDest(dst);
    const count = this.t64();
    const val = this.t64();
    const other = this.t64();
    const res = this.t64();
    const cf = this.t64();
    this.load(cnt, 1);
    c.i64_const(size === 8 ? 63n : 31n).i64_and().local_set(count);
    this.loadDest(dst, size, a);
    c.local_set(val);
    this.load(src, size);
    c.local_set(other);
    c.local_get(count).i64_eqz().i32_eqz().if_(T.empty);
    const bits = BigInt(BITS[size]);
    if (m === "shld") {
      // res = val << c | other >> (bits - c); CF = bit (bits - c) of val
      c.local_get(val).local_get(count).i64_shl();
      c.local_get(other).i64_const(bits).local_get(count).i64_sub().i64_shr_u().i64_or();
      this.mask(size);
      c.local_set(res);
      c.local_get(val).i64_const(bits).local_get(count).i64_sub().i64_shr_u().i64_const(1).i64_and().local_set(cf);
    } else {
      // res = val >> c | other << (bits - c); CF = bit (c - 1) of val
      c.local_get(val).local_get(count).i64_shr_u();
      c.local_get(other).i64_const(bits).local_get(count).i64_sub().i64_shl().i64_or();
      this.mask(size);
      c.local_set(res);
      c.local_get(val).local_get(count).i64_const(1).i64_sub().i64_shr_u().i64_const(1).i64_and().local_set(cf);
    }
    c.local_get(res);
    this.store(dst, size, a);
    // ZF, SF, PF from the result, CF as computed, OF = the sign changed.
    this.zspFlags(res, size);
    c.local_get(cf).i32_wrap_i64().i32_or();
    c.local_get(val).local_get(res).i64_xor().i64_const(bits - 1n).i64_shr_u().i32_wrap_i64().i32_const(1).i32_and().i32_const(11).i32_shl().i32_or();
    this.setEflags();
    c.end();
    this.lastFlags = null;
  }

  emitImul(ops, size, insn) {
    const c = this.c;
    if (ops.length === 1) {
      // rdx:rax = rax * src, signed
      const src = this.t64();
      const lo = this.t64();
      const hi = this.t64();
      this.load(ops[0], size);
      this.signExtend(size);
      c.local_set(src);
      this.getReg(REG.rax, size);
      this.signExtend(size);
      if (size === 8) {
        const ra = this.t64();
        c.local_tee(ra).local_get(src).i64_mul().local_set(lo);
        c.local_get(ra).local_get(src).call(this.ctx.helpers.mulhs).local_set(hi);
        c.local_get(lo).global_set(this.g.rax);
        c.local_get(hi).global_set(this.g.rdx);
        // overflow iff hi != lo >> 63
        c.local_get(hi).local_get(lo).i64_const(63).i64_shr_s().i64_ne().i64_extend_i32_u();
      } else {
        const full = this.t64();
        c.local_get(src).i64_mul().local_set(full);
        c.local_get(full);
        this.mask(size);
        c.local_set(lo);
        c.local_get(full).i64_const(BigInt(BITS[size])).i64_shr_s();
        this.mask(size);
        c.local_set(hi);
        if (size === 1) {
          c.local_get(full);
          this.mask(2);
          this.setReg(REG.rax, 2);
        } else {
          c.local_get(lo);
          this.setReg(REG.rax, size);
          c.local_get(hi);
          this.setReg(REG.rdx, size);
        }
        // overflow iff full != sext(lo)
        c.local_get(full);
        c.local_get(lo);
        this.signExtend(size);
        c.i64_ne().i64_extend_i32_u();
      }
      const ov = this.t64();
      c.local_set(ov);
      this.setFlags(CC.MUL, size, lo, ov);
      return;
    }
    // Two and three operand forms: dst = src1 * src2 (truncated)
    const src1 = ops.length === 3 ? ops[1] : ops[0];
    const src2 = ops.length === 3 ? ops[2] : ops[1];
    const a = this.t64();
    const b = this.t64();
    const res = this.t64();
    const ov = this.t64();
    this.load(src1, size);
    this.signExtend(size);
    c.local_set(a);
    this.load(src2, size);
    this.signExtend(size);
    c.local_set(b);
    if (size === 8) {
      c.local_get(a).local_get(b).i64_mul().local_tee(res);
      this.setReg(ops[0].reg, 8);
      c.local_get(a).local_get(b).call(this.ctx.helpers.mulhs);
      c.local_get(res).i64_const(63).i64_shr_s().i64_ne().i64_extend_i32_u().local_set(ov);
    } else {
      const full = this.t64();
      c.local_get(a).local_get(b).i64_mul().local_tee(full);
      this.mask(size);
      c.local_tee(res);
      this.setReg(ops[0].reg, size);
      c.local_get(full);
      c.local_get(res);
      this.signExtend(size);
      c.i64_ne().i64_extend_i32_u().local_set(ov);
    }
    this.setFlags(CC.MUL, size, res, ov);
  }

  emitMul(ops, size) {
    const c = this.c;
    const src = this.t64();
    const lo = this.t64();
    const hi = this.t64();
    this.load(ops[0], size);
    c.local_set(src);
    if (size === 8) {
      c.global_get(this.g.rax).local_get(src).call(this.ctx.helpers.mulhu).local_set(hi);
      c.global_get(this.g.rax).local_get(src).i64_mul().local_set(lo);
      c.local_get(lo).global_set(this.g.rax);
      c.local_get(hi).global_set(this.g.rdx);
    } else {
      const full = this.t64();
      this.getReg(REG.rax, size);
      c.local_get(src).i64_mul().local_set(full);
      c.local_get(full);
      this.mask(size);
      c.local_set(lo);
      c.local_get(full).i64_const(BigInt(BITS[size])).i64_shr_u().local_set(hi);
      if (size === 1) {
        c.local_get(full);
        this.setReg(REG.rax, 2);
      } else {
        c.local_get(lo);
        this.setReg(REG.rax, size);
        c.local_get(hi);
        this.setReg(REG.rdx, size);
      }
    }
    this.setFlags(CC.MUL, size, lo, hi);
  }

  emitDiv(m, ops, size) {
    const c = this.c;
    const signed = m === "idiv";
    const d = this.t64();
    this.load(ops[0], size);
    if (signed) {
      this.signExtend(size);
    }
    c.local_set(d);
    if (size === 8) {
      // Fast path when the high half is the extension of the low half.
      const q = this.t64();
      c.global_get(this.g.rdx);
      if (signed) {
        c.global_get(this.g.rax).i64_const(63).i64_shr_s().i64_eq();
      } else {
        c.i64_eqz();
      }
      c.if_(T.empty);
      c.global_get(this.g.rax).local_get(d);
      if (signed) {
        c.i64_div_s();
      } else {
        c.i64_div_u();
      }
      c.local_set(q);
      c.global_get(this.g.rax).local_get(d);
      if (signed) {
        c.i64_rem_s();
      } else {
        c.i64_rem_u();
      }
      c.global_set(this.g.rdx);
      c.local_get(q).global_set(this.g.rax);
      c.else_();
      c.local_get(d).global_set(this.g.cc_src2);
      c.i32_const(signed ? 1 : 0).call(this.ctx.imports.div128);
      c.end();
      return;
    }
    // Narrower: the dividend fits in i64.
    const n = this.t64();
    const q = this.t64();
    if (size === 1) {
      this.getReg(REG.rax, 2);
      if (signed) {
        c.i64_extend16_s();
      }
    } else {
      this.getReg(REG.rdx, size);
      c.i64_const(BigInt(BITS[size])).i64_shl();
      this.getReg(REG.rax, size);
      c.i64_or();
      if (size === 4 && signed) {
        // already 64 bits wide
      } else if (signed) {
        c.i64_extend32_s();
      }
    }
    c.local_set(n);
    c.local_get(n).local_get(d);
    if (signed) {
      c.i64_div_s();
    } else {
      c.i64_div_u();
    }
    c.local_set(q);
    c.local_get(n).local_get(d);
    if (signed) {
      c.i64_rem_s();
    } else {
      c.i64_rem_u();
    }
    if (size === 1) {
      this.setReg(REG.rax, 1, true);
      c.local_get(q);
      this.setReg(REG.rax, 1);
    } else {
      this.setReg(REG.rdx, size);
      c.local_get(q);
      this.setReg(REG.rax, size);
    }
  }

  emitString(m, insn, ops) {
    const c = this.c;
    const size = ops[0].size;
    const step = BigInt(size);
    // delta = df ? -size : size
    const delta = this.t64();
    c.global_get(this.g.df).if_(T.i64).i64_const(-step).else_().i64_const(step).end().local_set(delta);
    const body = () => {
      switch (m) {
        case "movs":
          c.global_get(this.g.rdi).i32_wrap_i64();
          c.global_get(this.g.rsi).i32_wrap_i64();
          this.loadMem(size);
          this.storeMem(size);
          c.global_get(this.g.rsi).local_get(delta).i64_add().global_set(this.g.rsi);
          c.global_get(this.g.rdi).local_get(delta).i64_add().global_set(this.g.rdi);
          break;
        case "stos":
          c.global_get(this.g.rdi).i32_wrap_i64();
          this.getReg(REG.rax, size);
          this.storeMem(size);
          c.global_get(this.g.rdi).local_get(delta).i64_add().global_set(this.g.rdi);
          break;
        case "lods":
          c.global_get(this.g.rsi).i32_wrap_i64();
          this.loadMem(size);
          this.setReg(REG.rax, size);
          c.global_get(this.g.rsi).local_get(delta).i64_add().global_set(this.g.rsi);
          break;
        case "scas": {
          // cmp rax, [rdi]
          const va = this.t64();
          const vb = this.t64();
          const res = this.t64();
          this.getReg(REG.rax, size);
          c.local_set(va);
          c.global_get(this.g.rdi).i32_wrap_i64();
          this.loadMem(size);
          c.local_set(vb);
          c.local_get(va).local_get(vb).i64_sub();
          this.mask(size);
          c.local_set(res);
          this.setFlags(CC.SUB, size, res, vb);
          c.global_get(this.g.rdi).local_get(delta).i64_add().global_set(this.g.rdi);
          break;
        }
        case "cmps": {
          // cmp [rsi], [rdi]
          const va = this.t64();
          const vb = this.t64();
          const res = this.t64();
          c.global_get(this.g.rsi).i32_wrap_i64();
          this.loadMem(size);
          c.local_set(va);
          c.global_get(this.g.rdi).i32_wrap_i64();
          this.loadMem(size);
          c.local_set(vb);
          c.local_get(va).local_get(vb).i64_sub();
          this.mask(size);
          c.local_set(res);
          this.setFlags(CC.SUB, size, res, vb);
          c.global_get(this.g.rsi).local_get(delta).i64_add().global_set(this.g.rsi);
          c.global_get(this.g.rdi).local_get(delta).i64_add().global_set(this.g.rdi);
          break;
        }
        default:
          throw new Unsupported(m);
      }
    };
    if (!insn.rep && !insn.repne) {
      body();
      return;
    }
    // rep: while rcx != 0 { body; rcx--; [break on ZF condition] }
    c.block(T.empty).loop(T.empty);
    c.global_get(this.g.rcx).i64_eqz().br_if(1);
    body();
    c.global_get(this.g.rcx).i64_const(1).i64_sub().global_set(this.g.rcx);
    if (m === "scas" || m === "cmps") {
      // repe stops when ZF clears, repne when ZF sets.
      c.global_get(this.g.cc_dst).i64_eqz();
      if (insn.rep) {
        c.i32_eqz();
      }
      c.br_if(1);
    }
    c.br(0);
    c.end().end();
    this.lastFlags = null;
  }

  emitBitTest(m, ops, size) {
    const c = this.c;
    const [dst, bit] = ops;
    const idx = this.t64();
    const val = this.t64();
    const f = this.t32();
    const cf = this.t32();
    this.load(bit, bit.size);
    if (bit.kind === "imm") {
      c.i64_const(BigInt(BITS[size] - 1)).i64_and();
    }
    c.local_set(idx);
    let a = null;
    if (dst.kind === "mem") {
      // A register bit offset addresses beyond the operand; fold the
      // whole-word part into the address.
      a = this.t32();
      this.address(dst);
      if (bit.kind === "reg") {
        c.local_get(idx);
        this.signExtend(bit.size);
        c.i64_const(BigInt(Math.log2(BITS[size]))).i64_shr_s().i64_const(BigInt(Math.log2(size))).i64_shl().i64_add();
        c.local_get(idx).i64_const(BigInt(BITS[size] - 1)).i64_and().local_set(idx);
      }
      c.i32_wrap_i64().local_set(a);
      c.local_get(a);
      this.loadMem(size);
    } else {
      c.local_get(idx).i64_const(BigInt(BITS[size] - 1)).i64_and().local_set(idx);
      this.load(dst, size);
    }
    c.local_set(val);
    c.local_get(val).local_get(idx).i64_shr_u().i32_wrap_i64().i32_const(1).i32_and().local_set(cf);
    if (m !== "bt") {
      c.local_get(val).i64_const(1).local_get(idx).i64_shl();
      if (m === "bts") {
        c.i64_or();
      } else if (m === "btr") {
        c.i64_const(-1n).i64_xor().i64_and();
      } else {
        c.i64_xor();
      }
      this.mask(size);
      this.store(dst, size, a);
    }
    this.eflags();
    c.i32_const(~1).i32_and().local_get(cf).i32_or();
    this.setEflags();
    this.lastFlags = null;
  }

  emitBitScan(m, ops, size) {
    const c = this.c;
    const src = this.t64();
    const res = this.t64();
    const f = this.t32();
    this.load(ops[1], size);
    c.local_set(src);
    const bits = BITS[size];
    switch (m) {
      case "popcnt":
        c.local_get(src).i64_popcnt().local_tee(res);
        this.setReg(ops[0].reg, size);
        // ZF from the source; other flags cleared.
        c.local_get(src).i64_eqz().i32_const(6).i32_shl();
        this.setEflags();
        break;
      case "tzcnt":
        c.local_get(src).i64_eqz().if_(T.i64).i64_const(BigInt(bits)).else_().local_get(src).i64_ctz().end().local_tee(res);
        this.setReg(ops[0].reg, size);
        // CF = src == 0, ZF = res == 0
        c.local_get(src).i64_eqz().local_get(res).i64_eqz().i32_const(6).i32_shl().i32_or();
        this.setEflags();
        break;
      case "lzcnt":
        c.local_get(src).i64_clz().i64_const(BigInt(64 - bits)).i64_sub().local_tee(res);
        this.setReg(ops[0].reg, size);
        c.local_get(src).i64_eqz().local_get(res).i64_eqz().i32_const(6).i32_shl().i32_or();
        this.setEflags();
        break;
      case "bsf":
      case "bsr":
        // ZF = src == 0; the destination is unchanged then.
        c.local_get(src).i64_eqz().i32_const(6).i32_shl();
        this.setEflags();
        c.local_get(src).i64_eqz().i32_eqz().if_(T.empty);
        c.local_get(src);
        if (m === "bsf") {
          c.i64_ctz();
        } else {
          c.i64_clz().i64_const(63).i64_xor();
        }
        this.setReg(ops[0].reg, size);
        c.end();
        break;
      default:
        throw new Unsupported(m);
    }
    this.lastFlags = null;
  }

  bswapStack(size) {
    const c = this.c;
    // Byte-reverse the low `size` bytes of the i64 on the stack.
    const v = this.t64();
    const r = this.t64();
    c.local_set(v);
    c.i64_const(0).local_set(r);
    for (let i = 0; i < size; i++) {
      c.local_get(r).i64_const(8).i64_shl();
      c.local_get(v).i64_const(BigInt(8 * i)).i64_shr_u().i64_const(0xff).i64_and().i64_or().local_set(r);
    }
    c.local_get(r);
  }

  emitBswap(ops) {
    const size = ops[0].size;
    this.load(ops[0], size);
    this.bswapStack(size);
    this.setReg(ops[0].reg, size);
  }

  emitCmpxchg(ops, size, index) {
    const c = this.c;
    const [dst, src] = ops;
    const a = this.prepareDest(dst);
    const va = this.persistent64();
    const acc = this.persistent64();
    const res = this.persistent64();
    this.loadDest(dst, size, a);
    c.local_set(va);
    this.getReg(REG.rax, size);
    c.local_set(acc);
    // flags from acc - dst
    c.local_get(acc).local_get(va).i64_sub();
    this.mask(size);
    c.local_set(res);
    this.setFlags(CC.SUB, size, res, va);
    c.local_get(acc).local_get(va).i64_eq().if_(T.empty);
    this.load(src, size);
    this.store(dst, size, a);
    c.else_();
    c.local_get(va);
    this.setReg(REG.rax, size);
    c.end();
    this.lastFlags = { index, kind: "cmp", size, a: acc, b: va, res };
  }

  emitXadd(ops, size, index) {
    const c = this.c;
    const [dst, src] = ops;
    const a = this.prepareDest(dst);
    const va = this.persistent64();
    const vb = this.persistent64();
    const res = this.persistent64();
    this.loadDest(dst, size, a);
    c.local_set(va);
    this.load(src, size);
    c.local_set(vb);
    c.local_get(va).local_get(vb).i64_add();
    this.mask(size);
    c.local_tee(res);
    this.store(dst, size, a);
    c.local_get(va);
    this.setReg(src.reg, size);
    this.setFlags(CC.ADD, size, res, vb);
    this.lastFlags = { index, kind: "arith", size, res };
  }

  emitBmi(m, ops, size) {
    const c = this.c;
    const res = this.t64();
    const a = this.t64();
    const b = this.t64();
    switch (m) {
      case "andn":
        this.load(ops[1], size);
        c.i64_const(-1n).i64_xor();
        this.load(ops[2], size);
        c.i64_and();
        this.mask(size);
        c.local_tee(res);
        this.setReg(ops[0].reg, size);
        this.setFlags(CC.LOGIC, size, res, null);
        return;
      case "shlx":
      case "shrx":
      case "sarx":
        this.load(ops[1], size);
        if (m === "sarx") {
          this.signExtend(size);
        }
        this.load(ops[2], size);
        c.i64_const(size === 8 ? 63n : 31n).i64_and();
        if (m === "shlx") {
          c.i64_shl();
        } else if (m === "shrx") {
          c.i64_shr_u();
        } else {
          c.i64_shr_s();
        }
        this.mask(size);
        this.setReg(ops[0].reg, size);
        return;
      case "rorx":
        this.load(ops[1], size);
        if (size === 8) {
          c.i64_const(ops[2].value & 63n).i64_rotr();
        } else {
          c.i32_wrap_i64().i32_const(Number(ops[2].value & 31n)).i32_rotr().i64_extend_i32_u();
        }
        this.setReg(ops[0].reg, size);
        return;
      case "bzhi": {
        // dst = src & ((1 << n) - 1) for n < bits; CF = n >= bits
        const n = this.t64();
        this.load(ops[2], 1);
        c.local_set(n);
        this.load(ops[1], size);
        c.local_set(a);
        c.local_get(n).i64_const(BigInt(BITS[size])).i64_ge_u().if_(T.i64);
        c.local_get(a);
        c.else_();
        c.local_get(a).i64_const(1).local_get(n).i64_shl().i64_const(1).i64_sub().i64_and();
        c.end();
        c.local_tee(res);
        this.setReg(ops[0].reg, size);
        // flags: ZF, SF from result, CF as above
        c.local_get(res).i64_eqz().i32_const(6).i32_shl();
        c.local_get(res).i64_const(BigInt(BITS[size] - 1)).i64_shr_u().i32_wrap_i64().i32_const(7).i32_shl().i32_or();
        c.local_get(n).i64_const(BigInt(BITS[size])).i64_ge_u().i32_or();
        this.setEflags();
        return;
      }
      case "blsr":
      case "blsmsk":
      case "blsi": {
        this.load(ops[1], size);
        c.local_set(a);
        c.local_get(a).local_get(a).i64_const(1).i64_sub();
        if (m === "blsr") {
          c.i64_and();
        } else if (m === "blsmsk") {
          c.i64_xor();
        } else {
          // blsi: x & -x
          c.drop().i64_const(0).local_get(a).i64_sub().i64_and();
        }
        this.mask(size);
        c.local_tee(res);
        this.setReg(ops[0].reg, size);
        // CF = src == 0 (blsr, blsmsk) or src != 0 (blsi); ZF from result
        c.local_get(res).i64_eqz().i32_const(6).i32_shl();
        c.local_get(res).i64_const(BigInt(BITS[size] - 1)).i64_shr_u().i32_wrap_i64().i32_const(7).i32_shl().i32_or();
        c.local_get(a).i64_eqz();
        if (m === "blsi") {
          c.i32_eqz();
        }
        c.i32_or();
        this.setEflags();
        return;
      }
      case "bextr": {
        // start = ctl[7:0], len = ctl[15:8]
        const start = this.t64();
        const len = this.t64();
        this.load(ops[2], size);
        c.local_set(b);
        c.local_get(b).i64_const(0xff).i64_and().local_set(start);
        c.local_get(b).i64_const(8).i64_shr_u().i64_const(0xff).i64_and().local_set(len);
        this.load(ops[1], size);
        c.local_set(a);
        c.local_get(start).i64_const(BigInt(BITS[size])).i64_ge_u().if_(T.i64);
        c.i64_const(0);
        c.else_();
        c.local_get(a).local_get(start).i64_shr_u();
        c.local_get(len).i64_const(64).i64_ge_u().if_(T.i64).i64_const(-1n).else_().i64_const(1).local_get(len).i64_shl().i64_const(1).i64_sub().end();
        c.i64_and();
        c.end();
        this.mask(size);
        c.local_tee(res);
        this.setReg(ops[0].reg, size);
        c.local_get(res).i64_eqz().i32_const(6).i32_shl();
        this.setEflags();
        return;
      }
      case "pdep":
      case "pext": {
        // Bit-by-bit loops; rare enough to be slow.
        const srcv = this.t64();
        const maskv = this.t64();
        const bit = this.t64();
        const k = this.t64();
        this.load(ops[1], size);
        c.local_set(srcv);
        this.load(ops[2], size);
        c.local_set(maskv);
        c.i64_const(0).local_set(res);
        c.i64_const(0).local_set(k);
        c.i64_const(0).local_set(bit);
        c.block(T.empty).loop(T.empty);
        c.local_get(bit).i64_const(BigInt(BITS[size])).i64_ge_u().br_if(1);
        c.local_get(maskv).local_get(bit).i64_shr_u().i64_const(1).i64_and().i64_eqz().i32_eqz().if_(T.empty);
        if (m === "pdep") {
          // res |= ((src >> k) & 1) << bit
          c.local_get(res).local_get(srcv).local_get(k).i64_shr_u().i64_const(1).i64_and().local_get(bit).i64_shl().i64_or().local_set(res);
        } else {
          // res |= ((src >> bit) & 1) << k
          c.local_get(res).local_get(srcv).local_get(bit).i64_shr_u().i64_const(1).i64_and().local_get(k).i64_shl().i64_or().local_set(res);
        }
        c.local_get(k).i64_const(1).i64_add().local_set(k);
        c.end();
        c.local_get(bit).i64_const(1).i64_add().local_set(bit);
        c.br(0);
        c.end().end();
        c.local_get(res);
        this.setReg(ops[0].reg, size);
        return;
      }
      case "mulx": {
        // dst1:dst0 = rdx * src, unsigned, no flags
        this.load(ops[2], size);
        c.local_set(b);
        this.getReg(REG.rdx, size);
        c.local_set(a);
        if (size === 8) {
          c.local_get(a).local_get(b).i64_mul();
          this.setReg(ops[1].reg, 8);
          c.local_get(a).local_get(b).call(this.ctx.helpers.mulhu);
          this.setReg(ops[0].reg, 8);
        } else {
          c.local_get(a).local_get(b).i64_mul().local_set(res);
          c.local_get(res);
          this.mask(4);
          this.setReg(ops[1].reg, 4);
          c.local_get(res).i64_const(32).i64_shr_u();
          this.setReg(ops[0].reg, 4);
        }
        return;
      }
      default:
        throw new Unsupported(m);
    }
  }

  emitSimd(insn, ops) {
    return emitSimd(this, insn, ops);
  }

  emitX87(insn, ops) {
    return emitX87(this, insn, ops);
  }
}

const REGNAME = [
  "rax", "rcx", "rdx", "rbx", "rsp", "rbp", "rsi", "rdi",
  "r8", "r9", "r10", "r11", "r12", "r13", "r14", "r15",
];

export class Unsupported extends Error {}

export { JS_IMPORTS };
