// The terminal's side of a process running in a Worker.
//
// Output is easy: the worker posts bytes and the page writes them to
// the pty. Input is not, because a guest read() must block, and a
// Worker cannot wait for a message. So keystrokes go through a ring
// buffer in a SharedArrayBuffer: the page appends and notifies, the
// worker takes what is there or waits on the counter with Atomics.wait.
// The same buffer carries the terminal's size and an end-of-input flag.

const HEAD = 0; // read position, owned by the worker
const TAIL = 1; // write position, owned by the page
const CLOSED = 2; // 1 once the page will send no more
const ROWS = 3;
const COLS = 4;
const INTERRUPT = 5; // set by the page on Ctrl-C, cleared by the worker
const HEADER_WORDS = 8;

export const DEFAULT_RING_BYTES = 1 << 16;

export function createInputRing(bytes = DEFAULT_RING_BYTES) {
  const sab = new SharedArrayBuffer(HEADER_WORDS * 4 + bytes);
  const header = new Int32Array(sab, 0, HEADER_WORDS);
  header[ROWS] = 24;
  header[COLS] = 80;
  return sab;
}

// The page's end.
export class InputWriter {
  constructor(sab) {
    this.header = new Int32Array(sab, 0, HEADER_WORDS);
    this.data = new Uint8Array(sab, HEADER_WORDS * 4);
    this.capacity = this.data.length;
  }

  // Appends bytes; drops what does not fit, which at 64 KiB of typed
  // input ahead of the reader is not a case worth blocking the page on.
  push(bytes) {
    const head = Atomics.load(this.header, HEAD);
    let tail = Atomics.load(this.header, TAIL);
    const free = this.capacity - (tail - head);
    const n = Math.min(bytes.length, free);
    for (let i = 0; i < n; i++) {
      this.data[(tail + i) % this.capacity] = bytes[i];
    }
    tail += n;
    Atomics.store(this.header, TAIL, tail);
    Atomics.notify(this.header, TAIL);
    return n;
  }

  close() {
    Atomics.store(this.header, CLOSED, 1);
    Atomics.notify(this.header, TAIL);
  }

  setSize(rows, cols) {
    Atomics.store(this.header, ROWS, rows);
    Atomics.store(this.header, COLS, cols);
  }

  interrupt() {
    Atomics.store(this.header, INTERRUPT, 1);
    Atomics.notify(this.header, TAIL);
  }
}

// The kernel's end: what its terminal reads from.
export class InputReader {
  constructor(sab) {
    this.header = new Int32Array(sab, 0, HEADER_WORDS);
    this.data = new Uint8Array(sab, HEADER_WORDS * 4);
    this.capacity = this.data.length;
    this.isatty = true;
    this.termios = null;
  }

  available() {
    return Atomics.load(this.header, TAIL) - Atomics.load(this.header, HEAD);
  }

  // Blocks until there is input or the page has closed it.
  read(out) {
    for (;;) {
      const head = Atomics.load(this.header, HEAD);
      const tail = Atomics.load(this.header, TAIL);
      if (tail !== head) {
        const n = Math.min(out.length, tail - head);
        for (let i = 0; i < n; i++) {
          out[i] = this.data[(head + i) % this.capacity];
        }
        Atomics.store(this.header, HEAD, head + n);
        return n;
      }
      if (Atomics.load(this.header, CLOSED) !== 0) {
        return 0;
      }
      Atomics.wait(this.header, TAIL, tail);
    }
  }

  // Waits up to ms for input to arrive.
  wait(ms) {
    const tail = Atomics.load(this.header, TAIL);
    if (tail !== Atomics.load(this.header, HEAD)) {
      return;
    }
    Atomics.wait(this.header, TAIL, tail, ms);
  }

  size() {
    return { rows: Atomics.load(this.header, ROWS), cols: Atomics.load(this.header, COLS) };
  }

  takeInterrupt() {
    return Atomics.compareExchange(this.header, INTERRUPT, 1, 0) === 1;
  }
}
