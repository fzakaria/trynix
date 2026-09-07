// Encoders for the structures a syscall answers with, shared by the
// kernel that fills them and the worker that copies them into guest
// memory: struct stat, the dirent64 stream and termios.

export const STAT_SIZE = 144;

export function encodeStat(st) {
  const buf = new Uint8Array(STAT_SIZE);
  const v = new DataView(buf.buffer);
  v.setBigUint64(0, BigInt(st.dev || 0), true);
  v.setBigUint64(8, BigInt(st.ino || 0), true);
  v.setBigUint64(16, BigInt(st.nlink || 1), true);
  v.setUint32(24, st.mode >>> 0, true);
  v.setUint32(28, st.uid || 0, true);
  v.setUint32(32, st.gid || 0, true);
  v.setBigUint64(40, BigInt(st.rdev || 0), true);
  v.setBigInt64(48, BigInt(st.size || 0), true);
  v.setBigInt64(56, BigInt(st.blksize || 4096), true);
  v.setBigInt64(64, BigInt(st.blocks || 0), true);
  [st.atime || 0, st.mtime || 0, st.ctime || 0].forEach((t, i) => {
    const sec = Math.floor(t);
    v.setBigInt64(72 + i * 16, BigInt(sec), true);
    v.setBigInt64(80 + i * 16, BigInt(Math.floor((t - sec) * 1e9)), true);
  });
  return buf;
}

// Encodes directory entries from `start` into at most `max` bytes of
// linux_dirent64 records; returns { bytes, consumed }.
export function encodeDirents(entries, start, max) {
  const enc = new TextEncoder();
  const out = new Uint8Array(max);
  const v = new DataView(out.buffer);
  let off = 0;
  let i = start;
  for (; i < entries.length; i++) {
    const e = entries[i];
    const name = enc.encode(e.name);
    const reclen = (19 + name.length + 1 + 7) & ~7;
    if (off + reclen > max) {
      break;
    }
    v.setBigUint64(off, BigInt(e.ino || i + 2), true);
    v.setBigUint64(off + 8, BigInt(i + 1), true);
    v.setUint16(off + 16, reclen, true);
    out[off + 18] = e.type;
    out.set(name, off + 19);
    out[off + 19 + name.length] = 0;
    off += reclen;
  }
  return { bytes: out.subarray(0, off), consumed: i - start };
}

// The kernel's struct termios (36 bytes) or termios2 (44, with speeds).
export const TERMIOS_SIZE = 36;
export const TERMIOS2_SIZE = 44;
const CC_OFFSET = 17;
const CC_LEN = 19;
const BAUD_38400 = 38400;

export const DEFAULT_TERMIOS = Object.freeze({
  iflag: 0x6500,
  oflag: 0x5,
  cflag: 0xbf,
  lflag: 0x8a3b,
  cc: [3, 28, 127, 21, 4, 0, 1, 0, 17, 19, 26, 0, 18, 15, 23, 22, 0, 0, 0],
});

export function encodeTermios(t, withSpeeds) {
  const buf = new Uint8Array(withSpeeds ? TERMIOS2_SIZE : TERMIOS_SIZE);
  const v = new DataView(buf.buffer);
  v.setUint32(0, t.iflag, true);
  v.setUint32(4, t.oflag, true);
  v.setUint32(8, t.cflag, true);
  v.setUint32(12, t.lflag, true);
  buf.set((t.cc ?? DEFAULT_TERMIOS.cc).slice(0, CC_LEN), CC_OFFSET);
  if (withSpeeds) {
    v.setUint32(36, BAUD_38400, true);
    v.setUint32(40, BAUD_38400, true);
  }
  return buf;
}

export function decodeTermios(buf) {
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const cc = Array.from(buf.subarray(CC_OFFSET, CC_OFFSET + CC_LEN));
  while (cc.length < 32) {
    cc.push(0);
  }
  return { iflag: v.getUint32(0, true), oflag: v.getUint32(4, true), cflag: v.getUint32(8, true), lflag: v.getUint32(12, true), cc };
}

// Strings in a payload: NUL-separated UTF-8.
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function packStrings(strings) {
  const parts = strings.map((s) => encoder.encode(s));
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length + 1, 0));
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
    out[off++] = 0;
  }
  return out;
}

export function unpackStrings(bytes, length) {
  const out = [];
  let start = 0;
  for (let i = 0; i < length; i++) {
    if (bytes[i] === 0) {
      // A copy: a browser's TextDecoder refuses a view of shared memory.
      out.push(decoder.decode(bytes.slice(start, i)));
      start = i + 1;
    }
  }
  return out;
}
