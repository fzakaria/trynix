// Small ELF files built by hand for the tests, laid out the way a
// linker lays one out: headers, then the interpreter's path, the string
// table and the dynamic section, all inside one loaded segment.

// Where each part of the hand-built file sits, and where the loaded
// segment is mapped, which the dynamic section's string table address
// is given in.
const PHDR_OFFSET = 64;
const PHDR_SIZE = 56;
const INTERP_OFFSET = 256;
const STRTAB_OFFSET = 512;
const DYNAMIC_OFFSET = 1024;
const FILE_SIZE = 2048;
const LOAD_VADDR = 0x400000;

const PT_LOAD = 1;
const PT_DYNAMIC = 2;
const PT_INTERP = 3;
const DT_NULL = 0;
const DT_NEEDED = 1;
const DT_STRTAB = 5;
export const DT_RPATH = 15;
const DT_RUNPATH = 29;

// A little-endian ELF64 file with the given interpreter (or none), and
// a dynamic section naming `needed` libraries and a search path under
// `pathTag` (DT_RUNPATH or DT_RPATH).
export function elf({
  interp = null,
  needed = [],
  searchPath = null,
  pathTag = DT_RUNPATH,
}) {
  const bytes = new Uint8Array(FILE_SIZE);
  const view = new DataView(bytes.buffer);
  const text = new TextEncoder();

  bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1], 0);
  view.setUint16(18, 183, true);
  view.setBigUint64(32, BigInt(PHDR_OFFSET), true);
  view.setUint16(54, PHDR_SIZE, true);

  const headers = [
    [PT_LOAD, 0, LOAD_VADDR, FILE_SIZE],
    [PT_DYNAMIC, DYNAMIC_OFFSET, LOAD_VADDR + DYNAMIC_OFFSET, 256],
  ];
  if (interp !== null) {
    bytes.set(text.encode(`${interp}\0`), INTERP_OFFSET);
    headers.push([PT_INTERP, INTERP_OFFSET, 0, interp.length + 1]);
  }
  view.setUint16(56, headers.length, true);
  headers.forEach(([type, offset, vaddr, size], at) => {
    const base = PHDR_OFFSET + at * PHDR_SIZE;
    view.setUint32(base, type, true);
    view.setBigUint64(base + 8, BigInt(offset), true);
    view.setBigUint64(base + 16, BigInt(vaddr), true);
    view.setBigUint64(base + 32, BigInt(size), true);
  });

  // The string table: a leading NUL, then each string; the dynamic
  // section names them by offset into it.
  let strings = "\0";
  const offsetOf = (string) => {
    const at = strings.length;
    strings += `${string}\0`;
    return at;
  };
  const entries = needed.map((name) => [DT_NEEDED, offsetOf(name)]);
  if (searchPath !== null) {
    entries.push([pathTag, offsetOf(searchPath)]);
  }
  entries.push([DT_STRTAB, LOAD_VADDR + STRTAB_OFFSET], [DT_NULL, 0]);
  bytes.set(text.encode(strings), STRTAB_OFFSET);
  entries.forEach(([tag, value], at) => {
    view.setBigInt64(DYNAMIC_OFFSET + at * 16, BigInt(tag), true);
    view.setBigUint64(DYNAMIC_OFFSET + at * 16 + 8, BigInt(value), true);
  });
  return bytes;
}
