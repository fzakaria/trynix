// A synchronous request channel from a process worker to the kernel,
// over one SharedArrayBuffer per worker.
//
// The worker fills in an opcode, up to eight 64-bit arguments and a
// payload, sets the state to REQUEST, rings the kernel's bell and
// waits for the state to become RESPONSE. The kernel, an asynchronous
// loop, sees the bell, serves what is pending, writes a result and a
// payload back, and sets RESPONSE. A request the kernel cannot answer
// yet (a read on an empty pipe, a wait for a child) is left in the
// PARKED state and completed when something changes.
//
// Layout, in 32-bit words:
//   0 state   1 op   2 payload length (request, then response)
//   3 pending signals (kernel writes, worker reads)   4 result lo
//   5 result hi   6 pid   7 tid   8.. eight i64 args   then payload

export const STATE = Object.freeze({ IDLE: 0, REQUEST: 1, PARKED: 2, RESPONSE: 3 });

const W_STATE = 0;
const W_OP = 1;
const W_LEN = 2;
const W_PENDING = 3;
const W_RESULT_LO = 4;
const W_RESULT_HI = 5;
const W_PID = 6;
const W_TID = 7;
const HEADER_WORDS = 16;
const ARG_COUNT = 8;
const ARGS_OFFSET = HEADER_WORDS * 4;
const PAYLOAD_OFFSET = ARGS_OFFSET + ARG_COUNT * 8;

export const PAYLOAD_BYTES = 1 << 20;
export const CHANNEL_BYTES = PAYLOAD_OFFSET + PAYLOAD_BYTES;

export function createChannel() {
  return new SharedArrayBuffer(CHANNEL_BYTES);
}

// Both ends see the same words; which methods each uses differs.
export class Channel {
  constructor(sab, bell) {
    this.sab = sab;
    this.i32 = new Int32Array(sab, 0, HEADER_WORDS);
    this.args = new BigInt64Array(sab, ARGS_OFFSET, ARG_COUNT);
    this.payload = new Uint8Array(sab, PAYLOAD_OFFSET, PAYLOAD_BYTES);
    // The bell: one Int32 the kernel waits on, bumped by every request.
    this.bell = bell;
  }

  get state() {
    return Atomics.load(this.i32, W_STATE);
  }

  get pid() {
    return Atomics.load(this.i32, W_PID);
  }

  get tid() {
    return Atomics.load(this.i32, W_TID);
  }

  // ---- worker side --------------------------------------------------

  // Sends a request and blocks for the answer. Returns the i64 result;
  // the response payload is in `payload` for `responseLength` bytes.
  call(op, args = [], payload = null) {
    const i32 = this.i32;
    for (let i = 0; i < ARG_COUNT; i++) {
      this.args[i] = i < args.length ? BigInt.asIntN(64, BigInt(args[i])) : 0n;
    }
    let len = 0;
    if (payload !== null) {
      len = Math.min(payload.length, PAYLOAD_BYTES);
      this.payload.set(payload.subarray(0, len));
    }
    Atomics.store(i32, W_LEN, len);
    Atomics.store(i32, W_OP, op);
    Atomics.store(i32, W_STATE, STATE.REQUEST);
    Atomics.add(this.bell, 0, 1);
    Atomics.notify(this.bell, 0);
    for (;;) {
      const state = Atomics.load(i32, W_STATE);
      if (state === STATE.RESPONSE) {
        break;
      }
      Atomics.wait(i32, W_STATE, state);
    }
    Atomics.store(i32, W_STATE, STATE.IDLE);
    const lo = Atomics.load(i32, W_RESULT_LO);
    const hi = Atomics.load(i32, W_RESULT_HI);
    return (BigInt(hi) << 32n) | BigInt(lo >>> 0);
  }

  get responseLength() {
    return Atomics.load(this.i32, W_LEN);
  }

  // Signals the kernel has raised for this task, as a mask.
  takePending() {
    return Atomics.exchange(this.i32, W_PENDING, 0);
  }

  peekPending() {
    return Atomics.load(this.i32, W_PENDING);
  }

  // ---- kernel side --------------------------------------------------

  get op() {
    return Atomics.load(this.i32, W_OP);
  }

  get requestLength() {
    return Atomics.load(this.i32, W_LEN);
  }

  arg(i) {
    return this.args[i];
  }

  park() {
    Atomics.store(this.i32, W_STATE, STATE.PARKED);
  }

  // Completes the request with a result and an optional payload.
  respond(result, payload = null) {
    let len = 0;
    if (payload !== null) {
      len = Math.min(payload.length, PAYLOAD_BYTES);
      this.payload.set(payload.subarray(0, len));
    }
    const v = BigInt.asIntN(64, BigInt(result));
    Atomics.store(this.i32, W_RESULT_LO, Number(v & 0xffffffffn) | 0);
    Atomics.store(this.i32, W_RESULT_HI, Number(v >> 32n) | 0);
    Atomics.store(this.i32, W_LEN, len);
    Atomics.store(this.i32, W_STATE, STATE.RESPONSE);
    Atomics.notify(this.i32, W_STATE);
  }

  raise(mask) {
    Atomics.or(this.i32, W_PENDING, mask);
  }

  setIds(pid, tid) {
    Atomics.store(this.i32, W_PID, pid);
    Atomics.store(this.i32, W_TID, tid);
  }
}
