// Which store paths a program's dynamic loading will open, read from
// its ELF headers.
//
// A store path served on first use (lazy.js) costs a round trip the
// first time the guest looks inside it, and a program's start makes
// those lookups one after another: the kernel opens the program and
// its loader, the loader opens each library the program needs, then
// each library each of those needs. In nixpkgs every one of them is
// found through the store paths the file's RUNPATH (or, from older
// linkers, RPATH) names, and the linker keeps only the directories
// that hold a library the file needs. So the moment the guest opens a
// file, those store paths are known to be next, and can all be on
// their way at once instead of one after another.
//
// Only 64-bit little-endian files are read: the two systems the page
// runs, aarch64-linux and x86_64-linux. Anything else, and any file
// whose headers point outside it, names nothing.

// ELF identification and the header fields read here (ELF64).
const ELF_MAGIC = [0x7f, 0x45, 0x4c, 0x46];
const EI_CLASS = 4;
const EI_DATA = 5;
const ELFCLASS64 = 2;
const ELFDATA2LSB = 1;
const E_PHOFF = 32;
const E_PHENTSIZE = 54;
const E_PHNUM = 56;
const ELF64_HEADER_SIZE = 64;

// Program header fields (Elf64_Phdr) and the types read.
const P_TYPE = 0;
const P_OFFSET = 8;
const P_VADDR = 16;
const P_FILESZ = 32;
const PT_LOAD = 1;
const PT_DYNAMIC = 2;
const PT_INTERP = 3;

// Dynamic section entries (Elf64_Dyn): a tag and a value, eight bytes
// each, and the tags read.
const DYN_SIZE = 16;
const DYN_VALUE = 8;
const DT_NULL = 0n;
const DT_NEEDED = 1n;
const DT_STRTAB = 5n;
const DT_RPATH = 15n;
const DT_RUNPATH = 29n;

// A store path inside a file name or search path entry: the name after
// the store directory. Whether the name is a path of the closure is the
// caller's question.
const STORE_PATH = /\/nix\/store\/([^/:]+)/;

// The NUL-terminated string at `offset`.
function stringAt(bytes, offset) {
  const end = bytes.indexOf(0, offset);
  if (end === -1) {
    throw new RangeError("string runs past the end of the file");
  }
  return new TextDecoder().decode(bytes.subarray(offset, end));
}

// The program headers, as { type, offset, vaddr, size }.
function programHeaders(bytes, view) {
  const at = Number(view.getBigUint64(E_PHOFF, true));
  const entrySize = view.getUint16(E_PHENTSIZE, true);
  const count = view.getUint16(E_PHNUM, true);
  const headers = [];
  for (let i = 0; i < count; i += 1) {
    const base = at + i * entrySize;
    headers.push({
      type: view.getUint32(base + P_TYPE, true),
      offset: Number(view.getBigUint64(base + P_OFFSET, true)),
      vaddr: Number(view.getBigUint64(base + P_VADDR, true)),
      size: Number(view.getBigUint64(base + P_FILESZ, true)),
    });
  }
  return headers;
}

// The file offset of a virtual address, through the loaded segment
// that maps it.
function offsetOf(headers, vaddr) {
  const segment = headers.find(
    (h) => h.type === PT_LOAD && vaddr >= h.vaddr && vaddr < h.vaddr + h.size,
  );
  if (segment === undefined) {
    throw new RangeError("address outside every loaded segment");
  }
  return vaddr - segment.vaddr + segment.offset;
}

// The file names and search paths the dynamic loader will use for
// this file: its interpreter, its search path entries and any library
// it names by a path of its own.
function loaderNames(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const headers = programHeaders(bytes, view);
  const names = [];

  const interp = headers.find((h) => h.type === PT_INTERP);
  if (interp !== undefined) {
    names.push(stringAt(bytes, interp.offset));
  }

  const dynamic = headers.find((h) => h.type === PT_DYNAMIC);
  if (dynamic === undefined) {
    return names;
  }

  // The dynamic section names strings by offset into a table whose
  // address is one of its own entries, so the entries are read first.
  const entries = [];
  for (let at = dynamic.offset; ; at += DYN_SIZE) {
    const tag = view.getBigInt64(at, true);
    if (tag === DT_NULL) {
      break;
    }
    entries.push({ tag, value: view.getBigUint64(at + DYN_VALUE, true) });
  }
  const table = entries.find((entry) => entry.tag === DT_STRTAB);
  if (table === undefined) {
    return names;
  }
  const strings = offsetOf(headers, Number(table.value));

  for (const { tag, value } of entries) {
    if (tag === DT_RUNPATH || tag === DT_RPATH) {
      names.push(...stringAt(bytes, strings + Number(value)).split(":"));
      continue;
    }
    if (tag === DT_NEEDED) {
      const needed = stringAt(bytes, strings + Number(value));
      if (needed.includes("/")) {
        names.push(needed);
      }
    }
  }
  return names;
}

// The store basenames the dynamic loader will open for this file, in
// the order it names them, once each; none for a file that is not a
// 64-bit little-endian ELF file, or is one whose headers do not fit.
export function loaderStorePaths(bytes) {
  if (
    bytes.byteLength < ELF64_HEADER_SIZE ||
    !ELF_MAGIC.every((byte, at) => bytes[at] === byte) ||
    bytes[EI_CLASS] !== ELFCLASS64 ||
    bytes[EI_DATA] !== ELFDATA2LSB
  ) {
    return [];
  }

  let names;
  try {
    names = loaderNames(bytes);
  } catch (err) {
    if (err instanceof RangeError) {
      return [];
    }
    throw err;
  }

  const basenames = [];
  for (const name of names) {
    const match = STORE_PATH.exec(name);
    if (match !== null && !basenames.includes(match[1])) {
      basenames.push(match[1]);
    }
  }
  return basenames;
}
