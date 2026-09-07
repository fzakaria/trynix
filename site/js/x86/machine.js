// A Machine is one guest address space and CPU: the wasm memory, the
// register file, the block table and the run loop that dispatches into
// translated code. It knows nothing about ELF files or Linux; the
// process layer sits on top and supplies the syscall handler.
import { buildHelpersModule, LOOKUP_L1_SIZE, LOOKUP_L2_SIZE } from "./helpers.js";
import { Translator } from "./translate.js";
import { EXIT, G, REGISTER_NAMES } from "./state.js";

const PAGE = 65536;

// What the Machine keeps for its own tables, at the top of the initial
// memory: the lookup directory and the second-level blocks behind it.
// The guest gets everything below, and everything above once the
// memory grows.
const KERNEL_SIZE = 64 << 20;

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
  constructor({ pages = 4096, maxPages = 65536 } = {}) {
    this.memory = new WebAssembly.Memory({ initial: pages, maximum: maxPages });
    this.table = new WebAssembly.Table({ element: "anyfunc", initial: 1 });
    this.refreshViews();

    if (pages * PAGE < 2 * KERNEL_SIZE) {
      throw new Error("memory too small for the runtime's tables");
    }
    this.kernelTop = pages * PAGE;
    this.kernelBase = this.kernelTop - KERNEL_SIZE;
    this.l1Base = this.kernelBase;
    // Everything the run loop reserves for itself comes from this bump
    // pointer, starting past the lookup directory.
    this.kernelBrk = this.l1Base + LOOKUP_L1_SIZE;

    const helpers = new WebAssembly.Instance(new WebAssembly.Module(buildHelpersModule({ l1Base: this.l1Base })), {
      env: { memory: this.memory },
    });
    this.helpers = helpers.exports;
    this.translator = new Translator(this);

    this.slots = 1;
    this.syscall = () => {
      throw new GuestFault("syscall with no handler");
    };
    this.cpuid = defaultCpuid;
    this.rdtsc = defaultRdtsc;
    this.div128 = div128;
    this.fpu = () => {
      throw new GuestFault("x87 helper with no handler");
    };
    this.imports = null;
    this.traceBlock = () => {};
  }

  refreshViews() {
    this.u8 = new Uint8Array(this.memory.buffer);
    this.u32 = new Uint32Array(this.memory.buffer);
    this.view = new DataView(this.memory.buffer);
  }

  // The imports every translated module takes.
  importObject() {
    if (this.imports === null) {
      this.imports = {
        env: {
          memory: this.memory,
          table: this.table,
          ...this.helpers,
          syscall: () => this.syscall(this),
          cpuid: () => this.cpuid(this),
          rdtsc: () => this.rdtsc(this),
          div128: (signed) => this.div128(this, signed !== 0),
          fpu: (op, arg) => this.fpu(this, op, arg),
          trace: (rip) => this.traceBlock(BigInt.asUintN(64, rip)),
        },
      };
    }
    return this.imports;
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

  // Zero-filled memory for the runtime's own tables.
  kalloc(len) {
    const addr = this.kernelBrk;
    if (addr + len > this.kernelTop) {
      throw new GuestFault("runtime table space exhausted");
    }
    this.kernelBrk += len;
    this.ensure(addr, len);
    return addr;
  }

  // ---- registers ----------------------------------------------------

  // Registers read back unsigned; wasm reports i64 globals signed.
  reg(name) {
    const v = this.helpers[name].value;
    return typeof v === "bigint" ? BigInt.asUintN(64, v) : v;
  }

  setReg(name, v) {
    this.helpers[name].value = typeof v === "bigint" ? BigInt.asUintN(64, v) : v;
  }

  // ---- block table --------------------------------------------------

  // The table slot for a guest address, or 0.
  lookup(addr) {
    const a = Number(BigInt.asUintN(32, addr));
    const l1 = this.u32[(this.l1Base >>> 2) + (a >>> 12)];
    if (l1 === 0) {
      return 0;
    }
    return this.u32[(l1 >>> 2) + (a & 0xfff)];
  }

  register(addr, slot) {
    const a = Number(BigInt.asUintN(32, addr));
    const l1i = (this.l1Base >>> 2) + (a >>> 12);
    let l1 = this.u32[l1i];
    if (l1 === 0) {
      l1 = this.kalloc(LOOKUP_L2_SIZE);
      this.u32[l1i] = l1;
    }
    this.u32[(l1 >>> 2) + (a & 0xfff)] = slot;
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
        case EXIT.HLT:
          return { reason: "hlt", rip: rip.value };
        case EXIT.TRAP:
          throw new GuestFault(`trap at 0x${rip.value.toString(16)}`);
        case EXIT.UNSUPPORTED: {
          const why = this.translator.unsupported.get(rip.value) || "unknown";
          throw new GuestFault(`unsupported instruction at 0x${rip.value.toString(16)}: ${why}`);
        }
        default:
          throw new GuestFault(`block returned with exit reason ${exitReason.value}`);
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
      d = (1 << 0) | (1 << 4) | (1 << 8) | (1 << 15) | (1 << 19) | (1 << 23) | (1 << 24) | (1 << 25) | (1 << 26);
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
