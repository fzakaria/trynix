// A Machine is one guest address space and CPU: the wasm memory, the
// register file, the block table and the run loop that dispatches into
// translated code. It knows nothing about ELF files or Linux; the
// process layer sits on top and supplies the syscall handler.
import {
  buildHelpersModule,
  LOOKUP_ENTRY_BYTES,
  LOOKUP_HASH_MULTIPLIER,
} from "./helpers.js";
import { Translator } from "./translate.js";
import { EXIT, G, GLOBALS, REGISTER_NAMES } from "./state.js";
import { fpuOp } from "./x87.js";

const PAGE = 65536;

// The block lookup: a hash table of this many entries, 16 MiB, per
// Machine. It holds a million and a half blocks at a comfortable load;
// python's start is a tenth of that.
const LOOKUP_ENTRIES = 1 << 21;
export const LOOKUP_BYTES = LOOKUP_ENTRIES * LOOKUP_ENTRY_BYTES;
const LOOKUP_LOAD_LIMIT = 0.8;
// Past the lookup: a scratch area the register file is spilled through.
export const SCRATCH_BYTES = 4096;
export const LOOKUP_RESERVE = LOOKUP_BYTES + SCRATCH_BYTES;

// Thrown by a syscall handler to end the process.
export class ProcessExit extends Error {
  constructor(code) {
    super(`exit ${code}`);
    this.code = code;
  }
}

// Thrown when the guest executes something it should not have.
export class GuestFault extends Error {}

export class Machine {
  // A Machine owns a memory unless given one (a thread shares its
  // process's), and keeps its block lookup at `lookupBase` in that
  // memory: LOOKUP_BYTES that the process layer reserved for it, or the
  // top of the initial memory when nothing is said.
  constructor({
    pages = 4096,
    maxPages = 65536,
    memory = null,
    shared = false,
    lookupBase = null,
  } = {}) {
    this.shared =
      shared || (memory !== null && memory.buffer instanceof SharedArrayBuffer);
    this.memory =
      memory ??
      new WebAssembly.Memory({
        initial: pages,
        maximum: maxPages,
        shared: this.shared,
      });
    this.table = new WebAssembly.Table({ element: "anyfunc", initial: 1 });
    this.refreshViews();

    if (lookupBase === null) {
      if (this.size < 2 * LOOKUP_BYTES) {
        throw new Error("memory too small for the block lookup");
      }
      lookupBase = this.size - LOOKUP_BYTES;
    }
    this.lookupBase = lookupBase;
    this.scratch = lookupBase + LOOKUP_BYTES;
    this.lookupMask = LOOKUP_ENTRIES - 1;
    this.lookupCount = 0;
    // The top of what the guest may use when the lookup sits at the
    // top of the initial memory; the process layer reads it.
    this.kernelBase = lookupBase;
    this.kernelTop = lookupBase + LOOKUP_BYTES;
    this.u8.fill(0, lookupBase, lookupBase + LOOKUP_BYTES);

    const helpers = new WebAssembly.Instance(
      new WebAssembly.Module(buildHelpersModule({ shared: this.shared })),
      {
        env: { memory: this.memory, table: this.table },
      },
    );
    this.helpers = helpers.exports;
    this.helpers.ht_base.value = lookupBase;
    this.helpers.ht_mask.value = this.lookupMask;
    this.translator = new Translator(this);
    // Reset values: mxcsr masks every exception and rounds to nearest;
    // the x87 control word extends precision with all exceptions masked.
    this.helpers.mxcsr.value = 0x1f80;
    this.helpers.fpu_cw.value = 0x37f;

    this.slots = 1;
    this.syscall = () => {
      throw new GuestFault("syscall with no handler");
    };
    this.cpuid = defaultCpuid;
    this.rdtsc = defaultRdtsc;
    this.div128 = div128;
    this.fpu = fpuOp;
    this.imports = null;
    this.traceBlock = () => {};
    // Set by the process layer: address -> { file, lo, hi, base } for
    // the file mapping holding it, or null.
    this.locator = () => null;
    // A translation cache: { get(key) -> entry | undefined, put(key, entry) }.
    this.cache = null;
  }

  locate(addr) {
    return this.locator(addr);
  }

  refreshViews() {
    this.u8 = new Uint8Array(this.memory.buffer);
    this.u32 = new Uint32Array(this.memory.buffer);
    this.view = new DataView(this.memory.buffer);
  }

  // Another thread may have grown a shared memory; views follow the
  // buffer's current length.
  syncViews() {
    if (this.u8.length !== this.memory.buffer.byteLength) {
      this.refreshViews();
    }
  }

  // The imports every translated module takes, with the load base the
  // instance's addresses are relative to.
  importObject(base = 0n) {
    if (this.imports === null) {
      this.imports = {
        memory: this.memory,
        ...this.helpers,
        syscall: () => this.syscall(this),
        cpuid: () => this.cpuid(this),
        rdtsc: () => this.rdtsc(this),
        div128: (signed) => this.div128(this, signed !== 0),
        fpu: (op, arg) => this.fpu(this, op, arg),
        trace: (rip) => this.traceBlock(BigInt.asUintN(64, rip)),
      };
    }
    return {
      env: {
        ...this.imports,
        base: new WebAssembly.Global(
          { value: "i64", mutable: false },
          BigInt.asIntN(64, base),
        ),
      },
    };
  }

  bytes() {
    return this.u8;
  }

  // ---- memory -------------------------------------------------------

  grow(pages) {
    this.memory.grow(pages);
    this.refreshViews();
  }

  get size() {
    return this.memory.buffer.byteLength;
  }

  // Makes sure [addr, addr + len) is inside the memory, growing it.
  ensure(addr, len) {
    const end = Number(addr) + Number(len);
    if (end <= this.size) {
      return;
    }
    const need = Math.ceil((end - this.size) / PAGE);
    this.grow(need);
  }

  write(addr, bytes) {
    this.ensure(addr, bytes.length);
    this.u8.set(bytes, Number(addr));
  }

  read(addr, len) {
    return this.u8.subarray(Number(addr), Number(addr) + len);
  }

  read64(addr) {
    return this.view.getBigUint64(Number(addr), true);
  }

  read32(addr) {
    return this.view.getUint32(Number(addr), true);
  }

  write64(addr, v) {
    this.view.setBigUint64(Number(addr), BigInt.asUintN(64, v), true);
  }

  write32(addr, v) {
    this.view.setUint32(Number(addr), Number(v) >>> 0, true);
  }

  // ---- registers ----------------------------------------------------

  // Registers read back unsigned; wasm reports i64 globals signed.
  reg(name) {
    const v = this.helpers[name].value;
    return typeof v === "bigint" ? BigInt.asUintN(64, v) : v;
  }

  setReg(name, v) {
    this.helpers[name].value =
      typeof v === "bigint" ? BigInt.asUintN(64, v) : v;
  }

  // The whole register file as plain data: BigInt strings for the
  // 64-bit globals, numbers for the rest, xmm as byte arrays. What a
  // fork, a new thread or a signal frame carries.
  saveState() {
    const state = {};
    for (const [name, type] of GLOBALS) {
      if (name.startsWith("xmm") || name.startsWith("ymmh")) {
        continue;
      }
      const v = this.helpers[name].value;
      state[name] = type === "i64" ? BigInt.asUintN(64, v).toString() : v;
    }
    this.helpers.save_ymm(this.scratch);
    state.ymm = Array.from(this.u8.subarray(this.scratch, this.scratch + 512));
    return state;
  }

  loadState(state) {
    for (const [name, type] of GLOBALS) {
      if (name.startsWith("xmm") || name.startsWith("ymmh")) {
        continue;
      }
      if (state[name] === undefined) {
        continue;
      }
      this.helpers[name].value =
        type === "i64" ? BigInt.asIntN(64, BigInt(state[name])) : state[name];
    }
    if (state.ymm) {
      this.u8.set(state.ymm, this.scratch);
      this.helpers.load_ymm(this.scratch);
    }
  }

  // An Int32 view for futexes on a shared memory; refreshed on growth.
  get i32() {
    if (this._i32 === undefined || this._i32.buffer !== this.memory.buffer) {
      this._i32 = new Int32Array(this.memory.buffer);
    }
    return this._i32;
  }

  // ---- block table --------------------------------------------------

  // The table slot for a guest address, or 0: the same probe as the
  // wasm helper, in JavaScript.
  lookup(addr) {
    const a = Number(BigInt.asUintN(32, addr));
    let i = (Math.imul(a, LOOKUP_HASH_MULTIPLIER) >>> 8) & this.lookupMask;
    const u32 = this.u32;
    const base = this.lookupBase >>> 2;
    for (;;) {
      const key = u32[base + i * 2];
      if (key === a) {
        return u32[base + i * 2 + 1];
      }
      if (key === 0) {
        return 0;
      }
      i = (i + 1) & this.lookupMask;
    }
  }

  // Puts a block function in a table slot and in the lookup for addr.
  register(addr, slot, func) {
    this.table.set(slot, func);
    const a = Number(BigInt.asUintN(32, addr));
    let i = (Math.imul(a, LOOKUP_HASH_MULTIPLIER) >>> 8) & this.lookupMask;
    const u32 = this.u32;
    const base = this.lookupBase >>> 2;
    for (;;) {
      const key = u32[base + i * 2];
      if (key === 0 || key === a) {
        if (key === 0) {
          this.lookupCount++;
          if (this.lookupCount > LOOKUP_ENTRIES * LOOKUP_LOAD_LIMIT) {
            throw new GuestFault("block lookup table full");
          }
        }
        u32[base + i * 2] = a;
        u32[base + i * 2 + 1] = slot;
        return;
      }
      i = (i + 1) & this.lookupMask;
    }
  }

  // Forgets a block: its entry keeps its key with slot 0, which both
  // probes read as "not translated" and a later register reuses.
  unregister(addr) {
    const a = Number(BigInt.asUintN(32, addr));
    let i = (Math.imul(a, LOOKUP_HASH_MULTIPLIER) >>> 8) & this.lookupMask;
    const u32 = this.u32;
    const base = this.lookupBase >>> 2;
    for (;;) {
      const key = u32[base + i * 2];
      if (key === a) {
        u32[base + i * 2 + 1] = 0;
        return;
      }
      if (key === 0) {
        return;
      }
      i = (i + 1) & this.lookupMask;
    }
  }

  // Grows the function table by n and returns the first new slot.
  reserveSlots(n) {
    const base = this.slots;
    this.table.grow(n);
    this.slots += n;
    return base;
  }

  // ---- running ------------------------------------------------------

  // Runs from `entry` until the guest halts, traps or exits.
  run(entry) {
    this.setReg("rip", entry);
    const exitReason = this.helpers.exit_reason;
    const rip = this.helpers.rip;
    for (;;) {
      const at = rip.value;
      let slot = this.lookup(at);
      if (slot === 0) {
        slot = this.translator.translateRegion(at);
      }
      exitReason.value = EXIT.NONE;
      try {
        this.table.get(slot)();
      } catch (e) {
        if (e instanceof ProcessExit) {
          return { reason: "exit", code: e.code, rip: rip.value };
        }
        throw e;
      }
      switch (exitReason.value) {
        case EXIT.MISS:
          continue;
        case EXIT.INVALIDATE:
          this.translator.invalidate(rip.value);
          continue;
        case EXIT.HLT:
          return { reason: "hlt", rip: rip.value };
        case EXIT.TRAP:
          throw new GuestFault(`trap at 0x${rip.value.toString(16)}`);
        case EXIT.UNSUPPORTED: {
          const why = this.translator.unsupported.get(rip.value) || "unknown";
          throw new GuestFault(
            `unsupported instruction at 0x${rip.value.toString(16)}: ${why}`,
          );
        }
        default:
          throw new GuestFault(
            `block returned with exit reason ${exitReason.value}`,
          );
      }
    }
  }
}

// The CPU the guest sees: an x86-64-v2 without AVX, so glibc's ifunc
// resolvers choose SSE routines. Vendor string and family are those of
// a real part so nothing decides the CPU is unknown.
function defaultCpuid(m) {
  const leaf = Number(m.reg("rax") & 0xffffffffn);
  const sub = Number(m.reg("rcx") & 0xffffffffn);
  let a = 0;
  let b = 0;
  let c = 0;
  let d = 0;
  switch (leaf) {
    case 0:
      a = 0xd;
      b = 0x756e6547; // "Genu"
      d = 0x49656e69; // "ineI"
      c = 0x6c65746e; // "ntel"
      break;
    case 1:
      a = 0x000306a9; // family 6 model 0x3a
      b = 0x00010800; // 1 logical processor, 8-byte clflush
      // ecx: sse3, pclmul, ssse3, fma=0, cx16, sse4.1, sse4.2, movbe=0,
      // popcnt, xsave, osxsave... keep AVX (bit 28) and OSXSAVE clear.
      // SSE4.2 (bit 20) is withheld until pcmpistri has a translation.
      c = (1 << 0) | (1 << 1) | (1 << 9) | (1 << 13) | (1 << 19) | (1 << 23);
      // edx: fpu, tsc, cx8, cmov, clflush, mmx, fxsr, sse, sse2
      d =
        (1 << 0) |
        (1 << 4) |
        (1 << 8) |
        (1 << 15) |
        (1 << 19) |
        (1 << 23) |
        (1 << 24) |
        (1 << 25) |
        (1 << 26);
      break;
    case 7:
      if (sub === 0) {
        // No AVX2, BMI, ERMS: keep every fast-path off.
        b = 0;
      }
      break;
    case 0x80000000:
      a = 0x80000008;
      break;
    case 0x80000001:
      // lahf/sahf in long mode; syscall, nx, lm
      c = 1;
      d = (1 << 11) | (1 << 20) | (1 << 29);
      break;
    case 0x80000008:
      a = 0x3028; // 40-bit physical, 48-bit virtual
      break;
    default:
      break;
  }
  m.setReg("rax", BigInt(a >>> 0));
  m.setReg("rbx", BigInt(b >>> 0));
  m.setReg("rcx", BigInt(c >>> 0));
  m.setReg("rdx", BigInt(d >>> 0));
}

function defaultRdtsc(m) {
  const t = BigInt(Math.round(performance.now() * 1e6));
  m.setReg("rax", t & 0xffffffffn);
  m.setReg("rdx", t >> 32n);
}

// 128-by-64-bit division for the case the inline fast path cannot do.
function div128(m, signed) {
  const lo = m.reg("rax");
  const hi = m.reg("rdx");
  const d = m.reg("cc_src2");
  let n = (hi << 64n) | lo;
  let dv = d;
  if (signed) {
    n = BigInt.asIntN(128, n);
    dv = BigInt.asIntN(64, d);
  }
  if (dv === 0n) {
    throw new GuestFault("division by zero");
  }
  const q = n / dv;
  const r = n % dv;
  m.setReg("rax", q);
  m.setReg("rdx", r);
}

export { EXIT, G, REGISTER_NAMES };
