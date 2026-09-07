// Linux errno values, as the guest expects them back from a syscall.
export const E = Object.freeze({
  PERM: 1,
  NOENT: 2,
  SRCH: 3,
  INTR: 4,
  IO: 5,
  BADF: 9,
  CHILD: 10,
  AGAIN: 11,
  NOMEM: 12,
  ACCES: 13,
  FAULT: 14,
  EXIST: 17,
  NOTDIR: 20,
  ISDIR: 21,
  INVAL: 22,
  NFILE: 23,
  MFILE: 24,
  NOTTY: 25,
  FBIG: 27,
  NOSPC: 28,
  SPIPE: 29,
  ROFS: 30,
  PIPE: 32,
  RANGE: 34,
  NAMETOOLONG: 36,
  NOSYS: 38,
  NOTEMPTY: 39,
  LOOP: 40,
  NOTSUP: 95,
  TIMEDOUT: 110,
});

// Thrown by the filesystem and syscall layer; the number goes back to
// the guest negated in rax.
export class Errno extends Error {
  constructor(errno, what = "") {
    super(`errno ${errno}${what ? `: ${what}` : ""}`);
    this.errno = errno;
  }
}
