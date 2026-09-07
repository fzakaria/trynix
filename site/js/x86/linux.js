// A Linux process without a Linux: the loader and the system calls.
//
// A Process owns one Machine's address space. It maps an ELF and its
// interpreter, builds the initial stack the way the kernel does (argv,
// envp and the auxiliary vector), and answers every `syscall` the
// translated code makes, against a filesystem backend and a set of
// stdio streams supplied by whoever created it.
//
// The syscalls implemented are the ones a command-line program makes.
// Anything else returns ENOSYS, which glibc and musl treat as "this
// kernel is old" and work around, so an unknown syscall is a message in
// the trace rather than a crash.
import { E, Errno } from "./errno.js";
import { parseElf, PF } from "./elf.js";
import { GuestFault, ProcessExit } from "./machine.js";

const PAGE_SIZE = 4096;
const PAGE_MASK = ~0xfffn;

// Where things go. Non-PIE executables carry their own addresses
// (0x400000 by convention); a PIE lands at EXE_BASE; the heap follows
// the executable; shared objects, the stack and anonymous mappings come
// from the mmap region.
const EXE_BASE = 0x10000000n;
const MMAP_BASE = 0x20000000n;
const BRK_RESERVE = 64 << 20;
const STACK_SIZE = 8 << 20;

// Auxiliary vector tags.
const AT = Object.freeze({
  NULL: 0, PHDR: 3, PHENT: 4, PHNUM: 5, PAGESZ: 6, BASE: 7, FLAGS: 8, ENTRY: 9,
  UID: 11, EUID: 12, GID: 13, EGID: 14, PLATFORM: 15, HWCAP: 16, CLKTCK: 17,
  SECURE: 23, RANDOM: 25, HWCAP2: 26, EXECFN: 31, SYSINFO_EHDR: 33,
});

const PROT = Object.freeze({ READ: 1, WRITE: 2, EXEC: 4 });
const MAP = Object.freeze({ SHARED: 1, PRIVATE: 2, FIXED: 0x10, ANONYMOUS: 0x20, FIXED_NOREPLACE: 0x100000 });

const O = Object.freeze({
  RDONLY: 0, WRONLY: 1, RDWR: 2, ACCMODE: 3, CREAT: 0o100, EXCL: 0o200, NOCTTY: 0o400,
  TRUNC: 0o1000, APPEND: 0o2000, NONBLOCK: 0o4000, DIRECTORY: 0o200000, NOFOLLOW: 0o400000,
  CLOEXEC: 0o2000000, PATH: 0o10000000,
});

const AT_FDCWD = -100;
const AT_SYMLINK_NOFOLLOW = 0x100;
const AT_EMPTY_PATH = 0x1000;

const S_IFMT = 0o170000;
const S_IFDIR = 0o040000;
const S_IFCHR = 0o020000;
const S_IFREG = 0o100000;
const S_IFLNK = 0o120000;
const S_IFIFO = 0o010000;

const ARCH_SET_GS = 0x1001;
const ARCH_SET_FS = 0x1002;
const ARCH_GET_FS = 0x1003;
const ARCH_GET_GS = 0x1004;

const FUTEX_WAIT = 0;
const FUTEX_WAKE = 1;
const FUTEX_CMD_MASK = 0x7f;

const TCGETS = 0x5401;
const TCSETS = 0x5402;
const TCSETSW = 0x5403;
const TCSETSF = 0x5404;
// The termios2 forms glibc 2.42 tries first: the same 36 bytes plus
// input and output speeds.
const TCGETS2 = 0x802c542a;
const TCSETS2 = 0x402c542b;
const TCSETSW2 = 0x402c542c;
const TCSETSF2 = 0x402c542d;
const TERMIOS_CC_LEN = 19;
const TERMIOS_CC_OFFSET = 17;
const TERMIOS_SIZE = 36;
const TERMIOS2_SIZE = 44;
const DEFAULT_TERMIOS = { iflag: 0x6500, oflag: 0x5, cflag: 0xbf, lflag: 0x8a3b, cc: null };
const DEFAULT_CC = [3, 28, 127, 21, 4, 0, 1, 0, 17, 19, 26, 0, 18, 15, 23, 22, 0, 0, 0];
const BAUD_38400 = 38400;
const TIOCGWINSZ = 0x5413;
const TIOCSWINSZ = 0x5414;
const TIOCGPGRP = 0x540f;
const TIOCSPGRP = 0x5410;
const FIONREAD = 0x541b;

const F_DUPFD = 0;
const F_GETFD = 1;
const F_SETFD = 2;
const F_GETFL = 3;
const F_SETFL = 4;
const F_DUPFD_CLOEXEC = 1030;

const CLOCK_REALTIME = 0;
const CLOCK_MONOTONIC = 1;

const STDIN = 0;
const STDOUT = 1;
const STDERR = 2;

const SIG_COUNT = 64;

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
  getresgid: 120, getpgid: 121, getsid: 124, sigaltstack: 131, statfs: 137, fstatfs: 138,
  prctl: 157, arch_prctl: 158, gettid: 186, time: 201, futex: 202, sched_getaffinity: 204,
  getdents64: 217, set_tid_address: 218, clock_gettime: 228, clock_getres: 229,
  clock_nanosleep: 230, exit_group: 231, tgkill: 234, openat: 257, mkdirat: 258, fchownat: 260,
  newfstatat: 262, unlinkat: 263, renameat: 264, linkat: 265, symlinkat: 266, readlinkat: 267,
  fchmodat: 268, faccessat: 269, pselect6: 270, ppoll: 271, set_robust_list: 273,
  get_robust_list: 274, utimensat: 280, eventfd2: 290, dup3: 292, pipe2: 293, prlimit64: 302,
  getrandom: 318, memfd_create: 319, statx: 332, rseq: 334, clone3: 435, close_range: 436,
  faccessat2: 439, epoll_create: 213, epoll_ctl: 233, epoll_wait: 232, epoll_pwait: 281,
  epoll_create1: 291, socketpair: 53,
});

const NR_NAMES = Object.fromEntries(Object.entries(NR).map(([k, v]) => [v, k]));

// A pipe inside one process: a byte queue. A read on an empty pipe
// with a writer still open cannot block here, since nothing else would
// ever fill it, so it fails with EAGAIN; once every writer is closed it
// reports end of file.
class Pipe {
  constructor() {
    this.chunks = [];
    this.length = 0;
    this.writers = 1;
    this.readers = 1;
  }

  read(out) {
    if (this.length === 0) {
      if (this.writers === 0) {
        return 0;
      }
      throw new Errno(E.AGAIN, "pipe empty");
    }
    let n = 0;
    while (n < out.length && this.chunks.length > 0) {
      const head = this.chunks[0];
      const take = Math.min(head.length, out.length - n);
      out.set(head.subarray(0, take), n);
      n += take;
      if (take === head.length) {
        this.chunks.shift();
      } else {
        this.chunks[0] = head.subarray(take);
      }
    }
    this.length -= n;
    return n;
  }

  write(data) {
    if (this.readers === 0) {
      throw new Errno(E.PIPE);
    }
    this.chunks.push(data.slice());
    this.length += data.length;
    return data.length;
  }
}

// An eventfd: a 64-bit counter read as eight bytes.
class EventFd {
  constructor(initial) {
    this.count = initial;
  }

  read(out) {
    if (out.length < 8) {
      throw new Errno(E.INVAL);
    }
    if (this.count === 0n) {
      throw new Errno(E.AGAIN);
    }
    new DataView(out.buffer, out.byteOffset).setBigUint64(0, this.count, true);
    this.count = 0n;
    return 8;
  }

  write(data) {
    if (data.length < 8) {
      throw new Errno(E.INVAL);
    }
    this.count += new DataView(data.buffer, data.byteOffset).getBigUint64(0, true);
    return 8;
  }
}

// A file description: what an fd refers to.
class Description {
  constructor(kind) {
    this.kind = kind; // "file" | "dir" | "stream" | "pipe"
    this.file = null; // backend file
    this.path = "";
    this.pos = 0;
    this.flags = 0;
    this.stream = null; // for "stream": { read?(buf) -> n, write?(buf) -> n, isatty }
    this.refs = 1;
  }
}

export class Process {
  constructor({ machine, fs, argv, envp = [], cwd = "/", stdio, trace = null }) {
    this.machine = machine;
    this.fs = fs;
    this.argv = argv;
    this.envp = envp;
    this.cwd = cwd;
    this.trace = trace;
    this.pid = 1000;
    this.tidAddress = 0n;
    this.umaskValue = 0o022;
    this.fds = new Map();
    this.cloexec = new Set();
    this.nextFd = 3;
    this.sigactions = new Array(SIG_COUNT).fill(null);
    this.sigmask = 0n;
    this.brkStart = 0n;
    this.brkEnd = 0n;
    this.brkLimit = 0n;
    this.exePath = argv[0];
    this.highWater = 0;
    this.startTime = performance.now();
    this.syscalls = 0;

    for (const [fd, stream] of [[STDIN, stdio.stdin], [STDOUT, stdio.stdout], [STDERR, stdio.stderr]]) {
      const d = new Description("stream");
      d.stream = stream;
      d.path = `/dev/stdio${fd}`;
      this.fds.set(fd, d);
    }

    // The mmap region: a sorted list of free [lo, hi) ranges.
    this.free = [[MMAP_BASE, BigInt(machine.kernelBase)]];
    if (machine.size > machine.kernelTop) {
      this.free.push([BigInt(machine.kernelTop), BigInt(machine.size)]);
    }
    machine.syscall = (m) => this.syscall(m);
  }

  // ---- address space ------------------------------------------------

  // Takes `len` bytes from the free list, at `hint` if that is free,
  // else the lowest fit. Grows the memory when nothing fits.
  allocate(len, hint = null) {
    const size = BigInt(len);
    if (hint !== null) {
      const at = this.takeRange(hint, hint + size);
      if (at !== null) {
        return at;
      }
    }
    for (const range of this.free) {
      if (range[1] - range[0] >= size) {
        const at = range[0];
        this.takeRange(at, at + size);
        return at;
      }
    }
    // Grow by the request rounded up to 16 MiB.
    const grow = Math.ceil(len / (16 << 20)) * (16 << 20);
    const oldSize = BigInt(this.machine.size);
    this.machine.grow(grow / 65536);
    this.free.push([oldSize, BigInt(this.machine.size)]);
    this.mergeFree();
    return this.allocate(len, hint);
  }

  // Removes [lo, hi) from the free list if it lies inside one range.
  takeRange(lo, hi) {
    for (let i = 0; i < this.free.length; i++) {
      const [a, b] = this.free[i];
      if (lo >= a && hi <= b) {
        const pieces = [];
        if (a < lo) {
          pieces.push([a, lo]);
        }
        if (hi < b) {
          pieces.push([hi, b]);
        }
        this.free.splice(i, 1, ...pieces);
        return lo;
      }
    }
    return null;
  }

  // Claims [lo, hi) whatever is there (MAP_FIXED): free pieces are
  // removed, mapped pieces are simply reused.
  claimRange(lo, hi) {
    const out = [];
    for (const [a, b] of this.free) {
      if (b <= lo || a >= hi) {
        out.push([a, b]);
        continue;
      }
      if (a < lo) {
        out.push([a, lo]);
      }
      if (hi < b) {
        out.push([hi, b]);
      }
    }
    this.free = out;
    this.machine.ensure(lo, hi - lo);
  }

  release(lo, hi) {
    this.free.push([lo, hi]);
    this.mergeFree();
  }

  mergeFree() {
    this.free.sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0));
    const out = [];
    for (const r of this.free) {
      const last = out[out.length - 1];
      if (last && last[1] >= r[0]) {
        last[1] = r[1] > last[1] ? r[1] : last[1];
      } else {
        out.push([r[0], r[1]]);
      }
    }
    this.free = out;
  }

  // Zeroes a range for a fresh mapping. Memory the guest has never
  // touched is already zero, and ruby alone maps hundreds of megabytes
  // it then barely uses, so only the part below the high-water mark
  // of addresses ever mapped is filled.
  zero(at, size) {
    const lo = Number(at);
    const hi = lo + size;
    if (lo < this.highWater) {
      this.machine.u8.fill(0, lo, Math.min(hi, this.highWater));
    }
    if (hi > this.highWater) {
      this.highWater = hi;
    }
  }

  // ---- loading ------------------------------------------------------

  readFile(path) {
    const f = this.fs.open(path, O.RDONLY);
    try {
      const st = f.stat();
      const buf = new Uint8Array(st.size);
      let got = 0;
      while (got < st.size) {
        const n = f.read(buf.subarray(got), got);
        if (n <= 0) {
          break;
        }
        got += n;
      }
      return buf.subarray(0, got);
    } finally {
      f.close();
    }
  }

  // Maps an ELF image; returns { base, entry, phdr, ... }.
  mapElf(bytes, elf, base) {
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
    this.claimRange(lo, hi);
    this.zero(lo, Number(hi - lo));
    for (const s of elf.segments) {
      const at = Number(base + s.vaddr);
      m.u8.set(bytes.subarray(s.offset, s.offset + s.filesz), at);
    }
    return { lo, hi };
  }

  load(path) {
    const bytes = this.readFile(path);
    const elf = parseElf(bytes);
    const base = elf.pie ? EXE_BASE : 0n;
    const { hi } = this.mapElf(bytes, elf, base);
    this.exePath = path;

    // The heap starts on the page after the executable.
    this.brkStart = hi;
    this.brkEnd = hi;
    this.brkLimit = hi + BigInt(BRK_RESERVE);
    this.claimRange(this.brkStart, this.brkLimit);

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
      this.mapElf(ibytes, ielf, interpBase);
      entry = interpBase + ielf.entry;
    }

    const sp = this.buildStack(elf, base, interpBase, path);
    this.machine.setReg("rsp", sp);
    for (const r of ["rax", "rbx", "rcx", "rdx", "rsi", "rdi", "rbp", "r8", "r9", "r10", "r11", "r12", "r13", "r14", "r15"]) {
      this.machine.setReg(r, 0n);
    }
    this.entry = entry;
    return entry;
  }

  // Lays out the initial stack and returns rsp.
  buildStack(elf, base, interpBase, execfn) {
    const m = this.machine;
    const stackLo = this.allocate(STACK_SIZE);
    const stackHi = stackLo + BigInt(STACK_SIZE);
    this.zero(stackLo, STACK_SIZE);
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
    const argvAddrs = this.argv.map((a) => pushString(a));
    const envpAddrs = this.envp.map((e) => pushString(e));

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

    // Words: argc, argv..., 0, envp..., 0, auxv pairs. Align so that
    // rsp is 16-byte aligned at the entry point.
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

  // ---- syscall plumbing ---------------------------------------------

  syscall(m) {
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
    m.setReg("rax", result);
  }

  // Reads a NUL-terminated string from guest memory.
  str(addr) {
    const m = this.machine;
    const start = Number(addr);
    let end = start;
    while (m.u8[end] !== 0) {
      end++;
    }
    return new TextDecoder().decode(m.u8.subarray(start, end));
  }

  fd(n) {
    const d = this.fds.get(Number(n));
    if (d === undefined) {
      throw new Errno(E.BADF);
    }
    return d;
  }

  installFd(d, min = 0) {
    let n = Math.max(min, 0);
    while (this.fds.has(n)) {
      n++;
    }
    this.fds.set(n, d);
    return n;
  }

  // Resolves a path relative to a directory fd, as the *at calls do.
  pathAt(dirfd, addr, allowEmpty = false) {
    let p = this.str(addr);
    if (p === "" && allowEmpty) {
      return this.fd(dirfd).path;
    }
    if (p.startsWith("/")) {
      return p;
    }
    const base = Number(BigInt.asIntN(32, dirfd)) === AT_FDCWD ? this.cwd : this.fd(dirfd).path;
    return base.endsWith("/") ? base + p : `${base}/${p}`;
  }

  // The few /proc entries a program reads about itself.
  virtualPath(path) {
    if (path === "/proc/self/exe" || path === `/proc/${this.pid}/exe`) {
      return { link: this.exePath };
    }
    return null;
  }

  writeStat(addr, st) {
    const m = this.machine;
    const a = Number(addr);
    m.u8.fill(0, a, a + 144);
    m.write64(a, BigInt(st.dev || 0));
    m.write64(a + 8, BigInt(st.ino || 0));
    m.write64(a + 16, BigInt(st.nlink || 1));
    m.write32(a + 24, st.mode);
    m.write32(a + 28, st.uid || 0);
    m.write32(a + 32, st.gid || 0);
    m.write64(a + 40, BigInt(st.rdev || 0));
    m.write64(a + 48, BigInt(st.size || 0));
    m.write64(a + 56, BigInt(st.blksize || 4096));
    m.write64(a + 64, BigInt(st.blocks || 0));
    const times = [st.atime || 0, st.mtime || 0, st.ctime || 0];
    times.forEach((t, i) => {
      const sec = Math.floor(t);
      m.write64(a + 72 + i * 16, BigInt(sec));
      m.write64(a + 80 + i * 16, BigInt(Math.floor((t - sec) * 1e9)));
    });
  }

  statOfDescription(d) {
    if (d.kind === "stream") {
      return { mode: S_IFCHR | 0o620, size: 0, blksize: 1024, nlink: 1, rdev: 0x8800 };
    }
    if (d.kind === "pipe") {
      return { mode: S_IFIFO | 0o600, size: 0, blksize: 4096, nlink: 1 };
    }
    return d.file.stat();
  }

  // ---- handlers -----------------------------------------------------

  sys_read(fd, buf, count) {
    const d = this.fd(fd);
    const len = Number(count);
    const out = this.machine.u8.subarray(Number(buf), Number(buf) + len);
    if (d.kind === "stream") {
      if (!d.stream.read) {
        throw new Errno(E.BADF);
      }
      return d.stream.read(out);
    }
    if (d.kind === "pipe") {
      return d.pipe.read(out);
    }
    const n = d.file.read(out, d.pos);
    d.pos += n;
    return n;
  }

  sys_write(fd, buf, count) {
    const d = this.fd(fd);
    const len = Number(count);
    const data = this.machine.u8.subarray(Number(buf), Number(buf) + len);
    if (d.kind === "stream") {
      if (!d.stream.write) {
        throw new Errno(E.BADF);
      }
      return d.stream.write(data);
    }
    if (d.kind === "pipe") {
      return d.pipe.write(data);
    }
    if (d.flags & O.APPEND) {
      d.pos = d.file.stat().size;
    }
    const n = d.file.write(data, d.pos);
    d.pos += n;
    return n;
  }

  sys_pread64(fd, buf, count, offset) {
    const d = this.fd(fd);
    if (d.kind !== "file") {
      throw new Errno(E.SPIPE);
    }
    const out = this.machine.u8.subarray(Number(buf), Number(buf) + Number(count));
    return d.file.read(out, Number(offset));
  }

  sys_pwrite64(fd, buf, count, offset) {
    const d = this.fd(fd);
    if (d.kind !== "file") {
      throw new Errno(E.SPIPE);
    }
    const data = this.machine.u8.subarray(Number(buf), Number(buf) + Number(count));
    return d.file.write(data, Number(offset));
  }

  iov(addr, count) {
    const m = this.machine;
    const out = [];
    for (let i = 0; i < Number(count); i++) {
      const base = m.read64(Number(addr) + i * 16);
      const len = Number(m.read64(Number(addr) + i * 16 + 8));
      out.push([base, len]);
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
    const path = this.pathAt(dirfd, pathAddr);
    const fl = Number(flags);
    const virtual = this.virtualPath(path);
    const real = virtual && virtual.link ? virtual.link : path;
    const d = new Description("file");
    d.path = real;
    d.flags = fl;
    // A path that does not exist yet is fine when it is being created.
    let st = null;
    try {
      st = this.fs.stat(real, !(fl & O.NOFOLLOW));
    } catch (e) {
      if (!(e instanceof Errno && e.errno === E.NOENT && fl & O.CREAT)) {
        throw e;
      }
    }
    if (st !== null && (st.mode & S_IFMT) === S_IFDIR) {
      if ((fl & O.ACCMODE) !== O.RDONLY) {
        throw new Errno(E.ISDIR);
      }
      d.kind = "dir";
    } else if (fl & O.DIRECTORY) {
      throw new Errno(E.NOTDIR);
    }
    d.file = this.fs.open(real, fl & ~(O.CLOEXEC | O.NONBLOCK), Number(mode) & ~this.umaskValue);
    const n = this.installFd(d);
    if (fl & O.CLOEXEC) {
      this.cloexec.add(n);
    }
    return n;
  }

  sys_open(pathAddr, flags, mode) {
    return this.sys_openat(BigInt.asUintN(64, BigInt(AT_FDCWD)), pathAddr, flags, mode);
  }

  sys_close(fd) {
    const d = this.fd(fd);
    this.fds.delete(Number(fd));
    this.cloexec.delete(Number(fd));
    if (--d.refs === 0) {
      if (d.file) {
        d.file.close();
      }
      if (d.kind === "pipe") {
        if (d.end === "read") {
          d.pipe.readers--;
        } else {
          d.pipe.writers--;
        }
      }
    }
    return 0;
  }

  sys_pipe2(fdsAddr, flags) {
    const pipe = new Pipe();
    const r = new Description("pipe");
    r.pipe = pipe;
    r.end = "read";
    r.path = "pipe:[r]";
    const w = new Description("pipe");
    w.pipe = pipe;
    w.end = "write";
    w.path = "pipe:[w]";
    const rfd = this.installFd(r);
    const wfd = this.installFd(w);
    if (Number(flags) & O.CLOEXEC) {
      this.cloexec.add(rfd);
      this.cloexec.add(wfd);
    }
    this.machine.write32(fdsAddr, rfd);
    this.machine.write32(fdsAddr + 4n, wfd);
    return 0;
  }

  sys_pipe(fdsAddr) {
    return this.sys_pipe2(fdsAddr, 0n);
  }

  // epoll: an interest list per instance. With one thread there is
  // never anything to wait for that a later syscall will not find, so
  // epoll_wait reports the descriptors that are readable or writable
  // now, or sleeps out its timeout and reports none.
  sys_epoll_create1(flags) {
    const d = new Description("epoll");
    d.interest = new Map();
    d.path = "anon_inode:[eventpoll]";
    const fd = this.installFd(d);
    if (Number(flags) & O.CLOEXEC) {
      this.cloexec.add(fd);
    }
    return fd;
  }

  sys_epoll_ctl(epfd, op, fd, event) {
    const ep = this.fd(epfd);
    if (ep.kind !== "epoll") {
      throw new Errno(E.INVAL);
    }
    const n = Number(fd);
    this.fd(fd);
    const EPOLL_CTL_ADD = 1;
    const EPOLL_CTL_DEL = 2;
    const EPOLL_CTL_MOD = 3;
    switch (Number(op)) {
      case EPOLL_CTL_ADD:
        if (ep.interest.has(n)) {
          throw new Errno(E.EXIST);
        }
      // fall through
      case EPOLL_CTL_MOD:
        ep.interest.set(n, { events: this.machine.read32(event), data: this.machine.read64(event + 4n) });
        return 0;
      case EPOLL_CTL_DEL:
        if (!ep.interest.delete(n)) {
          throw new Errno(E.NOENT);
        }
        return 0;
      default:
        throw new Errno(E.INVAL);
    }
  }

  sys_epoll_wait(epfd, events, maxevents, timeout) {
    const ep = this.fd(epfd);
    if (ep.kind !== "epoll") {
      throw new Errno(E.INVAL);
    }
    const EPOLLIN = 1;
    const EPOLLOUT = 4;
    const m = this.machine;
    let n = 0;
    for (const [fd, { events: want, data }] of ep.interest) {
      if (n >= Number(maxevents)) {
        break;
      }
      const d = this.fds.get(fd);
      if (d === undefined) {
        continue;
      }
      let ready = 0;
      if (d.kind === "pipe") {
        if (d.end === "read" && d.pipe.length > 0) {
          ready |= EPOLLIN;
        }
        if (d.end === "write") {
          ready |= EPOLLOUT;
        }
      } else if (d.kind === "stream" && d.stream instanceof EventFd) {
        if (d.stream.count > 0n) {
          ready |= EPOLLIN;
        }
        ready |= EPOLLOUT;
      } else {
        ready = EPOLLIN | EPOLLOUT;
      }
      ready &= want;
      if (ready === 0) {
        continue;
      }
      const at = Number(events) + n * 12;
      m.write32(at, ready);
      m.write64(at + 4, data);
      n++;
    }
    const ms = Number(BigInt.asIntN(32, timeout));
    if (n === 0 && ms !== 0) {
      if (ms < 0) {
        throw new GuestFault("epoll_wait would block forever");
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
    }
    return n;
  }

  sys_epoll_pwait(epfd, events, maxevents, timeout) {
    return this.sys_epoll_wait(epfd, events, maxevents, timeout);
  }

  sys_eventfd2(initial, flags) {
    const d = new Description("stream");
    d.stream = new EventFd(BigInt.asUintN(32, initial));
    d.path = "anon_inode:[eventfd]";
    const fd = this.installFd(d);
    if (Number(flags) & O.CLOEXEC) {
      this.cloexec.add(fd);
    }
    return fd;
  }

  sys_lseek(fd, offset, whence) {
    const d = this.fd(fd);
    if (d.kind === "stream" || d.kind === "pipe") {
      throw new Errno(E.SPIPE);
    }
    const off = Number(BigInt.asIntN(64, offset));
    const w = Number(whence);
    let pos;
    if (w === 0) {
      pos = off;
    } else if (w === 1) {
      pos = d.pos + off;
    } else if (w === 2) {
      pos = d.file.stat().size + off;
    } else {
      throw new Errno(E.INVAL);
    }
    if (pos < 0) {
      throw new Errno(E.INVAL);
    }
    d.pos = pos;
    return pos;
  }

  sys_fstat(fd, buf) {
    this.writeStat(buf, this.statOfDescription(this.fd(fd)));
    return 0;
  }

  sys_newfstatat(dirfd, pathAddr, buf, flags) {
    const fl = Number(flags);
    const path = this.pathAt(dirfd, pathAddr, (fl & AT_EMPTY_PATH) !== 0);
    if (this.str(pathAddr) === "" && fl & AT_EMPTY_PATH) {
      return this.sys_fstat(dirfd, buf);
    }
    const virtual = this.virtualPath(path);
    if (virtual && virtual.link && fl & AT_SYMLINK_NOFOLLOW) {
      this.writeStat(buf, { mode: S_IFLNK | 0o777, size: virtual.link.length, nlink: 1 });
      return 0;
    }
    const real = virtual && virtual.link ? virtual.link : path;
    this.writeStat(buf, this.fs.stat(real, !(fl & AT_SYMLINK_NOFOLLOW)));
    return 0;
  }

  sys_stat(pathAddr, buf) {
    return this.sys_newfstatat(BigInt.asUintN(64, BigInt(AT_FDCWD)), pathAddr, buf, 0n);
  }

  sys_lstat(pathAddr, buf) {
    return this.sys_newfstatat(BigInt.asUintN(64, BigInt(AT_FDCWD)), pathAddr, buf, BigInt(AT_SYMLINK_NOFOLLOW));
  }

  sys_statx(dirfd, pathAddr, flags, mask, buf) {
    const fl = Number(flags);
    let st;
    if (this.str(pathAddr) === "" && fl & AT_EMPTY_PATH) {
      st = this.statOfDescription(this.fd(dirfd));
    } else {
      const path = this.pathAt(dirfd, pathAddr);
      const virtual = this.virtualPath(path);
      const real = virtual && virtual.link ? virtual.link : path;
      st = this.fs.stat(real, !(fl & AT_SYMLINK_NOFOLLOW));
    }
    const m = this.machine;
    const a = Number(buf);
    m.u8.fill(0, a, a + 256);
    m.write32(a, 0x7ff); // STATX_BASIC_STATS
    m.write32(a + 4, st.blksize || 4096);
    m.write32(a + 16, st.nlink || 1);
    m.write32(a + 20, st.uid || 0);
    m.write32(a + 24, st.gid || 0);
    m.view.setUint16(a + 28, st.mode, true);
    m.write64(a + 32, BigInt(st.ino || 0));
    m.write64(a + 40, BigInt(st.size || 0));
    m.write64(a + 48, BigInt(st.blocks || 0));
    const times = [st.atime || 0, 0, st.ctime || 0, st.mtime || 0];
    times.forEach((t, i) => {
      const sec = Math.floor(t);
      m.write64(a + 64 + i * 16, BigInt(sec));
      m.write32(a + 72 + i * 16, Math.floor((t - sec) * 1e9));
    });
    return 0;
  }

  sys_readlinkat(dirfd, pathAddr, buf, size) {
    const path = this.pathAt(dirfd, pathAddr);
    const virtual = this.virtualPath(path);
    const target = virtual && virtual.link ? virtual.link : this.fs.readlink(path);
    const bytes = new TextEncoder().encode(target);
    const n = Math.min(bytes.length, Number(size));
    this.machine.u8.set(bytes.subarray(0, n), Number(buf));
    return n;
  }

  sys_readlink(pathAddr, buf, size) {
    return this.sys_readlinkat(BigInt.asUintN(64, BigInt(AT_FDCWD)), pathAddr, buf, size);
  }

  sys_faccessat(dirfd, pathAddr, mode) {
    const path = this.pathAt(dirfd, pathAddr);
    this.fs.access(path, Number(mode));
    return 0;
  }

  sys_access(pathAddr, mode) {
    return this.sys_faccessat(BigInt.asUintN(64, BigInt(AT_FDCWD)), pathAddr, mode);
  }

  sys_getdents64(fd, buf, count) {
    const d = this.fd(fd);
    if (d.kind !== "dir") {
      throw new Errno(E.NOTDIR);
    }
    if (d.entries === undefined) {
      d.entries = [
        { name: ".", type: 4, ino: 1 },
        { name: "..", type: 4, ino: 1 },
        ...d.file.readdir(),
      ];
    }
    const m = this.machine;
    const enc = new TextEncoder();
    let off = 0;
    const max = Number(count);
    const base = Number(buf);
    while (d.pos < d.entries.length) {
      const e = d.entries[d.pos];
      const name = enc.encode(e.name);
      const reclen = (19 + name.length + 1 + 7) & ~7;
      if (off + reclen > max) {
        break;
      }
      m.write64(base + off, BigInt(e.ino || d.pos + 2));
      m.write64(base + off + 8, BigInt(d.pos + 1));
      m.view.setUint16(base + off + 16, reclen, true);
      m.u8[base + off + 18] = e.type;
      m.u8.set(name, base + off + 19);
      m.u8[base + off + 19 + name.length] = 0;
      off += reclen;
      d.pos++;
    }
    return off;
  }

  sys_mkdirat(dirfd, pathAddr, mode) {
    this.fs.mkdir(this.pathAt(dirfd, pathAddr), Number(mode) & ~this.umaskValue);
    return 0;
  }

  sys_mkdir(pathAddr, mode) {
    return this.sys_mkdirat(BigInt.asUintN(64, BigInt(AT_FDCWD)), pathAddr, mode);
  }

  sys_unlinkat(dirfd, pathAddr, flags) {
    const path = this.pathAt(dirfd, pathAddr);
    if (Number(flags) & 0x200) {
      this.fs.rmdir(path);
    } else {
      this.fs.unlink(path);
    }
    return 0;
  }

  sys_unlink(pathAddr) {
    return this.sys_unlinkat(BigInt.asUintN(64, BigInt(AT_FDCWD)), pathAddr, 0n);
  }

  sys_rmdir(pathAddr) {
    return this.sys_unlinkat(BigInt.asUintN(64, BigInt(AT_FDCWD)), pathAddr, 0x200n);
  }

  sys_renameat(olddir, oldAddr, newdir, newAddr) {
    this.fs.rename(this.pathAt(olddir, oldAddr), this.pathAt(newdir, newAddr));
    return 0;
  }

  sys_rename(oldAddr, newAddr) {
    const cwd = BigInt.asUintN(64, BigInt(AT_FDCWD));
    return this.sys_renameat(cwd, oldAddr, cwd, newAddr);
  }

  sys_symlinkat(targetAddr, dirfd, pathAddr) {
    this.fs.symlink(this.str(targetAddr), this.pathAt(dirfd, pathAddr));
    return 0;
  }

  sys_fchmodat(dirfd, pathAddr, mode) {
    this.fs.chmod(this.pathAt(dirfd, pathAddr), Number(mode));
    return 0;
  }

  sys_ftruncate(fd, len) {
    const d = this.fd(fd);
    this.fs.truncate(d.path, Number(len));
    return 0;
  }

  sys_getcwd(buf, size) {
    const bytes = new TextEncoder().encode(this.cwd + "\0");
    if (bytes.length > Number(size)) {
      throw new Errno(E.RANGE);
    }
    this.machine.u8.set(bytes, Number(buf));
    return bytes.length;
  }

  sys_chdir(pathAddr) {
    const path = this.pathAt(BigInt.asUintN(64, BigInt(AT_FDCWD)), pathAddr);
    const st = this.fs.stat(path);
    if ((st.mode & S_IFMT) !== S_IFDIR) {
      throw new Errno(E.NOTDIR);
    }
    this.cwd = path;
    return 0;
  }

  sys_fchdir(fd) {
    this.cwd = this.fd(fd).path;
    return 0;
  }

  sys_dup(fd) {
    const d = this.fd(fd);
    d.refs++;
    return this.installFd(d);
  }

  sys_dup3(fd, newfd, flags) {
    const d = this.fd(fd);
    const n = Number(newfd);
    if (n === Number(fd)) {
      throw new Errno(E.INVAL);
    }
    if (this.fds.has(n)) {
      this.sys_close(BigInt(n));
    }
    d.refs++;
    this.fds.set(n, d);
    if (Number(flags) & O.CLOEXEC) {
      this.cloexec.add(n);
    }
    return n;
  }

  sys_dup2(fd, newfd) {
    if (Number(fd) === Number(newfd)) {
      this.fd(fd);
      return newfd;
    }
    return this.sys_dup3(fd, newfd, 0n);
  }

  sys_fcntl(fd, cmd, arg) {
    const d = this.fd(fd);
    const n = Number(fd);
    switch (Number(cmd)) {
      case F_DUPFD:
      case F_DUPFD_CLOEXEC: {
        d.refs++;
        const nf = this.installFd(d, Number(arg));
        if (Number(cmd) === F_DUPFD_CLOEXEC) {
          this.cloexec.add(nf);
        }
        return nf;
      }
      case F_GETFD:
        return this.cloexec.has(n) ? 1 : 0;
      case F_SETFD:
        if (Number(arg) & 1) {
          this.cloexec.add(n);
        } else {
          this.cloexec.delete(n);
        }
        return 0;
      case F_GETFL:
        return d.flags;
      case F_SETFL:
        d.flags = (d.flags & O.ACCMODE) | (Number(arg) & ~O.ACCMODE);
        return 0;
      default:
        throw new Errno(E.INVAL);
    }
  }

  sys_ioctl(fd, req, arg) {
    const d = this.fd(fd);
    const r = Number(req);
    const m = this.machine;
    const isatty = d.kind === "stream" && d.stream.isatty;
    switch (r) {
      case TCGETS:
      case TCGETS2: {
        if (!isatty) {
          throw new Errno(E.NOTTY);
        }
        const a = Number(arg);
        const size = r === TCGETS2 ? TERMIOS2_SIZE : TERMIOS_SIZE;
        m.u8.fill(0, a, a + size);
        // The defaults are xterm-pty's: ICRNL IXON IUTF8, OPOST ONLCR,
        // CS8 CREAD, and the usual echoing canonical line discipline.
        const t = d.stream.termios || DEFAULT_TERMIOS;
        m.write32(a, t.iflag);
        m.write32(a + 4, t.oflag);
        m.write32(a + 8, t.cflag);
        m.write32(a + 12, t.lflag);
        const cc = t.cc ? t.cc.slice(0, TERMIOS_CC_LEN) : DEFAULT_CC;
        m.u8.set(cc, a + TERMIOS_CC_OFFSET);
        if (r === TCGETS2) {
          m.write32(a + 36, BAUD_38400);
          m.write32(a + 40, BAUD_38400);
        }
        return 0;
      }
      case TCSETS:
      case TCSETSW:
      case TCSETSF:
      case TCSETS2:
      case TCSETSW2:
      case TCSETSF2: {
        if (!isatty) {
          throw new Errno(E.NOTTY);
        }
        const a = Number(arg);
        const cc = Array.from(m.u8.subarray(a + TERMIOS_CC_OFFSET, a + TERMIOS_CC_OFFSET + TERMIOS_CC_LEN));
        while (cc.length < 32) {
          cc.push(0);
        }
        d.stream.termios = { iflag: m.read32(a), oflag: m.read32(a + 4), cflag: m.read32(a + 8), lflag: m.read32(a + 12), cc };
        if (d.stream.setTermios) {
          d.stream.setTermios(d.stream.termios);
        }
        return 0;
      }
      case TIOCGWINSZ: {
        if (!isatty) {
          throw new Errno(E.NOTTY);
        }
        const a = Number(arg);
        const size = d.stream.size ? d.stream.size() : { rows: 24, cols: 80 };
        m.view.setUint16(a, size.rows, true);
        m.view.setUint16(a + 2, size.cols, true);
        m.view.setUint16(a + 4, 0, true);
        m.view.setUint16(a + 6, 0, true);
        return 0;
      }
      case TIOCSWINSZ:
        if (!isatty) {
          throw new Errno(E.NOTTY);
        }
        return 0;
      case TIOCGPGRP:
        if (!isatty) {
          throw new Errno(E.NOTTY);
        }
        m.write32(Number(arg), this.pid);
        return 0;
      case TIOCSPGRP:
        if (!isatty) {
          throw new Errno(E.NOTTY);
        }
        return 0;
      case FIONREAD:
        m.write32(Number(arg), 0);
        return 0;
      default:
        throw new Errno(E.NOTTY);
    }
  }

  sys_mmap(addr, length, prot, flags, fd, offset) {
    const len = Number(length);
    const fl = Number(flags);
    if (len === 0) {
      throw new Errno(E.INVAL);
    }
    const size = (len + PAGE_SIZE - 1) & ~(PAGE_SIZE - 1);
    let at;
    if (fl & MAP.FIXED) {
      at = addr & PAGE_MASK;
      this.claimRange(at, at + BigInt(size));
    } else {
      at = this.allocate(size, addr !== 0n ? addr & PAGE_MASK : null);
    }
    const m = this.machine;
    m.ensure(at, size);
    this.zero(at, size);
    if (!(fl & MAP.ANONYMOUS)) {
      const d = this.fd(fd);
      if (d.kind !== "file") {
        throw new Errno(E.ACCES);
      }
      const buf = m.u8.subarray(Number(at), Number(at) + len);
      let got = 0;
      while (got < len) {
        const n = d.file.read(buf.subarray(got), Number(offset) + got);
        if (n <= 0) {
          break;
        }
        got += n;
      }
    }
    return at;
  }

  sys_munmap(addr, length) {
    const lo = addr & PAGE_MASK;
    const hi = (addr + length + 0xfffn) & PAGE_MASK;
    if (hi > lo) {
      this.release(lo, hi);
    }
    return 0;
  }

  sys_mremap(oldAddr, oldSize, newSize, flags) {
    // MREMAP_MAYMOVE only: allocate, copy, release.
    const os = Number(oldSize);
    const ns = Number(newSize);
    if (ns <= os) {
      if (ns < os) {
        this.release(oldAddr + BigInt((ns + 0xfff) & ~0xfff), oldAddr + BigInt((os + 0xfff) & ~0xfff));
      }
      return oldAddr;
    }
    if (!(Number(flags) & 1)) {
      throw new Errno(E.NOMEM);
    }
    const at = this.allocate((ns + 0xfff) & ~0xfff);
    const m = this.machine;
    m.ensure(at, ns);
    m.u8.copyWithin(Number(at), Number(oldAddr), Number(oldAddr) + os);
    m.u8.fill(0, Number(at) + os, Number(at) + ns);
    this.release(oldAddr, oldAddr + BigInt((os + 0xfff) & ~0xfff));
    return at;
  }

  sys_brk(addr) {
    if (addr === 0n || addr < this.brkStart || addr > this.brkLimit) {
      return this.brkEnd;
    }
    const m = this.machine;
    m.ensure(addr, 0);
    if (addr > this.brkEnd) {
      this.zero(this.brkEnd, Number(addr - this.brkEnd));
    }
    this.brkEnd = addr;
    return addr;
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

  sys_rt_sigaction(sig, act, oldact, sigsetsize) {
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
        case 0: this.sigmask |= v; break; // SIG_BLOCK
        case 1: this.sigmask &= ~v; break; // SIG_UNBLOCK
        case 2: this.sigmask = v; break; // SIG_SETMASK
        default: throw new Errno(E.INVAL);
      }
    }
    return 0;
  }

  sys_sigaltstack(ss, oldss) {
    if (oldss !== 0n) {
      this.machine.u8.fill(0, Number(oldss), Number(oldss) + 24);
      this.machine.write32(Number(oldss) + 8, 2); // SS_DISABLE
    }
    return 0;
  }

  sys_futex(uaddr, op, val) {
    const cmd = Number(op) & FUTEX_CMD_MASK;
    if (cmd === FUTEX_WAIT) {
      const cur = this.machine.read32(uaddr);
      if (cur !== Number(val & 0xffffffffn)) {
        throw new Errno(E.AGAIN);
      }
      throw new GuestFault("futex wait with no other thread to wake it");
    }
    if (cmd === FUTEX_WAKE) {
      return 0;
    }
    throw new Errno(E.NOSYS);
  }

  sys_clock_gettime(clock, ts) {
    const m = this.machine;
    let ns;
    if (Number(clock) === CLOCK_REALTIME) {
      ns = BigInt(Date.now()) * 1000000n;
    } else {
      ns = BigInt(Math.round(performance.now() * 1e6));
    }
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

  sys_time(tloc) {
    const now = BigInt(Math.floor(Date.now() / 1000));
    if (tloc !== 0n) {
      this.machine.write64(tloc, now);
    }
    return now;
  }

  sys_gettimeofday(tv) {
    if (tv !== 0n) {
      const ms = BigInt(Date.now());
      this.machine.write64(tv, ms / 1000n);
      this.machine.write64(tv + 8n, (ms % 1000n) * 1000n);
    }
    return 0;
  }

  // poll: no descriptor here ever blocks, so every requested fd is
  // ready at once, and a closed one reports POLLNVAL.
  sys_poll(fds, nfds, timeout) {
    const m = this.machine;
    const POLLIN = 1;
    const POLLOUT = 4;
    const POLLNVAL = 32;
    let ready = 0;
    for (let i = 0; i < Number(nfds); i++) {
      const at = Number(fds) + i * 8;
      const fd = m.view.getInt32(at, true);
      const events = m.view.getInt16(at + 4, true);
      let revents = 0;
      if (fd >= 0) {
        if (!this.fds.has(fd)) {
          revents = POLLNVAL;
        } else {
          revents = events & (POLLIN | POLLOUT);
        }
      }
      m.view.setInt16(at + 6, revents, true);
      if (revents !== 0) {
        ready++;
      }
    }
    return ready;
  }

  sys_ppoll(fds, nfds) {
    return this.sys_poll(fds, nfds, 0n);
  }

  // Whether a descriptor has input now. A terminal stream answers
  // from its ring; files and pipes with data are ready; the rest are.
  readable(d) {
    if (d.kind === "stream") {
      return d.stream.available === undefined || d.stream.available() > 0;
    }
    if (d.kind === "pipe") {
      return d.pipe.length > 0 || d.pipe.writers === 0;
    }
    return true;
  }

  // select: readable sets are answered from `readable`; write and
  // except sets as always ready and never. With nothing ready and a
  // timeout, the terminal stream is waited on for that long.
  sys_select(nfds, readAddr, writeAddr, exceptAddr, timeoutAddr, isPselect = false) {
    const m = this.machine;
    const n = Number(nfds);
    const words = Math.ceil(Math.max(n, 1) / 64);
    const bitSet = (addr, fd) => addr !== 0n && (m.read64(Number(addr) + 8 * Math.floor(fd / 64)) >> BigInt(fd % 64)) & 1n;
    let timeoutMs = -1;
    if (timeoutAddr !== 0n) {
      const sec = Number(m.read64(timeoutAddr));
      const sub = Number(m.read64(timeoutAddr + 8n));
      timeoutMs = sec * 1000 + (isPselect ? sub / 1e6 : sub / 1e3);
    }
    const deadline = timeoutMs < 0 ? Infinity : performance.now() + timeoutMs;
    for (;;) {
      const readyRead = [];
      const readyWrite = [];
      for (let fd = 0; fd < n; fd++) {
        const d = this.fds.get(fd);
        if (bitSet(readAddr, fd) && d !== undefined && this.readable(d)) {
          readyRead.push(fd);
        }
        if (bitSet(writeAddr, fd) && d !== undefined) {
          readyWrite.push(fd);
        }
      }
      if (readyRead.length + readyWrite.length > 0 || performance.now() >= deadline) {
        for (const addr of [readAddr, writeAddr, exceptAddr]) {
          if (addr !== 0n) {
            m.u8.fill(0, Number(addr), Number(addr) + words * 8);
          }
        }
        for (const fd of readyRead) {
          m.u8[Number(readAddr) + Math.floor(fd / 8)] |= 1 << (fd % 8);
        }
        for (const fd of readyWrite) {
          m.u8[Number(writeAddr) + Math.floor(fd / 8)] |= 1 << (fd % 8);
        }
        return readyRead.length + readyWrite.length;
      }
      // Wait for the terminal's ring, or for the deadline.
      const stdin = this.fds.get(STDIN);
      const wait = Math.min(deadline - performance.now(), 50);
      if (stdin !== undefined && stdin.kind === "stream" && stdin.stream.wait) {
        stdin.stream.wait(wait);
      } else {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, wait);
      }
    }
  }

  sys_pselect6(nfds, readAddr, writeAddr, exceptAddr, timeoutAddr) {
    return this.sys_select(nfds, readAddr, writeAddr, exceptAddr, timeoutAddr, true);
  }

  sys_nanosleep(req) {
    const sec = Number(this.machine.read64(req));
    const nsec = Number(this.machine.read64(req + 8n));
    const until = performance.now() + sec * 1000 + nsec / 1e6;
    if (typeof Atomics !== "undefined" && typeof SharedArrayBuffer !== "undefined") {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, until - performance.now());
    } else {
      while (performance.now() < until) {
        // spin
      }
    }
    return 0;
  }

  sys_clock_nanosleep(clock, flags, req) {
    return this.sys_nanosleep(req);
  }

  sys_getrandom(buf, len) {
    const n = Number(len);
    const out = this.machine.u8.subarray(Number(buf), Number(buf) + n);
    // getRandomValues caps a request at 64 KiB.
    for (let i = 0; i < n; i += 65536) {
      crypto.getRandomValues(out.subarray(i, Math.min(n, i + 65536)));
    }
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

  sys_getrlimit(resource, rlim) {
    return this.sys_prlimit64(0n, resource, 0n, rlim);
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

  sys_getpid() {
    return this.pid;
  }

  sys_getppid() {
    return this.pid - 1;
  }

  sys_gettid() {
    return this.pid;
  }

  sys_getuid() {
    return 1000;
  }

  sys_getgid() {
    return 100;
  }

  sys_getpgrp() {
    return this.pid;
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

  sys_umask(mask) {
    const old = this.umaskValue;
    this.umaskValue = Number(mask) & 0o777;
    return old;
  }

  sys_set_tid_address(addr) {
    this.tidAddress = addr;
    return this.pid;
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

  sys_kill(pid, sig) {
    if (Number(pid) === this.pid) {
      throw new ProcessExit(128 + Number(sig));
    }
    throw new Errno(E.SRCH);
  }

  sys_tgkill(tgid, tid, sig) {
    return this.sys_kill(tid, sig);
  }

  sys_exit(code) {
    throw new ProcessExit(Number(code & 0xffn));
  }

  sys_exit_group(code) {
    throw new ProcessExit(Number(code & 0xffn));
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
  [NR.lseek]: Process.prototype.sys_lseek,
  [NR.mmap]: Process.prototype.sys_mmap,
  [NR.mprotect]: Process.prototype.sys_ok,
  [NR.munmap]: Process.prototype.sys_munmap,
  [NR.brk]: Process.prototype.sys_brk,
  [NR.rt_sigaction]: Process.prototype.sys_rt_sigaction,
  [NR.rt_sigprocmask]: Process.prototype.sys_rt_sigprocmask,
  [NR.ioctl]: Process.prototype.sys_ioctl,
  [NR.pread64]: Process.prototype.sys_pread64,
  [NR.pwrite64]: Process.prototype.sys_pwrite64,
  [NR.readv]: Process.prototype.sys_readv,
  [NR.writev]: Process.prototype.sys_writev,
  [NR.access]: Process.prototype.sys_access,
  [NR.sched_yield]: Process.prototype.sys_ok,
  [NR.mremap]: Process.prototype.sys_mremap,
  [NR.msync]: Process.prototype.sys_ok,
  [NR.madvise]: Process.prototype.sys_ok,
  [NR.pipe]: Process.prototype.sys_pipe,
  [NR.pipe2]: Process.prototype.sys_pipe2,
  [NR.eventfd2]: Process.prototype.sys_eventfd2,
  [NR.epoll_create1]: Process.prototype.sys_epoll_create1,
  [NR.epoll_create]: Process.prototype.sys_epoll_create1,
  [NR.epoll_ctl]: Process.prototype.sys_epoll_ctl,
  [NR.epoll_wait]: Process.prototype.sys_epoll_wait,
  [NR.epoll_pwait]: Process.prototype.sys_epoll_pwait,
  [NR.dup]: Process.prototype.sys_dup,
  [NR.dup2]: Process.prototype.sys_dup2,
  [NR.nanosleep]: Process.prototype.sys_nanosleep,
  [NR.poll]: Process.prototype.sys_poll,
  [NR.select]: Process.prototype.sys_select,
  [NR.pselect6]: Process.prototype.sys_pselect6,
  [NR.ppoll]: Process.prototype.sys_ppoll,
  [NR.getpid]: Process.prototype.sys_getpid,
  [NR.exit]: Process.prototype.sys_exit,
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
  [NR.readlink]: Process.prototype.sys_readlink,
  [NR.umask]: Process.prototype.sys_umask,
  [NR.gettimeofday]: Process.prototype.sys_gettimeofday,
  [NR.time]: Process.prototype.sys_time,
  [NR.getrlimit]: Process.prototype.sys_getrlimit,
  [NR.sysinfo]: Process.prototype.sys_sysinfo,
  [NR.getuid]: Process.prototype.sys_getuid,
  [NR.getgid]: Process.prototype.sys_getgid,
  [NR.geteuid]: Process.prototype.sys_getuid,
  [NR.getegid]: Process.prototype.sys_getgid,
  [NR.getppid]: Process.prototype.sys_getppid,
  [NR.getpgrp]: Process.prototype.sys_getpgrp,
  [NR.getgroups]: Process.prototype.sys_getgroups,
  [NR.getresuid]: Process.prototype.sys_getresuid,
  [NR.getresgid]: Process.prototype.sys_getresgid,
  [NR.getpgid]: Process.prototype.sys_getpgrp,
  [NR.sigaltstack]: Process.prototype.sys_sigaltstack,
  [NR.arch_prctl]: Process.prototype.sys_arch_prctl,
  [NR.gettid]: Process.prototype.sys_gettid,
  [NR.futex]: Process.prototype.sys_futex,
  [NR.sched_getaffinity]: Process.prototype.sys_sched_getaffinity,
  [NR.getdents64]: Process.prototype.sys_getdents64,
  [NR.set_tid_address]: Process.prototype.sys_set_tid_address,
  [NR.clock_gettime]: Process.prototype.sys_clock_gettime,
  [NR.clock_getres]: Process.prototype.sys_clock_getres,
  [NR.clock_nanosleep]: Process.prototype.sys_clock_nanosleep,
  [NR.exit_group]: Process.prototype.sys_exit_group,
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
  [NR.set_robust_list]: Process.prototype.sys_ok,
  [NR.dup3]: Process.prototype.sys_dup3,
  [NR.prlimit64]: Process.prototype.sys_prlimit64,
  [NR.getrandom]: Process.prototype.sys_getrandom,
  [NR.statx]: Process.prototype.sys_statx,
  [NR.rseq]: Process.prototype.sys_nosys,
  [NR.prctl]: Process.prototype.sys_ok,
};

export { O, MAP, PROT, AT_FDCWD, S_IFMT, S_IFDIR, S_IFREG, S_IFLNK, S_IFCHR, S_IFIFO, NR_NAMES };
