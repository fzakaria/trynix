// ELF64 parsing: just enough to load a program and its interpreter.
// Segments to map, the entry point, the program header table's
// location for the auxiliary vector, and the interpreter's path.

const ELF_MAGIC = 0x464c457f;
const ET_EXEC = 2;
const ET_DYN = 3;
const EM_X86_64 = 62;

export const PT = Object.freeze({
  LOAD: 1,
  DYNAMIC: 2,
  INTERP: 3,
  PHDR: 6,
  TLS: 7,
  GNU_STACK: 0x6474e551,
});

export const PF = Object.freeze({ X: 1, W: 2, R: 4 });

export class ElfError extends Error {}

// Parses the headers of an ELF image given as a Uint8Array.
export function parseElf(bytes) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 64 || v.getUint32(0, true) !== ELF_MAGIC) {
    throw new ElfError("not an ELF file");
  }
  if (bytes[4] !== 2 || bytes[5] !== 1) {
    throw new ElfError("not a little-endian 64-bit ELF");
  }
  const type = v.getUint16(16, true);
  const machine = v.getUint16(18, true);
  if (machine !== EM_X86_64) {
    throw new ElfError(`not an x86-64 ELF (machine ${machine})`);
  }
  if (type !== ET_EXEC && type !== ET_DYN) {
    throw new ElfError(`not an executable (type ${type})`);
  }
  const entry = v.getBigUint64(24, true);
  const phoff = Number(v.getBigUint64(32, true));
  const phentsize = v.getUint16(54, true);
  const phnum = v.getUint16(56, true);

  const segments = [];
  let interp = null;
  let tls = null;
  let phdrVaddr = null;
  for (let i = 0; i < phnum; i++) {
    const o = phoff + i * phentsize;
    const p = {
      type: v.getUint32(o, true),
      flags: v.getUint32(o + 4, true),
      offset: Number(v.getBigUint64(o + 8, true)),
      vaddr: v.getBigUint64(o + 16, true),
      filesz: Number(v.getBigUint64(o + 32, true)),
      memsz: Number(v.getBigUint64(o + 40, true)),
      align: Number(v.getBigUint64(o + 48, true)),
    };
    if (p.type === PT.LOAD) {
      segments.push(p);
    } else if (p.type === PT.INTERP) {
      const raw = bytes.subarray(p.offset, p.offset + p.filesz);
      interp = new TextDecoder().decode(raw).replace(/\0+$/, "");
    } else if (p.type === PT.TLS) {
      tls = p;
    } else if (p.type === PT.PHDR) {
      phdrVaddr = p.vaddr;
    }
  }
  if (phdrVaddr === null && segments.length > 0) {
    // No PT_PHDR: the table sits at its file offset inside the first
    // segment that covers it.
    for (const s of segments) {
      if (s.offset <= phoff && phoff < s.offset + s.filesz) {
        phdrVaddr = s.vaddr + BigInt(phoff - s.offset);
        break;
      }
    }
  }
  return {
    type,
    pie: type === ET_DYN,
    entry,
    phoff,
    phentsize,
    phnum,
    phdrVaddr,
    segments,
    interp,
    tls,
  };
}
