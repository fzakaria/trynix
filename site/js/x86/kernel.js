// The kernel: what one process cannot keep to itself.
//
// Each process, and each thread, is a Worker running translated code
// on its own thread of the browser. What they share lives here and is
// reached over a synchronous channel (channel.js): the file table of
// every process, the filesystem, pipes and the terminal, the address
// space allocator of every process (threads share one), the process
// tree with its zombies and waiters, signals, and the store of
// translated regions. A worker computes, maps, translates and handles
// its own signals; everything else is a request.
//
// The kernel runs as an asynchronous loop on its own thread (a Worker
// in the page, the main thread under node): it waits on a bell every
// request rings, serves what is pending, and parks what cannot be
// answered yet until the write, the exit or the keystroke that
// answers it arrives.
import { Channel, createChannel, STATE } from "./channel.js";
import { E, Errno } from "./errno.js";
import { OP } from "./ops.js";
import { waitAsync } from "./platform.js";
import { DEFAULT_TERMIOS, decodeTermios, encodeDirents, encodeStat, encodeTermios, packStrings, unpackStrings } from "./structs.js";

const PAGE_SIZE = 4096n;
const PAGE_MASK = ~0xfffn;
const WASM_PAGE = 65536;

// Where a process's things go: a PIE executable at EXE_BASE, its heap
// after it, and shared objects, stacks and anonymous mappings from
// MMAP_BASE up. The block lookup of each thread takes LOOKUP_BYTES
// from the same allocator.
export const EXE_BASE = 0x10000000n;
const MMAP_BASE = 0x20000000n;
const BRK_RESERVE = 64n << 20n;
const GROW_STEP = 16 << 20;

const O_ACCMODE = 3;
const O_RDONLY = 0;
const O_CREAT = 0o100;
const O_NOFOLLOW = 0o400000;
const O_DIRECTORY = 0o200000;
const O_CLOEXEC = 0o2000000;
const O_NONBLOCK = 0o4000;
const O_APPEND = 0o2000;

const AT_FDCWD = -100;
const AT_SYMLINK_NOFOLLOW = 0x100;
const AT_EMPTY_PATH = 0x1000;
const AT_REMOVEDIR = 0x200;

const S_IFMT = 0o170000;
const S_IFDIR = 0o040000;
const S_IFCHR = 0o020000;
const S_IFIFO = 0o010000;
const S_IFLNK = 0o120000;

const F_DUPFD = 0;
const F_GETFD = 1;
const F_SETFD = 2;
const F_GETFL = 3;
const F_SETFL = 4;
const F_DUPFD_CLOEXEC = 1030;
const FD_CLOEXEC = 1;

const TCGETS = 0x5401;
const TCSETS = 0x5402;
const TCSETSW = 0x5403;
const TCSETSF = 0x5404;
const TCGETS2 = 0x802c542a;
const TCSETS2 = 0x402c542b;
const TCSETSW2 = 0x402c542c;
const TCSETSF2 = 0x402c542d;
const TIOCGWINSZ = 0x5413;
const TIOCSWINSZ = 0x5414;
const TIOCGPGRP = 0x540f;
const TIOCSPGRP = 0x5410;
const FIONREAD = 0x541b;
const FIONBIO = 0x5421;
const TIOCSCTTY = 0x540e;

const POLLIN = 1;
const POLLOUT = 4;
const POLLERR = 8;
const POLLHUP = 16;
const POLLNVAL = 32;

const EPOLL_CTL_ADD = 1;
const EPOLL_CTL_DEL = 2;
const EPOLL_CTL_MOD = 3;

const WNOHANG = 1;

const SIG = Object.freeze({ HUP: 1, INT: 2, QUIT: 3, KILL: 9, PIPE: 13, ALRM: 14, TERM: 15, CHLD: 17, CONT: 18, STOP: 19, TSTP: 20, WINCH: 28, URG: 23 });
// Signals whose default action is to do nothing.
const DEFAULT_IGNORED = (1 << (SIG.CHLD - 1)) | (1 << (SIG.WINCH - 1)) | (1 << (SIG.URG - 1)) | (1 << (SIG.CONT - 1));
const MAX_SIGNAL = 31;

const INIT_PID = 1;

// A file description: what a descriptor refers to.
class Desc {
  constructor(id, kind) {
    this.id = id;
    this.kind = kind; // tty | pipe-r | pipe-w | file | dir | epoll | eventfd
    this.refs = 1;
    this.pos = 0;
    this.flags = 0;
    this.path = "";
    this.file = null;
    this.entries = null;
    this.pipe = null;
    this.count = 0n;
    this.interest = null;
  }
}

class Pipe {
  constructor() {
    this.chunks = [];
    this.length = 0;
    this.readers = 1;
    this.writers = 1;
    this.waiting = []; // tasks parked reading
  }
}

class Proc {
  constructor(pid, ppid) {
    this.pid = pid;
    this.ppid = ppid;
    this.pgid = pid;
    this.sid = pid;
    this.fds = new Map();
    this.cloexec = new Set();
    this.cwd = "/";
    this.umask = 0o022;
    this.tasks = new Map();
    this.children = new Set();
    this.zombie = null;
    this.waiters = [];
    this.comm = "";
    this.memory = null;
    // Signal dispositions the worker reported, as masks.
    this.ignored = DEFAULT_IGNORED;
    this.handled = 0;
    // The address space: free ranges, the heap, file mappings.
    this.free = [];
    this.brkStart = 0n;
    this.brkEnd = 0n;
    this.brkLimit = 0n;
    this.mappings = [];
    this.highWater = 0n;
    this.exiting = false;
  }
}

class Task {
  constructor(tid, proc, channel, worker) {
    this.tid = tid;
    this.proc = proc;
    this.channel = channel;
    this.worker = worker;
    this.parked = null;
    this.ctid = 0n;
    this.terminated = false;
  }

  terminate() {
    this.terminated = true;
    this.worker.terminate();
  }
}

export class Kernel {
  // fs: the filesystem backend (fs-node.js or fs-memory.js).
  // tty: { available(), read(out), size(), takeInterrupt(), write(stream, bytes), setTermios(t) }.
  // spawn: (data) -> Promise<worker port>, where data says what kind
  //   of task to start; store: passed to every worker so it can read
  //   store files itself (null when the kernel reads for it).
  constructor({ fs, tty, spawn, translations = new Map(), onTranslation = null, log = () => {}, memoryPages = 16384 }) {
    this.fs = fs;
    this.tty = tty;
    this.spawn = spawn;
    this.translations = translations;
    this.onTranslation = onTranslation;
    this.log = log;
    this.memoryPages = memoryPages;
    this.bell = new Int32Array(new SharedArrayBuffer(4));
    this.descs = new Map();
    this.procs = new Map();
    this.tasks = new Map();
    this.nextDesc = 1;
    this.nextPid = INIT_PID;
    this.ttyWaiters = [];
    this.foreground = INIT_PID;
    this.termios = { ...DEFAULT_TERMIOS };
    this.finished = null;
    this.exitStatus = null;
    this.running = false;
  }

  // ---- lifecycle ----------------------------------------------------

  // Starts init: the program with its arguments and environment.
  async start({ argv, envp, cwd }) {
    const pid = this.nextPid++;
    const proc = new Proc(pid, 0);
    proc.cwd = cwd;
    proc.comm = argv[0];
    this.procs.set(pid, proc);
    for (const fd of [0, 1, 2]) {
      const d = this.newDesc("tty");
      d.path = "/dev/tty";
      d.stream = fd;
      proc.fds.set(fd, d.id);
    }
    this.initAddressSpace(proc);
    await this.spawnTask(proc, pid, { kind: "exec", argv, envp });
    this.finished = new Promise((resolve) => {
      this.resolveFinished = resolve;
    });
    this.run();
    return this.finished;
  }

  async spawnTask(proc, tid, data) {
    const sab = createChannel();
    const channel = new Channel(sab, this.bell);
    channel.setIds(proc.pid, tid);
    const lookupBase = this.allocate(proc, LOOKUP_RESERVE);
    const worker = await this.spawn({
      ...data,
      pid: proc.pid,
      ppid: proc.ppid,
      tid,
      channel: sab,
      bell: this.bell.buffer,
      lookupBase,
      memoryPages: this.memoryPages,
      translations: this.translations,
    });
    const task = new Task(tid, proc, channel, worker);
    proc.tasks.set(tid, task);
    this.tasks.set(tid, task);
    worker.onMessage((m) => this.onWorkerMessage(task, m));
    worker.onError((e) => {
      if (task.terminated) {
        return;
      }
      this.log(`task ${tid} of ${proc.pid} died: ${e.message}`);
      this.exitGroup(proc, 139);
    });
    return task;
  }

  onWorkerMessage(task, m) {
    if (m.type === "ready") {
      task.proc.memory = m.memory;
    } else if (m.type === "output") {
      this.tty.write(m.stream, m.bytes);
    } else if (m.type === "log") {
      this.log(m.text);
    }
  }

  // The loop: serve requests as the bell rings, and the terminal as
  // input arrives.
  async run() {
    this.running = true;
    while (this.running) {
      const seen = Atomics.load(this.bell, 0);
      this.serviceAll();
      this.serviceTty();
      if (!this.running) {
        break;
      }
      await waitAsync(this.bell, 0, seen, 20);
    }
  }

  serviceAll() {
    for (const task of [...this.tasks.values()]) {
      if (task.channel.state === STATE.REQUEST) {
        this.serve(task);
      }
    }
  }

  serve(task) {
    const ch = task.channel;
    let result;
    let payload = null;
    try {
      const out = this.handle(task, ch.op);
      if (out === PARK) {
        ch.park();
        return;
      }
      if (out === NO_REPLY) {
        return;
      }
      if (typeof out === "object" && out !== null) {
        result = out.result;
        payload = out.payload ?? null;
      } else {
        result = out;
      }
    } catch (e) {
      if (e instanceof Errno) {
        result = -e.errno;
      } else {
        this.log(`kernel: op ${ch.op} from ${task.proc.pid}: ${e.stack ?? e.message}`);
        result = -E.IO;
      }
    }
    ch.respond(result, payload);
  }

  // ---- descriptors --------------------------------------------------

  newDesc(kind) {
    const d = new Desc(this.nextDesc++, kind);
    this.descs.set(d.id, d);
    return d;
  }

  desc(proc, fd) {
    const id = proc.fds.get(Number(fd));
    if (id === undefined) {
      throw new Errno(E.BADF);
    }
    return this.descs.get(id);
  }

  install(proc, d, min = 0) {
    let n = min;
    while (proc.fds.has(n)) {
      n++;
    }
    proc.fds.set(n, d.id);
    return n;
  }

  release(d) {
    if (--d.refs > 0) {
      return;
    }
    this.descs.delete(d.id);
    if (d.kind === "file" || d.kind === "dir") {
      if (d.file) {
        d.file.close();
      }
    } else if (d.kind === "pipe-r") {
      d.pipe.readers--;
    } else if (d.kind === "pipe-w") {
      d.pipe.writers--;
      if (d.pipe.writers === 0) {
        this.wakePipeReaders(d.pipe);
      }
    }
  }

  closeFd(proc, fd) {
    const n = Number(fd);
    const id = proc.fds.get(n);
    if (id === undefined) {
      throw new Errno(E.BADF);
    }
    proc.fds.delete(n);
    proc.cloexec.delete(n);
    this.release(this.descs.get(id));
  }

  statOf(d) {
    switch (d.kind) {
      case "tty":
        return { mode: S_IFCHR | 0o620, size: 0, blksize: 1024, nlink: 1, rdev: 0x8800, ino: d.id };
      case "pipe-r":
      case "pipe-w":
        return { mode: S_IFIFO | 0o600, size: d.pipe.length, blksize: 4096, nlink: 1, ino: d.id };
      case "eventfd":
      case "epoll":
      case "device":
        return { mode: S_IFCHR | 0o666, size: 0, blksize: 4096, nlink: 1, ino: d.id, rdev: 0x103 };
      default:
        return d.file.stat();
    }
  }

  // ---- paths --------------------------------------------------------

  resolvePath(proc, dirfd, path, allowEmpty = false) {
    if (path === "" && allowEmpty) {
      return this.desc(proc, dirfd).path;
    }
    if (path.startsWith("/")) {
      return normalize(path);
    }
    const base = Number(BigInt.asIntN(32, BigInt(dirfd))) === AT_FDCWD ? proc.cwd : this.desc(proc, dirfd).path;
    return normalize(base.endsWith("/") ? base + path : `${base}/${path}`);
  }

  // The devices every program expects: the terminal, null, zero, the
  // random sources, and the standard streams by name.
  openDevice(proc, path, flags) {
    const STREAMS = { "/dev/stdin": 0, "/dev/stdout": 1, "/dev/stderr": 2, "/proc/self/fd/0": 0, "/proc/self/fd/1": 1, "/proc/self/fd/2": 2 };
    let d;
    if (path === "/dev/tty" || path === "/dev/console") {
      d = this.newDesc("tty");
      d.stream = 1;
    } else if (path === "/dev/null" || path === "/dev/zero" || path === "/dev/urandom" || path === "/dev/random") {
      d = this.newDesc("device");
      d.device = path.slice(5);
    } else if (STREAMS[path] !== undefined) {
      d = this.desc(proc, STREAMS[path]);
      d.refs++;
    } else {
      return null;
    }
    d.path = path;
    const fd = this.install(proc, d);
    if (flags & O_CLOEXEC) {
      proc.cloexec.add(fd);
    }
    return fd;
  }

  virtual(proc, path) {
    if (path === "/proc/self/exe" || path === `/proc/${proc.pid}/exe`) {
      return proc.comm;
    }
    return null;
  }

  // ---- address space ------------------------------------------------

  initAddressSpace(proc) {
    proc.free = [[MMAP_BASE, BigInt(this.memoryPages * WASM_PAGE)]];
  }

  allocate(proc, len, hint = null) {
    const size = BigInt(len);
    if (hint !== null && this.takeRange(proc, hint, hint + size)) {
      return hint;
    }
    for (const r of proc.free) {
      if (r[1] - r[0] >= size) {
        const at = r[0];
        this.takeRange(proc, at, at + size);
        return at;
      }
    }
    // Grow the memory; the process's own memory when it has one.
    const grow = Math.ceil(len / GROW_STEP) * GROW_STEP;
    const oldSize = BigInt(this.memorySize(proc));
    this.growMemory(proc, grow / WASM_PAGE);
    proc.free.push([oldSize, BigInt(this.memorySize(proc))]);
    mergeFree(proc);
    return this.allocate(proc, len, hint);
  }

  memorySize(proc) {
    if (proc.memory !== null) {
      return proc.memory.buffer.byteLength;
    }
    // Before the worker reports its memory, the initial size.
    return proc.free.reduce((max, r) => (r[1] > max ? r[1] : max), 0n) > 0n ? Number(proc.free[proc.free.length - 1][1]) : this.memoryPages * WASM_PAGE;
  }

  growMemory(proc, pages) {
    if (proc.memory === null) {
      throw new Errno(E.NOMEM, "memory not yet reported by the worker");
    }
    proc.memory.grow(pages);
  }

  takeRange(proc, lo, hi) {
    for (let i = 0; i < proc.free.length; i++) {
      const [a, b] = proc.free[i];
      if (lo >= a && hi <= b) {
        const pieces = [];
        if (a < lo) {
          pieces.push([a, lo]);
        }
        if (hi < b) {
          pieces.push([hi, b]);
        }
        proc.free.splice(i, 1, ...pieces);
        return true;
      }
    }
    return false;
  }

  claimRange(proc, lo, hi) {
    const out = [];
    for (const [a, b] of proc.free) {
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
    proc.free = out;
    const size = BigInt(this.memorySize(proc));
    if (hi > size) {
      this.growMemory(proc, Number((hi - size + BigInt(WASM_PAGE) - 1n) / BigInt(WASM_PAGE)));
    }
  }

  releaseRange(proc, lo, hi) {
    proc.free.push([lo, hi]);
    mergeFree(proc);
  }

  addMapping(proc, lo, hi, file, fileOffset) {
    this.dropMapping(proc, lo, hi);
    proc.mappings.push({ lo, hi, file, base: lo - BigInt(fileOffset) });
  }

  dropMapping(proc, lo, hi) {
    const kept = [];
    for (const m of proc.mappings) {
      if (m.hi <= lo || m.lo >= hi) {
        kept.push(m);
        continue;
      }
      if (m.lo < lo) {
        kept.push({ ...m, hi: lo });
      }
      if (m.hi > hi) {
        kept.push({ ...m, lo: hi });
      }
    }
    proc.mappings = kept;
  }

  // ---- processes ----------------------------------------------------

  // Ends every task of a process and leaves a zombie for its parent.
  exitGroup(proc, status) {
    if (proc.exiting) {
      return;
    }
    proc.exiting = true;
    for (const task of proc.tasks.values()) {
      task.terminate();
      this.tasks.delete(task.tid);
    }
    proc.tasks.clear();
    for (const id of proc.fds.values()) {
      this.release(this.descs.get(id));
    }
    proc.fds.clear();
    // Children go to init.
    const init = this.procs.get(INIT_PID);
    for (const cpid of proc.children) {
      const child = this.procs.get(cpid);
      if (child) {
        child.ppid = INIT_PID;
        if (init && init !== proc) {
          init.children.add(cpid);
        }
      }
    }
    proc.children.clear();
    proc.zombie = { status };
    if (proc.pid === INIT_PID) {
      this.running = false;
      this.exitStatus = status;
      // Nothing else can be waited for: end the rest.
      for (const other of this.procs.values()) {
        for (const task of other.tasks.values()) {
          task.terminate();
        }
      }
      this.resolveFinished((status >> 8) & 0xff);
      return;
    }
    const parent = this.procs.get(proc.ppid);
    if (parent) {
      this.wakeWaiters(parent);
      this.raise(parent, SIG.CHLD);
    }
  }

  // Serves a parent's parked wait4 if a matching zombie exists.
  wakeWaiters(parent) {
    for (const task of [...parent.tasks.values()]) {
      if (task.parked && task.parked.kind === "wait4") {
        const out = this.tryWait(parent, task.parked.pid, task.parked.options);
        if (out !== null) {
          task.parked = null;
          task.channel.respond(out.result, out.payload);
        }
      }
    }
  }

  tryWait(proc, pid, options) {
    let candidates = [...proc.children].map((p) => this.procs.get(p)).filter(Boolean);
    if (pid > 0) {
      candidates = candidates.filter((c) => c.pid === pid);
    } else if (pid === 0) {
      candidates = candidates.filter((c) => c.pgid === proc.pgid);
    } else if (pid < -1) {
      candidates = candidates.filter((c) => c.pgid === -pid);
    }
    if (candidates.length === 0) {
      throw new Errno(E.CHILD);
    }
    const zombie = candidates.find((c) => c.zombie !== null);
    if (zombie === undefined) {
      return options & WNOHANG ? { result: 0 } : null;
    }
    proc.children.delete(zombie.pid);
    this.procs.delete(zombie.pid);
    const status = new Uint8Array(4);
    new DataView(status.buffer).setInt32(0, zombie.zombie.status, true);
    return { result: zombie.pid, payload: status };
  }

  // Delivers a signal to a process by the dispositions it reported.
  raise(proc, sig) {
    if (proc.zombie !== null || proc.exiting) {
      return;
    }
    const bit = 1 << (sig - 1);
    if (sig === SIG.KILL) {
      this.exitGroup(proc, sig);
      return;
    }
    if (proc.ignored & bit && !(proc.handled & bit)) {
      return;
    }
    if (!(proc.handled & bit)) {
      // Default action: terminate.
      this.exitGroup(proc, sig);
      return;
    }
    const task = proc.tasks.values().next().value;
    if (!task) {
      return;
    }
    task.channel.raise(bit);
    this.interrupt(task);
  }

  // A parked task learns about a signal by an interrupted request.
  interrupt(task) {
    if (task.parked === null) {
      return;
    }
    const kind = task.parked.kind;
    if (kind === "tty") {
      this.ttyWaiters = this.ttyWaiters.filter((t) => t !== task);
    } else if (kind === "pipe") {
      task.parked.pipe.waiting = task.parked.pipe.waiting.filter((t) => t !== task);
    }
    if (kind === "fork") {
      return;
    }
    task.parked = null;
    task.channel.respond(-E.INTR);
  }

  // ---- the terminal -------------------------------------------------

  serviceTty() {
    if (this.tty.takeInterrupt && this.tty.takeInterrupt()) {
      for (const proc of this.procs.values()) {
        if (proc.pgid === this.foreground) {
          this.raise(proc, SIG.INT);
        }
      }
    }
    if (this.ttyWaiters.length === 0) {
      return;
    }
    const closed = this.tty.closed && this.tty.closed();
    if (this.tty.available() === 0 && !closed) {
      return;
    }
    const waiters = this.ttyWaiters;
    this.ttyWaiters = [];
    for (const task of waiters) {
      if (task.parked === null) {
        continue;
      }
      const len = task.parked.len;
      task.parked = null;
      const buf = new Uint8Array(Math.min(len, 65536));
      const n = this.tty.available() > 0 ? this.tty.read(buf) : 0;
      task.channel.respond(n, buf.subarray(0, n));
    }
  }

  ttyRead(task, len) {
    if (this.tty.available() > 0) {
      const buf = new Uint8Array(Math.min(len, 65536));
      const n = this.tty.read(buf);
      return { result: n, payload: buf.subarray(0, n) };
    }
    if (this.tty.closed && this.tty.closed()) {
      return 0;
    }
    task.parked = { kind: "tty", len };
    this.ttyWaiters.push(task);
    return PARK;
  }

  // ---- pipes --------------------------------------------------------

  pipeRead(task, d, len) {
    const pipe = d.pipe;
    if (pipe.length > 0) {
      const out = new Uint8Array(Math.min(len, pipe.length));
      let n = 0;
      while (n < out.length && pipe.chunks.length > 0) {
        const head = pipe.chunks[0];
        const take = Math.min(head.length, out.length - n);
        out.set(head.subarray(0, take), n);
        n += take;
        if (take === head.length) {
          pipe.chunks.shift();
        } else {
          pipe.chunks[0] = head.subarray(take);
        }
      }
      pipe.length -= n;
      return { result: n, payload: out.subarray(0, n) };
    }
    if (pipe.writers === 0) {
      return 0;
    }
    if (d.flags & O_NONBLOCK) {
      throw new Errno(E.AGAIN);
    }
    task.parked = { kind: "pipe", pipe, len };
    pipe.waiting.push(task);
    return PARK;
  }

  wakePipeReaders(pipe) {
    const waiting = pipe.waiting;
    pipe.waiting = [];
    for (const task of waiting) {
      if (task.parked === null) {
        continue;
      }
      const len = task.parked.len;
      task.parked = null;
      const d = { pipe, flags: 0 };
      const out = this.pipeRead(task, d, len);
      if (out === PARK) {
        continue;
      }
      if (typeof out === "object") {
        task.channel.respond(out.result, out.payload);
      } else {
        task.channel.respond(out);
      }
    }
  }

  readiness(proc, fd, events) {
    const id = proc.fds.get(fd);
    if (id === undefined) {
      return POLLNVAL;
    }
    const d = this.descs.get(id);
    let ready = 0;
    switch (d.kind) {
      case "tty":
        if (this.tty.available() > 0) {
          ready |= POLLIN;
        }
        ready |= POLLOUT;
        break;
      case "pipe-r":
        if (d.pipe.length > 0) {
          ready |= POLLIN;
        }
        if (d.pipe.writers === 0) {
          ready |= POLLHUP;
        }
        break;
      case "pipe-w":
        ready |= POLLOUT;
        if (d.pipe.readers === 0) {
          ready |= POLLERR;
        }
        break;
      case "eventfd":
        if (d.count > 0n) {
          ready |= POLLIN;
        }
        ready |= POLLOUT;
        break;
      default:
        ready |= POLLIN | POLLOUT;
    }
    return ready & (events | POLLHUP | POLLERR);
  }

  // ---- requests -----------------------------------------------------

  handle(task, op) {
    const proc = task.proc;
    const ch = task.channel;
    const a = (i) => ch.arg(i);
    const strings = () => unpackStrings(ch.payload, ch.requestLength);
    const payload = () => ch.payload.subarray(0, ch.requestLength);

    switch (op) {
      case OP.OPENAT: {
        const [path] = strings();
        const flags = Number(a(1));
        const mode = Number(a(2));
        const resolved = this.resolvePath(proc, a(0), path);
        const device = this.openDevice(proc, resolved, flags);
        if (device !== null) {
          return device;
        }
        const real = this.virtual(proc, resolved) ?? resolved;
        let st = null;
        try {
          st = this.fs.stat(real, !(flags & O_NOFOLLOW));
        } catch (e) {
          if (!(e instanceof Errno && e.errno === E.NOENT && flags & O_CREAT)) {
            throw e;
          }
        }
        const isDir = st !== null && (st.mode & S_IFMT) === S_IFDIR;
        if (isDir && (flags & O_ACCMODE) !== O_RDONLY) {
          throw new Errno(E.ISDIR);
        }
        if (!isDir && flags & O_DIRECTORY) {
          throw new Errno(E.NOTDIR);
        }
        const d = this.newDesc(isDir ? "dir" : "file");
        d.path = real;
        d.flags = flags & ~O_CLOEXEC;
        d.file = this.fs.open(real, flags & ~(O_CLOEXEC | O_NONBLOCK), mode & ~proc.umask);
        const fd = this.install(proc, d);
        if (flags & O_CLOEXEC) {
          proc.cloexec.add(fd);
        }
        return fd;
      }
      case OP.CLOSE:
        this.closeFd(proc, a(0));
        return 0;
      case OP.READ: {
        const d = this.desc(proc, a(0));
        const len = Number(a(1));
        if (d.kind === "tty") {
          return this.ttyRead(task, len);
        }
        if (d.kind === "pipe-r") {
          return this.pipeRead(task, d, len);
        }
        if (d.kind === "pipe-w") {
          throw new Errno(E.BADF);
        }
        if (d.kind === "eventfd") {
          if (d.count === 0n) {
            throw new Errno(E.AGAIN);
          }
          const out = new Uint8Array(8);
          new DataView(out.buffer).setBigUint64(0, d.count, true);
          d.count = 0n;
          return { result: 8, payload: out };
        }
        if (d.kind === "dir") {
          throw new Errno(E.ISDIR);
        }
        if (d.kind === "device") {
          if (d.device === "null") {
            return 0;
          }
          const out = new Uint8Array(Math.min(len, ch.payload.length));
          if (d.device !== "zero") {
            for (let i = 0; i < out.length; i += 65536) {
              crypto.getRandomValues(out.subarray(i, Math.min(out.length, i + 65536)));
            }
          }
          return { result: out.length, payload: out };
        }
        const out = new Uint8Array(Math.min(len, ch.payload.length));
        const n = d.file.read(out, d.pos);
        d.pos += n;
        return { result: n, payload: out.subarray(0, n) };
      }
      case OP.WRITE: {
        const d = this.desc(proc, a(0));
        const data = payload();
        if (d.kind === "tty") {
          this.tty.write(d.stream === 2 ? "stderr" : "stdout", data.slice());
          return data.length;
        }
        if (d.kind === "pipe-w") {
          if (d.pipe.readers === 0) {
            this.raise(proc, SIG.PIPE);
            throw new Errno(E.PIPE);
          }
          d.pipe.chunks.push(data.slice());
          d.pipe.length += data.length;
          this.wakePipeReaders(d.pipe);
          return data.length;
        }
        if (d.kind === "eventfd") {
          d.count += new DataView(data.buffer, data.byteOffset).getBigUint64(0, true);
          return 8;
        }
        if (d.kind === "device") {
          return data.length;
        }
        if (d.kind !== "file") {
          throw new Errno(E.BADF);
        }
        if (d.flags & O_APPEND) {
          d.pos = d.file.stat().size;
        }
        const n = d.file.write(data, d.pos);
        d.pos += n;
        return n;
      }
      case OP.PREAD: {
        const d = this.desc(proc, a(0));
        if (d.kind !== "file") {
          throw new Errno(E.SPIPE);
        }
        const out = new Uint8Array(Math.min(Number(a(1)), ch.payload.length));
        const n = d.file.read(out, Number(a(2)));
        return { result: n, payload: out.subarray(0, n) };
      }
      case OP.PWRITE: {
        const d = this.desc(proc, a(0));
        if (d.kind !== "file") {
          throw new Errno(E.SPIPE);
        }
        return d.file.write(payload(), Number(a(1)));
      }
      case OP.LSEEK: {
        const d = this.desc(proc, a(0));
        if (d.kind !== "file" && d.kind !== "dir") {
          throw new Errno(E.SPIPE);
        }
        const off = Number(BigInt.asIntN(64, a(1)));
        const whence = Number(a(2));
        let pos;
        if (whence === 0) {
          pos = off;
        } else if (whence === 1) {
          pos = d.pos + off;
        } else if (whence === 2) {
          pos = d.file.stat().size + off;
        } else {
          throw new Errno(E.INVAL);
        }
        if (pos < 0) {
          throw new Errno(E.INVAL);
        }
        d.pos = pos;
        if (d.kind === "dir") {
          d.entries = null;
        }
        return pos;
      }
      case OP.FSTAT:
        return { result: 0, payload: encodeStat(this.statOf(this.desc(proc, a(0)))) };
      case OP.STATAT: {
        const [path] = strings();
        const flags = Number(a(1));
        if (path === "" && flags & AT_EMPTY_PATH) {
          return { result: 0, payload: encodeStat(this.statOf(this.desc(proc, a(0)))) };
        }
        const resolved = this.resolvePath(proc, a(0), path);
        const virt = this.virtual(proc, resolved);
        if (virt !== null && flags & AT_SYMLINK_NOFOLLOW) {
          return { result: 0, payload: encodeStat({ mode: S_IFLNK | 0o777, size: virt.length, nlink: 1 }) };
        }
        return { result: 0, payload: encodeStat(this.fs.stat(virt ?? resolved, !(flags & AT_SYMLINK_NOFOLLOW))) };
      }
      case OP.READLINKAT: {
        const [path] = strings();
        const resolved = this.resolvePath(proc, a(0), path);
        const target = this.virtual(proc, resolved) ?? this.fs.readlink(resolved);
        const bytes = new TextEncoder().encode(target).subarray(0, Number(a(1)));
        return { result: bytes.length, payload: bytes };
      }
      case OP.FACCESSAT: {
        const [path] = strings();
        this.fs.access(this.resolvePath(proc, a(0), path), Number(a(1)));
        return 0;
      }
      case OP.MKDIRAT: {
        const [path] = strings();
        this.fs.mkdir(this.resolvePath(proc, a(0), path), Number(a(1)) & ~proc.umask);
        return 0;
      }
      case OP.UNLINKAT: {
        const [path] = strings();
        const resolved = this.resolvePath(proc, a(0), path);
        if (Number(a(1)) & AT_REMOVEDIR) {
          this.fs.rmdir(resolved);
        } else {
          this.fs.unlink(resolved);
        }
        return 0;
      }
      case OP.RENAMEAT: {
        const [from, to] = strings();
        this.fs.rename(this.resolvePath(proc, a(0), from), this.resolvePath(proc, a(1), to));
        return 0;
      }
      case OP.SYMLINKAT: {
        const [target, path] = strings();
        this.fs.symlink(target, this.resolvePath(proc, a(0), path));
        return 0;
      }
      case OP.FCHMODAT: {
        const [path] = strings();
        this.fs.chmod(this.resolvePath(proc, a(0), path), Number(a(1)));
        return 0;
      }
      case OP.FTRUNCATE: {
        const d = this.desc(proc, a(0));
        this.fs.truncate(d.path, Number(a(1)));
        return 0;
      }
      case OP.GETDENTS: {
        const d = this.desc(proc, a(0));
        if (d.kind !== "dir") {
          throw new Errno(E.NOTDIR);
        }
        if (d.entries === null) {
          d.entries = [{ name: ".", type: 4, ino: 1 }, { name: "..", type: 4, ino: 1 }, ...d.file.readdir()];
        }
        const { bytes, consumed } = encodeDirents(d.entries, d.pos, Math.min(Number(a(1)), ch.payload.length));
        d.pos += consumed;
        return { result: bytes.length, payload: bytes };
      }
      case OP.DUP: {
        const d = this.desc(proc, a(0));
        d.refs++;
        return this.install(proc, d, Number(a(1)));
      }
      case OP.DUP3: {
        const d = this.desc(proc, a(0));
        const n = Number(a(1));
        if (n === Number(a(0))) {
          throw new Errno(E.INVAL);
        }
        if (proc.fds.has(n)) {
          this.closeFd(proc, n);
        }
        d.refs++;
        proc.fds.set(n, d.id);
        if (Number(a(2)) & O_CLOEXEC) {
          proc.cloexec.add(n);
        }
        return n;
      }
      case OP.FCNTL: {
        const fd = Number(a(0));
        const d = this.desc(proc, fd);
        const cmd = Number(a(1));
        const arg = Number(a(2));
        switch (cmd) {
          case F_DUPFD:
          case F_DUPFD_CLOEXEC: {
            d.refs++;
            const n = this.install(proc, d, arg);
            if (cmd === F_DUPFD_CLOEXEC) {
              proc.cloexec.add(n);
            }
            return n;
          }
          case F_GETFD:
            return proc.cloexec.has(fd) ? FD_CLOEXEC : 0;
          case F_SETFD:
            if (arg & FD_CLOEXEC) {
              proc.cloexec.add(fd);
            } else {
              proc.cloexec.delete(fd);
            }
            return 0;
          case F_GETFL:
            return d.flags;
          case F_SETFL:
            d.flags = (d.flags & O_ACCMODE) | (arg & ~O_ACCMODE);
            return 0;
          default:
            throw new Errno(E.INVAL);
        }
      }
      case OP.IOCTL:
        return this.ioctl(proc, this.desc(proc, a(0)), Number(a(1)), payload());
      case OP.PIPE2: {
        const pipe = new Pipe();
        const r = this.newDesc("pipe-r");
        r.pipe = pipe;
        r.path = "pipe:[r]";
        const w = this.newDesc("pipe-w");
        w.pipe = pipe;
        w.path = "pipe:[w]";
        const rfd = this.install(proc, r);
        const wfd = this.install(proc, w);
        const flags = Number(a(0));
        if (flags & O_CLOEXEC) {
          proc.cloexec.add(rfd);
          proc.cloexec.add(wfd);
        }
        if (flags & O_NONBLOCK) {
          r.flags |= O_NONBLOCK;
          w.flags |= O_NONBLOCK;
        }
        const out = new Uint8Array(8);
        new DataView(out.buffer).setInt32(0, rfd, true);
        new DataView(out.buffer).setInt32(4, wfd, true);
        return { result: 0, payload: out };
      }
      case OP.READY: {
        // Pairs of (fd, events) in; revents per pair out.
        const req = payload();
        const n = req.length / 8;
        const v = new DataView(req.buffer, req.byteOffset);
        const out = new Uint8Array(n * 4);
        const ov = new DataView(out.buffer);
        let ready = 0;
        for (let i = 0; i < n; i++) {
          const fd = v.getInt32(i * 8, true);
          const events = v.getInt32(i * 8 + 4, true);
          const r = fd < 0 ? 0 : this.readiness(proc, fd, events);
          ov.setInt32(i * 4, r, true);
          if (r !== 0) {
            ready++;
          }
        }
        return { result: ready, payload: out };
      }
      case OP.GETCWD:
        return { result: 0, payload: packStrings([proc.cwd]) };
      case OP.CHDIR: {
        const [path] = strings();
        const resolved = this.resolvePath(proc, AT_FDCWD, path);
        if ((this.fs.stat(resolved).mode & S_IFMT) !== S_IFDIR) {
          throw new Errno(E.NOTDIR);
        }
        proc.cwd = resolved;
        return 0;
      }
      case OP.FCHDIR:
        proc.cwd = this.desc(proc, a(0)).path;
        return 0;
      case OP.UMASK: {
        const old = proc.umask;
        proc.umask = Number(a(0)) & 0o777;
        return old;
      }
      case OP.EPOLL_CREATE: {
        const d = this.newDesc("epoll");
        d.interest = new Map();
        d.path = "anon_inode:[eventpoll]";
        const fd = this.install(proc, d);
        if (Number(a(0)) & O_CLOEXEC) {
          proc.cloexec.add(fd);
        }
        return fd;
      }
      case OP.EPOLL_CTL: {
        const ep = this.desc(proc, a(0));
        if (ep.kind !== "epoll") {
          throw new Errno(E.INVAL);
        }
        const fd = Number(a(2));
        this.desc(proc, fd);
        switch (Number(a(1))) {
          case EPOLL_CTL_ADD:
            if (ep.interest.has(fd)) {
              throw new Errno(E.EXIST);
            }
          // fall through
          case EPOLL_CTL_MOD:
            ep.interest.set(fd, { events: Number(a(3)), data: a(4) });
            return 0;
          case EPOLL_CTL_DEL:
            if (!ep.interest.delete(fd)) {
              throw new Errno(E.NOENT);
            }
            return 0;
          default:
            throw new Errno(E.INVAL);
        }
      }
      case OP.EPOLL_WAIT: {
        const ep = this.desc(proc, a(0));
        if (ep.kind !== "epoll") {
          throw new Errno(E.INVAL);
        }
        const max = Number(a(1));
        const out = new Uint8Array(max * 12);
        const v = new DataView(out.buffer);
        let n = 0;
        for (const [fd, { events, data }] of ep.interest) {
          if (n >= max) {
            break;
          }
          const r = this.readiness(proc, fd, events);
          if (r === 0 || r === POLLNVAL) {
            continue;
          }
          v.setUint32(n * 12, r, true);
          v.setBigUint64(n * 12 + 4, data, true);
          n++;
        }
        return { result: n, payload: out.subarray(0, n * 12) };
      }
      case OP.EVENTFD: {
        const d = this.newDesc("eventfd");
        d.count = BigInt.asUintN(32, a(0));
        d.path = "anon_inode:[eventfd]";
        const fd = this.install(proc, d);
        if (Number(a(1)) & O_CLOEXEC) {
          proc.cloexec.add(fd);
        }
        return fd;
      }

      // ---- memory ----
      case OP_MMAP: {
        const addr = BigInt.asUintN(64, a(0));
        const len = Number(a(1));
        const flags = Number(a(3));
        const fd = Number(BigInt.asIntN(32, a(4)));
        const offset = Number(a(5));
        if (len === 0) {
          throw new Errno(E.INVAL);
        }
        const size = (len + 4095) & ~4095;
        let at;
        if (flags & MAP_FIXED) {
          at = addr & PAGE_MASK;
          this.claimRange(proc, at, at + BigInt(size));
        } else {
          at = this.allocate(proc, size, addr !== 0n ? addr & PAGE_MASK : null);
        }
        let file = null;
        if (!(flags & MAP_ANONYMOUS)) {
          const d = this.desc(proc, fd);
          if (d.kind !== "file") {
            throw new Errno(E.ACCES);
          }
          file = d.path;
        }
        this.addMapping(proc, at, at + BigInt(size), file, file === null ? 0 : offset);
        // The worker fills the range: zero below the high-water mark,
        // then the file's bytes; it is told whether zeroing is needed.
        const needZero = at < proc.highWater ? 1n : 0n;
        const hi = at + BigInt(size);
        if (hi > proc.highWater) {
          proc.highWater = hi;
        }
        return { result: at, payload: packStrings([needZero.toString(), file ?? ""]) };
      }
      case OP_MUNMAP: {
        const lo = BigInt.asUintN(64, a(0)) & PAGE_MASK;
        const hi = (BigInt.asUintN(64, a(0)) + a(1) + 0xfffn) & PAGE_MASK;
        if (hi > lo) {
          this.releaseRange(proc, lo, hi);
          this.dropMapping(proc, lo, hi);
        }
        return 0;
      }
      case OP_BRK: {
        const addr = BigInt.asUintN(64, a(0));
        if (addr === 0n || addr < proc.brkStart || addr > proc.brkLimit) {
          return proc.brkEnd;
        }
        const old = proc.brkEnd;
        proc.brkEnd = addr;
        if (addr > proc.highWater) {
          proc.highWater = addr;
        }
        // The worker zeroes [old, addr) when it grew.
        return { result: addr, payload: packStrings([old.toString()]) };
      }
      case OP_BRK_INIT: {
        // After loading the executable: the heap starts at the given
        // page and gets BRK_RESERVE.
        const start = BigInt.asUintN(64, a(0));
        proc.brkStart = start;
        proc.brkEnd = start;
        proc.brkLimit = start + BRK_RESERVE;
        this.claimRange(proc, start, proc.brkLimit);
        if (proc.brkLimit > proc.highWater) {
          proc.highWater = proc.brkLimit;
        }
        return 0;
      }
      case OP_CLAIM: {
        // The loader maps segments at fixed addresses.
        const lo = BigInt.asUintN(64, a(0));
        const hi = BigInt.asUintN(64, a(1));
        const [file] = strings();
        this.claimRange(proc, lo, hi);
        this.addMapping(proc, lo, hi, file === "" ? null : file, Number(a(2)));
        const needZero = lo < proc.highWater ? 1n : 0n;
        if (hi > proc.highWater) {
          proc.highWater = hi;
        }
        return needZero;
      }
      case OP_ALLOCATE: {
        const at = this.allocate(proc, Number(a(0)));
        this.addMapping(proc, at, at + a(0), null, 0);
        const needZero = at < proc.highWater ? 1n : 0n;
        if (at + a(0) > proc.highWater) {
          proc.highWater = at + a(0);
        }
        return { result: at, payload: packStrings([needZero.toString()]) };
      }
      case OP_LOCATE: {
        const addr = BigInt.asUintN(64, a(0));
        for (const m of proc.mappings) {
          if (addr >= m.lo && addr < m.hi) {
            return { result: 1, payload: packStrings([m.lo.toString(), m.hi.toString(), m.base.toString(), m.file ?? ""]) };
          }
        }
        return 0;
      }

      // ---- processes ----
      case OP.SPAWNED: {
        // A forked child or a new thread is up; its parent's request
        // completes with the new id.
        if (task.parked !== null && task.parked.kind === "spawning") {
          const parent = task.parked.parent;
          task.parked = null;
          if (parent.parked !== null && parent.parked.kind === "fork") {
            parent.parked = null;
            parent.channel.respond(task.parked_result ?? task.tid);
          }
        }
        return 0;
      }
      case OP.FORK:
        return this.fork(task, payload());
      case OP.CLONE:
        return this.clone(task, payload());
      case OP.EXIT: {
        // A thread ends; the last one ends the process.
        if (proc.tasks.size === 1) {
          this.exitGroup(proc, Number(a(0)) << 8);
          return NO_REPLY;
        }
        proc.tasks.delete(task.tid);
        this.tasks.delete(task.tid);
        task.terminate();
        return NO_REPLY;
      }
      case OP.EXIT_GROUP:
        this.exitGroup(proc, Number(a(0)) << 8);
        return NO_REPLY;
      case OP.WAIT4: {
        const pid = Number(BigInt.asIntN(32, a(0)));
        const options = Number(a(1));
        const out = this.tryWait(proc, pid, options);
        if (out !== null) {
          return out;
        }
        task.parked = { kind: "wait4", pid, options };
        return PARK;
      }
      case OP.KILL: {
        const pid = Number(BigInt.asIntN(32, a(0)));
        const sig = Number(a(1));
        const targets = [];
        if (pid > 0) {
          const t = this.procs.get(pid);
          if (!t) {
            throw new Errno(E.SRCH);
          }
          targets.push(t);
        } else if (pid === -1) {
          for (const p of this.procs.values()) {
            if (p.pid !== INIT_PID && p !== proc) {
              targets.push(p);
            }
          }
        } else {
          const pgid = pid === 0 ? proc.pgid : -pid;
          for (const p of this.procs.values()) {
            if (p.pgid === pgid) {
              targets.push(p);
            }
          }
        }
        if (sig !== 0) {
          for (const t of targets) {
            this.raise(t, sig);
          }
        }
        return NO_REPLY_IF_DEAD(this, task);
      }
      case OP.TGKILL: {
        const t = this.tasks.get(Number(a(1)));
        if (!t) {
          throw new Errno(E.SRCH);
        }
        this.raise(t.proc, Number(a(2)));
        return NO_REPLY_IF_DEAD(this, task);
      }
      case OP.GETPPID:
        return proc.ppid;
      case OP.SETPGID: {
        const pid = Number(a(0)) === 0 ? proc.pid : Number(a(0));
        const target = this.procs.get(pid);
        if (!target) {
          throw new Errno(E.SRCH);
        }
        target.pgid = Number(a(1)) === 0 ? pid : Number(a(1));
        return 0;
      }
      case OP.GETPGID: {
        const target = Number(a(0)) === 0 ? proc : this.procs.get(Number(a(0)));
        if (!target) {
          throw new Errno(E.SRCH);
        }
        return target.pgid;
      }
      case OP.SETSID:
        proc.sid = proc.pid;
        proc.pgid = proc.pid;
        return proc.pid;
      case OP.EXECVE: {
        // The worker replaced its image: close what was close-on-exec,
        // drop handled signals, and end the other threads.
        const [comm] = strings();
        proc.comm = comm;
        for (const fd of [...proc.cloexec]) {
          if (proc.fds.has(fd)) {
            this.closeFd(proc, fd);
          }
        }
        proc.cloexec.clear();
        proc.handled = 0;
        for (const other of [...proc.tasks.values()]) {
          if (other !== task) {
            other.terminate();
            proc.tasks.delete(other.tid);
            this.tasks.delete(other.tid);
          }
        }
        // A fresh address space.
        proc.mappings = [];
        this.initAddressSpace(proc);
        proc.highWater = 0n;
        proc.brkStart = proc.brkEnd = proc.brkLimit = 0n;
        return 0;
      }
      case OP_SIGDISPOSITION:
        proc.ignored = Number(a(0)) | DEFAULT_IGNORED;
        proc.handled = Number(a(1));
        return 0;

      // ---- translations ----
      case OP.TRANSLATION_GET: {
        const [key] = strings();
        const entry = this.translations.get(key);
        if (entry === undefined) {
          return -1;
        }
        return { result: entry.bytes.length, payload: encodeTranslation(entry) };
      }
      case OP.TRANSLATION_PUT: {
        const entry = decodeTranslation(payload());
        if (!this.translations.has(entry.key)) {
          const shared = new Uint8Array(new SharedArrayBuffer(entry.bytes.length));
          shared.set(entry.bytes);
          const stored = { bytes: shared, offsets: entry.offsets, unsupported: entry.unsupported };
          this.translations.set(entry.key, stored);
          if (this.onTranslation) {
            this.onTranslation({ key: entry.key, ...stored });
          }
        }
        return 0;
      }
      case OP.LOG: {
        const [text] = strings();
        this.log(`[${proc.pid}] ${text}`);
        return 0;
      }
      default:
        throw new Errno(E.NOSYS, `kernel op ${op}`);
    }
  }

  ioctl(proc, d, req, data) {
    const isTty = d.kind === "tty";
    switch (req) {
      case TCGETS:
      case TCGETS2:
        if (!isTty) {
          throw new Errno(E.NOTTY);
        }
        return { result: 0, payload: encodeTermios(this.termios, req === TCGETS2) };
      case TCSETS:
      case TCSETSW:
      case TCSETSF:
      case TCSETS2:
      case TCSETSW2:
      case TCSETSF2:
        if (!isTty) {
          throw new Errno(E.NOTTY);
        }
        this.termios = decodeTermios(data);
        if (this.tty.setTermios) {
          this.tty.setTermios(this.termios);
        }
        return 0;
      case TIOCGWINSZ: {
        if (!isTty) {
          throw new Errno(E.NOTTY);
        }
        const size = this.tty.size();
        const out = new Uint8Array(8);
        const v = new DataView(out.buffer);
        v.setUint16(0, size.rows, true);
        v.setUint16(2, size.cols, true);
        return { result: 0, payload: out };
      }
      case TIOCSWINSZ:
      case TIOCSCTTY:
        if (!isTty) {
          throw new Errno(E.NOTTY);
        }
        return 0;
      case TIOCGPGRP: {
        if (!isTty) {
          throw new Errno(E.NOTTY);
        }
        const out = new Uint8Array(4);
        new DataView(out.buffer).setInt32(0, this.foreground, true);
        return { result: 0, payload: out };
      }
      case TIOCSPGRP:
        if (!isTty) {
          throw new Errno(E.NOTTY);
        }
        this.foreground = new DataView(data.buffer, data.byteOffset).getInt32(0, true);
        return 0;
      case FIONREAD: {
        const out = new Uint8Array(4);
        const n = isTty ? this.tty.available() : d.kind === "pipe-r" ? d.pipe.length : 0;
        new DataView(out.buffer).setInt32(0, n, true);
        return { result: 0, payload: out };
      }
      case FIONBIO:
        if (new DataView(data.buffer, data.byteOffset).getInt32(0, true) !== 0) {
          d.flags |= O_NONBLOCK;
        } else {
          d.flags &= ~O_NONBLOCK;
        }
        return 0;
      default:
        throw new Errno(E.NOTTY);
    }
  }

  // ---- fork and clone -----------------------------------------------

  fork(task, statePayload) {
    const parent = task.proc;
    if (parent.memory === null) {
      throw new Errno(E.AGAIN, "parent memory unknown");
    }
    const pid = this.nextPid++;
    const child = new Proc(pid, parent.pid);
    child.pgid = parent.pgid;
    child.sid = parent.sid;
    child.cwd = parent.cwd;
    child.umask = parent.umask;
    child.comm = parent.comm;
    child.ignored = parent.ignored;
    child.handled = parent.handled;
    child.free = parent.free.map((r) => [r[0], r[1]]);
    child.brkStart = parent.brkStart;
    child.brkEnd = parent.brkEnd;
    child.brkLimit = parent.brkLimit;
    child.mappings = parent.mappings.map((m) => ({ ...m }));
    child.highWater = parent.highWater;
    for (const [fd, id] of parent.fds) {
      this.descs.get(id).refs++;
      child.fds.set(fd, id);
    }
    child.cloexec = new Set(parent.cloexec);
    this.procs.set(pid, child);
    parent.children.add(pid);
    // The child copies the used ranges of the parent's memory: what
    // the free list does not cover.
    const used = usedRanges(parent, this.memorySize(parent));
    const state = new TextDecoder().decode(statePayload);
    task.parked = { kind: "fork" };
    this.spawnTask(child, pid, {
      kind: "fork",
      parentMemory: parent.memory,
      ranges: used.map(([lo, hi]) => [lo.toString(), hi.toString()]),
      state,
    }).then((childTask) => {
      childTask.parked = { kind: "spawning", parent: task };
      childTask.parked_result = pid;
    });
    return PARK;
  }

  clone(task, statePayload) {
    const proc = task.proc;
    if (proc.memory === null) {
      throw new Errno(E.AGAIN, "memory unknown");
    }
    const tid = this.nextPid++;
    const state = new TextDecoder().decode(statePayload);
    task.parked = { kind: "fork" };
    this.spawnTask(proc, tid, {
      kind: "thread",
      memory: proc.memory,
      state,
    }).then((childTask) => {
      childTask.parked = { kind: "spawning", parent: task };
      childTask.parked_result = tid;
    });
    return PARK;
  }
}

// Sentinels handle() returns instead of a result.
const PARK = Symbol("park");
const NO_REPLY = Symbol("no-reply");

// After a signal that may have ended the caller itself.
function NO_REPLY_IF_DEAD(kernel, task) {
  return kernel.tasks.has(task.tid) ? 0 : NO_REPLY;
}

// Memory ops and the loader's, numbered past ops.js's.
export const OP_MMAP = 70;
export const OP_MUNMAP = 71;
export const OP_BRK = 72;
export const OP_BRK_INIT = 73;
export const OP_CLAIM = 74;
export const OP_ALLOCATE = 75;
export const OP_LOCATE = 76;
export const OP_SIGDISPOSITION = 77;

const MAP_FIXED = 0x10;
const MAP_ANONYMOUS = 0x20;

// The block lookup each thread reserves from its process's space.
export const LOOKUP_RESERVE = 16 << 20;

function mergeFree(proc) {
  proc.free.sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0));
  const out = [];
  for (const r of proc.free) {
    const last = out[out.length - 1];
    if (last && last[1] >= r[0]) {
      last[1] = r[1] > last[1] ? r[1] : last[1];
    } else {
      out.push([r[0], r[1]]);
    }
  }
  proc.free = out;
}

// The complement of the free list below the memory's size.
function usedRanges(proc, size) {
  const out = [];
  let cursor = 0n;
  for (const [lo, hi] of proc.free) {
    if (lo > cursor) {
      out.push([cursor, lo]);
    }
    cursor = hi;
  }
  if (cursor < BigInt(size)) {
    out.push([cursor, BigInt(size)]);
  }
  return out;
}

function normalize(path) {
  const parts = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") {
      continue;
    }
    if (part === "..") {
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return `/${parts.join("/")}`;
}

// A translation entry on the wire: a JSON header line, then bytes.
export function encodeTranslation(entry) {
  const header = new TextEncoder().encode(
    `${JSON.stringify({ key: entry.key ?? "", offsets: entry.offsets.map(String), unsupported: entry.unsupported.map(([o, w]) => [String(o), w]) })}\n`,
  );
  const out = new Uint8Array(header.length + entry.bytes.length);
  out.set(header);
  out.set(entry.bytes, header.length);
  return out;
}

export function decodeTranslation(bytes) {
  const nl = bytes.indexOf(10);
  const header = JSON.parse(new TextDecoder().decode(bytes.subarray(0, nl)));
  return {
    key: header.key,
    bytes: bytes.slice(nl + 1),
    offsets: header.offsets.map((o) => BigInt(o)),
    unsupported: header.unsupported.map(([o, w]) => [BigInt(o), w]),
  };
}
