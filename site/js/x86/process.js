// A process, from inside its worker: the loader, the syscalls that
// stay on this thread, and the requests for everything else.
//
// What stays here: the guest's memory contents, translation and the
// block lookup, signal handling, futexes (the memory is shared, so
// Atomics on it are the futex), clocks, identities. What is a request
// to the kernel (kernel.js): files and descriptors, the address-space
// allocator, processes, and the terminal.
import { E, Errno } from "./errno.js";
import { parseElf } from "./elf.js";
import { GuestFault, ProcessExit, LOOKUP_RESERVE } from "./machine.js";
import { Channel } from "./channel.js";
import { OP } from "./ops.js";
import {
  encodeTranslation,
  decodeTranslation,
  EXE_BASE,
  OP_ALLOCATE,
  OP_BRK,
  OP_BRK_INIT,
  OP_CLAIM,
  OP_LOCATE,
  OP_MMAP,
  OP_MUNMAP,
  OP_SIGDISPOSITION,
} from "./kernel.js";
import { packStrings, unpackStrings } from "./structs.js";

const PAGE_SIZE = 4096;
const PAGE_MASK = ~0xfffn;
const STACK_SIZE = 8 << 20;
const READ_CHUNK = 1 << 20;

// Auxiliary vector tags.
const AT = Object.freeze({
  NULL: 0, PHDR: 3, PHENT: 4, PHNUM: 5, PAGESZ: 6, BASE: 7, FLAGS: 8, ENTRY: 9,
  UID: 11, EUID: 12, GID: 13, EGID: 14, PLATFORM: 15, HWCAP: 16, CLKTCK: 17,
  SECURE: 23, RANDOM: 25, HWCAP2: 26, EXECFN: 31,
});

const O = Object.freeze({ RDONLY: 0, CLOEXEC: 0o2000000 });
const AT_FDCWD = -100;
const MAP = Object.freeze({ ANONYMOUS: 0x20 });

const ARCH_SET_GS = 0x1001;
const ARCH_SET_FS = 0x1002;
const ARCH_GET_FS = 0x1003;
const ARCH_GET_GS = 0x1004;

const FUTEX_WAIT = 0;
const FUTEX_WAKE = 1;
const FUTEX_WAIT_BITSET = 9;
const FUTEX_WAKE_BITSET = 10;
const FUTEX_CMD_MASK = 0x7f;

const CLOCK_REALTIME = 0;

const CLONE_VM = 0x100;
const CLONE_THREAD = 0x10000;
const CLONE_SETTLS = 0x80000;
const CLONE_PARENT_SETTID = 0x100000;
const CLONE_CHILD_CLEARTID = 0x200000;
const CLONE_CHILD_SETTID = 0x1000000;

const SIG_DFL = 0n;
const SIG_IGN = 1n;
const SA_SIGINFO = 4n;
const SA_RESTORER = 0x04000000n;
const SA_RESTART = 0x10000000n;
const SA_NODEFER = 0x40000000n;
const SIG_COUNT = 64;
const NR_rt_sigreturn = 15;

// Slices a blocking wait is cut into, so a signal is seen promptly.
const WAIT_SLICE_MS = 50;
const POLL_SLICE_MS = 4;

// Syscall numbers, x86-64.
export const NR = Object.freeze({
  read: 0, write: 1, open: 2, close: 3, stat: 4, fstat: 5, lstat: 6, poll: 7, lseek: 8, mmap: 9,
  mprotect: 10, munmap: 11, brk: 12, rt_sigaction: 13, rt_sigprocmask: 14, rt_sigreturn: 15,
  ioctl: 16, pread64: 17, pwrite64: 18, readv: 19, writev: 20, access: 21, pipe: 22, select: 23,
  sched_yield: 24, mremap: 25, msync: 26, mincore: 27, madvise: 28, dup: 32, dup2: 33, pause: 34,
  nanosleep: 35, getitimer: 36, alarm: 37, setitimer: 38, getpid: 39, socket: 41, clone: 56,
  fork: 57, vfork: 58, execve: 59, exit: 60, wait4: 61, kill: 62, uname: 63, fcntl: 72, flock: 73,
  fsync: 74, fdatasync: 75, truncate: 76, ftruncate: 77, getdents: 78, getcwd: 79, chdir: 80,
  fchdir: 81, rename: 82, mkdir: 83, rmdir: 84, creat: 85, link: 86, unlink: 87, symlink: 88,
  readlink: 89, chmod: 90, fchmod: 91, chown: 92, fchown: 93, lchown: 94, umask: 95,
  gettimeofday: 96, getrlimit: 97, getrusage: 98, sysinfo: 99, times: 100, getuid: 102,
  getgid: 104, setuid: 105, setgid: 106, geteuid: 107, getegid: 108, setpgid: 109, getppid: 110,
  getpgrp: 111, setsid: 112, getgroups: 115, setresuid: 117, getresuid: 118, setresgid: 119,
  getresgid: 120, getpgid: 121, getsid: 124, rt_sigsuspend: 130, sigaltstack: 131, statfs: 137,
  fstatfs: 138, prctl: 157, arch_prctl: 158, gettid: 186, time: 201, futex: 202,
  sched_getaffinity: 204, epoll_create: 213, getdents64: 217, set_tid_address: 218,
  clock_gettime: 228, clock_getres: 229, clock_nanosleep: 230, exit_group: 231, epoll_wait: 232,
  epoll_ctl: 233, tgkill: 234, openat: 257, mkdirat: 258, fchownat: 260, newfstatat: 262,
  unlinkat: 263, renameat: 264, linkat: 265, symlinkat: 266, readlinkat: 267, fchmodat: 268,
  faccessat: 269, pselect6: 270, ppoll: 271, set_robust_list: 273, get_robust_list: 274,
  utimensat: 280, epoll_pwait: 281, eventfd2: 290, epoll_create1: 291, dup3: 292, pipe2: 293,
  prlimit64: 302, getrandom: 318, memfd_create: 319, statx: 332, rseq: 334, clone3: 435,
  close_range: 436, faccessat2: 439, socketpair: 53,
});
const NR_NAMES = Object.fromEntries(Object.entries(NR).map(([k, v]) => [v, k]));

// Thrown by execve: the worker builds a new image and runs it.
export class ExecRequest {
  constructor(path, argv, envp) {
    this.path = path;
    this.argv = argv;
    this.envp = envp;
  }
}

export class Process {
  constructor({ machine, channel, pid, tid, ppid, trace = null }) {
    this.machine = machine;
    this.channel = channel;
    this.pid = pid;
    this.tid = tid;
    this.ppid = ppid;
    this.trace = trace;
    this.tidAddress = 0n;
    this.clearTid = 0n;
    this.sigactions = new Array(SIG_COUNT).fill(null);
    this.sigmask = 0n;
    this.signalFrames = [];
    // The alternate signal stack, if the thread set one: { sp, size }.
    this.altStack = null;
    this.mappings = [];
    this.exePath = "";
    this.argv = [];
    this.entry = 0n;
    this.syscalls = 0;
    // Called before the process ends, for the runner's statistics.
    this.beforeExit = null;
    machine.syscall = (m) => this.syscall(m);
    machine.locator = (addr) => this.locate(addr);
    machine.cache = {
      get: (key) => this.translationGet(key),
      put: (key, entry) => this.translationPut(key, entry),
    };
    this.localTranslations = new Map();
  }

  // ---- the kernel ---------------------------------------------------

  // A request; a negative result is an errno and throws.
  k(op, args = [], payload = null) {
    const r = this.channel.call(op, args, payload);
    if (r < 0n && r >= -4096n) {
      throw new Errno(Number(-r));
    }
    return r;
  }

  // The response payload of the last request.
  kbytes() {
    return this.channel.payload.subarray(0, this.channel.responseLength);
  }

  kstrings() {
    return unpackStrings(this.channel.payload, this.channel.responseLength);
  }

  // ---- translations -------------------------------------------------

  translationGet(key) {
    const local = this.localTranslations.get(key);
    if (local !== undefined) {
      return local;
    }
    const r = this.channel.call(OP.TRANSLATION_GET, [], packStrings([key]));
    if (r < 0n) {
      return undefined;
    }
    const entry = decodeTranslation(this.kbytes());
    this.localTranslations.set(key, entry);
    return entry;
  }

  translationPut(key, entry) {
    this.localTranslations.set(key, entry);
    this.channel.call(OP.TRANSLATION_PUT, [], encodeTranslation({ key, ...entry }));
  }

  seedTranslations(map) {
    if (map) {
      for (const [key, entry] of map) {
        this.localTranslations.set(key, entry);
      }
    }
  }

  // ---- memory -------------------------------------------------------

  locate(addr) {
    for (const m of this.mappings) {
      if (addr >= m.lo && addr < m.hi) {
        return m;
      }
    }
    const r = this.channel.call(OP_LOCATE, [addr]);
    if (r !== 1n) {
      return null;
    }
    const [lo, hi, base, file] = this.kstrings();
    const m = { lo: BigInt(lo), hi: BigInt(hi), base: BigInt(base), file: file === "" ? null : file };
    this.mappings.push(m);
    return m;
  }

  forgetMappings(lo, hi) {
    this.mappings = this.mappings.filter((m) => m.hi <= lo || m.lo >= hi);
  }

  // Reads a whole file through the kernel.
  readFile(path) {
    const fd = Number(this.k(OP.OPENAT, [AT_FDCWD, O.RDONLY | O.CLOEXEC, 0], packStrings([path])));
    try {
      this.k(OP.FSTAT, [fd]);
      const size = Number(new DataView(this.channel.payload.buffer, this.channel.payload.byteOffset).getBigInt64(48, true));
      const out = new Uint8Array(size);
      let got = 0;
      while (got < size) {
        const n = Number(this.k(OP.PREAD, [fd, Math.min(READ_CHUNK, size - got), got]));
        if (n <= 0) {
          break;
        }
        out.set(this.kbytes().subarray(0, n), got);
        got += n;
      }
      return out.subarray(0, got);
    } finally {
      this.k(OP.CLOSE, [fd]);
    }
  }

  // Fills [at, at + len) of memory from a file descriptor's contents.
  readInto(fd, at, offset, len) {
    const m = this.machine;
    let got = 0;
    while (got < len) {
      const n = Number(this.k(OP.PREAD, [fd, Math.min(READ_CHUNK, len - got), offset + got]));
      if (n <= 0) {
        break;
      }
      m.syncViews();
      m.u8.set(this.kbytes().subarray(0, n), at + got);
      got += n;
    }
  }

  // ---- loading ------------------------------------------------------

  mapElf(bytes, elf, base, path) {
    const m = this.machine;
    let lo = null;
    let hi = 0n;
    for (const s of elf.segments) {
      const start = (base + s.vaddr) & PAGE_MASK;
      const end = (base + s.vaddr + BigInt(s.memsz) + 0xfffn) & PAGE_MASK;
      if (lo === null || start < lo) {
        lo = start;
      }
      if (end > hi) {
        hi = end;
      }
    }
    const needZero = this.k(OP_CLAIM, [lo, hi, 0], packStrings([""]));
    m.syncViews();
    if (needZero !== 0n) {
      m.u8.fill(0, Number(lo), Number(hi));
    }
    this.forgetMappings(lo, hi);
    for (const s of elf.segments) {
      const at = Number(base + s.vaddr);
      m.u8.set(bytes.subarray(s.offset, s.offset + s.filesz), at);
      const segLo = (base + s.vaddr) & PAGE_MASK;
      const segHi = (base + s.vaddr + BigInt(s.filesz) + 0xfffn) & PAGE_MASK;
      if (segHi > segLo) {
        const fileOffset = s.offset - Number(s.vaddr - (s.vaddr & PAGE_MASK));
        this.k(OP_CLAIM, [segLo, segHi, fileOffset], packStrings([path]));
      }
    }
    return { lo, hi };
  }

  load(path, argv, envp) {
    this.argv = argv;
    const bytes = this.readFile(path);
    const elf = parseElf(bytes);
    const base = elf.pie ? EXE_BASE : 0n;
    const { hi } = this.mapElf(bytes, elf, base, path);
    this.exePath = path;
    this.k(OP_BRK_INIT, [hi]);

    let entry = base + elf.entry;
    let interpBase = 0n;
    if (elf.interp !== null) {
      const ibytes = this.readFile(elf.interp);
      const ielf = parseElf(ibytes);
      let span = 0n;
      for (const s of ielf.segments) {
        const end = (s.vaddr + BigInt(s.memsz) + 0xfffn) & PAGE_MASK;
        if (end > span) {
          span = end;
        }
      }
      interpBase = this.allocate(Number(span));
      this.mapElf(ibytes, ielf, interpBase, elf.interp);
      entry = interpBase + ielf.entry;
    }

    const sp = this.buildStack(elf, base, interpBase, path, argv, envp);
    this.machine.setReg("rsp", sp);
    for (const r of ["rax", "rbx", "rcx", "rdx", "rsi", "rdi", "rbp", "r8", "r9", "r10", "r11", "r12", "r13", "r14", "r15"]) {
      this.machine.setReg(r, 0n);
    }
    this.entry = entry;
    return entry;
  }

  // Anonymous memory from the kernel's allocator, zeroed.
  allocate(len) {
    const at = this.k(OP_ALLOCATE, [len]);
    const [needZero] = this.kstrings();
    this.machine.syncViews();
    if (needZero !== "0") {
      this.machine.u8.fill(0, Number(at), Number(at) + len);
    }
    this.forgetMappings(at, at + BigInt(len));
    return at;
  }

  buildStack(elf, base, interpBase, execfn, argv, envp) {
    const m = this.machine;
    const stackLo = this.allocate(STACK_SIZE);
    const stackHi = stackLo + BigInt(STACK_SIZE);
    let sp = stackHi - 16n;
    const enc = new TextEncoder();
    const pushBytes = (bytes) => {
      sp -= BigInt(bytes.length);
      m.u8.set(bytes, Number(sp));
      return sp;
    };
    const pushString = (s) => pushBytes(enc.encode(s + "\0"));
    const execfnAddr = pushString(execfn);
    const platformAddr = pushString("x86_64");
    const random = new Uint8Array(16);
    crypto.getRandomValues(random);
    const randomAddr = pushBytes(random);
    const argvAddrs = argv.map((s) => pushString(s));
    const envpAddrs = envp.map((s) => pushString(s));
    const auxv = [
      [AT.PHDR, base + (elf.phdrVaddr ?? 0n)],
      [AT.PHENT, BigInt(elf.phentsize)],
      [AT.PHNUM, BigInt(elf.phnum)],
      [AT.PAGESZ, BigInt(PAGE_SIZE)],
      [AT.BASE, interpBase],
      [AT.FLAGS, 0n],
      [AT.ENTRY, base + elf.entry],
      [AT.UID, 1000n],
      [AT.EUID, 1000n],
      [AT.GID, 100n],
      [AT.EGID, 100n],
      [AT.SECURE, 0n],
      [AT.RANDOM, randomAddr],
      [AT.HWCAP, 0x178bfbffn],
      [AT.HWCAP2, 0n],
      [AT.CLKTCK, 100n],
      [AT.PLATFORM, platformAddr],
      [AT.EXECFN, execfnAddr],
      [AT.NULL, 0n],
    ];
    const words = 1 + argvAddrs.length + 1 + envpAddrs.length + 1 + auxv.length * 2;
    sp &= ~0xfn;
    if ((words & 1) === 1) {
      sp -= 8n;
    }
    sp -= BigInt(words * 8);
    let p = sp;
    const put = (v) => {
      m.write64(p, v);
      p += 8n;
    };
    put(BigInt(argvAddrs.length));
    for (const a of argvAddrs) {
      put(a);
    }
    put(0n);
    for (const e of envpAddrs) {
      put(e);
    }
    put(0n);
    for (const [k, v] of auxv) {
      put(BigInt(k));
      put(v);
    }
    return sp;
  }

  run() {
    return this.machine.run(this.entry);
  }

  // ---- state for fork and clone -------------------------------------

  serialize() {
    return {
      registers: this.machine.saveState(),
      sigactions: this.sigactions.map((a) => (a === null ? null : { handler: a.handler.toString(), flags: a.flags.toString(), restorer: a.restorer.toString(), mask: a.mask.toString() })),
      sigmask: this.sigmask.toString(),
      altStack: this.altStack === null ? null : { sp: this.altStack.sp.toString(), size: this.altStack.size },
      tidAddress: this.tidAddress.toString(),
      exePath: this.exePath,
      argv: this.argv,
      entry: this.entry.toString(),
      mappings: this.mappings.map((m) => ({ lo: m.lo.toString(), hi: m.hi.toString(), base: m.base.toString(), file: m.file })),
    };
  }

  restore(state) {
    this.sigactions = state.sigactions.map((a) => (a === null ? null : { handler: BigInt(a.handler), flags: BigInt(a.flags), restorer: BigInt(a.restorer), mask: BigInt(a.mask) }));
    this.sigmask = BigInt(state.sigmask);
    this.altStack = state.altStack ? { sp: BigInt(state.altStack.sp), size: state.altStack.size } : null;
    this.tidAddress = BigInt(state.tidAddress);
    this.exePath = state.exePath;
    this.argv = state.argv;
    this.entry = BigInt(state.entry);
    this.mappings = state.mappings.map((m) => ({ lo: BigInt(m.lo), hi: BigInt(m.hi), base: BigInt(m.base), file: m.file }));
    this.machine.loadState(state.registers);
  }

  // ---- syscall plumbing ---------------------------------------------

  syscall(m) {
    m.syncViews();
    const nr = Number(m.reg("rax"));
    const args = [m.reg("rdi"), m.reg("rsi"), m.reg("rdx"), m.reg("r10"), m.reg("r8"), m.reg("r9")];
    const handler = this.handlers[nr];
    let result;
    this.syscalls++;
    try {
      if (handler === undefined) {
        if (this.trace) {
          this.trace(`${NR_NAMES[nr] || nr}(...) = -ENOSYS (unimplemented)`);
        }
        result = -BigInt(E.NOSYS);
      } else {
        result = handler.call(this, ...args);
        if (typeof result !== "bigint") {
          result = BigInt(result);
        }
      }
    } catch (e) {
      if (e instanceof Errno) {
        result = -BigInt(e.errno);
      } else {
        throw e;
      }
    }
    if (this.trace && handler !== undefined) {
      const name = NR_NAMES[nr] || `#${nr}`;
      const shown = args.slice(0, 4).map((a) => `0x${a.toString(16)}`).join(", ");
      this.trace(`${name}(${shown}) = ${result >= 0n ? result : `-${-result}`}`);
    }
    m.syncViews();
    m.setReg("rax", result);
    // A signal handled by this process runs before the syscall
    // returns: its frame saves the result already in rax, so the
    // handler's return lands in the caller with it.
    if (nr !== NR.rt_sigreturn && this.channel.peekPending() !== 0) {
      this.deliverSignals(result, nr);
    }
  }

  str(addr) {
    const m = this.machine;
    const start = Number(addr);
    let end = start;
    while (m.u8[end] !== 0) {
      end++;
    }
    // A copy: guest memory is shared, and a browser's TextDecoder
    // refuses a view of it.
    return new TextDecoder().decode(m.u8.slice(start, end));
  }

  // Copies the kernel's payload into guest memory.
  copyOut(addr, max = Infinity) {
    const bytes = this.kbytes();
    const n = Math.min(bytes.length, max);
    this.machine.syncViews();
    this.machine.u8.set(bytes.subarray(0, n), Number(addr));
    return n;
  }

  guestBytes(addr, len) {
    return this.machine.u8.subarray(Number(addr), Number(addr) + Number(len));
  }

  // ---- signals ------------------------------------------------------

  reportDispositions() {
    let ignored = 0;
    let handled = 0;
    for (let sig = 1; sig < 32; sig++) {
      const a = this.sigactions[sig];
      if (a === null) {
        continue;
      }
      if (a.handler === SIG_IGN) {
        ignored |= 1 << (sig - 1);
      } else if (a.handler !== SIG_DFL) {
        handled |= 1 << (sig - 1);
      }
    }
    this.channel.call(OP_SIGDISPOSITION, [ignored, handled]);
  }

  // Runs the handlers of pending signals by pushing a frame; the
  // syscall that was interrupted answers EINTR unless its handler asks
  // for a restart.
  deliverSignals(result, nr) {
    let pending = this.channel.takePending();
    let restart = false;
    for (let sig = 1; sig < 32 && pending !== 0; sig++) {
      const bit = 1 << (sig - 1);
      if (!(pending & bit)) {
        continue;
      }
      pending &= ~bit;
      if (this.sigmask & (1n << BigInt(sig - 1))) {
        // Blocked: leave it pending.
        this.channel.raise(bit);
        continue;
      }
      const a = this.sigactions[sig];
      if (a === null || a.handler === SIG_DFL || a.handler === SIG_IGN) {
        continue;
      }
      restart = restart || (a.flags & SA_RESTART) !== 0n;
      this.pushSignalFrame(sig, a);
    }
    if (result === -BigInt(E.INTR) && restart && this.signalFrames.length > 0) {
      // Re-execute the syscall when the handler returns: the frame's
      // saved rip backs up to the instruction and its rax is the number.
      const frame = this.signalFrames[this.signalFrames.length - 1];
      frame.registers.rip = (BigInt(frame.registers.rip) - 2n).toString();
      frame.registers.rax = BigInt(nr).toString();
    }
  }

  // The rt_sigframe: the restorer as return address, then siginfo and
  // ucontext with the registers, which rt_sigreturn restores from the
  // saved state rather than from what the handler may have changed.
  pushSignalFrame(sig, action) {
    const m = this.machine;
    const saved = { registers: m.saveState(), sigmask: this.sigmask };
    this.signalFrames.push(saved);
    const SA_ONSTACK = 0x08000000n;
    let sp;
    if (action.flags & SA_ONSTACK && this.altStack !== null && !this.onAltStack()) {
      sp = this.altStack.sp + BigInt(this.altStack.size);
    } else {
      sp = m.reg("rsp") - 128n;
    }
    const frameTop = sp;
    sp -= 128n; // siginfo
    const siginfo = sp;
    sp -= 968n; // ucontext + fpstate room
    const ucontext = sp;
    sp = (sp & ~0xfn) - 8n;
    m.u8.fill(0, Number(sp), Number(frameTop));
    m.write64(sp, action.restorer);
    m.write32(siginfo, sig);
    // uc_mcontext.gregs at ucontext + 40
    const gregs = ucontext + 40n;
    const order = ["r8", "r9", "r10", "r11", "r12", "r13", "r14", "r15", "rdi", "rsi", "rbp", "rbx", "rdx", "rax", "rcx", "rsp", "rip"];
    order.forEach((r, i) => m.write64(gregs + BigInt(i * 8), m.reg(r)));
    m.write64(gregs + 17n * 8n, BigInt(m.helpers.cc_eflags()));
    m.write64(ucontext + 296n, this.sigmask);
    this.sigmask |= action.mask;
    if (!(action.flags & SA_NODEFER)) {
      this.sigmask |= 1n << BigInt(sig - 1);
    }
    m.setReg("rsp", sp);
    m.setReg("rdi", BigInt(sig));
    m.setReg("rsi", siginfo);
    m.setReg("rdx", ucontext);
    m.setReg("rax", 0n);
    m.setReg("rip", action.handler);
  }

  sys_rt_sigreturn() {
    const frame = this.signalFrames.pop();
    if (frame === undefined) {
      throw new GuestFault("rt_sigreturn with no frame");
    }
    this.machine.loadState(frame.registers);
    this.sigmask = frame.sigmask;
    return this.machine.reg("rax");
  }

  // ---- handlers: kernel requests ------------------------------------

  sys_read(fd, buf, count) {
    const n = this.k(OP.READ, [fd, Math.min(Number(count), READ_CHUNK)]);
    this.copyOut(buf, Number(n));
    return n;
  }

  sys_write(fd, buf, count) {
    const len = Math.min(Number(count), READ_CHUNK);
    return this.k(OP.WRITE, [fd], this.guestBytes(buf, len));
  }

  sys_pread64(fd, buf, count, offset) {
    const n = this.k(OP.PREAD, [fd, Math.min(Number(count), READ_CHUNK), offset]);
    this.copyOut(buf, Number(n));
    return n;
  }

  sys_pwrite64(fd, buf, count, offset) {
    return this.k(OP.PWRITE, [fd, offset], this.guestBytes(buf, Math.min(Number(count), READ_CHUNK)));
  }

  iov(addr, count) {
    const m = this.machine;
    const out = [];
    for (let i = 0; i < Number(count); i++) {
      out.push([m.read64(Number(addr) + i * 16), Number(m.read64(Number(addr) + i * 16 + 8))]);
    }
    return out;
  }

  sys_readv(fd, iov, count) {
    let total = 0;
    for (const [base, len] of this.iov(iov, count)) {
      if (len === 0) {
        continue;
      }
      const n = Number(this.sys_read(fd, base, BigInt(len)));
      total += n;
      if (n < len) {
        break;
      }
    }
    return total;
  }

  sys_writev(fd, iov, count) {
    let total = 0;
    for (const [base, len] of this.iov(iov, count)) {
      if (len === 0) {
        continue;
      }
      total += Number(this.sys_write(fd, base, BigInt(len)));
    }
    return total;
  }

  sys_openat(dirfd, pathAddr, flags, mode) {
    return this.k(OP.OPENAT, [BigInt.asIntN(32, dirfd), flags, mode], packStrings([this.str(pathAddr)]));
  }

  sys_open(pathAddr, flags, mode) {
    return this.sys_openat(BigInt(AT_FDCWD), pathAddr, flags, mode);
  }

  sys_close(fd) {
    return this.k(OP.CLOSE, [fd]);
  }

  sys_lseek(fd, offset, whence) {
    return this.k(OP.LSEEK, [fd, offset, whence]);
  }

  sys_fstat(fd, buf) {
    this.k(OP.FSTAT, [fd]);
    this.copyOut(buf);
    return 0;
  }

  sys_newfstatat(dirfd, pathAddr, buf, flags) {
    this.k(OP.STATAT, [BigInt.asIntN(32, dirfd), flags], packStrings([this.str(pathAddr)]));
    this.copyOut(buf);
    return 0;
  }

  sys_stat(pathAddr, buf) {
    return this.sys_newfstatat(BigInt(AT_FDCWD), pathAddr, buf, 0n);
  }

  sys_lstat(pathAddr, buf) {
    return this.sys_newfstatat(BigInt(AT_FDCWD), pathAddr, buf, 0x100n);
  }

  sys_statx(dirfd, pathAddr, flags, mask, buf) {
    this.k(OP.STATAT, [BigInt.asIntN(32, dirfd), flags], packStrings([this.str(pathAddr)]));
    const st = this.kbytes();
    const sv = new DataView(st.buffer, st.byteOffset);
    const m = this.machine;
    const a = Number(buf);
    m.u8.fill(0, a, a + 256);
    m.write32(a, 0x7ff);
    m.write32(a + 4, Number(sv.getBigInt64(56, true)));
    m.write32(a + 16, Number(sv.getBigUint64(16, true)));
    m.write32(a + 20, sv.getUint32(28, true));
    m.write32(a + 24, sv.getUint32(32, true));
    m.view.setUint16(a + 28, sv.getUint32(24, true) & 0xffff, true);
    m.write64(a + 32, sv.getBigUint64(8, true));
    m.write64(a + 40, sv.getBigInt64(48, true));
    m.write64(a + 48, sv.getBigInt64(64, true));
    // atime, btime, ctime, mtime
    for (const [dst, src] of [[64, 72], [80, 72], [96, 104], [112, 88]]) {
      m.write64(a + dst, sv.getBigInt64(src, true));
      m.write32(a + dst + 8, Number(sv.getBigInt64(src + 8, true)));
    }
    return 0;
  }

  sys_readlinkat(dirfd, pathAddr, buf, size) {
    const n = this.k(OP.READLINKAT, [BigInt.asIntN(32, dirfd), size], packStrings([this.str(pathAddr)]));
    this.copyOut(buf, Number(n));
    return n;
  }

  sys_readlink(pathAddr, buf, size) {
    return this.sys_readlinkat(BigInt(AT_FDCWD), pathAddr, buf, size);
  }

  sys_faccessat(dirfd, pathAddr, mode) {
    return this.k(OP.FACCESSAT, [BigInt.asIntN(32, dirfd), mode], packStrings([this.str(pathAddr)]));
  }

  sys_access(pathAddr, mode) {
    return this.sys_faccessat(BigInt(AT_FDCWD), pathAddr, mode);
  }

  sys_getdents64(fd, buf, count) {
    const n = this.k(OP.GETDENTS, [fd, count]);
    this.copyOut(buf, Number(n));
    return n;
  }

  sys_mkdirat(dirfd, pathAddr, mode) {
    return this.k(OP.MKDIRAT, [BigInt.asIntN(32, dirfd), mode], packStrings([this.str(pathAddr)]));
  }

  sys_mkdir(pathAddr, mode) {
    return this.sys_mkdirat(BigInt(AT_FDCWD), pathAddr, mode);
  }

  sys_unlinkat(dirfd, pathAddr, flags) {
    return this.k(OP.UNLINKAT, [BigInt.asIntN(32, dirfd), flags], packStrings([this.str(pathAddr)]));
  }

  sys_unlink(pathAddr) {
    return this.sys_unlinkat(BigInt(AT_FDCWD), pathAddr, 0n);
  }

  sys_rmdir(pathAddr) {
    return this.sys_unlinkat(BigInt(AT_FDCWD), pathAddr, 0x200n);
  }

  sys_renameat(olddir, oldAddr, newdir, newAddr) {
    return this.k(OP.RENAMEAT, [BigInt.asIntN(32, olddir), BigInt.asIntN(32, newdir)], packStrings([this.str(oldAddr), this.str(newAddr)]));
  }

  sys_rename(oldAddr, newAddr) {
    return this.sys_renameat(BigInt(AT_FDCWD), oldAddr, BigInt(AT_FDCWD), newAddr);
  }

  sys_symlinkat(targetAddr, dirfd, pathAddr) {
    return this.k(OP.SYMLINKAT, [BigInt.asIntN(32, dirfd)], packStrings([this.str(targetAddr), this.str(pathAddr)]));
  }

  sys_symlink(targetAddr, pathAddr) {
    return this.sys_symlinkat(targetAddr, BigInt(AT_FDCWD), pathAddr);
  }

  sys_fchmodat(dirfd, pathAddr, mode) {
    return this.k(OP.FCHMODAT, [BigInt.asIntN(32, dirfd), mode], packStrings([this.str(pathAddr)]));
  }

  sys_chmod(pathAddr, mode) {
    return this.sys_fchmodat(BigInt(AT_FDCWD), pathAddr, mode);
  }

  sys_ftruncate(fd, len) {
    return this.k(OP.FTRUNCATE, [fd, len]);
  }

  sys_getcwd(buf, size) {
    this.k(OP.GETCWD, []);
    const bytes = this.kbytes();
    if (bytes.length > Number(size)) {
      throw new Errno(E.RANGE);
    }
    this.copyOut(buf);
    return bytes.length;
  }

  sys_chdir(pathAddr) {
    return this.k(OP.CHDIR, [], packStrings([this.str(pathAddr)]));
  }

  sys_fchdir(fd) {
    return this.k(OP.FCHDIR, [fd]);
  }

  sys_dup(fd) {
    return this.k(OP.DUP, [fd, 0]);
  }

  sys_dup3(fd, newfd, flags) {
    return this.k(OP.DUP3, [fd, newfd, flags]);
  }

  sys_dup2(fd, newfd) {
    if (fd === newfd) {
      this.k(OP.FCNTL, [fd, 1, 0]);
      return newfd;
    }
    return this.k(OP.DUP3, [fd, newfd, 0]);
  }

  sys_fcntl(fd, cmd, arg) {
    return this.k(OP.FCNTL, [fd, cmd, arg]);
  }

  sys_ioctl(fd, req, arg) {
    const r = Number(BigInt.asUintN(32, req));
    // Requests that read a struct from the caller carry it along.
    const inSizes = { 0x5402: 36, 0x5403: 36, 0x5404: 36, 0x402c542b: 44, 0x402c542c: 44, 0x402c542d: 44, 0x5410: 4, 0x5421: 4, 0x5414: 8 };
    const size = inSizes[r] ?? 0;
    const res = this.k(OP.IOCTL, [fd, r], size > 0 ? this.guestBytes(arg, size) : null);
    if (this.channel.responseLength > 0 && arg !== 0n) {
      this.copyOut(arg);
    }
    return res;
  }

  sys_pipe2(fdsAddr, flags) {
    this.k(OP.PIPE2, [flags]);
    this.copyOut(fdsAddr);
    return 0;
  }

  sys_pipe(fdsAddr) {
    return this.sys_pipe2(fdsAddr, 0n);
  }

  sys_umask(mask) {
    return this.k(OP.UMASK, [mask]);
  }

  sys_epoll_create1(flags) {
    return this.k(OP.EPOLL_CREATE, [flags]);
  }

  sys_epoll_ctl(epfd, op, fd, event) {
    const events = this.machine.read32(event);
    const data = this.machine.read64(event + 4n);
    return this.k(OP.EPOLL_CTL, [epfd, op, fd, events, data]);
  }

  sys_epoll_wait(epfd, events, maxevents, timeout) {
    const ms = Number(BigInt.asIntN(32, timeout));
    const deadline = ms < 0 ? Infinity : performance.now() + ms;
    for (;;) {
      const n = Number(this.k(OP.EPOLL_WAIT, [epfd, maxevents]));
      if (n > 0 || performance.now() >= deadline) {
        this.copyOut(events);
        return n;
      }
      this.sleepSlice(Math.min(POLL_SLICE_MS, deadline - performance.now()));
    }
  }

  sys_eventfd2(initial, flags) {
    return this.k(OP.EVENTFD, [initial, flags]);
  }

  // poll: readiness from the kernel, the timeout kept here.
  sys_poll(fds, nfds, timeout) {
    const m = this.machine;
    const n = Number(nfds);
    const ms = Number(BigInt.asIntN(32, timeout));
    const deadline = ms < 0 ? Infinity : performance.now() + ms;
    const req = new Uint8Array(n * 8);
    const rv = new DataView(req.buffer);
    for (let i = 0; i < n; i++) {
      rv.setInt32(i * 8, m.view.getInt32(Number(fds) + i * 8, true), true);
      rv.setInt32(i * 8 + 4, m.view.getInt16(Number(fds) + i * 8 + 4, true), true);
    }
    for (;;) {
      const ready = Number(this.k(OP.READY, [], req));
      if (ready > 0 || performance.now() >= deadline) {
        const out = this.kbytes();
        const ov = new DataView(out.buffer, out.byteOffset);
        for (let i = 0; i < n; i++) {
          m.view.setInt16(Number(fds) + i * 8 + 6, ov.getInt32(i * 4, true), true);
        }
        return ready;
      }
      this.sleepSlice(Math.min(POLL_SLICE_MS, deadline - performance.now()));
    }
  }

  sys_ppoll(fds, nfds, ts) {
    let ms = -1;
    if (ts !== 0n) {
      ms = Number(this.machine.read64(ts)) * 1000 + Number(this.machine.read64(ts + 8n)) / 1e6;
    }
    return this.sys_poll(fds, nfds, BigInt(Math.round(ms)));
  }

  sys_select(nfds, readAddr, writeAddr, exceptAddr, timeoutAddr, isPselect = false) {
    const m = this.machine;
    const n = Number(nfds);
    let ms = -1;
    if (timeoutAddr !== 0n) {
      const sec = Number(m.read64(timeoutAddr));
      const sub = Number(m.read64(timeoutAddr + 8n));
      ms = sec * 1000 + (isPselect ? sub / 1e6 : sub / 1e3);
    }
    const deadline = ms < 0 ? Infinity : performance.now() + ms;
    const bitSet = (addr, fd) => addr !== 0n && (m.u8[Number(addr) + (fd >> 3)] >> (fd & 7)) & 1;
    const wanted = [];
    for (let fd = 0; fd < n; fd++) {
      const ev = (bitSet(readAddr, fd) ? 1 : 0) | (bitSet(writeAddr, fd) ? 4 : 0);
      if (ev !== 0) {
        wanted.push([fd, ev]);
      }
    }
    const req = new Uint8Array(wanted.length * 8);
    const rv = new DataView(req.buffer);
    wanted.forEach(([fd, ev], i) => {
      rv.setInt32(i * 8, fd, true);
      rv.setInt32(i * 8 + 4, ev, true);
    });
    for (;;) {
      const ready = Number(this.k(OP.READY, [], req));
      if (ready > 0 || performance.now() >= deadline || wanted.length === 0) {
        const out = this.kbytes();
        const ov = new DataView(out.buffer, out.byteOffset);
        const words = Math.ceil(Math.max(n, 1) / 64) * 8;
        for (const addr of [readAddr, writeAddr, exceptAddr]) {
          if (addr !== 0n) {
            m.u8.fill(0, Number(addr), Number(addr) + words);
          }
        }
        let count = 0;
        wanted.forEach(([fd, ev], i) => {
          const r = ov.getInt32(i * 4, true);
          if (r & 1 && ev & 1) {
            m.u8[Number(readAddr) + (fd >> 3)] |= 1 << (fd & 7);
            count++;
          }
          if (r & 4 && ev & 4) {
            m.u8[Number(writeAddr) + (fd >> 3)] |= 1 << (fd & 7);
            count++;
          }
        });
        return count;
      }
      this.sleepSlice(Math.min(POLL_SLICE_MS, deadline - performance.now()));
    }
  }

  sys_pselect6(nfds, r, w, x, t) {
    return this.sys_select(nfds, r, w, x, t, true);
  }

  // ---- memory -------------------------------------------------------

  sys_mmap(addr, length, prot, flags, fd, offset) {
    const at = this.k(OP_MMAP, [addr, length, prot, flags, BigInt.asIntN(32, fd), offset]);
    const [needZero, file] = this.kstrings();
    const len = Number(length);
    const size = (len + PAGE_SIZE - 1) & ~(PAGE_SIZE - 1);
    const m = this.machine;
    m.syncViews();
    if (needZero !== "0") {
      m.u8.fill(0, Number(at), Number(at) + size);
    }
    this.forgetMappings(at, at + BigInt(size));
    if (file !== "") {
      this.readInto(Number(fd), Number(at), Number(offset), len);
    }
    return at;
  }

  sys_munmap(addr, length) {
    this.forgetMappings(addr & PAGE_MASK, (addr + length + 0xfffn) & PAGE_MASK);
    return this.k(OP_MUNMAP, [addr, length]);
  }

  sys_mremap(oldAddr, oldSize, newSize, flags) {
    const os = Number(oldSize);
    const ns = Number(newSize);
    if (ns <= os) {
      if (ns < os) {
        this.sys_munmap(oldAddr + BigInt((ns + 0xfff) & ~0xfff), BigInt(os - ((ns + 0xfff) & ~0xfff)));
      }
      return oldAddr;
    }
    if (!(Number(flags) & 1)) {
      throw new Errno(E.NOMEM);
    }
    const at = this.allocate((ns + 0xfff) & ~0xfff);
    const m = this.machine;
    m.u8.copyWithin(Number(at), Number(oldAddr), Number(oldAddr) + os);
    this.sys_munmap(oldAddr, oldSize);
    return at;
  }

  sys_brk(addr) {
    const r = this.k(OP_BRK, [addr]);
    if (this.channel.responseLength > 0) {
      const [old] = this.kstrings();
      const from = BigInt(old);
      const m = this.machine;
      m.syncViews();
      if (r > from) {
        m.u8.fill(0, Number(from), Number(r));
      }
    }
    return r;
  }

  sys_arch_prctl(code, addr) {
    const m = this.machine;
    switch (Number(code)) {
      case ARCH_SET_FS:
        m.setReg("fs_base", addr);
        return 0;
      case ARCH_SET_GS:
        m.setReg("gs_base", addr);
        return 0;
      case ARCH_GET_FS:
        m.write64(addr, m.reg("fs_base"));
        return 0;
      case ARCH_GET_GS:
        m.write64(addr, m.reg("gs_base"));
        return 0;
      default:
        throw new Errno(E.INVAL);
    }
  }

  // ---- signals, futexes, sleeping -----------------------------------

  sys_rt_sigaction(sig, act, oldact) {
    const n = Number(sig);
    if (n < 1 || n >= SIG_COUNT) {
      throw new Errno(E.INVAL);
    }
    const m = this.machine;
    if (oldact !== 0n) {
      const a = Number(oldact);
      const old = this.sigactions[n];
      m.u8.fill(0, a, a + 32);
      if (old) {
        m.write64(a, old.handler);
        m.write64(a + 8, old.flags);
        m.write64(a + 16, old.restorer);
        m.write64(a + 24, old.mask);
      }
    }
    if (act !== 0n) {
      const a = Number(act);
      this.sigactions[n] = { handler: m.read64(a), flags: m.read64(a + 8), restorer: m.read64(a + 16), mask: m.read64(a + 24) };
      if (n < 32) {
        this.reportDispositions();
      }
    }
    return 0;
  }

  sys_rt_sigprocmask(how, set, oldset) {
    const m = this.machine;
    if (oldset !== 0n) {
      m.write64(oldset, this.sigmask);
    }
    if (set !== 0n) {
      const v = m.read64(set);
      switch (Number(how)) {
        case 0: this.sigmask |= v; break;
        case 1: this.sigmask &= ~v; break;
        case 2: this.sigmask = v; break;
        default: throw new Errno(E.INVAL);
      }
    }
    return 0;
  }

  sys_rt_sigsuspend(set) {
    const old = this.sigmask;
    this.sigmask = this.machine.read64(set);
    try {
      for (;;) {
        if (this.channel.peekPending() !== 0) {
          break;
        }
        this.sleepSlice(WAIT_SLICE_MS);
      }
    } finally {
      // The handler runs on the way out; the mask is restored by the
      // caller's expectation that sigsuspend returns EINTR.
    }
    this.sigmask = old;
    throw new Errno(E.INTR);
  }

  sys_sigaltstack(ss, oldss) {
    const m = this.machine;
    const SS_ONSTACK = 1;
    const SS_DISABLE = 2;
    if (oldss !== 0n) {
      const a = Number(oldss);
      m.u8.fill(0, a, a + 24);
      if (this.altStack === null) {
        m.write32(a + 8, SS_DISABLE);
      } else {
        m.write64(a, this.altStack.sp);
        m.write32(a + 8, this.onAltStack() ? SS_ONSTACK : 0);
        m.write64(a + 16, BigInt(this.altStack.size));
      }
    }
    if (ss !== 0n) {
      const a = Number(ss);
      const flags = m.read32(a + 8);
      if (flags & SS_DISABLE) {
        this.altStack = null;
      } else {
        this.altStack = { sp: m.read64(a), size: Number(m.read64(a + 16)) };
      }
    }
    return 0;
  }

  onAltStack() {
    if (this.altStack === null) {
      return false;
    }
    const rsp = this.machine.reg("rsp");
    return rsp >= this.altStack.sp && rsp < this.altStack.sp + BigInt(this.altStack.size);
  }

  sys_kill(pid, sig) {
    return this.k(OP.KILL, [BigInt.asIntN(32, pid), sig]);
  }

  sys_tgkill(tgid, tid, sig) {
    return this.k(OP.TGKILL, [tgid, tid, sig]);
  }

  sys_pause() {
    for (;;) {
      if (this.channel.peekPending() !== 0) {
        throw new Errno(E.INTR);
      }
      this.sleepSlice(WAIT_SLICE_MS);
    }
  }

  // A short blocking sleep on a private word.
  sleepSlice(ms) {
    if (ms <= 0) {
      return;
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  }

  sys_futex(uaddr, op, val, timeoutAddr) {
    const cmd = Number(op) & FUTEX_CMD_MASK;
    const m = this.machine;
    const index = Number(uaddr) >> 2;
    if ((Number(uaddr) & 3) !== 0) {
      throw new Errno(E.INVAL);
    }
    if (cmd === FUTEX_WAIT || cmd === FUTEX_WAIT_BITSET) {
      const expected = Number(BigInt.asIntN(32, val));
      let deadline = Infinity;
      if (timeoutAddr !== 0n) {
        const sec = Number(m.read64(timeoutAddr));
        const nsec = Number(m.read64(timeoutAddr + 8n));
        const ms = sec * 1000 + nsec / 1e6;
        // FUTEX_WAIT's timeout is relative; the bitset form's absolute.
        deadline = cmd === FUTEX_WAIT ? performance.now() + ms : (Number(op) & 256 ? Date.now() : performance.now()) + 0 + ms - (Number(op) & 256 ? Date.now() : performance.now()) + performance.now();
        if (cmd === FUTEX_WAIT_BITSET) {
          const now = Number(op) & 256 ? Date.now() : performance.now();
          deadline = performance.now() + (ms - now);
        }
      }
      for (;;) {
        if (Atomics.load(m.i32, index) !== expected) {
          if (Atomics.load(m.i32, index) !== expected) {
            throw new Errno(E.AGAIN);
          }
        }
        const remaining = deadline - performance.now();
        if (remaining <= 0) {
          throw new Errno(E.TIMEDOUT);
        }
        const r = Atomics.wait(m.i32, index, expected, Math.min(remaining, WAIT_SLICE_MS));
        if (r === "ok" || r === "not-equal") {
          return 0;
        }
        if (this.channel.peekPending() !== 0) {
          throw new Errno(E.INTR);
        }
      }
    }
    if (cmd === FUTEX_WAKE || cmd === FUTEX_WAKE_BITSET) {
      return Atomics.notify(m.i32, index, Number(BigInt.asIntN(32, val)));
    }
    throw new Errno(E.NOSYS);
  }

  sys_nanosleep(req) {
    const m = this.machine;
    const ms = Number(m.read64(req)) * 1000 + Number(m.read64(req + 8n)) / 1e6;
    const deadline = performance.now() + ms;
    while (performance.now() < deadline) {
      this.sleepSlice(Math.min(WAIT_SLICE_MS, deadline - performance.now()));
      if (this.channel.peekPending() !== 0) {
        throw new Errno(E.INTR);
      }
    }
    return 0;
  }

  sys_clock_nanosleep(clock, flags, req) {
    return this.sys_nanosleep(req);
  }

  // ---- processes ----------------------------------------------------

  sys_fork() {
    const state = this.serialize();
    // The child resumes after this syscall with rax = 0.
    state.registers.rax = "0";
    const pid = this.k(OP.FORK, [], new TextEncoder().encode(JSON.stringify(state)));
    return pid;
  }

  sys_clone(flags, stack, ptid, ctid, tls) {
    const f = Number(flags & 0xffffffffn);
    if (!(f & CLONE_VM) || !(f & CLONE_THREAD)) {
      // A fork with clone flags: the child is a process.
      return this.sys_fork();
    }
    const state = this.serialize();
    state.registers.rax = "0";
    if (stack !== 0n) {
      state.registers.rsp = stack.toString();
    }
    if (f & CLONE_SETTLS) {
      state.registers.fs_base = tls.toString();
    }
    state.setTid = f & CLONE_CHILD_SETTID ? ctid.toString() : "0";
    state.clearTid = f & CLONE_CHILD_CLEARTID ? ctid.toString() : "0";
    const tid = this.k(OP.CLONE, [flags], new TextEncoder().encode(JSON.stringify(state)));
    if (f & CLONE_PARENT_SETTID) {
      this.machine.write32(ptid, Number(tid));
    }
    return tid;
  }

  sys_clone3(args, size) {
    const m = this.machine;
    const flags = m.read64(args);
    const pidfd = m.read64(args + 8n);
    const ctid = m.read64(args + 16n);
    const ptid = m.read64(args + 24n);
    const stack = m.read64(args + 40n);
    const stackSize = m.read64(args + 48n);
    const tls = m.read64(args + 56n);
    return this.sys_clone(flags, stack === 0n ? 0n : stack + stackSize, ptid, ctid, tls);
  }

  sys_vfork() {
    return this.sys_fork();
  }

  sys_execve(pathAddr, argvAddr, envpAddr) {
    const m = this.machine;
    const readList = (addr) => {
      const out = [];
      for (let p = Number(addr); ; p += 8) {
        const s = m.read64(p);
        if (s === 0n) {
          break;
        }
        out.push(this.str(s));
      }
      return out;
    };
    let path = this.str(pathAddr);
    let argv = readList(argvAddr);
    const envp = readList(envpAddr);
    // The file must exist and be runnable; a script names its
    // interpreter on its first line.
    for (let depth = 0; depth < 4; depth++) {
      const fd = Number(this.k(OP.OPENAT, [AT_FDCWD, O.RDONLY | O.CLOEXEC, 0], packStrings([path])));
      const n = Number(this.k(OP.PREAD, [fd, 256, 0]));
      const head = this.kbytes().slice(0, n);
      this.k(OP.CLOSE, [fd]);
      if (n >= 2 && head[0] === 0x23 && head[1] === 0x21) {
        const line = new TextDecoder().decode(head.slice(2, head.indexOf(10) === -1 ? n : head.indexOf(10))).trim();
        const parts = line.split(/\s+/).filter(Boolean);
        argv = [parts[0], ...(parts.length > 1 ? [parts.slice(1).join(" ")] : []), path, ...argv.slice(1)];
        path = parts[0];
        continue;
      }
      if (n < 4 || head[0] !== 0x7f || head[1] !== 0x45) {
        throw new Errno(E.NOEXEC);
      }
      break;
    }
    throw new ExecRequest(path, argv, envp);
  }

  sys_exit(code) {
    // The last thread's exit ends the process; the kernel decides.
    if (this.clearTid !== 0n) {
      this.machine.write32(this.clearTid, 0);
      Atomics.notify(this.machine.i32, Number(this.clearTid) >> 2);
    }
    this.channel.call(OP.EXIT, [code & 0xffn]);
    throw new ProcessExit(Number(code & 0xffn));
  }

  sys_exit_group(code) {
    if (this.beforeExit) {
      this.beforeExit();
    }
    this.channel.call(OP.EXIT_GROUP, [code & 0xffn]);
    throw new ProcessExit(Number(code & 0xffn));
  }

  sys_wait4(pid, status, options) {
    const r = this.k(OP.WAIT4, [BigInt.asIntN(32, pid), options]);
    if (r > 0n && status !== 0n) {
      this.copyOut(status, 4);
    }
    return r;
  }

  sys_getpid() {
    return this.pid;
  }

  sys_gettid() {
    return this.tid;
  }

  sys_getppid() {
    return this.k(OP.GETPPID, []);
  }

  sys_setpgid(pid, pgid) {
    return this.k(OP.SETPGID, [pid, pgid]);
  }

  sys_getpgid(pid) {
    return this.k(OP.GETPGID, [pid]);
  }

  sys_getpgrp() {
    return this.k(OP.GETPGID, [0]);
  }

  sys_setsid() {
    return this.k(OP.SETSID, []);
  }

  sys_set_tid_address(addr) {
    this.tidAddress = addr;
    this.clearTid = addr;
    return this.tid;
  }

  // ---- local odds and ends ------------------------------------------

  sys_clock_gettime(clock, ts) {
    const m = this.machine;
    const ns = Number(clock) === CLOCK_REALTIME ? BigInt(Date.now()) * 1000000n : BigInt(Math.round(performance.now() * 1e6));
    m.write64(ts, ns / 1000000000n);
    m.write64(ts + 8n, ns % 1000000000n);
    return 0;
  }

  sys_clock_getres(clock, ts) {
    if (ts !== 0n) {
      this.machine.write64(ts, 0n);
      this.machine.write64(ts + 8n, 1000n);
    }
    return 0;
  }

  sys_gettimeofday(tv) {
    if (tv !== 0n) {
      const ms = BigInt(Date.now());
      this.machine.write64(tv, ms / 1000n);
      this.machine.write64(tv + 8n, (ms % 1000n) * 1000n);
    }
    return 0;
  }

  sys_time(tloc) {
    const now = BigInt(Math.floor(Date.now() / 1000));
    if (tloc !== 0n) {
      this.machine.write64(tloc, now);
    }
    return now;
  }

  sys_getrandom(buf, len) {
    const n = Number(len);
    // Into a private buffer first: shared memory cannot be filled
    // directly.
    const tmp = new Uint8Array(n);
    for (let i = 0; i < n; i += 65536) {
      crypto.getRandomValues(tmp.subarray(i, Math.min(n, i + 65536)));
    }
    this.machine.u8.set(tmp, Number(buf));
    return n;
  }

  sys_uname(buf) {
    const m = this.machine;
    const a = Number(buf);
    m.u8.fill(0, a, a + 6 * 65);
    const enc = new TextEncoder();
    ["Linux", "trynix", "6.6.0", "#1 SMP", "x86_64", "(none)"].forEach((s, i) => {
      m.u8.set(enc.encode(s), a + i * 65);
    });
    return 0;
  }

  sys_prlimit64(pid, resource, newlim, oldlim) {
    if (oldlim !== 0n) {
      const LIMITS = { 3: [STACK_SIZE, STACK_SIZE], 7: [1024, 4096], 6: [0, 0] };
      const [cur, max] = LIMITS[Number(resource)] || [-1, -1];
      this.machine.write64(oldlim, BigInt.asUintN(64, BigInt(cur)));
      this.machine.write64(oldlim + 8n, BigInt.asUintN(64, BigInt(max)));
    }
    return 0;
  }

  sys_getrlimit(resource, rlim) {
    return this.sys_prlimit64(0n, resource, 0n, rlim);
  }

  sys_sysinfo(info) {
    const m = this.machine;
    const a = Number(info);
    m.u8.fill(0, a, a + 112);
    m.write64(a, BigInt(Math.floor(performance.now() / 1000)));
    m.write64(a + 32, BigInt(m.size));
    m.write64(a + 40, BigInt(m.size / 2));
    m.view.setUint16(a + 96, 1, true);
    m.write32(a + 104, 1);
    return 0;
  }

  sys_getuid() {
    return 1000;
  }

  sys_getgid() {
    return 100;
  }

  sys_getresuid(r, e, s) {
    for (const a of [r, e, s]) {
      this.machine.write32(a, 1000);
    }
    return 0;
  }

  sys_getresgid(r, e, s) {
    for (const a of [r, e, s]) {
      this.machine.write32(a, 100);
    }
    return 0;
  }

  sys_getgroups(size, list) {
    if (Number(size) > 0) {
      this.machine.write32(list, 100);
    }
    return 1;
  }

  sys_sched_getaffinity(pid, size, mask) {
    const n = Number(size);
    if (n < 8) {
      throw new Errno(E.INVAL);
    }
    this.machine.u8.fill(0, Number(mask), Number(mask) + n);
    this.machine.u8[Number(mask)] = 1;
    return 8;
  }

  sys_ok() {
    return 0;
  }

  sys_nosys() {
    throw new Errno(E.NOSYS);
  }
}

Process.prototype.handlers = {
  [NR.read]: Process.prototype.sys_read,
  [NR.write]: Process.prototype.sys_write,
  [NR.open]: Process.prototype.sys_open,
  [NR.close]: Process.prototype.sys_close,
  [NR.stat]: Process.prototype.sys_stat,
  [NR.fstat]: Process.prototype.sys_fstat,
  [NR.lstat]: Process.prototype.sys_lstat,
  [NR.poll]: Process.prototype.sys_poll,
  [NR.lseek]: Process.prototype.sys_lseek,
  [NR.mmap]: Process.prototype.sys_mmap,
  [NR.mprotect]: Process.prototype.sys_ok,
  [NR.munmap]: Process.prototype.sys_munmap,
  [NR.brk]: Process.prototype.sys_brk,
  [NR.rt_sigaction]: Process.prototype.sys_rt_sigaction,
  [NR.rt_sigprocmask]: Process.prototype.sys_rt_sigprocmask,
  [NR.rt_sigreturn]: Process.prototype.sys_rt_sigreturn,
  [NR.ioctl]: Process.prototype.sys_ioctl,
  [NR.pread64]: Process.prototype.sys_pread64,
  [NR.pwrite64]: Process.prototype.sys_pwrite64,
  [NR.readv]: Process.prototype.sys_readv,
  [NR.writev]: Process.prototype.sys_writev,
  [NR.access]: Process.prototype.sys_access,
  [NR.pipe]: Process.prototype.sys_pipe,
  [NR.select]: Process.prototype.sys_select,
  [NR.sched_yield]: Process.prototype.sys_ok,
  [NR.mremap]: Process.prototype.sys_mremap,
  [NR.msync]: Process.prototype.sys_ok,
  [NR.madvise]: Process.prototype.sys_ok,
  [NR.dup]: Process.prototype.sys_dup,
  [NR.dup2]: Process.prototype.sys_dup2,
  [NR.pause]: Process.prototype.sys_pause,
  [NR.nanosleep]: Process.prototype.sys_nanosleep,
  [NR.getpid]: Process.prototype.sys_getpid,
  [NR.clone]: Process.prototype.sys_clone,
  [NR.fork]: Process.prototype.sys_fork,
  [NR.vfork]: Process.prototype.sys_vfork,
  [NR.execve]: Process.prototype.sys_execve,
  [NR.exit]: Process.prototype.sys_exit,
  [NR.wait4]: Process.prototype.sys_wait4,
  [NR.kill]: Process.prototype.sys_kill,
  [NR.uname]: Process.prototype.sys_uname,
  [NR.fcntl]: Process.prototype.sys_fcntl,
  [NR.flock]: Process.prototype.sys_ok,
  [NR.fsync]: Process.prototype.sys_ok,
  [NR.fdatasync]: Process.prototype.sys_ok,
  [NR.ftruncate]: Process.prototype.sys_ftruncate,
  [NR.getcwd]: Process.prototype.sys_getcwd,
  [NR.chdir]: Process.prototype.sys_chdir,
  [NR.fchdir]: Process.prototype.sys_fchdir,
  [NR.rename]: Process.prototype.sys_rename,
  [NR.mkdir]: Process.prototype.sys_mkdir,
  [NR.rmdir]: Process.prototype.sys_rmdir,
  [NR.unlink]: Process.prototype.sys_unlink,
  [NR.symlink]: Process.prototype.sys_symlink,
  [NR.readlink]: Process.prototype.sys_readlink,
  [NR.chmod]: Process.prototype.sys_chmod,
  [NR.umask]: Process.prototype.sys_umask,
  [NR.gettimeofday]: Process.prototype.sys_gettimeofday,
  [NR.getrlimit]: Process.prototype.sys_getrlimit,
  [NR.sysinfo]: Process.prototype.sys_sysinfo,
  [NR.getuid]: Process.prototype.sys_getuid,
  [NR.getgid]: Process.prototype.sys_getgid,
  [NR.geteuid]: Process.prototype.sys_getuid,
  [NR.getegid]: Process.prototype.sys_getgid,
  [NR.setpgid]: Process.prototype.sys_setpgid,
  [NR.getppid]: Process.prototype.sys_getppid,
  [NR.getpgrp]: Process.prototype.sys_getpgrp,
  [NR.setsid]: Process.prototype.sys_setsid,
  [NR.getgroups]: Process.prototype.sys_getgroups,
  [NR.getresuid]: Process.prototype.sys_getresuid,
  [NR.getresgid]: Process.prototype.sys_getresgid,
  [NR.getpgid]: Process.prototype.sys_getpgid,
  [NR.getsid]: Process.prototype.sys_getpid,
  [NR.rt_sigsuspend]: Process.prototype.sys_rt_sigsuspend,
  [NR.sigaltstack]: Process.prototype.sys_sigaltstack,
  [NR.arch_prctl]: Process.prototype.sys_arch_prctl,
  [NR.gettid]: Process.prototype.sys_gettid,
  [NR.time]: Process.prototype.sys_time,
  [NR.futex]: Process.prototype.sys_futex,
  [NR.sched_getaffinity]: Process.prototype.sys_sched_getaffinity,
  [NR.epoll_create]: Process.prototype.sys_epoll_create1,
  [NR.getdents64]: Process.prototype.sys_getdents64,
  [NR.set_tid_address]: Process.prototype.sys_set_tid_address,
  [NR.clock_gettime]: Process.prototype.sys_clock_gettime,
  [NR.clock_getres]: Process.prototype.sys_clock_getres,
  [NR.clock_nanosleep]: Process.prototype.sys_clock_nanosleep,
  [NR.exit_group]: Process.prototype.sys_exit_group,
  [NR.epoll_wait]: Process.prototype.sys_epoll_wait,
  [NR.epoll_ctl]: Process.prototype.sys_epoll_ctl,
  [NR.tgkill]: Process.prototype.sys_tgkill,
  [NR.openat]: Process.prototype.sys_openat,
  [NR.mkdirat]: Process.prototype.sys_mkdirat,
  [NR.newfstatat]: Process.prototype.sys_newfstatat,
  [NR.unlinkat]: Process.prototype.sys_unlinkat,
  [NR.renameat]: Process.prototype.sys_renameat,
  [NR.symlinkat]: Process.prototype.sys_symlinkat,
  [NR.readlinkat]: Process.prototype.sys_readlinkat,
  [NR.fchmodat]: Process.prototype.sys_fchmodat,
  [NR.faccessat]: Process.prototype.sys_faccessat,
  [NR.faccessat2]: Process.prototype.sys_faccessat,
  [NR.pselect6]: Process.prototype.sys_pselect6,
  [NR.ppoll]: Process.prototype.sys_ppoll,
  [NR.set_robust_list]: Process.prototype.sys_ok,
  [NR.epoll_pwait]: Process.prototype.sys_epoll_wait,
  [NR.eventfd2]: Process.prototype.sys_eventfd2,
  [NR.epoll_create1]: Process.prototype.sys_epoll_create1,
  [NR.dup3]: Process.prototype.sys_dup3,
  [NR.pipe2]: Process.prototype.sys_pipe2,
  [NR.prlimit64]: Process.prototype.sys_prlimit64,
  [NR.getrandom]: Process.prototype.sys_getrandom,
  [NR.statx]: Process.prototype.sys_statx,
  [NR.rseq]: Process.prototype.sys_nosys,
  [NR.clone3]: Process.prototype.sys_clone3,
  [NR.prctl]: Process.prototype.sys_ok,
};

export { LOOKUP_RESERVE };
